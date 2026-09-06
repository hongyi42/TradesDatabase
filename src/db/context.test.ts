import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import { createTenant } from './tenants.js';
import { createVisit, insertVisitNote } from './visits.js';
import { appendRawCapture, listRawCapturesForCustomer } from './rawCaptures.js';
import { getCustomerContext } from './context.js';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').order('created_at', { ascending: true }).limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
  await pg.end();
});

describe('getCustomerContext', () => {
  test('aggregates customer + jobs + visits + captures, surfacing tech notes linked only via source_capture_id', async () => {
    const customer = await createCustomer({ tenantId, name: 'Context Cust', phone: '555-2200' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'CtxJob' });

    // A tech voice note: lands in L1 with NO customer_id; reachable only through
    // the visit's source_capture_id.
    const techNote = await appendRawCapture({
      tenantId,
      channel: 'technician_voice',
      rawText: 'tech said this',
    });
    // A reported trip: the visit, plus the note link recordFieldNote writes.
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

    // A capture stamped directly with the customer (e.g. an inbound call).
    const call = await appendRawCapture({
      tenantId,
      channel: 'phone_call',
      rawText: 'inbound call',
      customerId: customer.id,
    });

    const ctx = await getCustomerContext(customer.id);
    expect(ctx.customer?.id).toBe(customer.id);
    expect(ctx.jobs.map((j) => j.id)).toContain(job.id);
    expect(ctx.recentVisits.map((v) => v.id)).toContain(visit.id);

    const captureIds = ctx.recentCaptures.map((c) => c.id);
    expect(captureIds).toContain(techNote.id); // via source_capture_id union
    expect(captureIds).toContain(call.id); // via customer_id column
  });

  // The date-eval 2026-08-13 regression class: a customer with confirmed
  // BOOKINGS (assignments) but no past visits briefed as "no visits
  // scheduled" — context read only the visits table. upcomingVisits is the
  // schedule half.
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

    const ctx = await getCustomerContext(customer.id);
    const ids = ctx.upcomingVisits.map((u) => u.visitId);
    expect(ids).toContain(placed.id);
    expect(ids).toContain(unplaced.id);
    expect(ids).toHaveLength(2); // cancelled + past excluded

    const placedRow = ctx.upcomingVisits.find((u) => u.visitId === placed.id);
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

    const windowRow = ctx.upcomingVisits.find((u) => u.visitId === unplaced.id);
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

  test("upcomingVisits never leaks another tenant's bookings", async () => {
    // Two tenants, same-shaped data: the leak test the data-security gate
    // requires for a new accessor.
    const other = await createTenant(`ctx-other-${Date.now()}`, { technicianSeats: 2 });
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

    const ctx = await getCustomerContext(mine.id);
    expect(ctx.upcomingVisits.map((u) => u.visitId)).not.toContain(theirRow.id);
    // And reading the OTHER tenant's customer directly never mixes mine in.
    const otherCtx = await getCustomerContext(theirs.id);
    expect(otherCtx.upcomingVisits.map((u) => u.visitId)).toEqual([theirRow.id]);
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
