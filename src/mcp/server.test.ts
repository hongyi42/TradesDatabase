import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client as PgClient } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getClient } from '../db/client.js';
import { appendRawCapture } from '../db/rawCaptures.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { createAssignment } from '../db/assignments.js';
import { createVisit } from '../db/visits.js';
import { insertTechnician, setTechnicianState, updateTechnician } from '../db/technicians.js';
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
    'truncate table schedule_entries, customers, jobs, visits, raw_captures, technicians, review_items, web_requests, schedule_events cascade',
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
  test('lists the technician tool surface (exactly 13 tools)', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'record_field_note',
        'find_customer',
        'get_customer_context',
        'get_job',
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
    expect(names).toHaveLength(13);
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

      // Add: mints the slug ref, lands as invited technician.
      const added = await callWith('add_technician_seat', { displayName: 'Bob Marley' });
      expect(added.isError).toBe(false);
      expect(added.data).toMatchObject({ ref: 'bob-marley', tier: 'technician', state: 'invited' });

      // Duplicate display name WITH a seat still free → the 23505 disambiguation
      // error (at cap the trigger would report the cap instead — Phase 1 probe).
      const dup = await callWith('add_technician_seat', { displayName: 'Bob Marley' });
      expect(dup.isError).toBe(true);
      expect(dup.text).toContain("ref 'bob-marley' is taken");

      // Fill the last seat, then exceed: the purchase error, verbatim tier name.
      const carlEarly = await callWith('add_technician_seat', { displayName: 'Carl Sagan' });
      expect(carlEarly.isError).toBe(false); // seat 3/3
      const capped = await callWith('add_technician_seat', { displayName: 'Dan Dare' });
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
      expect(confirmed.data).toEqual({ status: 'deactivated', ref: 'bob-marley' });
      const state = await pg.query<{ state: string }>(
        "select state from technicians where tenant_id = $1 and ref = 'bob-marley'",
        [tenantId],
      );
      expect(state.rows[0].state).toBe('offboarding'); // cross-channel read-back

      // Repeat deactivation is idempotent, not an error.
      const repeat = await callWith('deactivate_technician_seat', { ref: 'bob-marley' });
      expect(repeat.data).toEqual({ status: 'already_deactivated', ref: 'bob-marley' });

      // The freed seat is immediately usable — the earlier capped add now works.
      const dan = await callWith('add_technician_seat', { displayName: 'Dan Dare' });
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
      // The full manager surface: every base spine tool + the 8 seat/lifecycle
      // tools — the count the runbook/Box_Setup_Stuff verification steps cite.
      const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
      expect(mgrTools).toContain('reactivate_technician_seat');
      expect(mgrTools).toContain('bind_telegram');
      expect(mgrTools).toContain('web_search');
      expect(mgrTools).toContain('read_webpage');
      expect(mgrTools).toHaveLength(25);

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
      await callWith('add_technician_seat', { displayName: 'Cap Filler Five' });
      await callWith('add_technician_seat', { displayName: 'Cap Filler Six' });
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
      // Technician surface count including send_email: exactly 13.
      const tools = (await techClient.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('send_email');
      expect(tools).toHaveLength(13);

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
        expect(mgrTools).toHaveLength(25);
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
  // Deterministic fixtures, far from other suites' dates; identity tech-mcp.
  const G1 = '2026-09-14'; // Monday
  const G2 = '2026-09-15';
  const stubOptimize: ServerDeps['optimizeStopOrder'] = async (stops) => ({
    order: stops.map((_, i) => stops.length - 1 - i), // reverse, so reordering is observable
    legMinutes: [7, 8],
    totalMinutes: 15,
  });

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
      await createAssignment({
        tenantId,
        jobId: job.id,
        technicianId: techMcpId,
        startsAt: startISO,
        endsAt: new Date(Date.parse(startISO) + 60 * 60_000).toISOString(),
        status: 'confirmed',
      });
    };
    await mk('g1-a', `${G1}T15:00:00.000Z`);
    await mk('g1-b', `${G1}T17:00:00.000Z`);
    await mk('g2-a', `${G2}T16:00:00.000Z`);
    await mk('g2-noaddr', `${G2}T18:00:00.000Z`, false);
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

  test('zero-stop range → explicit empty days', async () => {
    const { client: c, callWith } = await scheduleClient();
    try {
      const r = await callWith('get_schedule', { from: '2027-01-04', to: '2027-01-05' });
      expect(r.data).toMatchObject({ status: 'ok', days: [] });
    } finally {
      await c.close();
    }
  });

  test('roster-less badge → empty days, no crash', async () => {
    // A valid badge with NO roster row keeps the plain-technician surface;
    // its schedule is simply empty (daySource returns []).
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'badge-no-roster-row' },
      { optimizeStopOrder: stubOptimize },
    );
    try {
      const r = await callWith('get_schedule', { from: G1, to: G2 });
      expect(r.isError).toBe(false);
      expect(r.data).toMatchObject({ status: 'ok', days: [] });
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

describe('scheduling tools (book/move/cancel_visit + get_team_schedule)', () => {
  test('technician badge is denied all four tools', async () => {
    for (const name of ['get_team_schedule', 'book_visit', 'move_visit', 'cancel_visit']) {
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
        locked: true,
      });
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
      const cancelStage = await callWith('cancel_visit', {
        assignmentId: movedId,
        reason: 'testing the refusal',
      });
      expect(cancelStage.data.status).toBe('needs_confirmation');
      const refused = await callWith('resolve_review', {
        reviewItemId: cancelStage.data.confirmId,
        resolution: 'resolved',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toContain('cancel_visit');
      const dismissed = await callWith('resolve_review', {
        reviewItemId: cancelStage.data.confirmId,
        resolution: 'dismissed',
      });
      expect(dismissed.isError).toBe(false);
      const deadConfirm = await callWith('cancel_visit', { confirmId: cancelStage.data.confirmId });
      expect(deadConfirm.isError).toBe(true);
      expect(deadConfirm.text).toContain('confirmation not found');

      // CANCEL for real: restage (fresh preview) then confirm.
      const cancelStage2 = await callWith('cancel_visit', {
        assignmentId: movedId,
        reason: 'customer cancelled',
      });
      expect(cancelStage2.data.preview).toMatchObject({ customerName: 'Sched Henderson' });
      const cancelled = await callWith('cancel_visit', { confirmId: cancelStage2.data.confirmId });
      expect(cancelled.data.status).toBe('cancelled');
      // The cancelled visit no longer appears on the board.
      const gone = await callWith('get_team_schedule', { from: '2026-12-02', to: '2026-12-02' });
      expect(gone.data.days).toHaveLength(0);
    } finally {
      await mgrClient.close();
    }
  });

  test('a booking with NO stated promise records none/null and a later move claims no broken promise', async () => {
    // The pilot bug: booking silently recorded "customer told this day", so a
    // later move nagged about a promise nobody made. Default is now 'none'.
    const customer = await createCustomer({ tenantId, name: 'Unpromised Uma' });
    const { client: mgrClient, callWith } = await clientFor({ tenantId, technicianRef: 'mgr-test' });
    try {
      const staged = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-15',
        startTime: '09:00',
        endTime: '10:00',
      });
      expect(staged.data.preview.promiseLevel).toBe('none'); // nothing was stated → nothing promised
      const booked = await callWith('book_visit', { confirmId: staged.data.confirmId });
      expect(booked.data.promiseLevel).toBe('none');
      const id = booked.data.assignmentId as string;

      const team = await callWith('get_team_schedule', { from: '2026-12-15', to: '2026-12-15' });
      const stop = (team.data.days[0].stops as Array<Record<string, unknown>>).find(
        (s) => s.assignmentId === id,
      );
      expect(stop).toMatchObject({ promiseLevel: 'none', promisedDay: null });

      // Moving it to another day must NOT claim a broken promise.
      const moveStage = await callWith('move_visit', {
        assignmentId: id,
        date: '2026-12-16',
        startTime: '09:00',
        reason: 'internal reshuffle',
      });
      expect(moveStage.data.preview.promiseBroken).toBe(false);
      expect(moveStage.data.note ?? '').not.toContain('promiseBroken is TRUE');
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
      });
      expect(unknown.isError).toBe(true);
      expect(unknown.text).toContain("'ghost-tech' not found");

      const first = await callWith('book_visit', {
        customerId: customer.id,
        technicianRef: 'tech-mcp',
        date: '2026-12-09',
        startTime: '09:00',
        endTime: '11:00',
      });
      await callWith('book_visit', { confirmId: first.data.confirmId });
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
