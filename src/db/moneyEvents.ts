import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { ALLOWED_TRANSITIONS, getJob, updateJobStatus, type JobStatus } from './jobs.js';
import { getRawCapture, wrapDbError } from './rawCaptures.js';

export type MoneyEvent = Database['public']['Tables']['money_events']['Row'];
export type MoneyEventKind = Database['public']['Enums']['money_event_kind'];

// Runtime vocabulary (MCP handlers validate free strings against THIS list —
// the JOB_PRIORITIES precedent: one exported list, every surface checks it).
export const MONEY_EVENT_KINDS: MoneyEventKind[] = [
  'fee_charged',
  'estimate_presented',
  'estimate_approved',
  'estimate_declined',
  'change_order',
  'invoice_issued',
  'invoice_voided',
  'payment_received',
  'payment_refunded',
  'credit_applied',
  'write_off',
  'correction',
  // What the job COST the firm in parts/materials (plan 2026-08-19). A COST
  // row, not an AR row: it never touches balance due, and cannot advance or
  // walk back job status. Direction comes from `kind` — the amount is still
  // >= 0, like every other kind.
  'material_cost',
];

// Kinds that legitimately carry no amount: a declined estimate is an outcome,
// not a number — and a void/correction cancels its TARGET whole, so its own
// amount is decorative (review finding: requiring one taught callers that
// "correction, amountCents: 5000" means a $50 adjustment; it never did). When
// a void/correction DOES state an amount it must equal the target's, as a
// checksum. Every other kind must state one — direction comes from `kind`,
// never sign.
const AMOUNTLESS_KINDS: ReadonlySet<MoneyEventKind> = new Set([
  'estimate_declined',
  'invoice_voided',
  'correction',
]);

// Kinds whose meaning IS "negate that other row" — they must say which row.
// An unreferenced void/correction would be a silent no-op the fold ignores
// while the balance stays wrong (plan review finding). They may NOT target
// another void/correction: negation is one-level by design, so "correcting a
// void" would be accepted and change nothing — the remedy for a mistaken void
// is RE-ISSUING the cancelled entry (review finding).
const MUST_REFERENCE: ReadonlySet<MoneyEventKind> = new Set(['invoice_voided', 'correction']);
// Shape-checked before it can reach a uuid column: PostgREST answers a
// malformed uuid with an error (22P02), and a mistyped provenance id must cost
// the LINK, never the amount. Same guard shape as nudgeDecisions' safeJobId.
const CAPTURE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Exported so "is this row still live?" has exactly ONE definition — the fold
// (negatedIds) and the cost probe (listJobIdsWithCostEvents) both read it, so a
// new negating kind cannot land in one and be silently forgotten in the other.
export const NEGATING_KINDS: ReadonlySet<MoneyEventKind> = MUST_REFERENCE;

export interface AppendMoneyEventInput {
  tenantId: string;
  jobId: string;
  kind: MoneyEventKind;
  amountCents?: number | null;
  currency?: string;
  occurredAt?: string | null;
  actorRef?: string | null;
  sourceCaptureId?: string | null;
  correctsEventId?: number | null;
  method?: string | null;
  externalRef?: string | null;
  /**
   * Idempotency key (partial unique per tenant). Inferred/spine-generated
   * writers mint one so replays collide on 23505 and converge; manual entries
   * pass null and are never blocked.
   */
  dedupeKey?: string | null;
  detail?: Json;
}

const isWholeNonNegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= 0;

/**
 * Append one money fact. Insert only — the table is trigger-enforced
 * append-only; corrections are new rows. Validation here is the write-side
 * guard for every surface (MCP tool, future inference), so it is strict:
 * kind vocabulary, amount rules, tenant/job coherence, and reference rules
 * for voids/corrections. SQLSTATE is preserved (rawCaptures precedent) so
 * callers can detect dedupe collisions with isUniqueViolation.
 */
