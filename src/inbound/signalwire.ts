import { createHmac, timingSafeEqual } from 'node:crypto';

// SignalWire Compatibility-API (LaML) glue for the inbound phone path. Three jobs:
//   1. validateSignalWireSignature — verify a webhook really came from SignalWire,
//   2. buildVoiceCxml / buildRejectCxml — the cXML our voice webhook returns,
//   3. parseRecordingCallback / parseFormBody — read a recording callback.
// LaML webhooks POST application/x-www-form-urlencoded bodies (NOT JSON).

// Twilio-compatible request validation (SignalWire is 100% LaML-compatible):
// HMAC-SHA1 over [ the full request URL, then every POST param appended as
// key+value in alphabetical key order ], keyed by the SignalWire API TOKEN,
// base64-encoded, compared to the X-SignalWire-Signature header.
// Never throws — returns false on any missing/bad input (fail closed).
//
// RESOLVED live 2026-08-06: the documented Twilio construction is correct AS-IS.
// The one gotcha was query-string ORDER on the recording callback — SignalWire signs
// the recordingStatusCallback URL verbatim but DELIVERS it with the query re-sorted
// alphabetically, so the received URL differed from the signed one and every recording
// callback 403'd. Fix lives at the EMIT side (handleVoiceWebhook builds the callback
// query already alphabetical), so the received URL == the signed URL and this
// reconstruction (base + req.url) matches. %-encoding is preserved as-sent (%2B stays
// %2B); POST-param concatenation in sorted key order is unchanged and verified live.
export function validateSignalWireSignature(
  fullUrl: string,
  params: Record<string, string>,
  signatureHeader: string | undefined,
  token: string,
): boolean {
  if (!signatureHeader || !token) return false;
  let data = fullUrl;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  const expected = createHmac('sha1', token).update(data, 'utf8').digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signatureHeader, 'base64');
  } catch {
    return false;
  }
  // Length-guard before timingSafeEqual (it throws on length mismatch), same idiom
  // as verifyWebhookSignature.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

// Parse an application/x-www-form-urlencoded body into a flat (decoded) map —
// the shape validateSignalWireSignature and parseRecordingCallback consume.
export function parseFormBody(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  return out;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const XML_DECL = '<?xml version="1.0" encoding="UTF-8"?>';
const DEFAULT_CONSENT = 'This call is recorded for quality and service.';

export interface VoiceCxmlInput {
  forwardTo: string | null; // the tenant's call-center line; null → voicemail mode
  recordingCallbackUrl: string; // absolute; tenant/from/to baked into its query
  consentText?: string;
  maxLengthSeconds?: number; // voicemail mode only
}

// The cXML the voice webhook returns: a non-skippable consent <Say> FIRST (it
// gates recording — "gate before the irreversible action"), then either a
// <Dial record> forward to a human (both legs, dual-channel — no voiceprints) or,
// when no forward line is set, a <Record> voicemail. Both fire the
// recordingStatusCallback on 'completed' only.
export function buildVoiceCxml(input: VoiceCxmlInput): string {
  const say = `<Say>${xmlEscape(input.consentText ?? DEFAULT_CONSENT)}</Say>`;
  const cb = xmlEscape(input.recordingCallbackUrl);
  if (input.forwardTo) {
    const dial =
      `<Dial record="record-from-answer-dual" recordingStatusCallback="${cb}"` +
      ` recordingStatusCallbackEvent="completed">${xmlEscape(input.forwardTo)}</Dial>`;
    return `${XML_DECL}<Response>${say}${dial}</Response>`;
  }
  const rec =
    `<Record recordingStatusCallback="${cb}" recordingStatusCallbackEvent="completed"` +
    ` maxLength="${input.maxLengthSeconds ?? 120}" playBeep="true"/>`;
  return `${XML_DECL}<Response>${say}${rec}</Response>`;
}

// Reject the call (unknown number / bad payload) — the caller hears a rejection
// rather than dead air.
export function buildRejectCxml(reason: 'rejected' | 'busy' = 'rejected'): string {
  return `${XML_DECL}<Response><Reject reason="${reason}"/></Response>`;
}

export interface RecordingCallback {
  externalId: string; // RecordingSid — the dedup key
  recordingUrl: string;
  durationSec: number | null;
  callSid: string | null;
  status: string; // RecordingStatus (in-progress | completed | absent)
}

// Read a RecordingStatusCallback body. NOTE: SignalWire does NOT include From/To
// here — those are threaded via the callback URL query (see handleRecordingWebhook).
export function parseRecordingCallback(params: Record<string, string>): RecordingCallback {
  const externalId = params.RecordingSid;
  const status = params.RecordingStatus;
  if (!externalId || !status) {
    throw new Error('signalwire recording callback missing RecordingSid/RecordingStatus');
  }
  const duration = Number(params.RecordingDuration);
  return {
    externalId,
    recordingUrl: params.RecordingUrl ?? '',
    durationSec: Number.isFinite(duration) ? duration : null,
    callSid: params.CallSid ?? null,
    status,
  };
}
