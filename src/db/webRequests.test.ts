import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client as PgClient } from 'pg';
import { getClient } from './client.js';
import {
  countRecentWebRequests,
  isRecentSearchResultUrl,
  logWebRequests,
} from './webRequests.js';

// Window semantics need rows with back-dated created_at, which the module's
// own insert (correctly) doesn't allow — so seed those directly over pg.
const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

const backdated = (ref: string, kind: string, value: string, hoursAgo: number) =>
  pg.query(
    `insert into web_requests (tenant_id, technician_ref, kind, value, created_at)
     values ($1, $2, $3, $4, now() - ($5 || ' hours')::interval)`,
    [tenantId, ref, kind, value, String(hoursAgo)],
  );

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query("delete from web_requests where technician_ref like 'wrq-%'");
});

afterAll(async () => {
  await pg.query("delete from web_requests where technician_ref like 'wrq-%'");
  await pg.end();
});

describe('webRequests windows', () => {
  test('rate count includes only the rolling 24h window', async () => {
    await logWebRequests([
      { tenantId, technicianRef: 'wrq-rate', kind: 'search', value: 'now' },
    ]);
    await backdated('wrq-rate', 'search', 'old', 25);
    await backdated('wrq-rate', 'fetch', 'https://x.example/', 1); // other kind: excluded
    expect(await countRecentWebRequests(tenantId, 'wrq-rate', 'search')).toBe(1);
    expect(await countRecentWebRequests(tenantId, 'wrq-rate', 'fetch')).toBe(1);
  });

  test('provenance honors the 2h window, exact value, kind, and person', async () => {
    const url = 'https://supplier.example/part?sku=123';
    await logWebRequests([
      { tenantId, technicianRef: 'wrq-prov', kind: 'search_result', value: url },
    ]);
    expect(await isRecentSearchResultUrl(tenantId, 'wrq-prov', url)).toBe(true);
    // Exact-match only: a composed variant must not inherit the search tier.
    expect(await isRecentSearchResultUrl(tenantId, 'wrq-prov', `${url}&d=leak`)).toBe(false);
    // Another person's result does not vouch for this one.
    expect(await isRecentSearchResultUrl(tenantId, 'wrq-other', url)).toBe(false);
    // Stale result (3h) has aged out of the window.
    await backdated('wrq-stale', 'search_result', url, 3);
    expect(await isRecentSearchResultUrl(tenantId, 'wrq-stale', url)).toBe(false);
    // A 'fetch' row of the same value is not provenance.
    await backdated('wrq-kind', 'fetch', url, 0);
    expect(await isRecentSearchResultUrl(tenantId, 'wrq-kind', url)).toBe(false);
  });
});
