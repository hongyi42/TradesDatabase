import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createTenant } from './tenants.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import { insertTechnician } from './technicians.js';
import { createVisit, listVisitsForTenant, listVisitsWithRefsForTenant } from './visits.js';
import { hitRowCap, POSTGREST_MAX_ROWS, rowCapNote } from './rowCap.js';
import { readLooseBucket } from '../schedule/boardRead.js';
import { nl } from './time.js';

// Retrieval layer 4, phase 2: the schedule's window readers are COMPLETE, and
// the loose bucket carries what the recall view needs. Each describe runs on its
// own firm, so no other file's fixtures can pad or starve the counts.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const made: string[] = [];

beforeAll(async () => {
  await pg.connect();
});

afterAll(async () => {
  for (const t of made) {
    await pg.query('delete from visits where tenant_id = $1', [t]);
    await pg.query('delete from jobs where tenant_id = $1', [t]);
    await pg.query('delete from customers where tenant_id = $1', [t]);
    await pg.query('delete from technicians where tenant_id = $1', [t]);
    await pg.query('delete from tenants where id = $1', [t]);
  }
  await pg.end();
});

describe('the window readers page past PostgREST\'s row limit', () => {
  test('1,005 confirmed visits in one window all come back, in order, once each', async () => {
    const tenantId = (await createTenant('sw-window', { managerSeats: 1 })).id;
    made.push(tenantId);
    const customer = await createCustomer({ tenantId, name: 'Window Wanda' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'many trips' });
    // Nobody on them, so the overlap guard (on participants) never fires. Every
    // visit is 30 minutes inside 2027-05-03, several sharing a start, so the id
    // tiebreak is exercised too.
    await pg.query(
      `insert into visits (tenant_id, job_id, starts_at, ends_at, status)
       select $1, $2,
              timestamptz '2027-05-03 08:00+00' + ((g % 200) || ' seconds')::interval,
              timestamptz '2027-05-03 08:30+00' + ((g % 200) || ' seconds')::interval,
              'confirmed'
         from generate_series(1, 1005) as g`,
      [tenantId, job.id],
    );
    const from = '2027-05-03T00:00:00.000Z';
    const to = '2027-05-04T00:00:00.000Z';
    for (const read of [listVisitsForTenant, listVisitsWithRefsForTenant]) {
      const rows = await read(tenantId, from, to);
      expect(rows).toHaveLength(1005);
      expect(new Set(rows.map((r) => r.id)).size).toBe(1005);
      for (let i = 1; i < rows.length; i++) {
        const a = rows[i - 1];
        const b = rows[i];
        const ordered =
          Date.parse(a.starts_at) < Date.parse(b.starts_at) ||
          (Date.parse(a.starts_at) === Date.parse(b.starts_at) && a.id < b.id);
        expect(ordered).toBe(true);
      }
    }
  });
});

describe('the row-limit note', () => {
  test('fires at the limit, not below it, and names what was read', () => {
    expect(POSTGREST_MAX_ROWS).toBe(1000);
    expect(hitRowCap(999)).toBe(false);
    expect(hitRowCap(1000)).toBe(true);
    expect(rowCapNote('ledger entries')).toContain('first 1000 ledger entries');
  });
});

describe('readLooseBucket — what the recall view reads', () => {
  test('overdue follows the clock it is given, and a crew we cannot name is still a crew', async () => {
    const tenantId = (await createTenant('sw-bucket', { managerSeats: 1 })).id;
    const foreignTenant = (await createTenant('sw-bucket-foreign', { managerSeats: 1 })).id;
    made.push(tenantId, foreignTenant);
    const customer = await createCustomer({ tenantId, name: 'Bucket Bea' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'parked work' });
    const parked = await createVisit({
      tenantId,
      jobId: job.id,
      startsAt: nl('2027-06-10T09:00:00Z'),
      endsAt: nl('2027-06-10T10:00:00Z'),
      status: 'confirmed',
    });
    const untimed = await createVisit({
      tenantId,
      jobId: job.id,
      startsAt: null,
      endsAt: null,
      status: 'confirmed',
    });
    // A participant row on THIS firm whose technician belongs to another firm:
    // unnameable, but somebody is on the trip.
    const stranger = await insertTechnician({
      tenantId: foreignTenant,
      ref: 'sw-stranger',
      displayName: 'Stranger',
      seatExempt: true,
    });
    await pg.query(
      'insert into visit_participants (tenant_id, visit_id, technician_id) values ($1, $2, $3)',
      [tenantId, untimed.id, stranger.id],
    );

    const before = await readLooseBucket(tenantId, '2027-06-01T12:00:00.000Z');
    const after = await readLooseBucket(tenantId, '2027-06-20T12:00:00.000Z');
    const find = (b: typeof before, id: string) => b.parkedVisits.find((v) => v.visitId === id);
    expect(find(before, parked.id)).toMatchObject({ overdue: false, jobId: job.id, unassigned: true });
    expect(find(after, parked.id)).toMatchObject({ overdue: true });

    const crewed = find(before, untimed.id);
    expect(crewed).toBeDefined();
    expect(crewed?.technicianRefs).toEqual([]);
    expect(crewed?.unassigned).toBe(false);
    expect(typeof crewed?.createdAt).toBe('string');
    expect(before.unscheduledJobsRowCapHit).toBe(false);
  });
});
