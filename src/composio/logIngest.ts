import {
  appendRawCapture,
  getTechnician,
  isUniqueViolation,
  type CaptureChannel,
  type Json,
} from '../db/index.js';
import { formatEmailRawText } from '../email/format.js';

// The audit sweep: Composio's server-side tool-execution logs → L1. Manager
// sessions act Composio-direct (our server is not in the request path — MCP
// bypasses beforeExecute/afterExecute), so this job is how their actions
// become evidence. Capture-all, NO work/personal classifier (recorded user
// decision 2026-07-04); L1 is undeletable, so the redaction policy below is
// the one thing standing between "audit" and "we stored something we can
// never delete" — treat changes to it as reviewed policy changes.
//
// Idempotency: overlapping window (60 min, ≥4 cron ticks) + per-tenant
// external-id dedup. No cursor table.

// Sends (immediate dispatch) — the only slugs whose bodies are stored verbatim
// (business correspondence, same storage form as inbound email).
export const EMAIL_SEND_SLUGS = ['GMAIL_SEND_EMAIL', 'GMAIL_REPLY_TO_THREAD'];

// Conservative read-only patterns — skipped (an agent doing real work reads
// constantly; capturing reads floods undeletable L1 with non-events). When a
// slug matches NOTHING here and isn't a send, it is CAPTURED (when unsure,
// capture: a wrongly-captured read is noise; a skipped payment is a lost
// record). Product-configurable, like TECHNICIAN_GMAIL_TOOLS.
export const READ_SLUG_PREFIXES = [
  'GMAIL_FETCH_',
  'GMAIL_GET_',
  'GMAIL_LIST_',
  'GMAIL_SEARCH_',
  // Excel reads excluded per user decision 2026-07-05 ("I don't think we need
  // to record the read excel calls in L1") after the live scenario run showed
  // EXCEL_LIST_FILES etc. flooding the audit. Slugs observed live: LIST_FILES,
  // LIST_WORKSHEETS, LIST_TABLES, LIST_TABLE_ROWS, LIST_TABLE_COLUMNS,
  // GET_RANGE, GET_WORKSHEET, GET_WORKSHEET_USED_RANGE, GET_SESSION,
  // SEARCH_FILES. Writes (ADD_TABLE, ADD_TABLE_ROW, UPDATE_RANGE) and the
  // ambiguous CLOSE_SESSION stay captured (when unsure, capture).
  'EXCEL_GET_',
  'EXCEL_LIST_',
  'EXCEL_SEARCH_',
];
// Composio meta-tools are session plumbing (search/schemas/execute wrappers),
// not business actions — except connection management, which mints real
// grants and IS captured.
export const META_TOOL_PREFIX = 'COMPOSIO_';
export const CAPTURED_META_TOOLS = ['COMPOSIO_MANAGE_CONNECTIONS'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One list item from POST /api/v3.1/logs/tool_execution (envelope verified
// against the live OpenAPI 2026-07-04; PAYLOAD key names are tolerant-parsed
// and live-verified in Phase 5).
export interface ExecutionLogItem {
  id: string;
  status?: string;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

export type FetchExecutionLogs = (window: { from: string; to: string }) => Promise<ExecutionLogItem[]>;
export type FetchExecutionLogDetail = (id: string) => Promise<Record<string, unknown>>;

const API_BASE = 'https://backend.composio.dev/api/v3.1/logs/tool_execution';

function apiKey(): string {
  const key = process.env.COMPOSIO_API_KEY;
  if (!key) throw new Error('COMPOSIO_API_KEY is not set');
  return key;
}

// Default list fetcher: cursor-paged POST. Kept small and injectable — unit
// tests never touch the network.
export const fetchExecutionLogs: FetchExecutionLogs = async ({ from, to }) => {
  const items: ExecutionLogItem[] = [];
  let cursor: string | undefined;
  do {
    const res = await fetch(API_BASE, {
      method: 'POST',
      headers: { 'x-api-key': apiKey(), 'content-type': 'application/json' },
      body: JSON.stringify({
        time_range: { from: Date.parse(from), to: Date.parse(to) },
        limit: 100,
        ...(cursor ? { cursor } : {}),
      }),
    });
    if (!res.ok) throw new Error(`logs API ${res.status}: ${await res.text()}`);
    // Envelope live-verified 2026-07-04: rows under `logs`, cursor is
    // `next_cursor` (null when exhausted). items/data kept as fallbacks only.
    const page = (await res.json()) as {
      logs?: ExecutionLogItem[];
      items?: ExecutionLogItem[];
      data?: ExecutionLogItem[];
      next_cursor?: string | null;
    };
    items.push(...(page.logs ?? page.items ?? page.data ?? []));
    cursor = page.next_cursor || undefined;
  } while (cursor);
  return items;
};

export const fetchExecutionLogDetail: FetchExecutionLogDetail = async (id) => {
  const res = await fetch(`${API_BASE}/${id}`, { headers: { 'x-api-key': apiKey() } });
  if (!res.ok) throw new Error(`log detail API ${res.status}: ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
};

export interface LogIngestDeps {
  fetchLogs?: FetchExecutionLogs;
  fetchDetail?: FetchExecutionLogDetail;
  getTech?: typeof getTechnician;
  append?: typeof appendRawCapture;
}

export interface LogIngestSummary {
  scanned: number;
  captured: number;
  skippedReads: number;
  skippedNonComposite: number;
  skippedTechnicianSends: number;
  deduped: number;
  rowErrors: number;
}

const WINDOW_MS = 60 * 60_000; // ≥4 overlapping 15-min ticks

export async function runLogIngestion(
  nowIso: string,
  deps: LogIngestDeps = {},
): Promise<LogIngestSummary> {
  const fetchLogs = deps.fetchLogs ?? fetchExecutionLogs;
  const fetchDetail = deps.fetchDetail ?? fetchExecutionLogDetail;
  const getTech = deps.getTech ?? getTechnician;
  const append = deps.append ?? appendRawCapture;

  const to = nowIso;
  const from = new Date(Date.parse(nowIso) - WINDOW_MS).toISOString();
  const items = await fetchLogs({ from, to });

  const summary: LogIngestSummary = {
    scanned: items.length,
    captured: 0,
    skippedReads: 0,
    skippedNonComposite: 0,
    skippedTechnicianSends: 0,
    deduped: 0,
    rowErrors: 0,
  };

  for (const item of items) {
    try {
      const meta = item.metadata ?? {};
      // Failed executions changed nothing — skip (not counted as reads).
      const status = str(item.status) ?? str(meta.status);
      if (status && status.toLowerCase() !== 'success') continue;

      // Live-verified 2026-07-04: metadata.tool is an OBJECT {slug, version,
      // is_deprecated} — the slug lives at metadata.tool.slug. Flat spellings
      // kept as fallbacks only.
      const toolObj = pickRecord(meta, 'tool');
      const slug = (
        str(toolObj?.slug) ??
        str(meta.tool_slug) ??
        str(meta.toolSlug) ??
        str(meta.tool) ??
        ''
      ).toUpperCase();
      if (!slug) continue;

      // Read-only and meta plumbing → skip.
      const isCapturedMeta = CAPTURED_META_TOOLS.includes(slug);
      const isRead =
        READ_SLUG_PREFIXES.some((p) => slug.startsWith(p)) ||
        (slug.startsWith(META_TOOL_PREFIX) && !isCapturedMeta);
      if (isRead) {
        summary.skippedReads++;
        continue;
      }

      // Composite user id — same rules as the inbound webhook (first-colon
      // split; bare uuid / 'default' / connector:* refs are not people).
      const userId = str(meta.user_id) ?? str(meta.userId) ?? '';
      const sep = userId.indexOf(':');
      const tenantId = sep === -1 ? '' : userId.slice(0, sep);
      const ref = sep === -1 ? '' : userId.slice(sep + 1);
      if (!tenantId || !ref || ref.startsWith('connector:') || !UUID_RE.test(tenantId)) {
        summary.skippedNonComposite++;
        continue;
      }

      const isSend = EMAIL_SEND_SLUGS.includes(slug);
      const actor = await getTech(tenantId, ref);

      // Double-capture backstop: technician sessions structurally cannot send
      // (4310, verified), so a technician-attributed send execution is by
      // definition the spine's own tools.execute — already captured
      // synchronously. The sent:<id> collision alone cannot guarantee dedup
      // (the spine falls back to sent:confirm:<confirmId> when the response
      // has no parseable message id, and an L1 miss is permanent).
      // KNOWN LIMITATION (final review, accepted): a MANAGER using the spine
      // send_email (allowed — shared tool surface) whose ids fail to parse on
      // either side can produce a duplicate outbound_email row here. The
      // structural discriminator would be the log detail's context.session_id
      // (session-originated vs API-key execute) — adopt it only after a live
      // verification pass proves the field; skipping on an unverified field
      // risks LOSING manager session-send audit rows, which is worse than an
      // occasional duplicate.
      if (isSend && actor?.tier === 'technician') {
        summary.skippedTechnicianSends++;
        continue;
      }

      const detail = await fetchDetail(item.id);
      const data = (detail.data ?? detail) as Record<string, unknown>;
      // Detail shapes live-verified 2026-07-04: arguments under
      // data.request.payload, response body under data.response.body
      // (response also carries status_code). Flat spellings kept as fallbacks.
      const requestObj = pickRecord(data, 'request');
      const args =
        pickRecord(requestObj ?? {}, 'payload') ??
        pickRecord(data, 'arguments', 'input') ??
        requestObj ??
        {};
      const responseObj = pickRecord(data, 'response');
      const response =
        pickRecord(responseObj ?? {}, 'body') ??
        pickRecord(data, 'response_data', 'output') ??
        responseObj ??
        {};
      // metadata.toolkit is an object {slug, icon} (live-verified).
      const toolkit = slug.startsWith('GMAIL_')
        ? 'gmail'
        : (str(pickRecord(meta, 'toolkit')?.slug) ?? str(meta.toolkit) ?? slug.split('_')[0].toLowerCase());

      let channel: CaptureChannel;
      let rawText: string;
      let externalId: string;
      let sensitivity: string | null = null;

      if (isSend) {
        // Gmail sends: business correspondence — stored in the SAME form as
        // inbound email (subject/from/body), values included by policy.
        channel = 'outbound_email';
        rawText = formatEmailRawText({
          from: actor?.connected_email ?? ref,
          subject: str(args.subject) ?? '(no subject)',
          body: str(args.body) ?? str(args.message_body) ?? '',
        });
        const messageId = str(response.id) ?? str(response.messageId) ?? str(response.message_id);
        externalId = messageId ? `sent:${messageId}` : `composio-exec:${item.id}`;
      } else {
        // DEFAULT REDACTION POLICY: slug, toolkit, timestamps, and argument
        // KEY NAMES only — never argument or response VALUES (they may carry
        // legally-deletable data; L1 is undeletable). Adding value capture
        // for a toolkit = a reviewed policy entry here.
        //
        // AND THAT REVIEW NOW HAS A SECOND QUESTION (retrieval layer plan 3,
        // 2026-09-15). These rows are the ONLY thing stamped `manager_only`, and
        // the planner's pushed evidence carries them: a gap on job J renders the
        // manager agent-actions on job J, and the planner writes the technician's
        // message itself. That was accepted because the text is KEY NAMES — a
        // technician learns that a manager sent mail about their job and which
        // fields it had, never an amount or a body. Capture VALUES here and that
        // stops being true: real values would start reaching technician-facing
        // evidence, so the fold that was dropped (src/db/captureMembership.ts,
        // gap_evidence's capture_visible(…, 'planner')) has to come back with it.
        channel = 'agent_action';
        rawText =
          `Agent action: ${slug} (${toolkit}) — argument keys: ` +
          `${Object.keys(args).join(', ') || '(none)'}`;
        externalId = `composio-exec:${item.id}`;
        // Manager-only marker; unknown refs are marked too (safe default).
        if (!actor || actor.tier === 'manager') sensitivity = 'manager_only';
      }

      try {
        await append({
          tenantId,
          channel,
          technicianRef: ref,
          rawText,
          externalId,
          metadata: {
            toolkit,
            toolSlug: slug,
            logId: item.id,
            status: status ?? 'success',
          } as Json,
          sensitivity,
        });
        summary.captured++;
      } catch (err) {
        if (isUniqueViolation(err)) summary.deduped++;
        else throw err;
      }
    } catch {
      summary.rowErrors++;
    }
  }
  return summary;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function pickRecord(obj: Record<string, unknown>, ...keys: string[]): Record<string, unknown> | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  }
  return null;
}
