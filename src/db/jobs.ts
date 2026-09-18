import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { participantIdsOf, type ParticipantIdEmbed } from './visits.js';

export type Job = Database['public']['Tables']['jobs']['Row'];
export type JobStatus = Database['public']['Enums']['job_status'];
export type JobPriority = Database['public']['Enums']['job_priority'];

// The customer fields a route/day view needs alongside a job — one embedded
// select instead of a per-row customer lookup.
export type JobCustomerAddress = Pick<
  Database['public']['Tables']['customers']['Row'],
  'name' | 'address_line1' | 'address_line2' | 'city' | 'state' | 'postal_code'
>;
export type JobWithCustomer = Job & { customers: JobCustomerAddress | null };

// Hardcoded, auditable state machine (overview §5: identity/pricing/status are
// code, not the model's guess). The authoritative "done" is a downstream event
// (invoice paid), so paid/cancelled/declined are terminal here.
//
// Money-ledger edges (plan 2026-08-15-money-ledger-v1): the invoiced/paid tail
// is DERIVED from money_events by syncJobStatusForMoney, walking these edges —
// never hand-advanced. Two deliberate backward edges keep derivation undoable:
//   completed → in_progress  (reopen: a new field note's 'in_progress'
//                             statusSignal legally revives a wrongly-completed
//                             job — no dedicated tool needed)
//   invoiced  → completed    (walk-down when every real invoice is voided)
// paid/cancelled/declined stay empty ⇒ the derived TERMINAL_STATUSES set
// (recordFieldNote) is unchanged — note-attachment and mint-guard behavior
// must not shift.
export const ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  open: ['in_progress', 'cancelled', 'declined'],
  in_progress: ['completed', 'cancelled'],
  completed: ['invoiced', 'in_progress'],
  invoiced: ['paid', 'completed'],
  paid: [],
  cancelled: [],
  declined: [],
};

// The states with no outgoing edge — DERIVED from the machine above, never hand
// listed, so a change up there cannot leave a stale copy behind. TWO readers
// need it and both mean the same thing by it, "you cannot put new work on this
// job": the write-path never reuses a terminal job for a new note
// (recordFieldNote), and the thread identity key never hands one back as the job
// to file a reply on (findCustomersByThread) — doing so would swallow the rung
// 10 ask, because the door only asks when it found NO job.
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set(
  (Object.keys(ALLOWED_TRANSITIONS) as JobStatus[]).filter(
    (status) => ALLOWED_TRANSITIONS[status].length === 0,
  ),
);

export interface CreateJobInput {
  tenantId: string;
  customerId: string;
  title?: string | null;
  jobType?: string | null;
  status?: JobStatus;
  // Dispatcher triage tier — scheduler code branches on it (find_slots scoring;
  // the future bump-the-bumpable). Default 'routine'.
  priority?: JobPriority;
  priceCents?: number | null;
  // How long the work takes (plan 4b-1) — the freeze's core input, which is why
  // it lives on the JOB and not only on a visit: the freeze places jobs that
  // have no visit yet. Null = never been told; readers stay fail-closed.
  durationMinutes?: number | null;
  attributes?: Json; // L3
  sourceCaptureId?: string | null;
}

export async function createJob(input: CreateJobInput): Promise<Job> {
  // Validated at BOTH typed-layer write points (here and updateJobDetails), so
  // "every stored duration is a whole 1..MAX minutes" holds no matter which
  // surface wrote it — the DB only checks > 0, by design (the ladder and its
  // bound must stay editable without a pilot migration).
  if (input.durationMinutes != null && !isValidDuration(input.durationMinutes)) {
    throw new Error(durationError());
  }
  const { data, error } = await getClient()
    .from('jobs')
    .insert({
      tenant_id: input.tenantId,
      customer_id: input.customerId,
      title: input.title ?? null,
      job_type: input.jobType ?? null,
      status: input.status ?? 'open',
      priority: input.priority ?? 'routine',
      price_cents: input.priceCents ?? null,
      duration_minutes: input.durationMinutes ?? null,
      attributes: input.attributes ?? {},
      source_capture_id: input.sourceCaptureId ?? null,
    })
    .select()
    .single();
  if (error || !data) throw new Error(`createJob failed: ${error?.message ?? 'no row returned'}`);
  return data;
}

