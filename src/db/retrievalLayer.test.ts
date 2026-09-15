import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer, insertCustomerCapture, setCustomerAttribute } from './customers.js';
import { createJob, insertJobCapture } from './jobs.js';
import { createTenant } from './tenants.js';
import { createVisit, insertVisitNote } from './visits.js';
import { appendRawCapture, type RawCapture } from './rawCaptures.js';

// The retrieval layer's core (migration 20260916120000_retrieval_layer_core.sql),
// driven through the RPCs exactly as src/db/context.ts calls them. What these
// pin is the set of rules the layer owns once: membership over all six
// attachment kinds, the retraction fold, the tier gate, tenant re-checks on
// id-only foreign keys, a total paging order, and search inside a scope.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
// The second firm the leak test creates. Its L1 row pins it until the truncate
// below runs, so it is deleted AFTER that (the house pattern: spineViews.test.ts).
let otherTenantId: string | null = null;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .order('created_at', { ascending: true })
    .limit(1)
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  // L1 is append-only by trigger — DELETE is refused, so the house pattern is TRUNCATE.
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
  if (otherTenantId) await pg.query('delete from tenants where id = $1', [otherTenantId]);
  await pg.end();
});

// ---- the shapes the functions return (narrowed by hand, like the readers) ----
interface Snip {
  id: string;
  snippet: string;
  truncated: boolean;
}
interface JobBlock {
  job: { id: string; title: string | null };
  note_count: number;
  restricted_count: number;
  newest: Snip | null;
  last_visit_at: string | null;
  retracted_count: number;
  money_events: unknown[];
}
interface Contents {
  customer: { id: string };
  jobs_total: number;
  older_jobs: number;
  jobs: JobBlock[];
  customer_level: { note_count: number; restricted_count: number; newest: Snip | null };
  retracted_evidence_ids: string[];
}
interface PageRow {
  id: string;
  via: string[];
  text: string;
  text_truncated: boolean;
  retracts_capture_id: string | null;
  retracted: { id: string; reason: string | null } | null;
}
interface Page {
  scope_found: boolean;
  captures: PageRow[];
  has_more: boolean;
  next_before_at: string | null;
  next_before_id: string | null;
  total_visible: number;
  restricted_count: number;
}
interface Search {
  scope_found: boolean;
  matches: { id: string; snippet: string }[];
  count: number;
  more: boolean;
  note?: string;
}

const contents = async (customerId: string, tier: string, tenant = tenantId): Promise<Contents | null> => {
  const { data, error } = await getClient().rpc('customer_contents', {
    p_tenant: tenant,
    p_customer: customerId,
    p_caller_tier: tier,
  });
  if (error) throw new Error(error.message);
  return data as unknown as Contents | null;
};

const page = async (
  scope: 'job' | 'customer' | 'customer_level',
  scopeId: string,
  tier: string,
  opts: { beforeAt?: string; beforeId?: string; limit?: number; includeRetracted?: boolean } = {},
): Promise<Page> => {
  const { data, error } = await getClient().rpc('captures_page', {
    p_tenant: tenantId,
    p_scope: scope,
    p_scope_id: scopeId,
    p_caller_tier: tier,
    ...(opts.beforeAt ? { p_before_at: opts.beforeAt } : {}),
    ...(opts.beforeId ? { p_before_id: opts.beforeId } : {}),
    ...(opts.limit ? { p_limit: opts.limit } : {}),
    ...(opts.includeRetracted ? { p_include_retracted: true } : {}),
  });
  if (error) throw new Error(error.message);
  return data as unknown as Page;
};

const full = async (captureId: string, tier: string, includeRetracted = false) => {
  const { data, error } = await getClient().rpc('capture_full', {
    p_tenant: tenantId,
    p_capture: captureId,
    p_caller_tier: tier,
    p_include_retracted: includeRetracted,
  });
  if (error) throw new Error(error.message);
  return data as unknown as { id: string; raw_text: string | null; memberships: { via: string }[] } | null;
};

