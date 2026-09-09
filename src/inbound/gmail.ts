import { registerNormalizer, type InboundEnvelope, type Normalizer } from './normalize.js';
import { formatEmailRawText } from '../email/format.js';

// Shape of Composio's GMAIL_NEW_GMAIL_MESSAGE trigger payload `data`.
// Field names CONFIRMED against a live V3 trigger (2026-06-28): snake_case
// message_id / sender / subject / message_text / message_timestamp.
//
// THE PAYLOAD HAS TWELVE FIELDS, NOT FIVE (verified against the trigger-type
// schema and a live read of the same message, 2026-09-07 — research
// `2026-09-07-email-thread-context-from-composio`). The seven this interface
// used to omit were silently dropped before L1, and L1 is append-only, so an
// email landed without its thread id can never be attached to its
// conversation afterwards. Three are kept now: `thread_id` (a reply carries
// the SAME thread id as the message it answers — the only key that chains an
// email to what it replies to), `to` (which mailbox it arrived in), and
// `label_ids` (INBOX / SENT / CATEGORY_* — direction, once SENT is watched).
// Still dropped, deliberately: `payload`, `preview`, `attachment_list`, `id`.
interface GmailMessagePayload {
  message_id?: string;
  sender?: string;
  subject?: string;
  message_text?: string;
  message_timestamp?: string;
  thread_id?: string;
  to?: string;
  label_ids?: unknown;
}

// Maps a Gmail "new message" trigger payload to the connector-agnostic envelope.
// Same rawText shape the webhook normalizer builds (src/email/format.ts). Throws if the
// message id is absent — without it there is no dedup key, so the capture is unsafe.
export const gmailNewMessageNormalizer: Normalizer = (payload: unknown): InboundEnvelope => {
  const data = (payload ?? {}) as GmailMessagePayload;
  const messageId = data.message_id;
  if (!messageId) throw new Error('gmailNewMessageNormalizer: payload missing message_id');

  const from = data.sender ?? '';
  const subject = data.subject ?? '';
  const body = data.message_text ?? '';
  // Present-only, and under the OUTBOUND capture's key names (`threadId` —
  // src/mcp/server.ts stamps every assistant-sent email with it), so one
  // thread's inbound and outbound rows share a key. An absent field stays
  // absent rather than becoming `null`: L1 readers test for the key.
  // LENGTH-CAPPED, and it is the INSERT this protects, not the read. Rung 10b
  // indexes `metadata->>'threadId'`, and a btree entry tops out around 2704
  // bytes — so an absurdly long thread id would make the L1 APPEND ITSELF fail
  // ("index row size exceeds btree maximum") inside the webhook, which the
  // handler reads as transient and retries forever, paying for an extraction
  // every time. A real Gmail thread id is 16 characters. Over the cap the key is
  // DROPPED, never truncated: a truncated id is a key that could match the wrong
  // conversation, which is worse than having no key at all. The mail still
  // ingests — the thread id is an aid, never a condition of capture.
  const THREAD_ID_MAX = 255;
  const threadId =
    typeof data.thread_id === 'string' && data.thread_id && data.thread_id.length <= THREAD_ID_MAX
      ? data.thread_id
      : undefined;
  const to = typeof data.to === 'string' && data.to ? data.to : undefined;
  const labelIds = Array.isArray(data.label_ids)
    ? data.label_ids.filter((l): l is string => typeof l === 'string')
    : undefined;
  // WHICH DIRECTION IS THIS (rung 10b.3)? Gmail's own answer: a message the
  // mailbox SENT carries the SENT label. Mapped to the existing
  // `outbound_email` channel rather than a new one, so every reader that
  // already distinguishes the firm's voice from the customer's — AUDIT_CHANNELS
  // (retraction is manager-only on an audit row), the extractor's "the firm's
  // own replies" rule, isTechnicianChannel — keeps working with no edit.
  // A message to oneself carries BOTH labels: SENT wins, because the firm
  // wrote it, and that is the fact every one of those readers is asking about.
  const isOwnSend = !!labelIds?.includes('SENT');

  // …AND IT IS KEYED IN THE OUTBOUND NAMESPACE, `sent:<messageId>`, because the
  // spine ALREADY writes the firm's own sends under exactly that key — the
  // synchronous capture from `send_email` (src/mcp/server.ts) and the
  // quarter-hour sweep over a manager's direct Composio executions
  // (src/composio/logIngest.ts). Deliver the same message under the bare id and
  // the per-tenant unique index sees two different keys, so ONE email becomes
  // TWO permanent L1 rows — the manager-direct case is the common one, because
  // logIngest runs up to fifteen minutes after the trigger fires.
  //
  // One key, three writers, and the collision is the point: whoever gets there
  // first holds the row and the others read as duplicates. It also makes a
  // Composio REDELIVERY free — our own earlier row is found before the
  // classifier — where a bare id would re-pay for the triage every time.
  const externalId = isOwnSend ? `sent:${messageId}` : messageId;

  return {
    channel: isOwnSend ? 'outbound_email' : 'email',
    rawText: formatEmailRawText({ from, subject, body }), // L1 storage form (headers + body)
    externalId,
    occurredAt: data.message_timestamp,
    // Keep the CLEAN body here too — the classifier is fed {from,subject,body},
    // NEVER the prefixed rawText: the storage form's header lines would be
    // judged as part of the message.
    sourceMeta: {
      from,
      subject,
      body,
      // THE BARE GMAIL ID, kept beside the prefixed externalId. Everything that
      // has to line up with GMAIL's own view of a thread — "never show the
      // message to itself", a retraction's blocked list — compares against the
      // id Gmail uses, and for an outbound row `externalId` is no longer it.
      messageId,
      ...(threadId ? { threadId } : {}),
      ...(to ? { to } : {}),
      ...(labelIds && labelIds.length > 0 ? { labelIds } : {}),
    },
    requiresWorkClassifier: true,
  };
};

registerNormalizer('GMAIL', 'GMAIL_NEW_GMAIL_MESSAGE', gmailNewMessageNormalizer);