// One CAS attempt at merging a standing-fact bundle under `key` — the job twin
// of trySetCustomerAttribute (see customers.ts for the why of the updated_at
// guard). Exported single-attempt so tests can force the CAS miss.
export async function trySetJobAttribute(row: Job, key: string, bundle: Json): Promise<Job | null> {
  const base =
    row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
      ? (row.attributes as Record<string, Json>)
      : null;
  // Refuse, never coerce (same rule as trySetCustomerAttribute): replacing a
  // non-object attributes value would silently destroy it.
  if (!base) {
    throw new Error(
      `trySetJobAttribute: attributes on job ${row.id} is not a JSON object — refusing to replace it`,
    );
  }
  const { data, error } = await getClient()
    .from('jobs')
    .update({ attributes: { ...base, [key]: bundle } })
    .eq('id', row.id)
    .eq('updated_at', row.updated_at)
    .select()
    .maybeSingle();
  if (error) throw new Error(`trySetJobAttribute failed: ${error.message}`);
  return data;
}

// Upsert one standing-fact key onto a job's L3 attributes (read → guarded
// merge, retried on a CAS miss). Tenant guarding is the caller's job.
export async function setJobAttribute(id: string, key: string, bundle: Json): Promise<Job> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getJob(id);
    if (!row) throw new Error(`setJobAttribute: job ${id} not found`);
    const updated = await trySetJobAttribute(row, key, bundle);
    if (updated) return updated;
  }
  throw new Error(`setJobAttribute: job ${id} changed concurrently; write not applied`);
}

export async function getJob(id: string): Promise<Job | null> {
  const { data, error } = await getClient().from('jobs').select().eq('id', id).maybeSingle();
  if (error) throw new Error(`getJob failed: ${error.message}`);
  return data;
}

// Oldest first, and the order is STABLE: `id` breaks a created_at tie. Postgres
// gives rows with equal sort keys no order, and two jobs minted in ONE
// transaction share created_at exactly (now() is fixed per transaction; separate
// requests almost never tie at microsecond precision). recordFieldNote reads the
// TAIL of this list as the newest job, so without the tiebreak one note could
// land on a different job on its next delivery. On a tie, the higher id is
// "newest": arbitrary, but the same answer every call.
export async function listJobsForCustomer(customerId: string): Promise<Job[]> {
  const { data, error } = await getClient()
    .from('jobs')
    .select()
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`listJobsForCustomer failed: ${error.message}`);
  return data ?? [];
}

/**
 * The customer's BOOKABLE work — what the customerId mint guard reads.
 * open + in_progress only: completed/invoiced/paid/cancelled jobs are history
 * and must never block booking genuinely new work.
 *
 * Tenant scoping: callers resolve and tenant-guard the customer row BEFORE
 * calling this (same contract as listJobsForCustomer above) — the customer id
 * itself is the proof of tenancy.
 */
