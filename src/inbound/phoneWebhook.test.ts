import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  buildVoiceCxml,
  parseRecordingCallback,
  validateSignalWireSignature,
} from './signalwire.js';
import { handleRecordingWebhook, handleVoiceWebhook, type PhoneWebhookDeps } from './phoneWebhook.js';
import type { EnqueueCallInput } from '../db/callIngest.js';

// Pure/stubbed unit tests — no DB, no network. Signature is verified with a
// self-computed vector; the handlers inject validateSignature/resolve/enqueue so
// routing + status classification are provable without SignalWire or the DB.

const BASE = 'https://spine.example';
let savedBase: string | undefined;
let savedToken: string | undefined;
beforeAll(() => {
  savedBase = process.env.SIGNALWIRE_WEBHOOK_BASE_URL;
  savedToken = process.env.SIGNALWIRE_API_TOKEN;
  process.env.SIGNALWIRE_WEBHOOK_BASE_URL = BASE;
  process.env.SIGNALWIRE_API_TOKEN = 'swtoken';
});
afterAll(() => {
  process.env.SIGNALWIRE_WEBHOOK_BASE_URL = savedBase;
  process.env.SIGNALWIRE_API_TOKEN = savedToken;
});

function form(obj: Record<string, string>): string {
  return new URLSearchParams(obj).toString();
}

function makeDeps(over: Partial<PhoneWebhookDeps> = {}): {
  deps: PhoneWebhookDeps;
  enqueued: EnqueueCallInput[];
} {
  const enqueued: EnqueueCallInput[] = [];
  const deps: PhoneWebhookDeps = {
    validateSignature: () => true,
    resolveTenantByNumber: async () => ({ tenantId: 'T1', forwardTo: '+15559000000' }),
    enqueueCall: async (input) => {
      enqueued.push(input);
      return { id: 'ci1', deduped: false };
    },
    ...over,
  };
  return { deps, enqueued };
}

describe('validateSignalWireSignature', () => {
  const token = 'swtoken';
  const url = `${BASE}/inbound/phone/voice`;
  const params = { From: '+15551234567', To: '+15551230001', CallSid: 'CA1' };
  function sign(u: string, p: Record<string, string>, key: string): string {
    let data = u;
    for (const k of Object.keys(p).sort()) data += k + p[k];
    return createHmac('sha1', key).update(data, 'utf8').digest('base64');
  }

  test('accepts a correctly-signed request', () => {
    expect(validateSignalWireSignature(url, params, sign(url, params, token), token)).toBe(true);
  });
  test('rejects wrong token, tampered params, bad/missing signature', () => {
    const good = sign(url, params, token);
    expect(validateSignalWireSignature(url, params, good, 'wrong')).toBe(false);
    expect(validateSignalWireSignature(url, { ...params, To: '+9999999' }, good, token)).toBe(false);
    expect(validateSignalWireSignature(url, params, 'AAAA', token)).toBe(false);
    expect(validateSignalWireSignature(url, params, undefined, token)).toBe(false);
    expect(validateSignalWireSignature(url, params, good, '')).toBe(false);
  });
});

describe('buildVoiceCxml', () => {
  test('forward mode: consent Say before Dial-record, & escaped in callback', () => {
    const cxml = buildVoiceCxml({
      forwardTo: '+15559000000',
      recordingCallbackUrl: `${BASE}/inbound/phone/recording?tenant=T1&from=%2B1`,
    });
    expect(cxml).toContain('<?xml');
    expect(cxml.indexOf('<Say>')).toBeGreaterThanOrEqual(0);
    expect(cxml.indexOf('<Say>')).toBeLessThan(cxml.indexOf('<Dial'));
    expect(cxml).toContain('record="record-from-answer-dual"');
    expect(cxml).toContain('tenant=T1&amp;from=%2B1'); // raw & would break the XML attribute
    expect(cxml).toContain('>+15559000000</Dial>');
  });
  test('voicemail mode (no forward line): Record, not Dial', () => {
    const cxml = buildVoiceCxml({ forwardTo: null, recordingCallbackUrl: `${BASE}/x` });
    expect(cxml).toContain('<Record');
    expect(cxml).not.toContain('<Dial');
    expect(cxml).toContain('<Say>');
  });
});

