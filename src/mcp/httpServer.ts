import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { resolveIdentity, seatTokenOf } from './identity.js';
import { handleInboundWebhook } from '../inbound/webhook.js';
import {
  handleRecordingWebhook,
  handleVoiceWebhook,
  type RecordingStatus,
} from '../inbound/phoneWebhook.js';
import { newSeatToken, sha256hex } from '../control/badges.js';
import { buildBadgeResponse } from '../control/badgeFile.js';
import { buildNudgeDelivery, completeNudgeDelivery } from '../control/nudgeQueue.js';
import { buildOfficeDelivery, completeOfficeDelivery } from '../control/officeQueue.js';
import {
  FILE_MAX_BYTES,
  clearSandboxAssignmentIfRef,
  completeSandboxRecycle,
  createFile,
  fileVisibleTo,
  getFile,
  getTechnicianView,
  linksOf,
  readFileBytes,
  getHostByTokenHash,
  getSeatBotUsername,
  getSeatByHostRef,
  getSeatIdentityByTokenHash,
  insertSeatTurns,
  getTechnician,
  getTechnicianById,
  getTenant,
  isInactiveState,
  listLiveGlueTechnicianIds,
  listPoolRowsForHost,
  mintSeatToken,
  pingDb,
  retireSeatByHostRef,
  setSandboxBotId,
  touchSeatPull,
  type Json,
  type Seat,
  type SeatTurnInsert,
  type Technician,
} from '../db/index.js';
import { isValidService, recordOpsEvent } from '../db/opsEvents.js';
import { recordHostMetrics } from '../db/hostMetrics.js';
import { notifyOpsTransition } from '../telegram/opsNotify.js';
import { handleComposioRelay, isRelayPath } from '../composio/relayHandler.js';
import { handleBoardRequest, isBoardPath } from '../telegram/boardApi.js';
import { handleConsoleRequest, isConsolePath } from '../console/consoleApi.js';
import { handleAdminRequest, isAdminPath } from '../admin/adminApi.js';
import { UUID_RE, isActiveManager } from './tools/shared.js';
import { QUERY_SPINE_MAX_ROWS, runSpineQuery } from '../db/querySpine.js';
import { toCsv } from './csv.js';

// Central HTTP entrypoint (Architecture A). Every NemoClaw bot reaches this one
// server through the gateway. It runs STATELESS (sessionIdGenerator: undefined):
// per request we verify the gateway's signed identity header, build a fresh
// identity-scoped MCP server, and serve one Streamable HTTP request — so any
// replica can serve any request (the captureId resume keeps no in-memory state).
//
// mTLS + private-network IP allowlist is provisioned at deploy time; in-code, the
// HMAC-signed identity header (resolveIdentityFromHeaders) is what this process
// trusts. The stdio entrypoint in server.ts is unchanged (used by tests/dev).

// Optional coarse source-IP allowlist in front of mTLS. Skipped if unset, so the
// network/mTLS layer is the boundary unless ALLOWED_CLIENT_IPS is configured.
function allowed(req: http.IncomingMessage): boolean {
  const list = process.env.ALLOWED_CLIENT_IPS;
  if (!list) return true;
  const ips = list.split(',').map((s) => s.trim()).filter(Boolean);
  const ip = req.socket.remoteAddress;
  return !!ip && ips.includes(ip);
}

// The request stream is consumable once, so the webhook path reads the RAW string
// (HMAC is over the exact bytes) while the MCP path parses JSON — never both.
// maxBytes (optional) aborts oversized bodies instead of buffering them: the
// board path reads pre-auth on a publicly-distributed URL, so an uncapped read
// there is a memory-DoS invitation. Existing callers pass no cap (unchanged).
async function readRawBody(req: http.IncomingMessage, maxBytes?: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (maxBytes !== undefined && total > maxBytes) {
      req.destroy();
      throw Object.assign(new Error('request body exceeds cap'), { code: 'BODY_TOO_LARGE' });
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Raw bytes, for the file store's upload (step 2d). Over the cap it stops
// KEEPING bytes but reads on to the end, so the caller's 413 reaches a client
// that is still sending (answering mid-upload breaks the client's write and it
// never sees the reply). Past twice the cap it gives up and cuts the
// connection: nobody gets to make the server read forever.
function readBinaryBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const tooLarge = () => Object.assign(new Error('request body exceeds cap'), { code: 'BODY_TOO_LARGE' });
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total <= maxBytes) chunks.push(chunk);
      else if (total > 2 * maxBytes) {
        req.destroy();
        reject(tooLarge());
      }
    });
    req.once('end', () => (total > maxBytes ? reject(tooLarge()) : resolve(Buffer.concat(chunks))));
    req.once('error', reject);
  });
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const raw = await readRawBody(req);
  return raw.length ? JSON.parse(raw) : undefined;
}

// Inbound handler status → HTTP code, with deliberate retry semantics: 2xx and 4xx
// tell Composio "stop" (deterministic — a retry yields the same result); 503 tells it
// "retry" (a transient fault a retry could fix). Collapsing all of these to one code
// would either retry-storm poison pills or drop recoverable captures.
const INBOUND_STATUS_CODES: Record<string, number> = {
  ingested: 200,
  duplicate: 200,
  unrouted: 200,
  skipped_non_work: 200,
  skipped_offboarded: 200,
  bad_signature: 401,
  bad_payload: 400,
  unknown_tenant: 422,
  transient_error: 503,
};

