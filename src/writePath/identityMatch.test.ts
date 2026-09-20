import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import { createJob, insertJobCapture } from '../db/jobs.js';
import { appendRawCapture } from '../db/rawCaptures.js';
import { createVisit, updateVisitStatus } from '../db/visits.js';
import { matchIdentity } from './identityMatch.js';
import type { ExtractedFields } from './extract.js';

// Spy-wrap the db barrel matchIdentity imports from (originals still run) so one
// test can inject a TRANSIENT thread-read failure — the "a failed WHICH must not
// cost us the WHO" contract is unreachable otherwise. The fixtures below reach
// the db through the concrete modules, not the barrel, so they are untouched.
vi.mock('../db/index.js', { spy: true });
import { findCustomersByThread } from '../db/index.js';
import { nl } from '../db/time.js';

// matchIdentity reads customers + the DB-owned schedule (assignments), so this
// is a DB-backed test against the local stack: we seed rows, then assert.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let phoneCustomerId: string;
let addressCustomerId: string;
let schedTech1Id: string;
let schedTech2Id: string;

// Fixed day, far from other suites' fixtures; capture time on the same UTC day.
const DAY = '2026-06-19';
const today = `${DAY}T10:00:00.000Z`;

// A confirmed visit for a (technician, customer) on DAY — the schedule shape
// matchIdentity consults since the sheet mirror retired.
async function bookOn(technicianId: string, customerId: string, hour: string) {
  const job = await createJob({ tenantId, customerId, title: `visit ${hour}` });
  const assignment = await createVisit({
    tenantId,
    jobId: job.id,
    technicianId,
    startsAt: nl(`${DAY}T${hour}:00:00.000Z`),
    endsAt: nl(`${DAY}T${Number(hour) + 2}:00:00.000Z`),
    status: 'confirmed',
  });
  return { job, assignment };
}

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query('truncate table customers, jobs, technicians, schedule_events cascade');
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  schedTech1Id = (
    await insertTechnician({ tenantId, ref: 'tech-sched-1', displayName: 'Sched One' })
  ).id;
  schedTech2Id = (
    await insertTechnician({ tenantId, ref: 'tech-sched-2', displayName: 'Sched Two' })
  ).id;

  phoneCustomerId = (await createCustomer({ tenantId, name: 'Phone Match', phone: '555-0142' })).id;
  addressCustomerId = (
    await createCustomer({ tenantId, name: 'Address Match', addressLine1: '14 Smith St' })
  ).id;
});

afterAll(async () => {
  await pg.query(
    'truncate table customers, jobs, visits, raw_captures, technicians, schedule_events cascade',
  );
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

const note = (over: Partial<ExtractedFields> = {}): ExtractedFields => ({ ...over });

describe('matchIdentity', () => {
  test('a confirmed customerId wins outright', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-1',
      capturedAt: today,
      extracted: note(),
      confirmed: { customerId: phoneCustomerId },
    });
    expect(r).toMatchObject({ status: 'matched', customerId: phoneCustomerId });
  });

  test('a unique phone match resolves to that customer', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-1',
      capturedAt: today,
      extracted: note({ phone: '555-0142' }),
    });
    expect(r).toMatchObject({ status: 'matched', customerId: phoneCustomerId });
  });

  test('a phone matches across spellings: stored (206) 555-0172, extracted +1 206-555-0172', async () => {
    const spelled = await createCustomer({ tenantId, name: 'Spelling Stan', phone: '(206) 555-0172' });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-1',
      capturedAt: today,
      extracted: note({ phone: '+1 206-555-0172' }),
    });
    expect(r).toMatchObject({ status: 'matched', customerId: spelled.id });
  });

  test('a unique address match resolves to that customer (case-insensitive)', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-1',
      capturedAt: today,
      extracted: note({ address: '14 smith st' }),
    });
    expect(r).toMatchObject({ status: 'matched', customerId: addressCustomerId });
  });

  test('no phone/address match and no roster row (no schedule) → needs_disambiguation', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note({ phone: '555-9999', address: '999 Nowhere Ave' }),
    });
    expect(r.status).toBe('needs_disambiguation');
  });
});

