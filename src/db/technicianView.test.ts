import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer, insertCustomerCapture, type Customer } from './customers.js';
import { TERMINAL_JOB_STATUSES, createJob, type Job } from './jobs.js';
import { createTenant } from './tenants.js';
import { createVisit } from './visits.js';
import { insertTechnician } from './technicians.js';
import { appendRawCapture, type RawCapture } from './rawCaptures.js';
import {
  getCaptureFull,
  getCustomerContents,
  isOutsideView,
  listCapturesPage,
  searchCaptures,
  type CustomerContents,
} from './context.js';
import {
  getTechnicianView,
  insertAccessGrant,
  revokeAccessGrant,
  setTechnicianViewRule,
} from './technicianView.js';

// The technician limited view (migration 20260917120000_technician_view.sql;
// plan 2026-09-15-the-retrieval-layer-2-the-technician-limited-view), driven
// through the same readers the tools call. The cast, on a firm of its own:
//
//   Jane   a trip on Lee's OPEN job; a completed trip on Past Pat's PAID job;
//          a CANCELLED trip on Cancel Cal's open job.
//   Lee    open (Jane's trip) · other open (nobody's) · paid (nobody's)
//   Pat    paid (Jane's old trip) · new open job (someone else's)
//   Henderson  one open job Jane has nothing to do with: a technician note, a
//          phone call, and a manager_only row.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

let tenantId: string;
let otherTenantId: string;
let jane: string;
let lee: Customer;
let pat: Customer;
let cal: Customer;
let henderson: Customer;
let leeOpen: Job;
let leeOther: Job;
let leePaid: Job;
let patPaid: Job;
let patNew: Job;
let calOpen: Job;
let hJob: Job;
let leeNote: RawCapture;
let leeLevelNote: RawCapture;
let leeOtherNote: RawCapture;
let leePaidNote: RawCapture;
let hNote: RawCapture;
let hCall: RawCapture;
let hSecret: RawCapture;
let hLevelNote: RawCapture;
let dana: Customer;
let danaJob: Job;
let danaOwnNote: RawCapture;
let unfiledOwnNote: RawCapture;

const contentsFor = async (customerId: string, viewer: string | null = jane) =>
  getCustomerContents(tenantId, customerId, 'technician', viewer);
const inView = async (customerId: string): Promise<CustomerContents> => {
  const c = await contentsFor(customerId);
  if (!c || isOutsideView(c)) throw new Error('expected the customer to be in the view');
  return c;
};

