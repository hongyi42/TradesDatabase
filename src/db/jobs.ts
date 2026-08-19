import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';

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

export async function listJobsForCustomer(customerId: string): Promise<Job[]> {
  const { data, error } = await getClient()
    .from('jobs')
    .select()
    .eq('customer_id', customerId)
    .order('created_at', { ascending: true });
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
    .order('created_at', { ascending: true });
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
  const { data, error } = await getClient()
    .from('jobs')
    .select('*, customers(name, address_line1, address_line2, city, state, postal_code)')
    .eq('tenant_id', tenantId)
    .in('id', jobIds);
  if (error) throw new Error(`listJobsWithCustomerByIds failed: ${error.message}`);
  return (data ?? []) as JobWithCustomer[];
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
// Rows with no technician are DROPPED here: assignments.technician_id has been
// nullable since 20260717120000, and createPendingNudge requires one — there is
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
  const { data, error } = await getClient()
    .from('assignments')
    .select('technician_id, ends_at, job_id, jobs!inner(id, title, status, tenant_id, customers(name))')
    .eq('tenant_id', tenantId)
    .eq('status', 'confirmed')
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
    .not('technician_id', 'is', null)
    // DESCENDING, deliberately: the dedup below keeps the FIRST row per job, so
    // this makes that the job's MOST RECENT in-window visit. Ascending asked
    // whoever happened to go first on a multi-visit job — the wrong person to
    // ask what it ended up costing.
    .order('ends_at', { ascending: false });
  if (error) throw new Error(`listCostGapCandidates failed: ${error.message}`);
  const rows = (data ?? []) as unknown as Array<{
    technician_id: string | null;
    ends_at: string | null;
    job_id: string;
    jobs: { id: string; title: string | null; tenant_id: string; customers: { name: string } | null } | null;
  }>;
  const seen = new Set<string>();
  const out: CostGapCandidate[] = [];
  for (const r of rows) {
    // id-only-FK belt-and-suspenders (the boardRead pattern): the embed is
    // filtered in the query, re-checked here.
    if (!r.jobs || r.jobs.tenant_id !== tenantId) continue;
    if (!r.technician_id || !r.ends_at) continue;
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
      technicianId: r.technician_id,
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
