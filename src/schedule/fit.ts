// The fit engine (Plan 3b Phase 1) — pure gap math and candidate scoring for
// find_slots. No DB, no network, no clock: `today` and `now` are INPUTS, so
// every behavior is fake-clock testable. The DB-composing wrapper lives at the
// bottom; the Google drive-delta measurement is Phase 2.
//
// Time convention: everything here is naive-local HH:MM minute arithmetic on
// the wall-clock times the schedule stores (visit rows are naive-local, see
// booking.ts) — no timezone math anywhere. Pattern days resolve via
// localDayOfWeek(date, 'UTC') exactly like the availability calculator.
//
// FEASIBILITY IS A TOOL VERDICT, NEVER THE MODEL'S OPINION (toolset research,
// 2026-07-20): every emitted slot must be bookable by book_visit VERBATIM —
// window ends of '24:00' are clamped to '23:59' on emission (book_visit
// rejects '24:00'; the addMinutesClamped precedent), and day-0 gaps are
// trimmed to `now` so an afternoon ask never ranks an already-past slot.

import {
  listVisitsWithRefsForTenant,
  participantIdsOf,
  participantsOf,
  listTeam,
  listTimeOffForTechnician,
  type PlacedVisit,
  type JobPriority,
  type Technician,
  type WeeklyPattern,
} from '../db/index.js';
import { localDayOfWeek } from './availability.js';
import { dayEndNaive, dayStartNaive } from '../db/time.js';
import { optimizeStopOrder, type ComputeRoutes } from '../routes/googleRoutes.js';
import type { RouteStop } from '../routes/deepLink.js';

// ---------------------------------------------------------------------------
// Pure minute math

// Module-local minute math. It was EXPORTED for 4b-3, when the freeze solver
// shared it rather than keeping a second copy that could drift from the one
// find_slots trusts; the solver is gone (rung 8) and nothing outside this file
// reads it, so the export goes with it. `addDaysISO` and `dayWindows` DO have
// other consumers and stay exported.
const toMin = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
const toHHMM = (min: number): string =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// Emission clamp: a slot may END at minute 1440 ('24:00' window edge) but
// book_visit's HH:MM validation rejects '24:00' — emit '23:59' instead so the
// candidate is bookable verbatim (loses one un-bookable minute, documented).
const emitEnd = (min: number): string => (min >= 1440 ? '23:59' : toHHMM(min));

export interface VisitSpan {
  start: string; // HH:MM within this day (callers clamp overlapping rows)
  end: string; // HH:MM; '24:00' allowed for rows running past midnight
}

export interface Gap {
  start: string;
  end: string; // '24:00' possible internally; candidates emit via emitEnd
  minutes: number;
}

// The day's working windows for a naive-local calendar date.
export function dayWindows(pattern: WeeklyPattern, dateISO: string): [string, string][] {
  const windows = pattern[localDayOfWeek(dayStartNaive(dateISO), 'UTC')];
  return Array.isArray(windows) ? windows : [];
}

// 'Thu' for '2026-07-23'. Every date the engine emits is prefixed with this,
// because the agent otherwise computes weekday names itself and gets them
// wrong (live E2E 2026-07-21: all five candidates relabeled one weekday
// early, incl. a "Sunday" for a Monday slot — resolve_date's lesson again;
// mechanism over instruction, so the server leaves no calendar math to do).
export const weekdayLabel = (dateISO: string): string => {
  const d = localDayOfWeek(dayStartNaive(dateISO), 'UTC');
  return d.charAt(0).toUpperCase() + d.slice(1);
};