// Composio connector webhooks. Authenticated by their OWN HMAC over the body
// (webhook-signature) — NOT the gateway identity header and NOT the source-IP
// allowlist (Composio posts from the public internet, not the gateway). So this runs
// BEFORE allowed(). Its own try/catch maps handler status → HTTP code; a genuine
// server fault (e.g. COMPOSIO_WEBHOOK_SECRET unset) → 500 so Composio retries.
async function handleInbound(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const raw = await readRawBody(req);
    // Set INBOUND_DEBUG=1 to print the exact payload + headers Composio sends, so the
    // real envelope/field names can be read off a live trigger (the normalizer mapping
    // is a best-effort guess until then). Dev-only; leave unset in any real deployment.
    if (process.env.INBOUND_DEBUG) {
      console.error('[INBOUND_DEBUG] url=', req.url);
      console.error('[INBOUND_DEBUG] headers=', JSON.stringify(req.headers, null, 2));
      console.error('[INBOUND_DEBUG] body=', raw);
      // Persist the exact raw bytes + signing headers so the signature scheme can be
      // verified offline (re-typing the body would corrupt the bytes the HMAC covers).
      try {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(
          process.env.INBOUND_DEBUG_FILE ?? 'inbound-last.json',
          JSON.stringify({
            id: req.headers['webhook-id'],
            timestamp: req.headers['webhook-timestamp'],
            signature: req.headers['webhook-signature'],
            body: raw,
          }),
        );
      } catch {
        /* best-effort */
      }
    }
    // Standard Webhooks (Svix) scheme: all three headers feed the signature check.
    const pick = (h: string | string[] | undefined): string | undefined =>
      Array.isArray(h) ? h[0] : h;
    const result = await handleInboundWebhook(
      raw,
      {
        id: pick(req.headers['webhook-id']),
        timestamp: pick(req.headers['webhook-timestamp']),
        signature: pick(req.headers['webhook-signature']),
      },
      {},
    );
    res.writeHead(INBOUND_STATUS_CODES[result.status] ?? 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(result));
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// SignalWire phone webhooks (LaML). Authenticated by validateRequest over
// X-SignalWire-Signature (SignalWire posts from the public internet, not the
// gateway), so like /inbound/ they route BEFORE the IP allowlist. Bodies are
// small form-encoded payloads; capped like the board path (pre-auth, public URL).
const PHONE_BODY_CAP = 64 * 1024;
const PHONE_RECORDING_CODES: Record<RecordingStatus, number> = {
  enqueued: 200,
  duplicate: 200,
  unknown_number: 200,
  ignored_status: 200,
  bad_signature: 403,
  bad_payload: 400,
  transient_error: 503,
};

function pickHeader(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}
// The exact URL SignalWire signed = the configured public base + the path/query it
// posted to. Reconstructed here for validateRequest.
function signalwireFullUrl(req: http.IncomingMessage): string {
  return `${process.env.SIGNALWIRE_WEBHOOK_BASE_URL ?? ''}${req.url ?? ''}`;
}

async function handlePhoneVoice(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const raw = await readRawBody(req, PHONE_BODY_CAP);
    const result = await handleVoiceWebhook({
      fullUrl: signalwireFullUrl(req),
      rawBody: raw,
      signature: pickHeader(req.headers['x-signalwire-signature']),
    });
    if (result.status === 'bad_signature') {
      res.writeHead(403);
      res.end();
      return;
    }
    if (result.status === 'bad_payload') {
      res.writeHead(400);
      res.end();
      return;
    }
    // ok_forward / ok_voicemail / unknown_number all return cXML the caller executes.
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(result.cxml);
  } catch (err) {
    if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
      if (!res.headersSent) {
        res.writeHead(413);
        res.end();
      }
      return;
    }
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

async function handlePhoneRecording(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const raw = await readRawBody(req, PHONE_BODY_CAP);
    const url = new URL(req.url ?? '', 'http://internal'); // base only to parse the query
    const result = await handleRecordingWebhook({
      fullUrl: signalwireFullUrl(req),
      rawBody: raw,
      query: {
        tenant: url.searchParams.get('tenant') ?? undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
      },
      signature: pickHeader(req.headers['x-signalwire-signature']),
    });
    res.writeHead(PHONE_RECORDING_CODES[result.status] ?? 200, {
      'content-type': 'application/json',
    });
    res.end(JSON.stringify(result));
  } catch (err) {
    if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
      if (!res.headersSent) {
        res.writeHead(413);
        res.end();
      }
      return;
    }
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// Badge pull for host machines. Authenticated by the host's own bearer token
// (stored server-side only as a sha256 fingerprint) — NOT the gateway identity
// header and NOT the IP allowlist (hosts' egress IPs rotate), so like /inbound/
// it runs BEFORE allowed(). Every failure is a bare 401: an unauthenticated
// probe learns nothing (not even whether the route exists behind auth).
async function handleBadgePull(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    const body = await buildBadgeResponse(host.id);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// Mint a seat's token (step 4, delivery "C"): the box's install.sh calls this
// with its HOST token and gets the plaintext back exactly once — it writes it
// straight into the seat's env file, never to a terminal. Host-scoped: a box can
// only mint for a seat recorded on THAT box, so a host token cannot reach
// another box's people (the same trust it already has over its own badges).
// Every mint REPLACES the fingerprint, which is rotation: the previous token
// stops working on its very next request. Before allowed(), like every control
// route; an unauthenticated probe gets a bare 401.
async function handleSeatToken(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const seatRef = (body as { seatRef?: unknown })?.seatRef;
    if (typeof seatRef !== 'string' || !/^[a-z0-9_]+$/.test(seatRef)) {
      json(400, { error: 'seatRef must match ^[a-z0-9_]+$' });
      return;
    }
    const seat = await getSeatByHostRef(host.id, seatRef);
    if (!seat) {
      json(404, { error: `no live seat ${seatRef} on this host` });
      return;
    }
    const person = await getTechnicianById(seat.technician_id, seat.tenant_id);
    if (!person || isInactiveState(person.state)) {
      json(409, { error: 'this seat belongs to a deactivated or missing team member' });
      return;
    }
    const minted = newSeatToken();
    await mintSeatToken(seat.id, minted.hash);
    json(200, {
      token: minted.badge,
      seatRef: seat.seat_ref,
      tenantId: seat.tenant_id,
      technicianRef: person.ref,
      botUsername: await getSeatBotUsername(seat),
    });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// "Who am I?" — a glue seat asks this at start (step 4). Its token IS the
// answer: firm, person, Telegram account and the firm's timezone, so the box
// keeps no identity of its own to drift. Seat tokens only — the HMAC headers
// prove a person, not a seat. A deactivated person gets 403, and the glue then
// refuses to start rather than run on a guessed identity.
async function handleSeatWhoami(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    if (!seatTokenOf(req.headers)) {
      res.writeHead(401);
      res.end();
      return;
    }
    let identity;
    try {
      identity = await resolveIdentity(req.headers);
    } catch (err) {
      // An unknown token is the caller's fault (401); a DB outage is ours and
      // falls through to the 500 below, so the glue reads it as "retry", not
      // "your token is bad".
      if (err instanceof Error && err.message === 'unknown seat token') {
        res.writeHead(401);
        res.end();
        return;
      }
      throw err;
    }
    const [person, tenant] = await Promise.all([
      getTechnician(identity.tenantId, identity.technicianRef),
      getTenant(identity.tenantId),
    ]);
    if (!person || isInactiveState(person.state)) {
      json(403, { error: 'this seat belongs to a deactivated or missing team member' });
      return;
    }
    json(200, {
      seatRef: identity.seatRef,
      tenantId: identity.tenantId,
      technicianRef: identity.technicianRef,
      telegramUserId: person.telegram_user_id,
      timezone: tenant?.timezone ?? 'UTC',
      // Step 2a: the glue picks the manager or technician rulebook from this.
      tier: person.tier,
      shareConversation: sharesConversation(person),
    });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// STEP 2b — a manager seat's export_query (plan 2026-09-28-step-2b-manager-files-
// sandbox-skills). The same read-only query_spine path the model uses, but EVERY
// row (up to the spine's own 1,000) comes back as CSV for the glue to write into
// the manager's sandbox — never through the model, whose copy of a result is cut
// at 20,000 characters and retyped (the lossy path seen live on 2026-09-27).
// Only an ACTIVE manager: the same predicate query_spine's tier gate uses.
export const SEAT_EXPORT_SQL_MAX = 20_000;

// The DATABASE refused the SQL (a SQLSTATE like 42703 / 42501): the model reads
// it and fixes its query. Anything else — supabase-js reports an unreachable
// database as an error with an empty code ("fetch failed") — is ours: a 500 the
// glue reads as "retry", never "your SQL is wrong" (phase 1 review).
export function isQueryRefusal(err: unknown): boolean {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code);
}
async function handleSeatExport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    if (!seatTokenOf(req.headers)) {
      res.writeHead(401);
      res.end();
      return;
    }
    let identity;
    try {
      identity = await resolveIdentity(req.headers);
    } catch (err) {
      if (err instanceof Error && err.message === 'unknown seat token') {
        res.writeHead(401);
        res.end();
        return;
      }
      throw err;
    }
    if (!(await isActiveManager(identity))) {
      json(403, { error: 'exports are for an active manager only' });
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const sql = (body as { sql?: unknown } | undefined)?.sql;
    if (typeof sql !== 'string' || !sql.trim() || sql.length > SEAT_EXPORT_SQL_MAX) {
      json(400, { error: `sql must be one SELECT of at most ${SEAT_EXPORT_SQL_MAX} characters` });
      return;
    }
    let result;
    try {
      result = await runSpineQuery(identity.tenantId, sql, {
        technicianRef: identity.technicianRef,
        maxRows: QUERY_SPINE_MAX_ROWS,
      });
    } catch (err) {
      if (!isQueryRefusal(err)) throw err;
      json(400, { error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const { csv, columns } = toCsv(result.rows);
    json(200, { csv, columns, rowCount: result.rowCount, truncated: result.truncated });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// THE FILE STORE'S BYTES (plan 2026-09-28-step-2d-files, Phase 2). A seat
// uploads a photo or document its person sent (or a sandbox file), and
// downloads one its person may see. Seat token via seatOfRequest: 401 unknown,
// 403 a deactivated person — resolveIdentity alone checks only the seat's
// retirement. Bytes never leave through anything but these two routes.
const FILE_ID_PATH = /^\/seat\/files\/([^/]+)$/;

async function handleSeatFileUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    const who = await seatOfRequest(req);
    if ('status' in who) {
      res.writeHead(who.status);
      res.end();
      return;
    }
    const url = new URL(req.url ?? '', 'http://internal');
    const kind = url.searchParams.get('kind');
    const name = (url.searchParams.get('name') ?? '').trim();
    if (kind !== 'photo' && kind !== 'document') {
      json(400, { error: 'kind must be photo or document' });
      return;
    }
    if (!name) {
      json(400, { error: 'name is required' });
      return;
    }
    // Too big is answered 413 and the connection closed: a declared length is
    // refused before a byte is read; a stream that runs over, once it ends.
    const tooBig = () => {
      res.writeHead(413, { 'content-type': 'application/json', connection: 'close' });
      res.end(JSON.stringify({ error: 'the file is over 20 MB' }));
    };
    if (Number(req.headers['content-length'] ?? 0) > FILE_MAX_BYTES) {
      tooBig();
      return;
    }
    let bytes: Buffer;
    try {
      bytes = await readBinaryBody(req, FILE_MAX_BYTES);
    } catch (err) {
      if ((err as { code?: unknown }).code === 'BODY_TOO_LARGE') {
        tooBig();
        return;
      }
      throw err;
    }
    if (bytes.length === 0) {
      json(400, { error: 'the file is empty' });
      return;
    }
    const mime = (req.headers['content-type'] ?? '').split(';')[0].trim() || 'application/octet-stream';
    const file = await createFile({
      tenantId: who.seat.tenant_id,
      kind,
      fileName: name,
      mimeType: mime,
      bytes,
      uploadedByRef: who.person.ref,
      uploadedBy: who.person.id,
      source: req.headers['x-file-source'] === 'sandbox' ? 'sandbox' : 'telegram',
    });
    json(200, { id: file.id, fileName: file.file_name, sizeBytes: file.size_bytes });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

async function handleSeatFileDownload(req: http.IncomingMessage, res: http.ServerResponse, fileId: string): Promise<void> {
  try {
    const who = await seatOfRequest(req);
    if ('status' in who) {
      res.writeHead(who.status);
      res.end();
      return;
    }
    // A malformed id is simply not a file (never a database error, never a 500).
    if (!UUID_RE.test(fileId)) {
      res.writeHead(404);
      res.end();
      return;
    }
    const tenantId = who.seat.tenant_id;
    const file = await getFile(tenantId, fileId);
    // An ACTIVE manager, the tools' rule (activeManager): an invited manager
    // sees what a technician would.
    const manager = who.person.tier === 'manager' && who.person.state === 'active';
    const visible =
      !!file &&
      fileVisibleTo(file, manager ? [] : await linksOf(tenantId, fileId), {
        tier: manager ? 'manager' : 'technician',
        ref: who.person.ref,
        personId: who.person.id,
        view: manager ? null : await getTechnicianView(tenantId, who.person.id),
      });
    // Missing, deleted and out of view all read the same: a 404 never
    // confirms that a file exists.
    if (!file || !visible) {
      res.writeHead(404);
      res.end();
      return;
    }
    const bytes = await readFileBytes(file);
    res.writeHead(200, {
      'content-type': file.mime_type,
      'content-length': String(bytes.length),
      'x-file-name': encodeURIComponent(file.file_name),
      'cache-control': 'no-store',
    });
    res.end(bytes);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// STEP 3: a glue seat that pulled its inbox this recently is LIVE, and the box's
// bash runners skip its person. Twelve missed 10 s polls: long enough that a
// slow Render response never flaps a seat back to the runners, short enough that
// a stopped glue (rollback.sh) hands its person back to openclaw in two minutes.
export const LIVE_GLUE_WINDOW_MS = 120_000;
const liveGlueSince = (): string => new Date(Date.now() - LIVE_GLUE_WINDOW_MS).toISOString();

const UUID = UUID_RE;

// A MANAGER's conversation with their assistant is private (operator,
// 2026-09-24): it is never uploaded, never read by the office, and the seat
// sends no "the office can read our chats" notice. The office asks a manager
// directly instead. Everyone else's is shared (operator, 2026-09-23).
export const sharesConversation = (person: Pick<Technician, 'tier'>): boolean => person.tier !== 'manager';

// The seat a request's token names, and its person — the /seat/whoami posture:
// no or unknown token → 401, a deactivated or missing person → 403, a database
// failure → thrown (the caller's 500, which the glue reads as "retry").
async function seatOfRequest(
  req: http.IncomingMessage,
): Promise<{ seat: Seat; person: Technician } | { status: 401 | 403 }> {
  const token = seatTokenOf(req.headers);
  if (!token) return { status: 401 };
  const found = await getSeatIdentityByTokenHash(sha256hex(token));
  if (!found) return { status: 401 };
  const person = await getTechnicianById(found.seat.technician_id, found.seat.tenant_id);
  if (!person || isInactiveState(person.state)) return { status: 403 };
  return { seat: found.seat, person };
}

/** One inbox item: `phone` is texted to the person word for word; `note` is for their assistant. */
export interface SeatInboxItem {
  id: string;
  leg: 'phone' | 'note';
  text: string;
}

// STEP 3 — a glue seat's inbox (plan 2026-09-23-step-3-office-reaches-glue-seats).
// The glue pulls with its SEAT token and gets only its own person's rows: the
// phone leg (nudges, chat office rows, pushes) and the note leg (assistant
// office rows), exactly as the box's two runners would have been served them —
// same serve counting, same freezes. The pull stamps the seat live, which takes
// its person out of the runners' host pulls. It also carries who the seat is,
// so a running glue learns of a rebind or a timezone change without a restart.
async function handleSeatInboxPull(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  try {
    const who = await seatOfRequest(req);
    if ('status' in who) {
      res.writeHead(who.status);
      res.end();
      return;
    }
    const { seat, person } = who;
    // seat.host_id stands in for the person's technicians.host_id, which is what
    // the queue reads filter on. They agree by construction: bind_telegram writes
    // the roster's host FROM the seat (roster.ts), and assign-host's
    // add-glue-seat records the seat on the person's host. If they ever
    // diverged, this inbox would come back empty and the runners would not skip
    // the person — so the two must move together.
    // The timezone FIRST: it is the one read that fails the whole pull, and it
    // must fail before either builder has counted a serve it will not deliver.
    const tenant = await getTenant(seat.tenant_id);
    await touchSeatPull(seat.id);
    const scope = { onlyTechnicianId: seat.technician_id };
    // Each leg on its own: a builder counts its serves as it goes, so one leg
    // failing must never throw away the other leg's already-counted items — ten
    // such pulls would freeze rows that never left Render.
    const [phone, notes] = await Promise.allSettled([
      buildNudgeDelivery(seat.host_id, {}, scope),
      buildOfficeDelivery(seat.host_id, {}, scope),
    ]);
    for (const leg of [phone, notes]) {
      if (leg.status === 'rejected') console.error('[seat/inbox] one leg of the pull failed', leg.reason);
    }
    const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');
    const items: SeatInboxItem[] = [
      ...(phone.status === 'fulfilled' ? phone.value.nudges : []).map((n) => ({
        id: n.id,
        leg: 'phone' as const,
        text: decode(n.directMessageB64),
      })),
      ...(notes.status === 'fulfilled' ? notes.value.messages : []).map((m) => ({
        id: m.id,
        leg: 'note' as const,
        text: decode(m.directMessageB64),
      })),
    ];
    json(200, {
      seat: {
        telegramUserId: person.telegram_user_id,
        timezone: tenant?.timezone ?? 'UTC',
        // A promotion or demotion reaches a running glue here; it restarts on it.
        shareConversation: sharesConversation(person),
      },
      items,
    });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// The glue's per-item report. The seat, its host and its person all come from the
// TOKEN; the body names only the item, its leg and the outcome.
async function handleSeatInboxReport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const who = await seatOfRequest(req);
    if ('status' in who) {
      res.writeHead(who.status);
      res.end();
      return;
    }
    let body: unknown;
    try {
      const raw = await readRawBody(req, 16 * 1024);
      body = raw.length ? JSON.parse(raw) : undefined;
    } catch (err) {
      if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
        json(413, { error: 'body too large' });
        return;
      }
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    if (!UUID.test(id)) {
      json(400, { error: 'id must be an inbox item id (uuid)' });
      return;
    }
    if (b.leg !== 'phone' && b.leg !== 'note') {
      json(400, { error: "leg must be 'phone' or 'note'" });
      return;
    }
    if (b.outcome !== 'delivered' && b.outcome !== 'failed') {
      json(400, { error: "outcome must be 'delivered' or 'failed'" });
      return;
    }
    const detail = typeof b.detail === 'string' ? b.detail.slice(0, 300) : null;
    const { seat } = who;
    // A report is proof of life too: one long pull (slow Telegram, many items)
    // must not age the seat out and hand its person back to the runners mid-pull.
    await touchSeatPull(seat.id);
    const scope = { onlyTechnicianId: seat.technician_id };
    const result =
      b.leg === 'phone'
        ? await completeNudgeDelivery(seat.host_id, id, b.outcome, detail, {}, scope)
        : await completeOfficeDelivery(seat.host_id, id, b.outcome, detail, {}, scope);
    json(200, { result });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// STEP 3 — a glue seat uploads its conversation (plan 2026-09-23-step-3-office-
// reaches-glue-seats), so the office reads what an assistant knows instead of
// asking it. Tenant, person and seat come from the TOKEN; the body names only
// the turns. A turn is cut rather than refused where it can be (the office
// body idiom: the words already exist) and skipped only when it is not a turn.
export const SEAT_TURN_TEXT_MAX = 8000;
export const SEAT_TURN_ARGS_MAX = 4000;
const SEAT_CONVERSATION_BODY_CAP = 256 * 1024;
const SEAT_CONVERSATION_MAX_TURNS = 200;

// Postgres text refuses NUL, and a cut through the middle of an emoji would
// leave half a character: cut on whole characters, NULs gone.
function cleanTurnText(s: string, max: number): string {
  const chars = Array.from(s.replace(/\u0000/g, ''));
  return chars.length <= max ? chars.join('') : chars.slice(0, max).join('');
}

// A batch the database refuses for its DATA (22xxx bad value, 23xxx constraint)
// is stored row by row, dropping only the rows it refuses — otherwise one bad
// turn would be re-sent, oldest first, and block every turn after it forever.
// Any other failure (an outage) stays a 500, and the glue keeps the batch.
async function insertSeatTurnsTolerant(rows: SeatTurnInsert[]): Promise<{ stored: number; dropped: number }> {
  try {
    return { stored: await insertSeatTurns(rows), dropped: 0 };
  } catch (err) {
    const code = String(((err as { cause?: { code?: unknown } }).cause?.code as string | undefined) ?? '');
    if (!/^2[23]/.test(code)) throw err;
    let stored = 0;
    let dropped = 0;
    for (const row of rows) {
      try {
        stored += await insertSeatTurns([row]);
      } catch (rowErr) {
        const rowCode = String(((rowErr as { cause?: { code?: unknown } }).cause?.code as string | undefined) ?? '');
        if (!/^2[23]/.test(rowCode)) throw rowErr;
        dropped += 1;
      }
    }
    console.error(`[seat/conversation] dropped ${dropped} turn(s) the database refused (${code})`);
    return { stored, dropped };
  }
}

export function seatTurnsFromBody(
  body: unknown,
  seat: Pick<Seat, 'id' | 'tenant_id' | 'technician_id'>,
): SeatTurnInsert[] | null {
  const turns = (body as { turns?: unknown })?.turns;
  if (!Array.isArray(turns) || turns.length > SEAT_CONVERSATION_MAX_TURNS) return null;
  const out: SeatTurnInsert[] = [];
  for (const raw of turns as Array<Record<string, unknown>>) {
    if (!raw || typeof raw.id !== 'string' || !UUID.test(raw.id)) continue;
    if (raw.role !== 'person' && raw.role !== 'assistant' && raw.role !== 'tool') continue;
    if (typeof raw.at !== 'string' || Number.isNaN(Date.parse(raw.at))) continue;
    if (typeof raw.sessionId !== 'string' || !raw.sessionId || raw.sessionId.length > 200) continue;
    const text = typeof raw.text === 'string' ? cleanTurnText(raw.text, SEAT_TURN_TEXT_MAX) : null;
    const tool = typeof raw.tool === 'string' ? cleanTurnText(raw.tool, 200) : null;
    let args: Json | null = null;
    if (raw.args !== undefined && raw.args !== null) {
      // jsonb refuses a NUL anywhere, even escaped: drop it from every string
      // value as it is encoded (never by editing the encoded text, which would
      // break a string that merely CONTAINS the characters backslash-u-0000).
      const encoded = JSON.stringify(raw.args, (_k, v: unknown) =>
        typeof v === 'string' ? v.replace(/\u0000/g, '') : v,
      );
      args = encoded.length <= SEAT_TURN_ARGS_MAX ? (JSON.parse(encoded) as Json) : { truncated: true };
    }
    out.push({
      id: raw.id,
      tenantId: seat.tenant_id,
      technicianId: seat.technician_id,
      seatId: seat.id,
      sessionId: raw.sessionId,
      at: new Date(raw.at).toISOString(),
      role: raw.role,
      text,
      tool,
      args,
      ok: typeof raw.ok === 'boolean' ? raw.ok : null,
    });
  }
  return out;
}

async function handleSeatConversation(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const who = await seatOfRequest(req);
    if ('status' in who) {
      res.writeHead(who.status);
      res.end();
      return;
    }
    // An honest oversized client gets a clean 413 from its Content-Length before
    // any read (the board's idiom); a length-less flood is cut off by the cap.
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > SEAT_CONVERSATION_BODY_CAP) {
      json(413, { error: 'body too large' });
      return;
    }
    let body: unknown;
    try {
      const raw = await readRawBody(req, SEAT_CONVERSATION_BODY_CAP);
      body = raw.length ? JSON.parse(raw) : undefined;
    } catch (err) {
      if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
        json(413, { error: 'body too large' });
        return;
      }
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const rows = seatTurnsFromBody(body, who.seat);
    if (!rows) {
      json(400, { error: `turns must be an array of at most ${SEAT_CONVERSATION_MAX_TURNS}` });
      return;
    }
    // The second guard for a manager's privacy (the first: their glue never
    // uploads). Accepted and dropped, so a glue that has not yet restarted on a
    // promotion clears its outbox instead of retrying forever.
    if (!sharesConversation(who.person)) {
      json(200, { stored: 0, private: true });
      return;
    }
    const { stored, dropped } = await insertSeatTurnsTolerant(rows);
    json(200, dropped ? { stored, dropped } : { stored });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// The voice's outbox pull (plan 2026-08-15 feature B, Phase 4): queued nudges
// for this host's sandboxes, served until acked. Same host-token auth +
// bare-401 posture as the badge pull.
async function handleNudgePull(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    const body = await buildNudgeDelivery(host.id, {}, {
      skipTechnicianIds: await listLiveGlueTechnicianIds(host.id, liveGlueSince()),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// The box's per-item delivery report. hostId comes from the TOKEN, never the
// body (the ops-report rule), so a host can only move its own rows. Body
// capped (the board's idiom): this is a machine's one-line report, never a
// payload.
async function handleNudgeReport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body: unknown;
    try {
      const raw = await readRawBody(req, 16 * 1024);
      body = raw.length ? JSON.parse(raw) : undefined;
    } catch (err) {
      if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
        json(413, { error: 'body too large' });
        return;
      }
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const report = b.outcome;
    // UUID-shaped or 400: a malformed id would hit PostgREST's 22P02 and 500
    // (Phase-4 review F5) — noise from a token-holder, but a clean 400 beats
    // a fake server error.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      json(400, { error: 'id must be a nudge id (uuid)' });
      return;
    }
    if (report !== 'delivered' && report !== 'failed') {
      json(400, { error: "outcome must be 'delivered' or 'failed'" });
      return;
    }
    const detail = typeof b.detail === 'string' ? b.detail : null;
    const result = await completeNudgeDelivery(host.id, id, report, detail);
    json(200, { result });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// The office queue's pull (build 5.5 Phase 3): queued agent-addressed
// messages for this host's sandboxes, served until acked. Same host-token
// auth + bare-401 posture as the nudge pull it sits beside.
async function handleOfficePull(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    const body = await buildOfficeDelivery(host.id, {}, {
      skipTechnicianIds: await listLiveGlueTechnicianIds(host.id, liveGlueSince()),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// The box's per-item office delivery report — the /control/nudges POST shape:
// hostId from the TOKEN (the ops-report rule), body capped, uuid-checked.
async function handleOfficeReport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body: unknown;
    try {
      const raw = await readRawBody(req, 16 * 1024);
      body = raw.length ? JSON.parse(raw) : undefined;
    } catch (err) {
      if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
        json(413, { error: 'body too large' });
        return;
      }
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const report = b.outcome;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      json(400, { error: 'id must be an office message id (uuid)' });
      return;
    }
    if (report !== 'delivered' && report !== 'failed') {
      json(400, { error: "outcome must be 'delivered' or 'failed'" });
      return;
    }
    const detail = typeof b.detail === 'string' ? b.detail : null;
    const result = await completeOfficeDelivery(host.id, id, report, detail);
    json(200, { result });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// The box's seat-bot report: "these are the bots my seats are running".
//
// WHY THE BOX TELLS US AND NOT THE OTHER WAY ROUND. A Mini App launch verifies
// against the bot's NUMERIC id, and the id is learned from getMe — which needs
// the token, which lives on the box and must never reach Render (the whole
// point of the signature scheme). So the box, which already holds the tokens to
// run the bots, reports the public half up the channel it already polls. This
// is what makes a provisioned seat arrive allowlisted with nobody typing
// anything; before it, every seat needed an operator running wire-bot with a
// token in hand, and five seats sat unwired because their tokens were only
// recoverable from BotFather.
//
// IT NEVER CREATES A POOL ROW. Racking a seat stays a deliberate operator act
// (add-sandbox), because an auto-created row is a COLD row and bind_telegram
// hands cold rows to the next hire — an occupied sandbox offered to a new
// person, two people on one agent. An unknown seat is reported back as skipped
// so the operator can see what the box has that the server does not.
//
// A HANDLE THAT DISAGREES IS REFUSED, per seat. Binding seat A to seat B's bot
// would send A's launches to be verified against B forever, and nothing
// downstream would ever notice. Same cross-check wire-bot makes.
async function handleSeatBotReport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const seats = (body as { seats?: unknown })?.seats;
    if (!Array.isArray(seats)) {
      json(400, { error: 'seats must be an array' });
      return;
    }
    // A bounded batch: a box reports its own rack, which is tens of seats, not
    // thousands. A runaway body should be refused rather than looped over.
    if (seats.length > 200) {
      json(400, { error: 'too many seats in one report' });
      return;
    }
    const rows = await listPoolRowsForHost(host.id);
    const recorded: string[] = [];
    const skipped: Array<{ sandboxRef: string; why: string }> = [];
    for (const entry of seats) {
      const e = (entry ?? {}) as Record<string, unknown>;
      const sandboxRef = typeof e.sandboxRef === 'string' ? e.sandboxRef.trim() : '';
      const botId = typeof e.botId === 'string' ? e.botId.trim() : '';
      const handle = typeof e.botUsername === 'string' ? e.botUsername.trim() : '';
      if (!sandboxRef) continue;
      // Digits only. A pasted token must never become an allowlist entry, and
      // saying so per seat beats failing the whole report.
      if (!/^[0-9]{1,20}$/.test(botId)) {
        skipped.push({ sandboxRef, why: 'botId is not a bare numeric id' });
        continue;
      }
      if (handle && !/^@[A-Za-z0-9_]{5,32}$/.test(handle)) {
        skipped.push({ sandboxRef, why: 'botUsername is not a Telegram handle' });
        continue;
      }
      const row = rows.find((r) => r.sandbox_ref === sandboxRef);
      if (!row) {
        skipped.push({ sandboxRef, why: 'no pool row — rack it with add-sandbox first' });
        continue;
      }
      if (row.retired_at) {
        skipped.push({ sandboxRef, why: 'retired — a recycled seat must not keep a door' });
        continue;
      }
      if (handle && row.bot_username && row.bot_username.toLowerCase() !== handle.toLowerCase()) {
        skipped.push({ sandboxRef, why: `handle ${handle} disagrees with ${row.bot_username}` });
        continue;
      }
      if (row.bot_id === botId && (!handle || row.bot_username)) continue; // already true
      try {
        await setSandboxBotId({
          tenantId: row.tenant_id,
          hostId: host.id,
          sandboxRef,
          botId,
          // Only fills a gap; never overwrites a handle that was cross-checked
          // against it above.
          ...(handle && !row.bot_username ? { botUsername: handle } : {}),
        });
        recorded.push(sandboxRef);
      } catch (err) {
        // Per-seat isolation, the same reasoning as the mint loop: one bad row
        // must not cost the rest of the rack its report.
        skipped.push({ sandboxRef, why: err instanceof Error ? err.message : String(err) });
      }
    }
    json(200, { recorded, skipped });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// The box's recycle-completion report: "retired sandbox X is destroyed, blank Y
// is racked with bot Z". Same host-token auth + bare-401 posture as the pull.
// The response's rosterCleared:false tells the box to RETRY the whole (idempotent)
// report next tick — the residue clear is the only non-idempotent-looking half,
// and a person re-bound to a fresh blank is protected by the ref-guarded clear.
async function handleSandboxReport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const retiredSandboxRef = typeof b.retiredSandboxRef === 'string' ? b.retiredSandboxRef.trim() : '';
    const newSandboxRef = typeof b.newSandboxRef === 'string' ? b.newSandboxRef.trim() : '';
    const botUsername = b.botUsername == null ? null : b.botUsername;
    if (!retiredSandboxRef || !newSandboxRef) {
      json(400, { error: 'retiredSandboxRef and newSandboxRef are required' });
      return;
    }
    // Same handle contract as assign-host.mjs: @, 5-32 word chars. null is
    // allowed (registers handle-less; bind_telegram says "ask your operator").
    if (botUsername !== null && (typeof botUsername !== 'string' || !/^@[A-Za-z0-9_]{5,32}$/.test(botUsername))) {
      json(400, { error: 'botUsername must be @<5-32 word chars> or null' });
      return;
    }
    let result;
    try {
      result = await completeSandboxRecycle({
        hostId: host.id,
        retiredSandboxRef,
        newSandboxRef,
        botUsername,
      });
    } catch (err) {
      // Refusals (code 'recycle_refused') are the box being wrong, not the
      // server failing: conflict, not 500 — the box parks the entry and alarms.
      if ((err as { code?: string }).code === 'recycle_refused') {
        json(409, { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      throw err;
    }
    // Clear the roster's pointer at the destroyed sandbox. rosterCleared:false
    // → the box retries the report (this is the ONLY half without its own
    // retry, and the reactivate-path re-bind nudge depends on it landing).
    let rosterCleared: boolean | null = null;
    if (result.retiredTechnicianId) {
      try {
        // A glue seat backed by the destroyed sandbox (s5, or any seat step 5
        // moved) dies with it, or the person's next bind would "recover" a
        // ref the pool has just handed to someone else. Same retry contract.
        await retireSeatByHostRef(host.id, retiredSandboxRef);
        await clearSandboxAssignmentIfRef(result.retiredTechnicianId, retiredSandboxRef, host.id);
        rosterCleared = true;
      } catch {
        rosterCleared = false;
      }
    }
    json(200, { retired: result.retired, registered: result.registered, rosterCleared });
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// The box's health report: "service X on this host is ok / down right now".
// Same host-token auth and bare-401 posture as the pull and the recycle report.
//
// The reporter is STATELESS — it sends its current status every tick and this
// folds those observations into incidents (see recordOpsEvent). That is why the
// common responses are `suppressed` and `noop`: during a 30-minute outage the
// medic reports six times and exactly one row exists.
//
// Anything that goes wrong here answers 5xx and the reporter simply moves on.
// Alerting must never be able to break the thing it monitors, and the reporter
// is deliberately fire-and-forget for the same reason.
async function handleOpsReport(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    // CAPPED, unlike the sibling control routes: this body carries a journal
    // tail from a machine, so its size is set by however much a failing unit
    // logged. `readBody` is uncapped, and an unbounded read lets one reporter
    // balloon the shared process that serves every tenant. 64 KiB is ~16x the
    // 4 KiB tail ops-report.sh sends.
    let body: unknown;
    try {
      const raw = await readRawBody(req, 64 * 1024);
      body = raw.length ? JSON.parse(raw) : undefined;
    } catch (err) {
      if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
        json(413, { error: 'body too large' });
        return;
      }
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const service = typeof b.service === 'string' ? b.service.trim() : '';
    const status = b.status;
    if (!isValidService(service)) {
      json(400, { error: 'service must be lowercase kebab-case, 1-64 chars' });
      return;
    }
    if (status !== 'ok' && status !== 'down') {
      json(400, { error: "status must be 'ok' or 'down'" });
      return;
    }
    // detail is evidence, not instructions — stored verbatim as jsonb and never
    // interpreted here. host_id comes from the TOKEN, never the body, so a host
    // cannot file incidents against another host.
    const detail =
      b.detail && typeof b.detail === 'object' && !Array.isArray(b.detail)
        ? (b.detail as Record<string, unknown>)
        : undefined;
    const outcome = await recordOpsEvent({ hostId: host.id, service, status, detail });
    json(200, outcome);
    // The reporter already has its 200, so a slow or failing Telegram call costs
    // it nothing. Alerting must never be able to break — or even delay — the
    // thing it monitors; ops-report.sh keeps its side of that bargain by always
    // exiting 0, and this is ours. Only `opened`/`closed` notify (see
    // opsNotify.ts): the suppressed ticks during an outage stay silent.
    try {
      await notifyOpsTransition(outcome, service, host.name, detail);
    } catch (err) {
      console.error('[ops] alert push failed', err);
    }
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// The box's capacity reading: "here are my counters right now".
//
// WHY A SEPARATE ROUTE FROM /control/ops, which the same reporter already calls
// with the same token. That handler's entire contract is recordOpsEvent's
// incident folding, where a HEALTHY observation is deliberately discarded —
// `ok` with nothing open writes no row at all. Capacity is made of exactly those
// healthy observations. Routing them through the ops path would either lose them
// or require teaching the one handler that alerting depends on to behave two
// different ways. It stays a time series, written raw, next door.
//
// Same posture as its sibling: host identity from the TOKEN, bare 401, a capped
// body, and any failure answers 5xx and lets the reporter move on. A monitor
// must never be able to break — or delay — the thing it monitors.
async function handleMetricsReport(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const json = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  try {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const host = m ? await getHostByTokenHash(sha256hex(m[1].trim())) : null;
    if (!host) {
      res.writeHead(401);
      res.end();
      return;
    }
    // CAPPED. The `sandboxes` object grows with seat count, so unlike a fixed
    // payload this one has no natural ceiling — and an unbounded read lets one
    // box balloon the shared process that serves every tenant. 64 KiB is ~40x a
    // 40-seat report.
    let body: unknown;
    try {
      const raw = await readRawBody(req, 64 * 1024);
      body = raw.length ? JSON.parse(raw) : undefined;
    } catch (err) {
      if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
        json(413, { error: 'body too large' });
        return;
      }
      json(400, { error: 'malformed JSON body' });
      return;
    }
    const b = (body ?? {}) as Record<string, unknown>;

    // observed_at is the axis every derived rate divides by, so a missing or
    // unparseable one must be refused rather than defaulted to now(): silently
    // substituting the server's clock would attribute a delayed batch of ticks
    // to the wrong minutes and quietly corrupt the series.
    const observedAt = typeof b.observedAt === 'string' ? b.observedAt : '';
    const parsed = observedAt ? Date.parse(observedAt) : NaN;
    if (!Number.isFinite(parsed)) {
      json(400, { error: 'observedAt must be an ISO-8601 timestamp' });
      return;
    }

    // Every counter is optional and independently validated: a box that cannot
    // read one file still gets the rest of its tick stored. Anything that is
    // not a finite number becomes null — "cannot say" — never 0, which would be
    // a measurement claiming nothing happened.
    const num = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? v : null;
    const sandboxes =
      b.sandboxes && typeof b.sandboxes === 'object' && !Array.isArray(b.sandboxes)
        ? (b.sandboxes as Record<string, unknown>)
        : undefined;

    const outcome = await recordHostMetrics({
      hostId: host.id,
      observedAt: new Date(parsed).toISOString(),
      memAvailMb: num(b.memAvailMb),
      memTotalMb: num(b.memTotalMb),
      diskUsedPct: num(b.diskUsedPct),
      seats: num(b.seats),
      cpuCores: num(b.cpuCores),
      load5: num(b.load5),
      oomKills: num(b.oomKills),
      cpuUsageUsec: num(b.cpuUsageUsec),
      psiMemSomeUs: num(b.psiMemSomeUs),
      psiMemFullUs: num(b.psiMemFullUs),
      psiCpuSomeUs: num(b.psiCpuSomeUs),
      sandboxes,
    });
    json(200, outcome);
  } catch {
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

// Liveness/health for external monitors AND Render's zero-downtime deploy gate
// (which withholds traffic from a new instance until its health check answers
// 2xx/3xx). Unauthenticated and routed BEFORE the IP allowlist for the same
// reason the /control/ pull is: a health check that only answers while everything
// else is healthy is not a health check, and Render's own probe carries no gateway
// identity. It does a REAL DB round-trip (reachability != function, system-design
// Tier 4) and reports the running commit so "what's in prod?" has a one-line,
// curl-able answer (deploy provenance). The DEEP model-completion check is the
// scheduled canary, deliberately not on this hot path (would burn tokens/flap).
// GET only, no body. A failing DB → 503 so Render holds the old instance instead
// of cutting traffic to a broken deploy.
async function handleHealth(res: http.ServerResponse): Promise<void> {
  const commit = process.env.RENDER_GIT_COMMIT ?? 'unknown';
  const dbOk = await pingDb();
  res.writeHead(dbOk ? 200 : 503, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      status: dbOk ? 'ok' : 'degraded',
      commit,
      checks: { db: dbOk ? 'ok' : 'down' },
    }),
  );
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    // Health/liveness first — cheapest path, unauthenticated, ahead of the IP
    // allowlist (Render's deploy probe + any monitor carry no gateway identity).
    if (req.method === 'GET' && (req.url ?? '').split('?')[0] === '/health') {
      await handleHealth(res);
      return;
    }
    // Webhooks first — gated by HMAC, not by the gateway IP allowlist below.
    // SignalWire phone webhooks (their own X-SignalWire-Signature) route ahead of
    // the Composio /inbound/ handler.
    if (req.url?.startsWith('/inbound/phone/voice')) {
      await handlePhoneVoice(req, res);
      return;
    }
    if (req.url?.startsWith('/inbound/phone/recording')) {
      await handlePhoneRecording(req, res);
      return;
    }
    if (req.url?.startsWith('/inbound/')) {
      await handleInbound(req, res);
      return;
    }
    // Host badge pull — gated by the host token, same pre-allowlist placement.
    if (req.url === '/control/badges' && req.method === 'GET') {
      await handleBadgePull(req, res);
      return;
    }
    // Host recycle-completion report — same host-token gate + placement.
    if (req.url === '/control/sandboxes' && req.method === 'POST') {
      await handleSandboxReport(req, res);
      return;
    }
    // The box naming the bot behind each of its seats — the tokenless half of
    // wiring, so a provisioned seat becomes a verifiable door with no operator
    // step. Same host-token gate as every other control route.
    if (req.url === '/control/seat-bots' && req.method === 'POST') {
      await handleSeatBotReport(req, res);
      return;
    }
    // Step 4: the box mints a seat's token (host token), and a glue seat asks
    // who it is (seat token). Both before allowed(): box egress IPs rotate.
    if (req.url === '/control/seat-token' && req.method === 'POST') {
      await handleSeatToken(req, res);
      return;
    }
    if (req.url === '/seat/whoami' && req.method === 'GET') {
      await handleSeatWhoami(req, res);
      return;
    }
    if (req.url === '/seat/export' && req.method === 'POST') {
      await handleSeatExport(req, res);
      return;
    }
    // Step 2d: the file store's bytes. Matched on the PATH — the upload carries
    // its kind and name in the query string.
    {
      const path = new URL(req.url ?? '', 'http://internal').pathname;
      if (path === '/seat/files' && req.method === 'POST') {
        await handleSeatFileUpload(req, res);
        return;
      }
      const m = FILE_ID_PATH.exec(path);
      if (m && req.method === 'GET') {
        await handleSeatFileDownload(req, res, m[1]);
        return;
      }
    }
    // Step 3: a glue seat's inbox — its own person's office items, and its
    // report per item. Seat token only; before allowed() like whoami.
    if (req.url === '/seat/inbox' && req.method === 'GET') {
      await handleSeatInboxPull(req, res);
      return;
    }
    if (req.url === '/seat/inbox' && req.method === 'POST') {
      await handleSeatInboxReport(req, res);
      return;
    }
    // Step 3: the glue's conversation upload — before allowed() too, since box
    // egress IPs rotate and an upload refused there is a conversation lost.
    if (req.url === '/seat/conversation' && req.method === 'POST') {
      await handleSeatConversation(req, res);
      return;
    }
    // The voice's outbox: nudge pull + delivery report — same host-token gate
    // + pre-allowlist placement (the box calling in).
    if (req.url === '/control/nudges' && req.method === 'GET') {
      await handleNudgePull(req, res);
      return;
    }
    if (req.url === '/control/nudges' && req.method === 'POST') {
      await handleNudgeReport(req, res);
      return;
    }
    // The office queue: agent-addressed messages (build 5.5 Phase 3) — same
    // host-token gate + pre-allowlist placement as the nudge pull beside it.
    if (req.url === '/control/office' && req.method === 'GET') {
      await handleOfficePull(req, res);
      return;
    }
    if (req.url === '/control/office' && req.method === 'POST') {
      await handleOfficeReport(req, res);
      return;
    }
    // Host health report (ops alerting) — same host-token gate + placement.
    // It must route BEFORE the IP allowlist for the same reason the pull does:
    // this is the box calling in, and an alerting path that only works while
    // everything else is healthy is not an alerting path.
    if (req.url === '/control/ops' && req.method === 'POST') {
      await handleOpsReport(req, res);
      return;
    }
    // Box capacity metrics — same host-token gate and same placement rule as the
    // ops report above: this is the box calling in, so it must route BEFORE the
    // IP allowlist.
    if (req.url === '/control/metrics' && req.method === 'POST') {
      await handleMetricsReport(req, res);
      return;
    }
    // Dispatch-board Mini App — self-authenticated by Telegram initData (board
    // traffic is users' public browsers, not the gateway), so like /inbound/
    // and /control/ it must route BEFORE the IP allowlist. Only POSTs carry a
    // body, and it is CAPPED: this path is pre-auth AND its URL is handed to
    // every roster user via the Telegram menu button, so an unbounded read
    // would let any client balloon the shared process before auth runs.
    if (isBoardPath(req.url)) {
      let boardBody = '';
      if (req.method === 'POST') {
        // Honest oversized clients get a clean 413 via Content-Length before
        // any read; a length-less (chunked) flood is cut off mid-stream by
        // the read cap — no clean response owed to that caller.
        const BOARD_BODY_CAP = 64 * 1024;
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > BOARD_BODY_CAP) {
          res.writeHead(413);
          res.end();
          req.destroy();
          return;
        }
        try {
          boardBody = await readRawBody(req, BOARD_BODY_CAP);
        } catch (err) {
          if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
            if (!res.headersSent) {
              res.writeHead(413);
              res.end();
            }
            return;
          }
          throw err;
        }
      }
      await handleBoardRequest(req, res, boardBody);
      return;
    }
    // Dispatch CONSOLE — the wide desktop schedule surface, standing beside the
    // board while it is built (src/console/consoleApi.ts). Same pre-allowlist
    // placement and same body cap for the same reasons: it is another Mini App
    // authenticating itself with initData, so its traffic is public-browser
    // traffic and its POST bodies are read before auth runs. It is
    // DEFAULT-OFF — without CONSOLE_ENABLED the handler 404s every path — so
    // mounting it here does not expose it.
    if (isConsolePath(req.url)) {
      let consoleBody = '';
      if (req.method === 'POST') {
        const CONSOLE_BODY_CAP = 64 * 1024;
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > CONSOLE_BODY_CAP) {
          res.writeHead(413);
          res.end();
          req.destroy();
          return;
        }
        try {
          consoleBody = await readRawBody(req, CONSOLE_BODY_CAP);
        } catch (err) {
          if ((err as { code?: string }).code === 'BODY_TOO_LARGE') {
            if (!res.headersSent) {
              res.writeHead(413);
              res.end();
            }
            return;
          }
          throw err;
        }
      }
      await handleConsoleRequest(req, res, consoleBody);
      return;
    }
    // Operator cost dashboard — routed BEFORE the IP allowlist for the same
    // reason as the board: it loads in an operator's ordinary browser, not
    // through the gateway, so the allowlist would 403 every real user. It
    // authenticates itself with a bearer token, and the underlying tables have
    // RLS enabled so the anon key cannot reach the data around this handler.
    // GET-only, so no body to read or cap.
    if (isAdminPath(req.url)) {
      await handleAdminRequest(req, res);
      return;
    }
    if (!allowed(req)) {
      res.writeHead(403);
      res.end();
      return;
    }
    // Composio relay — same signed-identity trust as the MCP path (it shares
    // this catch's bare 401 for identity failures). Must route BEFORE the MCP
    // fallthrough below, which serves every unrouted path.
    if (isRelayPath(req.url)) {
      await handleComposioRelay(req, res, await readRawBody(req));
      return;
    }
    // Read+parse the body ourselves and pass it to handleRequest, so the transport
    // does not try to re-read the already-consumed stream.
    const body = await readBody(req);
    const identity = await resolveIdentity(req.headers);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcp = createServer({ identity, signal: hangUpSignal(res) });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (err) {
    // Identity/parse/allowlist failures are rejected without leaking detail.
    // Except OUR outage while looking a seat token up: that is a 503, so the
    // seat's engine reads "retry", not "your token is bad".
    if (!res.headersSent) {
      res.writeHead((err as { code?: string }).code === 'IDENTITY_UNAVAILABLE' ? 503 : 401);
      res.end();
    }
  }
}

// THE SEAT'S HANG-UP (plan 2026-09-22, the office). A seat's Stop aborts its tool
// call, which closes this request; the office can run for minutes, so it must
// hear that rather than finish for nobody. 'close' also fires after a normal
// reply — writableFinished tells the two apart. UNVERIFIED end to end: that the
// seat engine's abort closes the connection, and that Render's proxy passes the
// close through (a joint live check with the step-1 seat, owed).
export function hangUpSignal(res: Pick<http.ServerResponse, 'on' | 'writableFinished'>): AbortSignal {
  const hangUp = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) hangUp.abort();
  });
  return hangUp.signal;
}

export function createHttpServer(): http.Server {
  return http.createServer((req, res) => {
    void handle(req, res);
  });
}

async function main(): Promise<void> {
  const port = Number(process.env.MCP_HTTP_PORT ?? 8080);
  createHttpServer().listen(port, () => {
    console.error(`trades-spine MCP HTTP server listening on :${port}`);
  });
}

// Start the HTTP server only when executed directly (node dist/mcp/httpServer.js),
// not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
