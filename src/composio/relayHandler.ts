import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolveIdentity } from '../mcp/identity.js';
import { getTechnician, isInactiveState, recordComposioCall } from '../db/index.js';
import { ensurePersonSession, getSessionMcpUrl } from './sessions.js';
import { capToolResult, resultCapChars } from '../mcp/resultCap.js';

// The composio-doorman relay: sandbox → doorman → THIS route → that person's
// Composio session MCP. The caller controls request content only — destination
// (which session) and credential (x-api-key) are chosen here from the signed
// identity, so the master key never leaves the control plane and a badge can
// only ever reach its own person's session (per-person pinning is the security
// boundary; design of record 2026-07-05, plan 2026-07-06).
//
// Error-shape contract: the bare 401 is reserved for identity failures (the
// resolveIdentityFromHeaders throw propagates to httpServer's catch). Every
// later step answers its own 4xx/5xx with a JSON body, so a Composio-side
// fault is never mistaken for a badge/HMAC problem.

export type ForwardFn = (
  url: string,
  method: string,
  headers: Record<string, string>,
  body: Buffer,
  res: ServerResponse,
) => Promise<void>;

export interface RelayDeps {
  getTech?: typeof getTechnician;
  ensureSession?: typeof ensurePersonSession;
  getMcpUrl?: typeof getSessionMcpUrl;
  forward?: ForwardFn;
  recordCost?: typeof recordComposioCall;
}

// Composio bills the tool CALL. An MCP request body carrying any other method —
// initialize, notifications/initialized, tools/list — costs nothing, so counting
// every relayed request would inflate the Composio line substantially.
function isToolCall(parsed: unknown): parsed is { method: 'tools/call'; id?: unknown } {
  return (
    typeof parsed === 'object' &&
    parsed !== null &&
    (parsed as { method?: unknown }).method === 'tools/call'
  );
}

// All three forms must route here — a query string on the bare path would
// otherwise silently fall through to the spine MCP handler (which serves
// every unrouted path) as a malformed MCP request.
// Composio's hosted sandbox tools (operator, 2026-09-27): switched off, and KEPT
// off after step 2b (operator 2026-09-28, 5A) — a manager now has our own file
// tools in a sandbox the operator chose, and the workbench would still copy the
// firm's data onto Composio's storage.
// Measured live on s2 the same day: asked for a CSV, the seat retyped the rows
// into COMPOSIO_REMOTE_WORKBENCH, which uploaded customer names and balances to
// Composio's storage behind an open link. Refused as a TOOL RESULT (isError),
// never an HTTP error, so the model reads why and offers another way.
export const BLOCKED_COMPOSIO_TOOLS: ReadonlySet<string> = new Set([
  'COMPOSIO_REMOTE_WORKBENCH',
  'COMPOSIO_REMOTE_BASH_TOOL',
]);

export const BLOCKED_TOOL_TEXT =
  "That tool is switched off here: it would run in Composio's hosted sandbox and put the firm's data " +
  'in files on their storage. Do not retry it. If you have your own file tools (share_file), make ' +
  'the file there and send it; otherwise give the answer as text in the chat (a short table or list).';

function blockedToolCall(parsed: unknown): { id: string | number | null } | null {
  if (!isToolCall(parsed)) return null;
  const name = (parsed as { params?: { name?: unknown } }).params?.name;
  if (typeof name !== 'string' || !BLOCKED_COMPOSIO_TOOLS.has(name)) return null;
  const id = parsed.id;
  return { id: typeof id === 'string' || typeof id === 'number' ? id : null };
}

export function isRelayPath(url: string | undefined): boolean {
  if (!url) return false;
  return url === '/composio' || url.startsWith('/composio/') || url.startsWith('/composio?');
}

// Connected-account argument guard: fail-closed defense-in-depth against a
// request naming ANOTHER person's connected account (whether Composio pins
// the session's own account under a master-key-backed call is probed in the
// plan's Phase 2 — this guard ships regardless). Matches key NAMES anywhere
// in the JSON body, case-insensitively, snake or camel.
const CONNECTED_ACCOUNT_KEY = /connected_?account/i;

