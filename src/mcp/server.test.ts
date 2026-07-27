import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client as PgClient } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getClient } from '../db/client.js';
import { appendRawCapture } from '../db/rawCaptures.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { createAssignment, updateAssignmentStatus } from '../db/assignments.js';
import { createVisit } from '../db/visits.js';
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
import { createTenant, setTenantSeats } from '../db/tenants.js';
import { upsertOpenReviewItem } from '../db/reviewItems.js';
import { logWebRequests } from '../db/webRequests.js';
import { createServer, safeEnvInt, type ServerDeps } from './server.js';
import { localDateISO } from '../schedule/availability.js';

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

  const server = createServer({
    // Identity is injected here (the gateway/env source in prod); the agent never
    // supplies technicianRef. 'tech-mcp' matches the schedule entry below.
    identity: { tenantId, technicianRef: 'tech-mcp' },
    extract: async () => ({ workPerformed: 'did the work' }),
    // Stub the synthesizers so the MCP tests never call the live model.
    brief: async (ctx) => ({ briefing: `stub briefing for ${ctx.customer?.name}`, citations: [] }),
    answer: async (ctx, question) => ({
      answer: `stub answer to "${question}" for ${ctx.customer?.name}`,
      citations: [],
    }),
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
    'truncate table schedule_entries, customers, jobs, visits, raw_captures, technicians, review_items, web_requests, schedule_events, job_type_durations cascade',
  );
  // Restore the seed capacity (2/5) so post-suite live checks see known values.
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

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
    brief: async (ctx) => ({ briefing: `stub for ${ctx.customer?.name}`, citations: [] }),
    answer: async (ctx, question) => ({ answer: `stub: ${question}`, citations: [] }),
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

describe('MCP server', () => {
  test('lists the technician tool surface (exactly 14 tools)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'record_field_note',
        'find_customer',
        'get_customer_context',
        'get_job',
        'resolve_date',
        'list_recent_captures',
        'brief_customer',
        'answer_customer_question',
        'web_search',
        'read_webpage',
        'send_email',
        'retract_capture',
        'record_standing_fact',
        'get_schedule',
      ]),
    );
    expect(names).toHaveLength(14);
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
    // The weekend ambiguity contract, keyed on the SERVER's firm-local day so
    // the assertion is exact on any day the suite runs.
    const dow = new Date(`${today}T00:00:00.000Z`).getUTCDay();
    if (dow === 0 || dow === 6) {
      expect(wk.data.boundaryAmbiguous).toBe(true);
      expect(wk.data.alternate).toBeDefined();
      expect(wk.data.note).toMatch(/ask/i);
    } else {
      expect(wk.data.boundaryAmbiguous).toBeUndefined();
      expect(wk.data.alternate).toBeUndefined();
    }
  });

  test('every object tool result carries the temporal grounding rider `now`; arrays keep their shape', async () => {
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

    // …and array results stay arrays (the rider must not change their shape).
    const caps = await call('list_recent_captures', {
      jobId: '00000000-0000-0000-0000-000000000000',
    });
    expect(Array.isArray(caps.data)).toBe(true);
  });

  test('record_field_note stages (NO L1), resolves identity, and records only on the final confirm', async () => {
    // FIRM-local today (seed tenant tz = America/Los_Angeles): the matcher
    // consults the capture's firm-local day, so the fixture must book there.
    const day = localDateISO(new Date().toISOString(), 'America/Los_Angeles');
    // The schedule consultation reads confirmed assignments now: a real
    // customer at '12 MCP St' with a job booked for tech-mcp TODAY.
    const mcpCust = await createCustomer({ tenantId, name: 'MCP Cust', addressLine1: '12 MCP St' });
    const mcpJob = await createJob({ tenantId, customerId: mcpCust.id, title: 'mcp visit' });
    await createAssignment({
      tenantId,
      jobId: mcpJob.id,
      technicianId: techMcpId,
      startsAt: `${day}T12:00:00.000Z`,
      endsAt: `${day}T13:00:00.000Z`,
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
    const resumed = await call('record_field_note', {
      confirmId: first.data.confirmId,
      confirmed: { address: '12 MCP St' },
    });
    expect(resumed.data.status).toBe('needs_confirmation');
    expect(resumed.data.preview.customerName).toBe('MCP Cust');
    expect(resumed.data.preview.newCustomer).toBe(false);
    expect(resumed.data.preview.text).toBe('all wrapped up');
    expect(await noteRows()).toBe(0); // still nothing recorded

    // Final confirm: NOW the permanent rows land — exactly what was previewed.
    const done = await call('record_field_note', { confirmId: first.data.confirmId });
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

    const vis = await pg.query<{ technician_name: string }>(
      'select technician_name from visits where id = $1',
      [done.data.visitId],
    );
    expect(vis.rows[0].technician_name).toBe('tech-mcp');

    // The token is consumed: a repeat confirm errors cleanly, nothing doubles.
    const again = await call('record_field_note', { confirmId: first.data.confirmId });
    expect(again.isError).toBe(true);
    expect(again.text).toContain('confirmation not found');
    expect(await noteRows()).toBe(1);
  });

  test('staging with a known customer goes straight to needs_confirmation; re-stage supersedes the old token', async () => {
    const customer = await createCustomer({ tenantId, name: 'Stage Direct', phone: '555-2211' });

    const a = await call('record_field_note', {
      text: 'first attempt',
      confirmed: { customerId: customer.id },
    });
    expect(a.data.status).toBe('needs_confirmation');
    expect(a.data.preview.customerName).toBe('Stage Direct');
    expect(a.data.preview.newCustomer).toBe(false);

    // Re-stage before confirming: one staged note per person.
    const b = await call('record_field_note', {
      text: 'second attempt',
      confirmed: { customerId: customer.id },
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

    const customer = await createCustomer({ tenantId, name: 'Expiry Cust', phone: '555-2222' });
    const staged = await call('record_field_note', {
      text: 'about to expire',
      confirmed: { customerId: customer.id },
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
    const customer = await createCustomer({ tenantId, name: 'Heal Confirm', phone: '555-2233' });
    const staged = await call('record_field_note', {
      text: 'healed note',
      confirmed: { customerId: customer.id },
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

  test('resolve_review refuses to "resolve" a staged field note (live token); dismiss cancels it', async () => {
    const customer = await createCustomer({ tenantId, name: 'Cancel Cust', phone: '555-2244' });
    const staged = await call('record_field_note', {
      text: 'to be cancelled',
      confirmed: { customerId: customer.id },
    });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const refused = await callWith('resolve_review', {
        reviewItemId: staged.data.confirmId,
        resolution: 'resolved',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('staged field note');

      const dismissed = await callWith('resolve_review', {
        reviewItemId: staged.data.confirmId,
        resolution: 'dismissed',
      });
      expect(dismissed.isError).toBe(false);
    } finally {
      await mgrClient.close();
    }
    // The cancelled token no longer commits anything.
    const confirm = await call('record_field_note', { confirmId: staged.data.confirmId });
    expect(confirm.isError).toBe(true);
    expect(confirm.text).toContain('confirmation not found');
  });

  test('get_customer_context returns the aggregated record', async () => {
    const customer = await createCustomer({ tenantId, name: 'Ctx Over Mcp', phone: '555-3300' });
    await createJob({ tenantId, customerId: customer.id, title: 'J' });

    const { isError, data } = await call('get_customer_context', { customerId: customer.id });
    expect(isError).toBe(false);
    expect(data.customer.id).toBe(customer.id);
    expect(data.jobs.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.recentVisits)).toBe(true);
    expect(Array.isArray(data.recentCaptures)).toBe(true);
  });

  test('brief_customer returns a briefing + citations (stubbed synthesizer)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Brief Me', phone: '555-4400' });
    await createJob({ tenantId, customerId: customer.id, title: 'J' });

    const { isError, data } = await call('brief_customer', { customerId: customer.id });
    expect(isError).toBe(false);
    expect(typeof data.briefing).toBe('string');
    expect(Array.isArray(data.citations)).toBe(true);
  });

  test('answer_customer_question returns an answer + citations (stubbed synthesizer)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Ask Me', phone: '555-5500' });

    const { isError, data } = await call('answer_customer_question', {
      customerId: customer.id,
      question: 'What is going on with this customer?',
    });
    expect(isError).toBe(false);
    expect(typeof data.answer).toBe('string');
    expect(Array.isArray(data.citations)).toBe(true);
  });

  test('a synthesis tool on a bogus customerId is a clean "customer not found" error', async () => {
    const { isError, text } = await call('brief_customer', {
      customerId: '00000000-0000-0000-0000-000000000000',
    });
    expect(isError).toBe(true);
    expect(text).toContain('customer not found');
  });

  test('brief_customer rejects an invalid focus value', async () => {
    const customer = await createCustomer({ tenantId, name: 'Focus Test', phone: '555-6600' });
    const { isError, text } = await call('brief_customer', {
      customerId: customer.id,
      focus: 'deep_dive',
    });
    expect(isError).toBe(true);
    expect(text).toContain('invalid focus');
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
    const okBrief = await call('brief_customer', { customerId: customer.id });
    expect(okBrief.isError).toBe(false);

    // Wrong tenant: the SAME ids read as empty / null / error across all five tools.
    const { client: otherClient, callWith } = await clientFor({
      tenantId: WRONG_TENANT,
      technicianRef: 'tech-x',
    });
    try {
      expect((await callWith('get_job', { jobId: job.id })).data).toBeNull();

      const ctx = await callWith('get_customer_context', { customerId: customer.id });
      expect(ctx.data.customer).toBeNull();
      expect(ctx.data.jobs).toEqual([]);

      expect((await callWith('list_recent_captures', { jobId: job.id })).data).toEqual([]);
      expect((await callWith('list_recent_captures', { customerId: customer.id })).data).toEqual([]);

      expect((await callWith('brief_customer', { customerId: customer.id })).isError).toBe(true);
      expect(
        (await callWith('answer_customer_question', { customerId: customer.id, question: 'hi' }))
          .isError,
      ).toBe(true);
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
      ['list_pending_reviews', {}],
      ['resolve_review', { reviewItemId: 'x', resolution: 'resolved' }],
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
          'list_pending_reviews',
          'resolve_review',
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
      const bob = team.data.find((t: { ref: string }) => t.ref === 'bob-marley');
      expect(bob).toMatchObject({ displayName: 'Bob Marley', state: 'offboarding' });
      expect(Object.keys(bob)).not.toContain('composio_connected_account_id');

      // Reviews: open item listed; resolve closes it; bogus id → not found.
      const item = await upsertOpenReviewItem({
        tenantId,
        kind: 'sheet_ref_mismatch',
        subjectRef: 'tehc-bob',
        suggestion: 'bob-marley',
      });
      const pending = await callWith('list_pending_reviews', {});
      expect(pending.data.map((i: { id: string }) => i.id)).toContain(item.id);
      const resolved = await callWith('resolve_review', {
        reviewItemId: item.id,
        resolution: 'dismissed',
        note: 'sheet fixed',
      });
      expect(resolved.data.status).toBe('dismissed');
      const missing = await callWith('resolve_review', {
        reviewItemId: '00000000-0000-0000-0000-000000000000',
        resolution: 'resolved',
      });
      expect(missing.isError).toBe(true);

      // A pending_deactivation token cannot be closed as "resolved" via the
      // generic tool (that would fake a completed deactivation) — but
      // dismissing it (= cancel) is allowed.
      const pendingDan = await callWith('deactivate_technician_seat', { ref: 'dan-dare' });
      expect(pendingDan.data.status).toBe('needs_confirmation');
      const fakeResolve = await callWith('resolve_review', {
        reviewItemId: pendingDan.data.confirmId,
        resolution: 'resolved',
      });
      expect(fakeResolve.isError).toBe(true);
      expect(fakeResolve.text).toContain('pending deactivation');
      const cancel = await callWith('resolve_review', {
        reviewItemId: pendingDan.data.confirmId,
        resolution: 'dismissed',
      });
      expect(cancel.isError).toBe(false);
      const danState = await pg.query<{ state: string }>(
        "select state from technicians where tenant_id = $1 and ref = 'dan-dare'",
        [tenantId],
      );
      expect(danState.rows[0].state).toBe('invited'); // cancelled — never deactivated

      // Cross-tenant: another tenant's MANAGER (passes requireManager in their
      // own tenant) still cannot resolve this tenant's item — the DB tenant
      // guard reads it as not found.
      const crossItem = await upsertOpenReviewItem({
        tenantId,
        kind: 'unknown_ref_capture',
        subjectRef: 'cross-tenant-probe',
      });
      const otherTenantId = (await createTenant('cross-tenant-test', { managerSeats: 1 })).id;
      const otherMgr = await insertTechnician({
        tenantId: otherTenantId,
        ref: 'other-mgr',
        displayName: 'Other Manager',
        tier: 'manager',
      });
      await setTechnicianState(otherMgr.id, 'active');
      const { client: otherClient, callWith: otherCall } = await clientFor({
        tenantId: otherTenantId,
        technicianRef: 'other-mgr',
      });
      try {
        const cross = await otherCall('resolve_review', {
          reviewItemId: crossItem.id,
          resolution: 'dismissed',
        });
        expect(cross.isError).toBe(true);
        expect(cross.text).toContain('review item not found');
      } finally {
        await otherClient.close();
        // The extra tenant goes explicitly, BY ID (tenants is never truncated;
        // deleting by name once swept up a leftover from a crashed run that
        // other rows had attached to). Children first — FK.
        await pg.query('delete from technicians where tenant_id = $1', [otherTenantId]);
        await pg.query('delete from tenants where id = $1', [otherTenantId]);
      }
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
      const linkDenied = await callWith('get_connect_link', { ref: 'helper-hman' });
      expect(linkDenied.isError).toBe(true);
      expect(linkDenied.text).toContain('schedule-only');

      // list_team surfaces the flag on every row.
      const team = await callWith('list_team', {});
      expect(team.data.find((t: { ref: string }) => t.ref === 'helper-hman')).toMatchObject({
        seatExempt: true,
        state: 'active',
        sandboxRef: null,
        botUsername: null,
      });
      expect(
        team.data.find((t: { ref: string }) => t.ref === 'mgr-test'),
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
      const linkWhileOff = await callWith('get_connect_link', { ref: 'helper-hman' });
      expect(linkWhileOff.isError).toBe(true);
      expect(linkWhileOff.text).toContain('schedule-only');
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

describe('retract_capture + retraction folding', () => {
  test('author two-step retraction; context stops showing the capture and its visit', async () => {
    const customer = await createCustomer({ tenantId, name: 'Retract Cust', phone: '555-3311' });
    // Record a note via the staged flow (creates capture + visit).
    const staged = await call('record_field_note', {
      text: 'bad note to retract',
      confirmed: { customerId: customer.id },
    });
    const done = await call('record_field_note', { confirmId: staged.data.confirmId });
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

    // Folded context: neither the capture nor its visit surfaces.
    const ctx = await call('get_customer_context', { customerId: customer.id });
    expect(ctx.data.recentCaptures.map((c: { id: string }) => c.id)).not.toContain(
      done.data.captureId,
    );
    expect(ctx.data.recentVisits.map((v: { id: string }) => v.id)).not.toContain(
      done.data.visitId,
    );
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
      technicianName: 'Jane',
      sourceCaptureId: cap.id,
    });

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
        technicianName: 'Jane',
      },
    ]);
    expect(staged.data.note).toContain('willAlsoRemove');

    const done = await call('retract_capture', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('retracted');
    expect(done.data.alsoRemoved).toEqual(will);
    expect(typeof done.data.restoreHint).toBe('string');
    expect(done.data.restoreHint).toContain('SEQUENTIALLY');

    // Parity: the preview must equal what the fold ACTUALLY removes — the
    // predicted facts/visit are gone from the default context view, nothing
    // else. Ties "what will disappear" to "what does disappear" so predicate
    // drift between the scan and the fold fails here instead of lying live.
    const ctx = await call('get_customer_context', { customerId: customer.id });
    expect(ctx.data.customer.attributes.prefers).toBeUndefined();
    const foldedJob = ctx.data.jobs.find((j: { id: string }) => j.id === job.id);
    expect(foldedJob.attributes.symptom).toBeUndefined();
    expect(ctx.data.recentVisits.map((v: { id: string }) => v.id)).not.toContain(visit.id);
  });

  test('fold impact: a capture nothing cites previews and commits empty, with no restoreHint', async () => {
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'uncited note',
    });
    const staged = await call('retract_capture', { captureId: cap.id, reason: 'noise' });
    expect(staged.data.willAlsoRemove).toEqual({ facts: [], visits: [] });
    const done = await call('retract_capture', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('retracted');
    expect(done.data.alsoRemoved).toEqual({ facts: [], visits: [] });
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
    const foldedIds = folded.data.map((r: { id: string }) => r.id);
    expect(foldedIds).toContain(kept.id);
    expect(foldedIds).not.toContain(bad.id);
    expect(foldedIds).not.toContain(c.data.retractionId);

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
      const badRow = trail.data.find((r: { id: string }) => r.id === bad.id);
      expect(badRow.retracted).toBe(true);
      expect(badRow.retraction.reason).toBe('belongs to Tom');
      expect(badRow.retraction.by).toBe('tech-mcp');
      // The retraction row itself appears in the trail, as-is.
      expect(trail.data.map((r: { id: string }) => r.id)).toContain(c.data.retractionId);
    } finally {
      await mgrClient.close();
    }
  });

  test('resolve_review refuses to "resolve" a staged retraction (live token); dismiss cancels', async () => {
    const cap = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-mcp',
      rawText: 'cancel-retract target',
    });
    const s = await call('retract_capture', { captureId: cap.id, reason: 'oops' });
    const { client: mgrClient, callWith: callMgr } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const refused = await callMgr('resolve_review', {
        reviewItemId: s.data.confirmId,
        resolution: 'resolved',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('staged retraction');
      const dismissed = await callMgr('resolve_review', {
        reviewItemId: s.data.confirmId,
        resolution: 'dismissed',
      });
      expect(dismissed.isError).toBe(false);
    } finally {
      await mgrClient.close();
    }
    const confirm = await call('retract_capture', { confirmId: s.data.confirmId });
    expect(confirm.isError).toBe(true);
    expect(confirm.text).toContain('confirmation not found');
  });
});

describe('pairing lifecycle tools (Composio seams stubbed)', () => {
  test('get_connect_link states + cooldown; resolve_review verdicts', { timeout: 30_000 }, async () => {
    // The earlier admin test leaves technician seats 3/3 occupied — make room.
    await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });

    // Configurable pairing stubs, recorded per call.
    let checkResult: Awaited<ReturnType<NonNullable<ServerDeps['checkPairing']>>> = {
      status: 'not_connected',
    };
    const linkCalls: string[] = [];
    const unpairCalls: string[] = [];
    const pairingStubs: Partial<ServerDeps> = {
      checkPairing: async () => checkResult,
      connectLink: async (t) => {
        linkCalls.push(t.ref);
        // Mirror the real seam's one side effect — the cooldown stamp.
        await updateTechnician(t.id, { link_issued_at: new Date().toISOString() });
        return { url: 'https://connect.composio.example/xyz' };
      },
      unpair: async (t) => {
        unpairCalls.push(t.ref);
      },
    };

    // Technician identity: the tool is denied before any stub runs.
    const denied = await call('get_connect_link', { ref: 'tech-mcp' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('manager badge');

    const { client: mgrClient, callWith } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      pairingStubs,
    );
    try {
      // Managers see the new tool in the tier-filtered list.
      const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
      expect(mgrTools).toContain('get_connect_link');

      expect((await callWith('get_connect_link', { ref: 'nobody' })).isError).toBe(true);
      // An active person has nothing to connect.
      const active = await callWith('get_connect_link', { ref: 'tech-mcp' });
      expect(active.isError).toBe(true);
      expect(active.text).toContain('already connected and active');

      // Invited person: link minted; immediate repeat hits the cooldown.
      const probe = await insertTechnician({ tenantId, ref: 'pair-probe', displayName: 'Pair Probe' });
      const linked = await callWith('get_connect_link', { ref: 'pair-probe' });
      expect(linked.data).toMatchObject({
        status: 'link_created',
        url: 'https://connect.composio.example/xyz',
      });
      expect(linkCalls).toEqual(['pair-probe']);
      const cooled = await callWith('get_connect_link', { ref: 'pair-probe' });
      expect(cooled.isError).toBe(true);
      expect(cooled.text).toContain('wait a few minutes');
      expect(linkCalls).toHaveLength(1); // no second Composio call

      // Consent already completed (checkPairing reports paired): no link minted.
      await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 6 });
      await insertTechnician({ tenantId, ref: 'pair-early', displayName: 'Pair Early' });
      checkResult = { status: 'paired', connectedAccountId: 'ca_x', email: 'early@gmail.com' };
      const early = await callWith('get_connect_link', { ref: 'pair-early' });
      expect(early.data).toMatchObject({ status: 'awaiting_verification', email: 'early@gmail.com' });
      expect(linkCalls).toHaveLength(1);
      checkResult = { status: 'not_connected' };

      // Simulate the sweep having advanced the probe: pending_verification.
      await updateTechnician(probe.id, {
        state: 'pending_verification',
        connected_email: 'jane.probe@gmail.com',
        composio_connected_account_id: 'ca_probe',
      });
      const pending = await callWith('get_connect_link', { ref: 'pair-probe' });
      expect(pending.data).toMatchObject({
        status: 'awaiting_verification',
        email: 'jane.probe@gmail.com',
      });

      // Verification verdict RESOLVED: right mailbox → active (state-first).
      const item = await upsertOpenReviewItem({
        tenantId,
        kind: 'pairing_verification',
        subjectRef: 'pair-probe',
        detail: { email: 'jane.probe@gmail.com', connectedAccountId: 'ca_probe' },
      });
      const confirmed = await callWith('resolve_review', {
        reviewItemId: item.id,
        resolution: 'resolved',
      });
      expect(confirmed.isError).toBe(false);
      const state1 = await pg.query<{ state: string }>(
        "select state from technicians where tenant_id = $1 and ref = 'pair-probe'",
        [tenantId],
      );
      expect(state1.rows[0].state).toBe('active'); // cross-channel read-back
      expect(unpairCalls).toHaveLength(0);

      // Verification verdict DISMISSED: wrong mailbox → unpair seam invoked.
      const two = await insertTechnician({ tenantId, ref: 'pair-two', displayName: 'Pair Two' });
      await updateTechnician(two.id, { state: 'pending_verification' });
      const item2 = await upsertOpenReviewItem({
        tenantId,
        kind: 'pairing_verification',
        subjectRef: 'pair-two',
      });
      const dismissed = await callWith('resolve_review', {
        reviewItemId: item2.id,
        resolution: 'dismissed',
      });
      expect(dismissed.isError).toBe(false);
      expect(unpairCalls).toEqual(['pair-two']);

      // STALE item on an offboarding row: resolved must NOT resurrect anyone.
      await updateTechnician(two.id, { state: 'offboarding' });
      const stale = await upsertOpenReviewItem({
        tenantId,
        kind: 'pairing_verification',
        subjectRef: 'pair-two',
      });
      const staleResolve = await callWith('resolve_review', {
        reviewItemId: stale.id,
        resolution: 'resolved',
      });
      expect(staleResolve.isError).toBe(false); // the item closes...
      const state2 = await pg.query<{ state: string }>(
        "select state from technicians where tenant_id = $1 and ref = 'pair-two'",
        [tenantId],
      );
      expect(state2.rows[0].state).toBe('offboarding'); // ...the state does not move
      expect(unpairCalls).toHaveLength(1); // and no teardown ran either
    } finally {
      await mgrClient.close();
    }
  });
});

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
      const coldRow = team.data.find((t: { ref: string }) => t.ref === 'tg-cold');
      expect(coldRow).toMatchObject({ sandboxRef: 'pool-x', botUsername: '@poolx_bot' });
      const aRow = team.data.find((t: { ref: string }) => t.ref === 'tg-a');
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
      // The reactivated-to-invited case re-opens the pairing path — stub the
      // link seams so that probe never touches live Composio.
      checkPairing: async () => ({ status: 'not_connected' }),
      connectLink: async () => ({ url: 'https://connect.composio.example/reopened' }),
    };

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
      // (technician route view, removed 2026-07-19) + the 24 admin tools —
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
      expect(mgrTools).toContain('set_promise');
      expect(mgrTools).toContain('set_technician_horizon');
      expect(mgrTools).toContain('cancel_job'); // the terminal verb (2026-07-25)
      expect(mgrTools).toContain('set_visit_locks'); // human-privilege pinning (plan 4b-3)
      expect(mgrTools).toContain('run_freeze'); // the freeze (plan 4b-3)
      expect(mgrTools).toHaveLength(37);

      // pair-probe is active w/ a recorded pairing (from the pairing suite).
      // Give it an open verification item to prove deactivation closes it.
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

      // An open grace-period reminder must not survive reactivation (a stale
      // one would collide with a second episode's reminder).
      const reminder = await upsertOpenReviewItem({
        tenantId,
        kind: 'offboarding_reminder',
        subjectRef: 'pair-probe',
        detail: { startedAt: 'episode-1' },
      });

      // Reactivate: back to active, clock cleared, pairing re-enabled.
      const undo = await callWith('reactivate_technician_seat', { ref: 'pair-probe' });
      expect(undo.data).toMatchObject({
        status: 'reactivated',
        state: 'active',
        pairingRestored: true,
      });
      const reminderAfter = await pg.query<{ status: string }>(
        'select status from review_items where id = $1',
        [reminder.id],
      );
      expect(reminderAfter.rows[0].status).toBe('resolved');
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
      // INVITED, not active — otherwise get_connect_link refuses them and
      // their mailbox could never be paired (review finding).
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
      // ...and the pairing path is open again, not dead-ended.
      const carlLink = await callWith('get_connect_link', { ref: 'carl-sagan' });
      expect(carlLink.isError).toBe(false);

      // Reactivate AT CAP: free pair-probe's seat again, fill every seat, then
      // the undo must hit the purchase message (seat cap is never bypassed).
      const ask2 = await callWith('deactivate_technician_seat', { ref: 'pair-probe' });
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
      // Technician surface count including send_email: exactly 14.
      const tools = (await techClient.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('send_email');
      expect(tools).toHaveLength(14);

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

      // resolve_review: a staged send is a live token — "resolved" is refused,
      // dismiss (= cancel) is allowed. Manager surface counts exactly 21.
      const { client: mgrClient, callWith: mgrCall } = await clientFor(
        { tenantId, technicianRef: 'mgr-test' },
        stubs,
      );
      try {
        const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
        expect(mgrTools).toHaveLength(37); // base minus get_schedule + 24 admin
        const fakeResolve = await mgrCall('resolve_review', {
          reviewItemId: s6.data.confirmId,
          resolution: 'resolved',
        });
        expect(fakeResolve.isError).toBe(true);
        expect(fakeResolve.text).toContain('staged email send');
        const cancel = await mgrCall('resolve_review', {
          reviewItemId: s6.data.confirmId,
          resolution: 'dismissed',
        });
        expect(cancel.isError).toBe(false);
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
});

