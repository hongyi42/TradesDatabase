import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { isUniqueViolation } from './rawCaptures.js';

export type CallIngest = Database['public']['Tables']['call_ingest']['Row'];

export interface EnqueueCallInput {
  tenantId: string;
  externalId: string; // SignalWire RecordingSid — the dedup key
  callerPhone?: string | null;
  callSid?: string | null;
  audioRef?: string | null; // starts as the remote RecordingUrl; worker rewrites to the object path
  consentAnnounced: boolean;
  occurredAt?: string | null;
  payload?: Json;
}

// Drop a call onto the queue (status='pending'). At-least-once delivery: a
// redelivered RecordingSid hits uq_call_ingest_external and is turned into a
// no-op — we return the existing row's id with deduped:true (insert-then-catch
// 23505, the appendRawCapture / upsertOpenReviewItem pattern; supabase-js
// onConflict cannot target a specific unique index here).
export async function enqueueCall(input: EnqueueCallInput): Promise<{ id: string; deduped: boolean }> {
  const { data, error } = await getClient()
    .from('call_ingest')
    .insert({
      tenant_id: input.tenantId,
      external_id: input.externalId,
      caller_phone: input.callerPhone ?? null,
      call_sid: input.callSid ?? null,
      audio_ref: input.audioRef ?? null,
      consent_announced: input.consentAnnounced,
      occurred_at: input.occurredAt ?? null,
      payload: input.payload ?? {},
    })
    .select('id')
    .single();
  if (!error && data) return { id: data.id, deduped: false };
  if (!isUniqueViolation(error)) {
    throw new Error(`enqueueCall failed: ${error?.message ?? 'no row returned'}`);
  }
  const existing = await getClient()
    .from('call_ingest')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .eq('external_id', input.externalId)
    .maybeSingle();
  if (existing.error) throw new Error(`enqueueCall dedup lookup failed: ${existing.error.message}`);
  if (!existing.data) throw new Error('enqueueCall failed: conflict but no existing row found');
  return { id: existing.data.id, deduped: true };
}

// Concurrency-safe queue pop (SKIP LOCKED, in claim_next_call). Returns the
// claimed row already flipped to 'processing', or null when the queue is empty.
export async function claimNextPendingCall(): Promise<CallIngest | null> {
  const { data, error } = await getClient().rpc('claim_next_call');
  if (error) throw new Error(`claimNextPendingCall failed: ${error.message}`);
  // A `returns call_ingest` function yields the row (or nothing); normalize the
  // set-vs-single shape defensively.
  const row = Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
  // Empty queue: the LOCAL stack returns JSON null, but the HOSTED PostgREST
  // returns the NULL composite as an all-null ROW ({id:null, …}) — a truthy
  // object. Without this guard the worker treats "empty" as a phantom row and
  // crashes in markCallError with a null id (observed live on the pilot
  // 2026-08-06, where an idle worker would error-spin). A real claimed row always
  // has a non-null id, so key off that.
  if (!row || (row as CallIngest).id == null) return null;
  return row as CallIngest;
}

// Success: record the resulting capture, the match outcome, and when the audio
// may be purged. Called by the worker on the row it holds ('processing').
export async function markCallIngested(
  id: string,
  fields: { captureId: string; matchStatus: string; audioDeleteAfter: string },
): Promise<void> {
  const { error } = await getClient()
    .from('call_ingest')
    .update({
      status: 'ingested',
      capture_id: fields.captureId,
      match_status: fields.matchStatus,
      audio_delete_after: fields.audioDeleteAfter,
    })
    .eq('id', id);
  if (error) throw new Error(`markCallIngested failed: ${error.message}`);
}

// Failure: bump attempts and either re-queue (< cap) or park in 'error'. Safe as
// a read-modify-write because the worker exclusively holds this claimed row.
// The retry cap (5) is mirrored in claim_next_call's WHERE so a parked row is
// never re-served. Returns the resulting status + attempt count so the caller can
// tell a TERMINAL failure (parked in 'error') from a retryable one and alert only
// once the row is truly dead — otherwise the "only when exhausted" push is
// unwritable.
export async function markCallError(
  id: string,
  message: string,
): Promise<{ status: 'error' | 'pending'; attempts: number }> {
  const client = getClient();
  const current = await client.from('call_ingest').select('attempts').eq('id', id).maybeSingle();
  if (current.error) throw new Error(`markCallError read failed: ${current.error.message}`);
  const attempts = (current.data?.attempts ?? 0) + 1;
  const status: 'error' | 'pending' = attempts >= 5 ? 'error' : 'pending';
  const { error } = await client
    .from('call_ingest')
    .update({ attempts, last_error: message, status })
    .eq('id', id);
  if (error) throw new Error(`markCallError failed: ${error.message}`);
  return { status, attempts };
}

// Rewrite audio_ref from the remote SignalWire URL to the Supabase object path,
// once the worker has copied the recording in.
export async function setAudioRef(id: string, storagePath: string): Promise<void> {
  const { error } = await getClient()
    .from('call_ingest')
    .update({ audio_ref: storagePath })
    .eq('id', id);
  if (error) throw new Error(`setAudioRef failed: ${error.message}`);
}

// Rows whose stored audio is eligible for deletion — the purge cron's worklist.
// The `< now()` filter is here (not in the partial index) because now() is not
// IMMUTABLE. Cross-tenant by design (a system process, like the cost cron).
export async function listExpiredAudio(): Promise<CallIngest[]> {
  const { data, error } = await getClient()
    .from('call_ingest')
    .select()
    .lt('audio_delete_after', new Date().toISOString())
    .eq('legal_hold', false)
    .is('audio_deleted_at', null);
  if (error) throw new Error(`listExpiredAudio failed: ${error.message}`);
  return data ?? [];
}

// Stamp the audio as deleted (guards purge re-runs — idempotent).
export async function markAudioDeleted(id: string): Promise<void> {
  const { error } = await getClient()
    .from('call_ingest')
    .update({ audio_deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(`markAudioDeleted failed: ${error.message}`);
}

// Suspend/resume the purge for one call (litigation hold — deleting under a hold
// is spoliation).
export async function setLegalHold(id: string, on: boolean): Promise<void> {
  const { error } = await getClient().from('call_ingest').update({ legal_hold: on }).eq('id', id);
  if (error) throw new Error(`setLegalHold failed: ${error.message}`);
}
