import { fileURLToPath } from 'node:url';
import { listTechniciansInStates } from '../db/index.js';
import { checkPairing } from '../composio/pairing.js';
import { expireOffboarding, type ExpireResult } from '../composio/offboarding.js';
import { syncScheduleFromSheet } from '../schedule/sheetSync.js';

// The lifecycle heartbeat — the ONE scheduled entrypoint (Render Cron Job,
// */15 * * * *; Render guarantees at most one concurrent run). Everything
// here is a sweep over durable state, so a missed or doubled tick is safe:
// (1) notice completed OAuth consents and advance those rows;
// (2) run the grace-period expiry (reminders + permanent teardown);
// (3) mirror the manager's schedule sheet (single-tenant interim: the
//     DEFAULT_TENANT_ID sheet — recorded limitation, multi-tenant sheet
//     config is future work).
// Each step is isolated: one failing step is REPORTED (ok:false → exit 1 →
// Render marks the run failed) but never blocks the others.

export interface LifecycleDeps {
  listInStates?: typeof listTechniciansInStates;
  checkPairing?: typeof checkPairing;
  expire?: typeof expireOffboarding;
  syncSheet?: typeof syncScheduleFromSheet;
}

export interface LifecycleSummary {
  pairing: { checked: number; paired: number; rowErrors: number } | { stepError: string };
  offboarding: ExpireResult | { stepError: string };
  sheetSync:
    | { upserted: number; flagged: number }
    | { skipped: string }
    | { stepError: string };
  ok: boolean;
}

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runLifecycle(
  nowIso: string,
  deps: LifecycleDeps = {},
): Promise<LifecycleSummary> {
  const listInStates = deps.listInStates ?? listTechniciansInStates;
  const check = deps.checkPairing ?? checkPairing;
  const expire = deps.expire ?? expireOffboarding;
  const syncSheet = deps.syncSheet ?? syncScheduleFromSheet;
  let ok = true;

  // 1. Pairing sweep — only rows a link was ever issued for (checkPairing
  // itself no-ops on anything not 'invited', so the pending_verification rows
  // in the sweep are just cheap confirmations the item is still with the
  // manager). Per-row failures are retried next tick, not run failures.
  let pairing: LifecycleSummary['pairing'];
  try {
    const rows = (await listInStates(['invited', 'pending_verification'])).filter(
      (r) => r.link_issued_at,
    );
    let paired = 0;
    let rowErrors = 0;
    for (const row of rows) {
      try {
        if ((await check(row)).status === 'paired') paired++;
      } catch {
        rowErrors++;
      }
    }
    pairing = { checked: rows.length, paired, rowErrors };
    // EVERY row failing is systemic (bad/revoked key, Composio down), not a
    // blip — go red so Render surfaces it instead of showing green while
    // pairing is dead indefinitely (review finding).
    if (rows.length > 0 && rowErrors === rows.length) ok = false;
  } catch (err) {
    pairing = { stepError: msg(err) };
    ok = false;
  }

  // 2. Grace-period expiry (reminders, teardown, self-heal).
  let offboarding: LifecycleSummary['offboarding'];
  try {
    offboarding = await expire(nowIso);
  } catch (err) {
    offboarding = { stepError: msg(err) };
    ok = false;
  }

  // 3. Schedule-sheet sync — optional by config; skipping is not a failure.
  let sheetSync: LifecycleSummary['sheetSync'];
  const sheetId = process.env.SCHEDULE_SHEET_ID;
  const tenantId = process.env.DEFAULT_TENANT_ID;
  if (!sheetId || !tenantId) {
    sheetSync = { skipped: 'SCHEDULE_SHEET_ID / DEFAULT_TENANT_ID unset' };
  } else {
    try {
      sheetSync = await syncSheet(tenantId, sheetId);
    } catch (err) {
      sheetSync = { stepError: msg(err) };
      ok = false;
    }
  }

  return { pairing, offboarding, sheetSync, ok };
}

async function main(): Promise<void> {
  const summary = await runLifecycle(new Date().toISOString());
  console.log(JSON.stringify(summary));
  process.exit(summary.ok ? 0 : 1);
}

// Run only when executed directly (node dist/jobs/lifecycle.js), not on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