describe('matchIdentity — schedule branch (confirmed assignments)', () => {
  test('a single scheduled visit on the capture day → needs_confirmation with its address', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'Sched Cust',
      addressLine1: '5 Schedule Rd',
    });
    const { assignment } = await bookOn(schedTech1Id, cust.id, '15');
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-1',
      capturedAt: today,
      extracted: note(),
    });
    expect(r.status).toBe('needs_confirmation');
    expect(r.suggestion?.address).toBe('5 Schedule Rd');
    expect(r.suggestion?.visitId).toBe(assignment.id);

    // EVENING capture: 2026-06-20T01:00Z is still 6pm June 19 in the firm's
    // timezone (seed default America/Los_Angeles). The consultation must key
    // on the FIRM-local day, not the raw UTC slice — a same-evening writeup
    // still gets the day's suggestion.
    const evening = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-1',
      capturedAt: '2026-06-20T01:00:00.000Z',
      extracted: note(),
    });
    expect(evening.status).toBe('needs_confirmation');
    expect(evening.suggestion?.address).toBe('5 Schedule Rd');
  });

  test('resume with a confirmed address → matched to the visit\'s customer AND job', async () => {
    // TWO customers share the address (apartment-complex case), so step-1
    // unique-address dedup cannot short-circuit — the day's schedule is what
    // disambiguates, and it returns the JOB link only the assignment knows.
    const booked = await createCustomer({
      tenantId,
      name: 'Linked Unit A',
      addressLine1: '6 Linked Ave',
    });
    await createCustomer({ tenantId, name: 'Linked Unit B', addressLine1: '6 Linked Ave' });
    // A second visit the same day for an unrelated customer → no
    // single-suggestion either; the confirmed address must pick the right one.
    const other = await createCustomer({ tenantId, name: 'Same Day Other' });
    const target = await bookOn(schedTech2Id, booked.id, '09');
    await bookOn(schedTech2Id, other.id, '13');
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-2',
      capturedAt: today,
      extracted: note(),
      confirmed: { address: '6 linked ave' }, // case-insensitive
    });
    expect(r).toMatchObject({
      status: 'matched',
      customerId: booked.id,
      jobId: target.job.id,
    });
  });

  test('confirmed address not on the day\'s schedule → needs_disambiguation (caller creates)', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-2',
      capturedAt: today,
      extracted: note(),
      confirmed: { address: '404 Not Scheduled St' },
    });
    expect(r.status).toBe('needs_disambiguation');
    expect(r.reason).toContain('not found on the schedule');
  });

  test('cancelled visits do not suggest; another day\'s visit does not leak in', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'Other Day',
      addressLine1: '8 Other Day Dr',
    });
    // Visit on a DIFFERENT day than the capture → no suggestion for tech-sched-1
    // beyond its single 06-19 visit (already asserted); for a fresh tech ref
    // with only an off-day visit, the schedule branch finds nothing.
    const tech3 = await insertTechnician({ tenantId, ref: 'tech-sched-3', displayName: 'S3' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'off-day' });
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech3.id,
      startsAt: nl('2026-06-20T15:00:00.000Z'), // day AFTER the capture
      endsAt: nl('2026-06-20T17:00:00.000Z'),
      status: 'confirmed',
    });
    // A CANCELLED visit ON the capture day must not suggest either — only
    // confirmed rows are the schedule.
    const cancelled = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: tech3.id,
      startsAt: nl(`${DAY}T09:00:00.000Z`),
      endsAt: nl(`${DAY}T11:00:00.000Z`),
      status: 'confirmed',
    });
    await updateVisitStatus(cancelled.id, 'cancelled', 'test');
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-3',
      capturedAt: today,
      extracted: note(),
    });
    expect(r.status).toBe('needs_disambiguation');
  });
});

