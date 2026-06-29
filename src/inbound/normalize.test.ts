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
