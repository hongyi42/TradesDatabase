import { describe, expect, test } from 'vitest';
import { resolveNormalizer } from './normalize.js';
import { gmailNewMessageNormalizer } from './gmail.js'; // self-registers GMAIL normalizer
import { gmailEmailSentNormalizer } from './gmailSent.js'; // …and the SENT one

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
      // GMAIL's own id, kept beside the storage key: for an outbound row the
      // two differ, and anything comparing against Gmail's view needs this one.
      messageId: 'gmail-abc-123',
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
      messageId: 'gmail-abc-123',
      threadId: 'thread-abc-100',
      to: 'office@firm.example',
      labelIds: ['UNREAD', 'INBOX'], // non-strings dropped, never stored
    });
    // An empty thread id or a non-array label list is ABSENT, not null/garbage.
    const bare = gmailNewMessageNormalizer({ ...gmailPayload, thread_id: '', label_ids: 'INBOX' });
    expect(bare.sourceMeta).not.toHaveProperty('threadId');
    expect(bare.sourceMeta).not.toHaveProperty('labelIds');
  });

  // RUNG 10B: the thread id is INDEXED, and a btree entry caps at ~2704 bytes —
  // so an absurd id would break the L1 append itself, inside the webhook, which
  // retries forever. Dropped rather than truncated (a truncated id is a key that
  // could match the wrong conversation), and the mail still ingests.
  test('an absurdly long thread id is dropped, and the rest of the email survives', () => {
    const env = gmailNewMessageNormalizer({
      ...gmailPayload,
      thread_id: 'x'.repeat(256),
      to: 'office@firm.example',
    });
    expect(env.sourceMeta).not.toHaveProperty('threadId');
    expect(env.sourceMeta).toMatchObject({ from: 'jane@homeowner.com', to: 'office@firm.example' });
    expect(env.externalId).toBe(gmailPayload.message_id);
    // The boundary itself is kept.
    const atCap = gmailNewMessageNormalizer({ ...gmailPayload, thread_id: 'y'.repeat(255) });
    expect((atCap.sourceMeta as { threadId?: string }).threadId).toBe('y'.repeat(255));
  });

  // RUNG 10B.3 — DIRECTION, from Gmail's own label. Until the trigger watched
  // SENT this could not fire; now every reply a manager types by hand arrives
  // here, and the channel is how every downstream reader tells the firm's voice
  // from the customer's.
  describe('direction', () => {
    test('a SENT message is the firm\'s own — outbound_email', () => {
      const env = gmailNewMessageNormalizer({
        ...gmailPayload,
        sender: 'office@firm.example',
        to: 'jane@homeowner.com',
        label_ids: ['SENT'],
      });
      expect(env.channel).toBe('outbound_email');
      // Still classified: a manager's personal mail must never reach L1, which
      // has no delete (user ruling, 2026-09-09).
      expect(env.requiresWorkClassifier).toBe(true);
      // KEYED IN THE OUTBOUND NAMESPACE — the same key send_email and logIngest
      // write under, so one email can only ever be one L1 row. Gmail's own id
      // is kept beside it for everything that compares against Gmail's view.
      expect(env.externalId).toBe('sent:gmail-abc-123');
      expect((env.sourceMeta as { messageId?: string }).messageId).toBe('gmail-abc-123');
    });

    test('INBOX stays inbound, and so does a message with no labels at all', () => {
      expect(
        gmailNewMessageNormalizer({ ...gmailPayload, label_ids: ['INBOX', 'UNREAD'] }).channel,
      ).toBe('email');
      expect(gmailNewMessageNormalizer(gmailPayload).channel).toBe('email');
    });

    test('a message carrying BOTH labels — mailing yourself — reads as the firm\'s own', () => {
      // Gmail puts SENT and INBOX on a message you send to your own mailbox.
      // SENT wins: the firm wrote it, which is the fact every reader is asking.
      const env = gmailNewMessageNormalizer({
        ...gmailPayload,
        label_ids: ['INBOX', 'SENT', 'UNREAD'],
      });
      expect(env.channel).toBe('outbound_email');
    });
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

// RUNG 10B.4 — THE OTHER HALF OF THE MAILBOX. Gmail's trigger menu has exactly
// two watchers and each sees ONE DIRECTION. The received one is named, in
// Composio's own metadata, "New Gmail Message RECEIVED Trigger", so no config
// on it delivers the firm's own replies — verified live 2026-09-10. This
// normalizer serves GMAIL_EMAIL_SENT_TRIGGER, whose payload is a DIFFERENT
// shape: no `label_ids`, and `recipients`/`cc`/`bcc` that the received one
// never carries.
describe('gmailEmailSentNormalizer', () => {
  const sent = {
    message_id: 'gmail-sent-1',
    sender: 'Office <office@firm.test>',
    subject: 'Re: Radiator not heating upstairs',
    message_text: "Thursday works — we'll come out then.",
    message_timestamp: '2026-09-10T00:13:33.000Z',
    thread_id: 'thread-radiator',
    to: 'Iris <iris@homeowner.test>',
    recipients: 'iris@homeowner.test, bookkeeping@firm.test',
  };

  test('the direction comes from the TRIGGER TYPE — the payload has no labels', () => {
    const env = gmailEmailSentNormalizer(sent);
    expect(env.channel).toBe('outbound_email');
    // Nothing in the payload says "sent"; being handed to this normalizer does.
    expect(sent).not.toHaveProperty('label_ids');
  });

  test('keyed in the OUTBOUND namespace, with Gmail’s bare id kept beside it', () => {
    const env = gmailEmailSentNormalizer(sent);
    // One key for all three writers of an outbound row — this trigger,
    // send_email and logIngest — so one email cannot become two L1 rows.
    expect(env.externalId).toBe('sent:gmail-sent-1');
    expect((env.sourceMeta as { messageId?: string }).messageId).toBe('gmail-sent-1');
  });

  test('the classifier still gates it — the user’s ruling, and L1 has no delete', () => {
    expect(gmailEmailSentNormalizer(sent).requiresWorkClassifier).toBe(true);
  });

  test('stores the header form, and keeps the CLEAN body for the classifier', () => {
    const env = gmailEmailSentNormalizer(sent);
    expect(env.rawText).toBe(
      "Subject: Re: Radiator not heating upstairs\nFrom: Office <office@firm.test>\n\nThursday works — we'll come out then.",
    );
    expect((env.sourceMeta as { body?: string }).body).toBe("Thursday works — we'll come out then.");
    expect((env.sourceMeta as { body?: string }).body).not.toContain('Subject:');
  });

  test('the door keys on `to`, and `recipients` is kept as the record of who got it', () => {
    // A Bcc'd colleague must not turn a one-customer reply into an ambiguous
    // one: the door refuses anything but a single recipient, so it reads the
    // To line, not the folded list.
    const env = gmailEmailSentNormalizer(sent);
    expect(env.sourceMeta).toMatchObject({
      to: 'Iris <iris@homeowner.test>',
      recipients: 'iris@homeowner.test, bookkeeping@firm.test',
    });
  });

  test('present-only fields stay absent, and the timestamp rides along', () => {
    const bare = gmailEmailSentNormalizer({ message_id: 'm', sender: 'a@b.test' });
    expect(bare.sourceMeta).not.toHaveProperty('threadId');
    expect(bare.sourceMeta).not.toHaveProperty('cc');
    expect(bare.sourceMeta).not.toHaveProperty('recipients');
    expect(gmailEmailSentNormalizer(sent).occurredAt).toBe('2026-09-10T00:13:33.000Z');
  });

  test('no message id throws — no dedup key, and nothing to join the send to', () => {
    expect(() => gmailEmailSentNormalizer({ sender: 'x@y.test' })).toThrow();
  });

  test('an absurdly long thread id is dropped, and the mail still ingests', () => {
    const env = gmailEmailSentNormalizer({ ...sent, thread_id: 'x'.repeat(256) });
    expect(env.sourceMeta).not.toHaveProperty('threadId');
    expect(env.externalId).toBe('sent:gmail-sent-1');
  });

  describe('attachments (step 2e phase 4)', () => {
    test('the attachment_list is read in any of its spellings', () => {
      const env = gmailEmailSentNormalizer({
        ...sent,
        attachment_list: [
          { attachmentId: 'a1', filename: 'INV-77.pdf', mimeType: 'application/pdf', size: 1200 },
          { attachment_id: 'a2', file_name: 'photo.jpg', mime_type: 'image/jpeg', size: '300' },
          { id: 'a3', name: 'notes.txt', mimetype: 'text/plain' },
          { filename: 'no-id.pdf' }, // no id → cannot be fetched → skipped
          'junk',
        ],
      });
      expect((env.sourceMeta as { attachments?: unknown }).attachments).toEqual([
        { attachmentId: 'a1', name: 'INV-77.pdf', mime: 'application/pdf', size: 1200 },
        { attachmentId: 'a2', name: 'photo.jpg', mime: 'image/jpeg', size: 300 },
        { attachmentId: 'a3', name: 'notes.txt', mime: 'text/plain', size: null },
      ]);
    });

    test('an unreadable list falls back to the MIME tree (payload.parts, nested)', () => {
      const env = gmailEmailSentNormalizer({
        ...sent,
        attachment_list: [{}],
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            { mimeType: 'text/plain', filename: '', body: { size: 40 } },
            {
              mimeType: 'multipart/related',
              parts: [
                { mimeType: 'application/pdf', filename: 'Invoice 1004.pdf', body: { attachmentId: 'p1', size: 5000 } },
              ],
            },
            { mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'p2', size: 90 } },
          ],
        },
      });
      expect((env.sourceMeta as { attachments?: unknown }).attachments).toEqual([
        { attachmentId: 'p1', name: 'Invoice 1004.pdf', mime: 'application/pdf', size: 5000 },
        { attachmentId: 'p2', name: 'logo.png', mime: 'image/png', size: 90 },
      ]);
    });

    test('no attachments → no key at all', () => {
      expect(gmailEmailSentNormalizer(sent).sourceMeta).not.toHaveProperty('attachments');
      expect(
        gmailEmailSentNormalizer({ ...sent, attachment_list: [], payload: { parts: [] } }).sourceMeta,
      ).not.toHaveProperty('attachments');
    });
  });

  test('it is REGISTERED, or the webhook answers `unrouted` and discards the mail', () => {
    expect(resolveNormalizer('GMAIL', 'GMAIL_EMAIL_SENT_TRIGGER')).toBe(gmailEmailSentNormalizer);
    // …and the two doors stay distinct.
    expect(resolveNormalizer('GMAIL', 'GMAIL_NEW_GMAIL_MESSAGE')).toBe(gmailNewMessageNormalizer);
  });
});
