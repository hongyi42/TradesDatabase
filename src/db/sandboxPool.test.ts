import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createTenant, setTenantSeats } from './tenants.js';
import { createHost } from './hosts.js';
import { insertTechnician } from './technicians.js';
import {
  claimSandbox,
  getPoolRowByTechnician,
  listFreeSandboxes,
  registerSandbox,
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
  await setTenantSeats(tenantId, { managerSeats: 1, technicianSeats: 5 });
  otherTenantId = (await createTenant('sandbox-pool-other', { technicianSeats: 5 })).id;
  hostId = (await createHost('sandbox-pool-host', 'a'.repeat(64))).id;
});

afterAll(async () => {
  await pg.query('truncate table sandbox_pool, technicians cascade');
  await pg.query("delete from hosts where name = 'sandbox-pool-host'");
  await pg.query("delete from tenants where name = 'sandbox-pool-other'");
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

describe('sandbox_pool allocator', () => {
  test('listFreeSandboxes is FIFO, free-only, and tenant-scoped', async () => {
    // Two free sandboxes for our tenant (registered in order), one for another.
    const s1 = await registerSandbox({ tenantId, hostId, sandboxRef: 'pool-s1' });
    const s2 = await registerSandbox({ tenantId, hostId, sandboxRef: 'pool-s2' });
    await registerSandbox({ tenantId: otherTenantId, hostId, sandboxRef: 'pool-other' });

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
