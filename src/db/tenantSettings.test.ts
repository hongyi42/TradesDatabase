import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { getTenantSettings, patchTenantSettings, resolveSettings } from './tenantSettings.js';
// Imported from WATCHERS, not from the module under test, and deliberately: the
// declarations moved down into src/db/ and watchers.ts now re-exports them, so
// this is what pins the whole chain — the fallback resolveSettings hands out IS
// the constant every existing call-site still reads.
import {
  LOOKBACK_HOURS,
  MAX_NEW_ITEMS_PER_TENANT_TICK,
  OVERDUE_HOURS,
} from '../jobs/watchers.js';

// Writes via the app path (supabase-js); direct pg is the independent read-back
// channel and cleanup (the tenantProfiles.test.ts convention).
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  // Hermetic start: a crashed prior run skips afterAll, and a stale row would
  // flip the first upsert onto the update path and fail the fresh-insert
  // assertions (the tenantProfiles review finding).
  await pg.query('truncate table tenant_settings');
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query('truncate table tenant_settings');
  await pg.end();
});

describe('tenant_settings — upsert patch semantics', () => {
  test('first write creates; second write patches ONLY the supplied fields', async () => {
    const created = await patchTenantSettings(tenantId, {
      overdueHours: 6,
      lookbackHours: 24,
      approxWorkStartHour: 8,
      approxWorkEndHour: 16,
    });
    expect(created.overdue_hours).toBe(6);
    expect(created.lookback_hours).toBe(24);
    expect(created.max_new_per_tick).toBeNull();

    const patched = await patchTenantSettings(tenantId, { maxNewPerTick: 2 });
    expect(patched.max_new_per_tick).toBe(2);
    // Untouched by a patch that never named them.
    expect(patched.overdue_hours).toBe(6);
    expect(patched.lookback_hours).toBe(24);
    expect(patched.approx_work_start_hour).toBe(8);
    expect(patched.approx_work_end_hour).toBe(16);

    // Independent channel: the row itself, not the returned projection.
    const { rows } = await pg.query(
      'select overdue_hours, lookback_hours, max_new_per_tick from tenant_settings where tenant_id = $1',
      [tenantId],
    );
    expect(rows[0]).toEqual({ overdue_hours: 6, lookback_hours: 24, max_new_per_tick: 2 });
  });

  test('explicit null CLEARS one field without touching its neighbours', async () => {
    await patchTenantSettings(tenantId, { overdueHours: 9, lookbackHours: 48 });
    const cleared = await patchTenantSettings(tenantId, { overdueHours: null });
    expect(cleared.overdue_hours).toBeNull();
    expect(cleared.lookback_hours).toBe(48);
    // …and a cleared field resolves back to the global default, which is the
    // whole point of nullable columns.
    expect(resolveSettings(cleared).overdueHours).toBe(OVERDUE_HOURS);
  });

  test('a patch that names nothing is refused rather than writing an empty row', async () => {
    await expect(patchTenantSettings(tenantId, {})).rejects.toThrow(/nothing to change/);
  });

  test('a non-integer is refused by this layer with an instructive message', async () => {
    await expect(patchTenantSettings(tenantId, { overdueHours: 2.5 })).rejects.toThrow(
      /whole number/,
    );
  });

  test('naming BOTH hours in one call with start >= end is refused, not silently dropped', async () => {
    // No CHECK constraint can express a two-column rule, and resolveSettings
    // would discard the pair — so without this the write would be accepted and
    // echoed back as saved while every reader ignored it.
    await expect(
      patchTenantSettings(tenantId, { approxWorkStartHour: 18, approxWorkEndHour: 9 }),
    ).rejects.toThrow(/must be before/);
    await expect(
      patchTenantSettings(tenantId, { approxWorkStartHour: 9, approxWorkEndHour: 9 }),
    ).rejects.toThrow(/must be before/);
    // …but naming only ONE bound is still allowed: the pair may legitimately be
    // assembled across two calls, and resolveSettings handles the interim.
    const half = await patchTenantSettings(tenantId, { approxWorkStartHour: 18 });
    expect(half.approx_work_start_hour).toBe(18);
    await patchTenantSettings(tenantId, { approxWorkStartHour: null, approxWorkEndHour: null });
  });

  test('getTenantSettings returns null for a firm that has recorded nothing', async () => {
    await pg.query('truncate table tenant_settings');
    expect(await getTenantSettings(tenantId)).toBeNull();
  });
});

