import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
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
  // state: the relay 503 test specifies an ACTIVE session-less row (invited→
  // active doesn't change seat occupancy, so the cap trigger is indifferent).
  await updateTechnician(tech.id, { host_id: host.id, sandbox_ref: 's1', state: 'active' });

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

describe('/composio relay routing', () => {
  const RELAY_SECRET = 'httpserver-relay-test-secret';
  let prevSecret: string | undefined;
  let prevKey: string | undefined;

  beforeAll(() => {
    // Not in .env.test.example — set per-process like identity.test.ts. The
    // 503 path additionally depends on COMPOSIO_API_KEY being ABSENT.
    prevSecret = process.env.GATEWAY_IDENTITY_SECRET;
    prevKey = process.env.COMPOSIO_API_KEY;
    process.env.GATEWAY_IDENTITY_SECRET = RELAY_SECRET;
    delete process.env.COMPOSIO_API_KEY;
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.GATEWAY_IDENTITY_SECRET;
    else process.env.GATEWAY_IDENTITY_SECRET = prevSecret;
    if (prevKey !== undefined) process.env.COMPOSIO_API_KEY = prevKey;
  });

  const signedHeaders = (): Record<string, string> => ({
    'x-tenant-id': tenantId,
    'x-technician-ref': 'pull-probe',
    'x-identity-signature': createHmac('sha256', RELAY_SECRET)
      .update(`${tenantId}.pull-probe`)
      .digest('hex'),
    'content-type': 'application/json',
  });

  test('no identity headers → bare 401', async () => {
    const resp = await fetch(`${base}/composio/`, { method: 'POST', body: '{}' });
    expect(resp.status).toBe(401);
    expect(await resp.text()).toBe('');
  });

  test('signed identity, roster row without a session, no key → 503 session not ready', async () => {
    const resp = await fetch(`${base}/composio/`, {
      method: 'POST',
      headers: signedHeaders(),
      body: '{}',
    });
    expect(resp.status).toBe(503);
    expect(((await resp.json()) as { error: string }).error).toBe('session not ready');
  });

  test('non-relay paths still reach the MCP handler (route ordering)', async () => {
    // The spine MCP serves every unrouted path; a valid initialize on /nope
    // must get an MCP response, not a relay error shape.
    const resp = await fetch(`${base}/nope`, {
      method: 'POST',
      headers: { ...signedHeaders(), accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'route-probe', version: '0.0.0' },
        },
      }),
    });
    expect(resp.status).toBe(200);
  });
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