function findConnectedAccountKey(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findConnectedAccountKey(item);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (CONNECTED_ACCOUNT_KEY.test(key)) return key;
      const hit = findConnectedAccountKey(nested);
      if (hit) return hit;
    }
  }
  return null;
}

function jsonError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

// Default forward leg: raw HTTP proxy to the session MCP endpoint. Piping the
// response (headers included) is what carries SSE streams and any
// Mcp-Session-Id back to the agent. Protocol-selected so tests can point it
// at a local plain-HTTP listener.
const defaultForward: ForwardFn = (urlStr, method, headers, body, res) =>
  new Promise((resolve) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'http:' ? http : https;
    // A client abort must settle the promise — 'end' never fires on an
    // aborted stream (multiple resolve calls are harmless).
    res.on('close', resolve);
    const upReq = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.headers);
        upRes.pipe(res);
        upRes.on('end', resolve);
        upRes.on('close', resolve);
      },
    );
    upReq.on('error', () => {
      if (!res.headersSent) jsonError(res, 502, 'upstream error');
      else res.destroy(); // mid-stream fault: cut the client loose rather than hang it
      resolve();
    });
    upReq.end(body);
  });

// ─── The size cap on Composio results (retrieval layer 4, operator ruling 3) ───
//
// Composio results used to be piped straight back, so the one path that never
// went through the hub's cap could flood a manager's window with a mailbox
// listing. A `tools/call` response is now cut to the same limit with the same
// announcement. No spine FILTER applies here (tier, retraction fold): they are
// rules about the spine's own record, and which apps a badge reaches is already
// decided by the Composio session it is pinned to.
//
// MCP allows a request's response to be one JSON object OR an SSE stream that
// carries notifications and then the response
// (https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).
// The stream is transformed AS IT ARRIVES and never held to its end: a server
// SHOULD, not MUST, close it after the response, and an older revision may send
// something mid-stream that the client has to see before the answer comes.

export const COMPOSIO_CAP_ADVICE =
  'Ask the app for fewer results: a narrower search, a smaller page, or one item by id.';

// A body larger than this is not buffered at all (a pathological attachment
// dump): the relay answers 502 rather than hold it in memory.
const MAX_BUFFERED_BYTES = 16 * 1024 * 1024;

type ContentBlock = { type?: unknown; text?: unknown };

