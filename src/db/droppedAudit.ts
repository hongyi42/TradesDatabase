import { isUniqueViolation, type CaptureChannel } from './rawCaptures.js';
import { getClient } from './client.js';

export interface DroppedAuditInput {
  tenantId: string;
  channel: CaptureChannel;
  externalId?: string | null;
  // The full sender string ("Name <user@acme.com>" or "user@acme.com"). Only the
  // DOMAIN is persisted — never the local part or display name — so the audit row
  // stays content-free and is safe to read without exposing personal mail.
  from?: string | null;
  reason?: string | null;
}

// Extract just the domain from a sender string. "Mike <mike@acme.com>" → "acme.com".
// Returns null if no '@' is present (keeps the row content-free either way).
export function senderDomain(from: string | null | undefined): string | null {
  if (!from) return null;
  const at = from.lastIndexOf('@');
  if (at === -1) return null;
  return from.slice(at + 1).replace(/[>\s]+$/, '').trim().toLowerCase() || null;
}

// Record a content-free receipt that the classifier dropped a non-work message.
// Stores NO body/subject/full-address — only tenant, channel, external_id (re-fetch
// handle), sender domain, and the model's reason. Idempotent on (tenant, external_id)
// so overlapping pull windows / webhook retries do not pile up duplicate receipts.
export async function upsertDroppedAudit(input: DroppedAuditInput): Promise<void> {
  const row = {
    tenant_id: input.tenantId,
    channel: input.channel,
    external_id: input.externalId ?? null,
    sender_domain: senderDomain(input.from),
    classifier_reason: input.reason ?? null,
  };
  // Insert; a 23505 on the partial unique (tenant_id, external_id) index means this
  // message was already audited (overlapping pull window / webhook retry) → no-op.
  // Insert-then-catch (not upsert) because supabase-js onConflict cannot infer a
  // PARTIAL unique index — same pattern as appendRawCapture.
  const { error } = await getClient().from('dropped_audit').insert(row);
  if (error && !isUniqueViolation(error)) {
    throw new Error(`upsertDroppedAudit failed: ${error.message}`);
  }
}
