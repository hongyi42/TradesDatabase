// Spine-eval STEP 0 — build the world.
//
//   npm run spine-eval:world                    # anchor = today, firm-local
//   npm run spine-eval:world -- --anchor 2026-12-28 --seed 3
//
// Walks the declarative spec from src/eval/worldSpec.ts and writes it through the
// TYPED db layer, so provenance links, L3 standing-fact bundles and status
// transitions all follow the same paths the app itself uses. The only raw SQL is
// the reset (the db layer exposes no delete — L1 is append-only — and TRUNCATE
// does not fire the row-level append-only trigger).
//
// TWO MODES, and they behave very differently on purpose:
//
//   (default) LOCAL  — fail-closed to 127.0.0.1 (lib/env.mjs). Destructive by
//                      design: truncates the spine tables, which also clears
//                      whatever `npm run seed:local` last put there. Same
//                      contract the test suite already has with this database.
//
//   --pilot --yes     TIER 3. Writes to the deployed pilot, because the openclaw
//                      gateway only exists on trades-box-1 and its sandboxes read
//                      the pilot through the doorman. Here the rules invert:
//                        * NOTHING is truncated — assertTruncationAllowed()
//                          throws rather than returning false, so the truncating
//                          path is unreachable, not merely unused.
//                        * The tenant is STABLE and reused across runs. Not a
//                          preference: the doorman badge is keyed to
//                          (tenantId, technicianRef), so a fresh tenant per run
//                          would mean minting a badge and restarting a container
//                          on every rebuild.
//                        * A rebuild deletes only this tenant's L2 rows.
//                          raw_captures' provenance FKs are `on delete set null`
//                          (context_spine migration), so captures SURVIVE a
//                          rebuild with their links nulled.
//                        * L1 therefore ACCUMULATES, permanently, and the run
//                          says so out loud. raw_captures has no delete path and
//                          the tenant itself can never be deleted once it holds
//                          captures — a tenant delete would cascade into L1 and
//                          hit the append-only trigger.
//                        * Shared infra (hosts, sandbox_pool) is NOT touched:
//                          the real control plane and badge pull read those.
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import pg from 'pg';
import { requireLocalStack, requirePilotStack, argOf, hasFlag } from './lib/env.mjs';
import {
  assertEvalTenant,
  assertTruncationAllowed,
  EVAL_CAPTURE_MARKER,
  EVAL_COMPOSIO_SENTINEL,
  evalTenantName,
} from '../../dist/eval/pilotGuard.js';
import { buildWorldSpec } from '../../dist/eval/worldSpec.js';
import { firmToday, titleWeekday } from '../../dist/eval/clock.js';
import {
  addTimeOff,
  appendRawCapture,
  createAssignment,
  createCustomer,
  createJob,
  createTenant,
  insertTechnician,
  setTechnicianAvailability,
  setTechnicianHorizonDays,
  setTechnicianServiceCities,
  setTechnicianSkills,
  setTechnicianState,
  updateTechnician,
  updateJobStatus,
  upsertJobTypeDuration,
  createHost,
  registerSandbox,
} from '../../dist/db/index.js';

const MODE = hasFlag('pilot') ? 'pilot' : 'local';

console.log(`\n=== SPINE EVAL — BUILD WORLD (${MODE}) ===`);
const { dbUrl } = MODE === 'pilot' ? requirePilotStack() : requireLocalStack();

// In pilot mode only the tenants tier 3 actually drives are built. `seats` is a
// tier-1 mechanical fixture and tier 1 stays local, so writing it to the pilot
// would be permanent footprint bought for nothing. (`freeze` and `resolve` were
// two more until rung 8 deleted the solver they existed for.)
// `other` stays: the cross-tenant isolation scenarios are among the most valuable
// things tier 3 can check, and they need a second tenant to fail against.
const PILOT_TENANT_KEYS = ['main', 'other'];

const OUT_DIR = argOf('out', join(process.cwd(), 'spine-eval-runs'));
const SEED = Number(argOf('seed', '7'));
const TIMEZONE = 'America/Los_Angeles';
const ANCHOR = argOf('anchor', firmToday(TIMEZONE));