describe('sensitivity filtering (manager_only L1 rows)', () => {
  test('technician reads omit manager_only captures; manager reads include them; synthesizer ctx is filtered', { timeout: 30_000 }, async () => {
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
    expect(byCust.data.map((c: { raw_text: string }) => c.raw_text)).toEqual(['ordinary visit note']);
    const byJob = await call('list_recent_captures', { jobId: job.id });
    expect(byJob.data).toHaveLength(1);
    const ctx = await call('get_customer_context', { customerId: customer.id });
    expect(
      ctx.data.recentCaptures.some((c: { sensitivity: string | null }) => c.sensitivity === 'manager_only'),
    ).toBe(false);

    // The synthesizers receive the FILTERED ctx (a technician cannot leak the
    // row through a briefing).
    let brieferSaw: string[] = [];
    const { client: briefClient, callWith: briefCall } = await clientFor(
      { tenantId, technicianRef: 'tech-mcp' },
      {
        brief: async (bctx) => {
          brieferSaw = bctx.recentCaptures.map((c) => c.raw_text ?? '');
          return { briefing: 'stub', citations: [] };
        },
      },
    );
    try {
      await briefCall('brief_customer', { customerId: customer.id });
      expect(brieferSaw).toEqual(['ordinary visit note']);
    } finally {
      await briefClient.close();
    }

    // Manager badge sees both rows.
    const { client: mgrClient, callWith: mgrCall } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const mgrList = await mgrCall('list_recent_captures', { customerId: customer.id });
      expect(mgrList.data).toHaveLength(2);
      const mgrCtx = await mgrCall('get_customer_context', { customerId: customer.id });
      expect(
        mgrCtx.data.recentCaptures.some(
          (c: { sensitivity: string | null }) => c.sensitivity === 'manager_only',
        ),
      ).toBe(true);
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
  const stubOptimize: ServerDeps['optimizeStopOrder'] = async (stops) => ({
    order: stops.map((_, i) => stops.length - 1 - i), // reverse, so reordering is observable
    legMinutes: [7, 8],
    totalMinutes: 15,
  });
  const gAssignmentIds: string[] = [];

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
      const row = await createAssignment({
        tenantId,
        jobId: job.id,
        technicianId: techMcpId,
        startsAt: startISO,
        endsAt: new Date(Date.parse(startISO) + 60 * 60_000).toISOString(),
        status: 'confirmed',
      });
      gAssignmentIds.push(row.id);
    };
    await mk('g1-a', `${G1}T15:00:00.000Z`);
    await mk('g1-b', `${G1}T17:00:00.000Z`);
    await mk('g2-a', `${G2}T16:00:00.000Z`);
    await mk('g2-noaddr', `${G2}T18:00:00.000Z`, false);
  });

  afterAll(async () => {
    // Relative fixtures MUST NOT outlive the suite: later suites in this file
    // use fixed future dates (2026-12-*, 2027-*), and today+7/+8 sweeps across
    // them as the calendar advances — leaked rows would break their exact
    // reads deterministically weeks from now (final-review finding; the same
    // hazard boardApi.test.ts solves with all-relative distinct offsets).
    await pg.query('delete from assignments where id = any($1::uuid[])', [gAssignmentIds]);
  });

  async function scheduleClient(extra: Partial<ServerDeps> = {}) {
    return clientFor(
      { tenantId, technicianRef: 'tech-mcp' },
      { optimizeStopOrder: stubOptimize, ...extra },
    );
  }

  test('multi-day response: reordered stops, drive minutes, maps link per day', async () => {
    const { client: c, callWith } = await scheduleClient();
    try {
      const r = await callWith('get_schedule', { from: G1, to: G2 });
      expect(r.isError).toBe(false);
      expect(r.data.status).toBe('ok');
      expect(r.data.days.map((d: { date: string }) => d.date)).toEqual([G1, G2]);
      const d1 = r.data.days[0];
      // stub reverses: g1-b before g1-a
      expect(d1.stops.map((s: { label: string }) => s.label)).toEqual(['G g1-b', 'G g1-a']);
      expect(d1.driveMinutes).toBe(15);
      expect(d1.mapsUrl).toContain('https://www.google.com/maps/dir/?api=1');
      expect(d1.mapsUrl).toContain(encodeURIComponent('g1-b Rd, Fresno, CA, 93701'));
      expect(d1.linkTruncated).toBe(false);
    } finally {
      await c.close();
    }
  });

  test('null-address stop is listed unroutable and kept out of the link', async () => {
    const { client: c, callWith } = await scheduleClient();
    try {
      const r = await callWith('get_schedule', { from: G2, to: G2 });
      const day = r.data.days[0];
      // No-address stops live in their own time-ordered field — mixing them
      // into the drive-ordered list would misstate one sequence or the other.
      expect(day.stops.map((s: { label: string }) => s.label)).not.toContain('G g2-noaddr');
      expect(day.unroutableStops).toEqual([
        expect.objectContaining({ label: 'G g2-noaddr', address: null }),
      ]);
      expect(day.mapsUrl).not.toContain('g2-noaddr');
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
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'badge-no-roster-row' },
      { optimizeStopOrder: stubOptimize },
    );
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

  test('optimizer failure degrades the day, never eats the schedule', async () => {
    const { client: c, callWith } = await scheduleClient({
      optimizeStopOrder: async () => {
        throw new Error('quota');
      },
    });
    try {
      const r = await callWith('get_schedule', { from: G1, to: G1 });
      const day = r.data.days[0];
      expect(day.optimizeFailed).toBe(true);
      expect(day.driveMinutes).toBeNull();
      // scheduled order preserved, link still built
      expect(day.stops.map((s: { label: string }) => s.label)).toEqual(['G g1-a', 'G g1-b']);
      expect(day.mapsUrl).toContain('maps/dir');
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
describe('record_standing_fact (staged two-step)', () => {
  test('stage → preview (echoing the staged copy), confirm → wrapped bundle + evidence capture', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Cust', phone: '555-9001' });

    const staged = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'Prefers Contact!', // normalizes to prefers_contact
      value: 'email',
      sourceText: 'they said email only from now on',
    });
    expect(staged.isError).toBe(false);
    expect(staged.data.status).toBe('needs_confirmation');
    expect(staged.data.preview).toMatchObject({
      target: 'customer',
      targetName: 'Fact Cust',
      key: 'prefers_contact',
      value: 'email',
    });
    expect(staged.data.preview.previousValue).toBeUndefined();
    // Nothing recorded yet — no capture, no attribute.
    const before = await pg.query<{ attributes: Record<string, unknown> }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(before.rows[0].attributes).toEqual({});

    const done = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('recorded');

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
    expect(cap.rows[0].external_id).toBe(`fact:${staged.data.confirmId}`);
    expect(cap.rows[0].raw_text).toBe('they said email only from now on');
    expect(cap.rows[0].customer_id).toBe(customer.id);
    expect(cap.rows[0].channel).toBe('technician_note');
    expect(cap.rows[0].technician_ref).toBe('tech-mcp'); // identity, not args

    // The wrapped bundle landed on the customer row.
    const after = await pg.query<{
      attributes: { prefers_contact?: { value: string; sourceCaptureId: string; recordedAt: string } };
    }>('select attributes from customers where id = $1', [customer.id]);
    const fact = after.rows[0].attributes.prefers_contact;
    expect(fact?.value).toBe('email');
    expect(fact?.sourceCaptureId).toBe(done.data.captureId);
    expect(typeof fact?.recordedAt).toBe('string');
  });

  test('a job fact stamps BOTH ids on the evidence; an overwrite previews the previous value', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Job Cust', phone: '555-9002' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Boiler swap' });

    const first = await call('record_standing_fact', { jobId: job.id, key: 'crane_needed', value: true });
    expect(first.data.preview.targetName).toBe('Fact Job Cust: Boiler swap');
    const firstDone = await call('record_standing_fact', { confirmId: first.data.confirmId });
    expect(firstDone.data.status).toBe('recorded');

    const cap = await pg.query<{ customer_id: string; job_id: string }>(
      'select customer_id, job_id from raw_captures where id = $1',
      [firstDone.data.captureId],
    );
    expect(cap.rows[0].customer_id).toBe(customer.id);
    expect(cap.rows[0].job_id).toBe(job.id);

    const second = await call('record_standing_fact', { jobId: job.id, key: 'crane_needed', value: false });
    expect(second.data.preview.previousValue).toBe(true); // overwrite is explicit
    const secondDone = await call('record_standing_fact', { confirmId: second.data.confirmId });
    const after = await pg.query<{
      attributes: { crane_needed?: { value: boolean; sourceCaptureId: string } };
    }>('select attributes from jobs where id = $1', [job.id]);
    expect(after.rows[0].attributes.crane_needed?.value).toBe(false);
    expect(after.rows[0].attributes.crane_needed?.sourceCaptureId).toBe(secondDone.data.captureId);
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

  test('an expired token dismisses without writing; a forged confirmId is rejected', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Expiry', phone: '555-9004' });
    const staged = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'gate_code',
      value: 4321,
    });
    await pg.query(
      "update review_items set detail = jsonb_set(detail, '{stagedAt}', to_jsonb($1::text)) where id = $2",
      [new Date(Date.now() - 20 * 60_000).toISOString(), staged.data.confirmId],
    );
    const expired = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(expired.isError).toBe(true);
    expect(expired.text).toContain('expired');
    const after = await pg.query<{ attributes: Record<string, unknown> }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(after.rows[0].attributes.gate_code).toBeUndefined();
    // The token was actually DISMISSED (not left silently open): a retry finds
    // nothing to confirm.
    const item = await pg.query<{ status: string }>(
      'select status from review_items where id = $1',
      [staged.data.confirmId],
    );
    expect(item.rows[0].status).toBe('dismissed');
    const retry = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(retry.isError).toBe(true);
    expect(retry.text).toContain('confirmation not found');

    const forged = await call('record_standing_fact', {
      confirmId: '00000000-0000-0000-0000-000000000000',
    });
    expect(forged.isError).toBe(true);
    expect(forged.text).toContain('confirmation not found');
  });

  test('drift guard: a fact recorded by someone ELSE between stage and confirm is never clobbered unpreviewed', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Drift', phone: '555-9010' });
    // Tech stages (preview shows NO previousValue — a new fact).
    const techStage = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'gate_code',
      value: 1111,
    });
    expect(techStage.data.preview.previousValue).toBeUndefined();

    // A manager records the same key fully, inside the tech's confirm window.
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const mgrStage = await callWith('record_standing_fact', {
        customerId: customer.id,
        key: 'gate_code',
        value: 2222,
      });
      const mgrDone = await callWith('record_standing_fact', { confirmId: mgrStage.data.confirmId });
      expect(mgrDone.data.status).toBe('recorded');
    } finally {
      await mgrClient.close();
    }

    // The tech's confirm must refuse — not silently overwrite 2222 with 1111.
    const clobber = await call('record_standing_fact', { confirmId: techStage.data.confirmId });
    expect(clobber.isError).toBe(true);
    expect(clobber.text).toContain('changed on this customer');
    // No orphan evidence capture was written for the refused confirm.
    const caps = await pg.query<{ n: number }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [`fact:${techStage.data.confirmId}`],
    );
    expect(Number(caps.rows[0].n)).toBe(0);
    // The manager's fact is intact, and the tech token is dead (dismissed).
    const row = await pg.query<{ attributes: { gate_code?: { value: number } } }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(row.rows[0].attributes.gate_code?.value).toBe(2222);
    const retry = await call('record_standing_fact', { confirmId: techStage.data.confirmId });
    expect(retry.isError).toBe(true);
    expect(retry.text).toContain('confirmation not found');
  });

  test('stale replay guard: a re-opened token never reverts a NEWER fact; a landed-unconsumed token blocks restaging', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Replay', phone: '555-9011' });
    const staged = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'gate_code',
      value: 1111,
    });
    const done = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('recorded');

    // Simulate the crash window: commit landed, consume never ran.
    await pg.query(
      "update review_items set status = 'open', resolution = null, resolved_at = null where id = $1",
      [staged.data.confirmId],
    );

    // While the token dangles open, RESTAGING is refused — the landed evidence
    // must converge through its own confirmId, not be stranded by a supersede.
    const restage = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'other_key',
      value: 'x',
    });
    expect(restage.isError).toBe(true);
    expect(restage.text).toContain('still unfinished');
    expect(restage.text).toContain(staged.data.confirmId);

    // A manager then overwrites the key with a NEWER fact.
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const mgrStage = await callWith('record_standing_fact', {
        customerId: customer.id,
        key: 'gate_code',
        value: 2222,
      });
      await callWith('record_standing_fact', { confirmId: mgrStage.data.confirmId });
    } finally {
      await mgrClient.close();
    }

    // The tech's replay of the dangling token must NOT revert 2222 to 1111.
    const replay = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(replay.isError).toBe(true);
    expect(replay.text).toContain('changed on this customer');
    const row = await pg.query<{ attributes: { gate_code?: { value: number } } }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(row.rows[0].attributes.gate_code?.value).toBe(2222);
    // The conflicted token is dismissed, so a fresh restage now proceeds.
    const restage2 = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'other_key',
      value: 'x',
    });
    expect(restage2.isError).toBe(false);
    expect(restage2.data.status).toBe('needs_confirmation');
  });

  test("empty sourceText falls back to the canonical evidence text; a 'constructor' key never reads a prototype member as previousValue", async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Edge', phone: '555-9012' });
    const staged = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'Constructor', // normalizes to 'constructor' — must not hit Object.prototype
      value: 'edge',
      sourceText: '   ', // whitespace-only must not become the permanent evidence
    });
    expect(staged.data.preview.previousValue).toBeUndefined();
    const done = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('recorded');
    const cap = await pg.query<{ raw_text: string }>(
      'select raw_text from raw_captures where id = $1',
      [done.data.captureId],
    );
    expect(cap.rows[0].raw_text).toBe('Standing fact: constructor = edge');
  });

  test('crash-heal: token re-opened after a landed commit — a retry converges on ONE capture, same bundle', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Heal', phone: '555-9005' });
    const staged = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'dog_on_site',
      value: true,
    });
    const done = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('recorded');

    // A plain second confirm on the CONSUMED token errors honestly.
    const dead = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(dead.isError).toBe(true);
    expect(dead.text).toContain('confirmation not found');

    // Simulate the crash window (commit landed, consume never ran) and retry.
    await pg.query(
      "update review_items set status = 'open', resolution = null, resolved_at = null where id = $1",
      [staged.data.confirmId],
    );
    const retried = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(retried.isError).toBe(false);
    expect(retried.data.status).toBe('recorded');
    expect(retried.data.captureId).toBe(done.data.captureId); // same evidence row

    const caps = await pg.query<{ n: number }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [`fact:${staged.data.confirmId}`],
    );
    expect(Number(caps.rows[0].n)).toBe(1);
    const after = await pg.query<{ attributes: { dog_on_site?: { sourceCaptureId: string } } }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(after.rows[0].attributes.dog_on_site?.sourceCaptureId).toBe(done.data.captureId);
  });

  test('resolve_review refuses to "resolve" a staged fact (live token); dismiss cancels; re-stage supersedes', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Cancel', phone: '555-9006' });
    const a = await call('record_standing_fact', { customerId: customer.id, key: 'k_one', value: 1 });
    // Re-stage supersedes: one staged fact per person, the old token is dead.
    const b = await call('record_standing_fact', { customerId: customer.id, key: 'k_two', value: 2 });
    expect(b.data.confirmId).not.toBe(a.data.confirmId);
    const deadA = await call('record_standing_fact', { confirmId: a.data.confirmId });
    expect(deadA.isError).toBe(true);

    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const refused = await callWith('resolve_review', {
        reviewItemId: b.data.confirmId,
        resolution: 'resolved',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('staged standing fact');
      const cancel = await callWith('resolve_review', {
        reviewItemId: b.data.confirmId,
        resolution: 'dismissed',
      });
      expect(cancel.isError).toBe(false);
    } finally {
      await mgrClient.close();
    }
    // The cancelled token no longer commits anything.
    const confirmCancelled = await call('record_standing_fact', { confirmId: b.data.confirmId });
    expect(confirmCancelled.isError).toBe(true);
    expect(confirmCancelled.text).toContain('confirmation not found');
  });

  test('batch: several facts stage as ONE token with ONE preview, commit under ONE capture, and fold together on retraction', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Batch Cust', phone: '555-9020' });
    // Seed one key so the batch preview shows an overwrite.
    const pre = await call('record_standing_fact', { customerId: customer.id, key: 'gate_code', value: '1111' });
    await call('record_standing_fact', { confirmId: pre.data.confirmId });

    const staged = await call('record_standing_fact', {
      customerId: customer.id,
      facts: [
        { key: 'Dog On Property', value: true }, // normalizes to dog_on_property
        { key: 'gate_code', value: '2234' },
      ],
      sourceText: 'dog on the property; gated community, code 2234',
    });
    expect(staged.isError).toBe(false);
    expect(staged.data.status).toBe('needs_confirmation');
    expect(staged.data.preview.facts).toEqual([
      { key: 'dog_on_property', value: true },
      { key: 'gate_code', value: '2234', previousValue: '1111' }, // overwrite is explicit
    ]);
    // Multi-fact preview has no flat single-fact fields.
    expect(staged.data.preview.key).toBeUndefined();

    const done = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(done.isError).toBe(false);
    expect(done.data.status).toBe('recorded');
    expect([...done.data.keys].sort()).toEqual(['dog_on_property', 'gate_code']);

    // ONE evidence capture; BOTH bundles cite it.
    const caps = await pg.query<{ n: number }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [`fact:${staged.data.confirmId}`],
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
      [staged.data.confirmId],
    );
    const replay = await call('record_standing_fact', { confirmId: staged.data.confirmId });
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

  test('batch guards: duplicate keys, mixed forms, oversize, and whole-batch drift refusal', async () => {
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

    // Drift on ANY key refuses the WHOLE batch before the evidence lands.
    const staged = await call('record_standing_fact', {
      customerId: customer.id,
      facts: [
        { key: 'prefers_contact', value: 'email' },
        { key: 'gate_code', value: '9999' },
      ],
    });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const mgrStage = await callWith('record_standing_fact', {
        customerId: customer.id,
        key: 'gate_code',
        value: '5555',
      });
      await callWith('record_standing_fact', { confirmId: mgrStage.data.confirmId });
    } finally {
      await mgrClient.close();
    }
    const refused = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("'gate_code' changed on this customer");
    // No orphan evidence for the refused batch; the untouched key stayed absent.
    const caps = await pg.query<{ n: number }>(
      'select count(*)::int as n from raw_captures where external_id = $1',
      [`fact:${staged.data.confirmId}`],
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

  test('partial-conflict replay: a re-opened batch token skips the overwritten key, applies the rest, and reports honestly', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Partial Cust', phone: '555-9023' });
    const staged = await call('record_standing_fact', {
      customerId: customer.id,
      facts: [
        { key: 'alpha', value: 'a1' },
        { key: 'beta', value: 'b1' },
      ],
    });
    const done = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(done.data.status).toBe('recorded');

    // Crash window + a NEWER overwrite of one key by someone else.
    await pg.query(
      "update review_items set status = 'open', resolution = null, resolved_at = null where id = $1",
      [staged.data.confirmId],
    );
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const mgrStage = await callWith('record_standing_fact', {
        customerId: customer.id,
        key: 'alpha',
        value: 'NEWER',
      });
      await callWith('record_standing_fact', { confirmId: mgrStage.data.confirmId });
    } finally {
      await mgrClient.close();
    }

    const replay = await call('record_standing_fact', { confirmId: staged.data.confirmId });
    expect(replay.isError).toBe(false);
    expect(replay.data.status).toBe('recorded');
    expect(replay.data.keys).toEqual(['beta']); // 'already' counts as recorded
    expect(replay.data.conflictKeys).toEqual(['alpha']); // skipped, named
    expect(replay.data.note).toContain('NOT overwritten');
    // The newer value survived; the token's resolution names the skip.
    const row = await pg.query<{ attributes: { alpha?: { value: string } } }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(row.rows[0].attributes.alpha?.value).toBe('NEWER');
    const token = await pg.query<{ status: string; resolution: string }>(
      'select status, resolution from review_items where id = $1',
      [staged.data.confirmId],
    );
    expect(token.rows[0].status).toBe('resolved');
    expect(token.rows[0].resolution).toContain('skipped changed keys: alpha');
  });

  test('retraction fold: retracting the evidence hides the fact from context, get_job, and find_customer; the audit view keeps it labeled', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Fold Cust', phone: '555-9007' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Fold Job' });

    const cs = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'prefers_contact',
      value: 'email',
    });
    const cDone = await call('record_standing_fact', { confirmId: cs.data.confirmId });
    const js = await call('record_standing_fact', { jobId: job.id, key: 'crane_needed', value: true });
    const jDone = await call('record_standing_fact', { confirmId: js.data.confirmId });

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
    const row = found.data.find((c: { id: string }) => c.id === customer.id);
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
      const evidence = audit.data.find((c: { id: string }) => c.id === cDone.data.captureId);
      expect(evidence.retracted).toBe(true);
      expect(evidence.retraction.reason).toBe('wrong customer preference');
    } finally {
      await mgrClient.close();
    }
  });

  test("overwrite + retraction: only the CURRENT bundle's evidence controls the fold", async () => {
    const customer = await createCustomer({ tenantId, name: 'Fact Overfold', phone: '555-9008' });
    const first = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'gate_code',
      value: 1111,
    });
    const firstDone = await call('record_standing_fact', { confirmId: first.data.confirmId });
    const second = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'gate_code',
      value: 2222,
    });
    const secondDone = await call('record_standing_fact', { confirmId: second.data.confirmId });

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

    // Staging the key again after the retraction must NOT resurface the
    // retracted value as previousValue — the visible record has no such fact.
    const restaged = await call('record_standing_fact', {
      customerId: customer.id,
      key: 'gate_code',
      value: 3333,
    });
    expect(restaged.data.status).toBe('needs_confirmation');
    expect(restaged.data.preview.previousValue).toBeUndefined();
  });
});

