import type { CaptureChannel, Json } from '../db/index.js';

// The connector-agnostic inbound seam: every external source (Composio toolkit +
// trigger) is normalized to ONE shape before it touches the shared write-path, so
// recordFieldNote / the webhook never learn a connector's payload schema. Keep this
// Gmail-free — Gmail is just the first registered normalizer (see ./gmail.ts).
export interface InboundEnvelope {
  // Constrained to the capture_channel enum (migration 20260620005307 :16-22); a
  // genuinely new channel needs an enum migration, not a free string. 'email' reuses
  // an existing value.
  channel: CaptureChannel;
  rawText?: string | null;
  blobRef?: string | null;
  // The source's stable id — the per-tenant dedup key (raw_captures.external_id).
  externalId: string;
  occurredAt?: string;
  sourceMeta?: Json;
  // When true, the webhook runs the work/personal classifier BEFORE the L1 insert
  // (CLAUDE.md: classify-before-L1, since L1 is append-only and cannot be deleted).
  requiresWorkClassifier?: boolean;
}

export type Normalizer = (payload: unknown) => InboundEnvelope;

// Registry keyed by `${toolkit}:${triggerType}` (upper-cased so callers need not
// match Composio's exact casing). Normalizers self-register on import.
const registry = new Map<string, Normalizer>();

function key(toolkit: string, triggerType: string): string {
  return `${toolkit}:${triggerType}`.toUpperCase();
}

export function registerNormalizer(toolkit: string, triggerType: string, fn: Normalizer): void {
  registry.set(key(toolkit, triggerType), fn);
}

export function resolveNormalizer(toolkit: string, triggerType: string): Normalizer | null {
  return registry.get(key(toolkit, triggerType)) ?? null;
}