export async function appendMoneyEvent(input: AppendMoneyEventInput): Promise<MoneyEvent> {
  if (!MONEY_EVENT_KINDS.includes(input.kind)) {
    throw new Error(
      `appendMoneyEvent: unknown kind '${String(input.kind)}' (allowed: ${MONEY_EVENT_KINDS.join(', ')})`,
    );
  }
  const amount = input.amountCents ?? null;
  if (AMOUNTLESS_KINDS.has(input.kind)) {
    if (amount != null && !isWholeNonNegative(amount)) {
      throw new Error('appendMoneyEvent: amountCents must be a whole number of cents >= 0');
    }
  } else if (!isWholeNonNegative(amount)) {
    throw new Error(
      `appendMoneyEvent: kind '${input.kind}' requires amountCents as a whole number of cents >= 0 ` +
        '(direction comes from the kind, never a sign)',
    );
  }

  const job = await getJob(input.jobId);
  if (!job || job.tenant_id !== input.tenantId) {
    // Cross-tenant ids get the same answer as unknown ids — no existence oracle.
    throw new Error(`appendMoneyEvent: job ${input.jobId} not found for this tenant`);
  }

  // Provenance — which capture this amount came from. Optional, and its guard is
  // deliberately the OPPOSITE of the job guard above: a bad value drops the LINK
  // and records the amount anyway. An amount that fails to record because its
  // provenance was mistyped is strictly worse than an amount recorded without
  // provenance, and unlike jobId this is not load-bearing for anything.
  //
  // Unknown and cross-tenant get the SAME outcome and the SAME message, for the
  // reason the job guard states: no existence oracle. A caller must not be able
  // to learn that an id exists in some other firm's record by watching which
  // way this behaves.
  // `||`, not `??`: an empty string is truthy-adjacent enough to survive `??`
  // and falsy enough to skip the guard below, so it would sail through to a uuid
  // column and take the whole entry down with it — the exact outcome this guard
  // exists to prevent. safeJobId (nudgeDecisions.ts) gets this right with an
  // explicit `if (!jobId) return null`.
  let sourceCaptureId = input.sourceCaptureId || null;
  if (sourceCaptureId) {
    const capture = CAPTURE_ID_RE.test(sourceCaptureId) ? await getRawCapture(sourceCaptureId) : null;
    if (!capture || capture.tenant_id !== input.tenantId) {
      console.error(
        `[moneyEvents] sourceCaptureId ${sourceCaptureId} is not a capture in this tenant — ` +
          'recording the amount without it',
      );
      sourceCaptureId = null;
    }
  }

  if (MUST_REFERENCE.has(input.kind)) {
    if (input.correctsEventId == null) {
      throw new Error(
        `appendMoneyEvent: kind '${input.kind}' requires correctsEventId — an unreferenced ` +
          'void/correction would silently change nothing',
      );
    }
  }
  if (input.correctsEventId != null) {
    const target = await getMoneyEvent(input.correctsEventId);
    if (!target || target.tenant_id !== input.tenantId || target.job_id !== input.jobId) {
      throw new Error(
        `appendMoneyEvent: correctsEventId ${input.correctsEventId} is not an event on this job`,
      );
    }
    if (input.kind === 'invoice_voided' && target.kind !== 'invoice_issued') {
      throw new Error(
        `appendMoneyEvent: invoice_voided must target an invoice_issued event (got '${target.kind}')`,
      );
    }
    if (NEGATING_KINDS.has(input.kind) && NEGATING_KINDS.has(target.kind)) {
      throw new Error(
        `appendMoneyEvent: cannot ${input.kind} a '${target.kind}' entry — negation is ` +
          'one-level; to undo a mistaken void/correction, RE-ISSUE the cancelled entry instead',
      );
    }
    // Checksum: a stated amount on a void/correction must equal the target's —
    // it cancels the WHOLE entry, never a part of it. A partial adjustment is
    // void/correct-then-re-enter.
    if (
      NEGATING_KINDS.has(input.kind) &&
      amount != null &&
      amount !== (target.amount_cents ?? 0)
    ) {
      throw new Error(
        `appendMoneyEvent: a ${input.kind} cancels the WHOLE entry (${target.amount_cents ?? 0} ` +
          `cents), not a part of it — omit amountCents or state ${target.amount_cents ?? 0}; ` +
          'for a partial adjustment, cancel the entry and re-enter the right amount',
      );
    }
  }

  const { data, error } = await getClient()
    .from('money_events')
    .insert({
      tenant_id: input.tenantId,
      job_id: input.jobId,
      kind: input.kind,
      amount_cents: amount,
      currency: input.currency ?? 'USD',
      ...(input.occurredAt ? { occurred_at: input.occurredAt } : {}),
      actor_ref: input.actorRef ?? null,
      source_capture_id: sourceCaptureId,
      corrects_event_id: input.correctsEventId ?? null,
      method: input.method ?? null,
      external_ref: input.externalRef ?? null,
      dedupe_key: input.dedupeKey ?? null,
      detail: input.detail ?? {},
    })
    .select()
    .single();
  if (error || !data) {
    // Preserve SQLSTATE so callers can detect a dedupe collision (23505).
    throw wrapDbError('appendMoneyEvent failed', error);
  }
  return data;
}

