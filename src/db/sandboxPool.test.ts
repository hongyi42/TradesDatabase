import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createTenant, setTenantSeats } from './tenants.js';
import { createHost } from './hosts.js';
import { insertTechnician } from './technicians.js';
import {
  cancelSandboxRetirement,
  claimSandbox,
  completeSandboxRecycle,
  getPoolRowByTechnician,
  listFreeSandboxes,
  listPoolRows,
  listRetirementsForHost,
  registerSandbox,
  requestSandboxRetirement,
} from './sandboxPool.js';

// Integration against the LOCAL stack (pattern: technicians.test.ts). Exercises
// the cold-pool allocator's guards: FIFO listing, tenant scoping, and the
// claim-once CAS that stops two binds taking the same sandbox.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let otherTenantId: string;
let hostId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  // sandbox_pool FKs technicians; clear both to a known-empty baseline.
  await pg.query('truncate table sandbox_pool, technicians cascade');
  // 12: the allocator suite inserts 3 technicians, the retirement suite 5 more.
  await setTenantSeats(tenantId, { managerSeats: 1, technicianSeats: 12 });
  otherTenantId = (await createTenant('sandbox-pool-other', { technicianSeats: 5 })).id;
  hostId = (await createHost('sandbox-pool-host', 'a'.repeat(64))).id;
});