// The capped form of one tools/call RESULT, or null when it already fits (the
// caller then forwards the original bytes untouched). Only text survives a cut:
// images and resources are the bulk the cap exists for, and structuredContent
// duplicates the text a tool SHOULD also send (MCP tools spec). What was
// dropped is said, never silent.
export function capMcpToolResult(
  result: Record<string, unknown>,
  cap: number = resultCapChars(),
): Record<string, unknown> | null {
  if (cap <= 0) return null;
  const blocks = Array.isArray(result.content) ? (result.content as ContentBlock[]) : [];
  const texts = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string');
  const dropped = blocks.length - texts.length;
  const hasStructured = result.structuredContent !== undefined;
  // WHAT THE MODEL READS is the measure, not the wire bytes: the text a
  // tools/call returns is JSON-in-text, and its escaped form is 15-35% longer
  // than the text itself. Measuring the serialized result announced a cut on
  // results that fit, which tells the model to re-query for nothing.
  // With no text block, what stands in for one depends on what is there:
  //   * the structured copy, served AS its JSON (and then not "dropped");
  //   * otherwise, for a result made only of images/audio/resources, a LINE
  //     NAMING them — serializing those blocks would spend the whole budget on
  //     base64 the model cannot read, cut mid-string;
  //   * otherwise the result itself (a shape a later MCP revision adds — an
  //     input_required result's inputRequests), rather than nothing at all.
  const servesStructured = texts.length === 0 && hasStructured;
  const joined =
    texts.length > 0
      ? texts.map((b) => b.text as string).join('\n')
      : servesStructured
        ? JSON.stringify(result.structuredContent)
        : blocks.length > 0
          ? `[relay] This result carried no text, only: ${blocks.map((b) => String(b.type)).join(', ')}.`
          : JSON.stringify(result);
  // THREE CASES, and only the first two change anything:
  //   * the text itself is over the limit → cut it, and say so;
  //   * the text fits but the RESULT is over → the bulk is elsewhere (images,
  //     the structured copy), so keep the text and drop those, saying what went;
  //   * the text fits and the only reason the serialized result does not is
  //     JSON escaping (15-35% on the JSON-in-text a tool returns) → nothing is
  //     wrong: pass it through untouched. Measuring the serialized size alone
  //     announced cuts that never happened, and stripping a small result's
  //     structuredContent breaks any client validating it against an
  //     outputSchema, which a tool declaring one MUST send (MCP tools spec).
  if (joined.length <= cap) {
    if (JSON.stringify(result).length <= cap) return null;
    if (dropped === 0 && !hasStructured) return null;
  }
  const droppedNote =
    (dropped > 0 ? `${dropped} non-text block(s) were dropped. ` : '') +
    // …not when the structured copy IS what is being served as the text.
    (hasStructured && !servesStructured ? 'The structured copy was dropped. ' : '');
  const body = capToolResult(joined, cap, {}, droppedNote + COMPOSIO_CAP_ADVICE);
  const content: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: body }];
  // The text itself fit — what went was the non-text blocks or the structured
  // copy, and that is said rather than left for the model to notice.
  if (body === joined && droppedNote) {
    content.push({ type: 'text', text: `[relay] ${droppedNote}${COMPOSIO_CAP_ADVICE}` });
  }
  return {
    ...(result.resultType !== undefined ? { resultType: result.resultType } : {}),
    content,
    ...(result.isError === true ? { isError: true } : {}),
  };
}

// One JSON-RPC message's text, capped when it is THE response to this request
// and carries a result. Returns null when there is nothing to change (not the
// response, an error response, unparseable, or already under the cap).
function capResponseText(text: string, requestId: string | number): { capped: string | null; isResponse: boolean } {
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return { capped: null, isResponse: false };
  }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return { capped: null, isResponse: false };
  const m = msg as { id?: unknown; result?: unknown; error?: unknown };
  const isResponse = m.id === requestId && ('result' in m || 'error' in m);
  if (!isResponse || !m.result || typeof m.result !== 'object' || Array.isArray(m.result)) {
    return { capped: null, isResponse };
  }
  const result = capMcpToolResult(m.result as Record<string, unknown>);
  return { capped: result ? JSON.stringify({ ...m, result }) : null, isResponse };
}

// Split a buffer of SSE text into complete events and the unfinished remainder.
// Each event keeps the exact separator that ended it, so an untouched event is
// forwarded byte-for-byte.
//
// Hand-scanned rather than a regex, for two reasons. An SSE line ends with CRLF,
// LF or CR, so an event boundary is ANY TWO of those in a row — '\n\r\n' and
// '\r\n\r' included, which a fixed alternation misses while a generic one would
// read a single '\r\n' as two endings. And the scan RESUMES: re-scanning the
// whole buffer on every chunk is quadratic, and a multi-megabyte result — the
// case the cap exists for — would block the shared web process for seconds.
function newlineAt(text: string, i: number): number {
  if (text[i] === '\r') return text[i + 1] === '\n' ? 2 : 1;
  return text[i] === '\n' ? 1 : 0;
}

