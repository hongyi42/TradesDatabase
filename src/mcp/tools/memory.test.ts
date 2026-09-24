import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client as PgClient } from 'pg';
import { getClient } from '../../db/client.js';
import { setTenantSeats } from '../../db/tenants.js';
import { insertTechnician, setTechnicianState } from '../../db/technicians.js';
import { dispatchForIdentity } from '../server.js';

// The seat-memory tools through the REAL hub (dispatchForIdentity), because the
// manager gate lives there (ADMIN_TOOL_NAMES), not in the handlers: calling a
// handler directly would never show the refusal (plan review finding).
const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
const MGR = 'memtest-manager';
const TECH = 'memtest-tech';

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').eq('name', 'Default Tenant').single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  // A manager holds a real seat (no_seat_exempt_managers), so the cap is raised
  // for the suite and restored after — the server.test.ts pattern.
  await setTenantSeats(tenantId, { managerSeats: 6, technicianSeats: 8 });
  for (const [ref, tier] of [[MGR, 'manager'], [TECH, 'technician']] as const) {
    await pg.query('delete from technicians where tenant_id = $1 and ref = $2', [tenantId, ref]);
    const row = await insertTechnician({ tenantId, ref, displayName: ref, tier });
    await setTechnicianState(row.id, 'active');
  }
});

afterAll(async () => {
  await pg.query('delete from seat_memory where tenant_id = $1 and technician_ref = any($2)', [tenantId, [MGR, TECH]]);
  await pg.query('delete from seat_memory_versions where tenant_id = $1 and technician_ref = any($2)', [tenantId, [MGR, TECH]]);
  await pg.query('delete from technicians where tenant_id = $1 and ref = any($2)', [tenantId, [MGR, TECH]]);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

const call = (ref: string, name: string, args: Record<string, unknown>) =>
  dispatchForIdentity(name, args, { tenantId, technicianRef: ref });

describe('list/read/write_my_memory', () => {
  test('a manager writes, reads back, lists, and deletes their own note', async () => {
    expect(await call(MGR, 'write_my_memory', { path: 'prefs.md', content: 'Due in 14 days.' })).toMatchObject({ action: 'saved' });
    expect(await call(MGR, 'read_my_memory', { path: 'prefs.md' })).toMatchObject({ exists: true, content: 'Due in 14 days.' });
    expect(await call(MGR, 'list_my_memory', {})).toMatchObject({ paths: ['prefs.md'] });
    // Written under the caller's own ref — checked on an independent channel.
    const rows = await pg.query('select technician_ref from seat_memory where tenant_id = $1 and path = $2', [tenantId, 'prefs.md']);
    expect(rows.rows.map((r) => r.technician_ref)).toContain(MGR);
    expect(await call(MGR, 'write_my_memory', { path: 'prefs.md', content: '  ' })).toMatchObject({ action: 'deleted' });
    expect(await call(MGR, 'read_my_memory', { path: 'prefs.md' })).toMatchObject({ exists: false });
  });

  test('a technician is refused at the hub and nothing lands', async () => {
    await expect(call(TECH, 'write_my_memory', { path: 'x.md', content: 'nope' })).rejects.toThrow(/manager/i);
    await expect(call(TECH, 'list_my_memory', {})).rejects.toThrow(/manager/i);
    const n = await pg.query('select count(*)::int n from seat_memory where tenant_id = $1 and technician_ref = $2', [tenantId, TECH]);
    expect(n.rows[0].n).toBe(0);
  });

  test('bad paths and non-text content are refused in words', async () => {
    await expect(call(MGR, 'write_my_memory', { path: '../x.md', content: 'a' })).rejects.toThrow(/\.\./);
    await expect(call(MGR, 'write_my_memory', { path: 'Prefs.txt', content: 'a' })).rejects.toThrow(/not a usable path/);
    await expect(call(MGR, 'write_my_memory', { path: 'p.md', content: ['a'] })).rejects.toThrow(/content must be text/);
  });
});
