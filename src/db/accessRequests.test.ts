import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  addManagersTexted,
  closeAccessRequest,
  contextOf,
  listRecentAccessRequestsFor,
  openAccessRequest,
  requestKeyOf,
} from './accessRequests.js';
import { insertTechnician } from './technicians.js';

// The office's read of one person's requests, settled ones INCLUDED (plan
// 2026-09-22): the open-set reads cannot see a manager's "no", because a declined
// request is dismissed. Direct pg is the cleanup channel (the officeMessages.test
// convention); isolation is by this run's own rows.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
const techIds: string[] = [];
const RUN = `access-${Date.now()}`;
const CUSTOMER = '11111111-1111-4111-8111-111111111111';

async function mkTech(suffix: string): Promise<string> {
  const t = await insertTechnician({
    tenantId,
    ref: `${RUN}-${suffix}`,
    displayName: `Access Test ${suffix}`,
    seatExempt: true,
  });
  techIds.push(t.id);
  return t.id;
}

async function file(technicianId: string, wants: 'record' | 'money') {
  const requestKey = requestKeyOf({ technicianId, customerId: CUSTOMER, wants });
  const row = await openAccessRequest({
    tenantId,
    technicianId,
    context: {
      requestKey,
      technicianRef: 'x',
      technicianName: 'X',
      customerId: CUSTOMER,
      targetName: 'somebody',
      wants,
      why: 'need it',
      managersTexted: [],
    },
  });
  if (!row) throw new Error('fixture request collided');
  return row;
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
});

afterAll(async () => {
  if (techIds.length > 0) {
    await pg.query(
      "delete from observations where kind = 'access_request' and technician_id = any($1::uuid[])",
      [techIds],
    );
    await pg.query('delete from technicians where id = any($1::uuid[])', [techIds]);
  }
  await pg.end();
});

describe('listRecentAccessRequestsFor', () => {
  test("returns this person's requests, a declined one included, newest first", async () => {
    const me = await mkTech('me');
    const declined = await file(me, 'record');
    await closeAccessRequest(tenantId, declined.id, 'declined by Sam: not today');
    const waiting = await file(me, 'money');
    const rows = await listRecentAccessRequestsFor(tenantId, me, '2000-01-01T00:00:00Z');
    expect(rows.map((r) => r.id)).toEqual([waiting.id, declined.id]);
    expect(rows[1].status).toBe('dismissed');
    expect(rows[1].dismiss_reason).toBe('declined by Sam: not today');
  });

  test("another person's requests and another firm's view are never returned", async () => {
    const me = await mkTech('me2');
    const other = await mkTech('other');
    await file(other, 'record');
    expect(await listRecentAccessRequestsFor(tenantId, me, '2000-01-01T00:00:00Z')).toEqual([]);
    expect(
      await listRecentAccessRequestsFor(
        '00000000-0000-4000-8000-000000000000',
        other,
        '2000-01-01T00:00:00Z',
      ),
    ).toEqual([]);
  });
});

describe('addManagersTexted', () => {
  test('adds names to a waiting request, once each', async () => {
    const me = await mkTech('me3');
    const row = await file(me, 'record');
    const updated = await addManagersTexted(tenantId, row, ['Sam Lee', 'Sam Lee']);
    expect(contextOf(updated!).managersTexted).toEqual(['Sam Lee']);
    const again = await addManagersTexted(tenantId, updated!, ['Dana Reed']);
    expect(contextOf(again!).managersTexted).toEqual(['Sam Lee', 'Dana Reed']);
  });

  test('a stale read loses the race and changes nothing; a settled request is left alone', async () => {
    const me = await mkTech('me4');
    const row = await file(me, 'money');
    await addManagersTexted(tenantId, row, ['Sam Lee']);
    // `row` still holds the pre-update context: compare-and-set refuses it.
    expect(await addManagersTexted(tenantId, row, ['Dana Reed'])).toBeNull();
    const fresh = (await listRecentAccessRequestsFor(tenantId, me, '2000-01-01T00:00:00Z'))[0];
    await closeAccessRequest(tenantId, fresh.id, 'declined by Sam: no');
    expect(await addManagersTexted(tenantId, fresh, ['Dana Reed'])).toBeNull();
  });
});

// The office catalog's name-only search (plan 2026-09-22, final review): a phone or
// street match must not come back, and must not crowd a name match out of the cap.
describe('searchCustomersByName', () => {
  test('matches names only, commas and LIKE wildcards literally', async () => {
    const { createCustomer, searchCustomersByName } = await import('./customers.js');
    const made = [
      await createCustomer({ tenantId, name: `Smith, John ${RUN}`, phone: '555-7100' }),
      await createCustomer({ tenantId, name: `Oak Tree Cafe ${RUN}`, phone: '555-7101' }),
      await createCustomer({ tenantId, name: `Nobody ${RUN}`, phone: '555-7102', addressLine1: `12 Smith St ${RUN}` }),
    ];
    try {
      const byComma = await searchCustomersByName(tenantId, `Smith, John ${RUN}`);
      expect(byComma.map((c) => c.id)).toEqual([made[0].id]);
      // A street that matches is NOT a name match.
      const street = await searchCustomersByName(tenantId, `12 Smith St ${RUN}`);
      expect(street).toEqual([]);
      // '%' is literal, not "anything".
      expect(await searchCustomersByName(tenantId, `%${RUN}`)).toEqual([]);
    } finally {
      await pg.query('delete from customers where id = any($1::uuid[])', [made.map((c) => c.id)]);
    }
  });
});
