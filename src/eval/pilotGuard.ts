// The TIER 3 target guard — the mirror image of targetGuard.ts, and deliberately
// a separate file.
//
// Tier 3 measures the openclaw GATEWAY. The gateway exists only on trades-box-1,
// whose sandboxes reach the spine through the doorman → Render → the PILOT
// database. So unlike tiers 1 and 2, tier 3 cannot run locally: the pilot is not
// a convenience here, it is the subject.
//
// WHY THIS IS NOT A FLAG ON targetGuard.ts
// ----------------------------------------
// targetGuard.ts refuses the pilot by ref, and it exists because a test run
// truncated the pilot's roster on 2026-07-03 and locked a technician out. Adding
// an `allowPilot` option to it would mean one code path, one bug away from
// letting tier 1 truncate the pilot. Two guards that disagree by construction is
// the safer shape: this one refuses everything that is NOT the pilot, that one
// refuses everything that IS. Neither can be talked into the other's job.
//
// WHAT THIS GUARD IS FOR, precisely
// ---------------------------------
// The user lifted the "never touch the pilot" constraint on 2026-08-12 ("You can
// touch the pilot. The live DB is used for testing anyways."). That lifts the
// prohibition; it does not lift the CARE. Three things stay true no matter who
// approved what:
//
//   1. TRUNCATION IS NEVER OK. Tier 1 truncates 14 tables to build its world.
//      Against the pilot that is the 2026-07-03 incident again. So truncation is
//      not merely "not done" in pilot mode — assertTruncationAllowed() throws,
//      making it unreachable rather than merely unused.
//   2. WRITES ARE TENANT-SCOPED. Everything tier 3 creates lives under one
//      dedicated eval tenant, so it is isolatable and removable by tenant id.
//   3. L1 IS FOREVER. `raw_captures` is append-only with no delete path, so every
//      tier-3 run appends permanent rows to the pilot. Nothing here can prevent
//      that; the harness's duty is to stamp them and COUNT them out loud.

import { isLocalDbUrl } from '../testEnvGuard.js';
import { PILOT_REF } from './targetGuard.js';

export { PILOT_REF };

/**
 * Every tenant tier 3 creates carries this prefix.
 *
 * It is load-bearing, not cosmetic: it is the check that a mistyped or inherited
 * tenant id cannot be written to, and it is how a human scanning the pilot's
 * `tenants` table later can tell eval rows from a real firm's at a glance.
 */
export const EVAL_TENANT_PREFIX = 'spine-eval';

/**
 * Marker written into the `source` metadata of every L1 capture tier 3 creates.
 *
 * Same pattern as `pendingVerification` in src/inbound/webhook.ts, and for the
 * same reason: `raw_captures` has no delete path, so the only way a future
 * forensic reader can separate eval noise from real customer evidence is a stamp
 * that was applied at insert time. There is no retrofit for this.
 */
export const EVAL_CAPTURE_MARKER = 'spineEvalTier3';

/**
 * Sentinel written to `technicians.composio_session_id` for every tier-3 person.
 *
 * WHY: the pilot's lifecycle cron (`src/jobs/lifecycle.ts` step 3, every 15
 * minutes) ensures a tier-scoped Composio session for EVERY technician whose
 * `state` is 'active'. Eval technicians must be active — the schedule readers
 * treat a non-active roster as empty — so without this the cron would create one
 * real Composio session per fake person on the production Composio account, and a
 * 20-person eval world would mint 20 of them within a quarter of an hour.
 *
 * `ensurePersonSession` short-circuits with `{status:'exists'}` when the column is
 * already set, so pre-filling it makes the sweep a no-op. This is honest rather
 * than a trick: the eval tenant has no Composio pairing and no connected account,
 * so there is no real session to hold, and nothing in the tier-3 path calls
 * Composio (the eval sandbox has no `composio` MCP server — only `trades-spine`).
 *
 * Deliberately not a plausible id: anything reading it should fail loudly and
 * obviously rather than issue an API call that half-works.
 */
export const EVAL_COMPOSIO_SENTINEL = 'eval-no-composio-session';

export type PilotVerdict =
  | { ok: true; ref: string; host: string }
  | { ok: false; reason: string; detail?: string };

