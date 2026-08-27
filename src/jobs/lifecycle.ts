import { fileURLToPath } from 'node:url';
import {
  backfillBraveCostEvents,
  isMissingCostLedger,
  latestBraveCostEventAt,
  listTechniciansInStates,
  rollupCosts,
} from '../db/index.js';
import { insertLifecycleRun, pruneLifecycleRuns } from '../db/lifecycleRuns.js';
import type { Json } from '../db/database.types.js';
import { checkPairing } from '../composio/pairing.js';
import { expireOffboarding, type ExpireResult } from '../composio/offboarding.js';
import { ensurePersonSession } from '../composio/sessions.js';
import { runLogIngestion, type LogIngestSummary } from '../composio/logIngest.js';
import { runGapSummaries, type SummarizeSummary } from './summarize.js';
import { runReflector, type ReflectorMode, type ReflectorSummary } from '../teamLead/reflector.js';
import { runWatchers, type WatchersSummary } from './watchers.js';
import { runPlanner, type PlannerMode, type PlannerSummary } from '../teamLead/planner.js';
import { TEAM_LEAD_REF } from '../teamLead/identity.js';
import { dispatchForIdentity, TEAM_LEAD_TOOL_SCHEMAS } from '../mcp/server.js';
import { hasModelCredentials } from '../model/forcedTool.js';

// The lifecycle heartbeat — the ONE scheduled entrypoint (Render Cron Job,
// */5 * * * *; Render guarantees at most one concurrent run). CADENCE GATE
// (user decision 2026-08-16): the schedule is 5-minutely for the WATCHER lane
// only — steps 1-7 still run on quarter-hour ticks (getUTCMinutes() % 15 < 5,
// tolerant of small firing delays; stateless, no new env), because step 4
// calls an outside vendor every time it runs and gains nothing from frequency,
// while step 8 is SQL-only and wants the faster pulse (auto-resolve clears a
// flagged gap within ~5 min of the field note arriving). Everything here is a
// sweep over durable state, so a missed or doubled tick is safe:
// (1) notice completed OAuth consents and advance those rows;
// (2) run the grace-period expiry (reminders + permanent teardown);
// (3) ensure every ACTIVE person has their tier-scoped Composio session
//     (self-healing, ≤15-min latency; skipped cleanly when COMPOSIO_API_KEY
//     is unset so a cron deployed without the key never goes permanently red);
// (4) ingest Composio execution logs into L1 (the manager-action audit; same
//     key gate, overlapping 60-min window so a missed tick loses nothing);
// (5) replay Brave searches from web_requests into the cost ledger;
// (6) RETIRED 2026-08-19 — was the DeepInfra bill pull. The step numbers below are kept
//     as-is rather than renumbered: the cron's JSON FIELD NAMES are the stable reference,
//     and renumbering would silently invalidate every runbook that cites a step number;
// (7) recompute the current month's per-tenant cost rollup (idempotent);
// (8) the watcher (plan 2026-08-15 features A+B): deterministic overdue-visit
//     gap detection + the Stage-1 ladder — runs EVERY tick, gated on
//     WATCHERS_MODE (unset = skipped; 'shadow' = count only; 'live' = act;
//     anything else = LOUD stepError — a config typo must never be silently
//     off). NUDGES_MODE gates the ladder within live: unset = 'off' silently
//     (rung 1 is optional — the Stage-0 behavior needs no new env), 'shadow'
//     counts would-be nudges, 'live' asks technicians first; any other value
//     is the same LOUD stepError.
// (9) the team-lead PLANNER (plan 2026-08-19): one agentic call per firm per
//     half-hour that decides pacing, closure and escalation — and, since the
//     collapse (plan 2026-08-24), WRITES the technician's question and queues it
//     itself. It is the ladder's only model call. Gated on PLANNER_MODE alone —
//     NOT on NUDGES_MODE;
// (10) the MUTE check (the collapse): the compose turn that used to sit here is
//     gone, so a live ladder with a non-live planner mints gaps nobody can ask
//     about. That state is reported, never made red — a rollback is a choice.
// Steps 5 and 7 report `skipped` — not an error — when the cost tables are absent,
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
  runWatchers?: typeof runWatchers;
  runPlanner?: typeof runPlanner;
  summarize?: typeof runGapSummaries;
  reflect?: typeof runReflector;
  prune?: typeof pruneLifecycleRuns;
  // Seam so the skip branch is testable without setting a real key.
  hasModelKey?: () => boolean;
}