const spec = buildWorldSpec({ anchor: ANCHOR, seed: SEED });
console.log(`  anchor: ${titleWeekday(spec.anchor)} ${spec.anchor}   seed: ${SEED}`);
console.log(`  span:   ${spec.span.from} → ${spec.span.to}`);

// ── reset ──────────────────────────────────────────────────────────────────────
// Only tables that actually exist are touched, so this same script works in a
// worktree whose local stack is a migration or two behind.
// lifecycle_runs is DELIBERATELY EXCLUDED from both lists below (eng-memory §1
// registration): it is the cron's own tenant-agnostic execution log, holds no
// customer-derived text and has no tenant FK to dangle, so rebuilding a world
// must not erase the record of whether the heartbeat has been ticking.
const RESET_TABLES = [
  'customers',
  'jobs',
  'visits',
  'raw_captures',
  'schedule_entries',
  'dropped_audit',
  'assignments',
  'technician_time_off',
  'job_type_durations',
  'schedule_events',
  'technicians',
  'review_items',
  'cost_events',
  'query_audit',
  // References only tenants (no cascade path reaches it), and its FK is NO
  // ACTION — left out, one C10 run would pin the Eval tenants forever and the
  // reset's `delete from tenants` below would die on 23503 (review finding).
  'tenant_profiles',
  // Same trap as tenant_profiles: references ONLY tenants. The FK IS `on delete
  // cascade`, so the reset would not die on 23503 — the failure would be SILENT
  // instead, a stale settings row surviving a world rebuild and quietly changing
  // that firm's detector thresholds and planner cadence in the next eval run.
  // Registered BY NAME (eng-memory §1).
  'tenant_settings',
  // The planner's memory (build 3), which replaced planner_lessons. Same trap as
  // tenant_profiles above: tenants-only FKs, and planner_memory_versions hangs
  // off no table at all, so NO cascade reaches any of the three. Registered BY
  // NAME (eng-memory §1). A stale MEMORY.md surviving a rebuild would put the
  // previous world's conclusions into the rebuilt firm's very first prompt.
  'planner_memory',
  'planner_memory_versions',
  'planner_runs',
  // The planner's per-job notepads (build: job notepads, 2026-08-30). These DO
  // cascade from jobs — named anyway (eng-memory §1).
  'job_notes',
  'job_note_versions',
  'nudges',
  // observations (build 4): the nudges trap exactly — tenants/technicians FKs
  // only, no cascade reaches it, and stale any-status rows suppress fresh
  // detections through the once-ever dedup. Registered BY NAME at creation
  // (eng-memory §1). Its decision rows cascade FROM it, but nudge_decisions is
  // named below anyway.
  'observations',
  // office_messages (build 5.5, the planner's inbox): tenants/technicians FKs
  // only — the technicians truncate above WOULD cascade-wipe it incidentally,
  // which is exactly the coverage eng-memory §1 forbids relying on. Named so a
  // fresh world never inherits a previous run's unread informs (W14 writes one
  // per run) and the wipe is a decision, not an accident.
  'office_messages',
  // Cascades from nudges, named anyway (eng-memory §1).
  'nudge_decisions',
  // Infra, but the eval registers its own cold pool for bind_telegram, so stale
  // rows from a previous run would otherwise accumulate.
  'sandbox_pool',
  'hosts',
];

