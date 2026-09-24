import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// MANDATORY, not tidiness. The /control/ops block below posts down/ok
// repeatedly, and since 2026-09-17 an ops alert is QUEUED as a person_push and
// delivered by the box through the operator's own assistant. Unstubbed, these
// tests would file real rows that a live box would then text to a real phone.
//
// PARTIAL mock, via importOriginal: this is an integration suite that needs the
// rest of src/db for real, so exactly two exports are replaced — the queue
// write (so nothing is filed) and the roster lookup (so the notifier resolves an
// operator without this suite having to seed one). Everything else is genuine.
//
// Stubbed BEFORE createHttpServer is imported. Precedent: src/calls/notify.test.ts.
vi.mock('../db/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/index.js')>()),
  queuePersonPush: vi.fn(async () => ({}) as never),
  findRosterByTelegramUserIdGlobal: vi.fn(async () => ({
    technician: { id: 'tech-ops', tenant_id: 'tenant-ops' },
  })) as never,
}));

import { createHmac } from 'node:crypto';
import { queuePersonPush } from '../db/index.js';
import { Client } from 'pg';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createHttpServer, hangUpSignal } from './httpServer.js';
import { EventEmitter } from 'node:events';
import { mintBadge, sha256hex } from '../control/badges.js';
import { createHost } from '../db/hosts.js';
import { getClient } from '../db/client.js';
import { insertTechnician, updateTechnician } from '../db/technicians.js';
import {
  claimSandbox,
  registerSandbox,
  requestSandboxRetirement,
} from '../db/sandboxPool.js';
import { setTenantSeats } from '../db/tenants.js';
import { createSeat } from '../db/seats.js';
import { fetchWhoami } from '../seatGlue/whoami.js';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

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

