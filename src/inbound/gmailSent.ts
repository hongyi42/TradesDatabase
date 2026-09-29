import { registerNormalizer, type InboundEnvelope, type Normalizer } from './normalize.js';
import { formatEmailRawText } from '../email/format.js';

// THE FIRM'S OWN HALF OF THE CONVERSATION (rung 10b.4).
//
// WHY A SECOND TRIGGER RATHER THAN A WIDER ONE. Composio publishes a fixed menu
// of trigger types per toolkit and Gmail's has exactly two. The one we already
// watch is named, in its own metadata, "New Gmail Message RECEIVED Trigger" —
// "triggers when a new message is received in Gmail". No config widens it: a
// message the mailbox SENT is never received, so `labelIds` and `query` both
// filter within mail that arrived. Verified live 2026-09-10 — a SENT reply was
// never delivered and never entered the instance's tracked-message state.
//
// GMAIL_EMAIL_SENT_TRIGGER is the other half, and it is purpose-built:
// "Triggers when a Gmail message is sent by the authenticated user. It polls
// the 'SENT' label…" (GET /api/v3/triggers_types/GMAIL_EMAIL_SENT_TRIGGER,
// read 2026-09-10).
//
// ITS PAYLOAD IS NOT THE RECEIVED ONE'S. Confirmed against that schema:
// message_id · message_text · message_timestamp · thread_id · sender · to ·
// subject · recipients (To+Cc+Bcc, comma-separated) · cc · bcc ·
// attachment_list · payload. There is NO `label_ids`, which is why direction
// cannot be read off the labels here — it does not need to be. The TRIGGER TYPE
// is the direction: everything this normalizer sees, the firm sent.
interface GmailSentPayload {
  message_id?: string;
  sender?: string;
  subject?: string;
  message_text?: string;
  message_timestamp?: string;
  thread_id?: string;
  to?: string;
  recipients?: string;
  cc?: string;
  bcc?: string;
  attachment_list?: unknown;
  payload?: unknown;
}

/**
 * One attachment on the firm's own sent mail (step 2e Phase 4). `attachmentId`
 * is Gmail's handle for fetching the bytes and never reaches L1 — the capture's
 * metadata keeps only `{name, mime, size}` (webhook.ts).
 */
export interface SentAttachment {
  attachmentId: string;
  name: string;
  mime: string;
  /** Bytes, when the payload says; null when it does not. */
  size: number | null;
}

// A generous bound on what one message can carry into the fetch loop — Gmail
// caps a message near 25 MB, so a list past this is a malformed payload.
const MAX_ATTACHMENTS = 25;
const MAX_PART_DEPTH = 10;

const str = (o: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
};

const sizeOf = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

// THE ITEM SHAPE OF `attachment_list` IS UNDECLARED. Composio's live trigger
// schema (GET /api/v3/triggers_types/GMAIL_EMAIL_SENT_TRIGGER) types it as an
// array of `{}` — so every spelling seen across Composio's Gmail tools is read,
// and a list we cannot read falls back to the message's own MIME tree:
// `payload.parts[]`, Gmail's `MessagePart` (filename, mimeType,
// body.attachmentId, body.size —
// https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages).
// An item with no attachment id is skipped: without it the bytes cannot be
// fetched, and a name alone keeps nothing.
export function readSentAttachments(data: { attachment_list?: unknown; payload?: unknown }): SentAttachment[] {
  const out: SentAttachment[] = [];
  const seen = new Set<string>();
  const push = (a: SentAttachment): void => {
    if (seen.has(a.attachmentId) || out.length >= MAX_ATTACHMENTS) return;
    seen.add(a.attachmentId);
    out.push(a);
  };
  if (Array.isArray(data.attachment_list)) {
    for (const item of data.attachment_list) {
      if (!isObj(item)) continue;
      const attachmentId = str(item, 'attachmentId', 'attachment_id', 'id');
      if (!attachmentId) continue;
      push({
        attachmentId,
        name: str(item, 'filename', 'file_name', 'name') ?? 'attachment',
        mime: str(item, 'mimeType', 'mime_type', 'mimetype') ?? 'application/octet-stream',
        size: sizeOf(item.size),
      });
    }
  }
  if (out.length > 0) return out;
  const walk = (part: unknown, depth: number): void => {
    if (!isObj(part) || depth > MAX_PART_DEPTH) return;
    const body = isObj(part.body) ? part.body : {};
    const filename = str(part, 'filename');
    const attachmentId = str(body, 'attachmentId', 'attachment_id');
    if (filename && attachmentId) {
      push({
        attachmentId,
        name: filename,
        mime: str(part, 'mimeType', 'mime_type') ?? 'application/octet-stream',
        size: sizeOf(body.size),
      });
    }
    if (Array.isArray(part.parts)) for (const p of part.parts) walk(p, depth + 1);
  };
  walk(data.payload, 0);
  return out;
}

