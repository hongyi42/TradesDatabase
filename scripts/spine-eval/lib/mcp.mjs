// The spine eval's MCP client — talks to the REAL server over the REAL path.
//
// Not a stub and not an in-process function call: the server is started in this
// process but reached over HTTP with a signed identity header, so every request
// exercises the transport, the identity verification, the tier gating and the
// stateless MCP envelope exactly as the gateway does in production. The only
// things missing versus the box are the network hop itself and the gateway's
// tools/list cache.
//
// Two facts established by probe (they are not in the server's own tests):
//   1. NO `initialize` handshake is needed. sessionIdGenerator is undefined, so
//      the handler builds a fresh Server per request — each POST is independent.
//   2. Replies come back as SSE (`event: message\ndata: {...}`), not plain JSON,
//      even for a single request/response pair.
import { createHmac, randomBytes } from 'node:crypto';

/**
 * Start the spine MCP server on an ephemeral loopback port.
 *
 * The harness plays the gateway's role, so it needs the identity signing secret.
 * That secret is GENERATED here, per run, at random: never read from a file,
 * never written to an artifact, never printed. A real gateway secret has no
 * business in an eval, and a hardcoded one in a repo is a leak waiting to happen.
 */
export async function startSpineServer() {
  process.env.GATEWAY_IDENTITY_SECRET = randomBytes(32).toString('hex');
  const secret = process.env.GATEWAY_IDENTITY_SECRET;
  // Imported dynamically, AFTER the secret is in the environment.
  const { createHttpServer } = await import('../../../dist/mcp/httpServer.js');
  const server = createHttpServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    port,
    secret,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Pull every `data:` payload out of an SSE body. */
function parseSse(body) {
  const out = [];
  for (const line of body.split('\n')) {
    if (line.startsWith('data:')) {
      try {
        out.push(JSON.parse(line.slice(5).trim()));
      } catch {
        // A non-JSON data line is a protocol surprise worth surfacing, not hiding.
        out.push({ __unparsed: line.slice(5).trim() });
      }
    }
  }
  return out;
}

/**
 * Build a caller bound to one server.
 *
 * Every call returns the same shape whatever went wrong — transport error, HTTP
 * 401, JSON-RPC error, or a tool-level isError. A harness that throws on some
 * failures and returns on others turns "the tool refused me" (often the expected
 * answer) into a crashed run.
 */
export function makeCaller({ port, secret }) {
  const url = `http://127.0.0.1:${port}/`;

  function headers(tenantId, badge) {
    return {
      'content-type': 'application/json',
      // Streamable HTTP requires both, or the transport rejects the request.
      accept: 'application/json, text/event-stream',
      'x-tenant-id': tenantId,
      'x-technician-ref': badge,
      'x-identity-signature': createHmac('sha256', secret).update(`${tenantId}.${badge}`).digest('hex'),
    };
  }

  async function rpc(method, params, { tenantId, badge, timeoutMs = 30_000 }) {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: headers(tenantId, badge),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
      const body = await res.text();
      const ms = performance.now() - started;
      const frames = parseSse(body);
      const envelope = frames.find((f) => f.result !== undefined || f.error !== undefined) ?? null;
      return { httpStatus: res.status, ms, envelope, body, timedOut: false };
    } catch (err) {
      const ms = performance.now() - started;
      const timedOut = err.name === 'AbortError';
      return {
        httpStatus: 0,
        ms,
        envelope: null,
        body: timedOut ? `timed out after ${timeoutMs}ms` : String(err.message ?? err),
        timedOut,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * Call one spine tool. `isError` distinguishes a tool that REFUSED (a normal,
     * often-expected outcome) from transport failure (`ok: false`).
     */
    async call(tool, args, identity) {
      const { httpStatus, ms, envelope, body, timedOut } = await rpc(
        'tools/call',
        { name: tool, arguments: args ?? {} },
        identity,
      );
      if (httpStatus !== 200 || !envelope) {
        return {
          ok: false,
          isError: true,
          timedOut,
          httpStatus,
          text: `transport failure (HTTP ${httpStatus}): ${String(body).slice(0, 300)}`,
          json: null,
          ms,
        };
      }
      if (envelope.error) {
        return {
          ok: true,
          isError: true,
          timedOut: false,
          httpStatus,
          text: `rpc error ${envelope.error.code}: ${envelope.error.message}`,
          json: null,
          ms,
        };
      }
      const content = envelope.result?.content ?? [];
      const text = content.map((c) => c.text ?? '').join('\n');
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = null; // Plenty of tools answer in prose; that is not a failure.
      }
      return {
        ok: true,
        isError: envelope.result?.isError === true,
        timedOut: false,
        httpStatus,
        text,
        json,
        ms,
      };
    },

    /** The tool names this badge is OFFERED — the tier-gating surface. */
    async listTools(identity) {
      const { httpStatus, ms, envelope, body } = await rpc('tools/list', {}, identity);
      if (httpStatus !== 200 || !envelope?.result) {
        return { ok: false, names: [], ms, text: `HTTP ${httpStatus}: ${String(body).slice(0, 200)}` };
      }
      return { ok: true, names: (envelope.result.tools ?? []).map((t) => t.name), ms, text: '' };
    },

    /**
     * Full tool definitions for this badge, in OpenAI function-calling shape.
     *
     * Taken from the SERVER rather than hand-written, so tier 2 hands the model
     * the real descriptions and the real schemas. Those descriptions are the
     * discovery surface — rewriting one changes whether the agent finds the tool
     * at all — and their depth is what cost 51 seconds a turn once.
     */
    async listToolDefs(identity) {
      const { httpStatus, ms, envelope, body } = await rpc('tools/list', {}, identity);
      if (httpStatus !== 200 || !envelope?.result) {
        throw new Error(`tools/list failed (HTTP ${httpStatus}): ${String(body).slice(0, 200)}`);
      }
      const tools = (envelope.result.tools ?? []).map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema ?? { type: 'object', properties: {} } },
      }));
      return { tools, ms };
    },
  };
}