const search = async (scope: 'job' | 'customer', scopeId: string, q: string, tier: string): Promise<Search> => {
  const { data, error } = await getClient().rpc('search_captures', {
    p_tenant: tenantId,
    p_scope: scope,
    p_scope_id: scopeId,
    p_query: q,
    p_caller_tier: tier,
  });
  if (error) throw new Error(error.message);
  return data as unknown as Search;
};

// An UNSTAMPED technician note: no customer_id/job_id, the inbound/tech-note
// shape where identity resolves after the immutable L1 append.
const techNote = (text: string, over: Partial<Parameters<typeof appendRawCapture>[0]> = {}) =>
  appendRawCapture({ tenantId, channel: 'technician_note', technicianRef: 'tech-layer', rawText: text, ...over });

const retract = (target: RawCapture) =>
  appendRawCapture({
    tenantId,
    channel: 'retraction',
    technicianRef: 'tech-layer',
    rawText: 'recorded in error',
    retractsCaptureId: target.id,
  });

describe('capture_membership — every attachment kind reaches the record', () => {
  test('a note linked ONLY via visit_notes and one ONLY via job_captures are listed and counted', async () => {
    const customer = await createCustomer({ tenantId, name: 'Six Ways Sue' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Boiler' });
    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: '2026-08-16T13:00:00.000Z',
    });
    // Attached to an already-booked trip: no source_capture_id anywhere, only the link.
    const onTrip = await techNote('pilot light relit, left running');
    await insertVisitNote({ tenantId, visitId: visit.id, captureId: onTrip.id });
    // Landed on the job with no trip: the rung-10 link-less shape.
    const onJob = await techNote('customer asked for the invoice by email');
    await insertJobCapture({ tenantId, jobId: job.id, captureId: onJob.id });

    const p = await page('job', job.id, 'manager');
    const byId = new Map(p.captures.map((c) => [c.id, c]));
    expect(byId.get(onTrip.id)?.via).toEqual(['visit_note']);
    expect(byId.get(onJob.id)?.via).toEqual(['job_link']);

    const c = await contents(customer.id, 'manager');
    const block = c!.jobs.find((j) => j.job.id === job.id)!;
    expect(block.note_count).toBe(2);
    expect(block.last_visit_at).not.toBeNull();
    // The newest is the newest by (captured_at, id) — onJob was appended second.
    expect(block.newest?.id).toBe(onJob.id);
  });

  test('the customer-level pile is what has no job on ANY arm, and every kind is in the customer scope', async () => {
    const customer = await createCustomer({ tenantId, name: 'Pile Pat' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Tap' });
    const noJob = await techNote('is someone still coming out?');
    await insertCustomerCapture({ tenantId, customerId: customer.id, captureId: noJob.id });
    // Linked at customer level AND on a job → not customer-level.
    const both = await techNote('re: the tap — Tuesday works');
    await insertCustomerCapture({ tenantId, customerId: customer.id, captureId: both.id });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: both.id });

    const lvl = await page('customer_level', customer.id, 'manager');
    expect(lvl.captures.map((c) => c.id)).toEqual([noJob.id]);
    const all = await page('customer', customer.id, 'manager');
    expect(new Set(all.captures.map((c) => c.id))).toEqual(new Set([noJob.id, both.id]));
    const c = await contents(customer.id, 'manager');
    expect(c!.customer_level.note_count).toBe(1);
    expect(c!.customer_level.newest?.id).toBe(noJob.id);
  });
});