export function takeEvents(
  pending: string,
  from = 0,
): { events: Array<{ block: string; sep: string }>; rest: string; scanned: number } {
  const events: Array<{ block: string; sep: string }> = [];
  let start = 0;
  let i = Math.max(0, from);
  while (i < pending.length) {
    const first = newlineAt(pending, i);
    if (first === 0) {
      i += 1;
      continue;
    }
    // A lone '\r' at the very end may still become '\r\n': wait for more.
    if (pending[i] === '\r' && first === 1 && i + 1 >= pending.length) break;
    const second = newlineAt(pending, i + first);
    if (second === 0) {
      i += first;
      continue;
    }
    if (pending[i + first] === '\r' && second === 1 && i + first + 1 >= pending.length) break;
    events.push({ block: pending.slice(start, i), sep: pending.slice(i, i + first + second) });
    i += first + second;
    start = i;
  }
  const rest = pending.slice(start);
  // Resume THREE characters behind the tail — not one, not two. The longest
  // prefix of a boundary that can still be incomplete is '\r\n' + '\r' (a CRLF
  // line ending followed by a CR that may yet become CRLF), so an index further
  // back than len-3 can no longer become part of a boundary, and anything
  // nearer would miss one split across chunks exactly there. Verified by
  // fuzzing the scanner against a full rescan (review, 2026-09-15).
  return { events, rest, scanned: Math.max(0, rest.length - 3) };
}

// A UTF-8 BOM may precede the first field of a stream (SSE strips it).
const stripBom = (line: string): string => (line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);

function eventData(block: string): string | null {
  const data = block
    .split(/\r\n|\n|\r/)
    .map(stripBom)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''));
  return data.length > 0 ? data.join('\n') : null;
}

function withData(block: string, data: string): string {
  const kept = block
    .split(/\r\n|\n|\r/)
    // An empty line inside a block only happens on the EOF remainder (a blank
    // line is a boundary everywhere else), and keeping it would emit the data
    // line behind a blank one.
    .filter((line) => line !== '' && !stripBom(line).startsWith('data:'));
  return [...kept, `data: ${data}`].join('\n');
}

