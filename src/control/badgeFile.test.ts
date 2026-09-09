import { describe, expect, test } from 'vitest';
import type { Technician } from '../db/technicians.js';
import type { SandboxPoolRow } from '../db/sandboxPool.js';
import { sha256hex } from './badges.js';
import { buildBadgeResponse } from './badgeFile.js';

// Unit tests with stubbed rows â€” no DB. The live minting write is covered by
// the httpServer integration test.
const HOST = 'host-1';

function row(over: Partial<Technician>): Technician {
  return {
    id: 'row-1',
    tenant_id: 'tenant-1',
    ref: 'tech-test',
    display_name: 'Tech Test',
    tier: 'technician',
    state: 'active',
    sandbox_ref: null,
    composio_connected_account_id: null,
    composio_trigger_id: null,
    connected_email: null,
    badge_hash: null,
    host_id: HOST,
    offboarding_started_at: null,
    link_issued_at: null,
    composio_session_id: null,
    availability: null,
    service_cities: [],
    telegram_user_id: null,
    seat_exempt: false,
    skills: [],
    created_at: '2026-07-02T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    ...over,
  };
}

// Pool-row stand-in for the retirements dep (only sandbox_ref is read).
function poolRow(over: Partial<SandboxPoolRow>): SandboxPoolRow {
  return {
    id: 'pool-1',
    tenant_id: 'tenant-1',
    host_id: HOST,
    sandbox_ref: 's1',
    technician_id: null,
    bot_username: null,
    bot_id: null,
    retire_requested_at: '2026-07-12T00:00:00.000Z',
    retired_at: null,
    retired_technician_id: null,
    created_at: '2026-07-11T00:00:00.000Z',
    ...over,
  };
}

// In-memory stand-ins for the three db calls buildBadgeResponse makes. claim
// mirrors claimBadgeHash's write-if-still-null contract; failIds simulates a
// transient DB error for specific rows. listRetirements defaults empty — the
// live default would hit the DB with this file's fake host id.
function stubs(
  rows: Technician[],
  opts: { failIds?: string[]; retirements?: SandboxPoolRow[] } = {},
) {
  const claims: Array<{ id: string; hash: string }> = [];
  return {
    claims,
    list: async () => rows,
    claim: async (id: string, hash: string) => {
      if (opts.failIds?.includes(id)) throw new Error('transient db blip');
      claims.push({ id, hash });
      const target = rows.find((r) => r.id === id)!;
      if (target.badge_hash) return null; // another pull already minted
      target.badge_hash = hash;
      return target;
    },
    listRetirements: async () => opts.retirements ?? [],
  };
}

describe('buildBadgeResponse', () => {
  test('mints once for an unbadged active row; second pull returns only the hash entry', async () => {
    const rows = [row({ id: 'a', ref: 'jane-doe', sandbox_ref: 's3' })];
    const s = stubs(rows);

    const first = await buildBadgeResponse(HOST, s);
    expect(first.newBadges).toHaveLength(1);
    const { badge } = first.newBadges[0];
    expect(first.newBadges[0]).toMatchObject({ ref: 'jane-doe', sandboxRef: 's3' });
    // The file is keyed by the badge's fingerprint, never the plaintext.
    const hash = sha256hex(badge);
    expect(first.badgesFile[hash]).toMatchObject({ technicianRef: 'jane-doe', revoked: false });
    expect(Object.keys(first.badgesFile)).not.toContain(badge);

    const second = await buildBadgeResponse(HOST, s);
    expect(second.newBadges).toHaveLength(0); // plaintext existed exactly once
    expect(second.badgesFile[hash]).toBeDefined();
    expect(s.claims).toHaveLength(1); // no re-mint write either
  });

  test('one failing row is isolated; earlier rows still deliver their plaintext', async () => {
    const rows = [
      row({ id: 'ok-1', ref: 'first-fine' }),
      row({ id: 'bad', ref: 'blips' }),
      row({ id: 'ok-2', ref: 'also-fine' }),
    ];
    const s = stubs(rows, { failIds: ['bad'] });
    const result = await buildBadgeResponse(HOST, s);
    // Without isolation the whole pull 500s and rows minted before the failure
    // lose their only plaintext copy (review finding).
    expect(result.newBadges.map((b) => b.ref)).toEqual(['first-fine', 'also-fine']);
    expect(Object.keys(result.badgesFile)).toHaveLength(2); // 'blips' mints next pull
  });

  test('overlapping pulls cannot double-mint: the loser ships nothing and self-heals next pull', async () => {
    const winner = 'c'.repeat(64);
    const snapshot = row({ id: 'a', ref: 'contested' }); // loser's stale read: badge_hash null
    let dbHash: string | null = null;
    const claim = async (_id: string, hash: string) => {
      if (dbHash) return null; // the concurrent pull's write landed first
      dbHash = hash;
      return row({ id: 'a', ref: 'contested', badge_hash: hash });
    };
    dbHash = winner; // winner already minted between the loser's list and claim
    const lost = await buildBadgeResponse(HOST, {
      list: async () => [snapshot],
      claim,
      listRetirements: async () => [],
    });
    expect(lost.newBadges).toHaveLength(0); // loser hands out NO plaintextâ€¦
    expect(Object.keys(lost.badgesFile)).toHaveLength(0); // â€¦and no stale-guess entry

    // The next pull lists the winner's hash from the DB and ships it normally.
    const healed = await buildBadgeResponse(HOST, {
      list: async () => [row({ id: 'a', ref: 'contested', badge_hash: winner })],
      claim,
      listRetirements: async () => [],
    });
    expect(healed.newBadges).toHaveLength(0);
    expect(healed.badgesFile[winner]).toMatchObject({ technicianRef: 'contested' });
  });

  test('offboarding row WITH a badge ships revoked; never-minted inactive row is omitted (no "null" key)', async () => {
    const badged = 'b'.repeat(64);
    const result = await buildBadgeResponse(
      HOST,
      stubs([
        row({ id: 'a', ref: 'gone-badged', state: 'offboarding', badge_hash: badged }),
        row({ id: 'b', ref: 'gone-unbadged', state: 'offboarded', badge_hash: null }),
      ]),
    );
    expect(result.newBadges).toHaveLength(0); // inactive rows never mint
    expect(result.badgesFile[badged]).toMatchObject({ technicianRef: 'gone-badged', revoked: true });
    expect(Object.keys(result.badgesFile)).toHaveLength(1);
    expect(result.badgesFile).not.toHaveProperty('null');
  });

  test('invited/pending rows mint too (badge ready before the person goes active)', async () => {
    const result = await buildBadgeResponse(
      HOST,
      stubs([row({ id: 'a', ref: 'new-hire', state: 'invited' })]),
    );
    expect(result.newBadges).toHaveLength(1);
    expect(Object.values(result.badgesFile)[0]).toMatchObject({
      technicianRef: 'new-hire',
      revoked: false,
    });
  });
});

