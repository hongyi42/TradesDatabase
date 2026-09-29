import type { Database, Json } from './database.types.js';
import { getClient } from './client.js';
import { getJob, type JobStatus } from './jobs.js';
import {
  appendMoneyEvent,
  getMoneyEvent,
  getMoneyEventByDedupeKey,
  syncJobStatusForMoney,
  type AppendMoneyEventInput,
  type MoneyEvent,
} from './moneyEvents.js';
import { isUniqueViolation, wrapDbError } from './rawCaptures.js';
import { documentStart } from './tenantProfiles.js';

// Invoices and estimates as records (plan 2026-09-29-step-2e-invoices-estimates).
//
// ONE record type, two kinds. A draft is editable and has no number. Issuing is
// the manager saying "this is final" (operator 2026-09-29: recorded when FINAL,
// not when sent — invoices leave by post, text and hand, which we cannot see):
// it gives the next number and writes the ledger row. From then on the document
// changes only by void or, for an estimate, its outcome. The ledger stays the one
// money truth; every ledger write here carries a dedupe key (doc:<id>:issue /
// :void / :outcome) so a retried call converges on the row the first one wrote.

export type MoneyDocument = Database['public']['Tables']['money_documents']['Row'];
export type MoneyDocumentKind = 'invoice' | 'estimate';
export type EstimateOutcome = 'accepted' | 'declined';

export interface DocumentLine {
  description: string;
  quantity: number;
  unitCents: number;
  amountCents: number;
}

/** A line as a caller gives it: amountCents is worked out here, and if stated must agree. */
export interface DocumentLineInput {
  description: string;
  quantity: number;
  unitCents: number;
  amountCents?: number;
}

export const DOCUMENT_KINDS: readonly MoneyDocumentKind[] = ['invoice', 'estimate'];
export const MAX_DOCUMENT_LINES = 100;
const PREFIX: Record<MoneyDocumentKind, string> = { invoice: 'INV', estimate: 'EST' };
// The ledger's amount column is a Postgres integer.
const MAX_CENTS = 2_147_483_647;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a document is named in words: its number once issued, "the draft invoice" before. */
const nameOf = (d: MoneyDocument): string => d.number ?? `the draft ${d.kind}`;

/**
 * Validate and price the lines. Strict, because these print on a customer
 * document and write the ledger's amount: humans never check the arithmetic, so
 * the machine does, and a stated amount that disagrees is refused rather than
 * silently replaced.
 */
export function normalizeLines(lines: unknown): { lines: DocumentLine[]; totalCents: number } {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw new Error('a document needs at least one line');
  }
  if (lines.length > MAX_DOCUMENT_LINES) {
    throw new Error(`a document has at most ${MAX_DOCUMENT_LINES} lines`);
  }
  const out: DocumentLine[] = [];
  let total = 0;
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`line ${n} must be {description, quantity, unitCents}`);
    }
    const l = raw as Record<string, unknown>;
    if (typeof l.description !== 'string' || l.description.trim() === '') {
      throw new Error(`line ${n} needs a description`);
    }
    if (typeof l.quantity !== 'number' || !Number.isFinite(l.quantity) || l.quantity <= 0) {
      throw new Error(`line ${n}: quantity must be a number above 0`);
    }
    if (typeof l.unitCents !== 'number' || !Number.isInteger(l.unitCents) || l.unitCents < 0) {
      throw new Error(`line ${n}: unitCents must be a whole number of cents, 0 or more`);
    }
    const amountCents = Math.round(l.quantity * l.unitCents);
    if (l.amountCents !== undefined && l.amountCents !== null && l.amountCents !== amountCents) {
      throw new Error(
        `line ${n}: amountCents ${String(l.amountCents)} is not quantity × unitCents ` +
          `(${l.quantity} × ${l.unitCents} = ${amountCents})`,
      );
    }
    total += amountCents;
    out.push({ description: l.description.trim(), quantity: l.quantity, unitCents: l.unitCents, amountCents });
  });
  if (total > MAX_CENTS) throw new Error('the total is too large to record');
  return { lines: out, totalCents: total };
}

/** One document of this firm, or null (another firm's id reads like a missing one). */
export async function getDocument(tenantId: string, id: string): Promise<MoneyDocument | null> {
  if (!UUID_RE.test(id)) return null;
  const { data, error } = await getClient()
    .from('money_documents')
    .select()
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .maybeSingle();
  if (error) throw wrapDbError('getDocument failed', error);
  return data;
}