describe('scheduling tools (book/move/unschedule_visit + get_team_schedule)', () => {
  test('timeTbd + day promise: stages AND confirms (the malformed-stage regression), then recall + find_slots + set_promise semantics — plan 4b-2', { timeout: 30_000 }, async () => {
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
      // timeTbd + times together is an agent error, refused loudly.
      const mixed = await callWith('book_visit', {
        customerId: customer.id, title: 'tbd mixed', timeTbd: true,
        earliestDate: '2026-12-14', startTime: '09:00',
      });
      expect(mixed.isError).toBe(true);
      expect(mixed.text).toContain('NOT settled');

      // THE regression (plan-review severe finding): a day-promised timeTbd
      // booking routes through STAGING — the stage must carry the unplaced
      // shape and the confirm must accept it as valid, not "malformed".
      const staged = await callWith('book_visit', {
        customerId: customer.id,
        title: 'tbd promised install',
        timeTbd: true,
        earliestDate: '2026-12-14',
        promiseLevel: 'day',
      });
      expect(staged.data.status).toBe('needs_confirmation');
      expect(staged.data.preview).toMatchObject({
        timeTbd: true,
        earliestDate: '2026-12-14',
        latestDate: '2026-12-14',
        startTime: null,
        endTime: null,
        promiseLevel: 'day',
      });
      const booked = await callWith('book_visit', { confirmId: staged.data.confirmId });
      expect(booked.data.status).toBe('booked');
      expect(booked.data.timeTbd).toBe(true);
      expect(booked.data.startTime).toBeNull();
      const assignmentId = booked.data.assignmentId as string;
      // Row read-back: null times, range set, promise stamped.
      const { rows } = await pg.query(
        'select starts_at, ends_at, earliest_date::text, latest_date::text, promise_level, promised_day from assignments where id = $1',
        [assignmentId],
      );
      expect(rows[0].starts_at).toBeNull();
      expect(rows[0].ends_at).toBeNull();
      expect(rows[0].earliest_date).toBe('2026-12-14');
      expect(rows[0].promise_level).toBe('day');

      // A RANGE that straddles `from` is still-live work and must not be
      // clamped out of recall (review finding: only a fully-past range drops).
      const straddle = await callWith('book_visit', {
        customerId: customer.id, title: 'tbd straddle', timeTbd: true,
        earliestDate: '2026-12-10', latestDate: '2026-12-20',
      });
      const recallStraddle = await callWith('get_team_schedule', {
        unassignedOnly: true, from: '2026-12-15',
      });
      const straddleDays = recallStraddle.data.days as Array<{
        date: string;
        stops: Array<Record<string, unknown>>;
      }>;
      const straddleDay = straddleDays.find((d) =>
        d.stops.some((st) => st.assignmentId === straddle.data.assignmentId),
      );
      expect(straddleDay).toBeDefined();
      // …and its day group is CLAMPED to `from` (final-review finding: the
      // unclamped earliest_date emitted a group dated before the requested
      // window — the agent relayed live Dec 15–20 work as five days past).
      expect(straddleDay?.date).toBe('2026-12-15');
      const straddleStop = straddleDay?.stops.find(
        (st) => st.assignmentId === straddle.data.assignmentId,
      );
      // The true range still rides the stop — the clamp adjusts the group
      // key, never the data.
      expect(straddleStop?.earliestDate).toBe('2026-12-10');
      expect(straddleStop?.latestDate).toBe('2026-12-20');

      // The recall view lists it with its day and NO invented time.
      const recall = await callWith('get_team_schedule', { unassignedOnly: true });
      const allStops: Array<Record<string, unknown>> = (
        recall.data.days as Array<{ date: string; stops: Array<Record<string, unknown>> }>
      ).flatMap((d) => d.stops.map((st) => ({ ...st, date: d.date })));
      const mine = allStops.find((st) => st.assignmentId === assignmentId);
      expect(mine).toBeDefined();
      expect(mine?.date).toBe('2026-12-14');
      expect(mine?.startTime).toBeNull();
      expect(mine?.timeTbd).toBe(true);

      // find_slots on the unplaced visit: duration from the JOB's recorded
      // length; the search window defaults to the visit's own day. Give
      // tech-mcp a working pattern so 2026-12-14 (a Monday) has real gaps.
      const techRow = await pg.query('select id from technicians where tenant_id = $1 and ref = $2', [tenantId, 'tech-mcp']);
      await setTechnicianAvailability(techRow.rows[0].id as string, {
        mon: [['08:00', '17:00']], tue: [['08:00', '17:00']], wed: [['08:00', '17:00']],
        thu: [['08:00', '17:00']], fri: [['08:00', '17:00']], sat: [], sun: [],
      });
      const jobId = booked.data.jobId as string;
      const noLen = await callWith('find_slots', { assignmentId });
      expect(noLen.isError).toBe(true); // fail-closed: no length anywhere yet
      const upd = await callWith('update_job', { jobId, durationMinutes: 120 });
      expect(upd.data.status).toBe('ok');
      const slots = await callWith('find_slots', { assignmentId });
      expect(slots.data.status).toBe('ok');
      expect(slots.data.durationAssumption).toContain("job's recorded length");
      // The window defaulted to the visit's OWN day: every candidate must sit
      // on 2026-12-14 (a one-day search space proves the range default).
      const cands = slots.data.candidates as Array<{ date: string; endTime: string; startTime: string }>;
      expect(cands.length).toBeGreaterThan(0);
      expect(cands.every((c) => c.date === '2026-12-14')).toBe(true);
      // …and each candidate spans the job's 120 recorded minutes.
      expect(cands[0].endTime >= '10:00').toBe(true);

      // set_promise semantics: 'time' refused on the unplaced row; 'none' ok.
      const timeRefused = await callWith('set_promise', { assignmentId, promiseLevel: 'time' });
      expect(timeRefused.isError).toBe(true);
      expect(timeRefused.text).toContain('booked time');
      const cleared = await callWith('set_promise', { assignmentId, promiseLevel: 'none' });
      expect(cleared.data.status).toBe('ok');
      expect(cleared.data.date).toBe('2026-12-14'); // derived from the range day
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

  test('assigned time-TBD visits: windowed visibility + clamped day, wide-range find_slots, row-derived echo — final-review fixes', { timeout: 30_000 }, async () => {
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
        customerId: customer.id, title: 'assigned tbd', timeTbd: true,
        technicianRef: 'tech-mcp',
        earliestDate: '2026-12-21', latestDate: '2026-12-23',
      });
      expect(booked.data.status).toBe('booked');
      const assignmentId = booked.data.assignmentId as string;
      // Full-window read: lands on its own earliest day, person attached.
      const full = await callWith('get_team_schedule', {
        from: '2026-12-20', to: '2026-12-24',
      });
      const fullDays = full.data.days as Array<{
        date: string;
        stops: Array<Record<string, unknown>>;
      }>;
      const fullDay = fullDays.find((d) => d.stops.some((st) => st.assignmentId === assignmentId));
      expect(fullDay?.date).toBe('2026-12-21');
      const stop = fullDay?.stops.find((st) => st.assignmentId === assignmentId);
      expect(stop).toMatchObject({
        timeTbd: true,
        technicianRef: 'tech-mcp',
        unassigned: false,
        startTime: null,
        endTime: null,
        earliestDate: '2026-12-21',
        latestDate: '2026-12-23',
      });
      // Mid-range window: still visible, day group clamped to `from`.
      const mid = await callWith('get_team_schedule', {
        from: '2026-12-22', to: '2026-12-24',
      });
      const midDays = mid.data.days as Array<{
        date: string;
        stops: Array<Record<string, unknown>>;
      }>;
      const midDay = midDays.find((d) => d.stops.some((st) => st.assignmentId === assignmentId));
      expect(midDay?.date).toBe('2026-12-22');
      // A window the range never touches stays clean.
      const outside = await callWith('get_team_schedule', {
        from: '2026-12-26', to: '2026-12-28',
      });
      const outsideStops = (
        outside.data.days as Array<{ stops: Array<Record<string, unknown>> }>
      ).flatMap((d) => d.stops);
      expect(outsideStops.some((st) => st.assignmentId === assignmentId)).toBe(false);

      // find_slots on a subject whose range is WIDER than the 14-day cap:
      // the subject-defaulted window CLAMPS instead of erroring (final-review
      // finding: "sometime this month" booked fine, then a bare find_slots
      // call died with invalid_range blaming args the agent never passed).
      const wide = await callWith('book_visit', {
        customerId: customer.id, title: 'whole month', timeTbd: true,
        earliestDate: '2027-02-01', latestDate: '2027-02-28',
      });
      const wideId = wide.data.assignmentId as string;
      await callWith('update_job', { jobId: wide.data.jobId, durationMinutes: 60 });
      const slots = await callWith('find_slots', { assignmentId: wideId });
      expect(slots.data.status).not.toBe('invalid_range');
      const searched = slots.data.searched as { days: number } | undefined;
      if (searched) expect(searched.days).toBeLessThanOrEqual(14);

      // One-shot echo derives the day from the ROW: on a mixed
      // date+earliestDate call the range day wins the booking, and the echo
      // must report the day the row actually holds, not the ignored arg.
      const mixed = await callWith('book_visit', {
        customerId: customer.id, title: 'mixed args', timeTbd: true,
        date: '2026-12-28', earliestDate: '2026-12-29',
      });
      expect(mixed.data.status).toBe('booked');
      expect(mixed.data.date).toBe('2026-12-29');
      expect(mixed.data.earliestDate).toBe('2026-12-29');
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

  test('book → team view → move (promise break) → cancel, with version bumps and token guards', async () => {
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
      // STAGE: full preview, resolved defaults, availability warning (tech-mcp
      // has no working pattern configured), nothing booked yet.
      const staged = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        title: 'water heater swap',
        date: '2026-12-01',
        startTime: '09:00',
        endTime: '12:00',
        promiseLevel: 'day', // manager told the customer this day (exercises the promise-break path)
      });
      expect(staged.data.status).toBe('needs_confirmation');
      expect(staged.data.preview).toMatchObject({
        customerName: 'Sched Henderson',
        technicianName: 'Tech MCP',
        newJob: true,
        date: '2026-12-01',
        startTime: '09:00',
        endTime: '12:00',
        promiseLevel: 'day',
      });
      expect(staged.data.preview.warning).toContain('no working pattern');

      // Forged confirmId → not found.
      const forged = await callWith('book_visit', { confirmId: customer.id });
      expect(forged.isError).toBe(true);
      expect(forged.text).toContain('confirmation not found');

      // resolve_review refuses to "resolve" the live booking token (the token
      // survives — the confirm below still works).
      const refusedBooking = await callWith('resolve_review', {
        reviewItemId: staged.data.confirmId,
        resolution: 'resolved',
      });
      expect(refusedBooking.isError).toBe(true);
      expect(refusedBooking.text).toContain('book_visit');

      // CONFIRM books it.
      const booked = await callWith('book_visit', { confirmId: staged.data.confirmId });
      expect(booked.data.status).toBe('booked');
      expect(booked.data.promiseLevel).toBe('day');
      const assignmentId = booked.data.assignmentId as string;

      // Second confirm on the consumed token → nothing double-booked.
      const replay = await callWith('book_visit', { confirmId: staged.data.confirmId });
      expect(replay.isError).toBe(true);
      expect(replay.text).toContain('confirmation not found');

      // Team view: the manager sees ANOTHER technician's stop, with the
      // promise/lock markers and a scheduleVersion.
      const team = await callWith('get_team_schedule', { from: '2026-12-01', to: '2026-12-01' });
      expect(team.data.status).toBe('ok');
      const v1 = team.data.scheduleVersion as number;
      expect(v1).toBeGreaterThan(0);
      const stops = team.data.days[0].stops as Array<Record<string, unknown>>;
      const stop = stops.find((s) => s.assignmentId === assignmentId);
      expect(stop).toMatchObject({
        technicianRef: 'tech-mcp',
        customer: 'Sched Henderson',
        promiseLevel: 'day',
        promisedDay: '2026-12-01',
        locked: false, // human-privilege pinning (plan 4b-3): no verb auto-locks
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
      expect(stop?.address).toContain('40 Elm Ave');

      // MOVE to another day: preview must flag the promise break; confirm moves.
      const moveStage = await callWith('move_visit', {
        assignmentId,
        date: '2026-12-02',
        startTime: '13:00',
        reason: 'customer asked for Wednesday',
      });
      expect(moveStage.data.status).toBe('needs_confirmation');
      expect(moveStage.data.preview.promiseBroken).toBe(true);
      expect(moveStage.data.note).toContain('promiseBroken is TRUE');
      // Refusal covers the move kind too.
      const refusedMove = await callWith('resolve_review', {
        reviewItemId: moveStage.data.confirmId,
        resolution: 'resolved',
      });
      expect(refusedMove.isError).toBe(true);
      expect(refusedMove.text).toContain('move_visit');
      const moved = await callWith('move_visit', { confirmId: moveStage.data.confirmId });
      expect(moved.data.status).toBe('moved');
      expect(moved.data.promiseBroken).toBe(true);
      const movedId = moved.data.assignmentId as string;
      expect(movedId).not.toBe(assignmentId);

      // Version advanced (booked + moved events).
      const after = await callWith('get_team_schedule', { from: '2026-12-02', to: '2026-12-02' });
      expect(after.data.scheduleVersion).toBeGreaterThan(v1);

      // resolve_review refuses to "resolve" a live scheduling token; dismissing
      // cancels it (then its confirm finds nothing).
      const cancelStage = await callWith('unschedule_visit', {
        assignmentId: movedId,
        reason: 'testing the refusal',
      });
      expect(cancelStage.data.status).toBe('needs_confirmation');
      const refused = await callWith('resolve_review', {
        reviewItemId: cancelStage.data.confirmId,
        resolution: 'resolved',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('unschedule_visit');
      const dismissed = await callWith('resolve_review', {
        reviewItemId: cancelStage.data.confirmId,
        resolution: 'dismissed',
      });
      expect(dismissed.isError).toBe(false);
      const deadConfirm = await callWith('unschedule_visit', { confirmId: cancelStage.data.confirmId });
      expect(deadConfirm.isError).toBe(true);
      expect(deadConfirm.text).toContain('confirmation not found');

      // CANCEL for real: restage (fresh preview) then confirm.
      const cancelStage2 = await callWith('unschedule_visit', {
        assignmentId: movedId,
        reason: 'customer cancelled',
      });
      expect(cancelStage2.data.preview).toMatchObject({ customerName: 'Sched Henderson' });
      const cancelled = await callWith('unschedule_visit', { confirmId: cancelStage2.data.confirmId });
      // Vocabulary (2026-07-25): the wire status says what the tool DID — the
      // visit is unscheduled; "cancelled" is reserved for the terminal verb.
      expect(cancelled.data.status).toBe('unscheduled');
      expect(cancelled.data.note).toContain('loose bucket');
      // The unscheduled visit no longer appears on the board.
      const gone = await callWith('get_team_schedule', { from: '2026-12-02', to: '2026-12-02' });
      expect(gone.data.days).toHaveLength(0);
    } finally {
      await mgrClient.close();
    }
  });

  test('unpromised book/move/cancel are ONE-SHOT (doctrine: reversible + internal = act and report)', async () => {
    // The pilot bugs, both directions: booking silently recorded "customer
    // told this day" (default is now 'none'), and reversible internal changes
    // dragged the manager through a confirmation they didn't need.
    const customer = await createCustomer({ tenantId, name: 'Unpromised Uma' });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // ONE call books it — no needs_confirmation for an unpromised visit.
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-15',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(booked.data.status).toBe('booked');
      expect(booked.data.promiseLevel).toBe('none');
      expect(booked.data.note).toContain('one step');
      // 4b-1 (final-review finding): the minted shell RECORDS the booked span
      // as the job's length — a silently-stored value unless echoed here, the
      // same rule that put jobTitle on this result (live E2E 2026-07-21).
      expect(booked.data.jobDurationMinutes).toBe(60);
      const id = booked.data.assignmentId as string;

      const team = await callWith('get_team_schedule', { from: '2026-12-15', to: '2026-12-15' });
      const stop = (team.data.days[0].stops as Array<Record<string, unknown>>).find(
        (s) => s.assignmentId === id,
      );
      expect(stop).toMatchObject({ promiseLevel: 'none', promisedDay: null });

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
      expect(missingEnd.text).toContain('ask them');

      // Moving the unpromised visit is one-shot too — and claims no break.
      const moved = await callWith('move_visit', {
        assignmentId: id,
        date: '2026-12-16',
        startTime: '09:00',
        reason: 'internal reshuffle',
      });
      expect(moved.data.status).toBe('moved');
      expect(moved.data.promiseBroken).toBe(false);
      expect(moved.data.note).toContain('one step');

      // Unscheduling it: one-shot as well — and the result must say the WORK
      // survives (the job returns to the loose bucket).
      const cancelled = await callWith('unschedule_visit', {
        assignmentId: moved.data.assignmentId,
        reason: 'not needed',
      });
      expect(cancelled.data.status).toBe('unscheduled');
      expect(cancelled.data.note).toContain('one step');
      expect(cancelled.data.note).toContain('loose bucket');

      // The PROMISED path also requires both times — staged and confirmed with
      // exactly the stated window (preview == commit).
      const staged = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-18',
        startTime: '09:00',
        endTime: '10:30',
        promiseLevel: 'day',
      });
      expect(staged.data.status).toBe('needs_confirmation');
      expect(staged.data.preview.endTime).toBe('10:30');
      const confirmed = await callWith('book_visit', { confirmId: staged.data.confirmId });
      expect(confirmed.data.status).toBe('booked');
      expect(confirmed.data.endTime).toBe('10:30');
    } finally {
      await mgrClient.close();
    }
  });

  test('expired staged booking is dismissed with a clean restage error', async () => {
    const customer = await createCustomer({ tenantId, name: 'Expiry Ed' });
    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      const staged = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-08',
        startTime: '09:00',
        endTime: '10:00',
        promiseLevel: 'day', // promised → still stages (one-shot would skip the token)
      });
      // Age the token past the 15-minute window.
      await pg.query(
        `update review_items set detail = detail || jsonb_build_object('stagedAt', $1::text) where id = $2`,
        [new Date(Date.now() - 20 * 60_000).toISOString(), staged.data.confirmId],
      );
      const expired = await callWith('book_visit', { confirmId: staged.data.confirmId });
      expect(expired.isError).toBe(true);
      expect(expired.text).toContain('confirmation expired');
    } finally {
      await mgrClient.close();
    }
  });

  test('staging an impossible booking fails at stage time (unknown tech, overlap)', async () => {
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

      // Unpromised → lands in one call under the one-shot doctrine.
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
      // PROMISED + unassigned: the promise forces the stage, whose preview
      // must echo a person-less booking (null technician fields).
      const staged = await callWith('book_visit', {
        customerId: customer.id,
        date: '2027-01-05',
        startTime: '09:00',
        endTime: '10:00',
        promiseLevel: 'day',
      });
      expect(staged.data.status).toBe('needs_confirmation');
      expect(staged.data.preview.technicianRef).toBeNull();
      expect(staged.data.preview.technicianName).toBeNull();
      const booked = await callWith('book_visit', { confirmId: staged.data.confirmId });
      expect(booked.data.status).toBe('booked');
      expect(booked.data.unassigned).toBe(true);
      expect(booked.data.technicianRef).toBeNull();
      const id = booked.data.assignmentId as string;

      // The board window covering the day flags it person-less.
      const team = await callWith('get_team_schedule', { from: '2027-01-05', to: '2027-01-05' });
      const stop = (team.data.days[0].stops as Array<Record<string, unknown>>).find(
        (s) => s.assignmentId === id,
      );
      expect(stop).toMatchObject({ unassigned: true, technicianRef: null, technicianName: null });

      // Attaching a person same day/time keeps the promise → ONE-SHOT move.
      const moved = await callWith('move_visit', {
        assignmentId: id,
        date: '2027-01-05',
        startTime: '09:00',
        technicianRef: 'tech-mcp',
        reason: 'assigning tech',
      });
      expect(moved.data.status).toBe('moved');
      expect(moved.data.promiseBroken).toBe(false);
      const after = await callWith('get_team_schedule', { from: '2027-01-05', to: '2027-01-05' });
      const attached = (after.data.days[0].stops as Array<Record<string, unknown>>).find(
        (s) => s.assignmentId === moved.data.assignmentId,
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
      const farId = booked.data.assignmentId as string;
      // An ASSIGNED far-out visit — must never appear in the recall view.
      const aBooked = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2027-02-11',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(aBooked.data.status).toBe('booked');

      // Default board read (today) does NOT show the far-out visit…
      const today = await callWith('get_team_schedule', {});
      const todaysIds = (today.data.days as Array<{ stops: Array<{ assignmentId: string }> }>)
        .flatMap((d) => d.stops)
        .map((s) => s.assignmentId);
      expect(todaysIds).not.toContain(farId);
      // …and a >14-day range without the flag still errors (cap unchanged).
      const capped = await callWith('get_team_schedule', { from: '2027-01-01', to: '2027-03-01' });
      expect(capped.data.status).toBe('invalid_range');

      // The recall view finds it, however far out, with the full stop shape.
      const recall = await callWith('get_team_schedule', { unassignedOnly: true });
      expect(recall.data.status).toBe('ok');
      expect(recall.data.unassignedOnly).toBe(true);
      expect(recall.data.scheduleVersion).toBeGreaterThan(0);
      const recallStops = (recall.data.days as Array<{ stops: Array<Record<string, unknown>> }>)
        .flatMap((d) => d.stops);
      const farStop = recallStops.find((s) => s.assignmentId === farId);
      expect(farStop).toMatchObject({ unassigned: true, customer: 'Recall Roy' });
      // Assigned visits never appear here.
      expect(recallStops.map((s) => s.assignmentId)).not.toContain(aBooked.data.assignmentId);

      // Plan 4a agent parity: the recall view also carries the bucket's other
      // half — open jobs with NO visit at all — plus the explaining note.
      const bareJob = await createJob({
        tenantId,
        customerId: customer.id,
        title: 'Recall bare job',
        priority: 'urgent',
      });
      const recall2 = await callWith('get_team_schedule', { unassignedOnly: true });
      const jobs = recall2.data.unscheduledJobs as Array<Record<string, unknown>>;
      const bare = jobs.find((j) => j.jobId === bareJob.id);
      expect(bare).toMatchObject({
        title: 'Recall bare job',
        customer: 'Recall Roy',
        priority: 'urgent',
      });
      // Jobs with a live visit (the far-out booking's job) stay OUT.
      expect(jobs.map((j) => j.jobId)).not.toContain(booked.data.jobId);
      expect(recall2.data.note).toContain('unscheduledJobs');
      // The windowed mode does NOT carry the jobs half.
      const windowed = await callWith('get_team_schedule', {});
      expect(windowed.data.unscheduledJobs).toBeUndefined();

      // Garbage flag type is rejected.
      const bad = await callWith('get_team_schedule', { unassignedOnly: 'yes' });
      expect(bad.data.status).toBe('invalid_range');
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
      const row = (team.data as Array<Record<string, unknown>>).find((t) => t.ref === 'input-probe');
      expect(row).toMatchObject({ skills: ['boilers', 'gas-line'], availabilityConfigured: true });
      const goneRow = (team.data as Array<Record<string, unknown>>).find((t) => t.ref === 'input-gone');
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

  test('onboarding hook: seat confirm opens availability_setup; set_availability auto-resolves; dismiss = "not known yet"', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
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

      const pending = await callWith('list_pending_reviews', {});
      const item = (pending.data as Array<Record<string, unknown>>).find(
        (r) => r.kind === 'availability_setup' && r.subject_ref === 'onboard-one',
      );
      expect(item).toBeDefined();

      // Setting the pattern closes the obligation.
      const set = await callWith('set_availability', { ref: 'onboard-one', pattern: PATTERN_MON_FRI });
      expect(set.isError).toBe(false);
      const after = await callWith('list_pending_reviews', {});
      expect(
        (after.data as Array<Record<string, unknown>>).find(
          (r) => r.kind === 'availability_setup' && r.subject_ref === 'onboard-one',
        ),
      ).toBeUndefined();

      // Second person: the explicit "no availability yet" path via dismiss.
      const stage2 = await callWith('add_technician_seat', {
        displayName: 'Onboard Two',
        seatExempt: true,
      });
      await callWith('add_technician_seat', { confirmId: stage2.data.confirmId });
      const pending2 = await callWith('list_pending_reviews', {});
      const item2 = (pending2.data as Array<Record<string, unknown>>).find(
        (r) => r.kind === 'availability_setup' && r.subject_ref === 'onboard-two',
      );
      expect(item2).toBeDefined();
      const dismissed = await callWith('resolve_review', {
        reviewItemId: item2!.id,
        resolution: 'dismissed',
        note: 'no availability yet — hours not known',
      });
      expect(dismissed.isError).toBe(false);

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
      const pending3 = await callWith('list_pending_reviews', {});
      expect(
        (pending3.data as Array<Record<string, unknown>>).find(
          (r) => r.kind === 'availability_setup' && r.subject_ref === 'onboard-three',
        ),
      ).toBeDefined();
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

      // Staged path: preview shows the tier + job title; commit writes and
      // echoes exactly them.
      const staged = await callWith('book_visit', {
        customerId: customer.id,
        title: 'panel upgrade',
        date: '2027-04-03',
        startTime: '09:00',
        endTime: '10:00',
        promiseLevel: 'day',
        priority: 'emergency',
      });
      expect(staged.data.status).toBe('needs_confirmation');
      expect(staged.data.preview.priority).toBe('emergency');
      expect(staged.data.preview.jobTitle).toBe('panel upgrade');
      const confirmed = await callWith('book_visit', { confirmId: staged.data.confirmId });
      expect(confirmed.isError).toBe(false);
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
    return createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: opts.technicianId,
      startsAt: opts.startsAt,
      endsAt: opts.endsAt,
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

      // assumedType on an UNTYPED subject → resolves the table, labeled a guess.
      const guessed = await callWith('find_slots', {
        customerId: henderson.id,
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
        assignmentId: booked.data.assignmentId,
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
      startsAt: '2027-03-08T09:00:00.000Z',
      endsAt: '2027-03-08T10:00:00.000Z',
    });
    await bookedVisit({
      technicianId: bob.id,
      startsAt: '2027-03-08T11:00:00.000Z',
      endsAt: '2027-03-08T13:00:00.000Z',
    });

    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    const prevHandle = process.env.BOARD_BOT_HANDLE;
    process.env.BOARD_BOT_HANDLE = 'SlotsProbeBot';
    try {
      const empty = await callWith('find_slots', {
        customerId: henderson.id,
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

  test('assignmentId subject: row duration, own-slot exclusion, terminal refusal', { timeout: 30_000 }, async () => {
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // An UNASSIGNED parked visit is a valid subject; its booked length rides.
      const parked = await bookedVisit({
        technicianId: null,
        startsAt: '2027-03-15T09:00:00.000Z',
        endsAt: '2027-03-15T11:00:00.000Z',
      });
      const who = await callWith('find_slots', {
        assignmentId: parked.id,
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
        startsAt: '2027-03-22T08:00:00.000Z',
        endsAt: '2027-03-22T17:00:00.000Z',
      });
      const rehome = await callWith('find_slots', {
        assignmentId: whole.id,
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
        startsAt: '2027-03-29T09:00:00.000Z',
        endsAt: '2027-03-29T10:00:00.000Z',
      });
      await updateAssignmentStatus(dead.id, 'cancelled');
      const refused = await callWith('find_slots', { assignmentId: dead.id });
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
        startsAt: '2027-04-19T08:00:00.000Z',
        endsAt: '2027-04-19T17:00:00.000Z',
      });
      const fullDay = await callWith('find_slots', {
        customerId: henderson.id,
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
      expect(displaced[0]).toHaveProperty('promiseLevel');
      expect(displaced[0]).toHaveProperty('locked');
    } finally {
      await mgrClient.close();
    }
  });

  test('drive wiring: a 2-stop day measures the with-route through the injected seam', { timeout: 30_000 }, async () => {
    await bookedVisit({
      technicianId: bob.id,
      startsAt: '2027-04-05T09:00:00.000Z',
      endsAt: '2027-04-05T10:00:00.000Z',
      addressed: true,
    });
    await bookedVisit({
      technicianId: bob.id,
      startsAt: '2027-04-05T11:00:00.000Z',
      endsAt: '2027-04-05T12:00:00.000Z',
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
    const subject = await createAssignment({
      tenantId,
      jobId: subjJob.id,
      technicianId: bob.id,
      startsAt: '2027-04-12T09:00:00.000Z',
      endsAt: '2027-04-12T10:00:00.000Z',
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
        startsAt: `2027-04-12T${s}:00.000Z`,
        endsAt: `2027-04-12T${e}:00.000Z`,
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
        assignmentId: subject.id,
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
        assignmentId: subject.id,
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
    const proposed = await createAssignment({
      tenantId,
      jobId: subjJob.id,
      technicianId: bob.id,
      startsAt: '2027-04-12T09:00:00.000Z', // same instant as bob's CONFIRMED visit
      endsAt: '2027-04-12T10:00:00.000Z',
    });
    const propFake = mkFake();
    const { client: c3, callWith: propCall } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      { computeRoutes: propFake },
    );
    try {
      const res = await propCall('find_slots', {
        assignmentId: proposed.id,
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

describe('set_promise (the promise-record editor)', () => {
  test('gate + validation + old→new echo + the promise then gates moves', { timeout: 30_000 }, async () => {
    const denied = await call('set_promise', { assignmentId: 'x', promiseLevel: 'day' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('manager badge');

    const customer = await createCustomer({ tenantId, name: 'Set Promise Cust' });
    const job = await createJob({
      tenantId,
      customerId: customer.id,
      title: 'garage sink leak',
      status: 'open',
    });
    // Own probe tech — standalone-runnable (the update_job round-2 lesson).
    const spt = await insertTechnician({
      tenantId,
      ref: 'set-promise-tech',
      displayName: 'Set Promise Tech',
      seatExempt: true,
    });
    await setTechnicianAvailability(spt.id, {
      mon: [['08:00', '17:00']],
      tue: [['08:00', '17:00']],
      wed: [['08:00', '17:00']],
      thu: [['08:00', '17:00']],
      fri: [['08:00', '17:00']],
      sat: [],
      sun: [],
    });
    // The live P5 incident shape: booked one-shot, confirmed, promise-free —
    // the manager's "I told them we're coming Thursday" never became an arg.
    const visit = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: spt.id,
      startsAt: '2027-06-07T13:00:00.000Z', // a Monday well past other fixtures
      endsAt: '2027-06-07T14:00:00.000Z',
      status: 'confirmed',
    });

    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      // Validation: missing/invalid/non-string args, unknown id.
      const noId = await callWith('set_promise', { promiseLevel: 'day' });
      expect(noId.isError).toBe(true);
      expect(noId.text).toContain('assignmentId is required');
      const noLevel = await callWith('set_promise', { assignmentId: visit.id });
      expect(noLevel.isError).toBe(true);
      expect(noLevel.text).toContain('invalid promiseLevel');
      const badLevel = await callWith('set_promise', {
        assignmentId: visit.id,
        promiseLevel: 'promised',
      });
      expect(badLevel.isError).toBe(true);
      expect(badLevel.text).toContain('invalid promiseLevel');
      // A number must be REJECTED, not coerced-to-absent (partial-update trap).
      const numLevel = await callWith('set_promise', { assignmentId: visit.id, promiseLevel: 42 });
      expect(numLevel.isError).toBe(true);
      expect(numLevel.text).toContain('promiseLevel must be a string');
      const unknown = await callWith('set_promise', {
        assignmentId: '00000000-0000-0000-0000-000000000002',
        promiseLevel: 'day',
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain('visit not found');

      // The correction: promise-free → 'day', echoed old → new. BOARD_BOT_HANDLE
      // set: a promise correction is a schedule answer — it must carry the REAL
      // board link (the find_slots fabrication lesson).
      const prevHandle = process.env.BOARD_BOT_HANDLE;
      process.env.BOARD_BOT_HANDLE = 'SlotsProbeBot';
      let fixed;
      try {
        fixed = await callWith('set_promise', { assignmentId: visit.id, promiseLevel: 'day' });
      } finally {
        if (prevHandle === undefined) delete process.env.BOARD_BOT_HANDLE;
        else process.env.BOARD_BOT_HANDLE = prevHandle;
      }
      expect(fixed.isError).toBe(false);
      expect(fixed.data.changes.promiseLevel).toEqual({ from: 'none', to: 'day' });
      // promisedDay is SERVER-derived from the visit's own row (bookVisit
      // precedent) — agent date math never touches the promise record.
      expect(fixed.data.changes.promisedDay).toEqual({ from: null, to: '2027-06-07' });
      // Short form — the same weekday vocabulary find_slots already ships.
      expect(fixed.data.weekday).toBe('Mon');
      expect(fixed.data.note).toContain('old → new');
      // The gating claim matches the actual gate (review finding): a 'day'
      // promise gates day-changing moves only — same-day shifts stay one-shot.
      expect(fixed.data.note).toContain('ANOTHER day');
      expect(fixed.data.boardLink).toBe('https://t.me/SlotsProbeBot?startapp');
      const row = await pg.query(
        'select promise_level, promised_day::text as promised_day from assignments where id = $1',
        [visit.id],
      );
      expect(row.rows[0]).toEqual({ promise_level: 'day', promised_day: '2027-06-07' });
      // The edit joined the append-only ledger: who, what, old → new.
      const ev = await pg.query(
        "select actor_ref, assignment_id, detail from schedule_events where tenant_id = $1 and kind = 'promise_updated' order by id desc limit 1",
        [tenantId],
      );
      expect(ev.rows[0].actor_ref).toBe('mgr-test');
      expect(ev.rows[0].assignment_id).toBe(visit.id);
      expect(ev.rows[0].detail.promiseLevel).toEqual({ from: 'none', to: 'day' });

      // THE point of the tool: the recorded promise now GATES — a day-breaking
      // move stages a confirmation instead of one-shotting (the silent-move
      // harm the correction exists to prevent).
      const move = await callWith('move_visit', {
        assignmentId: visit.id,
        date: '2027-06-08',
        startTime: '13:00',
        reason: 'probe: the promise must gate this move',
      });
      expect(move.isError).toBe(false);
      expect(move.data.status).toBe('needs_confirmation');
      expect(move.data.preview.promiseBroken).toBe(true);

      // 'none' is the undo: promise cleared, promisedDay follows.
      const cleared = await callWith('set_promise', { assignmentId: visit.id, promiseLevel: 'none' });
      expect(cleared.isError).toBe(false);
      expect(cleared.data.changes.promiseLevel).toEqual({ from: 'day', to: 'none' });
      expect(cleared.data.changes.promisedDay).toEqual({ from: '2027-06-07', to: null });
      expect(cleared.data.note).toContain('can now move');

      // Dead rows refuse: a cancelled visit's promise is not correctable.
      const dead = await createAssignment({
        tenantId,
        jobId: job.id,
        technicianId: spt.id,
        startsAt: '2027-06-09T13:00:00.000Z',
        endsAt: '2027-06-09T14:00:00.000Z',
        status: 'confirmed',
      });
      await updateAssignmentStatus(dead.id, 'cancelled');
      const onDead = await callWith('set_promise', { assignmentId: dead.id, promiseLevel: 'day' });
      expect(onDead.isError).toBe(true);
      expect(onDead.text).toContain('cancelled — promises are corrected on live visits only');

      // CAS honesty at the db layer: a stale snapshot refuses, never
      // overwrite-and-misreport (the echo IS the disclosure).
      const { updateAssignmentPromise } = await import('../db/assignments.js');
      await expect(
        updateAssignmentPromise(
          tenantId,
          visit.id,
          'day',
          '2027-06-07',
          '2020-01-01T00:00:00.000Z',
        ),
      ).rejects.toThrow(/changed while updating/);
    } finally {
      await mgrClient.close();
    }
  });
});

describe('set_visit_locks (plan 4b-3: human-privilege pinning)', () => {
  test('ids + range selectors, selector exclusivity, technician gate', { timeout: 30_000 }, async () => {
    const customer = await createCustomer({ tenantId, name: 'Lock Verb Cust' });
    // Own probe tech — standalone-runnable (the update_job round-2 lesson).
    const lvt = await insertTechnician({
      tenantId,
      ref: 'lock-verb-tech',
      displayName: 'Lock Verb Tech',
      seatExempt: true,
    });
    await setTechnicianState(lvt.id, 'active');
    const { client: mgrClient, callWith } = await clientFor({
      tenantId,
      technicianRef: 'mgr-test',
    });
    try {
      // The technician-tier default client hits the admin gate.
      const gated = await call('set_visit_locks', { locked: true, from: '2027-08-02', to: '2027-08-03' });
      expect(gated.isError).toBe(true);
      expect(gated.text).toContain('admin tools require a manager badge');

      const bookedA = await callWith('book_visit', {
        customerId: customer.id, title: 'lock probe A', technicianRef: 'lock-verb-tech',
        date: '2027-08-02', startTime: '09:00', endTime: '10:00',
      });
      expect(bookedA.data.status).toBe('booked');
      const bookedTbd = await callWith('book_visit', {
        customerId: customer.id, title: 'lock probe tbd', timeTbd: true,
        earliestDate: '2027-08-03', latestDate: '2027-08-06',
      });
      expect(bookedTbd.data.status).toBe('booked');

      // Both selectors at once is refused, never silently resolved.
      const both = await callWith('set_visit_locks', {
        locked: true, assignmentIds: [bookedA.data.assignmentId], from: '2027-08-02', to: '2027-08-03',
      });
      expect(both.isError).toBe(true);
      expect(both.text).toContain('ONE selector');
      const neither = await callWith('set_visit_locks', { locked: true });
      expect(neither.isError).toBe(true);
      expect(neither.text).toContain('BOTH from and to');

      // ids selector: pin one visit; echo carries count + server-computed days.
      const pinOne = await callWith('set_visit_locks', {
        locked: true, assignmentIds: [bookedA.data.assignmentId],
      });
      expect(pinOne.data.status).toBe('ok');
      expect(pinOne.data.count).toBe(1);
      expect(pinOne.data.days).toEqual([{ date: '2027-08-02', weekday: 'Mon' }]);

      // Range selector: catches the placed row AND the fence-overlapping
      // time-TBD row (its range starts inside the window).
      const pinWeek = await callWith('set_visit_locks', {
        locked: true, from: '2027-08-02', to: '2027-08-04',
      });
      expect(pinWeek.data.count).toBeGreaterThanOrEqual(2);
      const { rows } = await pg.query(
        'select locked from assignments where id = any($1::uuid[])',
        [[bookedA.data.assignmentId, bookedTbd.data.assignmentId]],
      );
      expect(rows.every((r: { locked: boolean }) => r.locked)).toBe(true);

      // The pinned marker reaches get_team_schedule (the copy the agent reads).
      const team = await callWith('get_team_schedule', { from: '2027-08-02', to: '2027-08-04' });
      const stops = (team.data.days as Array<{ stops: Array<Record<string, unknown>> }>).flatMap(
        (d) => d.stops,
      );
      expect(stops.find((s) => s.assignmentId === bookedA.data.assignmentId)?.locked).toBe(true);

      // Unpin by range; empty re-resolution refuses loudly.
      const unpin = await callWith('set_visit_locks', {
        locked: false, from: '2027-08-02', to: '2027-08-06',
      });
      expect(unpin.data.status).toBe('ok');
      const empty = await callWith('set_visit_locks', {
        locked: true, from: '2027-09-06', to: '2027-09-07',
      });
      expect(empty.isError).toBe(true);
      expect(empty.text).toContain('nothing matched');
    } finally {
      await mgrClient.close();
    }
  });
});

describe('run_freeze (plan 4b-3: stage → confirm the whole plan)', () => {
  // A deterministic greedy "solver": walks the REAL model the handler built,
  // seats every q| shipment on its first allowed vehicle at the earliest
  // feasible time (exact-window shipments keep their own start). Context
  // shipments are ignored (treated as seated).
  type RoiModel = {
    vehicles: Array<{ label: string; startTimeWindows: Array<{ startTime: string }> }>;
    shipments: Array<{
      label: string;
      allowedVehicleIndices?: number[];
      deliveries: Array<{
        duration: string;
        timeWindows: Array<{ startTime: string; endTime: string }>;
      }>;
    }>;
  };
  const greedyRoi = async (_url: string, _token: string, body: unknown) => {
    const model = (body as { model: RoiModel }).model;
    const routes = model.vehicles.map((v) => ({
      vehicleLabel: v.label,
      visits: [] as Array<{ shipmentLabel: string; startTime: string }>,
    }));
    const cursor = model.vehicles.map((v) => Date.parse(v.startTimeWindows[0].startTime));
    // Context pre-pass: existing visits occupy their vehicle — advance that
    // vehicle's cursor past them so greedy never double-books a real slot.
    for (const s of model.shipments) {
      if (!s.label.startsWith('ctx|') || !s.allowedVehicleIndices) continue;
      const idx = s.allowedVehicleIndices[0];
      const d = s.deliveries[0];
      const end =
        Date.parse(d.timeWindows[0].startTime) + Number.parseInt(d.duration, 10) * 1000;
      cursor[idx] = Math.max(cursor[idx], end);
    }
    for (const s of model.shipments) {
      if (!s.label.startsWith('q|')) continue;
      const allowed = s.allowedVehicleIndices ?? model.vehicles.map((_, i) => i);
      const idx = allowed[0];
      const d = s.deliveries[0];
      const durMs = Number.parseInt(d.duration, 10) * 1000;
      const tw = d.timeWindows[0];
      const exact = tw.startTime === tw.endTime;
      const startMs = exact
        ? Date.parse(tw.startTime)
        : Math.max(cursor[idx], Date.parse(tw.startTime));
      routes[idx].visits.push({
        shipmentLabel: s.label,
        startTime: new Date(startMs).toISOString().replace('.000Z', 'Z'),
      });
      cursor[idx] = Math.max(cursor[idx], startMs + durMs);
    }
    return { routes, skippedShipments: [] };
  };
  const freezeDeps: Partial<ServerDeps> = {
    roiTransport: greedyRoi,
    roiMintToken: async () => ({ token: 'tok', projectId: 'proj' }),
    // The freeze reads TENANT-WIDE queues, and earlier suites leave rows for
    // customers with addresses but no coords — those must degrade to
    // "couldn't be located" skips, never a crash. MY fixtures are pre-coded,
    // so they never reach this fake.
    geocode: async () => ({ status: 'ZERO_RESULTS', results: [] }),
  };
  const ALL_WEEK: WeeklyPattern = {
    mon: [['08:00', '17:00']], tue: [['08:00', '17:00']], wed: [['08:00', '17:00']],
    thu: [['08:00', '17:00']], fri: [['08:00', '17:00']], sat: [['08:00', '17:00']],
    sun: [['08:00', '17:00']],
  };

  test('stage → confirm: queues drain through the real verbs; pins/version/expiry/partial honesty', { timeout: 60_000 }, async () => {
    const frz = await insertTechnician({
      tenantId, ref: 'frz-tech', displayName: 'Freeze Fiona', seatExempt: true,
    });
    await setTechnicianAvailability(frz.id, ALL_WEEK);
    const { updateCustomerCoords } = await import('../db/customers.js');
    const casa = await createCustomer({
      tenantId, name: 'Freeze Casa', addressLine1: '7 Freeze Way', city: 'Clovis', state: 'CA',
    });
    await updateCustomerCoords(casa.id, 36.8, -119.7);

    // Queue fixtures: an unscheduled job, a person-less PLACED visit (exact),
    // an assigned time-TBD visit, and a PINNED time-TBD visit (must be
    // skipped and untouched).
    const jobA = await createJob({
      tenantId, customerId: casa.id, title: 'freeze job A', status: 'open', durationMinutes: 120,
    });
    const { client: mgrClient, callWith } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      freezeDeps,
    );
    try {
      // jobA stays visit-less (queue 1). The exact person-less visit (queue 2)
      // gets its own job so the two queues stay distinguishable.
      const exactJob = await createJob({
        tenantId, customerId: casa.id, title: 'freeze exact', status: 'open', durationMinutes: 60,
      });
      const exactRow = await callWith('book_visit', {
        jobId: exactJob.id, date: relDay(2), startTime: '10:00', endTime: '11:00',
      });
      expect(exactRow.data.unassigned).toBe(true);
      const tbdJob = await createJob({
        tenantId, customerId: casa.id, title: 'freeze tbd', status: 'open', durationMinutes: 60,
      });
      const tbdRow = await callWith('book_visit', {
        jobId: tbdJob.id, technicianRef: 'frz-tech', timeTbd: true,
        earliestDate: relDay(2), latestDate: relDay(6),
      });
      expect(tbdRow.data.timeTbd).toBe(true);
      const pinJob = await createJob({
        tenantId, customerId: casa.id, title: 'freeze pinned', status: 'open', durationMinutes: 60,
      });
      const pinRow = await callWith('book_visit', {
        jobId: pinJob.id, technicianRef: 'frz-tech', timeTbd: true,
        earliestDate: relDay(3), latestDate: relDay(3),
      });
      await callWith('set_visit_locks', {
        locked: true, assignmentIds: [pinRow.data.assignmentId],
      });

      // ---- STAGE: default horizon, whole plan held behind one token.
      const staged = await callWith('run_freeze', {});
      expect(staged.data.status).toBe('needs_confirmation');
      expect(staged.data.requiresConfirmation).toBe(true);
      const { from, to } = staged.data.horizon as { from: string; to: string };
      expect(Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)).toBe(
        13 * 86_400_000,
      );
      // Assertions key on MY fixtures — the tenant-wide queues can carry
      // leftovers from earlier suites (all of which skip on missing coords).
      const placements = staged.data.placements as Array<Record<string, unknown>>;
      const mine = placements.filter((p) =>
        [jobA.id, exactJob.id, tbdJob.id].includes(p.jobId as string),
      );
      expect(mine).toHaveLength(3);
      for (const p of placements) expect(typeof p.weekday).toBe('string');
      const skipped = staged.data.skipped as Array<{ ref: string; reason: string }>;
      expect(skipped.find((s) => s.ref === pinRow.data.assignmentId)?.reason).toContain('pinned');
      expect(staged.data.note).toContain('1 pinned visit(s) were left untouched');
      expect(
        (staged.data.capacity as Array<{ technicianRef: string }>).find(
          (c) => c.technicianRef === 'frz-tech',
        ),
      ).toBeDefined();

      // Horizon validation (stage-only paths; each stage supersedes).
      const past = await callWith('run_freeze', { throughDate: '2020-01-01' });
      expect(past.isError).toBe(true);
      expect(past.text).toContain('in the past');
      const far = await callWith('run_freeze', { throughDate: relDay(40) });
      expect(far.isError).toBe(true);
      expect(far.text).toContain('capped at 31 days');

      // resolve_review must never fake-resolve the plan (dismiss-only kind).
      const restaged = await callWith('run_freeze', {});
      const fakeResolve = await callWith('resolve_review', {
        reviewItemId: restaged.data.confirmId, resolution: 'resolved',
      });
      expect(fakeResolve.isError).toBe(true);
      expect(fakeResolve.text).toContain('run_freeze');

      // Restaging superseded the FIRST token kind-wide.
      const staleConfirm = await callWith('run_freeze', { confirmId: staged.data.confirmId });
      expect(staleConfirm.isError).toBe(true);
      expect(staleConfirm.text).toContain('confirmation not found');

      // Version drift: any schedule change under the plan kills the token.
      const driftJob = await createJob({
        tenantId, customerId: casa.id, title: 'drift probe', status: 'open',
      });
      // Booked ONTO the tech: a person-less probe would join queue 2 and
      // inflate the fresh plan below — attached+placed makes it context.
      await callWith('book_visit', {
        jobId: driftJob.id, technicianRef: 'frz-tech',
        date: relDay(9), startTime: '07:00', endTime: '07:30',
      });
      const drifted = await callWith('run_freeze', { confirmId: restaged.data.confirmId });
      expect(drifted.isError).toBe(true);
      expect(drifted.text).toContain('schedule changed');
      // Consumed — a replay finds nothing.
      const replay = await callWith('run_freeze', { confirmId: restaged.data.confirmId });
      expect(replay.isError).toBe(true);
      expect(replay.text).toContain('confirmation not found');

      // ---- Fresh stage → CONFIRM: the happy path.
      const fresh = await callWith('run_freeze', {});
      expect(fresh.data.status).toBe('needs_confirmation');
      const committed = await callWith('run_freeze', { confirmId: fresh.data.confirmId });
      expect(committed.data.status).toBe('committed');
      expect(committed.data.placed).toBe(3);

      // Row read-backs: placed, UNPINNED, on the right person; ledger marked.
      const { rows: aRows } = await pg.query(
        `select a.starts_at, a.locked, t.ref from assignments a
           left join technicians t on t.id = a.technician_id
          where a.job_id = $1 and a.status = 'confirmed'`,
        [jobA.id],
      );
      expect(aRows).toHaveLength(1);
      expect(aRows[0].starts_at).not.toBeNull();
      expect(aRows[0].locked).toBe(false);
      expect(aRows[0].ref).toBe('frz-tech');
      // The exact person-less visit kept ITS OWN times, gained the person.
      const { rows: eRows } = await pg.query(
        `select a.starts_at::text, t.ref from assignments a
           left join technicians t on t.id = a.technician_id
          where a.job_id = $1 and a.status = 'confirmed'`,
        [exactJob.id],
      );
      expect(eRows).toHaveLength(1);
      expect(eRows[0].starts_at).toContain(`${relDay(2)} 10:00`);
      expect(eRows[0].ref).toBe('frz-tech');
      // The attached time-TBD visit is now placed inside its fence.
      const { rows: tRows } = await pg.query(
        `select a.starts_at, a.earliest_date from assignments a
          where a.job_id = $1 and a.status = 'confirmed'`,
        [tbdJob.id],
      );
      expect(tRows).toHaveLength(1);
      expect(tRows[0].starts_at).not.toBeNull();
      expect(tRows[0].earliest_date).toBeNull();
      // The PINNED visit is untouched: still unplaced, still pinned.
      const { rows: pRows } = await pg.query(
        `select starts_at, locked from assignments where id = $1`,
        [pinRow.data.assignmentId],
      );
      expect(pRows[0].starts_at).toBeNull();
      expect(pRows[0].locked).toBe(true);
      // Ledger: every committed row carries the freezeRun marker + reason,
      // and the run summary event exists.
      const { rows: evRows } = await pg.query(
        `select kind from schedule_events
          where tenant_id = $1 and detail->>'freezeRun' is not null
          order by id`,
        [tenantId],
      );
      const kinds = evRows.map((r: { kind: string }) => r.kind);
      expect(kinds.filter((k) => k === 'booked' || k === 'moved')).toHaveLength(3);
      expect(kinds).toContain('freeze_committed');

      // ---- Partial-failure honesty: sabotage one target between stage+confirm
      // WITHOUT bumping the schedule version (direct status flip, no event).
      const jobB = await createJob({
        tenantId, customerId: casa.id, title: 'freeze job B', status: 'open', durationMinutes: 60,
      });
      const lateJob = await createJob({
        tenantId, customerId: casa.id, title: 'freeze late', status: 'open', durationMinutes: 45,
      });
      const lateRow = await callWith('book_visit', {
        jobId: lateJob.id, technicianRef: 'frz-tech', timeTbd: true,
        earliestDate: relDay(7), latestDate: relDay(8),
      });
      // That booking bumped the version — stage AFTER it.
      const partialStage = await callWith('run_freeze', {});
      expect((partialStage.data.placements as unknown[]).length).toBe(2);
      await updateAssignmentStatus(lateRow.data.assignmentId as string, 'cancelled');
      const partial = await callWith('run_freeze', { confirmId: partialStage.data.confirmId });
      expect(partial.data.status).toBe('partial');
      expect(partial.data.placed).toBe(1);
      expect((partial.data.failed as { error: string }).error).toContain('cannot move');
      expect(partial.data.note).toContain('STOPPED');
      // jobB really landed; re-running is safe (idempotent by drained queues).
      const { rows: bRows } = await pg.query(
        `select starts_at from assignments where job_id = $1 and status = 'confirmed'`,
        [jobB.id],
      );
      expect(bRows).toHaveLength(1);

      // ---- 12h expiry: backdate the staged token 13h → confirm refuses.
      const oldStage = await callWith('run_freeze', {});
      await pg.query(
        `update review_items set detail = jsonb_set(detail, '{stagedAt}', to_jsonb($1::text))
          where id = $2`,
        [new Date(Date.now() - 13 * 3600_000).toISOString(), oldStage.data.confirmId],
      );
      const expired = await callWith('run_freeze', { confirmId: oldStage.data.confirmId });
      expect(expired.isError).toBe(true);
      expect(expired.text).toContain('expired (12 hours)');

      // ---- ONE plan per TENANT: a DIFFERENT manager's stage supersedes this
      // manager's token (kind-wide dismiss, review finding 5).
      const mgr2 = await insertTechnician({
        tenantId, ref: 'mgr-two', displayName: 'Manager Two', tier: 'manager',
      });
      await setTechnicianState(mgr2.id, 'active');
      const mineStage = await callWith('run_freeze', {});
      const { client: mgr2Client, callWith: callAsMgr2 } = await clientFor(
        { tenantId, technicianRef: 'mgr-two' },
        freezeDeps,
      );
      try {
        const theirs = await callAsMgr2('run_freeze', {});
        expect(theirs.data.status).toBe('needs_confirmation');
        const superseded = await callWith('run_freeze', { confirmId: mineStage.data.confirmId });
        expect(superseded.isError).toBe(true);
        expect(superseded.text).toContain('confirmation not found');
        // ...and either manager may confirm the ONE live plan — dismiss it
        // here so no token leaks out of the suite.
        const dismissed = await callAsMgr2('resolve_review', {
          reviewItemId: theirs.data.confirmId, resolution: 'dismissed',
        });
        expect(dismissed.isError).toBe(false);
      } finally {
        await mgr2Client.close();
      }
    } finally {
      await mgrClient.close();
    }
  });

  test('the promise belt: a plan row that would break a promise is SKIPPED at commit, never booked', async () => {
    // Unreachable via the real solver by construction (day-fenced placements
    // land inside their fence) — which is exactly why the belt needs a direct
    // unit test: a window-construction bug must not convert the manager's
    // plan-level yes into an unreviewed promise break.
    const { commitFreezePlan } = await import('../schedule/freezeCommit.js');
    const { bookVisit } = await import('../schedule/booking.js');
    const belt = await insertTechnician({
      tenantId, ref: 'belt-tech', displayName: 'Belt Bella', seatExempt: true,
    });
    expect(belt.state).toBe('active');
    const casa = await createCustomer({ tenantId, name: 'Belt Casa' });
    const promised = await bookVisit({
      tenantId, technicianRef: 'belt-tech', customerId: casa.id, title: 'promised install',
      date: relDay(4), startTime: '09:00', endTime: '10:00',
      promiseLevel: 'day', actorRef: 'mgr-test',
    });
    const result = await commitFreezePlan(
      tenantId,
      {
        horizonFrom: relDay(0),
        horizonTo: relDay(13),
        placements: [
          {
            kind: 'unplaced_visit',
            jobId: promised.job.id,
            assignmentId: promised.assignment.id,
            customer: 'Belt Casa',
            jobTitle: 'promised install',
            technicianRef: 'belt-tech',
            date: relDay(5), // ANOTHER day — breaks the day promise
            startTime: '11:00',
            endTime: '12:00',
          },
        ],
        skipped: [],
        capacity: [],
      },
      'mgr-test',
      new Date().toISOString(),
    );
    expect(result.committed).toHaveLength(0);
    expect(result.failed).toBeNull();
    expect(result.skippedAtCommit).toEqual([
      expect.objectContaining({
        ref: promised.assignment.id,
        reason: expect.stringContaining('break what the customer was told'),
      }),
    ]);
    // The row is genuinely untouched.
    const { rows } = await pg.query(
      `select starts_at::text, status from assignments where id = $1`,
      [promised.assignment.id],
    );
    expect(rows[0].status).toBe('confirmed');
    expect(rows[0].starts_at).toContain(`${relDay(4)} 09:00`);
  });

  test('stage result carries proposalLink + fused boardNote; the stage note SURVIVES; other staged tools stay undecorated', { timeout: 30_000 }, async () => {
    // Asserted WITH the handle set (plan review finding 1): unset ⇒ no
    // decoration ⇒ a `note`-clobbering attachment would ship invisibly.
    const prev = process.env.BOARD_BOT_HANDLE;
    const { client: mgrClient, callWith } = await clientFor(
      { tenantId, technicianRef: 'mgr-test' },
      freezeDeps,
    );
    try {
      process.env.BOARD_BOT_HANDLE = 'DashboardMan_bot';
      const staged = await callWith('run_freeze', {});
      expect(staged.isError).toBe(false);
      expect(staged.data.status).toBe('needs_confirmation');
      // The ONE seam exception: the proposal view shows the staged plan, so
      // the "board would show the OLD schedule" premise inverts here alone.
      expect(staged.data.proposalLink).toBe('https://t.me/DashboardMan_bot?startapp=freeze');
      expect(staged.data.boardNote).toBe(
        'ALWAYS end this reply with the exact line: ' +
          '[Review the full proposal on the board](https://t.me/DashboardMan_bot?startapp=freeze)',
      );
      expect(staged.data.boardLink).toBeUndefined(); // committed-result field only
      // The clobber guard: the stage instruction must survive the decoration.
      expect(staged.data.note).toContain('NOTHING is booked yet');

      // A DIFFERENT staged tool keeps the exclusion — no board fields at all.
      const cust = await createCustomer({ tenantId, name: 'Seam Probe Cust' });
      const job = await createJob({
        tenantId, customerId: cust.id, title: 'seam probe', status: 'open',
      });
      const otherStage = await callWith('book_visit', {
        jobId: job.id, date: relDay(9), startTime: '09:00', endTime: '10:00',
        technicianRef: 'frz-tech', promiseLevel: 'day',
      });
      expect(otherStage.data.status).toBe('needs_confirmation');
      expect(otherStage.data.boardLink).toBeUndefined();
      expect(otherStage.data.proposalLink).toBeUndefined();
      expect(otherStage.data.boardNote).toBeUndefined();

      // Handle unset ⇒ the stage result carries NO proposal fields either.
      delete process.env.BOARD_BOT_HANDLE;
      const bare = await callWith('run_freeze', {});
      expect(bare.data.status).toBe('needs_confirmation');
      expect(bare.data.proposalLink).toBeUndefined();
      expect(bare.data.boardNote).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.BOARD_BOT_HANDLE;
      else process.env.BOARD_BOT_HANDLE = prev;
      await mgrClient.close();
    }
  });
});

describe('move_visit unassign + time_only (plan 4a.5)', () => {
  test('one-shot park, staged-confirm park (the preview==commit path), time_only record', { timeout: 30_000 }, async () => {
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
        assignmentId: 'x',
        date: '2027-07-05',
        startTime: '09:00',
        reason: 'r',
        unassign: 'yes',
      });
      expect(badFlag.isError).toBe(true);
      expect(badFlag.text).toContain('unassign must be a boolean');

      // Unpromised park: ONE call, technician gone, row visible as unassigned.
      const booked = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'park-probe-tech',
        date: '2027-07-05', // a Monday, clear of other fixtures
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(booked.data.status).toBe('booked');
      const parked = await callWith('move_visit', {
        assignmentId: booked.data.assignmentId,
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
        'select technician_id from assignments where id = $1',
        [parked.data.assignmentId],
      );
      expect(parkedRow.rows[0].technician_id).toBeNull();

      // Both steering args at once → the shared verb refuses.
      const both = await callWith('move_visit', {
        assignmentId: parked.data.assignmentId,
        date: '2027-07-05',
        startTime: '09:00',
        technicianRef: 'park-probe-tech',
        unassign: true,
        reason: 'contradiction',
      });
      expect(both.isError).toBe(true);
      expect(both.text).toContain('not both');

      // STAGED-CONFIRM PARK (plan review finding #1): a promise-breaking
      // cross-day park must stage, and the CONFIRM must still detach —
      // dropping unassign from the staged detail would commit a plain move
      // that keeps the technician (preview ≠ commit on the one gated path).
      const promised = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'park-probe-tech',
        date: '2027-07-06',
        startTime: '09:00',
        endTime: '10:00',
        promiseLevel: 'day',
      });
      const stagedPromised = await callWith('book_visit', { confirmId: promised.data.confirmId });
      expect(stagedPromised.data.status).toBe('booked');
      const parkStage = await callWith('move_visit', {
        assignmentId: stagedPromised.data.assignmentId,
        date: '2027-07-07', // day change on a day-promise → break → stage
        startTime: '09:00',
        unassign: true,
        reason: 'park it for the reflow',
      });
      expect(parkStage.data.status).toBe('needs_confirmation');
      expect(parkStage.data.preview.unassign).toBe(true);
      expect(parkStage.data.preview.promiseLevel).toBe('day');
      const parkConfirmed = await callWith('move_visit', { confirmId: parkStage.data.confirmId });
      expect(parkConfirmed.isError).toBe(false);
      expect(parkConfirmed.data.status).toBe('moved');
      expect(parkConfirmed.data.unassigned).toBe(true);
      const confirmedRow = await pg.query(
        'select technician_id, promise_level, promised_day::text as promised_day from assignments where id = $1',
        [parkConfirmed.data.assignmentId],
      );
      expect(confirmedRow.rows[0].technician_id).toBeNull();
      expect(confirmedRow.rows[0].promise_level).toBe('day');
      expect(confirmedRow.rows[0].promised_day).toBe('2027-07-07');

      // time_only end to end: set_promise stores it with NO promised day; a
      // day move stays one-shot; a time change stages.
      const nineAm = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'park-probe-tech',
        date: '2027-07-08',
        startTime: '09:00',
        endTime: '10:00',
      });
      const toTimeOnly = await callWith('set_promise', {
        assignmentId: nineAm.data.assignmentId,
        promiseLevel: 'time_only',
      });
      expect(toTimeOnly.isError).toBe(false);
      expect(toTimeOnly.data.changes.promiseLevel).toEqual({ from: 'none', to: 'time_only' });
      expect(toTimeOnly.data.changes.promisedDay).toEqual({ from: null, to: null });
      expect(toTimeOnly.data.note).toContain('START TIME');
      expect(toTimeOnly.data.note).toContain('day may still move freely');
      const dayMove = await callWith('move_visit', {
        assignmentId: nineAm.data.assignmentId,
        date: '2027-07-09',
        startTime: '09:00',
        reason: 'day shuffle under a time_only promise',
      });
      expect(dayMove.isError).toBe(false);
      expect(dayMove.data.status).toBe('moved'); // one-shot — the day was never promised
      const timeMove = await callWith('move_visit', {
        assignmentId: dayMove.data.assignmentId,
        date: '2027-07-09',
        startTime: '13:00',
        reason: 'time shift under a time_only promise',
      });
      expect(timeMove.data.status).toBe('needs_confirmation');
      expect(timeMove.data.preview.promiseLevel).toBe('time_only');
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
      const before = await callWith('get_team_schedule', { unassignedOnly: true });
      expect(
        (before.data.unscheduledJobs as Array<{ jobId: string }>).map((j) => j.jobId),
      ).toContain(bare.id);

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
      const recall = await callWith('get_team_schedule', { unassignedOnly: true });
      expect(
        (recall.data.unscheduledJobs as Array<{ jobId: string }>).map((j) => j.jobId),
      ).not.toContain(bare.id);

      // A used token cannot commit twice.
      const replay = await callWith('cancel_job', { confirmId: stage2.data.confirmId });
      expect(replay.isError).toBe(true);
    } finally {
      await mgrClient.close();
    }
  });

  test('cascade through the tool: promised visit disclosed in the preview, then dies', { timeout: 30_000 }, async () => {
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
      expect(booked.data.status).toBe('booked'); // unassigned + unpromised → one-shot
      const jobId = booked.data.jobId as string;
      await callWith('set_promise', {
        assignmentId: booked.data.assignmentId,
        promiseLevel: 'day',
      });

      const stage = await callWith('cancel_job', { jobId, reason: 'customer called it off' });
      const preview = stage.data.preview as {
        visits: Array<{ assignmentId: string; promiseLevel: string; day: string }>;
      };
      // The stake is stated: the promised visit rides the preview.
      expect(preview.visits).toHaveLength(1);
      expect(preview.visits[0]).toMatchObject({
        assignmentId: booked.data.assignmentId,
        promiseLevel: 'day',
        day: '2027-02-01',
      });

      const confirmed = await callWith('cancel_job', { confirmId: stage.data.confirmId });
      expect(confirmed.isError).toBe(false);
      expect(confirmed.data.visitsCancelled).toEqual([
        { assignmentId: booked.data.assignmentId, day: '2027-02-01' },
      ]);
      // Off the board.
      const day = await callWith('get_team_schedule', { from: '2027-02-01', to: '2027-02-01' });
      expect(day.data.days).toHaveLength(0);
      // Terminal: a second cancel_job on the same job refuses with the truth.
      const again = await callWith('cancel_job', { jobId, reason: 'again' });
      expect(again.isError).toBe(true);
      expect(again.text).toContain('it already is');
    } finally {
      await mgrClient.close();
    }
  });
});
