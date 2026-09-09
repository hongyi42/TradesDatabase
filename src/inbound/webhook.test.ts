import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  handleInboundWebhook,
  verifyWebhookSignature,
  type InboundWebhookDeps,
  type WebhookHeaders,
} from './webhook.js';
import type { RecordFieldNoteInput, RecordFieldNoteResult } from '../writePath/recordFieldNote.js';
import type { DroppedAuditInput, ReviewItem, Technician } from '../db/index.js';
import type { EmailInput, WorkClassifier } from '../email/classify.js';

// Pure/stubbed unit tests — no DB, no live model. HMAC cases mirror identity.test.ts;
// recordFieldNote, classify, tenantExists and the drop audit are injected so the
// routing + classify-before-L1 gate + error classification are provable without a
// Composio connection or DB.
// Composio uses the raw secret string as the HMAC key (not base64-decoded).
const SECRET = 'test-webhook-secret';
const OTHER_SECRET = 'other-secret';

// Mirrors the live Composio V3 envelope: metadata.user_id + metadata.trigger_slug,
// snake_case data fields. Default user_id is the composite "<tenant>:<ref>" —
// the only shape the webhook accepts since bare-uuid retirement (2026-07-02).
// `over` replaces top-level keys wholesale (pass `{ metadata: {...} }` or
// `{ data: {...} }` to override a whole sub-object).
const TENANT = '11111111-1111-1111-1111-111111111111';
function body(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'msg_test',
    type: 'composio.trigger.message',
    metadata: { user_id: `${TENANT}:tech-test`, trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' },
    data: {
      message_id: 'gmail-msg-1',
      sender: 'jane@homeowner.com',
      subject: 'AC repair',
      message_text: 'still noisy',
      message_timestamp: '2026-06-02T08:30:00.000Z',
    },
    ...over,
  });
}

// Build Composio webhook headers for a body: signs `${id}.${timestamp}.${body}` with
// the RAW secret as the HMAC key, emits `v1,<base64>` — mirrors the live scheme.
function sign(rawBody: string, secret = SECRET): WebhookHeaders {
  const id = 'msg_test';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${rawBody}`).digest('base64')}`;
  return { id, timestamp, signature };
}

// Recording stub for recordFieldNote; returns 'matched' by default.
function recorder(result: Partial<RecordFieldNoteResult> = {}) {
  const calls: RecordFieldNoteInput[] = [];
  const fn = async (input: RecordFieldNoteInput): Promise<RecordFieldNoteResult> => {
    calls.push(input);
    return { status: 'matched', captureId: 'cap-1', ...result };
  };
  return { calls, fn };
}

// Recording stub for the classifier — captures what it was fed (to prove clean body).
function classifyStub(isWork: boolean) {
  const calls: EmailInput[] = [];
  // The cost context is captured too. Without this the ctx argument threaded at
  // webhook.ts is untested — every stub ignores extra arguments, so deleting it
  // would leave the whole suite green while the classifier's Anthropic spend
  // (billed on EVERY inbound email, including the ones then dropped) silently
  // stopped being attributed to anyone.
  const contexts: Array<{ tenantId: string; technicianRef?: string | null } | undefined> = [];
  const fn: WorkClassifier = async (email, ctx) => {
    calls.push(email);
    contexts.push(ctx);
    return { isWork, reason: 'stub' };
  };
  return { calls, contexts, fn };
}

// Recording stub for the drop audit.
function dropRecorder() {
  const calls: DroppedAuditInput[] = [];
  const fn = async (input: DroppedAuditInput): Promise<void> => {
    calls.push(input);
  };
  return { calls, fn };
}

// A full roster Row for the getTechnician stub (only ref/state/tier vary in tests).
function techRow(over: Partial<Technician> = {}): Technician {
  return {
    id: 'tech-row-1',
    tenant_id: TENANT,
    ref: 'tech-test',
    display_name: 'Tech Test',
    tier: 'technician',
    state: 'active',
    sandbox_ref: null,
    composio_connected_account_id: null,
    composio_trigger_id: null,
    connected_email: null,
    badge_hash: null,
    host_id: null,
    offboarding_started_at: null,
    link_issued_at: null,
    composio_session_id: null,
    availability: null,
    service_cities: [],
    telegram_user_id: null,
    seat_exempt: false,
    skills: [],
    created_at: '2026-07-02T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    ...over,
  };
}