describe('GET /health', () => {
  test('unauthenticated liveness: 200 with a real DB round-trip and the running commit', async () => {
    const prev = process.env.RENDER_GIT_COMMIT;
    process.env.RENDER_GIT_COMMIT = 'abc1234';
    try {
      // No auth header, and it must answer ahead of the IP allowlist.
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string; commit: string; checks: { db: string } };
      expect(body.status).toBe('ok');
      expect(body.checks.db).toBe('ok'); // a real select against the local stack ran
      expect(body.commit).toBe('abc1234'); // deploy provenance: the running SHA is curl-able
    } finally {
      if (prev === undefined) delete process.env.RENDER_GIT_COMMIT;
      else process.env.RENDER_GIT_COMMIT = prev;
    }
  });

  test('commit falls back to "unknown" when RENDER_GIT_COMMIT is unset', async () => {
    const prev = process.env.RENDER_GIT_COMMIT;
    delete process.env.RENDER_GIT_COMMIT;
    try {
      const res = await fetch(`${base}/health`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { commit: string }).commit).toBe('unknown');
    } finally {
      if (prev !== undefined) process.env.RENDER_GIT_COMMIT = prev;
    }
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

  test('a Telegram-bound active row ships its binding in the pull payload', async () => {
    // pull-probe is active with sandbox_ref 's1' (beforeAll). Bind a Telegram id
    // directly in the DB (independent of the bind_telegram tool) and confirm it
    // rides the authenticated pull — HTTP → DB, a second channel.
    await pg.query("update technicians set telegram_user_id = '55501234' where ref = 'pull-probe'");
    const res = await fetch(`${base}/control/badges`, {
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      bindings: Array<{ ref: string; sandboxRef: string; telegramUserId: string }>;
    };
    expect(body.bindings).toContainEqual({
      ref: 'pull-probe',
      sandboxRef: 's1',
      telegramUserId: '55501234',
    });
  });
});

describe('POST /control/sandboxes (recycle-completion report)', () => {
  const pull = () =>
    fetch(`${base}/control/badges`, { headers: { authorization: `Bearer ${hostToken}` } }).then(
      (r) => r.json() as Promise<{ retirements: Array<{ sandboxRef: string }> }>,
    );
  const report = (body: unknown, token = hostToken) =>
    fetch(`${base}/control/sandboxes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  test('auth + validation: bad token 401; malformed body / bad handle 400; unmarked ref 409', async () => {
    const noAuth = await fetch(`${base}/control/sandboxes`, { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.text()).toBe('');
    expect((await report({}, 'deadbeef')).status).toBe(401);

    expect((await report('not json {{{')).status).toBe(400);
    expect((await report({ retiredSandboxRef: 'x' })).status).toBe(400); // newSandboxRef missing
    expect(
      (await report({ retiredSandboxRef: 'x', newSandboxRef: 'y', botUsername: 'nope' })).status,
    ).toBe(400); // handle must be @word — same contract as assign-host.mjs

    // An existing pool row that was never marked for retirement → 409 conflict.
    const host = await getHostId();
    await registerSandbox({ tenantId, hostId: host, sandboxRef: 'rep-unmarked' });
    const conflict = await report({
      retiredSandboxRef: 'rep-unmarked',
      newSandboxRef: 'rep-new',
      botUsername: null,
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: string }).error).toContain(
      'not marked for retirement',
    );
  });

  test('full loop over real HTTP: retirement rides the GET, POST completes it, GET drops it, blank is free, roster cleared', async () => {
    const host = await getHostId();
    const tech = await insertTechnician({ tenantId, ref: 'rep-probe', displayName: 'Rep Probe' });
    const old = await registerSandbox({
      tenantId,
      hostId: host,
      sandboxRef: 'rep_s4',
      botUsername: '@reps4_bot',
    });
    await claimSandbox(old.id, tech.id);
    await updateTechnician(tech.id, { sandbox_ref: 'rep_s4', host_id: host });
    // This person was also moved to the seat glue (step 4) on that same sandbox.
    await createSeat({ tenantId, technicianId: tech.id, hostId: host, seatRef: 'rep_s4', botRef: null });
    await requestSandboxRetirement(tech.id);

    // GET serves the retirement until the box reports completion.
    expect((await pull()).retirements).toContainEqual({ sandboxRef: 'rep_s4' });

    const done = await report({
      retiredSandboxRef: 'rep_s4',
      newSandboxRef: 'rep-s5',
      botUsername: '@reps4_bot',
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ retired: true, registered: true, rosterCleared: true });
    // The glue seat on the destroyed sandbox dies with it — a later bind must
    // never "recover" a ref the pool has just handed to someone else.
    const liveSeat = await pg.query(
      'select count(*)::int as n from seats where technician_id = $1 and retired_at is null',
      [tech.id],
    );
    expect(liveSeat.rows[0].n).toBe(0);

    // GET no longer serves it; the blank is a FREE pool row; the destroyed row
    // released its claim; the roster no longer points at the dead sandbox.
    expect((await pull()).retirements).not.toContainEqual({ sandboxRef: 'rep_s4' });
    const rows = await pg.query(
      "select sandbox_ref, technician_id, retired_at, retired_technician_id, bot_username from sandbox_pool where sandbox_ref in ('rep_s4','rep-s5') order by sandbox_ref",
    );
    expect(rows.rows[0]).toMatchObject({
      sandbox_ref: 'rep_s4',
      technician_id: null,
      retired_technician_id: tech.id,
    });
    expect(rows.rows[0].retired_at).not.toBeNull();
    expect(rows.rows[1]).toMatchObject({
      sandbox_ref: 'rep-s5',
      technician_id: null,
      retired_at: null,
      bot_username: '@reps4_bot',
    });
    const roster = await pg.query("select sandbox_ref, host_id from technicians where ref = 'rep-probe'");
    expect(roster.rows[0]).toEqual({ sandbox_ref: null, host_id: null });

    // Retry (box lost the 200): idempotent, still 200-shaped, no second blank.
    const retry = await report({
      retiredSandboxRef: 'rep_s4',
      newSandboxRef: 'rep-s5',
      botUsername: '@reps4_bot',
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ retired: false, registered: false, rosterCleared: true });
    const blanks = await pg.query("select count(*)::int as n from sandbox_pool where sandbox_ref = 'rep-s5'");
    expect(blanks.rows[0].n).toBe(1);
  });
});

describe('menuButton rides the badge pull', () => {
  test('states the console button when BOARD_PUBLIC_URL is set, stays silent when it is not', async () => {
    const prev = process.env.BOARD_PUBLIC_URL;
    process.env.BOARD_PUBLIC_URL = 'https://example.test/';
    try {
      const res = await fetch(`${base}/control/badges`, {
        headers: { authorization: `Bearer ${hostToken}` },
      });
      const body = (await res.json()) as { menuButton: { text: string; url: string } | null };
      // Trailing slash trimmed: the box pastes this straight into
      // setChatMenuButton and a double slash would be a different URL to
      // Telegram's cache.
      expect(body.menuButton).toEqual({ text: 'Schedule', url: 'https://example.test/console' });
    } finally {
      if (prev === undefined) delete process.env.BOARD_PUBLIC_URL;
      else process.env.BOARD_PUBLIC_URL = prev;
    }

    // Unset: say nothing rather than point the whole fleet at a guess. The box
    // treats null as "leave every button alone".
    delete process.env.BOARD_PUBLIC_URL;
    const quiet = await fetch(`${base}/control/badges`, {
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(((await quiet.json()) as { menuButton: unknown }).menuButton).toBeNull();
    if (prev !== undefined) process.env.BOARD_PUBLIC_URL = prev;
  });
});

describe('POST /control/seat-bots (the box names the bot behind each seat)', () => {
  const report = (body: unknown, token = hostToken) =>
    fetch(`${base}/control/seat-bots`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  const idOf = async (ref: string) =>
    (await pg.query('select bot_id, bot_username from sandbox_pool where sandbox_ref = $1', [ref]))
      .rows[0];

  test('auth and shape: no token 401, wrong token 401, seats must be an array', async () => {
    const noAuth = await fetch(`${base}/control/seat-bots`, { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.text()).toBe('');
    expect((await report({ seats: [] }, 'deadbeef')).status).toBe(401);
    expect((await report('not json {{{')).status).toBe(400);
    expect((await report({})).status).toBe(400);
    expect((await report({ seats: 'nope' })).status).toBe(400);
  });

  test('records the id on a live row, fills a missing handle, and is idempotent', async () => {
    const host = await getHostId();
    await registerSandbox({ tenantId, hostId: host, sandboxRef: 'sb-live' });

    const first = await report({
      seats: [{ sandboxRef: 'sb-live', botId: '8918989737', botUsername: '@sblive_bot' }],
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ recorded: ['sb-live'], skipped: [] });
    expect(await idOf('sb-live')).toEqual({ bot_id: '8918989737', bot_username: '@sblive_bot' });

    // The tick repeats every 5 minutes forever; a report that changes nothing
    // must not write. `recorded` empty is how the box knows it is in sync.
    const again = await report({
      seats: [{ sandboxRef: 'sb-live', botId: '8918989737', botUsername: '@sblive_bot' }],
    });
    expect(await again.json()).toEqual({ recorded: [], skipped: [] });
  });

  test('refuses a handle that disagrees with the row — the wrong-token mistake', async () => {
    const host = await getHostId();
    await registerSandbox({
      tenantId,
      hostId: host,
      sandboxRef: 'sb-handle',
      botUsername: '@sbhandle_bot',
    });
    const res = await report({
      seats: [{ sandboxRef: 'sb-handle', botId: '4242424242', botUsername: '@someoneelse_bot' }],
    });
    const body = (await res.json()) as { recorded: string[]; skipped: Array<{ why: string }> };
    expect(body.recorded).toEqual([]);
    expect(body.skipped[0].why).toContain('disagrees');
    expect((await idOf('sb-handle')).bot_id).toBeNull();
  });

  test('a token pasted as an id never becomes an allowlist entry', async () => {
    const host = await getHostId();
    await registerSandbox({ tenantId, hostId: host, sandboxRef: 'sb-token' });
    const res = await report({
      seats: [{ sandboxRef: 'sb-token', botId: '8918989737:AAHtokenlookingthing' }],
    });
    const body = (await res.json()) as { recorded: string[]; skipped: Array<{ why: string }> };
    expect(body.recorded).toEqual([]);
    expect(body.skipped[0].why).toContain('numeric');
    expect((await idOf('sb-token')).bot_id).toBeNull();
  });

  test('a retired seat is refused, and an unracked one is reported back, not created', async () => {
    const host = await getHostId();
    // Retired directly rather than through the recycle flow: this test is about
    // the report refusing a dead seat, and the tenant's seat cap is spoken for
    // by the suites above.
    await registerSandbox({ tenantId, hostId: host, sandboxRef: 'sb-dead' });
    await pg.query("update sandbox_pool set retired_at = now() where sandbox_ref = 'sb-dead'");

    const res = await report({
      seats: [
        { sandboxRef: 'sb-dead', botId: '5150' },
        { sandboxRef: 'sb-never-racked', botId: '5151' },
      ],
    });
    const body = (await res.json()) as {
      recorded: string[];
      skipped: Array<{ sandboxRef: string; why: string }>;
    };
    expect(body.recorded).toEqual([]);
    expect(body.skipped.find((x) => x.sandboxRef === 'sb-dead')?.why).toContain('retired');
    expect(body.skipped.find((x) => x.sandboxRef === 'sb-never-racked')?.why).toContain(
      'no pool row',
    );
    // The unracked seat must NOT have been created: an auto-created row is COLD,
    // and bind_telegram hands cold rows to the next hire.
    const created = await pg.query(
      "select count(*)::int as n from sandbox_pool where sandbox_ref = 'sb-never-racked'",
    );
    expect(created.rows[0].n).toBe(0);
  });

  test('one bad seat does not cost the rest of the rack its report', async () => {
    const host = await getHostId();
    await registerSandbox({ tenantId, hostId: host, sandboxRef: 'sb-good' });
    const res = await report({
      seats: [
        { sandboxRef: 'sb-never-racked', botId: '5151' },
        { sandboxRef: 'sb-good', botId: '777000777' },
      ],
    });
    const body = (await res.json()) as { recorded: string[] };
    expect(body.recorded).toEqual(['sb-good']);
    expect((await idOf('sb-good')).bot_id).toBe('777000777');
  });
});

describe('POST /control/ops', () => {
  const post = (body: unknown, token = hostToken) =>
    fetch(`${base}/control/ops`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const alerts = vi.mocked(queuePersonPush);
  const saved = { ids: process.env.OPS_ALERT_TELEGRAM_IDS };

  beforeEach(async () => {
    await pg.query('delete from ops_events where host_id = $1', [await getHostId()]);
    vi.clearAllMocks();
    // Alerting is OFF unless configured, so the operator list is set
    // explicitly. Inheriting it from .env would make these tests pass only on a
    // machine that happens to have one: in a fresh worktree (which CLAUDE.md's
    // parallel workflow creates with no .env) the notifier would skip and the
    // assertions below would fail.
    process.env.OPS_ALERT_TELEGRAM_IDS = '8639645984';
  });

  afterAll(() => {
    for (const [k, v] of Object.entries({
      OPS_ALERT_TELEGRAM_IDS: saved.ids,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('bad or missing token → bare 401, no detail', async () => {
    const noAuth = await fetch(`${base}/control/ops`, { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.text()).toBe('');
    expect((await post({ service: 'inference-medic', status: 'down' }, 'deadbeef')).status).toBe(401);
  });

  test('rejects a malformed service or status instead of forking a silent stream', async () => {
    expect((await post({ service: 'Inference Medic', status: 'down' })).status).toBe(400);
    expect((await post({ status: 'down' })).status).toBe(400);
    expect((await post({ service: 'inference-medic', status: 'broken' })).status).toBe(400);
  });

  test('down → open, repeats → suppressed, ok → closed', async () => {
    const opened = (await post({
      service: 'inference-medic',
      status: 'down',
      detail: { message: 'deepinfra-prod IS NOT SERVING' },
    }).then((r) => r.json())) as { action: string; incidentId: string };
    expect(opened.action).toBe('opened');

    // The 5-minute ticks during the outage.
    for (let i = 0; i < 3; i++) {
      const again = (await post({ service: 'inference-medic', status: 'down' }).then((r) => r.json())) as {
        action: string;
        incidentId: string;
      };
      expect(again.action).toBe('suppressed');
      expect(again.incidentId).toBe(opened.incidentId);
    }

    const closed = (await post({ service: 'inference-medic', status: 'ok' }).then((r) => r.json())) as {
      action: string;
      incidentId: string;
    };
    expect(closed.action).toBe('closed');
    expect(closed.incidentId).toBe(opened.incidentId);

    // Four bad reports and a recovery = ONE incident row.
    const { rows } = await pg.query('select count(*)::int as n from ops_events where host_id = $1', [
      await getHostId(),
    ]);
    expect(rows[0].n).toBe(1);

    // ...and exactly TWO alerts: "it broke" and "it's back". The three
    // suppressed ticks in between must stay silent, or a 30-minute outage pages
    // six times and the operator mutes the channel — which would rebuild the
    // alerting gap this notifier exists to close.
    expect(alerts).toHaveBeenCalledTimes(2);
    const bodies = alerts.mock.calls.map((c) => (c[0] as { body: string; kind: string }));
    expect(bodies[0].body).toContain('is DOWN');
    expect(bodies[1].body).toContain('recovered');
    // Filed as ops, not as a schedule change — `kind` is how an operator
    // reading the queue knows why the message was owed.
    expect(bodies.map((b) => b.kind)).toEqual(['ops', 'ops']);
  });

  test('a failing alert never fails the report — the reporter still gets its 200', async () => {
    alerts.mockRejectedValueOnce(new Error('queuePersonPush failed: 23514'));
    const res = await post({ service: 'inference-medic', status: 'down' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { action: string }).action).toBe('opened');
    // Assert the send was ATTEMPTED, or this test passes for the wrong reason
    // whenever the notifier skips — and the queued rejection would survive into
    // the next test (vi.clearAllMocks does not drain mockRejectedValueOnce).
    expect(alerts).toHaveBeenCalledTimes(1);
    // The incident is still recorded — alerting is downstream of the record.
    const { rows } = await pg.query('select count(*)::int as n from ops_events where host_id = $1', [
      await getHostId(),
    ]);
    expect(rows[0].n).toBe(1);
  });

  test('alerting off (no OPS_ALERT_TELEGRAM_IDS) changes nothing about the report', async () => {
    delete process.env.OPS_ALERT_TELEGRAM_IDS;
    const res = await post({ service: 'inference-medic', status: 'down' });
    expect(res.status).toBe(200);
    expect(alerts).not.toHaveBeenCalled();
  });

  test('healthy reports on a healthy service write nothing at all', async () => {
    for (let i = 0; i < 3; i++) {
      expect(
        ((await post({ service: 'inference-medic', status: 'ok' }).then((r) => r.json())) as { action: string })
          .action,
      ).toBe('noop');
    }
    const { rows } = await pg.query('select count(*)::int as n from ops_events where host_id = $1', [
      await getHostId(),
    ]);
    expect(rows[0].n).toBe(0);
  });

  test('an oversized body is refused, not read into the shared process', async () => {
    // The cap destroys the socket mid-read (readRawBody's behaviour, shared
    // with the phone webhook paths), so the client observes a reset rather than
    // a 413 — the point is that the shared process never buffers it, and no
    // incident is filed from a body it refused to finish reading.
    const oversized = fetch(`${base}/control/ops`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      // A runaway journal tail: the reporter sends ~4 KiB, the cap is 64 KiB.
      body: JSON.stringify({
        service: 'inference-medic',
        status: 'down',
        detail: { journal: 'x'.repeat(200_000) },
      }),
    }).then(
      (r) => ({ rejected: r.status === 413 }),
      () => ({ rejected: true }), // connection reset
    );
    expect((await oversized).rejected).toBe(true);
    const { rows } = await pg.query('select count(*)::int as n from ops_events where host_id = $1', [
      await getHostId(),
    ]);
    expect(rows[0].n).toBe(0);

    // ...and the server is still serving afterwards.
    const after = await post({ service: 'inference-medic', status: 'ok' });
    expect(after.status).toBe(200);
  });

  test('host_id comes from the TOKEN, so a body cannot file against another host', async () => {
    const other = await createHost('test-host-ops-other', mintBadge().hash);
    await post({ service: 'inference-medic', status: 'down', hostId: other.id, host_id: other.id });
    const { rows } = await pg.query('select count(*)::int as n from ops_events where host_id = $1', [other.id]);
    expect(rows[0].n).toBe(0);
    await pg.query('delete from ops_events where host_id = $1', [await getHostId()]);
    await pg.query('delete from hosts where id = $1', [other.id]);
  });
});

// Capacity metrics take the SAME wire as /control/ops and the opposite storage
// semantics: ops folds observations into incidents and discards healthy ones,
// this keeps every reading because capacity is made of the healthy ones. These
// pin the wire (auth, shapes, DB effects) and the two properties that make the
// series trustworthy: counters stored RAW, and unreadable values stored NULL.
describe('POST /control/metrics', () => {
  const post = (body: unknown, token = hostToken) =>
    fetch(`${base}/control/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const tick = (over: Record<string, unknown> = {}) => ({
    observedAt: new Date().toISOString(),
    memAvailMb: 12185,
    memTotalMb: 15788,
    diskUsedPct: 7,
    seats: 7,
    cpuCores: 4,
    load5: 0.15,
    oomKills: 0,
    cpuUsageUsec: 1133526202349,
    psiMemSomeUs: 2823734,
    psiMemFullUs: 2338513,
    psiCpuSomeUs: 68897090130,
    sandboxes: { 'openshell-s2': { mem_mb: 746, cpu_usec: 98375328674, psi_mem_some_us: 256644 } },
    ...over,
  });

  beforeEach(async () => {
    await pg.query('delete from host_metrics where host_id = $1', [await getHostId()]);
  });

  test('bad or missing token → bare 401, no detail', async () => {
    const noAuth = await fetch(`${base}/control/metrics`, { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.text()).toBe('');
    expect((await post(tick(), 'deadbeef')).status).toBe(401);
  });

  test('stores one tick, with the cumulative counters kept RAW', async () => {
    expect(await (await post(tick())).json()).toEqual({ action: 'recorded' });
    const { rows } = await pg.query(
      'select * from host_metrics where host_id = $1',
      [await getHostId()],
    );
    expect(rows).toHaveLength(1);
    // Odometers, not deltas: a delta computed on the box is lost forever if the
    // POST fails, and a counter that misses a tick self-heals into a wider
    // window at read time.
    expect(Number(rows[0].cpu_usage_usec)).toBe(1133526202349);
    expect(Number(rows[0].psi_cpu_some_us)).toBe(68897090130);
    expect(rows[0].seats).toBe(7);
    expect(rows[0].sandboxes['openshell-s2'].cpu_usec).toBe(98375328674);
  });

  test('an unreadable counter stores NULL, never 0', async () => {
    // THE trap this whole series rests on. A box that cannot read /proc/pressure
    // (older kernel, cgroup v1) must record "cannot say", because 0 is a
    // measurement — it claims the box was never stalled. Downstream, numeric
    // comparison reads NULL as 0 and would turn missing data into a silent pass.
    await post(tick({ psiMemSomeUs: 'unreadable', oomKills: null, memAvailMb: undefined }));
    const { rows } = await pg.query(
      'select psi_mem_some_us, oom_kills, mem_avail_mb, cpu_usage_usec from host_metrics where host_id = $1',
      [await getHostId()],
    );
    expect(rows[0].psi_mem_some_us).toBeNull();
    expect(rows[0].oom_kills).toBeNull();
    expect(rows[0].mem_avail_mb).toBeNull();
    // ...and the readable fields in the same tick still land. A partial row is
    // worth far more than no row.
    expect(Number(rows[0].cpu_usage_usec)).toBe(1133526202349);
  });

  test('refuses a tick with no usable observedAt rather than stamping now()', async () => {
    // observed_at is the axis every derived rate divides by. Substituting the
    // server clock would attribute a delayed batch of ticks to the wrong
    // minutes and quietly corrupt every rate computed from them.
    expect((await post(tick({ observedAt: undefined }))).status).toBe(400);
    expect((await post(tick({ observedAt: 'yesterday-ish' }))).status).toBe(400);
    const { rows } = await pg.query(
      'select count(*)::int as n from host_metrics where host_id = $1',
      [await getHostId()],
    );
    expect(rows[0].n).toBe(0);
  });

  test('a replayed tick is idempotent, not an error', async () => {
    const t = tick();
    expect(await (await post(t)).json()).toEqual({ action: 'recorded' });
    // The reporter retries and needs no delivery guarantee; the primary key is
    // what makes that safe. A 5xx here would make it log a failure for a
    // reading that IS stored.
    const again = await post(t);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ action: 'duplicate' });
    const { rows } = await pg.query(
      'select count(*)::int as n from host_metrics where host_id = $1',
      [await getHostId()],
    );
    expect(rows[0].n).toBe(1);
  });

  test('host_id comes from the TOKEN, so a body cannot file against another host', async () => {
    const other = await createHost('test-host-metrics-other', mintBadge().hash);
    await post(tick({ hostId: other.id, host_id: other.id }));
    const { rows } = await pg.query(
      'select count(*)::int as n from host_metrics where host_id = $1',
      [other.id],
    );
    expect(rows[0].n).toBe(0);
    await pg.query('delete from hosts where id = $1', [other.id]);
  });

  test('an oversized body is refused, not read into the shared process', async () => {
    // `sandboxes` grows with seat count, so unlike a fixed payload this one has
    // no natural ceiling — the cap is what stops one box ballooning the process
    // that serves every tenant.
    const oversized = fetch(`${base}/control/metrics`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(tick({ sandboxes: { runaway: 'x'.repeat(200_000) } })),
    }).then(
      (r) => ({ rejected: r.status === 413 }),
      () => ({ rejected: true }), // connection reset
    );
    expect((await oversized).rejected).toBe(true);
    expect((await post(tick())).status).toBe(200);
  });

  test('monitoring.health differences the counters, and a reboot reads as 0 not negative', async () => {
    const host = await getHostId();
    const now = Date.now();
    const at = (secondsAgo: number) => new Date(now - secondsAgo * 1000).toISOString();
    // 72 core-seconds of CPU across a 300 s window -> 0.24 cores busy.
    await post(tick({ observedAt: at(300), cpuUsageUsec: 1_000_000_000, psiCpuSomeUs: 4_000_000 }));
    await post(tick({ observedAt: at(0), cpuUsageUsec: 1_072_000_000, psiCpuSomeUs: 4_900_000 }));

    const { rows } = await pg.query(
      `select boxes -> (select name from hosts where id = $1) as box from monitoring.health`,
      [host],
    );
    const box = rows[0].box as Record<string, number>;
    expect(box.window_s).toBe(300);
    expect(Number(box.cpu_busy_cores)).toBeCloseTo(0.24, 3);
    expect(Number(box.psi_cpu_some_pct)).toBeCloseTo(0.3, 2);

    // A reboot resets every counter. That is "counters restarted", not "work
    // undone" — a negative delta must clamp to 0, or a rebooted box reports
    // impossible numbers and any threshold built on them misfires.
    await pg.query('delete from host_metrics where host_id = $1', [host]);
    await post(tick({ observedAt: at(300), cpuUsageUsec: 9_000_000_000, oomKills: 9 }));
    await post(tick({ observedAt: at(0), cpuUsageUsec: 50_000, oomKills: 0 }));
    const after = await pg.query(
      `select boxes -> (select name from hosts where id = $1) as box from monitoring.health`,
      [host],
    );
    const rebooted = after.rows[0].box as Record<string, number>;
    expect(Number(rebooted.cpu_busy_cores)).toBe(0);
    expect(Number(rebooted.oom_kills_delta)).toBe(0);
  });

  test('a box with only one tick reports NULL deltas, which must not read as zero', async () => {
    const host = await getHostId();
    await post(tick());
    const { rows } = await pg.query(
      `select boxes -> (select name from hosts where id = $1) as box from monitoring.health`,
      [host],
    );
    const box = rows[0].box as Record<string, unknown>;
    // No predecessor to difference against. NULL is "cannot say" — the caller
    // must not treat it as a healthy zero.
    expect(box.cpu_busy_cores).toBeNull();
    expect(box.oom_kills_delta).toBeNull();
    expect(box.psi_mem_some_pct).toBeNull();
    // ...while the point-in-time values, which need no predecessor, are present.
    expect(box.mem_avail_mb).toBe(12185);
    expect(box.seats).toBe(7);
  });
});

