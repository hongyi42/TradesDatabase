import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import { createTenant } from './tenants.js';
import { createVisit, insertVisitNote } from './visits.js';
import { appendRawCapture, listRawCapturesForCustomer } from './rawCaptures.js';
import { getCustomerContents } from './context.js';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let otherTenantId: string | null = null;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').order('created_at', { ascending: true }).limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
  if (otherTenantId) await pg.query('delete from tenants where id = $1', [otherTenantId]);
  await pg.end();
});

describe('getCustomerContents', () => {
  test('counts the tech note reachable only through its visit, and the stamped call at customer level', async () => {
    const customer = await createCustomer({ tenantId, name: 'Context Cust', phone: '555-2200' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'CtxJob' });

    // A tech voice note: lands in L1 with NO customer_id; reachable only through
    // the visit it created (source_capture_id) and the note link.
    const techNote = await appendRawCapture({
      tenantId,
      channel: 'technician_voice',
      rawText: 'tech said this',
    });
    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'completed',
      completedAt: '2026-08-16T13:00:00.000Z',
      sourceCaptureId: techNote.id,
    });
    await insertVisitNote({ tenantId, visitId: visit.id, captureId: techNote.id });

    // A capture stamped directly with the customer and no job (e.g. an inbound
    // call the door could not place on a job).
    const call = await appendRawCapture({
      tenantId,
      channel: 'phone_call',
      rawText: 'inbound call',
      customerId: customer.id,
    });

    const contents = (await getCustomerContents(tenantId, customer.id, 'manager'))!;
    expect(contents.customer.id).toBe(customer.id);
    const block = contents.jobs.find((j) => j.id === job.id)!;
    expect(block.noteCount).toBe(1); // the visit-linked note, via the membership view
    expect(block.newest?.captureId).toBe(techNote.id);
    expect(block.newest?.snippet).toBe('tech said this');
    expect(block.lastVisitAt).not.toBeNull();
    expect(contents.customerLevel.noteCount).toBe(1); // the call: no job on any arm
    expect(contents.customerLevel.newest?.captureId).toBe(call.id);
    expect(contents.jobsTotal).toBe(1);
    expect(contents.olderJobs).toBe(0);
  });

  // The date-eval 2026-08-13 regression class: a customer with confirmed
  // BOOKINGS but no past visits briefed as "no visits scheduled" — context read
  // only the visits table. upcomingVisits is the schedule half.
  test('upcomingVisits surfaces placed bookings, unplaced windows, and nothing stale', async () => {
    const customer = await createCustomer({ tenantId, name: 'Upcoming Cust' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Radiator bleed' });

    // Placed future visit (naive-local convention: display slices, no tz math).
    const placed = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: '2027-03-05T08:30:00Z',
      endsAt: '2027-03-05T10:00:00Z',
      status: 'confirmed',
    });
    // Unplaced (time-TBD) visit holding only a scheduling window.
    const unplaced = await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: null,
      endsAt: null,
      status: 'confirmed',
    });
    // Noise that must NOT surface: a cancelled row and a long-past visit.
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: '2027-03-06T08:00:00Z',
      endsAt: '2027-03-06T09:00:00Z',
      status: 'cancelled',
    });
    await createVisit({
      tenantId,
      jobId: job.id,
      technicianId: null,
      startsAt: '2020-01-01T08:00:00Z',
      endsAt: '2020-01-01T09:00:00Z',
      status: 'confirmed',
    });

    const contents = (await getCustomerContents(tenantId, customer.id, 'manager'))!;
    const ids = contents.upcomingVisits.map((u) => u.visitId);
    expect(ids).toContain(placed.id);
    expect(ids).toContain(unplaced.id);
    expect(ids).toHaveLength(2); // cancelled + past excluded

    const placedRow = contents.upcomingVisits.find((u) => u.visitId === placed.id);
    // Display convention: raw wall-clock slices, never timezone-converted —
    // and the day label is SERVER-composed (the resolve_date phrase pattern:
    // the eval caught the model writing "Tuesday, Aug 19" for a served
    // 2026-08-18 when left to label dates itself).
    expect(placedRow).toMatchObject({
      date: '2027-03-05',
      startTime: '08:30',
      endTime: '10:00',
      phrase: 'Friday 2027-03-05',
    });

    const windowRow = contents.upcomingVisits.find((u) => u.visitId === unplaced.id);
    // INVERTED (rung 9a): this used to carry a stored range, and the phrase
    // read "between Monday … and Friday …". Nothing records when an untimed
    // visit should happen, so the ONLY honest phrase says so — the brief must
    // never hand the model a date to relay for a visit that has none.
    expect(windowRow).toMatchObject({
      untimed: true,
      date: null,
      phrase: 'no time set yet',
    });
  });

  test("a cross-tenant customer reads as nothing, and never leaks another tenant's bookings", async () => {
    // Two tenants, same-shaped data: the leak test the data-security gate
    // requires for a new accessor.
    const other = await createTenant(`ctx-other-${Date.now()}`, { technicianSeats: 2 });
    otherTenantId = other.id;
    const mine = await createCustomer({ tenantId, name: 'Leak Cust A' });
    const theirs = await createCustomer({ tenantId: other.id, name: 'Leak Cust B' });
    const myJob = await createJob({ tenantId, customerId: mine.id, title: 'Mine' });
    const theirJob = await createJob({ tenantId: other.id, customerId: theirs.id, title: 'Theirs' });
    await createVisit({
      tenantId,
      jobId: myJob.id,
      technicianId: null,
      startsAt: '2027-04-01T09:00:00Z',
      endsAt: '2027-04-01T10:00:00Z',
      status: 'confirmed',
    });
    const theirRow = await createVisit({
      tenantId: other.id,
      jobId: theirJob.id,
      technicianId: null,
      startsAt: '2027-04-01T09:00:00Z',
      endsAt: '2027-04-01T10:00:00Z',
      status: 'confirmed',
    });

    const contents = (await getCustomerContents(tenantId, mine.id, 'manager'))!;
    expect(contents.upcomingVisits.map((u) => u.visitId)).not.toContain(theirRow.id);
    // Their customer under MY tenant is nothing at all — not an empty record.
    expect(await getCustomerContents(tenantId, theirs.id, 'manager')).toBeNull();
    // And reading the OTHER tenant's customer under its own tenant never mixes mine in.
    const otherContents = (await getCustomerContents(other.id, theirs.id, 'manager'))!;
    expect(otherContents.upcomingVisits.map((u) => u.visitId)).toEqual([theirRow.id]);
  });

  test('live work is never pushed off the page: an old open job outranks eleven newer finished ones', async () => {
    const customer = await createCustomer({ tenantId, name: 'Busy Cust' });
    const oldOpen = await createJob({ tenantId, customerId: customer.id, title: 'Old open job' });
    for (let i = 0; i < 11; i++) {
      const done = await createJob({ tenantId, customerId: customer.id, title: `Finished ${i}` });
      await pg.query("update jobs set status = 'paid' where id = $1", [done.id]);
    }
    const contents = (await getCustomerContents(tenantId, customer.id, 'manager'))!;
    expect(contents.jobsTotal).toBe(12);
    expect(contents.jobs).toHaveLength(10);
    expect(contents.olderJobs).toBe(2);
    // The live job leads; the rest are the newest finished ones.
    expect(contents.jobs[0].id).toBe(oldOpen.id);
    expect(contents.jobs.slice(1).every((j) => j.status === 'paid')).toBe(true);
    // The sort key never leaks into the job row.
    expect((contents.jobs[0] as unknown as Record<string, unknown>).finished).toBeUndefined();
  });

  test('listRawCapturesForCustomer returns newest first', async () => {
    const customer = await createCustomer({ tenantId, name: 'Order Cust' });
    const older = await appendRawCapture({
      tenantId,
      channel: 'phone_call',
      rawText: 'older',
      customerId: customer.id,
    });
    await new Promise((r) => setTimeout(r, 10)); // distinct captured_at
    const newer = await appendRawCapture({
      tenantId,
      channel: 'phone_call',
      rawText: 'newer',
      customerId: customer.id,
    });

    const list = await listRawCapturesForCustomer(customer.id);
    expect(list[0].id).toBe(newer.id); // newest first
    expect(list.map((c) => c.id)).toContain(older.id);
  });
});
