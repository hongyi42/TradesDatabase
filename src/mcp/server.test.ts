import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client as PgClient } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getClient } from '../db/client.js';
import { appendRawCapture } from '../db/rawCaptures.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { upsertScheduleEntry } from '../db/scheduleEntries.js';
import { insertTechnician, setTechnicianState, updateTechnician } from '../db/technicians.js';
import { createHost } from '../db/hosts.js';
import { completeSandboxRecycle, registerSandbox } from '../db/sandboxPool.js';
import { createTenant, setTenantSeats } from '../db/tenants.js';
import { upsertOpenReviewItem } from '../db/reviewItems.js';
import { logWebRequests } from '../db/webRequests.js';
import { createServer, type ServerDeps } from './server.js';
import { localDateISO } from '../schedule/availability.js';

// Drive the MCP server over the SDK's in-memory transport (no network/stdio).
// The extractor is stubbed so record_field_note never calls the live model.
const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
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
    'truncate table schedule_entries, customers, jobs, visits, raw_captures, technicians, review_items, web_requests cascade',
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
  test('lists the technician tool surface (exactly 12 tools)', async () => {
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
        'get_schedule',
      ]),
    );
    expect(names).toHaveLength(12);
  });

  test('record_field_note stages (NO L1), resolves identity, and records only on the final confirm', async () => {
    const tech = 'tech-mcp';
    const day = new Date().toISOString().slice(0, 10);
    await upsertScheduleEntry({
      tenantId,
      technicianRef: tech,
      externalRowKey: 'mcp-1',
      customerName: 'MCP Cust',
      addressLine1: '12 MCP St',
      scheduledStart: `${day}T12:00:00.000Z`,
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

    // Identity resume: sheet prefill becomes the previewed create-new customer.
    const resumed = await call('record_field_note', {
      confirmId: first.data.confirmId,
      confirmed: { address: '12 MCP St' },
    });
    expect(resumed.data.status).toBe('needs_confirmation');
    expect(resumed.data.preview.customerName).toBe('MCP Cust');
    expect(resumed.data.preview.newCustomer).toBe(true);
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
      expect(mgrTools).toHaveLength(20);

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
      // Technician surface count including send_email: exactly 12.
      const tools = (await techClient.listTools()).tools.map((t) => t.name);
      expect(tools).toContain('send_email');
      expect(tools).toHaveLength(12);

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
      // dismiss (= cancel) is allowed. Manager surface counts exactly 20.
      const { client: mgrClient, callWith: mgrCall } = await clientFor(
        { tenantId, technicianRef: 'mgr-test' },
        stubs,
      );
      try {
        const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
        expect(mgrTools).toHaveLength(20);
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
    const mk = (key: string, over: Record<string, unknown>) =>
      upsertScheduleEntry({
        tenantId,
        technicianRef: 'tech-mcp',
        externalRowKey: key,
        customerName: `G ${key}`,
        addressLine1: `${key} Rd`,
        city: 'Fresno',
        state: 'CA',
        postalCode: '93701',
        source: 'test',
        ...over,
      });
    await mk('g1-a', { scheduledStart: `${G1}T15:00:00.000Z` });
    await mk('g1-b', { scheduledStart: `${G1}T17:00:00.000Z` });
    await mk('g2-a', { scheduledStart: `${G2}T16:00:00.000Z` });
    await mk('g2-noaddr', { scheduledStart: `${G2}T18:00:00.000Z`, addressLine1: null });
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

  test('assignments-mode roster-less badge → empty days, no crash', async () => {
    // A valid badge with NO roster row keeps the plain-technician surface;
    // in assignments mode its schedule is simply empty (daySource returns []).
    const { client: c, callWith } = await clientFor(
      { tenantId, technicianRef: 'badge-no-roster-row' },
      { optimizeStopOrder: stubOptimize },
    );
    process.env.ROUTE_DAY_SOURCE = 'assignments';
    try {
      const r = await callWith('get_schedule', { from: G1, to: G2 });
      expect(r.isError).toBe(false);
      expect(r.data).toMatchObject({ status: 'ok', days: [] });
    } finally {
      delete process.env.ROUTE_DAY_SOURCE;
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
