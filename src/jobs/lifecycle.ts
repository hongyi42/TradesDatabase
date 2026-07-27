import { fileURLToPath } from 'node:url';
import {
  backfillBraveCostEvents,
  isMissingCostLedger,
  latestBraveCostEventAt,
  listTechniciansInStates,
  rollupCosts,
} from '../db/index.js';
import { checkPairing } from '../composio/pairing.js';
import { expireOffboarding, type ExpireResult } from '../composio/offboarding.js';
import { ensurePersonSession } from '../composio/sessions.js';
import { runLogIngestion, type LogIngestSummary } from '../composio/logIngest.js';

// The lifecycle heartbeat — the ONE scheduled entrypoint (Render Cron Job,
// */15 * * * *; Render guarantees at most one concurrent run). Everything
// here is a sweep over durable state, so a missed or doubled tick is safe:
// (1) notice completed OAuth consents and advance those rows;
// (2) run the grace-period expiry (reminders + permanent teardown);
// (3) ensure every ACTIVE person has their tier-scoped Composio session
//     (self-healing, ≤15-min latency; skipped cleanly when COMPOSIO_API_KEY
//     is unset so a cron deployed without the key never goes permanently red);
// (4) ingest Composio execution logs into L1 (the manager-action audit; same
//     key gate, overlapping 60-min window so a missed tick loses nothing);
// (5) replay Brave searches from web_requests into the cost ledger;
// (6) recompute the current month's per-tenant cost rollup (idempotent).
// Steps 5-6 report `skipped` — not an error — when the cost tables are absent,
// so a deploy that lands before the migration does not turn the cron red.
// (The schedule-sheet mirror step retired with the Telegram-schedule series
// Plan 1 — the DB owns the schedule; the sheet is no longer an input.)
// Each step is isolated: one failing step is REPORTED (ok:false → exit 1 →
// Render marks the run failed) but never blocks the others.

export interface LifecycleDeps {
  listInStates?: typeof listTechniciansInStates;
  checkPairing?: typeof checkPairing;
  expire?: typeof expireOffboarding;
  ensureSession?: typeof ensurePersonSession;
  ingestLogs?: typeof runLogIngestion;
  backfillBrave?: typeof backfillBraveCostEvents;
  latestBrave?: typeof latestBraveCostEventAt;
  rollup?: typeof rollupCosts;
}

export interface LifecycleSummary {
  pairing: { checked: number; paired: number; rowErrors: number } | { stepError: string };
  offboarding: ExpireResult | { stepError: string };
  sessions:
    | { checked: number; created: number; rowErrors: number }
    | { skipped: string }
    | { stepError: string };
  logIngest: LogIngestSummary | { skipped: string } | { stepError: string };
  braveBackfill: { scanned: number; since: string } | { skipped: string } | { stepError: string };
  costRollup:
    | { months: string[]; rowsWritten: number; tenantsTouched: number; unpricedEvents: number }
    | { skipped: string }
    | { stepError: string };
  ok: boolean;
}

// Overlap re-read on top of the watermark: enough to absorb clock skew and rows
// that landed out of order, and free to repeat because the
// (tenant, provider, sku, source_ref) key makes a replay a no-op.
const BRAVE_OVERLAP_MS = 60 * 60 * 1000; // 1h
// Where to start when the ledger holds no Brave events yet — i.e. the very first
// run after the migration lands. A fixed look-back window here would silently
// bill only the last few hours and abandon every earlier search in web_requests.
const BRAVE_BACKFILL_EPOCH = '2026-07-01T00:00:00.000Z';

