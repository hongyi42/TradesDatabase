import { createHmac, timingSafeEqual } from 'node:crypto';
import { recordFieldNote as liveRecordFieldNote } from '../writePath/recordFieldNote.js';
import {
  getTechnician as liveGetTechnician,
  isForeignKeyViolation,
  isInactiveState,
  tenantExists as liveTenantExists,
  upsertDroppedAudit,
} from '../db/index.js';
import { defaultClassifier } from '../email/classify.js';
import { emailAddressOf, isOwnMailbox, soleRecipientOf, type ThreadMessage } from '../email/format.js';
import { fetchThreadMessages } from '../composio/threads.js';
import {
  captureHasLinkedL2,
  getRawCaptureByExternalId,
  isAgentWrittenCapture,
  listCapturesByThread,
  raiseUnknownRefObservation,
} from '../db/index.js';
import type { WorkClassifier } from '../email/classify.js';
import { resolveNormalizer as liveResolveNormalizer } from './normalize.js';
import type { Normalizer } from './normalize.js';
import type { SentAttachment } from './gmailSent.js';
import { keepSentAttachments } from './sentAttachments.js';
import {
  invoiceWords,
  looksLikeInvoice,
  raiseOutboundInvoiceObservation,
} from './outboundInvoice.js';
import { namesIssuedNumber } from '../db/index.js';
import './gmail.js'; // self-registers the Gmail received normalizer
import './gmailSent.js'; // …and the Gmail SENT one (rung 10b.4)

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
  flagReview?: typeof raiseUnknownRefObservation;
  // RUNG 10B: the conversation this message belongs to, fetched from Gmail.
  // Injectable so a test never reaches Composio; returns null on any failure,
  // and the caller falls back to our own captures on that thread.
  fetchThread?: (
    tech: Parameters<typeof fetchThreadMessages>[0],
    threadId: string,
  ) => Promise<ThreadMessage[] | null>;
  listThreadCaptures?: typeof listCapturesByThread;
  alreadyProcessed?: (tenantId: string, externalId: string) => Promise<boolean>;
  // RUNG 10B.3: the lookup that recognises the assistant's OWN send coming back
  // to us through the SENT label a minute later. Injected for the same reason
  // everything else here is — a test must not need a DB.
  findCaptureByExternalId?: typeof getRawCaptureByExternalId;
  hasLinkedL2?: typeof captureHasLinkedL2;
  // STEP 2E PHASE 4 — the manager's own sent mail. Three seams, so a test of
  // this door never reaches Composio or the database:
  //   keepAttachments   — fetch and keep the files, run DETACHED after the
  //                       response (sentAttachments.ts);
  //   issuedNumberNamed — does the email name a number already on the books;
  //   raiseOutboundInvoice — the `outbound_invoice` observation.
  keepAttachments?: (input: {
    tenantId: string;
    tech: NonNullable<Awaited<ReturnType<typeof liveGetTechnician>>>;
    messageId: string;
    attachments: SentAttachment[];
    target: { jobId?: string | null; customerId?: string | null };
  }) => Promise<unknown>;
  issuedNumberNamed?: typeof namesIssuedNumber;
  raiseOutboundInvoice?: typeof raiseOutboundInvoiceObservation;
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
  const flagReview = deps.flagReview ?? raiseUnknownRefObservation;
  const fetchThread = deps.fetchThread ?? fetchThreadMessages;
  const listThreadCaptures = deps.listThreadCaptures ?? listCapturesByThread;
  // Is this delivery one the door will no-op on? The door's own dedup is the
  // authority; this is the cheap pre-check that keeps a BILLED fetch off the
  // path when the answer is already known to be "nothing to do".
  const findCaptureByExternalId = deps.findCaptureByExternalId ?? getRawCaptureByExternalId;
  const hasLinkedL2 = deps.hasLinkedL2 ?? captureHasLinkedL2;
  const alreadyProcessed =
    deps.alreadyProcessed ??
    (async (tid: string, externalId: string) => {
      const dup = await getRawCaptureByExternalId(tid, externalId);
      return !!dup && (await captureHasLinkedL2(dup.id));
    });

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
    messageId?: string;
    threadId?: string;
    to?: string;
    recipients?: string;
    cc?: string;
    bcc?: string;
    labelIds?: string[];
    attachments?: SentAttachment[];
  };
  // The files on the firm's own sent mail (gmailSent.ts). Their Gmail ids are
  // for the fetch only; L1 keeps {name, mime, size}.
  const attachments = outboundAttachments(meta.attachments);
  // GMAIL'S OWN ID FOR THIS MESSAGE. Not the same thing as `externalId` any
  // more: an outbound delivery is keyed `sent:<messageId>` so that the trigger,
  // `send_email` and `logIngest` share one L1 key. Anything comparing against
  // GMAIL's view of the thread must use this, not the storage key.
  const selfMessageId = meta.messageId ?? envelope.externalId;
  // …AND BOTH SPELLINGS WHERE THE OTHER SIDE COULD BE EITHER. The thread we
  // show the model comes from one of two places and they name a message
  // differently: Composio hands back GMAIL's bare id, our own L1 fallback hands
  // back the STORAGE key (`listCapturesByThread` reads `external_id`). Compare
  // against one spelling and the firm's own reply survives its own filter on
  // the other path — landing in its own "earlier in this conversation" block,
  // where the extractor is told a commitment is already handled. Same reason
  // the blocked list below carries both.
  const selfIds = new Set(
    [selfMessageId, envelope.externalId].filter((id): id is string => !!id),
  );
  // WHOSE VOICE IS THIS? The normalizer already decided, from Gmail's own SENT
  // label (src/inbound/gmail.ts); the door only reads its answer.
  const outbound = envelope.channel === 'outbound_email';

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
        // The recipient on the firm's own mail, for the same reason the
        // non-work receipt below takes it: the receipt keeps a DOMAIN only, and
        // on outbound the sender's domain is our own on every single row.
        from: outbound ? (meta.to ?? meta.from) : meta.from,
        reason: 'offboarded',
        technicianRef,
      });
      return { status: 'skipped_offboarded' };
    }

    // RUNG 10B.3 — THE ASSISTANT'S OWN SEND, COMING BACK. Now that SENT is
    // watched, every email the spine sends is delivered to us about a minute
    // later as an ordinary trigger message. The synchronous capture
    // `send_email` already wrote is the one of record — it is guaranteed, it
    // carries the staged copy, and it is already stamped — so the trigger's
    // copy is dropped rather than appended. L1 CANNOT BE REWRITTEN, which is
    // what makes the order non-negotiable: this runs BEFORE the classifier (no
    // model call for a message we already hold) and before any insert.
    //
    // No join is needed: the normalizer already keys an outbound delivery as
    // `sent:<messageId>`, the same key `send_email` and `logIngest` write under
    // (src/inbound/gmail.ts explains why). So this is simply "do we already hold
    // this row" — which also makes a plain REDELIVERY free, since our own
    // earlier capture answers it.
    //
    // ONE GAP, NAMED, AND IT COSTS MORE THAN A ROW. When the Gmail id cannot be
    // parsed out of the response, `send_email` falls back to
    // `sent:confirm:<confirmId>` and `logIngest` to `composio-exec:<logId>` —
    // keys no delivery can ever match, because there is genuinely nothing to
    // join on. The trigger's copy of that message then runs the WHOLE door: a
    // classifier call, an extractor call, a job link, correspondence, and an ask
    // to the planner about a commitment the agent itself made and already
    // reported to the person who approved it. Rare (the send seam returns an id
    // in every observed case) and not fixable from this side.
    if (outbound && envelope.externalId) {
      const twin = await findCaptureByExternalId(tenantId, envelope.externalId);
      if (twin) {
        // WHO WROTE THE ROW WE FOUND? Sharing one key means this lookup can
        // return OUR OWN half-finished delivery, and returning 'duplicate' on
        // that would be permanent: an append that landed and then threw before
        // the job link (three CAS misses on the correspondence append is the
        // named case) redelivers as a 503, and the door would never run again.
        // The promise would never reach the job and no later delivery could fix
        // it. `captureHasLinkedL2` alone cannot tell the two apart — an agent's
        // send row has no L2 link either — so the PRODUCER is the discriminator:
        // the agent's writers stamp `sentVia` (send_email) or `toolSlug`
        // (logIngest), the trigger stamps the headers.
        if (isAgentWrittenCapture(twin.metadata) || (await hasLinkedL2(twin.id))) {
          return { status: 'duplicate', captureId: twin.id };
        }
        // Otherwise fall through and finish the job this delivery started. The
        // unique index makes re-entry safe: recordFieldNote adopts the existing
        // row rather than appending a second one.
      }
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
          // RUNG 10B.3: on the firm's own mail the sender is always us, so the
          // recipient is the whole signal — customer, or the manager's dentist.
          // `|| undefined`, not `?? ''`: an empty string would sail past
          // classify.ts's own `?? '(unknown)'` guard and show the model a blank
          // `To:` line on a prompt whose entire recipient signal is that line.
          ...(outbound ? { outbound: true, to: meta.to || undefined } : {}),
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
          // WHICH END IS WORTH KEEPING. The receipt stores a DOMAIN only
          // (db/droppedAudit.ts), and on the firm's own outbound mail the
          // sender's domain is our own — the same string on every drop, saying
          // nothing. The recipient's domain is the one that tells an operator
          // what was dropped, and it is no more identifying than the inbound
          // case it mirrors.
          from: outbound ? (meta.to ?? meta.from) : meta.from,
          reason,
          technicianRef,
        });
        // A misprovisioned (unknown-ref) pairing must surface even when its
        // first deliveries are personal mail — otherwise the typo'd pairing
        // stays invisible until a work email happens to arrive. No capture
        // here (personal mail never reaches L1), hence the null. Advisory.
        if (!tech) {
          try {
            await flagReview({ tenantId, ref: technicianRef, captureId: null });
          } catch {
            /* advisory */
          }
        }
        return { status: 'skipped_non_work' };
      }
    }

    // RUNG 10B — THE CONVERSATION, BEFORE THE DOOR. Skipped for a thread STARTER
    // (its thread id IS its own message id, so there is nothing earlier) and for
    // a mailbox with no paired account. Composio first, our own captures as the
    // fallback, and NEITHER may fail the ingest: the email is the thing that
    // must land, and context is an aid.
    // …AND NOT ON A REDELIVERY THE DOOR WILL NO-OP ON. The fetch is BILLED, and
    // a 503 (a model blip, a CAS miss, a DB stall) makes Composio redeliver the
    // same message: without this the retry pays for the conversation again every
    // time. Only a fully-processed capture is skipped — a parked or half-built
    // one genuinely re-runs the door, and context is exactly what it wants.
    let threadContext: ThreadMessage[] = [];
    if (
      meta.threadId &&
      meta.threadId !== selfMessageId &&
      !(envelope.externalId && (await alreadyProcessed(tenantId, envelope.externalId)))
    ) {
      try {
        // OUR OWN VIEW OF THE THREAD FIRST, ALWAYS — one indexed read, and it is
        // the only thing that knows which of these messages a manager RETRACTED
        // or marked manager_only. Gmail knows neither, so without this a
        // retraction would hold only while Composio happened to be down.
        const ours = await listThreadCaptures(tenantId, meta.threadId);
        // Blocked ids are L1 `external_id`s, so an outbound row contributes the
        // `sent:` form while a Composio-fetched thread names the bare one. Both
        // spellings go in the set or a RETRACTED reply of ours would still be
        // shown to the model.
        const blocked = new Set(
          ours.blockedMessageIds.flatMap((id) =>
            id.startsWith('sent:') ? [id, id.slice('sent:'.length)] : [id],
          ),
        );
        const fetched = tech?.composio_connected_account_id
          ? await fetchThread(tech, meta.threadId)
          : null;
        const earlier = fetched ?? ours.messages;
        threadContext = earlier.filter((m) => {
          // NEVER the message being read. An unidentifiable row is dropped for
          // the same reason: if it cannot be placed, it cannot be ruled out, and
          // showing the current message as "earlier" would have the model treat
          // a live commitment as one already handled — a promise nobody hears.
          // GMAIL's id on both sides — `externalId` carries the `sent:` prefix on
          // an outbound delivery, so comparing against it would never match and
          // the firm's own reply would be shown to the model as EARLIER
          // context. The extractor is told an earlier commitment "is already
          // handled", so `visitCommitted` would be suppressed and the ask never
          // raised: a promise nobody hears, which is what this line prevents.
          if (!m.messageId || selfIds.has(m.messageId)) return false;
          return !blocked.has(m.messageId);
        });
      } catch (err) {
        console.error(
          `inbound: thread context unavailable for ${meta.threadId} — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
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
      // …AND NEVER OUR OWN MAILBOX (rung 10b.2): a message the firm sent to
      // itself would otherwise offer the firm's address as the caller's identity
      // key. The mail still ingests — only the key is withheld.
      // …AND THE OTHER END ENTIRELY ON THE FIRM'S OWN MAIL (rung 10b.3): on a
      // SENT message the sender IS us, so the address worth matching on is who
      // it went TO. Unique-or-nothing, like every other key: a reply copied to
      // two people names neither of them.
      fallbackEmail: outbound
        ? soleRecipientOf(meta.to)
        : isOwnMailbox(meta.from, meta.to, tech?.connected_email)
          ? null
          : emailAddressOf(meta.from),
      threadId: meta.threadId ?? null,
      ...(threadContext.length > 0 ? { threadContext } : {}),
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
        // WHO ACTUALLY RECEIVED IT, on the firm's own mail (rung 10b.4). The
        // door keys on ONE recipient and refuses the rest, but the record of a
        // Cc'd landlord or a Bcc'd bookkeeper is exactly the sort of thing
        // somebody asks about later — and L1 is append-only, so a field not
        // written here can never be recovered. Present-only, and inert on every
        // channel that has no such header.
        ...(meta.recipients ? { recipients: meta.recipients } : {}),
        ...(meta.cc ? { cc: meta.cc } : {}),
        ...(meta.bcc ? { bcc: meta.bcc } : {}),
        ...(meta.labelIds ? { labelIds: meta.labelIds } : {}),
        // WHAT WAS ATTACHED (step 2e). Names, types and sizes only — the Gmail
        // attachment ids are a fetch handle, not a fact about the email, and L1
        // is append-only. Present-only.
        ...(attachments.length > 0
          ? { attachments: attachments.map((a) => ({ name: a.name, mime: a.mime, size: a.size })) }
          : {}),
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
    // Unknown ref: keep the capture (ground truth), and raise an observation so
    // the planner sees it (the review queue it used to wait in is retired). One
    // observation per ref, ever — the once-ever index makes every later message
    // from the same unknown ref converge to null, and the planner's `recover`
    // is what re-surfaces a dismissed one. Advisory: a failure never fails an
    // already-landed ingest.
    if (!tech && r.status !== 'duplicate') {
      try {
        await flagReview({
          tenantId,
          ref: technicianRef,
          captureId: r.captureId,
        });
      } catch {
        /* advisory */
      }
    }
    if (outbound && tech && r.status !== 'duplicate') {
      // STEP 2E PHASE 4 — THE MANAGER'S OWN INVOICE, ASKED ABOUT ONCE. Only
      // here, after the capture is fully filed: an observation on the capture
      // counts as "processed" to the door's own dedup (captureHasLinkedL2), so
      // raising it any earlier would make a half-filed capture's redelivery
      // stop short. Advisory — the email has landed, and a failed ask must not
      // turn it into a 503 whose redelivery would then read as a duplicate and
      // never ask at all.
      // AN ACTIVE MANAGER'S MAILBOX ONLY (operator ruling, step 2e review): the
      // ask and the kept files are both about the manager's own sent work
      // email. A pending-verification mailbox is excluded too — its files would
      // carry no pairing stamp, so a wrong-account pairing could not find them.
      const manager = tech.tier === 'manager' && tech.state === 'active';
      if (manager && looksLikeInvoice({ subject: meta.subject, body: meta.body, attachments })) {
        try {
          const words = invoiceWords(meta.subject, meta.body);
          const named = await (deps.issuedNumberNamed ?? namesIssuedNumber)(
            tenantId,
            words,
            attachments.map((a) => a.name),
          );
          if (!named) {
            await (deps.raiseOutboundInvoice ?? raiseOutboundInvoiceObservation)({
              tenantId,
              captureId: r.captureId,
              customerId: r.customerId ?? null,
              jobId: r.jobId ?? null,
              sentTo: soleRecipientOf(meta.to) ?? meta.to ?? null,
              // WHOSE MAILBOX: the office addresses the ask to this person's
              // seat (planner.ts refuses any other recipient but a fallback
              // active manager).
              technicianRef: tech.ref,
              senderName: tech.display_name,
              words,
              attachments: attachments.map((a) => ({ name: a.name, mime: a.mime })),
            });
          }
        } catch (err) {
          console.error(
            `inbound: the sent-invoice ask for ${r.captureId} was not raised — ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      // THE FILES, AFTER THE RESPONSE. Fetching a PDF from Gmail is seconds of
      // network inside Composio's delivery request; stall past its timeout and
      // the delivery is redelivered into the same stall. So the fetch is
      // scheduled for after this handler returns and the response is written,
      // bounded (60 s total) and best-effort inside keepSentAttachments.
      //
      // A NAMED HOLE: this work lives only in this process. A restart or deploy
      // between the response and the fetch loses it, and nothing retries — the
      // delivery was already answered, so Composio will not redeliver. The email
      // itself is on the record either way; only its files are missing.
      if (manager && attachments.length > 0) {
        const keep = deps.keepAttachments ?? keepSentAttachments;
        const job = {
          tenantId,
          tech,
          messageId: selfMessageId,
          attachments,
          target: { jobId: r.jobId ?? null, customerId: r.customerId ?? null },
        };
        // Through a resolved promise, so even a SYNCHRONOUS throw from the
        // seam lands in the catch instead of escaping as an uncaught exception.
        setImmediate(() => {
          Promise.resolve()
            .then(() => keep(job))
            .catch((err: unknown) => {
              console.error(
                `inbound: sent attachments for ${r.captureId} not kept — ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              );
            });
        });
      }
    }
    return { status: r.status === 'duplicate' ? 'duplicate' : 'ingested', captureId: r.captureId };
  } catch (err) {
    if (isForeignKeyViolation(err)) return { status: 'unknown_tenant' };
    return { status: 'transient_error' };
  }
}

// The normalizer's list, re-checked at the door: sourceMeta is JSON by type, so
// anything malformed is dropped rather than trusted.
function outboundAttachments(raw: unknown): SentAttachment[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a): SentAttachment[] => {
    if (!a || typeof a !== 'object') return [];
    const o = a as Record<string, unknown>;
    if (typeof o.attachmentId !== 'string' || !o.attachmentId) return [];
    return [
      {
        attachmentId: o.attachmentId,
        name: typeof o.name === 'string' && o.name ? o.name : 'attachment',
        mime: typeof o.mime === 'string' && o.mime ? o.mime : 'application/octet-stream',
        size: typeof o.size === 'number' ? o.size : null,
      },
    ];
  });
}