describe('parseRecordingCallback', () => {
  test('parses the fields; duration coerced; missing From/To tolerated', () => {
    expect(
      parseRecordingCallback({
        RecordingSid: 'RE1',
        RecordingStatus: 'completed',
        RecordingUrl: 'https://sw/rec.wav',
        RecordingDuration: '42',
        CallSid: 'CA1',
      }),
    ).toEqual({
      externalId: 'RE1',
      recordingUrl: 'https://sw/rec.wav',
      durationSec: 42,
      callSid: 'CA1',
      status: 'completed',
    });
  });
  test('throws when RecordingSid/RecordingStatus absent', () => {
    expect(() => parseRecordingCallback({ RecordingStatus: 'completed' })).toThrow();
    expect(() => parseRecordingCallback({ RecordingSid: 'RE1' })).toThrow();
  });
});

describe('handleVoiceWebhook', () => {
  const url = `${BASE}/inbound/phone/voice`;
  test('valid → ok_forward with tenant/from/to baked into the callback', async () => {
    const { deps } = makeDeps();
    const res = await handleVoiceWebhook(
      { fullUrl: url, rawBody: form({ To: '+15551230001', From: '+15551234567', CallSid: 'CA1' }), signature: 'x' },
      deps,
    );
    expect(res.status).toBe('ok_forward');
    expect(res.cxml).toContain('tenant=T1');
    expect(res.cxml).toContain('from=%2B15551234567');
    expect(res.cxml).toContain('to=%2B15551230001');
  });
  test('no forward line → ok_voicemail', async () => {
    const { deps } = makeDeps({ resolveTenantByNumber: async () => ({ tenantId: 'T1', forwardTo: null }) });
    const res = await handleVoiceWebhook({ fullUrl: url, rawBody: form({ To: '+1', From: '+2' }), signature: 'x' }, deps);
    expect(res.status).toBe('ok_voicemail');
    expect(res.cxml).toContain('<Record');
  });
  test('unknown number → unknown_number + Reject cXML', async () => {
    const { deps } = makeDeps({ resolveTenantByNumber: async () => null });
    const res = await handleVoiceWebhook({ fullUrl: url, rawBody: form({ To: '+404', From: '+2' }), signature: 'x' }, deps);
    expect(res.status).toBe('unknown_number');
    expect(res.cxml).toContain('<Reject');
  });
  test('missing To → bad_payload', async () => {
    const { deps } = makeDeps();
    const res = await handleVoiceWebhook({ fullUrl: url, rawBody: form({ From: '+2' }), signature: 'x' }, deps);
    expect(res.status).toBe('bad_payload');
  });
  test('bad signature → bad_signature (never reaches resolve)', async () => {
    let resolved = false;
    const { deps } = makeDeps({
      validateSignature: () => false,
      resolveTenantByNumber: async () => {
        resolved = true;
        return null;
      },
    });
    const res = await handleVoiceWebhook({ fullUrl: url, rawBody: form({ To: '+1' }), signature: 'bad' }, deps);
    expect(res.status).toBe('bad_signature');
    expect(resolved).toBe(false);
  });
});

describe('handleRecordingWebhook', () => {
  const url = `${BASE}/inbound/phone/recording?tenant=T1&from=%2B1555&to=%2B1666`;
  function recBody(over: Record<string, string> = {}): string {
    return form({
      RecordingSid: 'RE1',
      RecordingUrl: 'https://sw/rec.wav',
      RecordingStatus: 'completed',
      RecordingDuration: '42',
      CallSid: 'CA1',
      ...over,
    });
  }
  const query = { tenant: 'T1', from: '+1555', to: '+1666' };

  test('completed → enqueued, with the right enqueue fields', async () => {
    const { deps, enqueued } = makeDeps();
    const res = await handleRecordingWebhook({ fullUrl: url, rawBody: recBody(), query, signature: 'x' }, deps);
    expect(res.status).toBe('enqueued');
    expect(res.callIngestId).toBe('ci1');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      tenantId: 'T1',
      externalId: 'RE1',
      callerPhone: '+1555',
      callSid: 'CA1',
      audioRef: 'https://sw/rec.wav',
      consentAnnounced: true,
    });
  });
  test('redelivered RecordingSid → duplicate', async () => {
    const { deps } = makeDeps({ enqueueCall: async () => ({ id: 'ci1', deduped: true }) });
    const res = await handleRecordingWebhook({ fullUrl: url, rawBody: recBody(), query, signature: 'x' }, deps);
    expect(res.status).toBe('duplicate');
  });
  test('non-completed status → ignored_status (nothing enqueued)', async () => {
    const { deps, enqueued } = makeDeps();
    const res = await handleRecordingWebhook(
      { fullUrl: url, rawBody: recBody({ RecordingStatus: 'in-progress' }), query, signature: 'x' },
      deps,
    );
    expect(res.status).toBe('ignored_status');
    expect(enqueued).toHaveLength(0);
  });
  test('missing tenant in query → bad_payload', async () => {
    const { deps } = makeDeps();
    const res = await handleRecordingWebhook({ fullUrl: url, rawBody: recBody(), query: {}, signature: 'x' }, deps);
    expect(res.status).toBe('bad_payload');
  });
  test('missing RecordingSid → bad_payload', async () => {
    const { deps } = makeDeps();
    const res = await handleRecordingWebhook(
      { fullUrl: url, rawBody: form({ RecordingStatus: 'completed' }), query, signature: 'x' },
      deps,
    );
    expect(res.status).toBe('bad_payload');
  });
  test('bad signature → bad_signature', async () => {
    const { deps } = makeDeps({ validateSignature: () => false });
    const res = await handleRecordingWebhook({ fullUrl: url, rawBody: recBody(), query, signature: 'bad' }, deps);
    expect(res.status).toBe('bad_signature');
  });
  test('enqueue throws → transient_error', async () => {
    const { deps } = makeDeps({
      enqueueCall: async () => {
        throw new Error('db down');
      },
    });
    const res = await handleRecordingWebhook({ fullUrl: url, rawBody: recBody(), query, signature: 'x' }, deps);
    expect(res.status).toBe('transient_error');
  });
});