const monthStart = (iso: string): string => `${iso.slice(0, 7)}-01`;
const previousMonthStart = (iso: string): string => {
  const d = new Date(`${monthStart(iso)}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 10);
};

const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function runLifecycle(
  nowIso: string,
  deps: LifecycleDeps = {},
): Promise<LifecycleSummary> {
  const listInStates = deps.listInStates ?? listTechniciansInStates;
  const check = deps.checkPairing ?? checkPairing;
  const expire = deps.expire ?? expireOffboarding;
  const ensureSession = deps.ensureSession ?? ensurePersonSession;
  const ingestLogs = deps.ingestLogs ?? runLogIngestion;
  const backfillBrave = deps.backfillBrave ?? backfillBraveCostEvents;
  const latestBrave = deps.latestBrave ?? latestBraveCostEventAt;
  const rollup = deps.rollup ?? rollupCosts;
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

  // 3. Session provisioning sweep — every ACTIVE row gets its tier-scoped
  // Composio session. GATED on the key: a cron deployed without
  // COMPOSIO_API_KEY skips cleanly (the sheet-sync pattern) instead of
  // failing every row and turning the heartbeat permanently red.
  let sessions: LifecycleSummary['sessions'];
  if (!process.env.COMPOSIO_API_KEY) {
    sessions = { skipped: 'COMPOSIO_API_KEY unset' };
  } else {
    try {
      // Seat-exempt rows are 'active' but have no agent — never mint them a
      // Composio session (they are schedule-only names, user decision 2026-07-19).
      const rows = (await listInStates(['active'])).filter((r) => !r.seat_exempt);
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

  // 4. Execution-log ingestion — the manager-action audit into L1. Same key
  // gate as step 3; per-row failures are inside the summary (the overlapping
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

  // 5. Brave cost backfill — web_requests already logs every search with its
  // tenant, so the ledger is replayed from it rather than instrumented live.
  // Returns rows SCANNED: the upsert ignores duplicates, so a steady tick
  // re-reads its window and inserts nothing.
  let braveBackfill: LifecycleSummary['braveBackfill'];
  try {
    // Watermarked, not a fixed window: the first run after the migration must
    // sweep everything web_requests already holds, and a cron outage of any
    // length must not leave a permanent hole in the ledger.
    const watermark = await latestBrave();
    const since = watermark
      ? new Date(Date.parse(watermark) - BRAVE_OVERLAP_MS).toISOString()
      : BRAVE_BACKFILL_EPOCH;
    braveBackfill = { ...(await backfillBrave(since)), since };
  } catch (err) {
    // Not-yet-migrated is EXPECTED between this phase merging and the pilot
    // migration landing — report it as skipped, or the heartbeat goes red every
    // 15 minutes for a condition that resolves itself.
    braveBackfill = isMissingCostLedger(err)
      ? { skipped: 'cost ledger not migrated here yet' }
      : { stepError: msg(err) };
    if (!isMissingCostLedger(err)) ok = false;
  }

  // 6. Cost rollup — units x rates, plus the monthly-bill allocation, for the
  // CURRENT month. Idempotent (it recomputes the period), so every tick simply
  // refreshes what the dashboard reads.
  let costRollup: LifecycleSummary['costRollup'];
  try {
    // BOTH the current month and the previous one. Invoices arrive after the
    // month they cover — the July DeepInfra bill is entered in August — so a
    // current-month-only rollup would never allocate a completed month's
    // inference cost at all, which is the entire allocated-cost mechanism.
    // Rate corrections land late for the same reason. The recompute is
    // idempotent, so re-running a settled month is free.
    const months = [monthStart(nowIso), previousMonthStart(nowIso)];
    const totals = { months, rowsWritten: 0, tenantsTouched: 0, unpricedEvents: 0 };
    for (const month of months) {
      const r = await rollup(month);
      totals.rowsWritten += r.rowsWritten;
      totals.unpricedEvents += r.unpricedEvents;
      totals.tenantsTouched = Math.max(totals.tenantsTouched, r.tenantsTouched);
    }
    costRollup = totals;
  } catch (err) {
    costRollup = isMissingCostLedger(err)
      ? { skipped: 'cost ledger not migrated here yet' }
      : { stepError: msg(err) };
    if (!isMissingCostLedger(err)) ok = false;
  }

  return { pairing, offboarding, sessions, logIngest, braveBackfill, costRollup, ok };
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