export const gmailEmailSentNormalizer: Normalizer = (payload: unknown): InboundEnvelope => {
  const data = (payload ?? {}) as GmailSentPayload;
  const messageId = data.message_id;
  // Same rule as the received door: no id, no dedup key, so the capture would be
  // unsafe — and here it is doubly so, since the id is what joins this delivery
  // to the row `send_email` may already have written for the same message.
  if (!messageId) throw new Error('gmailEmailSentNormalizer: payload missing message_id');

  const from = data.sender ?? '';
  const subject = data.subject ?? '';
  const body = data.message_text ?? '';
  // The same 255 cap and the same DROP-never-truncate rule as the received
  // normalizer, for the same reason: `metadata->>'threadId'` is indexed, a btree
  // entry tops out near 2704 bytes, and a truncated id is a key that could match
  // the WRONG conversation. See src/inbound/gmail.ts for the full reasoning.
  const THREAD_ID_MAX = 255;
  const threadId =
    typeof data.thread_id === 'string' && data.thread_id && data.thread_id.length <= THREAD_ID_MAX
      ? data.thread_id
      : undefined;
  // `to` is the To line; `recipients` folds in Cc and Bcc. The DOOR keys a
  // customer off `to` and refuses anything but a single address, so the To line
  // alone is what it wants — a Bcc'd colleague must not turn a one-customer
  // reply into an ambiguous one. `recipients` is kept in metadata as the record
  // of who actually received it.
  //
  // `to` IS THE WHOLE DOOR ON THIS CHANNEL, AND THE TRIGGER DOES NOT PROMISE IT.
  // The live payload schema declares it, but the trigger's own description lists
  // "sender, RECIPIENTS, subject, timestamp, and thread ID" — `to` is not in
  // that sentence. Every outbound behaviour keys off it: the customer match
  // (`soleRecipientOf`), the classifier's only real signal on mail whose sender
  // is always us, and the drop receipt's domain. An empty `to` would make EVERY
  // outbound message unmatched, silently. So `recipients` is the fallback, and
  // it is safe to be: `soleRecipientOf` refuses anything but ONE distinct
  // address, so a Cc'd colleague still yields no key rather than a wrong one.
  const to =
    (typeof data.to === 'string' && data.to ? data.to : undefined) ??
    (typeof data.recipients === 'string' && data.recipients ? data.recipients : undefined);
  const recipients = typeof data.recipients === 'string' && data.recipients ? data.recipients : undefined;
  // STEP 2E PHASE 4 — the files on the firm's own mail (an invoice PDF, most
  // often), carried to the door so it can keep them after the capture lands.
  const attachments = readSentAttachments(data);

  return {
    // The direction comes from the TRIGGER TYPE, not from anything in the
    // payload — every message this normalizer is handed was sent by the firm.
    channel: 'outbound_email',
    rawText: formatEmailRawText({ from, subject, body }), // L1 storage form
    // THE OUTBOUND NAMESPACE, shared with `send_email` and `logIngest`. One key
    // for all three writers, so a send and this delivery of the same message
    // collapse into one row on the per-tenant unique index instead of becoming
    // two undeletable ones (src/inbound/gmail.ts explains the whole ordering).
    externalId: `sent:${messageId}`,
    occurredAt: data.message_timestamp,
    sourceMeta: {
      from,
      subject,
      body, // the CLEAN body — the classifier must never be fed the header form
      messageId, // Gmail's own id, beside the prefixed storage key
      ...(threadId ? { threadId } : {}),
      ...(to ? { to } : {}),
      ...(recipients ? { recipients } : {}),
      ...(typeof data.cc === 'string' && data.cc ? { cc: data.cc } : {}),
      ...(typeof data.bcc === 'string' && data.bcc ? { bcc: data.bcc } : {}),
      // Present-only. The attachment ids ride here for the fetch; the door
      // writes only {name, mime, size} into L1 (webhook.ts).
      ...(attachments.length > 0
        ? { attachments: attachments.map((a) => ({ ...a })) }
        : {}),
    },
    // THE USER'S RULING STANDS (2026-09-09): a human's own sent mail is gated by
    // the work/personal classifier exactly as inbound is. L1 has no delete, so a
    // manager's dentist appointment must never be written. This is NOT the
    // 2026-07-04 agent-send exception, which covers what the AGENT performed.
    requiresWorkClassifier: true,
  };
};

registerNormalizer('GMAIL', 'GMAIL_EMAIL_SENT_TRIGGER', gmailEmailSentNormalizer);
