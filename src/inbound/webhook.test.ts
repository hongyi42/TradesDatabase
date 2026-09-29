import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  handleInboundWebhook,
  verifyWebhookSignature,
  type InboundWebhookDeps,
  type WebhookHeaders,
} from './webhook.js';
import type { RecordFieldNoteInput, RecordFieldNoteResult } from '../writePath/recordFieldNote.js';
import type { DroppedAuditInput, Observation, Technician } from '../db/index.js';
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

// Recording stub for the unknown-ref observation.
function flagRecorder() {
  const calls: Array<{ tenantId: string; ref: string; captureId: string | null }> = [];
  const fn = async (input: {
    tenantId: string;
    ref: string;
    captureId: string | null;
  }): Promise<Observation | null> => {
    calls.push(input);
    return { id: 'obs-1' } as Observation;
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
    findCaptureByExternalId: async () => null,
    hasLinkedL2: async () => false,
    // Step 2e phase 4: never Composio, never the DB.
    keepAttachments: async () => [],
    issuedNumberNamed: async () => false,
    raiseOutboundInvoice: async () => null,
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

  test('unknown ref → ingested AND raised for the planner (keep the mail, never lose it)', async () => {
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
    expect(flag.calls[0]).toEqual({ tenantId: TENANT, ref: 'tech-test', captureId: 'cap-1' });
  });

  test('unknown ref + duplicate redelivery → NOT re-raised', async () => {
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
          throw new Error('observations unavailable');
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
    // Personal mail never reaches L1, so there is no capture to point at.
    expect(flag.calls[0]).toEqual({ tenantId: TENANT, ref: 'tech-test', captureId: null });
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

// RUNG 10B.3 — THE FIRM'S OWN HALF OF THE CONVERSATION. Before this the trigger
// watched INBOX only, so a manager replying from Gmail directly was never
// captured: not filtered, not dropped, never delivered. A job's correspondence
// was one-sided and a promise typed by hand bound the firm with the spine
// unaware.
describe("the firm's own replies reach the record, gated (rung 10b.3)", () => {
  let prevSecret: string | undefined;
  beforeAll(() => {
    prevSecret = process.env.COMPOSIO_WEBHOOK_SECRET;
    process.env.COMPOSIO_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.COMPOSIO_WEBHOOK_SECRET;
    else process.env.COMPOSIO_WEBHOOK_SECRET = prevSecret;
  });

  const sentMail = (over: Record<string, unknown> = {}) =>
    body({
      data: {
        message_id: 'gmail-sent-1',
        sender: 'Office <office@firm.test>',
        to: 'Iris Calloway <iris@homeowner.test>',
        subject: 'Re: Radiator not heating upstairs',
        message_text: "Thursday works — we'll come out then.",
        message_timestamp: '2026-09-09T17:00:00.000Z',
        thread_id: 'thread-radiator',
        label_ids: ['SENT'],
        ...over,
      },
    });

  test('a SENT message lands as outbound_email, keyed on WHO IT WENT TO', async () => {
    const raw = sentMail();
    const rec = recorder();
    const r = await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(r.status).toBe('ingested');
    expect(rec.calls[0].channel).toBe('outbound_email');
    // Keyed in the outbound namespace — the same key send_email and logIngest
    // write under, so one email can only ever be one L1 row.
    expect(rec.calls[0].externalId).toBe('sent:gmail-sent-1');
    // The sender is US, so the address worth matching on is the recipient's.
    expect(rec.calls[0].fallbackEmail).toBe('iris@homeowner.test');
    expect(rec.calls[0].threadId).toBe('thread-radiator');
  });

  test('two recipients name neither — unique-or-nothing, like every other key', async () => {
    const raw = sentMail({
      message_id: 'gmail-sent-2',
      to: 'iris@homeowner.test, landlord@example.test',
    });
    const rec = recorder();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(rec.calls[0].fallbackEmail).toBeNull();
  });

  // THE USER'S RULING, 2026-09-09. L1 has no delete, so a manager's dentist
  // appointment must never be written; the classifier is the only thing standing
  // between the two. This is NOT the 2026-07-04 agent-send exception, which
  // covers actions the AGENT performed, not a human's own outbound mail.
  test('a PERSONAL message from the same mailbox is dropped with a receipt, never written', async () => {
    const raw = sentMail({
      message_id: 'gmail-sent-personal',
      to: 'dentist@clinic.test',
      subject: 'Appointment Thursday',
      message_text: 'confirming my 3pm cleaning',
    });
    const rec = recorder();
    const drops = dropRecorder();
    const r = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({ recordFieldNote: rec.fn, classify: classifyStub(false).fn, recordDrop: drops.fn }),
    );
    expect(r.status).toBe('skipped_non_work');
    expect(rec.calls).toHaveLength(0); // nothing reached L1 — this is the whole point
    expect(drops.calls[0]).toMatchObject({
      channel: 'outbound_email',
      externalId: 'sent:gmail-sent-personal',
      // The RECIPIENT, not the sender: the receipt keeps a domain only, and on
      // the firm's own mail the sender's domain is our own on every single drop.
      from: 'dentist@clinic.test',
    });
  });

  test('the classifier is TOLD the direction, and shown who it went to', async () => {
    // The sender is always the firm on a SENT message, so judging by sender is
    // judging nothing — and "unsure → not work" would drop the firm's own
    // short promises, which is the exact case this rung exists for.
    const raw = sentMail({ message_id: 'gmail-sent-direction' });
    const cls = classifyStub(true);
    await handleInboundWebhook(raw, sign(raw), baseDeps({ classify: cls.fn }));
    expect(cls.calls[0]).toMatchObject({
      outbound: true,
      to: 'Iris Calloway <iris@homeowner.test>',
    });
    // An ordinary inbound email makes no such claim.
    const inbound = body();
    const cls2 = classifyStub(true);
    await handleInboundWebhook(inbound, sign(inbound), baseDeps({ classify: cls2.fn }));
    expect(cls2.calls[0].outbound).toBeUndefined();
  });

  test('the classifier reads the CLEAN body, not the stored header form', async () => {
    const raw = sentMail({ message_id: 'gmail-sent-3' });
    const cls = classifyStub(true);
    await handleInboundWebhook(raw, sign(raw), baseDeps({ classify: cls.fn }));
    expect(cls.calls[0].body).toBe("Thursday works — we'll come out then.");
    expect(cls.calls[0].body).not.toContain('Subject:');
  });

  describe("the assistant's own send, coming back", () => {
    test("the AGENT's own send row is a duplicate — nothing written, nothing classified", async () => {
      const raw = sentMail({ message_id: 'gmail-sent-twin' });
      const rec = recorder();
      const cls = classifyStub(true);
      const looked: string[] = [];
      const r = await handleInboundWebhook(
        raw,
        sign(raw),
        baseDeps({
          recordFieldNote: rec.fn,
          classify: cls.fn,
          findCaptureByExternalId: async (_t: string, externalId: string) => {
            looked.push(externalId);
            // `sentVia` is send_email's own stamp — the PRODUCER, which is what
            // tells this row apart from one an earlier delivery wrote.
            return { id: 'cap-outbound-1', metadata: { sentVia: 'GMAIL_SEND_EMAIL' } } as never;
          },
        }),
      );
      expect(r).toEqual({ status: 'duplicate', captureId: 'cap-outbound-1' });
      expect(rec.calls).toHaveLength(0);
      // BEFORE the classifier: no model call for a message we already hold.
      expect(cls.calls).toHaveLength(0);
      // ONE key, three writers: the normalizer already put this delivery in the
      // outbound namespace, so the lookup is simply "do we hold this row".
      expect(looked).toEqual(['sent:gmail-sent-twin']);
    });

    test("logIngest's row counts too — it stamps toolSlug, not sentVia", async () => {
      const raw = sentMail({ message_id: 'gmail-sent-logingest' });
      const rec = recorder();
      const r = await handleInboundWebhook(
        raw,
        sign(raw),
        baseDeps({
          recordFieldNote: rec.fn,
          findCaptureByExternalId: async () =>
            ({ id: 'cap-log-1', metadata: { toolSlug: 'GMAIL_SEND_EMAIL' } }) as never,
        }),
      );
      expect(r).toEqual({ status: 'duplicate', captureId: 'cap-log-1' });
      expect(rec.calls).toHaveLength(0);
    });

    // THE REGRESSION THIS GUARDS. One key for all three writers means the
    // lookup can return OUR OWN half-finished delivery. Returning 'duplicate'
    // there would be permanent: an append that landed and then threw before the
    // job link redelivers as a 503, and the door would never run again — the
    // promise never reaching the job, with no later delivery able to fix it.
    test('an ORPHAN of our own earlier delivery falls through and heals', async () => {
      const raw = sentMail({ message_id: 'gmail-sent-orphan' });
      const rec = recorder();
      const r = await handleInboundWebhook(
        raw,
        sign(raw),
        baseDeps({
          recordFieldNote: rec.fn,
          // Written by the TRIGGER (headers, no producer stamp) and never
          // linked to anything.
          findCaptureByExternalId: async () =>
            ({ id: 'cap-orphan-1', metadata: { from: 'office@firm.test', subject: 'Re' } }) as never,
          hasLinkedL2: async () => false,
        }),
      );
      expect(r.status).toBe('ingested');
      expect(rec.calls).toHaveLength(1);
    });

    test("A SENT REPLY IS NEVER SHOWN TO ITSELF — the storage key is not Gmail's id", async () => {
      // THE REGRESSION THIS GUARDS. An outbound delivery is stored as
      // `sent:<id>` while Composio's thread fetch names the BARE id, so a
      // comparison against externalId can never match. The firm's own reply
      // would land in its own "EARLIER IN THIS CONVERSATION" block, where the
      // extractor is told a commitment "is already handled" — visitCommitted
      // suppressed, no ask raised, a promise nobody hears.
      const raw = sentMail({ message_id: 'gmail-sent-self', thread_id: 'thread-radiator' });
      const rec = recorder();
      const earlierOnly = [
        {
          messageId: 'gmail-msg-1',
          from: 'iris@homeowner.test',
          to: 'office@firm.test',
          subject: 'Radiator',
          body: 'still cold upstairs',
          at: '2026-09-08T10:00:00.000Z',
        },
      ];
      const fetchThread = vi.fn(async () => [
        ...earlierOnly,
        // The message being read, as Gmail hands it back — bare id.
        {
          messageId: 'gmail-sent-self',
          from: 'office@firm.test',
          to: null,
          subject: null,
          body: "Thursday works — we'll come out then.",
          at: null,
        },
      ]);
      await handleInboundWebhook(
        raw,
        sign(raw),
        baseDeps({
          recordFieldNote: rec.fn,
          getTechnician: async () => techRow({ composio_connected_account_id: 'ca_test' }),
          fetchThread,
        }),
      );
      expect(rec.calls[0].threadContext).toEqual(earlierOnly);
    });

    test('a RETRACTED reply of ours is filtered whichever spelling the block holds', async () => {
      // blockedMessageIds are L1 `external_id`s, so an outbound row contributes
      // the `sent:` form while the fetched thread names the bare one.
      const raw = sentMail({ message_id: 'gmail-sent-blocked', thread_id: 'thread-radiator' });
      const rec = recorder();
      await handleInboundWebhook(
        raw,
        sign(raw),
        baseDeps({
          recordFieldNote: rec.fn,
          getTechnician: async () => techRow({ composio_connected_account_id: 'ca_test' }),
          fetchThread: async () => [
            {
              messageId: 'gmail-retracted',
              from: 'office@firm.test',
              to: null,
              subject: null,
              body: 'ignore that last one',
              at: null,
            },
          ],
          listThreadCaptures: async () => ({
            messages: [],
            blockedMessageIds: ['sent:gmail-retracted'],
          }),
        }),
      );
      expect(rec.calls[0]).not.toHaveProperty('threadContext');
    });

    test('THE L1-FALLBACK PATH excludes the message from itself too', async () => {
      // The other half of "never show the message to itself", and the one that
      // runs on the pilot TODAY: with no connected account the Composio fetch is
      // skipped and our own captures are the thread. `listCapturesByThread`
      // names a message by its L1 `external_id` — the `sent:` form for an
      // outbound row — while Gmail names it bare, so one spelling is not enough.
      // Reached exactly where R2-1's healing redelivery sends us.
      const raw = sentMail({ message_id: 'gmail-sent-l1self', thread_id: 'thread-radiator' });
      const rec = recorder();
      await handleInboundWebhook(
        raw,
        sign(raw),
        baseDeps({
          recordFieldNote: rec.fn,
          // No paired account → `fetched` is null → our own captures are used.
          getTechnician: async () => techRow(),
          listThreadCaptures: async () => ({
            messages: [
              {
                messageId: 'sent:gmail-sent-l1self', // the row THIS delivery appended
                from: 'office@firm.test',
                to: null,
                subject: null,
                body: "Thursday works — we'll come out then.",
                at: null,
              },
            ],
            blockedMessageIds: [],
          }),
        }),
      );
      // Shown to itself, the extractor is told the commitment is "already
      // handled" — visitCommitted suppressed, and neither ask ever fires.
      expect(rec.calls[0]).not.toHaveProperty('threadContext');
    });

    test('…but once it IS linked, the door does not run again', async () => {
      const raw = sentMail({ message_id: 'gmail-sent-done' });
      const rec = recorder();
      const r = await handleInboundWebhook(
        raw,
        sign(raw),
        baseDeps({
          recordFieldNote: rec.fn,
          findCaptureByExternalId: async () => ({ id: 'cap-done-1', metadata: {} }) as never,
          hasLinkedL2: async () => true,
        }),
      );
      expect(r).toEqual({ status: 'duplicate', captureId: 'cap-done-1' });
      expect(rec.calls).toHaveLength(0);
    });

    test('with no twin it ingests normally', async () => {
      const raw = sentMail({ message_id: 'gmail-sent-notwin' });
      const rec = recorder();
      const r = await handleInboundWebhook(
        raw,
        sign(raw),
        baseDeps({ recordFieldNote: rec.fn, findCaptureByExternalId: async () => null }),
      );
      expect(r.status).toBe('ingested');
      expect(rec.calls).toHaveLength(1);
    });

    test('an INBOUND message never pays for the twin lookup', async () => {
      // The `sent:` prefix is minted only by outbound paths, so asking on every
      // inbound email would be a read per message for an answer that is always no.
      const raw = body();
      let asked = 0;
      await handleInboundWebhook(
        raw,
        sign(raw),
        baseDeps({
          findCaptureByExternalId: async () => {
            asked += 1;
            return null;
          },
        }),
      );
      expect(asked).toBe(0);
    });
  });
});

// RUNG 10B.4 — THE REAL DOOR THE FIRM'S REPLIES COME THROUGH. The tests above
// drive GMAIL_NEW_GMAIL_MESSAGE with a SENT label, which is a message the
// mailbox sent to ITSELF (Gmail puts both labels on those, so the received
// trigger does deliver them). An ordinary reply to a customer arrives on a
// different trigger entirely, and it is that one the manager's own mail uses.
describe('the SENT trigger reaches the same door (rung 10b.4)', () => {
  let prevSecret: string | undefined;
  beforeAll(() => {
    prevSecret = process.env.COMPOSIO_WEBHOOK_SECRET;
    process.env.COMPOSIO_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.COMPOSIO_WEBHOOK_SECRET;
    else process.env.COMPOSIO_WEBHOOK_SECRET = prevSecret;
  });

  const sentTrigger = (over: Record<string, unknown> = {}) =>
    body({
      metadata: { user_id: `${TENANT}:tech-test`, trigger_slug: 'GMAIL_EMAIL_SENT_TRIGGER' },
      data: {
        message_id: 'gmail-real-sent-1',
        sender: 'Office <office@firm.test>',
        subject: 'Re: Radiator not heating upstairs',
        message_text: "Thursday works — we'll come out then.",
        message_timestamp: '2026-09-10T00:13:33.000Z',
        thread_id: 'thread-radiator',
        to: 'Iris <iris@homeowner.test>',
        recipients: 'iris@homeowner.test',
        ...over,
      },
    });

  test('it routes, lands as outbound_email, and keys on WHO IT WENT TO', async () => {
    const raw = sentTrigger();
    const rec = recorder();
    const r = await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(r.status).toBe('ingested'); // NOT 'unrouted' — the registry knows this slug
    expect(rec.calls[0].channel).toBe('outbound_email');
    expect(rec.calls[0].externalId).toBe('sent:gmail-real-sent-1');
    expect(rec.calls[0].fallbackEmail).toBe('iris@homeowner.test');
    expect(rec.calls[0].threadId).toBe('thread-radiator');
  });

  test('the classifier is told the direction and shown the recipient', async () => {
    const raw = sentTrigger({ message_id: 'gmail-real-sent-2' });
    const cls = classifyStub(true);
    await handleInboundWebhook(raw, sign(raw), baseDeps({ classify: cls.fn }));
    expect(cls.calls[0]).toMatchObject({ outbound: true, to: 'Iris <iris@homeowner.test>' });
  });

  test('a PERSONAL one is dropped with a receipt, and never written', async () => {
    const raw = sentTrigger({
      message_id: 'gmail-real-sent-personal',
      to: 'dentist@clinic.test',
      subject: 'Appointment Thursday',
      message_text: 'confirming my 3pm cleaning',
    });
    const rec = recorder();
    const drops = dropRecorder();
    const r = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({ recordFieldNote: rec.fn, classify: classifyStub(false).fn, recordDrop: drops.fn }),
    );
    expect(r.status).toBe('skipped_non_work');
    expect(rec.calls).toHaveLength(0);
    expect(drops.calls[0]).toMatchObject({
      channel: 'outbound_email',
      externalId: 'sent:gmail-real-sent-personal',
      from: 'dentist@clinic.test', // the RECIPIENT — our own domain says nothing
    });
  });

  test("the agent's own send of the same message is recognised, not appended twice", async () => {
    const raw = sentTrigger({ message_id: 'gmail-real-sent-twin' });
    const rec = recorder();
    const cls = classifyStub(true);
    const r = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        classify: cls.fn,
        findCaptureByExternalId: async () =>
          ({ id: 'cap-sent-1', metadata: { sentVia: 'GMAIL_SEND_EMAIL' } }) as never,
      }),
    );
    expect(r).toEqual({ status: 'duplicate', captureId: 'cap-sent-1' });
    expect(cls.calls).toHaveLength(0); // before the classifier — no model call
  });

  // RUNG 10B.4 REVIEW — the whole outbound door keys off `to`, and the trigger's
  // own DESCRIPTION lists "sender, recipients, subject, timestamp, thread ID"
  // without it. If it ever comes back empty, every outbound message would be
  // unmatched, silently.
  test('an empty `to` falls back to `recipients` rather than losing the key', async () => {
    const raw = sentTrigger({ message_id: 'gmail-real-sent-noto', to: '', recipients: 'iris@homeowner.test' });
    const rec = recorder();
    const cls = classifyStub(true);
    await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn, classify: cls.fn }));
    expect(rec.calls[0].fallbackEmail).toBe('iris@homeowner.test');
    // …and the classifier is shown a real recipient, never a blank To: line.
    expect(cls.calls[0].to).toBe('iris@homeowner.test');
  });

  test('…but a fallback with TWO recipients still names neither', async () => {
    const raw = sentTrigger({
      message_id: 'gmail-real-sent-multi',
      to: '',
      recipients: 'iris@homeowner.test, landlord@example.test',
    });
    const rec = recorder();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(rec.calls[0].fallbackEmail).toBeNull();
  });

  test('WHO ACTUALLY RECEIVED IT reaches L1 — the door keys on one, the record keeps all', async () => {
    // L1 is append-only: a field not written here can never be recovered, and a
    // Cc'd landlord is exactly what somebody asks about later.
    const raw = sentTrigger({
      message_id: 'gmail-real-sent-cc',
      recipients: 'iris@homeowner.test, landlord@example.test',
      cc: 'landlord@example.test',
      bcc: 'bookkeeping@firm.test',
    });
    const rec = recorder();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ recordFieldNote: rec.fn }));
    expect(rec.calls[0].sourceMeta).toMatchObject({
      to: 'Iris <iris@homeowner.test>',
      recipients: 'iris@homeowner.test, landlord@example.test',
      cc: 'landlord@example.test',
      bcc: 'bookkeeping@firm.test',
    });
    // Still keyed on the single To address — a Bcc must not make it ambiguous.
    expect(rec.calls[0].fallbackEmail).toBe('iris@homeowner.test');
  });

  test('an OFFBOARDED mailbox drops it naming the recipient, not our own domain', async () => {
    const raw = sentTrigger({ message_id: 'gmail-real-sent-offboarded' });
    const drops = dropRecorder();
    const rec = recorder();
    const r = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        recordFieldNote: rec.fn,
        recordDrop: drops.fn,
        getTechnician: async () => techRow({ state: 'offboarded' }),
      }),
    );
    expect(r.status).toBe('skipped_offboarded');
    expect(rec.calls).toHaveLength(0);
    expect(drops.calls[0]).toMatchObject({ from: 'Iris <iris@homeowner.test>' });
  });

  test('a slug we have no normalizer for is unrouted, never guessed at', async () => {
    const raw = body({
      metadata: { user_id: `${TENANT}:tech-test`, trigger_slug: 'GMAIL_SOMETHING_NEW' },
    });
    const r = await handleInboundWebhook(raw, sign(raw), baseDeps());
    expect(r.status).toBe('unrouted');
  });
});

