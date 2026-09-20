import {
  factSourceIds,
  findRetractionsFor,
  foldRetractedFacts,
  getVisitWithRefsForTenant,
  getTenant,
  isInactiveState,
  listVisitsWithRefsForTenant,
  listTeam,
  listUnassignedVisitsWithRefs,
  listUnscheduledOpenJobsCapped,
  isPlaced,
  unwrapAttributes,
  type Visit,
  type VisitStatus,
  type Json,
  participantIdsOf,
  participantsOf,
  type ParticipantRef,
} from '../db/index.js';
import { formatAddress } from '../routes/deepLink.js';
import { localDateISO } from './availability.js';
import { dayEndNaive, dayStartNaive } from '../db/time.js';
import { weekdayLabel } from './fit.js';
import { clampToTechnicianHorizon, horizonDaysFor } from './policy.js';

// The dispatch board's day view — originally a deliberate mirror of
// get_team_schedule's body (src/mcp/server.ts, post-Feature-A shape) for the
// browser surface. This module is the ONE place the board binds to the per-stop
// shape: if the MCP read changes shape, this is the file to re-check. Kept
// separate from server.ts on purpose (fork (b) in the plan): the board must not
// drag the whole MCP tool surface into its footprint.
//
// DELIBERATE DIVERGENCE from get_team_schedule (2026-07-22, latency work): the
// board does NOT return a scheduleVersion. The agent version-pins its reads to
// detect staleness; the board never did — it re-fetches after every write — so
// the extra latestScheduleVersion round-trip was pure cost on the button path.
// get_team_schedule keeps its own version stamp (it calls latestScheduleVersion
// directly, not through here), as does boardNotify.
//
// Feature A semantics carried over: a visit can have NOBODY on it — such rows
// render technicianRef/technicianName null and unassigned:true, and a
// technician self-view can never contain them (an empty crew has no member to
// match the viewer).

export class InvalidRangeError extends Error {}

export interface BoardStop {
  visitId: string;
  // THE LANE this stop is drawn in. A crew visit emits one stop per person in
  // the team view — all sharing `visitId` — so the grid's lanes need no client
  // change; `technicianRefs` says who else is on the same trip.
  technicianRef: string | null;
  technicianName: string | null;
  technicianRefs: string[];
  technicianNames: string[];
  unassigned: boolean;
  customer: string | null;
  address: string | null;
  start: string;
  end: string;
  status: Visit['status'];
  // Null when the assignment references another tenant's job — the id is
  // withheld like every other nested field (see the tenant re-check below).
  jobId: string | null;
  // WHAT THE WORK IS, for surfaces wide enough to say it (the console's grid).
  // Withheld on the same tenant re-check as jobId: a stranded cross-tenant
  // assignment discloses neither the other firm's job id nor its words.
  jobTitle: string | null;
  priority: string | null;
}

export interface BoardDays {
  from: string;
  to: string;
  days: { date: string; stops: BoardStop[] }[];
  // Present when a technician-tier read was clamped at the visibility horizon
  // (Plan 4a): the payload explains the missing days itself. horizonEnd is
  // the STRUCTURED companion (the last visible day) — clients branch on data,
  // never by parsing the sentence (final-review finding: the client's
  // days-empty proxy conflated "fully beyond" with "trimmed but empty").
  horizonNote?: string;
  horizonEnd?: string;
}