// RUNG 10B — the two keys added between phone and address. Both unique-or-refuse:
// a second hit means the key identified nobody and the next key gets its turn.
describe('matchIdentity — the email key', () => {
  test('a unique email match resolves to that customer, case-insensitively', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'Email Match',
      email: 'Tom.Becker@Example.com',
    });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      email: 'tom.becker@example.com',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id });
  });

  test('phone still wins over email', async () => {
    // The email points at a DIFFERENT customer than the phone. Phone is read
    // first, so its answer stands and the email is never consulted.
    await createCustomer({ tenantId, name: 'Wrong By Email', email: 'shared@example.com' });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note({ phone: '555-0142' }),
      email: 'shared@example.com',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: phoneCustomerId });
  });

  test('two customers sharing an address fall through instead of guessing', async () => {
    await createCustomer({ tenantId, name: 'Shared One', email: 'office@example.com' });
    await createCustomer({ tenantId, name: 'Shared Two', email: 'office@example.com' });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      email: 'office@example.com',
    });
    expect(r.status).toBe('needs_disambiguation');
  });

  test('an underscore in the address is a literal, not a LIKE wildcard', async () => {
    // Unescaped, `a_b@…` would ALSO match `axb@…` — two hits, and the key would
    // refuse. Worse, a lookup for `axb@…` could land on the wrong customer.
    const underscored = await createCustomer({
      tenantId,
      name: 'Underscore',
      email: 'a_b@wildcard.test',
    });
    await createCustomer({ tenantId, name: 'Decoy', email: 'axb@wildcard.test' });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      email: 'a_b@wildcard.test',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: underscored.id });
  });
});

describe('matchIdentity — the thread key', () => {
  test('a thread whose captures name one customer and one job matches both', async () => {
    const cust = await createCustomer({ tenantId, name: 'Threaded' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'water heater' });
    // The STARTER: its thread id is its own message id, which is where
    // external_id holds it (Gmail's convention).
    const starter = await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'Friday morning for the water heater',
      externalId: 'thread-abc',
    });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: starter.id });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      threadId: 'thread-abc',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id, jobId: job.id });
  });

  test('a later message carries the key in metadata, and a stamped capture answers too', async () => {
    const cust = await createCustomer({ tenantId, name: 'Threaded By Metadata' });
    await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'reply one',
      externalId: 'msg-2',
      metadata: { threadId: 'thread-meta' },
      customerId: cust.id,
    });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      threadId: 'thread-meta',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id });
    expect(r.jobId).toBeUndefined(); // nothing named a job
  });

  test('a thread naming two customers falls through instead of guessing', async () => {
    const a = await createCustomer({ tenantId, name: 'Thread Cust A' });
    const b = await createCustomer({ tenantId, name: 'Thread Cust B' });
    for (const [i, customerId] of [a.id, b.id].entries()) {
      await appendRawCapture({
        tenantId,
        channel: 'email',
        rawText: `crossed ${i}`,
        externalId: `msg-crossed-${i}`,
        metadata: { threadId: 'thread-crossed' },
        customerId,
      });
    }
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      threadId: 'thread-crossed',
    });
    expect(r.status).toBe('needs_disambiguation');
  });

  test('one customer reached through TWO jobs matches the customer, not a job', async () => {
    const cust = await createCustomer({ tenantId, name: 'Two Jobs One Thread' });
    const jobs = [
      await createJob({ tenantId, customerId: cust.id, title: 'first' }),
      await createJob({ tenantId, customerId: cust.id, title: 'second' }),
    ];
    for (const [i, job] of jobs.entries()) {
      const capture = await appendRawCapture({
        tenantId,
        channel: 'email',
        rawText: `on job ${i}`,
        externalId: `msg-twojobs-${i}`,
        metadata: { threadId: 'thread-twojobs' },
      });
      await insertJobCapture({ tenantId, jobId: job.id, captureId: capture.id });
    }
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      threadId: 'thread-twojobs',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id });
    expect(r.jobId).toBeUndefined();
  });

  test('a TERMINAL job answers WHO but is never handed back as the job to file on', async () => {
    // Otherwise a reply about new work would land on a paid job — and, worse,
    // the door only raises rung 10's ask when it found NO job, so the ask would
    // be swallowed silently.
    const cust = await createCustomer({ tenantId, name: 'Paid Up Pat' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'settled' });
    await pg.query('update jobs set status = $1 where id = $2', ['paid', job.id]);
    const capture = await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'about that invoice',
      externalId: 'thread-terminal',
    });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: capture.id });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      threadId: 'thread-terminal',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id });
    expect(r.jobId).toBeUndefined();
  });

  test('a capture stamped with ANOTHER tenant\'s customer answers nothing', async () => {
    // customer_id on a capture is an id-only foreign key: nothing in the schema
    // makes the customer share the capture's tenant, so the stamp is re-read
    // under this tenant before it is allowed to identify anybody.
    const { rows } = await pg.query<{ id: string }>(
      "insert into tenants (name) values ('thread-key-foreign-probe') returning id",
    );
    const foreign = await createCustomer({ tenantId: rows[0].id, name: 'Not Ours' });
    await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'crossed wires',
      externalId: 'thread-foreign',
      customerId: foreign.id,
    });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      threadId: 'thread-foreign',
    });
    expect(r.status).toBe('needs_disambiguation');
  });

  test('the refusal says WHAT each key found — the planner is the second opinion', async () => {
    // A generic "no unique match" tells the planner nothing about the NEAR miss
    // it is being asked to adjudicate.
    await createCustomer({ tenantId, name: 'Shared A', email: 'twins@example.com' });
    await createCustomer({ tenantId, name: 'Shared B', email: 'twins@example.com' });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note({ phone: '555-nobody-has-this', address: '999 Nowhere Ave' }),
      email: 'twins@example.com',
      threadId: 'thread-crossed',
    });
    expect(r.status).toBe('needs_disambiguation');
    expect(r.reason).toContain('no customer has the phone');
    expect(r.reason).toContain('2 customers share the address twins@example.com');
    expect(r.reason).toContain('crosses 2 customers');
    expect(r.reason).toContain('no customer is at 999 Nowhere Ave');
  });

  test('a message with nothing to match on says so, rather than blaming the schedule', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
    });
    expect(r.reason).toContain('no phone, email, thread or address');
  });

  test('a thread nobody has filed leaves the address key its turn', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note({ address: '14 smith st' }),
      threadId: 'thread-unknown',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: addressCustomerId });
  });
});

