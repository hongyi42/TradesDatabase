import {
  casTechnician,
  flagOffboardingReminder,
  listTechniciansInStates,
  resolveOpenReviewItemFor,
  updateTechnician,
  type Technician,
} from '../db/index.js';
import {
  deleteComposioPairing,
  getComposioClient,
  isGoneError,
  type PairingClient,
} from './pairing.js';

// Grace-period offboarding (decided 2026-07-02): a confirmed deactivation
// DISABLES the pairing (reversible — reactivate_technician_seat is the undo);
// only when the grace period expires does the cron do the permanent teardown.
// ca_*/ti_* ids are KEPT after offboarding (history/audit) — the Composio
// objects are deleted, the columns are not nulled.

const DEFAULT_GRACE_DAYS = 7;
const REMINDER_WINDOW_MS = 2 * 86_400_000; // "2 days left" heads-up

export function graceDays(): number {
  const n = Number(process.env.GRACE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_GRACE_DAYS;
}

export interface OffboardingDeps {
  client?: PairingClient;
  update?: typeof updateTechnician;
  cas?: typeof casTechnician;
  listInStates?: typeof listTechniciansInStates;
  flagReminder?: typeof flagOffboardingReminder;
  resolveItemFor?: typeof resolveOpenReviewItemFor;
}

// Switch a pairing OFF without destroying it. Throws on real failures —
// callers treat it as advisory (the expiry teardown is the backstop).
export async function disablePairing(tech: Technician, deps: OffboardingDeps = {}): Promise<void> {
  const client = requireClient(deps);
  if (tech.composio_trigger_id) {
    try {
      await client.triggers.disable(tech.composio_trigger_id);
    } catch (err) {
      if (!isGoneError(err)) throw err;
    }
  }
  if (tech.composio_connected_account_id) {
    try {
      await client.connectedAccounts.disable(tech.composio_connected_account_id);
    } catch (err) {
      if (!isGoneError(err)) throw err;
    }
  }
}

// Mirror of disablePairing — the reactivation path.
export async function enablePairing(tech: Technician, deps: OffboardingDeps = {}): Promise<void> {
  const client = requireClient(deps);
  if (tech.composio_connected_account_id) {
    await client.connectedAccounts.enable(tech.composio_connected_account_id);
  }
  if (tech.composio_trigger_id) {
    await client.triggers.enable(tech.composio_trigger_id);
  }
}

export interface ExpireResult {
  scanned: number;
  stamped: number; // NULL clocks self-healed (deactivated between deploys)
  reminded: number;
  expired: number;
  raced: number; // reactivated between the list read and the claim — skipped
  failed: number; // per-row write/teardown failures (see teardown note below)
  sessionsCleaned: number; // leaked sessions on offboarded rows deleted by the retry pass
}

// The grace-period sweep the lifecycle cron runs every 15 minutes.
export async function expireOffboarding(
  nowIso: string,
  deps: OffboardingDeps = {},
): Promise<ExpireResult> {
  const update = deps.update ?? updateTechnician;
  const cas = deps.cas ?? casTechnician;
  const listInStates = deps.listInStates ?? listTechniciansInStates;
  const flagReminder = deps.flagReminder ?? flagOffboardingReminder;
  const resolveItemFor = deps.resolveItemFor ?? resolveOpenReviewItemFor;

  const graceMs = graceDays() * 86_400_000;
  const now = Date.parse(nowIso);
  const listed = await listInStates(['offboarding', 'offboarded']);
  const rows = listed.filter((r) => r.state === 'offboarding');
  // LEAKED sessions: an offboarded row still carrying a session id means a
  // prior tick's delete failed after the CAS claim (or the roster null-out
  // did). Retried here every tick until the delete lands (review finding:
  // these were previously unreachable forever once the row left the
  // 'offboarding' set).
  const leaked = listed.filter((r) => r.state === 'offboarded' && r.composio_session_id);
  const result: ExpireResult = {
    scanned: rows.length,
    stamped: 0,
    reminded: 0,
    expired: 0,
    raced: 0,
    failed: 0,
    sessionsCleaned: 0,
  };

  for (const row of leaked) {
    try {
      const client = requireClient(deps);
      try {
        await client.sessions.delete(row.composio_session_id as string);
      } catch (err) {
        if (!isGoneError(err)) throw err;
      }
      await update(row.id, { composio_session_id: null });
      result.sessionsCleaned++;
    } catch {
      result.failed++; // retried next tick — the row stays marked
    }
  }

  for (const row of rows) {
    // Self-heal a NULL clock (row deactivated before the stamping code
    // deployed): NULL math is NaN and BOTH branches below would silently
    // never fire — stamp now, let the grace period run from here. Guarded
    // like every other per-row write: one bad row must not abort the sweep.
    if (!row.offboarding_started_at) {
      try {
        await update(row.id, { offboarding_started_at: nowIso });
        result.stamped++;
      } catch {
        result.failed++;
      }
      continue;
    }
    const remaining = graceMs - (now - Date.parse(row.offboarding_started_at));
    if (remaining <= 0) {
      try {
        // CLAIM before the destructive teardown (CAS on 'offboarding'): a
        // reactivation landing between the list read and here must WIN — the
        // unguarded order (teardown first, blind state write after) would
        // delete the just-re-enabled pairing and terminally offboard someone
        // the manager was told is active (review finding). A lost claim skips
        // the row entirely.
        const claimed = await cas(row.id, 'offboarding', { state: 'offboarded' });
        if (!claimed) {
          result.raced++;
          continue;
        }
        // Teardown AFTER the claim. If it throws now, the row stays offboarded
        // with the Composio objects left behind — acceptable: they were
        // disabled at deactivation and the webhook roster gate drops their
        // mail regardless; the alternative (claim-after) risks destroying a
        // reactivated person's pairing, which is worse than inert clutter.
        await deleteComposioPairing(row, deps);
        // The person's Composio session goes with the pairing (same 404-is-
        // gone idiom). Deliberately NOT inside deleteComposioPairing — unpair
        // reuses that for people who STAY on the roster (wrong-mailbox
        // re-pair), and their session must survive. Deactivation normally
        // tears the session down already (server.ts, review finding: a live
        // manager session can mint NEW accounts, so the disabled-account 4302
        // backstop doesn't cover it) — this is the backstop for rows whose
        // deactivation-time teardown failed. The column is NULLED on success:
        // a non-null id on an offboarded row marks a LEAKED session for the
        // retry pass below (review finding: post-claim failures were never
        // retried, leaking a live session permanently).
        if (row.composio_session_id) {
          const client = requireClient(deps);
          try {
            await client.sessions.delete(row.composio_session_id);
          } catch (err) {
            if (!isGoneError(err)) throw err;
          }
          try {
            await update(row.id, { composio_session_id: null });
          } catch {
            /* advisory — the retry pass re-runs the (idempotent) delete */
          }
        }
        result.expired++;
      } catch {
        result.failed++;
        continue;
      }
      // Close the reminder if one is open — advisory once the state landed.
      try {
        await resolveItemFor(
          row.tenant_id,
          'offboarding_reminder',
          row.ref,
          'resolved',
          'offboarding completed',
        );
      } catch {
        /* advisory */
      }
    } else if (remaining <= REMINDER_WINDOW_MS) {
      // Once per episode (any-status dedup on startedAt inside the flag) —
      // advisory: a failed reminder write must not abort the sweep.
      try {
        const item = await flagReminder({
          tenantId: row.tenant_id,
          subjectRef: row.ref,
          startedAt: row.offboarding_started_at,
          graceEndsAt: new Date(Date.parse(row.offboarding_started_at) + graceMs).toISOString(),
        });
        if (item) result.reminded++;
      } catch {
        /* advisory */
      }
    }
  }
  return result;
}

// deps.client wins (tests); otherwise pairing's shared lazy singleton.
function requireClient(deps: OffboardingDeps): PairingClient {
  return deps.client ?? getComposioClient();
}