// Free gaps of at least `durationMin` inside `windows` after subtracting
// `visits`. `notBefore` (HH:MM) trims gap starts — the day-0 "now" clamp.
export function freeGaps(
  windows: [string, string][],
  visits: VisitSpan[],
  durationMin: number,
  notBefore?: string,
): Gap[] {
  const floor = notBefore ? toMin(notBefore) : 0;
  const busy = visits
    .map((v) => [toMin(v.start), toMin(v.end)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const gaps: Gap[] = [];
  for (const [ws, we] of windows) {
    let cursor = Math.max(toMin(ws), floor);
    const windowEnd = toMin(we);
    for (const [bs, be] of busy) {
      if (be <= cursor || bs >= windowEnd) continue; // no overlap with remainder
      if (bs > cursor) gaps.push({ start: toHHMM(cursor), end: toHHMM(bs), minutes: bs - cursor });
      cursor = Math.max(cursor, be);
    }
    if (windowEnd > cursor) {
      gaps.push({ start: toHHMM(cursor), end: emitEnd(windowEnd), minutes: windowEnd - cursor });
    }
  }
  return gaps.filter((g) => g.minutes >= durationMin);
}

// ---------------------------------------------------------------------------
// Candidate generation + scoring

export interface SlotCandidate {
  technicianRef: string;
  technicianName: string;
  date: string; // YYYY-MM-DD
  weekday: string; // 'Thu' — SERVER-computed; the agent must never do calendar math
  startTime: string; // HH:MM — bookable verbatim
  endTime: string; // HH:MM — bookable verbatim (24:00 already clamped)
  dayLevel: boolean; // true = FAR candidate: quote the DAY, times are a suggested window
  score: number;
  reasons: string[]; // human-ready, server-composed — the agent relays these
  driveDeltaMinutes: number | null; // Phase 2 fills for measured candidates
  driveMeasured: boolean;
  warnings: string[];
}

export interface FitTechnician {
  ref: string;
  name: string;
  pattern: WeeklyPattern;
  timeOffDates: Set<string>; // YYYY-MM-DD, expanded inclusive
  visitsByDate: Map<string, VisitSpan[]>;
  citiesByDate: Map<string, Set<string>>; // lowercase customer cities that day
  serviceCities: string[];
  // PLACED stops only — feeds DENSE_DAY_STOPS, which asks whether the route
  // has SHAPE (gap-fill vs day-level candidates).
  stopsByDate: Map<string, number>;
  // How COMMITTED the day is. Load is weight without shape — it lowers a day's
  // score but never flips it into gap-fill mode.
  //
  // As of rung 9a this EQUALS stopsByDate: it used to add the unplaced-assigned
  // rows whose stored range covered the day (plan 4b-2), and an untimed visit
  // now covers no day at all. Kept as a distinct concept rather than collapsed,
  // because it is the seam where a future non-stop commitment (a multi-person
  // visit, a planner-held slot) would land — but nothing populates it today, so
  // do not read a difference from the two maps that is not there.
  commitmentsByDate: Map<string, number>;
}

export interface GenerateCandidatesInput {
  todayISO: string; // firm-local today — SERVER-supplied, never the model's
  nowHHMM: string; // firm-local wall clock, trims day-0 gaps
  earliest: string; // YYYY-MM-DD inclusive
  latest: string; // YYYY-MM-DD inclusive
  durationMin: number;
  durationLabel: string; // e.g. "8h install" — fused into every reason string
  customerCity: string | null; // lowercase, for the same-city bonus
  priority: JobPriority;
  technicians: FitTechnician[];
}

// DENSITY decides the candidate mode, never the date (user correction
// 2026-07-20: closeness-to-today was only ever a proxy for packedness). A day
// with ≥ this many existing visits is a GAP-FILL day: the route has shape, so
// concrete per-gap slots (and drive deltas — measurable exactly when ≥2 stops
// exist) are honest. Below it, the day is OPEN: one day-level candidate, quote
// the DAY (a precise time on a loose day is false precision — it will move).
// Refinement trigger (recorded in the plan): if stop-count proves too coarse
// (one 8h visit = "1 stop" but a tight day), switch to booked-fraction.
export const DENSE_DAY_STOPS = 2;

// Scoring weights — plain constants, pinned by ORDER-based tests (not raw
// numbers). Rationale per component:
//   earliness   emergencies want the soonest day, steeply; maintenance barely
//               cares (it's the flexible filler — dispatcher research).
//   morning     routine/maintenance prefer morning gaps: front-load the day,
//               keep afternoons loose to absorb emergencies (15-20% slack
//               doctrine as a scoring bias, not schema).
//   light day   spread load; fewer stops = more absorbency.
//   same city   zone clustering without a geocoder: a visit in the same town
//               that day (or the tech's service city) beats a cross-town day.
const EARLINESS_PER_DAY: Record<JobPriority, number> = {
  emergency: 30,
  urgent: 15,
  routine: 3,
  maintenance: 1,
};
const MORNING_BONUS = 10;
const LIGHT_DAY_PER_STOP = 5;
const SAME_CITY_BONUS = 15;

export const addDaysISO = (dateISO: string, days: number): string =>
  new Date(Date.parse(`${dateISO}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);

const daysBetween = (fromISO: string, toISO: string): number =>
  Math.round((Date.parse(`${toISO}T00:00:00Z`) - Date.parse(`${fromISO}T00:00:00Z`)) / 86_400_000);

export function generateCandidates(input: GenerateCandidatesInput): SlotCandidate[] {
  const out: SlotCandidate[] = [];
  const span = daysBetween(input.earliest, input.latest);
  for (let i = 0; i <= span; i++) {
    const date = addDaysISO(input.earliest, i);
    const fromToday = daysBetween(input.todayISO, date);
    if (fromToday < 0) continue; // past dates can never be booked
    for (const tech of input.technicians) {
      if (tech.timeOffDates.has(date)) continue;
      const windows = dayWindows(tech.pattern, date);
      if (windows.length === 0) continue; // not a working day
      const visits = tech.visitsByDate.get(date) ?? [];
      const gaps = freeGaps(
        windows,
        visits,
        input.durationMin,
        fromToday === 0 ? input.nowHHMM : undefined,
      );
      if (gaps.length === 0) continue;
      const stops = tech.stopsByDate.get(date) ?? 0;
      const commitments = tech.commitmentsByDate.get(date) ?? stops;
      const sameCity =
        input.customerCity !== null &&
        ((tech.citiesByDate.get(date)?.has(input.customerCity) ?? false) ||
          tech.serviceCities.includes(input.customerCity));
      if (stops >= DENSE_DAY_STOPS) {
        // GAP-FILL: the day has shape — every fitting gap is a real, distinct
        // threading choice; emit each concretely (drive deltas attach here).
        for (const gap of gaps) {
          out.push(
            buildCandidate(input, tech, date, gap, false, fromToday, stops, commitments, sameCity),
          );
        }
      } else {
        // OPEN day: one day-level candidate; the first fitting gap is the
        // suggested internal window — the DAY is what gets quoted (quote
        // days, not times; the loose day will reshape before it arrives).
        out.push(
          buildCandidate(input, tech, date, gaps[0], true, fromToday, stops, commitments, sameCity),
        );
      }
    }
  }
  return sortCandidates(out);
}

// The one comparator: score desc, then earlier date, then earlier start.
// Exported so Phase 2's drive-delta application re-sorts with the SAME rule
// (and so tests pin the real comparator, not a re-implementation).
export const sortCandidates = (cands: SlotCandidate[]): SlotCandidate[] =>
  [...cands].sort(
    (a, b) =>
      b.score - a.score || a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
  );

function buildCandidate(
  input: GenerateCandidatesInput,
  tech: FitTechnician,
  date: string,
  gap: Gap,
  dayLevel: boolean,
  fromToday: number,
  stops: number,
  commitments: number, // placed + unplaced — the load axis (plan 4b-2)
  sameCity: boolean,
): SlotCandidate {
  const startTime = gap.start;
  const endTime = emitEnd(toMin(gap.start) + input.durationMin);
  const morning = toMin(startTime) < 12 * 60;
  let score = 0;
  score -= fromToday * EARLINESS_PER_DAY[input.priority];
  if (morning && (input.priority === 'routine' || input.priority === 'maintenance')) {
    score += MORNING_BONUS;
  }
  // Load (light-day) scores on COMMITMENTS: three time-TBD visits weigh the
  // day down exactly like three placed ones (plan 4b-2). Density (the
  // gap-fill/day-level mode switch above) keeps using placed stops.
  score -= commitments * LIGHT_DAY_PER_STOP;
  if (sameCity) score += SAME_CITY_BONUS;

  const weekday = weekdayLabel(date);
  const reasons = [
    dayLevel
      ? `${weekday} ${date} with ${tech.name} — day-level fit for the ${input.durationLabel} (free ${gap.start}–${gap.end}); quote the DAY, not a time`
      : `${weekday} ${date} with ${tech.name}, ${startTime}–${endTime} — fits the ${input.durationLabel} (free ${gap.start}–${gap.end})`,
    ...(sameCity ? ['same city as another visit/coverage that day'] : []),
    // "Empty" keys on commitments — a day holding three time-TBD visits is
    // NOT empty even though its time grid is (plan 4b-2 review guard).
    ...(commitments === 0 ? ['their day is empty'] : [`${commitments} other visit(s) that day`]),
  ];
  return {
    technicianRef: tech.ref,
    technicianName: tech.name,
    date,
    weekday,
    startTime,
    endTime,
    dayLevel,
    score,
    reasons,
    driveDeltaMinutes: null,
    driveMeasured: false,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// DB-composing context assembly (the only impure part of Phase 1)

export interface FitContext {
  technicians: FitTechnician[];
  skippedNoPattern: string[]; // refs — surfaced, never silent (fail-closed rule)
  skippedSkills: string[]; // refs excluded by an explicit non-matching skill list
  unknownSkills: string[]; // refs INCLUDED with the confirm-first flag (empty list)
}

const expandDates = (startsOn: string, endsOn: string): string[] => {
  const days = daysBetween(startsOn, endsOn);
  return Array.from({ length: days + 1 }, (_, i) => addDaysISO(startsOn, i));
};

// Clamp an assignment row onto ONE day's HH:MM span. Rows are naive-local;
// a row spilling past midnight (backfill-sourced) still blocks the morning of
// the day it runs into (review finding #7 — overlap, not start-day, semantics).
// PlacedVisit: every caller feeds range-filtered rows (compiler-checked
// since plan 4b-2 — an unplaced row has no span to clamp).
export function clampRowToDay(row: PlacedVisit, dateISO: string): VisitSpan | null {
  // Compare INSTANTS, never strings: PostgREST renders timestamptz as
  // '…T00:00:00+00:00' (offset suffix, no ms) while locally built literals end
  // '.000Z', and ASCII '+' < '.' misclassifies midnight-aligned rows — a
  // next-day 00:00 start would block the entire previous day, and a row ending
  // at exactly midnight produced an inverted '22:00–00:00' span that freeGaps
  // silently dropped (Phase-1 review finding, reproduced).
  const dayStart = Date.parse(`${dateISO}T00:00:00Z`);
  const dayEnd = dayStart + 86_400_000;
  const rowStart = Date.parse(row.starts_at);
  const rowEnd = Date.parse(row.ends_at);
  if (rowStart >= dayEnd || rowEnd <= dayStart) return null;
  const start = rowStart < dayStart ? '00:00' : row.starts_at.slice(11, 16);
  const end = rowEnd >= dayEnd ? '24:00' : row.ends_at.slice(11, 16);
  return { start, end };
}

export interface AssembleFitContextInput {
  tenantId: string;
  earliest: string;
  latest: string;
  technicianRef?: string; // pin to one person
  requiredSkills?: string[]; // lowercase; three-state semantics (Decisions)
  excludeVisitId?: string; // the subject row of an visitId ask
}

export async function assembleFitContext(input: AssembleFitContextInput): Promise<FitContext> {
  const team = (await listTeam(input.tenantId)).filter(
    (t) =>
      t.state === 'active' &&
      (input.technicianRef === undefined || t.ref === input.technicianRef),
  );
  const skippedNoPattern: string[] = [];
  const skippedSkills: string[] = [];
  const unknownSkills: string[] = [];
  const eligible: Technician[] = [];
  const required = (input.requiredSkills ?? []).map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (const t of team) {
    if (t.availability === null) {
      skippedNoPattern.push(t.ref);
      continue;
    }
    if (required.length > 0) {
      if (t.skills.length === 0) {
        unknownSkills.push(t.ref); // unknown ≠ unqualified — included, flagged
      } else if (!required.every((s) => t.skills.includes(s))) {
        skippedSkills.push(t.ref); // explicit list lacking the skill — excluded, named
        continue;
      }
    }
    eligible.push(t);
  }

  // One tenant-wide visit read covers every technician's day context.
  //
  // A second read used to bring the assigned time-TBD load in (plan 4b-2),
  // because an unplaced visit held a date RANGE and therefore weighed on every
  // day it could land on. Rung 9a deleted the range: an untimed visit belongs
  // to no day at all, so it can be budgeted against none of them, and there is
  // nothing to read.
  //
  // The EMBEDDED window reader (retrieval layer 4): the customer's city rides on
  // each row, so there is no second read keyed on a job-id list — that list went
  // into a URL in chunks of 500, above PostgREST's ~200-id wall, and a busy
  // fortnight would have failed the search outright. Paged, so a firm with more
  // than 1000 visits in the window no longer reads its later days as empty.
  const placedRows = await listVisitsWithRefsForTenant(
    input.tenantId,
    dayStartNaive(input.earliest),
    dayEndNaive(input.latest),
    ['confirmed'],
  );
  // Rows with SOMEBODY on them — a trip nobody is going on occupies nobody's
  // day (rung 9c: that is the crew list, not a column).
  const rows = placedRows.filter(
    (r) => participantIdsOf(r, input.tenantId).length > 0 && r.id !== input.excludeVisitId,
  );
  // ID-only foreign keys: the job and the customer are each re-checked against
  // the tenant before their city is used (the boardRead.readBoardDays rule).
  const cityByJob = new Map(
    rows.map((r) => {
      const job = r.jobs && r.jobs.tenant_id === input.tenantId ? r.jobs : null;
      const customer =
        job && job.customers && job.customers.tenant_id === input.tenantId ? job.customers : null;
      return [r.job_id, customer?.city?.trim().toLowerCase() || null] as const;
    }),
  );

  const technicians: FitTechnician[] = [];
  for (const t of eligible) {
    const timeOff = await listTimeOffForTechnician(t.id, input.earliest, input.latest);
    const timeOffDates = new Set(timeOff.flatMap((r) => expandDates(r.starts_on, r.ends_on)));
    const visitsByDate = new Map<string, VisitSpan[]>();
    const citiesByDate = new Map<string, Set<string>>();
    const stopsByDate = new Map<string, number>();
    const commitmentsByDate = new Map<string, number>();
    // A CREW visit occupies BOTH people's days — it is one trip and each of
    // them is out on it, so it is `mine` for every participant.
    const mine = rows.filter((r) =>
      participantIdsOf(r, input.tenantId).includes(t.id),
    );
    const span = daysBetween(input.earliest, input.latest);
    for (let i = 0; i <= span; i++) {
      const date = addDaysISO(input.earliest, i);
      for (const row of mine) {
        const clamped = clampRowToDay(row, date);
        if (!clamped) continue;
        visitsByDate.set(date, [...(visitsByDate.get(date) ?? []), clamped]);
        stopsByDate.set(date, (stopsByDate.get(date) ?? 0) + 1);
        commitmentsByDate.set(date, (commitmentsByDate.get(date) ?? 0) + 1);
        const city = cityByJob.get(row.job_id);
        if (city) citiesByDate.set(date, new Set([...(citiesByDate.get(date) ?? []), city]));
      }
    }
    technicians.push({
      ref: t.ref,
      name: t.display_name,
      pattern: t.availability as WeeklyPattern,
      timeOffDates,
      visitsByDate,
      citiesByDate,
      serviceCities: t.service_cities,
      stopsByDate,
      commitmentsByDate,
    });
  }
  return { technicians, skippedNoPattern, skippedSkills, unknownSkills };
}

// Displacement candidates for the no-fit block: what COULD move to make room.
// (A pinned-last tiebreak sat in the middle until rung 8 — pinning bound only
// AUTOMATIC scheduling, and there is none.)
export interface DisplacementCandidate {
  visitId: string;
  customer: string | null;
  technicianRef: string | null; // first-or-null; the crew is technicianRefs
  technicianRefs: string[];
  day: string;
  weekday: string; // server-computed — same no-agent-calendar-math rule
  span: string;
}

export async function findDisplacementCandidates(
  tenantId: string,
  earliest: string,
  latest: string,
  limit = 5,
  excludeVisitId?: string,
): Promise<DisplacementCandidate[]> {
  // excludeVisitId: an visitId ask's own subject — "what could move
  // to make room" must never propose moving the visit to make room for itself.
  // The embedded reader, as in assembleFitContext: names and crew refs ride on
  // the row, so neither a job-id list nor a per-person roster read is needed.
  const rows = (
    await listVisitsWithRefsForTenant(
      tenantId,
      dayStartNaive(earliest),
      dayEndNaive(latest),
      ['confirmed'],
    )
  ).filter((r) => r.id !== excludeVisitId);
  const out: DisplacementCandidate[] = [];
  // Earliest first. The promise-graded tiebreak died with the ladder
  // (rung 9a) — what a customer was told is no longer a column, so start time
  // is the only ordering the row itself can justify.
  const ordered = [...rows].sort((a, b) => (a.starts_at < b.starts_at ? -1 : 1));
  for (const row of ordered.slice(0, limit)) {
    // EVERY person who would be displaced — moving a crew visit moves both of
    // them, so naming one would understate what the manager is being asked to
    // disturb.
    // participantsOf re-checks both the participant and the technician row
    // against the tenant — a person who cannot be named is left out, exactly
    // what the per-person getTechnicianById read used to do.
    const refs = participantsOf(row, tenantId).map((p) => p.ref);
    const job = row.jobs && row.jobs.tenant_id === tenantId ? row.jobs : null;
    const customer =
      job && job.customers && job.customers.tenant_id === tenantId ? job.customers : null;
    out.push({
      visitId: row.id,
      customer: customer?.name ?? null,
      technicianRef: refs[0] ?? null,
      technicianRefs: refs,
      day: row.starts_at.slice(0, 10),
      weekday: weekdayLabel(row.starts_at.slice(0, 10)),
      span: `${row.starts_at.slice(11, 16)}–${row.ends_at.slice(11, 16)}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Marginal drive measurement (Phase 2) — the bounded computeRoutes integration

// Only the top-ranked candidates get API calls (2 per candidate worst case:
// day-with vs day-without) — billing stays pennies and the cap is visible in
// the result via driveMeasured per candidate.
export const DRIVE_MEASURE_TOP = 5;

// A measured detour subtracts from the score minute-for-minute: a 22-minute
// detour outweighs SAME_CITY_BONUS (15) and MORNING_BONUS (10) — real driving
// beats heuristics once we've actually measured it. (A negative delta — the
// route IMPROVES — boosts by the same rule.)
const DRIVE_DELTA_PENALTY_PER_MIN = 1;

export const techDateKey = (technicianRef: string, date: string): string =>
  `${technicianRef}|${date}`;

export interface MeasureDriveDeltasInput {
  candidates: SlotCandidate[]; // pre-scored, sorted (generateCandidates output)
  // EXISTING confirmed stops per techDateKey(ref, date) — listDayStops shapes.
  stopsByTechDate: Map<string, RouteStop[]>;
  newStop: RouteStop; // the customer being placed (address may be null)
}

// Measure what adding `newStop` does to each top candidate's day of driving,
// fold the delta into the score, and re-sort. THE NEW STOP IS ALWAYS AN
// INTERMEDIATE (never origin/destination): optimizeStopOrder pins first/last,
// so inserting at an endpoint would solve a differently-pinned problem and
// skew the with-vs-without comparison (plan review finding #4). Branches by
// the day's ROUTABLE existing-stop count (finding #5):
//   ≥3  both routes measurable → true delta, scored;
//   =2  only the with-route (3 stops) is measurable → "route becomes ~X min",
//       delta stays null (nothing to subtract from);
//   0–1 neither route measurable (optimizeStopOrder short-circuits <3 stops)
//       → driveMeasured false, NO API call, no route reason.
// Any Google failure degrades that candidate to driveMeasured:false — a
// routing outage must never eat the scheduling answer: find_slots still ranks
// and returns its candidates, just without a drive figure. (This is now the
// only Google-routing call on a chat path; get_schedule stopped optimizing on
// 2026-07-31 — reads render the booked order, they never re-derive it.)
export async function measureDriveDeltas(
  input: MeasureDriveDeltasInput,
  deps: { computeRoutes?: ComputeRoutes } = {},
): Promise<SlotCandidate[]> {
  const out = input.candidates.map((c) => ({
    ...c,
    reasons: [...c.reasons],
    warnings: [...c.warnings],
  }));
  // Candidates on the same (tech, day) share identical with/without routes —
  // the measurement is day-level, not gap-level — so cache per day and pay
  // Google once (two gaps on a dense day = still 2 calls, not 4).
  const totalCache = new Map<string, Promise<number | null>>();
  const measureTotal = (cacheKey: string, stops: RouteStop[]): Promise<number | null> => {
    let p = totalCache.get(cacheKey);
    if (!p) {
      p = optimizeStopOrder(stops, deps).then((r) => r.totalMinutes);
      totalCache.set(cacheKey, p);
    }
    return p;
  };

  for (const [idx, cand] of out.entries()) {
    const withinCap = idx < DRIVE_MEASURE_TOP;
    if (input.newStop.address === null) {
      if (withinCap) cand.warnings.push('customer address incomplete — drive not measured');
      continue;
    }
    const key = techDateKey(cand.technicianRef, cand.date);
    const existing = (input.stopsByTechDate.get(key) ?? []).filter((s) => s.address !== null);
    if (existing.length <= 1) continue; // nothing routable to compare against
    // Over-cap candidates issue NO new calls, but a sibling gap on an
    // already-measured day absorbs the cached day result — otherwise the
    // unmeasured twin would rank above its measured sibling with no drive
    // reason despite identical real driving (review observation).
    const needed =
      existing.length === 2 ? [`${key}|with`] : [`${key}|with`, `${key}|without`];
    if (!withinCap && !needed.every((k) => totalCache.has(k))) continue;
    try {
      // Endpoints stay pinned to the SAME existing first/last in both routes.
      const withStops = [
        existing[0],
        ...existing.slice(1, -1),
        input.newStop,
        existing[existing.length - 1],
      ];
      if (existing.length === 2) {
        const withTotal = await measureTotal(`${key}|with`, withStops);
        if (withTotal === null) continue;
        cand.driveMeasured = true;
        cand.reasons.push(`route becomes ~${withTotal} min of driving that day`);
      } else {
        const [withTotal, withoutTotal] = await Promise.all([
          measureTotal(`${key}|with`, withStops),
          measureTotal(`${key}|without`, existing),
        ]);
        if (withTotal === null || withoutTotal === null) continue; // both or nothing
        const delta = withTotal - withoutTotal;
        cand.driveMeasured = true;
        cand.driveDeltaMinutes = delta;
        cand.score -= delta * DRIVE_DELTA_PENALTY_PER_MIN;
        cand.reasons.push(
          delta >= 0
            ? `adds ~${delta} min of driving to that day's route`
            : `saves ~${-delta} min of driving on that day's route`,
        );
      }
    } catch {
      cand.warnings.push('drive not measured (routing service error)');
    }
  }
  return sortCandidates(out);
}
