import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import { createVisit } from './visits.js';
import { appendRawCapture, listRawCapturesForCustomer } from './rawCaptures.js';
import { getCustomerContext } from './context.js';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
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
    const visit = await createVisit({
      tenantId,
      jobId: job.id,
      technicianName: 'tech-x',
      sourceCaptureId: techNote.id,
    });

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