export async function listOpenJobsForCustomer(customerId: string): Promise<Job[]> {
  const { data, error } = await getClient()
    .from('jobs')
    .select()
    .eq('customer_id', customerId)
    .in('status', ['open', 'in_progress'])
    // Same tiebreak as listJobsForCustomer: this order reaches the model in
    // openWorkSteer's text, which must not reshuffle between two calls.
    .order('created_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw new Error(`listOpenJobsForCustomer failed: ${error.message}`);
  return data ?? [];
}

// Jobs (with their customer's name + address embedded) for a set of ids —
// the day-route reader's batch lookup. Tenant-scoped in the query itself:
// this fans out to customer PII, so the guard lives here, not two files up
// in whichever caller happened to scope its ids. Empty input short-circuits:
// PostgREST's `in.()` with zero values is an error, not an empty result.
export async function listJobsWithCustomerByIds(
  tenantId: string,
  jobIds: string[],
): Promise<JobWithCustomer[]> {
  if (jobIds.length === 0) return [];
  // CHUNKED AND PAGED, like every other batched reader on the watcher's path.
  // This was a single unbounded query while its input was one day-route's jobs;
  // the nudge sweep now feeds it open nudges PLUS every open review item, and a
  // review item leaves the queue only when it is resolved or dismissed — so the
  // set grows with the manager's backlog rather than with the day. Past
  // PostgREST's silent 1000-row cap the result would quietly lose rows, and past
  // a few thousand ids the `in.()` would blow the URL. Both failures are silent,
  // which is the only reason this is worth the loop.
  const PAGE = 1000;
  // 150, not 500: an `in.()` id list rides in the URL, and PostgREST's gateway refuses
  // past ~8,192 bytes — ~205 UUIDs, measured (rawCaptures.ts findRetractionsFor).
  const CHUNK = 150;
  const rows: JobWithCustomer[] = [];
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const slice = jobIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('jobs')
        .select('*, customers(name, address_line1, address_line2, city, state, postal_code)')
        .eq('tenant_id', tenantId)
        .in('id', slice)
        // A stable order is REQUIRED for paging to be correct — without it
        // PostgREST may return overlapping or skipped rows across ranges.
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listJobsWithCustomerByIds failed: ${error.message}`);
      rows.push(...((data ?? []) as JobWithCustomer[]));
      if (!data || data.length < PAGE) break;
    }
  }
  return rows;
}

// Detector #2's candidates (plan 2026-08-19): jobs whose WORK is finished
// ('completed', 'invoiced' or 'paid') but whose parts cost was never recorded.
//
// Anchored on the ASSIGNMENT's end, not on a job status change, for three
// reasons: no job-status history exists (`jobs.updated_at` is bumped by any
// write); `updated_at` is real-UTC while the watcher's window is the firm's
// wall clock stored as if UTC, so filtering one with the other is silently off
// by the firm's offset; and the assignment is what supplies the technician to
// ask. It also bounds the first-run backfill to the same 72h window the visit
// detector uses, instead of surfacing every historical job at once.
//
// Rows with NOBODY ON THEM are DROPPED here: a visit's crew can be empty
// (20260717120000 made the person optional; rung 9c moved it to
// `visit_participants`), and createPendingNudge requires somebody — there is
// nobody to ask.
export type CostGapCandidate = {
  jobId: string;
  jobTitle: string | null;
  customerName: string | null;
  technicianId: string;
  endsAtLocal: string;
};

export async function listCostGapCandidates(
  tenantId: string,
  endedFromNaive: string, // ISO, firm wall-clock as if UTC — inclusive
  endedToNaive: string, // ISO, firm wall-clock as if UTC — exclusive
): Promise<CostGapCandidate[]> {
  // PAGED: the "somebody is on it" test moved from SQL (.not technician_id is
  // null) into JS with the crew, so this query now returns person-less rows too
  // and PostgREST's 1000-row cap would truncate before the filter ran. The order
  // is ends_at DESC and the dedup keeps the first row per job, so a truncation
  // would silently drop the jobs whose only in-window visit ended earliest.
  const PAGE = 1000;
  const rows: Array<{
    id: string;
    tenant_id: string;
    ends_at: string | null;
    job_id: string;
    jobs: { id: string; title: string | null; tenant_id: string; customers: { name: string } | null } | null;
    visit_participants: ParticipantIdEmbed[];
  }> = [];
  for (let fromRow = 0; ; fromRow += PAGE) {
  const { data, error } = await getClient()
    .from('visits')
    .select(
      'id, tenant_id, ends_at, job_id, jobs!inner(id, title, status, tenant_id, customers(name)), visit_participants(technician_id,created_at,tenant_id)',
    )
    .eq('tenant_id', tenantId)
    // 'completed' BELONGS here since rung 9b: a field note now marks the visit
    // it reports as completed, so filtering to 'confirmed' alone would go blind
    // on exactly the trips a technician told us about — which are the ones most
    // likely to have a cost to record.
    .in('status', ['confirmed', 'completed'])
    .gte('ends_at', endedFromNaive)
    .lt('ends_at', endedToNaive)
    // 'paid' BELONGS here (final-review finding): deriveStatusTarget walks a job
    // completed -> invoiced -> paid automatically the moment a payment clears the
    // balance, and this window only opens 3h after the visit ends — so a job the
    // customer settles on the spot is ALREADY 'paid' before the detector first
    // looks, and the 72h window then closes on it unasked, forever. It is also the
    // case where the gap costs most: revenue is known exactly, so the missing cost
    // is the only thing between the firm and knowing what the job made.
    // 'cancelled'/'declined' stay out — no work happened, so nothing was spent.
    .in('jobs.status', ['completed', 'invoiced', 'paid'])
    // DESCENDING, deliberately: the dedup below keeps the FIRST row per job, so
    // this makes that the job's MOST RECENT in-window visit. Ascending asked
    // whoever happened to go first on a multi-visit job — the wrong person to
    // ask what it ended up costing.
    .order('ends_at', { ascending: false })
    .order('id', { ascending: true }) // total order, or a page can repeat a row
    .range(fromRow, fromRow + PAGE - 1);
  if (error) throw new Error(`listCostGapCandidates failed: ${error.message}`);
    rows.push(...((data ?? []) as unknown as typeof rows));
    if (!data || data.length < PAGE) break;
  }
  const seen = new Set<string>();
  const out: CostGapCandidate[] = [];
  for (const r of rows) {
    // id-only-FK belt-and-suspenders (the boardRead pattern): the embed is
    // filtered in the query, re-checked here.
    if (!r.jobs || r.jobs.tenant_id !== tenantId) continue;
    if (!r.ends_at) continue;
    // WHO to ask, off the crew (rung 9c). A trip with nobody on it has nobody
    // to ask, so it is skipped exactly as a null technician_id used to be. On a
    // crew the tiebreak-first participant is asked — deterministic, so the same
    // job names the same person on every run rather than flipping between them.
    const crew = participantIdsOf(r, tenantId);
    if (crew.length === 0) continue;
    // ONE candidate per job — a job with three visits is still one cost
    // question (subject_ref is the job). MOST RECENT visit wins (see the
    // descending order above): the technician who was there last is the one who
    // knows what the job ended up costing.
    if (seen.has(r.job_id)) continue;
    seen.add(r.job_id);
    out.push({
      jobId: r.job_id,
      jobTitle: r.jobs.title,
      customerName: r.jobs.customers?.name ?? null,
      technicianId: crew[0],
      endsAtLocal: r.ends_at,
    });
  }
  return out;
}

export async function updateJobStatus(id: string, next: JobStatus): Promise<Job> {
  const current = await getJob(id);
  if (!current) throw new Error(`updateJobStatus: job ${id} not found`);
  const allowed = ALLOWED_TRANSITIONS[current.status];
  if (!allowed.includes(next)) {
    throw new Error(
      `Illegal job status transition: ${current.status} → ${next} ` +
        `(allowed: ${allowed.join(', ') || 'none'})`,
    );
  }
  // Guard the write on the status we validated against, so a concurrent
  // transition can't be silently lost: if another writer moved the job between
  // our read and this update, no row matches and we surface it instead of
  // overwriting.
  const { data, error } = await getClient()
    .from('jobs')
    .update({ status: next }) // updated_at is stamped by the DB trigger
    .eq('id', id)
    .eq('status', current.status)
    .select()
    .maybeSingle();
  if (error) throw new Error(`updateJobStatus failed: ${error.message}`);
  if (!data) {
    throw new Error(
      `updateJobStatus: job ${id} changed concurrently (was '${current.status}'); transition not applied`,
    );
  }
  return data;
}

// Correct a job's IDENTITY fields — title, type, priority — after creation.
// Born from a live E2E finding (2026-07-21): an agent-assumed title reached
// the record with no way to fix it from chat; record_standing_fact could only
// annotate, while the title kept displaying everywhere. Identity only: status
// has its own state machine above, and visits belong to move/cancel.
// The triage vocabulary, exported beside the type so every surface validates
// against ONE list (MCP handlers + the board job endpoint — plan 4a.5).
export const JOB_PRIORITIES: JobPriority[] = ['emergency', 'urgent', 'routine', 'maintenance'];

// ── Job duration (plan 4b-1) ────────────────────────────────────────────────
// The OFFERED job lengths (user decision 2026-07-24) — denser at the short end:
// a 15-minute error on a 30-minute call matters, on a 6-hour install it does
// not. Every surface offers THIS list (JOB_PRIORITIES precedent), but it is
// PRESENTATION, not validation: free minutes are accepted so a firm whose
// standard callout is 20 minutes is never forced to round to a lie.
export const DURATION_LADDER = [15, 30, 45, 60, 90, 120, 180, 240, 360, 480] as const;

// The bound catches typos (6000 for 600). A job estimate longer than a day is
// multi-visit work, not a bigger number.
export const MAX_DURATION_MINUTES = 1440;

export const isValidDuration = (m: unknown): m is number =>
  typeof m === 'number' && Number.isInteger(m) && m > 0 && m <= MAX_DURATION_MINUTES;

// '1h 30m' — ONE label composer, so chat and board agree verbatim.
export const formatDuration = (m: number): string =>
  m % 60 === 0 ? `${m / 60}h` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;

// The shared rejection text: states the bound, offers the ladder as choices —
// never as the allowed set (free minutes are legal).
export const durationError = (): string =>
  `durationMinutes must be a whole number of minutes from 1 to ${MAX_DURATION_MINUTES} ` +
  `(common lengths: ${DURATION_LADDER.join(', ')}; any other whole number is fine)`;

export interface UpdateJobDetailsInput {
  title?: string;
  // string = set (normalized lowercase — must match set_job_duration's
  // vocabulary); null = CLEAR back to untyped. Without the null arm, typing a
  // job would be a one-way door: find_slots treats a set type as
  // authoritative, so a mistaken type on the wrong job needs a real undo
  // (review finding — the tool's "reversible" claim must hold every way).
  jobType?: string | null;
  priority?: JobPriority;
  // number = set (any whole 1..MAX_DURATION_MINUTES — the ladder is offered,
  // not enforced); null = CLEAR back to unknown. The clear arm exists for the
  // same reason jobType's does: a wrong length is scheduling-authoritative, so
  // it needs a real undo, not just an overwrite.
  durationMinutes?: number | null;
}

export async function updateJobDetails(
  tenantId: string,
  jobId: string,
  input: UpdateJobDetailsInput,
  // CAS: the caller's snapshot of jobs.updated_at. The old→new echo the tool
  // returns is only honest if nothing moved between read and write
  // (updateJobStatus / trySetJobAttribute precedent).
  expectedUpdatedAt: string,
): Promise<Job> {
  const patch: Database['public']['Tables']['jobs']['Update'] = {};
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title) throw new Error('title must not be empty');
    patch.title = title;
  }
  if (input.jobType !== undefined) {
    if (input.jobType === null) {
      patch.job_type = null; // explicit clear — '' stays an error (accident guard)
    } else {
      // Same normalization as job_type_durations: scheduling matches the type
      // against the stored duration vocabulary, so casing must never miss.
      const jobType = input.jobType.trim().toLowerCase();
      if (!jobType) throw new Error('jobType must not be empty (pass null to clear the type)');
      patch.job_type = jobType;
    }
  }
  if (input.priority !== undefined) patch.priority = input.priority;
  if (input.durationMinutes !== undefined) {
    if (input.durationMinutes !== null && !isValidDuration(input.durationMinutes)) {
      throw new Error(durationError());
    }
    patch.duration_minutes = input.durationMinutes; // null = explicit clear
  }
  if (Object.keys(patch).length === 0) {
    throw new Error('nothing to update — pass title, jobType, priority, or durationMinutes');
  }
  const { data, error } = await getClient()
    .from('jobs')
    .update(patch)
    .eq('id', jobId)
    .eq('tenant_id', tenantId) // tenant guard: a cross-tenant id matches no row
    .eq('updated_at', expectedUpdatedAt)
    .select()
    .maybeSingle();
  if (error) throw new Error(`updateJobDetails failed: ${error.message}`);
  if (!data) {
    throw new Error(
      'job changed while updating (or not found) — re-read it and try again so the old→new report stays honest',
    );
  }
  return data;
}

// ── RUNG 10: what landed on the job, and what the caller said ───────────────

// The LINK. The twin of visit_notes one rung down: an inbound capture on an
// open job with no live trip had nowhere to point, so both evidence homes
// missed it and the job read silent. Idempotent by primary key — a redelivery is
// a NO-OP, not an error (the insertVisitNote idiom). `ignoreDuplicates` is what
// makes that `ON CONFLICT DO NOTHING`, and it must never become DO UPDATE: the
// job_captures_append_only trigger would raise on it.
export interface InsertJobCaptureInput {
  tenantId: string;
  jobId: string;
  captureId: string;
}

export async function insertJobCapture(input: InsertJobCaptureInput): Promise<void> {
  const { error } = await getClient()
    .from('job_captures')
    .upsert(
      { tenant_id: input.tenantId, job_id: input.jobId, capture_id: input.captureId },
      { onConflict: 'job_id,capture_id', ignoreDuplicates: true },
    );
  if (error) throw new Error(`insertJobCapture failed: ${error.message}`);
}

// True if this capture is linked to any job — one of the "already processed"
// markers captureHasLinkedL2 reads. Fleet-wide by capture id, exactly like
// captureHasVisitNote: holding the id is proof enough of tenancy.
export async function captureHasJobCapture(captureId: string): Promise<boolean> {
  const { data, error } = await getClient()
    .from('job_captures')
    .select('capture_id')
    .eq('capture_id', captureId)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`captureHasJobCapture failed: ${error.message}`);
  return !!data;
}

// Which jobs a capture is linked to — the listVisitNotesForCapture twin, and
// for the same reason: a retraction has to follow its target onto every link,
// or it lands on the record with no connection to what it neutralizes.
export async function listJobCapturesForCapture(
  captureId: string,
): Promise<{ job_id: string; tenant_id: string }[]> {
  const { data, error } = await getClient()
    .from('job_captures')
    .select('job_id, tenant_id')
    .eq('capture_id', captureId);
  if (error) throw new Error(`listJobCapturesForCapture failed: ${error.message}`);
  return data ?? [];
}

// The VALUES. `attributes.correspondence` is the job's running list of what
// customers said about it — one entry per inbound capture, each carrying the
// capture that evidences it. RESERVED: record_standing_fact refuses this key,
// because a standing fact is a scalar bundle and writing one here would replace
// the array outright.
export const CORRESPONDENCE_KEY = 'correspondence';

export interface JobCorrespondenceEntry {
  captureId: string;
  channel: string;
  at: string;
  /** What the caller asked us to do next, in the extractor's words. */
  followUp?: string;
  /** The extractor's long-tail L3 facts. NEVER laborHours/workPerformed — the
   *  report and the bill stay technician-only (rung 9b's line). */
  facts?: Record<string, Json>;
}

// Shape guard, exact-keys-free on purpose (entries are ours, not a user's, and
// a future field must not make old rows unreadable): the three required
// strings are what every reader relies on.
export function isCorrespondenceEntry(v: Json): v is JobCorrespondenceEntry & { [k: string]: Json } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, Json>;
  return typeof e.captureId === 'string' && typeof e.channel === 'string' && typeof e.at === 'string';
}

// The entries stored on a job, or [] when the key is absent or malformed.
export function correspondenceEntries(attrs: Json): JobCorrespondenceEntry[] {
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return [];
  const raw = (attrs as Record<string, Json>)[CORRESPONDENCE_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is JobCorrespondenceEntry & { [k: string]: Json } =>
    isCorrespondenceEntry(v ?? null),
  );
}

// The entries that WOULD fold if `captureId` were retracted — the predicate
// below, selecting instead of dropping. Lives here beside the fold for the
// factEntriesCiting reason: "what will disappear" (the retraction preview) and
// "what does disappear" (the fold) must never be able to drift apart.
export function correspondenceEntriesCiting(
  attrs: Json,
  captureId: string,
): JobCorrespondenceEntry[] {
  return correspondenceEntries(attrs).filter((e) => e.captureId === captureId);
}

// Drop entries whose evidence capture was retracted — the correspondence twin
// of foldRetractedFacts, and the only removal path (there is no delete tool).
// Retaining the key with an empty array would be a lie of a different shape, so
// an emptied list is removed outright.
export function foldRetractedCorrespondence(attrs: Json, retractedIds: ReadonlySet<string>): Json {
  if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs)) return attrs;
  const map = attrs as Record<string, Json>;
  if (!Array.isArray(map[CORRESPONDENCE_KEY])) return attrs;
  const kept = correspondenceEntries(attrs).filter((e) => !retractedIds.has(e.captureId));
  const out = { ...map };
  if (kept.length === 0) delete out[CORRESPONDENCE_KEY];
  else out[CORRESPONDENCE_KEY] = kept as unknown as Json;
  return out;
}

// APPEND one entry under CAS (the setJobAttribute loop): read → append →
// guarded write, retried on a concurrent change. Never a merge over the key —
// two emails on one job are two entries, and a merge would keep only the last.
// A null entry is a no-op: an inbound capture that yielded neither a follow-up
// nor a fact adds nothing but noise, and the job_captures link already records
// that it landed.
export async function appendJobCorrespondence(
  jobId: string,
  entry: JobCorrespondenceEntry | null,
): Promise<Job | null> {
  if (!entry) return null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getJob(jobId);
    if (!row) throw new Error(`appendJobCorrespondence: job ${jobId} not found`);
    const existing = correspondenceEntries(row.attributes);
    // Idempotent under redelivery: one capture leaves one entry.
    if (existing.some((e) => e.captureId === entry.captureId)) return row;
    const updated = await trySetJobAttribute(row, CORRESPONDENCE_KEY, [
      ...existing,
      entry,
    ] as unknown as Json);
    if (updated) return updated;
  }
  throw new Error(`appendJobCorrespondence: job ${jobId} changed concurrently; write not applied`);
}
