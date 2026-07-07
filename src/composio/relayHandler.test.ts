import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Technician } from '../db/technicians.js';
import { handleComposioRelay, isRelayPath, type ForwardFn, type RelayDeps } from './relayHandler.js';

// Pure unit tests — every Composio/DB touchpoint stubbed via RelayDeps
// (sessions.test.ts pattern). Identity is real: headers are signed with the
// test secret, same fixture shape as identity.test.ts.

const SECRET = 'relay-test-secret';
const TENANT = '11111111-1111-1111-1111-111111111111';
const REF = 'jane-doe';

function sign(tenantId: string, technicianRef: string): string {
  return createHmac('sha256', SECRET).update(`${tenantId}.${technicianRef}`).digest('hex');
}

function identityHeaders(): Record<string, string> {
  return {
    'x-tenant-id': TENANT,
    'x-technician-ref': REF,
    'x-identity-signature': sign(TENANT, REF),
  };
}

function tech(over: Partial<Technician> = {}): Technician {
  return {
    id: 'tech-1',
    tenant_id: TENANT,
    ref: REF,
    display_name: 'Jane Doe',
    tier: 'technician',
    state: 'active',
    sandbox_ref: null,
    composio_connected_account_id: 'ca_abc',
    composio_trigger_id: null,
    connected_email: null,
    badge_hash: null,
    host_id: null,
    offboarding_started_at: null,
    link_issued_at: null,
    composio_session_id: 'sess-1',
    created_at: '2026-07-04T00:00:00.000Z',
    updated_at: '2026-07-04T00:00:00.000Z',
    ...over,
  };
}

function fakeReq(over: {
  headers?: Record<string, string>;
  method?: string;
} = {}): IncomingMessage {
  return {
    headers: over.headers ?? identityHeaders(),
    method: over.method ?? 'POST',
  } as unknown as IncomingMessage;
}

interface CapturedResponse {
  status: number | null;
  headers: Record<string, unknown> | undefined;
  body: string;
  res: ServerResponse;
}

function fakeRes(): CapturedResponse {
  const captured: CapturedResponse = { status: null, headers: undefined, body: '', res: null as unknown as ServerResponse };
  let sent = false;
  captured.res = {
    get headersSent() {
      return sent;
    },
    writeHead(status: number, headers?: Record<string, unknown>) {
      sent = true;
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(chunk?: string) {
      captured.body = chunk ?? '';
    },
  } as unknown as ServerResponse;
  return captured;
}

interface ForwardCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Buffer;
}

function stubForward(): { forward: ForwardFn; calls: ForwardCall[] } {
  const calls: ForwardCall[] = [];
  const forward: ForwardFn = async (url, method, headers, body) => {
    calls.push({ url, method, headers, body });
  };
  return { forward, calls };
}

function deps(over: Partial<RelayDeps> = {}): RelayDeps {
  return {
    getTech: async () => tech(),
    getMcpUrl: async () => 'https://mcp.composio.dev/session/abc',
    ...over,
  };
}

let prevSecret: string | undefined;
let prevKey: string | undefined;
let prevRelayKey: string | undefined;
beforeAll(() => {
  prevSecret = process.env.GATEWAY_IDENTITY_SECRET;
  prevKey = process.env.COMPOSIO_API_KEY;
  prevRelayKey = process.env.COMPOSIO_RELAY_API_KEY;
  process.env.GATEWAY_IDENTITY_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.COMPOSIO_API_KEY;
  delete process.env.COMPOSIO_RELAY_API_KEY;
});
afterAll(() => {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore('GATEWAY_IDENTITY_SECRET', prevSecret);
  restore('COMPOSIO_API_KEY', prevKey);
  restore('COMPOSIO_RELAY_API_KEY', prevRelayKey);
});

describe('isRelayPath', () => {
  test('matches the bare, slashed, and query forms only', () => {
    expect(isRelayPath('/composio')).toBe(true);
    expect(isRelayPath('/composio/anything')).toBe(true);
    expect(isRelayPath('/composio?x=1')).toBe(true);
    expect(isRelayPath('/composiox')).toBe(false);
    expect(isRelayPath('/')).toBe(false);
    expect(isRelayPath(undefined)).toBe(false);
  });
});