// Regression lock for the live 2026-08-06 recording-callback 403. SignalWire signs
// the recordingStatusCallback URL verbatim as emitted, but DELIVERS it with the query
// re-sorted alphabetically; if the emitted order isn't already alphabetical, the
// received bytes differ from the signed bytes and every recording callback 403s.
// The fix emits the query pre-sorted (from, tenant, to). These tests fail loudly if
// that order is ever broken again.
describe('recording-callback query order survives SignalWire alphabetical reorder', () => {
  function sign(u: string, p: Record<string, string>, key: string): string {
    let data = u;
    for (const k of Object.keys(p).sort()) data += k + p[k];
    return createHmac('sha1', key).update(data, 'utf8').digest('base64');
  }
  // Mimic SignalWire's delivery: re-sort the query params alphabetically by key,
  // preserving exact byte encoding of each key=value pair.
  function deliverSorted(u: string): string {
    const i = u.indexOf('?');
    if (i < 0) return u;
    const pairs = u
      .slice(i + 1)
      .split('&')
      .sort((a, b) => (a.split('=')[0] < b.split('=')[0] ? -1 : 1));
    return u.slice(0, i) + '?' + pairs.join('&');
  }

  test('emitted alphabetical + validates after reorder; a non-alphabetical emit would 403', async () => {
    const { deps } = makeDeps({
      resolveTenantByNumber: async () => ({ tenantId: 'T-abc', forwardTo: '+15551230000' }),
    });
    const { status, cxml } = await handleVoiceWebhook(
      {
        fullUrl: `${BASE}/inbound/phone/voice`,
        rawBody: form({ To: '+15550000001', From: '+15550000002' }),
        signature: 'x',
      },
      deps,
    );
    expect(status).toBe('ok_forward');

    const m = /recordingStatusCallback="([^"]*)"/.exec(cxml);
    expect(m).toBeTruthy();
    const cbUrl = m![1].replace(/&amp;/g, '&'); // undo the XML-attribute escaping

    // 1) emitted in alphabetical key order (from, tenant, to)
    const q = cbUrl.slice(cbUrl.indexOf('?') + 1);
    expect(q.split('&').map((kv) => kv.split('=')[0])).toEqual(['from', 'tenant', 'to']);

    // 2) round-trip: SignalWire signs as-emitted, delivers query re-sorted → must still pass
    const token = process.env.SIGNALWIRE_API_TOKEN!;
    const recParams = { RecordingSid: 'RE1', RecordingStatus: 'completed' };
    const sig = sign(cbUrl, recParams, token);
    expect(validateSignalWireSignature(deliverSorted(cbUrl), recParams, sig, token)).toBe(true);

    // 3) proof the check is real: a NON-alphabetical emit, once delivered re-sorted,
    //    changes the bytes → signature no longer matches → 403 (the original bug).
    const nonAlpha = `${BASE}/inbound/phone/recording?tenant=T-abc&from=%2B15550000002&to=%2B15550000001`;
    const badSig = sign(nonAlpha, recParams, token);
    expect(validateSignalWireSignature(deliverSorted(nonAlpha), recParams, badSig, token)).toBe(false);
  });
});