/**
 * Decide whether a (DATABASE_URL, SUPABASE_URL) pair is a legal TIER 3 target.
 *
 * Inverted relative to assessTarget(): the pilot must be PROVEN, and anything
 * else — including a local stack — is refused. Refusing local matters more than
 * it looks: a half-configured tier-3 run that silently hit the local stack would
 * report gateway numbers that never touched the gateway, which is worse than an
 * error because it looks like a result.
 *
 * `confirmed` is the caller's double opt-in (`--pilot --yes`). It is a parameter
 * rather than an env read so the decision stays a pure function, and so the test
 * suite can prove that the un-confirmed case refuses.
 */
export function assessPilotTarget(dbUrl: string, supaUrl: string, opts: { confirmed: boolean }): PilotVerdict {
  if (!opts.confirmed) {
    return {
      ok: false,
      reason: 'tier 3 writes to the PILOT database and requires an explicit --pilot --yes',
      detail: 'neither flag is implied by any other flag, and there is no environment variable for it',
    };
  }
  if (!dbUrl || !supaUrl) {
    return {
      ok: false,
      reason: 'DATABASE_URL and SUPABASE_URL must both be set',
      detail: `DATABASE_URL ${dbUrl ? 'set' : 'MISSING'}, SUPABASE_URL ${supaUrl ? 'set' : 'MISSING'}`,
    };
  }
  // Checked before the ref match, because a local URL here is a different mistake
  // with a different fix: the caller loaded .env.test (which retargets to local)
  // when tier 3 needs the pilot's own environment.
  if (isLocalDbUrl(dbUrl) || isLocalDbUrl(supaUrl)) {
    return {
      ok: false,
      reason: 'tier 3 targets the PILOT, but this environment points at the LOCAL stack',
      detail: 'a tier-3 run against local would report gateway numbers that never reached the gateway',
    };
  }
  const dbHasRef = dbUrl.includes(PILOT_REF);
  const supaHasRef = supaUrl.includes(PILOT_REF);
  // Both, independently. A half-retargeted environment would read one database
  // and write another; requiring both is the same reasoning as assessTarget's.
  if (!dbHasRef || !supaHasRef) {
    return {
      ok: false,
      reason: `both URLs must name the pilot project (${PILOT_REF})`,
      detail: `DATABASE_URL names it: ${dbHasRef}, SUPABASE_URL names it: ${supaHasRef}`,
    };
  }
  let host: string;
  try {
    host = new URL(supaUrl).host;
  } catch {
    return { ok: false, reason: 'SUPABASE_URL is not a parseable URL' };
  }
  return { ok: true, ref: PILOT_REF, host };
}

/**
 * Truncation is a local-only capability. In pilot mode this THROWS.
 *
 * Deliberately a throw and not a boolean: a caller that forgets to check a
 * boolean truncates the pilot, whereas a caller that forgets to call this at all
 * is caught by review of a single grep for the function name. The failure mode of
 * each choice is what decides it.
 */
export function assertTruncationAllowed(mode: 'local' | 'pilot'): void {
  if (mode === 'pilot') {
    throw new Error(
      'REFUSING: truncation is not reachable in pilot mode. Tier 3 creates its world inside one ' +
        'dedicated eval tenant and tears down by tenant-scoped delete. Truncating the pilot is the ' +
        '2026-07-03 incident (a test run emptied its roster and locked a technician out).',
    );
  }
}

/**
 * A tenant name is writable by tier 3 only if it declares itself an eval tenant.
 *
 * The prefix check is the last line between "write into my own scratch tenant"
 * and "write into a real firm's record". Cheap, total, and it fails closed on an
 * empty or undefined name.
 */
export function isEvalTenantName(name: string | null | undefined): boolean {
  return typeof name === 'string' && name.startsWith(`${EVAL_TENANT_PREFIX}-`);
}

/**
 * Guard the write target itself. Throws with the offending name, because the
 * useful message here names what it refused rather than restating the rule.
 */
export function assertEvalTenant(name: string | null | undefined): void {
  if (!isEvalTenantName(name)) {
    throw new Error(
      `REFUSING: tier 3 may only write to a tenant whose name starts with '${EVAL_TENANT_PREFIX}-', ` +
        `and this one is ${name === undefined || name === null ? String(name) : `'${name}'`}. ` +
        'Every tier-3 row must be isolatable and removable by tenant.',
    );
  }
}

/** The canonical name for a tier-3 tenant, so drivers cannot each invent one. */
export function evalTenantName(suffix: string): string {
  const clean = suffix.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!clean) throw new Error('evalTenantName needs a non-empty suffix');
  return `${EVAL_TENANT_PREFIX}-${clean}`;
}
