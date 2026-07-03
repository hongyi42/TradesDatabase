import {
  flagOffboardingReminder,
  findOpenReviewItem,
  listTechniciansInStates,
  resolveReviewItem,
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
  listInStates?: typeof listTechniciansInStates;
  flagReminder?: typeof flagOffboardingReminder;
  findOpenItem?: typeof findOpenReviewItem;
  resolveItem?: typeof resolveReviewItem;
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
  failed: number; // teardown failures — retried next run, state unchanged
}

// The grace-period sweep the lifecycle cron runs every 15 minutes.
export async function expireOffboarding(
  nowIso: string,
  deps: OffboardingDeps = {},
): Promise<ExpireResult> {
  const update = deps.update ?? updateTechnician;
  const listInStates = deps.listInStates ?? listTechniciansInStates;
  const flagReminder = deps.flagReminder ?? flagOffboardingReminder;
  const findOpenItem = deps.findOpenItem ?? findOpenReviewItem;
  const resolveItem = deps.resolveItem ?? resolveReviewItem;

  const graceMs = graceDays() * 86_400_000;
  const now = Date.parse(nowIso);
  const rows = await listInStates(['offboarding']);
  const result: ExpireResult = { scanned: rows.length, stamped: 0, reminded: 0, expired: 0, failed: 0 };

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
        await deleteComposioPairing(row, deps); // throws → retry next run
        await update(row.id, { state: 'offboarded' });
        result.expired++;
      } catch {
        result.failed++;
        continue;
      }
      // Close the reminder if one is open — advisory once the state landed.
      try {
        const reminder = await findOpenItem(row.tenant_id, 'offboarding_reminder', row.ref);
        if (reminder) {
          await resolveItem(reminder.id, row.tenant_id, 'resolved', 'offboarding completed');
        }
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