// Recording stub for the unknown-ref review flag.
function flagRecorder() {
  const calls: Array<{ tenantId: string; subjectRef: string; externalId?: string | null }> = [];
  const fn = async (input: {
    tenantId: string;
    subjectRef: string;
    externalId?: string | null;
  }): Promise<ReviewItem | null> => {
    calls.push(input);
    return { id: 'review-1' } as ReviewItem;
  };
  return { calls, fn };
}

// Default deps: tenant exists, roster knows the person (active), classifier says
// work, nothing hits the DB.
function baseDeps(over: InboundWebhookDeps = {}): InboundWebhookDeps {
  return {
    recordFieldNote: recorder().fn,
    classify: classifyStub(true).fn,
    tenantExists: async () => true,
    recordDrop: dropRecorder().fn,
    getTechnician: async () => techRow(),
    flagReview: flagRecorder().fn,
    // Hermetic by default: the live one reads the database, and every test here
    // stubs its world.
    alreadyProcessed: async () => false,
    listThreadCaptures: async () => ({ messages: [], blockedMessageIds: [] }),
    ...over,
  };
}

describe('verifyWebhookSignature', () => {
  test('valid passes; missing/tampered/stale/malformed fail (no throw)', () => {
    const raw = body();
    const now = String(Math.floor(Date.now() / 1000));
    expect(verifyWebhookSignature(raw, sign(raw), SECRET)).toBe(true);
    // missing headers entirely
    expect(verifyWebhookSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, {}, SECRET)).toBe(false);
    // wrong secret → same-length sig, fails timingSafeEqual
    expect(verifyWebhookSignature(raw, sign(raw, OTHER_SECRET), SECRET)).toBe(false);
    // tampered body (sig was for the original)
    expect(verifyWebhookSignature(body({ id: 'tampered' }), sign(raw), SECRET)).toBe(false);
    // stale timestamp (outside ±300s) → rejected even with a correct sig shape
    expect(
      verifyWebhookSignature(raw, { ...sign(raw), timestamp: '1000000000' }, SECRET),
    ).toBe(false);
    // malformed signature values
    expect(verifyWebhookSignature(raw, { id: 'x', timestamp: now, signature: 'abcd' }, SECRET)).toBe(false);
    expect(verifyWebhookSignature(raw, { id: 'x', timestamp: now, signature: 'v1,zz' }, SECRET)).toBe(false);
  });
});

