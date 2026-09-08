import { createHmac, timingSafeEqual } from 'node:crypto';
import { recordFieldNote as liveRecordFieldNote } from '../writePath/recordFieldNote.js';
import {
  flagUnknownRefCapture,
  getTechnician as liveGetTechnician,
  isForeignKeyViolation,
  isInactiveState,
  tenantExists as liveTenantExists,
  upsertDroppedAudit,
} from '../db/index.js';
import { defaultClassifier } from '../email/classify.js';
import { emailAddressOf } from '../email/format.js';
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
  getTechnician?: typeof liveGetTechnician;
  flagReview?: typeof flagUnknownRefCapture;
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
  | 'skipped_offboarded'
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
// metadata.user_id must be the composite "<tenantUuid>:<technicianRef>" (per-person
// pairing — one connected account per person), split on the FIRST colon. The bare-uuid
// whole-business mode was retired 2026-07-02 (zero live pairings existed; roster-based
// attribution needs a person). The trigger slug is metadata.trigger_slug; there is no
// explicit toolkit field, so we derive it from the slug prefix (GMAIL_… → GMAIL).
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
  const classify = deps.classify ?? defaultClassifier;
  const resolveNormalizer = deps.resolveNormalizer ?? liveResolveNormalizer;
  const tenantExists = deps.tenantExists ?? liveTenantExists;
  const recordDrop = deps.recordDrop ?? upsertDroppedAudit;
  const getTechnician = deps.getTechnician ?? liveGetTechnician;
  const flagReview = deps.flagReview ?? flagUnknownRefCapture;

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

  // Composio user_id must be composite "<tenantUuid>:<technicianRef>" (one
  // connected account per person). Split on the FIRST colon; the ref may itself
  // contain colons. A bare uuid (the retired whole-business mode) is a
  // deterministic reject — no live pairing sends it.
  const sep = userId.indexOf(':');
  if (sep === -1) return { status: 'bad_payload' };
  const tenantId = userId.slice(0, sep);
  // Attribution for everything this delivery writes (L1 capture, visit, drop
  // receipt, review flag): the person named by the composite user_id.
  const technicianRef = userId.slice(sep + 1);
  if (!tenantId || !technicianRef) return { status: 'bad_payload' };
  // `connector:` stays reserved for non-webhook channel attribution (e.g. seeded
  // web_form captures) — a composite ref like "…:connector:gmail" would be
  // indistinguishable from that sentinel downstream, so reject it at the boundary.
  if (technicianRef.startsWith('connector:')) return { status: 'bad_payload' };
  // Tenant must be uuid-shaped. PostgREST raises 22P02 (an error, NOT an empty
  // result) for a non-uuid eq against the uuid column, which would be classified
  // transient_error below and retried forever. A non-uuid tenant is
  // deterministically unknown — say so once, with no retry.
  if (!UUID_RE.test(tenantId)) return { status: 'unknown_tenant' };

  const meta = (envelope.sourceMeta ?? {}) as {
    from?: string;
    subject?: string;
    body?: string;
    threadId?: string;
    to?: string;
    labelIds?: string[];
  };

  // From here on, any THROW is a transient fault (DB/model blip) → transient_error
  // (503, retried), except an FK violation (unknown/deleted tenant) → unknown_tenant
  // (no retry). Deterministic outcomes still `return` their own status above/below.
  try {
    // Roster first (a tenant-scoped read, so a hit also proves the tenant —
    // one roundtrip on the hot known-person path, before the classifier so no
    // model call is spent on a person we already know is gone). The HMAC proves
    // the body is authentic, NOT that user_id is provisioned: only when the ref
    // is unknown do we pay the explicit tenantExists check to distinguish a
    // misprovisioned tenant (422, give up) from an unknown person under a real
    // tenant (ingest + flag — mail must not be lost to a provisioning slip).
    const tech = await getTechnician(tenantId, technicianRef);
    if (!tech && !(await tenantExists(tenantId))) return { status: 'unknown_tenant' };
    // An offboarded/offboarding person's mailbox can still deliver during
    // teardown (or if the Composio deletion failed): drop with a receipt,
    // never ingest (decided 2026-07-02).
    if (tech && isInactiveState(tech.state)) {
      await recordDrop({
        tenantId,
        channel: envelope.channel,
        externalId: envelope.externalId,
        from: meta.from,
        reason: 'offboarded',
        technicianRef,
      });
      return { status: 'skipped_offboarded' };
    }

    // classify-before-L1: gate the append, since L1 is append-only and a misrouted
    // (non-work) row could never be removed (CLAUDE.md). Feed the CLEAN body (sourceMeta),
    // NOT the header-prefixed rawText — the one classifier both email doors share.
    if (envelope.requiresWorkClassifier) {
      const { isWork, reason } = await classify(
        {
          from: meta.from ?? '',
          subject: meta.subject ?? '',
          body: meta.body ?? '',
        },
        // Billed even when the verdict is "personal" and the mail is dropped —
        // we paid for the triage either way.
        { tenantId, technicianRef },
      );
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
        // A misprovisioned (unknown-ref) pairing must surface even when its
        // first deliveries are personal mail — otherwise the typo'd pairing
        // stays invisible until a work email happens to arrive. Advisory.
        if (!tech) {
          try {
            await flagReview({ tenantId, subjectRef: technicianRef, externalId: envelope.externalId });
          } catch {
            /* advisory */
          }
        }
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
      // RUNG 10B — the two envelope keys the matcher now recognises a sender by.
      // `from` is the header string ("Name <a@b.com>"); the matcher wants the
      // bare address. Both are inert on a channel that carries neither.
      fallbackEmail: emailAddressOf(meta.from),
      threadId: meta.threadId ?? null,
      // L1 metadata carries from/subject only — the body already lives in raw_text,
      // so don't duplicate it into metadata JSONB. Captures landing before the
      // manager confirmed the mailbox are stamped, so if verification later
      // FAILS (wrong account connected) the affected rows are findable —
      // stamping is the only after-the-fact handle L1's append-only rule allows.
      sourceMeta: {
        from: meta.from,
        subject: meta.subject,
        // THE CONVERSATION KEY (2026-09-07). A reply carries the same thread
        // id as the message it answers; without it every email is an island
        // and, L1 being append-only, stays one forever. Same key name as the
        // outbound capture (`threadId`, src/mcp/server.ts) so a thread's two
        // directions are found with one predicate. `to` says which mailbox
        // it reached; `labelIds` says INBOX vs SENT. All three present-only.
        ...(meta.threadId ? { threadId: meta.threadId } : {}),
        ...(meta.to ? { to: meta.to } : {}),
        ...(meta.labelIds ? { labelIds: meta.labelIds } : {}),
        // The account id keys the stamp to a pairing EPISODE: across a
        // wrong-mailbox → dismiss → re-pair loop, a bare boolean couldn't say
        // which rows came from which mailbox (review finding), and L1's
        // append-only rule makes that ambiguity permanent.
        ...(tech?.state === 'pending_verification' && {
          pendingVerification: true,
          pendingAccount: tech.composio_connected_account_id,
        }),
      },
    });
    // Unknown ref: keep the capture (ground truth), flag for manager review.
    // Redeliveries must not re-open a resolved item — the 'duplicate' gate covers
    // L2-linked captures, and flagUnknownRefCapture's per-message (externalId)
    // dedup covers unmatched ones (whose redelivery heals as 'ingested').
    // Advisory: a flag failure never fails an already-landed ingest.
    if (!tech && r.status !== 'duplicate') {
      try {
        await flagReview({
          tenantId,
          subjectRef: technicianRef,
          externalId: envelope.externalId,
        });
      } catch {
        /* advisory */
      }
    }
    return { status: r.status === 'duplicate' ? 'duplicate' : 'ingested', captureId: r.captureId };
  } catch (err) {
    if (isForeignKeyViolation(err)) return { status: 'unknown_tenant' };
    return { status: 'transient_error' };
  }
}