beforeAll(async () => {
  await pg.connect();
  const t = await createTenant(`view-main-${Date.now()}`, { technicianSeats: 5 });
  tenantId = t.id;
  otherTenantId = (await createTenant(`view-other-${Date.now()}`, { technicianSeats: 5 })).id;
  await setTechnicianViewRule(tenantId, null, 'test');

  jane = (await insertTechnician({ tenantId, ref: 'tech-view-jane', displayName: 'Jane View' })).id;

  lee = await createCustomer({ tenantId, name: 'Lee Lin', phone: '206-555-0101' });
  leeOpen = await createJob({ tenantId, customerId: lee.id, title: 'Lee AC' });
  leeOther = await createJob({ tenantId, customerId: lee.id, title: 'Lee water heater' });
  leePaid = await createJob({ tenantId, customerId: lee.id, title: 'Lee old furnace', status: 'paid' });
  await createVisit({ tenantId, jobId: leeOpen.id, technicianId: jane, startsAt: null, endsAt: null });
  // Upcoming, on the job nobody is sent to yet: in view by default, not under own_trips.
  await createVisit({
    tenantId,
    jobId: leeOther.id,
    startsAt: `${days(3)}T10:00:00.000Z`,
    endsAt: `${days(3)}T11:00:00.000Z`,
    status: 'confirmed',
  });
  leeNote = await appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'tech-view-jane',
    rawText: 'condenser coil cleaned',
    jobId: leeOpen.id,
  });
  // Someone else's notes on Lee, so the scope rule — not Jane's authorship — is
  // what these tests exercise: a job-less note, one on the other open job (in
  // view), one on the paid job (outside it).
  leeLevelNote = await appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'someone-else',
    rawText: 'side gate sticks',
  });
  leeOtherNote = await appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'someone-else',
    rawText: 'water heater anode looked worn',
    jobId: leeOther.id,
  });
  leePaidNote = await appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'someone-else',
    rawText: 'old furnace flue cracked',
    jobId: leePaid.id,
  });
  await insertCustomerCapture({ tenantId, customerId: lee.id, captureId: leeLevelNote.id });

  pat = await createCustomer({ tenantId, name: 'Past Pat' });
  patPaid = await createJob({ tenantId, customerId: pat.id, title: 'Pat drain', status: 'paid' });
  patNew = await createJob({ tenantId, customerId: pat.id, title: 'Pat new work' });
  await createVisit({
    tenantId,
    jobId: patPaid.id,
    technicianId: jane,
    startsAt: null,
    endsAt: null,
    status: 'completed',
    completedAt: '2026-01-10T12:00:00.000Z',
  });

  cal = await createCustomer({ tenantId, name: 'Cancel Cal' });
  calOpen = await createJob({ tenantId, customerId: cal.id, title: 'Cal boiler' });
  await createVisit({
    tenantId,
    jobId: calOpen.id,
    technicianId: jane,
    startsAt: null,
    endsAt: null,
    status: 'cancelled',
  });

  henderson = await createCustomer({ tenantId, name: 'Hal Henderson', phone: '206-555-0199' });
  hJob = await createJob({ tenantId, customerId: henderson.id, title: 'Henderson roof' });
  hNote = await appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'someone-else',
    rawText: 'flashing replaced',
    jobId: hJob.id,
  });
  hCall = await appendRawCapture({
    tenantId,
    channel: 'phone_call',
    rawText: 'quoted $4,200 for the roof',
    jobId: hJob.id,
  });
  hSecret = await appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'someone-else',
    rawText: 'owner disputes the last invoice',
    jobId: hJob.id,
    sensitivity: 'manager_only',
  });
  // Filed on Henderson with no job: its customer is its only way into a view.
  hLevelNote = await appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'someone-else',
    rawText: 'dog in the yard at Hendersons',
  });
  await insertCustomerCapture({ tenantId, customerId: henderson.id, captureId: hLevelNote.id });

  // Jane dropped by Dana's unbooked and wrote a note; and one note of hers was never filed.
  dana = await createCustomer({ tenantId, name: 'Dana Dropby', phone: '206-555-0142' });
  danaJob = await createJob({ tenantId, customerId: dana.id, title: 'Dana gutters' });
  danaOwnNote = await appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'tech-view-jane',
    rawText: 'downspout loose, told her we would call',
    jobId: danaJob.id,
  });
  unfiledOwnNote = await appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'tech-view-jane',
    rawText: 'grab more capacitors tomorrow',
  });
  await appendRawCapture({
    tenantId,
    channel: 'technician_note',
    technicianRef: 'someone-else',
    rawText: 'gutter guard quote pending',
    jobId: danaJob.id,
  });
});

afterEach(async () => {
  await pg.query('truncate table access_grants, capture_tags');
  await setTechnicianViewRule(tenantId, null, 'test');
});

afterAll(async () => {
  await pg.query(
    'truncate table access_grants, technician_view_rules, capture_tags, customers, jobs, visits, raw_captures, technicians cascade',
  );
  await pg.query('delete from tenants where id = any($1)', [[tenantId, otherTenantId]]);
  await pg.end();
});