export async function getMoneyEvent(id: number): Promise<MoneyEvent | null> {
  const { data, error } = await getClient()
    .from('money_events')
    .select()
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getMoneyEvent failed: ${error.message}`);
  return data;
}

/**
 * The row a dedupe key already wrote, or null — what a writer re-reads after its
 * insert lost a 23505 on uq_money_events_dedupe (the key is unique per tenant).
 */
export async function getMoneyEventByDedupeKey(
  tenantId: string,
  dedupeKey: string,
): Promise<MoneyEvent | null> {
  const { data, error } = await getClient()
    .from('money_events')
    .select()
    .eq('tenant_id', tenantId)
    .eq('dedupe_key', dedupeKey)
    .maybeSingle();
  if (error) throw wrapDbError('getMoneyEventByDedupeKey failed', error);
  return data;
}

/** The ledger rows that cite one capture as their source, in id order. */
export async function listMoneyEventsCitingCapture(
  tenantId: string,
  captureId: string,
): Promise<MoneyEvent[]> {
  const { data, error } = await getClient()
    .from('money_events')
    .select()
    .eq('tenant_id', tenantId)
    .eq('source_capture_id', captureId)
    .order('id', { ascending: true });
  if (error) throw wrapDbError('listMoneyEventsCitingCapture failed', error);
  return data ?? [];
}

/** All events for one job, in ledger (id) order — the fold's required input. */
export async function listMoneyEventsForJob(tenantId: string, jobId: string): Promise<MoneyEvent[]> {
  const { data, error } = await getClient()
    .from('money_events')
    .select()
    .eq('tenant_id', tenantId)
    .eq('job_id', jobId)
    .order('id', { ascending: true });
  if (error) throw new Error(`listMoneyEventsForJob failed: ${error.message}`);
  return data ?? [];
}

/** Batch variant for context reads. Empty input short-circuits (PostgREST `in.()` errors). */
export async function listMoneyEventsForJobs(
  tenantId: string,
  jobIds: string[],
): Promise<MoneyEvent[]> {
  if (jobIds.length === 0) return [];
  const { data, error } = await getClient()
    .from('money_events')
    .select()
    .eq('tenant_id', tenantId)
    .in('job_id', jobIds)
    .order('id', { ascending: true });
  if (error) throw new Error(`listMoneyEventsForJobs failed: ${error.message}`);
  return data ?? [];
}

// Which of these jobs already have a LIVE cost recorded? The batched,
// in()-bounded shape the watcher's sweep needs (the listNudgedSubjectRefs
// pattern — never a tenant-wide scan). Kind-scoped: only 'material_cost'
// counts as "cost recorded", so a job with invoices but no cost is still a gap.
//
// LIVE is the load-bearing word (final-review finding). A mistaken cost is
// never edited, it is CANCELLED by a new row pointing at it — the same fold
// summarizeMoney applies. A raw kind='material_cost' probe counted a cancelled
// row as real, so correcting a typo suppressed the gap FOREVER: subject_ref is
// the job and uq_nudges_subject_ever is any-status, so that job could never be
// asked again. Doing the right thing was what buried it.
export async function listJobIdsWithCostEvents(
  tenantId: string,
  jobIds: string[],
): Promise<string[]> {
  if (jobIds.length === 0) return []; // PostgREST `in.()` with zero values errors
  const PAGE = 1000;
  // Chunked: costIds feeds an `in.()` and a very large list would blow the URL,
  // which PostgREST answers with an error rather than a truncation.
  // 150, not 500: an `in.()` id list rides in the URL, and PostgREST's gateway refuses
  // past ~8,192 bytes — ~205 UUIDs, measured (rawCaptures.ts findRetractionsFor).
  const CHUNK = 150;

  // (1) Every material_cost row on these jobs — id AND job_id, because step 2
  // needs the ids to ask what was cancelled.
  const costRows: { id: number; job_id: string }[] = [];
  // The INCOMING jobIds are chunked too, for the same reason costIds are: the
  // nudge sweep now passes open nudges plus every open review item, a set that
  // grows with the manager's backlog rather than with the day.
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const jobSlice = jobIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('money_events')
        .select('id, job_id')
        .eq('tenant_id', tenantId)
        .eq('kind', 'material_cost')
        .in('job_id', jobSlice)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listJobIdsWithCostEvents failed: ${error.message}`);
      costRows.push(...((data ?? []) as { id: number; job_id: string }[]));
      if (!data || data.length < PAGE) break;
    }
  }
  if (costRows.length === 0) return [];

  // (2) The rows that CANCEL any of them. Matched on corrects_event_id rather
  // than job_id: appendMoneyEvent refuses a reference to another job's event
  // ("not an event on this job"), but the COLUMN carries no such constraint —
  // it is a bare FK to money_events.id — so matching the id directly is exact
  // without depending on that application-layer invariant holding for every
  // row ever written.
  const costIds = costRows.map((r) => r.id);
  const negated = new Set<number>();
  for (let i = 0; i < costIds.length; i += CHUNK) {
    const slice = costIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('money_events')
        .select('corrects_event_id')
        .eq('tenant_id', tenantId)
        .in('kind', [...NEGATING_KINDS])
        .in('corrects_event_id', slice)
        .order('corrects_event_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listJobIdsWithCostEvents failed: ${error.message}`);
      for (const r of (data ?? []) as { corrects_event_id: number | null }[]) {
        if (r.corrects_event_id != null) negated.add(r.corrects_event_id);
      }
      if (!data || data.length < PAGE) break;
    }
  }

  // A job is "already costed" only if it still has a LIVE cost row. Two
  // cancelled rows and one live one still counts; all cancelled does not.
  return [...new Set(costRows.filter((r) => !negated.has(r.id)).map((r) => r.job_id))];
}

