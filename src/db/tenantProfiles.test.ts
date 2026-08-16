import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createTenant } from './tenants.js';
import {
  getTenantProfile,
  profileGaps,
  upsertTenantProfile,
  type TenantProfile,
} from './tenantProfiles.js';

// Writes via the app path (supabase-js); direct pg is the independent
// read-back channel and cleanup (moneyEvents.test.ts convention).
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  // Hermetic start: a crashed prior run skips afterAll, and a stale profile
  // row would flip the first upsert onto the update path and fail the
  // fresh-insert assertions (review finding). Same for leaked test tenants.
  await pg.query('truncate table tenant_profiles');
  await pg.query("delete from tenants where name like 'Profile Test%'");
  // BY NAME, not limit(1): an unspecified row goes nondeterministic the
  // moment any suite leaks an extra tenant (server.test.ts's own recorded
  // trap).
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  // Self-clean: profiles first (FK), then the extra tenants this file minted.
  await pg.query('truncate table tenant_profiles');
  await pg.query("delete from tenants where name like 'Profile Test%'");
  await pg.end();
});

describe('tenant_profiles — upsert patch semantics', () => {
  test('first write creates; second write patches ONLY the supplied fields', async () => {
    const created = await upsertTenantProfile(tenantId, {
      displayName: 'Hearth & Home Heating',
      city: 'Austin',
      state: 'TX',
      licenseNumbers: [{ label: 'TX TACL', number: 'TACLA12345E' }],
    });
    expect(created.display_name).toBe('Hearth & Home Heating');
    expect(created.legal_name).toBeNull();
    expect(created.license_numbers).toEqual([{ label: 'TX TACL', number: 'TACLA12345E' }]);

    const patched = await upsertTenantProfile(tenantId, { phone: '512-555-0100' });
    expect(patched.phone).toBe('512-555-0100');
    // Untouched fields survive the patch.
    expect(patched.display_name).toBe('Hearth & Home Heating');
    expect(patched.license_numbers).toEqual([{ label: 'TX TACL', number: 'TACLA12345E' }]);

    // Cross-channel read-back: the row pg sees is the row the app wrote.
    const row = await pg.query(
      // updated_at > created_at compared IN Postgres: node-postgres truncates
      // timestamptz to milliseconds, so a JS Date compare can flake when the
      // two transactions land within the same wall-clock ms (review finding).
      'select display_name, phone, license_numbers, updated_at > created_at as trigger_stamped ' +
        'from tenant_profiles where tenant_id = $1',
      [tenantId],
    );
    expect(row.rows[0].display_name).toBe('Hearth & Home Heating');
    expect(row.rows[0].phone).toBe('512-555-0100');
    expect(row.rows[0].license_numbers).toEqual([{ label: 'TX TACL', number: 'TACLA12345E' }]);
    // The DB trigger stamped the patch.
    expect(row.rows[0].trigger_stamped).toBe(true);
  });

  test('explicit null CLEARS a field; licenseNumbers clears to []', async () => {
    await upsertTenantProfile(tenantId, { displayName: 'To Clear', email: 'a@b.co' });
    const cleared = await upsertTenantProfile(tenantId, {
      displayName: null,
      licenseNumbers: null,
    });
    expect(cleared.display_name).toBeNull();
    expect(cleared.license_numbers).toEqual([]);
    expect(cleared.email).toBe('a@b.co'); // unsupplied → untouched
  });

  test('values are trimmed; empty strings are rejected, not stored or treated as clears', async () => {
    const trimmed = await upsertTenantProfile(tenantId, { legalName: '  Hearth LLC  ' });
    expect(trimmed.legal_name).toBe('Hearth LLC');
    await expect(upsertTenantProfile(tenantId, { phone: '   ' })).rejects.toThrow(
      /phone is empty — pass a value, or null to clear/,
    );
  });

  test('an empty patch is refused — nothing to change', async () => {
    await expect(upsertTenantProfile(tenantId, {})).rejects.toThrow(/nothing to change/);
  });

  test('non-string values hit an instructive runtime guard, not a TypeError', async () => {
    // The typed layer is the single write-side guard for EVERY surface, so it
    // must hold for untyped callers too — not just under tsc.
    await expect(
      upsertTenantProfile(tenantId, { phone: 5125550100 as never }),
    ).rejects.toThrow(/phone must be a string \(or null to clear it\)/);
  });

  test('state stores as the uppercase 2-letter code; full names are refused with the fix', async () => {
    const lower = await upsertTenantProfile(tenantId, { state: 'tx' });
    expect(lower.state).toBe('TX');
    await expect(upsertTenantProfile(tenantId, { state: 'Texas' })).rejects.toThrow(
      /state must be the 2-letter code \(e\.g\. TX\)/,
    );
  });

  test('licenseNumbers entries are validated strictly: blank parts and unknown keys refuse', async () => {
    await expect(
      upsertTenantProfile(tenantId, {
        licenseNumbers: [{ label: '', number: 'X1' }],
      }),
    ).rejects.toThrow(/non-empty string label and number/);
    await expect(
      upsertTenantProfile(tenantId, {
        licenseNumbers: [{ label: 'TX', number: 'X1', state: 'TX' } as never],
      }),
    ).rejects.toThrow(/unknown key/);
    // Entry values are trimmed too.
    const saved = await upsertTenantProfile(tenantId, {
      licenseNumbers: [{ label: ' CA CSLB ', number: ' 987654 ' }],
    });
    expect(saved.license_numbers).toEqual([{ label: 'CA CSLB', number: '987654' }]);
  });

  test('unknown tenant surfaces as an FK error, SQLSTATE intact', async () => {
    const err = await upsertTenantProfile('00000000-0000-0000-0000-000000000000', {
      displayName: 'Ghost',
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe('23503');
  });

  test('tenant isolation: one firm never reads another firm’s profile', async () => {
    const other = await createTenant('Profile Test Other Firm');
    await upsertTenantProfile(other.id, { displayName: 'Other Firm Plumbing' });
    await upsertTenantProfile(tenantId, { displayName: 'Main Firm HVAC' });
    expect((await getTenantProfile(tenantId))?.display_name).toBe('Main Firm HVAC');
    expect((await getTenantProfile(other.id))?.display_name).toBe('Other Firm Plumbing');
  });

  test('tenant_profiles is RLS-enabled with zero anon/authenticated privileges', async () => {
    const rls = await pg.query(
      "select relrowsecurity from pg_class where relname = 'tenant_profiles'",
    );
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const priv = await pg.query(
      `select count(*)::int as n from information_schema.table_privileges
        where table_name = 'tenant_profiles' and grantee in ('anon', 'authenticated')`,
    );
    expect(priv.rows[0].n).toBe(0);
  });
});

describe('profileGaps — names the missing invoice-header fields', () => {
  const full: TenantProfile = {
    tenant_id: 'T1',
    display_name: 'Hearth & Home Heating',
    legal_name: null,
    address_line1: '100 Main St',
    address_line2: null,
    city: 'Austin',
    state: 'TX',
    postal_code: '78701',
    phone: '512-555-0100',
    email: 'office@hearth.example',
    license_numbers: [{ label: 'TX TACL', number: 'TACLA12345E' }],
    disclosure_footer: 'Regulated by TDLR…',
    created_at: '2026-08-15T00:00:00+00:00',
    updated_at: '2026-08-15T00:00:00+00:00',
  };

  test('no profile at all → every gap, in arg-name terms', () => {
    const gaps = profileGaps(null);
    expect(gaps.length).toBe(9);
    expect(gaps.join(' ')).toContain('displayName');
    expect(gaps.join(' ')).toContain('licenseNumbers');
    expect(gaps.join(' ')).toContain('disclosureFooter');
  });

  test('a complete profile has zero gaps; addressLine2 is never one', () => {
    expect(profileGaps(full)).toEqual([]);
  });

  test('either name satisfies the business-name gap; an empty license list does not satisfy licenses', () => {
    expect(profileGaps({ ...full, display_name: null, legal_name: 'Hearth LLC' })).toEqual([]);
    const gaps = profileGaps({ ...full, license_numbers: [] });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain('licenseNumbers');
  });
});