describe('who a technician is serving (the default rule)', () => {
  test("her own jobs, a served customer's other unfinished jobs, and nothing else", async () => {
    const v = await getTechnicianView(tenantId, jane);
    expect(v.allScope).toBe(false);
    expect(v.jobIds).toEqual(new Set([leeOpen.id, leeOther.id, patPaid.id]));
    // Pat keeps her profile through Jane's own old job; Cal's cancelled trip gives nothing.
    expect(v.customerIds).toEqual(new Set([lee.id, pat.id]));
    expect(v.jobIds.has(leePaid.id)).toBe(false);
    expect(v.jobIds.has(patNew.id)).toBe(false);
    expect(v.jobIds.has(calOpen.id)).toBe(false);
  });

  test("the contents page lists only what she may open, and counts the rest", async () => {
    const c = await inView(lee.id);
    expect(new Set(c.jobs.map((j) => j.id))).toEqual(new Set([leeOpen.id, leeOther.id]));
    expect(c.jobsTotal).toBe(2);
    expect(c.jobsOutsideView).toBe(1);
    expect(c.jobs.find((j) => j.id === leeOpen.id)!.noteCount).toBe(1);
    expect(c.jobs.find((j) => j.id === leeOther.id)!.noteCount).toBe(1);
    // The job-less note is hers to read while Lee is in her view.
    expect(c.customerLevel.noteCount).toBe(1);
    expect(c.upcomingVisits.map((u) => u.jobId)).toEqual([leeOther.id]);

    const past = await inView(pat.id);
    expect(past.jobs.map((j) => j.id)).toEqual([patPaid.id]);
    expect(past.jobsOutsideView).toBe(1);
  });

  test('a customer outside the view is named and nothing more; its pages are empty and say so', async () => {
    const h = await contentsFor(henderson.id);
    expect(h).toEqual({ inView: false, customer: { id: henderson.id, name: 'Hal Henderson' } });
    expect(JSON.stringify(h)).not.toContain('555-0199');
    const page = await listCapturesPage(tenantId, 'job', hJob.id, 'technician', {}, jane);
    expect(page.inView).toBe(false);
    expect(page.captures).toEqual([]);
    const byCustomer = await listCapturesPage(tenantId, 'customer', henderson.id, 'technician', {}, jane);
    expect(byCustomer.inView).toBe(false);
    expect(await getCaptureFull(tenantId, hNote.id, 'technician', false, jane)).toBeNull();
    // A job-less note is guarded by its customer alone (get_capture has no parent to check first).
    expect(await getCaptureFull(tenantId, hLevelNote.id, 'technician', false, jane)).toBeNull();
    expect(await getCaptureFull(tenantId, leeLevelNote.id, 'technician', false, jane)).not.toBeNull();
    // Lee's page by customer holds what is in her view — not the note on Lee's paid job.
    const leePage = await listCapturesPage(tenantId, 'customer', lee.id, 'technician', {}, jane);
    expect(new Set(leePage.captures.map((p) => p.captureId))).toEqual(
      new Set([leeNote.id, leeLevelNote.id, leeOtherNote.id]),
    );
    expect(leePage.totalVisible).toBe(3);
    expect(leePage.restrictedCount).toBe(0);
    expect(await getCaptureFull(tenantId, leePaidNote.id, 'technician', false, jane)).toBeNull();
    const furnace = await searchCaptures(tenantId, 'customer', lee.id, 'furnace', 'technician', {}, jane);
    expect(furnace.inView).toBe(true);
    expect(furnace.count).toBe(0);
  });

  test('no viewer sees nothing, and a viewer without the finished-statuses list is refused', async () => {
    expect(await contentsFor(lee.id, null)).toBeNull();
    const page = await listCapturesPage(tenantId, 'job', leeOpen.id, 'technician', {}, null);
    expect(page.inView).toBe(false);
    expect(page.captures).toEqual([]);
    expect(await getCaptureFull(tenantId, leeNote.id, 'technician')).toBeNull();
    const { error } = await getClient().rpc('technician_view_of', {
      p_tenant: tenantId,
      p_technician: jane,
      p_terminal_statuses: [],
    });
    expect(error?.message).toContain('p_terminal_statuses is required');
    // A manager's read is untouched.
    const mgr = (await getCustomerContents(tenantId, henderson.id, 'manager')) as CustomerContents;
    expect(mgr.jobs.find((j) => j.id === hJob.id)!.noteCount).toBe(3);
    expect(mgr.jobsOutsideView).toBe(0);
  });
});

