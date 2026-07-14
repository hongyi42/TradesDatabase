import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  factSourceIds,
  foldRetractedFacts,
  isFactBundle,
  unwrapAttributes,
  type StandingFactBundle,
} from './standingFacts.js';
import {
  createCustomer,
  setCustomerAttribute,
  trySetCustomerAttribute,
} from './customers.js';
import { createJob, setJobAttribute } from './jobs.js';
import type { Json } from './database.types.js';

// Feature C+D Phase 1: wrapped standing facts — pure helpers + the CAS write.
// Integration tests against the LOCAL stack (testEnvGuard-pinned).
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
  await pg.query('truncate table customers, jobs, visits, raw_captures cascade');
  await pg.end();
});

const bundle = (over: Partial<StandingFactBundle> = {}): Json => ({
  value: 'email',
  sourceCaptureId: 'cap-1',
  recordedAt: '2026-07-14T00:00:00.000Z',
  ...over,
});

describe('standing-fact helpers (pure)', () => {
  test('isFactBundle accepts exactly the bundle shape and nothing looser', () => {
    expect(isFactBundle(bundle())).toBe(true);
    expect(isFactBundle(bundle({ value: 4321 }))).toBe(true);
    expect(isFactBundle(bundle({ value: true }))).toBe(true);
    // Plain values and near-misses are not bundles.
    expect(isFactBundle('email')).toBe(false);
    expect(isFactBundle(null)).toBe(false);
    expect(isFactBundle(['a'])).toBe(false);
    expect(isFactBundle({ value: 'x' })).toBe(false); // missing keys
    expect(isFactBundle({ ...(bundle() as object), extra: 1 } as Json)).toBe(false); // extra key
    expect(isFactBundle(bundle({ value: { nested: true } as unknown as string }))).toBe(false);
  });

  test('unwrapAttributes maps bundles to plain values and passes plain values through', () => {
    const attrs: Json = {
      prefers_contact: bundle(),
      gate_code: bundle({ value: 4321, sourceCaptureId: 'cap-2' }),
      workPerformed: 'inspected unit', // plain (visit-style) value
      dog: true,
    };
    expect(unwrapAttributes(attrs)).toEqual({
      prefers_contact: 'email',
      gate_code: 4321,
      workPerformed: 'inspected unit',
      dog: true,
    });
    expect(unwrapAttributes(null)).toEqual({});
    expect(unwrapAttributes('not an object')).toEqual({});
  });

  test('foldRetractedFacts drops only facts whose evidence is retracted — never plain values', () => {
    const attrs: Json = {
      prefers_contact: bundle({ sourceCaptureId: 'cap-retracted' }),
      gate_code: bundle({ value: 4321, sourceCaptureId: 'cap-live' }),
      workPerformed: 'inspected unit',
    };
    const folded = foldRetractedFacts(attrs, new Set(['cap-retracted']));
    expect(folded).toEqual({
      gate_code: bundle({ value: 4321, sourceCaptureId: 'cap-live' }),
      workPerformed: 'inspected unit',
    });
    // Empty set folds nothing; non-object attrs pass through untouched.
    expect(foldRetractedFacts(attrs, new Set())).toEqual(attrs);
    expect(foldRetractedFacts(null, new Set(['cap-retracted']))).toBeNull();
  });

  test('factSourceIds collects bundle capture ids only', () => {
    const attrs: Json = {
      a: bundle({ sourceCaptureId: 'cap-a' }),
      b: bundle({ sourceCaptureId: 'cap-b' }),
      plain: 'value',
    };
    expect(factSourceIds(attrs).sort()).toEqual(['cap-a', 'cap-b']);
    expect(factSourceIds({})).toEqual([]);
    expect(factSourceIds(null)).toEqual([]);
  });
});

describe('setCustomerAttribute / setJobAttribute (CAS merge)', () => {
  test('merges a new key without clobbering an existing one', async () => {
    const customer = await createCustomer({ tenantId, name: 'Merge Cust' });
    await setCustomerAttribute(customer.id, 'prefers_contact', bundle());
    const after = await setCustomerAttribute(
      customer.id,
      'gate_code',
      bundle({ value: 4321, sourceCaptureId: 'cap-2' }),
    );
    expect(after.attributes).toEqual({
      prefers_contact: bundle(),
      gate_code: bundle({ value: 4321, sourceCaptureId: 'cap-2' }),
    });
  });

  test('same-key upsert replaces the bundle (overwrite path)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Overwrite Cust' });
    await setCustomerAttribute(customer.id, 'prefers_contact', bundle({ value: 'phone' }));
    const after = await setCustomerAttribute(
      customer.id,
      'prefers_contact',
      bundle({ value: 'email', sourceCaptureId: 'cap-new' }),
    );
    expect(after.attributes).toEqual({
      prefers_contact: bundle({ value: 'email', sourceCaptureId: 'cap-new' }),
    });
  });

  test('a stale row loses the CAS (no write lands); the retry wrapper then succeeds and both keys survive', async () => {
    const customer = await createCustomer({ tenantId, name: 'CAS Cust' });
    // `customer` is now a STALE snapshot: a concurrent writer lands first.
    await setCustomerAttribute(customer.id, 'concurrent_key', bundle({ sourceCaptureId: 'cap-c' }));

    const missed = await trySetCustomerAttribute(customer, 'late_key', bundle({ sourceCaptureId: 'cap-l' }));
    expect(missed).toBeNull(); // CAS miss — updated_at moved under us
    const rows = await pg.query<{ attributes: Record<string, Json> }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(rows.rows[0].attributes.late_key).toBeUndefined(); // nothing landed
    expect(rows.rows[0].attributes.concurrent_key).toBeDefined();

    // The wrapper re-reads and retries: both writers' keys survive.
    const after = await setCustomerAttribute(customer.id, 'late_key', bundle({ sourceCaptureId: 'cap-l' }));
    expect(Object.keys(after.attributes as object).sort()).toEqual(['concurrent_key', 'late_key']);
  });

  test('a non-object attributes value is refused, never silently replaced', async () => {
    const customer = await createCustomer({ tenantId, name: 'NonObj Cust' });
    // Legal jsonb an external writer/import could leave behind.
    await pg.query(`update customers set attributes = '["vip","net-30"]'::jsonb where id = $1`, [
      customer.id,
    ]);
    await expect(setCustomerAttribute(customer.id, 'k', bundle())).rejects.toThrow(
      'not a JSON object',
    );
    // The original value survives untouched.
    const rows = await pg.query<{ attributes: unknown }>(
      'select attributes from customers where id = $1',
      [customer.id],
    );
    expect(rows.rows[0].attributes).toEqual(['vip', 'net-30']);
  });

  test('the job twin merges too and unknown ids throw not-found', async () => {
    const customer = await createCustomer({ tenantId, name: 'Job Fact Cust' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Furnace swap' });
    const after = await setJobAttribute(job.id, 'crane_needed', bundle({ value: true }));
    expect(after.attributes).toEqual({ crane_needed: bundle({ value: true }) });

    await expect(
      setJobAttribute('00000000-0000-0000-0000-000000000000', 'k', bundle()),
    ).rejects.toThrow('not found');
    await expect(
      setCustomerAttribute('00000000-0000-0000-0000-000000000000', 'k', bundle()),
    ).rejects.toThrow('not found');
  });
});
