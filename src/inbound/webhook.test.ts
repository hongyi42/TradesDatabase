import { afterAll, beforeAll, describe, expect, test } from 'vitest';
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
  const fn: WorkClassifier = async (email) => {
    calls.push(email);
    return { isWork, reason: 'stub' };
  };
  return { calls, fn };
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