describe('the retraction fold — removed everywhere, labelled on the audit path', () => {
  test('a retracted capture leaves all four reads and comes back labelled with p_include_retracted', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fold Fran' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Fold job' });
    const good = await techNote('good note', { jobId: job.id });
    const bad = await techNote('bad note — wrong customer', { jobId: job.id });
    const retraction = await retract(bad);

    const p = await page('job', job.id, 'manager');
    expect(p.captures.map((c) => c.id)).toEqual([good.id]);
    expect(p.total_visible).toBe(1);
    expect((await contents(customer.id, 'manager'))!.jobs[0].note_count).toBe(1);
    // The retraction is visible to a manager AS A COUNT (the key to the audit
    // trail), and to a technician not at all.
    expect((await contents(customer.id, 'manager'))!.jobs[0].retracted_count).toBe(1);
    expect((await contents(customer.id, 'technician'))!.jobs[0].retracted_count).toBe(0);
    expect(await full(bad.id, 'manager')).toBeNull();
    expect((await search('job', job.id, 'bad', 'manager')).matches).toEqual([]);

    const trail = await page('job', job.id, 'manager', { includeRetracted: true });
    const badRow = trail.captures.find((c) => c.id === bad.id)!;
    expect(badRow.retracted).toMatchObject({ id: retraction.id, reason: 'recorded in error' });
    // The retraction row itself is an ordinary row in the trail (it carries the job stamp).
    const retractionOnJob = await appendRawCapture({
      tenantId,
      channel: 'retraction',
      technicianRef: 'tech-layer',
      rawText: 'also in error',
      retractsCaptureId: good.id,
      jobId: job.id,
    });
    const trail2 = await page('job', job.id, 'manager', { includeRetracted: true });
    const asRow = trail2.captures.find((c) => c.id === retractionOnJob.id)!;
    expect(asRow.retracts_capture_id).toBe(good.id);
    expect((await full(bad.id, 'manager', true))?.raw_text).toBe('bad note — wrong customer');
  });

  test('retracted_evidence_ids names a standing fact whose evidence was retracted', async () => {
    const customer = await createCustomer({ tenantId, name: 'Evidence Eve' });
    const evidence = await techNote('gate code is 4321', { customerId: customer.id });
    await setCustomerAttribute(customer.id, 'gate_code', {
      value: '4321',
      sourceCaptureId: evidence.id,
      recordedAt: '2026-09-01T00:00:00.000Z',
    });
    expect((await contents(customer.id, 'manager'))!.retracted_evidence_ids).toEqual([]);
    await retract(evidence);
    expect((await contents(customer.id, 'manager'))!.retracted_evidence_ids).toEqual([evidence.id]);
  });
});