export interface ReadBoardDaysInput {
  tenantId: string;
  from?: string; // YYYY-MM-DD; default = firm-local today (tenant timezone)
  to?: string; // YYYY-MM-DD; default = from
  // Set for the technician self-view: only that person's stops. null/omitted =
  // manager view (whole team, unassigned included).
  viewerTechnicianId?: string | null;
  // The widest range this read will serve, in days (default 14). The Telegram
  // board never passes it and keeps its two-week ceiling verbatim; the console's
  // month grid needs 42 (six Mon-Sun rows), which is why the number is an input
  // and not a bigger constant — raising the constant would silently widen every
  // caller, including the technician-tier path.
  maxSpanDays?: number;
  // Technician-tier reads clamp at today + tenants.technician_horizon_days.
  // Keyed on TIER by the caller, never on the self-filter — the manager's
  // "Mine" tab uses viewerTechnicianId too and must keep far weeks.
  clampToHorizon?: boolean;
  // Which visit statuses are drawn. Default `['confirmed']` — the Telegram
  // board's "what stands" view, unchanged. The console passes
  // `['confirmed', 'completed']` so a past week reads as history rather than
  // as an empty grid (user decision 2026-09-07); a completed row still claims
  // no time and refuses every write, so nothing downstream of the read moves.
  // Never 'cancelled' (its own view, v_cancelled_visits) and never 'proposed'
  // (no writer mints it; see listUnscheduledOpenJobsWithCustomer).
  statuses?: VisitStatus[];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function readBoardDays(input: ReadBoardDaysInput): Promise<BoardDays> {
  const { tenantId } = input;
  let from = input.from;
  // The tenant row (timezone + horizon) costs an uncached round-trip — fetch
  // it only when actually needed: the from-default (once per board session)
  // or the clamp (technician tier). Managers passing `from` keep the
  // PR #70-era zero-extra-read button path.
  const tenant = !from || input.clampToHorizon ? await getTenant(tenantId) : null;
  if (!from) {
    const tz = tenant?.timezone ?? 'UTC';
    from = localDateISO(new Date().toISOString(), tz);
  }
  if (!DATE.test(from)) throw new InvalidRangeError('from must be YYYY-MM-DD');
  let toDay = input.to ?? from;
  if (!DATE.test(toDay) || from > toDay) {
    throw new InvalidRangeError('from/to must be YYYY-MM-DD with from <= to');
  }
  const spanDays =
    (Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (!Number.isFinite(spanDays)) throw new InvalidRangeError('from/to is not a real calendar date');
  const maxSpan = input.maxSpanDays ?? 14;
  if (spanDays > maxSpan) {
    throw new InvalidRangeError(`range is capped at ${maxSpan} days`);
  }

  // Horizon clamp AFTER validation (a garbage range is still a 400, never a
  // quiet clamp). Trim + note, not an error: the payload explains itself.
  // The policy itself lives in ONE place (schedule/policy.ts).
  let horizonNote: string | undefined;
  let horizonEnd: string | undefined;
  if (input.clampToHorizon) {
    const tz = tenant?.timezone ?? 'UTC';
    const today = localDateISO(new Date().toISOString(), tz);
    const clamp = clampToTechnicianHorizon(today, from, toDay, horizonDaysFor(tenant));
    horizonEnd = clamp.horizonEnd;
    if (clamp.beyond) {
      return { from, to: toDay, days: [], horizonNote: clamp.horizonNote, horizonEnd };
    }
    toDay = clamp.to;
    horizonNote = clamp.horizonNote;
  }

  // ONE embedded read for the whole window (was: visits + jobs-with-
  // customer + the full roster = three serial round-trips per board button).
  //
  // A second read used to bring the unplaced strip in (plan 4b-2), because a
  // stored range said which days an unplaced visit might land on. Rung 9a
  // deleted the range: an untimed visit belongs to no day, so the day view has
  // nothing to draw and the read is gone. Those visits live in the flat
  // unscheduled tray (readLooseBucket) instead.
  const rows = await listVisitsWithRefsForTenant(
    tenantId,
    dayStartNaive(from),
    dayEndNaive(toDay),
    input.statuses ?? ['confirmed'],
  );
  // MEMBERSHIP, not a column match (rung 9c): a technician's own board must
  // show a trip they are on even when somebody else was named first.
  const visible =
    input.viewerTechnicianId != null
      ? rows.filter((r) =>
          participantIdsOf(r, tenantId).includes(input.viewerTechnicianId as string),
        )
      : rows;
  const byDay = new Map<string, BoardStop[]>();
  for (const row of visible) {
    // Overlap semantics can pull in a row starting before `from` — clamp to
    // the requested days by start-day (the get_team_schedule precedent).
    const day = row.starts_at.slice(0, 10);
    if (day < from || day > toDay) continue;
    // SECURITY: the embed's foreign keys are ID-ONLY, so each nested row is
    // re-checked against the tenant before it is surfaced. This reproduces
    // exactly what the per-table reads gave for free: listJobsWithCustomerByIds
    // filtered jobs BY TENANT (a cross-tenant job was simply absent from the map
    // → customer null), and techById was built from listTeam(tenantId) (a
    // cross-tenant technician missed the map → ref/name null).
    const job = row.jobs && row.jobs.tenant_id === tenantId ? row.jobs : null;
    // The customer is re-checked on its OWN tenant, not merely inherited from
    // the job: it is a separate row with its own owner, and it holds the name
    // and address that reach the screen. (Hardening beyond the pre-embed
    // behavior — security review 2026-07-22.)
    const customer =
      job && job.customers && job.customers.tenant_id === tenantId ? job.customers : null;
    const crew = participantsOf(row, tenantId);
    // ONE STOP PER PERSON in the TEAM view, all sharing a visitId: the grid
    // draws lanes by technician, so a two-person trip has to appear in both
    // lanes or one of them looks free. In the SELF view the layout is flat
    // (web/board/board.js) — one stop, or the viewer's own crew visit would be
    // drawn twice on their own day.
    const lanes: (ParticipantRef | null)[] =
      crew.length === 0
        ? [null]
        : input.viewerTechnicianId != null
          ? [crew.find((p) => p.technicianId === input.viewerTechnicianId) ?? crew[0]]
          : crew;
    const bucket = byDay.get(day) ?? [];
    for (const technician of lanes) {
    bucket.push({
      visitId: row.id,
      technicianRef: technician?.ref ?? null,
      technicianName: technician?.displayName ?? null,
      // EVERY name on the trip, so a lane row can say who else is on it.
      technicianRefs: crew.map((p) => p.ref),
      technicianNames: crew.map((p) => p.displayName),
      // COUNTED, not named: somebody whose roster row belongs to another tenant
      // is a person we cannot NAME, not an empty visit. Saying "unassigned"
      // there would offer an occupied trip to the tray.
      unassigned: participantIdsOf(row, tenantId).length === 0,
      customer: customer?.name ?? null,
      address: customer
        ? formatAddress({
            address_line1: customer.address_line1,
            address_line2: customer.address_line2,
            city: customer.city,
            state: customer.state,
            postal_code: customer.postal_code,
          })
        : null,
      start: row.starts_at,
      end: row.ends_at,
      status: row.status,
      // Gated on the tenant-checked job, NOT the raw row.job_id: a stranded
      // cross-tenant assignment would otherwise disclose the other firm's job
      // UUID even while its customer/technician were correctly withheld.
      // (Pre-existing leak, closed here — security review 2026-07-22.)
      jobId: job ? row.job_id : null,
      jobTitle: job ? job.title : null,
      priority: job ? job.priority : null,
    });
    }
    byDay.set(day, bucket);
  }
  // The per-day strip is GONE (rung 9a). An unplaced row used to be smeared
  // across every day of its stored range, because the range said which days it
  // might land on. With no range, an untimed visit belongs to NO day and
  // cannot honestly be drawn on one — it lives in the flat unscheduled tray
  // (`parkedVisits` below), which is the whole point of the remodel: the queue
  // is a queue, not a shadow booking on days nobody chose.
  const days = [...byDay.keys()]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((date) => ({ date, stops: byDay.get(date) ?? [] }));
  return {
    from,
    to: toDay,
    days,
    ...(horizonNote ? { horizonNote } : {}),
    ...(horizonEnd ? { horizonEnd } : {}),
  };
}

// ---- The loose bucket (Plan 4a): what the freeze will consume, made visible ----
//
// Two halves: parked visits (confirmed, nobody attached, from today onward —
// UNBOUNDED, because the point is catching visits parked beyond any board
// window) and unscheduled open jobs (no visit at all — until now surfaced
// NOWHERE). One shape for both consumers (board tray + agent parity): dates
// ship as date + server-computed weekday + HH:MM slices, never raw
// timestamptz (the naive-local convention makes the wire's '+00:00' a lie —
// PR #72's lesson).

export interface UnscheduledJob {
  jobId: string;
  title: string | null;
  customer: string | null;
  priority: string;
  // How long the work takes (plan 4b-1) — null = "length not set", shown, not
  // hidden: the tray is where the manager learns which work is placeable.
  durationMinutes: number | null;
  createdAt: string;
}

export interface LooseBucket {
  parkedVisits: {
    visitId: string;
    date: string | null;
    weekday: string | null;
    // Null on an UNTIMED visit — there is no time, and no date either.
    startTime: string | null;
    endTime: string | null;
    customer: string | null;
    jobTitle: string | null;
    // A PLACED visit whose day already slipped past with nobody attached —
    // the most forgettable row of all (final-review finding: it used to vanish
    // from the tray entirely, while its job stayed hidden by the
    // live-assignment anti-join — invisible on every surface at once).
    // Always false for an untimed visit: with no date, nothing can be late.
    overdue: boolean;
    // WHO IS ALREADY ON IT (rung 9c). The tray holds two different rows: a
    // visit with NOBODY on it, and an UNTIMED visit that has a full crew. They
    // look identical without this, and the tray's Assign button REPLACES the
    // crew — so a manager tapping Assign on the second kind silently takes a
    // real crew off a real trip. The board renders these and names what the
    // tap will remove.
    technicianRefs: string[];
    technicianNames: string[];
    // Added for get_team_schedule's recall view (retrieval layer 4); the board
    // ignores them. `jobId` is withheld on the same tenant re-check as jobTitle,
    // so the agent can go from a parked row to update_job / cancel_job.
    jobId: string | null;
    // The row's age: the order untimed rows queue in, and the recall view's
    // paging key for them.
    createdAt: string;
    // COUNTED, not named: a crew member whose roster row belongs to another
    // tenant is left out of technicianRefs but still occupies the trip, so
    // "nobody is on it" is read off the participant ids (participantIdsOf).
    unassigned: boolean;
  }[];
  unscheduledJobs: UnscheduledJob[];
  // The open-job read came back at PostgREST's row limit, so the unscheduled
  // list may be short (src/db/rowCap.ts — told, not paged, by ruling).
  unscheduledJobsRowCapHit: boolean;
}

// THE unscheduled-jobs projection — the board tray AND get_team_schedule's
// recall view both call this, so the two surfaces agree by construction
// (final-review finding: parity was previously by duplication, tenant
// re-check included). The job row is already tenant-filtered by the query;
// only the embedded customer needs the re-check (ID-only foreign keys).
export async function readUnscheduledJobsCapped(
  tenantId: string,
): Promise<{ jobs: UnscheduledJob[]; rowCapHit: boolean }> {
  const { rows, rowCapHit } = await listUnscheduledOpenJobsCapped(tenantId);
  return {
    jobs: rows.map((job) => ({
      jobId: job.id,
      title: job.title,
      customer: job.customers && job.customers.tenant_id === tenantId ? job.customers.name : null,
      priority: job.priority,
      durationMinutes: job.duration_minutes,
      createdAt: job.created_at,
    })),
    rowCapHit,
  };
}

export async function readUnscheduledJobs(tenantId: string): Promise<UnscheduledJob[]> {
  return (await readUnscheduledJobsCapped(tenantId)).jobs;
}

// `nowIso` is the clock `overdue` is judged against. The board passes nothing
// (the real clock); get_team_schedule passes spineNowIso so an eval-anchored
// tenant's recall view flags the same rows its own `today` would.
export async function readLooseBucket(
  tenantId: string,
  nowIso: string = new Date().toISOString(),
): Promise<LooseBucket> {
  // The jobs read is independent of the tenant read — start it first so the
  // three queries run at depth 2, not 3 (final-review efficiency finding).
  const jobsPromise = readUnscheduledJobsCapped(tenantId);
  const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
  const today = localDateISO(nowIso, tz);
  // Parked visits are read UNBOUNDED into the past: a parked visit whose day
  // slipped by is missed work, not history — it surfaces flagged `overdue`
  // instead of disappearing. (Terminal rows still drop via status; note the
  // recorded limitation that `proposed` unassigned rows are invisible to
  // BOTH halves — no production writer mints them today; Plan 3c/4b decides.)
  const [parked, jobsRead] = await Promise.all([
    listUnassignedVisitsWithRefs(tenantId, dayStartNaive('1970-01-01')),
    jobsPromise,
  ]);
  // Sorted after mapping, not by the SQL order. Dated rows (placed but with
  // nobody attached) keep their day order; UNTIMED rows have no day to sort by
  // at all, so they queue by AGE behind them — the user's 2026-09-05 choice,
  // and the order that stops a hard-to-place visit sinking out of sight.
  // Stable sort keeps same-day relative order.
  const parkedVisits = parked.map((row) => {
      // ID-only foreign keys: re-check each nested row's tenant before its
      // name/title reaches a screen (withhold the field, keep the row —
      // the boardRead security pattern above).
      const job = row.jobs && row.jobs.tenant_id === tenantId ? row.jobs : null;
      const customer =
        job && job.customers && job.customers.tenant_id === tenantId ? job.customers : null;
      // UNTIMED rows (rung 9a) live in the tray too, and are its whole point:
      // every date field reads null, and nothing untimed can be overdue.
      const placedRow = isPlaced(row);
      const date = placedRow ? row.starts_at.slice(0, 10) : null;
      // Nameable crew only, tenant-checked at both levels (participantsOf) —
      // the same withhold-the-field-keep-the-row rule the rest of this reader
      // applies to job and customer names.
      const crew = participantsOf(row, tenantId);
      return {
        visitId: row.id,
        date,
        weekday: date ? weekdayLabel(date) : null,
        startTime: placedRow ? row.starts_at.slice(11, 16) : null,
        endTime: placedRow ? row.ends_at.slice(11, 16) : null,
        customer: customer?.name ?? null,
        jobTitle: job ? job.title : null,
        overdue: placedRow ? (date as string) < today : false,
        technicianRefs: crew.map((p) => p.ref),
        technicianNames: crew.map((p) => p.displayName),
        jobId: job ? row.job_id : null,
        createdAt: row.created_at,
        unassigned: participantIdsOf(row, tenantId).length === 0,
      };
    });
  // OLDEST FIRST (user choice 2026-09-05). Placed-but-overdue rows still sort
  // by their day; untimed rows have none, so age is the only order they can
  // justify — and it is the order that stops a hard-to-place visit sinking.
  parkedVisits.sort((a, b) => {
    if (a.date && b.date) return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
    if (a.date) return -1; // dated rows first
    if (b.date) return 1;
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
  return {
    parkedVisits,
    unscheduledJobs: jobsRead.jobs,
    unscheduledJobsRowCapHit: jobsRead.rowCapHit,
  };
}

// The board picker's roster read (plan 4a.5): every name chat booking would
// accept — the filter mirrors resolveTechnician (!isInactiveState), so
// seat-exempt and invited rows appear; offboarded never. Manager-gated at the
// endpoint; fetched on picker open, never on the board-load path.
export interface BoardRosterEntry {
  ref: string;
  name: string;
}

export async function readRosterForBoard(tenantId: string): Promise<BoardRosterEntry[]> {
  return (await listTeam(tenantId))
    .filter((t) => !isInactiveState(t.state))
    .map((t) => ({ ref: t.ref, name: t.display_name }));
}

// The tap-into-a-visit detail view (contact + logistics; SINCE plan 4a.5 also
// the compressed customer notes — the recorded 2026-07-23 decision that
// consciously revisits "notes stay off the board": standing facts already
// reach technicians through the agent's customer reads, so the sheet shows
// the same folded facts to both tiers; CAPTURES remain off the board, so the
// capture sensitivity filter still has nothing to do here).
export interface VisitDetail {
  visitId: string;
  status: Visit['status'];
  // Null on an UNTIMED visit (rung 9a) — nothing records when it should be.
  start: string | null;
  end: string | null;
  // Naive-local like start/end; set only once the trip is 'completed' (and
  // even then only when the completer knew the time — a note usually does).
  completedAt: string | null;
  unassigned: boolean;
  technicianRef: string | null; // first-or-null; the crew is technicianRefs
  technicianName: string | null;
  technicianRefs: string[];
  technicianNames: string[];
  // Null when the assignment references another tenant's job — withheld like
  // every other nested field (the day-view jobId precedent). The sheet's
  // Purpose editor posts against this id (plan 4a.5).
  jobId: string | null;
  jobTitle: string | null;
  jobPriority: string | null;
  // The job's recorded length (plan 4b-1) — editable through the same job
  // form as title/priority; null = not set.
  jobDurationMinutes: number | null;
  // Compressed standing facts (plan 4a.5): retraction-folded, capped, values
  // truncated — BOTH tiers see them (facts already reach technicians through
  // the agent's customer reads; recorded decision 2026-07-23).
  customerNotes: { key: string; value: string }[];
  customer: {
    name: string | null;
    phone: string | null;
    email: string | null;
    address: string | null;
  } | null;
}

// The notes cap/truncation — server-composed so clients render verbatim.
const NOTES_CAP = 8;
const NOTE_VALUE_MAX = 80;

// Attributes → compressed notes: fold facts whose evidence was retracted
// (factSourceIds → findRetractionsFor → foldRetractedFacts — the capture-read
// pattern in src/mcp/server.ts), unwrap bundles to plain values, then cap and
// truncate. Non-bundle (seed/legacy) values pass through the same compression.
async function composeCustomerNotes(attrs: Json): Promise<{ key: string; value: string }[]> {
  const ids = factSourceIds(attrs);
  let folded = attrs;
  if (ids.length > 0) {
    const retracted = new Set(
      (await findRetractionsFor(ids))
        .map((r) => r.retracts_capture_id)
        .filter((id): id is string => !!id),
    );
    if (retracted.size > 0) folded = foldRetractedFacts(attrs, retracted);
  }
  return Object.entries(unwrapAttributes(folded))
    .slice(0, NOTES_CAP)
    .map(([key, value]) => {
      const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
      return { key, value: s.length > NOTE_VALUE_MAX ? `${s.slice(0, NOTE_VALUE_MAX - 1)}…` : s };
    });
}

// One visit's detail, or null. viewerTechnicianId carries the SAME semantics
// as readBoardDays: set (technician) = only their own visits resolve — a
// crafted visitId for someone else's (or an unassigned) visit reads as
// null, indistinguishable from not-found, so the endpoint leaks nothing the
// day view wouldn't show. null/omitted = manager (any tenant visit).
export async function readVisitDetail(
  tenantId: string,
  visitId: string,
  viewerTechnicianId?: string | null,
): Promise<VisitDetail | null> {
  // ONE embedded read (was: assignment → job → customer → technician, four
  // serial round-trips, each waiting on the id from the one before).
  const row = await getVisitWithRefsForTenant(visitId, tenantId);
  if (!row) return null;
  // MEMBERSHIP (rung 9c): a crew-mate who was not named first still owns this
  // trip and must be able to open it.
  if (viewerTechnicianId != null && !participantIdsOf(row, tenantId).includes(viewerTechnicianId)) {
    return null;
  }
  // SECURITY: the embed's foreign keys are ID-ONLY, so every nested row is
  // re-checked against the tenant before use — the same guards the id-only
  // getJob/getCustomer reads required, plus the tenant scoping that
  // getTechnicianById used to apply in the query.
  const job = row.jobs && row.jobs.tenant_id === tenantId ? row.jobs : null;
  const customer =
    job && job.customers && job.customers.tenant_id === tenantId ? job.customers : null;
  const crew = participantsOf(row, tenantId);
  return {
    visitId: row.id,
    status: row.status,
    start: row.starts_at,
    end: row.ends_at,
    completedAt: row.completed_at,
    unassigned: participantIdsOf(row, tenantId).length === 0, // counted, not named
    technicianRef: crew[0]?.ref ?? null,
    technicianName: crew[0]?.displayName ?? null,
    technicianRefs: crew.map((p) => p.ref),
    technicianNames: crew.map((p) => p.displayName),
    // job/customer/technician are already tenant-gated above — no re-test here.
    // jobId gated on the tenant-checked job, NOT raw row.job_id (the day-view
    // precedent: never disclose another firm's job UUID).
    jobId: job ? row.job_id : null,
    jobTitle: job ? job.title : null,
    jobPriority: job ? job.priority : null,
    jobDurationMinutes: job ? job.duration_minutes : null,
    customerNotes: customer ? await composeCustomerNotes(customer.attributes) : [],
    customer:
      customer
        ? {
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
            address: formatAddress({
              address_line1: customer.address_line1,
              address_line2: customer.address_line2,
              city: customer.city,
              state: customer.state,
              postal_code: customer.postal_code,
            }),
          }
        : null,
  };
}