async function reset() {
  // Unreachable in pilot mode by construction, not by convention: this throws.
  assertTruncationAllowed(MODE);
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name = any($1::text[])`,
      [RESET_TABLES],
    );
    const present = rows.map((r) => r.table_name);
    await client.query(`truncate table ${present.join(', ')} cascade`);
    // The eval's own tenants go too, or every run would stack another five.
    // `Default Tenant` is left alone — seed.mjs owns it.
    const del = await client.query(`delete from tenants where name like 'Eval %'`);
    return { truncated: present.length, tenantsDropped: del.rowCount };
  } finally {
    await client.end();
  }
}

/**
 * Tables a pilot-mode rebuild clears, INSIDE one tenant, in FK-safe order.
 *
 * Not RESET_TABLES: three entries are deliberately absent.
 *   raw_captures — append-only, no delete path. Its provenance FKs are
 *                  `on delete set null`, so it survives this untouched.
 *   hosts,
 *   sandbox_pool — shared infra the real control plane and badge pull read. The
 *                  cold-pool fixture exists for tier 1's bind_telegram case, and
 *                  tier 1 stays local.
 *
 * tenant_profiles and tenant_settings are absent DELIBERATELY, and for the same
 * reason: both are firm CONFIGURATION, not demo data. A pilot rebuild replaces the
 * world a firm works in; it must not silently forget the firm's own letterhead or
 * its own detector thresholds. Both are in RESET_TABLES above, which is the
 * throwaway-eval-tenant path, where forgetting them is exactly what you want.
 */
const PILOT_TENANT_SCOPED = [
  'query_audit',
  'cost_events',
  'review_items',
  // Before technicians: nudges.technician_id is a NO ACTION FK, so the roster
  // delete below would 23503 and roll the whole rebuild back — and stale
  // any-status rows would permanently suppress asks on the rebuilt schedule
  // (the once-ever dedup). Phase-1 review finding (2026-08-16).
  // Before nudges: explicit, though the cascade FK would also carry it.
  'nudge_decisions',
  // The planner's memory (build 3) — see the note on the list above.
  'planner_memory',
  'planner_memory_versions',
  'planner_runs',
  // observations (build 4) and office_messages (build 5.5): the nudges trap
  // exactly — both carry NO ACTION technician FKs, so the roster delete below
  // would 23503 and roll the whole rebuild back the moment either holds a row
  // (office_messages' addressee CHECK makes that certain for any to_agent
  // message). observations was MISSED at build 4 and is registered here as
  // the catch-up (final review, 2026-08-31).
  'observations',
  'office_messages',
  // The planner's per-job notepads (build: job notepads, 2026-08-30). These DO
  // cascade from jobs — named anyway (eng-memory §1).
  'job_notes',
  'job_note_versions',
  'nudges',
  'schedule_events',
  'dropped_audit',
  'schedule_entries',
  'technician_time_off',
  'job_type_durations',
  // customers cascades → jobs → visits/assignments (context_spine + scheduling
  // migrations), so those need no explicit delete; listed last because the
  // cascade is what makes the order above safe.
  'customers',
  'technicians',
];

/**
 * Find-or-create the stable tier-3 tenant, then clear its L2 rows.
 *
 * Everything runs in ONE transaction: a half-cleared world is worse than no
 * world, because it grades as agent failure.
 */
async function resetPilotTenant(spec) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const byKey = {};
    let capturesBefore = 0;
    let created = 0;
    await client.query('begin');
    for (const key of PILOT_TENANT_KEYS) {
      const t = spec.tenants.find((x) => x.key === key);
      if (!t) throw new Error(`spec has no tenant '${key}'`);
      const name = evalTenantName(key);
      // Belt and braces: the guard is also applied at every write site, but a
      // name that cannot pass it should never reach a CREATE either.
      assertEvalTenant(name);

      const found = await client.query('select id from tenants where name = $1', [name]);
      let id = found.rows[0]?.id;
      if (!id) {
        const ins = await client.query(
          `insert into tenants (name, manager_seats, technician_seats) values ($1, $2, $3) returning id`,
          [name, t.managerSeats ?? 1, t.technicianSeats ?? 8],
        );
        id = ins.rows[0].id;
        created++;
      }
      byKey[key] = { id, name };

      const before = await client.query('select count(*)::int as n from raw_captures where tenant_id = $1', [id]);
      capturesBefore += Number(before.rows[0]?.n ?? 0);

      // A PILOT WORLD IS BUILD-ONCE, and this is where that gets discovered.
      //
      // raw_captures.customer_id/job_id/visit_id are `on delete set null`, so
      // deleting a customer UPDATES the referencing capture — and the append-only
      // trigger fires `before update OR delete`. So a stamped capture makes its
      // customer permanently undeletable: L1 pins L2. (The migration's own comment
      // about surviving the trigger refers to the OTHER direction,
      // customers.source_capture_id, which is on the mutable side.)
      //
      // Detected up front and explained, because the raw failure is the bare
      // string "raw_captures is append-only" from a delete that looks unrelated.
      const pinned = await client.query(
        `select count(*)::int as n from raw_captures
          where tenant_id = $1 and (customer_id is not null or job_id is not null or visit_id is not null)`,
        [id],
      );
      if (Number(pinned.rows[0]?.n ?? 0) > 0) {
        throw new Error(
          `tenant '${name}' is SEALED and cannot be rebuilt.\n` +
            `  ${pinned.rows[0].n} permanent L1 capture(s) reference its customers/jobs/visits, and\n` +
            `  clearing that reference is an UPDATE on raw_captures, which the append-only trigger\n` +
            `  refuses. L1 pins L2: those rows are undeletable for the life of the database.\n\n` +
            `  This is not a bug to work around — dropping the stamps instead would gut\n` +
            `  get_customer_context (src/db/context.ts reads them as a customer's evidence).\n\n` +
            `  To re-anchor an existing pilot world, SHIFT it rather than rebuild it: visit dates are\n` +
            `  the only anchor-dependent part, and assignments are mutable. Whole-week shifts only\n` +
            `  (weekday alignment), in two passes (no_confirmed_overlap is a non-deferrable GiST\n` +
            `  exclusion, so a single-pass uniform shift transiently collides).\n` +
            `  To start clean, build into a NEW tenant — which needs its own badge and a container\n` +
            `  restart, since credentials inject at launch only.`,
        );
      }

      for (const table of PILOT_TENANT_SCOPED) {
        const exists = await client.query(
          `select 1 from information_schema.tables where table_schema='public' and table_name=$1`,
          [table],
        );
        if (!exists.rowCount) continue;
        const hasTenant = await client.query(
          `select 1 from information_schema.columns
            where table_schema='public' and table_name=$1 and column_name='tenant_id'`,
          [table],
        );
        // A table without tenant_id cannot be cleared safely here — skip it
        // loudly rather than widening the delete to every tenant.
        if (!hasTenant.rowCount) {
          console.log(`  note:   ${table} has no tenant_id column — left alone`);
          continue;
        }
        await client.query(`delete from ${table} where tenant_id = $1`, [id]);
      }
    }
    await client.query('commit');
    return { tenants: byKey, capturesBefore, created };
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

