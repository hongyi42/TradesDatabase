import { describe, expect, test } from 'vitest';
import { resolveNormalizer } from './normalize.js';
import { gmailNewMessageNormalizer } from './gmail.js'; // self-registers GMAIL normalizer

// Pure-function unit tests: no DB, no network. Proves the payload → envelope seam
// and the registry routing independent of any live Composio connection.
const gmailPayload = {
  message_id: 'gmail-abc-123',
  sender: 'jane@homeowner.com',
  subject: 'AC repair follow-up',
  message_text: 'unit still noisy',
  message_timestamp: '2026-06-02T08:30:00.000Z',
};

describe('gmailNewMessageNormalizer', () => {
  test('maps a Gmail trigger payload to the inbound envelope', () => {
    const env = gmailNewMessageNormalizer(gmailPayload);
    expect(env.channel).toBe('email');
    expect(env.externalId).toBe('gmail-abc-123');
    expect(env.requiresWorkClassifier).toBe(true);
    expect(env.occurredAt).toBe('2026-06-02T08:30:00.000Z');
    expect(env.rawText).toBe('Subject: AC repair follow-up\nFrom: jane@homeowner.com\n\nunit still noisy');
    // sourceMeta carries the CLEAN body too, so the webhook can classify on the same
    // input the pull path uses (not the header-prefixed rawText).
    expect(env.sourceMeta).toEqual({
      from: 'jane@homeowner.com',
      subject: 'AC repair follow-up',
      body: 'unit still noisy',
    });
  });

  test('throws when the message id is missing (no dedup key)', () => {
    expect(() => gmailNewMessageNormalizer({ sender: 'x@y.com' })).toThrow();
  });

  // The conversation key (2026-09-07). The live payload carries twelve fields;
  // these three are kept under the OUTBOUND capture's key names so one thread's
  // inbound and outbound rows share a key. Present-only: the test above pins
  // that a payload without them yields exactly {from, subject, body}.
  test('keeps the thread id, the recipient and the labels when the payload carries them', () => {
    const env = gmailNewMessageNormalizer({
      ...gmailPayload,
      thread_id: 'thread-abc-100',
      to: 'office@firm.example',
      label_ids: ['UNREAD', 'INBOX', 42, null],
    });
    expect(env.sourceMeta).toEqual({
      from: 'jane@homeowner.com',
      subject: 'AC repair follow-up',
      body: 'unit still noisy',
      threadId: 'thread-abc-100',
      to: 'office@firm.example',
      labelIds: ['UNREAD', 'INBOX'], // non-strings dropped, never stored
    });
    // An empty thread id or a non-array label list is ABSENT, not null/garbage.
    const bare = gmailNewMessageNormalizer({ ...gmailPayload, thread_id: '', label_ids: 'INBOX' });
    expect(bare.sourceMeta).not.toHaveProperty('threadId');
    expect(bare.sourceMeta).not.toHaveProperty('labelIds');
  });
});

describe('resolveNormalizer', () => {
  test('round-trips a registered key (case-insensitive)', () => {
    expect(resolveNormalizer('GMAIL', 'GMAIL_NEW_GMAIL_MESSAGE')).toBe(gmailNewMessageNormalizer);
    expect(resolveNormalizer('gmail', 'gmail_new_gmail_message')).toBe(gmailNewMessageNormalizer);
  });

  test('returns null for an unknown toolkit/triggerType', () => {
    expect(resolveNormalizer('SLACK', 'NEW_MESSAGE')).toBeNull();
    expect(resolveNormalizer('GMAIL', 'GMAIL_UNKNOWN_TRIGGER')).toBeNull();
  });
});
