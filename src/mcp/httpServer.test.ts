import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createHttpServer } from './httpServer.js';
import { mintBadge, sha256hex } from '../control/badges.js';
import { createHost } from '../db/hosts.js';
import { getClient } from '../db/client.js';
import { insertTechnician, updateTechnician } from '../db/technicians.js';
import { setTenantSeats } from '../db/tenants.js';

// Integration: the /control/badges pull route against the TEST project — real
// HTTP server on an ephemeral port, real DB rows, self-cleaning. The MCP and
// /inbound/ routes keep their existing coverage (identity/webhook suites).
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const HOST_NAME = 'test-host-pull-route';
let server: http.Server;
let base: string;
let tenantId: string;
let hostToken: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query('delete from hosts where name = $1', [HOST_NAME]);
  await pg.query('truncate table technicians, review_items cascade');
  await setTenantSeats(tenantId, { managerSeats: 1, technicianSeats: 2 });

  const minted = mintBadge(); // host tokens share the badge shape
  hostToken = minted.badge;
  const host = await createHost(HOST_NAME, minted.hash);
  const tech = await insertTechnician({ tenantId, ref: 'pull-probe', displayName: 'Pull Probe' });
  await updateTechnician(tech.id, { host_id: host.id, sandbox_ref: 's1' });

  server = createHttpServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((e) => (e ? reject(e) : resolve())),
  );
  await pg.query('truncate table technicians, review_items cascade');
  await pg.query('delete from hosts where name = $1', [HOST_NAME]);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

describe('GET /control/badges', () => {
  test('bad or missing token → bare 401, no detail', async () => {
    const noAuth = await fetch(`${base}/control/badges`);
    expect(noAuth.status).toBe(401);
    expect(await noAuth.text()).toBe('');

    const wrong = await fetch(`${base}/control/badges`, {
      headers: { authorization: 'Bearer deadbeef' },
    });
    expect(wrong.status).toBe(401);
  });

  test('valid token: first pull mints (plaintext once), second pull ships only the fingerprint', async () => {
    const first = await fetch(`${base}/control/badges`, {
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(first.status).toBe(200);
    const body1 = (await first.json()) as {
      badgesFile: Record<string, { technicianRef: string; revoked: boolean }>;
      newBadges: Array<{ ref: string; badge: string; sandboxRef: string | null }>;
    };
    expect(body1.newBadges).toHaveLength(1);
    expect(body1.newBadges[0]).toMatchObject({ ref: 'pull-probe', sandboxRef: 's1' });
    const hash = sha256hex(body1.newBadges[0].badge);
    expect(body1.badgesFile[hash]).toMatchObject({ technicianRef: 'pull-probe', revoked: false });

    // Cross-channel read-back: the DB holds the fingerprint, not the badge.
    const { rows } = await pg.query('select badge_hash from technicians where ref = $1', [
      'pull-probe',
    ]);
    expect(rows[0].badge_hash).toBe(hash);

    const second = await fetch(`${base}/control/badges`, {
      headers: { authorization: `Bearer ${hostToken}` },
    });
    const body2 = (await second.json()) as typeof body1;
    expect(body2.newBadges).toHaveLength(0);
    expect(body2.badgesFile[hash]).toBeDefined();
  });
});