/** Permanent L1 rows this tenant now holds — reported so the growth is visible. */
async function countCaptures(tenantIds) {
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const { rows } = await client.query(
      'select count(*)::int as n from raw_captures where tenant_id = any($1::uuid[])',
      [tenantIds],
    );
    return Number(rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
}

// ── apply ──────────────────────────────────────────────────────────────────────

/** A standing fact as the tool layer writes it: value + its evidence capture. */
const factBundle = (value, capture) => ({
  value,
  sourceCaptureId: capture.id,
  recordedAt: capture.captured_at,
});

const attributesFrom = (facts, captures) =>
  Object.fromEntries(facts.map((f) => [f.key, factBundle(f.value, captures[f.evidence])]));

async function applyTenant(t, existing) {
  // In pilot mode the tenant already exists and is REUSED (the badge is keyed to
  // its id); locally a fresh one is created every run.
  const tenant = existing ?? (await createTenant(t.name, {
    managerSeats: t.managerSeats,
    technicianSeats: t.technicianSeats,
  }));
  if (existing) assertEvalTenant(tenant.name);
  await setTechnicianHorizonDays(tenant.id, t.horizonDays);

  // ── roster ──
  const techIds = {};
  for (const person of t.technicians) {
    const row = await insertTechnician({
      tenantId: tenant.id,
      ref: person.ref,
      displayName: person.displayName,
      tier: person.tier,
      ...(person.seatExempt ? { seatExempt: true } : {}),
    });
    // seatExempt rows are derived 'active' at insert; everyone else is 'invited'
    // and has to be flipped or the schedule readers treat the roster as empty.
    if (!person.seatExempt) await setTechnicianState(row.id, 'active');
    // Pilot mode only: claim the Composio session slot with a sentinel so the
    // pilot's lifecycle cron does not mint a real Composio session for a fake
    // person every 15 minutes. See EVAL_COMPOSIO_SENTINEL for the full reasoning.
    if (MODE === 'pilot') await updateTechnician(row.id, { composio_session_id: EVAL_COMPOSIO_SENTINEL });
    if (person.availability) await setTechnicianAvailability(row.id, person.availability);
    if (person.serviceCities) await setTechnicianServiceCities(row.id, person.serviceCities);
    if (person.skills?.length) await setTechnicianSkills(row.id, person.skills);
    techIds[person.ref] = row.id;
  }

  // ── cold sandbox pool (only where a tenant needs one) ──
  // token_hash holds a sha256 FINGERPRINT of a random per-run value, never a
  // token: secrets are stored as fingerprints, and an eval has no business
  // holding a real one (or inventing a plausible-looking one).
  //
  // Skipped entirely in pilot mode: `hosts` and `sandbox_pool` are shared infra
  // that the real control plane and the trades-box-1 badge pull read. This fixture
  // exists for tier 1's bind_telegram case, and tier 1 never runs against the
  // pilot.
  for (let i = 1; MODE === 'local' && i <= (t.coldSandboxes ?? 0); i++) {
    const host = await evalHost();
    await registerSandbox({
      tenantId: tenant.id,
      hostId: host.id,
      sandboxRef: `${t.key}-s${i}`,
      botUsername: `eval_${t.key}_s${i}_bot`,
    });
  }

  for (const d of t.durations) await upsertJobTypeDuration(tenant.id, d.jobType, d.minutes);
  for (const o of t.timeOff) {
    await addTimeOff({
      tenantId: tenant.id,
      technicianId: techIds[o.technicianRef],
      startsOn: o.startsOn,
      endsOn: o.endsOn,
      reason: o.reason,
    });
  }

  // ── L1 first: a capture that evidences a customer must predate it ──
  // Declared before appendCapture reads them: a 'pre' capture never names a
  // customer today, but a future one that did would hit a temporal-dead-zone
  // ReferenceError that reads like anything but the ordering mistake it is.
  const customerIds = {};
  const jobIds = {};
  const captures = {};
  const appendCapture = async (c) => {
    captures[c.key] = await appendRawCapture({
      tenantId: tenant.id,
      channel: c.channel,
      technicianRef: c.technicianRef,
      rawText: c.rawText,
      // In pilot mode every capture is STAMPED, because raw_captures has no
      // delete path: this row is permanent, and a stamp applied at insert time is
      // the only thing that will ever let a forensic reader separate eval noise
      // from a real customer's evidence. There is no retrofit. Same pattern as
      // `pendingVerification` in src/inbound/webhook.ts.
      ...(MODE === 'pilot'
        ? { metadata: { [EVAL_CAPTURE_MARKER]: true, evalAnchor: spec.anchor, evalSeed: SEED } }
        : {}),
      ...(c.externalId ? { externalId: c.externalId } : {}),
      ...(c.customerKey ? { customerId: customerIds[c.customerKey] } : {}),
      ...(c.jobKey ? { jobId: jobIds[c.jobKey] } : {}),
    });
  };
  for (const c of t.captures.filter((x) => x.phase === 'pre')) await appendCapture(c);

  // ── L2 + L3 ──
  for (const c of t.customers) {
    const row = await createCustomer({
      tenantId: tenant.id,
      name: c.name,
      phone: c.phone,
      email: c.email,
      addressLine1: c.addressLine1,
      city: c.city,
      state: c.state,
      postalCode: c.postalCode,
      attributes: attributesFrom(c.facts, captures),
      ...(c.sourceCapture ? { sourceCaptureId: captures[c.sourceCapture].id } : {}),
    });
    customerIds[c.key] = row.id;
  }

  for (const j of t.jobs) {
    const row = await createJob({
      tenantId: tenant.id,
      customerId: customerIds[j.customerKey],
      title: j.title,
      jobType: j.jobType,
      // Every job is created 'open' and then WALKED through the legal status
      // machine — inserting a terminal status directly would skip the transitions
      // the app can only reach one step at a time.
      status: 'open',
      priority: j.priority ?? 'routine',
      durationMinutes: j.durationMinutes,
      attributes: attributesFrom(j.facts, captures),
      ...(j.sourceCapture ? { sourceCaptureId: captures[j.sourceCapture].id } : {}),
    });
    jobIds[j.key] = row.id;
    for (const step of statusPath(j.status)) await updateJobStatus(row.id, step);
  }

  // Captures that name a customer/job can only be written now.
  for (const c of t.captures.filter((x) => x.phase === 'post')) await appendCapture(c);

  // ── visits ──
  const visitIds = {};
  for (const v of t.visits) {
    const placed = v.date !== undefined;
    const row = await createAssignment({
      tenantId: tenant.id,
      jobId: jobIds[v.jobKey],
      technicianId: v.technicianRef === null ? null : techIds[v.technicianRef],
      startsAt: placed ? naive(v.date, v.startTime) : null,
      endsAt: placed ? naive(v.date, addMin(v.startTime, v.durationMinutes)) : null,
      ...(placed ? {} : { earliestDate: v.earliestDate, latestDate: v.latestDate }),
      status: v.status,
    });
    visitIds[v.key] = row.id;
  }

  return {
    key: t.key,
    // The name the DATABASE row actually carries, not the spec's label. They
    // differ in pilot mode (`spine-eval-main` vs `Eval Main`), and the manifest is
    // what every downstream check reads — a manifest naming a row that does not
    // exist is the worst kind of wrong, because lookups miss and the misses grade
    // as agent failures.
    name: tenant.name ?? t.name,
    id: tenant.id,
    purpose: t.purpose,
    horizonDays: t.horizonDays,
    technicians: techIds,
    customers: Object.fromEntries(
      t.customers.map((c) => [c.key, { id: customerIds[c.key], name: c.name }]),
    ),
    jobs: Object.fromEntries(t.jobs.map((j) => [j.key, { id: jobIds[j.key], title: j.title }])),
    // The DATE rides along with the id: a scenario that needs "a different day
    // from the one this visit is on" cannot compute that from an offset, and
    // guessing produced a same-day move that made a correct agent look wrong.
    visits: Object.fromEntries(
      t.visits.map((v) => [v.key, { id: visitIds[v.key], date: v.date ?? v.earliestDate ?? null }]),
    ),
    // Capture ids are needed by retract_capture and the citation checks — a
    // scenario must never have to go find one by LIKE-matching raw text.
    captures: Object.fromEntries(t.captures.map((c) => [c.key, captures[c.key].id])),
    counts: {
      technicians: t.technicians.length,
      customers: t.customers.length,
      jobs: t.jobs.length,
      visits: t.visits.length,
      captures: t.captures.length,
    },
  };
}

// One host row for the whole run, created on first use.
let hostRow = null;
async function evalHost() {
  if (!hostRow) {
    hostRow = await createHost('eval-box', createHash('sha256').update(randomBytes(32)).digest('hex'));
  }
  return hostRow;
}

/** The legal transition path from 'open' to a target status (jobs.ts machine). */
function statusPath(target) {
  switch (target) {
    case 'open':
      return [];
    case 'in_progress':
      return ['in_progress'];
    case 'completed':
      return ['in_progress', 'completed'];
    case 'invoiced':
      return ['in_progress', 'completed', 'invoiced'];
    default:
      throw new Error(`no legal path to job status '${target}'`);
  }
}

// Naive-local: the wall clock written as-if-UTC (booking.ts naiveLocalISO).
const naive = (date, hhmm) => `${date}T${hhmm}:00.000Z`;
const addMin = (hhmm, minutes) => {
  const [h, m] = hhmm.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

// ── main ───────────────────────────────────────────────────────────────────────
async function main() {
  let existingByKey = {};
  let capturesBefore = 0;

  if (MODE === 'pilot') {
    // IDEMPOTENT BY ANCHOR. The world is a pure function of (anchor, seed), so
    // rebuilding it with the same pair produces an identical world — while adding
    // another 77 PERMANENT L1 captures, because raw_captures has no delete path.
    // Iterating on a harness means running its build command a lot, so without
    // this an afternoon's work silently multiplies the pilot's L1 by ten.
    const prior = existsSync(join(OUT_DIR, 'world.pilot.json'))
      ? JSON.parse(readFileSync(join(OUT_DIR, 'world.pilot.json'), 'utf8'))
      : null;
    if (prior && prior.anchor === spec.anchor && prior.seed === spec.seed && !hasFlag('force')) {
      console.log(`  SKIPPED: the pilot already holds this exact world (anchor ${spec.anchor}, seed ${SEED}).`);
      console.log(`           Rebuilding would add ~${spec.tenants.filter((t) => PILOT_TENANT_KEYS.includes(t.key)).reduce((n, t) => n + t.captures.length, 0)} more PERMANENT L1 rows for an identical result.`);
      console.log(`           Pass --force if you genuinely need to rebuild it.\n`);
      return;
    }

    const r = await resetPilotTenant(spec);
    existingByKey = r.tenants;
    capturesBefore = r.capturesBefore;
    const names = Object.values(r.tenants).map((t) => t.name).join(', ');
    console.log(`  tenants: ${names}${r.created ? ` (${r.created} created)` : ' (both reused)'}`);
    console.log(`  cleared: this tenant's L2 rows only — L1 untouched, ${capturesBefore} capture(s) already permanent`);
  } else if (!hasFlag('keep')) {
    const { truncated, tenantsDropped } = await reset();
    console.log(`  reset:  ${truncated} tables truncated, ${tenantsDropped} previous Eval tenant(s) dropped`);
  }

  // Pilot mode builds only the tenants tier 3 drives; local builds all of them.
  const wanted = MODE === 'pilot' ? spec.tenants.filter((t) => PILOT_TENANT_KEYS.includes(t.key)) : spec.tenants;
  if (MODE === 'pilot' && wanted.length !== PILOT_TENANT_KEYS.length) {
    throw new Error(`spec is missing one of the pilot tenants (${PILOT_TENANT_KEYS.join(', ')})`);
  }

  const tenants = [];
  for (const t of wanted) {
    const applied = await applyTenant(t, existingByKey[t.key]);
    tenants.push(applied);
    const c = applied.counts;
    console.log(
      `  ${applied.name.padEnd(21)} ${String(c.customers).padStart(3)} customers ` +
        `${String(c.jobs).padStart(3)} jobs ${String(c.visits).padStart(3)} visits ` +
        `${String(c.technicians).padStart(2)} roster`,
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const manifest = {
    builtAt: new Date().toISOString(),
    mode: MODE,
    anchor: spec.anchor,
    seed: spec.seed,
    timezone: spec.timezone,
    span: spec.span,
    edges: spec.edges,
    tenants,
  };
  // Pilot worlds get their own filename. Sharing world.json would let a tier-1
  // run (local) grade against a manifest of PILOT ids, whose every lookup would
  // miss — reported as dozens of agent failures.
  const out = join(OUT_DIR, MODE === 'pilot' ? 'world.pilot.json' : 'world.json');
  writeFileSync(out, JSON.stringify(manifest, null, 2));

  console.log(`\n  planted edges:`);
  for (const [k, v] of Object.entries(spec.edges)) console.log(`    ${k.padEnd(22)} ${v}`);
  console.log(`\n  world → ${out}`);

  if (MODE === 'pilot') {
    const after = await countCaptures(tenants.map((t) => t.id));
    const added = after - capturesBefore;
    console.log(`\n  PERMANENT L1: +${added} capture(s) this build, ${after} total under the eval tenants.`);
    console.log(`                raw_captures has no delete path — these rows stay for the life of the DB.`);
    console.log(`                Stamped metadata.${EVAL_CAPTURE_MARKER} = true, so they stay findable.`);
    console.log(`\n  NEXT:  mint a badge for this tenant, then restart the s6 container.\n`);
  } else {
    console.log(`\n  NEXT:  npm run spine-eval:tools\n`);
  }
}

main().catch((err) => {
  console.error('\nWORLD BUILD FAILED:', err.message);
  process.exit(1);
});
