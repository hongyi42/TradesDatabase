import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client as PgClient } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getClient } from '../db/client.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { upsertScheduleEntry } from '../db/scheduleEntries.js';
import { insertTechnician, setTechnicianState, updateTechnician } from '../db/technicians.js';
import { createTenant, setTenantSeats } from '../db/tenants.js';
import { upsertOpenReviewItem } from '../db/reviewItems.js';
import { createServer, type ServerDeps } from './server.js';

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
    'truncate table schedule_entries, customers, jobs, visits, raw_captures, technicians, review_items cascade',
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
  test('lists the technician tool surface', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'record_field_note',
        'find_customer',
        'get_customer_context',
        'get_job',
        'list_recent_captures',
        'brief_customer',
        'answer_customer_question',
      ]),
    );
  });

  test('record_field_note returns needs_confirmation, then resolves on resume', async () => {
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

    const first = await call('record_field_note', {
      text: 'all wrapped up',
      channel: 'technician_voice',
    });
    expect(first.isError).toBe(false);
    expect(first.data.status).toBe('needs_confirmation');
    expect(first.data.suggestion.address).toBe('12 MCP St');

    const resumed = await call('record_field_note', {
      captureId: first.data.captureId,
      confirmed: { address: '12 MCP St' },
    });
    expect(resumed.data.status).toBe('matched');
    expect(resumed.data.customerId).toBeDefined();

    // Cross-channel read-back: the L1 capture exists with the voice channel.
    const cap = await pg.query<{ channel: string }>(
      'select channel from raw_captures where id = $1',
      [first.data.captureId],
    );
    expect(cap.rows[0].channel).toBe('technician_voice');

    // Identity, not call args, is the source of technicianRef: the visit's
    // technician_name comes from the injected identity ('tech-mcp'), even though
    // no technicianRef was passed in the tool call.
    const vis = await pg.query<{ technician_name: string }>(
      'select technician_name from visits where id = $1',
      [resumed.data.visitId],
    );
    expect(vis.rows[0].technician_name).toBe('tech-mcp');
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
      // The full manager surface is now 14 tools (7 spine + 7 seat/lifecycle) —
      // the count the runbook/Box Setup Stuff verification steps cite.
      const mgrTools = (await mgrClient.listTools()).tools.map((t) => t.name);
      expect(mgrTools).toContain('reactivate_technician_seat');
      expect(mgrTools).toHaveLength(14);

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
