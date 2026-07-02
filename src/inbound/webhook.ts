import { createHmac, timingSafeEqual } from 'node:crypto';
import { recordFieldNote as liveRecordFieldNote } from '../writePath/recordFieldNote.js';
import { isForeignKeyViolation, tenantExists as liveTenantExists, upsertDroppedAudit } from '../db/index.js';
import { sonnetClassifier } from '../email/classify.js';
import type { WorkClassifier } from '../email/classify.js';
import { resolveNormalizer as liveResolveNormalizer } from './normalize.js';
import type { Normalizer } from './normalize.js';
import './gmail.js'; // self-registers the Gmail normalizer

// Composio-trigger entry point. Composio POSTs a signed JSON payload to /inbound/*;
// we HMAC-verify it, route by toolkit+triggerType to a normalizer, run the
// classify-before-L1 gate where required, and land the note through recordFieldNote.

// Composio signs webhooks (Standard-Webhooks shape) with three headers: webhook-id,
// webhook-timestamp, webhook-signature. Verified against a live trigger + the docs
// (docs.composio.dev/docs/webhook-verification): HMAC-SHA256 over
// `${id}.${timestamp}.${rawBody}`, keyed by the RAW secret string (NOT base64-decoded,
// no whsec_ prefix), digest base64-encoded. The header is a space-separated list whose
// entries may be `v1,<base64>` or a bare `<base64>`. Length-guard before timingSafeEqual;
// reject stale timestamps (replay guard). Returns false (never throws) on bad input.
const WEBHOOK_TOLERANCE_SECONDS = 300;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WebhookHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

export function verifyWebhookSignature(
  rawBody: string,
  headers: WebhookHeaders | undefined,
  secret: string,
): boolean {
  const id = headers?.id;
  const timestamp = headers?.timestamp;
  const signature = headers?.signature;
  if (!id || !timestamp || !signature) return false;

  // Replay guard: reject timestamps (unix seconds) outside the tolerance window.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > WEBHOOK_TOLERANCE_SECONDS) {
    return false;
  }

  // The raw secret string is the HMAC key (Composio does not base64-decode it).
  const expected = createHmac('sha256', secret).update(`${id}.${timestamp}.${rawBody}`).digest();

  // Each space-separated entry is `v1,<base64>` or a bare `<base64>` — match any.
  for (const part of signature.split(' ')) {
    const comma = part.indexOf(',');
    const b64 = comma >= 0 ? part.slice(comma + 1) : part;
    if (!b64) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(b64, 'base64');
    } catch {
      continue;
    }
    // base64 decode is lenient, so a length match is the real guard; timingSafeEqual
    // throws RangeError on a length mismatch.
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true;
  }
  return false;
}

export interface InboundWebhookDeps {
  recordFieldNote?: typeof liveRecordFieldNote;
  classify?: WorkClassifier;
  resolveNormalizer?: (toolkit: string, triggerType: string) => Normalizer | null;
  tenantExists?: (tenantId: string) => Promise<boolean>;
  recordDrop?: typeof upsertDroppedAudit;
}

// The handler classifies every outcome into one status; httpServer maps each status
// to an HTTP code with the correct RETRY semantics — retry only what a retry could
// fix (transient), never a deterministic failure (a poison pill must stop retrying).
//   ingested/duplicate/unrouted/skipped_non_work → 200 (acknowledged, no retry)
//   bad_signature → 401 · bad_payload → 400 · unknown_tenant → 422  (no retry)
//   transient_error → 503 (retry)
export type InboundWebhookStatus =
  | 'ingested'
  | 'duplicate'
  | 'unrouted'
  | 'skipped_non_work'
  | 'bad_signature'
  | 'bad_payload'
  | 'unknown_tenant'
  | 'transient_error';

export interface InboundWebhookResult {
  status: InboundWebhookStatus;
  captureId?: string;
}

// Composio V3 webhook envelope (confirmed against a live GMAIL_NEW_GMAIL_MESSAGE):
//   { id, type:'composio.trigger.message', metadata:{ user_id, trigger_slug, ... }, data }
// metadata.user_id is either a bare tenant uuid (legacy whole-business pairing) or
// "<tenantUuid>:<technicianRef>" (per-person pairing — one connected account per
// person), split on the FIRST colon. The trigger slug is metadata.trigger_slug; there
// is no explicit toolkit field, so we derive it from the slug prefix (GMAIL_… → GMAIL).
interface InboundEvent {
  type?: string;
  metadata?: { user_id?: string; trigger_slug?: string };
  data?: unknown;
}