describe('handleInboundWebhook', () => {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.COMPOSIO_WEBHOOK_SECRET;
    process.env.COMPOSIO_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (prev === undefined) delete process.env.COMPOSIO_WEBHOOK_SECRET;
    else process.env.COMPOSIO_WEBHOOK_SECRET = prev;
  });

  test('valid signature + work payload → ingested; recordFieldNote gets the split identity', async () => {
    const raw = body();
    const rec = recorder();
    const result = await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));

    expect(result).toEqual({ status: 'ingested', captureId: 'cap-1' });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]).toMatchObject({
      tenantId: TENANT,
      technicianRef: 'tech-test',
      channel: 'email',
      externalId: 'gmail-msg-1',
      occurredAt: '2026-06-02T08:30:00.000Z',
    });
    // A payload without a thread id lands without the key — never `threadId: null`.
    expect(rec.calls[0].sourceMeta).not.toHaveProperty('threadId');
  });

  // The conversation key reaches L1 (2026-09-07): the webhook copies threadId /
  // to / labelIds from the envelope into the capture's metadata, under the same
  // `threadId` the outbound capture uses, so a reply can be chained to what it
  // answers. Without this the field was dropped before an append-only store.
  test('threadId, to and labelIds ride into the L1 metadata when the payload carries them', async () => {
    const raw = body({
      data: {
        message_id: 'gmail-msg-2',
        sender: 'jane@homeowner.com',
        subject: 'Re: AC repair',
        message_text: 'yes, Friday works',
        message_timestamp: '2026-06-03T08:30:00.000Z',
        thread_id: 'gmail-msg-1',
        to: 'office@firm.example',
        label_ids: ['UNREAD', 'INBOX'],
      },
    });
    const rec = recorder();
    const result = await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(result.status).toBe('ingested');
    expect(rec.calls[0].sourceMeta).toMatchObject({
      from: 'jane@homeowner.com',
      subject: 'Re: AC repair',
      threadId: 'gmail-msg-1',
      to: 'office@firm.example',
      labelIds: ['UNREAD', 'INBOX'],
    });
    // The body is NOT duplicated into metadata — it lives in raw_text.
    expect(rec.calls[0].sourceMeta).not.toHaveProperty('body');
  });

  test('bare-uuid user_id (retired whole-business mode) → bad_payload, nothing called', async () => {
    const raw = body({ metadata: { user_id: TENANT, trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' } });
    const rec = recorder();
    const tenantChecks: string[] = [];
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        tenantExists: async (id) => {
          tenantChecks.push(id);
          return true;
        },
      }),
    );
    expect(result).toEqual({ status: 'bad_payload' });
    expect(rec.calls).toHaveLength(0);
    expect(tenantChecks).toHaveLength(0);
  });

  test('#5: classifier is fed the CLEAN body, not the header-prefixed rawText', async () => {
    const raw = body();
    const cls = classifyStub(true);
    await handleInboundWebhook(raw, sign(raw), baseDeps({ classify: cls.fn }));

    expect(cls.calls).toHaveLength(1);
    expect(cls.calls[0].body).toBe('still noisy'); // exactly messageText — no "Subject:/From:" prefix
    expect(cls.calls[0].body).not.toContain('Subject:');
    expect(cls.calls[0]).toMatchObject({ from: 'jane@homeowner.com', subject: 'AC repair' });
    // …and it is billed to whoever's mailbox this arrived in. This classifier
    // runs on every inbound email, so an unattributed call is real spend with
    // no tenant on it.
    expect(cls.contexts[0]).toEqual({ tenantId: TENANT, technicianRef: 'tech-test' });
  });

  test('composite user_id → tenant split + person attribution; tenantExists sees only the tenant part', async () => {
    const raw = body({
      metadata: { user_id: '11111111-1111-1111-1111-111111111111:alice', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' },
    });
    const rec = recorder();
    const tenantChecks: string[] = [];
    // Unknown ref (roster miss) forces the explicit tenantExists fallback —
    // for a KNOWN ref the tenant-scoped roster hit already proves the tenant
    // and tenantExists is skipped (asserted below).
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        getTechnician: async () => null,
        tenantExists: async (id) => {
          tenantChecks.push(id);
          return true;
        },
      }),
    );

    expect(result).toEqual({ status: 'ingested', captureId: 'cap-1' });
    expect(rec.calls[0]).toMatchObject({ tenantId: '11111111-1111-1111-1111-111111111111', technicianRef: 'alice' });
    expect(tenantChecks).toEqual(['11111111-1111-1111-1111-111111111111']); // validated on the SPLIT tenant, not the composite
  });

  test('known ref skips the tenantExists roundtrip (roster hit proves the tenant)', async () => {
    const raw = body();
    const tenantChecks: string[] = [];
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        tenantExists: async (id) => {
          tenantChecks.push(id);
          return true;
        },
      }),
    );
    expect(result.status).toBe('ingested');
    expect(tenantChecks).toHaveLength(0);
  });

  test('ref containing a colon: only the FIRST colon splits', async () => {
    const raw = body({
      metadata: { user_id: '11111111-1111-1111-1111-111111111111:crew:alice', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' },
    });
    const rec = recorder();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(rec.calls[0]).toMatchObject({ tenantId: '11111111-1111-1111-1111-111111111111', technicianRef: 'crew:alice' });
  });

  test('malformed composites ("tenant:" / ":alice") → bad_payload, recordFieldNote NOT called', async () => {
    const rec = recorder();
    const deps = baseDeps({ recordFieldNote: rec.fn });

    const emptyRef = body({ metadata: { user_id: '11111111-1111-1111-1111-111111111111:', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' } });
    expect(await handleInboundWebhook(emptyRef, sign(emptyRef), deps)).toEqual({ status: 'bad_payload' });

    const emptyTenant = body({ metadata: { user_id: ':alice', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' } });
    expect(await handleInboundWebhook(emptyTenant, sign(emptyTenant), deps)).toEqual({ status: 'bad_payload' });

    expect(rec.calls).toHaveLength(0);
  });

  test('non-work composite → skipped_non_work; drop receipt keyed by SPLIT tenant + person mailbox', async () => {
    const raw = body({
      metadata: { user_id: '11111111-1111-1111-1111-111111111111:alice', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' },
    });
    const rec = recorder();
    const drop = dropRecorder();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({ recordFieldNote: rec.fn, classify: classifyStub(false).fn, recordDrop: drop.fn }),
    );
    expect(result).toEqual({ status: 'skipped_non_work' });
    expect(rec.calls).toHaveLength(0);
    expect(drop.calls[0]).toMatchObject({
      tenantId: '11111111-1111-1111-1111-111111111111',
      technicianRef: 'alice', // re-fetch needs the mailbox: Gmail message ids are mailbox-local
    });
  });

  test('non-uuid tenant prefix → unknown_tenant BEFORE any DB call — a PostgREST 22P02 would otherwise become a retryable 503', async () => {
    const rec = recorder();
    const tenantChecks: string[] = [];
    const deps = baseDeps({
      recordFieldNote: rec.fn,
      tenantExists: async (id) => {
        tenantChecks.push(id);
        return true;
      },
    });

    const composite = body({ metadata: { user_id: 'acme:alice', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' } });
    expect(await handleInboundWebhook(composite, sign(composite), deps)).toEqual({ status: 'unknown_tenant' });

    expect(tenantChecks).toHaveLength(0); // guarded before tenantExists — no 22P02 possible
    expect(rec.calls).toHaveLength(0);
  });

  test('composite ref impersonating the reserved connector: namespace → bad_payload', async () => {
    const rec = recorder();
    const forged = body({
      metadata: { user_id: '11111111-1111-1111-1111-111111111111:connector:gmail', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' },
    });
    expect(await handleInboundWebhook(forged, sign(forged), baseDeps({ recordFieldNote: rec.fn }))).toEqual({
      status: 'bad_payload',
    });
    expect(rec.calls).toHaveLength(0);
  });

  test('offboarded person → skipped_offboarded drop receipt; no classify, no ingest', async () => {
    const raw = body();
    const rec = recorder();
    const cls = classifyStub(true);
    const drop = dropRecorder();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        classify: cls.fn,
        recordDrop: drop.fn,
        getTechnician: async () => techRow({ state: 'offboarded' }),
      }),
    );
    expect(result).toEqual({ status: 'skipped_offboarded' });
    expect(rec.calls).toHaveLength(0);
    expect(cls.calls).toHaveLength(0); // roster check runs before the model call
    expect(drop.calls[0]).toMatchObject({
      tenantId: TENANT,
      technicianRef: 'tech-test',
      reason: 'offboarded',
      externalId: 'gmail-msg-1',
    });
  });

  test('offboarding (grace period) is treated the same as offboarded', async () => {
    const raw = body();
    const drop = dropRecorder();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({ recordDrop: drop.fn, getTechnician: async () => techRow({ state: 'offboarding' }) }),
    );
    expect(result).toEqual({ status: 'skipped_offboarded' });
    expect(drop.calls).toHaveLength(1);
  });

  test('unknown ref → ingested AND flagged for manager review (keep the mail, never lose it)', async () => {
    const raw = body();
    const rec = recorder();
    const flag = flagRecorder();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({ recordFieldNote: rec.fn, flagReview: flag.fn, getTechnician: async () => null }),
    );
    expect(result).toEqual({ status: 'ingested', captureId: 'cap-1' });
    expect(rec.calls).toHaveLength(1); // the capture landed
    expect(flag.calls[0]).toMatchObject({
      tenantId: TENANT,
      subjectRef: 'tech-test',
      externalId: 'gmail-msg-1',
    });
  });

  test('unknown ref + duplicate redelivery → NOT re-flagged (resolved items stay resolved)', async () => {
    const raw = body();
    const flag = flagRecorder();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: recorder({ status: 'duplicate', captureId: 'cap-dup' }).fn,
        flagReview: flag.fn,
        getTechnician: async () => null,
      }),
    );
    expect(result).toEqual({ status: 'duplicate', captureId: 'cap-dup' });
    expect(flag.calls).toHaveLength(0);
  });

  test('active (known) ref → no review flag', async () => {
    const raw = body();
    const flag = flagRecorder();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ flagReview: flag.fn }));
    expect(flag.calls).toHaveLength(0);
  });

  test('a failing flag write is advisory: the ingest still succeeds', async () => {
    const raw = body();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        getTechnician: async () => null,
        flagReview: async () => {
          throw new Error('review_items unavailable');
        },
      }),
    );
    expect(result).toEqual({ status: 'ingested', captureId: 'cap-1' });
  });

  test('duplicate from recordFieldNote surfaces as duplicate', async () => {
    const raw = body();
    const rec = recorder({ status: 'duplicate', captureId: 'cap-dup' });
    const result = await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(result).toEqual({ status: 'duplicate', captureId: 'cap-dup' });
  });

  test('#2: bad signature → bad_signature (no throw, no DB work)', async () => {
    const raw = body();
    const rec = recorder();
    expect(await handleInboundWebhook(raw, undefined, baseDeps({ recordFieldNote: rec.fn }))).toEqual({
      status: 'bad_signature',
    });
    expect(await handleInboundWebhook(raw, sign(raw, OTHER_SECRET), baseDeps())).toEqual({
      status: 'bad_signature',
    });
    expect(
      await handleInboundWebhook(raw, { id: 'x', timestamp: '1', signature: 'abcd' }, baseDeps()),
    ).toEqual({ status: 'bad_signature' });
    expect(rec.calls).toHaveLength(0);
  });

  test('#2: malformed payloads → bad_payload (deterministic, no retry), recordFieldNote NOT called', async () => {
    const rec = recorder();
    const deps = baseDeps({ recordFieldNote: rec.fn });

    const badJson = 'not json at all';
    expect(await handleInboundWebhook(badJson, sign(badJson), deps)).toEqual({ status: 'bad_payload' });

    const missingFields = body({ metadata: {} }); // no user_id / trigger_slug
    expect(await handleInboundWebhook(missingFields, sign(missingFields), deps)).toEqual({ status: 'bad_payload' });

    // routed to Gmail but the normalizer throws (no message_id)
    const noMsgId = body({ data: { sender: 'x@y.com' } });
    expect(await handleInboundWebhook(noMsgId, sign(noMsgId), deps)).toEqual({ status: 'bad_payload' });

    expect(rec.calls).toHaveLength(0);
  });

  test('#4: unknown tenant (roster miss + tenantExists false) → unknown_tenant, classifier and recordFieldNote NOT called', async () => {
    const raw = body();
    const rec = recorder();
    const cls = classifyStub(true);
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        getTechnician: async () => null,
        tenantExists: async () => false,
        recordFieldNote: rec.fn,
        classify: cls.fn,
      }),
    );
    expect(result).toEqual({ status: 'unknown_tenant' });
    expect(cls.calls).toHaveLength(0);
    expect(rec.calls).toHaveLength(0);
  });

  test('bare NON-uuid user_id (no colon) → bad_payload at the shape check, before any lookup', async () => {
    const raw = body({ metadata: { user_id: 'acme', trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE' } });
    const tenantChecks: string[] = [];
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        tenantExists: async (id) => {
          tenantChecks.push(id);
          return true;
        },
      }),
    );
    expect(result).toEqual({ status: 'bad_payload' }); // shape check wins over uuid check
    expect(tenantChecks).toHaveLength(0);
  });

  test('non-work mail from an UNKNOWN ref is dropped AND flagged (typo pairing surfaces on personal mail too)', async () => {
    const raw = body();
    const drop = dropRecorder();
    const flag = flagRecorder();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        getTechnician: async () => null,
        classify: classifyStub(false).fn,
        recordDrop: drop.fn,
        flagReview: flag.fn,
      }),
    );
    expect(result).toEqual({ status: 'skipped_non_work' });
    expect(drop.calls).toHaveLength(1);
    expect(flag.calls[0]).toMatchObject({ subjectRef: 'tech-test', externalId: 'gmail-msg-1' });
  });

  test('non-work → skipped_non_work, recordFieldNote NOT called, content-free audit written', async () => {
    const raw = body();
    const rec = recorder();
    const drop = dropRecorder();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({ recordFieldNote: rec.fn, classify: classifyStub(false).fn, recordDrop: drop.fn }),
    );
    expect(result).toEqual({ status: 'skipped_non_work' });
    expect(rec.calls).toHaveLength(0); // classify-before-L1 proven
    expect(drop.calls).toHaveLength(1);
    expect(drop.calls[0]).toMatchObject({
      tenantId: '11111111-1111-1111-1111-111111111111',
      channel: 'email',
      externalId: 'gmail-msg-1',
      from: 'jane@homeowner.com',
    });
  });

  test('unknown toolkit → unrouted, recordFieldNote NOT called', async () => {
    const raw = body({ metadata: { user_id: '11111111-1111-1111-1111-111111111111', trigger_slug: 'SLACK_NEW_MESSAGE' } });
    const rec = recorder();
    const result = await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(result).toEqual({ status: 'unrouted' });
    expect(rec.calls).toHaveLength(0);
  });

  test('#2: a transient recordFieldNote error → transient_error (retryable)', async () => {
    const raw = body();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: async () => {
          throw new Error('db timeout');
        },
      }),
    );
    expect(result).toEqual({ status: 'transient_error' });
  });

  test('#2/#4: an FK violation from recordFieldNote → unknown_tenant (not retried)', async () => {
    const raw = body();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: async () => {
          throw Object.assign(new Error('insert or update violates foreign key'), { code: '23503' });
        },
      }),
    );
    expect(result).toEqual({ status: 'unknown_tenant' });
  });

  test('missing secret → throws (httpServer maps to 500)', async () => {
    const raw = body();
    delete process.env.COMPOSIO_WEBHOOK_SECRET;
    try {
      await expect(handleInboundWebhook(raw, sign(raw), baseDeps())).rejects.toThrow();
    } finally {
      process.env.COMPOSIO_WEBHOOK_SECRET = SECRET;
    }
  });
});

