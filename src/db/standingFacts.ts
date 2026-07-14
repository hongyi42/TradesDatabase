import type { Json } from './database.types.js';

// A standing fact: one durable customer/job-level L3 attribute, wrapped with the
// L1 capture that evidences it (build-schedule Feature C+D Phase 1). The wrapper
// IS the provenance link — customers/jobs carry a single creation-time
// source_capture_id, so a fact recorded later has no other schema home for its
// evidence. Only record_standing_fact writes these; visit attributes stay plain
// values, so every helper below passes non-bundle values through untouched.
export interface StandingFactBundle {
  value: string | number | boolean;
  sourceCaptureId: string;
  recordedAt: string;
}

const BUNDLE_KEYS = ['recordedAt', 'sourceCaptureId', 'value'] as const;

// Shape guard: exactly the three bundle keys with the right types. Exact-keys
// (not just "has the keys") so a plain attribute object that happens to carry a
// `value` field is never misread as a fact and silently unwrapped or folded.
export function isFactBundle(v: Json): v is StandingFactBundle & { [k: string]: Json } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const keys = Object.keys(v).sort();
  if (keys.length !== BUNDLE_KEYS.length || keys.some((k, i) => k !== BUNDLE_KEYS[i])) return false;
  const bundle = v as Record<string, Json>;
  const scalar = ['string', 'number', 'boolean'].includes(typeof bundle.value);
  return scalar && typeof bundle.sourceCaptureId === 'string' && typeof bundle.recordedAt === 'string';
}

// Bundles → plain values (for prompts/previews); non-bundle values untouched.
export function unwrapAttributes(attrs: Json): Record<string, Json> {
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return {};
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const v = value ?? null;
    out[key] = isFactBundle(v) ? v.value : v;
  }
  return out;
}

// Drop facts whose evidence capture was retracted ("fact disappears" — the only
// removal path; there is no delete tool). Plain values are never dropped.
export function foldRetractedFacts(attrs: Json, retractedIds: ReadonlySet<string>): Json {
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return attrs;
  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const v = value ?? null;
    if (isFactBundle(v) && retractedIds.has(v.sourceCaptureId)) continue;
    out[key] = v;
  }
  return out;
}

// The evidence capture ids inside an attributes object — readers use this to
// know which retractions to look up before folding.
export function factSourceIds(attrs: Json): string[] {
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return [];
  return Object.values(attrs)
    .filter((v): v is StandingFactBundle & { [k: string]: Json } => isFactBundle(v ?? null))
    .map((v) => v.sourceCaptureId);
}
