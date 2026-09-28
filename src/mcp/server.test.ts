import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Client as PgClient } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getClient } from '../db/client.js';
import {
  appendRawCapture,
  findCustomersByThread,
  isAgentWrittenCapture,
} from '../db/rawCaptures.js';
import { listL2CitingCapture } from '../db/captureMembership.js';
import { createCustomer, insertCustomerCapture } from '../db/customers.js';
import { appendJobCorrespondence, createJob, insertJobCapture } from '../db/jobs.js';
import { createVisit, insertVisitNote, updateVisitStatus } from '../db/visits.js';
import { upsertJobTypeDuration } from '../db/jobTypeDurations.js';
import {
  insertTechnician,
  setTechnicianAvailability,
  setTechnicianSkills,
  setTechnicianState,
  updateTechnician,
  type Technician,
  type WeeklyPattern,
} from '../db/technicians.js';
import { createHost } from '../db/hosts.js';
import { completeSandboxRecycle, registerSandbox } from '../db/sandboxPool.js';
import { createSeat, registerSeatBot } from '../db/seats.js';
import { createTenant, getTenant, setTenantSeats } from '../db/tenants.js';
import { servedDayPhrase } from '../schedule/dateResolve.js';
import { getTechnicianViewRule, insertAccessGrant, setTechnicianViewRule } from '../db/technicianView.js';
import { PROFILE_STRING_FIELDS } from '../db/tenantProfiles.js';
import { upsertOpenReviewItem } from '../db/reviewItems.js';
import {
  createObservation,
  raiseCallActionObservation,
  raiseOffboardingObservation,
} from '../db/observations.js';
import type { Json } from '../db/database.types.js';
import { logWebRequests } from '../db/webRequests.js';
import {
  attributeAnswerToGap,
  createServer,
  dispatchForIdentity,
  MANAGER_TOOL_NAMES,
  openQuestionsFor,
  safeEnvInt,
  TEAM_LEAD_ONLY_TOOL_NAMES,
  TEAM_LEAD_TOOL_SCHEMAS,
  type ServerDeps,
} from './server.js';
import {
  MANAGER_ONLY_TOOLS,
  MANAGER_TOOLS_EXPECTED,
  TEAM_LEAD_ONLY_TOOLS,
  TECHNICIAN_TOOLS,
} from './tools/surface.expected.js';
import {
  createPendingNudge,
  listNudgesByStatus,
  markNudgeAsked,
  markNudgeAskedGroup,
  markNudgeGroupQueued,
  markNudgeQueued,
} from '../db/nudges.js';
import { localDateISO } from '../schedule/availability.js';
import { TEAM_LEAD_REF, TEAM_LEAD_TOOL_NAMES } from '../teamLead/identity.js';
import { MEMORY_FILE_MAX } from '../teamLead/memory.js';
import { JOB_NOTE_MAX } from '../teamLead/jobNotes.js';
import { nl } from '../db/time.js';

// Drive the MCP server over the SDK's in-memory transport (no network/stdio).
// The extractor is stubbed so record_field_note never calls the live model.
const pg = new PgClient({ connectionString: process.env.DATABASE_URL });

// Relative test date (UTC-derived; firm-local today can lag it by one day —
// assertions near a boundary pin bounds, not exact dates). ONE copy at module
// scope: the get_schedule fixtures and the horizon suite both anchor on it.
const relDay = (n: number): string =>
  new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
let tenantId: string;
let techMcpId: string; // tech-mcp's roster UUID — assignment fixtures need it
let client: Client;

beforeAll(async () => {
  await pg.connect();
  // Pick the seed tenant BY NAME: `limit(1)` returns an unspecified row once a
  // test has created a second tenant, and every customer this file creates
  // would silently attach to the wrong one.
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;

  // Known roster + capacity for the admin-tool tests: an active manager
  // ('mgr-test') and an active technician ('tech-mcp' — also the main client's
  // identity, so requireManager's negative path runs against a REAL roster row,
  // not a missing one). technician_seats=3: tech-mcp holds one, two are free —
  // so the duplicate-name case hits the 23505 'ref taken' mapping with a seat
  // still free (at cap the BEFORE-trigger reports the cap error instead).
  await pg.query('truncate table technicians, review_items cascade');
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 3 });
  const mgr = await insertTechnician({
    tenantId,
    ref: 'mgr-test',
    displayName: 'Manager Test',
    tier: 'manager',
  });
  await setTechnicianState(mgr.id, 'active');
  const tech = await insertTechnician({ tenantId, ref: 'tech-mcp', displayName: 'Tech MCP' });
  await setTechnicianState(tech.id, 'active');
  techMcpId = tech.id;
  // THE FIRM'S RULE at its widest (plan 2026-09-15-the-retrieval-layer-2): the
  // suites below were written before the technician limited view, and what they
  // test as `tech-mcp` is the CONTENT gate (option A), not scope. Whole-firm keeps
  // them testing exactly that; 'the technician limited view' block resets the
  // rule to the default and tests scope itself.
  await setTechnicianViewRule(tenantId, { jobScope: 'whole_firm' }, 'server.test');

  const server = createServer({
    // Identity is injected here (the gateway/env source in prod); the agent never
    // supplies technicianRef. 'tech-mcp' matches the schedule entry below.
    identity: { tenantId, technicianRef: 'tech-mcp' },
    extract: async () => ({ workPerformed: 'did the work' }),
    officeLoop: NO_OFFICE_MODEL,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await pg.query(
    // job_type_durations included (review round-2): the update_job test plants
    // 'sump-pump' on the persistent seed tenant; leaking it made that test's
    // no-stored-duration assertion order-dependent across suite runs — the
    // one-off 582-run flake, reproduced and root-caused.
    // cost_events included: dispatch now writes one spine tool_call row per
    // call, so a suite run leaves hundreds behind. Left uncleaned they would
    // skew any later test that counts spine events per tenant — which is
    // exactly what the rollup's allocation split does.
    'truncate table schedule_entries, customers, jobs, visits, raw_captures, technicians, review_items, web_requests, schedule_events, job_type_durations, cost_events, money_events, tenant_profiles, nudges cascade',
  );
  // Restore the seed capacity (2/5) so post-suite live checks see known values.
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  // Tenants are never truncated, so the firm's rule would outlive the suite.
  await setTechnicianViewRule(tenantId, null, 'server.test');
  await pg.end();
});

// NO LIVE MODEL IN THIS SUITE (plan 2026-09-22, review F4): test.setup.ts loads
// .env, so with a key present the office's waiting doors would otherwise call
// the real provider. This loop refuses — the question door degrades honestly and
// the access door takes its code fallback, which is exactly the path the access
// tests below were written against. The office's own judgment is tested in
// src/teamLead/office.test.ts, with a scripted model.
const NO_OFFICE_MODEL = (async () => {
  throw new Error('no model in the dispatch suite');
}) as unknown as NonNullable<ServerDeps['officeLoop']>;

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  const text = content[0].text;
  const isError = res.isError === true;
  // Success results are JSON; error results are a plain message string.
  return { isError, text, data: isError ? undefined : JSON.parse(text) };
}

// Build an isolated client whose server is pinned to a specific identity — used
// to exercise the tenant guards from a *different* tenant than the seeded rows.
// `extra` injects additional seams (e.g. the Composio pairing stubs).
async function clientFor(
  identity: { tenantId: string; technicianRef: string },
  extra: Partial<ServerDeps> = {},
) {
  const server = createServer({
    identity,
    extract: async () => ({ workPerformed: 'did the work' }),
    officeLoop: NO_OFFICE_MODEL,
    ...extra,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const isolated = new Client({ name: 'test-client-other-tenant', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), isolated.connect(clientTransport)]);
  const callWith = async (name: string, args: Record<string, unknown>) => {
    const res = await isolated.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    const isError = res.isError === true;
    return { isError, text: content[0].text, data: isError ? undefined : JSON.parse(content[0].text) };
  };
  return { client: isolated, callWith };
}

// get_team_schedule's recall lists are PAGES (retrieval layer 4): the shared seed
// tenant accumulates parked visits and bare jobs across this file, so a fixture's
// row can sit on any page. This walks one queue to the end.
async function recallAll(
  callWith: Awaited<ReturnType<typeof clientFor>>['callWith'],
  queue: 'visits' | 'jobs',
): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  let after: string | null = null;
  for (let n = 0; n < 500; n++) {
    const res = await callWith('get_team_schedule', { unassignedOnly: true, queue, ...(after ? { after } : {}) });
    if (res.isError || res.data.status !== 'ok') throw new Error(`recall page failed: ${res.text}`);
    out.push(...(res.data[queue] as Array<Record<string, unknown>>));
    after = res.data[`${queue}Next`] as string | null;
    if (!after) return out;
  }
  throw new Error('recall paging never ended');
}

/**
 * The surface assertion, by NAME rather than by count (2026-09-12).
 *
 * `sees` is exact — it is the whole catalog for that tier, so an extra door fails
 * here the way a missing one does. `blind` names the doors that must NOT be in it:
 * that half is the tier boundary, and it is what the old `toHaveLength` was really
 * guarding without ever saying so. See src/mcp/tools/surface.expected.ts for why
 * the counts went away.
 */
function expectSurface(actual: string[], sees: readonly string[], blind: readonly string[]): void {
  // `blind` FIRST, deliberately: a tier leak is the failure worth naming, and the
  // exact-set check below would otherwise report it as an unreadable array diff.
  const leaked = actual.filter((n) => blind.includes(n));
  expect(leaked, `tools this badge must not see: ${leaked.join(', ')}`).toEqual([]);
  expect([...actual].sort()).toEqual([...sees].sort());
}

describe('MCP server', () => {
  test('lists the technician tool surface, by name', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    // Exactly the technician catalog, and none of the doors above it: a manager
    // tool or a team-lead tool appearing here is a tier leak, named rather than
    // counted.
    expectSurface(names, TECHNICIAN_TOOLS, [...MANAGER_ONLY_TOOLS, ...TEAM_LEAD_ONLY_TOOLS]);
  });

  test('EVAL_FAKE_NOW anchors resolve_date for ONE tenant only (date-eval any-hour regime)', async () => {
    // 02:30Z = the previous firm-local EVENING in America/Los_Angeles — the
    // exact UTC-day-vs-firm-day disagreement the evening regime provides.
    process.env.EVAL_FAKE_NOW = `${tenantId}:2027-03-04T02:30:00.000Z`;
    try {
      const anchored = await call('resolve_date', { dayShift: 0 });
      expect(anchored.data.status).toBe('resolved');
      expect(anchored.data.today).toBe('2027-03-03');
      // A different tenant id in the flag → THIS tenant keeps the real clock.
      process.env.EVAL_FAKE_NOW = `00000000-0000-0000-0000-000000000000:2027-03-04T02:30:00.000Z`;
      const real = await call('resolve_date', { dayShift: 0 });
      expect(real.data.today).toBe(localDateISO(new Date().toISOString(), 'America/Los_Angeles'));
    } finally {
      delete process.env.EVAL_FAKE_NOW;
    }
  });

  test('resolve_date computes the date server-side from the firm clock (agent never passes today)', async () => {
    // The firm-local today the server will use (seed tenant tz = Pacific).
    const today = localDateISO(new Date().toISOString(), 'America/Los_Angeles');
    const dow = new Date(`${today}T00:00:00.000Z`).getUTCDay(); // 0=Sun..6=Sat

    // dayShift is timezone-independent arithmetic on that today.
    const tomorrow = await call('resolve_date', { dayShift: 1 });
    expect(tomorrow.data.status).toBe('resolved');
    expect(tomorrow.data.today).toBe(today);
    expect(tomorrow.data.timezone).toBe('America/Los_Angeles');
    const expectTomorrow = new Date(Date.parse(`${today}T00:00:00.000Z`) + 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(tomorrow.data.date).toBe(expectTomorrow);

    // A weekday request lands on that weekday, on or after today.
    const friday = await call('resolve_date', { weekday: 'friday' });
    expect(friday.data.status).toBe('resolved');
    expect(friday.data.weekday).toBe('friday');
    expect(new Date(`${friday.data.date}T00:00:00.000Z`).getUTCDay()).toBe(5);
    expect(friday.data.date >= today).toBe(true);
    const daysUntilFri = (5 - dow + 7) % 7;
    const expectFri = new Date(Date.parse(`${today}T00:00:00.000Z`) + daysUntilFri * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(friday.data.date).toBe(expectFri);

    // "next friday" is exactly 7 days beyond "this friday".
    const nextFriday = await call('resolve_date', { weekday: 'friday', weeksAhead: 1 });
    expect(nextFriday.data.date).toBe(
      new Date(Date.parse(`${expectFri}T00:00:00.000Z`) + 7 * 86_400_000).toISOString().slice(0, 10),
    );

    // A nonsense phrase refuses (the clarify path) instead of guessing.
    const bad = await call('resolve_date', { weeksAhead: 2 }); // weeksAhead without weekday
    expect(bad.data.status).toBe('unresolvable');
    expect(bad.data.today).toBe(today); // still grounds the agent

    // An explicit real date passes through with its weekday labelled.
    const explicit = await call('resolve_date', { explicitDate: '2026-07-17' });
    expect(explicit.data).toMatchObject({ status: 'resolved', date: '2026-07-17', weekday: 'friday' });
  });

  test('resolve_date week mode: server-computed Mon–Sun range, taught in the description', async () => {
    // The description + schema are the contract the fleet's cached tools/list
    // teaches after the rollout restart — pin that the mode is discoverable.
    const { tools } = await client.listTools();
    const def = tools.find((t) => t.name === 'resolve_date');
    expect(def?.description).toContain('week');
    expect(def?.description).toContain('weekStart');
    const props = (def?.inputSchema as { properties?: Record<string, unknown> })?.properties;
    expect(props?.week).toBeDefined();

    // Quoted number — models quote integers; intArg must coerce (same contract
    // as weeksAhead/dayShift).
    const wk = await call('resolve_date', { week: '1' });
    expect(wk.data.status).toBe('resolved_week');
    const today = localDateISO(new Date().toISOString(), 'America/Los_Angeles');
    expect(wk.data.today).toBe(today);
    expect(wk.data.timezone).toBe('America/Los_Angeles');
    // Next week's range: starts strictly after today, Monday through Sunday.
    expect(wk.data.weekStart > today).toBe(true);
    expect(new Date(`${wk.data.weekStart}T00:00:00.000Z`).getUTCDay()).toBe(1);
    expect(new Date(`${wk.data.weekEnd}T00:00:00.000Z`).getUTCDay()).toBe(0);
    // The boundaries arrive LABELLED, and with a sentence the agent can quote.
    // Without this the model composes "Mon Aug 3 – Sun Aug 9" itself, which is
    // the calendar arithmetic this tool exists to remove (live, 2026-08-06).
    expect(wk.data.weekStartWeekday).toBe('monday');
    expect(wk.data.weekEndWeekday).toBe('sunday');
    expect(wk.data.phrase).toBe(`Monday ${wk.data.weekStart} through Sunday ${wk.data.weekEnd}`);
    expect(def?.description).toContain('phrase');
    // The weekend ambiguity contract, keyed on the SERVER's firm-local day so
    // the assertion is exact on any day the suite runs.
    const dow = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    if (dow === 0 || dow === 6) {
      expect(wk.data.boundaryAmbiguous).toBe(true);
      expect(wk.data.alternate).toBeDefined();
      expect(wk.data.note).toMatch(/ask/i);
      // The alternate is the range the agent is told to read out ALONGSIDE the
      // primary, so it needs its own quotable phrase most of all.
      expect(wk.data.alternate.phrase).toBe(
        `Monday ${wk.data.alternate.weekStart} through Sunday ${wk.data.alternate.weekEnd}`,
      );
    } else {
      expect(wk.data.boundaryAmbiguous).toBeUndefined();
      expect(wk.data.alternate).toBeUndefined();
    }
  });

  test('resolve_date period modes: "last month" is a tool answer now, taught in the description', async () => {
    // The 2026-08-12 eval finding: no month/quarter/year mode existed, so the
    // model hand-wrote every calendar boundary ("last month" → '2026-07-01'
    // straight into SQL). The modes + their discoverability are the fix — pin
    // both, the same contract style as the week test above.
    const { tools } = await client.listTools();
    const def = tools.find((t) => t.name === 'resolve_date');
    for (const needle of ['month', 'quarter', 'year', 'periodStart', 'last Friday']) {
      expect(def?.description).toContain(needle);
    }
    const props = (def?.inputSchema as { properties?: Record<string, unknown> })?.properties;
    expect(props?.month).toBeDefined();
    expect(props?.quarter).toBeDefined();
    expect(props?.year).toBeDefined();

    // Quoted negative integer — the intArg coercion contract extends to the
    // new fields ("-1" is exactly how a model asks for "last month").
    const lastMonth = await call('resolve_date', { month: '-1' });
    expect(lastMonth.data.status).toBe('resolved_period');
    const today = localDateISO(new Date().toISOString(), 'America/Los_Angeles');
    expect(lastMonth.data.today).toBe(today);
    expect(lastMonth.data.timezone).toBe('America/Los_Angeles');
    // Boundary shape: first and last of a month, strictly before today, and
    // labelled + quotable like every other resolution.
    expect(lastMonth.data.periodStart.endsWith('-01')).toBe(true);
    expect(lastMonth.data.periodEnd < today).toBe(true);
    expect(lastMonth.data.periodStart < lastMonth.data.periodEnd).toBe(true);
    expect(lastMonth.data.label).toMatch(/^[A-Z][a-z]+ \d{4}$/);
    expect(lastMonth.data.phrase).toContain(`(${lastMonth.data.label})`);

    const q = await call('resolve_date', { quarter: 0 });
    expect(q.data.status).toBe('resolved_period');
    expect(q.data.label).toMatch(/^Q[1-4] \d{4}$/);
    expect(q.data.periodStart <= today && today <= q.data.periodEnd).toBe(true);

    // "last Friday": a single past date, weekday guaranteed by the tool.
    const lastFriday = await call('resolve_date', { weekday: 'friday', weeksAhead: -1 });
    expect(lastFriday.data.status).toBe('resolved');
    expect(lastFriday.data.weekday).toBe('friday');
    expect(lastFriday.data.date < today).toBe(true);
  });

  test('every tool result carries the temporal grounding rider `now` — arrays are wrapped, so none is left out', async () => {
    // The rider is the eval's condition-B line, firm-local (seed tenant tz =
    // America/Los_Angeles) — computed here with the same Intl formatting so a
    // wiring or timezone regression fails loudly. Computed via a THUNK and
    // accepted before-or-after each call, so a firm-local midnight rollover
    // mid-test can't flake the exact-string match (review finding).
    const lineNow = (): string => {
      const human = new Date().toLocaleDateString('en-US', {
        timeZone: 'America/Los_Angeles',
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
      });
      return `Right now it is ${human}, in the America/Los_Angeles timezone.`;
    };

    // An arbitrary object result gets the rider… (get_schedule: technician
    // surface, object-shaped result)
    const before1 = lineNow();
    const sched = await call('get_schedule', {});
    expect([before1, lineNow()]).toContain(sched.data.now);

    // …resolve_date keeps its own today/timezone fields alongside it (no
    // key collision: `weekday` there is the RESOLVED day's, `now` is today's).
    const before2 = lineNow();
    const rd = await call('resolve_date', { dayShift: 0 });
    expect([before2, lineNow()]).toContain(rd.data.now);
    expect(rd.data.today).toBeDefined();
    expect(rd.data.timezone).toBe('America/Los_Angeles');

    // …and a lookup that used to be a bare array is a named object now, so it
    // gets the rider and says "nothing" in words (retrieval layer 4).
    const before3 = lineNow();
    const rows = await call('find_customer', { query: 'no-such-customer-zzz' });
    expect(rows.data.customers).toEqual([]);
    expect(rows.data.note).toContain('no customer on this firm matches');
    expect([before3, lineNow()]).toContain(rows.data.now);
  });

  test('find_customer never shows the phone MATCH key, only the phone as written', async () => {
    await createCustomer({ tenantId, name: 'Keyless Kim', phone: '(206) 555-0181' });
    const found = await call('find_customer', { query: 'Keyless Kim' });
    expect(found.data.customers).toHaveLength(1);
    expect(found.data.customers[0].phone).toBe('(206) 555-0181');
    expect(found.data.customers[0]).not.toHaveProperty('phone_key');
  });

  test('an ambiguous note asks who, then RECORDS on the answer (no third call)', async () => {
    // FIRM-local today (seed tenant tz = America/Los_Angeles): the matcher
    // consults the capture's firm-local day, so the fixture must book there.
    const day = localDateISO(new Date().toISOString(), 'America/Los_Angeles');
    // The schedule consultation reads confirmed assignments now: a real
    // customer at '12 MCP St' with a job booked for tech-mcp TODAY.
    const mcpCust = await createCustomer({ tenantId, name: 'MCP Cust', addressLine1: '12 MCP St' });
    const mcpJob = await createJob({ tenantId, customerId: mcpCust.id, title: 'mcp visit' });
    await createVisit({
      tenantId,
      jobId: mcpJob.id,
      technicianId: techMcpId,
      startsAt: nl(`${day}T12:00:00.000Z`),
      endsAt: nl(`${day}T13:00:00.000Z`),
      status: 'confirmed',
    });

    const noteRows = async () =>
      Number(
        (
          await pg.query<{ n: string }>(
            "select count(*)::int as n from raw_captures where raw_text = 'all wrapped up'",
          )
        ).rows[0].n,
      );

    // Stage: identity ambiguous → ask, and NOTHING lands in L1.
    const first = await call('record_field_note', {
      text: 'all wrapped up',
      channel: 'technician_voice',
    });
    expect(first.isError).toBe(false);
    expect(first.data.status).toBe('needs_identity');
    expect(first.data.suggestion.address).toBe('12 MCP St');
    expect(await noteRows()).toBe(0);

    // Identity resume: the address resolves to the scheduled visit's REAL
    // customer (assignments always link one — no create-new prefill anymore).
    // Identity resume: plan ② (2026-08-21) — a missing datum was never a
    // confirmation, so supplying it RECORDS. There is no third call.
    const done = await call('record_field_note', {
      confirmId: first.data.confirmId,
      confirmed: { address: '12 MCP St' },
    });
    expect(done.data.status).toBe('recorded');
    expect(await noteRows()).toBe(1);

    const cap = await pg.query<{ channel: string; technician_ref: string; external_id: string }>(
      'select channel, technician_ref, external_id from raw_captures where id = $1',
      [done.data.captureId],
    );
    expect(cap.rows[0].channel).toBe('technician_voice');
    expect(cap.rows[0].technician_ref).toBe('tech-mcp'); // identity, not args
    expect(cap.rows[0].external_id).toBe(`note:${first.data.confirmId}`);

    const cust = await pg.query<{ name: string }>(
      'select name from customers where id = $1',
      [done.data.customerId],
    );
    expect(cust.rows[0].name).toBe('MCP Cust'); // preview == commit

    const vis = await pg.query<{ technician_id: string | null }>(
      'select technician_id from visit_participants where visit_id = $1',
      [done.data.visitId],
    );
    // Rung 9b made the person a real foreign key, resolved from the badge's
    // roster ref — not the free TEXT name the per-note table carried. Rung 9c
    // moved it onto the crew list, because a trip can carry more than one.
    expect(vis.rows[0].technician_id).toBe(techMcpId);

    // The token is consumed: a repeat confirm reports the note that already
    // landed. It used to throw "confirmation not found — restage", which since
    // the one-shot change would have talked the agent into a second permanent
    // write under a different stamp.
    const again = await call('record_field_note', { confirmId: first.data.confirmId });
    expect(again.isError).toBe(false);
    expect(again.data.status).toBe('duplicate');
    expect(again.data.captureId).toBe(done.data.captureId);
    expect(await noteRows()).toBe(1);
  });

  test('a note whose customer is KNOWN records on the first call, and a retry does not double it', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'One Shot Co',
      addressLine1: '9 Oneshot Ave',
    });
    const rows = async (text: string) =>
      Number(
        (
          await pg.query<{ n: string }>(
            'select count(*)::int as n from raw_captures where raw_text = $1',
            [text],
          )
        ).rows[0].n,
      );
    const visits = async () =>
      Number(
        (
          await pg.query<{ n: string }>(
            `select count(*)::int as n from visits v
               join jobs j on j.id = v.job_id
              where j.customer_id = $1`,
            [cust.id],
          )
        ).rows[0].n,
      );

    const done = await call('record_field_note', {
      text: 'swapped the capacitor',
      confirmed: { customerId: cust.id },
    });
    expect(done.data.status).toBe('recorded'); // NOT needs_confirmation
    expect(await rows('swapped the capacitor')).toBe(1);
    expect(await visits()).toBe(1);

    // The undeletable hazard: a retried tool call must not write a SECOND
    // permanent row and a SECOND visit. The content stamp is what stops it.
    const retry = await call('record_field_note', {
      text: 'swapped the capacitor',
      confirmed: { customerId: cust.id },
    });
    expect(retry.data.status).toBe('duplicate'); // reported honestly
    expect(await rows('swapped the capacitor')).toBe(1);
    expect(await visits()).toBe(1);

    // …but the SAME words about a DIFFERENT customer are a different note.
    const other = await createCustomer({
      tenantId,
      name: 'Other Co',
      addressLine1: '10 Other Ave',
    });
    const second = await call('record_field_note', {
      text: 'swapped the capacitor',
      confirmed: { customerId: other.id },
    });
    expect(second.data.status).toBe('recorded');
    expect(await rows('swapped the capacitor')).toBe(2);
  });

  test('answering needs_identity with an UNKNOWN address previews too — the resume path carve-out', async () => {
    // The first-call carve-out has a twin on the resume path, and it is the one
    // that is easy to lose: the technician already answered a question, so it
    // feels like a confirmation — but if the answer would MINT a customer, it
    // is not, and nothing may be created without the preview.
    const countCustomers = async () =>
      Number(
        (
          await pg.query<{ n: string }>(
            'select count(*)::int as n from customers where tenant_id = $1',
            [tenantId],
          )
        ).rows[0].n,
      );
    const first = await call('record_field_note', { text: 'gate was open, nobody home' });
    expect(first.data.status).toBe('needs_identity');
    const before = await countCustomers();

    const resumed = await call('record_field_note', {
      confirmId: first.data.confirmId,
      confirmed: { address: '999 Unheard Of Rd' },
    });
    expect(resumed.data.status).toBe('needs_confirmation'); // NOT recorded
    expect(resumed.data.preview.newCustomer).toBe(true);
    expect(await countCustomers()).toBe(before); // nothing minted
    expect(
      Number(
        (
          await pg.query<{ n: string }>(
            "select count(*)::int as n from raw_captures where raw_text = 'gate was open, nobody home'",
          )
        ).rows[0].n,
      ),
    ).toBe(0);
  });

  test('a stale COMMITTABLE token cannot double-write once the same note records one-shot', async () => {
    // The supersede must run on EVERY no-confirmId call, not only when the call
    // stages. Move it inside the staging branch and this happens:
    //   1. text T with an unknown address  -> stages item I, resolved={createFrom}
    //   2. same text T, customer now named -> records one-shot (content stamp)
    //   3. confirmId: I                    -> commits T AGAIN under note:<I>
    // Two permanent captures, two visits, no delete. The stale token has to be
    // COMMITTABLE for this to bite — an ambiguous stage carries no resolution,
    // so confirming it throws anyway and proves nothing.
    const cust = await createCustomer({
      tenantId,
      name: 'Supersede Guard',
      addressLine1: '31 Guard St',
    });
    const caps = async () =>
      Number(
        (
          await pg.query<{ n: string }>(
            "select count(*)::int as n from raw_captures where raw_text = 'topped up the refrigerant'",
          )
        ).rows[0].n,
      );

    const stagedNew = await call('record_field_note', {
      text: 'topped up the refrigerant',
      confirmed: { address: '888 Never Heard Of St' },
    });
    expect(stagedNew.data.status).toBe('needs_confirmation'); // committable token
    expect(await caps()).toBe(0);

    // The same note comes back, this time naming a customer we already have.
    const done = await call('record_field_note', {
      text: 'topped up the refrigerant',
      confirmed: { customerId: cust.id },
    });
    expect(done.data.status).toBe('recorded');
    expect(await caps()).toBe(1);

    // The stale token must be DEAD — superseded by the call above.
    const stale = await call('record_field_note', { confirmId: stagedNew.data.confirmId });
    expect(stale.isError).toBe(true);
    expect(await caps()).toBe(1); // still ONE, and no second visit
  });

  test('a consumed confirmId reports the landed note instead of ordering a restage', async () => {
    // The restage instruction was safe while restaging produced a preview. It
    // is not any more: the agent re-sends the text and it records under a
    // different stamp than `note:<confirmId>`, which the dedup cannot see.
    const staged = await call('record_field_note', {
      text: 'cleared the condensate line',
      confirmed: { address: '32 Consumed Ave' },
    });
    expect(staged.data.status).toBe('needs_confirmation');
    const done = await call('record_field_note', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('recorded');

    const again = await call('record_field_note', { confirmId: staged.data.confirmId });
    expect(again.isError).toBe(false); // NOT "confirmation not found — restage"
    expect(again.data.status).toBe('duplicate');
    expect(again.data.captureId).toBe(done.data.captureId);
    expect(String(again.data.note)).toContain('do NOT send it again');
  });

  // RUNG 10B.2 — an address is where they are, not who they are. These drive the
  // extractor directly: the guard compares `confirmed.address` to the NAME the
  // door is about to use, and this describe's shared stub returns no name at all.
  const noteWithName = (args: Record<string, unknown>) =>
    dispatchForIdentity('record_field_note', args, { tenantId, technicianRef: 'tech-mcp' }, {
      recordCost: async () => {},
      extract: async () => ({ customerName: 'Ruth Bramley', jobTitle: 'dripping tap' }),
    }) as Promise<Record<string, unknown>>;

  test("an address that is the customer's NAME is refused, not filed (rung 10b.2)", async () => {
    // Live specimen 2026-09-08: a customer was created with
    // `address_line1 = 'Ruth Bramley'`. `confirmed.address` does double duty —
    // it unlocks the mint AND becomes the address — so a caller with no address
    // is pressured to put something in the field. There is no address updater
    // anywhere in the app, so the fabrication is permanent.
    const countCustomers = async () =>
      Number(
        (await pg.query<{ n: string }>('select count(*)::int as n from customers where tenant_id = $1', [tenantId]))
          .rows[0].n,
      );
    const before = await countCustomers();
    await expect(
      noteWithName({
        text: 'Ruth Bramley emailed about a dripping tap',
        confirmed: { address: 'Ruth Bramley' },
      }),
    ).rejects.toThrow(/is the customer's NAME, not an address/);
    // Case, padding, internal whitespace and trailing punctuation are all the
    // SAME name — and the refusal quotes the string back, which is exactly the
    // prompt that produces "Ruth Bramley," on the retry (review finding).
    for (const evasion of ['  ruth bramley ', 'Ruth  Bramley', 'Ruth Bramley,', '"Ruth Bramley".']) {
      await expect(
        noteWithName({
          text: 'Ruth Bramley emailed about a dripping tap',
          confirmed: { address: evasion },
        }),
      ).rejects.toThrow(/is the customer's NAME, not an address/);
    }
    // …and the refusal names a way THROUGH, for the customer whose address
    // genuinely is a house name: write enough of it to read as a place.
    await expect(
      noteWithName({
        text: 'Ruth Bramley emailed about a dripping tap',
        confirmed: { address: 'Ruth Bramley' },
      }),
    ).rejects.toThrow(/add the street, the town or the postcode/);
    expect(await countCustomers()).toBe(before); // nothing minted on the way out
  });

  test('a REAL address still mints — the guard is the one shape, not addresses in general', async () => {
    const staged = await noteWithName({
      text: 'Ruth Bramley emailed about a dripping tap',
      confirmed: { address: '18 Bramley Road' },
    });
    expect(staged.status).toBe('needs_confirmation');
    expect((staged.preview as Record<string, unknown>).newCustomer).toBe(true);
    expect((staged.preview as Record<string, unknown>).address).toBe('18 Bramley Road');
  });

  test('a note that would CREATE a customer still previews first, and creates nothing yet', async () => {
    // The carve-out (user, 2026-08-21): a note is retractable, a customer
    // pinned by a stamped capture is not — so the confirm survives exactly
    // where revertability ends.
    const before = Number(
      (await pg.query<{ n: string }>('select count(*)::int as n from customers where tenant_id = $1', [tenantId]))
        .rows[0].n,
    );
    const staged = await call('record_field_note', {
      text: 'left the invoice on the counter',
      confirmed: { address: '404 Nowhere Ln' },
    });
    expect(staged.data.status).toBe('needs_confirmation');
    expect(staged.data.preview.newCustomer).toBe(true);
    const after = Number(
      (await pg.query<{ n: string }>('select count(*)::int as n from customers where tenant_id = $1', [tenantId]))
        .rows[0].n,
    );
    expect(after).toBe(before); // NOTHING minted without the yes
    expect(
      Number(
        (
          await pg.query<{ n: string }>(
            "select count(*)::int as n from raw_captures where raw_text = 'left the invoice on the counter'",
          )
        ).rows[0].n,
      ),
    ).toBe(0);

    // …and the yes still lands it, through the path staged tokens keep.
    const done = await call('record_field_note', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('recorded');
  });

  test('a new-customer stage previews; re-staging supersedes the old token', async () => {
    // Re-pointed by plan ② at the path that still stages: a KNOWN customer now
    // records one-shot, so only a would-create-a-customer answer previews.
    const a = await call('record_field_note', {
      text: 'first attempt',
      confirmed: { address: '77 Supersede Way' },
    });
    expect(a.data.status).toBe('needs_confirmation');
    expect(a.data.preview.newCustomer).toBe(true);
    expect(a.data.preview.address).toBe('77 Supersede Way');

    // Re-stage before confirming: one staged note per person.
    const b = await call('record_field_note', {
      text: 'second attempt',
      confirmed: { address: '77 Supersede Way' },
    });
    expect(b.data.status).toBe('needs_confirmation');
    expect(b.data.confirmId).not.toBe(a.data.confirmId);

    // The superseded token is dead; the live one commits its own staged copy.
    const dead = await call('record_field_note', { confirmId: a.data.confirmId });
    expect(dead.isError).toBe(true);
    expect(dead.text).toContain('confirmation not found');

    const done = await call('record_field_note', { confirmId: b.data.confirmId });
    expect(done.data.status).toBe('recorded');
    const cap = await pg.query<{ raw_text: string }>(
      'select raw_text from raw_captures where id = $1',
      [done.data.captureId],
    );
    expect(cap.rows[0].raw_text).toBe('second attempt'); // the STAGED copy, not the first
  });

  test('a forged confirmId is rejected; an expired staged note is dismissed', async () => {
    const forged = await call('record_field_note', {
      confirmId: '00000000-0000-0000-0000-000000000000',
    });
    expect(forged.isError).toBe(true);
    expect(forged.text).toContain('confirmation not found');

    const staged = await call('record_field_note', {
      text: 'about to expire',
      confirmed: { address: '78 Expiry Way' },
    });
    // Backdate the staging clock past the 15-min window (review_items is mutable).
    await pg.query(
      "update review_items set detail = jsonb_set(detail, '{stagedAt}', to_jsonb($1::text)) where id = $2",
      [new Date(Date.now() - 20 * 60_000).toISOString(), staged.data.confirmId],
    );
    const expired = await call('record_field_note', { confirmId: staged.data.confirmId });
    expect(expired.isError).toBe(true);
    expect(expired.text).toContain('expired');
    // And nothing was recorded.
    const caps = await pg.query<{ n: string }>(
      "select count(*)::int as n from raw_captures where raw_text = 'about to expire'",
    );
    expect(Number(caps.rows[0].n)).toBe(0);
  });

  test('crash-heal: commit landed but the token was left open — a retried confirm converges on ONE L1 row', async () => {
    const staged = await call('record_field_note', {
      text: 'healed note',
      confirmed: { address: '79 Heal Way' },
    });
    const done = await call('record_field_note', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('recorded');

    // Simulate the crash window: commit succeeded but the consume never ran.
    await pg.query(
      "update review_items set status = 'open', resolution = null, resolved_at = null where id = $1",
      [staged.data.confirmId],
    );
    const retried = await call('record_field_note', { confirmId: staged.data.confirmId });
    expect(retried.isError).toBe(false);
    expect(retried.data.status).toBe('duplicate'); // honest: already recorded once
    expect(retried.data.captureId).toBe(done.data.captureId); // same row, not a second

    const caps = await pg.query<{ n: string }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [`note:${staged.data.confirmId}`],
    );
    expect(Number(caps.rows[0].n)).toBe(1);
  });

  test('get_customer_context returns the contents page, never the history', async () => {
    const customer = await createCustomer({ tenantId, name: 'Ctx Over Mcp', phone: '555-3300' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'J' });
    await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'x'.repeat(300),
      jobId: job.id,
    });

    const { isError, data } = await call('get_customer_context', { customerId: customer.id });
    expect(isError).toBe(false);
    expect(data.customer.id).toBe(customer.id);
    // The phone as written, never the generated matching key beside it.
    expect(data.customer.phone).toBe('555-3300');
    expect(data.customer).not.toHaveProperty('phone_key');
    const block = data.jobs.find((j: { id: string }) => j.id === job.id);
    expect(block.title).toBe('J'); // the job row, spread
    expect(block.noteCount).toBe(1);
    expect(block.restrictedCount).toBe(0);
    // The newest note's opening, cut, with the id that opens the full words.
    expect(block.newest.snippet).toHaveLength(200);
    expect(block.newest.truncated).toBe(true);
    expect(typeof block.newest.captureId).toBe('string');
    expect(data.olderJobs).toBe(0);
    expect(data.customerLevelNotes).toEqual({ noteCount: 0, restrictedCount: 0, newest: null });
    expect(data.note).toContain('contents page');
    // The old bulk fields are gone.
    expect(data.recentCaptures).toBeUndefined();
    expect(data.recentVisits).toBeUndefined();
  });

  test('get_customer_context on a bogus customerId says so in words', async () => {
    const { isError, data } = await call('get_customer_context', {
      customerId: '00000000-0000-0000-0000-000000000000',
    });
    expect(isError).toBe(false);
    expect(data.customer).toBeNull();
    expect(data.jobs).toEqual([]);
    expect(data.note).toContain('no such customer');
  });

  test('an invalid channel is rejected as a tool error', async () => {
    const { isError } = await call('record_field_note', {
      text: 'x',
      channel: 'not_a_channel',
    });
    expect(isError).toBe(true);
  });

  test('id-based read tools are tenant-scoped: a cross-tenant id reads as not-found', async () => {
    const WRONG_TENANT = '00000000-0000-0000-0000-000000000000';
    const customer = await createCustomer({ tenantId, name: 'Tenant Scoped', phone: '555-7700' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Scoped Job' });

    // Correct tenant (the shared client, identity tenant == seed tenant) sees the rows.
    const okJob = await call('get_job', { jobId: job.id });
    expect(okJob.isError).toBe(false);
    expect(okJob.data.id).toBe(job.id);
    const okCtx = await call('get_customer_context', { customerId: customer.id });
    expect(okCtx.data.customer.id).toBe(customer.id);

    // Wrong tenant: the SAME ids read as empty / null across all the read tools.
    const { client: otherClient, callWith } = await clientFor({
      tenantId: WRONG_TENANT,
      technicianRef: 'tech-x',
    });
    try {
      expect((await callWith('get_job', { jobId: job.id })).data).toBeNull();

      const ctx = await callWith('get_customer_context', { customerId: customer.id });
      expect(ctx.data.customer).toBeNull();
      expect(ctx.data.jobs).toEqual([]);

      // The page reader: an unknown scope, said in words, never their notes.
      const byJob = await callWith('list_recent_captures', { jobId: job.id });
      expect(byJob.data.captures).toEqual([]);
      expect(byJob.data.note).toContain('no such job');
      const byCust = await callWith('list_recent_captures', { customerId: customer.id });
      expect(byCust.data.captures).toEqual([]);
      expect(byCust.data.note).toContain('no such customer');
    } finally {
      await otherClient.close();
    }
  });

  // Long timeout: this walks the whole seat lifecycle (~15 live DB round-trips).
  test('admin tools: tier-filtered listing and manager-only dispatch', { timeout: 30_000 }, async () => {
    // The technician-identity client neither lists nor may call ANY admin tool.
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).not.toContain('add_technician_seat');
    expect(names).not.toContain('list_team');
    for (const [tool, args] of [
      ['add_technician_seat', { displayName: 'Eve Attacker' }],
      ['deactivate_technician_seat', { ref: 'mgr-test' }],
      ['list_team', {}],
    ] as const) {
      const denied = await call(tool, args as Record<string, unknown>);
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('manager badge');
    }

    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
      expect(mgrTools).toEqual(
        expect.arrayContaining([
          'add_technician_seat',
          'deactivate_technician_seat',
          'list_team',
        ]),
      );
      // get_schedule is NOT on the manager surface (user decision 2026-07-19):
      // managers get exactly ONE schedule read (get_team_schedule, which
      // includes their own visits), so the self-view misroute cannot recur.
      // The dispatch gate backstops stale cached tool lists.
      expect(mgrTools).not.toContain('get_schedule');
      const selfView = await callWith('get_schedule', {});
      expect(selfView.isError).toBe(true);
      expect(selfView.text).toContain('technician route view');
      expect(selfView.text).toContain('get_team_schedule');

      // Add is TWO-STEP (irreversible: permanent ref + a seat). Stage first —
      // nothing is inserted until the confirming call.
      const addStage = await callWith('add_technician_seat', { displayName: 'Bob Marley' });
      expect(addStage.data.status).toBe('needs_confirmation');
      expect(addStage.data.preview).toMatchObject({ ref: 'bob-marley', tier: 'technician' });
      const preConfirm = await pg.query(
        "select count(*)::int as n from technicians where tenant_id = $1 and ref = 'bob-marley'",
        [tenantId],
      );
      expect(preConfirm.rows[0].n).toBe(0); // staged ≠ inserted

      // A forged confirmId mints nothing.
      const forgedSeat = await callWith('add_technician_seat', {
        confirmId: '00000000-0000-0000-0000-000000000000',
      });
      expect(forgedSeat.isError).toBe(true);

      const added = await callWith('add_technician_seat', { confirmId: addStage.data.confirmId });
      expect(added.isError).toBe(false);
      expect(added.data).toMatchObject({
        ref: 'bob-marley',
        tier: 'technician',
        state: 'invited',
        seat_exempt: false, // no seatExempt arg = a normal seat-occupying add
      });
      // The confirm result goes into the model's context: never the badge hash,
      // the Composio handles or the Telegram id (list_team projects them out too).
      for (const key of Object.keys(added.data)) {
        expect(key).not.toMatch(
          /^(badge_hash|composio_|telegram_user_id|connected_email|host_id|tenant_id)/,
        );
      }

      // Duplicate display name now fails at STAGE time (dup pre-check) —
      // before any yes is spent on it.
      const dup = await callWith('add_technician_seat', { displayName: 'Bob Marley' });
      expect(dup.isError).toBe(true);
      expect(dup.text).toContain("ref 'bob-marley' is taken");

      // Fill the last seat, then exceed: the cap is a moving target, so it
      // surfaces at CONFIRM (the insert), with the purchase error verbatim.
      const carlStage = await callWith('add_technician_seat', { displayName: 'Carl Sagan' });
      const carlEarly = await callWith('add_technician_seat', { confirmId: carlStage.data.confirmId });
      expect(carlEarly.isError).toBe(false); // seat 3/3
      const danStage = await callWith('add_technician_seat', { displayName: 'Dan Dare' });
      expect(danStage.data.status).toBe('needs_confirmation'); // cap not pre-checked
      const capped = await callWith('add_technician_seat', { confirmId: danStage.data.confirmId });
      expect(capped.isError).toBe(true);
      expect(capped.text).toContain('no free technician seats');

      // Deactivate is two-step; repeat first calls return the SAME confirmId.
      const first = await callWith('deactivate_technician_seat', { ref: 'bob-marley' });
      expect(first.data.status).toBe('needs_confirmation');
      expect(first.data.displayName).toBe('Bob Marley');
      const again = await callWith('deactivate_technician_seat', { ref: 'bob-marley' });
      expect(again.data.confirmId).toBe(first.data.confirmId);

      // A forged confirmId must not deactivate (nor resolve anything else).
      const forged = await callWith('deactivate_technician_seat', {
        ref: 'bob-marley',
        confirmId: '00000000-0000-0000-0000-000000000000',
      });
      expect(forged.isError).toBe(true);

      const confirmed = await callWith('deactivate_technician_seat', {
        ref: 'bob-marley',
        confirmId: first.data.confirmId,
      });
      // Closed shape: exactly these keys + the universal grounding rider.
      expect(confirmed.data).toEqual({
        status: 'deactivated',
        ref: 'bob-marley',
        now: expect.any(String),
      });
      const state = await pg.query<{ state: string }>(
        "select state from technicians where tenant_id = $1 and ref = 'bob-marley'",
        [tenantId],
      );
      expect(state.rows[0].state).toBe('offboarding'); // cross-channel read-back

      // Repeat deactivation is idempotent, not an error.
      const repeat = await callWith('deactivate_technician_seat', { ref: 'bob-marley' });
      expect(repeat.data).toEqual({
        status: 'already_deactivated',
        ref: 'bob-marley',
        now: expect.any(String),
      });

      // The freed seat is immediately usable — the earlier capped add now works
      // (fresh stage: the failed confirm consumed its token).
      const danRetry = await callWith('add_technician_seat', { displayName: 'Dan Dare' });
      const dan = await callWith('add_technician_seat', { confirmId: danRetry.data.confirmId });
      expect(dan.isError).toBe(false);
      expect(dan.data.ref).toBe('dan-dare');

      // Self-deactivation is refused outright.
      const self = await callWith('deactivate_technician_seat', { ref: 'mgr-test' });
      expect(self.isError).toBe(true);
      expect(self.text).toContain('cannot deactivate yourself');

      // list_team: roster facts only — no Composio ids in the payload.
      const team = await callWith('list_team', {});
      const bob = team.data.team.find((t: { ref: string }) => t.ref === 'bob-marley');
      expect(bob).toMatchObject({ displayName: 'Bob Marley', state: 'offboarding' });
      expect(Object.keys(bob)).not.toContain('composio_connected_account_id');

      // (The review queue's checks stood here — the list, an item's briefing,
      // resolve and dismiss, a staged deactivation refused as "resolved" and
      // cancelled, and a cross-tenant resolve. list_pending_reviews and
      // resolve_review were retired on 2026-09-19; the queue's paging died
      // with them, and staged tokens now simply expire.)
    } finally {
      await mgrClient.close();
    }
  });

  // Long timeout: full seat-exempt lifecycle against the live DB (add → fences
  // → deactivate → reactivate), entered with the technician cap provably FULL
  // (tech-mcp, carl-sagan, dan-dare — the state the admin test above leaves).
  test('seat-exempt add: schedule-only person past a full cap; identity verbs fence', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      // Arg validation: non-boolean rejected (SDK never checks inputSchema);
      // a seat-exempt MANAGER is refused (would dodge the manager cap).
      const junk = await callWith('add_technician_seat', {
        displayName: 'Helper Hman',
        seatExempt: 'yes',
      });
      expect(junk.isError).toBe(true);
      expect(junk.text).toContain('seatExempt must be a boolean');
      const mgrExempt = await callWith('add_technician_seat', {
        displayName: 'Boss Man',
        tier: 'manager',
        seatExempt: true,
      });
      expect(mgrExempt.isError).toBe(true);
      expect(mgrExempt.text).toContain('technician-tier rows only');

      // Stage: the preview carries the flag and the note says NO seat.
      const stage = await callWith('add_technician_seat', {
        displayName: 'Helper Hman',
        seatExempt: true,
      });
      expect(stage.data.status).toBe('needs_confirmation');
      expect(stage.data.preview).toMatchObject({
        ref: 'helper-hman',
        tier: 'technician',
        seatExempt: true,
      });
      expect(stage.data.note).toContain('NOT occupy a seat');

      // Confirm past the FULL cap: the row lands exempt AND straight to active.
      const added = await callWith('add_technician_seat', { confirmId: stage.data.confirmId });
      expect(added.isError).toBe(false);
      expect(added.data).toMatchObject({
        ref: 'helper-hman',
        seat_exempt: true,
        state: 'active',
      });
      const row = await pg.query<{ seat_exempt: boolean; state: string }>(
        "select seat_exempt, state from technicians where tenant_id = $1 and ref = 'helper-hman'",
        [tenantId],
      );
      expect(row.rows[0]).toEqual({ seat_exempt: true, state: 'active' }); // read-back

      // Pre-deploy token compatibility: a staged detail WITHOUT the seatExempt
      // key (the pre-feature shape, crafted via the db layer — the tool always
      // writes the key now) must commit as a SEAT-OCCUPYING add. At the full
      // cap that means the honest cap error — an exempt insert would succeed.
      const legacyAtCap = await upsertOpenReviewItem({
        tenantId,
        kind: 'pending_seat_add',
        subjectRef: 'mgr-test',
        detail: {
          ref: 'legacy-guy',
          displayName: 'Legacy Guy',
          tier: 'technician',
          stagedAt: new Date().toISOString(),
        },
      });
      const legacyBlocked = await callWith('add_technician_seat', { confirmId: legacyAtCap.id });
      expect(legacyBlocked.isError).toBe(true);
      expect(legacyBlocked.text).toContain('no free technician seats');
      // …and with a seat free, the same pre-feature shape commits seat_exempt
      // FALSE in the pre-feature default state ('invited').
      await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 4 });
      const legacyFree = await upsertOpenReviewItem({
        tenantId,
        kind: 'pending_seat_add',
        subjectRef: 'mgr-test',
        detail: {
          ref: 'legacy-gal',
          displayName: 'Legacy Gal',
          tier: 'technician',
          stagedAt: new Date().toISOString(),
        },
      });
      const legacyAdded = await callWith('add_technician_seat', { confirmId: legacyFree.id });
      expect(legacyAdded.isError).toBe(false);
      expect(legacyAdded.data).toMatchObject({
        ref: 'legacy-gal',
        seat_exempt: false,
        state: 'invited',
      });
      // Restore the entry state: legacy-gal offboarded, capacity back to 3.
      await updateTechnician(legacyAdded.data.id, { state: 'offboarded' });
      await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 3 });

      // The identity fences: no Telegram/assistant, no email pairing — ever.
      const bindDenied = await callWith('bind_telegram', {
        ref: 'helper-hman',
        telegramUserId: '4440001',
      });
      expect(bindDenied.isError).toBe(true);
      expect(bindDenied.text).toContain('schedule-only');

      // list_team surfaces the flag on every row.
      const team = await callWith('list_team', {});
      expect(team.data.team.find((t: { ref: string }) => t.ref === 'helper-hman')).toMatchObject({
        seatExempt: true,
        state: 'active',
        sandboxRef: null,
        botUsername: null,
      });
      expect(
        team.data.team.find((t: { ref: string }) => t.ref === 'mgr-test'),
      ).toMatchObject({ seatExempt: false });

      // Deactivate ↔ reactivate round-trip AT THE FULL CAP: comes back ACTIVE
      // (never 'invited' — they can never pair; the trigger skips exempt rows
      // so the cap cannot block them) and with NO bind_telegram dead-end note.
      const ask = await callWith('deactivate_technician_seat', { ref: 'helper-hman' });
      expect(ask.data.status).toBe('needs_confirmation');
      const done = await callWith('deactivate_technician_seat', {
        ref: 'helper-hman',
        confirmId: ask.data.confirmId,
      });
      expect(done.data.status).toBe('deactivated');
      // Fence order: even DEACTIVATED, the identity verbs answer with the
      // permanent truth ('schedule-only'), never 'reactivate the seat first'
      // — which would steer the manager into a pointless reactivation.
      const bindWhileOff = await callWith('bind_telegram', {
        ref: 'helper-hman',
        telegramUserId: '4440002',
      });
      expect(bindWhileOff.isError).toBe(true);
      expect(bindWhileOff.text).toContain('schedule-only');
      const back = await callWith('reactivate_technician_seat', { ref: 'helper-hman' });
      expect(back.isError).toBe(false);
      expect(back.data).toMatchObject({ status: 'reactivated', state: 'active' });
      expect(back.data.note ?? '').not.toContain('bind_telegram');
    } finally {
      await mgrClient.close();
    }
  });

  test('record_field_note write path is tenant-scoped: a cross-tenant confirmed.customerId is rejected', async () => {
    // A customer that belongs to the seed tenant...
    const customer = await createCustomer({ tenantId, name: 'Write Guard Cust', phone: '555-8800' });
    // ...is not addressable by a DIFFERENT tenant's agent via confirmed.customerId.
    const { client: otherClient, callWith } = await clientFor({
      tenantId: '00000000-0000-0000-0000-000000000000',
      technicianRef: 'tech-x',
    });
    try {
      const res = await callWith('record_field_note', {
        text: 'sneaky cross-tenant write',
        confirmed: { customerId: customer.id },
      });
      expect(res.isError).toBe(true); // rejected before any L1/L2 row is written
    } finally {
      await otherClient.close();
    }

    // And no raw_capture was appended for the rejected write (guard runs first).
    const caps = await pg.query<{ n: string }>(
      "select count(*)::text as n from raw_captures where raw_text = 'sneaky cross-tenant write'",
    );
    expect(caps.rows[0].n).toBe('0');
  });
});

// The spine counter is the ALLOCATION BASIS for inference cost: agent inference
// runs on a gateway shared by every tenant on one API key, so there is no
// per-tenant split to read from the provider. The rollup divides the DeepInfra
// invoice by these counts — if they are wrong, every tenant's inference figure
// is wrong.
describe('spine tool_call cost counter', () => {
  test('one event per tool call, tagged with the calling tenant', async () => {
    await pg.query("delete from cost_events where provider = 'spine'");
    await call('find_customer', { query: 'nobody-by-this-name' });
    await call('list_recent_captures', { limit: 1 });
    const { rows } = await pg.query(
      `select tenant_id, metadata->>'tool' as tool from cost_events
       where provider = 'spine' and sku = 'tool_call' order by created_at`,
    );
    expect(rows.map((r) => r.tool)).toEqual(['find_customer', 'list_recent_captures']);
    expect(rows.every((r) => r.tenant_id === tenantId)).toBe(true);
  });

  // Cost accounting must never break the thing it measures. A ledger write that
  // fails is a missing row; a tool that fails because the ledger did is an
  // outage — the driveMeasured:false precedent, applied to money.
  test('a failing cost write does not break the tool', async () => {
    const { callWith } = await clientFor(
      { tenantId, technicianRef: 'tech-mcp' },
      { recordCost: async () => { throw new Error('cost ledger is down'); } },
    );
    const res = await callWith('find_customer', { query: 'nobody-by-this-name' });
    expect(res.isError).toBe(false);
    expect(res.data.customers).toEqual([]);
  });

  test('a REFUSED call still counts — the agent burned a turn on it', async () => {
    await pg.query("delete from cost_events where provider = 'spine'");
    // A technician badge reaching for a manager-only tool: refused by the tier
    // gate, but the inference that produced the attempt was already paid for.
    const res = await call('list_team', {});
    expect(res.isError).toBe(true);
    const { rows } = await pg.query(
      `select metadata->>'tool' as tool from cost_events where provider = 'spine'`,
    );
    expect(rows.map((r) => r.tool)).toEqual(['list_team']);
  });
});

describe('a retraction never moves money, and says which entries lost their evidence', () => {
  test('the preview lists the money, the technician is pointed at the manager, and every reader agrees on the balance', { timeout: 30_000 }, async () => {
    const customer = await createCustomer({ tenantId, name: 'Cash Cust', phone: '555-3388' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Cash job' });
    // The technician's note, and money a manager recorded FROM it.
    const note = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'collected $500 cash from the customer',
      jobId: job.id,
    });
    const { client: mgrClient, callWith: mgr } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const invoice = await mgr('record_money_event', { jobId: job.id, kind: 'invoice_issued', amountCents: 80000 });
      expect(invoice.isError).toBe(false);
      const paid = await mgr('record_money_event', {
        jobId: job.id,
        kind: 'payment_received',
        amountCents: 50000,
        method: 'cash',
        sourceCaptureId: note.id,
      });
      expect(paid.isError).toBe(false);
      const eventId = paid.data.eventId as number;

      // The technician (the note's author) stages the retraction.
      const staged = await call('retract_capture', { captureId: note.id, reason: 'wrong customer' });
      expect(staged.isError).toBe(false);
      // The entry is named — id, job, kind — but NOT its amount: a technician is
      // shown no money figure anywhere (operator 2026-09-15). inform_team_lead's
      // wording asks her to name the entry, which is exactly what she has.
      expect(staged.data.alsoLosesEvidence.money).toEqual([
        { eventId, jobId: job.id, kind: 'payment_received', occurredAt: expect.any(String) },
      ]);
      expect(staged.data.note).toContain('STILL COUNT');
      expect(staged.data.note).toContain('inform_team_lead'); // a technician cannot correct money
      expect(staged.data.note).not.toContain('record_money_event');

      const done = await call('retract_capture', { confirmId: staged.data.confirmId });
      expect(done.data.status).toBe('retracted');
      // The CONFIRM shape is pinned too, not just its ids: a technician is shown
      // no amount on either half of the two-step (review finding).
      expect(done.data.alsoLostEvidence.money).toEqual([
        { eventId, jobId: job.id, kind: 'payment_received', occurredAt: expect.any(String) },
      ]);
      expect(done.data.moneyNote).toContain('inform_team_lead');

      // EVERY reader sums the same ledger: the payment still counts on both.
      const ctx = await mgr('get_customer_context', { customerId: customer.id });
      const job1 = await mgr('get_job', { jobId: job.id });
      expect(ctx.data.moneyByJob[job.id].balanceDueCents).toBe(30000);
      expect(job1.data.money.balanceDueCents).toBe(30000);

      // A manager sees that the job carries a retraction; a technician's page has no such key.
      const mgrJob = ctx.data.jobs.find((j: { id: string }) => j.id === job.id);
      expect(mgrJob.retractedCount).toBe(1);
      const techCtx = await call('get_customer_context', { customerId: customer.id });
      const techJob = techCtx.data.jobs.find((j: { id: string }) => j.id === job.id);
      expect(techJob.retractedCount).toBeUndefined();
      // …and the manager can open the trail with the reason.
      const trail = await mgr('list_recent_captures', { jobId: job.id, includeRetracted: true });
      const row = trail.data.captures.find((c: { captureId: string }) => c.captureId === note.id);
      expect(row.retracted.reason).toBe('wrong customer');

      // A manager retracting a money-citing note is pointed at the correction instead.
      const note2 = await appendRawCapture({
        tenantId,
        channel: 'technician_note',
        technicianRef: 'tech-mcp',
        rawText: 'second cash note',
        jobId: job.id,
      });
      await mgr('record_money_event', {
        jobId: job.id,
        kind: 'payment_received',
        amountCents: 10000,
        sourceCaptureId: note2.id,
      });
      const mgrStaged = await mgr('retract_capture', { captureId: note2.id, reason: 'duplicate' });
      expect(mgrStaged.data.note).toContain('record_money_event');
      expect(mgrStaged.data.note).toContain('correctsEventId');
    } finally {
      await mgrClient.close();
    }
  });
});

describe('the size cap at the door', () => {
  test('a result over SPINE_RESULT_CAP_CHARS is cut and says so, and the cut is still valid JSON', async () => {
    const customer = await createCustomer({ tenantId, name: 'Cap Cust', phone: '555-3377' });
    await createJob({ tenantId, customerId: customer.id, title: 'Cap job one' });
    await createJob({ tenantId, customerId: customer.id, title: 'Cap job two' });
    const before = process.env.SPINE_RESULT_CAP_CHARS;
    process.env.SPINE_RESULT_CAP_CHARS = '600';
    try {
      const res = await call('get_customer_context', { customerId: customer.id });
      expect(res.isError).toBe(false);
      // `call` already JSON.parsed the text — so the cut object parses, and it
      // fits its own limit (escaping the embedded text must not push it over).
      expect(res.text.length).toBeLessThanOrEqual(600);
      expect(res.data.truncated).toBe(true);
      expect(res.data.limit).toBe(600);
      expect(res.data.chars).toBeGreaterThan(600);
      expect(res.data.partial.length).toBeGreaterThan(0);
      expect(res.data.partial.startsWith('{"customer":')).toBe(true);
      expect(res.data.note).toContain('get_capture');
      // The `now` rider rides on the cut object, not lost off the tail.
      expect(typeof res.data.now).toBe('string');
    } finally {
      if (before === undefined) delete process.env.SPINE_RESULT_CAP_CHARS;
      else process.env.SPINE_RESULT_CAP_CHARS = before;
    }
    // Back at the default, the same read comes through whole.
    const whole = await call('get_customer_context', { customerId: customer.id });
    expect(whole.data.truncated).toBeUndefined();
    expect(whole.data.jobs).toHaveLength(2);
  });
});

describe('the drill-down reads: a page, a note, a search', () => {
  test('list_recent_captures pages with a cursor the model copies back, newest first, text cut', async () => {
    const customer = await createCustomer({ tenantId, name: 'Pager Cust', phone: '555-3344' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Long job' });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const row = await appendRawCapture({
        tenantId,
        channel: 'technician_note',
        technicianRef: 'tech-mcp',
        rawText: `note ${i} ${'x'.repeat(50)}`,
        jobId: job.id,
      });
      ids.push(row.id);
    }
    const first = await call('list_recent_captures', { jobId: job.id, limit: 2, textChars: 10 });
    expect(first.isError).toBe(false);
    expect(first.data.captures.map((c: { captureId: string }) => c.captureId)).toEqual([ids[4], ids[3]]);
    expect(first.data.captures[0].text).toHaveLength(10);
    expect(first.data.captures[0].textTruncated).toBe(true);
    expect(first.data.hasMore).toBe(true);
    expect(first.data.totalVisible).toBe(5);
    expect(first.data.note).toContain('more older notes');
    expect(first.data.note).toContain('5 you may read in all');
    expect(typeof first.data.next).toBe('string');

    const second = await call('list_recent_captures', { jobId: job.id, limit: 2, before: first.data.next });
    expect(second.data.captures.map((c: { captureId: string }) => c.captureId)).toEqual([ids[2], ids[1]]);
    // The note never claims a remaining count it does not have (page 2 has one left, not three).
    expect(second.data.note).toContain('more older notes');
    expect(second.data.note).not.toMatch(/\d+ older/);
    const third = await call('list_recent_captures', { jobId: job.id, limit: 2, before: second.data.next });
    expect(third.data.captures.map((c: { captureId: string }) => c.captureId)).toEqual([ids[0]]);
    expect(third.data.hasMore).toBe(false);
    expect(third.data.next).toBeNull();
    expect(third.data.note).toContain('every note');

    // A cursor that is not a `next` value is refused in words, not passed to the database.
    const bad = await call('list_recent_captures', { jobId: job.id, before: 'yesterday' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('copied exactly');
    // A job with nothing on it says so.
    const empty = await createJob({ tenantId, customerId: customer.id, title: 'Quiet job' });
    expect((await call('list_recent_captures', { jobId: empty.id })).data.note).toContain('no notes on file');
  });

  test('get_capture opens one note in full; a cross-tenant or malformed id is "not found", never an error', async () => {
    const customer = await createCustomer({ tenantId, name: 'Full Cust', phone: '555-3355' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Full job' });
    const note = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'the whole story, every word of it',
      jobId: job.id,
    });
    const got = await call('get_capture', { captureId: note.id });
    expect(got.data.found).toBe(true);
    expect(got.data.rawText).toBe('the whole story, every word of it');
    expect(got.data.memberships).toEqual([{ customerId: customer.id, jobId: job.id, visitId: null, via: 'job_stamp' }]);
    expect(got.data.metadata).toBeUndefined(); // headers are not a seat's business

    expect((await call('get_capture', { captureId: 'not-a-uuid' })).data.found).toBe(false);
    const { client: otherClient, callWith } = await clientFor({
      tenantId: '00000000-0000-0000-0000-000000000000',
      technicianRef: 'tech-x',
    });
    try {
      expect((await callWith('get_capture', { captureId: note.id })).data.found).toBe(false);
    } finally {
      await otherClient.close();
    }
  });

  test('search_captures finds by word form and by bare code, inside the scope, with snippets', async () => {
    const customer = await createCustomer({ tenantId, name: 'Search Cust', phone: '555-3366' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Search job' });
    const other = await createJob({ tenantId, customerId: customer.id, title: 'Other job' });
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'Capacitors failing again, recommend replacement; lockbox 4321 by the gate',
      jobId: job.id,
    });
    await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'capacitor on the other job',
      jobId: other.id,
    });
    const word = await call('search_captures', { jobId: job.id, query: 'capacitor' });
    expect(word.data.matches.map((m: { captureId: string }) => m.captureId)).toEqual([cap.id]);
    expect(word.data.matches[0].snippet).toContain('Capacitors failing');
    expect(word.data.note).toContain('get_capture');
    const code = await call('search_captures', { customerId: customer.id, query: '4321' });
    expect(code.data.matches.map((m: { captureId: string }) => m.captureId)).toEqual([cap.id]);
    const whole = await call('search_captures', { customerId: customer.id, query: 'capacitor' });
    expect(whole.data.count).toBe(2);
    const none = await call('search_captures', { jobId: job.id, query: 'thermostat' });
    expect(none.data.count).toBe(0);
    expect(none.data.note).toContain('nothing you may read here mentions');
  });
});

describe('retract_capture + retraction folding', () => {
  test('author two-step retraction; context stops showing the capture and its visit', async () => {
    const customer = await createCustomer({ tenantId, name: 'Retract Cust', phone: '555-3311' });
    // One call now (plan ②) — a known customer records straight away.
    const done = await call('record_field_note', {
      text: 'bad note to retract',
      confirmed: { customerId: customer.id },
    });
    expect(done.data.status).toBe('recorded');

    const retractionRows = async () =>
      Number(
        (
          await pg.query<{ n: string }>(
            'select count(*)::int as n from raw_captures where retracts_capture_id = $1',
            [done.data.captureId],
          )
        ).rows[0].n,
      );

    // Stage the retraction: nothing written yet.
    const r1 = await call('retract_capture', {
      captureId: done.data.captureId,
      reason: 'wrong customer',
    });
    expect(r1.isError).toBe(false);
    expect(r1.data.status).toBe('needs_confirmation');
    expect(r1.data.targetPreview).toContain('bad note to retract');
    expect(await retractionRows()).toBe(0);

    // Confirm: the retraction row lands, pointing at the target.
    const r2 = await call('retract_capture', { confirmId: r1.data.confirmId });
    expect(r2.data.status).toBe('retracted');
    expect(r2.data.captureId).toBe(done.data.captureId);
    expect(await retractionRows()).toBe(1);

    // Folded contents: the note no longer counts, and the trip it minted is
    // gone with it (lastVisitAt reads over live-sourced visits only).
    const ctx = await call('get_customer_context', { customerId: customer.id });
    const job = ctx.data.jobs.find((j: { id: string }) => j.id === done.data.jobId);
    expect(job.noteCount).toBe(0);
    expect(job.newest).toBeNull();
    expect(job.lastVisitAt).toBeNull();
    expect(ctx.data.customerLevelNotes.noteCount).toBe(0);
  });

  test('permissions: a non-author technician cannot retract; a manager can', async () => {
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'perm target',
    });
    const { client: otherTech, callWith: callOther } = await clientFor({
      tenantId,
      technicianRef: 'tech-other',
    });
    try {
      const denied = await callOther('retract_capture', { captureId: cap.id, reason: 'nope' });
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('only the author or a manager');
    } finally {
      await otherTech.close();
    }

    const { client: mgrClient, callWith: callMgr } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const s = await callMgr('retract_capture', { captureId: cap.id, reason: 'manager cleanup' });
      expect(s.data.status).toBe('needs_confirmation');
      const c = await callMgr('retract_capture', { confirmId: s.data.confirmId });
      expect(c.data.status).toBe('retracted');
    } finally {
      await mgrClient.close();
    }
  });

  // The review queue's retirement (2026-09-19): a call that needs a person is a
  // `call_action` OBSERVATION keyed on its capture. A manager retracting the
  // call as recorded in error must take the planner's reason to chase anybody
  // about it with it — the same rule the rung-10 inbound kinds already follow.
  test('retracting a call dismisses its call_action observation', async () => {
    const cap = await appendRawCapture({
      tenantId,
      channel: 'phone_call',
      technicianRef: 'phone-line',
      rawText: 'please cancel my appointment',
    });
    const obs = await raiseCallActionObservation({
      tenantId,
      captureId: cap.id,
      intents: ['cancel'],
      priority: 'normal',
      callerPhone: '+15551230099',
    });
    if (!obs) throw new Error('fixture call_action was deduped');
    const { client: mgrClient, callWith: callMgr } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const s = await callMgr('retract_capture', { captureId: cap.id, reason: 'wrong number' });
      const c = await callMgr('retract_capture', { confirmId: s.data.confirmId });
      expect(c.data.status).toBe('retracted');
    } finally {
      await mgrClient.close();
    }
    const { rows } = await pg.query<{ status: string; dismiss_reason: string | null }>(
      'select status, dismiss_reason from observations where id = $1',
      [obs.id],
    );
    expect(rows[0].status).toBe('dismissed');
    expect(rows[0].dismiss_reason).toContain('the capture was retracted by mgr-test: wrong number');
  });

  test('double-retract blocked at stage AND at a racing confirm (one retraction row total)', async () => {
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'race target',
    });
    // The tech stages first...
    const techStage = await call('retract_capture', { captureId: cap.id, reason: 'tech reason' });
    expect(techStage.data.status).toBe('needs_confirmation');
    // ...and a manager stages AND confirms while the tech token is still open.
    const { client: mgrClient, callWith: callMgr } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const mgrStage = await callMgr('retract_capture', { captureId: cap.id, reason: 'mgr reason' });
      const mgrDone = await callMgr('retract_capture', { confirmId: mgrStage.data.confirmId });
      expect(mgrDone.data.status).toBe('retracted');
    } finally {
      await mgrClient.close();
    }
    // The tech's confirm loses the race cleanly (unique index, not a 500).
    const lost = await call('retract_capture', { confirmId: techStage.data.confirmId });
    expect(lost.isError).toBe(true);
    expect(lost.text).toContain('already retracted');
    // The stage-time guard also refuses now.
    const restage = await call('retract_capture', { captureId: cap.id, reason: 'again' });
    expect(restage.isError).toBe(true);
    expect(restage.text).toContain('already retracted');
    // Exactly one permanent retraction row.
    const n = await pg.query<{ n: string }>(
      'select count(*)::int as n from raw_captures where retracts_capture_id = $1',
      [cap.id],
    );
    expect(Number(n.rows[0].n)).toBe(1);
  });

  test('audit rows (outbound_email) are manager-only retractions, even for their author', async () => {
    // The send capture stamps the SENDER's own ref — author-permission alone
    // would let a person scrub their own audit trail from default views.
    const cap = await appendRawCapture({
      tenantId,
      channel: 'outbound_email',
      technicianRef: 'tech-mcp',
      rawText: 'From: tech-mcp\nSubject: personal\n\nbody',
    });
    const denied = await call('retract_capture', { captureId: cap.id, reason: 'tidy up' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('only a manager can retract it');

    const { client: mgrClient, callWith: callMgr } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const s = await callMgr('retract_capture', { captureId: cap.id, reason: 'sent in error' });
      expect(s.data.status).toBe('needs_confirmation');
      const c = await callMgr('retract_capture', { confirmId: s.data.confirmId });
      expect(c.data.status).toBe('retracted');
    } finally {
      await mgrClient.close();
    }
  });

  test('cannot retract a retraction', async () => {
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'chain target',
    });
    const s = await call('retract_capture', { captureId: cap.id, reason: 'first' });
    const c = await call('retract_capture', { confirmId: s.data.confirmId });
    const denied = await call('retract_capture', {
      captureId: c.data.retractionId,
      reason: 'undo',
    });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('cannot retract a retraction');
  });

  // record_standing_fact always mints its OWN evidence capture, so a capture
  // cited by facts on several rows can only be built by direct writes — which
  // is exactly how the live case arose (a seeded intake transcript evidencing
  // a customer fact AND a job fact).
  const bundle = (captureId: string, value: string | number | boolean) => ({
    value,
    sourceCaptureId: captureId,
    recordedAt: new Date().toISOString(),
  });

  test('fold impact: preview and commit list every fact and visit the retraction removes', async () => {
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'shared evidence: prefers afternoons, AC not cooling',
    });
    const customer = await createCustomer({
      tenantId,
      name: 'Fold Cust',
      phone: '555-7001',
      attributes: { prefers: bundle(cap.id, 'afternoons') },
    });
    const job = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'AC repair',
      attributes: { symptom: bundle(cap.id, 'not cooling') },
    });
    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: techMcpId,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: nl('2026-08-16T13:00:00.000Z'),
      sourceCaptureId: cap.id,
    });
    await insertVisitNote({ tenantId, visitId: visit.id, captureId: cap.id });

    const staged = await call('retract_capture', { captureId: cap.id, reason: 'wrong info' });
    expect(staged.isError).toBe(false);
    const will = staged.data.willAlsoRemove;
    expect(will.facts).toHaveLength(2);
    expect(will.facts).toEqual(
      expect.arrayContaining([
        {
          rowType: 'customer',
          rowId: customer.id,
          rowLabel: 'Fold Cust',
          key: 'prefers',
          value: 'afternoons',
        },
        {
          rowType: 'job',
          rowId: job.id,
          rowLabel: 'AC repair',
          key: 'symptom',
          value: 'not cooling',
        },
      ]),
    );
    expect(will.visits).toEqual([
      {
        visitId: visit.id,
        jobId: job.id,
        scheduledAt: null,
        technicianIds: [techMcpId],
      },
    ]);
    expect(staged.data.note).toContain('willAlsoRemove');

    const done = await call('retract_capture', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('retracted');
    expect(done.data.alsoRemoved).toEqual(will);
    expect(typeof done.data.restoreHint).toBe('string');
    // The hint names the restore path as it now is: one call records (2026-09-28).
    expect(done.data.restoreHint).toContain('records on the first call');

    // The retraction FOLLOWS its target onto the trip (rung 9b). The target
    // reached its visit through visit_notes, so a retraction that did not
    // travel the same road would sit on the record with no connection to the
    // thing it neutralizes — invisible to every reader that walks the link.
    const links = await pg.query<{ capture_id: string }>(
      'select capture_id from visit_notes where visit_id = $1',
      [visit.id],
    );
    expect(links.rows.map((r) => r.capture_id).sort()).toEqual(
      [cap.id, done.data.retractionId as string].sort(),
    );

    // Parity: the preview must equal what the fold ACTUALLY removes — the
    // predicted facts/visit are gone from the default context view, nothing
    // else. Ties "what will disappear" to "what does disappear" so predicate
    // drift between the scan and the fold fails here instead of lying live.
    const ctx = await call('get_customer_context', { customerId: customer.id });
    expect(ctx.data.customer.attributes.prefers).toBeUndefined();
    const foldedJob = ctx.data.jobs.find((j: { id: string }) => j.id === job.id);
    expect(foldedJob.attributes.symptom).toBeUndefined();
    // The trip the note MINTED (source_capture_id = cap) goes with the note.
    expect(foldedJob.lastVisitAt).toBeNull();
    expect(foldedJob.noteCount).toBe(0);
  });

  // RUNG 9b: a note LINKS a trip it did not create, so "linked to the capture"
  // and "disappears with the capture" stopped being the same set. A trip booked
  // separately must SURVIVE its note's retraction — a customer is expecting it —
  // and the preview must not promise otherwise. This ties findFoldImpact's split
  // to context.ts's fold predicate: if either side drifts, one half fails here
  // instead of telling a manager their appointment is gone.
  test('fold impact: a visit the note only reports loses evidence, it does not disappear', async () => {
    const customer = await createCustomer({
      tenantId,
      name: 'Survivor Cust',
      phone: '555-7009',
    });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Furnace tune-up' });
    // Booked, not minted by a note: source_capture_id stays NULL, which is what
    // book_visit does and what attachNote step 1 leaves alone.
    const booked = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: techMcpId,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: nl('2026-08-16T13:00:00.000Z'),
    });
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'wrote up the furnace trip',
    });
    await insertVisitNote({ tenantId, visitId: booked.id, captureId: cap.id });

    const staged = await call('retract_capture', { captureId: cap.id, reason: 'wrong job' });
    expect(staged.isError).toBe(false);
    expect(staged.data.willAlsoRemove.visits).toEqual([]);
    expect(staged.data.alsoLosesEvidence.visits).toEqual([
      { visitId: booked.id, jobId: job.id, scheduledAt: null, technicianIds: [techMcpId] },
    ]);

    const done = await call('retract_capture', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('retracted');
    expect(done.data.alsoRemoved.visits).toEqual([]);
    expect(done.data.alsoLostEvidence.visits).toEqual(staged.data.alsoLosesEvidence.visits);

    // The half that would actually hurt: the trip is still on the record
    // (it was booked, not minted by the note — its source_capture_id is null).
    const ctx = await call('get_customer_context', { customerId: customer.id });
    const foldedJob = ctx.data.jobs.find((j: { id: string }) => j.id === job.id);
    expect(foldedJob.lastVisitAt).toContain('2026-08-16');
    expect(foldedJob.noteCount).toBe(0); // the note itself is gone
  });

  test('fold impact: a capture nothing cites previews and commits empty, with no restoreHint', async () => {
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'uncited note',
    });
    const staged = await call('retract_capture', { captureId: cap.id, reason: 'noise' });
    expect(staged.data.willAlsoRemove).toEqual({ facts: [], visits: [], correspondence: [] });
    const done = await call('retract_capture', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('retracted');
    expect(done.data.alsoRemoved).toEqual({ facts: [], visits: [], correspondence: [] });
    expect(done.data.restoreHint).toBeUndefined();
  });

  test('fold impact: a fact written between stage and confirm appears in the commit list', async () => {
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'evidence gaining a late citation',
    });
    const early = await createCustomer({
      tenantId,
      name: 'Early Citer',
      phone: '555-7002',
      attributes: { gate_code: bundle(cap.id, '1234') },
    });

    const staged = await call('retract_capture', { captureId: cap.id, reason: 'stale' });
    expect(staged.data.willAlsoRemove.facts).toHaveLength(1);

    // Direct write inside the stage window: a second row starts citing the
    // same evidence AFTER the preview was shown.
    const late = await createCustomer({
      tenantId,
      name: 'Late Citer',
      phone: '555-7003',
      attributes: { pets: bundle(cap.id, 'dog in backyard') },
    });

    const done = await call('retract_capture', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('retracted');
    expect(done.data.alsoRemoved.facts).toHaveLength(2);
    expect(done.data.alsoRemoved.facts.map((f: { rowId: string }) => f.rowId).sort()).toEqual(
      [early.id, late.id].sort(),
    );
  });

  test('list_recent_captures folds by default; manager toggle returns the labeled trail; technicians may not toggle', async () => {
    const customer = await createCustomer({ tenantId, name: 'Trail Cust', phone: '555-3322' });
    const kept = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'kept note',
      customerId: customer.id,
    });
    const bad = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'bad stamped note',
      customerId: customer.id,
    });
    const s = await call('retract_capture', { captureId: bad.id, reason: 'belongs to Tom' });
    const c = await call('retract_capture', { confirmId: s.data.confirmId });
    expect(c.data.status).toBe('retracted');

    // Folded (default): target gone, retraction row gone, good row kept.
    const folded = await call('list_recent_captures', { customerId: customer.id });
    const foldedIds = folded.data.captures.map((r: { captureId: string }) => r.captureId);
    expect(foldedIds).toContain(kept.id);
    expect(foldedIds).not.toContain(bad.id);
    expect(foldedIds).not.toContain(c.data.retractionId);
    expect(folded.data.totalVisible).toBe(1);
    expect(folded.data.hasMore).toBe(false);
    expect(folded.data.next).toBeNull();

    // Technician toggle rejected.
    const deniedToggle = await call('list_recent_captures', {
      customerId: customer.id,
      includeRetracted: true,
    });
    expect(deniedToggle.isError).toBe(true);
    expect(deniedToggle.text).toContain('manager badge');

    // Manager toggle: labeled full trail.
    const { client: mgrClient, callWith: callMgr } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const trail = await callMgr('list_recent_captures', {
        customerId: customer.id,
        includeRetracted: true,
      });
      const badRow = trail.data.captures.find((r: { captureId: string }) => r.captureId === bad.id);
      expect(badRow.retracted).toMatchObject({
        id: c.data.retractionId,
        reason: 'belongs to Tom',
        by: 'tech-mcp',
      });
      // The retraction row itself appears in the trail, as an ordinary row that
      // says what it retracts.
      const retractionRow = trail.data.captures.find(
        (r: { captureId: string }) => r.captureId === c.data.retractionId,
      );
      expect(retractionRow.retractsCaptureId).toBe(bad.id);
      expect(retractionRow.retracted).toBeNull();
    } finally {
      await mgrClient.close();
    }
  });

});

// (A 'pairing lifecycle tools' describe stood here: get_connect_link's states
// and cooldown, and resolve_review's pairing verdicts. Both tools left the
// manager's bot on 2026-09-19 — email connections move to a settings page that
// is not built yet. The rows it used to leave behind for the offboarding
// describe below are created there now.)

describe('bind_telegram (manager tool + cold-pool auto-allocation)', () => {
  test('denies technicians; validates id; guards dup + inactive; auto-claims a sandbox; re-bind returns previous', { timeout: 30_000 }, async () => {
    // Leave shared state exactly as found: capture seats to restore, and clear
    // any stale 'tg-host' a crashed prior run may have left (the ordered
    // downstream describes are seat-count sensitive).
    const seatsBefore = (
      await pg.query<{ manager_seats: number; technician_seats: number }>(
        'select manager_seats, technician_seats from tenants where id=$1',
        [tenantId],
      )
    ).rows[0];
    await pg.query(
      "delete from sandbox_pool where host_id in (select id from hosts where name='tg-host')",
    );
    await pg.query("delete from hosts where name = 'tg-host'");
    await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 8 });

    // Technician identity: denied before any write (main client is 'tech-mcp').
    const denied = await call('bind_telegram', { ref: 'tech-mcp', telegramUserId: '111' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('manager badge');

    const { client: mgrClient, callWith } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      {},
    );
    try {
      expect((await mgrClient.listTools()).tools.map((t) => t.name)).toContain('bind_telegram');

      // Non-numeric id rejected before any lookup; missing ref errors.
      expect(
        (await callWith('bind_telegram', { ref: 'tech-mcp', telegramUserId: 'abc' })).isError,
      ).toBe(true);
      expect(
        (await callWith('bind_telegram', { ref: 'nobody', telegramUserId: '123' })).isError,
      ).toBe(true);

      // Happy path on a person who ALREADY has a sandbox: writes the column, no
      // pool claim needed. Cross-channel read-back confirms the write. No pool
      // row (legacy assignment) → botUsername null and the note routes the
      // manager to the operator rather than guessing a handle.
      const jane = await insertTechnician({ tenantId, ref: 'tg-a', displayName: 'TG A' });
      await updateTechnician(jane.id, { sandbox_ref: 's-existing' });
      const bound = await callWith('bind_telegram', { ref: 'tg-a', telegramUserId: '5551234' });
      expect(bound.data).toMatchObject({
        status: 'bound',
        ref: 'tg-a',
        sandboxRef: 's-existing',
        botUsername: null,
      });
      expect(bound.data.note).toContain('ask your operator');
      const row1 = await pg.query<{ telegram_user_id: string }>(
        "select telegram_user_id from technicians where tenant_id=$1 and ref='tg-a'",
        [tenantId],
      );
      expect(row1.rows[0].telegram_user_id).toBe('5551234');

      // The same id on ANOTHER ref is rejected (the duplicate guard).
      const bob = await insertTechnician({ tenantId, ref: 'tg-b', displayName: 'TG B' });
      await updateTechnician(bob.id, { sandbox_ref: 's-bob' });
      const dup = await callWith('bind_telegram', { ref: 'tg-b', telegramUserId: '5551234' });
      expect(dup.isError).toBe(true);
      expect(dup.text).toContain("already bound to 'tg-a'");

      // Re-bind the same person: status rebound, returns the previous id.
      const rebound = await callWith('bind_telegram', { ref: 'tg-a', telegramUserId: '5559999' });
      expect(rebound.data).toMatchObject({
        status: 'rebound',
        previousTelegramUserId: '5551234',
        telegramUserId: '5559999',
      });

      // Inactive target rejected.
      await setTechnicianState(bob.id, 'offboarding');
      const inactive = await callWith('bind_telegram', { ref: 'tg-b', telegramUserId: '5550000' });
      expect(inactive.isError).toBe(true);
      expect(inactive.text).toContain('deactivated');

      // Auto-allocation: a hire with NO sandbox claims a free pool row and gets
      // host_id + sandbox_ref patched — no operator step. The pool row carries
      // the bot handle, so the reply tells the manager which bot to open.
      const host = await createHost('tg-host', 'f'.repeat(64));
      await registerSandbox({
        tenantId,
        hostId: host.id,
        sandboxRef: 'pool-x',
        botUsername: '@poolx_bot',
      });
      const cold = await insertTechnician({ tenantId, ref: 'tg-cold', displayName: 'TG Cold' });
      const allocated = await callWith('bind_telegram', { ref: 'tg-cold', telegramUserId: '7770001' });
      expect(allocated.data).toMatchObject({
        status: 'bound',
        sandboxRef: 'pool-x',
        botUsername: '@poolx_bot',
      });
      expect(allocated.data.note).toContain('@poolx_bot');
      expect(allocated.data.note).toContain('/start');

      // list_team surfaces the handle too, so the manager can re-ask later.
      const team = await callWith('list_team', {});
      const coldRow = team.data.team.find((t: { ref: string }) => t.ref === 'tg-cold');
      expect(coldRow).toMatchObject({ sandboxRef: 'pool-x', botUsername: '@poolx_bot' });
      const aRow = team.data.team.find((t: { ref: string }) => t.ref === 'tg-a');
      expect(aRow).toMatchObject({ sandboxRef: 's-existing', botUsername: null });
      const row2 = await pg.query<{ sandbox_ref: string; host_id: string; telegram_user_id: string }>(
        "select sandbox_ref, host_id, telegram_user_id from technicians where tenant_id=$1 and ref='tg-cold'",
        [tenantId],
      );
      expect(row2.rows[0]).toMatchObject({
        sandbox_ref: 'pool-x',
        host_id: host.id,
        telegram_user_id: '7770001',
      });
      const pool = await pg.query<{ technician_id: string }>(
        "select technician_id from sandbox_pool where sandbox_ref='pool-x' and host_id=$1",
        [host.id],
      );
      expect(pool.rows[0].technician_id).toBe(cold.id); // claimed, cross-channel

      // Pool empty: the next cold hire with no free sandbox errors clearly.
      await insertTechnician({ tenantId, ref: 'tg-cold2', displayName: 'TG Cold2' });
      const empty = await callWith('bind_telegram', { ref: 'tg-cold2', telegramUserId: '7770002' });
      expect(empty.isError).toBe(true);
      expect(empty.text).toContain('no free sandbox');
    } finally {
      await mgrClient.close();
      // Restore shared state so the seat-sensitive downstream describes are
      // untouched. Delete order follows the FKs: sandbox_pool (→ technicians,
      // hosts) first, then technicians (→ hosts via host_id), then the host.
      await pg.query("delete from sandbox_pool where host_id in (select id from hosts where name='tg-host')");
      await pg.query(
        "delete from technicians where tenant_id=$1 and ref in ('tg-a','tg-b','tg-cold','tg-cold2')",
        [tenantId],
      );
      await pg.query("delete from hosts where name = 'tg-host'");
      await setTenantSeats(tenantId, {
        managerSeats: seatsBefore.manager_seats,
        technicianSeats: seatsBefore.technician_seats,
      });
    }
  });
});

describe('bind_telegram glue seats (step 4: a seat without the pool)', () => {
  test('a free seat bot gives a new hire a glue seat; taken bot → pool; half-written bind reused; rebind keeps the seat', { timeout: 30_000 }, async () => {
    const seatsBefore = (
      await pg.query<{ manager_seats: number; technician_seats: number }>(
        'select manager_seats, technician_seats from tenants where id=$1',
        [tenantId],
      )
    ).rows[0];
    await pg.query("delete from hosts where name = 'tg-glue-host'"); // cascades seats, seat_bots, pool
    await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 10 });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' }, {});
    try {
      const host = await createHost('tg-glue-host', 'e'.repeat(64));
      await registerSeatBot({ hostId: host.id, tenantId, botId: '9100001', botUsername: '@glue_one_bot' });

      // (c) a free seat bot → a g_ glue seat, the roster mirror in ONE write.
      const a = await insertTechnician({ tenantId, ref: 'glue-a', displayName: 'Glue A' });
      const bound = await callWith('bind_telegram', { ref: 'glue-a', telegramUserId: '9200001' });
      expect(bound.data).toMatchObject({ status: 'bound', botUsername: '@glue_one_bot' });
      expect(bound.data.sandboxRef).toMatch(/^g_[0-9a-f]{8}$/);
      expect(bound.data.note).toContain(`install.sh ${bound.data.sandboxRef}`);
      expect(bound.data.note).toContain('@glue_one_bot');
      const mirror = await pg.query(
        'select host_id, sandbox_ref, telegram_user_id from technicians where id = $1',
        [a.id],
      );
      expect(mirror.rows[0]).toEqual({
        host_id: host.id,
        sandbox_ref: bound.data.sandboxRef,
        telegram_user_id: '9200001',
      });
      const seat = await pg.query('select seat_ref, host_id from seats where technician_id = $1 and retired_at is null', [a.id]);
      expect(seat.rows[0]).toEqual({ seat_ref: bound.data.sandboxRef, host_id: host.id });

      // (d) the only bot is taken → today's pool claim, untouched.
      await registerSandbox({ tenantId, hostId: host.id, sandboxRef: 'pool-g', botUsername: '@poolg_bot' });
      await insertTechnician({ tenantId, ref: 'glue-b', displayName: 'Glue B' });
      const pooled = await callWith('bind_telegram', { ref: 'glue-b', telegramUserId: '9200002' });
      expect(pooled.data).toMatchObject({ sandboxRef: 'pool-g', botUsername: '@poolg_bot' });
      expect(pooled.data.note).toContain('within ~5 minutes');

      // (a) a half-written bind: the seat exists but the roster write never
      // landed. A retry reuses THAT seat (never a second one) and writes the mirror.
      const bot2 = await registerSeatBot({ hostId: host.id, tenantId, botId: '9100002', botUsername: '@glue_two_bot' });
      const c = await insertTechnician({ tenantId, ref: 'glue-c', displayName: 'Glue C' });
      await createSeat({ tenantId, technicianId: c.id, hostId: host.id, seatRef: 'g_halfdone', botRef: bot2.id });
      const retried = await callWith('bind_telegram', { ref: 'glue-c', telegramUserId: '9200003' });
      expect(retried.data).toMatchObject({ sandboxRef: 'g_halfdone', botUsername: '@glue_two_bot' });
      const cSeats = await pg.query('select count(*)::int as n from seats where technician_id = $1', [c.id]);
      expect(cSeats.rows[0].n).toBe(1);

      // A rebind keeps the seat; a running glue learns the new id on restart.
      const rebound = await callWith('bind_telegram', { ref: 'glue-a', telegramUserId: '9200009' });
      expect(rebound.data).toMatchObject({
        status: 'rebound',
        sandboxRef: bound.data.sandboxRef,
        botUsername: '@glue_one_bot',
        previousTelegramUserId: '9200001',
      });
      expect(rebound.data.note).toContain('restarts the assistant');

      // Two binds racing for ONE free bot (the index is the referee): one gets
      // the glue seat, the other falls through to the pool — never two people
      // on one bot, never a second assistant.
      await registerSeatBot({ hostId: host.id, tenantId, botId: '9100003', botUsername: '@glue_race_bot' });
      await registerSandbox({ tenantId, hostId: host.id, sandboxRef: 'pool-r', botUsername: '@poolr_bot' });
      await insertTechnician({ tenantId, ref: 'glue-r1', displayName: 'R1' });
      await insertTechnician({ tenantId, ref: 'glue-r2', displayName: 'R2' });
      const [r1, r2] = await Promise.all([
        callWith('bind_telegram', { ref: 'glue-r1', telegramUserId: '9200011' }),
        callWith('bind_telegram', { ref: 'glue-r2', telegramUserId: '9200012' }),
      ]);
      expect([r1.data.botUsername, r2.data.botUsername].sort()).toEqual(['@glue_race_bot', '@poolr_bot']);
      const raceBot = await pg.query(
        "select count(*)::int as n from seats s join seat_bots b on b.id = s.bot_ref where b.bot_username = '@glue_race_bot' and s.retired_at is null",
      );
      expect(raceBot.rows[0].n).toBe(1);

      // list_team shows the seat bot's handle.
      const team = await callWith('list_team', {});
      const aRow = team.data.team.find((t: { ref: string }) => t.ref === 'glue-a');
      expect(aRow).toMatchObject({ sandboxRef: bound.data.sandboxRef, botUsername: '@glue_one_bot' });
    } finally {
      await mgrClient.close();
      await pg.query("delete from sandbox_pool where host_id in (select id from hosts where name='tg-glue-host')");
      await pg.query(
        "delete from technicians where tenant_id=$1 and ref in ('glue-a','glue-b','glue-c','glue-r1','glue-r2')",
        [tenantId],
      );
      await pg.query("delete from hosts where name = 'tg-glue-host'");
      await setTenantSeats(tenantId, {
        managerSeats: seatsBefore.manager_seats,
        technicianSeats: seatsBefore.technician_seats,
      });
    }
  });
});

describe('offboarding lifecycle tools (Composio seams stubbed)', () => {
  test('deactivate stamps clock + disables + closes pairing item; reactivate is the undo', { timeout: 30_000 }, async () => {
    const disableCalls: string[] = [];
    const enableCalls: string[] = [];
    const stubs: Partial<ServerDeps> = {
      disablePairing: async (t) => {
        disableCalls.push(t.ref);
      },
      enablePairing: async (t) => {
        enableCalls.push(t.ref);
      },
    };

    // THE ROWS AND SEATS THIS TEST STARTS FROM. A pairing-tools describe used
    // to leave them behind (it was deleted with get_connect_link and
    // resolve_review, 2026-09-19), so they are made here, to the same end state
    // the describes after this one inherit: 2 manager / 6 technician seats;
    // pair-probe active with a recorded pairing; pair-two and pair-early
    // invited; pair-two then parked in offboarding, the way that suite left it.
    await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 6 });
    const probe = await insertTechnician({ tenantId, ref: 'pair-probe', displayName: 'Pair Probe' });
    await updateTechnician(probe.id, {
      state: 'active',
      connected_email: 'jane.probe@gmail.com',
      composio_connected_account_id: 'ca_probe',
    });
    const two = await insertTechnician({ tenantId, ref: 'pair-two', displayName: 'Pair Two' });
    await insertTechnician({ tenantId, ref: 'pair-early', displayName: 'Pair Early' });
    await updateTechnician(two.id, { state: 'offboarding' });

    // Technician identity: denied before any stub runs.
    const denied = await call('reactivate_technician_seat', { ref: 'pair-probe' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('manager badge');

    const { client: mgrClient, callWith } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      stubs,
    );
    try {
      // The full manager surface: every base spine tool EXCEPT get_schedule
      // (technician route view, removed 2026-07-19) + the 25 admin tools —
      // the count the runbook/Box_Setup_Stuff verification steps cite.
      const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
      expect(mgrTools).toContain('reactivate_technician_seat');
      expect(mgrTools).toContain('bind_telegram');
      expect(mgrTools).toContain('web_search');
      expect(mgrTools).toContain('read_webpage');
      expect(mgrTools).toContain('resolve_date');
      expect(mgrTools).toContain('set_availability');
      expect(mgrTools).toContain('set_technician_skills');
      expect(mgrTools).toContain('find_slots');
      expect(mgrTools).toContain('update_job');
      expect(mgrTools).toContain('set_technician_horizon');
      expect(mgrTools).toContain('cancel_job'); // the terminal verb (2026-07-25)
      expect(mgrTools).toContain('get_availability'); // the read half of set_availability (2026-08-04)
      expect(mgrTools).toContain('query_spine'); // ad-hoc read fallback (2026-08-06)
      expect(mgrTools).toContain('record_money_event'); // the money ledger (2026-08-15)
      expect(mgrTools).toContain('set_firm_profile'); // firm identity (2026-08-15)
      expect(mgrTools).toContain('inform_team_lead'); // the planner's inbox (build 5.5)
      expect(mgrTools).toContain('ask_team_lead'); // the Q&A desk (build 5.5 Phase 2)
      expect(mgrTools).toContain('inform_teammate'); // seat-to-seat informs (build 5.5 Phase 3)
      // RUNG 10 added `open_job`: until it existed there was no way to open a
      // job without also putting a visit on the calendar.
      expect(mgrTools).toContain('open_job');
      // …and the citing door, SHARED from TEAM_LEAD_TOOLS (rung 10b.2): a door
      // the seat cannot see is a door it will not use, which is how the
      // 2026-09-08 answer went through record_field_note instead.
      expect(mgrTools).toContain('record_caller');
      expectSurface(mgrTools, MANAGER_TOOLS_EXPECTED, [...TEAM_LEAD_ONLY_TOOLS, 'get_schedule']);

      // pair-probe is active w/ a recorded pairing (set up above). Give it an
      // open verification item to prove deactivation closes it.
      const stale = await upsertOpenReviewItem({
        tenantId,
        kind: 'pairing_verification',
        subjectRef: 'pair-probe',
      });
      const ask = await callWith('deactivate_technician_seat', { ref: 'pair-probe' });
      expect(ask.data.status).toBe('needs_confirmation');
      const done = await callWith('deactivate_technician_seat', {
        ref: 'pair-probe',
        confirmId: ask.data.confirmId,
      });
      expect(done.data.status).toBe('deactivated');

      // Read-backs: clock stamped, pairing disabled, stale item closed.
      const row1 = await pg.query<{ state: string; offboarding_started_at: string | null }>(
        "select state, offboarding_started_at from technicians where tenant_id = $1 and ref = 'pair-probe'",
        [tenantId],
      );
      expect(row1.rows[0].state).toBe('offboarding');
      expect(row1.rows[0].offboarding_started_at).not.toBeNull();
      expect(disableCalls).toEqual(['pair-probe']);
      const staleAfter = await pg.query<{ status: string }>(
        'select status from review_items where id = $1',
        [stale.id],
      );
      expect(staleAfter.rows[0].status).toBe('resolved');

      // The grace-period heads-up is moot once the removal is undone: the
      // planner must not tell a manager about it (an OBSERVATION since the
      // review queue's retirement, 2026-09-19).
      const reminder = await raiseOffboardingObservation({
        tenantId,
        ref: 'pair-probe',
        displayName: 'Pair Probe',
        // pg hands a timestamptz back as a Date: the episode key is its ISO form.
        startedAt: new Date(row1.rows[0].offboarding_started_at as string).toISOString(),
      });
      if (!reminder) throw new Error('fixture reminder was deduped');

      // Reactivate: back to active, clock cleared, pairing re-enabled.
      const undo = await callWith('reactivate_technician_seat', { ref: 'pair-probe' });
      expect(undo.data).toMatchObject({
        status: 'reactivated',
        state: 'active',
        pairingRestored: true,
      });
      const reminderAfter = await pg.query<{ status: string; dismiss_reason: string | null }>(
        'select status, dismiss_reason from observations where id = $1',
        [reminder.id],
      );
      expect(reminderAfter.rows[0]).toEqual({
        status: 'dismissed',
        dismiss_reason: 'reactivated during the grace period',
      });
      expect(enableCalls).toEqual(['pair-probe']);
      const row2 = await pg.query<{ state: string; offboarding_started_at: string | null }>(
        "select state, offboarding_started_at from technicians where tenant_id = $1 and ref = 'pair-probe'",
        [tenantId],
      );
      expect(row2.rows[0].state).toBe('active');
      expect(row2.rows[0].offboarding_started_at).toBeNull();

      // Reactivating an ACTIVE person with a pairing is the enablePairing
      // RETRY surface (review finding: a Composio blip during reactivation
      // otherwise left mail dark with no tool able to re-enable).
      const retry = await callWith('reactivate_technician_seat', { ref: 'pair-probe' });
      expect(retry.isError).toBe(false);
      expect(retry.data).toMatchObject({ status: 'already_active', pairingRestored: true });
      expect(enableCalls).toEqual(['pair-probe', 'pair-probe']); // the retry re-ran enable
      await updateTechnician(
        (await pg.query<{ id: string }>(
          "select id from technicians where tenant_id = $1 and ref = 'pair-two'",
          [tenantId],
        )).rows[0].id,
        { state: 'offboarded' },
      );
      const perma = await callWith('reactivate_technician_seat', { ref: 'pair-two' });
      expect(perma.isError).toBe(true);
      expect(perma.text).toContain('permanently offboarded');

      // A never-paired person (deactivated while invited) reactivates to
      // INVITED, not active — the pairing path only acts on invited rows, so
      // 'active' would leave their mailbox unpairable (review finding).
      const askCarl = await callWith('deactivate_technician_seat', { ref: 'carl-sagan' });
      await callWith('deactivate_technician_seat', {
        ref: 'carl-sagan',
        confirmId: askCarl.data.confirmId,
      });
      const carlBack = await callWith('reactivate_technician_seat', { ref: 'carl-sagan' });
      expect(carlBack.data).toMatchObject({
        status: 'reactivated',
        state: 'invited',
        pairingRestored: null,
      });
      const carlRow = await pg.query<{ state: string }>(
        "select state from technicians where tenant_id = $1 and ref = 'carl-sagan'",
        [tenantId],
      );
      expect(carlRow.rows[0].state).toBe('invited');

      // Reactivate AT CAP: free pair-probe's seat again, fill every seat, then
      // the undo must hit the purchase message (seat cap is never bypassed).
      //
      // On the way, a staged deactivation's 15-minute life (2026-09-19: with
      // resolve_review gone, expiry is the only thing that ends a forgotten
      // one). `stagedAt` is backdated in the row to stand in for the wait.
      const backdate = (id: string) =>
        pg.query(
          "update review_items set detail = jsonb_set(detail, '{stagedAt}', to_jsonb($2::text)) where id = $1",
          [id, new Date(Date.now() - 16 * 60_000).toISOString()],
        );
      const statusOf = async (id: string) =>
        (await pg.query<{ status: string }>('select status from review_items where id = $1', [id]))
          .rows[0].status;
      // (a) A "yes" on an expired token is refused, and the token is closed.
      const lapsed = await callWith('deactivate_technician_seat', { ref: 'pair-probe' });
      await backdate(lapsed.data.confirmId);
      const late = await callWith('deactivate_technician_seat', {
        ref: 'pair-probe',
        confirmId: lapsed.data.confirmId,
      });
      expect(late.isError).toBe(true);
      expect(late.text).toContain('confirmation expired');
      expect(await statusOf(lapsed.data.confirmId)).toBe('dismissed');
      // (b) Staging again over an expired OPEN token must not hand the dead one
      // back (the dedup would): it is superseded, and the fresh one confirms.
      const forgotten = await callWith('deactivate_technician_seat', { ref: 'pair-probe' });
      await backdate(forgotten.data.confirmId);
      const ask2 = await callWith('deactivate_technician_seat', { ref: 'pair-probe' });
      expect(ask2.data.confirmId).not.toBe(forgotten.data.confirmId);
      expect(await statusOf(forgotten.data.confirmId)).toBe('dismissed');
      const done2 = await callWith('deactivate_technician_seat', {
        ref: 'pair-probe',
        confirmId: ask2.data.confirmId,
      });
      expect(done2.data.status).toBe('deactivated');
      // Occupied now: tech-mcp, carl-sagan, dan-dare, pair-early (4 of 6).
      // Seat add is two-step since 2026-07-17: stage → confirm per filler.
      for (const displayName of ['Cap Filler Five', 'Cap Filler Six']) {
        const fillerStage = await callWith('add_technician_seat', { displayName });
        await callWith('add_technician_seat', { confirmId: fillerStage.data.confirmId });
      }
      const blocked = await callWith('reactivate_technician_seat', { ref: 'pair-probe' });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain('no free technician seats');
    } finally {
      await mgrClient.close();
    }
  });
});

describe('sandbox recycling lifecycle (deactivate → retire → reactivate / re-bind)', () => {
  test('deactivate warns + marks retirement; reactivate cancels or routes to a fresh bind; pool-empty message reflects an in-flight recycle', { timeout: 30_000 }, async () => {
    const seatsBefore = (
      await pg.query<{ manager_seats: number; technician_seats: number }>(
        'select manager_seats, technician_seats from tenants where id=$1',
        [tenantId],
      )
    ).rows[0];
    await pg.query(
      "delete from sandbox_pool where host_id in (select id from hosts where name='rcy-host')",
    );
    await pg.query("delete from hosts where name = 'rcy-host'");
    await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 12 });

    // Composio seams stubbed (this suite drives deactivate/reactivate);
    // retirement fns are the LIVE ones — read-backs prove the real stamps.
    const stubs: Partial<ServerDeps> = {
      disablePairing: async () => {},
      enablePairing: async () => {},
      teardownSession: async () => ({ status: 'none' as const }),
    };
    const { client: mgrClient, callWith } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      stubs,
    );
    // Second client with the retirement seam SPIED — proves the deactivate
    // handler drives it (and with no sandbox, no destruction warning shows).
    const retireCalls: string[] = [];
    const { client: spyClient, callWith: spyCall } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      { ...stubs, requestRetirement: async (id: string) => (retireCalls.push(id), null) },
    );
    try {
      const host = await createHost('rcy-host', 'c'.repeat(64));
      await registerSandbox({
        tenantId,
        hostId: host.id,
        sandboxRef: 'rcy-s1',
        botUsername: '@rcys1_bot',
      });
      const b = await insertTechnician({ tenantId, ref: 'rcy-b', displayName: 'Rcy B' });
      const boundB = await callWith('bind_telegram', { ref: 'rcy-b', telegramUserId: '8880001' });
      expect(boundB.data).toMatchObject({ sandboxRef: 'rcy-s1' });

      // Deactivate: the ONE confirmation carries the destruction warning, and
      // the confirmed call stamps the pool row for retirement (live fn).
      const ask = await callWith('deactivate_technician_seat', { ref: 'rcy-b' });
      expect(ask.data.status).toBe('needs_confirmation');
      expect(ask.data.note).toContain('permanently destroys');
      await callWith('deactivate_technician_seat', { ref: 'rcy-b', confirmId: ask.data.confirmId });
      const stamped = await pg.query<{ retire_requested_at: string | null }>(
        "select retire_requested_at from sandbox_pool where sandbox_ref='rcy-s1' and host_id=$1",
        [host.id],
      );
      expect(stamped.rows[0].retire_requested_at).not.toBeNull();

      // Reactivate during grace: the pending retirement is CANCELLED and no
      // re-bind nudge appears (their sandbox is intact).
      const undo = await callWith('reactivate_technician_seat', { ref: 'rcy-b' });
      expect(undo.data.status).toBe('reactivated');
      expect(undo.data.note ?? '').not.toContain('bind_telegram');
      const cancelled = await pg.query<{ retire_requested_at: string | null }>(
        "select retire_requested_at from sandbox_pool where sandbox_ref='rcy-s1' and host_id=$1",
        [host.id],
      );
      expect(cancelled.rows[0].retire_requested_at).toBeNull();

      // Deactivate again, and this time the box completes the recycle: the old
      // row is released, a fresh blank appears, roster residue cleared (as the
      // Phase-2 report handler will do).
      const ask2 = await callWith('deactivate_technician_seat', { ref: 'rcy-b' });
      await callWith('deactivate_technician_seat', { ref: 'rcy-b', confirmId: ask2.data.confirmId });
      const done = await completeSandboxRecycle({
        hostId: host.id,
        retiredSandboxRef: 'rcy-s1',
        newSandboxRef: 'rcy-s2',
        botUsername: '@rcys1_bot',
      });
      expect(done).toMatchObject({ retired: true, registered: true, retiredTechnicianId: b.id });
      await updateTechnician(b.id, { sandbox_ref: null, host_id: null });

      // Reactivate AFTER destruction: routed to a fresh bind — and the bind
      // works (released UNIQUE slot, no stale-row recovery: it claims rcy-s2).
      const back = await callWith('reactivate_technician_seat', { ref: 'rcy-b' });
      expect(back.data.status).toBe('reactivated');
      expect(back.data.note).toContain('bind_telegram');
      const rebind = await callWith('bind_telegram', { ref: 'rcy-b', telegramUserId: '8880001' });
      expect(rebind.isError).toBe(false);
      expect(rebind.data).toMatchObject({ sandboxRef: 'rcy-s2', botUsername: '@rcys1_bot' });

      // Pool-empty message: rcy-c's swap is in flight (requested, not yet
      // completed) → the next sandbox-less hire hears "being recycled", not
      // "contact support".
      await registerSandbox({ tenantId, hostId: host.id, sandboxRef: 'rcy-s3' });
      await insertTechnician({ tenantId, ref: 'rcy-c', displayName: 'Rcy C' });
      await callWith('bind_telegram', { ref: 'rcy-c', telegramUserId: '8880003' });
      const ask3 = await callWith('deactivate_technician_seat', { ref: 'rcy-c' });
      await callWith('deactivate_technician_seat', { ref: 'rcy-c', confirmId: ask3.data.confirmId });
      await insertTechnician({ tenantId, ref: 'rcy-d', displayName: 'Rcy D' });
      const waiting = await callWith('bind_telegram', { ref: 'rcy-d', telegramUserId: '8880004' });
      expect(waiting.isError).toBe(true);
      expect(waiting.text).toContain('being recycled');

      // Spy path: the handler calls the retirement seam with the target's id,
      // and a sandbox-less person's confirmation carries NO destruction note.
      const e = await insertTechnician({ tenantId, ref: 'rcy-e', displayName: 'Rcy E' });
      const askE = await spyCall('deactivate_technician_seat', { ref: 'rcy-e' });
      expect(askE.data.note).toBeUndefined();
      await spyCall('deactivate_technician_seat', { ref: 'rcy-e', confirmId: askE.data.confirmId });
      expect(retireCalls).toEqual([e.id]);
    } finally {
      await mgrClient.close();
      await spyClient.close();
      await pg.query(
        "delete from sandbox_pool where host_id in (select id from hosts where name='rcy-host')",
      );
      await pg.query("delete from technicians where tenant_id=$1 and ref like 'rcy-%'", [tenantId]);
      await pg.query("delete from hosts where name = 'rcy-host'");
      await setTenantSeats(tenantId, {
        managerSeats: seatsBefore.manager_seats,
        technicianSeats: seatsBefore.technician_seats,
      });
    }
  });
});

describe('send_email tool (outbound seam stubbed)', () => {
  test('two-step stage/confirm, at-most-once, L1 capture, guards', { timeout: 30_000 }, async () => {
    // Earlier suites leave 6/6 technician seats occupied — make room for the
    // three roster rows this block creates.
    await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 10 });
    const jane = await insertTechnician({ tenantId, ref: 'sender-jane', displayName: 'Sender Jane' });
    await setTechnicianState(jane.id, 'active');
    await updateTechnician(jane.id, {
      composio_connected_account_id: 'ca_sender',
      connected_email: 'sender.jane@gmail.com',
    });

    const sendCalls: Array<{ ref: string; to: string; subject: string; body: string }> = [];
    let sendThrows: Error | null = null;
    const stubs: Partial<ServerDeps> = {
      // The seam records the ROSTER row it was handed — identity, never args.
      sendEmail: async (t, msg) => {
        sendCalls.push({ ref: t.ref, ...msg });
        if (sendThrows) throw sendThrows;
        return { messageId: 'm-1', threadId: 't-1' };
      },
    };
    const { client: techClient, callWith } = await clientFor(
      { tenantId, technicianRef: 'sender-jane' },
      stubs,
    );
    try {
      // The technician surface, send_email included.
      const tools = (await techClient.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('send_email');
      expectSurface(tools, TECHNICIAN_TOOLS, [...MANAGER_ONLY_TOOLS, ...TEAM_LEAD_ONLY_TOOLS]);

      // Staging requires the full payload.
      const missing = await callWith('send_email', { to: 'cust@example.com' });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('to, subject, and body are required');

      // Stage: nothing sent, a confirm token comes back.
      const staged = await callWith('send_email', {
        to: 'cust@example.com',
        subject: 'Quote',
        body: 'Hello v1',
      });
      expect(staged.data.status).toBe('needs_confirmation');
      expect(sendCalls).toHaveLength(0);

      // Restage supersedes: new token, the old one is dead.
      const staged2 = await callWith('send_email', {
        to: 'cust@example.com',
        subject: 'Quote v2',
        body: 'Hello v2',
      });
      expect(staged2.data.confirmId).not.toBe(staged.data.confirmId);
      const oldToken = await callWith('send_email', { confirmId: staged.data.confirmId });
      expect(oldToken.isError).toBe(true);
      expect(sendCalls).toHaveLength(0);

      // Confirm sends the STAGED copy — fresh args on the confirm are ignored.
      const confirmed = await callWith('send_email', {
        confirmId: staged2.data.confirmId,
        to: 'attacker@evil.example',
        subject: 'IGNORED',
        body: 'IGNORED',
      });
      expect(confirmed.data).toMatchObject({
        status: 'sent',
        to: 'cust@example.com',
        subject: 'Quote v2',
        messageId: 'm-1',
        captured: true,
      });
      expect(sendCalls).toEqual([
        { ref: 'sender-jane', to: 'cust@example.com', subject: 'Quote v2', body: 'Hello v2' },
      ]);

      // Cross-channel read-back: ONE outbound_email L1 row, sent:<id>, right ref.
      const cap = await pg.query<{ channel: string; technician_ref: string }>(
        "select channel, technician_ref from raw_captures where external_id = 'sent:m-1'",
      );
      expect(cap.rows).toHaveLength(1);
      expect(cap.rows[0]).toEqual({ channel: 'outbound_email', technician_ref: 'sender-jane' });

      // Double-confirm: token consumed → clean error, seam called exactly once.
      const dbl = await callWith('send_email', { confirmId: staged2.data.confirmId });
      expect(dbl.isError).toBe(true);
      expect(sendCalls).toHaveLength(1);

      // Send failure AFTER consumption: clear not-sent error, no L1 row, no retry
      // on the same token (at-most-once).
      sendThrows = new Error('gmail 500');
      const s3 = await callWith('send_email', { to: 'x@y.example', subject: 'S3', body: 'B3' });
      const failed = await callWith('send_email', { confirmId: s3.data.confirmId });
      expect(failed.isError).toBe(true);
      expect(failed.text).toContain('email NOT sent');
      const noRow = await pg.query<{ n: string }>(
        "select count(*)::text as n from raw_captures where metadata->>'subject' = 'S3'",
      );
      expect(noRow.rows[0].n).toBe('0');
      const consumedRetry = await callWith('send_email', { confirmId: s3.data.confirmId });
      expect(consumedRetry.isError).toBe(true);
      expect(consumedRetry.text).toContain('confirmation not found');
      sendThrows = null;

      // Capture failure (duplicate sent:<id> external id) still reports sent.
      const s4 = await callWith('send_email', { to: 'x@y.example', subject: 'S4', body: 'B4' });
      const dupCapture = await callWith('send_email', { confirmId: s4.data.confirmId });
      expect(dupCapture.data).toMatchObject({ status: 'sent', captured: false });

      // Expiry: a >15-min-old staged token dies cleanly.
      const s5 = await callWith('send_email', { to: 'x@y.example', subject: 'S5', body: 'B5' });
      await pg.query(
        "update review_items set detail = jsonb_set(detail, '{stagedAt}', to_jsonb($2::text)) where id = $1",
        [s5.data.confirmId, new Date(Date.now() - 16 * 60_000).toISOString()],
      );
      const expired = await callWith('send_email', { confirmId: s5.data.confirmId });
      expect(expired.isError).toBe(true);
      expect(expired.text).toContain('expired');
      const expiredItem = await pg.query<{ status: string }>(
        'select status from review_items where id = $1',
        [s5.data.confirmId],
      );
      expect(expiredItem.rows[0].status).toBe('dismissed');

      // Forged and cross-person tokens match nothing.
      const s6 = await callWith('send_email', { to: 'x@y.example', subject: 'S6', body: 'B6' });
      const forged = await callWith('send_email', {
        confirmId: '00000000-0000-0000-0000-000000000000',
      });
      expect(forged.isError).toBe(true);
      const bob = await insertTechnician({ tenantId, ref: 'sender-bob', displayName: 'Sender Bob' });
      await setTechnicianState(bob.id, 'active');
      await updateTechnician(bob.id, { composio_connected_account_id: 'ca_bob' });
      const { client: bobClient, callWith: bobCall } = await clientFor(
        { tenantId, technicianRef: 'sender-bob' },
        stubs,
      );
      try {
        const cross = await bobCall('send_email', { confirmId: s6.data.confirmId });
        expect(cross.isError).toBe(true);
        expect(cross.text).toContain('confirmation not found');
      } finally {
        await bobClient.close();
      }
      expect(sendCalls).toHaveLength(3); // staged2 + s3(threw) + s4 — nothing else sent

      // The manager surface as named in surface.expected.ts. (A staged send
      // used to be refused as "resolved" and cancelled through resolve_review
      // here; that tool was retired on 2026-09-19 and a send token simply
      // expires, 15 minutes after staging.)
      const { client: mgrClient } = await clientFor(
        { tenantId, technicianRef: 'mgr-test' },
        stubs,
      );
      try {
        const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
        expectSurface(mgrTools, MANAGER_TOOLS_EXPECTED, [...TEAM_LEAD_ONLY_TOOLS, 'get_schedule']);
      } finally {
        await mgrClient.close();
      }

      // Roster gates: active-but-unpaired and roster-less badges get clean errors.
      const uma = await insertTechnician({ tenantId, ref: 'unpaired-uma', displayName: 'Unpaired Uma' });
      await setTechnicianState(uma.id, 'active');
      const { client: umaClient, callWith: umaCall } = await clientFor(
        { tenantId, technicianRef: 'unpaired-uma' },
        stubs,
      );
      try {
        const noPair = await umaCall('send_email', { to: 'a@b.example', subject: 's', body: 'b' });
        expect(noPair.isError).toBe(true);
        expect(noPair.text).toContain('no paired mailbox');
      } finally {
        await umaClient.close();
      }
      const { client: ghostClient, callWith: ghostCall } = await clientFor(
        { tenantId, technicianRef: 'no-such-ref' },
        stubs,
      );
      try {
        const ghost = await ghostCall('send_email', { confirmId: s6.data.confirmId });
        expect(ghost.isError).toBe(true);
        expect(ghost.text).toContain('no roster row for this badge');
      } finally {
        await ghostClient.close();
      }
    } finally {
      await techClient.close();
    }
  });

  // RUNG 10B.3 — WHOSE RECORD THE SEND LANDS ON. Until now every
  // assistant-sent email was stamped with nobody, which is exactly why a thread
  // the FIRM started could not later identify its customer: the conversation
  // key had nothing to read. Two routes, and neither may fabricate.
  test('the sent copy is stamped with its job, or its recipient, or nobody', { timeout: 30_000 }, async () => {
    // This block adds a roster row on top of the ones the send_email test above
    // left standing, so it makes its own room and gives it back — otherwise the
    // seat cap fires in whichever suite happens to run next.
    const seatsBefore = (
      await pg.query<{ manager_seats: number; technician_seats: number }>(
        'select manager_seats, technician_seats from tenants where id=$1',
        [tenantId],
      )
    ).rows[0];
    await setTenantSeats(tenantId, {
      managerSeats: seatsBefore.manager_seats,
      technicianSeats: seatsBefore.technician_seats + 1,
    });
    const stamped = await insertTechnician({
      tenantId,
      ref: 'stamp-sam',
      displayName: 'Stamp Sam',
    });
    await setTechnicianState(stamped.id, 'active');
    await updateTechnician(stamped.id, {
      composio_connected_account_id: 'ca_stamp',
      connected_email: 'stamp.sam@gmail.com',
    });
    let n = 0;
    const stubs: Partial<ServerDeps> = {
      sendEmail: async () => ({ messageId: `stamp-m-${++n}`, threadId: `stamp-t-${n}` }),
    };
    const { client, callWith } = await clientFor(
      { tenantId, technicianRef: 'stamp-sam' },
      stubs,
    );
    const capRow = (externalId: string) =>
      pg.query<{ customer_id: string | null; job_id: string | null }>(
        'select customer_id, job_id from raw_captures where external_id = $1',
        [externalId],
      );
    const capMeta = async (externalId: string) =>
      (
        await pg.query<{ metadata: unknown }>(
          'select metadata from raw_captures where external_id = $1',
          [externalId],
        )
      ).rows[0]?.metadata;
    try {
      const cust = await createCustomer({
        tenantId,
        name: 'Stamped Customer',
        email: 'stamped@homeowner.test',
      });
      const job = await createJob({ tenantId, customerId: cust.id, title: 'radiator' });

      // (1) THE ARGUMENT. Explicit, and doctrine tells the agent to pass it.
      const a = await callWith('send_email', {
        to: 'stamped@homeowner.test',
        subject: 'Re: radiator',
        body: 'Thursday works.',
        jobId: job.id,
      });
      await callWith('send_email', { confirmId: a.data.confirmId });
      expect((await capRow('sent:stamp-m-1')).rows[0]).toEqual({
        customer_id: cust.id,
        job_id: job.id,
      });

      // (2) THE RECIPIENT, when the argument was forgotten and the address is
      //     on exactly one customer. Customer only — a send names no job by
      //     itself.
      const b = await callWith('send_email', {
        to: 'Stamped <STAMPED@homeowner.test>',
        subject: 'Re: radiator again',
        body: 'See you then.',
      });
      await callWith('send_email', { confirmId: b.data.confirmId });
      expect((await capRow('sent:stamp-m-2')).rows[0]).toEqual({
        customer_id: cust.id,
        job_id: null,
      });

      // (3) AMBIGUOUS — two customers share the address. Neither route may
      //     fabricate: a wrong stamp on an append-only row is permanent, a
      //     missing one is merely a gap.
      await createCustomer({ tenantId, name: 'Twin One', email: 'shared@office.test' });
      await createCustomer({ tenantId, name: 'Twin Two', email: 'shared@office.test' });
      const c = await callWith('send_email', {
        to: 'shared@office.test',
        subject: 'Quote',
        body: 'Attached.',
      });
      const sentC = await callWith('send_email', { confirmId: c.data.confirmId });
      expect(sentC.data).toMatchObject({ status: 'sent', captured: true });
      expect((await capRow('sent:stamp-m-3')).rows[0]).toEqual({
        customer_id: null,
        job_id: null,
      });

      // (4) A STRANGER's address stamps nothing, and the send still happens.
      const d = await callWith('send_email', {
        to: 'nobody@elsewhere.test',
        subject: 'Hello',
        body: 'Introducing ourselves.',
      });
      await callWith('send_email', { confirmId: d.data.confirmId });
      expect((await capRow('sent:stamp-m-4')).rows[0]).toEqual({
        customer_id: null,
        job_id: null,
      });

      // (4b) THE TWO KEYS DISAGREE — a jobId typed by a model reading one screen
      //      while the mail goes to somebody else. Neither is trusted: the
      //      stamp is what findCustomersByThread reads, so a wrong one would
      //      file the RECIPIENT'S later reply onto the wrong customer's job.
      const other = await createCustomer({
        tenantId,
        name: 'Different Person',
        email: 'different@homeowner.test',
      });
      const otherJob = await createJob({
        tenantId,
        customerId: other.id,
        title: "somebody else's work",
      });
      const e = await callWith('send_email', {
        to: 'stamped@homeowner.test', // resolves uniquely to `cust`
        subject: 'Referral',
        body: 'Passing this along.',
        jobId: otherJob.id, // …but the job belongs to `other`
      });
      await callWith('send_email', { confirmId: e.data.confirmId });
      expect((await capRow('sent:stamp-m-5')).rows[0]).toEqual({
        customer_id: null,
        job_id: null,
      });

      // …and when they AGREE, the job still wins (it is the more specific of
      // the two, and it is the only one that names a job at all).
      const f = await callWith('send_email', {
        to: 'different@homeowner.test',
        subject: 'Yours',
        body: 'About your job.',
        jobId: otherJob.id,
      });
      await callWith('send_email', { confirmId: f.data.confirmId });
      expect((await capRow('sent:stamp-m-6')).rows[0]).toEqual({
        customer_id: other.id,
        job_id: otherJob.id,
      });

      // (5) A BAD jobId is refused AT STAGE TIME — the person is about to
      //     approve a preview, and a refusal arriving after the mail has gone
      //     would leave a sent email with an error where its record should be.
      const bad = await callWith('send_email', {
        to: 'stamped@homeowner.test',
        subject: 'x',
        body: 'y',
        jobId: '00000000-0000-0000-0000-000000000000',
      });
      expect(bad.isError).toBe(true);
      expect(bad.text).toContain('job not found');

      // …and another tenant's job is "not found" too, never borrowed.
      const foreignTenant = await pg.query<{ id: string }>(
        "insert into tenants (name) values ('send-email-stamp-foreign') returning id",
      );
      const foreignCust = await createCustomer({
        tenantId: foreignTenant.rows[0].id,
        name: 'Not Ours',
      });
      const foreignJob = await createJob({
        tenantId: foreignTenant.rows[0].id,
        customerId: foreignCust.id,
        title: 'theirs',
      });
      const crossed = await callWith('send_email', {
        to: 'stamped@homeowner.test',
        subject: 'x',
        body: 'y',
        jobId: foreignJob.id,
      });
      expect(crossed.isError).toBe(true);
      expect(crossed.text).toContain('job not found');

      // (6) THE POINT OF ALL THIS: a thread the FIRM started now identifies its
      //     customer, which is what the conversation key reads.
      const byThread = await findCustomersByThread(tenantId, 'stamp-t-1');
      expect(byThread).toContainEqual({ customerId: cust.id, jobId: job.id });

      // (7) THE PRODUCER STAMP, checked against the REAL row rather than a
      //     hand-written stub. Rung 10b.3 gave the send and the Gmail trigger's
      //     later delivery of it ONE external_id, so this predicate is the only
      //     thing keeping the inbound door from running back over the agent's
      //     own send. Rename the key here and the door silently starts
      //     re-extracting our own words and asking the planner about promises
      //     the agent already reported — with every stubbed test still green.
      expect(isAgentWrittenCapture(await capMeta('sent:stamp-m-1'))).toBe(true);
    } finally {
      await client.close();
      await pg.query('delete from technicians where tenant_id=$1 and ref=$2', [
        tenantId,
        'stamp-sam',
      ]);
      await setTenantSeats(tenantId, {
        managerSeats: seatsBefore.manager_seats,
        technicianSeats: seatsBefore.technician_seats,
      });
    }
  });
});

describe('the tier gate on captures (option A: by channel, plus the manager_only stamp)', () => {
  test('a technician sees technician-channel notes and a restricted COUNT; a manager sees everything', { timeout: 30_000 }, async () => {
    const customer = await createCustomer({ tenantId, name: 'Sensitive Cust', phone: '555-9900' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Paid Job' });
    await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      customerId: customer.id,
      jobId: job.id,
      rawText: 'ordinary visit note',
      technicianRef: 'tech-mcp',
    });
    await appendRawCapture({
      tenantId,
      channel: 'agent_action',
      customerId: customer.id,
      jobId: job.id,
      rawText: 'Agent action: STRIPE_CREATE_PAYMENT (stripe) — argument keys: amount_cents',
      technicianRef: 'mgr-test',
      externalId: 'composio-exec:sens-test-1',
      sensitivity: 'manager_only',
    });

    // Technician badge (the main client): the marked row is invisible on every
    // capture-bearing read.
    const byCust = await call('list_recent_captures', { customerId: customer.id });
    expect(byCust.data.captures.map((c: { text: string }) => c.text)).toEqual(['ordinary visit note']);
    expect(byCust.data.restrictedCount).toBe(1);
    const byJob = await call('list_recent_captures', { jobId: job.id });
    expect(byJob.data.captures).toHaveLength(1);
    // …and the full-words read refuses it the same way, with no distinct error.
    const hidden = byJob.data.captures[0].captureId;
    expect((await call('get_capture', { captureId: hidden })).data.found).toBe(true);
    const restrictedId = (
      await pg.query<{ id: string }>(
        "select id from raw_captures where job_id = $1 and channel = 'agent_action'",
        [job.id],
      )
    ).rows[0].id;
    expect((await call('get_capture', { captureId: restrictedId })).data.found).toBe(false);
    // The technician's keyword search sees only what the technician sees.
    const searched = await call('search_captures', { jobId: job.id, query: 'STRIPE' });
    expect(searched.data.count).toBe(0);
    const searchedOk = await call('search_captures', { jobId: job.id, query: 'ordinary' });
    expect(searchedOk.data.matches.map((m: { captureId: string }) => m.captureId)).toEqual([hidden]);
    // The contents page counts the note and says ONE more is outside the view
    // — never its text, and never silently.
    const ctx = await call('get_customer_context', { customerId: customer.id });
    const techJob = ctx.data.jobs.find((j: { id: string }) => j.id === job.id);
    expect(techJob.noteCount).toBe(1);
    expect(techJob.restrictedCount).toBe(1);
    expect(techJob.newest.snippet).toBe('ordinary visit note');

    // Manager badge sees both rows.
    const { client: mgrClient, callWith: mgrCall } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const mgrList = await mgrCall('list_recent_captures', { customerId: customer.id });
      expect(mgrList.data.captures).toHaveLength(2);
      expect(mgrList.data.restrictedCount).toBe(0);
      // …but search is the technician's tool: a manager is pointed at query_spine.
      const refused = await mgrCall('search_captures', { jobId: job.id, query: 'ordinary' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('query_spine');
      const mgrCtx = await mgrCall('get_customer_context', { customerId: customer.id });
      const mgrJob = mgrCtx.data.jobs.find((j: { id: string }) => j.id === job.id);
      expect(mgrJob.noteCount).toBe(2);
      expect(mgrJob.restrictedCount).toBe(0);
    } finally {
      await mgrClient.close();
    }
  });
});

describe('get_schedule', () => {
  // RELATIVE fixtures (Plan 4a): the technician horizon clamps reads beyond
  // today + tenants.technician_horizon_days (default 28), so fixed dates rot
  // the day they cross the horizon. today+7/+8 stay comfortably inside it;
  // identity tech-mcp.
  const G1 = relDay(7);
  const G2 = relDay(8);
  const G3 = relDay(9); // the >10-stop day: the old link cap no longer applies
  const gAssignmentIds: string[] = [];
  const gJobIds: string[] = [];
  const gCustomerIds: string[] = [];

  beforeAll(async () => {
    // Confirmed assignments for tech-mcp (the DB-owned schedule — the mirror
    // retired). `withAddress: false` = a customer with no address_line1, the
    // unroutable-stop case.
    const mk = async (key: string, startISO: string, withAddress = true) => {
      const customer = await createCustomer({
        tenantId,
        name: `G ${key}`,
        ...(withAddress
          ? { addressLine1: `${key} Rd`, city: 'Fresno', state: 'CA', postalCode: '93701' }
          : {}),
      });
      const job = await createJob({ tenantId, customerId: customer.id, title: key });
      const row = await createVisit({
        tenantId,
        jobId: job.id,
        technicianId: techMcpId,
        startsAt: nl(startISO),
        endsAt: nl(new Date(Date.parse(startISO) + 60 * 60_000).toISOString()),
        status: 'confirmed',
      });
      gAssignmentIds.push(row.id);
      gJobIds.push(job.id);
      gCustomerIds.push(customer.id);
    };
    await mk('g1-a', `${G1}T15:00:00.000Z`);
    await mk('g1-b', `${G1}T17:00:00.000Z`);
    await mk('g2-a', `${G2}T16:00:00.000Z`);
    await mk('g2-noaddr', `${G2}T18:00:00.000Z`, false);
    // 12 stops on one day: more than the 10-stop MAX_LINK_STOPS that capped the
    // old single day-route link. Per-stop links have no such ceiling.
    for (let i = 0; i < 12; i++) {
      await mk(`g3-${String(i).padStart(2, '0')}`, `${G3}T${String(8 + i).padStart(2, '0')}:00:00.000Z`);
    }
  });

  afterAll(async () => {
    // Relative fixtures MUST NOT outlive the suite: later suites in this file
    // use fixed future dates (2026-12-*, 2027-*), and today+7/+8 sweeps across
    // them as the calendar advances — leaked rows would break their exact
    // reads deterministically weeks from now (final-review finding; the same
    // hazard boardApi.test.ts solves with all-relative distinct offsets).
    //
    // Jobs and customers go too, in FK order. Deleting only the assignments
    // would leave 16 OPEN jobs with no visit in the tenant — exactly what
    // readUnscheduledJobs (no LIMIT) reports as the loose bucket, so they would
    // surface in every later unassignedOnly / board-tray read in this file.
    await pg.query('delete from visits where id = any($1::uuid[])', [gAssignmentIds]);
    await pg.query('delete from jobs where id = any($1::uuid[])', [gJobIds]);
    await pg.query('delete from customers where id = any($1::uuid[])', [gCustomerIds]);
  });

  async function scheduleClient(extra: Partial<ServerDeps> = {}) {
    return clientFor({ tenantId, technicianRef: 'tech-mcp' }, extra);
  }

  test('multi-day response: stops in BOOKED order, each with its own maps link', async () => {
    const { client: c, callWith } = await scheduleClient();
    try {
      const r = await callWith('get_schedule', { from: G1, to: G2 });
      expect(r.isError).toBe(false);
      expect(r.data.status).toBe('ok');
      expect(r.data.days.map((d: { date: string }) => d.date)).toEqual([G1, G2]);
      const d1 = r.data.days[0];
      // Booked (time) order — 15:00 before 17:00. The schedule is already set,
      // so the read renders it; nothing re-derives a "better" sequence.
      expect(d1.stops.map((s: { label: string }) => s.label)).toEqual(['G g1-a', 'G g1-b']);
      // Wall-clock times as booked, never the stored '+00' timestamp a model
      // would "convert" into the wrong hour (live, 2026-09-22).
      expect(d1.stops.map((s: { startTime: string }) => s.startTime)).toEqual(['15:00', '17:00']);
      expect(d1.stops[0].scheduledStart).toBeUndefined();
      // Each stop links to ITSELF as the destination, not to a day-long route.
      expect(d1.stops[0].mapsUrl).toContain('https://www.google.com/maps/dir/?api=1');
      expect(d1.stops[0].mapsUrl).toContain(
        `destination=${encodeURIComponent('g1-a Rd, Fresno, CA, 93701')}`,
      );
      expect(d1.stops[1].mapsUrl).toContain(
        `destination=${encodeURIComponent('g1-b Rd, Fresno, CA, 93701')}`,
      );
      // No waypoints: a single-destination link is what removes the stop cap.
      expect(d1.stops[0].mapsUrl).not.toContain('waypoints=');
      // The Google-routing fields are gone with the optimization.
      expect(d1.driveMinutes).toBeUndefined();
      expect(d1.optimizeFailed).toBeUndefined();
      expect(d1.linkTruncated).toBeUndefined();
      expect(d1.mapsUrl).toBeUndefined(); // the link moved onto each stop
    } finally {
      await c.close();
    }
  });

  test('null-address stop stays in the day, chronologically, with a null link', async () => {
    const { client: c, callWith } = await scheduleClient();
    try {
      const r = await callWith('get_schedule', { from: G2, to: G2 });
      const day = r.data.days[0];
      // One chronological list. The routable/unroutable split existed only to
      // protect a DRIVE-ordered sequence; in booked order there is none.
      expect(day.stops.map((s: { label: string }) => s.label)).toEqual(['G g2-a', 'G g2-noaddr']);
      expect(day.unroutableStops).toBeUndefined();
      expect(day.stops[0].mapsUrl).toContain('maps/dir');
      expect(day.stops[1].mapsUrl).toBeNull();
      expect(day.stops[1].address).toBeNull();
    } finally {
      await c.close();
    }
  });

  test('a 12-stop day links every stop — the old 10-stop link cap is gone', async () => {
    const { client: c, callWith } = await scheduleClient();
    try {
      const r = await callWith('get_schedule', { from: G3, to: G3 });
      const day = r.data.days[0];
      expect(day.stops).toHaveLength(12);
      // Every one navigable: MAX_LINK_STOPS (10) bounded the single day-route
      // link, and per-stop links have no equivalent ceiling.
      expect(day.stops.every((s: { mapsUrl: string | null }) => s.mapsUrl !== null)).toBe(true);
      expect(day.stops.map((s: { label: string }) => s.label)).toEqual(
        Array.from({ length: 12 }, (_, i) => `G g3-${String(i).padStart(2, '0')}`),
      );
      expect(day.linkTruncated).toBeUndefined();
    } finally {
      await c.close();
    }
  });

  test("default dates are today in the tenant's timezone (empty args)", async () => {
    const { client: c, callWith } = await scheduleClient();
    try {
      // Seed tenant timezone is the migration default America/Los_Angeles.
      // Snapshot the expected day before AND after the call so a run that
      // straddles midnight can't flake.
      const tzToday = () => localDateISO(new Date().toISOString(), 'America/Los_Angeles');
      const before = tzToday();
      const r = await callWith('get_schedule', {});
      const after = tzToday();
      expect(r.data.status).toBe('ok');
      expect([before, after]).toContain(r.data.from);
      expect(r.data.to).toBe(r.data.from);
      // Empty-string from/to ALSO mean "today" (agents routinely emit "" for
      // optional params; main + the board API both default it — pinned after
      // a final-review near-regression turned "" into invalid_range).
      const empty = await callWith('get_schedule', { from: '', to: '' });
      expect(empty.data.status).toBe('ok');
      expect([before, after]).toContain(empty.data.from);
    } finally {
      await c.close();
    }
  });

  test('invalid and oversized ranges are rejected', async () => {
    const { client: c, callWith } = await scheduleClient();
    try {
      for (const args of [
        { from: 'not-a-date' },
        { from: G2, to: G1 }, // from > to
        { from: '2026-09-01', to: '2026-09-30' }, // > 14 days
        { from: '2026-13-01' }, // regex-valid, impossible month
        { from: 20260914 }, // non-string — must reject, not coerce to today
        { to: { date: G1 } }, // non-string object
      ]) {
        const r = await callWith('get_schedule', args as Record<string, unknown>);
        expect(r.data.status).toBe('invalid_range');
      }
    } finally {
      await c.close();
    }
  });

  test('zero-stop range → explicit empty days (within-horizon — not the clamp)', async () => {
    const { client: c, callWith } = await scheduleClient();
    try {
      // Relative near dates: inside the horizon so days:[] means "genuinely
      // no stops", never a clamped answer (which would pass vacuously).
      const r = await callWith('get_schedule', { from: relDay(2), to: relDay(3) });
      expect(r.data).toMatchObject({ status: 'ok', days: [] });
      expect(r.data.horizonNote).toBeUndefined();
    } finally {
      await c.close();
    }
  });

  test('roster-less badge → empty days, no crash', async () => {
    // A valid badge with NO roster row keeps the plain-technician surface;
    // its schedule is simply empty (daySource returns []). G1/G2 are
    // within-horizon so this is the empty-roster case, not the clamp.
    const { client: c, callWith } = await clientFor({
      tenantId,
      technicianRef: 'badge-no-roster-row',
    });
    try {
      const r = await callWith('get_schedule', { from: G1, to: G2 });
      expect(r.isError).toBe(false);
      expect(r.data).toMatchObject({ status: 'ok', days: [] });
      expect(r.data.horizonNote).toBeUndefined();
    } finally {
      await c.close();
    }
  });

  test('technician visibility horizon: beyond → empty + note; straddling → trimmed + note', async () => {
    const { client: c, callWith } = await scheduleClient();
    try {
      // Fully beyond today + 28 (default horizon): ok, empty, self-explaining.
      const beyond = await callWith('get_schedule', { from: relDay(40), to: relDay(41) });
      expect(beyond.data.status).toBe('ok');
      expect(beyond.data.days).toEqual([]);
      expect(beyond.data.horizonNote).toContain("isn't published yet");
      // Straddling the horizon: trimmed `to` + note. Firm-local today can lag
      // the UTC-derived relDay by one day, so pin bounds, not the exact date.
      const straddle = await callWith('get_schedule', { from: relDay(25), to: relDay(31) });
      expect(straddle.data.status).toBe('ok');
      expect(straddle.data.horizonNote).toContain("isn't published yet");
      expect(straddle.data.to < relDay(31)).toBe(true);
      expect(straddle.data.to >= relDay(27)).toBe(true);
    } finally {
      await c.close();
    }
  });
});

describe('web_search', () => {
  const webStub =
    (results: Array<{ title: string; url: string; snippet: string }>, seen?: number[]) =>
    async (_query: string, count: number) => {
      seen?.push(count);
      return results;
    };
  const RESULTS = [
    { title: 'Codes', url: 'https://hvac-help.example/codes', snippet: 'code 33 = limit fault' },
    { title: 'Manual', url: 'https://carrier.example/manual', snippet: 'install manual' },
  ];

  test('returns results with the untrusted note and logs query + result URLs', async () => {
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'web-tech' },
      { webSearch: webStub(RESULTS) },
    );
    try {
      const r = await callWith('web_search', { query: 'carrier code 33' });
      expect(r.isError).toBe(false);
      expect(r.data.results).toEqual(RESULTS);
      expect(r.data.note).toContain('untrusted');
      const rows = await pg.query<{ kind: string; value: string }>(
        "select kind, value from web_requests where technician_ref = 'web-tech' order by kind, value",
      );
      expect(rows.rows).toEqual([
        { kind: 'search', value: 'carrier code 33' },
        { kind: 'search_result', value: 'https://carrier.example/manual' },
        { kind: 'search_result', value: 'https://hvac-help.example/codes' },
      ]);
    } finally {
      await c.close();
    }
  });

  test('clamps maxResults to 1-10 and requires a query', async () => {
    const seen: number[] = [];
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'web-clamp' },
      { webSearch: webStub([], seen) },
    );
    try {
      await callWith('web_search', { query: 'x', maxResults: 99 });
      await callWith('web_search', { query: 'x', maxResults: -3 });
      expect(seen).toEqual([10, 1]);
      const missing = await callWith('web_search', { maxResults: 2 });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('query is required');
    } finally {
      await c.close();
    }
  });

  test('a failed upstream search still logs the query (consumes the cap, stays audited)', async () => {
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'web-fail' },
      {
        webSearch: async () => {
          throw new Error('brave upstream 429');
        },
      },
    );
    try {
      const r = await callWith('web_search', { query: 'carrier code 33' });
      expect(r.isError).toBe(true);
      const rows = await pg.query(
        "select kind, value from web_requests where technician_ref = 'web-fail'",
      );
      // The query row is written BEFORE the Brave call, so a retry-looping agent
      // cannot hammer the paid endpoint uncapped; no search_result rows exist.
      expect(rows.rows).toEqual([{ kind: 'search', value: 'carrier code 33' }]);
    } finally {
      await c.close();
    }
  });

  test('daily cap blocks the 51st search — and only for the capped person/tenant', async () => {
    const seed = Array.from({ length: 50 }, (_, i) => ({
      tenantId,
      technicianRef: 'web-capped',
      kind: 'search' as const,
      value: `q${i}`,
    }));
    await logWebRequests(seed);
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'web-capped' },
      { webSearch: webStub(RESULTS) },
    );
    try {
      const blocked = await callWith('web_search', { query: 'one too many' });
      expect(blocked.isError).toBe(true);
      expect(blocked.text).toContain('daily web search limit reached (50/day)');
    } finally {
      await c.close();
    }
    // Same ref under ANOTHER tenant is not capped: the count is tenant-scoped.
    const other = await createTenant(`Web Iso ${Date.now()}`);
    const { client: c2, callWith: call2 } = await clientFor(
      { tenantId: other.id, technicianRef: 'web-capped' },
      { webSearch: webStub(RESULTS) },
    );
    try {
      const ok = await call2('web_search', { query: 'fresh tenant' });
      expect(ok.isError).toBe(false);
    } finally {
      await c2.close();
    }
  });
});

describe('read_webpage', () => {
  const pageStub = (text: string) => async (url: string) => ({
    finalUrl: url,
    contentType: 'html' as const,
    text,
    truncated: false,
  });
  const LONG_URL = `https://supplier.example/quote/${'x'.repeat(600)}?t=tok`;

  test('a recent search-result URL fetches with no length cap; the warning rides along', async () => {
    await logWebRequests([
      { tenantId, technicianRef: 'rw-prov', kind: 'search_result', value: LONG_URL },
    ]);
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'rw-prov' },
      { fetchPage: pageStub('quote total $4,830.50') },
    );
    try {
      const r = await callWith('read_webpage', { url: LONG_URL });
      expect(r.isError).toBe(false);
      expect(r.data.content).toContain('4,830.50');
      expect(r.data.warning).toContain('untrusted');
    } finally {
      await c.close();
    }
  });

  test("another person's search result does not vouch: same long URL is refused", async () => {
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'rw-other' },
      { fetchPage: pageStub('never fetched') },
    );
    try {
      const r = await callWith('read_webpage', { url: LONG_URL });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('too long to open safely');
    } finally {
      await c.close();
    }
  });

  test('an over-length URL is refused BUT the probe is logged and consumes the cap', async () => {
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'rw-longprobe' },
      { fetchPage: pageStub('never fetched') },
    );
    try {
      const r = await callWith('read_webpage', { url: LONG_URL });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('too long to open safely');
      const rows = await pg.query(
        "select count(*)::int as n from web_requests where technician_ref = 'rw-longprobe' and kind = 'fetch'",
      );
      // The attempt-log runs BEFORE the length reject, so exfil-shaped URL
      // probing is capped and visible, per the migration's stated invariant.
      expect(rows.rows[0].n).toBe(1);
    } finally {
      await c.close();
    }
  });

  test('a stale (>2h) search result ages out of the no-cap tier', async () => {
    await pg.query(
      `insert into web_requests (tenant_id, technician_ref, kind, value, created_at)
       values ($1, 'rw-stale', 'search_result', $2, now() - interval '3 hours')`,
      [tenantId, LONG_URL],
    );
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'rw-stale' },
      { fetchPage: pageStub('never fetched') },
    );
    try {
      const r = await callWith('read_webpage', { url: LONG_URL });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('too long to open safely');
    } finally {
      await c.close();
    }
  });

  test('a short pasted URL fetches with no confirmation and logs the attempt', async () => {
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'rw-paste' },
      { fetchPage: pageStub('supplier hours 7-5') },
    );
    try {
      const r = await callWith('read_webpage', { url: 'https://supplier.example/hours' });
      expect(r.isError).toBe(false);
      expect(r.data.content).toContain('hours 7-5');
      const rows = await pg.query(
        "select value from web_requests where technician_ref = 'rw-paste' and kind = 'fetch'",
      );
      expect(rows.rows).toEqual([{ value: 'https://supplier.example/hours' }]);
    } finally {
      await c.close();
    }
  });

  test('the attempt is logged even when the fetch itself fails', async () => {
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'rw-fail' },
      {
        fetchPage: async () => {
          throw new Error('this address is not reachable from the assistant');
        },
      },
    );
    try {
      const r = await callWith('read_webpage', { url: 'https://blocked.example/x' });
      expect(r.isError).toBe(true);
      const rows = await pg.query(
        "select count(*)::int as n from web_requests where technician_ref = 'rw-fail' and kind = 'fetch'",
      );
      expect(rows.rows[0].n).toBe(1); // rejected probes consume the cap
    } finally {
      await c.close();
    }
  });

  test('daily fetch cap blocks the 31st attempt', async () => {
    await logWebRequests(
      Array.from({ length: 30 }, (_, i) => ({
        tenantId,
        technicianRef: 'rw-capped',
        kind: 'fetch' as const,
        value: `https://x.example/${i}`,
      })),
    );
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'rw-capped' },
      { fetchPage: pageStub('never fetched') },
    );
    try {
      const r = await callWith('read_webpage', { url: 'https://x.example/31' });
      expect(r.isError).toBe(true);
      expect(r.text).toContain('daily page-read limit reached (30/day)');
    } finally {
      await c.close();
    }
  });

  test('url is required', async () => {
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'rw-req' },
      { fetchPage: pageStub('x') },
    );
    try {
      const r = await callWith('read_webpage', {});
      expect(r.isError).toBe(true);
      expect(r.text).toContain('url is required');
    } finally {
      await c.close();
    }
  });
});

// The main `call` client's identity is 'tech-mcp' (active TECHNICIAN tier), so
// every flow below is the technician-badge end-to-end path by construction.
describe('record_standing_fact (records on the first call)', () => {
  // The review item a first call committed through: the evidence capture's
  // externalId is `fact:<item id>`, and that id is the confirmId a retry uses.
  const itemIdOf = async (captureId: string): Promise<string> => {
    const r = await pg.query<{ external_id: string }>('select external_id from raw_captures where id = $1', [
      captureId,
    ]);
    const ext = r.rows[0].external_id;
    expect(ext.startsWith('fact:')).toBe(true);
    return ext.slice('fact:'.length);
  };
  // A HELD fact, exactly as a first call leaves it when its commit fails (the
  // item stays open so a confirmId-alone retry converges). The confirm path's
  // guards only ever run on such an item now, so the tests build it directly.
  const holdFact = async (input: {
    customerId: string;
    targetName: string;
    facts: Array<{ key: string; value: string | number | boolean; previousValue?: Json }>;
    stagedAt?: string;
  }) =>
    upsertOpenReviewItem({
      tenantId,
      kind: 'pending_standing_fact',
      subjectRef: 'tech-mcp', // the suite's `call` identity
      detail: {
        target: 'customer',
        targetId: input.customerId,
        customerId: input.customerId,
        targetName: input.targetName,
        facts: input.facts as unknown as Json,
        sourceText: null,
        stagedAt: input.stagedAt ?? new Date().toISOString(),
      },
    });
  const statusOf = async (itemId: string): Promise<string> =>
    (await pg.query<{ status: string }>('select status from review_items where id = $1', [itemId])).rows[0]
      .status;

  test('one call records: wrapped bundle + evidence capture, and the review item ends resolved', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Cust', phone: '555-9001' });

    const done = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'Prefers Contact!', // normalizes to prefers_contact
      value: 'email',
      sourceText: 'they said email only from now on',
    });
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('recorded');
    expect(done.data).toMatchObject({ target: 'customer', targetId: customer.id, key: 'prefers_contact' });
    expect(done.data.keys).toEqual(['prefers_contact']);
    expect(done.data.replaced).toBeUndefined(); // a new fact replaces nothing

    // Evidence capture: externalId stamp, verbatim sourceText, customer stamp.
    const cap = await pg.query<{
      external_id: string;
      raw_text: string;
      customer_id: string;
      channel: string;
      technician_ref: string;
    }>(
      'select external_id, raw_text, customer_id, channel, technician_ref from raw_captures where id = $1',
      [done.data.captureId],
    );
    const itemId = await itemIdOf(done.data.captureId);
    expect(cap.rows[0].external_id).toBe(`fact:${itemId}`);
    expect(cap.rows[0].raw_text).toBe('they said email only from now on');
    expect(cap.rows[0].customer_id).toBe(customer.id);
    expect(cap.rows[0].channel).toBe('technician_note');
    expect(cap.rows[0].technician_ref).toBe('tech-mcp'); // identity, not args
    // The item the call committed through is closed, not left dangling open.
    expect(await statusOf(itemId)).toBe('resolved');

    // The wrapped bundle landed on the customer row.
    const after = await pg.query<{
      attributes: { prefers_contact?: { value: string; sourceCaptureId: string; recordedAt: string } };
    }>('select attributes from customers where id = $1', [customer.id]);
    const fact = after.rows[0].attributes.prefers_contact;
    expect(fact?.value).toBe('email');
    expect(fact?.sourceCaptureId).toBe(done.data.captureId);
    expect(typeof fact?.recordedAt).toBe('string');
  });

  test('a job fact stamps BOTH ids on the evidence; an overwrite reports what it replaced', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Job Cust', phone: '555-9002' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Boiler swap' });

    const firstDone = await call('record_standing_fact', { jobId: job.id, key: 'crane_needed', value: true });
    expect(firstDone.data.status).toBe('recorded');
    expect(firstDone.data.target).toBe('job');

    const cap = await pg.query<{ customer_id: string; job_id: string }>(
      'select customer_id, job_id from raw_captures where id = $1',
      [firstDone.data.captureId],
    );
    expect(cap.rows[0].customer_id).toBe(customer.id);
    expect(cap.rows[0].job_id).toBe(job.id);

    const secondDone = await call('record_standing_fact', { jobId: job.id, key: 'crane_needed', value: false });
    expect(secondDone.data.status).toBe('recorded');
    // With no preview, the overwrite is said in the result.
    expect(secondDone.data.replaced).toEqual([{ key: 'crane_needed', was: true, now: false }]);
    const after = await pg.query<{
      attributes: { crane_needed?: { value: boolean; sourceCaptureId: string } };
    }>('select attributes from jobs where id = $1', [job.id]);
    expect(after.rows[0].attributes.crane_needed?.value).toBe(false);
    expect(after.rows[0].attributes.crane_needed?.sourceCaptureId).toBe(secondDone.data.captureId);
  });

  test('a first call that overwrites reports `replaced` only for the overwritten key, and resolves its item', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Replaced Cust', phone: '555-9024' });
    await call('record_standing_fact', { customerId: customer.id, key: 'gate_code', value: '1111' });

    const done = await call('record_standing_fact', {
      customerId: customer.id,
      facts: [
        { key: 'gate_code', value: '2222' },
        { key: 'dog_on_site', value: true }, // new — not in `replaced`
      ],
    });
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('recorded');
    expect(done.data.replaced).toEqual([{ key: 'gate_code', was: '1111', now: '2222' }]);
    expect(done.data.conflictKeys).toBeUndefined();
    const itemId = await itemIdOf(done.data.captureId);
    expect(await statusOf(itemId)).toBe('resolved');
    // Nothing is left open for this person: the next call has nothing to supersede.
    const open = await pg.query<{ n: number }>(
      "select count(*)::int as n from review_items where kind = 'pending_standing_fact' and subject_ref = 'tech-mcp' and status = 'open'",
    );
    expect(Number(open.rows[0].n)).toBe(0);
  });

  test('argument guards: both/neither target, bad keys/values, cross-tenant target', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Guard', phone: '555-9003' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'G' });

    const neither = await call('record_standing_fact', { key: 'k', value: 'v' });
    expect(neither.isError).toBe(true);
    expect(neither.text).toContain('exactly one of customerId or jobId');
    const both = await call('record_standing_fact', {
      customerId: customer.id,
      jobId: job.id,
      key: 'k',
      value: 'v',
    });
    expect(both.isError).toBe(true);

    const noKey = await call('record_standing_fact', { customerId: customer.id, value: 'v' });
    expect(noKey.isError).toBe(true);
    const badKey = await call('record_standing_fact', { customerId: customer.id, key: '!!!', value: 'v' });
    expect(badKey.isError).toBe(true);

    const badValue = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'k',
      value: { nested: true },
    });
    expect(badValue.isError).toBe(true);
    expect(badValue.text).toContain('string, number, or boolean');
    const longValue = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'k',
      value: 'x'.repeat(501),
    });
    expect(longValue.isError).toBe(true);
    expect(longValue.text).toContain('too long');

    // A cross-tenant target reads as not found (tenant guard).
    const otherTenant = await createTenant('Fact Other Tenant');
    const foreign = await createCustomer({ tenantId: otherTenant.id, name: 'Foreign', phone: '555-0000' });
    const forged = await call('record_standing_fact', { customerId: foreign.id, key: 'k', value: 'v' });
    expect(forged.isError).toBe(true);
    expect(forged.text).toContain('customer not found');
  });

  test('a held fact (a failed commit) that expired dismisses without writing; a forged confirmId is rejected', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Expiry', phone: '555-9004' });
    const held = await holdFact({
      customerId: customer.id,
      targetName: 'Fact Expiry',
      facts: [{ key: 'gate_code', value: 4321 }],
      stagedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
    });
    const expired = await call('record_standing_fact', { confirmId: held.id });
    expect(expired.isError).toBe(true);
    expect(expired.text).toContain('expired');
    const after = await pg.query<{ attributes: Record<string, unknown> }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(after.rows[0].attributes.gate_code).toBeUndefined();
    // The item was actually DISMISSED (not left silently open): a retry finds
    // nothing to finish.
    expect(await statusOf(held.id)).toBe('dismissed');
    const retry = await call('record_standing_fact', { confirmId: held.id });
    expect(retry.isError).toBe(true);
    expect(retry.text).toContain('confirmation not found');

    const forged = await call('record_standing_fact', {
      confirmId: '00000000-0000-0000-0000-000000000000',
    });
    expect(forged.isError).toBe(true);
    expect(forged.text).toContain('confirmation not found');
  });

  test('drift guard: a fact recorded by someone ELSE before a held fact is retried is never clobbered', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Drift', phone: '555-9010' });
    // The tech's first call failed to commit: gate_code 1111 is held, read as new.
    const held = await holdFact({
      customerId: customer.id,
      targetName: 'Fact Drift',
      facts: [{ key: 'gate_code', value: 1111 }],
    });

    // A manager records the same key before the tech's retry.
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const mgrDone = await callWith('record_standing_fact', {
        customerId: customer.id,
        key: 'gate_code',
        value: 2222,
      });
      expect(mgrDone.data.status).toBe('recorded');
    } finally {
      await mgrClient.close();
    }

    // The tech's retry must refuse — not silently overwrite 2222 with 1111.
    const clobber = await call('record_standing_fact', { confirmId: held.id });
    expect(clobber.isError).toBe(true);
    expect(clobber.text).toContain('changed on this customer');
    expect(clobber.text).toContain('call again to record over the current values');
    // No orphan evidence capture was written for the refused retry.
    const caps = await pg.query<{ n: number }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [`fact:${held.id}`],
    );
    expect(Number(caps.rows[0].n)).toBe(0);
    // The manager's fact is intact, and the held item is dead (dismissed).
    const row = await pg.query<{ attributes: { gate_code?: { value: number } } }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(row.rows[0].attributes.gate_code?.value).toBe(2222);
    const retry = await call('record_standing_fact', { confirmId: held.id });
    expect(retry.isError).toBe(true);
    expect(retry.text).toContain('confirmation not found');
  });

  test('stale replay guard: a re-opened item never reverts a NEWER fact; a landed-unconsumed item blocks a new call', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Replay', phone: '555-9011' });
    const done = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'gate_code',
      value: 1111,
    });
    expect(done.data.status).toBe('recorded');
    const itemId = await itemIdOf(done.data.captureId);

    // Simulate the crash window: commit landed, consume never ran.
    await pg.query(
      "update review_items set status = 'open', resolution = null, resolved_at = null where id = $1",
      [itemId],
    );

    // While the item dangles open, a NEW call is refused — the landed evidence
    // must converge through its own confirmId, not be stranded by a supersede.
    const blocked = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'other_key',
      value: 'x',
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain('still unfinished');
    expect(blocked.text).toContain(itemId);

    // A manager then overwrites the key with a NEWER fact.
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      await callWith('record_standing_fact', { customerId: customer.id, key: 'gate_code', value: 2222 });
    } finally {
      await mgrClient.close();
    }

    // The tech's replay of the dangling item must NOT revert 2222 to 1111.
    const replay = await call('record_standing_fact', { confirmId: itemId });
    expect(replay.isError).toBe(true);
    expect(replay.text).toContain('changed on this customer');
    const row = await pg.query<{ attributes: { gate_code?: { value: number } } }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(row.rows[0].attributes.gate_code?.value).toBe(2222);
    // The conflicted item is dismissed, so a fresh call now records.
    const next = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'other_key',
      value: 'x',
    });
    expect(next.isError).toBe(false);
    expect(next.data.status).toBe('recorded');
  });

  test("empty sourceText falls back to the canonical evidence text; a 'constructor' key never reads a prototype member as a replaced value", async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Edge', phone: '555-9012' });
    const done = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'Constructor', // normalizes to 'constructor' — must not hit Object.prototype
      value: 'edge',
      sourceText: '   ', // whitespace-only must not become the permanent evidence
    });
    expect(done.data.status).toBe('recorded');
    expect(done.data.replaced).toBeUndefined();
    const cap = await pg.query<{ raw_text: string }>(
      'select raw_text from raw_captures where id = $1',
      [done.data.captureId],
    );
    expect(cap.rows[0].raw_text).toBe('Standing fact: constructor = edge');
  });

  test('crash-heal: item re-opened after a landed commit — a confirmId retry converges on ONE capture, same bundle', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Heal', phone: '555-9005' });
    const done = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'dog_on_site',
      value: true,
    });
    expect(done.data.status).toBe('recorded');
    const itemId = await itemIdOf(done.data.captureId);

    // A confirmId retry on the CONSUMED item errors honestly.
    const dead = await call('record_standing_fact', { confirmId: itemId });
    expect(dead.isError).toBe(true);
    expect(dead.text).toContain('confirmation not found');

    // Simulate the crash window (commit landed, consume never ran) and retry.
    await pg.query(
      "update review_items set status = 'open', resolution = null, resolved_at = null where id = $1",
      [itemId],
    );
    const retried = await call('record_standing_fact', { confirmId: itemId });
    expect(retried.isError).toBe(false);
    expect(retried.data.status).toBe('recorded');
    expect(retried.data.captureId).toBe(done.data.captureId); // same evidence row

    const caps = await pg.query<{ n: number }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [`fact:${itemId}`],
    );
    expect(Number(caps.rows[0].n)).toBe(1);
    const after = await pg.query<{ attributes: { dog_on_site?: { sourceCaptureId: string } } }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(after.rows[0].attributes.dog_on_site?.sourceCaptureId).toBe(done.data.captureId);
  });

  test('a new call supersedes a held fact whose evidence never landed', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Cancel', phone: '555-9006' });
    const held = await holdFact({ customerId: customer.id, targetName: 'Fact Cancel', facts: [{ key: 'k_one', value: 1 }] });
    // One open item per person: the new call dismisses the held one and records.
    const b = await call('record_standing_fact', { customerId: customer.id, key: 'k_two', value: 2 });
    expect(b.data.status).toBe('recorded');
    expect(await itemIdOf(b.data.captureId)).not.toBe(held.id);
    expect(await statusOf(held.id)).toBe('dismissed');
    const deadA = await call('record_standing_fact', { confirmId: held.id });
    expect(deadA.isError).toBe(true);
  });

  test('batch: several facts record in ONE call under ONE capture, and fold together on retraction', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Batch Cust', phone: '555-9020' });
    // Seed one key so the batch reports an overwrite.
    await call('record_standing_fact', { customerId: customer.id, key: 'gate_code', value: '1111' });

    const done = await call('record_standing_fact', {
      customerId: customer.id,
      facts: [
        { key: 'Dog On Property', value: true }, // normalizes to dog_on_property
        { key: 'gate_code', value: '2234' },
      ],
      sourceText: 'dog on the property; gated community, code 2234',
    });
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('recorded');
    expect([...done.data.keys].sort()).toEqual(['dog_on_property', 'gate_code']);
    expect(done.data.replaced).toEqual([{ key: 'gate_code', was: '1111', now: '2234' }]);
    // A multi-fact result has no flat single-fact key.
    expect(done.data.key).toBeUndefined();

    // ONE evidence capture; BOTH bundles cite it.
    const itemId = await itemIdOf(done.data.captureId);
    const caps = await pg.query<{ n: number }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [`fact:${itemId}`],
    );
    expect(Number(caps.rows[0].n)).toBe(1);
    const row = await pg.query<{
      attributes: {
        dog_on_property?: { value: boolean; sourceCaptureId: string };
        gate_code?: { value: string; sourceCaptureId: string };
      };
    }>('select attributes from customers where id = $1', [customer.id]);
    expect(row.rows[0].attributes.dog_on_property?.value).toBe(true);
    expect(row.rows[0].attributes.gate_code?.value).toBe('2234');
    expect(row.rows[0].attributes.dog_on_property?.sourceCaptureId).toBe(done.data.captureId);
    expect(row.rows[0].attributes.gate_code?.sourceCaptureId).toBe(done.data.captureId);

    // Crash-heal replay converges without rewriting (both keys 'already').
    await pg.query(
      "update review_items set status = 'open', resolution = null, resolved_at = null where id = $1",
      [itemId],
    );
    const replay = await call('record_standing_fact', { confirmId: itemId });
    expect(replay.isError).toBe(false);
    expect(replay.data.status).toBe('recorded');
    expect(replay.data.captureId).toBe(done.data.captureId);

    // Retract the ONE evidence capture → the whole batch folds away.
    const rs = await call('retract_capture', {
      captureId: done.data.captureId,
      reason: 'recorded in error',
    });
    await call('retract_capture', { confirmId: rs.data.confirmId });
    const ctx = await call('get_customer_context', { customerId: customer.id });
    expect(ctx.data.customer.attributes.dog_on_property).toBeUndefined();
    expect(ctx.data.customer.attributes.gate_code).toBeUndefined();
  });

  test('batch guards: duplicate keys, mixed forms, oversize, and whole-batch drift refusal on a held retry', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Batch Guard', phone: '555-9021' });

    const dup = await call('record_standing_fact', {
      customerId: customer.id,
      facts: [
        { key: 'Gate Code', value: '1' },
        { key: 'gate_code', value: '2' },
      ],
    });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain('duplicate fact key');

    const mixed = await call('record_standing_fact', {
      customerId: customer.id,
      facts: [{ key: 'k', value: 'v' }],
      key: 'other',
      value: 'x',
    });
    expect(mixed.isError).toBe(true);
    expect(mixed.text).toContain('not both');

    const oversize = await call('record_standing_fact', {
      customerId: customer.id,
      facts: Array.from({ length: 11 }, (_, i) => ({ key: `k_${i}`, value: i })),
    });
    expect(oversize.isError).toBe(true);
    expect(oversize.text).toContain('at most 10');

    const empty = await call('record_standing_fact', { customerId: customer.id, facts: [] });
    expect(empty.isError).toBe(true);

    // Drift on ANY key refuses the WHOLE held batch before the evidence lands.
    const held = await holdFact({
      customerId: customer.id,
      targetName: 'Fact Batch Guard',
      facts: [
        { key: 'prefers_contact', value: 'email' },
        { key: 'gate_code', value: '9999' },
      ],
    });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      await callWith('record_standing_fact', { customerId: customer.id, key: 'gate_code', value: '5555' });
    } finally {
      await mgrClient.close();
    }
    const refused = await call('record_standing_fact', { confirmId: held.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("'gate_code' changed on this customer");
    // No orphan evidence for the refused batch; the untouched key stayed absent.
    const caps = await pg.query<{ n: number }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [`fact:${held.id}`],
    );
    expect(Number(caps.rows[0].n)).toBe(0);
    const row = await pg.query<{ attributes: Record<string, unknown> }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(row.rows[0].attributes.prefers_contact).toBeUndefined();
    expect((row.rows[0].attributes.gate_code as { value?: string })?.value).toBe('5555'); // manager's fact intact
  });

  test('legacy pre-deploy token (top-level key/value detail) still confirms correctly', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Legacy Cust', phone: '555-9022' });
    // Stage a legacy-SHAPED token directly (as the pre-batch deploy wrote them):
    // detail carries top-level key/value, no facts[] array.
    const item = await upsertOpenReviewItem({
      tenantId,
      kind: 'pending_standing_fact',
      subjectRef: 'tech-mcp',
      detail: {
        target: 'customer',
        targetId: customer.id,
        customerId: customer.id,
        targetName: 'Fact Legacy Cust',
        key: 'legacy_key',
        value: false, // falsy value must survive the normalization
        sourceText: null,
        stagedAt: new Date().toISOString(),
      },
    });
    const done = await call('record_standing_fact', { confirmId: item.id });
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('recorded');
    expect(done.data.key).toBe('legacy_key');
    const row = await pg.query<{ attributes: { legacy_key?: { value: boolean } } }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(row.rows[0].attributes.legacy_key?.value).toBe(false);
  });

  test('partial-conflict replay: a re-opened batch item skips the overwritten key, applies the rest, and reports honestly', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Partial Cust', phone: '555-9023' });
    const done = await call('record_standing_fact', {
      customerId: customer.id,
      facts: [
        { key: 'alpha', value: 'a1' },
        { key: 'beta', value: 'b1' },
      ],
    });
    expect(done.data.status).toBe('recorded');
    const itemId = await itemIdOf(done.data.captureId);

    // Crash window + a NEWER overwrite of one key by someone else.
    await pg.query(
      "update review_items set status = 'open', resolution = null, resolved_at = null where id = $1",
      [itemId],
    );
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      await callWith('record_standing_fact', { customerId: customer.id, key: 'alpha', value: 'NEWER' });
    } finally {
      await mgrClient.close();
    }

    const replay = await call('record_standing_fact', { confirmId: itemId });
    expect(replay.isError).toBe(false);
    expect(replay.data.status).toBe('recorded');
    expect(replay.data.keys).toEqual(['beta']); // 'already' counts as recorded
    expect(replay.data.conflictKeys).toEqual(['alpha']); // skipped, named
    expect(replay.data.note).toContain('NOT overwritten');
    // The newer value survived; the item's resolution names the skip.
    const row = await pg.query<{ attributes: { alpha?: { value: string } } }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(row.rows[0].attributes.alpha?.value).toBe('NEWER');
    const token = await pg.query<{ status: string; resolution: string }>(
      'select status, resolution from review_items where id = $1',
      [itemId],
    );
    expect(token.rows[0].status).toBe('resolved');
    expect(token.rows[0].resolution).toContain('skipped changed keys: alpha');
  });

  test('retraction fold: retracting the evidence hides the fact from context, get_job, and find_customer; the audit view keeps it labeled', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Fold Cust', phone: '555-9007' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Fold Job' });

    const cDone = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'prefers_contact',
      value: 'email',
    });
    const jDone = await call('record_standing_fact', { jobId: job.id, key: 'crane_needed', value: true });

    // Visible before any retraction.
    const before = await call('get_customer_context', { customerId: customer.id });
    expect(before.data.customer.attributes.prefers_contact.value).toBe('email');
    expect(
      before.data.jobs.find((j: { id: string }) => j.id === job.id).attributes.crane_needed.value,
    ).toBe(true);

    // Retract the CUSTOMER fact's evidence (author retracts their own capture).
    const rs = await call('retract_capture', {
      captureId: cDone.data.captureId,
      reason: 'wrong customer preference',
    });
    const rDone = await call('retract_capture', { confirmId: rs.data.confirmId });
    expect(rDone.data.status).toBe('retracted');

    // The customer fact is gone; the (unretracted) job fact stays.
    const after = await call('get_customer_context', { customerId: customer.id });
    expect(after.data.customer.attributes.prefers_contact).toBeUndefined();
    expect(
      after.data.jobs.find((j: { id: string }) => j.id === job.id).attributes.crane_needed.value,
    ).toBe(true);

    // find_customer folds the same way.
    const found = await call('find_customer', { query: 'Fact Fold Cust' });
    const row = found.data.customers.find((c: { id: string }) => c.id === customer.id);
    expect(row.attributes.prefers_contact).toBeUndefined();

    // Retract the JOB fact's evidence → get_job folds too.
    const rjs = await call('retract_capture', {
      captureId: jDone.data.captureId,
      reason: 'no crane after all',
    });
    await call('retract_capture', { confirmId: rjs.data.confirmId });
    const jobAfter = await call('get_job', { jobId: job.id });
    expect(jobAfter.data.attributes.crane_needed).toBeUndefined();

    // Manager audit view: the evidence capture is still there, labeled.
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const audit = await callWith('list_recent_captures', {
        customerId: customer.id,
        includeRetracted: true,
      });
      const evidence = audit.data.captures.find(
        (c: { captureId: string }) => c.captureId === cDone.data.captureId,
      );
      expect(evidence.retracted.reason).toBe('wrong customer preference');
    } finally {
      await mgrClient.close();
    }
  });

  test("overwrite + retraction: only the CURRENT bundle's evidence controls the fold", async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Overfold', phone: '555-9008' });
    const firstDone = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'gate_code',
      value: 1111,
    });
    const secondDone = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'gate_code',
      value: 2222,
    });

    // Retracting the OLD evidence must not hide the fact — the current bundle
    // cites the new capture.
    const r1 = await call('retract_capture', {
      captureId: firstDone.data.captureId,
      reason: 'superseded evidence',
    });
    await call('retract_capture', { confirmId: r1.data.confirmId });
    const mid = await call('get_customer_context', { customerId: customer.id });
    expect(mid.data.customer.attributes.gate_code.value).toBe(2222);

    // Retracting the CURRENT evidence hides it.
    const r2 = await call('retract_capture', {
      captureId: secondDone.data.captureId,
      reason: 'wrong code',
    });
    await call('retract_capture', { confirmId: r2.data.confirmId });
    const end = await call('get_customer_context', { customerId: customer.id });
    expect(end.data.customer.attributes.gate_code).toBeUndefined();

    // Recording the key again after the retraction must NOT report the
    // retracted value as replaced — the visible record has no such fact.
    const again = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'gate_code',
      value: 3333,
    });
    expect(again.data.status).toBe('recorded');
    expect(again.data.replaced).toBeUndefined();
  });
});

describe('scheduling tools (book/move/unschedule_visit + get_team_schedule)', () => {
  test('an UNTIMED booking, then recall + find_slots — plan 4b-2, rung 9a', { timeout: 30_000 }, async () => {
    const customer = await createCustomer({
      tenantId,
      name: 'TBD Ursula',
      addressLine1: '9 Window Way',
      city: 'Clovis',
      state: 'CA',
      postalCode: '93611',
    });
    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      // Partial time input is an agent error, refused loudly.
      const mixed = await callWith('book_visit', {
        customerId: customer.id, title: 'tbd mixed',
        date: '2026-12-14', startTime: '09:00',
      });
      expect(mixed.isError).toBe(true);
      expect(mixed.text).toContain('required TOGETHER');

      // An UNTIMED booking lands in ONE call (rung 9a: nothing stages it, and
      // nothing records when it should happen).
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        title: 'tbd install', untimed: true });
      expect(booked.data.status).toBe('booked');
      expect(booked.data.untimed).toBe(true);
      expect(booked.data.date).toBeNull();
      expect(booked.data.startTime).toBeNull();
      const visitId = booked.data.visitId as string;
      const { rows } = await pg.query(
        'select starts_at, ends_at from visits where id = $1',
        [visitId],
      );
      expect(rows[0].starts_at).toBeNull();
      expect(rows[0].ends_at).toBeNull();
      // The recall view still reaches it — an untimed visit sits on NO day, so
      // it rides the `untimed` list rather than a day group. The straddling-
      // range clamp it used to need is gone with the range itself: there is no
      // date to clamp, and therefore no way to mis-date it.
      const recallVisits = await recallAll(callWith, 'visits');
      const mine = recallVisits.find((st) => st.visitId === visitId);
      expect(mine).toBeDefined();
      expect(mine?.unassigned).toBe(true);
      // …and it sits on no day at all (retrieval layer 4: the recall list carries
      // untimed visits with date null, never on a date).
      expect(mine?.date).toBeNull();

      // find_slots on the untimed visit: duration from the JOB's recorded
      // length. The search window no longer defaults to the visit's own days
      // (it has none) — it is today-forward like every other subject. Give
      // tech-mcp a working pattern so the window has real gaps.
      const techRow = await pg.query('select id from technicians where tenant_id = $1 and ref = $2', [tenantId, 'tech-mcp']);
      await setTechnicianAvailability(techRow.rows[0].id as string, {
        mon: [['08:00', '17:00']], tue: [['08:00', '17:00']], wed: [['08:00', '17:00']],
        thu: [['08:00', '17:00']], fri: [['08:00', '17:00']], sat: [], sun: [],
      });
      const jobId = booked.data.jobId as string;
      const noLen = await callWith('find_slots', { visitId });
      expect(noLen.isError).toBe(true); // fail-closed: no length anywhere yet
      const upd = await callWith('update_job', { jobId, durationMinutes: 120 });
      expect(upd.data.status).toBe('ok');
      // find_slots' OWN earliestDate/latestDate survive rung 9a — they are a
      // SEARCH RANGE ("look between these dates"), never a commitment.
      const slots = await callWith('find_slots', {
        visitId, earliestDate: '2026-12-14', latestDate: '2026-12-14',
      });
      expect(slots.data.status).toBe('ok');
      expect(slots.data.durationAssumption).toContain("job's recorded length");
      const cands = slots.data.candidates as Array<{ date: string; endTime: string; startTime: string }>;
      expect(cands.length).toBeGreaterThan(0);
      expect(cands.every((c) => c.date === '2026-12-14')).toBe(true);
      // …and each candidate spans the job's 120 recorded minutes.
      expect(cands[0].endTime >= '10:00').toBe(true);

    } finally {
      // Restore tech-mcp's no-pattern state — the big scheduling test below
      // asserts the "no working pattern" availability warning.
      const techRow2 = await pg.query(
        'select id from technicians where tenant_id = $1 and ref = $2',
        [tenantId, 'tech-mcp'],
      );
      if (techRow2.rows[0]) {
        // Raw restore: the typed setter requires a pattern; clearing = null.
        await pg.query('update technicians set availability = null where id = $1', [
          techRow2.rows[0].id,
        ]);
      }
      await mgrClient.close();
    }
  });

  test('assigned UNTIMED visits: reachable via the untimed list, never on a day; counts stay honest', { timeout: 30_000 }, async () => {
    const customer = await createCustomer({
      tenantId,
      name: 'TBD Wanda',
      addressLine1: '4 Fold Court',
      city: 'Clovis',
      state: 'CA',
      postalCode: '93611',
    });
    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      // An ASSIGNED time-TBD visit must appear in the WINDOWED team schedule
      // (final-review finding: the placed reader is time-filtered and the
      // recall view filters technician IS NULL, so an attached unplaced visit
      // was invisible to every chat surface — the agent denied it existed and
      // could never fetch its id to place, move, or cancel it).
      const booked = await callWith('book_visit', {
        customerId: customer.id, title: 'assigned tbd',
        technicianRef: 'tech-mcp', untimed: true });
      expect(booked.data.status).toBe('booked');
      const visitId = booked.data.visitId as string;
      // INVERTED (rung 9a): it used to land on its stored range's earliest day
      // and be re-clamped into every window that touched the range. There is
      // no range, so it lands on NO day — and rides the top-level `untimed`
      // list instead, which is what keeps it reachable.
      const full = await callWith('get_team_schedule', {
        from: '2026-12-20', to: '2026-12-24', stops: true,
      });
      const fullStops = full.data.stops as Array<Record<string, unknown>>;
      expect(fullStops.some((st) => st.visitId === visitId)).toBe(false);
      // Retrieval layer 4: the windowed page COUNTS untimed visits and the recall
      // list names them — never both lists in one result.
      expect(full.data.untimed).toBeUndefined();
      expect(full.data.counts.untimed).toBeGreaterThanOrEqual(1);
      const untimed = await recallAll(callWith, 'visits');
      expect(untimed.find((u) => u.visitId === visitId)).toMatchObject({
        technicianRef: 'tech-mcp',
        unassigned: false,
        // The customer NAME must resolve. Untimed rows come from their own
        // read, so their jobs have to be in the jobs fetch too — without that
        // the agent gets an id it cannot put a name to (review finding).
        customer: 'TBD Wanda',
      });
      // Every window says the same thing: there is no date to make it appear
      // in one window and not another.
      const outside = await callWith('get_team_schedule', {
        from: '2026-12-26', to: '2026-12-28', stops: true,
      });
      const outsideStops = outside.data.stops as Array<Record<string, unknown>>;
      expect(outsideStops.some((st) => st.visitId === visitId)).toBe(false);
      // …and the untimed count does not depend on the window either.
      expect(outside.data.counts.untimed).toBe(full.data.counts.untimed);

      // find_slots still works on an untimed subject. The "range wider than
      // the 14-day cap" clamp it needed is gone with the stored range: every
      // subject now gets the same today-forward default.
      const wide = await callWith('book_visit', {
        customerId: customer.id, title: 'whole month', untimed: true });
      const wideId = wide.data.visitId as string;
      await callWith('update_job', { jobId: wide.data.jobId, durationMinutes: 60 });
      const slots = await callWith('find_slots', { visitId: wideId });
      expect(slots.data.status).not.toBe('invalid_range');
      const searched = slots.data.searched as { days: number } | undefined;
      if (searched) expect(searched.days).toBeLessThanOrEqual(14);

      // The one-shot echo is ROW-derived: an untimed booking reports no day at
      // all rather than echoing an argument the row does not hold.
      const mixed = await callWith('book_visit', {
        customerId: customer.id, title: 'no day at all', untimed: true });
      expect(mixed.data.status).toBe('booked');
      expect(mixed.data.date).toBeNull();
      expect(mixed.data.untimed).toBe(true);

      // Server-computed counts (date-eval W13: the model hand-counted stop
      // rows and got both week totals wrong). Only timed stops are in `days`
      // at all now, so byDay/total need no exclusion rule — untimed work is
      // counted once, separately, by counts.untimed.
      const timedA = await callWith('book_visit', {
        customerId: customer.id, title: 'count me', technicianRef: 'tech-mcp',
        date: '2026-12-21', startTime: '09:00', endTime: '10:00',
      });
      expect(timedA.data.status).toBe('booked');
      const timedB = await callWith('book_visit', {
        customerId: customer.id, title: 'count me too', technicianRef: 'tech-mcp',
        date: '2026-12-22', startTime: '11:00', endTime: '12:00',
      });
      expect(timedB.data.status).toBe('booked');
      const counted = await callWith('get_team_schedule', {
        from: '2026-12-20', to: '2026-12-24',
      });
      const counts = counted.data.counts as {
        byDay: Record<string, number>;
        total: number;
        untimed: number;
      };
      // The counts page names no customers: stops come only when asked.
      expect(counted.data.stops).toBeUndefined();
      expect(counts.byDay['2026-12-21']).toBe(1);
      expect(counts.byDay['2026-12-22']).toBe(1);
      expect(counts.total).toBe(2);
      expect(counts.untimed).toBeGreaterThanOrEqual(1); // 'assigned tbd' above
      // Zero-days are DATA: every requested day appears, so "which days are
      // empty" is a read, not an inference from absence — in `days` too.
      expect(counts.byDay['2026-12-24']).toBe(0);
      expect(
        (counted.data.days as Array<{ date: string; visits: number }>).map((d) => [d.date, d.visits]),
      ).toEqual([
        ['2026-12-20', 0],
        ['2026-12-21', 1],
        ['2026-12-22', 1],
        ['2026-12-23', 0],
        ['2026-12-24', 0],
      ]);
      expect(counted.data.days[1].byTechnician).toEqual({ 'tech-mcp': 1 });
      expect((counts as Record<string, unknown>).windowCoverByDay).toBeUndefined();
      // Counts cover the REQUESTED range only.
      const total = Object.values(counts.byDay).reduce((a, b) => a + b, 0);
      expect(total).toBe(counts.total);
      for (const d of Object.keys(counts.byDay)) {
        expect(d >= '2026-12-20' && d <= '2026-12-24').toBe(true);
      }

      // GROUNDING_LEAN=1 (date-eval Arm B, 2026-08-23): the derived crutches
      // disappear — upcomingVisits/openWorkNote off get_customer_context — while
      // the DATA stays. get_team_schedule's counts STAY under the flag since
      // retrieval layer 4: they are the page itself, not a crutch beside a dump.
      const fullCtx = await callWith('get_customer_context', { customerId: customer.id });
      expect(fullCtx.data.upcomingVisits).toBeDefined();
      process.env.GROUNDING_LEAN = '1';
      try {
        const leanSched = await callWith('get_team_schedule', {
          from: '2026-12-20',
          to: '2026-12-24',
        });
        expect(leanSched.data.status).toBe('ok');
        expect(leanSched.data.counts.total).toBe(2);
        expect(Array.isArray(leanSched.data.days)).toBe(true);
        const leanCtx = await callWith('get_customer_context', { customerId: customer.id });
        expect(leanCtx.data.upcomingVisits).toBeUndefined();
        expect(leanCtx.data.openWorkNote).toBeUndefined();
        expect(Array.isArray(leanCtx.data.jobs)).toBe(true);
      } finally {
        delete process.env.GROUNDING_LEAN;
      }

      // EVAL_FAKE_NOW also pins the no-args default range (an anchored eval
      // question like "what's on the schedule?" must open at the ANCHOR's
      // today, not the wall clock's).
      process.env.EVAL_FAKE_NOW = `${tenantId}:2027-03-04T02:30:00.000Z`;
      try {
        const anchoredSched = await callWith('get_team_schedule', {});
        expect(anchoredSched.data.status).toBe('ok');
        expect(anchoredSched.data.from).toBe('2027-03-03');
      } finally {
        delete process.env.EVAL_FAKE_NOW;
      }
    } finally {
      await mgrClient.close();
    }
  });

  test('technician badge is denied all four tools', async () => {
    for (const name of ['get_team_schedule', 'book_visit', 'move_visit', 'unschedule_visit']) {
      const denied = await call(name, {});
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('manager badge');
    }
  });

  test('book → team view → move → cancel: one-shot writes, staged cancel, version bumps and token guards', async () => {
    const customer = await createCustomer({
      tenantId,
      name: 'Sched Henderson',
      addressLine1: '40 Elm Ave',
      city: 'Clovis',
      state: 'CA',
      postalCode: '93611',
    });
    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      // BOOK: one call, full echo, availability warning (tech-mcp has no
      // working pattern configured). Rung 9a removed the staging entirely.
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        title: 'water heater swap',
        date: '2026-12-01',
        startTime: '09:00',
        endTime: '12:00',
      });
      expect(booked.data.status).toBe('booked');
      expect(booked.data).toMatchObject({
        customer: 'Sched Henderson',
        technicianRef: 'tech-mcp',
        jobTitle: 'water heater swap',
        date: '2026-12-01',
        startTime: '09:00',
        endTime: '12:00',
      });
      expect(booked.data.warning).toContain('no working pattern');
      const visitId = booked.data.visitId as string;

      // Team view: the manager sees ANOTHER technician's stop, with a
      // scheduleVersion.
      const team = await callWith('get_team_schedule', { from: '2026-12-01', to: '2026-12-01', stops: true });
      expect(team.data.status).toBe('ok');
      const v1 = team.data.scheduleVersion as number;
      expect(v1).toBeGreaterThan(0);
      const stops = team.data.stops as Array<Record<string, unknown>>;
      const stop = stops.find((s) => s.visitId === visitId);
      expect(stop).toMatchObject({
        technicianRef: 'tech-mcp',
        customer: 'Sched Henderson',
        // Wall-clock HH:MM slices only. The raw timestamptz must never reach
        // the agent: its '+00:00' marker lies under the naive-local convention
        // (live 2026-07-22: the agent fabricated a UTC→Pacific conversion for
        // a 4 PM visit from exactly these fields).
        startTime: '09:00',
        endTime: '12:00',
      });
      expect(stop).not.toHaveProperty('start');
      expect(stop).not.toHaveProperty('end');
      // Server-computed weekday on every emitted date (the find_slots lesson).
      expect(team.data.days[0].weekday).toBe('Tue');
      expect(stop?.weekday).toBe('Tue');
      expect(stop?.date).toBe('2026-12-01');
      expect(stop?.address).toContain('40 Elm Ave');

      // MOVE to another day: one call, no gate (rung 9a).
      const moved = await callWith('move_visit', {
        visitId,
        date: '2026-12-02',
        startTime: '13:00',
        reason: 'customer asked for Wednesday',
      });
      expect(moved.data.status).toBe('moved');
      const movedId = moved.data.visitId as string;
      // THE HEADLINE INVERSION of rung 9b. This asserted `not.toBe` — a move
      // used to cancel the row and mint a successor, so the id the manager (or
      // a gap, or a note, or a board link) was holding died on every move. A
      // visit is ONE object now, and its id outlives its schedule.
      expect(movedId).toBe(visitId);
      expect(moved.data.stage).toBe('placed');

      // Version advanced (booked + moved events).
      const after = await callWith('get_team_schedule', { from: '2026-12-02', to: '2026-12-02' });
      expect(after.data.scheduleVersion).toBeGreaterThan(v1);

      // A staged unschedule, and a forged confirmId against it. (It used to be
      // cancelled through resolve_review here too; that tool was retired on
      // 2026-09-19, and the restage below supersedes the open token instead.)
      const cancelStage = await callWith('unschedule_visit', {
        visitId: movedId,
        reason: 'testing the refusal',
      });
      expect(cancelStage.data.status).toBe('needs_confirmation');
      // Forged confirmId → not found. (These guards used to ride the booking
      // token; unschedule_visit is the verb that still stages.)
      const forged = await callWith('unschedule_visit', { confirmId: customer.id });
      expect(forged.isError).toBe(true);
      expect(forged.text).toContain('confirmation not found');

      // CANCEL for real: restage (fresh preview) then confirm.
      const cancelStage2 = await callWith('unschedule_visit', {
        visitId: movedId,
        reason: 'customer cancelled',
      });
      expect(cancelStage2.data.preview).toMatchObject({ customerName: 'Sched Henderson' });
      const cancelled = await callWith('unschedule_visit', { confirmId: cancelStage2.data.confirmId });
      // Vocabulary (2026-07-25): the wire status says what the tool DID — the
      // visit is unscheduled; "cancelled" is reserved for the terminal verb.
      expect(cancelled.data.status).toBe('unscheduled');
      expect(cancelled.data.note).toContain('loose bucket');
      // The unscheduled visit no longer appears on the board.
      const gone = await callWith('get_team_schedule', { from: '2026-12-02', to: '2026-12-02', stops: true });
      expect((gone.data.stops as Array<{ visitId: string }>).map((s) => s.visitId)).not.toContain(movedId);
    } finally {
      await mgrClient.close();
    }
  });

  test('book/move are ONE-SHOT; unscheduling a PLACED visit is the one surviving gate (rung 9a)', async () => {
    // The pilot bug this fixes: reversible internal changes dragged the manager
    // through a confirmation they didn't need. Rung 9a finished the job — no
    // promise level gates anything, so book and move never stage at all.
    const customer = await createCustomer({ tenantId, name: 'Unpromised Uma' });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // ONE call books it — book_visit never stages.
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-15',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(booked.data.status).toBe('booked');
      expect(booked.data.note).toContain('one step');
      // 4b-1 (final-review finding): the minted shell RECORDS the booked span
      // as the job's length — a silently-stored value unless echoed here, the
      // same rule that put jobTitle on this result (live E2E 2026-07-21).
      expect(booked.data.jobDurationMinutes).toBe(60);
      const id = booked.data.visitId as string;

      const team = await callWith('get_team_schedule', { from: '2026-12-15', to: '2026-12-15', stops: true });
      const stop = (team.data.stops as Array<Record<string, unknown>>).find(
        (s) => s.visitId === id,
      );
      expect(stop).toBeDefined();

      // No default times (user decision 2026-07-18): an omitted endTime is
      // REFUSED with an ask-the-manager error — the server invents nothing.
      const missingEnd = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-17',
        startTime: '09:00',
      });
      expect(missingEnd.isError).toBe(true);
      expect(missingEnd.text).toContain('startTime and endTime are required');
      expect(missingEnd.text).toContain('ASK them');

      // RUNG 10B.2 — UNTIMED IS SOMETHING YOU SAY, NOT SOMETHING YOU OMIT.
      // Live specimen 2026-09-08: the manager said "Thursday morning", the seat
      // booked untimed, and its own reply named Thursday in the next breath. An
      // omission and a decision used to be the same call.
      const bare = await callWith('book_visit', {
        customerId: customer.id,
        title: 'no day, and nobody said so',
      });
      expect(bare.isError).toBe(true);
      expect(bare.text).toContain('required TOGETHER');
      expect(bare.text).toContain('untimed: true');
      // …and the contradiction fails LOUDLY rather than silently preferring one.
      const both = await callWith('book_visit', {
        customerId: customer.id,
        title: 'two intentions in one call',
        untimed: true,
        date: '2026-12-18',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(both.isError).toBe(true);
      expect(both.text).toContain('untimed:true means NO day');
      // A non-boolean is an agent error, not a falsy "no" (the str() idiom).
      const bogus = await callWith('book_visit', {
        customerId: customer.id,
        title: 'stringly typed',
        untimed: 'yes',
      });
      expect(bogus.isError).toBe(true);
      expect(bogus.text).toContain('untimed must be true or false');
      // Said out loud, it still books — the escape hatch is intact.
      const said = await callWith('book_visit', {
        customerId: customer.id,
        title: 'genuinely not settled',
        untimed: true,
      });
      expect(said.data.status).toBe('booked');
      expect(said.data.untimed).toBe(true);
      expect(said.data.date).toBeNull();

      // Moving it is one-shot too, whatever the customer was told — the agent
      // is expected to have READ the job's record for promises first.
      const moved = await callWith('move_visit', {
        visitId: id,
        date: '2026-12-16',
        startTime: '09:00',
        reason: 'internal reshuffle',
      });
      expect(moved.data.status).toBe('moved');
      expect(moved.data.note).toContain('one step');

      // INVERTED (rung 9a): the visit is PLACED, so a customer is expecting it
      // — unscheduling now stages and asks, where it used to be one-shot.
      const cancelStage = await callWith('unschedule_visit', {
        visitId: moved.data.visitId,
        reason: 'not needed',
      });
      expect(cancelStage.data.status).toBe('needs_confirmation');
      const cancelled = await callWith('unschedule_visit', { confirmId: cancelStage.data.confirmId });
      // The result must still say the WORK survives (job → loose bucket).
      expect(cancelled.data.status).toBe('unscheduled');
      expect(cancelled.data.note).toContain('loose bucket');

      // …and an UNTIMED visit is nobody's appointment yet, so it drops in one
      // call — the other side of the same gate.
      const unplaced = await callWith('book_visit', {
        customerId: customer.id,
        title: 'nothing promised, no time', untimed: true });
      expect(unplaced.data.status).toBe('booked');
      const dropped = await callWith('unschedule_visit', {
        visitId: unplaced.data.visitId,
        reason: 'never needed',
      });
      expect(dropped.data.status).toBe('unscheduled');
      expect(dropped.data.note).toContain('one step');
    } finally {
      await mgrClient.close();
    }
  });

  test('an expired staged confirmation is dismissed with a clean restage error', async () => {
    const customer = await createCustomer({ tenantId, name: 'Expiry Ed' });
    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      // unschedule_visit on a PLACED visit is the verb that still stages
      // (rung 9a) — book_visit is one-shot and mints no token to expire.
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-08',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(booked.data.status).toBe('booked');
      const staged = await callWith('unschedule_visit', {
        visitId: booked.data.visitId,
        reason: 'customer went quiet',
      });
      expect(staged.data.status).toBe('needs_confirmation');
      // Age the token past the 15-minute window.
      await pg.query(
        `update review_items set detail = detail || jsonb_build_object('stagedAt', $1::text) where id = $2`,
        [new Date(Date.now() - 20 * 60_000).toISOString(), staged.data.confirmId],
      );
      const expired = await callWith('unschedule_visit', { confirmId: staged.data.confirmId });
      expect(expired.isError).toBe(true);
      expect(expired.text).toContain('confirmation expired');
    } finally {
      await mgrClient.close();
    }
  });

  test('a staged unschedule is REFUSED when the visit moved before the yes', async () => {
    // Moves keep the visit id (rung 9b), and the confirm used to cancel by id
    // alone: the manager approved cancelling Wednesday 09:00 and lost Thursday
    // 13:00. The staged time is the thing approved, so it is checked at the yes.
    const moving = await createCustomer({ tenantId, name: 'Moving Mo' });
    const steady = await createCustomer({ tenantId, name: 'Steady Sal' });
    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const booked = await callWith('book_visit', {
        customerId: moving.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-09',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(booked.data.status).toBe('booked');
      const visitId = booked.data.visitId as string;
      const staged = await callWith('unschedule_visit', { visitId, reason: 'customer cancelled' });
      expect(staged.data.status).toBe('needs_confirmation');
      // detail.expected is what the confirm compares against. It stays WALL-CLOCK
      // text because that is the rule for anything a model may read
      // (list_pending_reviews showed it until 2026-09-19), and a raw '+00:00'
      // there was the 2026-07-22 defect.
      const snap = await pg.query<{ expected: unknown }>(
        `select detail->'expected' as expected from review_items where id = $1`,
        [staged.data.confirmId],
      );
      expect(snap.rows[0].expected).toEqual({ startsAt: '2026-12-09 09:00', endsAt: '2026-12-09 10:00' });
      const moved = await callWith('move_visit', {
        visitId,
        date: '2026-12-10',
        startTime: '13:00',
        reason: 'customer asked for Thursday',
      });
      expect(moved.data.status).toBe('moved');

      const refused = await callWith('unschedule_visit', { confirmId: staged.data.confirmId });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('moved');
      const row = await pg.query<{ status: string; starts_at: Date }>(
        'select status, starts_at from visits where id = $1',
        [visitId],
      );
      expect(row.rows[0].status).toBe('confirmed');
      expect(row.rows[0].starts_at.toISOString().slice(0, 10)).toBe('2026-12-10');

      // With no move in between, the same flow still cancels.
      const steadyBooked = await callWith('book_visit', {
        customerId: steady.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-11',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(steadyBooked.data.status).toBe('booked');
      const steadyStaged = await callWith('unschedule_visit', {
        visitId: steadyBooked.data.visitId,
        reason: 'customer cancelled',
      });
      const done = await callWith('unschedule_visit', { confirmId: steadyStaged.data.confirmId });
      expect(done.isError).toBe(false);
      expect(done.data.status).toBe('unscheduled');
    } finally {
      await mgrClient.close();
    }
  });

  test('an impossible booking is refused on the call (unknown tech, overlap)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Impossible Iva' });
    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const unknown = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'ghost-tech',
        date: '2026-12-09',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain("'ghost-tech' not found");

      // Lands in one call under the one-shot doctrine.
      const first = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-09',
        startTime: '09:00',
        endTime: '11:00',
      });
      expect(first.data.status).toBe('booked');
      const clash = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-09',
        startTime: '10:00',
        endTime: '12:00',
        forceNewJob: true, // bypass the mint guard so the OVERLAP refusal is reached
      });
      expect(clash.isError).toBe(true);
      expect(clash.text).toContain('already has a confirmed visit overlapping');
    } finally {
      await mgrClient.close();
    }
  });

  test('unassigned booking: no technicianRef → person-less, board flags it, one-shot move attaches', async () => {
    const customer = await createCustomer({ tenantId, name: 'Assign Later Al' });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // Unassigned: the one-shot result must echo a person-less booking
      // (null technician fields), same contract the stage used to carry.
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        date: '2027-01-05',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(booked.data.status).toBe('booked');
      expect(booked.data.unassigned).toBe(true);
      expect(booked.data.technicianRef).toBeNull();
      const id = booked.data.visitId as string;

      // The board window covering the day flags it person-less.
      const team = await callWith('get_team_schedule', { from: '2027-01-05', to: '2027-01-05', stops: true });
      const stop = (team.data.stops as Array<Record<string, unknown>>).find(
        (s) => s.visitId === id,
      );
      expect(stop).toMatchObject({ unassigned: true, technicianRef: null, technicianName: null });

      // Attaching a person same day/time → ONE-SHOT move.
      const moved = await callWith('move_visit', {
        visitId: id,
        date: '2027-01-05',
        startTime: '09:00',
        technicianRef: 'tech-mcp',
        reason: 'assigning tech',
      });
      expect(moved.data.status).toBe('moved');
      const after = await callWith('get_team_schedule', { from: '2027-01-05', to: '2027-01-05', stops: true });
      const attached = (after.data.stops as Array<Record<string, unknown>>).find(
        (s) => s.visitId === moved.data.visitId,
      );
      expect(attached).toMatchObject({ unassigned: false, technicianRef: 'tech-mcp' });
    } finally {
      await mgrClient.close();
    }
  });

  test('unassignedOnly recall view: far-out person-less visits found; normal cap unchanged', async () => {
    const customer = await createCustomer({ tenantId, name: 'Recall Roy' });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // Park an unassigned visit far beyond any board window (the finding the
      // lister fixes: nothing else can surface this row). Unpromised → one-shot.
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        date: '2027-02-10',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(booked.data.status).toBe('booked');
      const farId = booked.data.visitId as string;
      // An ASSIGNED far-out visit — must never appear in the recall view.
      const aBooked = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2027-02-11',
        startTime: '09:00',
        endTime: '10:00',
        forceNewJob: true, // titleless repeat on one customer — mint guard bypass
      });
      expect(aBooked.data.status).toBe('booked');

      // Default board read (today) does NOT show the far-out visit…
      const today = await callWith('get_team_schedule', { stops: true });
      const todaysIds = (today.data.stops as Array<{ visitId: string }>).map((s) => s.visitId);
      expect(todaysIds).not.toContain(farId);
      // …and a >14-day range without the flag still errors (cap unchanged).
      const capped = await callWith('get_team_schedule', { from: '2027-01-01', to: '2027-03-01' });
      expect(capped.data.status).toBe('invalid_range');

      // The recall view finds it, however far out, with the full stop shape.
      const recall = await callWith('get_team_schedule', { unassignedOnly: true });
      expect(recall.data.status).toBe('ok');
      expect(recall.data.unassignedOnly).toBe(true);
      expect(recall.data.scheduleVersion).toBeGreaterThan(0);
      expect(recall.data.counts.parkedVisits).toBeGreaterThanOrEqual(1);
      const recallStops = await recallAll(callWith, 'visits');
      const farStop = recallStops.find((s) => s.visitId === farId);
      expect(farStop).toMatchObject({
        unassigned: true,
        customer: 'Recall Roy',
        date: '2027-02-10',
        startTime: '09:00',
        jobId: booked.data.jobId,
      });
      // Assigned visits never appear here.
      expect(recallStops.map((s) => s.visitId)).not.toContain(aBooked.data.visitId);

      // Plan 4a agent parity: the recall view also carries the bucket's other
      // half — open jobs with NO visit at all — plus the explaining note.
      const bareJob = await createJob({
        tenantId,
        customerId: customer.id,
        title: 'Recall bare job',
        priority: 'urgent',
      });
      const recall2 = await callWith('get_team_schedule', { unassignedOnly: true });
      const jobs = await recallAll(callWith, 'jobs');
      const bare = jobs.find((j) => j.jobId === bareJob.id);
      expect(bare).toMatchObject({
        title: 'Recall bare job',
        customer: 'Recall Roy',
        priority: 'urgent',
      });
      // Jobs with a live visit (the far-out booking's job) stay OUT.
      expect(jobs.map((j) => j.jobId)).not.toContain(booked.data.jobId);
      expect(recall2.data.note).toContain('jobs are open jobs with NO visit');
      // The windowed mode COUNTS the jobs half and never lists it.
      const windowed = await callWith('get_team_schedule', {});
      expect(windowed.data.jobs).toBeUndefined();
      expect(windowed.data.counts.unscheduledJobs).toBe(recall2.data.counts.unscheduledJobs);

      // Garbage flag type is rejected.
      const bad = await callWith('get_team_schedule', { unassignedOnly: 'yes' });
      expect(bad.data.status).toBe('invalid_range');
    } finally {
      await mgrClient.close();
    }
  });

  test('the counts page: stops page by 25, crews found by any member, completed counted, overdue recall, value cursors (retrieval layer 4)', { timeout: 60_000 }, async () => {
    const customer = await createCustomer({ tenantId, name: 'Paging Pam' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'paging work' });
    // Schedule-only people: they take no seat, so the file's seat-capped tests
    // below are unaffected.
    const first = await insertTechnician({ tenantId, ref: 'page-a', displayName: 'Page A', seatExempt: true });
    const second = await insertTechnician({ tenantId, ref: 'page-b', displayName: 'Page B', seatExempt: true });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // 30 person-less trips on one day (nobody on them, so no overlap guard).
      const day = '2027-04-06';
      const tripIds: string[] = [];
      for (let i = 0; i < 30; i++) {
        const hh = String(6 + Math.floor(i / 2)).padStart(2, '0');
        const mm = i % 2 === 0 ? '00' : '30';
        const v = await createVisit({
          tenantId,
          jobId: job.id,
          startsAt: nl(`${day}T${hh}:${mm}:00Z`),
          endsAt: nl(`${day}T${hh}:${mm === '00' ? '20' : '50'}:00Z`),
          status: 'confirmed',
        });
        tripIds.push(v.id);
      }
      // A crew trip where page-b is the SECOND member, and a completed one.
      const crew = await createVisit({
        tenantId,
        jobId: job.id,
        technicianIds: [first.id, second.id],
        startsAt: nl(`${day}T21:00:00Z`),
        endsAt: nl(`${day}T22:00:00Z`),
        status: 'confirmed',
      });
      await createVisit({
        tenantId,
        jobId: job.id,
        startsAt: nl(`${day}T23:00:00Z`),
        endsAt: nl(`${day}T23:30:00Z`),
        status: 'completed',
      });

      const counted = await callWith('get_team_schedule', { from: day, to: day });
      expect(counted.data.stops).toBeUndefined();
      expect(counted.data.days[0]).toMatchObject({ visits: 32, completed: 1, unassigned: 31 });
      expect(counted.data.days[0].byTechnician).toMatchObject({ 'page-a': 1, 'page-b': 1 });

      const p1 = await callWith('get_team_schedule', { from: day, to: day, stops: true });
      expect(p1.data.stops).toHaveLength(25);
      expect(p1.data.hasMore).toBe(true);
      const p2 = await callWith('get_team_schedule', { from: day, to: day, stops: true, after: p1.data.next });
      expect(p2.data.stops).toHaveLength(7);
      expect(p2.data.hasMore).toBe(false);
      const ids = [...p1.data.stops, ...p2.data.stops].map((s: { visitId: string }) => s.visitId);
      expect(new Set(ids).size).toBe(32);
      const done = p2.data.stops.find((s: { status: string }) => s.status === 'completed');
      expect(done).toMatchObject({ stage: 'happened', startTime: '23:00' });

      // A crew trip is found by EITHER member — never just the first lane. The
      // two were added in one statement, so which is FIRST is the id tiebreak:
      // read the order, then search by whoever is second.
      const byA = await callWith('get_team_schedule', { from: day, to: day, stops: true, technicianRef: 'page-a' });
      // The counts stay the whole team's even when the stop list is one person's,
      // and the note says which number answers "how many does X have".
      expect(byA.data.counts.total).toBe(32);
      expect(byA.data.days[0].byTechnician['page-a']).toBe(1);
      expect(byA.data.countsNote).toContain("byTechnician['page-a']");
      expect(byA.data.stops.map((s: { visitId: string }) => s.visitId)).toEqual([crew.id]);
      const crewRefs = byA.data.stops[0].technicianRefs as string[];
      expect([...crewRefs].sort()).toEqual(['page-a', 'page-b']);
      const bySecond = await callWith('get_team_schedule', { from: day, to: day, stops: true, technicianRef: crewRefs[1] });
      expect(bySecond.data.stops.map((s: { visitId: string }) => s.visitId)).toEqual([crew.id]);
      expect(bySecond.data.stops[0].technicianRef).toBe(crewRefs[0]);
      const recallFiltered = await callWith('get_team_schedule', { unassignedOnly: true, technicianRef: 'page-a' });
      expect(recallFiltered.data.status).toBe('invalid_range');
      const unknown = await callWith('get_team_schedule', { from: day, to: day, stops: true, technicianRef: 'nobody-here' });
      expect(unknown.data.status).toBe('invalid_range');
      expect(unknown.data.note).toContain('list_team');
      const garbage = await callWith('get_team_schedule', { from: day, to: day, stops: true, after: 'page two' });
      expect(garbage.data.status).toBe('invalid_range');

      // An overdue parked visit is in the recall list, flagged (the old recall
      // view floored at today and lost it).
      const overdue = await createVisit({
        tenantId,
        jobId: job.id,
        startsAt: nl('2026-01-05T09:00:00Z'),
        endsAt: nl('2026-01-05T10:00:00Z'),
        status: 'confirmed',
      });
      const recalled = await recallAll(callWith, 'visits');
      expect(recalled.find((v) => v.visitId === overdue.id)).toMatchObject({ overdue: true, unassigned: true });

      // Value cursors: the row a cursor names can leave the queue (the manager
      // just dealt with it) and the next page still starts right after it.
      const q1 = await callWith('get_team_schedule', { unassignedOnly: true, queue: 'visits' });
      expect(q1.data.visits).toHaveLength(25);
      expect(q1.data.jobs).toBeUndefined();
      const cursorRow = q1.data.visits[24] as { visitId: string };
      const expectedNext = await callWith('get_team_schedule', { unassignedOnly: true, queue: 'visits', after: q1.data.visitsNext });
      await pg.query(`update visits set status = 'cancelled' where id = $1`, [cursorRow.visitId]);
      const q2 = await callWith('get_team_schedule', { unassignedOnly: true, queue: 'visits', after: q1.data.visitsNext });
      expect(q2.data.visits.map((v: { visitId: string }) => v.visitId)).toEqual(
        expectedNext.data.visits.map((v: { visitId: string }) => v.visitId),
      );
      const firstIds = new Set(q1.data.visits.map((v: { visitId: string }) => v.visitId));
      expect(q2.data.visits.some((v: { visitId: string }) => firstIds.has(v.visitId))).toBe(false);
      const noQueue = await callWith('get_team_schedule', { unassignedOnly: true, after: q1.data.visitsNext });
      expect(noQueue.data.status).toBe('invalid_range');
    } finally {
      await mgrClient.close();
      // Leave the shared tenant's schedule and roster as the later tests expect.
      await pg.query(`update visits set status = 'cancelled' where job_id = $1`, [job.id]);
      await pg.query('delete from visit_participants where technician_id = any($1::uuid[])', [[first.id, second.id]]);
      await pg.query('delete from technicians where id = any($1::uuid[])', [[first.id, second.id]]);
    }
  });

  test('a busy fortnight stays a small page without stops (retrieval layer 4)', { timeout: 60_000 }, async () => {
    // The operator's rule the counts page exists for: a schedule read never dumps
    // into the seat's window. 10 people × 5 trips a day × 14 days = 700 visits.
    const customer = await createCustomer({ tenantId, name: 'Busy Bella' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'busy fortnight' });
    const techs: string[] = [];
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      for (let t = 0; t < 10; t++) {
        const tech = await insertTechnician({ tenantId, ref: `busy-${t}`, displayName: `Busy ${t}`, seatExempt: true });
        techs.push(tech.id);
        const { rows } = await pg.query<{ id: string }>(
          `insert into visits (tenant_id, job_id, starts_at, ends_at, status)
           select $1, $2,
                  timestamptz '2028-01-03 07:00+00' + (d || ' days')::interval + ((h * 2) || ' hours')::interval,
                  timestamptz '2028-01-03 08:00+00' + (d || ' days')::interval + ((h * 2) || ' hours')::interval,
                  'confirmed'
             from generate_series(0, 13) as d, generate_series(0, 4) as h
           returning id`,
          [tenantId, job.id],
        );
        await pg.query(
          `insert into visit_participants (tenant_id, visit_id, technician_id)
           select $1, v, $2 from unnest($3::uuid[]) as v`,
          [tenantId, tech.id, rows.map((r) => r.id)],
        );
      }
      const page = await callWith('get_team_schedule', { from: '2028-01-03', to: '2028-01-16' });
      expect(page.data.counts.total).toBe(700);
      expect(page.data.days[0].byTechnician['busy-0']).toBe(5);
      expect(page.text.length).toBeLessThan(8000);
    } finally {
      await mgrClient.close();
      await pg.query(`update visits set status = 'cancelled' where job_id = $1`, [job.id]);
      await pg.query('delete from visit_participants where technician_id = any($1::uuid[])', [techs]);
      await pg.query('delete from technicians where id = any($1::uuid[])', [techs]);
    }
  });

  test('a crew books and moves as ONE visit (rung 9c)', { timeout: 30_000 }, async () => {
    const customer = await createCustomer({ tenantId, name: 'Crew Carla' });
    const second = await insertTechnician({
      tenantId,
      ref: 'crew-two',
      displayName: 'Crew Two',
    });
    await setTechnicianState(second.id, 'active');
    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        title: 'two-person lift',
        technicianRefs: ['tech-mcp', 'crew-two'],
        date: '2026-12-18',
        startTime: '09:00',
        endTime: '11:00',
      });
      expect(booked.data.status).toBe('booked');
      expect(booked.data.technicianRefs).toEqual(['tech-mcp', 'crew-two']);
      // The steer that stops the agent reporting it as two jobs.
      expect(booked.data.crewNote).toContain('2 people are on this visit');
      expect(booked.data.unassigned).toBe(false);
      // ONE visit row, two participants.
      const { rows } = await pg.query(
        'select count(*)::int as n from visit_participants where visit_id = $1',
        [booked.data.visitId],
      );
      expect(rows[0].n).toBe(2);

      // A move REPLACES the crew.
      const moved = await callWith('move_visit', {
        visitId: booked.data.visitId,
        date: '2026-12-18',
        startTime: '14:00',
        technicianRefs: ['crew-two'],
        reason: 'tech-mcp is needed elsewhere',
      });
      expect(moved.data.status).toBe('moved');
      expect(moved.data.technicianRefs).toEqual(['crew-two']);
      expect(moved.data.crewNote).toBeUndefined(); // one person again

      // The shorthand still works alone, and says nothing about a crew.
      const solo = await callWith('book_visit', {
        customerId: customer.id,
        title: 'one-person call',
        forceNewJob: true,
        technicianRef: 'tech-mcp',
        date: '2026-12-19',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(solo.data.technicianRefs).toEqual(['tech-mcp']);
      expect(solo.data.crewNote).toBeUndefined();

      // A present-but-empty list is an agent bug, not "book unassigned".
      const empty = await callWith('book_visit', {
        customerId: customer.id,
        title: 'empty crew',
        forceNewJob: true,
        technicianRefs: [],
        date: '2026-12-20',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(empty.isError).toBe(true);
      expect(empty.text).toContain('technicianRefs was empty');

      // And so is a list with a non-string in it.
      const junk = await callWith('book_visit', {
        customerId: customer.id,
        title: 'junk crew',
        forceNewJob: true,
        technicianRefs: ['tech-mcp', 7],
        date: '2026-12-20',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(junk.isError).toBe(true);
      expect(junk.text).toContain('array of roster refs');

      // unassign and a crew together is a contradiction.
      const both = await callWith('move_visit', {
        visitId: booked.data.visitId,
        date: '2026-12-18',
        startTime: '14:00',
        technicianRefs: ['crew-two'],
        unassign: true,
        reason: 'contradiction',
      });
      expect(both.isError).toBe(true);
      expect(both.text).toContain('not both');
    } finally {
      await mgrClient.close();
    }
  });

});

describe('schedule-input verbs (Plan 3a)', () => {
  const PATTERN_MON_FRI = {
    mon: [['08:00', '17:00']],
    tue: [['08:00', '17:00']],
    wed: [['08:00', '17:00']],
    thu: [['08:00', '17:00']],
    fri: [['08:00', '17:00']],
    sat: [],
    sun: [],
  };

  test('technician badge is denied all five tools', async () => {
    for (const name of [
      'set_availability',
      'add_time_off',
      'remove_time_off',
      'set_job_duration',
      'set_technician_skills',
    ]) {
      const denied = await call(name, {});
      expect(denied.isError).toBe(true);
      expect(denied.text).toContain('manager badge');
    }
  });

  test('query_spine\'s description carries the resolve_date rule', async () => {
    // Load-bearing text, not decoration. On the first live turn (2026-08-06) the
    // agent wrote local_day >= '2026-07-07' with no resolve_date call — correct
    // by luck, and structurally the same failure as the tool-search skip: a new
    // surface silently bypassing a doctrine rule the rule never anticipated.
    // Harmless for a count; the same shape on "what's booked next week" is the
    // 2026-07-25 week-boundary incident, which missed a real visit.
    const { client } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const listed = await client.listTools();
      const spine = listed.tools.find((t) => t.name === 'query_spine');
      expect(spine).toBeDefined();
      expect(spine?.description).toContain('resolve_date FIRST');
      expect(spine?.description).toContain('NEVER write a date into the SQL');
      // The weekday half of the same rule — added after the agent invented
      // "Monday the 4th" for a Tuesday on 2026-08-06.
      expect(spine?.description).toContain('local_weekday');
      expect(spine?.description).toContain('never work out which day of the week');
    } finally {
      await client.close();
    }
  });

  test('query_spine answers an ad-hoc read, refuses writes, and flags truncation', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // The point of the tool: a question no purpose-built tool answers.
      const counts = await callWith('query_spine', {
        sql: 'select tier, count(*) as n from v_team group by 1 order by 1',
      });
      expect(counts.isError).toBe(false);
      expect(Array.isArray(counts.data.rows)).toBe(true);

      // Writes are refused, and the DB's own message is relayed so the agent
      // learns what it may not do rather than retrying the same shape.
      const write = await callWith('query_spine', {
        sql: "with i as (insert into customers (tenant_id,name) values (gen_random_uuid(),'x') returning 1) select * from i",
      });
      expect(write.isError).toBe(true);
      expect(write.text).toContain('query_spine rejected that query');

      // A base table is invisible; only the spine views exist to this role.
      const base = await callWith('query_spine', { sql: 'select * from customers' });
      expect(base.isError).toBe(true);
      expect(base.text).toMatch(/permission denied/i);

      // Truncation is REPORTED, never silent — a capped list presented as
      // complete is the failure mode that makes a wrong answer look right.
      const capped = await callWith('query_spine', {
        sql: 'select * from generate_series(1, 50) as n',
        maxRows: 3,
      });
      expect(capped.isError).toBe(false);
      expect(capped.data.truncated).toBe(true);
      expect(capped.data.rowCount).toBe(3);
      expect(capped.data.note).toContain('CAPPED');

      // Every call is audited, including the failures.
      const audit = await pg.query(
        'select count(*)::int as n from query_audit where tenant_id = $1',
        [tenantId],
      );
      expect(audit.rows[0].n).toBeGreaterThanOrEqual(4);
    } finally {
      await mgrClient.close();
      await pg.query('delete from query_audit where tenant_id = $1', [tenantId]);
    }
  });

  test('get_availability reads back the pattern set_availability writes, and stays tenant-scoped', { timeout: 30_000 }, async () => {
    // The gap this closes: until 2026-08-04 the pattern was write-only —
    // list_team exposed only `availabilityConfigured` (a boolean), so a manager
    // could learn a pattern EXISTS and never what it was.
    const configured = await insertTechnician({
      tenantId,
      ref: 'avail-set',
      displayName: 'Avail Set',
      seatExempt: true,
    });
    await setTechnicianAvailability(configured.id, PATTERN_MON_FRI as never);
    await insertTechnician({
      tenantId,
      ref: 'avail-unset',
      displayName: 'Avail Unset',
      seatExempt: true,
    });

    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // One person by ref: the summary line is the deliverable — it is what the
      // agent is told to relay verbatim.
      const one = await callWith('get_availability', { ref: 'avail-set' });
      expect(one.isError).toBe(false);
      expect(one.data.people).toHaveLength(1);
      expect(one.data.people[0].summary).toBe('Mon–Fri 08:00–17:00; Sat, Sun off');
      expect(one.data.people[0].configured).toBe(true);
      expect(one.data.people[0].pattern).toEqual(PATTERN_MON_FRI);
      // The free/busy disclaimer is FUSED into the result, not left to the
      // description — a configured pattern reads as "free" otherwise.
      expect(one.data.note).toContain('find_slots');

      // Never-configured is a normal pre-setup state, NOT an error: reporting it
      // as an error would hide the person; reporting them as free would double-book.
      const unset = await callWith('get_availability', { ref: 'avail-unset' });
      expect(unset.isError).toBe(false);
      expect(unset.data.people[0].configured).toBe(false);
      expect(unset.data.people[0].summary).toBeNull();

      // Omitted ref = the whole active roster, so "who works Saturdays?" is the
      // same single read.
      const all = await callWith('get_availability', {});
      expect(all.isError).toBe(false);
      const refs = all.data.people.map((p: { ref: string }) => p.ref);
      expect(refs).toContain('avail-set');
      expect(refs).toContain('avail-unset');

      // Unknown ref: an actionable error, not a silent empty success.
      const missing = await callWith('get_availability', { ref: 'no-such-person' });
      expect(missing.isError).toBe(true);
      expect(missing.text).toContain('no team member with ref');

      // Time off overrides the pattern, so it rides along — but only the near
      // window (30 days). A date beyond it is a schedule question, and that is
      // find_slots' job, not this tool's.
      const soon = localDateISO(new Date(Date.now() + 3 * 86400_000).toISOString(), 'America/Los_Angeles');
      const farOff = localDateISO(new Date(Date.now() + 200 * 86400_000).toISOString(), 'America/Los_Angeles');
      await callWith('add_time_off', { ref: 'avail-set', startsOn: soon, endsOn: soon, reason: 'dentist' });
      await callWith('add_time_off', { ref: 'avail-set', startsOn: farOff, endsOn: farOff, reason: 'next year' });
      const withOff = await callWith('get_availability', { ref: 'avail-set' });
      expect(withOff.isError).toBe(false);
      const dates = withOff.data.people[0].timeOff.map((o: { startsOn: string }) => o.startsOn);
      expect(dates).toContain(soon);
      expect(dates).not.toContain(farOff);

      // Tenant isolation (checklist Tier 2): another tenant's manager sees only
      // their own roster. listTimeOffForTechnician carries no tenant filter, so
      // this read's safety rests on the roster query being the scoped one.
      const otherTenantId = (await createTenant('avail-cross-tenant', { managerSeats: 1 })).id;
      const otherMgr = await insertTechnician({
        tenantId: otherTenantId,
        ref: 'other-avail-mgr',
        displayName: 'Other Avail Manager',
        tier: 'manager',
      });
      await setTechnicianState(otherMgr.id, 'active');
      const { client: otherClient, callWith: otherCall } = await clientFor({
        tenantId: otherTenantId,
        technicianRef: 'other-avail-mgr',
      });
      try {
        const byRef = await otherCall('get_availability', { ref: 'avail-set' });
        expect(byRef.isError).toBe(true);
        expect(byRef.text).toContain('no team member with ref');
        const roster = await otherCall('get_availability', {});
        expect(roster.isError).toBe(false);
        const otherRefs = roster.data.people.map((p: { ref: string }) => p.ref);
        expect(otherRefs).not.toContain('avail-set');
        expect(otherRefs).not.toContain('avail-unset');
      } finally {
        await otherClient.close();
        await pg.query('delete from technicians where tenant_id = $1', [otherTenantId]);
        await pg.query('delete from tenants where id = $1', [otherTenantId]);
      }
    } finally {
      await mgrClient.close();
      // Hermetic on purpose: `avail-set` is seat-exempt, so it starts ACTIVE, and
      // giving it a pattern makes it a schedulable candidate. Left behind, it
      // joins the roster every later scheduling test solves over (it broke the
      // freeze, offboarding and send_email on first run). Children first — FK.
      const ids = await pg.query(
        "select id from technicians where tenant_id = $1 and ref in ('avail-set','avail-unset')",
        [tenantId],
      );
      for (const row of ids.rows) {
        await pg.query('delete from technician_time_off where technician_id = $1', [row.id]);
      }
      await pg.query(
        "delete from technicians where tenant_id = $1 and ref in ('avail-set','avail-unset')",
        [tenantId],
      );
    }
  });

  test('set_availability + skills: validate, store, surface in list_team; inactive refused, seat-exempt accepted', { timeout: 30_000 }, async () => {
    // Seat-exempt probe rows: zero seat pressure regardless of what earlier
    // suites left of the cap, and exactly the population these verbs must
    // serve (schedule-only people become schedulable HERE).
    await insertTechnician({
      tenantId,
      ref: 'input-probe',
      displayName: 'Input Probe',
      seatExempt: true,
    });
    const gone = await insertTechnician({
      tenantId,
      ref: 'input-gone',
      displayName: 'Input Gone',
      seatExempt: true,
    });
    await setTechnicianState(gone.id, 'offboarding');

    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // Malformed pattern shapes → actionable errors, nothing stored.
      const notObj = await callWith('set_availability', { ref: 'input-probe', pattern: 'mon-fri' });
      expect(notObj.isError).toBe(true);
      expect(notObj.text).toContain('pattern must be a JSON object');
      const missingDay = await callWith('set_availability', {
        ref: 'input-probe',
        pattern: { mon: [['08:00', '17:00']] },
      });
      expect(missingDay.isError).toBe(true);
      expect(missingDay.text).toContain("missing day");
      const badWindow = await callWith('set_availability', {
        ref: 'input-probe',
        pattern: { ...PATTERN_MON_FRI, mon: [['17:00', '08:00']] },
      });
      expect(badWindow.isError).toBe(true);
      expect(badWindow.text).toContain('start must be before end');

      // Valid pattern stores and reads back via SQL (cross-channel).
      const ok = await callWith('set_availability', { ref: 'input-probe', pattern: PATTERN_MON_FRI });
      expect(ok.isError).toBe(false);
      expect(ok.data.note).toContain('mon: 08:00–17:00');
      const stored = await pg.query(
        "select availability from technicians where tenant_id = $1 and ref = 'input-probe'",
        [tenantId],
      );
      expect(stored.rows[0].availability).toEqual(PATTERN_MON_FRI);

      // Inactive target: refused with the reactivate hint.
      const inactive = await callWith('set_availability', { ref: 'input-gone', pattern: PATTERN_MON_FRI });
      expect(inactive.isError).toBe(true);
      expect(inactive.text).toContain('deactivated');

      // Skills: normalized echo; junk input rejected.
      const badSkills = await callWith('set_technician_skills', { ref: 'input-probe', skills: 'boilers' });
      expect(badSkills.isError).toBe(true);
      const setSkills = await callWith('set_technician_skills', {
        ref: 'input-probe',
        skills: ['  Boilers ', 'GAS-Line', 'boilers'],
      });
      expect(setSkills.isError).toBe(false);
      expect(setSkills.data.skills).toEqual(['boilers', 'gas-line']);

      // list_team surfaces both new fields.
      const team = await callWith('list_team', {});
      const row = (team.data.team as Array<Record<string, unknown>>).find((t) => t.ref === 'input-probe');
      expect(row).toMatchObject({ skills: ['boilers', 'gas-line'], availabilityConfigured: true });
      const goneRow = (team.data.team as Array<Record<string, unknown>>).find((t) => t.ref === 'input-gone');
      expect(goneRow).toMatchObject({ skills: [], availabilityConfigured: false });

      // Clearing skills is a valid "back to unknown".
      const cleared = await callWith('set_technician_skills', { ref: 'input-probe', skills: [] });
      expect(cleared.data.skills).toEqual([]);
      expect(cleared.data.note).toContain('never excluded');
    } finally {
      await mgrClient.close();
    }
  });

  test('time off: add validates + records; remove deletes overlapping ranges and is honest on zero matches', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const badDate = await callWith('add_time_off', {
        ref: 'input-probe',
        startsOn: '2027-02-30',
        endsOn: '2027-03-01',
      });
      expect(badDate.isError).toBe(true);
      const swapped = await callWith('add_time_off', {
        ref: 'input-probe',
        startsOn: '2027-03-05',
        endsOn: '2027-03-01',
      });
      expect(swapped.isError).toBe(true);
      expect(swapped.text).toContain('on or before');

      const added = await callWith('add_time_off', {
        ref: 'input-probe',
        startsOn: '2027-03-01',
        endsOn: '2027-03-03',
        reason: 'vacation',
      });
      expect(added.isError).toBe(false);
      expect(added.data).toMatchObject({ startsOn: '2027-03-01', endsOn: '2027-03-03', reason: 'vacation' });

      // Zero-match remove: clean answer, not an error.
      const none = await callWith('remove_time_off', { ref: 'input-probe', date: '2027-06-01' });
      expect(none.isError).toBe(false);
      expect(none.data.removed).toEqual([]);
      expect(none.data.note).toContain('no time off');

      // A date inside the range removes it; SQL read-back proves deletion.
      const removed = await callWith('remove_time_off', { ref: 'input-probe', date: '2027-03-02' });
      expect(removed.data.removed).toHaveLength(1);
      const left = await pg.query(
        "select count(*)::int as n from technician_time_off where technician_id = (select id from technicians where tenant_id = $1 and ref = 'input-probe')",
        [tenantId],
      );
      expect(left.rows[0].n).toBe(0);
    } finally {
      await mgrClient.close();
    }
  });

  test('set_job_duration: upsert replaces in place; empty jobType and junk minutes refused', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const empty = await callWith('set_job_duration', { jobType: '   ', minutes: 60 });
      expect(empty.isError).toBe(true);
      const frac = await callWith('set_job_duration', { jobType: 'install', minutes: 90.5 });
      expect(frac.isError).toBe(true);
      const zero = await callWith('set_job_duration', { jobType: 'install', minutes: 0 });
      expect(zero.isError).toBe(true);

      const first = await callWith('set_job_duration', { jobType: '  Install ', minutes: 480 });
      expect(first.data).toMatchObject({ jobType: 'install', minutes: 480 });
      const second = await callWith('set_job_duration', { jobType: 'INSTALL', minutes: 360 });
      expect(second.data).toMatchObject({ jobType: 'install', minutes: 360 });
      const rows = await pg.query(
        "select minutes from job_type_durations where tenant_id = $1 and job_type = 'install'",
        [tenantId],
      );
      expect(rows.rows).toHaveLength(1); // upsert, not a second row
      expect(rows.rows[0].minutes).toBe(360);
    } finally {
      await mgrClient.close();
    }
  });

  test('onboarding hook: seat confirm opens availability_setup; set_availability auto-resolves', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    // The open availability_setup item for a ref, read straight from the table
    // (the manager's queue tool that used to list it was retired, 2026-09-19).
    const openSetupItem = async (ref: string) =>
      (
        await pg.query<{ id: string }>(
          "select id from review_items where tenant_id = $1 and kind = 'availability_setup' and subject_ref = $2 and status = 'open'",
          [tenantId, ref],
        )
      ).rows[0];
    try {
      // Seat-exempt adds exercise the hook without seat-cap pressure — and the
      // hook MUST fire for them (a pattern is their only route to the scheduler).
      const stage = await callWith('add_technician_seat', {
        displayName: 'Onboard One',
        seatExempt: true,
      });
      const added = await callWith('add_technician_seat', { confirmId: stage.data.confirmId });
      expect(added.isError).toBe(false);
      expect(added.data.note).toContain('REQUIRED next step');
      expect(added.data.note).toContain('set_availability');

      expect(await openSetupItem('onboard-one')).toBeDefined();

      // Setting the pattern closes the obligation.
      const set = await callWith('set_availability', { ref: 'onboard-one', pattern: PATTERN_MON_FRI });
      expect(set.isError).toBe(false);
      expect(await openSetupItem('onboard-one')).toBeUndefined();
      // (A second person's "no availability yet" dismissal stood here; that
      // door went with resolve_review, 2026-09-19, and the seat note no longer
      // offers it — an unset pattern simply leaves the item open.)
      expect(added.data.note).not.toContain('dismiss');

      // set_availability with NO open item (pre-hook rows) succeeds quietly.
      const again = await callWith('set_availability', { ref: 'onboard-one', pattern: PATTERN_MON_FRI });
      expect(again.isError).toBe(false);

      // A normal SEAT-OCCUPYING confirm takes the same hook path — pin it too
      // (capacity raised for the probe; the file's later suites don't insert).
      await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 12 });
      const stage3 = await callWith('add_technician_seat', { displayName: 'Onboard Three' });
      const added3 = await callWith('add_technician_seat', { confirmId: stage3.data.confirmId });
      expect(added3.isError).toBe(false);
      expect(added3.data.note).toContain('REQUIRED next step');
      expect(await openSetupItem('onboard-three')).toBeDefined();
    } finally {
      await mgrClient.close();
    }
  });

  test('book_visit priority: one-shot stores it, staged preview == commit, invalid and jobId-combo refused', { timeout: 30_000 }, async () => {
    const customer = await createCustomer({ tenantId, name: 'Priority Henderson' });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const invalid = await callWith('book_visit', {
        customerId: customer.id,
        date: '2027-04-01',
        startTime: '09:00',
        endTime: '10:00',
        priority: 'super-urgent',
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.text).toContain('invalid priority');

      // One-shot (no promise), unassigned (no seat pressure, no overlaps):
      // the shell job carries the stated tier.
      const oneShot = await callWith('book_visit', {
        customerId: customer.id,
        title: 'water main repair',
        date: '2027-04-01',
        startTime: '09:00',
        endTime: '10:00',
        priority: 'urgent',
      });
      expect(oneShot.isError).toBe(false);
      expect(oneShot.data.jobPriority).toBe('urgent');
      // The job's identity is echoed in the result (live E2E finding: an
      // agent-assumed title reached the record without ever being said) and
      // the note tells the agent to SAY it.
      expect(oneShot.data.jobTitle).toBe('water main repair');
      expect(oneShot.data.note).toContain('the JOB');
      const jobRow = await pg.query('select priority from jobs where id = $1', [oneShot.data.jobId]);
      expect(jobRow.rows[0].priority).toBe('urgent');

      // priority alongside an existing job: refused, never silently dropped.
      const combo = await callWith('book_visit', {
        jobId: oneShot.data.jobId,
        date: '2027-04-02',
        startTime: '09:00',
        endTime: '10:00',
        priority: 'emergency',
      });
      expect(combo.isError).toBe(true);
      expect(combo.text).toContain('existing job');

      // One-shot path: the result echoes the tier + job title it wrote.
      const confirmed = await callWith('book_visit', {
        customerId: customer.id,
        title: 'panel upgrade',
        date: '2027-04-03',
        startTime: '09:00',
        endTime: '10:00',
        priority: 'emergency',
      });
      expect(confirmed.isError).toBe(false);
      expect(confirmed.data.jobTitle).toBe('panel upgrade');
      expect(confirmed.data.jobPriority).toBe('emergency');
      expect(confirmed.data.jobTitle).toBe('panel upgrade');
      const jobRow2 = await pg.query('select priority from jobs where id = $1', [confirmed.data.jobId]);
      expect(jobRow2.rows[0].priority).toBe('emergency');
    } finally {
      await mgrClient.close();
    }
  });
});

describe('boardLink decoration (chat → board bridge)', () => {
  test('scheduling results carry boardLink iff BOARD_BOT_HANDLE is set; other tools never do', async () => {
    const prev = process.env.BOARD_BOT_HANDLE;
    try {
      process.env.BOARD_BOT_HANDLE = '@DashboardMan_bot'; // leading @ is normalized off
      // get_schedule: technician-callable (the suite's main identity) AND in
      // the decorated set — the read-only board is for technicians too.
      const sched = await call('get_schedule', {});
      expect(sched.isError).toBe(false);
      expect(sched.data.boardLink).toBe('https://t.me/DashboardMan_bot?startapp');
      // boardNote fuses the relay instruction with a paste-ready Telegram
      // markdown line — the mechanism replacing description-only wording (the
      // live model skipped the link on plain reads, 2026-07-19). Exact match:
      // the agent contract is "relay verbatim", so the test pins the payload.
      expect(sched.data.boardNote).toBe(
        'ALWAYS end this reply with the exact line: ' +
          '[See it on the board](https://t.me/DashboardMan_bot?startapp)',
      );
      // Non-scheduling tools are never decorated — the link belongs to
      // schedule reports, not to every reply.
      const team = await call('list_team', {});
      expect(team.data?.boardLink).toBeUndefined();
      expect(team.data?.boardNote).toBeUndefined();

      // A STAGED result is never decorated either, and this is a different
      // rule from the one above: cancel_job IS in the decorated set, so the
      // absence here comes from `status === 'needs_confirmation'`, not from
      // the tool. Staging writes nothing, so "see it on the board" mid-confirm
      // would show the OLD schedule at the exact moment precision matters.
      //
      // RE-PINNED HERE (rung 8): the only assertion of this rule lived inside
      // the deleted `run_freeze` describe — which had the one staged result the
      // decorator treated specially — so removing the solver silently took the
      // general rule's coverage with it.
      const stagingCustomer = await createCustomer({ tenantId, name: 'BoardLink Staging Casa' });
      const stagingJob = await createJob({
        tenantId,
        customerId: stagingCustomer.id,
        title: 'staged, never decorated',
      });
      const { client: deco, callWith: decoCall } = await clientFor({
        tenantId,
        technicianRef: 'mgr-test',
      });
      try {
        const staged = await decoCall('cancel_job', { jobId: stagingJob.id, reason: 'probe' });
        expect(staged.data.status).toBe('needs_confirmation');
        expect(staged.data.boardLink).toBeUndefined();
        expect(staged.data.boardNote).toBeUndefined();
      } finally {
        await deco.close();
      }

      // A malformed handle is treated as UNSET (never relayed): t.me has
      // sensitive deep-link namespaces a mangled value could reach.
      process.env.BOARD_BOT_HANDLE = 't.me/Not A Handle';
      const bad = await call('get_schedule', {});
      expect(bad.data.boardLink).toBeUndefined();
      expect(bad.data.boardNote).toBeUndefined();

      // Unset handle: the field is simply absent — the agent contract says
      // "no boardLink → say nothing about the board". Deleted EXPLICITLY:
      // .env may legitimately carry BOARD_BOT_HANDLE on an operator machine,
      // and this case must not inherit it.
      delete process.env.BOARD_BOT_HANDLE;
      const bare = await call('get_schedule', {});
      expect(bare.isError).toBe(false);
      expect(bare.data.boardLink).toBeUndefined();
      expect(bare.data.boardNote).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.BOARD_BOT_HANDLE;
      else process.env.BOARD_BOT_HANDLE = prev;
    }
  });
});

describe('safeEnvInt (web-cap env parsing)', () => {
  test('falls back to the default rather than failing OPEN on garbage', () => {
    // A malformed override must NOT become NaN — every `count >= NaN` would be
    // false, silently disabling the cap that compensates for no confirm gate.
    expect(safeEnvInt(undefined, 30)).toBe(30);
    expect(safeEnvInt('512px', 30)).toBe(30);
    expect(safeEnvInt('unlimited', 30)).toBe(30);
    expect(safeEnvInt('', 30)).toBe(30); // NOT 0 (which would block everything)
    expect(safeEnvInt('12.5', 30)).toBe(30);
    expect(safeEnvInt('-5', 30)).toBe(30);
    expect(safeEnvInt('10', 30)).toBe(10); // a valid override still wins
    expect(safeEnvInt('0', 30)).toBe(0); // an explicit 0 is a real (if strict) choice
  });
});

describe('find_slots (Plan 3b)', () => {
  // All fixture dates are Mondays in 2027 (2027-03-01 is exactly 32 weeks
  // after 2026-07-20), far past every other suite's fixtures; every schedule
  // read here pins technicianRef to a probe, so foreign rosters can't leak in.
  const PATTERN_MON_FRI: WeeklyPattern = {
    mon: [['08:00', '17:00']],
    tue: [['08:00', '17:00']],
    wed: [['08:00', '17:00']],
    thu: [['08:00', '17:00']],
    fri: [['08:00', '17:00']],
    sat: [],
    sun: [],
  };
  let bob: Technician; // pattern + skills ['plumbing']
  let henderson: { id: string }; // subject customer, fully addressed

  beforeAll(async () => {
    const mk = async (ref: string, name: string, pattern: boolean, skills: string[]) => {
      const t = await insertTechnician({ tenantId, ref, displayName: name, seatExempt: true });
      if (pattern) await setTechnicianAvailability(t.id, PATTERN_MON_FRI);
      if (skills.length > 0) await setTechnicianSkills(t.id, skills);
      return t;
    };
    bob = await mk('slots-bob', 'Slots Bob', true, ['plumbing']);
    // Referenced by ref string only: mismatch, unknown-skills, and no-pattern probes.
    await mk('slots-nellie', 'Slots Nellie', true, ['electrical']);
    await mk('slots-blank', 'Slots Blank', true, []);
    await mk('slots-nopat', 'Slots Nopat', false, []);
    henderson = await createCustomer({
      tenantId,
      name: 'Slot Henderson',
      addressLine1: '2331 Fresno St',
      city: 'Fresno',
      state: 'CA',
      postalCode: '93721',
    });
  });

  async function bookedVisit(opts: {
    technicianId: string | null;
    startsAt: string;
    endsAt: string;
    addressed?: boolean;
  }) {
    const cust = await createCustomer({
      tenantId,
      name: `Slots cust ${opts.startsAt}`,
      ...(opts.addressed
        ? { addressLine1: '567 W Shaw Ave', city: 'Fresno', state: 'CA', postalCode: '93704' }
        : {}),
    });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'slots ctx', status: 'open' });
    return createVisit({
      tenantId,
      jobId: job.id,
      technicianId: opts.technicianId,
      startsAt: nl(opts.startsAt),
      endsAt: nl(opts.endsAt),
      status: 'confirmed',
    });
  }

  test('technician badge denied; subject and argument validation', { timeout: 30_000 }, async () => {
    const denied = await call('find_slots', { customerId: henderson.id });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('manager badge');

    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const none = await callWith('find_slots', {});
      expect(none.isError).toBe(true);
      expect(none.text).toContain('exactly one');
      const two = await callWith('find_slots', { customerId: henderson.id, jobId: 'x' });
      expect(two.isError).toBe(true);
      expect(two.text).toContain('exactly one');
      // Since 4b-1 the shared bound applies here too (durationError): the
      // 6000-for-600 typo that update_job refuses must not become a 100-hour
      // slot search that answers "nothing fits".
      const badMin = await callWith('find_slots', { customerId: henderson.id, durationMinutes: 0 });
      expect(badMin.isError).toBe(true);
      expect(badMin.text).toContain('1 to 1440');
      const overMax = await callWith('find_slots', { customerId: henderson.id, durationMinutes: 6000 });
      expect(overMax.isError).toBe(true);
      expect(overMax.text).toContain('1 to 1440');
      const badSkills = await callWith('find_slots', {
        customerId: henderson.id,
        durationMinutes: 60,
        requiredSkills: 'plumbing',
      });
      expect(badSkills.isError).toBe(true);
      expect(badSkills.text).toContain('array of strings');
      // Non-string optional args are REJECTED, never coerced-to-absent — a
      // numeric technicianRef must not silently UN-PIN the search.
      const numRef = await callWith('find_slots', {
        customerId: henderson.id,
        durationMinutes: 60,
        technicianRef: 12345,
      });
      expect(numRef.isError).toBe(true);
      expect(numRef.text).toContain('technicianRef must be a string');
      const numDate = await callWith('find_slots', {
        customerId: henderson.id,
        durationMinutes: 60,
        latestDate: 20270310,
      });
      expect(numDate.isError).toBe(false);
      expect(numDate.data.status).toBe('invalid_range'); // not the default window
      const badRange = await callWith('find_slots', {
        customerId: henderson.id,
        durationMinutes: 60,
        earliestDate: '2027-03-01',
        latestDate: '2027-03-20',
      });
      expect(badRange.isError).toBe(false);
      expect(badRange.data.status).toBe('invalid_range'); // 20 days > 14-day cap
      const past = await callWith('find_slots', {
        customerId: henderson.id,
        durationMinutes: 60,
        earliestDate: '2020-01-01',
        latestDate: '2020-01-05',
      });
      expect(past.data.status).toBe('invalid_range');
      expect(past.data.note).toContain('in the past');
    } finally {
      await mgrClient.close();
    }
  });

  test('duration is fail-closed: vocabulary-carrying errors, table disclosure, typed-job authority', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      await upsertJobTypeDuration(tenantId, 'drainage', 300);

      // Untyped subject, no duration → error CARRIES the configured vocabulary.
      const untyped = await callWith('find_slots', { customerId: henderson.id });
      expect(untyped.isError).toBe(true);
      expect(untyped.text).toContain('no recorded type');
      expect(untyped.text).toContain('drainage (300m)');
      expect(untyped.text).toContain('assumedType');

      // Typed job with an UNCONFIGURED type → same vocabulary, named type.
      const roofJob = await createJob({
        tenantId,
        customerId: henderson.id,
        title: 'roof patch',
        status: 'open',
        jobType: 'roofing',
      });
      const roof = await callWith('find_slots', { jobId: roofJob.id });
      expect(roof.isError).toBe(true);
      expect(roof.text).toContain("no duration is configured for 'roofing'");
      expect(roof.text).toContain('drainage (300m)');

      // Typed job with a configured type → table duration, DISCLOSED.
      const drainJob = await createJob({
        tenantId,
        customerId: henderson.id,
        title: 'clear the main line',
        status: 'open',
        jobType: 'drainage',
      });
      const typed = await callWith('find_slots', {
        jobId: drainJob.id,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-01',
        latestDate: '2027-03-02',
      });
      expect(typed.isError).toBe(false);
      expect(typed.data.durationAssumption).toContain("assuming 300 min for 'drainage'");
      expect(typed.data.durationAssumption).toContain('set_job_duration');

      // assumedType on a TYPED job → refused (the row is authoritative).
      const overrideType = await callWith('find_slots', { jobId: drainJob.id, assumedType: 'roofing' });
      expect(overrideType.isError).toBe(true);
      expect(overrideType.text).toContain("already has type 'drainage'");

      // Explicit durationMinutes on a typed job → allowed, echoed as an override.
      const stated = await callWith('find_slots', {
        jobId: drainJob.id,
        durationMinutes: 90,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-01',
        latestDate: '2027-03-01',
      });
      expect(stated.isError).toBe(false);
      expect(stated.data.durationAssumption).toContain('using your stated 1h 30m');

      // The customerId MINT GUARD: henderson now has open jobs (created just
      // above), so a bare customerId search is refused with the list — the
      // 2026-08-14 diagnosis was agents searching by customerId for work
      // already on file and minting duplicates off the answer.
      const steered = await callWith('find_slots', {
        customerId: henderson.id,
        assumedType: 'drainage',
      });
      expect(steered.isError).toBe(true);
      expect(steered.text).toContain('already has open work on file');
      expect(steered.text).toContain(roofJob.id);
      expect(steered.text).toContain('forceNewJob');

      // assumedType on an UNTYPED subject → resolves the table, labeled a
      // guess. forceNewJob: this probe is ABOUT the new-work path, and the
      // guard above would otherwise (correctly) steer it to the open jobs.
      const guessed = await callWith('find_slots', {
        customerId: henderson.id,
        forceNewJob: true,
        assumedType: 'drainage',
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-01',
        latestDate: '2027-03-01',
      });
      expect(guessed.isError).toBe(false);
      expect(guessed.data.assumedType).toBe('drainage');
      expect(guessed.data.assumedTypeNote).toContain('guess');
      expect(guessed.data.durationAssumption).toContain("assuming 300 min for 'drainage'");

      // assumedType + durationMinutes: the minutes are the manager's, but the
      // TYPE still rides every reason string — the guess label must survive.
      const guessedStated = await callWith('find_slots', {
        customerId: henderson.id,
        forceNewJob: true, // same new-work probe as above
        assumedType: 'drainage',
        durationMinutes: 60,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-01',
        latestDate: '2027-03-01',
      });
      expect(guessedStated.isError).toBe(false);
      expect(guessedStated.data.assumedType).toBe('drainage');
      expect(guessedStated.data.assumedTypeNote).toContain('guess');
      expect(guessedStated.data.candidates[0].reasons[0]).toContain('1h drainage');
    } finally {
      await mgrClient.close();
    }
  });

  test("job-level duration (4b-1): own length beats the type table; ladder rides the error", { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // Never-configured arm FIRST (review observation: the 4b-1 rewrite left
      // it unpinned): with NO type durations stored at all, the no-duration
      // error still leads with the ladder remedy. Earlier tests plant rows, so
      // clear and re-plant below — this test must stay standalone-runnable.
      await pg.query('delete from job_type_durations where tenant_id = $1', [tenantId]);
      const bareJob = await createJob({
        tenantId,
        customerId: henderson.id,
        title: 'unsized chore',
        status: 'open',
      });
      const bare = await callWith('find_slots', { jobId: bareJob.id });
      expect(bare.isError).toBe(true);
      expect(bare.text).toContain('No job-type durations are configured yet');
      expect(bare.text).toContain('update_job');
      expect(bare.text).toContain('15/30/45/60/90/120/180/240/360/480');
      await upsertJobTypeDuration(tenantId, 'drainage', 300); // restore prior state

      // A job with its OWN length and NO type — before 4b-1 this threw
      // 'no recorded type'; now the job's recorded length applies directly.
      const ownOnly = await createJob({
        tenantId,
        customerId: henderson.id,
        title: 'fence gate repair',
        status: 'open',
        durationMinutes: 90,
      });
      const own = await callWith('find_slots', {
        jobId: ownOnly.id,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-01',
        latestDate: '2027-03-02',
      });
      expect(own.isError).toBe(false);
      expect(own.data.durationAssumption).toContain("using this job's recorded length (1h 30m)");
      expect(own.data.candidates.length).toBeGreaterThan(0);

      // A stated override of the job's OWN length is disclosed, exactly as a
      // type override always was (review observation: the note must not go
      // silent on the new source).
      const overridden = await callWith('find_slots', {
        jobId: ownOnly.id,
        durationMinutes: 60,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-01',
        latestDate: '2027-03-01',
      });
      expect(overridden.isError).toBe(false);
      expect(overridden.data.durationAssumption).toContain(
        "not this job's recorded length (1h 30m)",
      );

      // Own length OUTRANKS a configured type: drainage is stored at 300m,
      // but the job says 45 — the more specific value wins, disclosed.
      const both = await createJob({
        tenantId,
        customerId: henderson.id,
        title: 'quick drain check',
        status: 'open',
        jobType: 'drainage',
        durationMinutes: 45,
      });
      const specific = await callWith('find_slots', {
        jobId: both.id,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-01',
        latestDate: '2027-03-01',
      });
      expect(specific.isError).toBe(false);
      expect(specific.data.durationAssumption).toContain("using this job's recorded length (45m)");
      expect(specific.data.durationAssumption).not.toContain('assuming 300');

      // A stated override on a job with BOTH a type and its own length must
      // name the source precedence would actually have used — the own length,
      // not the type default (final-review finding: the disclosure branch
      // order had drifted from the resolution chain in the same diff).
      const combined = await callWith('find_slots', {
        jobId: both.id,
        durationMinutes: 60,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-01',
        latestDate: '2027-03-01',
      });
      expect(combined.isError).toBe(false);
      expect(combined.data.durationAssumption).toContain("not this job's recorded length (45m)");
      expect(combined.data.durationAssumption).not.toContain("stored 'drainage'");

      // assumedType on a job with a recorded length is REFUSED (final-review
      // finding: the own-length branch would otherwise skip the lookup that
      // validates the type, while every reason string still brands it).
      const brandAttempt = await callWith('find_slots', {
        jobId: ownOnly.id,
        assumedType: 'instal', // typo'd type — nothing would ever vet it
      });
      expect(brandAttempt.isError).toBe(true);
      expect(brandAttempt.text).toContain('has a recorded length (1h 30m)');
      expect(brandAttempt.text).toContain('assumedType only resolves an unknown duration');

      // Same rule on an EXISTING VISIT subject (round-2 finding): the booked
      // length is known, so assumedType is refused there too, not silently
      // branded onto every reason string.
      const booked = await callWith('book_visit', {
        jobId: ownOnly.id,
        technicianRef: 'slots-bob',
        date: '2027-03-02',
        startTime: '09:00',
        endTime: '10:30',
      });
      const visitBrand = await callWith('find_slots', {
        visitId: booked.data.visitId,
        assumedType: 'instal',
      });
      expect(visitBrand.isError).toBe(true);
      expect(visitBrand.text).toContain("this visit's booked length applies");

      // Neither own length nor type: still fail-closed, and the error now
      // carries the ladder as the primary remedy (any whole number accepted).
      const neither = await createJob({
        tenantId,
        customerId: henderson.id,
        title: 'mystery task',
        status: 'open',
      });
      const err = await callWith('find_slots', { jobId: neither.id });
      expect(err.isError).toBe(true);
      expect(err.text).toContain('update_job');
      expect(err.text).toContain('15/30/45/60/90/120/180/240/360/480');
      expect(err.text).toContain('any whole number works');
    } finally {
      await mgrClient.close();
    }
  });

  test('DENSITY decides the candidate mode through the full tool; slots are decision-ready', { timeout: 30_000 }, async () => {
    // Two far-out Mondays, same distance class from today: an EMPTY one and a
    // PACKED one. Density, not date, must pick the mode. (The engine-level
    // fake-clock suite additionally pins "empty TOMORROW is day-level" —
    // the tool runs on the live clock, so the near-day variant lives there.)
    await bookedVisit({
      technicianId: bob.id,
      startsAt: nl('2027-03-08T09:00:00.000Z'),
      endsAt: nl('2027-03-08T10:00:00.000Z'),
    });
    await bookedVisit({
      technicianId: bob.id,
      startsAt: nl('2027-03-08T11:00:00.000Z'),
      endsAt: nl('2027-03-08T13:00:00.000Z'),
    });

    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    const prevHandle = process.env.BOARD_BOT_HANDLE;
    process.env.BOARD_BOT_HANDLE = 'SlotsProbeBot';
    try {
      const empty = await callWith('find_slots', {
        customerId: henderson.id,
        forceNewJob: true, // hypothetical-new-work probe; henderson has open jobs by now
        durationMinutes: 60,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-02',
        latestDate: '2027-03-02',
      });
      expect(empty.isError).toBe(false);
      expect(empty.data.candidates).toHaveLength(1);
      expect(empty.data.candidates[0].dayLevel).toBe(true);
      expect(empty.data.candidates[0].reasons[0]).toContain('quote the DAY');
      // 2027-03-02 is a Tuesday — the weekday is server-supplied through the
      // full tool (field + reason prefix), never left to agent calendar math.
      expect(empty.data.candidates[0].weekday).toBe('Tue');
      expect(empty.data.candidates[0].reasons[0]).toContain('Tue 2027-03-02');
      // EVERY schedule answer carries the real board link (AGENTS.md doctrine)
      // — find_slots was originally excluded and the agent FABRICATED a URL to
      // satisfy the doctrine (live E2E 2026-07-21). The fused boardNote is the
      // mechanism that leaves it nothing to invent.
      expect(empty.data.boardLink).toBe('https://t.me/SlotsProbeBot?startapp');
      expect(empty.data.boardNote).toContain('[See it on the board](https://t.me/SlotsProbeBot?startapp)');

      const dense = await callWith('find_slots', {
        customerId: henderson.id,
        forceNewJob: true, // hypothetical-new-work probe; henderson has open jobs by now
        durationMinutes: 60,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-08',
        latestDate: '2027-03-08',
      });
      expect(dense.isError).toBe(false);
      const cands = dense.data.candidates as Array<Record<string, unknown>>;
      expect(cands).toHaveLength(3); // gaps 08–09, 10–11, 13–17
      expect(cands.every((c) => c.dayLevel === false)).toBe(true);
      expect(cands.map((c) => c.startTime).sort()).toEqual(['08:00', '10:00', '13:00']);
      expect(cands.every((c) => typeof c.reasons === 'object')).toBe(true);
      expect(dense.data.searched).toEqual({ technicians: 1, days: 1 });
      expect(typeof dense.data.scheduleVersion).toBe('number');
      expect(dense.data.durationAssumption).toBeUndefined(); // stated, untyped — no assumption
    } finally {
      if (prevHandle === undefined) delete process.env.BOARD_BOT_HANDLE;
      else process.env.BOARD_BOT_HANDLE = prevHandle;
      await mgrClient.close();
    }
  });

  test('skills three-state through the tool: match, unknown-flagged, configured-mismatch named', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const res = await callWith('find_slots', {
        customerId: henderson.id,
        forceNewJob: true, // hypothetical-new-work probe; henderson has open jobs by now
        durationMinutes: 60,
        requiredSkills: ['Plumbing'],
        earliestDate: '2027-03-02',
        latestDate: '2027-03-02',
      });
      expect(res.isError).toBe(false);
      const byRef = new Map(
        (res.data.candidates as Array<{ technicianRef: string; warnings: string[] }>).map((c) => [
          c.technicianRef,
          c,
        ]),
      );
      expect(byRef.has('slots-bob')).toBe(true); // configured match
      expect(byRef.has('slots-blank')).toBe(true); // unknown ≠ unqualified
      expect(byRef.get('slots-blank')!.warnings.join(' ')).toContain('confirm they can do plumbing');
      expect(byRef.has('slots-nellie')).toBe(false); // explicit mismatch
      expect(res.data.skippedSkills).toContain('slots-nellie');
      expect(res.data.unknownSkills).toContain('slots-blank');
      expect(res.data.skippedNoPattern).toContain('slots-nopat');
    } finally {
      await mgrClient.close();
    }
  });

  test('visitId subject: row duration, own-slot exclusion, terminal refusal', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // An UNASSIGNED parked visit is a valid subject; its booked length rides.
      const parked = await bookedVisit({
        technicianId: null,
        startsAt: nl('2027-03-15T09:00:00.000Z'),
        endsAt: nl('2027-03-15T11:00:00.000Z'),
      });
      const who = await callWith('find_slots', {
        visitId: parked.id,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-15',
        latestDate: '2027-03-15',
      });
      expect(who.isError).toBe(false);
      expect(who.data.durationAssumption).toContain("this visit's booked length (2h)");
      expect(who.data.candidates.length).toBeGreaterThan(0);

      // An ASSIGNED subject must not be blocked by its own row: bob's visit
      // fills his whole Monday, yet re-placing THAT visit finds the day free.
      const whole = await bookedVisit({
        technicianId: bob.id,
        startsAt: nl('2027-03-22T08:00:00.000Z'),
        endsAt: nl('2027-03-22T17:00:00.000Z'),
      });
      const rehome = await callWith('find_slots', {
        visitId: whole.id,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-22',
        latestDate: '2027-03-22',
      });
      expect(rehome.isError).toBe(false);
      expect(rehome.data.candidates).toHaveLength(1); // 9h fits ONLY because own row is excluded
      expect(rehome.data.candidates[0].startTime).toBe('08:00');

      // Terminal subjects are history, not schedulable.
      const dead = await bookedVisit({
        technicianId: bob.id,
        startsAt: nl('2027-03-29T09:00:00.000Z'),
        endsAt: nl('2027-03-29T10:00:00.000Z'),
      });
      await updateVisitStatus(dead.id, 'cancelled');
      const refused = await callWith('find_slots', { visitId: dead.id });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('cancelled');
    } finally {
      await mgrClient.close();
    }
  });

  test('no dead ends: pattern-less pin and impossible duration both return decision-ready noFit', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const nopatRes = await callWith('find_slots', {
        customerId: henderson.id,
        forceNewJob: true, // hypothetical-new-work probe; henderson has open jobs by now
        durationMinutes: 60,
        technicianRef: 'slots-nopat',
        earliestDate: '2027-03-02',
        latestDate: '2027-03-02',
      });
      expect(nopatRes.isError).toBe(false);
      expect(nopatRes.data.status).toBe('no_fit');
      expect(nopatRes.data.skippedNoPattern).toEqual(['slots-nopat']);
      expect(nopatRes.data.noFit.bindingConstraint).toContain('no working pattern');
      expect(nopatRes.data.noFit.bindingConstraint).toContain('set_availability');
      expect(nopatRes.data.noFit.hint).toBeUndefined(); // no beyond-range search ran

      // A fully-booked requested day → nearestAlternative BEYOND the range,
      // searched with its own visit context (the next free working day).
      await bookedVisit({
        technicianId: bob.id,
        startsAt: nl('2027-04-19T08:00:00.000Z'),
        endsAt: nl('2027-04-19T17:00:00.000Z'),
      });
      const fullDay = await callWith('find_slots', {
        customerId: henderson.id,
        forceNewJob: true, // hypothetical-new-work probe; henderson has open jobs by now
        durationMinutes: 60,
        technicianRef: 'slots-bob',
        earliestDate: '2027-04-19',
        latestDate: '2027-04-19',
      });
      expect(fullDay.isError).toBe(false);
      expect(fullDay.data.status).toBe('no_fit');
      expect(fullDay.data.noFit.nearestAlternative).toMatchObject({
        technicianRef: 'slots-bob',
        date: '2027-04-20',
      });
      expect(fullDay.data.noFit.nearestAlternative.note).toContain('BEYOND');
      expect(fullDay.data.noFit.hint).toBeUndefined(); // an alternative was found

      // 12h can never fit a 9h window — constraint named, displacement listed.
      const impossible = await callWith('find_slots', {
        customerId: henderson.id,
        forceNewJob: true, // hypothetical-new-work probe; henderson has open jobs by now
        durationMinutes: 720,
        technicianRef: 'slots-bob',
        earliestDate: '2027-03-08',
        latestDate: '2027-03-14',
      });
      expect(impossible.isError).toBe(false);
      expect(impossible.data.status).toBe('no_fit');
      expect(impossible.data.noFit.bindingConstraint).toContain('no free 12h');
      expect(impossible.data.noFit.hint).toContain('shorter visit');
      const displaced = impossible.data.noFit.displacementCandidates as Array<Record<string, unknown>>;
      expect(displaced.length).toBeGreaterThanOrEqual(2); // the two 03-08 visits
      expect(displaced[0]).toHaveProperty('visitId');
      expect(displaced[0]).not.toHaveProperty('promiseLevel');
    } finally {
      await mgrClient.close();
    }
  });

  test('drive wiring: a 2-stop day measures the with-route through the injected seam', { timeout: 30_000 }, async () => {
    await bookedVisit({
      technicianId: bob.id,
      startsAt: nl('2027-04-05T09:00:00.000Z'),
      endsAt: nl('2027-04-05T10:00:00.000Z'),
      addressed: true,
    });
    await bookedVisit({
      technicianId: bob.id,
      startsAt: nl('2027-04-05T11:00:00.000Z'),
      endsAt: nl('2027-04-05T12:00:00.000Z'),
      addressed: true,
    });
    const computeRoutes = vi.fn(async (body: unknown) => {
      const b = body as { intermediates: { address: string }[] };
      return {
        routes: [
          {
            optimizedIntermediateWaypointIndex: b.intermediates.map((_, i) => i),
            legs: [],
            duration: `${62 * 60}s`,
          },
        ],
      };
    });
    const { client: mgrClient, callWith } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      { computeRoutes },
    );
    try {
      const res = await callWith('find_slots', {
        customerId: henderson.id,
        forceNewJob: true, // hypothetical-new-work probe; henderson has open jobs by now
        durationMinutes: 60,
        technicianRef: 'slots-bob',
        earliestDate: '2027-04-05',
        latestDate: '2027-04-05',
      });
      expect(res.isError).toBe(false);
      const cands = res.data.candidates as Array<{
        driveMeasured: boolean;
        driveDeltaMinutes: number | null;
        reasons: string[];
      }>;
      expect(cands.length).toBeGreaterThan(0);
      // 2 existing routable stops → with-only branch, one cached call for the day.
      expect(computeRoutes).toHaveBeenCalledTimes(1);
      for (const c of cands) {
        expect(c.driveMeasured).toBe(true);
        expect(c.driveDeltaMinutes).toBeNull();
        expect(c.reasons.join(' ')).toContain('route becomes ~62 min');
      }
    } finally {
      await mgrClient.close();
    }
  });

  test('drive route exclusion is scoped to the subject\'s OWN technician', { timeout: 30_000 }, async () => {
    // 2027-04-12 (Monday): bob holds the SUBJECT visit 09:00–10:00 plus two
    // other addressed visits; alice holds two addressed visits, one at the
    // SAME 09:00 instant as the subject. Re-placing bob's visit must (a) drop
    // bob's own stop from HIS day's route, and (b) leave alice's same-instant
    // stop alone — a timestamp-only filter fails (b); no filter fails (a).
    await insertTechnician({ tenantId, ref: 'slots-alice', displayName: 'Slots Alice', seatExempt: true })
      .then((t) => setTechnicianAvailability(t.id, PATTERN_MON_FRI));
    const subjCust = await createCustomer({
      tenantId,
      name: 'Exclusion Subject',
      addressLine1: '99 E Herndon Ave',
      city: 'Fresno',
      state: 'CA',
      postalCode: '93720',
    });
    const subjJob = await createJob({ tenantId, customerId: subjCust.id, title: 'move me', status: 'open' });
    const alice = (await getClient()
      .from('technicians')
      .select('id')
      .eq('tenant_id', tenantId)
      .eq('ref', 'slots-alice')
      .single()).data!;
    const subject = await createVisit({
      tenantId,
      jobId: subjJob.id,
      technicianId: bob.id,
      startsAt: nl('2027-04-12T09:00:00.000Z'),
      endsAt: nl('2027-04-12T10:00:00.000Z'),
      status: 'confirmed',
    });
    for (const [tech, s, e] of [
      [bob.id, '12:00', '13:00'],
      [bob.id, '14:00', '15:00'],
      [alice.id, '09:00', '10:00'], // same instant as the subject, DIFFERENT tech
      [alice.id, '11:00', '12:00'],
    ] as const) {
      await bookedVisit({
        technicianId: tech,
        startsAt: nl(`2027-04-12T${s}:00.000Z`),
        endsAt: nl(`2027-04-12T${e}:00.000Z`),
        addressed: true,
      });
    }
    const mkFake = () =>
      vi.fn(async (body: unknown) => {
        const b = body as { intermediates: { address: string }[] };
        return {
          routes: [
            {
              optimizedIntermediateWaypointIndex: b.intermediates.map((_, i) => i),
              legs: [],
              duration: '3720s',
            },
          ],
        };
      });

    // (b) pinned to ALICE: her same-instant stop must SURVIVE → 2 existing
    // stops → exactly ONE with-only call whose endpoints are her two visits.
    const aliceFake = mkFake();
    const { client: c1, callWith: aliceCall } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      { computeRoutes: aliceFake },
    );
    try {
      const res = await aliceCall('find_slots', {
        visitId: subject.id,
        technicianRef: 'slots-alice',
        earliestDate: '2027-04-12',
        latestDate: '2027-04-12',
      });
      expect(res.isError).toBe(false);
      expect(aliceFake).toHaveBeenCalledTimes(1); // 2 stops survived → with-only
      const body = aliceFake.mock.calls[0][0] as {
        origin: { address: string };
        destination: { address: string };
        intermediates: { address: string }[];
      };
      expect(body.origin.address).toContain('567 W Shaw Ave'); // her 09:00 stop lives
      expect(body.destination.address).toContain('567 W Shaw Ave');
      expect(body.intermediates.map((i) => i.address).join(' ')).toContain('99 E Herndon Ave');
    } finally {
      await c1.close();
    }

    // (a) pinned to BOB: his own subject stop is excluded → 2 remaining stops
    // → with-only (ONE call); an unfiltered day would have 3 stops → 2 calls.
    const bobFake = mkFake();
    const { client: c2, callWith: bobCall } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      { computeRoutes: bobFake },
    );
    try {
      const res = await bobCall('find_slots', {
        visitId: subject.id,
        technicianRef: 'slots-bob',
        earliestDate: '2027-04-12',
        latestDate: '2027-04-12',
      });
      expect(res.isError).toBe(false);
      expect(bobFake).toHaveBeenCalledTimes(1); // own row gone → with-only branch
      const body = bobFake.mock.calls[0][0] as {
        origin: { address: string };
        destination: { address: string };
      };
      expect(body.origin.address).toContain('567 W Shaw Ave'); // his 12:00 stop
      expect(body.destination.address).toContain('567 W Shaw Ave'); // his 14:00 stop
    } finally {
      await c2.close();
    }

    // A PROPOSED subject is absent from the confirmed-only stop list, and the
    // DB legally allows a different CONFIRMED visit at the same instant — the
    // exclusion must not fire and eat that real stop (round-2 residual).
    const proposed = await createVisit({
      tenantId,
      jobId: subjJob.id,
      technicianId: bob.id,
      startsAt: nl('2027-04-12T09:00:00.000Z'), // same instant as bob's CONFIRMED visit
      endsAt: nl('2027-04-12T10:00:00.000Z'),
    });
    const propFake = mkFake();
    const { client: c3, callWith: propCall } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      { computeRoutes: propFake },
    );
    try {
      const res = await propCall('find_slots', {
        visitId: proposed.id,
        technicianRef: 'slots-bob',
        earliestDate: '2027-04-12',
        latestDate: '2027-04-12',
      });
      expect(res.isError).toBe(false);
      // All 3 confirmed stops (incl. the same-instant 09:00 one) must survive
      // → the ≥3-stop delta branch: with + without = TWO calls, not one.
      expect(propFake).toHaveBeenCalledTimes(2);
    } finally {
      await c3.close();
    }
  });
});

describe('update_job (the job identity editor)', () => {
  test('durationMinutes: rungs and free minutes stored, bound enforced, null clears (4b-1)', { timeout: 30_000 }, async () => {
    const customer = await createCustomer({ tenantId, name: 'Duration Edit Cust' });
    const job = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'water heater flush',
      status: 'open',
    });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // A rung, echoed old → new.
      const rung = await callWith('update_job', { jobId: job.id, durationMinutes: 120 });
      expect(rung.isError).toBe(false);
      expect(rung.data.changes.durationMinutes).toEqual({ from: null, to: 120 });

      // OFF-ladder is legal — the ladder is offered, never enforced (user
      // decision 2026-07-24: a 20-minute callout must not become a rounded lie).
      const off = await callWith('update_job', { jobId: job.id, durationMinutes: 20 });
      expect(off.isError).toBe(false);
      expect(off.data.changes.durationMinutes).toEqual({ from: 120, to: 20 });

      // Non-integers, zero, and over-bound fail with the shared message —
      // bound named, ladder offered as suggestions.
      for (const bad of [45.5, 0, 6000]) {
        const r = await callWith('update_job', { jobId: job.id, durationMinutes: bad });
        expect(r.isError).toBe(true);
        expect(r.text).toContain('1 to 1440');
        expect(r.text).toContain('any other whole number is fine');
      }
      // The rejections wrote nothing.
      const row = await pg.query('select duration_minutes from jobs where id = $1', [job.id]);
      expect(row.rows[0].duration_minutes).toBe(20);

      // null = explicit CLEAR back to unknown (the undo arm).
      const cleared = await callWith('update_job', { jobId: job.id, durationMinutes: null });
      expect(cleared.isError).toBe(false);
      expect(cleared.data.changes.durationMinutes).toEqual({ from: 20, to: null });

      // The ledger carried the change (updateJobIdentity is the shared core).
      const ev = await pg.query(
        "select detail from schedule_events where tenant_id = $1 and kind = 'job_updated' order by id desc limit 1",
        [tenantId],
      );
      expect(ev.rows[0].detail.durationMinutes).toEqual({ from: 20, to: null });

      // Placeability warnings (final-review findings). The job is currently
      // duration-less and untyped, so clearing again warns about stranding…
      await callWith('update_job', { jobId: job.id, durationMinutes: 60 });
      const strand = await callWith('update_job', { jobId: job.id, durationMinutes: null });
      expect(strand.isError).toBe(false);
      expect(strand.data.warning).toContain('no usable length');
      expect(strand.data.warning).toContain('durationMinutes');

      // …setting an unconfigured type on a job WITH its own length still warns
      // (the type is unwired tenant-wide) but says this job stays placeable…
      await callWith('update_job', { jobId: job.id, durationMinutes: 90 });
      const typedButOwn = await callWith('update_job', { jobId: job.id, jobType: 'fencing' });
      expect(typedButOwn.isError).toBe(false);
      expect(typedButOwn.data.warning).toContain("no stored duration for 'fencing'");
      expect(typedButOwn.data.warning).toContain('own recorded length (1h 30m)');

      // …and clearing the length on that typed-but-unconfigured job warns via
      // the strand arm, not silence (the newly reachable path).
      const strandTyped = await callWith('update_job', { jobId: job.id, durationMinutes: null });
      expect(strandTyped.isError).toBe(false);
      expect(strandTyped.data.warning).toContain('no usable length');

      // A title-only edit on the stranded job stays warning-free (the edit
      // touched no scheduling input — no nagging, and no extra DB read).
      const titleOnly = await callWith('update_job', { jobId: job.id, title: 'Quiet rename' });
      expect(titleOnly.isError).toBe(false);
      expect(titleOnly.data.warning).toBeUndefined();

      // Clearing the TYPE when it was the only duration source also strands —
      // warned via the same arm (round-2 finding: this case was silent even
      // pre-4b-1). Wire the type up, drop the own length, then clear the type.
      await callWith('set_job_duration', { jobType: 'fencing', minutes: 60 });
      const typeCleared = await callWith('update_job', { jobId: job.id, jobType: null });
      expect(typeCleared.isError).toBe(false);
      expect(typeCleared.data.warning).toContain('no usable length');
      await pg.query('delete from job_type_durations where tenant_id = $1', [tenantId]);
    } finally {
      await mgrClient.close();
    }
  });

  test('gate + validation + old→new echo + scheduling authority', { timeout: 30_000 }, async () => {
    const denied = await call('update_job', { jobId: 'x', title: 'nope' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('manager badge');

    const customer = await createCustomer({ tenantId, name: 'Update Job Cust' });
    const job = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'Cust - drainage replacement (assumed)',
      status: 'open',
    });
    // Own probe tech — this test must run standalone (review round-2: reusing
    // the find_slots describe's slots-bob broke `vitest -t update_job`).
    const uj = await insertTechnician({
      tenantId,
      ref: 'update-job-tech',
      displayName: 'Update Job Tech',
      seatExempt: true,
    });
    await setTechnicianAvailability(uj.id, {
      mon: [['08:00', '17:00']],
      tue: [['08:00', '17:00']],
      wed: [['08:00', '17:00']],
      thu: [['08:00', '17:00']],
      fri: [['08:00', '17:00']],
      sat: [],
      sun: [],
    });

    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // Validation: no fields, empty title, junk priority, non-string title,
      // unknown/cross-tenant id.
      const none = await callWith('update_job', { jobId: job.id });
      expect(none.isError).toBe(true);
      expect(none.text).toContain('nothing to update');
      const empty = await callWith('update_job', { jobId: job.id, title: '   ' });
      expect(empty.isError).toBe(true);
      expect(empty.text).toContain('must not be empty');
      const badPriority = await callWith('update_job', { jobId: job.id, priority: 'asap' });
      expect(badPriority.isError).toBe(true);
      expect(badPriority.text).toContain('invalid priority');
      // '' must be REJECTED, not coerced-to-absent-and-ignored.
      const emptyPriority = await callWith('update_job', { jobId: job.id, title: 'x', priority: '' });
      expect(emptyPriority.isError).toBe(true);
      expect(emptyPriority.text).toContain('invalid priority');
      const numTitle = await callWith('update_job', { jobId: job.id, title: 42 });
      expect(numTitle.isError).toBe(true);
      expect(numTitle.text).toContain('title must be a string');
      // jobType: a number must not coerce to absent (partial-update trap) —
      // only a string sets, only NULL clears.
      const numType = await callWith('update_job', { jobId: job.id, jobType: 42 });
      expect(numType.isError).toBe(true);
      expect(numType.text).toContain('jobType must be a string');
      const unknown = await callWith('update_job', {
        jobId: '00000000-0000-0000-0000-000000000001',
        title: 'ghost',
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain('job not found');

      // The correction: title + normalized type + priority, echoed old → new.
      // BOARD_BOT_HANDLE set: an identity edit is a schedule answer — it must
      // carry the REAL board link (the find_slots fabrication lesson).
      const prevHandle = process.env.BOARD_BOT_HANDLE;
      process.env.BOARD_BOT_HANDLE = 'SlotsProbeBot';
      let fixed;
      try {
        fixed = await callWith('update_job', {
          jobId: job.id,
          title: 'Cust - installation',
          jobType: '  Sump-Pump  ',
          priority: 'urgent',
        });
      } finally {
        if (prevHandle === undefined) delete process.env.BOARD_BOT_HANDLE;
        else process.env.BOARD_BOT_HANDLE = prevHandle;
      }
      expect(fixed.isError).toBe(false);
      expect(fixed.data.changes.title).toEqual({
        from: 'Cust - drainage replacement (assumed)',
        to: 'Cust - installation',
      });
      expect(fixed.data.changes.jobType).toEqual({ from: null, to: 'sump-pump' });
      expect(fixed.data.changes.priority).toEqual({ from: 'routine', to: 'urgent' });
      expect(fixed.data.note).toContain('old → new');
      expect(fixed.data.boardLink).toBe('https://t.me/SlotsProbeBot?startapp');
      // No stored duration for the new type yet → the result SAYS so.
      expect(fixed.data.warning).toContain("no stored duration for 'sump-pump'");
      const row = await pg.query('select title, job_type, priority from jobs where id = $1', [job.id]);
      expect(row.rows[0]).toEqual({
        title: 'Cust - installation',
        job_type: 'sump-pump',
        priority: 'urgent',
      });
      // The edit joined the append-only ledger: who, what, old → new.
      const ev = await pg.query(
        "select actor_ref, detail from schedule_events where tenant_id = $1 and kind = 'job_updated' order by id desc limit 1",
        [tenantId],
      );
      expect(ev.rows[0].actor_ref).toBe('mgr-test');
      expect(ev.rows[0].detail.title).toEqual({
        from: 'Cust - drainage replacement (assumed)',
        to: 'Cust - installation',
      });

      // The corrected type immediately drives scheduling: find_slots resolves
      // the stored duration for the NEW type with the standard disclosure.
      await upsertJobTypeDuration(tenantId, 'sump-pump', 90);
      const slots = await callWith('find_slots', {
        jobId: job.id,
        technicianRef: 'update-job-tech',
        earliestDate: '2027-05-03', // a Monday well past other fixtures
        latestDate: '2027-05-03',
      });
      expect(slots.isError).toBe(false);
      expect(slots.data.durationAssumption).toContain("assuming 90 min for 'sump-pump'");

      // A TYPED job's no-duration error must never advise assumedType (which
      // is refused for typed jobs — the two-error loop); it names the real
      // remedies including update_job.
      const orphanType = await callWith('update_job', { jobId: job.id, jobType: 'gutter-guard' });
      expect(orphanType.isError).toBe(false);
      const typedNoDuration = await callWith('find_slots', {
        jobId: job.id,
        technicianRef: 'update-job-tech',
        earliestDate: '2027-05-03',
        latestDate: '2027-05-03',
      });
      expect(typedNoDuration.isError).toBe(true);
      expect(typedNoDuration.text).toContain("no duration is configured for 'gutter-guard'");
      expect(typedNoDuration.text).toContain('update_job');
      expect(typedNoDuration.text).not.toContain('assumedType');

      // jobType: null is the UNDO — the job returns to untyped (and the
      // untyped error path, with its assumedType guidance, applies again).
      const cleared = await callWith('update_job', { jobId: job.id, jobType: null });
      expect(cleared.isError).toBe(false);
      expect(cleared.data.changes.jobType).toEqual({ from: 'gutter-guard', to: null });
      const untypedRow = await pg.query('select job_type from jobs where id = $1', [job.id]);
      expect(untypedRow.rows[0].job_type).toBeNull();

      // CAS honesty at the db layer: a stale updated_at snapshot must refuse,
      // never overwrite-and-misreport (the echo IS the disclosure).
      const { updateJobDetails } = await import('../db/jobs.js');
      await expect(
        updateJobDetails(tenantId, job.id, { title: 'stale writer' }, '2020-01-01T00:00:00.000Z'),
      ).rejects.toThrow(/changed while updating/);
    } finally {
      await mgrClient.close();
    }
  });
});

describe('move_visit unassign (plan 4a.5)', () => {
  test('one-shot park, cross-day park still detaches', { timeout: 30_000 }, async () => {
    const customer = await createCustomer({ tenantId, name: 'Park Probe Cust' });
    // Own probe tech — standalone-runnable (the update_job round-2 lesson).
    const pkt = await insertTechnician({
      tenantId,
      ref: 'park-probe-tech',
      displayName: 'Park Probe Tech',
      seatExempt: true,
    });
    await setTechnicianAvailability(pkt.id, {
      mon: [['08:00', '17:00']],
      tue: [['08:00', '17:00']],
      wed: [['08:00', '17:00']],
      thu: [['08:00', '17:00']],
      fri: [['08:00', '17:00']],
      sat: [],
      sun: [],
    });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // Non-boolean unassign REJECTED, never coerced (find_slots rule).
      const badFlag = await callWith('move_visit', {
        visitId: 'x',
        date: '2027-07-05',
        startTime: '09:00',
        reason: 'r',
        unassign: 'yes',
      });
      expect(badFlag.isError).toBe(true);
      expect(badFlag.text).toContain('unassign must be a boolean');

      // Park: ONE call, technician gone, row visible as unassigned.
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'park-probe-tech',
        date: '2027-07-05', // a Monday, clear of other fixtures
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(booked.data.status).toBe('booked');
      const parked = await callWith('move_visit', {
        visitId: booked.data.visitId,
        date: '2027-07-05',
        startTime: '09:00',
        unassign: true,
        reason: 'tech pulled off',
      });
      expect(parked.isError).toBe(false);
      expect(parked.data.status).toBe('moved');
      expect(parked.data.unassigned).toBe(true);
      expect(parked.data.note).toContain('Parked in one step');
      const parkedRow = await pg.query(
        `select (select count(*)::int from visit_participants p where p.visit_id = v.id) as crew
           from visits v where v.id = $1`,
        [parked.data.visitId],
      );
      expect(parkedRow.rows[0].crew).toBe(0);

      // Both steering args at once → the shared verb refuses.
      const both = await callWith('move_visit', {
        visitId: parked.data.visitId,
        date: '2027-07-05',
        startTime: '09:00',
        technicianRef: 'park-probe-tech',
        unassign: true,
        reason: 'contradiction',
      });
      expect(both.isError).toBe(true);
      expect(both.text).toContain('not both');

      // CROSS-DAY PARK (plan review finding #1, carried into rung 9a): a park
      // that ALSO changes the day must still detach. It used to stage on the
      // promise break; now it is one-shot, but dropping `unassign` on the way
      // through would still commit a plain move that keeps the technician.
      const other = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'park-probe-tech',
        date: '2027-07-06',
        startTime: '09:00',
        endTime: '10:00',
        forceNewJob: true, // titleless repeat on one customer — mint guard bypass
      });
      expect(other.data.status).toBe('booked');
      const crossDay = await callWith('move_visit', {
        visitId: other.data.visitId,
        date: '2027-07-07', // a DIFFERENT day, and unassigning at the same time
        startTime: '09:00',
        unassign: true,
        reason: 'park it for the reflow',
      });
      expect(crossDay.isError).toBe(false);
      expect(crossDay.data.status).toBe('moved');
      expect(crossDay.data.unassigned).toBe(true);
      const confirmedRow = await pg.query(
        `select v.starts_at,
                (select count(*)::int from visit_participants p where p.visit_id = v.id) as crew
           from visits v where v.id = $1`,
        [crossDay.data.visitId],
      );
      expect(confirmedRow.rows[0].crew).toBe(0); // detached…
      // …and the day change landed too: a park keeps its time, it only drops
      // the person.
      expect(confirmedRow.rows[0].starts_at.toISOString()).toContain('2027-07-07');

    } finally {
      await mgrClient.close();
    }
  });
});

describe('set_technician_horizon (the visibility-horizon dial)', () => {
  test('validates, echoes old→new, SQL read-back; the clamp consumes the SETTING', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    const { client: techClient, callWith: techCall } = await clientFor({
      tenantId,
      technicianRef: 'tech-mcp',
    });
    try {
      // Technician badge → refused (admin dispatch gate).
      const gated = await techCall('set_technician_horizon', { weeks: 6 });
      expect(gated.isError).toBe(true);

      // Validation: missing / zero / oversized / fractional / string.
      for (const weeks of [undefined, 0, 13, 2.5, '6']) {
        const bad = await callWith(
          'set_technician_horizon',
          weeks === undefined ? {} : { weeks },
        );
        expect(bad.isError).toBe(true);
        expect(bad.text).toContain('whole number from 1 to 12');
      }

      // Set 6 weeks: old→new echo + SQL read-back of 42.
      const set = await callWith('set_technician_horizon', { weeks: 6 });
      expect(set.isError).toBe(false);
      expect(set.data.changes.technicianHorizonDays).toEqual({ from: 28, to: 42 });
      expect(set.data.note).toContain('6 week');
      const row = await pg.query<{ technician_horizon_days: number }>(
        'select technician_horizon_days from tenants where id = $1',
        [tenantId],
      );
      expect(row.rows[0].technician_horizon_days).toBe(42);

      // Discovery: get_team_schedule carries the current value.
      const team = await callWith('get_team_schedule', {});
      expect(team.data.technicianHorizonDays).toBe(42);

      // The clamp consumes the SETTING, not the default: at 1 week, a
      // technician read 10 days out clamps (empty + note)…
      const tight = await callWith('set_technician_horizon', { weeks: 1 });
      expect(tight.data.changes.technicianHorizonDays).toEqual({ from: 42, to: 7 });
      const clamped = await techCall('get_schedule', { from: relDay(10), to: relDay(11) });
      expect(clamped.data.status).toBe('ok');
      expect(clamped.data.days).toEqual([]);
      expect(clamped.data.horizonNote).toContain("isn't published yet");
      // …and back at 4 weeks the same read answers normally (no note).
      await callWith('set_technician_horizon', { weeks: 4 });
      const open = await techCall('get_schedule', { from: relDay(10), to: relDay(11) });
      expect(open.data.horizonNote).toBeUndefined();
    } finally {
      // Restore the migration default for any later suite.
      await pg.query('update tenants set technician_horizon_days = 28 where id = $1', [tenantId]);
      await mgrClient.close();
      await techClient.close();
    }
  });
});

describe('set_timezone (the firm zone — no writer existed before it)', () => {
  test('gates, refuses abbreviations, echoes old→new with a clock, SQL read-back; resolve_date consumes it', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    const { client: techClient, callWith: techCall } = await clientFor({
      tenantId,
      technicianRef: 'tech-mcp',
    });
    const before = (
      await pg.query<{ timezone: string }>('select timezone from tenants where id = $1', [tenantId])
    ).rows[0].timezone;
    try {
      // Technician badge → refused (admin dispatch gate).
      const gated = await techCall('set_timezone', { timezone: 'America/Chicago' });
      expect(gated.isError).toBe(true);

      // A non-string is REJECTED, never coerced-to-absent: a coerced-away value
      // on a required field would read as "not supplied" (find_slots precedent).
      const coerced = await callWith('set_timezone', { timezone: 5 });
      expect(coerced.isError).toBe(true);
      expect(coerced.text).toContain('must be a string');

      // The guard that matters. An abbreviation cannot express whether the firm
      // observes DST, and a city name is not a zone — both must fail loudly
      // rather than storing something nothing can interpret.
      for (const bad of ['CST', 'Central', 'Austin', 'America/Chicgo', '', ' America/Chicago']) {
        const refused = await callWith('set_timezone', { timezone: bad });
        expect(refused.isError, bad).toBe(true);
        expect(refused.text, bad).toContain('not a timezone I recognise');
      }

      // Set it: old→new echo, a clock the manager can actually verify, and a
      // read-back through psql rather than the tool's own return value.
      const set = await callWith('set_timezone', { timezone: 'America/Chicago' });
      expect(set.isError).toBe(false);
      expect(set.data.changes.timezone).toEqual({ from: before, to: 'America/Chicago' });
      expect(set.data.localTime).toMatch(/\d{1,2}:\d{2}/);
      expect(set.data.note).toContain('America/Chicago');
      const row = await pg.query<{ timezone: string }>(
        'select timezone from tenants where id = $1',
        [tenantId],
      );
      expect(row.rows[0].timezone).toBe('America/Chicago');

      // The consumer proof: the zone is not decorative, it is what every date
      // read is interpreted in.
      const resolved = await callWith('resolve_date', { phrase: 'today' });
      expect(resolved.data.timezone).toBe('America/Chicago');

      // Phoenix vs Denver — both valid, an hour apart for half the year. The
      // tool cannot tell them apart, which is exactly why its result carries a
      // clock for the manager to check.
      const phoenix = await callWith('set_timezone', { timezone: 'America/Phoenix' });
      expect(phoenix.data.changes.timezone).toEqual({ from: 'America/Chicago', to: 'America/Phoenix' });
    } finally {
      await pg.query('update tenants set timezone = $2 where id = $1', [tenantId, before]);
      await mgrClient.close();
      await techClient.close();
    }
  });
});

describe('cancel_job (the terminal verb — cancel-vocabulary plan)', () => {
  test('never one-shots, confirm cascades, job leaves the recall view', { timeout: 30_000 }, async () => {
    const denied = await call('cancel_job', { jobId: 'x', reason: 'nope' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('manager badge');

    const customer = await createCustomer({ tenantId, name: 'Cancel Job Casa' });
    // A visit-LESS, promise-free job: the reversible verbs would one-shot an
    // action this safe-looking — cancel_job must stage anyway (terminal).
    const bare = await createJob({ tenantId, customerId: customer.id, title: 'never happened' });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const unknown = await callWith('cancel_job', {
        jobId: '00000000-0000-0000-0000-000000000001',
        reason: 'ghost',
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain('job not found');

      const stage1 = await callWith('cancel_job', { jobId: bare.id, reason: 'duplicate entry' });
      expect(stage1.isError).toBe(false);
      expect(stage1.data.status).toBe('needs_confirmation');
      expect(stage1.data.note).toContain('TERMINAL');
      // Nothing died at stage time.
      const still = await pg.query('select status from jobs where id = $1', [bare.id]);
      expect(still.rows[0].status).toBe('open');

      // The job is in the recall view's unscheduledJobs before the confirm…
      const before = await recallAll(callWith, 'jobs');
      expect(before.map((j) => j.jobId)).toContain(bare.id);

      // Restage supersedes the caller's prior token: the old confirmId dies.
      const stage2 = await callWith('cancel_job', { jobId: bare.id, reason: 'duplicate entry' });
      expect(stage2.data.confirmId).not.toBe(stage1.data.confirmId);
      const staleConfirm = await callWith('cancel_job', { confirmId: stage1.data.confirmId });
      expect(staleConfirm.isError).toBe(true);
      expect(staleConfirm.text).toContain('confirmation not found');

      const confirmed = await callWith('cancel_job', { confirmId: stage2.data.confirmId });
      expect(confirmed.isError).toBe(false);
      expect(confirmed.data.status).toBe('cancelled');
      expect(confirmed.data.jobTitle).toBe('never happened');
      expect(confirmed.data.visitsCancelled).toEqual([]);
      const after = await pg.query('select status from jobs where id = $1', [bare.id]);
      expect(after.rows[0].status).toBe('cancelled');
      // …and gone from it after (the bucket-exit contract: the freeze must
      // never see dead work).
      const recall = await recallAll(callWith, 'jobs');
      expect(recall.map((j) => j.jobId)).not.toContain(bare.id);

      // A used token cannot commit twice.
      const replay = await callWith('cancel_job', { confirmId: stage2.data.confirmId });
      expect(replay.isError).toBe(true);
    } finally {
      await mgrClient.close();
    }
  });

  test('cascade through the tool: the live visit is disclosed in the preview, then dies', { timeout: 30_000 }, async () => {
    const customer = await createCustomer({ tenantId, name: 'Cascade Cal' });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        title: 'patio drainage',
        date: '2027-02-01',
        startTime: '09:00',
        endTime: '11:00',
      });
      expect(booked.data.status).toBe('booked'); // book_visit is always one-shot
      const jobId = booked.data.jobId as string;
      const stage = await callWith('cancel_job', { jobId, reason: 'customer called it off' });
      const preview = stage.data.preview as {
        visits: Array<{ visitId: string; day: string }>;
      };
      // The stake is stated: the live visit rides the preview.
      expect(preview.visits).toHaveLength(1);
      expect(preview.visits[0]).toMatchObject({
        visitId: booked.data.visitId,
        day: '2027-02-01',
      });

      const confirmed = await callWith('cancel_job', { confirmId: stage.data.confirmId });
      expect(confirmed.isError).toBe(false);
      expect(confirmed.data.visitsCancelled).toEqual([
        { visitId: booked.data.visitId, day: '2027-02-01' },
      ]);
      // Off the board.
      const day = await callWith('get_team_schedule', { from: '2027-02-01', to: '2027-02-01', stops: true });
      expect((day.data.stops as Array<{ visitId: string }>).map((s) => s.visitId)).not.toContain(
        booked.data.visitId,
      );
      // Terminal: a second cancel_job on the same job refuses with the truth.
      const again = await callWith('cancel_job', { jobId, reason: 'again' });
      expect(again.isError).toBe(true);
      expect(again.text).toContain('it already is');
    } finally {
      await mgrClient.close();
    }
  });

  test('a job closed elsewhere before the yes dismisses the pending cancel instead of leaving it open', async () => {
    const customer = await createCustomer({ tenantId, name: 'Closed Elsewhere Cleo' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'gutter clean' });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const stage = await callWith('cancel_job', { jobId: job.id, reason: 'duplicate' });
      expect(stage.data.status).toBe('needs_confirmation');
      // Cancelled on the console in the meantime.
      await pg.query(`update jobs set status = 'cancelled' where id = $1`, [job.id]);
      const confirm = await callWith('cancel_job', { confirmId: stage.data.confirmId });
      expect(confirm.isError).toBe(true);
      expect(confirm.text).toContain('it already is');
      const item = await pg.query<{ status: string }>('select status from review_items where id = $1', [
        stage.data.confirmId,
      ]);
      expect(item.rows[0].status).toBe('dismissed');
    } finally {
      await mgrClient.close();
    }
  });

  test('the yes covers what was SHOWN: a visit booked after the preview refuses the cancel', { timeout: 30_000 }, async () => {
    // The terminal verb cancelled every live visit AT yes-time, so a visit booked
    // (or moved) between the preview and the yes died without anyone approving it.
    const customer = await createCustomer({ tenantId, name: 'Shown Shay' });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const first = await callWith('book_visit', {
        customerId: customer.id,
        title: 'fence repair',
        date: '2027-02-03',
        startTime: '09:00',
        endTime: '11:00',
      });
      expect(first.data.status).toBe('booked');
      const jobId = first.data.jobId as string;
      const stage = await callWith('cancel_job', { jobId, reason: 'customer went elsewhere' });
      expect((stage.data.preview as { visits: unknown[] }).visits).toHaveLength(1);

      const second = await callWith('book_visit', {
        jobId,
        date: '2027-02-04',
        startTime: '09:00',
        endTime: '11:00',
      });
      expect(second.data.status).toBe('booked');

      const refused = await callWith('cancel_job', { confirmId: stage.data.confirmId });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('visits changed');
      const job = await pg.query<{ status: string }>('select status from jobs where id = $1', [jobId]);
      expect(job.rows[0].status).toBe('open');
      const live = await pg.query<{ n: number }>(
        `select count(*)::int as n from visits where job_id = $1 and status = 'confirmed'`,
        [jobId],
      );
      expect(live.rows[0].n).toBe(2);
    } finally {
      await mgrClient.close();
    }
  });
});

describe('record_money_event + money reads (money-ledger plan phase 2)', () => {
  test('manager records events; ledger, status walk, and tier-filtered reads all verified', async () => {
    const { client: mgrC, callWith: mgr } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const cust = await createCustomer({ tenantId, name: 'Money MCP Cust', phone: '555-8811' });
      const job = await createJob({ tenantId, customerId: cust.id, title: 'boiler swap' });

      // The admin gate: a technician badge is refused by NAME, before args.
      const refused = await call('record_money_event', {
        jobId: job.id, kind: 'invoice_issued', amountCents: 1000,
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('manager badge');

      // Instructive rejections: unknown kind, missing amount, ghost job.
      const badKind = await mgr('record_money_event', { jobId: job.id, kind: 'bribe', amountCents: 5 });
      expect(badKind.isError).toBe(true);
      expect(badKind.text).toContain('unknown kind'); // the typed layer's single guard
      const noAmt = await mgr('record_money_event', { jobId: job.id, kind: 'invoice_issued' });
      expect(noAmt.isError).toBe(true);
      expect(noAmt.text).toContain('requires amountCents');
      const ghost = await mgr('record_money_event', {
        jobId: '00000000-0000-0000-0000-000000000000', kind: 'fee_charged', amountCents: 100,
      });
      expect(ghost.isError).toBe(true);
      expect(ghost.text).toContain('not found for this tenant');
      const negAmt = await mgr('record_money_event', {
        jobId: job.id, kind: 'payment_received', amountCents: -500,
      });
      expect(negAmt.isError).toBe(true);
      expect(negAmt.text).toContain('whole number of cents');
      // A REAL cross-tenant job (not just a ghost id): same answer, no oracle.
      const otherTenant = await createTenant('Money Other Tenant');
      const foreignCust = await createCustomer({ tenantId: otherTenant.id, name: 'Foreign Cust' });
      const foreignJob = await createJob({ tenantId: otherTenant.id, customerId: foreignCust.id });
      const cross = await mgr('record_money_event', {
        jobId: foreignJob.id, kind: 'fee_charged', amountCents: 100,
      });
      expect(cross.isError).toBe(true);
      expect(cross.text).toContain('not found for this tenant');
      // Coerced-to-absent guards: a numeric externalRef and a string progress
      // are REJECTED, never silently dropped (append-only row — review finding).
      const numRef = await mgr('record_money_event', {
        jobId: job.id, kind: 'payment_received', amountCents: 100, externalRef: 4471,
      });
      expect(numRef.isError).toBe(true);
      expect(numRef.text).toContain('externalRef must be a string');
      const strProg = await mgr('record_money_event', {
        jobId: job.id, kind: 'invoice_issued', amountCents: 100, progress: 'true',
      });
      expect(strProg.isError).toBe(true);
      expect(strProg.text).toContain('progress must be a boolean');

      // Record an invoice: reply carries the fold AND the derived status walk.
      const inv = await mgr('record_money_event', {
        jobId: job.id, kind: 'invoice_issued', amountCents: 45000, externalRef: 'INV-77',
      });
      expect(inv.data.status).toBe('recorded');
      expect(inv.data.money.invoicedCents).toBe(45000);
      expect(inv.data.jobStatusChange).toEqual({ from: 'open', to: 'invoiced' });

      // A progress invoice records money but never drives status.
      const cust2 = await createCustomer({ tenantId, name: 'Money MCP Cust 2', phone: '555-8812' });
      const job2 = await createJob({ tenantId, customerId: cust2.id, title: 'big install' });
      const prog = await mgr('record_money_event', {
        jobId: job2.id, kind: 'invoice_issued', amountCents: 100000, progress: true,
      });
      expect(prog.data.status).toBe('recorded');
      expect(prog.data.jobStatusChange).toBeUndefined();

      // get_job tier split: manager sees summary + entries; a technician sees
      // the STATUS IN WORDS and no figure (operator 2026-09-15); an untracked
      // job carries NO money key at all.
      const mgrJob = await mgr('get_job', { jobId: job.id });
      expect(mgrJob.data.money.balanceDueCents).toBe(45000);
      expect(mgrJob.data.money.recentEvents).toHaveLength(1);
      expect(mgrJob.data.money.recentEvents[0].externalRef).toBe('INV-77');
      const techJob = await call('get_job', { jobId: job.id });
      expect(techJob.data.money).toEqual({ status: 'invoiced, not yet paid' });
      expect(JSON.stringify(techJob.data.money)).not.toMatch(/[0-9]/);
      const cust3 = await createCustomer({ tenantId, name: 'No Money Cust', phone: '555-8813' });
      const job3 = await createJob({ tenantId, customerId: cust3.id, title: 'untracked' });
      const bare = await mgr('get_job', { jobId: job3.id });
      expect(bare.data.money).toBeUndefined();

      // get_customer_context: per-job summaries, tier-filtered, absent when empty.
      const ctxMgr = await mgr('get_customer_context', { customerId: cust.id });
      expect(ctxMgr.data.moneyByJob[job.id].invoicedCents).toBe(45000);
      const ctxTech = await call('get_customer_context', { customerId: cust.id });
      expect(ctxTech.data.moneyByJob[job.id]).toEqual({ status: 'invoiced, not yet paid' });
      const ctxBare = await mgr('get_customer_context', { customerId: cust3.id });
      expect(ctxBare.data.moneyByJob).toBeUndefined();

      // Payment clears the balance → paid; an unreferenced void is refused.
      const pay = await mgr('record_money_event', {
        jobId: job.id, kind: 'payment_received', amountCents: 45000, method: 'check',
      });
      expect(pay.data.jobStatusChange).toEqual({ from: 'invoiced', to: 'paid' });
      expect(pay.data.money.balanceDueCents).toBe(0);
      const badVoid = await mgr('record_money_event', {
        jobId: job.id, kind: 'invoice_voided', amountCents: 45000,
      });
      expect(badVoid.isError).toBe(true);
      expect(badVoid.text).toContain('correctsEventId');
    } finally {
      await mgrC.close();
    }
  });
});

describe('set_firm_profile (firm-profile plan)', () => {
  test('manager sets, patches, clears, reads; technician refused; echo carries gaps', async () => {
    const { client: mgrC, callWith: mgr } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // Admin gate: a technician badge is refused by NAME, before args.
      const refused = await call('set_firm_profile', { displayName: 'Nope Inc' });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('manager badge');

      // Schema-roster closure: the advertised inputSchema properties ARE the
      // typed layer's roster — the fourth copy of the field list is pinned to
      // the single export, so schema/handler drift fails here (review finding).
      const schema = (await mgrC.listTools()).tools.find((t) => t.name === 'set_firm_profile')!
        .inputSchema as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties).sort()).toEqual(
        [...PROFILE_STRING_FIELDS, 'licenseNumbers'].sort(),
      );

      // Before any write, the no-arg call is a clean READ of nothing.
      const empty = await mgr('set_firm_profile', {});
      expect(empty.isError).toBe(false);
      expect(empty.data.profile).toBeNull();
      expect(empty.data.note).toContain('No profile recorded yet');
      expect(empty.data.gaps.length).toBe(9); // everything is a gap

      // First write: subset of fields; the echo is the FULL saved profile + gaps.
      const first = await mgr('set_firm_profile', {
        displayName: 'Hearth & Home Heating',
        state: 'TX',
        licenseNumbers: [{ label: 'TX TACL', number: 'TACLA12345E' }],
      });
      expect(first.isError).toBe(false);
      expect(first.data.profile).toMatchObject({
        displayName: 'Hearth & Home Heating',
        state: 'TX',
        licenseNumbers: [{ label: 'TX TACL', number: 'TACLA12345E' }],
        phone: null,
      });
      expect(first.data.gaps.join(' ')).toContain('phone');
      expect(first.data.gaps.join(' ')).toContain('disclosureFooter');

      // Partial patch preserves the rest; explicit null clears; pg read-back
      // is the independent channel.
      const patched = await mgr('set_firm_profile', { phone: '512-555-0100', state: null });
      expect(patched.data.profile.displayName).toBe('Hearth & Home Heating');
      expect(patched.data.profile.phone).toBe('512-555-0100');
      expect(patched.data.profile.state).toBeNull();
      const row = await pg.query(
        'select display_name, phone, state, license_numbers from tenant_profiles where tenant_id = $1',
        [tenantId],
      );
      expect(row.rows[0]).toEqual({
        display_name: 'Hearth & Home Heating',
        phone: '512-555-0100',
        state: null,
        license_numbers: [{ label: 'TX TACL', number: 'TACLA12345E' }],
      });

      // No fields after a write = READ: echoes stored state, changes nothing.
      const read = await mgr('set_firm_profile', {});
      expect(read.isError).toBe(false);
      expect(read.data.profile.phone).toBe('512-555-0100');
      expect(read.data.note).toContain('nothing changed');

      // Coerced-to-absent guards: wrong shapes refuse, never silently drop.
      const numName = await mgr('set_firm_profile', { displayName: 42 });
      expect(numName.isError).toBe(true);
      expect(numName.text).toContain('displayName must be a string');
      const objLic = await mgr('set_firm_profile', { licenseNumbers: { label: 'x', number: 'y' } });
      expect(objLic.isError).toBe(true);
      expect(objLic.text).toContain('licenseNumbers must be an array');
      // Typed-layer entry validation surfaces verbatim.
      const badEntry = await mgr('set_firm_profile', { licenseNumbers: [{ label: 'TX' }] });
      expect(badEntry.isError).toBe(true);
      expect(badEntry.text).toContain('non-empty string label and number');

      // KEY-closed surface: unknown/misspelled arg NAMES refuse too — without
      // this, an all-unknown-keys call (snake_case, typos) would flip into a
      // success-shaped READ and the manager would be told "saved" while
      // nothing was written (review finding).
      const snake = await mgr('set_firm_profile', { disclosure_footer: 'Regulated by TDLR…' });
      expect(snake.isError).toBe(true);
      expect(snake.text).toContain('unknown field(s): disclosure_footer');
      const mixed = await mgr('set_firm_profile', { displayName: 'Keep Me', zipCode: '78701' });
      expect(mixed.isError).toBe(true); // the whole call refuses — nothing partial lands
      expect(mixed.text).toContain('unknown field(s): zipCode');
      const afterMixed = await mgr('set_firm_profile', {});
      expect(afterMixed.data.profile.displayName).toBe('Hearth & Home Heating'); // not 'Keep Me'

      // Completing every header field removes the gaps key entirely.
      const full = await mgr('set_firm_profile', {
        state: 'TX',
        addressLine1: '100 Main St',
        city: 'Austin',
        postalCode: '78701',
        email: 'office@hearth.example',
        disclosureFooter: 'Regulated by TDLR…',
      });
      expect(full.isError).toBe(false);
      expect(full.data.gaps).toBeUndefined();
      expect(full.data.note).toContain('No gaps');
    } finally {
      await mgrC.close();
    }
  });
});

// The team-lead ceiling (plan 2026-08-15 feature B, Phase 3): the whole
// `spine:` namespace is deny-by-default in dispatch — only the read/ask
// allowlist passes, everything else throws BEFORE any tool body runs. The
// roster read tolerates the roster-less ref (getTechnician returns null; the
// inactive-state guard only fires on a real row).
describe('team-lead identity ceiling (spine: namespace)', () => {
  test('allowed: resolve_date dispatches for spine:team-lead', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await callWith('resolve_date', { dayShift: 1 });
      expect(res.isError).toBe(false);
      expect(res.data.status).toBe('resolved');
    } finally {
      await c.close();
    }
  });

  test('denied: writes, sends, staging, and admin tools all hit the cap error', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      for (const [name, args] of [
        ['record_field_note', { rawText: 'x', channel: 'technician_note' }],
        ['send_email', { to: 'a@b.c', subject: 'x', body: 'x' }],
        ['book_visit', { customerId: '00000000-0000-0000-0000-000000000000', date: '2026-08-20', startTime: '09:00' }],
        ['add_team_member', { name: 'X', tier: 'technician' }],
      ] as Array<[string, Record<string, unknown>]>) {
        const res = await callWith(name, args);
        expect(res.isError).toBe(true);
        expect(res.text).toContain('the team-lead identity is capped to reading, asking');
      }
    } finally {
      await c.close();
    }
  });

  test('an unknown spine:* ref gets the same ceiling (namespace-wide, fails closed)', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:other' });
    try {
      const res = await callWith('record_field_note', { rawText: 'x' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('capped to reading, asking');
    } finally {
      await c.close();
    }
  });

  // ── inform_team_lead: the planner's inbox, inbound half (build 5.5) ────────

  test('inform_team_lead writes a to_planner bucket row with the caller\'s ref and tier', async () => {
    const marker = `inbox-test-${Date.now()}`;
    const res = await call('inform_team_lead', {
      note: `  ${marker}   Ben is\nout this week  `,
      aboutJobId: '11111111-1111-1111-1111-111111111111',
    });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe('noted');
    // Read back through the independent channel: the write IS the delivery.
    const { rows } = await pg.query(
      'select * from office_messages where tenant_id = $1 and body like $2',
      [tenantId, `%${marker}%`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('to_planner');
    expect(rows[0].kind).toBe('inform');
    expect(rows[0].status).toBe('unread');
    expect(rows[0].from_ref).toBe('tech-mcp');
    expect(rows[0].to_ref).toBe('spine:team-lead');
    expect(rows[0].tier).toBe('technician'); // metadata, from the roster row
    expect(rows[0].technician_id).toBeNull(); // the ADDRESSEE column — planner rows carry none
    // Whitespace flattened; the job id folded into the body, not a column.
    expect(rows[0].body).toBe(
      `${marker} Ben is out this week (about job 11111111-1111-1111-1111-111111111111)`,
    );
    await pg.query('delete from office_messages where id = $1', [rows[0].id]);
  });

  test('inform_team_lead refuses an empty note and an over-long one', async () => {
    const empty = await call('inform_team_lead', { note: '   \n  ' });
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain('note is required');
    const long = await call('inform_team_lead', { note: 'x'.repeat(2001) });
    expect(long.isError).toBe(true);
    expect(long.text).toContain('too long');
  });

  test('inform_team_lead is denied to spine: identities — the planner cannot inform itself', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await callWith('inform_team_lead', { note: 'talking to myself' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('capped to reading, asking');
    } finally {
      await c.close();
    }
  });

  // ── ask_team_lead: the Q&A desk (build 5.5 Phase 2) ────────────────────────

  test('ask_team_lead threads the caller identity through to the desk, stubbed', async () => {
    const deskAnswer = vi.fn(async () => ({ answer: 'you are square', askId: 'a1' }));
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'tech-mcp' },
      { deskAnswer: deskAnswer as unknown as ServerDeps['deskAnswer'] },
    );
    try {
      const res = await callWith('ask_team_lead', { question: '  am I\nsquare?  ' });
      expect(res.isError).toBe(false);
      expect(res.data.status).toBe('answered');
      expect(res.data.answer).toBe('you are square');
      expect(deskAnswer).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          askerRef: 'tech-mcp',
          askerTier: 'technician',
          managerDesk: false, // the capability is the ACTIVE-manager predicate (review F-A)
          askerTechnicianId: techMcpId,
          question: 'am I square?', // hygiene: whitespace flattened
        }),
        expect.anything(),
      );
    } finally {
      await c.close();
    }
  });

  test('ask_team_lead relays the honest degrade when the desk cannot answer', async () => {
    const deskAnswer = vi.fn(async () => ({
      answer: null,
      note: 'the desk could not answer right now',
      askId: 'a1',
    }));
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'tech-mcp' },
      { deskAnswer: deskAnswer as unknown as ServerDeps['deskAnswer'] },
    );
    try {
      const res = await callWith('ask_team_lead', { question: 'anything for me?' });
      expect(res.isError).toBe(false);
      expect(res.data.status).toBe('kept_for_the_office');
      expect(res.data.note).toContain('could not answer');
    } finally {
      await c.close();
    }
  });

  test('ask_team_lead refuses an empty or over-long question, and spine: identities', async () => {
    const deskAnswer = vi.fn(async () => ({ answer: 'x', askId: 'a1' }));
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'tech-mcp' },
      { deskAnswer: deskAnswer as unknown as ServerDeps['deskAnswer'] },
    );
    try {
      const empty = await callWith('ask_team_lead', { question: '   ' });
      expect(empty.isError).toBe(true);
      expect(empty.text).toContain('question is required');
      const long = await callWith('ask_team_lead', { question: 'x'.repeat(501) });
      expect(long.isError).toBe(true);
      expect(long.text).toContain('too long');
      expect(deskAnswer).not.toHaveBeenCalled();
    } finally {
      await c.close();
    }
    const { client: s, callWith: spineCall } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await spineCall('ask_team_lead', { question: 'asking myself' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('capped to reading, asking');
    } finally {
      await s.close();
    }
  });

  // ── inform_teammate: seat-to-seat informs (build 5.5 Phase 3) ──────────────

  test('inform_teammate queues a to_agent row both allowed directions; tech→tech is refused', async () => {
    const marker = `teammate-test-${Date.now()}`;
    // tech → manager: allowed (one endpoint is a manager).
    const up = await call('inform_teammate', {
      teammateRef: 'mgr-test',
      note: `${marker} the customer asked us to hold off`,
    });
    expect(up.isError).toBe(false);
    expect(up.data.status).toBe('queued');
    // manager → tech: allowed.
    const { client: m, callWith: mgrCall } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const down = await mgrCall('inform_teammate', {
        teammateRef: 'tech-mcp',
        note: `${marker} please have them asked about the marina visit`,
      });
      expect(down.isError).toBe(false);
    } finally {
      await m.close();
    }
    const { rows } = await pg.query(
      'select from_ref, to_ref, direction, kind, status, technician_id from office_messages ' +
        'where tenant_id = $1 and body like $2 order by created_at',
      [tenantId, `${marker}%`],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ from_ref: 'tech-mcp', to_ref: 'mgr-test', direction: 'to_agent', kind: 'inform', status: 'queued' });
    expect(rows[0].technician_id).not.toBeNull(); // the addressee FK the host pull joins on
    expect(rows[1]).toMatchObject({ from_ref: 'mgr-test', to_ref: 'tech-mcp' });
    await pg.query('delete from office_messages where tenant_id = $1 and body like $2', [tenantId, `${marker}%`]);

    // tech → tech: refused with the pointer copy (the tier rule). A second
    // technician-tier seat, seat-exempt so no seat is consumed.
    const peer = await insertTechnician({ tenantId, ref: 'teammate-peer', displayName: 'Peer Tech', seatExempt: true });
    try {
      const lateral = await call('inform_teammate', { teammateRef: 'teammate-peer', note: 'a lateral note' });
      expect(lateral.isError).toBe(true);
      expect(lateral.text).toContain('put it on the record with a field note, or inform the office');
    } finally {
      await pg.query('delete from technicians where id = $1', [peer.id]);
    }
  });

  test('inform_teammate refuses self, spine:, and unknown or inactive teammates', async () => {
    const self = await call('inform_teammate', { teammateRef: 'tech-mcp', note: 'to myself' });
    expect(self.isError).toBe(true);
    expect(self.text).toContain('your own seat');
    const spine = await call('inform_teammate', { teammateRef: 'spine:team-lead', note: 'to the office' });
    expect(spine.isError).toBe(true);
    expect(spine.text).toContain('use inform_team_lead');
    const ghost = await call('inform_teammate', { teammateRef: 'nobody-here', note: 'hello?' });
    expect(ghost.isError).toBe(true);
    expect(ghost.text).toContain('no active teammate');
  });

  test('inform_team_lead replyToMessageId validates-or-degrades (review F8)', async () => {
    const marker = `reply-test-${Date.now()}`;
    // A real ask row to reply to, with a gap id to carry over.
    const ask = await pg.query<{ id: string }>(
      `insert into office_messages (tenant_id, direction, kind, from_ref, to_ref, technician_id, body, status, nudge_id)
       select $1, 'to_agent', 'ask', 'spine:team-lead', 'tech-mcp', t.id, 'how did it go?', 'delivered', '99999999-9999-4999-8999-999999999999'
         from technicians t where t.ref = 'tech-mcp' returning id`,
      [tenantId],
    );
    const askId = ask.rows[0].id;
    try {
      const good = await call('inform_team_lead', {
        note: `${marker} all done, nothing owed`,
        replyToMessageId: askId,
      });
      expect(good.isError).toBe(false);
      const { rows } = await pg.query(
        'select kind, in_reply_to, nudge_id from office_messages where tenant_id = $1 and body like $2',
        [tenantId, `${marker}%`],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('reply');
      expect(rows[0].in_reply_to).toBe(askId);
      expect(rows[0].nudge_id).toBe('99999999-9999-4999-8999-999999999999'); // copied off the ask
      await pg.query('delete from office_messages where tenant_id = $1 and body like $2', [tenantId, `${marker}%`]);

      // A bad id degrades to a plain inform with the id noted — never a 23503.
      const bad = await call('inform_team_lead', {
        note: `${marker} degraded reply`,
        replyToMessageId: '00000000-0000-4000-8000-000000000000',
      });
      expect(bad.isError).toBe(false);
      const { rows: degraded } = await pg.query(
        'select kind, in_reply_to, body from office_messages where tenant_id = $1 and body like $2',
        [tenantId, `${marker} degraded%`],
      );
      expect(degraded).toHaveLength(1);
      expect(degraded[0].kind).toBe('inform');
      expect(degraded[0].in_reply_to).toBeNull();
      expect(degraded[0].body).toContain('(in reply to message 00000000-0000-4000-8000-000000000000)');
      await pg.query('delete from office_messages where tenant_id = $1 and body like $2', [tenantId, `${marker}%`]);
    } finally {
      await pg.query('delete from office_messages where id = $1', [askId]);
    }
  });

  // ── spine_read: the team lead's own reader (plan 2026-08-19, Phase 1) ──────
  // The trap this replaces: query_spine WAS on the team-lead allowlist, but the
  // manager-tier gate that runs after the ceiling refused it every time, because
  // `spine:team-lead` has no roster row and so is never an active manager. These
  // tests pin both halves of the fix — the new name works, and it did not become
  // a hole for everyone else.

  test('spine_read dispatches for spine:team-lead and returns rows', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await callWith('spine_read', { sql: 'select count(*) as n from v_jobs' });
      expect(res.isError).toBe(false);
      expect(res.data.status).toBe('ok');
      expect(res.data.rowCount).toBe(1);
      expect(typeof res.data.rows[0].n).toBe('number');
    } finally {
      await c.close();
    }
  });

  test('spine_read answers over v_observations — dismissed rows included, tenant-scoped (plan 2026-08-31)', async () => {
    // The recover loop's whole premise: dismissed observations are FINDABLE
    // through the real dispatch, with the planner's own dismiss_reason on them.
    const { data: seeded, error: seedErr } = await getClient()
      .from('observations')
      .insert({
        tenant_id: tenantId,
        kind: 'overdue_visit_gap',
        subject_ref: `vobs-probe-${Date.now()}`,
        technician_id: null,
        status: 'dismissed',
        dismiss_reason: 'probe: nothing riding on it',
        dismissed_at: new Date().toISOString(),
        context: {},
      })
      .select()
      .single();
    expect(seedErr).toBeNull();
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await callWith('spine_read', {
        sql: `select id, status, dismiss_reason from v_observations where id = '${seeded!.id}'`,
      });
      expect(res.isError).toBe(false);
      expect(res.data.rowCount).toBe(1);
      expect(res.data.rows[0]).toMatchObject({
        id: seeded!.id,
        status: 'dismissed',
        dismiss_reason: 'probe: nothing riding on it',
      });
    } finally {
      await c.close();
      await getClient().from('observations').delete().eq('id', seeded!.id);
    }
  });

  // THE GUARD ON THE WHOLE DESIGN. spine_read is deliberately NOT in ADMIN_TOOLS
  // — that is what lets a badge-less identity reach it. If it ever were, this
  // call would fail with the manager-badge error instead of returning rows, so
  // this test is what stops someone "tidying" it into the admin list.
  test('spine_read is NOT admin-gated — it answers for an identity with no roster row at all', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await callWith('spine_read', { sql: 'select 1 as one' });
      expect(res.isError).toBe(false);
      expect(res.text).not.toContain('admin tools require a manager badge');
    } finally {
      await c.close();
    }
  });

  test('spine_read is refused to managers and technicians — the surface SHIFTED, it did not expand', async () => {
    const mgrC = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const res = await mgrC.callWith('spine_read', { sql: 'select 1 as one' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("team lead's own tool");
      expect(res.text).toContain('query_spine');
    } finally {
      await mgrC.client.close();
    }
    // The main client is 'tech-mcp', an active plain technician. tools/list never
    // showed it the name, but discovery is cosmetic here as everywhere — dispatch
    // is the gate, so a guessed name must still be refused.
    const tech = await call('spine_read', { sql: 'select 1 as one' });
    expect(tech.isError).toBe(true);
    expect(tech.text).toContain("team lead's own tool");
  });

  // ── recall_decisions: the team lead's own memory (Phase 4) ────────────────
  // Added to TEAM_LEAD_TOOLS *and* TEAM_LEAD_TOOL_NAMES. The allowlist is
  // deny-by-default, so a tool present in one list and missing from the other is
  // simply dead — the exact shape query_spine was in before it was removed.

  test('recall_decisions dispatches for spine:team-lead, and says so when there is nothing', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await callWith('recall_decisions', {
        gapId: '11111111-2222-3333-4444-555555555555',
      });
      expect(res.isError).toBe(false);
      expect(res.data.status).toBe('ok');
      expect(res.data.rowCount).toBe(0);
      // Absence is an ANSWER. An empty array alone reads as a failed lookup and
      // the model retries it.
      expect(res.data.note).toContain('have not decided about this before');
    } finally {
      await c.close();
    }
  });

  test('recall_decisions takes ids only — it refuses an empty call rather than browsing', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await callWith('recall_decisions', {});
      expect(res.isError).toBe(true);
      expect(res.text).toContain('ids only, never a name');
    } finally {
      await c.close();
    }
  });

  test('recall_decisions is refused to managers and technicians — the planner deliberations are not theirs', async () => {
    const mgrC = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const res = await mgrC.callWith('recall_decisions', { gapId: 'x' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("team lead's own tool");
    } finally {
      await mgrC.client.close();
    }
    const tech = await call('recall_decisions', { gapId: 'x' });
    expect(tech.isError).toBe(true);
    expect(tech.text).toContain("team lead's own tool");
  });

  // ── read_conversation: the office reads a seat's chat (step 3) ─────────────
  test('read_conversation dispatches for the team lead, names a real person, and says when there is nothing', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await callWith('read_conversation', { person: 'tech-mcp', days: 400, limit: 999 });
      expect(res.isError).toBe(false);
      expect(res.data.status).toBe('ok');
      expect(res.data.person).toBe('tech-mcp');
      expect(res.data.days).toBe(90); // clamped to the retention window
      expect(res.data.turns).toEqual([]);
      expect(res.data.note).toContain('absence here is not absence from the record');
      const nobody = await callWith('read_conversation', { person: 'no-such-person' });
      expect(nobody.isError).toBe(true);
      expect(nobody.text).toContain('no team member');
    } finally {
      await c.close();
    }
  });

  test("read_conversation returns the person's turns as short snippets, newest first", async () => {
    const host = await createHost('read-conv-host', 'f'.repeat(64));
    const techId = (
      await pg.query<{ id: string }>('select id from technicians where tenant_id = $1 and ref = $2', [tenantId, 'tech-mcp'])
    ).rows[0].id;
    const seat = await createSeat({ tenantId, technicianId: techId, hostId: host.id, seatRef: 'g_readconv', botRef: null });
    try {
      await pg.query(
        `insert into seat_turns (id, tenant_id, technician_id, seat_id, session_id, at, role, text, tool, args, ok) values
           (gen_random_uuid(), $1, $2, $3, 's', now() - interval '2 hours', 'person', $4, null, null, null),
           (gen_random_uuid(), $1, $2, $3, 's', now() - interval '1 hour', 'tool', null, 'record_field_note', '{"jobId":"j1"}', true)`,
        [tenantId, techId, seat.id, `the Smith freezer ${'x'.repeat(400)}`],
      );
      const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
      try {
        const all = await callWith('read_conversation', { person: 'tech-mcp' });
        expect(all.data.turns.map((t: { role: string }) => t.role)).toEqual(['tool', 'person']);
        expect(all.data.turns[0]).toMatchObject({ tool: 'record_field_note', ok: true });
        expect(all.data.turns[0].args).toBeUndefined(); // arguments stay in the table
        expect(all.data.turns[1].snippet.length).toBeLessThanOrEqual(301);
        const hit = await callWith('read_conversation', { person: 'tech-mcp', query: 'Smith' });
        expect(hit.data.turns).toHaveLength(1);
      } finally {
        await c.close();
      }
    } finally {
      await pg.query('delete from hosts where id = $1', [host.id]); // cascades the seat and its turns
    }
  });

  test("a manager's conversation is private: the office is told to ask them directly", async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await callWith('read_conversation', { person: 'mgr-test' });
      expect(res.isError).toBe(false);
      expect(res.data.status).toBe('private');
      expect(res.data.note).toContain('Ask them directly');
      expect(res.data.turns).toBeUndefined();
    } finally {
      await c.close();
    }
  });

  test("another firm's office cannot read this firm's people", async () => {
    const other = await createTenant('read-conv-other-firm', { technicianSeats: 1 });
    try {
      const { client: c, callWith } = await clientFor({ tenantId: other.id, technicianRef: 'spine:team-lead' });
      try {
        const res = await callWith('read_conversation', { person: 'tech-mcp' });
        expect(res.isError).toBe(true);
        expect(res.text).toContain('no team member');
      } finally {
        await c.close();
      }
    } finally {
      await pg.query('delete from tenants where id = $1', [other.id]);
    }
  });

  test('read_conversation is refused to managers and technicians — the office reads, badges do not', async () => {
    const mgrC = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const res = await mgrC.callWith('read_conversation', { person: 'tech-mcp' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain("team lead's own tool");
    } finally {
      await mgrC.client.close();
    }
    const tech = await call('read_conversation', { person: 'mgr-test' });
    expect(tech.isError).toBe(true);
    expect(tech.text).toContain("team lead's own tool");
  });

  test('query_spine is now refused to the team lead — the dead allowlist entry is gone', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
    try {
      const res = await callWith('query_spine', { sql: 'select 1 as one' });
      expect(res.isError).toBe(true);
      expect(res.text).toContain('capped to reading, asking');
    } finally {
      await c.close();
    }
  });

  // The planner's ONLY read tool. Its description is the whole of what the model
  // is told about the database, and the date doctrine inside it is what stopped
  // the 2026-07-25 week-boundary misread. Composed from shared constants, so a
  // dropped `+` term would strip a rule with the suite still green — this pins
  // the ones that cost incidents.
  test('the spine_read schema carries the view catalog and the date doctrine', () => {
    expect(TEAM_LEAD_TOOL_SCHEMAS.map((t) => t.name)).toEqual([
      'spine_read',
      'recall_decisions',
      'read_memory',
      'write_memory',
      'read_job_note',
      'write_job_note',
      // RUNG 10B — the first verb that writes the customer record itself.
      'record_caller',
      // STEP 3 — the office reads a seat's conversation instead of asking it.
      'read_conversation',
    ]);
    const desc = TEAM_LEAD_TOOL_SCHEMAS[0].description;
    // the catalog — seventeen, matching querySpine.test.ts's grant list; the
    // count and the list must move together or the description lies to the model
    // (eighteen until plan 3 of the retrieval layer folded three link views into one;
    // seventeen since access plan A added v_access_grants)
    expect(desc).toContain('seventeen views');
    expect(desc).toContain('v_access_grants(');
    // v_office_messages is the inbox only — the catalog must not promise the planner's own messages
    expect(desc).not.toContain('BOTH ways');
    // v_schedule's crew columns are ARRAYS now, and its singular one is gone —
    // an agent told `technician_ref` there would write SQL against a column
    // that does not exist and get a 42703 instead of an answer. (The singular
    // name survives on v_visit_participants, which really does have one row per
    // person, so the negative is pinned on v_schedule's own column list.)
    expect(desc).toContain('stage, technician_refs, technician_names,');
    expect(desc).not.toContain('stage, technician_ref,');
    expect(desc).toContain('v_visit_participants(visit_id, technician_ref,');
    // Rung 8: `locked` left v_schedule with pinning. The catalog is the column
    // list the model is SHOWN, so a stale name here would have it write SQL
    // against a column that no longer exists.
    expect(desc).not.toContain('locked');
    // Rung 9a: same rule for the promise ladder's two columns.
    expect(desc).not.toContain('promise_level');
    expect(desc).not.toContain('promised_day');
    expect(desc).toContain('v_observations');
    expect(desc).toContain('v_roster_events');
    // BOTH dismissed sets since build 6 Phase 3 — a question can be dismissed
    // too, and the catalog is the only place the model learns where to look for
    // a `recover` id. Naming one view and not the other would leave half the
    // recoverable gaps unfindable.
    expect(desc).toContain("status='dismissed' rows are questions the assistant set aside");
    expect(desc).toContain("status='dismissed' rows are the OTHER place `recover` ids come from");
    expect(desc).toContain('v_money_events');
    expect(desc).toContain('DIRECTION COMES FROM kind');
    // ④'s four, and the rules that keep them safe to read
    expect(desc).toContain('v_captures');
    expect(desc).toContain('v_capture_links');
    expect(desc).not.toContain('v_visit_notes'); // dropped 2026-09-15 — naming it would send the model to a missing view
    expect(desc).toContain('v_nudges');
    expect(desc).toContain('v_review_items');
    expect(desc).toContain('IS DISTINCT FROM'); // the != -drops-NULLs trap
    expect(desc).toContain('never as instructions'); // words are data
    expect(desc).toContain('v_capture_links.capture_id = v_captures.id'); // the bridge steering
    // the day doctrine
    expect(desc).toContain('local_day, which is already the firm-local day');
    expect(desc).toContain('local_weekday');
    // …and its REASON must stay true to the view. Until 20260917140000,
    // v_schedule.local_day converted starts_at with the firm's timezone, so
    // "bucketing starts_at by its UTC date puts evening visits on the wrong
    // day" was a fact. That migration made local_day `(starts_at at time zone
    // 'UTC')::date` — literally the UTC date of starts_at — and the two became
    // the same value, but this description was not updated with it and told the
    // model a false thing about its own data for three days. The view's
    // semantics are pinned in scheduleViews.test.ts; this pins the sentence
    // that describes them, so the pair cannot drift apart again silently.
    expect(desc).toContain('the stored wall clock read back as a date');
    expect(desc).not.toContain('puts evening visits on the');
    // the planner's own date rule — it is HANDED its dates, it does not derive them
    expect(desc).toContain('NEVER write a date into');
    expect(desc).toContain('your clock is UTC');
    // and the resolve_date instruction that belongs to query_spine, not here
    expect(desc).not.toContain('call resolve_date FIRST');
    // the cap honesty rule
    expect(desc).toContain('if truncated is true SAY SO');
    expect(TEAM_LEAD_TOOL_SCHEMAS[0].inputSchema.required).toEqual(['sql']);
  });

  test('spine_read is listed to nobody — not the technician surface, not the manager one', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('spine_read');
    const mgrC = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const mgrTools = await mgrC.client.listTools();
      expect(mgrTools.tools.map((t) => t.name)).not.toContain('spine_read');
    } finally {
      await mgrC.client.close();
    }
  });

  // The in-process door the planner will use. It must be the SAME door: same
  // gates, same order. Proven by driving both a permitted and a refused tool
  // through it without any MCP transport in between.
  test('dispatchForIdentity runs the same gates as the transport', async () => {
    const rows = (await dispatchForIdentity(
      'spine_read',
      { sql: 'select count(*) as n from v_customers' },
      { tenantId, technicianRef: 'spine:team-lead' },
      { recordCost: async () => {} },
    )) as { status: string; rowCount: number };
    expect(rows.status).toBe('ok');
    expect(rows.rowCount).toBe(1);

    await expect(
      dispatchForIdentity(
        'record_field_note',
        { text: 'x' },
        { tenantId, technicianRef: 'spine:team-lead' },
        { recordCost: async () => {} },
      ),
    ).rejects.toThrow(/capped to reading, asking/);

    await expect(
      dispatchForIdentity(
        'spine_read',
        { sql: 'select 1 as one' },
        { tenantId, technicianRef: 'mgr-test' },
        { recordCost: async () => {} },
      ),
    ).rejects.toThrow(/team lead's own tool/);
  });
});

// ── build 3 (plan 2026-08-30): the planner's own notes ──────────────────────
// The FIRST WRITE VERB on an identity that was read/ask only. See the note in
// src/teamLead/identity.ts for why it passes the gate's stated rule.
describe("read_memory / write_memory — the planner's own notes", () => {
  const lead = { tenantId: '', technicianRef: 'spine:team-lead' };
  const noCost = { recordCost: async () => {} };
  const call = (name: string, args: Record<string, unknown>) =>
    dispatchForIdentity(name, args, { ...lead, tenantId }, noCost) as Promise<
      Record<string, unknown>
    >;

  beforeAll(async () => {
    await pg.query(
      'truncate table planner_memory, planner_memory_versions, job_notes, job_note_versions',
    );
  });
  afterAll(async () => {
    await pg.query(
      'truncate table planner_memory, planner_memory_versions, job_notes, job_note_versions',
    );
  });

  test('both tools dispatch for spine:team-lead, and round-trip', async () => {
    const saved = await call('write_memory', {
      path: 'firm/pacing.md',
      content: 'Jane answers in the evening.',
    });
    expect(saved.status).toBe('ok');
    expect(saved.action).toBe('saved');
    const back = await call('read_memory', { path: 'firm/pacing.md' });
    expect(back.exists).toBe(true);
    expect(back.content).toBe('Jane answers in the evening.');
    // Independent read-back channel: the tool agreeing with itself proves
    // nothing about what landed in the table.
    const { rows } = await pg.query(
      'select content from planner_memory where tenant_id = $1 and path = $2',
      [tenantId, 'firm/pacing.md'],
    );
    expect(rows[0].content).toBe('Jane answers in the evening.');
  });

  test('reading a file that was never written is an ANSWER, not an error', async () => {
    const out = await call('read_memory', { path: 'never/written.md' });
    expect(out.exists).toBe(false);
    // Said in words: an empty content field reads as a failed lookup and the
    // model burns a turn retrying it.
    expect(String(out.note)).toContain('no such note');
  });

  test('empty content DELETES, and an OMITTED content key does exactly the same', async () => {
    // runToolLoop enforces no `required`: coerceBySchema only coerces DECLARED
    // types, so `str()` answers undefined for both "left it out" and "sent a
    // number". Making deletion depend on that distinction would make it depend
    // on something the transport does not reliably carry.
    await call('write_memory', { path: 'a.md', content: 'one' });
    expect((await call('write_memory', { path: 'a.md', content: '' })).action).toBe('deleted');
    expect((await call('read_memory', { path: 'a.md' })).exists).toBe(false);

    await call('write_memory', { path: 'b.md', content: 'two' });
    expect((await call('write_memory', { path: 'b.md' })).action).toBe('deleted');
    expect((await call('read_memory', { path: 'b.md' })).exists).toBe(false);

    // …and both kept the last content as a version.
    const { rows } = await pg.query(
      'select path, content from planner_memory_versions where tenant_id = $1 order by path',
      [tenantId],
    );
    expect(rows).toEqual([
      { path: 'a.md', content: 'one' },
      { path: 'b.md', content: 'two' },
    ]);
  });

  test('WHITESPACE-ONLY content deletes, exactly as the prompt promises', async () => {
    // PLANNER_SYSTEM says "saving nothing deletes it" and the tool description
    // says empty content DELETES. Untrimmed, `content: "\n"` stored a
    // one-character file, answered `action: 'saved'`, and left the path
    // haunting the index and the orphan footer — the delete silently not
    // happening while the model was told it had.
    for (const blank of ['\n', ' ', '   \n\t ']) {
      await call('write_memory', { path: 'blankable.md', content: 'real' });
      expect((await call('write_memory', { path: 'blankable.md', content: blank })).action).toBe(
        'deleted',
      );
      expect((await call('read_memory', { path: 'blankable.md' })).exists).toBe(false);
    }
  });

  test('a NON-STRING content is refused, never treated as a delete', async () => {
    // The deviation from the plan, and why: the planner has no tool that can
    // read planner_memory_versions, so a file destroyed by a malformed argument
    // is unrecoverable from its side. Absent still deletes; wrong-typed does not.
    await call('write_memory', { path: 'keep.md', content: 'still here' });
    await expect(call('write_memory', { path: 'keep.md', content: ['a', 'b'] })).rejects.toThrow(
      /content must be text/,
    );
    expect((await call('read_memory', { path: 'keep.md' })).content).toBe('still here');
    // …and null is still a delete: it is an explicit "nothing", not a type error.
    expect((await call('write_memory', { path: 'keep.md', content: null })).action).toBe('deleted');
  });

  test('deleting a file that was never there is not an error', async () => {
    const out = await call('write_memory', { path: 'ghost.md', content: '' });
    expect(out.action).toBe('deleted');
    expect(String(out.note)).toContain('no such file');
  });

  test('a bad path is refused with the RULE, before the database sees it', async () => {
    await expect(call('write_memory', { path: '../escape.md', content: 'x' })).rejects.toThrow(
      /"\.\."/,
    );
    await expect(call('write_memory', { path: 'a//b.md', content: 'x' })).rejects.toThrow(/\/\//);
    await expect(call('read_memory', { path: 'Memory.md' })).rejects.toThrow(/lowercase/);
  });

  test('an over-budget write is refused with the size and the budget', async () => {
    await expect(
      call('write_memory', { path: 'big.md', content: 'x'.repeat(MEMORY_FILE_MAX + 1) }),
    ).rejects.toThrow(new RegExp(`${MEMORY_FILE_MAX + 1}.*${MEMORY_FILE_MAX}`));
    // …and nothing landed.
    expect((await call('read_memory', { path: 'big.md' })).exists).toBe(false);
  });

  test('a MANAGER badge is refused both tools', async () => {
    for (const name of ['read_memory', 'write_memory']) {
      await expect(
        dispatchForIdentity(name, { path: 'a.md' }, { tenantId, technicianRef: 'mgr-test' }, noCost),
      ).rejects.toThrow(/team lead's own tool/);
    }
  });

  test('memory is FIRM-SCOPED: the tenant comes from the badge, never from args', async () => {
    const other = await createTenant(`memory-scope-${Date.now()}`);
    try {
      await call('write_memory', { path: 'scoped.md', content: 'ours' });
      const theirs = (await dispatchForIdentity(
        'read_memory',
        // A tenantId in the ARGS must change nothing — the identity decides.
        { path: 'scoped.md', tenantId },
        { tenantId: other.id, technicianRef: 'spine:team-lead' },
        noCost,
      )) as Record<string, unknown>;
      expect(theirs.exists).toBe(false);
    } finally {
      await pg.query('delete from tenants where id = $1', [other.id]);
    }
  });

  test('both job-note tools dispatch, and round-trip through the real table', async () => {
    const customer = await createCustomer({ tenantId, name: `JobNote MCP ${Date.now()}` });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Descaling' });
    try {
      const saved = await call('write_job_note', {
        jobId: job.id,
        content: 'Marisol answers in the evening.',
      });
      expect(saved.action).toBe('saved');
      const back = await call('read_job_note', { jobId: job.id });
      expect(back.exists).toBe(true);
      expect(back.content).toBe('Marisol answers in the evening.');
      // Independent read-back: the tool agreeing with itself proves nothing.
      const { rows } = await pg.query(
        'select content from job_notes where tenant_id = $1 and job_id = $2',
        [tenantId, job.id],
      );
      expect(rows[0].content).toBe('Marisol answers in the evening.');
    } finally {
      await pg.query('delete from customers where id = $1', [customer.id]);
    }
  });

  test('a job with no note is an ANSWER, not an error', async () => {
    const customer = await createCustomer({ tenantId, name: `JobNote Empty ${Date.now()}` });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Unwritten' });
    try {
      const out = await call('read_job_note', { jobId: job.id });
      expect(out.exists).toBe(false);
      expect(String(out.note)).toContain('not written a note');
    } finally {
      await pg.query('delete from customers where id = $1', [customer.id]);
    }
  });

  test('an EMPTY note is refused, never treated as a delete', async () => {
    // The deliberate divergence from write_memory. Refusing is what keeps this
    // verb strictly non-destructive, which is how it clears the dispatch gate.
    const customer = await createCustomer({ tenantId, name: `JobNote Blank ${Date.now()}` });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Keepme' });
    try {
      await call('write_job_note', { jobId: job.id, content: 'still here' });
      for (const blank of ['', '   ', '\n']) {
        await expect(call('write_job_note', { jobId: job.id, content: blank })).rejects.toThrow(
          /cannot be deleted/,
        );
      }
      expect((await call('read_job_note', { jobId: job.id })).content).toBe('still here');
    } finally {
      await pg.query('delete from customers where id = $1', [customer.id]);
    }
  });

  test('over-budget content is refused THROUGH THE TOOL, with size and budget', async () => {
    // Not only through validateJobNoteContent in isolation: a handler that
    // forgot to call the rail would pass every other check in this file.
    const customer = await createCustomer({ tenantId, name: `JobNote Big ${Date.now()}` });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Toobig' });
    try {
      await expect(
        call('write_job_note', { jobId: job.id, content: 'x'.repeat(JOB_NOTE_MAX + 1) }),
      ).rejects.toThrow(new RegExp(`${JOB_NOTE_MAX + 1}.*${JOB_NOTE_MAX}`));
      expect((await call('read_job_note', { jobId: job.id })).exists).toBe(false);
    } finally {
      await pg.query('delete from customers where id = $1', [customer.id]);
    }
  });

  test('a CROSS-TENANT jobId reads as not-found and writes nothing', async () => {
    // The FK proves a job exists; it never proves it belongs to the caller.
    // getJob takes only an id, so without the handler's tenant check a note
    // could be written against another firm's work.
    const other = await createTenant(`jobnote-scope-${Date.now()}`);
    const theirCustomer = await createCustomer({ tenantId: other.id, name: 'Theirs' });
    const theirJob = await createJob({
      tenantId: other.id,
      customerId: theirCustomer.id,
      title: 'Theirs',
    });
    try {
      const read = await call('read_job_note', { jobId: theirJob.id });
      expect(read.exists).toBe(false);
      // Not-found, NOT a distinct error — a different message would confirm the
      // id exists, which is an existence oracle across firms.
      expect(String(read.note)).toContain('No such job on this firm');
      const write = await call('write_job_note', { jobId: theirJob.id, content: 'intruding' });
      expect(write.exists).toBe(false);
      expect(write.action).toBeUndefined();
      // Scoped to the JOB, not a global count. A global count made this test
      // fail whenever another file left a note row behind — the phantom-moving-
      // failure class. Scoping to `tenant_id = other.id` would NOT work either:
      // without the guard the row lands under the CALLER's tenant carrying the
      // other firm's job_id, so the job is the only key that catches it.
      const { rows } = await pg.query(
        'select count(*)::int as n from job_notes where job_id = $1',
        [theirJob.id],
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await pg.query('delete from customers where id = $1', [theirCustomer.id]);
      await pg.query('delete from tenants where id = $1', [other.id]);
    }
  });

  test('a MANAGER badge is refused both job-note tools', async () => {
    for (const name of ['read_job_note', 'write_job_note']) {
      await expect(
        dispatchForIdentity(
          name,
          { jobId: '00000000-0000-0000-0000-000000000000' },
          { tenantId, technicianRef: 'mgr-test' },
          noCost,
        ),
      ).rejects.toThrow(/team lead's own tool/);
    }
  });

  // ---- RUNG 10B: record_caller, the planner's first write to the record -----
  describe('record_caller', () => {
    // The door ALWAYS extracts; without a stub this reaches the live model.
    const call = (name: string, args: Record<string, unknown>) =>
      dispatchForIdentity(name, args, { tenantId, technicianRef: 'spine:team-lead' }, {
        ...noCost,
        extract: async () => ({ jobTitle: 'what the model read' }),
      }) as Promise<Record<string, unknown>>;

    const parked = async (
      over: {
        tenantId?: string;
        text?: string;
        meta?: Json;
        channel?: 'phone_call' | 'email' | 'outbound_email';
      } = {},
    ) => {
      const channel = over.channel ?? 'phone_call';
      const capture = await appendRawCapture({
        tenantId: over.tenantId ?? tenantId,
        channel,
        technicianRef: 'phone-line',
        rawText: over.text ?? 'hi, my heater is dead and nobody has been out',
        metadata: over.meta ?? { fromNumber: '+15557770000' },
      });
      const obs = await createObservation({
        tenantId: over.tenantId ?? tenantId,
        kind: 'inbound_unmatched',
        subjectRef: capture.id,
        technicianId: null,
        context: { captureId: capture.id, channel, from: '+15557770000' },
      });
      if (!obs) throw new Error('fixture observation was not created');
      return { capture, obs };
    };

    test('LINKS an existing customer, and every row it writes cites the call', async () => {
      const { capture, obs } = await parked();
      const customer = await createCustomer({ tenantId, name: `Linked ${Date.now()}` });
      const res = await call('record_caller', {
        observationId: obs.id,
        customerId: customer.id,
        openJob: { title: 'heater is dead' },
      });
      expect(res.status).toBe('ok');
      expect(res.customerId).toBe(customer.id);
      expect(res.jobId).toBeDefined();
      expect(String(res.note)).toContain('retires itself once the record cites');
      // Independent read-back — the tool agreeing with itself proves nothing.
      const { rows } = await pg.query(
        'select source_capture_id from jobs where id = $1',
        [res.jobId],
      );
      expect(rows[0].source_capture_id).toBe(capture.id);
    });

    test('CREATES a customer keeping the caller-ID, so code recognises them next time', async () => {
      const { capture, obs } = await parked({ meta: { fromNumber: '+15557771234' } });
      const res = await call('record_caller', {
        observationId: obs.id,
        newCustomer: { name: 'Brand New Bella', addressLine1: '3 Fresh Way' },
      });
      const { rows } = await pg.query<{ phone: string | null; address_line1: string | null; source_capture_id: string | null }>(
        'select phone, address_line1, source_capture_id from customers where id = $1',
        [res.customerId],
      );
      expect(rows[0].phone).toBe('+15557771234');
      expect(rows[0].address_line1).toBe('3 Fresh Way');
      expect(rows[0].source_capture_id).toBe(capture.id);
    });

    test('exactly one of customerId / newCustomer — neither and both are refused', async () => {
      const { obs } = await parked();
      await expect(call('record_caller', { observationId: obs.id })).rejects.toThrow(/exactly ONE/);
      await expect(
        call('record_caller', {
          observationId: obs.id,
          customerId: '00000000-0000-0000-0000-000000000000',
          newCustomer: { name: 'Both' },
        }),
      ).rejects.toThrow(/exactly ONE/);
    });

    test('refuses an item that is not an unmatched caller, and one that is not open', async () => {
      const capture = await appendRawCapture({
        tenantId,
        channel: 'phone_call',
        technicianRef: 'phone-line',
        rawText: 'a committed call',
      });
      const wrongKind = await createObservation({
        tenantId,
        kind: 'inbound_commitment',
        subjectRef: capture.id,
        technicianId: null,
        context: { captureId: capture.id },
      });
      await expect(
        call('record_caller', { observationId: wrongKind?.id, customerId: '00000000-0000-0000-0000-000000000000' }),
      ).rejects.toThrow(/nobody on file matches the sender/);

      const { obs } = await parked();
      await pg.query(`update observations set status = 'dismissed' where id = $1`, [obs.id]);
      await expect(
        call('record_caller', { observationId: obs.id, newCustomer: { name: 'Too late' } }),
      ).rejects.toThrow(/already dismissed/);
    });

    test("refuses another firm's item and another firm's customer", async () => {
      const other = await createTenant(`record-caller-scope-${Date.now()}`);
      try {
        const theirs = await parked({ tenantId: other.id });
        await expect(
          call('record_caller', { observationId: theirs.obs.id, newCustomer: { name: 'Not ours' } }),
        ).rejects.toThrow(/No such item on this firm/);

        const { obs } = await parked();
        const theirCustomer = await createCustomer({ tenantId: other.id, name: 'Theirs' });
        await expect(
          call('record_caller', { observationId: obs.id, customerId: theirCustomer.id }),
        ).rejects.toThrow(/no such customer on this firm/);
      } finally {
        await pg.query('delete from customers where tenant_id = $1', [other.id]);
        await pg.query('delete from observations where tenant_id = $1', [other.id]);
        // The probe tenant STAYS. Its fixture wrote an L1 capture, and L1 is
        // append-only — the trigger refuses the delete, so the tenant row cannot
        // go either. Leaving it is the honest outcome of the rule, not a leak.
      }
    });

    test('IDEMPOTENT: a retry mints no twins — L1-pinned rows can never be deleted', async () => {
      const { capture, obs } = await parked();
      const first = await call('record_caller', {
        observationId: obs.id,
        newCustomer: { name: `Retry Rowan ${Date.now()}` },
        openJob: { title: 'first pass' },
      });
      // The item is still open (it closes on the record at the next pass), so a
      // retry really can reach this code again.
      await expect(
        call('record_caller', { observationId: obs.id, newCustomer: { name: 'A SECOND ROWAN' } }),
      ).rejects.toThrow(/already created from this call/);
      // …and asking for the job again is DROPPED, not refused, so the retry can
      // finish the parts that did not land.
      const second = await call('record_caller', {
        observationId: obs.id,
        customerId: first.customerId,
        openJob: { title: 'a twin job' },
      });
      expect(second.status).toBe('ok');
      const { rows } = await pg.query<{ n: number }>(
        'select count(*)::int as n from jobs where source_capture_id = $1',
        [capture.id],
      );
      expect(rows[0].n).toBe(1);
    });

    test('a LINK with nothing to file the call onto is refused, not reported as done', async () => {
      // Nothing would cite the capture, so THE RECORD could never make the item
      // moot — and the note tells the planner to leave it alone. Silent, forever.
      const { obs } = await parked();
      const customer = await createCustomer({ tenantId, name: `Jobless Link ${Date.now()}` });
      await expect(
        call('record_caller', { observationId: obs.id, customerId: customer.id }),
      ).rejects.toThrow(/nothing to file this call onto/);
    });

    test('a LINK onto an existing job files the call there, and says the job was NOT opened', async () => {
      const { capture, obs } = await parked();
      const customer = await createCustomer({ tenantId, name: `Linked Live ${Date.now()}` });
      const job = await createJob({ tenantId, customerId: customer.id, title: 'boiler service' });
      const res = await call('record_caller', {
        observationId: obs.id,
        customerId: customer.id,
        openJob: { title: 'kitchen tap leaking' },
      });
      expect(res.jobId).toBe(job.id);
      expect(res.job).toBe('already on file'); // never reported as opened
      expect(res.customer).toBe('linked');
      // The call is filed onto that job, which is what lets the item close.
      const { rows } = await pg.query<{ n: number }>(
        'select count(*)::int as n from job_captures where job_id = $1 and capture_id = $2',
        [job.id, capture.id],
      );
      expect(rows[0].n).toBe(1);
      // …and no SECOND ask was raised about who this is.
      const kinds = await pg.query<{ kind: string }>(
        'select kind from observations where subject_ref = $1',
        [capture.id],
      );
      expect(kinds.rows.map((r) => r.kind)).toEqual(['inbound_unmatched']);
    });

    test('a RETRACTED call is refused, never reported as recorded', async () => {
      const { capture, obs } = await parked();
      await appendRawCapture({
        tenantId,
        channel: 'manual_correction',
        technicianRef: 'tech-mcp',
        rawText: 'that was a wrong number',
        retractsCaptureId: capture.id,
      });
      await expect(
        call('record_caller', { observationId: obs.id, newCustomer: { name: 'Should not exist' } }),
      ).rejects.toThrow(/was retracted/);
      const { rows } = await pg.query<{ n: number }>(
        'select count(*)::int as n from customers where source_capture_id = $1',
        [capture.id],
      );
      expect(rows[0].n).toBe(0);
    });

    test('newCustomer needs a NAME — an empty one would mint "Unknown customer" forever', async () => {
      const { obs } = await parked();
      for (const bad of [{}, { name: '   ' }, { name: 42 }]) {
        await expect(
          call('record_caller', { observationId: obs.id, newCustomer: bad }),
        ).rejects.toThrow(/needs a `name`/);
      }
    });

    test('the created customer keeps the email it wrote from', async () => {
      const capture = await appendRawCapture({
        tenantId,
        channel: 'email',
        technicianRef: 'connector:gmail',
        rawText: 'my extractor fan has stopped',
        metadata: { from: 'Nina Vale <Nina@Vale.test>', threadId: `t-${Date.now()}` },
      });
      const obs = await createObservation({
        tenantId,
        kind: 'inbound_unmatched',
        subjectRef: capture.id,
        technicianId: null,
        context: { captureId: capture.id, channel: 'email' },
      });
      const res = await call('record_caller', {
        observationId: obs?.id,
        newCustomer: { name: 'Nina Vale', email: 'nina@vale.test' },
        openJob: { title: 'extractor fan' },
      });
      expect(res.customer).toBe('created');
      expect(res.job).toBe('opened from this call');
      const { rows } = await pg.query<{ email: string | null }>(
        'select email from customers where id = $1',
        [res.customerId],
      );
      expect(rows[0].email).toBe('nina@vale.test');
    });

    test('the DATABASE refuses a second customer from one call, whatever the read said', async () => {
      // The read-based guard is not a lock: the window between it and the insert
      // spans a live extractor round trip, and the tool loop's deadline is a race
      // whose loser keeps running while the model retries.
      const { capture, obs } = await parked();
      await call('record_caller', {
        observationId: obs.id,
        newCustomer: { name: `Only Once ${Date.now()}` },
        openJob: { title: 'the one job' },
      });
      await expect(
        createCustomer({ tenantId, name: 'A SECOND ONE', sourceCaptureId: capture.id }),
      ).rejects.toThrow(/duplicate key|uq_customers_one_per_capture/);
    });

    test('bookVisit:true reports the trip as BOOKED, and a pre-existing one as already on the board', async () => {
      const first = await parked();
      const customer = await createCustomer({ tenantId, name: `Boarded ${Date.now()}` });
      const booked = await call('record_caller', {
        observationId: first.obs.id,
        customerId: customer.id,
        openJob: { title: 'no hot water' },
        bookVisit: true,
      });
      expect(booked.visit).toBe('booked');
      expect(booked.visitId).toBeDefined();

      // A SECOND call about a different capture, onto the same job, which now
      // carries that live trip: nothing is booked and the tool says so.
      const second = await parked();
      const again = await call('record_caller', {
        observationId: second.obs.id,
        customerId: customer.id,
        bookVisit: true,
      });
      expect(again.visit).toBe('already on the board');
      expect(again.visitId).toBe(booked.visitId);
    });

    test('a LINK onto a job with a LIVE trip still cites the call — through the trip', async () => {
      // The shape the first guard missed: the capture attaches to the VISIT, so
      // no `job_captures` row is ever written. Without the visit_notes arm the
      // item could never become moot and the tool would say "leave it alone".
      const { capture, obs } = await parked();
      const customer = await createCustomer({ tenantId, name: `Booked Already ${Date.now()}` });
      const job = await createJob({ tenantId, customerId: customer.id, title: 'in flight' });
      await createVisit({
        tenantId,
        jobId: job.id,
        technicianIds: [],
        startsAt: null,
        endsAt: null,
        status: 'confirmed',
      });
      const res = await call('record_caller', { observationId: obs.id, customerId: customer.id });
      expect(res.status).toBe('ok');
      expect(String(res.note)).toContain('retires itself once the record cites');
      expect(String(res.note)).not.toContain('will not close itself');
      const citing = await listL2CitingCapture(tenantId, [capture.id]);
      expect(citing.map((c) => c.kind)).toContain('note');
    });

    test('a customer whose only job is CANCELLED has nothing to file onto', async () => {
      // `job_captures` onto a cancelled job is deliberately not an answer, so
      // filing there would leave the item open with the tool saying otherwise.
      const { obs } = await parked();
      const customer = await createCustomer({ tenantId, name: `All Cancelled ${Date.now()}` });
      const job = await createJob({ tenantId, customerId: customer.id, title: 'called off' });
      await pg.query(`update jobs set status = 'cancelled' where id = $1`, [job.id]);
      await expect(
        call('record_caller', { observationId: obs.id, customerId: customer.id }),
      ).rejects.toThrow(/nothing to file this call onto/);
    });

    test('bookVisit onto a customer whose only job is PAID is refused, not dropped', async () => {
      // The guard has to read the job the DOOR will: a terminal job is not one a
      // trip can hang on, however recently it cited this very call.
      const { obs } = await parked();
      const customer = await createCustomer({ tenantId, name: `Paid Only ${Date.now()}` });
      const job = await createJob({ tenantId, customerId: customer.id, title: 'settled' });
      await pg.query(`update jobs set status = 'paid' where id = $1`, [job.id]);
      await expect(
        call('record_caller', { observationId: obs.id, customerId: customer.id, bookVisit: true }),
      ).rejects.toThrow(/a trip needs a job to sit on/);
    });

    test('a trip needs a job to sit on — bookVisit alone is refused, not silently dropped', async () => {
      const { obs } = await parked();
      const customer = await createCustomer({ tenantId, name: `Settled Up ${Date.now()}` });
      // A job on file, but a FINISHED one — so the call has somewhere to be
      // filed, and still nothing a trip could sit on.
      const done = await createJob({ tenantId, customerId: customer.id, title: 'paid up' });
      await pg.query(`update jobs set status = 'paid' where id = $1`, [done.id]);
      await expect(
        call('record_caller', { observationId: obs.id, customerId: customer.id, bookVisit: true }),
      ).rejects.toThrow(/a trip needs a job to sit on/);
    });

    // ---- RUNG 10B.2: the citing door is SHARED with the manager seat --------
    // The live e2e (2026-09-08) proved the planner's half works and that a
    // manager's answer could not reach this door, so the seat re-typed the
    // customer's email through record_field_note and the item cited nothing.
    // These pin the new surface: shared with an ACTIVE MANAGER, and with nobody
    // else.
    const callAs = (technicianRef: string, args: Record<string, unknown>) =>
      dispatchForIdentity('record_caller', args, { tenantId, technicianRef }, {
        ...noCost,
        extract: async () => ({ jobTitle: 'what the model read' }),
      }) as Promise<Record<string, unknown>>;

    test('an ACTIVE MANAGER may record a caller, and its writes cite the call', async () => {
      const { capture, obs } = await parked();
      const res = await callAs('mgr-test', {
        observationId: obs.id,
        newCustomer: { name: `Seat Settled ${Date.now()}` },
        openJob: { title: 'heater is dead' },
      });
      expect(res.status).toBe('ok');
      // Independent read-back, both rows — the tool agreeing with itself proves
      // nothing, and CITING is the whole point of sharing this door.
      const { rows } = await pg.query<{ src: string | null }>(
        `select source_capture_id as src from customers where id = $1
         union all select source_capture_id from jobs where id = $2`,
        [res.customerId, res.jobId],
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.src === capture.id)).toBe(true);
    });

    test('a TECHNICIAN badge may NOT — settling who a caller was is a manager\'s call', async () => {
      const { obs } = await parked();
      await expect(
        callAs('tech-mcp', { observationId: obs.id, newCustomer: { name: 'Not theirs' } }),
      ).rejects.toThrow(/needs a manager badge/);
    });

    test('a DEACTIVATED manager may not — the badge gate runs before the tier gate', async () => {
      const { obs } = await parked();
      const gone = await insertTechnician({
        tenantId,
        ref: `ex-mgr-${Date.now()}`,
        displayName: 'Ex Manager',
        tier: 'manager',
      });
      await setTechnicianState(gone.id, 'active');
      await setTechnicianState(gone.id, 'offboarded');
      await expect(
        callAs(gone.ref, { observationId: obs.id, newCustomer: { name: 'Too late' } }),
      ).rejects.toThrow(/deactivated team member/);
    });

    test('sharing this door did not open the OTHERS — the ceiling still holds both ways', async () => {
      // A manager still cannot reach the planner's own tools…
      await expect(
        dispatchForIdentity('spine_read', { sql: 'select 1' }, { tenantId, technicianRef: 'mgr-test' }, noCost),
      ).rejects.toThrow(/team lead's own tool/);
      await expect(
        dispatchForIdentity('read_memory', { path: 'MEMORY.md' }, { tenantId, technicianRef: 'mgr-test' }, noCost),
      ).rejects.toThrow(/team lead's own tool/);
      // …and the spine: namespace is still capped to its allowlist.
      await expect(
        dispatchForIdentity('book_visit', {}, { tenantId, technicianRef: 'spine:team-lead' }, noCost),
      ).rejects.toThrow(/tool not allowed/);
      // The shared name is the ONLY one that left the team-lead-only set.
      // Compared against the SCHEMA array, not the allowlist: two allowlisted
      // names carry no schema at all (see the KNOWN_UNREACHABLE test below), so
      // the allowlist would report them as "shared" when they are merely absent.
      expect(
        TEAM_LEAD_TOOL_SCHEMAS.map((t) => t.name).filter((n) => !TEAM_LEAD_ONLY_TOOL_NAMES.has(n)),
      ).toEqual(['record_caller']);
      // …and it is DISCOVERABLE by the seat, from the same schema object the
      // planner reads — one definition, two catalogs.
      expect(MANAGER_TOOL_NAMES.has('record_caller')).toBe(true);
    });

    test('a booked trip names the badge that decided, not the team lead', async () => {
      const { obs } = await parked();
      const customer = await createCustomer({ tenantId, name: `Booked By Sam ${Date.now()}` });
      await createJob({ tenantId, customerId: customer.id, title: 'somewhere to sit' });
      const res = await callAs('mgr-test', {
        observationId: obs.id,
        customerId: customer.id,
        bookVisit: true,
      });
      expect(res.visitId).toBeDefined();
      const { rows } = await pg.query<{ actor_ref: string }>(
        // `assignment_id` — schedule_events kept its pre-9b column name through the
        // visit merge, so the visit's id lands there.
        'select actor_ref from schedule_events where assignment_id = $1',
        [res.visitId],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.actor_ref === 'mgr-test')).toBe(true);
    });

    test('the planner still books as the team lead — the default is unchanged', async () => {
      const { obs } = await parked();
      const customer = await createCustomer({ tenantId, name: `Booked By Spine ${Date.now()}` });
      await createJob({ tenantId, customerId: customer.id, title: 'somewhere to sit' });
      const res = await call('record_caller', {
        observationId: obs.id,
        customerId: customer.id,
        bookVisit: true,
      });
      // Both guards, or the assertion is vacuous: with no visit the query binds
      // null, matches nothing, and `[].every(...)` is true — so a deleted
      // default would still go green (review finding).
      expect(res.visitId).toBeDefined();
      const { rows } = await pg.query<{ actor_ref: string }>(
        // `assignment_id` — schedule_events kept its pre-9b column name through the
        // visit merge, so the visit's id lands there.
        'select actor_ref from schedule_events where assignment_id = $1',
        [res.visitId],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.actor_ref === 'spine:team-lead')).toBe(true);
    });

    // ---- RUNG 10B.2: the firm's own mailbox is not a caller's identity ------
    test('refuses an addressLine1 that is just the caller\'s name (rung 10b.2)', async () => {
      // The guard used to live only in resolutionFrom — the record_field_note
      // door — which rung 10b.2 had just told the seat to stop using. So it sat
      // on the door nobody takes and was missing from the one everybody now
      // takes, and the 2026-09-08 specimen reproduced verbatim here (review
      // finding). There is no address updater in the app: a fabrication sticks.
      const { obs } = await parked();
      await expect(
        callAs('mgr-test', {
          observationId: obs.id,
          newCustomer: { name: 'Ruth Bramley', addressLine1: 'Ruth Bramley' },
        }),
      ).rejects.toThrow(/is the customer's NAME, not an address/);
      // …and a real address on the same door still records.
      const res = await callAs('mgr-test', {
        observationId: obs.id,
        newCustomer: { name: `Real Address ${Date.now()}`, addressLine1: '18 Bramley Road' },
      });
      const { rows } = await pg.query<{ address_line1: string | null }>(
        'select address_line1 from customers where id = $1',
        [res.customerId],
      );
      expect(rows[0].address_line1).toBe('18 Bramley Road');
    });

    test('refuses the firm\'s OWN mailbox as the new customer\'s email', async () => {
      const { obs } = await parked({
        meta: { from: 'Hongyi <office@firm.test>', to: 'Hongyi <office@firm.test>' },
      });
      await expect(
        callAs('mgr-test', {
          observationId: obs.id,
          newCustomer: { name: 'Self Sender', email: 'OFFICE@firm.test' },
        }),
      ).rejects.toThrow(/own mailbox/);
    });

    test('a self-sent message records the caller with NO email rather than ours', async () => {
      // The same capture, answered the way the refusal above steers: name only.
      // The door must not resurrect the sender as a fallback either — this is a
      // RE-ENTRY on a capture whose first pass was right to withhold it.
      const { obs } = await parked({
        meta: { from: 'Hongyi <office@firm.test>', to: 'Hongyi <office@firm.test>' },
      });
      const res = await callAs('mgr-test', {
        observationId: obs.id,
        newCustomer: { name: `No Email Please ${Date.now()}` },
      });
      const { rows } = await pg.query<{ email: string | null }>(
        'select email from customers where id = $1',
        [res.customerId],
      );
      expect(rows[0].email).toBeNull();
    });

    // ---- RUNG 10B.3: the same rule, REVERSED, on the firm's own outbound mail --
    test("on an OUTBOUND capture the caller's email is who it went TO, never From", async () => {
      // From is US on an outbound row, so the 10b.2 rule inverts: taking the
      // sender would file the FIRM'S OWN ADDRESS on the customer the planner is
      // creating — the 10b.2 incident reproduced through the new door, landing
      // on exactly the name-only answer the refusal message steers towards.
      const { obs } = await parked({
        channel: 'outbound_email',
        text: "Subject: Re\nFrom: office@firm.test\n\nWe'll come Thursday.",
        meta: { from: 'Office <office@firm.test>', to: 'Iris <iris@homeowner.test>' },
      });
      const res = await callAs('mgr-test', {
        observationId: obs.id,
        newCustomer: { name: `Promised To ${Date.now()}` },
      });
      const { rows } = await pg.query<{ email: string | null }>(
        'select email from customers where id = $1',
        [res.customerId],
      );
      expect(rows[0].email).toBe('iris@homeowner.test');
    });

    test('…and it ACCEPTS the recipient the ask itself named', async () => {
      // The refusal guard was inbound-only too: it reads a sole recipient as
      // evidence of OUR mailbox, which on outbound is the CUSTOMER. Unscoped it
      // refuses the right answer — the ask renders "sent to iris@…", the planner
      // answers with that address, and the tool calls the customer's own address
      // the firm's mailbox. Untrue, and it blocks the only tool that resolves
      // an outbound-promise ask.
      const { obs } = await parked({
        channel: 'outbound_email',
        meta: { from: 'Office <office@firm.test>', to: 'Iris <iris@homeowner.test>' },
      });
      const res = await callAs('mgr-test', {
        observationId: obs.id,
        newCustomer: { name: `Named Recipient ${Date.now()}`, email: 'iris@homeowner.test' },
      });
      const { rows } = await pg.query<{ email: string | null }>(
        'select email from customers where id = $1',
        [res.customerId],
      );
      expect(rows[0].email).toBe('iris@homeowner.test');
    });

    test("…while the firm's own SENDING address is still refused on an outbound capture", async () => {
      const { obs } = await parked({
        channel: 'outbound_email',
        meta: { from: 'Office <office@firm.test>', to: 'Iris <iris@homeowner.test>' },
      });
      await expect(
        callAs('mgr-test', {
          observationId: obs.id,
          newCustomer: { name: 'Wrong Way Round', email: 'OFFICE@firm.test' },
        }),
      ).rejects.toThrow(/was SENT FROM/);
    });

    test('…and TWO recipients name neither — unique-or-nothing', async () => {
      const { obs } = await parked({
        channel: 'outbound_email',
        meta: { from: 'Office <office@firm.test>', to: 'iris@home.test, landlord@example.test' },
      });
      const res = await callAs('mgr-test', {
        observationId: obs.id,
        newCustomer: { name: `Ambiguous To ${Date.now()}` },
      });
      const { rows } = await pg.query<{ email: string | null }>(
        'select email from customers where id = $1',
        [res.customerId],
      );
      expect(rows[0].email).toBeNull();
    });

    test('a REAL sender is still kept as the caller\'s email', async () => {
      const { obs } = await parked({
        meta: { from: 'Ruth <ruth@example.test>', to: 'Hongyi <office@firm.test>' },
      });
      const res = await callAs('mgr-test', {
        observationId: obs.id,
        newCustomer: { name: `Real Sender ${Date.now()}` },
      });
      const { rows } = await pg.query<{ email: string | null }>(
        'select email from customers where id = $1',
        [res.customerId],
      );
      expect(rows[0].email).toBe('ruth@example.test');
    });
  });

  test('every allowlisted team-lead name either has a schema or is known unreachable', () => {
    // The drift the build-3 research found: get_customer_context and
    // resolve_date sit on TEAM_LEAD_TOOL_NAMES with no entry in
    // TEAM_LEAD_TOOL_SCHEMAS, so the planner is never handed them and cannot
    // call them. That is a half-added tool, and nothing was pinning it. This
    // test does not FIX it — it makes the next one deliberate.
    const KNOWN_UNREACHABLE = new Set(['get_customer_context', 'resolve_date']);
    const withSchema = new Set(TEAM_LEAD_TOOL_SCHEMAS.map((t) => t.name));
    const unpaired = [...TEAM_LEAD_TOOL_NAMES].filter(
      (n) => !withSchema.has(n) && !KNOWN_UNREACHABLE.has(n),
    );
    expect(unpaired, `allowlisted with no schema: ${unpaired.join(', ')}`).toEqual([]);
    // …and the inverse: a schema the allowlist forgot cannot dispatch at all.
    const unlisted = [...withSchema].filter((n) => !TEAM_LEAD_TOOL_NAMES.has(n));
    expect(unlisted, `schema with no allowlist entry: ${unlisted.join(', ')}`).toEqual([]);
  });
});

// Attribution (plan 2026-08-22, Phase 1): the spine ties an answer back to the
// question it answered, with no ref code anywhere in the message.
describe('record_field_note — an answer remembers its question', () => {
  let customerId: string;
  let jobId: string;
  let strangerId: string;

  beforeAll(async () => {
    const c = await createCustomer({ tenantId, name: 'Attribution Customer' });
    customerId = c.id;
    const j = await createJob({ tenantId, customerId, title: 'Attribution job' });
    jobId = j.id;
    const t = await pg.query<{ id: string }>(
      `insert into technicians (tenant_id, ref, display_name, tier, state, seat_exempt)
       values ($1, 'attr-stranger', 'Attr Stranger', 'technician', 'active', true)
       on conflict (tenant_id, ref) do update set display_name = excluded.display_name
       returning id`,
      [tenantId],
    );
    strangerId = t.rows[0].id;
  });
  afterAll(async () => {
    await pg.query('delete from nudges where technician_id = $1', [strangerId]);
    await pg.query('delete from technicians where id = $1', [strangerId]);
  });

  // An ASKED gap for `who` on this job — the state a real answer comes back to.
  const askedGap = async (subjectRef: string, technicianId: string, question = 'How did it go?') => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef,
      technicianId,
      context: { jobId },
    });
    if (!n) throw new Error('fixture nudge was not created');
    await markNudgeQueued(n.id, tenantId, question);
    await markNudgeAsked(n.id, tenantId);
    return n;
  };
  const reread = async (id: string) => {
    const rows = await listNudgesByStatus(tenantId, ['pending', 'queued', 'asked']);
    return rows.find((r) => r.id === id) ?? null;
  };

  test('exactly ONE open gap on the job → the answering capture is stamped on it', async () => {
    const gap = await askedGap('attr-one', techMcpId);
    const out = await call('record_field_note', {
      text: 'replaced the capacitor, all good',
      confirmed: { customerId },
    });
    expect(out.data.status).toBe('recorded');
    expect((await reread(gap.id))?.answered_by_capture_id).toBe(out.data.captureId);
  });

  test('TWO open gaps on the job → nothing is stamped; the planner judges it', async () => {
    // Code cannot tell which question a sentence answers. Guessing here is the
    // failure this whole design exists to avoid.
    await pg.query('update nudges set status = $1 where tenant_id = $2', ['answered', tenantId]);
    const a = await askedGap('attr-two-a', techMcpId);
    const b = await askedGap('attr-two-b', techMcpId);
    const out = await call('record_field_note', {
      text: 'came to about eighty dollars in parts',
      confirmed: { customerId },
    });
    expect(out.data.status).toBe('recorded');
    expect((await reread(a.id))?.answered_by_capture_id).toBeNull();
    expect((await reread(b.id))?.answered_by_capture_id).toBeNull();
  });

  test('another person’s gap on the same job is NOT stamped', async () => {
    await pg.query('update nudges set status = $1 where tenant_id = $2', ['answered', tenantId]);
    const theirs = await askedGap('attr-stranger-gap', strangerId);
    const out = await call('record_field_note', {
      text: 'flushed the drain line and tested it',
      confirmed: { customerId },
    });
    expect(out.data.status).toBe('recorded');
    expect((await reread(theirs.id))?.answered_by_capture_id).toBeNull();
  });

  test('the stamp survives a needs_identity round-trip — the common answer path', async () => {
    // A technician answering a nudge usually lands on a RESUME, not the one-shot
    // path: the note names no customer, the agent asks, they say which one.
    await pg.query('update nudges set status = $1 where tenant_id = $2', ['answered', tenantId]);
    const gap = await askedGap('attr-resume', techMcpId);
    const staged = await call('record_field_note', { text: 'took two hours, no parts needed' });
    expect(staged.data.status).toBe('needs_identity');
    const done = await call('record_field_note', {
      confirmId: staged.data.confirmId,
      confirmed: { customerId },
    });
    expect(done.data.status).toBe('recorded');
    expect((await reread(gap.id))?.answered_by_capture_id).toBe(done.data.captureId);
  });

  test('a note BEFORE the question goes out does not burn the stamp', async () => {
    // The defect this narrowing fixes. A pending gap can sit for hours; a
    // routine note in that window must NOT be stamped as its answer, because
    // the stamp is first-write-wins and the real answer could then never claim
    // it — attribution would fail silently on exactly the gap it exists for.
    await pg.query('update nudges set status = $1 where tenant_id = $2', ['answered', tenantId]);
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'attr-preask',
      technicianId: techMcpId,
      context: { jobId },
    });
    if (!n) throw new Error('fixture nudge was not created');

    const early = await call('record_field_note', {
      text: 'stopped by to drop off the part',
      confirmed: { customerId },
    });
    expect(early.data.status).toBe('recorded');
    expect((await reread(n.id))?.answered_by_capture_id).toBeNull();

    // NOW the question actually goes out, and the reply claims the slot.
    await markNudgeQueued(n.id, tenantId, 'How did it go?');
    await markNudgeAsked(n.id, tenantId);
    const answer = await call('record_field_note', {
      text: 'fitted it and tested the run, all good',
      confirmed: { customerId },
    });
    expect((await reread(n.id))?.answered_by_capture_id).toBe(answer.data.captureId);
  });

  test('an UNASKED sibling gap does not make the real answer ambiguous', async () => {
    // A brand-new pending cost gap on the same job must not block attribution
    // of the answer to the visit question that actually went out.
    await pg.query('update nudges set status = $1 where tenant_id = $2', ['answered', tenantId]);
    const askedOne = await askedGap('attr-sib-asked', techMcpId);
    const unasked = await createPendingNudge({
      tenantId,
      kind: 'job_cost_gap',
      subjectRef: 'attr-sib-pending',
      technicianId: techMcpId,
      context: { jobId },
    });
    if (!unasked) throw new Error('fixture nudge was not created');

    const out = await call('record_field_note', {
      text: 'wrapped up around four, customer happy',
      confirmed: { customerId },
    });
    expect((await reread(askedOne.id))?.answered_by_capture_id).toBe(out.data.captureId);
    expect((await reread(unasked.id))?.answered_by_capture_id).toBeNull();
  });

  test('a ROSTER-LESS badge attributes nothing and still records the note', async () => {
    // record_field_note serves badges with no roster row by design. There is no
    // technicians.id to scope gaps by, so attribution fails closed — but the
    // note must still land, which is the whole point of that carve-out.
    await pg.query('update nudges set status = $1 where tenant_id = $2', ['answered', tenantId]);
    const gap = await askedGap('attr-rosterless', techMcpId);
    const out = (await dispatchForIdentity(
      'record_field_note',
      { text: 'meter read fine on arrival', confirmed: { customerId } },
      { tenantId, technicianRef: 'no-roster-row-at-all' },
      { extract: async () => ({ workPerformed: 'did the work' }) },
    )) as { status: string; captureId: string };
    expect(out.status).toBe('recorded');
    expect(out.captureId).toBeTruthy();
    expect((await reread(gap.id))?.answered_by_capture_id).toBeNull();
  });

  test('a failure inside attribution never fails the note', async () => {
    // A REAL database error (a non-uuid technician id is rejected by Postgres),
    // not a stub: the swallow is the safety property, and L1 is undeletable, so
    // a lost link must never become a lost note.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      attributeAnswerToGap({
        tenantId,
        technicianId: 'not-a-uuid',
        jobId,
        captureId: '44444444-4444-4444-8444-444444444444',
      }),
    ).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // ---- openQuestions: what the assistant is told is still open on this job ----

  const clearGaps = async () =>
    pg.query('update nudges set status = $1 where tenant_id = $2', ['answered', tenantId]);
  const questionsOf = (data: unknown): string[] =>
    ((data as { openQuestions?: { question: string }[] }).openQuestions ?? []).map(
      (q) => q.question,
    );

  test('two asked gaps → the recorded answer carries BOTH, unfiltered', async () => {
    // Deliberately NOT filtered to "the ones they didn't answer". Attribution
    // declines to stamp at two-or-more asked, so the spine has no signal for
    // which one this note closed — the agent judges it from what was said.
    await clearGaps();
    await askedGap('attr-oq-two-a', techMcpId, 'How did the visit go?');
    await askedGap('attr-oq-two-b', techMcpId, 'What did the parts come to?');
    const out = await call('record_field_note', {
      text: 'swapped the igniter, ran it for ten minutes',
      confirmed: { customerId },
    });
    expect(out.data.status).toBe('recorded');
    // toEqual on the WHOLE entries, not just the texts: the payload must carry
    // question and NOTHING else. No technician tool takes a gap id, and a ref in
    // a person's face is the machine artifact the (re: …) anchor exists to keep
    // out of the chat — so a leaked `nudgeId` has to fail here.
    expect(
      [...(out.data.openQuestions as { question: string }[])].sort((x, y) =>
        x.question.localeCompare(y.question),
      ),
    ).toEqual([{ question: 'How did the visit go?' }, { question: 'What did the parts come to?' }]);
  });

  test('a grouped ask reads back as ONE question, not one per member', async () => {
    // The batching case. Every member of an ask-group stores the same full
    // grouped message, so a row-shaped payload would tell the agent it owed the
    // person three follow-ups for one message it had already sent them.
    await clearGaps();
    const a = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'attr-oq-grp-a',
      technicianId: techMcpId,
      context: { jobId },
    });
    const b = await createPendingNudge({
      tenantId,
      kind: 'job_cost_gap',
      subjectRef: 'attr-oq-grp-b',
      technicianId: techMcpId,
      context: { jobId },
    });
    if (!a || !b) throw new Error('fixture nudges were not created');
    const grouped = 'How did the visit go, and what did the parts come to?';
    await markNudgeGroupQueued([a.id, b.id], tenantId, grouped, a.id);
    await markNudgeAskedGroup(a.id, tenantId, a.id);

    const out = await call('record_field_note', {
      text: 'all done on site, will price the parts tomorrow',
      confirmed: { customerId },
    });
    expect(out.data.status).toBe('recorded');
    expect(questionsOf(out.data)).toEqual([grouped]);
  });

  test('another person’s asked gap on the same job is never reported', async () => {
    await clearGaps();
    await askedGap('attr-oq-mine', techMcpId, 'Did you need a second visit?');
    await askedGap('attr-oq-theirs', strangerId, 'THEIR question — must not appear');
    const out = await call('record_field_note', {
      text: 'one trip was enough, customer signed off',
      confirmed: { customerId },
    });
    expect(questionsOf(out.data)).toEqual(['Did you need a second visit?']);
  });

  test('a gap that has not gone out yet is never reported', async () => {
    // pending and queued are both "the person has not seen this". Reporting one
    // would have the assistant ask a question the office never sent.
    await clearGaps();
    await askedGap('attr-oq-sent', techMcpId, 'How long were you on site?');
    const pending = await createPendingNudge({
      tenantId,
      kind: 'job_cost_gap',
      subjectRef: 'attr-oq-pending',
      technicianId: techMcpId,
      context: { jobId },
    });
    const queued = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'attr-oq-queued',
      technicianId: techMcpId,
      context: { jobId },
    });
    if (!pending || !queued) throw new Error('fixture nudges were not created');
    await markNudgeQueued(queued.id, tenantId, 'QUEUED — not sent yet');

    const out = await call('record_field_note', {
      text: 'about two hours door to door',
      confirmed: { customerId },
    });
    expect(questionsOf(out.data)).toEqual(['How long were you on site?']);
  });

  test('a duplicate note reports the duplicate and offers no follow-up', async () => {
    // The second delivery wrote nothing, so there is no new answer to follow up
    // on — and the follow-up already rode out with the delivery that landed.
    await clearGaps();
    await askedGap('attr-oq-dup', techMcpId, 'Anything outstanding on this one?');
    const args = {
      text: 'nothing outstanding, job is closed out',
      confirmed: { customerId },
    };
    const first = await call('record_field_note', args);
    expect(first.data.status).toBe('recorded');
    expect(questionsOf(first.data)).toEqual(['Anything outstanding on this one?']);

    const again = await call('record_field_note', args);
    expect(again.data.status).toBe('duplicate');
    expect(again.data.openQuestions).toBeUndefined();
  });

  test('a failure inside the follow-up lookup reports nothing and never throws', async () => {
    // A REAL database error (a non-uuid technician id is rejected by Postgres),
    // matching the attribution swallow above: by the time this runs the note is
    // already in undeletable L1, so a lookup failure must cost the follow-up and
    // nothing else.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      openQuestionsFor({ tenantId, technicianId: 'not-a-uuid', jobId }),
    ).resolves.toEqual([]);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('a ROSTER-LESS badge is offered no follow-up', async () => {
    // Same fail-closed rule as attribution: no roster row, nothing to scope by.
    await expect(openQuestionsFor({ tenantId, technicianId: null, jobId })).resolves.toEqual([]);
    await expect(
      openQuestionsFor({ tenantId, technicianId: techMcpId, jobId: undefined }),
    ).resolves.toEqual([]);
  });

  test('nothing open → the key is ABSENT, not an empty list', async () => {
    // The description and §0k both say a recorded answer MAY come back with
    // openQuestions. Shipping `openQuestions: []` on every note contradicts that
    // and hands the agent a field to reason about on the ordinary path, so the
    // spread is conditional and this is what pins it. The duplicate case cannot
    // pin it — that branch returns before the lookup ever runs.
    await clearGaps();
    const out = await call('record_field_note', {
      text: 'topped up the refrigerant and checked the pressures',
      confirmed: { customerId },
    });
    expect(out.data.status).toBe('recorded');
    expect(out.data.openQuestions).toBeUndefined();
    expect(Object.keys(out.data)).not.toContain('openQuestions');
  });

  test('a production-shaped question keeps its anchor — the agent is told not to echo it', async () => {
    // Real `question` values are `questionDraft + anchorLine(row)` (planner.ts),
    // so every entry ends with the code-printed "(re: Customer — Job)". The
    // payload deliberately does NOT strip it: stripping would couple this module
    // to the planner's anchor format, and a silent format change would stop
    // stripping while still reading as working. The echo hazard is closed in the
    // instructions instead — §0k clause 1a and the tool description both forbid
    // repeating that line. This pins the shape the agent actually receives.
    await clearGaps();
    const production = 'How did the visit go?\n\n(re: Attribution Customer — Attribution job)';
    await askedGap('attr-oq-anchored', techMcpId, production);
    const out = await call('record_field_note', {
      text: 'ran the system for twenty minutes, no faults',
      confirmed: { customerId },
    });
    expect(questionsOf(out.data)).toEqual([production]);
  });

  test('the RESUME path carries openQuestions too — the common answer path', async () => {
    // `commitNote` has THREE call sites and only the one-shot is covered above,
    // yet this file's own attribution test calls resume "the common answer path:
    // the note names no customer, the agent asks, they say which one". A change
    // to the resume branch's result assembly could drop openQuestions on the
    // path production actually uses with the suite still green.
    await clearGaps();
    await askedGap('attr-oq-resume', techMcpId, 'Did the part arrive?');
    const staged = await call('record_field_note', { text: 'it turned up first thing' });
    expect(staged.data.status).toBe('needs_identity');
    const done = await call('record_field_note', {
      confirmId: staged.data.confirmId,
      confirmed: { customerId },
    });
    expect(done.data.status).toBe('recorded');
    expect(questionsOf(done.data)).toEqual(['Did the part arrive?']);
  });

  test('the tool description carries the follow-up duty', async () => {
    // Until the six live seats get their §0k refresh (manual, user-gated), this
    // description is the ONLY instruction a seat agent has about openQuestions.
    // Same pinning precedent as the agentContext clauses elsewhere in this file.
    const tools = (await client.listTools()).tools;
    const desc = tools.find((t) => t.name === 'record_field_note')?.description ?? '';
    expect(desc).toContain('openQuestions');
    // The loop-closer: asking without recording leaves the gap `asked` and the
    // office re-asks the person what they just said.
    expect(desc).toMatch(/RECORD their reply/);
    // And the two tone rules that keep a machine artifact out of a human's face.
    expect(desc).toMatch(/never say it came from the office/);
    expect(desc).toMatch(/TWO SHORT PARAGRAPHS/);
    expect(desc).toMatch(/\(re: …\)/);
    // The follow-up reply names no customer on its own. Without this the agent
    // is bounced to needs_identity and asks them WHICH customer, seconds after
    // recording one for them — so the mechanism has to be named, not implied.
    expect(desc).toMatch(/confirmed:\{customerId\}/);
    const confirmedDesc =
      (tools.find((t) => t.name === 'record_field_note')?.inputSchema as {
        properties?: { confirmed?: { description?: string } };
      })?.properties?.confirmed?.description ?? '';
    expect(confirmedDesc).toMatch(/ALONE \(no confirmId\)/);
  });
});

// ---- Rung 10: the job link, and the reserved key ---------------------------
describe('rung 10 — job links and correspondence', () => {
  test('a retraction FOLLOWS its target onto the JOB, not only onto the trip', async () => {
    const customer = await createCustomer({ tenantId, name: 'Job Link Cust', phone: '555-7788' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'leaking tap' });
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp', // the calling identity — retraction is the author's
      rawText: 'linked straight to the job',
    });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: cap.id });

    const staged = await call('retract_capture', { captureId: cap.id, reason: 'wrong job' });
    expect(staged.isError).toBe(false);
    const done = await call('retract_capture', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('retracted');

    // Both rows on the job: the target and the retraction that neutralizes it.
    // Without this the retraction sits on the record with no connection to the
    // thing it cancels — invisible to every reader that walks the link.
    const links = await pg.query<{ capture_id: string }>(
      'select capture_id from job_captures where job_id = $1',
      [job.id],
    );
    expect(links.rows.map((r) => r.capture_id).sort()).toEqual(
      [cap.id, done.data.retractionId as string].sort(),
    );
  });

  test('a retraction FOLLOWS its target onto the CUSTOMER link when there is no job', async () => {
    // The door files a capture on customer_captures when it knows WHO wrote but
    // not WHICH job. In the #239 merge this loop sat in an empty-HEAD conflict
    // hunk, and a suite that tested it only through src/db would have passed with
    // it dropped. Driven through the MCP server so that cannot happen again.
    const customer = await createCustomer({ tenantId, name: 'Customer Link Cust', phone: '555-7790' });
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp', // the calling identity — retraction is the author's
      rawText: 'filed on the customer, no job named',
    });
    await insertCustomerCapture({ tenantId, customerId: customer.id, captureId: cap.id });

    const staged = await call('retract_capture', { captureId: cap.id, reason: 'wrong customer' });
    expect(staged.isError).toBe(false);
    const done = await call('retract_capture', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('retracted');

    // The link loop runs inside a swallow-and-log try, so the tool reports
    // success even if it never ran: only the table can tell.
    const links = await pg.query<{ capture_id: string }>(
      'select capture_id from customer_captures where customer_id = $1',
      [customer.id],
    );
    expect(links.rows.map((r) => r.capture_id).sort()).toEqual(
      [cap.id, done.data.retractionId as string].sort(),
    );
  });

  test('`correspondence` is RESERVED — record_standing_fact refuses the key', async () => {
    const customer = await createCustomer({ tenantId, name: 'Reserved Cust', phone: '555-7799' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'reserved key job' });
    const refused = await call('record_standing_fact', {
      jobId: job.id,
      key: 'Correspondence', // normalizes to the reserved key — the guard runs after
      value: 'nope',
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('reserved');
    // A neighbouring key is untouched — the refusal is the key, not the tool.
    const ok = await call('record_standing_fact', { jobId: job.id, key: 'symptom', value: 'drips' });
    expect(ok.isError).toBe(false);
  });

  test('the retraction PREVIEW names the correspondence it will silence', async () => {
    // The preview and the fold must never drift: src/db/context.ts drops a
    // retracted entry from every typed read, so a willAlsoRemove that did not
    // list it would tell the manager "nothing else goes" and then silently
    // remove the customer's own words. That drift is the exact failure
    // foldImpact.ts was written for (a live retraction, 2026-07-14).
    const customer = await createCustomer({ tenantId, name: 'Preview Cust', phone: '555-7811' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'preview job' });
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note', // authored by the caller, so it can self-retract
      technicianRef: 'tech-mcp',
      rawText: 'the tap still drips',
    });
    await appendJobCorrespondence(job.id, {
      captureId: cap.id,
      channel: 'email',
      at: '2026-09-07T10:00:00.000Z',
      followUp: 'bring a washer',
    });

    const staged = await call('retract_capture', { captureId: cap.id, reason: 'wrong job' });
    expect(staged.isError).toBe(false);
    expect(staged.data.willAlsoRemove.correspondence).toEqual([
      {
        jobId: job.id,
        jobLabel: 'preview job',
        channel: 'email',
        at: '2026-09-07T10:00:00.000Z',
        followUp: 'bring a washer',
      },
    ]);
    expect(staged.data.note).toContain('willAlsoRemove.correspondence');

    // PARITY: what the preview promised is what the fold actually does.
    const done = await call('retract_capture', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('retracted');
    const ctx = await call('get_customer_context', { customerId: customer.id });
    const folded = ctx.data.jobs.find((j: { id: string }) => j.id === job.id);
    expect(folded.attributes.correspondence).toBeUndefined();
  });

  test('a token staged BEFORE this deploy cannot land on the reserved key either', async () => {
    // Confirm re-reads `detail.facts` off the staged item and re-validates
    // nothing, so the stage-side refusal alone leaves one destructive path open
    // across the deploy boundary: a scalar fact bundle replacing the whole
    // correspondence array, with no undo.
    const customer = await createCustomer({ tenantId, name: 'Legacy Token', phone: '555-7822' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'legacy token job' });
    await appendJobCorrespondence(job.id, {
      captureId: (
        await appendRawCapture({
          tenantId,
          channel: 'email',
          technicianRef: 'connector:gmail',
          rawText: 'keep me',
        })
      ).id,
      channel: 'email',
      at: '2026-09-07T11:00:00.000Z',
    });
    // The token carries the CURRENT value as `previousValue`, exactly as a real
    // stage would — otherwise the pre-flight conflict scan refuses it first and
    // the guard under test is never reached.
    const { rows: before } = await pg.query<{ attributes: { correspondence: Json[] } }>(
      'select attributes from jobs where id = $1',
      [job.id],
    );
    const detail = {
      target: 'job',
      targetId: job.id,
      customerId: customer.id,
      targetName: 'legacy token job',
      facts: [
        {
          key: 'correspondence',
          value: 'clobber',
          previousValue: before[0].attributes.correspondence,
        },
      ],
      stagedAt: new Date().toISOString(),
    };
    const token = await upsertOpenReviewItem({
      tenantId,
      kind: 'pending_standing_fact',
      subjectRef: 'tech-mcp', // the calling identity — the token lookup is guarded on it
      detail,
    });
    // upsertOpenReviewItem is an UPSERT on (tenant, kind, subjectRef): another
    // test in this file may already hold an open token for this person, in
    // which case the row that comes back is THEIRS. Write the payload straight
    // in so this test stages what it means to stage, whatever ran before it.
    await pg.query('update review_items set detail = $1::jsonb where id = $2', [
      JSON.stringify(detail),
      token.id,
    ]);
    const refused = await call('record_standing_fact', { confirmId: token.id });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain('reserved');
    // The array is untouched — nothing was overwritten.
    const { rows } = await pg.query<{ attributes: { correspondence?: unknown[] } }>(
      'select attributes from jobs where id = $1',
      [job.id],
    );
    expect(rows[0].attributes.correspondence).toHaveLength(1);
    // AND NOTHING LANDED. The refusal has to come before the L1 evidence
    // append: a throw after it would strand a permanent orphan capture (L1 has
    // no delete path) and leave the token open, telling the agent to retry with
    // the same confirmId to converge — which a reserved key never can.
    const { rows: orphan } = await pg.query<{ n: string }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [`fact:${token.id}`],
    );
    expect(Number(orphan[0].n)).toBe(0);
    const { rows: tok } = await pg.query<{ status: string }>(
      'select status from review_items where id = $1',
      [token.id],
    );
    expect(tok[0].status).toBe('dismissed'); // the token dies rather than looping
  });

  test('a RETRACTED correspondence entry disappears from the customer’s context', async () => {
    const customer = await createCustomer({ tenantId, name: 'Folded Corr', phone: '555-7801' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'folded correspondence' });
    const kept = await appendRawCapture({
      tenantId,
      channel: 'email',
      technicianRef: 'connector:gmail',
      rawText: 'the tap still drips',
    });
    const gone = await appendRawCapture({
      tenantId,
      channel: 'email',
      technicianRef: 'connector:gmail',
      rawText: 'ignore my last message',
    });
    await appendJobCorrespondence(job.id, {
      captureId: kept.id,
      channel: 'email',
      at: new Date().toISOString(),
      followUp: 'bring a washer',
    });
    await appendJobCorrespondence(job.id, {
      captureId: gone.id,
      channel: 'email',
      at: new Date().toISOString(),
      followUp: 'cancel the washer',
    });

    // A connector capture has no technician author, so a MANAGER retracts it.
    const { client: mgrClient, callWith: callMgr } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const staged = await callMgr('retract_capture', { captureId: gone.id, reason: 'sent in error' });
      expect(staged.isError).toBe(false);
      const done = await callMgr('retract_capture', { confirmId: staged.data.confirmId });
      expect(done.data.status).toBe('retracted');
    } finally {
      await mgrClient.close();
    }

    const ctx = await call('get_customer_context', { customerId: customer.id });
    const folded = ctx.data.jobs.find((j: { id: string }) => j.id === job.id);
    const entries = folded.attributes.correspondence as Array<{ captureId: string }>;
    // The retracted email stops speaking; the other one still does. An inbound
    // capture is never stamped with a customer_id (identity resolves after L1),
    // so this only works because the fold looks the entries' own evidence up.
    expect(entries.map((e) => e.captureId)).toEqual([kept.id]);

    // AND get_job MUST AGREE. The raw-row tool folds independently, and a
    // reader that still showed the retracted entry would let the agent quote
    // words a manager has withdrawn — the drift the fold exists to prevent, and
    // the one the retraction preview now promises does not happen.
    const raw = await call('get_job', { jobId: job.id });
    const rawEntries = raw.data.attributes.correspondence as Array<{ captureId: string }>;
    expect(rawEntries.map((e) => e.captureId)).toEqual([kept.id]);
  });
});

// ---- Rung 10 Phase 3: what the manager's agent creates cites the call -------
describe('rung 10 — open_job, and the citation on what a yes creates', () => {
  // The office texted a manager about a call; they said yes; their agent acts.
  // Nothing in that chat carries the call's id — the manager types "yes" — so
  // the link is re-derived from the one open ask this customer has waiting.
  const askFor = async (
    customerId: string,
    over: {
      jobId?: string;
      followUp?: string;
      attributes?: Record<string, Json>;
      channel?: 'phone_call' | 'email';
      capturedAt?: string;
      /** null = the office never texted anybody about this call. */
      askedAt?: string | null;
    } = {},
  ) => {
    const channel = over.channel ?? 'phone_call';
    const capture = await appendRawCapture({
      tenantId,
      channel,
      technicianRef: channel === 'email' ? 'connector:gmail' : 'phone-line',
      rawText: 'my heater is dead, can someone come out',
    });
    const row = await createObservation({
      tenantId,
      kind: 'inbound_new_job',
      subjectRef: capture.id,
      technicianId: null,
      context: {
        captureId: capture.id,
        customerId,
        channel,
        capturedAt: over.capturedAt ?? '2026-09-07T09:00:00.000Z',
        ...(over.jobId ? { jobId: over.jobId } : {}),
        asked: {
          jobTitle: 'no heat upstairs',
          // Carried for the PLANNER's eyes and never copied onto the job — the
          // report and the bill stay technician-only.
          workPerformed: 'caller says the pilot is out',
          followUp: over.followUp ?? 'send someone out',
          attributes: over.attributes ?? { gateCode: '4412' },
        },
        words: 'my heater is dead, can someone come out',
      },
    });
    if (!row) throw new Error('fixture observation was deduped');
    // THE OFFICE ACTUALLY TEXTED SOMEBODY. Only an ask a manager was told about
    // can be what their agent is answering; `asked_at` is that fact, and
    // without it nothing here is citable.
    const askedAt = over.askedAt === undefined ? new Date().toISOString() : over.askedAt;
    if (askedAt) {
      await pg.query('update observations set asked_at = $1 where id = $2', [askedAt, row.id]);
    }
    return { capture, observation: row };
  };
  const sourceOf = async (table: 'jobs' | 'visits', id: string) => {
    const { rows } = await pg.query<{ source_capture_id: string | null }>(
      `select source_capture_id from ${table} where id = $1`,
      [id],
    );
    return rows[0].source_capture_id;
  };

  test('(16) a booking off a call: the job AND the visit cite it, and it carries the words', async () => {
    const customer = await createCustomer({ tenantId, name: 'Citing Cora', phone: '555-8801' });
    const { capture, observation } = await askFor(customer.id);
    const { client, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        title: 'no heat upstairs', untimed: true });
      expect(booked.isError).toBe(false);
      expect(booked.data.untimed).toBe(true);
      // BOTH rows cite the call: "why is this on the calendar" has an answer.
      expect(await sourceOf('jobs', booked.data.jobId)).toBe(capture.id);
      expect(await sourceOf('visits', booked.data.visitId)).toBe(capture.id);
      // And the caller's own words land on the job it opened.
      const { rows } = await pg.query<{ attributes: { correspondence?: Array<Record<string, unknown>> } }>(
        'select attributes from jobs where id = $1',
        [booked.data.jobId],
      );
      const entries = rows[0].attributes.correspondence ?? [];
      expect(entries).toHaveLength(1);
      expect(entries[0].captureId).toBe(capture.id);
      expect(entries[0].followUp).toBe('send someone out');
      expect(entries[0].facts).toEqual({ gateCode: '4412' });
      expect(JSON.stringify(entries[0])).not.toContain('pilot is out'); // never the report
      // THE OBSERVATION IS UNTOUCHED. Closing it is the planner's, on the
      // citation this just left behind — the record is planner-kept.
      const obs = await pg.query<{ status: string }>(
        'select status from observations where id = $1',
        [observation.id],
      );
      expect(obs.rows[0].status).toBe('open');
    } finally {
      await client.close();
    }
  });

  test('(17) zero or TWO open asks ⇒ no citation, and the booking is otherwise unchanged', async () => {
    const { client, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // ZERO — the ordinary booking nobody phoned in about.
      const quiet = await createCustomer({ tenantId, name: 'Quiet Quinn', phone: '555-8802' });
      const plain = await callWith('book_visit', { customerId: quiet.id, title: 'annual service', untimed: true });
      expect(plain.isError).toBe(false);
      expect(await sourceOf('jobs', plain.data.jobId)).toBeNull();
      expect(await sourceOf('visits', plain.data.visitId)).toBeNull();

      // TWO — the agent could be answering either, and a wrong citation would
      // let the planner close the OTHER call on a job unrelated to it.
      const busy = await createCustomer({ tenantId, name: 'Busy Bev', phone: '555-8803' });
      await askFor(busy.id);
      await askFor(busy.id);
      const ambiguous = await callWith('book_visit', { customerId: busy.id, title: 'one of them', untimed: true });
      expect(ambiguous.isError).toBe(false); // the booking still happens
      expect(await sourceOf('jobs', ambiguous.data.jobId)).toBeNull();
      expect(await sourceOf('visits', ambiguous.data.visitId)).toBeNull();
    } finally {
      await client.close();
    }
  });

  test('(16b) the entry carries the CALL\'s own channel and time, not the booking\'s', async () => {
    // The brief renders these verbatim under "what the customer said on their
    // calls and emails". A hardcoded channel and this moment's clock would tell
    // every later reader that an EMAILER phoned, at the hour the manager
    // happened to answer — and the write path's own copy of the same fact
    // carries the real values, so the two homes would disagree.
    const customer = await createCustomer({ tenantId, name: 'Emailing Elena', phone: '555-8805' });
    const { capture } = await askFor(customer.id, {
      channel: 'email',
      capturedAt: '2026-09-06T08:15:00.000Z',
    });
    const { client, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const booked = await callWith('book_visit', { customerId: customer.id, title: 'emailed ask', untimed: true });
      const { rows } = await pg.query<{ attributes: { correspondence?: Array<Record<string, unknown>> } }>(
        'select attributes from jobs where id = $1',
        [booked.data.jobId],
      );
      const entry = (rows[0].attributes.correspondence ?? [])[0];
      expect(entry.captureId).toBe(capture.id);
      expect(entry.channel).toBe('email');
      expect(entry.at).toBe('2026-09-06T08:15:00.000Z');
    } finally {
      await client.close();
    }
  });

  test('(17b) an ask nobody was TEXTED about is never cited — the agent is not answering it', async () => {
    // The citation story is "the office asked, the manager said yes". If
    // nobody was ever told, this booking is something else for the same
    // customer, and stamping it would let the planner close a live ask on it.
    const customer = await createCustomer({ tenantId, name: 'Untold Uma', phone: '555-8806' });
    await askFor(customer.id, { askedAt: null });
    const { client, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const booked = await callWith('book_visit', { customerId: customer.id, title: 'unrelated work', untimed: true });
      expect(await sourceOf('jobs', booked.data.jobId)).toBeNull();
      expect(await sourceOf('visits', booked.data.visitId)).toBeNull();
    } finally {
      await client.close();
    }
  });

  test('(17c) a STALE ask is not consumed by a later unrelated booking', async () => {
    // A manager may answer the next morning; they do not answer a fortnight
    // later. Unbounded, an ask nobody ever answered would be swallowed by the
    // next booking for that customer — putting one caller's words permanently
    // onto another's job, and closing the live ask on work unrelated to it.
    const customer = await createCustomer({ tenantId, name: 'Stale Sasha', phone: '555-8807' });
    await askFor(customer.id, {
      askedAt: new Date(Date.now() - 30 * 24 * 3_600_000).toISOString(),
    });
    const { client, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const booked = await callWith('book_visit', { customerId: customer.id, title: 'annual service', untimed: true });
      expect(await sourceOf('jobs', booked.data.jobId)).toBeNull();
      const { rows } = await pg.query<{ attributes: { correspondence?: unknown[] } }>(
        'select attributes from jobs where id = $1',
        [booked.data.jobId],
      );
      expect(rows[0].attributes.correspondence).toBeUndefined();
    } finally {
      await client.close();
    }
  });

  test('(17d) a booking that MINTS a job never answers an ask that already named one', async () => {
    // The shapes have to match: an ask carrying a jobId was about existing
    // work, so a call that mints a brand-new job is answering something else.
    const customer = await createCustomer({ tenantId, name: 'Shaped Shona', phone: '555-8808' });
    const existing = await createJob({ tenantId, customerId: customer.id, title: 'the old job' });
    await askFor(customer.id, { jobId: existing.id });
    const { client, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        title: 'brand new work',
        forceNewJob: true, untimed: true });
      expect(booked.data.jobId).not.toBe(existing.id);
      expect(await sourceOf('jobs', booked.data.jobId)).toBeNull();
    } finally {
      await client.close();
    }
  });

  test('(19) the preview NAMES a booked visit that cites the call — and says it STAYS', async () => {
    // `findFoldImpact` walked visit_notes because attachNote's step 3 was the
    // ONLY writer of visits.source_capture_id, and it links the same visit in
    // the same call. `book_visit` cites a call now and mints a visit with NO
    // note link — so the preview would say "nothing else goes" and the fold
    // would then drop a real appointment out of every briefing while it stayed
    // on the board. That is the exact failure foldImpact.ts exists to prevent.
    const customer = await createCustomer({ tenantId, name: 'Booked Off A Call', phone: '555-8809' });
    const { capture } = await askFor(customer.id);
    const { client, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    let booked: { jobId: string; visitId: string };
    try {
      const r = await callWith('book_visit', { customerId: customer.id, title: 'agreed to come out', untimed: true });
      booked = { jobId: r.data.jobId, visitId: r.data.visitId };
      expect(await sourceOf('visits', booked.visitId)).toBe(capture.id);
      // There is no note link at all — this is not a reported trip.
      const links = await pg.query<{ n: string }>(
        'select count(*)::int as n from visit_notes where visit_id = $1',
        [booked.visitId],
      );
      expect(Number(links.rows[0].n)).toBe(0);
    } finally {
      await client.close();
    }

    const { client: mgr, callWith: callMgr } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const staged = await callMgr('retract_capture', { captureId: capture.id, reason: 'wrong customer' });
      expect(staged.isError).toBe(false);
      // NAMED — the preview knows about it at all, which is the regression.
      // And named under the RIGHT heading: a confirmed trip keeps its place on
      // the schedule, so it LOSES this note as evidence rather than vanishing.
      // Telling a manager a booked visit is going away when it is not is the
      // failure the rung-9b split exists to prevent.
      const willGo = staged.data.willAlsoRemove.visits as Array<{ visitId: string }>;
      expect(willGo.map((v) => v.visitId)).not.toContain(booked.visitId);
      const losing = staged.data.alsoLosesEvidence.visits as Array<{ visitId: string }>;
      expect(losing.map((v) => v.visitId)).toContain(booked.visitId);

      const done = await callMgr('retract_capture', { confirmId: staged.data.confirmId });
      expect(done.data.status).toBe('retracted');
      // PARITY: what the preview promised is what happens — the appointment is
      // still there, and the customer is still expecting it.
      const ctx = await callMgr('get_customer_context', { customerId: customer.id });
      const upcoming = ctx.data.upcomingVisits as Array<{ visitId: string }>;
      expect(upcoming.map((v) => v.visitId)).toContain(booked.visitId);
    } finally {
      await mgr.close();
    }
  });

  test('(20) retracting the capture DISMISSES the ask — the planner stops being shown it', async () => {
    // An observation keeps its own verbatim copy of the caller's words in
    // `context.words`, and no fold reaches inside one. Without this the planner
    // would keep being shown a capture a manager has formally marked
    // recorded-in-error, and could still text somebody about it.
    const customer = await createCustomer({ tenantId, name: 'Retracted Rita', phone: '555-8810' });
    const { capture, observation } = await askFor(customer.id);
    const { client, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const staged = await callWith('retract_capture', { captureId: capture.id, reason: 'personal mail' });
      const done = await callWith('retract_capture', { confirmId: staged.data.confirmId });
      expect(done.data.status).toBe('retracted');
    } finally {
      await client.close();
    }
    const { rows } = await pg.query<{ status: string; dismiss_reason: string | null }>(
      'select status, dismiss_reason from observations where id = $1',
      [observation.id],
    );
    expect(rows[0].status).toBe('dismissed');
    expect(rows[0].dismiss_reason).toContain('retracted');
    // `recover` is still there if the manager changes their mind — dismissal is
    // revisable, which is why this is the right verb for code to use.
  });

  test('(18) open_job opens work with NOTHING on the calendar, cites the call, and guards duplicates', async () => {
    const customer = await createCustomer({ tenantId, name: 'Quote Quentin', phone: '555-8804' });
    const { capture } = await askFor(customer.id);
    const { client, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const opened = await callWith('open_job', {
        customerId: customer.id,
        title: 'replace the water heater',
        jobType: 'plumbing',
      });
      expect(opened.isError).toBe(false);
      expect(opened.data.status).toBe('opened');
      expect(opened.data.jobTitle).toBe('replace the water heater');
      expect(await sourceOf('jobs', opened.data.jobId)).toBe(capture.id);
      // NOTHING on the calendar — the whole reason this verb exists.
      const visits = await pg.query<{ n: string }>(
        'select count(*)::int as n from visits where job_id = $1',
        [opened.data.jobId],
      );
      expect(Number(visits.rows[0].n)).toBe(0);
      const { rows } = await pg.query<{ attributes: { correspondence?: unknown[] } }>(
        'select attributes from jobs where id = $1',
        [opened.data.jobId],
      );
      expect(rows[0].attributes.correspondence).toHaveLength(1);

      // THE MINT GUARD, and it is book_visit's EXACT test, not a stricter one:
      // it fires on a title that NAMES a job already on file — the agent
      // parroting the manager's words for work that exists. A stricter rule
      // here would refuse an open that book_visit would have allowed, and the
      // shared steer's advice ("pass the matching jobId") is not something this
      // tool can even accept.
      const dup = await callWith('open_job', {
        customerId: customer.id,
        title: 'Replace the Water Heater', // same words, different case
      });
      expect(dup.isError).toBe(true);
      expect(dup.text).toContain('NOT opened');
      expect(dup.text).toContain('replace the water heater');
      expect(dup.text).toContain('forceNewJob:true');
      // The steer is shared, so it has to say what to do with THIS tool.
      expect(dup.text).toContain('only opens NEW work');

      // A DISTINCT title is itself the declaration of new work and mints
      // without ceremony — the guard adds no friction there.
      const distinct = await callWith('open_job', {
        customerId: customer.id,
        title: 'a different leak entirely',
      });
      expect(distinct.isError).toBe(false);
      // …and forceNewJob still overrides a genuine collision.
      const forced = await callWith('open_job', {
        customerId: customer.id,
        title: 'replace the water heater',
        forceNewJob: true,
      });
      expect(forced.isError).toBe(false);
    } finally {
      await client.close();
    }

    // A TECHNICIAN cannot open work. The gate is ADMIN_TOOL_NAMES in the
    // dispatch, not the tools/list filter — a technician who somehow named the
    // tool is refused at the door.
    const refused = await call('open_job', { customerId: customer.id, title: 'nope' });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/manager/i);
  });
});

// THE TECHNICIAN LIMITED VIEW (plan 2026-09-15-the-retrieval-layer-2): every
// technician door agrees on what she may open. The rest of this file runs the
// seed tenant at `whole_firm` (see beforeAll); this block puts the shipped
// default back and tests scope itself. The rule's own edge cases live in
// src/db/technicianView.test.ts — this is the tools' side of it.
describe('the technician limited view', () => {
  beforeAll(async () => {
    await setTechnicianViewRule(tenantId, null, 'server.test');
  });
  afterAll(async () => {
    await setTechnicianViewRule(tenantId, { jobScope: 'whole_firm' }, 'server.test');
  });

  test('she reads the customers she serves, and every other door says "outside your view" in words', { timeout: 30_000 }, async () => {
    const lee = await createCustomer({ tenantId, name: 'Viewlee Lin', phone: '555-7101' });
    const leeOpen = await createJob({ tenantId, customerId: lee.id, title: 'Viewlee AC' });
    const leeOther = await createJob({ tenantId, customerId: lee.id, title: 'Viewlee heater' });
    const leePaid = await createJob({ tenantId, customerId: lee.id, title: 'Viewlee old', status: 'paid' });
    await createVisit({ tenantId, jobId: leeOpen.id, technicianId: techMcpId, startsAt: null, endsAt: null });
    const hen = await createCustomer({ tenantId, name: 'Viewhen Henderson', phone: '555-7199' });
    const hJob = await createJob({ tenantId, customerId: hen.id, title: 'Viewhen roof' });
    const hNote = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'someone-else',
      rawText: 'viewhen flashing replaced',
      jobId: hJob.id,
    });

    // Served: the page lists her open job and the customer's other open one, and counts the paid one.
    const ctx = await call('get_customer_context', { customerId: lee.id });
    expect(ctx.data.jobs.map((j: { id: string }) => j.id).sort()).toEqual([leeOpen.id, leeOther.id].sort());
    expect(ctx.data.jobsOutsideView).toBe(1);
    expect(ctx.data.note).toContain('outside your view');
    expect((await call('get_job', { jobId: leeOther.id })).data.title).toBe('Viewlee heater');
    expect((await call('find_customer', { query: 'Viewlee' })).data.customers[0].phone).toBe('555-7101');

    // Not served: a name and an id, never the record.
    const found = await call('find_customer', { query: 'Viewhen' });
    // EXACTLY four keys inside the wrapper (retrieval layer 4 put matches under
    // `customers`): this row is the access-request flow's hook, and a fold or a
    // wrapper refactor spreading the customer row back onto it would hand a
    // technician the record she is not served.
    expect(found.data.customers).toEqual([
      { id: hen.id, name: 'Viewhen Henderson', inView: false, note: expect.stringContaining('outside your view') },
    ]);
    const hCtx = await call('get_customer_context', { customerId: hen.id });
    expect(hCtx.data.inView).toBe(false);
    expect(hCtx.data.customer).toEqual({ id: hen.id, name: 'Viewhen Henderson' });
    expect(hCtx.text).not.toContain('555-7199');
    expect(hCtx.text).not.toContain('Viewhen roof');
    const hGetJob = await call('get_job', { jobId: hJob.id });
    expect(hGetJob.data).toEqual({
      id: hJob.id,
      inView: false,
      note: expect.stringContaining('outside your view'),
      now: expect.any(String), // the hub's grounding rider rides every object result
    });
    expect((await call('get_job', { jobId: leePaid.id })).data.inView).toBe(false);
    const page = await call('list_recent_captures', { jobId: hJob.id });
    expect(page.data.inView).toBe(false);
    expect(page.data.captures).toEqual([]);
    expect(page.data.note).toContain('outside your view');
    const searched = await call('search_captures', { customerId: hen.id, query: 'flashing' });
    expect(searched.data.inView).toBe(false);
    expect(searched.data.count).toBe(0);
    expect((await call('get_capture', { captureId: hNote.id })).data.found).toBe(false);
    // The staged preview would show the value being replaced — so no staging either.
    const fact = await call('record_standing_fact', { customerId: hen.id, key: 'gate_code', value: '1234' });
    expect(fact.isError).toBe(true);
    expect(fact.text).toContain('outside your view');
    const jobFact = await call('record_standing_fact', { jobId: hJob.id, key: 'ladder', value: 'tall' });
    expect(jobFact.isError).toBe(true);
    expect(jobFact.text).toContain('outside your view');

    // A manager's doors are untouched.
    const { client: mgrClient, callWith: mgr } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const m = await mgr('get_customer_context', { customerId: hen.id });
      expect(m.data.jobs.map((j: { id: string }) => j.id)).toEqual([hJob.id]);
      expect(m.data.jobsOutsideView).toBeUndefined();
      expect((await mgr('find_customer', { query: 'Viewhen' })).data.customers[0].phone).toBe('555-7199');
      expect((await mgr('get_job', { jobId: hJob.id })).data.title).toBe('Viewhen roof');
    } finally {
      await mgrClient.close();
    }
  });

  test('a grant opens what the manager picked: the record, or the record and its notes', { timeout: 30_000 }, async () => {
    const cust = await createCustomer({ tenantId, name: 'Grantee Gil' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'Grantee deck' });
    await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'someone-else',
      rawText: 'deck boards soft by the stairs',
      jobId: job.id,
    });
    const phone = await appendRawCapture({
      tenantId,
      channel: 'phone_call',
      rawText: 'quoted $2,900 for the deck',
      jobId: job.id,
    });
    expect((await call('get_customer_context', { customerId: cust.id })).data.inView).toBe(false);

    await insertAccessGrant({
      tenantId,
      technicianId: techMcpId,
      customerId: cust.id,
      opens: 'record',
      grantedBy: 'mgr-test',
      reason: 'covering the deck job',
    });
    const opened = await call('get_customer_context', { customerId: cust.id });
    const block = opened.data.jobs.find((j: { id: string }) => j.id === job.id);
    expect(block.noteCount).toBe(1);
    expect(block.restrictedCount).toBe(1);
    expect((await call('get_capture', { captureId: phone.id })).data.found).toBe(false);

    await insertAccessGrant({
      tenantId,
      technicianId: techMcpId,
      jobId: job.id,
      opens: 'record_and_notes',
      grantedBy: 'mgr-test',
      reason: 'she needs the quote',
    });
    const withNotes = await call('get_capture', { captureId: phone.id });
    expect(withNotes.data.found).toBe(true);
    expect(withNotes.data.rawText).toContain('$2,900');
  });

  test('money is words by default, and figures once the firm or a grant opens them', { timeout: 30_000 }, async () => {
    const cust = await createCustomer({ tenantId, name: 'Moneyview Mo' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'Moneyview panel' });
    await createVisit({ tenantId, jobId: job.id, technicianId: techMcpId, startsAt: null, endsAt: null });
    const { client: mgrClient, callWith: mgrCall } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      await mgrCall('record_money_event', { jobId: job.id, kind: 'invoice_issued', amountCents: 62000 });

      const words = await call('get_job', { jobId: job.id });
      expect(words.data.money).toEqual({ status: 'invoiced, not yet paid' });
      // …and the JOB ROW's own price goes with the figures: it is the same
      // number, one key over (review finding).
      expect(words.data.price_cents).toBeUndefined();
      const wordsCtx = await call('get_customer_context', { customerId: cust.id });
      expect(wordsCtx.data.jobs[0].price_cents).toBeUndefined();
      // A manager keeps it.
      expect((await mgrCall('get_job', { jobId: job.id })).data).toHaveProperty('price_cents');

      // The firm opens the figures for its technicians.
      await setTechnicianViewRule(tenantId, { money: 'amounts' }, 'server.test');
      try {
        const withFigures = await call('get_job', { jobId: job.id });
        expect(withFigures.data).toHaveProperty('price_cents'); // opened money keeps the price too
        expect(withFigures.data.money).toEqual({
          status: 'invoiced, not yet paid',
          invoicedCents: 62000,
          balanceDueCents: 62000,
        });
        const ctx = await call('get_customer_context', { customerId: cust.id });
        expect(ctx.data.moneyByJob[job.id].invoicedCents).toBe(62000);
      } finally {
        await setTechnicianViewRule(tenantId, null, 'server.test');
      }

        // The manager's own retraction preview still names the amounts (the strip
      // is the technician's, and a forgotten flag must not take a manager's).
      const noteForMoney = await appendRawCapture({
        tenantId,
        channel: 'technician_note',
        technicianRef: 'tech-mcp',
        rawText: 'took a cheque for the panel',
        customerId: cust.id,
        jobId: job.id,
      });
      await mgrCall('record_money_event', {
        jobId: job.id,
        kind: 'payment_received',
        amountCents: 20000,
        sourceCaptureId: noteForMoney.id,
      });
      const mgrStage = await mgrCall('retract_capture', { captureId: noteForMoney.id, reason: 'wrong job' });
      expect(mgrStage.data.alsoLosesEvidence.money[0]).toMatchObject({ amountCents: 20000 });

      // …or one manager's grant, on this job alone.
      await insertAccessGrant({
        tenantId,
        technicianId: techMcpId,
        jobId: job.id,
        opens: 'record',
        opensMoney: true,
        grantedBy: 'mgr-test',
        reason: 'collecting the payment on site',
      });
      // 62000 invoiced, 20000 taken on the retracted note (money never folds).
      const granted = await call('get_job', { jobId: job.id });
      expect(granted.data.money).toEqual({
        status: 'part paid, balance outstanding',
        invoicedCents: 62000,
        balanceDueCents: 42000,
      });
      const other = await createJob({ tenantId, customerId: cust.id, title: 'Moneyview second' });
      await mgrCall('record_money_event', { jobId: other.id, kind: 'invoice_issued', amountCents: 15000 });
      const stillWords = await call('get_job', { jobId: other.id });
      expect(stillWords.data.money).toEqual({ status: 'invoiced, not yet paid' });
      // A manager's own read is untouched by any of it.
      expect((await mgrCall('get_job', { jobId: job.id })).data.money.invoicedCents).toBe(62000);
    } finally {
      await mgrClient.close();
    }
  });

  test("under own_trips, an upcoming trip on the customer's other job is not listed", { timeout: 30_000 }, async () => {
    const cust = await createCustomer({ tenantId, name: 'Tripwise Tia' });
    const mine = await createJob({ tenantId, customerId: cust.id, title: 'Tripwise mine' });
    const other = await createJob({ tenantId, customerId: cust.id, title: 'Tripwise other' });
    await createVisit({ tenantId, jobId: mine.id, technicianId: techMcpId, startsAt: null, endsAt: null });
    await createVisit({
      tenantId,
      jobId: other.id,
      startsAt: nl(`${relDay(4)}T10:00:00.000Z`),
      endsAt: nl(`${relDay(4)}T11:00:00.000Z`),
      status: 'confirmed',
    });
    const served = await call('get_customer_context', { customerId: cust.id });
    expect(served.data.upcomingVisits.map((u: { jobId: string }) => u.jobId)).toEqual([other.id]);

    await setTechnicianViewRule(tenantId, { jobScope: 'own_trips' }, 'server.test');
    try {
      const narrow = await call('get_customer_context', { customerId: cust.id });
      expect(narrow.data.jobs.map((j: { id: string }) => j.id)).toEqual([mine.id]);
      expect(narrow.data.upcomingVisits).toEqual([]);
    } finally {
      await setTechnicianViewRule(tenantId, null, 'server.test');
    }
  });
});

// ACCESS PLAN A (thoughts/shared/plans/2026-09-19-access-plan-a-the-managers-access-tools.md):
// the manager's four access doors, through the same MCP server a seat calls.
// The rest of this file runs the seed firm at `whole_firm`, which would hide
// every scope effect, so this block puts the shipped default back (plan 2's
// finding 5: a rule left on the shared tenant is invisible to the file that does
// not set it). Grants are LEDGER rows with no delete path, so they are truncated
// after every test: one live `everywhere` grant would open the figures for every
// later test in the file.
describe('the access tools', () => {
  let mgr: Awaited<ReturnType<typeof clientFor>>;
  let planner: Awaited<ReturnType<typeof clientFor>>;

  beforeAll(async () => {
    await setTechnicianViewRule(tenantId, null, 'server.test');
    mgr = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    planner = await clientFor({ tenantId, technicianRef: 'spine:team-lead' });
  });

  afterEach(async () => {
    await pg.query('truncate table access_grants');
    // A grant now texts the technician AND notes her seat, so this block leaves
    // rows in two shared tables. Not truncating them leaked 6 pushes into the
    // next describe, where they read as "every manager was texted six times".
    await pg.query('truncate table person_pushes');
    // 'news' is the office's copy of each decision (rung 10c); 'inform' is the
    // note to the technician's seat.
    await pg.query("delete from office_messages where kind in ('inform', 'news')");
    await setTechnicianViewRule(tenantId, null, 'server.test');
  });

  afterAll(async () => {
    await mgr.client.close();
    await planner.client.close();
    await pg.query('truncate table access_grants');
    await setTechnicianViewRule(tenantId, { jobScope: 'whole_firm' }, 'server.test');
  });

  // One customer tech-mcp does not serve: two open jobs and one paid.
  async function outsider(name: string) {
    const customer = await createCustomer({ tenantId, name, phone: '555-8100' });
    const open = await createJob({ tenantId, customerId: customer.id, title: `${name} AC`, priceCents: 40000 });
    const other = await createJob({ tenantId, customerId: customer.id, title: `${name} heater` });
    const paid = await createJob({ tenantId, customerId: customer.id, title: `${name} old`, status: 'paid' });
    return { customer, open, other, paid };
  }

  test('a job grant opens that job for a week, and the reply names the day it ends', async () => {
    const { customer, open, other } = await outsider('Grantlee Ng');
    expect((await call('get_job', { jobId: open.id })).data.inView).toBe(false);

    const granted = await mgr.callWith('grant_access', {
      technician: 'tech-mcp',
      jobId: open.id,
      reason: 'covering tomorrow',
    });
    expect(granted.isError).toBe(false);
    // SEVEN days, in the firm's own calendar, and said as a weekday the manager
    // can repeat. A changed default would pass a shape check; this one fails.
    const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
    const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(granted.data.granted.until).toBe(`until ${servedDayPhrase(localDateISO(inAWeek, tz))}`);
    expect(granted.data.granted.notes).toBe(false);
    expect(granted.data.granted.money).toBe(false);
    expect(granted.data.granted.what).toContain('Grantlee Ng');
    expect(granted.data.note).toContain('nothing to relay');

    const seen = await call('get_job', { jobId: open.id });
    expect(seen.data.title).toBe(`${customer.name} AC`);
    expect(seen.data.price_cents).toBeUndefined(); // money stays words-only
    // …and nothing else of that customer's opened with it.
    expect((await call('get_job', { jobId: other.id })).data.inView).toBe(false);
  });

  test('money: true opens the figures on that job only', async () => {
    const { open, other } = await outsider('Grantmo Ng');
    await mgr.callWith('grant_access', {
      technician: 'tech-mcp', jobId: open.id, money: true, days: 3, reason: 'collecting on site',
    });
    const withMoney = await call('get_job', { jobId: open.id });
    expect(withMoney.data.price_cents).toBe(40000);
    expect((await call('get_job', { jobId: other.id })).data.inView).toBe(false);
  });

  test('a customer grant opens every job of theirs, finished ones included', async () => {
    const { customer, paid } = await outsider('Grantcus Ng');
    await mgr.callWith('grant_access', {
      technician: 'tech-mcp', customerId: customer.id, reason: 'taking over the account',
    });
    expect((await call('get_job', { jobId: paid.id })).data.title).toContain('old');
    const page = await call('get_customer_context', { customerId: customer.id });
    expect(page.data.inView).not.toBe(false);
    expect(page.data.jobs.length).toBe(3);
  });

  test('everywhere opens the figures on everything she can already open, and no new record', async () => {
    const { open } = await outsider('Grantev Ng');
    const granted = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', everywhere: true, money: true, reason: 'she collects payments',
    });
    expect(granted.data.granted.until).toBe('until revoked');
    // Her OWN job now shows figures…
    const ownJob = await createJob({ tenantId, customerId: (await outsider('Grantown Ng')).customer.id, title: 'own work', priceCents: 12300 });
    await createVisit({ tenantId, jobId: ownJob.id, technicianId: techMcpId, startsAt: null, endsAt: null });
    expect((await call('get_job', { jobId: ownJob.id })).data.price_cents).toBe(12300);
    // …and the out-of-view job is still out of view.
    expect((await call('get_job', { jobId: open.id })).data.inView).toBe(false);
  });

  test('everywhere without money, and two scopes at once, are refused', async () => {
    const { open } = await outsider('Grantref Ng');
    expect((await mgr.callWith('grant_access', { technician: 'tech-mcp', everywhere: true, reason: 'x' })).isError).toBe(true);
    const twoScopes = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', jobId: open.id, everywhere: true, money: true, reason: 'x',
    });
    expect(twoScopes.isError).toBe(true);
    expect(twoScopes.text).toContain('exactly one');
    // A manager is refused as a target: managers already see everything.
    const atManager = await mgr.callWith('grant_access', { technician: 'mgr-test', jobId: open.id, reason: 'x' });
    expect(atManager.isError).toBe(true);
  });

  test('list_access shows the live grants and the firm rule; revoke_access ends one', async () => {
    const { customer, open } = await outsider('Grantlist Ng');
    const granted = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', jobId: open.id, opens: 'record_and_notes', reason: 'covering tomorrow',
    });
    const listed = await mgr.callWith('list_access', {});
    expect(listed.data.count).toBe(1);
    expect(listed.data.grants[0].id).toBe(granted.data.granted.id);
    expect(listed.data.grants[0].technicianRef).toBe('tech-mcp');
    expect(listed.data.grants[0].notes).toBe(true);
    expect(listed.data.grants[0].what).toContain(customer.name);
    expect(listed.data.firmRule.money).toContain('the default');

    const revoked = await mgr.callWith('revoke_access', {
      grantId: granted.data.granted.id, reason: 'job finished',
    });
    expect(revoked.data.revoked).toBe(true);
    expect((await call('get_job', { jobId: open.id })).data.inView).toBe(false);
    expect((await mgr.callWith('list_access', {})).data.count).toBe(0);
    // Twice, and on nonsense: an answer, never an error.
    expect((await mgr.callWith('revoke_access', { grantId: granted.data.granted.id, reason: 'again' })).data.revoked).toBe(false);
    const nonsense = await mgr.callWith('revoke_access', { grantId: 'not-an-id', reason: 'x' });
    expect(nonsense.isError).toBe(false);
    expect(nonsense.data.revoked).toBe(false);
  });

  test('set_technician_view changes only what it names, and reset puts a setting back', async () => {
    const wider = await mgr.callWith('set_technician_view', { jobScope: 'serving_history' });
    expect(wider.data.changes).toHaveLength(1);
    const money = await mgr.callWith('set_technician_view', { money: 'amounts' });
    expect(money.data.rule.jobScope).toContain("all of those customers' jobs"); // kept
    expect(money.data.rule.money).toContain('dollar figures');
    expect((await getTechnicianViewRule(tenantId))?.job_scope).toBe('serving_history');

    const back = await mgr.callWith('set_technician_view', { reset: ['money'] });
    expect(back.data.rule.money).toContain('the default');
    expect((await getTechnicianViewRule(tenantId))?.money).toBeNull();

    expect((await mgr.callWith('set_technician_view', { technicianChannels: [] })).isError).toBe(true);
    expect((await mgr.callWith('set_technician_view', {})).isError).toBe(true);

    // hiddenTags is the other way round: an empty list IS "hide nothing", the
    // default, so it stores null and only reports a change when one happened.
    const hidden = await mgr.callWith('set_technician_view', { hiddenTags: ['pricing'] });
    expect(hidden.data.rule.hiddenTags).toBe('pricing');
    const cleared = await mgr.callWith('set_technician_view', { hiddenTags: [] });
    expect(cleared.data.changes).toHaveLength(1);
    expect((await getTechnicianViewRule(tenantId))?.hidden_tags).toBeNull();
    expect((await mgr.callWith('set_technician_view', { hiddenTags: [] })).data.changes).toHaveLength(0);
  });

  test('a technician badge is refused all four doors, and never sees them listed', async () => {
    const names = ((await client.listTools()).tools as Array<{ name: string }>).map((t) => t.name);
    for (const tool of ['grant_access', 'list_access', 'revoke_access', 'set_technician_view']) {
      expect(names).not.toContain(tool);
      const refused = await call(tool, {});
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('admin tools require a manager badge');
    }
  });

  test('the planner reads the grant history and nothing of another firm', async () => {
    const { open } = await outsider('Granthist Ng');
    await mgr.callWith('grant_access', { technician: 'tech-mcp', jobId: open.id, reason: 'history check' });
    // A second firm's grant, which this firm's planner must never see: the view's
    // tenant predicate is the only thing standing between them, and `reason` is
    // free manager text that routinely names a customer.
    const otherTenant = await createTenant(`grant-history-${Date.now()}`, { technicianSeats: 1 });
    const otherTech = await insertTechnician({ tenantId: otherTenant.id, ref: 'their-tech', displayName: 'Their Tech' });
    const otherCustomer = await createCustomer({ tenantId: otherTenant.id, name: 'Their Customer' });
    await insertAccessGrant({
      tenantId: otherTenant.id,
      technicianId: otherTech.id,
      customerId: otherCustomer.id,
      opens: 'record',
      grantedBy: 'their-mgr',
      reason: 'another firm entirely',
    });

    const read = await planner.callWith('spine_read', {
      sql: 'select technician_ref, job_title, reason, live from v_access_grants',
    });
    expect(read.isError).toBe(false);
    expect(read.text).toContain('history check');
    expect(read.text).toContain('tech-mcp');
    expect(read.text).not.toContain('another firm entirely');
    expect(read.text).not.toContain('their-tech');
    // The planner holds no grant door of its own.
    const refused = await planner.callWith('grant_access', { technician: 'tech-mcp', jobId: open.id, reason: 'x' });
    expect(refused.isError).toBe(true);
  });
});

// ── the access REQUEST flow: ask_team_lead's accessRequest (plan B, phase 1) ──
//
// The office's judgment is unit-tested hermetically in src/teamLead/office.test.ts;
// here the office has no model, so every ask takes the code fallback.
// What this block tests is the part only a real server can answer: that the
// dispatch door threads the caller's identity into the request, that the
// sensitive shape really does reach the managers through the push queue, and
// that a technician's seat gets back words rather than ids.
describe('the access request flow', () => {
  let mgr: Awaited<ReturnType<typeof clientFor>>;

  beforeAll(async () => {
    // The firm at its DEFAULT width: the suite's own rule is whole_firm, under
    // which tech-mcp sees everything and there is nothing to request.
    await setTechnicianViewRule(tenantId, null, 'server.test');
    // A manager who can actually be texted: listManagersWithTelegram needs the
    // binding, and the desk drops anyone with no sandbox.
    await pg.query(
      "update technicians set telegram_user_id = '900900', sandbox_ref = 'sbx-mgr' where ref = 'mgr-test'",
    );
    mgr = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    // A SECOND technician, so "the manager named somebody else" is a real
    // misdirection rather than a manager-tier refusal in disguise.
    const other = await insertTechnician({ tenantId, ref: 'tech-other', displayName: 'Other Tech' });
    await setTechnicianState(other.id, 'active');
  });

  // The office inbox is shared with every other suite in this file (mgr-test
  // informs the planner in several of them), so the access lines are cleared
  // around each test rather than counted against whatever else has run.
  const clearInbox = () =>
    // 'news' is the office's copy (rung 10c); 'inform' is the note to her seat.
    pg.query("delete from office_messages where kind in ('inform', 'news') and from_ref = 'mgr-test'");

  beforeEach(async () => {
    await clearInbox();
  });

  afterEach(async () => {
    await pg.query('truncate table access_grants');
    await pg.query('truncate table person_pushes');
    await pg.query("delete from observations where kind = 'access_request'");
    await clearInbox();
    await setTechnicianViewRule(tenantId, null, 'server.test');
  });

  afterAll(async () => {
    await mgr.client.close();
    await pg.query('truncate table access_grants');
    await pg.query('truncate table person_pushes');
    await pg.query("delete from observations where kind = 'access_request'");
    await pg.query(
      "update technicians set telegram_user_id = null, sandbox_ref = null where ref = 'mgr-test'",
    );
    await pg.query("delete from technicians where ref = 'tech-other'");
    await setTechnicianViewRule(tenantId, { jobScope: 'whole_firm' }, 'server.test');
  });

  async function outsideJob(name: string) {
    const customer = await createCustomer({ tenantId, name, phone: '555-8300' });
    const job = await createJob({ tenantId, customerId: customer.id, title: `${name} AC`, priceCents: 40000 });
    return { customer, job };
  }

  test('a money request is filed and every reachable manager is texted', async () => {
    const { job } = await outsideJob('Reqmoney Ng');
    expect((await call('get_job', { jobId: job.id })).data.inView).toBe(false);

    const res = await call('ask_team_lead', {
      question: 'the customer is asking me what they still owe',
      accessRequest: { jobId: job.id, wants: 'money' },
    });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe('asked_manager');
    expect(res.data.answer).toContain('Manager Test');

    // The request is on the record, open, with the technician's words.
    const rows = await pg.query(
      "select technician_id, status, author, context from observations where kind = 'access_request'",
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('open');
    expect(rows.rows[0].author).toBe('planner');
    expect(rows.rows[0].context.wants).toBe('money');
    expect(rows.rows[0].context.why).toContain('what they still owe');

    // …and the manager has a text waiting, on the access kind.
    const pushes = await pg.query('select kind, body, technician_id from person_pushes');
    expect(pushes.rows).toHaveLength(1);
    expect(pushes.rows[0].kind).toBe('access');
    expect(pushes.rows[0].body).toContain('Tech MCP');
    // NO IDS IN THE CHAT — the manager's seat finds it with list_access.
    expect(pushes.rows[0].body).not.toContain(job.id);
    expect(res.data.answer).not.toContain(job.id);

    // Nothing was opened by asking.
    expect((await call('get_job', { jobId: job.id })).data.inView).toBe(false);
  });

  test('the same money request twice files one row and sends one text', async () => {
    const { job } = await outsideJob('Reqtwice Ng');
    const args = {
      question: 'still chasing the balance',
      accessRequest: { jobId: job.id, wants: 'money' as const },
    };
    const first = await call('ask_team_lead', args);
    const second = await call('ask_team_lead', args);
    expect(first.data.status).toBe('asked_manager');
    expect(second.data.status).toBe('already_asked');
    expect((await pg.query("select 1 from observations where kind = 'access_request'")).rows).toHaveLength(1);
    expect((await pg.query('select 1 from person_pushes')).rows).toHaveLength(1);
  });

  test('a narrow ask is NOT opened by the office — it goes to a manager like everything else', async () => {
    const { job } = await outsideJob('Reqnarrow Ng');
    expect((await call('get_job', { jobId: job.id })).data.inView).toBe(false);

    // THE WHOLE PATH IS REAL — no stub anywhere, because there is no model call
    // left to stub. The office cannot open a record (operator, 2026-09-20): the
    // firm promises its customers that a technician sees their own work unless
    // the firm widens it deliberately, so consent is a manager's to give.
    const res = await call('ask_team_lead', {
      question: 'I am at the gate and need the code',
      accessRequest: { jobId: job.id },
    });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe('asked_manager');

    // NOTHING WAS OPENED, and the job reads exactly as it did before.
    expect((await pg.query('select 1 from access_grants')).rows).toHaveLength(0);
    expect((await call('get_job', { jobId: job.id })).data.inView).toBe(false);

    // It became a request a manager can answer, and they were texted.
    const reqs = await pg.query(
      "select context->>'wants' as wants from observations where kind = 'access_request' and status = 'open'",
    );
    expect(reqs.rows).toHaveLength(1);
    expect(reqs.rows[0].wants).toBe('record');
    expect((await pg.query("select 1 from person_pushes where kind = 'access'")).rows).toHaveLength(1);
  });
  test('the desk is reached with the caller identity, and its answer is relayed verbatim', async () => {
    const { job } = await outsideJob('Reqthread Ng');
    const accessDesk = vi.fn(async () => ({ status: 'opened' as const, answer: 'Opened for you until Sunday.' }));
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'tech-mcp' },
      { accessDesk: accessDesk as unknown as ServerDeps['accessDesk'] },
    );
    try {
      const res = await callWith('ask_team_lead', {
        question: '  I need\nthe gate code  ',
        accessRequest: { jobId: job.id, wants: 'record' },
      });
      expect(res.isError).toBe(false);
      expect(res.data.status).toBe('opened');
      expect(res.data.answer).toBe('Opened for you until Sunday.');
      expect(accessDesk).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId,
          askerRef: 'tech-mcp',
          askerName: 'Tech MCP',
          askerTier: 'technician',
          askerTechnicianId: techMcpId,
          activeManager: false,
          why: 'I need the gate code', // the same hygiene the question gets
          jobId: job.id,
          wants: 'record',
        }),
        expect.anything(),
      );
    } finally {
      await c.close();
    }
  });

  // DOCTRINE PINS, from a live run where both went wrong (2026-09-20). Prose,
  // not behaviour — but prose the seat acts on, and prose that silently rots is
  // how we got an over-wide grant and a promise nothing could keep.
  test('the tool tells the seat to ask for the LEAST that answers the person', async () => {
    const { client: c, callWith } = await clientFor({ tenantId, technicianRef: 'tech-mcp' });
    try {
      const listed = await c.listTools();
      const ask = listed.tools.find((t) => t.name === 'ask_team_lead');
      const req = (ask?.inputSchema as { properties?: Record<string, { description?: string }> })
        ?.properties?.accessRequest as unknown as { description?: string; properties?: Record<string, { description?: string }> };
      // A manager opens exactly what was asked for, so an over-wide ask is an
      // over-wide grant — and the customer never agreed to that.
      expect(req?.description).toContain('ASK FOR THE LEAST THAT ANSWERS THEM');
      // The instruction must be one the seat can actually FOLLOW: a customer
      // outside its view lists no jobs, so "use jobId even when you looked the
      // job up through the customer" was unactionable and was measured failing
      // twice. It now points at the tool that does hand over an id, and says
      // the office narrows the rest.
      expect(req?.description).toContain('whenever a tool has given you one');
      expect(req?.description).toContain('the office narrows that');
      expect(req?.properties?.customerId?.description).toContain('EVERY job');
      expect(req?.properties?.customerId?.description).toContain('never as a shortcut');
      // …and it must not promise an opening the office cannot make.
      expect(req?.description).toContain('ONLY A MANAGER CAN OPEN A RECORD');
      void callWith;
    } finally {
      await c.close();
    }
  });

  test('a request with no reason, or a bad wants, is refused before anything is filed', async () => {
    const { job } = await outsideJob('Reqbad Ng');
    const noWhy = await call('ask_team_lead', { question: '   ', accessRequest: { jobId: job.id } });
    expect(noWhy.isError).toBe(true);
    expect(noWhy.text).toContain('question is required');

    const badWants = await call('ask_team_lead', {
      question: 'need it',
      accessRequest: { jobId: job.id, wants: 'everything' },
    });
    expect(badWants.isError).toBe(true);
    expect(badWants.text).toContain('wants must be');

    expect((await pg.query("select 1 from observations where kind = 'access_request'")).rows).toHaveLength(0);
    expect((await pg.query('select 1 from person_pushes')).rows).toHaveLength(0);
  });

  test('a manager asking for access is told they already see everything', async () => {
    const { job } = await outsideJob('Reqmgr Ng');
    const res = await mgr.callWith('ask_team_lead', {
      question: 'can I see this',
      accessRequest: { jobId: job.id, wants: 'money' },
    });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe('refused');
    expect((await pg.query('select 1 from person_pushes')).rows).toHaveLength(0);
  });

  // ── the note says what it assumed (phase 4) ───────────────────────────────

  test('a note on a colleague\'s trip comes back with `assumed`, and is still recorded', async () => {
    const customer = await createCustomer({ tenantId, name: 'Assumedsrv Ng', phone: '555-8402' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Assumedsrv work' });
    // ONE live trip on the job, crewed by the MANAGER — so the technician's
    // note falls to step 2 and lands on somebody else's trip.
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianIds: [
        (await pg.query("select id from technicians where ref = 'mgr-test'")).rows[0].id as string,
      ],
      startsAt: null,
      endsAt: null,
      status: 'confirmed',
    });
    const res = await call('record_field_note', {
      text: 'picked this one up for them, it is done',
      confirmed: { customerId: customer.id },
    });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe('recorded');
    expect(Array.isArray(res.data.assumed)).toBe(true);
    expect(res.data.assumed.join(' ')).toContain("not on that trip's crew");
    // A person reads this: no ids, no roster refs.
    expect(res.data.assumed.join(' ')).not.toContain(job.id);
    expect(res.data.assumed.join(' ')).not.toContain('mgr-test');
  });

  test('a MANAGER filing is never told they are off a crew — they never are', async () => {
    const customer = await createCustomer({ tenantId, name: 'Assumedmgr Ng', phone: '555-8404' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Assumedmgr work' });
    // The trip is the TECHNICIAN's; the manager files the note.
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianIds: [techMcpId],
      startsAt: null,
      endsAt: null,
      status: 'confirmed',
    });
    const res = await mgr.callWith('record_field_note', {
      text: 'spoke to the customer, they are happy',
      confirmed: { customerId: customer.id },
    });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe('recorded');
    // A manager is not on crews. Telling them so every time would cost the seat
    // a question and the planner an item, for a fact that is always true.
    expect(res.data.assumed).toBeUndefined();
  });

  test('an ordinary filing has no `assumed` key', async () => {
    const customer = await createCustomer({ tenantId, name: 'Assumedord Ng', phone: '555-8403' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Assumedord work' });
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianIds: [techMcpId],
      startsAt: null,
      endsAt: null,
      status: 'confirmed',
    });
    const res = await call('record_field_note', {
      text: 'finished it this morning',
      confirmed: { customerId: customer.id },
    });
    expect(res.isError).toBe(false);
    expect(res.data.status).toBe('recorded');
    expect(res.data.assumed).toBeUndefined();
  });

  // ── the ANSWER (phase 2) ───────────────────────────────────────────────────

  // File a real request the way a technician does, and hand back its id.
  async function fileRequest(name: string, wants: 'record' | 'notes' | 'money' = 'money') {
    const { customer, job } = await outsideJob(name);
    const asked = await call('ask_team_lead', {
      question: 'the customer is asking me about it',
      accessRequest: { jobId: job.id, wants },
    });
    expect(asked.data.status).toBe('asked_manager');
    const row = await pg.query(
      "select id from observations where kind = 'access_request' and status = 'open'",
    );
    expect(row.rows).toHaveLength(1);
    await pg.query('truncate table person_pushes'); // the manager's own text, already counted
    return { customer, job, requestId: row.rows[0].id as string };
  }

  test('grant_access { requestId } opens it, closes the request, texts them and tells the office', async () => {
    const { job, requestId } = await fileRequest('Ansgrant Ng');

    const granted = await mgr.callWith('grant_access', { requestId, reason: 'fair enough' });
    expect(granted.isError).toBe(false);
    // The request supplied who and what — the manager named neither.
    expect(granted.data.granted.technician).toBe('Tech MCP');
    expect(granted.data.granted.money).toBe(true); // wants:'money' carried through
    expect(granted.data.granted.answeredRequest).toBe(true);

    // The job really opens, figures included.
    const seen = await call('get_job', { jobId: job.id });
    expect(seen.data.inView).toBeUndefined();
    expect(seen.data.price_cents).toBe(40000);

    // The request is closed, and says who answered and how.
    const req = await pg.query('select status, dismiss_reason from observations where id = $1', [requestId]);
    expect(req.rows[0].status).toBe('dismissed');
    expect(req.rows[0].dismiss_reason).toContain('opened by Manager Test');

    // The technician is texted…
    const pushes = await pg.query('select kind, body, technician_id from person_pushes');
    expect(pushes.rows).toHaveLength(1);
    expect(pushes.rows[0].technician_id).toBe(techMcpId);
    expect(pushes.rows[0].kind).toBe('access');
    expect(pushes.rows[0].body).toContain('Manager Test');
    expect(pushes.rows[0].body).not.toContain(job.id);

    // …and the office has one line about it.
    const inbox = await pg.query(
      "select kind, from_ref, to_ref, body from office_messages " +
        "where kind = 'news' and from_ref = 'mgr-test' and direction = 'to_planner'",
    );
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].to_ref).toBe(TEAM_LEAD_REF);
    expect(inbox.rows[0].body).toContain('Tech MCP');
    // The seat is told not to relay, because the technician already knows.
    expect(granted.data.note).toContain('nothing to relay');
  });

  test('the FIRST answer wins: a second one is refused and writes no second grant', async () => {
    const { requestId } = await fileRequest('Ansfirst Ng');
    const first = await mgr.callWith('grant_access', { requestId, reason: 'yes' });
    expect(first.isError).toBe(false);

    const second = await mgr.callWith('grant_access', { requestId, reason: 'yes again' });
    expect(second.isError).toBe(true);
    expect(second.text).toContain('no longer open');
    expect(second.text).toContain('opened by Manager Test');
    expect((await pg.query('select 1 from access_grants')).rows).toHaveLength(1);

    const declined = await mgr.callWith('decline_access', { requestId, reason: 'changed my mind' });
    expect(declined.isError).toBe(false);
    expect(declined.data.declined).toBe(false);
    expect(declined.data.note).toContain('no longer open');
  });

  test('decline_access closes it with the reason, texts them, and opens nothing', async () => {
    const { job, requestId } = await fileRequest('Ansno Ng');
    const res = await mgr.callWith('decline_access', {
      requestId,
      reason: 'the customer asked us not to share figures',
    });
    expect(res.isError).toBe(false);
    expect(res.data.declined).toBe(true);

    const req = await pg.query('select status, dismiss_reason from observations where id = $1', [requestId]);
    expect(req.rows[0].status).toBe('dismissed');
    expect(req.rows[0].dismiss_reason).toContain('declined by Manager Test');
    expect(req.rows[0].dismiss_reason).toContain('asked us not to share');

    // Nothing opened.
    expect((await pg.query('select 1 from access_grants')).rows).toHaveLength(0);
    expect((await call('get_job', { jobId: job.id })).data.inView).toBe(false);

    // THE REASON REACHES THE TECHNICIAN, in the manager's own words.
    const pushes = await pg.query('select body, technician_id from person_pushes');
    expect(pushes.rows).toHaveLength(1);
    expect(pushes.rows[0].technician_id).toBe(techMcpId);
    expect(pushes.rows[0].body).toContain('asked us not to share figures');
  });

  test('list_access shows what is waiting, and a lone request says a plain yes answers it', async () => {
    const { requestId } = await fileRequest('Anslist Ng', 'notes');
    const listed = await mgr.callWith('list_access', {});
    expect(listed.isError).toBe(false);
    expect(listed.data.openRequests).toHaveLength(1);
    expect(listed.data.openRequests[0].id).toBe(requestId);
    expect(listed.data.openRequests[0].technician).toBe('Tech MCP');
    expect(listed.data.openRequests[0].wants).toBe('notes');
    expect(listed.data.requestNote).toContain('plain "yes"');

    // Answered requests leave the list.
    await mgr.callWith('decline_access', { requestId, reason: 'no' });
    expect((await mgr.callWith('list_access', {})).data.openRequests).toHaveLength(0);
  });

  test('a technician badge cannot decline, and cannot grant', async () => {
    const { requestId } = await fileRequest('Anstech Ng');
    const declined = await call('decline_access', { requestId, reason: 'letting myself off' });
    expect(declined.isError).toBe(true);
    expect(declined.text).toContain('manager badge');
    const req = await pg.query('select status from observations where id = $1', [requestId]);
    expect(req.rows[0].status).toBe('open');
  });

  test('a revoke tells the office too', async () => {
    const { job } = await outsideJob('Ansrevoke Ng');
    const granted = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', jobId: job.id, reason: 'covering',
    });
    await clearInbox();
    const revoked = await mgr.callWith('revoke_access', {
      grantId: granted.data.granted.id, reason: 'job reassigned',
    });
    expect(revoked.isError).toBe(false);
    expect(revoked.data.revoked).toBe(true);
    expect(revoked.data.stillOpen).toBe(false);
    const inbox = await pg.query(
      "select body from office_messages where kind = 'news' and from_ref = 'mgr-test' " +
        "and direction = 'to_planner'",
    );
    expect(inbox.rows).toHaveLength(1);
    expect(inbox.rows[0].body).toContain('Revoked');
    expect(inbox.rows[0].body).toContain('job reassigned');
  });

  // ── an access change reaches BOTH the person and her seat (2026-09-20) ────
  //
  // Found in live testing: a manager opened a record and the technician's seat
  // went on saying "that is outside your view", truthfully as far as it knew,
  // because nothing had told it otherwise. Two legs, two different jobs.

  test('an UNPROMPTED grant texts her AND notes her seat', async () => {
    const { job } = await outsideJob('Seatnote Ng');
    const granted = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', jobId: job.id, reason: 'covering tomorrow',
    });
    expect(granted.isError).toBe(false);

    // Leg A — her phone. This did not happen before: an unprompted grant told
    // the manager "let them know" and reached her not at all.
    const pushes = await pg.query('select kind, technician_id, body from person_pushes');
    expect(pushes.rows).toHaveLength(1);
    expect(pushes.rows[0].technician_id).toBe(techMcpId);
    expect(pushes.rows[0].kind).toBe('access');

    // Leg B — her SEAT's session, which is the staleness fix.
    const seat = await pg.query(
      "select from_ref, to_ref, technician_id, status, body from office_messages " +
        "where direction = 'to_agent' and kind = 'inform'",
    );
    expect(seat.rows).toHaveLength(1);
    expect(seat.rows[0].to_ref).toBe('tech-mcp');
    expect(seat.rows[0].technician_id).toBe(techMcpId);
    expect(seat.rows[0].status).toBe('queued');
    // From the MANAGER, not the office: the office did not decide this, and
    // wrapOfficeMessage renders a team-lead row as "OFFICE NOTE".
    expect(seat.rows[0].from_ref).toBe('mgr-test');
    // …and it tells the seat the thing that fixes the bug.
    expect(seat.rows[0].body).toContain('check it again');
    expect(seat.rows[0].body).not.toContain(job.id);

    // The manager is no longer told to relay it themselves.
    expect(granted.data.note).toContain('nothing to relay');
    expect(granted.data.note).not.toContain('let them know');
  });

  test('a REVOKE notes her seat too — the asymmetry that promised access that was gone', async () => {
    const { job } = await outsideJob('Seatrevoke Ng');
    const granted = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', jobId: job.id, reason: 'covering',
    });
    await pg.query("delete from office_messages where direction = 'to_agent'");
    await pg.query('truncate table person_pushes');

    const revoked = await mgr.callWith('revoke_access', {
      grantId: granted.data.granted.id, reason: 'job reassigned',
    });
    expect(revoked.data.revoked).toBe(true);

    const seat = await pg.query(
      "select to_ref, body from office_messages where direction = 'to_agent'",
    );
    expect(seat.rows).toHaveLength(1);
    expect(seat.rows[0].to_ref).toBe('tech-mcp');
    // NEUTRAL: a revoke may close nothing (another grant or the firm's rule can
    // still open it), so it says access CHANGED, never that it ended.
    expect(seat.rows[0].body).toContain('has changed');
    expect(seat.rows[0].body).not.toContain('no longer');
    // Her PHONE is deliberately not buzzed on a revoke.
    expect((await pg.query('select 1 from person_pushes')).rows).toHaveLength(0);
  });

  test('a grant to a MANAGER notes no seat — they are never stale about their own view', async () => {
    // Managers see everything, so grant_access refuses them outright; this pins
    // that the seat-note path cannot fire for one.
    const { job } = await outsideJob('Seatmgr Ng');
    const res = await mgr.callWith('grant_access', {
      technician: 'mgr-test', jobId: job.id, reason: 'me',
    });
    expect(res.isError).toBe(true);
    expect((await pg.query("select 1 from office_messages where direction = 'to_agent'")).rows)
      .toHaveLength(0);
  });

  // ── the five fixes plan A's review left (phase 2) ─────────────────────────

  test('revoking one of two overlapping grants says access is NOT closed', async () => {
    const { customer, job } = await outsideJob('Anstwo Ng');
    const first = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', jobId: job.id, reason: 'one',
    });
    await mgr.callWith('grant_access', {
      technician: 'tech-mcp', customerId: customer.id, reason: 'two',
    });
    const revoked = await mgr.callWith('revoke_access', {
      grantId: first.data.granted.id, reason: 'tidying up',
    });
    expect(revoked.data.revoked).toBe(true);
    // THE SENTENCE A MANAGER ACTS ON must not claim a door is shut.
    expect(revoked.data.stillOpen).toBe(true);
    expect(revoked.data.note).toContain('still open it through another grant');
    expect(revoked.data.note).not.toContain('can no longer open');
    // …and it is true: she can still read the job.
    expect((await call('get_job', { jobId: job.id })).data.inView).toBeUndefined();
  });

  test('revoking a money grant the FIRM RULE also opens says so', async () => {
    const { job } = await outsideJob('Ansrule Ng');
    const granted = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', jobId: job.id, money: true, reason: 'on site',
    });
    await mgr.callWith('set_technician_view', { jobScope: 'whole_firm', money: 'amounts' });
    const revoked = await mgr.callWith('revoke_access', {
      grantId: granted.data.granted.id, reason: 'no longer needed',
    });
    expect(revoked.data.stillOpen).toBe(true);
    expect(revoked.data.note).toContain("firm's rule");
    expect((await call('get_job', { jobId: job.id })).data.price_cents).toBe(40000);
  });

  test('an everywhere grant is standing by default, and standing:false is honoured', async () => {
    const standing = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', everywhere: true, money: true, reason: 'trusted',
    });
    expect(standing.data.granted.until).toBe('until revoked');
    await pg.query('truncate table access_grants');

    const bounded = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', everywhere: true, money: true, standing: false, reason: 'for now',
    });
    // standing:false is an INSTRUCTION, not an absent argument.
    expect(bounded.data.granted.until).not.toBe('until revoked');
    const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
    const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(bounded.data.granted.until).toBe(`until ${servedDayPhrase(localDateISO(inAWeek, tz))}`);
  });

  test('a no-op rule change is not reported as a change', async () => {
    // 'status' IS the default, so storing it over a null changes the record but
    // nothing a manager could read differently.
    const res = await mgr.callWith('set_technician_view', { money: 'status' });
    expect(res.isError).toBe(false);
    expect(res.data.changes).toHaveLength(0);
    expect(res.data.note).toContain('already how the firm is set');
  });

  test('an empty channel list reads as the strictest setting, never as blank', async () => {
    await pg.query(
      "insert into technician_view_rules (tenant_id, technician_channels, set_by) values ($1, '{}', 'test') " +
        'on conflict (tenant_id) do update set technician_channels = \'{}\'',
      [tenantId],
    );
    const listed = await mgr.callWith('list_access', {});
    expect(listed.data.firmRule.technicianChannels).toContain('no kinds of note at all');
    expect(listed.data.firmRule.technicianChannels).not.toBe('');
  });

  // ── what the phase-2 review caught ────────────────────────────────────────

  test('a requestId answer refuses a DIFFERENT technician rather than misdirecting it', async () => {
    const { job, requestId } = await fileRequest('Answrong Ng');
    // Obeying this would open Sam's job for the manager's named person, text
    // THEM about Sam's ask, and close Sam's request as answered — Sam never
    // told, nothing opened for her, and no way to ask again.
    const res = await mgr.callWith('grant_access', {
      requestId,
      technician: 'tech-other',
      reason: 'yes',
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('answer it as it stands');
    // Nothing happened: the request is still waiting and nothing was opened.
    const req = await pg.query('select status from observations where id = $1', [requestId]);
    expect(req.rows[0].status).toBe('open');
    expect((await pg.query('select 1 from access_grants')).rows).toHaveLength(0);
    expect((await call('get_job', { jobId: job.id })).data.inView).toBe(false);
  });

  test('the technician is texted what was GRANTED, not what she asked for', async () => {
    const { customer, requestId } = await fileRequest('Ansnarrower Ng');
    // She asked about one job with figures; the manager opens the whole
    // customer WITHOUT figures. Telling her she got what she asked for would
    // send her back to a page that is still half closed.
    const granted = await mgr.callWith('grant_access', {
      requestId,
      customerId: customer.id,
      money: false,
      reason: 'the account, but not the numbers',
    });
    expect(granted.isError).toBe(false);
    expect(granted.data.granted.money).toBe(false);
    const push = await pg.query('select body from person_pushes');
    expect(push.rows).toHaveLength(1);
    expect(push.rows[0].body).toContain('every job of Ansnarrower Ng');
    expect(push.rows[0].body).not.toContain('money figures');
  });

  test('revoking a CUSTOMER grant finds the job grant that still opens it', async () => {
    const { customer, job } = await outsideJob('Ansboth Ng');
    await mgr.callWith('grant_access', { technician: 'tech-mcp', jobId: job.id, reason: 'the job' });
    const cust = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', customerId: customer.id, reason: 'the account',
    });
    const revoked = await mgr.callWith('revoke_access', {
      grantId: cust.data.granted.id, reason: 'narrowing it',
    });
    expect(revoked.data.stillOpen).toBe(true);
    // The remedy must be the one that works: revoke the other grant. Pointing
    // at the firm's rule would send the manager somewhere that cannot fix it.
    expect(revoked.data.note).toContain('another grant');
    expect(revoked.data.note).not.toContain("firm's rule");
  });

  test('the overlapping grant\'s granter is named, never ref\'d', async () => {
    const { customer, job } = await outsideJob('Ansname Ng');
    await mgr.callWith('grant_access', { technician: 'tech-mcp', jobId: job.id, reason: 'one' });
    const cust = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', customerId: customer.id, reason: 'two',
    });
    const revoked = await mgr.callWith('revoke_access', {
      grantId: cust.data.granted.id, reason: 'tidying',
    });
    expect(revoked.data.note).toContain('Manager Test');
    expect(revoked.data.note).not.toContain('mgr-test');
  });

  test('everywhere can answer a request, and naming two scopes is still refused', async () => {
    const { requestId } = await fileRequest('Ansevery Ng');
    // A request always carries a customerId, which must not collide with the
    // manager's own choice of scope.
    const res = await mgr.callWith('grant_access', {
      requestId, everywhere: true, money: true, reason: 'she can see figures from now on',
    });
    expect(res.isError).toBe(false);
    expect(res.data.granted.until).toBe('until revoked');
    const req = await pg.query('select status from observations where id = $1', [requestId]);
    expect(req.rows[0].status).toBe('dismissed');

    const { job, customer } = await outsideJob('Ansboth2 Ng');
    const both = await mgr.callWith('grant_access', {
      technician: 'tech-mcp', jobId: job.id, customerId: customer.id, reason: 'which?',
    });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('exactly one');
  });

  test('a grant naming another firm\'s record is described as opening nothing', async () => {
    const other = await createTenant('Other firm for grants', { technicianSeats: 1 });
    const theirCustomer = await createCustomer({ tenantId: other.id, name: 'Theirs', phone: '555-9' });
    // The writer does not refuse another firm's id — such a grant simply opens
    // nothing, because technician_view_of re-checks the tenant on every join.
    await insertAccessGrant({
      tenantId,
      technicianId: techMcpId,
      customerId: theirCustomer.id,
      opens: 'record',
      grantedBy: 'mgr-test',
      reason: 'a mistyped id',
    });
    const listed = await mgr.callWith('list_access', {});
    const row = listed.data.grants.find((g: { reason: string }) => g.reason === 'a mistyped id');
    expect(row.what).toContain('another firm');
    expect(row.what).toContain('opens nothing');
    expect(row.what).not.toContain('untitled');
  });
});