// Verify → parse → route → validate tenant → (classify-before-L1) → recordFieldNote.
// Returns a status for EVERY handled outcome (never throws for bad signature/payload/
// tenant — those are deterministic and must NOT trigger Composio retries). Only a
// genuine server fault (e.g. missing secret) throws → httpServer maps that to 500.
export async function handleInboundWebhook(
  rawBody: string,
  headers: WebhookHeaders | undefined,
  deps: InboundWebhookDeps = {},
): Promise<InboundWebhookResult> {
  const secret = process.env.COMPOSIO_WEBHOOK_SECRET;
  if (!secret) throw new Error('COMPOSIO_WEBHOOK_SECRET is not set'); // server misconfig → 500
  if (!verifyWebhookSignature(rawBody, headers, secret)) {
    return { status: 'bad_signature' }; // → 401, deterministic, no retry
  }

  const recordFieldNote = deps.recordFieldNote ?? liveRecordFieldNote;
  const classify = deps.classify ?? sonnetClassifier;
  const resolveNormalizer = deps.resolveNormalizer ?? liveResolveNormalizer;
  const tenantExists = deps.tenantExists ?? liveTenantExists;
  const recordDrop = deps.recordDrop ?? upsertDroppedAudit;

  // Deterministic payload failures → bad_payload (400, no retry — same body, same fail).
  let event: InboundEvent;
  try {
    event = JSON.parse(rawBody) as InboundEvent;
  } catch {
    return { status: 'bad_payload' };
  }
  const userId = event.metadata?.user_id;
  const triggerType = event.metadata?.trigger_slug;
  const toolkit = triggerType ? triggerType.split('_')[0] : undefined; // GMAIL_… → GMAIL
  if (!userId || !triggerType || !toolkit) return { status: 'bad_payload' };

  const normalizer = resolveNormalizer(toolkit, triggerType);
  if (!normalizer) return { status: 'unrouted' };

  let envelope;
  try {
    envelope = normalizer(event.data); // throws on a malformed payload (e.g. no messageId)
  } catch {
    return { status: 'bad_payload' };
  }

  // Composio user_id is either a bare tenant uuid (legacy: whole-business pairing)
  // or "<tenantUuid>:<technicianRef>" (per-person pairing, one connected account
  // per person). Split on the FIRST colon; the ref may itself contain colons.
  const sep = userId.indexOf(':');
  const tenantId = sep === -1 ? userId : userId.slice(0, sep);
  const personRef = sep === -1 ? undefined : userId.slice(sep + 1);
  if (sep !== -1 && (!tenantId || !personRef)) return { status: 'bad_payload' };
  // `connector:` is the reserved fallback namespace for unattributed (bare-uuid)
  // pairings — a composite ref like "…:connector:gmail" would be indistinguishable
  // from that sentinel downstream, so reject it at the boundary.
  if (personRef?.startsWith('connector:')) return { status: 'bad_payload' };
  // Tenant must be uuid-shaped. PostgREST raises 22P02 (an error, NOT an empty
  // result) for a non-uuid eq against the uuid column, which would be classified
  // transient_error below and retried forever. A non-uuid tenant is
  // deterministically unknown — say so once, with no retry.
  if (!UUID_RE.test(tenantId)) return { status: 'unknown_tenant' };

  // Attribution for everything this delivery writes (L1 capture, visit, drop
  // receipt): the person named by the composite user_id, else the channel label.
  const technicianRef = personRef ?? `connector:${toolkit.toLowerCase()}`;

  const meta = (envelope.sourceMeta ?? {}) as { from?: string; subject?: string; body?: string };

  // From here on, any THROW is a transient fault (DB/model blip) → transient_error
  // (503, retried), except an FK violation (unknown/deleted tenant) → unknown_tenant
  // (no retry). Deterministic outcomes still `return` their own status above/below.
  try {
    // The HMAC proves the body is authentic, NOT that user_id is a provisioned tenant.
    // Validate up front so an unknown tenant gives up cleanly (422) instead of failing
    // the L1 insert's FK deep in the write-path and becoming a retry storm.
    if (!(await tenantExists(tenantId))) return { status: 'unknown_tenant' };

    // classify-before-L1: gate the append, since L1 is append-only and a misrouted
    // (non-work) row could never be removed (CLAUDE.md). Feed the CLEAN body (sourceMeta),
    // NOT the header-prefixed rawText — so the verdict matches the Gmail pull path.
    if (envelope.requiresWorkClassifier) {
      const { isWork, reason } = await classify({
        from: meta.from ?? '',
        subject: meta.subject ?? '',
        body: meta.body ?? '',
      });
      if (!isWork) {
        // Content-free audit receipt only — the dropped email itself is not stored.
        // technicianRef says WHOSE mailbox this arrived in: Gmail message ids are
        // mailbox-local, so re-fetching a misclassified message under per-person
        // pairing needs the mailbox, not just the external id.
        await recordDrop({
          tenantId,
          channel: envelope.channel,
          externalId: envelope.externalId,
          from: meta.from,
          reason,
          technicianRef,
        });
        return { status: 'skipped_non_work' };
      }
    }

    const r = await recordFieldNote({
      tenantId,
      technicianRef,
      channel: envelope.channel,
      text: envelope.rawText,
      blobPath: envelope.blobRef,
      externalId: envelope.externalId,
      occurredAt: envelope.occurredAt,
      // L1 metadata carries from/subject only — the body already lives in raw_text,
      // so don't duplicate it into metadata JSONB.
      sourceMeta: { from: meta.from, subject: meta.subject },
    });
    return { status: r.status === 'duplicate' ? 'duplicate' : 'ingested', captureId: r.captureId };
  } catch (err) {
    if (isForeignKeyViolation(err)) return { status: 'unknown_tenant' };
    return { status: 'transient_error' };
  }
}