describe('tenant_settings — the CHECK constraints are real', () => {
  // The app layer deliberately does NOT duplicate the ranges (one rule, one
  // place), so these assert the table itself refuses them.
  test('approx_work_end_hour = 0 is rejected', async () => {
    await expect(patchTenantSettings(tenantId, { approxWorkEndHour: 0 })).rejects.toThrow(
      /approx_work_end_hour/,
    );
  });

  test('a negative overdue_hours is rejected', async () => {
    await expect(patchTenantSettings(tenantId, { overdueHours: -1 })).rejects.toThrow(
      /overdue_hours/,
    );
  });

  test('approx_work_start_hour = 24 is rejected (0-23, an hour-of-day)', async () => {
    await expect(patchTenantSettings(tenantId, { approxWorkStartHour: 24 })).rejects.toThrow(
      /approx_work_start_hour/,
    );
  });
});

describe('resolveSettings — the defaults live in exactly one place', () => {
  test('no row at all resolves to today’s constants, and hours stay UNKNOWN', () => {
    // Asserted against the IMPORTED constants, never copied literals: a future
    // retune of OVERDUE_HOURS must not need this test edited, and must not be
    // able to drift from what resolveSettings hands out.
    expect(resolveSettings(null)).toEqual({
      approxWorkStartHour: null,
      approxWorkEndHour: null,
      overdueHours: OVERDUE_HOURS,
      lookbackHours: LOOKBACK_HOURS,
      maxNewPerTick: MAX_NEW_ITEMS_PER_TENANT_TICK,
    });
  });

  test('a row with every column null is identical to no row', () => {
    const empty = {
      tenant_id: tenantId,
      approx_work_start_hour: null,
      approx_work_end_hour: null,
      overdue_hours: null,
      lookback_hours: null,
      max_new_per_tick: null,
      created_at: '2026-08-29T00:00:00Z',
      updated_at: '2026-08-29T00:00:00Z',
    };
    expect(resolveSettings(empty)).toEqual(resolveSettings(null));
  });

  test('recorded values win, field by field', () => {
    const row = {
      tenant_id: tenantId,
      approx_work_start_hour: 6,
      approx_work_end_hour: 22,
      overdue_hours: 1,
      lookback_hours: null,
      max_new_per_tick: 99,
      created_at: '2026-08-29T00:00:00Z',
      updated_at: '2026-08-29T00:00:00Z',
    };
    expect(resolveSettings(row)).toEqual({
      approxWorkStartHour: 6,
      approxWorkEndHour: 22,
      overdueHours: 1,
      lookbackHours: LOOKBACK_HOURS, // the one it did not record
      maxNewPerTick: 99,
    });
  });

  test('HALF a window is no window — one bound alone normalises to unknown', () => {
    // Unset must never mean "think less about this firm", so an incoherent pair
    // has to collapse to null here rather than define a broken window
    // downstream. Both directions.
    const base = {
      tenant_id: tenantId,
      overdue_hours: null,
      lookback_hours: null,
      max_new_per_tick: null,
      created_at: '2026-08-29T00:00:00Z',
      updated_at: '2026-08-29T00:00:00Z',
    };
    const startOnly = resolveSettings({ ...base, approx_work_start_hour: 8, approx_work_end_hour: null });
    expect([startOnly.approxWorkStartHour, startOnly.approxWorkEndHour]).toEqual([null, null]);
    const endOnly = resolveSettings({ ...base, approx_work_start_hour: null, approx_work_end_hour: 17 });
    expect([endOnly.approxWorkStartHour, endOnly.approxWorkEndHour]).toEqual([null, null]);
  });

  test('a pair that is not a forward daytime span normalises to unknown', () => {
    // The per-column CHECKs cannot catch start >= end — 22..6 passes both and
    // describes nothing this build knows how to read.
    const row = {
      tenant_id: tenantId,
      approx_work_start_hour: 22,
      approx_work_end_hour: 6,
      overdue_hours: null,
      lookback_hours: null,
      max_new_per_tick: null,
      created_at: '2026-08-29T00:00:00Z',
      updated_at: '2026-08-29T00:00:00Z',
    };
    const r = resolveSettings(row);
    expect([r.approxWorkStartHour, r.approxWorkEndHour]).toEqual([null, null]);
  });
});