// Money that LANDED on these jobs after a bound — the planner's evidence read
// (plan 2026-08-21 ①). Batched and paged like listJobIdsWithCostEvents, never a
// tenant-wide scan, and deliberately NOT modelled on listMoneyEventsForJobs
// above: that one has no paging loop and is exposed to PostgREST's silent
// 1000-row cap.
//
// The bound is `created_at`, not `occurred_at`. Two reasons, and the second is
// the load-bearing one: (a) a payment that HAPPENED before the question was
// asked but was RECORDED after it is still the person answering, and (b)
// `occurred_at` is caller-supplied (appendMoneyEvent takes it as input) while
// `created_at` is never set by the insert — so only `created_at` is unspoofable.
//
// "Live" here means what summarizeMoney means by it, because there is exactly
// ONE definition (see NEGATING_KINDS): a row is dropped if something cancels
// it, AND the cancelling rows themselves are dropped. Without the second half a
// correction would render to the planner as fresh money. Note `payment_refunded`
// is deliberately NOT a negation — the fold handles it by subtraction — so a
// refunded payment still appears here, which is correct: it is still something
// that landed on the job and the planner is entitled to weigh it.
export async function listLiveMoneyEventsForJobsSince(
  tenantId: string,
  jobIds: string[],
  sinceIso: string,
): Promise<MoneyEvent[]> {
  if (jobIds.length === 0) return []; // PostgREST `in.()` with zero values errors
  const PAGE = 1000;
  // 150, not 500: an `in.()` id list rides in the URL, and PostgREST's gateway refuses
  // past ~8,192 bytes — ~205 UUIDs, measured (rawCaptures.ts findRetractionsFor).
  const CHUNK = 150;

  // (1) Everything on these jobs inside the window.
  const rows: MoneyEvent[] = [];
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const jobSlice = jobIds.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('money_events')
        .select()
        .eq('tenant_id', tenantId)
        .in('job_id', jobSlice)
        .gt('created_at', sinceIso)
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listLiveMoneyEventsForJobsSince failed: ${error.message}`);
      rows.push(...((data ?? []) as MoneyEvent[]));
      if (!data || data.length < PAGE) break;
    }
  }
  if (rows.length === 0) return [];

  // (2) What cancels any of them. NO time filter — not because one would break
  // it today (a canceller is always written after its target, so any canceller
  // of an in-window row is itself in-window; this was probed with a mutation and
  // the filtered variant passed), but because the filter would be load-bearing
  // for a reason nothing states and nothing tests. The unfiltered query is the
  // simpler one and stays correct if `created_at` ever stops being insert-time.
  const ids = rows.map((r) => r.id);
  const negated = new Set<number>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await getClient()
        .from('money_events')
        .select('corrects_event_id')
        .eq('tenant_id', tenantId)
        .in('kind', [...NEGATING_KINDS])
        .in('corrects_event_id', slice)
        .order('corrects_event_id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`listLiveMoneyEventsForJobsSince failed: ${error.message}`);
      for (const r of (data ?? []) as { corrects_event_id: number | null }[]) {
        if (r.corrects_event_id != null) negated.add(r.corrects_event_id);
      }
      if (!data || data.length < PAGE) break;
    }
  }

  return rows.filter((r) => !negated.has(r.id) && !NEGATING_KINDS.has(r.kind));
}

export interface MoneySummary {
  /** Last approved estimate + change orders after that approval. */
  quotedCents: number;
  /** Σ invoices, minus voided/corrected ones. */
  invoicedCents: number;
  /** Σ payments − Σ refunds. */
  paidCents: number;
  creditsCents: number;
  writtenOffCents: number;
  /** invoiced − paid − credits − write-offs. Negative = customer credit. */
  balanceDueCents: number;
  /**
   * Σ material_cost — what the job COST the firm in parts/materials.
   * DELIBERATELY absent from balanceDueCents: cost is not receivable. This is
   * also NOT margin — there is no labour rate, so revenue − this is not profit.
   */
  materialCostCents: number;
  lastEventAt: string | null;
  hasProgressInvoice: boolean;
}

const isProgress = (e: MoneyEvent): boolean =>
  !!e.detail && typeof e.detail === 'object' && !Array.isArray(e.detail) &&
  (e.detail as Record<string, Json>).progress === true;

// Ids negated by a later invoice_voided/correction row. "Negated" is derived,
// never stored — the retraction-fold pattern applied to money.
function negatedIds(events: MoneyEvent[]): Set<number> {
  const out = new Set<number>();
  for (const e of events) {
    if (NEGATING_KINDS.has(e.kind) && e.corrects_event_id != null) {
      out.add(e.corrects_event_id);
    }
  }
  return out;
}

/**
 * Fold the ledger into current money state. Pure — same list in, same summary
 * out; all surfaces (tool replies, context reads, status derivation) call THIS
 * so there is exactly one definition of "the balance".
 */
export function summarizeMoney(events: MoneyEvent[]): MoneySummary {
  const negated = negatedIds(events);
  const live = events.filter(
    (e) => !negated.has(e.id) && e.kind !== 'invoice_voided' && e.kind !== 'correction',
  );

  // quoted: the LAST approved estimate wins; change orders only count after it
  // (a re-approval supersedes earlier deltas — plan review finding).
  let quoted = 0;
  let lastApprovalIdx = -1;
  live.forEach((e, i) => {
    if (e.kind === 'estimate_approved') lastApprovalIdx = i;
  });
  if (lastApprovalIdx >= 0) {
    quoted = live[lastApprovalIdx].amount_cents ?? 0;
    for (let i = lastApprovalIdx + 1; i < live.length; i++) {
      if (live[i].kind === 'change_order') quoted += live[i].amount_cents ?? 0;
    }
  }

  const sum = (kind: MoneyEventKind): number =>
    live.reduce((acc, e) => (e.kind === kind ? acc + (e.amount_cents ?? 0) : acc), 0);

  const invoiced = sum('invoice_issued');
  const paid = sum('payment_received') - sum('payment_refunded');
  const credits = sum('credit_applied');
  const writtenOff = sum('write_off');
  // Folded like every other kind — so `correction` negation works on it for
  // free (negatedIds/live above are kind-agnostic) — but kept OUT of the AR
  // arithmetic below.
  const materialCost = sum('material_cost');

  let lastEventAt: string | null = null;
  for (const e of events) {
    if (lastEventAt === null || e.occurred_at > lastEventAt) lastEventAt = e.occurred_at;
  }

  return {
    quotedCents: quoted,
    invoicedCents: invoiced,
    paidCents: paid,
    creditsCents: credits,
    writtenOffCents: writtenOff,
    balanceDueCents: invoiced - paid - credits - writtenOff,
    materialCostCents: materialCost,
    lastEventAt,
    hasProgressInvoice: live.some((e) => e.kind === 'invoice_issued' && isProgress(e)),
  };
}

/**
 * What the ledger says the job's status SHOULD be — or null for "no opinion".
 * Pure. Gate first: at least one live, NON-PROGRESS invoice must exist, else
 * the ledger derives nothing (all-progress chains and deposit-only chains
 * leave status entirely to the work signals — the workflow-agnostic guard).
 * Downward: if the gate stops holding (every real invoice voided) and the job
 * sits at 'invoiced', it walks back to 'completed'. 'paid' never walks back
 * (no backward edge — keeping it terminal preserves TERMINAL_STATUSES and
 * every reader built on it).
 */
export function deriveStatusTarget(
  current: JobStatus,
  summary: MoneySummary,
  events: MoneyEvent[],
): JobStatus | null {
  if (current === 'cancelled' || current === 'declined') return null;

  const negated = negatedIds(events);
  const gate = events.some(
    (e) => e.kind === 'invoice_issued' && !negated.has(e.id) && !isProgress(e),
  );

  if (!gate) {
    // Downward only when the gate STOPPED holding — a real invoice existed and
    // was voided. A job that reached 'invoiced' with no ledger invoice at all
    // (pre-ledger data, hand-walked seeds) is none of the ledger's business:
    // record the event, leave status alone (review finding). Accepted limit of
    // this proxy: a pre-ledger invoiced job whose OFF-ledger invoice is still
    // outstanding, if it later gains and then voids a ledger invoice, walks
    // down to 'completed' — the ledger can't see paper it never held. The fix
    // for that firm is recording the real invoice, not code.
    const hadRealInvoice = events.some(
      (e) => e.kind === 'invoice_issued' && negated.has(e.id) && !isProgress(e),
    );
    return current === 'invoiced' && hadRealInvoice ? 'completed' : null;
  }
  if (current === 'paid') return null;
  // Past the gate, paid = nothing left to collect. No invoicedCents > 0 guard:
  // a $0 comped/warranty invoice is legal end-to-end and must settle to 'paid',
  // not strand at 'invoiced' forever (review finding — the gate already
  // guarantees a real invoice exists).
  const target: JobStatus = summary.balanceDueCents <= 0 ? 'paid' : 'invoiced';
  return target === current ? null : target;
}

// Shortest legal path between two statuses over ALLOWED_TRANSITIONS (BFS with
// the path carried in the queue — robust to edge additions and to the cycles
// the backward edges introduce; the graph is 7 nodes, so the copying is free).
function transitionPath(from: JobStatus, to: JobStatus): JobStatus[] | null {
  if (from === to) return []; // total for any caller; the sole current caller pre-filters this
  const seen = new Set<JobStatus>([from]);
  const queue: Array<[JobStatus, JobStatus[]]> = [[from, []]];
  while (queue.length > 0) {
    const [at, path] = queue.shift() as [JobStatus, JobStatus[]];
    for (const next of ALLOWED_TRANSITIONS[at]) {
      if (seen.has(next)) continue;
      seen.add(next);
      const nextPath = [...path, next];
      if (next === to) return nextPath;
      queue.push([next, nextPath]);
    }
  }
  return null;
}

const isConcurrentTransition = (err: unknown): boolean =>
  err instanceof Error && err.message.includes('changed concurrently');
// The exact prefix updateJobStatus throws for an edge the machine does not have.
const isIllegalTransition = (err: unknown): boolean =>
  err instanceof Error && err.message.startsWith('Illegal job status transition');

/**
 * Re-derive the job's money-target and walk the status there through LEGAL
 * transitions only (one write path: updateJobStatus, CAS-guarded per hop).
 * Both directions. Silent when the ledger has no opinion, the target is
 * unreachable, or a concurrent writer wins after one retry — recording the
 * event always succeeds independently of the walk (plan decision). Any OTHER
 * failure (network, grants) is re-thrown: swallowing it as if it were a race
 * would leave a mid-path job with no signal to anyone (review finding) — the
 * caller decides how to report a landed event whose walk failed.
 */
export async function syncJobStatusForMoney(
  tenantId: string,
  jobId: string,
): Promise<{ from: JobStatus; to: JobStatus } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const job = await getJob(jobId);
    if (!job || job.tenant_id !== tenantId) return null;
    const events = await listMoneyEventsForJob(tenantId, jobId);
    const target = deriveStatusTarget(job.status, summarizeMoney(events), events);
    if (!target) return null;
    const path = transitionPath(job.status, target);
    if (!path || path.length === 0) return null;
    // Where the walk has got to: the status after the last hop that landed.
    let at: JobStatus = job.status;
    try {
      for (const hop of path) {
        await updateJobStatus(jobId, hop);
        at = hop;
      }
      return { from: job.status, to: target };
    } catch (err) {
      // updateJobStatus re-reads the job before its CAS, so a writer that moved
      // it between OUR last hop and that read surfaces as an "illegal
      // transition" (e.g. invoiced → invoiced when two issues sync at once), not
      // as "changed concurrently". Only THAT error, and only when the job really
      // is no longer where our walk left it, is a race; anything else re-throws.
      const movedUnderUs =
        isIllegalTransition(err) && (await getJob(jobId))?.status !== at;
      if (!isConcurrentTransition(err) && !movedUnderUs) throw err;
      // Concurrent transition — loop re-reads and re-derives once, then gives up.
    }
  }
  return null;
}

/**
 * The technician projection of a money summary — STATUS IN WORDS, NO FIGURES.
 * ONE definition of the money tier boundary (review finding: it was inline in
 * two read tools; policy encoded twice drifts).
 *
 * It used to return the two "door numbers", `balanceDueCents` + `invoicedCents`.
 * The operator removed both on 2026-09-15: the invoice amount is what the
 * customer was charged, and balance due EQUALS it until something is paid, so
 * keeping either one told a technician the price. A firm whose technician really
 * needs the figure — collecting a payment on site — asks the manager for it, in
 * life or through the access request flow. That makes it a thing you ask for
 * rather than a default, which is the whole point.
 *
 * Deliberately no booleans and no "roughly": a number is a number however it is
 * rounded, and a flag pair reconstructs one.
 */
export type TechnicianMoneyStatus =
  | 'nothing recorded yet'
  | 'recorded, nothing owed'
  | 'quoted, nothing invoiced yet'
  | 'invoiced, not yet paid'
  | 'part paid, balance outstanding'
  | 'deposit paid, more to invoice'
  | 'paid in full'
  | 'settled, no balance due'
  | 'the office holds a credit';

export function technicianMoneyView(
  s: MoneySummary,
  // MAY SHE BE TOLD THE FIGURES? Answered by the layer — the firm's rule, or a
  // grant on this customer or job (view_money_open) — never by a tier test here:
  // status-only is the DEFAULT, not a ceiling (operator, 2026-09-15). When it is
  // open she gets the door numbers beside the status: totals only, no methods,
  // no references, no history.
  opts: { amounts?: boolean } = {},
): { status: TechnicianMoneyStatus; balanceDueCents?: number; invoicedCents?: number } {
  if (opts.amounts) {
    return {
      ...technicianMoneyView(s),
      balanceDueCents: s.balanceDueCents,
      invoicedCents: s.invoicedCents,
    };
  }
  return statusOnly(s);
}

function statusOnly(s: MoneySummary): { status: TechnicianMoneyStatus } {
  // Order matters: a credit balance is read before "settled", "settled" (cleared
  // by a credit or a write-off rather than by payment) before "paid", and a
  // PROGRESS invoice before either — a cleared deposit is not a finished job, and
  // the job's own state machine refuses `paid` there too (deriveStatusTarget).
  if (s.invoicedCents === 0) {
    // Money taken before anything was invoiced is a DEPOSIT, not a credit the
    // firm owes back — balanceDue is negative in both, which is why this is read
    // before the credit branch (review finding). Deposit-only chains are a real
    // shape here: deriveStatusTarget names them too.
    if (s.paidCents > 0) return { status: 'deposit paid, more to invoice' };
    if (s.quotedCents > 0) return { status: 'quoted, nothing invoiced yet' };
    // A ledger with rows whose AR totals are zero is NOT an empty ledger: a
    // voided invoice, a $0 comped job, a fee, a material cost, an estimate that
    // was only presented. "Nothing recorded" would be a lie the reader cannot
    // check (review finding) — and the empty case never reaches here anyway,
    // because both callers omit the money block when the ledger has no rows.
    return { status: s.lastEventAt ? 'recorded, nothing owed' : 'nothing recorded yet' };
  }
  if (s.balanceDueCents < 0) return { status: 'the office holds a credit' };
  if (s.balanceDueCents > 0) {
    return { status: s.paidCents > 0 ? 'part paid, balance outstanding' : 'invoiced, not yet paid' };
  }
  if (s.hasProgressInvoice) return { status: 'deposit paid, more to invoice' };
  return { status: s.paidCents >= s.invoicedCents ? 'paid in full' : 'settled, no balance due' };
}