export const cappingForward =
  (requestId: string | number): ForwardFn =>
  (urlStr, method, headers, body, res) =>
    new Promise((resolve) => {
      let upstream: IncomingMessage | null = null;
      // A fault answers ONCE: whichever leg notices first writes the 502 (or
      // cuts the client loose, if the head is already out) and the rest are
      // no-ops. Without this a socket error a tick after the 502 truncated it.
      let answered = false;
      const fail = (why: string): void => {
        if (answered) return;
        answered = true;
        if (!res.headersSent) jsonError(res, 502, why);
        else res.destroy(); // mid-stream fault: cut the client loose rather than hang it
        resolve();
      };
      let upReq: http.ClientRequest;
      try {
        // Inside the try with the request itself: `new URL` throws synchronously
        // on a malformed session endpoint, and that is a relay fault with its own
        // 502 — never the bare 401 reserved for identity failures.
        const url = new URL(urlStr);
        const lib = url.protocol === 'http:' ? http : https;
        upReq = lib.request(
          {
            hostname: url.hostname,
            port: url.port || (url.protocol === 'http:' ? 80 : 443),
            path: url.pathname + url.search,
            method,
            // Identity encoding: a compressed body cannot be read to be capped.
            headers: { ...headers, 'accept-encoding': 'identity' },
          },
          (upRes) => {
            upstream = upRes;
            const status = upRes.statusCode ?? 502;
            const contentType = String(upRes.headers['content-type'] ?? '').toLowerCase();
            const encoding = String(upRes.headers['content-encoding'] ?? 'identity').toLowerCase();
            const isJson = contentType.startsWith('application/json');
            const isSse = contentType.startsWith('text/event-stream');
            const outHeaders = { ...upRes.headers };
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            // An upstream that dies mid-body is a Composio-side fault, and the
            // relay's contract is that those answer with a JSON 502 whenever the
            // head has not gone out yet (the JSON branch writes nothing until the
            // body is whole, so that is the common case).
            upRes.on('error', () => fail('upstream ended mid-response'));

            if (status < 200 || status >= 300 || encoding !== 'identity' || (!isJson && !isSse)) {
              // Nothing this relay can read to cap: the old pipe.
              res.writeHead(status, upRes.headers);
              upRes.pipe(res);
              upRes.on('end', resolve);
              return;
            }

            if (isJson) {
              const chunks: Buffer[] = [];
              let size = 0;
              upRes.on('data', (chunk: Buffer) => {
                size += chunk.length;
                if (size > MAX_BUFFERED_BYTES) {
                  upRes.destroy();
                  fail('Composio result too large to relay');
                  return;
                }
                chunks.push(chunk);
              });
              upRes.on('end', () => {
                if (answered || res.headersSent) return resolve();
                answered = true;
                const raw = Buffer.concat(chunks);
                const { capped } = capResponseText(raw.toString('utf8'), requestId);
                const out = capped === null ? raw : Buffer.from(capped, 'utf8');
                res.writeHead(status, { ...outHeaders, 'content-length': String(Buffer.byteLength(out)) });
                res.end(out);
                resolve();
              });
              return;
            }

            // SSE: forward event by event; only the response event is rewritten.
            res.writeHead(status, outHeaders);
            // BACKPRESSURE, which pipe() used to do for us: a slow sandbox client
          // on a chatty stream would otherwise pile writes up inside the shared
          // web process — the very thing the byte ceiling above guards against.
          const writeEvent = (text: string): void => {
            if (!res.write(text)) {
              upRes.pause();
              res.once('drain', () => upRes.resume());
            }
          };
          const decoder = new StringDecoder('utf8');
            let pending = '';
            let scanned = 0;
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              // The request HAS been answered: a socket reset racing the last
              // write must not then destroy a response already ended.
              answered = true;
              res.end();
              upRes.destroy();
              resolve();
            };
            upRes.on('data', (chunk: Buffer) => {
              if (done) return;
              pending += decoder.write(chunk);
              if (pending.length > MAX_BUFFERED_BYTES) {
                // One unterminated event this large: cut the client loose.
                done = true;
                res.destroy();
                upRes.destroy();
                resolve();
                return;
              }
              const { events, rest, scanned: next } = takeEvents(pending, scanned);
              pending = rest;
              scanned = next;
              for (const { block, sep } of events) {
                const data = eventData(block);
                const { capped, isResponse } =
                  data === null ? { capped: null, isResponse: false } : capResponseText(data, requestId);
                writeEvent(capped === null ? block + sep : withData(block, capped) + sep);
                if (isResponse) {
                  finish();
                  return;
                }
              }
            });
            upRes.on('end', () => {
              if (done) return;
              pending += decoder.end();
              // A stream may end WITHOUT the blank line after its last event —
              // the response would then go out uncapped. Cap the remainder the
              // same way before it leaves.
              if (pending) {
                const data = eventData(pending);
                const { capped } = data === null ? { capped: null } : capResponseText(data, requestId);
                writeEvent(capped === null ? pending : withData(pending, capped));
              }
              finish();
            });
          },
        );
      } catch {
        // http.request THROWS synchronously on a malformed header value — the
        // shape an env var pasted with a trailing newline has. Answer the
        // relay's own 502 rather than letting the rejection surface as the 401
        // reserved for identity failures.
        fail('the Composio session endpoint could not be called');
        return;
      }
      upReq.on('error', () => {
        upstream?.destroy();
        fail('upstream error');
      });
      // Registered AFTER `upReq` exists, deliberately: a listener that closes
      // over a `const` declared below it throws a ReferenceError the moment the
      // constructor throws synchronously (http.request does, on a header value
      // carrying a stray newline — the shape a pasted env var has), and an
      // uncaught throw inside an emitter takes the whole web process down.
      // The client going away cancels the request (MCP: closing the response
      // stream IS the cancellation), so the upstream leg goes with it.
      res.on('close', () => {
        upReq.destroy();
        resolve();
      });
      upReq.end(body);
    });