describe("the manager's own sent invoices (step 2e phase 4)", () => {
  let prevSecret: string | undefined;
  beforeAll(() => {
    prevSecret = process.env.COMPOSIO_WEBHOOK_SECRET;
    process.env.COMPOSIO_WEBHOOK_SECRET = SECRET;
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.COMPOSIO_WEBHOOK_SECRET;
    else process.env.COMPOSIO_WEBHOOK_SECRET = prevSecret;
  });

  const invoiceMail = (over: Record<string, unknown> = {}) =>
    body({
      metadata: { user_id: `${TENANT}:mgr-sam`, trigger_slug: 'GMAIL_EMAIL_SENT_TRIGGER' },
      data: {
        message_id: 'gmail-inv-1',
        sender: 'Sam <sam@firm.test>',
        subject: 'Your bathroom job',
        message_text: 'Hi Lee, attached is the bill for the work. $450 due in 30 days.',
        message_timestamp: '2026-09-29T17:00:00.000Z',
        to: 'Lee <lee@homeowner.test>',
        attachment_list: [{ attachmentId: 'att-9', filename: 'Invoice-2231.pdf', mimeType: 'application/pdf', size: 4000 }],
        ...over,
      },
    });
  const manager = techRow({ id: 'mgr-row', ref: 'mgr-sam', tier: 'manager', composio_connected_account_id: 'ca_sam' });

  function spies() {
    const raised: unknown[] = [];
    const kept: Array<Record<string, unknown>> = [];
    const numberChecks: string[] = [];
    const fileChecks: string[][] = [];
    return {
      raised,
      kept,
      numberChecks,
      fileChecks,
      deps: {
        getTechnician: async () => manager,
        recordFieldNote: recorder({ status: 'matched', captureId: 'cap-inv', customerId: 'cust-lee', jobId: 'job-bath' }).fn,
        raiseOutboundInvoice: async (input: unknown) => {
          raised.push(input);
          return null;
        },
        issuedNumberNamed: async (_t: string, text: string, fileNames: string[] = []) => {
          numberChecks.push(text);
          fileChecks.push(fileNames);
          return false;
        },
        keepAttachments: async (input: Record<string, unknown>) => {
          kept.push(input);
          return [];
        },
      } satisfies InboundWebhookDeps,
    };
  }
  const tick = () => new Promise((r) => setImmediate(r));

  test("a manager's invoice email raises ONE outbound_invoice, with the context the office reads", async () => {
    const raw = invoiceMail();
    const s = spies();
    const r = await handleInboundWebhook(raw, sign(raw), baseDeps(s.deps));
    expect(r).toEqual({ status: 'ingested', captureId: 'cap-inv' });
    expect(s.raised).toEqual([
      {
        tenantId: TENANT,
        captureId: 'cap-inv',
        customerId: 'cust-lee',
        jobId: 'job-bath',
        sentTo: 'lee@homeowner.test',
        technicianRef: 'mgr-sam',
        senderName: 'Tech Test',
        words: 'Subject: Your bathroom job\n\nHi Lee, attached is the bill for the work. $450 due in 30 days.',
        attachments: [{ name: 'Invoice-2231.pdf', mime: 'application/pdf' }],
      },
    ]);
    // The number check reads the same words — and the attachments' names,
    // since an invoice's number is often only in its file name.
    expect(s.numberChecks).toHaveLength(1);
    expect(s.fileChecks).toEqual([['Invoice-2231.pdf']]);
  });

  test('the word "invoice" alone is enough; L1 keeps only name, type and size of a file', async () => {
    const raw = invoiceMail({ attachment_list: [], subject: 'Invoice for the bathroom' });
    const s = spies();
    const rec = recorder({ captureId: 'cap-inv' });
    await handleInboundWebhook(raw, sign(raw), baseDeps({ ...s.deps, recordFieldNote: rec.fn }));
    expect(s.raised).toHaveLength(1);
    const withFile = invoiceMail({ message_id: 'gmail-inv-meta' });
    const rec2 = recorder({ captureId: 'cap-meta' });
    await handleInboundWebhook(withFile, sign(withFile), baseDeps({ ...s.deps, recordFieldNote: rec2.fn }));
    expect((rec2.calls[0].sourceMeta as Record<string, unknown>).attachments).toEqual([
      { name: 'Invoice-2231.pdf', mime: 'application/pdf', size: 4000 },
    ]);
  });

  test("a TECHNICIAN's sent email raises nothing and keeps no files — only a manager's sent work email", async () => {
    const raw = invoiceMail();
    const s = spies();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ ...s.deps, getTechnician: async () => ({ ...manager, tier: 'technician' }) }));
    await tick();
    expect(s.raised).toHaveLength(0);
    expect(s.kept).toHaveLength(0);
  });

  test('a PENDING-VERIFICATION manager raises nothing and keeps no files (they would carry no pairing stamp)', async () => {
    const raw = invoiceMail();
    const s = spies();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ ...s.deps, getTechnician: async () => ({ ...manager, state: 'pending_verification' }) }));
    await tick();
    expect(s.raised).toHaveLength(0);
    expect(s.kept).toHaveLength(0);
  });

  test('a seam that throws SYNCHRONOUSLY is caught — it cannot escape the detached run', async () => {
    const raw = invoiceMail();
    const s = spies();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        ...s.deps,
        keepAttachments: (() => {
          throw new Error('sync boom');
        }) as unknown as NonNullable<InboundWebhookDeps['keepAttachments']>,
      }),
    );
    await tick();
    await tick();
    expect(r.status).toBe('ingested');
    expect(err.mock.calls.some((c) => String(c[0]).includes('sync boom'))).toBe(true);
    err.mockRestore();
  });

  test('a non-invoice (no PDF, no "invoice") raises nothing', async () => {
    const raw = invoiceMail({
      subject: 'Thursday',
      message_text: 'See you Thursday.',
      attachment_list: [{ attachmentId: 'p', filename: 'site.jpg', mimeType: 'image/jpeg' }],
    });
    const s = spies();
    await handleInboundWebhook(raw, sign(raw), baseDeps(s.deps));
    expect(s.raised).toHaveLength(0);
  });

  test('a duplicate delivery raises nothing and keeps nothing', async () => {
    const raw = invoiceMail();
    const s = spies();
    await handleInboundWebhook(raw, sign(raw), baseDeps({ ...s.deps, recordFieldNote: recorder({ status: 'duplicate' }).fn }));
    await tick();
    expect(s.raised).toHaveLength(0);
    expect(s.kept).toHaveLength(0);
  });

  test("the agent's own send coming back raises nothing and keeps nothing", async () => {
    const raw = invoiceMail();
    const s = spies();
    const r = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        ...s.deps,
        findCaptureByExternalId: async () => ({ id: 'cap-agent', metadata: { sentVia: 'GMAIL_SEND_EMAIL' } }) as never,
      }),
    );
    await tick();
    expect(r.status).toBe('duplicate');
    expect(s.raised).toHaveLength(0);
    expect(s.kept).toHaveLength(0);
  });

  test('one naming a number the firm already issued raises nothing', async () => {
    const raw = invoiceMail({ subject: 'INV-1004 for the bathroom' });
    const s = spies();
    const seen: string[] = [];
    await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        ...s.deps,
        issuedNumberNamed: async (_t, text) => {
          seen.push(text);
          return text.includes('INV-1004');
        },
      }),
    );
    expect(seen[0]).toContain('INV-1004');
    expect(s.raised).toHaveLength(0);
  });

  test('a failed ask is advisory — the email still lands as ingested', async () => {
    const raw = invoiceMail();
    const s = spies();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({ ...s.deps, raiseOutboundInvoice: async () => { throw new Error('db down'); } }),
    );
    err.mockRestore();
    expect(r.status).toBe('ingested');
  });

  test('the attachments run through the seam, and only AFTER the handler has answered', async () => {
    const raw = invoiceMail();
    const s = spies();
    let release: () => void = () => {};
    const blocked = new Promise<void>((r) => { release = r; });
    const r = await handleInboundWebhook(
      raw,
      sign(raw),
      baseDeps({
        ...s.deps,
        keepAttachments: async (input) => {
          s.kept.push(input as unknown as Record<string, unknown>);
          await blocked; // a slow Gmail must not hold the response
          return [];
        },
      }),
    );
    // Answered, and the fetch has not even started yet.
    expect(r.status).toBe('ingested');
    expect(s.kept).toHaveLength(0);
    await tick();
    expect(s.kept).toEqual([
      {
        tenantId: TENANT,
        tech: manager,
        messageId: 'gmail-inv-1', // Gmail's own id, not the sent: storage key
        attachments: [{ attachmentId: 'att-9', name: 'Invoice-2231.pdf', mime: 'application/pdf', size: 4000 }],
        target: { jobId: 'job-bath', customerId: 'cust-lee' },
      },
    ]);
    release();
  });
});