export interface LifecycleSummary {
  pairing:
    | { checked: number; paired: number; rowErrors: number }
    | { skipped: string }
    | { stepError: string };
  offboarding: ExpireResult | { skipped: string } | { stepError: string };
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
  // The 90-day prune of this cron's OWN run records. Reported like every other
  // step so a prune that has been quietly failing is visible in the same place
  // the rows it prunes are read from.
  lifecycleRuns:
    | { pruned: number; before: string }
    | { skipped: string }
    | { stepError: string };
  watchers: WatchersSummary | { skipped: string } | { stepError: string };
  teamLeadPlanner: PlannerSummary | { skipped: string } | { stepError: string };
  // The ladder cannot speak (the collapse, plan 2026-08-24): NUDGES_MODE is
  // live so gaps are being minted, but the PLANNER — the only author of a
  // question since compose retired — is not. Present only when true, so a
  // healthy tick's report is unchanged.
  ladderMute?: string;
  gapSummaries: SummarizeSummary | { skipped: string } | { stepError: string };
  reflector: ReflectorSummary | { skipped: string } | { stepError: string };
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

// How long a tick's own record is kept. Deliberately longer than Render's log
// horizon (~30d on the starter plan) so the database outlives the log stream it
// replaces, and short enough to bound the table: 288 ticks/day x 90 days is
// ~26k rows. Env-overridable for an operator who wants a longer window; a
// non-numeric or non-positive value falls back to the default rather than
// deleting everything (fail-closed on the destructive axis).
const DEFAULT_RUN_RETENTION_DAYS = 90;
const runRetentionDays = (): number => {
  const raw = Number(process.env.LIFECYCLE_RUN_RETENTION_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_RUN_RETENTION_DAYS;
};

// How much of a step's error text the run record keeps. The stdout line carries
// it in full; this is a durable row, and an unbounded provider stack trace has
// no business growing a JSONB column without limit.
//
// NOTE what this cap is and is not. It bounds SIZE; it does not redact. A step
// error is a vendor or Postgres message, and those can incidentally echo values
// — a 23505 quotes the conflicting key, a Composio 4xx can quote a payload — so
// a run record MAY contain an identifier that arrived inside an error string.
// Kept anyway, deliberately: an error you cannot read is a step you cannot fix,
// and the same text already goes to stdout. What the row is guaranteed free of
// is the planner's own free text (the question, the citation, the reasoning),
// which is the bulk, is customer-authored, and is stripped structurally below.
// The migration header states the guarantee in exactly these terms.
const RECORD_STEP_ERROR_CHARS = 500;

// Ceiling on the record write. Deliberately far below Render's 5-minute cadence
// so a hung database can never delay the next tick.
const RECORD_TIMEOUT_MS = 10_000;

// What the run record is ALLOWED to hold. The tick summary's richest field —
// teamLeadPlanner.plans[].decisions / .dropped — carries the question written to
// a technician, the quoted words of their reply, and the model's reasoning. A
// lifecycle_runs row has NO tenant_id (one tick sweeps every firm), so that text
// would sit outside the tenant boundary and survive the firm being deleted. It
// is already stored correctly, scoped to its firm, in nudge_decisions.
//
// So: arrays become their COUNTS, every other field passes through, and step
// errors are capped. Anything added to LifecycleSummary later that carries free
// text must be handled here too.
export function redactForRecord(summary: LifecycleSummary): Json {
  const copy = JSON.parse(JSON.stringify(summary)) as Record<string, unknown>;
  for (const value of Object.values(copy)) {
    if (!value || typeof value !== 'object') continue;
    const step = value as { stepError?: unknown };
    if (typeof step.stepError === 'string') {
      step.stepError = step.stepError.slice(0, RECORD_STEP_ERROR_CHARS);
    }
  }
  const planner = copy.teamLeadPlanner as { plans?: unknown } | null | undefined;
  if (planner && Array.isArray(planner.plans)) {
    planner.plans = (planner.plans as Record<string, unknown>[]).map((plan) => ({
      ...plan,
      // Guarded rather than a bare `.length`: if a future shape stops making
      // these arrays, the field passes through unchanged instead of becoming
      // undefined and vanishing from the JSON.
      decisions: Array.isArray(plan.decisions) ? plan.decisions.length : plan.decisions,
      dropped: Array.isArray(plan.dropped) ? plan.dropped.length : plan.dropped,
    }));
  }
  return copy as Json;
}

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

  // CADENCE GATE (user decision 2026-08-16): on the */5 schedule, steps 1-7
  // run only on quarter-hour ticks — `< 5` (not `=== 0`) tolerates a delayed
  // firing (a :15 tick that starts at :16 still counts). Stateless: the minute
  // itself is the state. Step 8 runs every tick.
  const heavyTick = new Date(nowIso).getUTCMinutes() % 15 < 5;
  const OFF_CADENCE = { skipped: 'off-cadence tick' };

  // ONE gate for steps 1-7 (final-review finding: seven copy-pasted per-step
  // gates invite a future step 9 that forgets its gate and silently runs a
  // vendor-calling sweep every 5 minutes). All seven default to skipped; the
  // heavy block below overwrites them on quarter-hour ticks.
  let pairing: LifecycleSummary['pairing'] = OFF_CADENCE;
  let offboarding: LifecycleSummary['offboarding'] = OFF_CADENCE;
  let sessions: LifecycleSummary['sessions'] = OFF_CADENCE;
  let logIngest: LifecycleSummary['logIngest'] = OFF_CADENCE;
  let braveBackfill: LifecycleSummary['braveBackfill'] = OFF_CADENCE;
  let costRollup: LifecycleSummary['costRollup'] = OFF_CADENCE;
  let lifecycleRuns: LifecycleSummary['lifecycleRuns'] = OFF_CADENCE;

  if (heavyTick) {
  // 1. Pairing sweep — only rows a link was ever issued for (checkPairing
  // itself no-ops on anything not 'invited', so the pending_verification rows
  // in the sweep are just cheap confirmations the item is still with the
  // manager). Per-row failures are retried next tick, not run failures.
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

  // (The DeepInfra bill pull lived here until 2026-08-19. DeepInfra was retired as an
  // inference provider, so there was no longer an invoice for it to collect. NOTE the gap it
  // leaves: nothing collects the FIREWORKS invoice, so the allocated agent-inference line
  // reads $0 until a collector exists — which is the exact silent-underreport the old
  // collector was written to prevent. Its historical rows are untouched and still priced;
  // `cost_rates` keeps its deepinfra entries for precisely that reason.)

  // 7. Cost rollup — units x rates, plus the monthly-bill allocation, for the
  // CURRENT month. Idempotent (it recomputes the period), so every tick simply
  // refreshes what the dashboard reads.
  try {
    // BOTH the current month and the previous one. Invoices arrive after the
    // month they cover — a July inference bill is entered in August — so a
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
  // The run-record prune. Deliberately NOT renumbered into the step sequence:
  // lifecycle.ts's header records that the JSON FIELD NAMES are the stable
  // reference and that renumbering silently invalidates every runbook citing a
  // step number (that is why the retired step 6 left a hole). It lives in the
  // heavy block because it is a slow-moving sweep that gains nothing from
  // running every five minutes — the same reasoning as steps 1-7.
  //
  // Missing table -> skipped, never red: this code can deploy before its
  // migration is applied by hand (deploys do not migrate), and a heartbeat that
  // goes red every 15 minutes for a self-resolving condition trains people to
  // ignore it. The braveBackfill idiom, verbatim.
  try {
    const before = new Date(
      Date.parse(nowIso) - runRetentionDays() * 24 * 60 * 60 * 1000,
    ).toISOString();
    lifecycleRuns = { pruned: await (deps.prune ?? pruneLifecycleRuns)(before), before };
  } catch (err) {
    lifecycleRuns = isMissingCostLedger(err)
      ? { skipped: 'lifecycle_runs not migrated here yet' }
      : { stepError: msg(err) };
    if (!isMissingCostLedger(err)) ok = false;
  }
  } // end of the steps 1-7 heavy-tick block

  // 8. The Stage-0 watcher — EVERY tick (SQL-only; the reason the schedule is
  // */5 at all). Unset WATCHERS_MODE skips cleanly (the COMPOSIO_API_KEY
  // precedent: a cron deployed before the var is chosen never goes red); any
  // value other than shadow|live is a LOUD stepError — a config typo must
  // never read as "watchers quietly off".
  let watchers: LifecycleSummary['watchers'];
  const watchersMode = process.env.WATCHERS_MODE;
  // NUDGES_MODE: unset is a VALID state ('off' — rung 1 simply not enabled,
  // unlike WATCHERS_MODE where unset means the whole step is dark), but a
  // typo is the same loud failure. Checked only when the step actually runs.
  const nudgesModeRaw = process.env.NUDGES_MODE;
  const nudgeMode =
    !nudgesModeRaw ? ('off' as const)
    : nudgesModeRaw === 'shadow' || nudgesModeRaw === 'live' ? nudgesModeRaw
    : null;
  if (!watchersMode) {
    watchers = { skipped: 'WATCHERS_MODE unset (shadow|live)' };
  } else if (watchersMode !== 'shadow' && watchersMode !== 'live') {
    watchers = { stepError: `WATCHERS_MODE must be 'shadow' or 'live', got '${watchersMode}'` };
    ok = false;
  } else if (nudgeMode === null) {
    watchers = {
      stepError: `NUDGES_MODE must be 'shadow' or 'live' when set, got '${nudgesModeRaw}'`,
    };
    ok = false;
  } else {
    try {
      const summary = await (deps.runWatchers ?? runWatchers)(nowIso, watchersMode, {}, nudgeMode);
      watchers = summary;
      // EVERY tenant failing is systemic (DB down, bad schema), not row blips —
      // the pairing-sweep detector shape.
      if (summary.tenants > 0 && summary.tenantErrors === summary.tenants) ok = false;
    } catch (err) {
      watchers = { stepError: msg(err) };
      ok = false;
    }
  }

  // 9. The team-lead PLANNER (plan 2026-08-19, Phase 3) — the half-hour tick,
  // and since the collapse it writes and queues the question itself, so a send
  // it decides is deliverable the moment the tick ends. Same stateless cadence
  // trick as heavyTick above: the
  // minute is the state, and `< 5` tolerates a delayed firing. On a */5 schedule
  // that is :00 and :30, never twice.
  //
  // PLANNER_MODE follows the NUDGES_MODE contract exactly: unset is a VALID
  // 'off' (a cron deployed before the var is chosen must not go red), and any
  // other value is a LOUD stepError, because a config typo must never read as
  // "the planner is quietly off".
  //
  // NOT gated on NUDGES_MODE — deliberate. The planner
  // follows the SWEEP's rollback-rescue doctrine (watchers.ts: in-flight rows
  // keep their lifecycle regardless of NUDGES_MODE, because silence must always
  // escalate), not compose's creation gate. Consequence to hold: with the ladder
  // rolled back and PLANNER_MODE on, the planner still makes a billed call for
  // any tenant that still has open rows. It skips tenants with none.
  const plannerTick = new Date(nowIso).getUTCMinutes() % 30 < 5;
  const plannerModeRaw = process.env.PLANNER_MODE;
  const plannerMode: PlannerMode | null =
    !plannerModeRaw ? 'off'
    : plannerModeRaw === 'off' || plannerModeRaw === 'shadow' || plannerModeRaw === 'live'
      ? plannerModeRaw
      : null;
  let teamLeadPlanner: LifecycleSummary['teamLeadPlanner'];
  if (plannerMode === null) {
    teamLeadPlanner = {
      stepError: `PLANNER_MODE must be 'off', 'shadow' or 'live', got '${plannerModeRaw}'`,
    };
    ok = false;
  } else if (plannerMode === 'off') {
    teamLeadPlanner = { skipped: "PLANNER_MODE 'off'" };
  } else if (!plannerTick) {
    teamLeadPlanner = { skipped: 'off-cadence tick (planner runs on the half hour)' };
  } else if (!(deps.hasModelKey ?? hasModelCredentials)()) {
    teamLeadPlanner = { skipped: 'no inference credentials' };
  } else {
    try {
      teamLeadPlanner = await (deps.runPlanner ?? runPlanner)(nowIso, plannerMode, {
        tools: [...TEAM_LEAD_TOOL_SCHEMAS],
        // The planner's `escalate` only moves a deadline — the SWEEP inside
        // step 8 performs the handoff, and it reads nothing unless the watcher
        // is live. Deliberately decoupling the planner's gate from the ladder
        // (see above) means this combination is reachable: watcher rolled back
        // to shadow, planner still on. Without this the escalation would write
        // its row, log `applied`, and reach nobody.
        sweepLive: watchersMode === 'live',
        // The identity is minted PER TENANT, from the tenant the planner is
        // currently walking — never bound once for the process.
        execute: (tenantId, name, args) =>
          dispatchForIdentity(name, args, { tenantId, technicianRef: TEAM_LEAD_REF }),
      });
    } catch (err) {
      teamLeadPlanner = { stepError: msg(err) };
      ok = false;
    }
  }

  // 10. THE MUTE CHECK (the collapse, plan 2026-08-24). The compose turn used to
  // live here and was the ladder's voice whenever the planner was off. It is
  // gone: the planner writes every question now and queues it itself, so this
  // combination — gaps being minted with no author for them — is a real
  // operational state that must be visible rather than silently quiet.
  //
  // Deliberately NOT an `ok = false`: a rollback to PLANNER_MODE=off is a
  // legitimate operator choice, and turning the cron red would train people to
  // ignore it. The floor is the sweep's 18h never-asked handoff — but only when
  // the SWEEP is live too (watchers.ts gates its open-nudge read on
  // WATCHERS_MODE === 'live'), so the wording says which case this is.
  let ladderMute: string | undefined;
  if (nudgeMode === 'live') {
    // Two ways to be voiceless, and the credential one is easy to miss: it used
    // to surface as compose's own `skipped: no inference credentials`, and with
    // compose gone it would otherwise read as a mere planner skip.
    const why =
      plannerMode !== 'live'
        ? 'PLANNER_MODE is not live'
        : !(deps.hasModelKey ?? hasModelCredentials)()
          ? 'the planner has no inference credentials'
          : null;
    if (why) {
      ladderMute =
        watchersMode === 'live'
          ? `NUDGES_MODE=live but ${why} — gaps are detected and nobody writes the questions; ` +
            'the 18h never-asked sweep hands them to managers'
          : `NUDGES_MODE=live but ${why} and WATCHERS_MODE is not live — gaps are detected, ` +
            'nobody writes the questions, and NO backstop sweep is running';
      console.error(`[lifecycle] LADDER IS MUTE: ${ladderMute}`);
    }
  }

  // 11. Gap-life summaries (⑤ Phase 2): one code-written row per closed gap —
  // the planner's experience corpus. AFTER the planner, so a gap that closed
  // this very tick is summarizable next tick at the latest. Ungated by mode flags:
  // it writes history, and history is wanted whether or not the ladder is
  // live. Missing table → skipped, never red (the braveBackfill idiom: code
  // can deploy before its migration on a lagging environment).
  let gapSummaries: LifecycleSummary['gapSummaries'];
  try {
    gapSummaries = await (deps.summarize ?? runGapSummaries)(nowIso);
  } catch (err) {
    gapSummaries = isMissingCostLedger(err)
      ? { skipped: 'gap_summaries not migrated here yet' }
      : { stepError: msg(err) };
    if (!isMissingCostLedger(err)) ok = false;
  }

  // 12. The Reflector (⑤ Phase 4) — the distiller, dark. REFLECTOR_MODE
  // follows the PLANNER_MODE contract verbatim: unset = 'off' silently (a
  // cron deployed before the var is chosen must not go red), bad value =
  // LOUD stepError. 'live' is shadow-equivalent in this plan (activation
  // stays human); the per-tenant gate inside owns dailiness and thresholds.
  const reflectorModeRaw = process.env.REFLECTOR_MODE;
  const reflectorMode: ReflectorMode | null =
    !reflectorModeRaw ? 'off'
    : reflectorModeRaw === 'off' || reflectorModeRaw === 'shadow' || reflectorModeRaw === 'live'
      ? reflectorModeRaw
      : null;
  let reflector: LifecycleSummary['reflector'];
  if (reflectorMode === null) {
    reflector = {
      stepError: `REFLECTOR_MODE must be 'off', 'shadow' or 'live', got '${reflectorModeRaw}'`,
    };
    ok = false;
  } else if (reflectorMode === 'off') {
    reflector = { skipped: "REFLECTOR_MODE 'off'" };
  } else if (!(deps.hasModelKey ?? hasModelCredentials)()) {
    reflector = { skipped: 'no inference credentials' };
  } else {
    try {
      reflector = await (deps.reflect ?? runReflector)(nowIso, reflectorMode);
    } catch (err) {
      reflector = isMissingCostLedger(err)
        ? { skipped: 'reflector tables not migrated here yet' }
        : { stepError: msg(err) };
      if (!isMissingCostLedger(err)) ok = false;
    }
  }

  return {
    pairing,
    offboarding,
    sessions,
    logIngest,
    braveBackfill,
    costRollup,
    lifecycleRuns,
    watchers,
    teamLeadPlanner,
    ...(ladderMute ? { ladderMute } : {}),
    gapSummaries,
    reflector,
    ok,
  };
}

async function main(): Promise<void> {
  // Captured BEFORE the sweep and handed to both runLifecycle and the record, so
  // the row's started_at is the exact instant the cadence gates read — not a
  // second clock that could disagree with the decisions the tick made.
  const startedAt = new Date().toISOString();
  const summary = await runLifecycle(startedAt);
  // Drain stdout BEFORE exiting: on a pipe (Render cron logs) process.exit
  // tears the process down without flushing async writes, losing the one
  // diagnostic line exactly on the failed runs that need it (review finding).
  await new Promise<void>((resolve) => {
    process.stdout.write(JSON.stringify(summary) + '\n', () => resolve());
  });
  // The durable record — written AFTER stdout and outside runLifecycle, in that
  // order for two reasons. After stdout: a database that is down must not cost
  // us the one diagnostic line, which is exactly what a failing tick needs.
  // Outside runLifecycle: the summary has to be complete before it can be
  // recorded, and keeping the write here leaves runLifecycle a pure function of
  // its injected deps.
  //
  // NEVER changes the exit code. A failed record is a lost observation; a tick
  // turned red by its own bookkeeping is a false alarm about the work itself,
  // and the work already succeeded or failed on its own terms above.
  try {
    // TIMED OUT, not merely awaited. Render runs at most one lifecycle cron at a
    // time and SKIPS an overlapping firing, so a Supabase that hangs rather than
    // fails would hold this process open (undici's default is 300s = five whole
    // ticks) and suppress the next runs — the bookkeeping write manufacturing
    // the exact gap the record exists to expose. Losing one observation beats
    // losing five ticks of work.
    await Promise.race([
      insertLifecycleRun({
        startedAt,
      // The app's clock at both ends — the same clock cost_events.occurred_at
      // carries — so [started_at, finished_at] and the spend inside it are
      // measured against one timeline. See the accessor for why.
      finishedAt: new Date().toISOString(),
        ok: summary.ok,
        summary: redactForRecord(summary),
      }),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`run record timed out after ${RECORD_TIMEOUT_MS}ms`)),
          RECORD_TIMEOUT_MS,
        ).unref(),
      ),
    ]);
  } catch (err) {
    console.error('[lifecycle] could not record this run', err);
  }
  process.exit(summary.ok ? 0 : 1);
}

// Run only when executed directly (node dist/jobs/lifecycle.js), not on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