afterAll(async () => {
  await pg.query('truncate table sandbox_pool, technicians cascade');
  await pg.query("delete from hosts where name in ('sandbox-pool-host', 'ret-other-host')");
  await pg.query("delete from tenants where name = 'sandbox-pool-other'");
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

describe('sandbox_pool allocator', () => {
  test('listFreeSandboxes is FIFO, free-only, and tenant-scoped', async () => {
    // Two free sandboxes for our tenant (registered in order), one for another.
    // s1 carries a bot handle (the normal case since 2026-07-11); s2 omits it
    // (legacy row) — both round-trip.
    const s1 = await registerSandbox({
      tenantId,
      hostId,
      sandboxRef: 'pool-s1',
      botUsername: '@pools1_bot',
    });
    const s2 = await registerSandbox({ tenantId, hostId, sandboxRef: 'pool-s2' });
    await registerSandbox({ tenantId: otherTenantId, hostId, sandboxRef: 'pool-other' });
    expect(s1.bot_username).toBe('@pools1_bot');
    expect(s2.bot_username).toBeNull();

    // listPoolRows: tenant-scoped, both free and (later) claimed rows.
    const all = await listPoolRows(tenantId);
    expect(all.map((r) => r.sandbox_ref).sort()).toEqual(['pool-s1', 'pool-s2']);

    const free = await listFreeSandboxes(tenantId);
    // Only this tenant's rows, oldest-built first.
    expect(free.map((r) => r.sandbox_ref)).toEqual(['pool-s1', 'pool-s2']);

    // Claiming s1 drops it from the free list; s2 remains.
    const tech = await insertTechnician({ tenantId, ref: 'pool-tech', displayName: 'Pool Tech' });
    const claimed = await claimSandbox(s1.id, tech.id);
    expect(claimed?.technician_id).toBe(tech.id);
    expect((await listFreeSandboxes(tenantId)).map((r) => r.sandbox_ref)).toEqual(['pool-s2']);

    // getPoolRowByTechnician recovers the claim (idempotent-recovery read).
    expect((await getPoolRowByTechnician(tech.id))?.id).toBe(s1.id);
    expect(await getPoolRowByTechnician(s2.id)).toBeNull(); // a random id owns nothing
  });

  test('claimSandbox is claim-once: a second claim on the same row returns null', async () => {
    const s = await registerSandbox({ tenantId, hostId, sandboxRef: 'pool-contested' });
    const a = await insertTechnician({ tenantId, ref: 'claim-a', displayName: 'Claim A' });
    const b = await insertTechnician({ tenantId, ref: 'claim-b', displayName: 'Claim B' });

    const first = await claimSandbox(s.id, a.id);
    expect(first?.technician_id).toBe(a.id);

    // The row is no longer null → the CAS matches nothing → loser gets null and
    // the winner's claim stands (never silently overwritten).
    const second = await claimSandbox(s.id, b.id);
    expect(second).toBeNull();
    expect((await getPoolRowByTechnician(a.id))?.id).toBe(s.id);
    expect(await getPoolRowByTechnician(b.id)).toBeNull();
  });
});

describe('sandbox retirement + recycle', () => {
  test('request is idempotent, cancel clears pending only, list is host-scoped and drops retired', async () => {
    // Delete-first: a prior FAILED run skips the finally-cleanup's host delete
    // only if the process died — but be immune to leftovers regardless.
    await pg.query("delete from hosts where name = 'ret-other-host'");
    try {
      const tech = await insertTechnician({ tenantId, ref: 'ret-tech', displayName: 'Ret Tech' });
      const row = await registerSandbox({ tenantId, hostId, sandboxRef: 'ret-s1' });
      await claimSandbox(row.id, tech.id);

      // No pool row → null (a deactivation of a sandbox-less person is a no-op here).
      const loner = await insertTechnician({ tenantId, ref: 'ret-loner', displayName: 'Ret Loner' });
      expect(await requestSandboxRetirement(loner.id)).toBeNull();

      const requested = await requestSandboxRetirement(tech.id);
      expect(requested?.retire_requested_at).not.toBeNull();
      // Second request: already stamped → null, first stamp survives.
      expect(await requestSandboxRetirement(tech.id)).toBeNull();
      expect((await getPoolRowByTechnician(tech.id))?.retire_requested_at).toBe(
        requested?.retire_requested_at,
      );

      // Host-scoped working set: our row is served; another host's is not.
      const otherHost = await createHost('ret-other-host', 'b'.repeat(64));
      const otherTech = await insertTechnician({ tenantId, ref: 'ret-other', displayName: 'Ret O' });
      const otherRow = await registerSandbox({
        tenantId,
        hostId: otherHost.id,
        sandboxRef: 'ret-s1',
      });
      await claimSandbox(otherRow.id, otherTech.id);
      await requestSandboxRetirement(otherTech.id);
      expect((await listRetirementsForHost(hostId)).map((r) => r.sandbox_ref)).toEqual(['ret-s1']);
      expect((await listRetirementsForHost(hostId))[0].id).toBe(row.id);

      // Cancel (the reactivation undo): pending request cleared; second cancel null.
      const cancelled = await cancelSandboxRetirement(tech.id);
      expect(cancelled?.retire_requested_at).toBeNull();
      expect(await cancelSandboxRetirement(tech.id)).toBeNull();
      expect(await listRetirementsForHost(hostId)).toEqual([]);
    } finally {
      await pg.query("delete from sandbox_pool where sandbox_ref like 'ret-%'");
      await pg.query("delete from technicians where ref like 'ret-%'");
      await pg.query("delete from hosts where name = 'ret-other-host'");
    }
  });

  test('completeSandboxRecycle: stamps + releases the claim, registers the blank, retries idempotently, rejects the rest', async () => {
    try {
      const tech = await insertTechnician({ tenantId, ref: 'rec-tech', displayName: 'Rec Tech' });
      const old = await registerSandbox({
        tenantId,
        hostId,
        sandboxRef: 'rec-s4',
        botUsername: '@recs4_bot',
      });
      await claimSandbox(old.id, tech.id);
      await requestSandboxRetirement(tech.id);

      // Never-requested ref refused — the box cannot retire arbitrary sandboxes.
      await registerSandbox({ tenantId, hostId, sandboxRef: 'rec-unmarked' });
      await expect(
        completeSandboxRecycle({
          hostId,
          retiredSandboxRef: 'rec-unmarked',
          newSandboxRef: 'rec-s9',
          botUsername: '@recs4_bot',
        }),
      ).rejects.toThrow('not marked for retirement');

      // Happy path: old row stamped, claim moved to retired_technician_id (the
      // UNIQUE technician_id slot is released), new row registered free with
      // the tenant inherited from the retired row.
      const done = await completeSandboxRecycle({
        hostId,
        retiredSandboxRef: 'rec-s4',
        newSandboxRef: 'rec-s5',
        botUsername: '@recs4_bot',
      });
      expect(done).toMatchObject({
        retired: true,
        registered: true,
        tenantId,
        retiredTechnicianId: tech.id,
      });
      const oldAfter = (await listPoolRows(tenantId)).find((r) => r.sandbox_ref === 'rec-s4');
      expect(oldAfter?.retired_at).not.toBeNull();
      expect(oldAfter?.retired_technician_id).toBe(tech.id);
      expect(oldAfter?.technician_id).toBeNull();
      expect(await getPoolRowByTechnician(tech.id)).toBeNull(); // slot released
      // A COMPLETED retirement is out of reach for both control paths: cancel
      // has nothing to clear, and the host's retirement working set drops it.
      expect(await cancelSandboxRetirement(tech.id)).toBeNull();
      expect(
        (await listRetirementsForHost(hostId)).find((r) => r.sandbox_ref === 'rec-s4'),
      ).toBeUndefined();
      // The DESTROYED row must never look free — only the fresh blank does.
      const free = await listFreeSandboxes(tenantId);
      expect(free.find((r) => r.sandbox_ref === 'rec-s4')).toBeUndefined();
      const blank = free.find((r) => r.sandbox_ref === 'rec-s5');
      expect(blank).toMatchObject({ tenant_id: tenantId, bot_username: '@recs4_bot' });
      // ...and a direct claim on the retired row is refused too.
      expect(await claimSandbox(oldAfter!.id, tech.id)).toBeNull();

      // Retry (box lost the 200): both halves idempotent, still a 200-shaped result.
      const retry = await completeSandboxRecycle({
        hostId,
        retiredSandboxRef: 'rec-s4',
        newSandboxRef: 'rec-s5',
        botUsername: '@recs4_bot',
      });
      expect(retry).toMatchObject({
        retired: false,
        registered: false,
        retiredTechnicianId: tech.id,
      });
      expect(
        (await listFreeSandboxes(tenantId)).filter((r) => r.sandbox_ref === 'rec-s5'),
      ).toHaveLength(1);

      // The NEW ref colliding with a row that is NOT this recycle's product
      // (different bot handle) must throw, not silently under-refill the pool.
      const tech2 = await insertTechnician({ tenantId, ref: 'rec-tech2', displayName: 'Rec T2' });
      const old2 = await registerSandbox({ tenantId, hostId, sandboxRef: 'rec-s6' });
      await claimSandbox(old2.id, tech2.id);
      await requestSandboxRetirement(tech2.id);
      await expect(
        completeSandboxRecycle({
          hostId,
          retiredSandboxRef: 'rec-s6',
          newSandboxRef: 'rec-unmarked', // exists, bot_username null vs '@other_bot'
          botUsername: '@other_bot',
        }),
      ).rejects.toThrow('does not match this recycle');
    } finally {
      await pg.query("delete from sandbox_pool where sandbox_ref like 'rec-%'");
      await pg.query("delete from technicians where ref like 'rec-%'");
    }
  });
});