// The suite's host row is created in beforeAll without keeping the id; the
// recycle tests need it to seed pool rows.
async function getHostId(): Promise<string> {
  const { data, error } = await getClient()
    .from('hosts')
    .select('id')
    .eq('name', HOST_NAME)
    .single();
  if (error || !data) throw new Error(`host lookup failed: ${error?.message ?? 'none'}`);
  return data.id;
}

// The voice's outbox routes (plan 2026-08-15 feature B, Phase 4): same
// host-token gate as the badge pull; serve/report semantics are unit-pinned
// in nudgeQueue.test.ts — this suite pins the WIRE (auth, shapes, DB effects).
describe('/control/nudges', () => {
  const NUDGE_CTX = {
    customerName: 'Henderson',
    jobTitle: 'Furnace tune-up',
    technicianRef: 'pull-probe',
    technicianName: 'Pull Probe',
    jobId: 'j-http',
    startsAtLocal: '2026-08-14T07:00:00.000Z',
    endsAtLocal: '2026-08-14T08:00:00.000Z',
  };
  let nudgeId: string;

  beforeAll(async () => {
    // The probe row needs a Telegram binding to be deliverable.
    await pg.query(
      "update technicians set telegram_user_id = '424242' where ref = 'pull-probe'",
    );
    const r = await pg.query<{ id: string }>(
      `insert into nudges (tenant_id, kind, subject_ref, technician_id, status, question, queued_at, context)
       select $1, 'overdue_visit_gap', 'asg-http-1', t.id, 'queued', 'How did it go?', now(), $2::jsonb
         from technicians t where t.ref = 'pull-probe'
       returning id`,
      [tenantId, JSON.stringify(NUDGE_CTX)],
    );
    nudgeId = r.rows[0].id;
  });

  afterAll(async () => {
    await pg.query('delete from nudges where subject_ref = $1', ['asg-http-1']);
    await pg.query("delete from review_items where subject_ref = 'asg-http-1'");
  });

  test('bad or missing token → bare 401, both methods', async () => {
    const noAuthGet = await fetch(`${base}/control/nudges`);
    expect(noAuthGet.status).toBe(401);
    expect(await noAuthGet.text()).toBe('');
    const wrongPost = await fetch(`${base}/control/nudges`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x', outcome: 'delivered' }),
    });
    expect(wrongPost.status).toBe(401);
  });

  test('GET serves the queued nudge with a fresh session id and counted serve; POST delivered → asked', async () => {
    const pull = await fetch(`${base}/control/nudges`, {
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(pull.status).toBe(200);
    const body = (await pull.json()) as {
      nudges: Array<{
        id: string;
        sandboxRef: string;
        replyTo: string;
        sessionId: string;
        directMessageB64: string;
      }>;
    };
    const item = body.nudges.find((x) => x.id === nudgeId);
    expect(item).toBeDefined();
    expect(item!.sandboxRef).toBe('s1');
    expect(item!.replyTo).toBe('424242');
    expect(item!.sessionId).toBe(`nudge-${nudgeId}`);
    // ④b Phase 5: the verbatim payload is the ONLY payload (messageB64 removed).
    expect('messageB64' in item!).toBe(false);
    expect(Buffer.from(item!.directMessageB64, 'base64').toString('utf8')).toBe('How did it go?');

    const served = await pg.query<{ serve_count: number }>(
      'select serve_count from nudges where id = $1',
      [nudgeId],
    );
    expect(served.rows[0].serve_count).toBe(1);

    // Malformed report bodies are 400s, not row movement.
    const badOutcome = await fetch(`${base}/control/nudges`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: nudgeId, outcome: 'lost' }),
    });
    expect(badOutcome.status).toBe(400);

    const ack = await fetch(`${base}/control/nudges`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: nudgeId, outcome: 'delivered' }),
    });
    expect(ack.status).toBe(200);
    expect(((await ack.json()) as { result: string }).result).toBe('asked');

    const row = await pg.query<{ status: string; asked_at: string | null }>(
      'select status, asked_at from nudges where id = $1',
      [nudgeId],
    );
    expect(row.rows[0].status).toBe('asked');
    expect(row.rows[0].asked_at).not.toBeNull();

    // A duplicate/late report lands on a row that already moved → ignored.
    const dupe = await fetch(`${base}/control/nudges`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: nudgeId, outcome: 'failed' }),
    });
    expect(((await dupe.json()) as { result: string }).result).toBe('ignored');
  });
});

