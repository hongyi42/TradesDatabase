import { fileURLToPath } from 'node:url';
import { listTechniciansInStates } from '../db/index.js';
import { checkPairing } from '../composio/pairing.js';
import { expireOffboarding, type ExpireResult } from '../composio/offboarding.js';
import { ensurePersonSession } from '../composio/sessions.js';
import { runLogIngestion, type LogIngestSummary } from '../composio/logIngest.js';
import { syncScheduleFromSheet } from '../schedule/sheetSync.js';

// The lifecycle heartbeat — the ONE scheduled entrypoint (Render Cron Job,
// */15 * * * *; Render guarantees at most one concurrent run). Everything
// here is a sweep over durable state, so a missed or doubled tick is safe:
// (1) notice completed OAuth consents and advance those rows;
// (2) run the grace-period expiry (reminders + permanent teardown);
// (3) mirror the manager's schedule sheet (single-tenant interim: the
//     DEFAULT_TENANT_ID sheet — recorded limitation, multi-tenant sheet
//     config is future work);
// (4) ensure every ACTIVE person has their tier-scoped Composio session
//     (self-healing, ≤15-min latency; skipped cleanly when COMPOSIO_API_KEY
//     is unset so a cron deployed without the key never goes permanently red);
// (5) ingest Composio execution logs into L1 (the manager-action audit; same
//     key gate, overlapping 60-min window so a missed tick loses nothing).
// Each step is isolated: one failing step is REPORTED (ok:false → exit 1 →
// Render marks the run failed) but never blocks the others.

export interface LifecycleDeps {
  listInStates?: typeof listTechniciansInStates;
  checkPairing?: typeof checkPairing;
  expire?: typeof expireOffboarding;
  syncSheet?: typeof syncScheduleFromSheet;
  ensureSession?: typeof ensurePersonSession;
  ingestLogs?: typeof runLogIngestion;
}

export interface LifecycleSummary {
  pairing: { checked: number; paired: number; rowErrors: number } | { stepError: string };
  offboarding: ExpireResult | { stepError: string };
  sheetSync:
    | { upserted: number; flagged: number }
    | { skipped: string }
    | { stepError: string };
  sessions:
    | { checked: number; created: number; rowErrors: number }
    | { skipped: string }
    | { stepError: string };
  logIngest: LogIngestSummary | { skipped: string } | { stepError: string };
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
  const ensureSession = deps.ensureSession ?? ensurePersonSession;
  const ingestLogs = deps.ingestLogs ?? runLogIngestion;
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
    let attempts = 0;
    for (const row of rows) {
      try {
        const result = await check(row);
        if (result.status !== 'no_op') attempts++; // no_op rows can't error
        if (result.status === 'paired') paired++;
      } catch {
        attempts++;
        rowErrors++;
      }
    }
    pairing = { checked: rows.length, paired, rowErrors };
    // EVERY attempted row failing is systemic (bad/revoked key, Composio
    // down), not a blip — go red so Render surfaces it. Measured against
    // ATTEMPTS, not rows: pending_verification no-ops never call Composio and
    // would dilute the detector into permanent green (review finding).
    if (attempts > 0 && rowErrors === attempts) ok = false;
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

  // 4. Session provisioning sweep — every ACTIVE row gets its tier-scoped
  // Composio session. GATED on the key: a cron deployed without
  // COMPOSIO_API_KEY skips cleanly (the sheet-sync pattern) instead of
  // failing every row and turning the heartbeat permanently red.
  let sessions: LifecycleSummary['sessions'];
  if (!process.env.COMPOSIO_API_KEY) {
    sessions = { skipped: 'COMPOSIO_API_KEY unset' };
  } else {
    try {
      const rows = await listInStates(['active']);
      let created = 0;
      let rowErrors = 0;
      let attempts = 0;
      for (const row of rows) {
        try {
          const result = await ensureSession(row);
          if (result.status === 'created') {
            attempts++; // only rows that actually called Composio
            created++;
          }
        } catch {
          attempts++;
          rowErrors++;
        }
      }
      sessions = { checked: rows.length, created, rowErrors };
      // Same systemic-failure detector as the pairing sweep: every ATTEMPTED
      // row failing means a bad key / Composio down, not a row blip.
      if (attempts > 0 && rowErrors === attempts) ok = false;
    } catch (err) {
      sessions = { stepError: msg(err) };
      ok = false;
    }
  }

  // 5. Execution-log ingestion — the manager-action audit into L1. Same key
  // gate as step 4; per-row failures are inside the summary (the overlapping
  // window retries them next tick), a step-level throw goes red.
  let logIngest: LifecycleSummary['logIngest'];
  if (!process.env.COMPOSIO_API_KEY) {
    logIngest = { skipped: 'COMPOSIO_API_KEY unset' };
  } else {
    try {
      logIngest = await ingestLogs(nowIso);
    } catch (err) {
      logIngest = { stepError: msg(err) };
      ok = false;
    }
  }

  return { pairing, offboarding, sheetSync, sessions, logIngest, ok };
}

async function main(): Promise<void> {
  const summary = await runLifecycle(new Date().toISOString());
  // Drain stdout BEFORE exiting: on a pipe (Render cron logs) process.exit
  // tears the process down without flushing async writes, losing the one
  // diagnostic line exactly on the failed runs that need it (review finding).
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify(summary) + '\n', () => resolve());
  });
  process.exit(summary.ok ? 0 : 1);
}

// Run only when executed directly (node dist/jobs/lifecycle.js), not on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