describe('pending_verification capture stamping', () => {
  let prev: string | undefined;
  beforeAll(() => {
    prev = process.env.COMPOSIO_WEBHOOK_SECRET;
    process.env.COMPOSIO_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.COMPOSIO_WEBHOOK_SECRET = prev;
  });

  test('a pending-verification person\'s capture is stamped; an active person\'s is not', async () => {
    // Window captures are permanent (L1 append-only) — the stamp is the only
    // after-the-fact handle if verification later fails (wrong mailbox).
    const pending = recorder();
    const raw = body();
    const r1 = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: pending.fn,
        getTechnician: async () => techRow({ state: 'pending_verification' }),
      }),
    );
    expect(r1.status).toBe('ingested'); // pending ingests exactly like active
    expect(pending.calls[0].sourceMeta).toMatchObject({ pendingVerification: true });

    const active = recorder();
    const r2 = await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: active.fn }));
    expect(r2.status).toBe('ingested');
    expect(active.calls[0].sourceMeta).not.toHaveProperty('pendingVerification');
  });
});

// RUNG 10B — THE CONVERSATION REACHES THE EXTRACTOR. A reply's own words are
// often useless alone; the name and the number sit three messages up. Composio
// first, our own captures as the fallback, and NEITHER may fail the ingest.
describe('thread context (rung 10b)', () => {
  let prevSecret: string | undefined;
  beforeAll(() => {
    prevSecret = process.env.COMPOSIO_WEBHOOK_SECRET;
    process.env.COMPOSIO_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.COMPOSIO_WEBHOOK_SECRET;
    else process.env.COMPOSIO_WEBHOOK_SECRET = prevSecret;
  });

  const reply = (over: Record<string, unknown> = {}) =>
    body({
      data: {
        message_id: 'gmail-msg-2',
        thread_id: 'thread-abc',
        sender: 'jane@homeowner.com',
        subject: 'Re: AC repair',
        message_text: 'Friday afternoon instead?',
        message_timestamp: '2026-06-03T08:30:00.000Z',
        ...over,
      },
    });
  const earlier = [
    {
      messageId: 'gmail-msg-1',
      from: 'jane@homeowner.com',
      to: 'office@firm.test',
      subject: 'AC repair',
      body: 'my number is 555-0199',
      at: '2026-06-02T08:30:00.000Z',
    },
  ];
  const fromL1 = { messages: earlier, blockedMessageIds: [] as string[] };
  const paired = techRow({ composio_connected_account_id: 'ca_test' });

  test('a thread STARTER fetches nothing — its thread id IS its own message id', async () => {
    const raw = body({
      data: {
        message_id: 'gmail-msg-1',
        thread_id: 'gmail-msg-1',
        sender: 'jane@homeowner.com',
        subject: 'AC repair',
        message_text: 'unit still noisy',
      },
    });
    const rec = recorder();
    const fetchThread = vi.fn(async () => earlier);
    const listThreadCaptures = vi.fn(async () => fromL1);
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        getTechnician: async () => paired,
        fetchThread,
        listThreadCaptures,
      }),
    );
    expect(result.status).toBe('ingested');
    expect(fetchThread).not.toHaveBeenCalled();
    expect(listThreadCaptures).not.toHaveBeenCalled();
    expect(rec.calls[0]).not.toHaveProperty('threadContext');
  });

  test('a REPLY fetches the thread once and hands it to the door, minus itself', async () => {
    const raw = reply();
    const rec = recorder();
    const fetchThread = vi.fn(async () => [
      ...earlier,
      // The current message comes back in its own thread — it must not be shown
      // to the model as context for itself.
      { messageId: 'gmail-msg-2', from: null, to: null, subject: null, body: 'Friday?', at: null },
    ]);
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({ recordFieldNote: rec.fn, getTechnician: async () => paired, fetchThread }),
    );
    expect(result.status).toBe('ingested');
    expect(fetchThread).toHaveBeenCalledTimes(1);
    expect(rec.calls[0].threadContext).toEqual(earlier);
  });

  test('a FAILED fetch falls back to our own captures, and the mail still lands', async () => {
    const raw = reply();
    const rec = recorder();
    const listThreadCaptures = vi.fn(async () => fromL1);
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        getTechnician: async () => paired,
        fetchThread: async () => null,
        listThreadCaptures,
      }),
    );
    expect(result.status).toBe('ingested');
    expect(listThreadCaptures).toHaveBeenCalledWith(TENANT, 'thread-abc');
    expect(rec.calls[0].threadContext).toEqual(earlier);
  });

  test('an unpaired mailbox skips Composio entirely and reads L1', async () => {
    const raw = reply();
    const rec = recorder();
    const fetchThread = vi.fn(async () => earlier);
    await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        getTechnician: async () => techRow(), // no connected account
        fetchThread,
        listThreadCaptures: async () => fromL1,
      }),
    );
    expect(fetchThread).not.toHaveBeenCalled();
    expect(rec.calls[0].threadContext).toEqual(earlier);
  });

  test('a redelivery the door will NO-OP on pays for no thread fetch', async () => {
    // The fetch is BILLED, and a 503 makes Composio redeliver: without the
    // pre-check the retry buys the same conversation again, every time.
    const raw = reply();
    const rec = recorder();
    const fetchThread = vi.fn(async () => earlier);
    const listThreadCaptures = vi.fn(async () => fromL1);
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: async () => ({ status: 'duplicate', captureId: 'cap-1' }),
        getTechnician: async () => paired,
        alreadyProcessed: async () => true,
        fetchThread,
        listThreadCaptures,
      }),
    );
    expect(result.status).toBe('duplicate');
    expect(fetchThread).not.toHaveBeenCalled();
    expect(listThreadCaptures).not.toHaveBeenCalled();
    void rec;
  });

  test('a RETRACTED message is kept out even when Composio hands it back', async () => {
    // Gmail knows nothing of our retractions, so the exclusion has to travel from
    // OUR view of the thread onto the fetched one — otherwise a retraction holds
    // only while Composio is down.
    const raw = reply();
    const rec = recorder();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        getTechnician: async () => paired,
        listThreadCaptures: async () => ({
          messages: [],
          blockedMessageIds: ['gmail-msg-1'],
        }),
        fetchThread: async () => earlier, // Gmail still returns the retracted one
      }),
    );
    expect(result.status).toBe('ingested');
    expect(rec.calls[0]).not.toHaveProperty('threadContext');
  });

  test('a fetched message with NO id is dropped — it cannot be ruled out', async () => {
    // If it cannot be placed it might BE the message being read, and showing that
    // as "earlier" would have the model treat a live commitment as one already
    // handled: a promise nobody at the firm ever hears about.
    const raw = reply();
    const rec = recorder();
    await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        getTechnician: async () => paired,
        fetchThread: async () => [
          ...earlier,
          { messageId: null, from: null, to: null, subject: null, body: 'unplaceable', at: null },
        ],
      }),
    );
    expect(rec.calls[0].threadContext).toEqual(earlier);
  });

  test('BOTH sources failing still ingests — context is an aid, never a condition', async () => {
    const raw = reply();
    const rec = recorder();
    const result = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        getTechnician: async () => paired,
        fetchThread: async () => {
          throw new Error('composio down');
        },
        listThreadCaptures: async () => {
          throw new Error('database down');
        },
      }),
    );
    expect(result).toEqual({ status: 'ingested', captureId: 'cap-1' });
    expect(rec.calls[0]).not.toHaveProperty('threadContext');
  });
});