describe('her own notes (operator, 2026-09-15)', () => {
  test('a note she wrote is readable wherever it sits; the record around it is not', async () => {
    expect(isOutsideView((await contentsFor(dana.id))!)).toBe(true);
    expect((await getCaptureFull(tenantId, danaOwnNote.id, 'technician', false, jane))?.rawText).toContain('downspout');
    expect((await getCaptureFull(tenantId, unfiledOwnNote.id, 'technician', false, jane))?.rawText).toContain(
      'capacitors',
    );
    const page = await listCapturesPage(tenantId, 'job', danaJob.id, 'technician', {}, jane);
    expect(page.inView).toBe(false);
    expect(page.captures.map((c) => c.captureId)).toEqual([danaOwnNote.id]);
    // The counts on an out-of-view page never reach someone else's note there.
    expect(page.totalVisible).toBe(1);
    expect(page.restrictedCount).toBe(0);
    const byCustomer = await listCapturesPage(tenantId, 'customer', dana.id, 'technician', {}, jane);
    expect(byCustomer.captures.map((c) => c.captureId)).toEqual([danaOwnNote.id]);
    expect((await searchCaptures(tenantId, 'job', danaJob.id, 'quote', 'technician', {}, jane)).count).toBe(0);
    // No viewer, no authorship: still nothing.
    expect(await getCaptureFull(tenantId, danaOwnNote.id, 'technician')).toBeNull();
  });

  test('only a TECHNICIAN-channel note counts as hers: mail stamped with her ref stays behind the scope rule', async () => {
    const mail = await appendRawCapture({
      tenantId,
      channel: 'email',
      technicianRef: 'tech-view-jane',
      rawText: 'From Dana: can you also look at the fence?',
      jobId: danaJob.id,
    });
    await setTechnicianViewRule(tenantId, { technicianChannels: ['technician_note', 'email'] }, 'test');
    expect(await getCaptureFull(tenantId, mail.id, 'technician', false, jane)).toBeNull();
  });

  test('authorship lifts scope only: a hidden tag still closes her own note', async () => {
    await pg.query(
      "insert into capture_tags (tenant_id, capture_id, tag, source) values ($1, $2, 'pricing', 'manager')",
      [tenantId, danaOwnNote.id],
    );
    await setTechnicianViewRule(tenantId, { hiddenTags: ['pricing'] }, 'test');
    expect(await getCaptureFull(tenantId, danaOwnNote.id, 'technician', false, jane)).toBeNull();
  });
});

