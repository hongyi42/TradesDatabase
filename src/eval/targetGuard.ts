// The spine eval's target guard — the single most safety-critical decision in
// the harness, so it lives here (typechecked, linted, unit-tested) rather than in
// the .mjs driver that calls it.
//
// Why it matters: this eval WRITES. It truncates spine tables and generates a
// world. The hosted "test" project is the deployed pilot's LIVE database — Render
// web + cron and the trades-box-1 badge pull read it — and a test run truncated
// its roster once already (2026-07-03), locking a technician out. Nothing the eval
// does needs the pilot, so the only correct answer for any non-local target is no.
//
// FAIL-CLOSED means: local is PROVEN, never inferred from the absence of evidence.
// An empty, malformed, or unrecognised URL is not-local and is refused.

import { isLocalDbUrl } from '../testEnvGuard.js';

/** The pilot project ref, named in refusals so the message is actionable. */
export const PILOT_REF = 'daqapdlkgxfrhquacprv';

export type TargetVerdict =
  | { ok: true; host: string }
  | { ok: false; reason: string; dbLocal: boolean; supaLocal: boolean };

/**
 * Decide whether a (DATABASE_URL, SUPABASE_URL) pair is a legal eval target.
 *
 * Both must independently prove local. Requiring BOTH matters: a half-retargeted
 * environment — local Postgres, hosted PostgREST — would read and write two
 * different databases, and the hosted half is the pilot.
 */
export function assessTarget(dbUrl: string, supaUrl: string): TargetVerdict {
  const dbLocal = isLocalDbUrl(dbUrl);
  const supaLocal = isLocalDbUrl(supaUrl);

  // Checked first so the message names the pilot explicitly rather than the
  // generic not-local one — the difference between "misconfigured" and "about to
  // truncate production".
  if (dbUrl.includes(PILOT_REF) || supaUrl.includes(PILOT_REF)) {
    return {
      ok: false,
      reason: `the target is the PILOT database (${PILOT_REF}), which the deployed stack reads live`,
      dbLocal,
      supaLocal,
    };
  }
  if (!dbLocal || !supaLocal) {
    return {
      ok: false,
      reason: 'DATABASE_URL and SUPABASE_URL must BOTH point at the local stack (127.0.0.1/localhost)',
      dbLocal,
      supaLocal,
    };
  }
  let host: string;
  try {
    host = new URL(supaUrl).host;
  } catch {
    // Unreachable: isLocalDbUrl already parsed it. Kept because a guard that
    // throws on its own success path is worse than one that degrades a label.
    host = 'local';
  }
  return { ok: true, host };
}