describe('the tier gate — option A, by channel; unknown tiers see nothing', () => {
  test('a phone call is restricted for a technician, visible for a manager and the planner', async () => {
    const customer = await createCustomer({ tenantId, name: 'Tier Tom' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Furnace' });
    const call = await appendRawCapture({
      tenantId,
      channel: 'phone_call',
      rawText: 'quote was $1,850 for the furnace',
      jobId: job.id,
    });
    const note = await techNote('furnace igniter replaced', { jobId: job.id });

    const tech = await page('job', job.id, 'technician');
    expect(tech.captures.map((c) => c.id)).toEqual([note.id]);
    expect(tech.restricted_count).toBe(1);
    expect(await full(call.id, 'technician')).toBeNull();
    expect((await search('job', job.id, 'quote', 'technician')).matches).toEqual([]);
    const techContents = (await contents(customer.id, 'technician'))!.jobs[0];
    expect(techContents.note_count).toBe(1);
    expect(techContents.restricted_count).toBe(1);

    for (const tier of ['manager', 'planner']) {
      const p = await page('job', job.id, tier);
      expect(new Set(p.captures.map((c) => c.id))).toEqual(new Set([call.id, note.id]));
      expect(p.restricted_count).toBe(0);
    }
    // Fail closed: a tier the predicate does not know is not a manager.
    const unknown = await page('job', job.id, 'owner');
    expect(unknown.captures).toEqual([]);
    expect(unknown.restricted_count).toBe(2);
    expect((await contents(customer.id, 'owner'))!.jobs[0].note_count).toBe(0);
  });
});

describe('tenant re-checks on id-only foreign keys', () => {
  test("a link carrying ANOTHER firm's tenant never reaches this customer's reads", async () => {
    const customer = await createCustomer({ tenantId, name: 'Guarded Gina' });
    const other = await createTenant(`layer-guard-${Date.now()}`);
    otherTenantId = other.id;
    const theirs = await appendRawCapture({
      tenantId: other.id,
      channel: 'email',
      rawText: "another firm's words entirely",
    });
    // Nothing in the schema stops a link naming THIS customer under ANOTHER tenant.
    await pg.query(
      'insert into customer_captures (tenant_id, customer_id, capture_id) values ($1, $2, $3)',
      [other.id, customer.id, theirs.id],
    );
    expect((await page('customer', customer.id, 'manager')).captures).toEqual([]);
    expect((await contents(customer.id, 'manager'))!.customer_level.note_count).toBe(0);
    // A cross-tenant scope id reads as an unknown scope, not as their captures.
    expect((await contents(customer.id, 'manager', other.id))).toBeNull();
    await pg.query('delete from customer_captures where capture_id = $1', [theirs.id]);
  });
});

describe('paging and search', () => {
  test('keyset paging over 25 captures yields 20 + 5 with no repeat or gap', async () => {
    const customer = await createCustomer({ tenantId, name: 'Pager Pam' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Long job' });
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push((await techNote(`note ${i}`, { jobId: job.id })).id);

    const first = await page('job', job.id, 'manager');
    expect(first.captures).toHaveLength(20);
    expect(first.has_more).toBe(true);
    expect(first.total_visible).toBe(25);
    const second = await page('job', job.id, 'manager', {
      beforeAt: first.next_before_at!,
      beforeId: first.next_before_id!,
    });
    expect(second.captures).toHaveLength(5);
    expect(second.has_more).toBe(false);
    const seen = [...first.captures, ...second.captures].map((c) => c.id);
    expect(new Set(seen).size).toBe(25);
    expect(new Set(seen)).toEqual(new Set(ids));
    // Newest first, and the text is cut at the page's limit with the flag set.
    expect(first.captures[0].id).toBe(ids[24]);
    const longNote = await techNote('x'.repeat(700), { jobId: job.id });
    const withLong = await page('job', job.id, 'manager', { limit: 1 });
    expect(withLong.captures[0].id).toBe(longNote.id);
    expect(withLong.captures[0].text).toHaveLength(600);
    expect(withLong.captures[0].text_truncated).toBe(true);
  });

  test('search finds a word form and a bare code, inside the scope only', async () => {
    const customer = await createCustomer({ tenantId, name: 'Search Sal' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'AC' });
    const otherJob = await createJob({ tenantId, customerId: customer.id, title: 'Other' });
    const cap = await techNote('Capacitors failing, recommend replacement soon', { jobId: job.id });
    const code = await techNote('lockbox 4321 by the side gate', { jobId: job.id });
    await techNote('capacitor on the OTHER job', { jobId: otherJob.id });

    const word = await search('job', job.id, 'capacitor', 'manager');
    expect(word.matches.map((m) => m.id)).toEqual([cap.id]);
    expect(word.matches[0].snippet).toContain('Capacitors failing');
    expect(word.matches[0].snippet).not.toContain('<b>'); // a model reads this, not a browser
    const number = await search('job', job.id, '4321', 'manager');
    expect(number.matches.map((m) => m.id)).toEqual([code.id]);
    const whole = await search('customer', customer.id, 'capacitor', 'manager');
    expect(whole.count).toBe(2);
    expect((await search('job', job.id, '   ', 'manager')).note).toBe('empty query');
    expect((await search('job', '00000000-0000-0000-0000-000000000000', 'x', 'manager')).scope_found).toBe(false);
  });
});
