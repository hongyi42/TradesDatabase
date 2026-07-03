import { describe, expect, test } from 'vitest';
import type { Technician, TechnicianPatch } from '../db/technicians.js';
import { sha256hex } from './badges.js';
import { buildBadgeResponse } from './badgeFile.js';

// Unit tests with stubbed rows — no DB. The live minting write is covered by
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
    created_at: '2026-07-02T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    ...over,
  };
}

// In-memory stand-ins for the two db calls buildBadgeResponse makes.
function stubs(rows: Technician[]) {
  const patches: Array<{ id: string; patch: TechnicianPatch }> = [];
  return {
    patches,
    list: async () => rows,
    update: async (id: string, patch: TechnicianPatch) => {
      patches.push({ id, patch });
      const target = rows.find((r) => r.id === id)!;
      Object.assign(target, patch);
      return target;
    },
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
    expect(s.patches).toHaveLength(1); // no re-mint write either
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