export async function handleComposioRelay(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string,
  deps: RelayDeps = {},
): Promise<void> {
  // Identity failures THROW (→ httpServer's bare 401); everything below
  // answers for itself.
  const identity = await resolveIdentity(req.headers);

  const tech = await (deps.getTech ?? getTechnician)(identity.tenantId, identity.technicianRef);
  if (!tech) return jsonError(res, 403, 'no roster row for this badge');
  if (isInactiveState(tech.state)) {
    return jsonError(res, 403, 'this badge belongs to a deactivated team member');
  }

  // Mint-on-demand for a session-less row. The key-unset skip lives in the
  // CALLER here (mirroring lifecycle.ts) — ensurePersonSession itself throws
  // from the keyless SDK constructor, it does not return 'skipped'.
  let sessionId = tech.composio_session_id;
  if (!sessionId) {
    if (!process.env.COMPOSIO_API_KEY) return jsonError(res, 503, 'session not ready');
    try {
      const result = await (deps.ensureSession ?? ensurePersonSession)(tech);
      if (result.status === 'skipped') return jsonError(res, 503, 'session not ready');
      sessionId = result.sessionId;
    } catch {
      return jsonError(res, 503, 'session not ready');
    }
  }

  // Declared OUTSIDE the block so the billing gate below can read it: the relay
  // also proxies initialize / notifications/initialized / tools/list and bare
  // GET SSE opens, none of which are billable Composio tool calls.
  let parsed: unknown;
  if (rawBody.length > 0) {
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return jsonError(res, 400, 'body is not valid JSON');
    }
    const offending = findConnectedAccountKey(parsed);
    if (offending) {
      return jsonError(res, 400, `argument key '${offending}' is not allowed through the relay`);
    }
    // Answered here, before Composio or the cost counter ever sees it.
    const blocked = blockedToolCall(parsed);
    if (blocked) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: blocked.id,
          result: { content: [{ type: 'text', text: BLOCKED_TOOL_TEXT }], isError: true },
        }),
      );
      return;
    }
  }

  // The spread is load-bearing after mint-on-demand: the original row still
  // carries a null session id and getSessionMcpUrl throws on it.
  let url: string;
  try {
    url = await (deps.getMcpUrl ?? getSessionMcpUrl)({ ...tech, composio_session_id: sessionId });
  } catch {
    return jsonError(res, 502, 'could not resolve the Composio session');
  }

  // Fresh header set, built HERE so stubs can assert it: never forward the
  // identity headers to Composio; whitelist the MCP protocol headers a
  // stateful streamable-HTTP server needs post-initialize.
  const body = Buffer.from(rawBody);
  const apiKey = process.env.COMPOSIO_RELAY_API_KEY ?? process.env.COMPOSIO_API_KEY;
  // Keyless forwarding would surface as a Composio 401 — indistinguishable
  // from a badge/HMAC failure at the agent. Answer for the misconfiguration
  // explicitly instead (review finding, Phase 1).
  if (!apiKey) return jsonError(res, 503, 'relay is not configured with a Composio API key');
  const headers: Record<string, string> = {
    'content-type': header(req, 'content-type') ?? 'application/json',
    accept: header(req, 'accept') ?? 'application/json, text/event-stream',
    'content-length': String(body.length),
    'x-api-key': apiKey,
  };
  for (const name of ['mcp-session-id', 'mcp-protocol-version']) {
    const value = header(req, name);
    if (value) headers[name] = value;
  }

  // Bill exactly the tool CALLS. Everything above this point can early-return
  // without ever reaching Composio, so the counter sits here at the forward —
  // not at the roster read, where it would count requests that never billed.
  if (req.method === 'POST' && isToolCall(parsed)) {
    // .catch() at the CALL SITE, not trusting the recorder to swallow its own
    // failures: isolation has to be a property of this handler, or it silently
    // evaporates the day someone swaps the default or injects another recorder.
    await (deps.recordCost ?? recordComposioCall)({
      tenantId: identity.tenantId,
      technicianRef: identity.technicianRef,
    }).catch((err: unknown) => {
      console.error(
        `cost: relay tool_call not recorded — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  // A tools/call carries the result a model will read, so its response goes
  // through the size cap; every other relayed request (initialize, tools/list,
  // notifications) is protocol and stays a plain pipe. An injected `forward`
  // (tests) replaces both legs.
  const requestId = isToolCall(parsed) ? parsed.id : undefined;
  const leg =
    deps.forward ??
    (req.method === 'POST' && (typeof requestId === 'string' || typeof requestId === 'number')
      ? cappingForward(requestId)
      : defaultForward);
  await leg(url, req.method ?? 'POST', headers, body, res);
}