/** A firm's documents on a job or customer (or all), newest first. */
export async function listDocuments(
  tenantId: string,
  filter: { jobId?: string; customerId?: string; kind?: MoneyDocumentKind } = {},
): Promise<MoneyDocument[]> {
  if ((filter.jobId && !UUID_RE.test(filter.jobId)) || (filter.customerId && !UUID_RE.test(filter.customerId))) {
    return [];
  }
  let q = getClient().from('money_documents').select().eq('tenant_id', tenantId);
  if (filter.jobId) q = q.eq('job_id', filter.jobId);
  if (filter.customerId) q = q.eq('customer_id', filter.customerId);
  if (filter.kind) q = q.eq('kind', filter.kind);
  const { data, error } = await q.order('created_at', { ascending: false }).order('id');
  if (error) throw wrapDbError('listDocuments failed', error);
  return data ?? [];
}

export interface SaveDraftInput {
  tenantId: string;
  kind: MoneyDocumentKind;
  jobId: string;
  lines: DocumentLineInput[];
  /** undefined keeps the draft's notes; null clears them. */
  notes?: string | null;
  byRef: string;
  /** Edit this draft; omitted = a new one. */
  documentId?: string;
}

/** Create or replace a draft. An issued or void document refuses: it changes only by void/outcome. */
export async function saveDraft(input: SaveDraftInput): Promise<MoneyDocument> {
  if (!DOCUMENT_KINDS.includes(input.kind)) {
    throw new Error(`kind must be one of ${DOCUMENT_KINDS.join(', ')}`);
  }
  const { lines, totalCents } = normalizeLines(input.lines);
  const job = UUID_RE.test(input.jobId) ? await getJob(input.jobId) : null;
  if (!job || job.tenant_id !== input.tenantId) {
    // Unknown and another firm's read the same — no existence oracle.
    throw new Error('no such job on this firm');
  }
  const notes = input.notes === undefined ? undefined : input.notes?.trim() || null;
  const cols = {
    job_id: job.id,
    customer_id: job.customer_id,
    lines: lines as unknown as Json,
    total_cents: totalCents,
    ...(notes !== undefined ? { notes } : {}),
  };

  if (!input.documentId) {
    const { data, error } = await getClient()
      .from('money_documents')
      .insert({ tenant_id: input.tenantId, kind: input.kind, created_by_ref: input.byRef, ...cols })
      .select()
      .single();
    if (error || !data) throw wrapDbError('saveDraft failed', error);
    return data;
  }

  const existing = await getDocument(input.tenantId, input.documentId);
  if (!existing) throw new Error('no such document');
  if (existing.kind !== input.kind) {
    throw new Error(`that document is an ${existing.kind}, not an ${input.kind}`);
  }
  if (existing.status !== 'draft') throw refuseEdit(existing);
  // Compare-and-set on draft: an issue that lands between the read and this write wins.
  const { data, error } = await getClient()
    .from('money_documents')
    .update(cols)
    .eq('id', existing.id)
    .eq('tenant_id', input.tenantId)
    .eq('status', 'draft')
    .select()
    .maybeSingle();
  if (error) throw wrapDbError('saveDraft failed', error);
  if (!data) {
    const now = await getDocument(input.tenantId, existing.id);
    throw now ? refuseEdit(now) : new Error('no such document');
  }
  return data;
}

const refuseEdit = (d: MoneyDocument): Error =>
  new Error(
    d.status === 'void'
      ? `${nameOf(d)} is void — make a new ${d.kind} instead`
      : `${nameOf(d)} is issued and cannot be edited — void it and make a new one`,
  );

