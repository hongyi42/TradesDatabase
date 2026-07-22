import { beforeEach, describe, expect, test } from 'vitest';
import * as rosterCache from './rosterCache.js';
import type { Technician } from '../db/index.js';

// Pure unit tests — the cache holds no DB handle, and its clock is injected, so
// the TTL is exercised by advancing a number rather than sleeping.

const tech = (ref: string): Technician =>
  ({ id: `id-${ref}`, ref, display_name: ref, tenant_id: 'tenant-a' }) as Technician;

const entry = (ref: string) => ({ tenantId: 'tenant-a', technician: tech(ref) });

beforeEach(() => {
  rosterCache.clear();
});

describe('rosterCache', () => {
  test('a stored entry is returned inside the TTL', () => {
    rosterCache.set('900000001', entry('board-mgr'), 1_000);
    expect(rosterCache.get('900000001', 1_000)).toMatchObject({
      tenantId: 'tenant-a',
      technician: { ref: 'board-mgr' },
    });
    // Still live one millisecond before expiry.
    expect(rosterCache.get('900000001', 1_000 + rosterCache.TTL_MS - 1)).toBeDefined();
  });

  test('an entry expires exactly at the TTL boundary and is evicted on read', () => {
    rosterCache.set('900000001', entry('board-mgr'), 1_000);
    // Boundary is inclusive-expired: expiresAt <= now counts as stale.
    expect(rosterCache.get('900000001', 1_000 + rosterCache.TTL_MS)).toBeUndefined();
    // Lazy expiry actually removed it rather than leaving a tombstone.
    expect(rosterCache.size()).toBe(0);
  });

  test('an unknown id is a miss', () => {
    expect(rosterCache.get('nobody', 1_000)).toBeUndefined();
  });

  test('re-setting the same id refreshes its expiry', () => {
    rosterCache.set('900000001', entry('board-mgr'), 1_000);
    rosterCache.set('900000001', entry('board-mgr'), 50_000);
    // Would have expired on the FIRST write's clock; the second write extends it.
    expect(rosterCache.get('900000001', 1_000 + rosterCache.TTL_MS + 1)).toBeDefined();
    expect(rosterCache.size()).toBe(1);
  });

  test('the size cap evicts the oldest entry, never growing past MAX_ENTRIES', () => {
    for (let i = 0; i < rosterCache.MAX_ENTRIES + 10; i += 1) {
      rosterCache.set(`user-${i}`, entry(`ref-${i}`), 1_000);
    }
    expect(rosterCache.size()).toBe(rosterCache.MAX_ENTRIES);
    // The first 10 were pushed out; the most recent survive.
    expect(rosterCache.get('user-0', 1_000)).toBeUndefined();
    expect(rosterCache.get('user-9', 1_000)).toBeUndefined();
    expect(rosterCache.get(`user-${rosterCache.MAX_ENTRIES + 9}`, 1_000)).toBeDefined();
  });

  test('clear() empties the cache', () => {
    rosterCache.set('900000001', entry('board-mgr'), 1_000);
    rosterCache.clear();
    expect(rosterCache.size()).toBe(0);
    expect(rosterCache.get('900000001', 1_000)).toBeUndefined();
  });
});