describe("the firm's own rule", () => {
  test('own_trips drops the other open job (and its upcoming trip); serving_history adds the finished one', async () => {
    await setTechnicianViewRule(tenantId, { jobScope: 'own_trips' }, 'test');
    const narrow = await inView(lee.id);
    expect(narrow.jobs.map((j) => j.id)).toEqual([leeOpen.id]);
    expect(narrow.upcomingVisits).toEqual([]);

    await setTechnicianViewRule(tenantId, { jobScope: 'serving_history' }, 'test');
    const wide = await getTechnicianView(tenantId, jane);
    expect(wide.jobIds).toEqual(new Set([leeOpen.id, leeOther.id, leePaid.id, patPaid.id]));
    expect(await getCaptureFull(tenantId, leePaidNote.id, 'technician', false, jane)).not.toBeNull();
  });

  test('whole_firm opens every customer, with no job filter on the schedule ahead', async () => {
    await setTechnicianViewRule(tenantId, { jobScope: 'whole_firm' }, 'test');
    const h = await inView(henderson.id);
    expect(h.jobs.map((j) => j.id)).toEqual([hJob.id]);
    // Scope opened; content did not: the call and the manager_only row stay closed.
    expect(h.jobs[0].noteCount).toBe(1);
    expect(h.jobs[0].restrictedCount).toBe(2);
    const { data } = await getClient().rpc('customer_contents', {
      p_tenant: tenantId,
      p_customer: lee.id,
      p_caller_tier: 'technician',
      p_terminal_statuses: [...TERMINAL_JOB_STATUSES],
      p_viewer: jane,
    });
    expect((data as { in_view_job_ids: unknown }).in_view_job_ids).toBeNull();
    expect((await inView(lee.id)).upcomingVisits.map((u) => u.jobId)).toEqual([leeOther.id]);
  });

  test('a tag the firm hides closes a technician note, and is counted as restricted', async () => {
    await pg.query(
      "insert into capture_tags (tenant_id, capture_id, tag, source) values ($1, $2, 'pricing', 'extractor')",
      [tenantId, leeNote.id],
    );
    expect((await inView(lee.id)).jobs.find((j) => j.id === leeOpen.id)!.noteCount).toBe(1);
    await setTechnicianViewRule(tenantId, { hiddenTags: ['pricing'] }, 'test');
    const job = (await inView(lee.id)).jobs.find((j) => j.id === leeOpen.id)!;
    expect(job.noteCount).toBe(0);
    expect(job.restrictedCount).toBe(1);
  });

  test('widening the channels opens a phone call to a technician in scope', async () => {
    await setTechnicianViewRule(
      tenantId,
      { jobScope: 'whole_firm', technicianChannels: ['technician_note', 'phone_call'] },
      'test',
    );
    expect(await getCaptureFull(tenantId, hCall.id, 'technician', false, jane)).not.toBeNull();
    expect(await getCaptureFull(tenantId, hSecret.id, 'technician', false, jane)).toBeNull();
  });
});

