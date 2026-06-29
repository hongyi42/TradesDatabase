import { registerNormalizer, type InboundEnvelope, type Normalizer } from './normalize.js';
import { formatEmailRawText } from '../email/format.js';

// Shape of Composio's GMAIL_NEW_GMAIL_MESSAGE trigger payload `data`.
// Field names CONFIRMED against a live V3 trigger (2026-06-28): snake_case
// message_id / sender / subject / message_text / message_timestamp.
interface GmailMessagePayload {
  message_id?: string;
  sender?: string;
  subject?: string;
  message_text?: string;
  message_timestamp?: string;
}

// Maps a Gmail "new message" trigger payload to the connector-agnostic envelope.
// Same rawText shape as the existing Gmail pull (ingest.ts:89). Throws if the
// message id is absent — without it there is no dedup key, so the capture is unsafe.
export const gmailNewMessageNormalizer: Normalizer = (payload: unknown): InboundEnvelope => {
  const data = (payload ?? {}) as GmailMessagePayload;
  const messageId = data.message_id;
  if (!messageId) throw new Error('gmailNewMessageNormalizer: payload missing message_id');

  const from = data.sender ?? '';
  const subject = data.subject ?? '';
  const body = data.message_text ?? '';

  return {
    channel: 'email',
    rawText: formatEmailRawText({ from, subject, body }), // L1 storage form (headers + body)
    externalId: messageId,
    occurredAt: data.message_timestamp,
    // Keep the CLEAN body here too — the webhook feeds {from,subject,body} to the
    // classifier, which must match the Gmail pull path's input (NOT the prefixed
    // rawText), so the same email is judged identically regardless of route.
    sourceMeta: { from, subject, body },
    requiresWorkClassifier: true,
  };
};

registerNormalizer('GMAIL', 'GMAIL_NEW_GMAIL_MESSAGE', gmailNewMessageNormalizer);
