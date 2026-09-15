import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  createCustomer,
  insertCustomerCapture,
  captureHasCustomerCapture,
  listCustomerCapturesForCapture,
  listLinkedCapturesForCustomer,
} from './customers.js';
import { createTenant } from './tenants.js';
import { appendRawCapture, captureHasLinkedL2 } from './rawCaptures.js';
import { listL2CitingCapture } from './captureMembership.js';
import { getCustomerContents } from './context.js';

// THE THIRD LINK LEVEL (2026-09-12). A capture the door can place on a PERSON
// but not on a job. What these tests pin is the set of answers that link is and
// is not allowed to give: it is a processed-marker and a retraction road, it is
// readable from the customer, and it is NOT a citation — "filed under this
// customer" must never read as "somebody dealt with what they asked for".
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  // The house pattern for L1-touching suites: TRUNCATE, because raw_captures is
  // append-only by trigger — DELETE is refused.
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
  await pg.end();
});

// An INBOUND capture: no customer_id stamp, because identity resolves after L1
// and L1 can never be updated. That absent stamp is the entire reason this
// table exists, so every fixture here has to have it.
async function unstampedCapture(text: string): Promise<string> {
  const row = await appendRawCapture({
    tenantId,
    channel: 'email',
    technicianRef: 'link-test',
    rawText: text,
  });
  expect(row.customer_id, 'fixture must be unstamped or it proves nothing').toBeNull();
  return row.id;
}

describe('customer_captures — the link for "we know WHO, not WHICH"', () => {
  test('insert links, is idempotent, and reads back both ways', async () => {
    const customer = await createCustomer({ tenantId, name: 'Linked Lucy' });
    const captureId = await unstampedCapture('is someone still coming out?');

    await insertCustomerCapture({ tenantId, customerId: customer.id, captureId });
    // A redelivery re-runs the door: the second write must be a NO-OP, not a
    // duplicate-key error and not an UPDATE (the trigger would raise on that).
    await insertCustomerCapture({ tenantId, customerId: customer.id, captureId });

    expect(await captureHasCustomerCapture(captureId)).toBe(true);
    expect(await listLinkedCapturesForCustomer(customer.id)).toEqual([
      { capture_id: captureId, tenant_id: tenantId },
    ]);
    expect(await listCustomerCapturesForCapture(captureId)).toEqual([
      { customer_id: customer.id, tenant_id: tenantId },
    ]);
  });

  test('a link is never re-pointed: UPDATE raises', async () => {
    const customer = await createCustomer({ tenantId, name: 'Immutable Ida' });
    const other = await createCustomer({ tenantId, name: 'Somebody Else' });
    const captureId = await unstampedCapture('moving this to another customer?');
    await insertCustomerCapture({ tenantId, customerId: customer.id, captureId });

    await expect(
      pg.query('update customer_captures set customer_id = $1 where capture_id = $2', [
        other.id,
        captureId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  test('a customer-only link IS a processed-marker — a redelivery must not re-extract', async () => {
    const customer = await createCustomer({ tenantId, name: 'Processed Pat' });
    const captureId = await unstampedCapture('thanks, talk soon');

    expect(await captureHasLinkedL2(captureId)).toBe(false);
    await insertCustomerCapture({ tenantId, customerId: customer.id, captureId });
    expect(await captureHasLinkedL2(captureId)).toBe(true);
  });

  test('a customer-only link is NOT a citation — it cannot close an ask', async () => {
    const customer = await createCustomer({ tenantId, name: 'Uncited Ursula' });
    const captureId = await unstampedCapture('you said Wednesday between 10 and 12');
    await insertCustomerCapture({ tenantId, customerId: customer.id, captureId });

    // The whole point: the promise is still unanswered. If this link counted as
    // L2 citing the capture, the planner would read "something was created from
    // this" and close the item, leaving a customer expecting somebody with
    // nothing on the calendar and nobody still asking.
    expect(await listL2CitingCapture(tenantId, [captureId])).toEqual([]);
  });

  test('a link carrying ANOTHER firm\'s tenant never reaches this customer\'s context', async () => {
    const customer = await createCustomer({ tenantId, name: 'Guarded Gina' });
    const other = await createTenant(`link-guard-${Date.now()}`);
    const captureId = await unstampedCapture('another firm\'s words entirely');

    // customer_id is an id-only foreign key: nothing in the schema stops a row
    // naming THIS customer while carrying ANOTHER tenant. Written straight over
    // pg because the accessor would have no reason to build one.
    await pg.query(
      'insert into customer_captures (tenant_id, customer_id, capture_id) values ($1, $2, $3)',
      [other.id, customer.id, captureId],
    );

    // The link exists and is readable...
    expect(await listLinkedCapturesForCustomer(customer.id)).toEqual([
      { capture_id: captureId, tenant_id: other.id },
    ]);
    // ...but the read must refuse it: the membership view re-checks the link's
    // tenant, so another firm's verbatim text is never counted here.
    const contents = (await getCustomerContents(tenantId, customer.id, 'manager'))!;
    expect(contents.customerLevel.noteCount).toBe(0);
    expect(contents.customerLevel.newest).toBeNull();

    await pg.query('delete from customer_captures where capture_id = $1', [captureId]);
    await pg.query('delete from tenants where id = $1', [other.id]);
  });

  test('getCustomerContents surfaces a customer-linked capture that has no L1 stamp', async () => {
    const customer = await createCustomer({ tenantId, name: 'Visible Vera' });
    const captureId = await unstampedCapture('the upstairs radiator is cold too');

    const before = (await getCustomerContents(tenantId, customer.id, 'manager'))!;
    expect(before.customerLevel.noteCount).toBe(0);

    await insertCustomerCapture({ tenantId, customerId: customer.id, captureId });

    // A link nothing reads would be worse than the guess it replaces: the
    // message would be filed correctly and still invisible to everyone. It has
    // no job, so it is the customer-level pile's newest.
    const after = (await getCustomerContents(tenantId, customer.id, 'manager'))!;
    expect(after.customerLevel.noteCount).toBe(1);
    expect(after.customerLevel.newest?.captureId).toBe(captureId);
  });
});