describe('grants', () => {
  const grant = (over: Partial<Parameters<typeof insertAccessGrant>[0]> = {}) =>
    insertAccessGrant({
      tenantId,
      technicianId: jane,
      customerId: henderson.id,
      opens: 'record',
      grantedBy: 'mgr-test',
      reason: 'covering the roof job',
      ...over,
    });

  test('a record grant opens the customer and his jobs, but not the notes the content gate closes', async () => {
    await grant();
    const h = await inView(henderson.id);
    expect(h.jobs[0].noteCount).toBe(1);
    expect(h.jobs[0].restrictedCount).toBe(2);
    expect(await getCaptureFull(tenantId, hCall.id, 'technician', false, jane)).toBeNull();
  });

  test('a record_and_notes CUSTOMER grant opens every note of that customer, as a manager sees them', async () => {
    await grant({ opens: 'record_and_notes' });
    const h = await inView(henderson.id);
    expect(h.jobs[0].noteCount).toBe(3);
    expect(h.jobs[0].restrictedCount).toBe(0);
    expect((await getCaptureFull(tenantId, hCall.id, 'technician', false, jane))?.rawText).toContain('$4,200');
    expect(await getCaptureFull(tenantId, hSecret.id, 'technician', false, jane)).not.toBeNull();
  });

  test('a JOB grant: record opens the job (and its customer) behind the content gate; record_and_notes opens its notes', async () => {
    await grant({ customerId: undefined, jobId: hJob.id });
    const recordOnly = await inView(henderson.id);
    expect(recordOnly.jobs.map((j) => j.id)).toEqual([hJob.id]);
    expect(recordOnly.jobs[0].noteCount).toBe(1);
    expect(recordOnly.jobs[0].restrictedCount).toBe(2);
    expect(await getCaptureFull(tenantId, hCall.id, 'technician', false, jane)).toBeNull();
    // The customer comes into view with the job, so his job-less notes do too (content-gated).
    expect(await getCaptureFull(tenantId, hLevelNote.id, 'technician', false, jane)).not.toBeNull();

    await pg.query('truncate table access_grants');
    await grant({ customerId: undefined, jobId: hJob.id, opens: 'record_and_notes' });
    const withNotes = await inView(henderson.id);
    expect(withNotes.jobs[0].noteCount).toBe(3);
    expect(withNotes.jobs[0].restrictedCount).toBe(0);
    expect(await getCaptureFull(tenantId, hCall.id, 'technician', false, jane)).not.toBeNull();
  });

  test('expired and revoked grants open nothing; a grant naming another firm opens nothing', async () => {
    await grant({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(isOutsideView((await contentsFor(henderson.id))!)).toBe(true);

    const live = await grant();
    expect(isOutsideView((await contentsFor(henderson.id))!)).toBe(false);
    expect(await revokeAccessGrant(live.id, tenantId, 'mgr-test', 'done')).toBe(true);
    expect(await revokeAccessGrant(live.id, tenantId, 'mgr-test', 'again')).toBe(false);
    expect(isOutsideView((await contentsFor(henderson.id))!)).toBe(true);

    const theirs = await createCustomer({ tenantId: otherTenantId, name: 'Foreign Fay' });
    await grant({ customerId: theirs.id });
    expect((await getTechnicianView(tenantId, jane)).customerIds.has(theirs.id)).toBe(false);
  });

  test('the ledger: no edits, no direct deletes, one revocation stamp, gone with its technician', async () => {
    const g = await grant();
    await expect(pg.query("update access_grants set reason = 'rewritten' where id = $1", [g.id])).rejects.toThrow(
      /ledger/,
    );
    await expect(pg.query('delete from access_grants where id = $1', [g.id])).rejects.toThrow(/ledger/);

    const temp = await insertTechnician({ tenantId, ref: 'tech-view-temp', displayName: 'Temp' });
    const tg = await grant({ technicianId: temp.id });
    await pg.query('delete from technicians where id = $1', [temp.id]);
    const left = await pg.query('select 1 from access_grants where id = $1', [tg.id]);
    expect(left.rowCount).toBe(0);
  });
});

describe('a trip her own note minted is not a trip (operator, 2026-09-15)', () => {
  test('filing a note on a customer she is not booked on does not open his record', async () => {
    const stranger = await createCustomer({ tenantId, name: 'Stranger Sam', phone: '206-555-0177' });
    const job = await createJob({ tenantId, customerId: stranger.id, title: 'Stranger porch' });
    // The note door's shape: a technician note, and a completed visit minted FROM it
    // with its author on the crew (attachNote.ts).
    const note = await appendRawCapture({
      tenantId,
      channel: 'technician_note',
      technicianRef: 'tech-view-jane',
      rawText: 'reset the breaker while I was there',
      jobId: job.id,
    });
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: jane,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: '2026-09-14T15:00:00.000Z',
      sourceCaptureId: note.id,
    });
    const v = await getTechnicianView(tenantId, jane);
    expect(v.jobIds.has(job.id)).toBe(false);
    expect(v.customerIds.has(stranger.id)).toBe(false);
    expect(isOutsideView((await contentsFor(stranger.id))!)).toBe(true);
    // Her own note is still hers to read — that is the whole record she gets.
    expect((await getCaptureFull(tenantId, note.id, 'technician', false, jane))?.rawText).toContain('breaker');
  });

  test('a trip minted from a CALL still counts: the firm booked it, she did not', async () => {
    const called = await createCustomer({ tenantId, name: 'Called Cora' });
    const job = await createJob({ tenantId, customerId: called.id, title: 'Cora furnace' });
    const call = await appendRawCapture({
      tenantId,
      channel: 'phone_call',
      rawText: 'no heat, send someone',
      jobId: job.id,
    });
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: jane,
      startsAt: null,
      endsAt: null,
      sourceCaptureId: call.id,
    });
    expect((await getTechnicianView(tenantId, jane)).jobIds.has(job.id)).toBe(true);
  });
});
