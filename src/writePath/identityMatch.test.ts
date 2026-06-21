import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { upsertScheduleEntry } from '../db/scheduleEntries.js';
import { matchIdentity } from './identityMatch.js';
import type { ExtractedFields } from './extract.js';

// matchIdentity reads the customers table, so this is a DB-backed test against the
// TEST project (not a pure unit test): we seed customers, then assert matches.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let phoneCustomerId: string;
let addressCustomerId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;

  phoneCustomerId = (await createCustomer({ tenantId, name: 'Phone Match', phone: '555-0142' })).id;
  addressCustomerId = (
    await createCustomer({ tenantId, name: 'Address Match', addressLine1: '14 Smith St' })
  ).id;
});

afterAll(async () => {
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
  await pg.end();
});

const note = (over: Partial<ExtractedFields> = {}): ExtractedFields => ({ ...over });
const at = () => new Date().toISOString();

describe('matchIdentity', () => {
  test('a confirmed customerId wins outright', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-1',
      capturedAt: at(),
      extracted: note(),
      confirmed: { customerId: phoneCustomerId },
    });
    expect(r).toMatchObject({ status: 'matched', customerId: phoneCustomerId });
  });

  test('a unique phone match resolves to that customer', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-1',
      capturedAt: at(),
      extracted: note({ phone: '555-0142' }),
    });
    expect(r).toMatchObject({ status: 'matched', customerId: phoneCustomerId });
  });

  test('a unique address match resolves to that customer (case-insensitive)', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-1',
      capturedAt: at(),
      extracted: note({ address: '14 smith st' }),
    });
    expect(r).toMatchObject({ status: 'matched', customerId: addressCustomerId });
  });

  test('no phone/address match and no schedule → needs_disambiguation', async () => {
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-no-sched',
      capturedAt: at(),
      extracted: note({ phone: '555-9999', address: '999 Nowhere Ave' }),
    });
    expect(r.status).toBe('needs_disambiguation');
  });
});

describe('matchIdentity — schedule branch', () => {
  const today = '2026-06-19T10:00:00.000Z';

  test('a single scheduled entry on the capture day → needs_confirmation', async () => {
    await upsertScheduleEntry({
      tenantId,
      technicianRef: 'tech-sched-1',
      externalRowKey: 'r1',
      addressLine1: '5 Schedule Rd',
      scheduledStart: today,
    });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-1',
      capturedAt: today,
      extracted: note(),
    });
    expect(r.status).toBe('needs_confirmation');
    expect(r.suggestion?.address).toBe('5 Schedule Rd');
    expect(r.suggestion?.scheduleEntryId).toBeDefined();
  });

  test('resume with a confirmed address on a LINKED entry → matched to that customer & job', async () => {
    // The customer has no address, so step-1 cannot short-circuit; the match must
    // come from the schedule entry's link, proving the job linkage is returned.
    const customer = await createCustomer({ tenantId, name: 'Linked Cust' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Scheduled job' });
    await upsertScheduleEntry({
      tenantId,
      technicianRef: 'tech-sched-2',
      externalRowKey: 'r2',
      addressLine1: '6 Linked Ave',
      scheduledStart: today,
      customerId: customer.id,
      jobId: job.id,
    });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-2',
      capturedAt: today,
      extracted: note(),
      confirmed: { address: '6 Linked Ave' },
    });
    expect(r).toMatchObject({ status: 'matched', customerId: customer.id, jobId: job.id });
  });

  test('an existing customer at the scheduled address is reused, not duplicated', async () => {
    const existing = await createCustomer({
      tenantId,
      name: 'Already Here',
      addressLine1: '7 Dedup Blvd',
    });
    // Unlinked schedule entry at the SAME address — dedup must reuse the customer.
    await upsertScheduleEntry({
      tenantId,
      technicianRef: 'tech-sched-3',
      externalRowKey: 'r3',
      addressLine1: '7 Dedup Blvd',
      scheduledStart: today,
    });
    const r = await matchIdentity({
      tenantId,
      technicianRef: 'tech-sched-3',
      capturedAt: today,
      extracted: note(),
      confirmed: { address: '7 Dedup Blvd' },
    });
    expect(r).toMatchObject({ status: 'matched', customerId: existing.id });
  });
});