describe('handleComposioRelay', () => {
  test('missing identity headers throw (the bare-401 contract belongs to the caller)', async () => {
    const { res } = fakeRes();
    await expect(
      handleComposioRelay(fakeReq({ headers: {} }), res, '', deps()),
    ).rejects.toThrow('missing identity headers');
  });

  test('unknown ref → 403 JSON', async () => {
    const out = fakeRes();
    await handleComposioRelay(fakeReq(), out.res, '{}', deps({ getTech: async () => null }));
    expect(out.status).toBe(403);
    expect(JSON.parse(out.body).error).toMatch(/no roster row/);
  });

  test('inactive roster state → 403', async () => {
    const out = fakeRes();
    await handleComposioRelay(
      fakeReq(),
      out.res,
      '{}',
      deps({ getTech: async () => tech({ state: 'offboarding' }) }),
    );
    expect(out.status).toBe(403);
    expect(JSON.parse(out.body).error).toMatch(/deactivated/);
  });

  test('no session + COMPOSIO_API_KEY unset → 503 without calling ensureSession', async () => {
    let ensureCalled = false;
    const out = fakeRes();
    await handleComposioRelay(
      fakeReq(),
      out.res,
      '{}',
      deps({
        getTech: async () => tech({ composio_session_id: null }),
        ensureSession: async () => {
          ensureCalled = true;
          return { status: 'created', sessionId: 'sess-9' };
        },
      }),
    );
    expect(out.status).toBe(503);
    expect(JSON.parse(out.body).error).toBe('session not ready');
    expect(ensureCalled).toBe(false);
  });

  test('no session + key set → mint-on-demand; the minted id reaches getMcpUrl', async () => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    const { forward, calls } = stubForward();
    const seen: Array<string | null> = [];
    const out = fakeRes();
    await handleComposioRelay(
      fakeReq(),
      out.res,
      '{}',
      deps({
        getTech: async () => tech({ composio_session_id: null }),
        ensureSession: async () => ({ status: 'created', sessionId: 'sess-9' }),
        getMcpUrl: async (t) => {
          seen.push(t.composio_session_id);
          return 'https://mcp.composio.dev/session/minted';
        },
        forward,
      }),
    );
    expect(seen).toEqual(['sess-9']);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://mcp.composio.dev/session/minted');
  });

  test('ensureSession skipped or throwing → 503', async () => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    for (const ensureSession of [
      async () => ({ status: 'skipped', reason: 'state is invited' }) as const,
      async () => {
        throw new Error('boom');
      },
    ]) {
      const out = fakeRes();
      await handleComposioRelay(
        fakeReq(),
        out.res,
        '{}',
        deps({
          getTech: async () => tech({ composio_session_id: null }),
          ensureSession: ensureSession as RelayDeps['ensureSession'],
        }),
      );
      expect(out.status).toBe(503);
    }
  });

  test('connected-account keys anywhere in the body → 400, forward never called', async () => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    const { forward, calls } = stubForward();
    const bodies = [
      JSON.stringify({ params: { arguments: { connectedAccountId: 'ca_other' } } }),
      JSON.stringify({ params: { items: [{ connected_account_id: 'ca_other' }] } }),
      JSON.stringify({ ConnectedAccountIds: ['ca_other'] }),
    ];
    for (const body of bodies) {
      const out = fakeRes();
      await handleComposioRelay(fakeReq(), out.res, body, deps({ forward }));
      expect(out.status).toBe(400);
      expect(JSON.parse(out.body).error).toMatch(/not allowed through the relay/);
    }
    expect(calls).toHaveLength(0);
  });

  test('unparseable body → 400', async () => {
    const out = fakeRes();
    await handleComposioRelay(fakeReq(), out.res, 'not json', deps());
    expect(out.status).toBe(400);
  });

  test('clean POST forwards with x-api-key, MCP headers whitelisted, identity headers absent', async () => {
    process.env.COMPOSIO_API_KEY = 'master-key';
    const { forward, calls } = stubForward();
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const out = fakeRes();
    await handleComposioRelay(
      fakeReq({ headers: { ...identityHeaders(), 'mcp-session-id': 'mcp-123' } }),
      out.res,
      body,
      deps({ forward }),
    );
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.method).toBe('POST');
    expect(call.headers['x-api-key']).toBe('master-key');
    expect(call.headers['mcp-session-id']).toBe('mcp-123');
    expect(call.headers['x-tenant-id']).toBeUndefined();
    expect(call.headers['x-technician-ref']).toBeUndefined();
    expect(call.headers['x-identity-signature']).toBeUndefined();
    expect(call.body.toString()).toBe(body);
    expect(call.headers['content-length']).toBe(String(Buffer.byteLength(body)));
  });

  test('COMPOSIO_RELAY_API_KEY wins over COMPOSIO_API_KEY', async () => {
    process.env.COMPOSIO_API_KEY = 'master-key';
    process.env.COMPOSIO_RELAY_API_KEY = 'scoped-key';
    const { forward, calls } = stubForward();
    await handleComposioRelay(fakeReq(), fakeRes().res, '{}', deps({ forward }));
    expect(calls[0].headers['x-api-key']).toBe('scoped-key');
  });

  test('existing session but no Composio key at all → distinct 503, never a piped Composio 401', async () => {
    const { forward, calls } = stubForward();
    const out = fakeRes();
    await handleComposioRelay(fakeReq(), out.res, '{}', deps({ forward }));
    expect(out.status).toBe(503);
    expect(JSON.parse(out.body).error).toMatch(/not configured/);
    expect(calls).toHaveLength(0);
  });

  test('getMcpUrl throw → 502, not 401', async () => {
    const out = fakeRes();
    await handleComposioRelay(
      fakeReq(),
      out.res,
      '{}',
      deps({
        getMcpUrl: async () => {
          throw new Error('session gone');
        },
      }),
    );
    expect(out.status).toBe(502);
    expect(JSON.parse(out.body).error).toMatch(/could not resolve/);
  });

  test('empty body (SSE GET) skips the guard and forwards', async () => {
    process.env.COMPOSIO_API_KEY = 'test-key';
    const { forward, calls } = stubForward();
    await handleComposioRelay(fakeReq({ method: 'GET' }), fakeRes().res, '', deps({ forward }));
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('GET');
  });
});
