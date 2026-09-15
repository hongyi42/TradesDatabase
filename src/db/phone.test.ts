import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createCustomer, searchCustomers } from './customers.js';
import { createTenant } from './tenants.js';
import { phoneKey } from './phone.js';

// phoneKey is the TypeScript twin of the generated column customers.phone_key
// (20260916130100_customers_phone_key). The lookup computes the key in code and
// compares it to the key Postgres computed, so the two rules must never drift:
// the parity test runs every case through BOTH and demands the same answer.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

const CASES: Array<[string | null, string | null]> = [
  ['(206) 555-0170', '2065550170'],
  ['206.555.0170', '2065550170'],
  ['206-555-0170', '2065550170'],
  ['+1 206-555-0170', '2065550170'],
  ['12065550170', '2065550170'],
  ['+12065550170', '2065550170'],
  // No area code: kept as its 7 digits. Guessing one could name the wrong person.
  ['555-0142', '5550142'],
  // 11 digits NOT starting with 1, and 12+ digits: kept whole (not a US +1).
  ['22065550170', '22065550170'],
  ['+44 20 7946 0958 12', '442079460958' + '12'],
  // Fewer than 7 digits is not a phone number.
  ['555-014', null],
  ['555-nobody-has-this', null],
  ['', null],
  [null, null],
  // Fullwidth digits: Postgres `\D` would keep them, JS `\D` strips them. The
  // column uses [^0-9], so both sides agree the string holds no phone.
  ['２０６５５５０１７０', null],
];

beforeAll(async () => {
  await pg.connect();
  // A throwaway tenant, so parity rows never meet another suite's phone fixtures.
  tenantId = (await createTenant(`phone-key-${Date.now()}`, { technicianSeats: 1 })).id;
});

afterAll(async () => {
  await pg.query('delete from customers where tenant_id = $1', [tenantId]);
  await pg.query('delete from tenants where id = $1', [tenantId]);
  await pg.end();
});

describe('phoneKey', () => {
  test.each(CASES)('phoneKey(%j) is %j', (raw, key) => {
    expect(phoneKey(raw)).toBe(key);
  });

  test('the generated column computes the same key for every case', async () => {
    for (const [raw] of CASES) {
      const c = await createCustomer({ tenantId, name: `Parity ${raw}`, phone: raw });
      const { rows } = await pg.query<{ phone_key: string | null }>(
        'select phone_key from customers where id = $1',
        [c.id],
      );
      expect(rows[0].phone_key, `column vs code for ${JSON.stringify(raw)}`).toBe(phoneKey(raw));
    }
  });

  test('find_customer search reaches a stored number by any spelling of it', async () => {
    const stored = await createCustomer({ tenantId, name: 'Searchable Sue', phone: '206-555-0199' });
    for (const q of ['206 555 0199', '+1 206 555 0199', '(206) 555-0199']) {
      const hits = await searchCustomers(tenantId, q);
      expect(hits.map((h) => h.id), q).toContain(stored.id);
    }
  });

  test('an address with a house number does not turn into a phone search', async () => {
    const onElm = await createCustomer({ tenantId, name: 'Elm Ed', addressLine1: '2065 Elm St' });
    const phoneOnly = await createCustomer({ tenantId, name: 'Area Al', phone: '206-512-3456' });
    const hits = (await searchCustomers(tenantId, '2065 Elm St')).map((h) => h.id);
    expect(hits).toContain(onElm.id);
    expect(hits).not.toContain(phoneOnly.id);
  });
});