// RUNG 10B.3. Two different questions used to share one answer: the key that
// found the PERSON also decided the JOB, by returning the moment it was unique
// and leaving the door to guess (the customer's newest non-terminal job). The
// thread is the only key that ever knew the job, so it is now asked whichever
// key won — for the job alone, and only when the job is that customer's.
describe('matchIdentity — a person key decides WHO, the thread decides WHICH', () => {
  test('the thread names ONE job for the matched customer → it rides along', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'Which Job',
      email: 'which@example.com',
    });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'radiator' });
    const capture = await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'the radiator again',
      externalId: 'msg-which-1',
      metadata: { threadId: 'thread-which' },
    });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: capture.id });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      email: 'which@example.com',
      threadId: 'thread-which',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id, jobId: job.id });
  });

  test('THE DEFECT: two open jobs, a reply on the older thread lands on the OLDER', async () => {
    // Fails on main: the email key returned before the thread was consulted, so
    // the door fell through to "newest non-terminal job" and filed the reply
    // against work the customer was not writing about.
    const cust = await createCustomer({
      tenantId,
      name: 'Two Open Jobs',
      email: 'twoopen@example.com',
    });
    const older = await createJob({ tenantId, customerId: cust.id, title: 'quote: repipe' });
    const newer = await createJob({ tenantId, customerId: cust.id, title: 'booked: radiator' });
    const capture = await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'about the repipe quote',
      externalId: 'msg-twoopen-1',
      metadata: { threadId: 'thread-twoopen' },
    });
    await insertJobCapture({ tenantId, jobId: older.id, captureId: capture.id });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      email: 'twoopen@example.com',
      threadId: 'thread-twoopen',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id, jobId: older.id });
    expect(r.jobId).not.toBe(newer.id);
  });

  test("THE HAZARD: the thread's job belongs to ANOTHER customer → no jobId", async () => {
    // Adopting it blindly would file this message against somebody else's work,
    // which is worse than the guess this rung replaces.
    const writer = await createCustomer({
      tenantId,
      name: 'The Writer',
      email: 'writer@example.com',
    });
    const other = await createCustomer({ tenantId, name: 'Somebody Else' });
    const theirJob = await createJob({ tenantId, customerId: other.id, title: 'not yours' });
    const capture = await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'forwarded along',
      externalId: 'msg-drift-1',
      metadata: { threadId: 'thread-drift' },
    });
    await insertJobCapture({ tenantId, jobId: theirJob.id, captureId: capture.id });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      email: 'writer@example.com',
      threadId: 'thread-drift',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: writer.id });
    expect(r.jobId).toBeUndefined();
  });

  test('the thread names TWO jobs for the matched customer → no jobId', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'Ambiguous Thread',
      email: 'ambiguous@example.com',
    });
    for (const [i, title] of ['first', 'second'].entries()) {
      const job = await createJob({ tenantId, customerId: cust.id, title });
      const capture = await appendRawCapture({
        tenantId,
        channel: 'email',
        rawText: `about ${title}`,
        externalId: `msg-ambig-${i}`,
        metadata: { threadId: 'thread-ambig' },
      });
      await insertJobCapture({ tenantId, jobId: job.id, captureId: capture.id });
    }
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      email: 'ambiguous@example.com',
      threadId: 'thread-ambig',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id });
    expect(r.jobId).toBeUndefined();
  });

  test('a TERMINAL job on the thread is never adopted', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'Settled Sam',
      email: 'settled@example.com',
    });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'invoiced' });
    const capture = await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'thanks, paid',
      externalId: 'msg-settled-1',
      metadata: { threadId: 'thread-settled' },
    });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: capture.id });
    await pg.query('update jobs set status = $1 where id = $2', ['paid', job.id]);
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      email: 'settled@example.com',
      threadId: 'thread-settled',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id });
    expect(r.jobId).toBeUndefined();
  });

  test('no threadId at all → the email key answers exactly as it did', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'No Thread',
      email: 'nothread@example.com',
    });
    await createJob({ tenantId, customerId: cust.id, title: 'open work' });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      email: 'nothread@example.com',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id });
    expect(r.jobId).toBeUndefined();
  });

  test('the PHONE key gets the thread’s job too, not just email', async () => {
    const cust = await createCustomer({
      tenantId,
      name: 'Phoned In',
      phone: '555-0777',
    });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'boiler' });
    const capture = await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'the boiler',
      externalId: 'msg-phoned-1',
      metadata: { threadId: 'thread-phoned' },
    });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: capture.id });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note({ phone: '555-0777' }),
      threadId: 'thread-phoned',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id, jobId: job.id });
  });

  test('the ADDRESS key gets the thread’s job too — even on a thread that REFUSED', async () => {
    // The address arm sits BELOW the thread arm, so reaching it needs a thread
    // the thread arm itself would not answer: this one crosses two customers.
    // It still knows exactly one job for the customer the ADDRESS named, and
    // that is the whole split — the key decides who, the conversation which.
    const cust = await createCustomer({
      tenantId,
      name: 'Addressed',
      addressLine1: '77 Thread Lane',
    });
    const stranger = await createCustomer({ tenantId, name: 'Also On This Thread' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'gutters' });
    const capture = await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'the gutters',
      externalId: 'msg-addr-1',
      metadata: { threadId: 'thread-addr' },
    });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: capture.id });
    await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'looping in the landlord',
      externalId: 'msg-addr-2',
      metadata: { threadId: 'thread-addr' },
      customerId: stranger.id,
    });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note({ address: '77 Thread Lane' }),
      threadId: 'thread-addr',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id, jobId: job.id });
  });

  test('a thread read that FAILS keeps the match — WHO is answered, WHICH is an aid', async () => {
    // Before this rung a unique email key returned without reading the thread at
    // all. If the read's failure escaped, an otherwise-resolved identity would
    // become a 503 and Composio's redelivery would pay for the extractor a
    // SECOND time — the capture has no L2 link yet, so the door's
    // already-processed short-circuit does not catch it.
    const cust = await createCustomer({
      tenantId,
      name: 'Blipped',
      email: 'blipped@example.com',
    });
    // THE THREAD IS SEEDED ON PURPOSE. Without a job on it, this test passes
    // whether the read threw or merely found nothing — a guard that stays green
    // if a later refactor stops the person arms calling the thread at all.
    // Seeded, `jobId` would ride along on a SUCCESSFUL read, so the assertion
    // below can only hold if the failure was swallowed.
    const job = await createJob({ tenantId, customerId: cust.id, title: 'would ride along' });
    const capture = await appendRawCapture({
      tenantId,
      channel: 'email',
      rawText: 'the blip',
      externalId: 'msg-blip-1',
      metadata: { threadId: 'thread-blip' },
    });
    await insertJobCapture({ tenantId, jobId: job.id, captureId: capture.id });
    vi.mocked(findCustomersByThread).mockRejectedValueOnce(new Error('PostgREST blip'));
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: today,
      extracted: note(),
      email: 'blipped@example.com',
      threadId: 'thread-blip',
    });
    expect(r).toMatchObject({ status: 'matched', customerId: cust.id });
    expect(r.jobId).toBeUndefined();
  });
});
