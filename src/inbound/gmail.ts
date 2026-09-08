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
  const threadId = typeof data.thread_id === 'string' && data.thread_id ? data.thread_id : undefined;
  const to = typeof data.to === 'string' && data.to ? data.to : undefined;
  const labelIds = Array.isArray(data.label_ids)
    ? data.label_ids.filter((l): l is string => typeof l === 'string')
    : undefined;

  return {
    channel: 'email',
    rawText: formatEmailRawText({ from, subject, body }), // L1 storage form (headers + body)
    externalId: messageId,
    occurredAt: data.message_timestamp,
    // Keep the CLEAN body here too — the classifier is fed {from,subject,body},
    // NEVER the prefixed rawText: the storage form's header lines would be
    // judged as part of the message.
    sourceMeta: {
      from,
      subject,
      body,
      ...(threadId ? { threadId } : {}),
      ...(to ? { to } : {}),
      ...(labelIds && labelIds.length > 0 ? { labelIds } : {}),
    },
    requiresWorkClassifier: true,
  };
};

registerNormalizer('GMAIL', 'GMAIL_NEW_GMAIL_MESSAGE', gmailNewMessageNormalizer);
