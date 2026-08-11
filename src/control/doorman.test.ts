import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Runs the REAL Box_Setup_Stuff/doorman.mjs as a child process against a stub
// upstream. The doorman is ONE shared process for every sandbox on the box, so
// any unhandled 'error' in its request flow kills every agent's in-flight MCP
// session at once (observed live 2026-08-04: upstream TLS reset mid-SSE →
// second writeHead in the error handler → ERR_HTTP_HEADERS_SENT → process
// exit). These tests lock in the identity translation (badge in → signed
// headers out, badge never forwarded), fail-closed auth, and process survival
// across every stream-error path.
//
// The stub upstream is plain http on loopback — the doorman permits http for
// loopback hostnames only (any real upstream must be https).

const DOORMAN = join(process.cwd(), 'Box_Setup_Stuff', 'doorman.mjs');
const SECRET = 'test-secret';
const BADGE = 'test-badge-plaintext';
const TENANT = 'tenant-1';
const REF = 'tech-1';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

type UpstreamHandler = (req: IncomingMessage, res: ServerResponse) => void;
const okHandler: UpstreamHandler = (_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"ok":true}');
};

describe('doorman proxy (Box_Setup_Stuff/doorman.mjs)', () => {
  let upstream: Server;
  let upstreamPort: number;
  let handler: UpstreamHandler;
  let upstreamSeen: Array<{ url: string; headers: IncomingHttpHeaders }>;
  let dir: string;
  let child: ChildProcessWithoutNullStreams | null = null;
  let childStderr = '';

  beforeEach(async () => {
    handler = okHandler;
    upstreamSeen = [];
    upstream = createServer((req, res) => {
      req.on('error', () => {});
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        upstreamSeen.push({ url: req.url ?? '', headers: req.headers });
        handler(req, res);
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = (upstream.address() as AddressInfo).port;

    dir = await mkdtemp(join(tmpdir(), 'doorman-test-'));
    const fingerprint = createHash('sha256').update(BADGE).digest('hex');
    await writeFile(
      join(dir, 'badges.json'),
      JSON.stringify({ [fingerprint]: { tenantId: TENANT, technicianRef: REF, revoked: false } }),
    );
  });

  afterEach(async () => {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    child = null;
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  // Spawns the doorman with DOORMAN_PORT=0 and reads the kernel-assigned port
  // back from its startup line. Rejects (with stderr attached) if it dies first.
  function startDoorman(upstreamUrl?: string): Promise<number> {
    childStderr = '';
    const c = spawn(process.execPath, [DOORMAN], {
      env: {
        DOORMAN_PORT: '0',
        DOORMAN_BIND: '127.0.0.1',
        GATEWAY_IDENTITY_SECRET: SECRET,
        MCP_UPSTREAM_URL: upstreamUrl ?? `http://127.0.0.1:${upstreamPort}/`,
        BADGES_FILE: join(dir, 'badges.json'),
      },
    });
    child = c;
    c.stderr.on('data', (chunk: Buffer) => {
      childStderr += String(chunk);
    });
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`doorman never announced a port; stderr:\n${childStderr}`)),
        5000,
      );
      let out = '';
      c.stdout.on('data', (chunk: Buffer) => {
        out += String(chunk);
        const m = /doorman 127\.0\.0\.1:(\d+) ->/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve(Number(m[1]));
        }
      });
      c.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`doorman exited (${code}) before binding; stderr:\n${childStderr}`));
      });
    });
  }

  type CallResult = { status: number | null; body: string; ended: 'end' | 'error' };

  // One client request through the doorman. `ended: 'error'` means the
  // response was cut mid-stream (socket died) rather than completing.
  function call(
    port: number,
    opts: { path?: string; badge?: string | null; headers?: Record<string, string> } = {},
  ): Promise<CallResult> {
    const badge = opts.badge === undefined ? BADGE : opts.badge;
    return new Promise((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: opts.path ?? '/',
          method: 'POST',
          headers: {
            ...(badge === null ? {} : { authorization: `Bearer ${badge}` }),
            'content-type': 'application/json',
            ...opts.headers,
          },
        },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => {
            body += String(c);
          });
          res.on('end', () => resolve({ status: res.statusCode ?? null, body, ended: 'end' }));
          res.on('error', () => resolve({ status: res.statusCode ?? null, body, ended: 'error' }));
        },
      );
      req.on('error', () => resolve({ status: null, body: '', ended: 'error' }));
      req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}');
    });
  }

  it('translates a valid badge into signed identity headers; the badge never goes upstream', async () => {
    const port = await startDoorman();
    const r = await call(port);
    expect(r.status).toBe(200);
    expect(r.body).toBe('{"ok":true}');
    expect(upstreamSeen).toHaveLength(1);
    const h = upstreamSeen[0].headers;
    expect(h['x-tenant-id']).toBe(TENANT);
    expect(h['x-technician-ref']).toBe(REF);
    expect(h['x-identity-signature']).toBe(
      createHmac('sha256', SECRET).update(`${TENANT}.${REF}`).digest('hex'),
    );
    expect(h['authorization']).toBeUndefined();
  });

  it('fails closed: missing badge → 401, unknown badge → 403, upstream never contacted', async () => {
    const port = await startDoorman();
    expect((await call(port, { badge: null })).status).toBe(401);
    expect((await call(port, { badge: 'not-a-real-badge' })).status).toBe(403);
    expect(upstreamSeen).toHaveLength(0);
  });

  it('refuses to start against a non-loopback http upstream (no accidental plaintext proxying)', async () => {
    await expect(startDoorman('http://mcp.example.com/')).rejects.toThrow(/must be https/);
  });

  it('relay prefix: /composio keeps the sandbox path and MCP session headers; other paths do not', async () => {
    const port = await startDoorman();
    await call(port, { path: '/composio/x?y=1', headers: { 'mcp-session-id': 'sess-9' } });
    await call(port, { path: '/anything/else', headers: { 'mcp-session-id': 'sess-9' } });
    expect(upstreamSeen[0].url).toBe('/composio/x?y=1');
    expect(upstreamSeen[0].headers['mcp-session-id']).toBe('sess-9');
    expect(upstreamSeen[1].url).toBe('/'); // non-relay traffic pins to the configured upstream path
    expect(upstreamSeen[1].headers['mcp-session-id']).toBeUndefined();
  });

  // THE 2026-08-04 CRASH. Upstream resets the socket after the response head
  // and first SSE bytes have been relayed; the old error handler then called
  // writeHead a second time → ERR_HTTP_HEADERS_SENT → whole process exits.
  it('survives an upstream socket reset mid-SSE (regression: ERR_HTTP_HEADERS_SENT process crash)', async () => {
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message\ndata: {}\n\n');
      setTimeout(() => res.socket?.resetAndDestroy(), 50);
    };
    const port = await startDoorman();
    const r = await call(port);
    expect(r.status).toBe(200); // head was already relayed…
    expect(r.ended).toBe('error'); // …then the stream was cut, not completed

    await sleep(200);
    expect(childStderr).not.toContain('ERR_HTTP_HEADERS_SENT');
    expect(child!.exitCode).toBeNull(); // the shared process survived…
    handler = okHandler;
    expect((await call(port)).status).toBe(200); // …and still serves every other sandbox
  });

  it('upstream down (connection refused) → clean 502, process stays up', async () => {
    // Take a port, then free it so nothing is listening there.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const port = await startDoorman(`http://127.0.0.1:${deadPort}/`);
    const r = await call(port);
    expect(r.status).toBe(502);
    expect(r.body).toContain('upstream error:');
    expect(child!.exitCode).toBeNull();
  });

  it('client disconnect mid-SSE frees the upstream leg and does not kill the process', async () => {
    let releaseUpstream: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message\ndata: {}\n\n'); // then hold the stream open
      res.on('close', () => releaseUpstream());
    };
    const port = await startDoorman();

    await new Promise<void>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          path: '/',
          method: 'POST',
          headers: { authorization: `Bearer ${BADGE}`, 'content-type': 'application/json' },
        },
        (res) => {
          res.on('error', () => {});
          res.on('data', () => {
            req.destroy(); // client walks away mid-stream
            resolve();
          });
        },
      );
      req.on('error', () => {});
      req.end('{}');
    });

    await Promise.race([
      upstreamClosed,
      sleep(3000).then(() => {
        throw new Error('upstream request was not torn down after the client vanished');
      }),
    ]);
    expect(child!.exitCode).toBeNull();
    handler = okHandler;
    expect((await call(port)).status).toBe(200);
  });

  it('client disconnect mid-upload does not kill the process', async () => {
    const port = await startDoorman();
    await new Promise<void>((resolve) => {
      const req = request({
        host: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
        // promise more body than we send, then vanish
        headers: { authorization: `Bearer ${BADGE}`, 'content-length': '1000' },
      });
      req.on('error', () => {});
      req.write('partial');
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 30);
    });
    await sleep(200);
    expect(child!.exitCode).toBeNull();
    expect((await call(port)).status).toBe(200);
  });
});