describe('buildBadgeResponse bindings (Feature A)', () => {
  test('active row with a sandbox + telegram id ships a binding, alongside its minted badge', async () => {
    const rows = [
      row({ id: 'a', ref: 'jane-doe', sandbox_ref: 's3', telegram_user_id: '12345678' }),
    ];
    const result = await buildBadgeResponse(HOST, stubs(rows));
    expect(result.bindings).toEqual([
      { ref: 'jane-doe', sandboxRef: 's3', telegramUserId: '12345678' },
    ]);
    // The binding rides the SAME pull as a freshly minted badge (independent paths).
    expect(result.newBadges).toHaveLength(1);
  });

  test('an already-badged active row still ships its binding (no mint this pull)', async () => {
    // The "didn't mint because a badge already exists" path — proves the binding
    // is independent of the mint flow, not just co-emitted with a fresh badge.
    const result = await buildBadgeResponse(
      HOST,
      stubs([
        row({
          id: 'a',
          ref: 'settled',
          sandbox_ref: 's5',
          telegram_user_id: '999',
          badge_hash: 'd'.repeat(64),
        }),
      ]),
    );
    expect(result.newBadges).toHaveLength(0); // nothing minted…
    expect(result.bindings).toEqual([
      { ref: 'settled', sandboxRef: 's5', telegramUserId: '999' }, // …binding still ships
    ]);
  });

  test('inactive rows and rows missing sandbox_ref or telegram_user_id ship no binding', async () => {
    const result = await buildBadgeResponse(
      HOST,
      stubs([
        // Inactive: never bound, even with both fields set + a badge.
        row({
          id: 'a',
          ref: 'gone',
          state: 'offboarding',
          sandbox_ref: 's1',
          telegram_user_id: '111',
          badge_hash: 'a'.repeat(64),
        }),
        // Active but no sandbox yet (unassigned) → nothing to bind.
        row({ id: 'b', ref: 'no-sandbox', sandbox_ref: null, telegram_user_id: '222' }),
        // Active with a sandbox but no telegram id → not bound yet.
        row({ id: 'c', ref: 'no-tg', sandbox_ref: 's2', telegram_user_id: null }),
      ]),
    );
    expect(result.bindings).toEqual([]);
  });
});

describe('buildBadgeResponse retirements (recycler)', () => {
  test('pending retirements ride the pull as {sandboxRef}, independent of the roster loop', async () => {
    // No roster rows at all — a retired-then-released sandbox has no roster
    // echo, so retirements must not depend on the badge/binding loop.
    const result = await buildBadgeResponse(
      HOST,
      stubs([], {
        retirements: [
          poolRow({ id: 'p1', sandbox_ref: 's4' }),
          poolRow({ id: 'p2', sandbox_ref: 's7' }),
        ],
      }),
    );
    expect(result.retirements).toEqual([{ sandboxRef: 's4' }, { sandboxRef: 's7' }]);
  });

  test('no pending retirements → empty array (key always present for the box)', async () => {
    const result = await buildBadgeResponse(HOST, stubs([row({ id: 'a' })]));
    expect(result.retirements).toEqual([]);
  });
});