async function nextNumberSeq(tenantId: string, kind: MoneyDocumentKind): Promise<number> {
  const start = await documentStart(tenantId, kind);
  const { data, error } = await getClient()
    .from('money_documents')
    .select('number_seq')
    .eq('tenant_id', tenantId)
    .eq('kind', kind)
    .not('number_seq', 'is', null)
    .order('number_seq', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw wrapDbError('nextNumberSeq failed', error);
  // A raised start jumps ahead; a lowered one never reuses a number.
  return Math.max(start, (data?.number_seq ?? 0) + 1);
}

/**
 * Append a ledger row under a dedupe key; if the key already wrote one (a retry,
 * or a racing call), return that row instead.
 */
async function appendOnce(input: AppendMoneyEventInput & { dedupeKey: string }): Promise<MoneyEvent> {
  try {
    return await appendMoneyEvent(input);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await getMoneyEventByDedupeKey(input.tenantId, input.dedupeKey);
    if (!existing) throw err;
    return existing;
  }
}

export interface IssueResult {
  document: MoneyDocument;
  event: MoneyEvent;
  /** True when it was already issued and recorded — nothing new was written. */
  already: boolean;
  statusChange: { from: JobStatus; to: JobStatus } | null;
}

/**
 * The manager says it is final: number it, record it in the ledger, walk the
 * job's status. Safe to retry and to race — the number is set by a
 * compare-and-set on status='draft' (a racing second call gets the first's
 * number), and the ledger write carries doc:<id>:issue. An issued document whose
 * ledger write never landed (money_event_id null) gets it written now.
 */
export async function issueDocument(
  tenantId: string,
  id: string,
  byRef: string,
  opts: { progress?: boolean } = {},
): Promise<IssueResult> {
  let doc = await getDocument(tenantId, id);
  if (!doc) throw new Error('no such document');
  if (opts.progress && doc.kind !== 'invoice') throw new Error('progress applies to invoices only');
  if (doc.status === 'void') throw new Error(`${nameOf(doc)} is void — make a new ${doc.kind} instead`);

  if (doc.status === 'draft') {
    normalizeLines(doc.lines); // a draft saved through saveDraft always passes; this is the guard for one that was not
    const kind = doc.kind as MoneyDocumentKind;
    const docId = doc.id;
    for (let attempt = 0; doc.status === 'draft' && attempt < 5; attempt++) {
      const seq = await nextNumberSeq(tenantId, kind);
      const { data, error }: { data: MoneyDocument | null; error: unknown } = await getClient()
        .from('money_documents')
        .update({
          status: 'issued',
          number_seq: seq,
          number: `${PREFIX[kind]}-${seq}`,
          issued_at: new Date().toISOString(),
        })
        .eq('id', docId)
        .eq('tenant_id', tenantId)
        .eq('status', 'draft')
        .select()
        .maybeSingle();
      if (error) {
        // Another document of this firm took the number first: count again.
        if (isUniqueViolation(error)) continue;
        throw wrapDbError('issueDocument failed', error);
      }
      // No row: a racing call issued it first. Carry on from what it did.
      doc = data ?? (await getDocument(tenantId, id));
      if (!doc) throw new Error('no such document');
    }
    if (doc.status === 'draft') throw new Error('could not number the document — try again');
    if (doc.status === 'void') throw new Error(`${nameOf(doc)} is void — make a new ${doc.kind} instead`);
  }

  if (doc.money_event_id != null) {
    const event = await getMoneyEvent(doc.money_event_id);
    if (!event) throw new Error(`issueDocument: ledger row ${doc.money_event_id} is missing`);
    return { document: doc, event, already: true, statusChange: null };
  }

  const event = await appendOnce({
    tenantId,
    jobId: doc.job_id,
    kind: doc.kind === 'invoice' ? 'invoice_issued' : 'estimate_presented',
    amountCents: doc.total_cents,
    externalRef: doc.number,
    actorRef: byRef,
    dedupeKey: `doc:${doc.id}:issue`,
    detail: { documentId: doc.id, ...(opts.progress ? { progress: true } : {}) },
  });
  const { data, error } = await getClient()
    .from('money_documents')
    .update({ money_event_id: event.id })
    .eq('id', doc.id)
    .eq('tenant_id', tenantId)
    .is('money_event_id', null)
    .select()
    .maybeSingle();
  if (error) throw wrapDbError('issueDocument (ledger link) failed', error);
  const document = data ?? (await getDocument(tenantId, id));
  if (!document) throw new Error('no such document');
  const statusChange = await syncJobStatusForMoney(tenantId, doc.job_id);
  return { document, event, already: false, statusChange };
}

export interface VoidResult {
  document: MoneyDocument;
  /** The cancelling ledger row, or null when there was nothing in the ledger to cancel. */
  event: MoneyEvent | null;
  already: boolean;
  statusChange: { from: JobStatus; to: JobStatus } | null;
}

/**
 * Cancel an issued document. An invoice: invoice_voided against its issuing row
 * (the job walks back through the existing sync). An estimate: void, plus a
 * correction of its estimate_approved row if it was accepted — else `quoted`
 * would keep an estimate nobody stands behind. A draft is not recorded anywhere,
 * so there is nothing to void: change it, or leave it.
 */
export async function voidDocument(
  tenantId: string,
  id: string,
  reason: string | null,
  byRef: string,
): Promise<VoidResult> {
  const doc = await getDocument(tenantId, id);
  if (!doc) throw new Error('no such document');
  if (doc.status === 'draft') {
    throw new Error(`${nameOf(doc)} was never issued, so there is nothing to void — change it or leave it`);
  }
  if (doc.status === 'void') return { document: doc, event: null, already: true, statusChange: null };

  const why = reason?.trim() || null;
  const detail: Json = { documentId: doc.id, ...(why ? { reason: why } : {}) };
  let event: MoneyEvent | null = null;
  if (doc.kind === 'invoice') {
    // The issuing row by its link, or by its key when the link was never stamped.
    const issuedId =
      doc.money_event_id ?? (await getMoneyEventByDedupeKey(tenantId, `doc:${doc.id}:issue`))?.id ?? null;
    if (issuedId != null) {
      event = await appendOnce({
        tenantId,
        jobId: doc.job_id,
        kind: 'invoice_voided',
        correctsEventId: issuedId,
        externalRef: doc.number,
        actorRef: byRef,
        dedupeKey: `doc:${doc.id}:void`,
        detail,
      });
    }
  } else if (doc.outcome === 'accepted') {
    const approved = await getMoneyEventByDedupeKey(tenantId, `doc:${doc.id}:outcome`);
    if (approved?.kind === 'estimate_approved') {
      event = await appendOnce({
        tenantId,
        jobId: doc.job_id,
        kind: 'correction',
        correctsEventId: approved.id,
        externalRef: doc.number,
        actorRef: byRef,
        dedupeKey: `doc:${doc.id}:void`,
        detail,
      });
    }
  }

  const { data, error } = await getClient()
    .from('money_documents')
    .update({ status: 'void', voided_at: new Date().toISOString(), void_reason: why })
    .eq('id', doc.id)
    .eq('tenant_id', tenantId)
    .eq('status', 'issued')
    .select()
    .maybeSingle();
  if (error) throw wrapDbError('voidDocument failed', error);
  const document = data ?? (await getDocument(tenantId, id));
  if (!document) throw new Error('no such document');
  const statusChange = await syncJobStatusForMoney(tenantId, doc.job_id);
  return { document, event, already: !data, statusChange };
}

/**
 * The customer's answer to an issued estimate: accepted → estimate_approved for
 * the total (this is what sets `quoted`), declined → estimate_declined. Once
 * only: a second outcome is refused in words. The ledger row is written FIRST
 * under doc:<id>:outcome, so two racing answers converge on one row and the
 * loser is refused rather than recording a contradiction.
 */
export async function recordEstimateOutcome(
  tenantId: string,
  id: string,
  outcome: EstimateOutcome,
  byRef: string,
): Promise<{ document: MoneyDocument; event: MoneyEvent }> {
  if (outcome !== 'accepted' && outcome !== 'declined') {
    throw new Error("outcome must be 'accepted' or 'declined'");
  }
  const doc = await getDocument(tenantId, id);
  if (!doc) throw new Error('no such document');
  if (doc.kind !== 'estimate') throw new Error('only an estimate has an outcome');
  if (doc.status === 'draft') throw new Error('the estimate is still a draft — issue it first');
  if (doc.status === 'void') throw new Error(`${nameOf(doc)} is void`);
  if (doc.outcome) throw new Error(`${nameOf(doc)} is already recorded as ${doc.outcome}`);

  const want = outcome === 'accepted' ? 'estimate_approved' : 'estimate_declined';
  const event = await appendOnce({
    tenantId,
    jobId: doc.job_id,
    kind: want,
    amountCents: outcome === 'accepted' ? doc.total_cents : null,
    externalRef: doc.number,
    actorRef: byRef,
    dedupeKey: `doc:${doc.id}:outcome`,
    detail: { documentId: doc.id },
  });
  if (event.kind !== want) {
    const was = event.kind === 'estimate_approved' ? 'accepted' : 'declined';
    throw new Error(`${nameOf(doc)} is already recorded as ${was}`);
  }
  const { data, error } = await getClient()
    .from('money_documents')
    .update({ outcome, outcome_at: new Date().toISOString() })
    .eq('id', doc.id)
    .eq('tenant_id', tenantId)
    .is('outcome', null)
    .select()
    .maybeSingle();
  if (error) throw wrapDbError('recordEstimateOutcome failed', error);
  const document = data ?? (await getDocument(tenantId, id));
  if (!document) throw new Error('no such document');
  return { document, event };
}
