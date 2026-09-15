import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Technician } from '../db/technicians.js';
import {
  capMcpToolResult,
  cappingForward,
  handleComposioRelay,
  isRelayPath,
  type ForwardFn,
  type RelayDeps,
} from './relayHandler.js';

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
    availability: null,
    service_cities: [],
    telegram_user_id: null,
    seat_exempt: false,
    skills: [],
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
    on() {
      return this;
    },
    destroy() {
      return this;
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

// Composio bills the tool CALL. The relay is an MCP proxy, so most of what
// crosses it — the handshake, the tool listing, SSE opens — costs nothing;
// counting every relayed request would inflate the Composio cost line badly.
describe('handleComposioRelay cost metering', () => {
  const billed = async (over: { method?: string; body?: unknown }) => {
    process.env.COMPOSIO_API_KEY = 'key-1';
    const calls: Array<{ tenantId: string }> = [];
    const { forward } = stubForward();
    await handleComposioRelay(
      fakeReq({ method: over.method ?? 'POST' }),
      fakeRes().res,
      over.body === undefined ? '' : JSON.stringify(over.body),
      deps({ forward, recordCost: async (ctx) => void calls.push({ tenantId: ctx!.tenantId }) }),
    );
    return calls;
  };

  test('a tools/call POST bills exactly once, tagged with the caller tenant', async () => {
    const calls = await billed({ body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} } });
    expect(calls).toEqual([{ tenantId: TENANT }]);
  });

  test('protocol traffic bills nothing', async () => {
    expect(await billed({ body: { method: 'initialize' } })).toEqual([]);
    expect(await billed({ body: { method: 'notifications/initialized' } })).toEqual([]);
    expect(await billed({ body: { method: 'tools/list' } })).toEqual([]);
    // A bare GET is an SSE stream open — no body, no tool call.
    expect(await billed({ method: 'GET' })).toEqual([]);
  });

  test('a failing cost write still forwards the call', async () => {
    process.env.COMPOSIO_API_KEY = 'key-1';
    const { forward, calls } = stubForward();
    await handleComposioRelay(
      fakeReq(),
      fakeRes().res,
      JSON.stringify({ method: 'tools/call' }),
      deps({ forward, recordCost: async () => { throw new Error('cost ledger is down'); } }),
    );
    expect(calls).toHaveLength(1);
  });

  test('a request that never reaches Composio bills nothing', async () => {
    // No API key configured -> 503 before the forward. Billing at the roster
    // read instead of the forward would have charged for this.
    const calls: Array<unknown> = [];
    const captured = fakeRes();
    await handleComposioRelay(
      fakeReq(),
      captured.res,
      JSON.stringify({ method: 'tools/call' }),
      deps({ recordCost: async () => void calls.push(1) }),
    );
    expect(captured.status).toBe(503);
    expect(calls).toEqual([]);
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

// ─── The size cap on the tools/call leg (retrieval layer 4) ─────────────────
//
// Real sockets, both sides: an upstream standing in for the Composio session MCP,
// and a front server calling handleComposioRelay, because the capping leg uses
// the parts of a response the stub above does not have (write, on('close'),
// destroy). SPINE_RESULT_CAP_CHARS is lowered so a small fixture is "too big".
describe('cappingForward — Composio results through the size cap', () => {
  let upstreamHandler: (req: IncomingMessage, res: ServerResponse) => void = () => {};
  let upstream: http.Server;
  let front: http.Server;
  let upstreamUrl = '';
  let frontUrl = '';
  const sockets = new Set<import('node:net').Socket>();
  let prevCap: string | undefined;

  beforeAll(async () => {
    prevCap = process.env.SPINE_RESULT_CAP_CHARS;
    upstream = http.createServer((req, res) => upstreamHandler(req, res));
    upstream.on('connection', (s) => {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
    });
    front = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void handleComposioRelay(req, res, Buffer.concat(chunks).toString('utf8'), {
          getTech: async () => tech(),
          getMcpUrl: async () => upstreamUrl,
          recordCost: async () => undefined,
        });
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    await new Promise<void>((r) => front.listen(0, '127.0.0.1', () => r()));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as import('node:net').AddressInfo).port}/mcp`;
    frontUrl = `http://127.0.0.1:${(front.address() as import('node:net').AddressInfo).port}/composio`;
  });

  afterAll(async () => {
    if (prevCap === undefined) delete process.env.SPINE_RESULT_CAP_CHARS;
    else process.env.SPINE_RESULT_CAP_CHARS = prevCap;
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => upstream.close(() => r()));
    await new Promise<void>((r) => front.close(() => r()));
  });

  const post = (rpc: unknown) =>
    fetch(frontUrl, {
      method: 'POST',
      headers: { ...identityHeaders(), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(rpc),
    });
  const toolCall = { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'GMAIL_FETCH_EMAILS', arguments: {} } };

  test('a result under the cap comes back byte-for-byte', async () => {
    process.env.COMPOSIO_API_KEY = 'k';
    process.env.SPINE_RESULT_CAP_CHARS = '400';
    const payload = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'two emails' }] } });
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(payload);
    };
    const resp = await post(toolCall);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe(payload);
  });

  test('a big JSON result is cut, announced, stays valid JSON-RPC, and its byte length is right', async () => {
    process.env.COMPOSIO_API_KEY = 'k';
    process.env.SPINE_RESULT_CAP_CHARS = '400';
    const text = 'émail '.repeat(400); // non-ASCII: bytes != characters
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          result: {
            content: [{ type: 'text', text }, { type: 'image', data: 'x'.repeat(5000), mimeType: 'image/png' }],
            structuredContent: { emails: text },
          },
        }),
      );
    };
    const resp = await post(toolCall);
    const body = await resp.text();
    expect(Number(resp.headers.get('content-length'))).toBe(Buffer.byteLength(body));
    const msg = JSON.parse(body) as { id: number; result: { content: Array<{ text: string }>; structuredContent?: unknown } };
    expect(msg.id).toBe(7);
    expect(msg.result.structuredContent).toBeUndefined();
    expect(msg.result.content).toHaveLength(1);
    const capped = JSON.parse(msg.result.content[0].text) as { truncated: boolean; note: string; partial: string };
    expect(capped.truncated).toBe(true);
    expect(capped.note).toContain('1 non-text block(s) were dropped');
    expect(capped.note).toContain('Ask the app for fewer results');
    expect(msg.result.content[0].text.length).toBeLessThanOrEqual(400);
  });

  test('SSE: notifications pass through, the response is cut, and the reply ends even if upstream keeps the stream open', async () => {
    process.env.COMPOSIO_API_KEY = 'k';
    process.env.SPINE_RESULT_CAP_CHARS = '400';
    const progress = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } });
    const response = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'z'.repeat(3000) }] } });
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: message\r\ndata: ${progress}\r\n\r\n`);
      // Split the response event across two writes, mid-JSON.
      res.write(`event: message\r\ndata: ${response.slice(0, 50)}`);
      setTimeout(() => res.write(`${response.slice(50)}\r\n\r\n`), 20);
      // …and never end: a server SHOULD close after the response, not MUST.
    };
    const started = Date.now();
    const resp = await post(toolCall);
    const body = await resp.text();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(body).toContain(`data: ${progress}\r\n\r\n`);
    const events = body.split(/\r\n\r\n|\n\n/).filter(Boolean);
    const last = events[events.length - 1];
    expect(last).toContain('event: message');
    const data = last.split(/\r\n|\n/).find((l) => l.startsWith('data: '))!.slice(6);
    const msg = JSON.parse(data) as { id: number; result: { content: Array<{ text: string }> } };
    expect(msg.id).toBe(7);
    expect((JSON.parse(msg.result.content[0].text) as { truncated: boolean }).truncated).toBe(true);
  });

  test('SSE: a notification reaches the client BEFORE the response is ready (streamed, not buffered)', async () => {
    process.env.COMPOSIO_API_KEY = 'k';
    process.env.SPINE_RESULT_CAP_CHARS = '400';
    const progress = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } });
    const response = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'z'.repeat(3000) }] } });
    let release: (() => void) | null = null;
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${progress}\r\n\r\n`);
      // The response only goes out once the test says so, from the client side.
      release = () => {
        // The event SEPARATOR is split across writes — the boundary scan has to
        // survive "\r\n" arriving before "\r\n".
        res.write(`data: ${response}\r\n`);
        res.write('\r\n');
      };
    };
    const resp = await post(toolCall);
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toContain('notifications/progress');
    expect(first).not.toContain('"id":7');
    expect(release).not.toBeNull();
    release!();
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += decoder.decode(value);
    }
    const data = rest.split(/\r\n|\n/).find((l) => l.startsWith('data: '))!.slice(6);
    const msg = JSON.parse(data) as { id: number; result: { content: Array<{ text: string }> } };
    expect(msg.id).toBe(7);
    expect((JSON.parse(msg.result.content[0].text) as { truncated: boolean }).truncated).toBe(true);
  });

  test('SSE: a stream that ENDS without a blank line still has its response cut', async () => {
    process.env.COMPOSIO_API_KEY = 'k';
    process.env.SPINE_RESULT_CAP_CHARS = '400';
    const response = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: 'q'.repeat(3000) }] } });
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${response}`); // no trailing blank line
    };
    const body = await (await post(toolCall)).text();
    const data = body.split(/\r\n|\n/).find((l) => l.startsWith('data: '))!.slice(6);
    const msg = JSON.parse(data) as { result: { content: Array<{ text: string }> } };
    expect((JSON.parse(msg.result.content[0].text) as { truncated: boolean }).truncated).toBe(true);
  });

  test('an upstream error status passes through unchanged', async () => {
    process.env.COMPOSIO_API_KEY = 'k';
    process.env.SPINE_RESULT_CAP_CHARS = '400';
    const errBody = JSON.stringify({ error: 'x'.repeat(2000) });
    upstreamHandler = (_req, res) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(errBody);
    };
    const resp = await post(toolCall);
    expect(resp.status).toBe(500);
    expect(await resp.text()).toBe(errBody);
  });

  test('protocol traffic (tools/list) is piped, never cut', async () => {
    process.env.COMPOSIO_API_KEY = 'k';
    process.env.SPINE_RESULT_CAP_CHARS = '400';
    const catalog = JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'T', description: 'd'.repeat(3000) }] } });
    upstreamHandler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(catalog);
    };
    const resp = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(await resp.text()).toBe(catalog);
  });
});

describe('capMcpToolResult — what counts as too big, and what is never lost', () => {
  test('a text that FITS is left alone even though its JSON form does not', () => {
    // Composio results are JSON-in-text: escaping inflates them 15-35%. Measuring
    // the serialized result announced a cut on results the model could read whole,
    // which tells it to re-query for nothing.
    const text = JSON.stringify({ emails: Array.from({ length: 12 }, (_, i) => ({ id: i, subject: 'hi "there"' })) });
    const cap = text.length; // the text fits EXACTLY
    expect(JSON.stringify({ content: [{ type: 'text', text }] }).length).toBeGreaterThan(cap);
    expect(capMcpToolResult({ content: [{ type: 'text', text }] }, cap)).toBeNull();
  });

  test('a result with no content array keeps its payload as text instead of becoming "null"', () => {
    const capped = capMcpToolResult({ resultType: 'task', task: { id: 't1', words: 'w'.repeat(2000) } }, 400);
    expect(capped?.resultType).toBe('task');
    const body = (capped?.content as Array<{ text: string }>)[0].text;
    expect(body).toContain('t1');
    expect(body).not.toBe('null');
  });

  test('dropping blocks is announced even when the text itself fits', () => {
    const capped = capMcpToolResult(
      { content: [{ type: 'text', text: 'short' }, { type: 'image', data: 'x'.repeat(900) }], isError: true },
      400,
    );
    const blocks = capped?.content as Array<{ text: string }>;
    expect(blocks[0].text).toBe('short');
    expect(blocks[1].text).toContain('1 non-text block(s) were dropped');
    expect(capped?.isError).toBe(true);
  });
});

describe('cappingForward — faults answer once, and in the contracted shape', () => {
  test('a header value http.request refuses answers 502 JSON, never an uncaught throw', async () => {
    const captured = fakeRes();
    await cappingForward(1)(
      'http://127.0.0.1:9/mcp',
      'POST',
      { 'x-api-key': 'abc\n' }, // a pasted env var's trailing newline
      Buffer.from(''),
      captured.res,
    );
    expect(captured.status).toBe(502);
    expect(JSON.parse(captured.body)).toMatchObject({ error: 'upstream request could not be built' });
  });
});
