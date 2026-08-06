import { enqueueCall as liveEnqueueCall, resolveTenantByNumber as liveResolveTenantByNumber } from '../db/index.js';
import type { EnqueueCallInput } from '../db/callIngest.js';
import {
  buildRejectCxml,
  buildVoiceCxml,
  parseFormBody,
  parseRecordingCallback,
  validateSignalWireSignature,
  type RecordingCallback,
} from './signalwire.js';

// The two SignalWire phone webhooks. Both authenticate with validateRequest over
// X-SignalWire-Signature (not the gateway identity header — SignalWire posts from
// the public internet) and do NO STT / write-path on the request thread. Deps are
// injectable so tests exercise the flow with fakes.

export type VoiceStatus = 'ok_forward' | 'ok_voicemail' | 'unknown_number' | 'bad_signature' | 'bad_payload';
export type RecordingStatus =
  | 'enqueued'
  | 'duplicate'
  | 'unknown_number'
  | 'bad_signature'
  | 'bad_payload'
  | 'ignored_status'
  | 'transient_error';

export interface PhoneWebhookDeps {
  resolveTenantByNumber: (n: string) => Promise<{ tenantId: string; forwardTo: string | null } | null>;
  enqueueCall: (input: EnqueueCallInput) => Promise<{ id: string; deduped: boolean }>;
  validateSignature: (
    fullUrl: string,
    params: Record<string, string>,
    signature: string | undefined,
    token: string,
  ) => boolean;
}

const liveDeps: PhoneWebhookDeps = {
  resolveTenantByNumber: liveResolveTenantByNumber,
  enqueueCall: liveEnqueueCall,
  validateSignature: validateSignalWireSignature,
};

// Webhook 1 — the number's "when a call comes in" handler. Validates, resolves
// the tenant from the dialed number, and returns cXML that plays consent then
// forwards+records. The recording callback URL carries tenant/from/to (the
// recording callback won't include From/To itself).
export async function handleVoiceWebhook(
  input: { fullUrl: string; rawBody: string; signature?: string },
  deps: PhoneWebhookDeps = liveDeps,
): Promise<{ status: VoiceStatus; cxml: string }> {
  const params = parseFormBody(input.rawBody);
  const token = process.env.SIGNALWIRE_API_TOKEN ?? '';
  if (!deps.validateSignature(input.fullUrl, params, input.signature, token)) {
    return { status: 'bad_signature', cxml: buildRejectCxml() };
  }
  const to = params.To;
  if (!to) return { status: 'bad_payload', cxml: buildRejectCxml() };
  const from = params.From ?? '';
  const tenant = await deps.resolveTenantByNumber(to);
  if (!tenant) return { status: 'unknown_number', cxml: buildRejectCxml() };

  const base = process.env.SIGNALWIRE_WEBHOOK_BASE_URL ?? '';
  // Query params MUST be emitted in ALPHABETICAL key order (from, tenant, to).
  // Confirmed live 2026-08-06: SignalWire signs the recordingStatusCallback URL
  // VERBATIM as written here, but DELIVERS it with the query re-sorted alphabetically
  // (emitted `tenant&from&to` → delivered `from&tenant&to` → validateRequest saw
  // different bytes than were signed → 403 on every recording callback). Emitting
  // already-sorted makes the delivered URL byte-identical to the signed one, so
  // validateSignalWireSignature (which reconstructs from the RECEIVED url) matches.
  // Keep these three in sorted order; adding a param means re-sorting the whole query.
  const callbackUrl =
    `${base}/inbound/phone/recording?from=${encodeURIComponent(from)}` +
    `&tenant=${encodeURIComponent(tenant.tenantId)}&to=${encodeURIComponent(to)}`;
  const cxml = buildVoiceCxml({ forwardTo: tenant.forwardTo, recordingCallbackUrl: callbackUrl });
  return { status: tenant.forwardTo ? 'ok_forward' : 'ok_voicemail', cxml };
}

// Webhook 2 — RecordingStatusCallback. Validates, enqueues into call_ingest, and
// fast-acks. tenant/from/to come from the callback URL query (baked in by
// webhook 1); RecordingSid/RecordingUrl/etc. come from the POST body.
export async function handleRecordingWebhook(
  input: {
    fullUrl: string;
    rawBody: string;
    query: { tenant?: string; from?: string; to?: string };
    signature?: string;
  },
  deps: PhoneWebhookDeps = liveDeps,
): Promise<{ status: RecordingStatus; callIngestId?: string }> {
  const params = parseFormBody(input.rawBody);
  const token = process.env.SIGNALWIRE_API_TOKEN ?? '';
  if (!deps.validateSignature(input.fullUrl, params, input.signature, token)) {
    return { status: 'bad_signature' };
  }
  let rec: RecordingCallback;
  try {
    rec = parseRecordingCallback(params);
  } catch {
    return { status: 'bad_payload' };
  }
  // Only 'completed' carries a finished recording (we subscribe to it, but guard
  // anyway — a misconfigured event subscription must not enqueue a half-recording).
  if (rec.status !== 'completed') return { status: 'ignored_status' };
  const tenantId = input.query.tenant;
  if (!tenantId) return { status: 'bad_payload' };

  try {
    const { id, deduped } = await deps.enqueueCall({
      tenantId,
      externalId: rec.externalId, // RecordingSid — dedup key
      callerPhone: input.query.from || null,
      callSid: rec.callSid,
      audioRef: rec.recordingUrl || null, // remote URL; the worker copies it to the bucket
      consentAnnounced: true, // webhook 1 always emits the consent <Say> before recording
      occurredAt: null,
      payload: { durationSec: rec.durationSec, toNumber: input.query.to ?? null },
    });
    return { status: deduped ? 'duplicate' : 'enqueued', callIngestId: id };
  } catch {
    return { status: 'transient_error' };
  }
}