describe("the firm's own mailbox is not a caller's identity (rung 10b.2)", () => {
  let prevSecret: string | undefined;
  beforeAll(() => {
    prevSecret = process.env.COMPOSIO_WEBHOOK_SECRET;
    process.env.COMPOSIO_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.COMPOSIO_WEBHOOK_SECRET;
    else process.env.COMPOSIO_WEBHOOK_SECRET = prevSecret;
  });

  const mail = (sender: string, to: string) =>
    body({
      data: {
        message_id: `own-mailbox-${sender}-${to}`,
        sender,
        to,
        subject: 'kitchen tap dripping',
        message_text: 'my kitchen tap has been dripping for about a week',
      },
    });

  // The live specimen, 2026-09-08: the pilot mailbox was mailed FROM the pilot
  // mailbox, and the sender was offered as the caller's identity key. Stored on
  // a customer, that address matches every later message the firm sends itself.
  test('a SELF-SENT message offers no fallbackEmail', async () => {
    const raw = mail('Hongyi <office@firm.test>', 'Hongyi <office@firm.test>');
    const rec = recorder();
    const result = await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(result.status).toBe('ingested'); // the mail still LANDS — only the key is withheld
    expect(rec.calls[0].fallbackEmail).toBeNull();
  });

  test('…and it is matched on the bare address, not the display name', async () => {
    // Same mailbox, different display name and case: still ours.
    const raw = mail('The Office <OFFICE@Firm.test>', 'Hongyi <office@firm.test>');
    const rec = recorder();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(rec.calls[0].fallbackEmail).toBeNull();
  });

  test('a REAL sender is unchanged', async () => {
    const raw = mail('Ruth Bramley <ruth@example.test>', 'Hongyi <office@firm.test>');
    const rec = recorder();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(rec.calls[0].fallbackEmail).toBe('ruth@example.test');
  });

  test('no `to` at all leaves the sender as the key', async () => {
    const raw = body({
      data: {
        message_id: 'no-to-header',
        sender: 'Ruth <ruth@example.test>',
        subject: 'tap',
        message_text: 'still dripping',
      },
    });
    const rec = recorder();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(rec.calls[0].fallbackEmail).toBe('ruth@example.test');
  });
});
