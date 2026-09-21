import { afterAll, describe, expect, it } from 'vitest';
import { createTenant, getTenant, isValidTimezone, setTenantTimezone } from './tenants.js';
import { getClient } from './client.js';

// Fixtures own their rows (the eval-fixture rule): every tenant this file makes
// is named with a unique suffix and removed in afterAll, so a rerun cannot
// collide with itself or with another suite's world.
const made: string[] = [];

async function freshTenant(label: string) {
  const tenant = await createTenant(`tz-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  made.push(tenant.id);
  return tenant;
}

afterAll(async () => {
  for (const id of made) {
    await getClient().from('tenants').delete().eq('id', id);
  }
});

describe('isValidTimezone', () => {
  it('accepts IANA names', () => {
    for (const tz of ['America/Chicago', 'America/New_York', 'America/Phoenix', 'America/Denver', 'Europe/Berlin']) {
      expect(isValidTimezone(tz), tz).toBe(true);
    }
  });

  it('refuses city names, typos and empties', () => {
    for (const bad of ['Central', 'central time', 'Austin', 'America/Chicgo', '', '   ']) {
      expect(isValidTimezone(bad), bad).toBe(false);
    }
  });

  // THE REASON A try/catch AROUND Intl IS NOT ENOUGH. Node 24 accepts every one
  // of these, and 'EST', 'MST' and 'HST' are fixed-offset zones that never
  // observe DST — a New York firm set to 'EST' reads an hour wrong all summer,
  // silently. They are also the strings Postgres resolves through
  // pg_timezone_abbrevs rather than as zones, so they diverge across the two
  // runtimes that both read this column.
  it('refuses abbreviations and legacy aliases that Intl itself would accept', () => {
    for (const bad of ['CST', 'EST', 'MST', 'HST', 'PST', 'US/Central', 'CST6CDT', 'EST5EDT', 'Etc/GMT+6']) {
      expect(new Intl.DateTimeFormat(undefined, { timeZone: bad }), bad).toBeDefined();
      expect(isValidTimezone(bad), bad).toBe(false);
    }
  });

  // 'UTC' is a real zone and is still refused: no trades firm is in it, and
  // admitting it reopens the case for 'EST'. Read-side fallbacks default to
  // 'UTC' for a MISSING tenant, which is a different thing.
  it('refuses UTC', () => {
    expect(isValidTimezone('UTC')).toBe(false);
  });

  it('is case-sensitive and does not trim', () => {
    expect(isValidTimezone('america/chicago')).toBe(false);
    expect(isValidTimezone(' America/Chicago')).toBe(false);
    expect(isValidTimezone('America/Chicago ')).toBe(false);
  });
});

describe('setTenantTimezone', () => {
  it('writes the zone and returns the updated row', async () => {
    const tenant = await freshTenant('write');
    // The default is what made this tool necessary: every firm outside it read
    // every date wrong, silently.
    expect(tenant.timezone).toBe('America/Los_Angeles');

    const updated = await setTenantTimezone(tenant.id, 'America/Chicago');
    expect(updated.timezone).toBe('America/Chicago');

    // Read back through a separate call, not the update's own return value.
    expect((await getTenant(tenant.id))?.timezone).toBe('America/Chicago');
  });

  it('leaves other tenants untouched', async () => {
    const a = await freshTenant('iso-a');
    const b = await freshTenant('iso-b');
    await setTenantTimezone(a.id, 'America/New_York');
    expect((await getTenant(a.id))?.timezone).toBe('America/New_York');
    expect((await getTenant(b.id))?.timezone).toBe('America/Los_Angeles');
  });

  it('throws when the tenant does not exist', async () => {
    await expect(
      setTenantTimezone('00000000-0000-0000-0000-000000000000', 'America/Chicago'),
    ).rejects.toThrow(/setTenantTimezone failed/);
  });
});