describe('/control/office (build 5.5 Phase 3)', () => {
  let messageId: string;

  beforeAll(async () => {
    const r = await pg.query<{ id: string }>(
      `insert into office_messages (tenant_id, direction, kind, from_ref, to_ref, technician_id, body, status, nudge_id)
       select $1, 'to_agent', 'ask', 'spine:team-lead', 'pull-probe', t.id,
              'how did the furnace tune-up go?', 'queued', gen_random_uuid()
         from technicians t where t.ref = 'pull-probe'
       returning id`,
      [tenantId],
    );
    messageId = r.rows[0].id;
  });

  afterAll(async () => {
    await pg.query('delete from office_messages where id = $1', [messageId]);
  });

  test('bad or missing token → bare 401, both methods', async () => {
    const noAuthGet = await fetch(`${base}/control/office`);
    expect(noAuthGet.status).toBe(401);
    expect(await noAuthGet.text()).toBe('');
    const wrongPost = await fetch(`${base}/control/office`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x', outcome: 'delivered' }),
    });
    expect(wrongPost.status).toBe(401);
  });

  test('GET serves the wrapped queued message with a counted serve; POST delivered moves it', async () => {
    const pull = await fetch(`${base}/control/office`, {
      headers: { authorization: `Bearer ${hostToken}` },
    });
    expect(pull.status).toBe(200);
    const body = (await pull.json()) as {
      messages: Array<{ id: string; sandboxRef: string; kind: string; directMessageB64: string }>;
    };
    const item = body.messages.find((x) => x.id === messageId);
    expect(item).toBeDefined();
    expect(item!.sandboxRef).toBe('s1');
    expect(item!.kind).toBe('ask');
    const decoded = Buffer.from(item!.directMessageB64, 'base64').toString('utf8');
    expect(decoded).toContain('OFFICE QUESTION (from the office record system, not a person)');
    expect(decoded).toContain('how did the furnace tune-up go?');
    expect(decoded).toContain(`mention this id: ${messageId}`);

    const served = await pg.query<{ serve_count: number }>(
      'select serve_count from office_messages where id = $1',
      [messageId],
    );
    expect(served.rows[0].serve_count).toBe(1);

    // Malformed report bodies are 400s, not row movement.
    const badId = await fetch(`${base}/control/office`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'not-a-uuid', outcome: 'delivered' }),
    });
    expect(badId.status).toBe(400);
    const badOutcome = await fetch(`${base}/control/office`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: messageId, outcome: 'lost' }),
    });
    expect(badOutcome.status).toBe(400);

    const ack = await fetch(`${base}/control/office`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: messageId, outcome: 'delivered' }),
    });
    expect(ack.status).toBe(200);
    expect(((await ack.json()) as { result: string }).result).toBe('delivered');

    const row = await pg.query<{ status: string; delivered_at: string | null }>(
      'select status, delivered_at from office_messages where id = $1',
      [messageId],
    );
    expect(row.rows[0].status).toBe('delivered');
    expect(row.rows[0].delivered_at).not.toBeNull();

    // A duplicate/late report lands on a row that already moved → ignored.
    const dupe = await fetch(`${base}/control/office`, {
      method: 'POST',
      headers: { authorization: `Bearer ${hostToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ id: messageId, outcome: 'failed' }),
    });
    expect(((await dupe.json()) as { result: string }).result).toBe('ignored');
  });
});

describe('hangUpSignal (plan 2026-09-22, the office)', () => {
  const fakeRes = (finished: boolean) =>
    Object.assign(new EventEmitter(), { writableFinished: finished }) as unknown as Parameters<
      typeof hangUpSignal
    >[0] & EventEmitter;

  test('the request closing before the reply aborts the signal', () => {
    const res = fakeRes(false);
    const signal = hangUpSignal(res);
    expect(signal.aborted).toBe(false);
    res.emit('close');
    expect(signal.aborted).toBe(true);
  });

  test('the close that follows a finished reply does not', () => {
    const res = fakeRes(true);
    const signal = hangUpSignal(res);
    res.emit('close');
    expect(signal.aborted).toBe(false);
  });
});

// Step 4 (plan 2026-09-23-step-4-per-seat-tokens): the box mints a seat's token
// with its HOST token; the seat then proves itself with that token alone — to
// /seat/whoami and to /mcp itself, through the real MCP client.
describe('seat tokens: POST /control/seat-token, GET /seat/whoami, /mcp', () => {
  let seatTechId: string;
  let otherHostToken: string;

  beforeAll(async () => {
    await pg.query("delete from hosts where name = 'test-host-seat-other'");
    // Two more people than the suite's cap of 2 (afterAll restores the default).
    await setTenantSeats(tenantId, { managerSeats: 1, technicianSeats: 4 });
    const hostId = (
      await pg.query<{ id: string }>('select id from hosts where name = $1', [HOST_NAME])
    ).rows[0].id;
    const tech = await insertTechnician({ tenantId, ref: 'seat-probe', displayName: 'Seat Probe' });
    seatTechId = tech.id;
    await updateTechnician(tech.id, {
      host_id: hostId,
      sandbox_ref: 'g_probe001',
      state: 'active',
      telegram_user_id: '5801703167',
    });
    await createSeat({ tenantId, technicianId: tech.id, hostId, seatRef: 'g_probe001', botRef: null });
    // A second box with its own seat: the first box must never mint for it.
    const other = mintBadge();
    otherHostToken = other.badge;
    const otherHost = await createHost('test-host-seat-other', other.hash);
    const otherTech = await insertTechnician({ tenantId, ref: 'seat-other', displayName: 'Other' });
    await updateTechnician(otherTech.id, { state: 'active' });
    await createSeat({
      tenantId,
      technicianId: otherTech.id,
      hostId: otherHost.id,
      seatRef: 'g_other001',
      botRef: null,
    });
  });
  afterAll(async () => {
    // Cascades take the other box's seat with it (seats.host_id on delete cascade).
    await pg.query("delete from hosts where name = 'test-host-seat-other'");
  });

  const mint = (token: string, seatRef: string) =>
    fetch(`${base}/control/seat-token`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ seatRef }),
    });
  const mcpList = (token: string) =>
    fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
  const whoami = (token: string) =>
    fetch(`${base}/seat/whoami`, { headers: { authorization: `Bearer ${token}` } });

  test('mint: bare 401 without a valid host token; 400 on a bad ref', async () => {
    expect((await mint('nope', 'g_probe001')).status).toBe(401);
    const noAuth = await fetch(`${base}/control/seat-token`, { method: 'POST', body: '{}' });
    expect(noAuth.status).toBe(401);
    expect(await noAuth.text()).toBe('');
    expect((await mint(hostToken, '../etc')).status).toBe(400);
  });

  test("mint is host-scoped: a box cannot mint for another box's seat", async () => {
    expect((await mint(hostToken, 'g_other001')).status).toBe(404);
    expect((await mint(otherHostToken, 'g_probe001')).status).toBe(404);
  });

  test('mint returns the token once, stores only its fingerprint, and rotation kills the old one', async () => {
    const first = await mint(hostToken, 'g_probe001');
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('no-store');
    const a = (await first.json()) as { token: string; technicianRef: string; tenantId: string };
    expect(a.token).toMatch(/^st_[0-9a-f]{64}$/);
    expect(a).toMatchObject({ technicianRef: 'seat-probe', tenantId });
    const row = await pg.query('select token_hash from seats where technician_id = $1', [seatTechId]);
    expect(row.rows[0].token_hash).toBe(sha256hex(a.token));

    expect((await whoami(a.token)).status).toBe(200);
    const b = (await (await mint(hostToken, 'g_probe001')).json()) as { token: string };
    expect(b.token).not.toBe(a.token);
    expect((await whoami(a.token)).status).toBe(401);
    expect((await mcpList(a.token)).status).toBe(401);
    expect((await whoami(b.token)).status).toBe(200);
  });

  test("whoami: the seat's person, Telegram id and the firm's timezone; HMAC headers are refused", async () => {
    const { token } = (await (await mint(hostToken, 'g_probe001')).json()) as { token: string };
    const res = await whoami(token);
    const tz = (await pg.query('select timezone from tenants where id = $1', [tenantId])).rows[0]
      .timezone;
    expect(await res.json()).toEqual({
      seatRef: 'g_probe001',
      tenantId,
      technicianRef: 'seat-probe',
      telegramUserId: '5801703167',
      timezone: tz,
    });
    const hmac = await fetch(`${base}/seat/whoami`, {
      headers: {
        'x-tenant-id': tenantId,
        'x-technician-ref': 'seat-probe',
        'x-identity-signature': 'a'.repeat(64),
      },
    });
    expect(hmac.status).toBe(401);
  });

  test("the glue's own fetchWhoami against Render's own route", async () => {
    const { token } = (await (await mint(hostToken, 'g_probe001')).json()) as { token: string };
    const tz = (await pg.query('select timezone from tenants where id = $1', [tenantId])).rows[0]
      .timezone;
    expect(await fetchWhoami(`${base}/`, token)).toEqual({
      seatRef: 'g_probe001',
      tenantId,
      technicianRef: 'seat-probe',
      telegramUserId: 5801703167,
      tz,
    });
  });

  test('a deactivated person: mint 409, whoami 403, /mcp refused', async () => {
    const { token } = (await (await mint(hostToken, 'g_probe001')).json()) as { token: string };
    await updateTechnician(seatTechId, { state: 'offboarded' });
    try {
      expect((await mint(hostToken, 'g_probe001')).status).toBe(409);
      expect((await whoami(token)).status).toBe(403);
      // The token still names the seat, but dispatch's roster check refuses
      // every tool call for an inactive person (server.ts, same as HMAC).
      const client = new McpClient({ name: 'seat-token-probe', version: '0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }),
      );
      try {
        const out = await client
          .callTool({ name: 'get_schedule', arguments: {} })
          .then((r) => JSON.stringify(r))
          .catch((e: unknown) => String(e));
        expect(out).toMatch(/deactivated|inactive/i);
      } finally {
        await client.close();
      }
    } finally {
      await updateTechnician(seatTechId, { state: 'active' });
    }
  });

  test('/mcp: the real MCP client lists the technician tools with only the seat token', async () => {
    const { token } = (await (await mint(hostToken, 'g_probe001')).json()) as { token: string };
    const client = new McpClient({ name: 'seat-token-probe', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(5);
      expect(tools.map((t) => t.name)).toContain('get_schedule');
    } finally {
      await client.close();
    }
    const bad = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer st_${'0'.repeat(64)}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(bad.status).toBe(401);
  });
});
