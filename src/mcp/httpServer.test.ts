import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// MANDATORY, not tidiness: src/test.setup.ts loads .env before .env.test, and
// .env carries a REAL BOARD_BOT_TOKEN. The /control/ops block below posts
// down/ok repeatedly, so without this stub — the moment OPS_ALERT_CHAT_ID is set
// in a developer's .env — `npm test` would fire live Telegram messages at the
// operator. Stubbed BEFORE createHttpServer is imported. (Precedent:
// src/calls/notify.test.ts.) This file exercises no board route, so replacing
// the module wholesale is safe.
vi.mock('../telegram/boardBot.js', () => ({
  sendBoardMessage: vi.fn(async () => {}),
  setBoardMenuButton: vi.fn(async () => {}),
}));

import { createHmac } from 'node:crypto';
import { sendBoardMessage } from '../telegram/boardBot.js';
import { Client } from 'pg';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createHttpServer } from './httpServer.js';
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
      sandboxRef: 'rep-s4',
      botUsername: '@reps4_bot',
    });
    await claimSandbox(old.id, tech.id);
    await updateTechnician(tech.id, { sandbox_ref: 'rep-s4', host_id: host });
    await requestSandboxRetirement(tech.id);

    // GET serves the retirement until the box reports completion.
    expect((await pull()).retirements).toContainEqual({ sandboxRef: 'rep-s4' });

    const done = await report({
      retiredSandboxRef: 'rep-s4',
      newSandboxRef: 'rep-s5',
      botUsername: '@reps4_bot',
    });
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ retired: true, registered: true, rosterCleared: true });

    // GET no longer serves it; the blank is a FREE pool row; the destroyed row
    // released its claim; the roster no longer points at the dead sandbox.
    expect((await pull()).retirements).not.toContainEqual({ sandboxRef: 'rep-s4' });
    const rows = await pg.query(
      "select sandbox_ref, technician_id, retired_at, retired_technician_id, bot_username from sandbox_pool where sandbox_ref in ('rep-s4','rep-s5') order by sandbox_ref",
    );
    expect(rows.rows[0]).toMatchObject({
      sandbox_ref: 'rep-s4',
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
      retiredSandboxRef: 'rep-s4',
      newSandboxRef: 'rep-s5',
      botUsername: '@reps4_bot',
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ retired: false, registered: false, rosterCleared: true });
    const blanks = await pg.query("select count(*)::int as n from sandbox_pool where sandbox_ref = 'rep-s5'");
    expect(blanks.rows[0].n).toBe(1);
  });
});

describe('POST /control/ops', () => {
  const post = (body: unknown, token = hostToken) =>
    fetch(`${base}/control/ops`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const alerts = vi.mocked(sendBoardMessage);
  const saved = { chat: process.env.OPS_ALERT_CHAT_ID, token: process.env.BOARD_BOT_TOKEN };

  beforeEach(async () => {
    await pg.query('delete from ops_events where host_id = $1', [await getHostId()]);
    vi.clearAllMocks();
    // Alerting is OFF unless configured, and notifyOpsTransition gates on BOTH
    // vars — so both are set explicitly. Inheriting BOARD_BOT_TOKEN from .env
    // would make these tests pass only on a machine that happens to have one:
    // in a fresh worktree (which CLAUDE.md's parallel workflow creates with no
    // .env) the notifier would skip and the assertions below would fail.
    process.env.OPS_ALERT_CHAT_ID = '5801703167';
    process.env.BOARD_BOT_TOKEN = 'test-token';
  });

  afterAll(() => {
    for (const [k, v] of Object.entries({
      OPS_ALERT_CHAT_ID: saved.chat,
      BOARD_BOT_TOKEN: saved.token,
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
    expect((alerts.mock.calls[0] as [string, string])[1]).toContain('is DOWN');
    expect((alerts.mock.calls[1] as [string, string])[1]).toContain('recovered');
  });

  test('a failing alert never fails the report — the reporter still gets its 200', async () => {
    alerts.mockRejectedValueOnce(new Error('telegram sendMessage failed: chat not found'));
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

  test('alerting off (no OPS_ALERT_CHAT_ID) changes nothing about the report', async () => {
    delete process.env.OPS_ALERT_CHAT_ID;
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
