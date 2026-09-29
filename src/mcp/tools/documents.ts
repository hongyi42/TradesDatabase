// Invoices and estimates as records (plan 2026-09-29-step-2e, Phase 2).
//
// The manager's five document tools over src/db/moneyDocuments.ts. All `admin`
// tier: technicians never see documents (plan decision) — the hub's admin gate
// refuses them by name before any handler here runs.
//
// The typed layer is the one write-side guard (lines, arithmetic, numbering,
// dedupe, the void/outcome rules) and its errors are already words the model
// can read out; this module checks argument SHAPES (a wrong type is refused,
// never coerced to absent — the find_slots rule) and shapes the replies.
import {
  hitRowCap,
  issueDocument,
  listDocuments,
  listMoneyEventsForJob,
  recordEstimateOutcome,
  rowCapNote,
  saveDraft,
  summarizeMoney,
  voidDocument,
} from '../../db/index.js';
import type {
  DocumentLineInput,
  MoneyDocument,
  MoneyDocumentKind,
} from '../../db/index.js';
import { UUID_RE } from './shared.js';
import type { DomainTools, ToolContext } from './types.js';

const DOC_ID = { type: 'string', description: 'The document id draft_document or list_documents returned.' };

const ADMIN_TOOLS = [
  {
    name: 'draft_document',
    description:
      'Make or change a DRAFT invoice or estimate for a job (manager only). A draft has no number ' +
      'and is recorded NOWHERE: drafting never touches the ledger. Amounts are IN CENTS; each ' +
      'line is priced quantity × unitCents and the total is worked out for you — read both back. ' +
      'Tax, discounts and deposits already paid are just lines (no tax engine). Pass documentId to ' +
      'change an existing draft: its lines are REPLACED whole. The PDF of a draft says DRAFT. ' +
      'An invoice the manager already made in their own system is NOT a document: record it with ' +
      'record_money_event(invoice_issued, externalRef = their number).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['invoice', 'estimate'] },
        jobId: { type: 'string', description: 'The job it is for.' },
        lines: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'number', description: 'Above 0; may be fractional (1.5 hours).' },
              unitCents: { type: 'integer', minimum: 0, description: 'Price of one, in cents.' },
            },
            required: ['description', 'quantity', 'unitCents'],
          },
          description: 'Every line, in order ($120 × 2 = {quantity: 2, unitCents: 12000}).',
        },
        notes: { type: ['string', 'null'], description: 'Free text printed on it (terms, thanks); null clears.' },
        documentId: { type: 'string', description: 'Change this draft instead of making a new one.' },
      },
      required: ['kind', 'jobId', 'lines'],
    },
  },
  {
    name: 'issue_document',
    description:
      'Make a draft FINAL (manager only): gives it its number (INV-/EST-) and records it in the ' +
      "job's ledger — an invoice as invoice issued (a final invoice walks the job to invoiced), " +
      'an estimate as estimate presented. Call it ONLY when the manager says it is final — never ' +
      'while still drafting, and never just because it is about to be emailed: sending is ' +
      'delivery, it records nothing. Safe to repeat. Then draw the final PDF (it must carry the ' +
      'number), save_file it and link_file it to this documentId before delivering. Reply ' +
      'carries the job money summary and any status change — relay both.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: DOC_ID,
        progress: {
          type: 'boolean',
          description: 'Invoices only: true = a deposit / milestone invoice (does not mark the job done).',
        },
      },
      required: ['documentId'],
    },
  },
  {
    name: 'void_document',
    description:
      'Cancel an ISSUED invoice or estimate (manager only). An invoice is voided in the ledger and ' +
      "the job's status walks back; an accepted estimate's approval is cancelled. The number is " +
      'never reused. To change an issued document: void it, then draft and issue a new one. A ' +
      'draft is not recorded anywhere — change it with draft_document instead.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: DOC_ID,
        reason: { type: 'string', description: 'Why, in the manager\'s words — kept on the record.' },
      },
      required: ['documentId', 'reason'],
    },
  },
  {
    name: 'record_estimate_outcome',
    description:
      "The customer's answer to an issued estimate (manager only): accepted records the approval " +
      '(it becomes the job\'s quoted amount), declined records the decline. Once only — a second ' +
      'answer is refused; if it was wrong, void the estimate and issue a new one.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: DOC_ID,
        outcome: { type: 'string', enum: ['accepted', 'declined'] },
      },
      required: ['documentId', 'outcome'],
    },
  },
  {
    name: 'list_documents',
    description:
      "A job's or customer's invoices and estimates (manager only), newest first: number (none " +
      'while a draft), status draft/issued/void, total, lines, and an estimate\'s outcome. ' +
      'unsettled: true marks a void whose cancelling never reached the ledger — void it again.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'Exactly one of jobId / customerId.' },
        customerId: { type: 'string', description: 'Exactly one of jobId / customerId.' },
      },
      required: [],
    },
  },
];

/** A string arg that must be a well-formed id, named in the refusal. */
function idArg(ctx: ToolContext, key: string, what: string): string {
  const v = ctx.args[key];
  if (v === undefined || v === null || v === '') throw new Error(`${key} is required`);
  if (typeof v !== 'string' || !UUID_RE.test(v)) {
    throw new Error(`${key} must be ${what} id as a tool returned it — "${String(v)}" is not one`);
  }
  return v;
}

/**
 * An optional arg the caller actually gave. An explicit null is "not given"
 * (models send null for an unset optional); a wrong type is still refused by
 * the caller's own check.
 */
const given = (ctx: ToolContext, key: string): boolean => ctx.args[key] !== undefined && ctx.args[key] !== null;

function onlyStrings(ctx: ToolContext, keys: string[]): void {
  for (const k of keys) {
    const v = ctx.args[k];
    if (v !== undefined && v !== null && typeof v !== 'string') throw new Error(`${k} must be a string`);
  }
}

/** The job's money after a write. A failure here must not read as the write failing. */
async function moneyAfter(tenantId: string, jobId: string): Promise<Record<string, unknown>> {
  try {
    const events = await listMoneyEventsForJob(tenantId, jobId);
    return {
      money: summarizeMoney(events),
      ...(hitRowCap(events.length) ? { moneyNote: rowCapNote('ledger entries') } : {}),
    };
  } catch (err) {
    return {
      moneyWarning:
        `it WAS done, but the money summary could not be read (${err instanceof Error ? err.message : String(err)}) ` +
        '— do not repeat it; get_job shows the position',
    };
  }
}

const shape = (d: MoneyDocument) => ({
  documentId: d.id,
  kind: d.kind,
  number: d.number,
  status: d.status,
  totalCents: d.total_cents,
  lines: d.lines,
  ...(d.notes ? { notes: d.notes } : {}),
  jobId: d.job_id,
  ...(d.progress ? { progress: true } : {}),
  ...(d.outcome ? { outcome: d.outcome } : {}),
  ...(d.issued_at ? { issuedAt: d.issued_at } : {}),
  ...(d.voided_at ? { voidedAt: d.voided_at } : {}),
  ...(d.void_reason ? { voidReason: d.void_reason } : {}),
});

async function handleDraftDocument(ctx: ToolContext): Promise<unknown> {
  const { args, tenantId, identity } = ctx;
  onlyStrings(ctx, ['kind', 'notes']);
  const kind = args.kind;
  if (kind !== 'invoice' && kind !== 'estimate') throw new Error("kind must be 'invoice' or 'estimate'");
  const jobId = idArg(ctx, 'jobId', 'a job');
  const documentId = given(ctx, 'documentId') ? idArg(ctx, 'documentId', 'a document') : undefined;
  const doc = await saveDraft({
    tenantId,
    kind: kind as MoneyDocumentKind,
    jobId,
    lines: args.lines as DocumentLineInput[],
    // notes: null is the schema's advertised CLEAR ("null clears"), so it is
    // passed on as null, not read as absent — absent keeps the draft's notes.
    notes: args.notes as string | null | undefined,
    byRef: identity.technicianRef,
    documentId,
  });
  return {
    ...shape(doc),
    note:
      `Draft ${doc.kind} saved — no number, nothing recorded. Read the lines and the total back ` +
      'to the manager. Issue it only when they say it is final.',
  };
}

async function handleIssueDocument(ctx: ToolContext): Promise<unknown> {
  const { args, tenantId, identity } = ctx;
  const documentId = idArg(ctx, 'documentId', 'a document');
  if (given(ctx, 'progress') && typeof args.progress !== 'boolean') {
    throw new Error('progress must be true or false');
  }
  const r = await issueDocument(tenantId, documentId, identity.technicianRef, {
    progress: given(ctx, 'progress') ? (args.progress as boolean) : undefined,
  });
  const d = r.document;
  return {
    documentId: d.id,
    kind: d.kind,
    number: d.number,
    status: d.status,
    totalCents: d.total_cents,
    recorded: d.kind === 'invoice' ? 'invoice issued' : 'estimate presented',
    ...(r.already ? { alreadyIssued: true } : {}),
    ...(await moneyAfter(tenantId, d.job_id)),
    ...(r.statusChange ? { jobStatusChange: r.statusChange } : {}),
    ...(r.note ? { warning: r.note } : {}),
    note:
      (r.already ? `${d.number} was already issued — nothing new recorded. ` : `${d.number} is final and recorded. `) +
      'Now draw the final PDF with this number, save_file it and link_file it to this documentId ' +
      'before it goes out.',
  };
}

async function handleVoidDocument(ctx: ToolContext): Promise<unknown> {
  const { args, tenantId, identity } = ctx;
  const documentId = idArg(ctx, 'documentId', 'a document');
  onlyStrings(ctx, ['reason']);
  const reason = (args.reason as string | undefined)?.trim();
  if (!reason) throw new Error('reason is required — say why it is being voided');
  const r = await voidDocument(tenantId, documentId, reason, identity.technicianRef);
  const d = r.document;
  const recorded = r.event
    ? r.event.kind === 'invoice_voided'
      ? 'invoice voided'
      : 'estimate approval cancelled'
    : 'nothing in the ledger to cancel';
  return {
    documentId: d.id,
    kind: d.kind,
    number: d.number,
    status: d.status,
    recorded,
    ...(r.already ? { alreadyVoid: true } : {}),
    ...(await moneyAfter(tenantId, d.job_id)),
    ...(r.statusChange ? { jobStatusChange: r.statusChange } : {}),
    ...(r.note ? { warning: r.note } : {}),
    note: `${d.number} is void; its number is not reused. Tell the manager, with any status change.`,
  };
}

async function handleRecordEstimateOutcome(ctx: ToolContext): Promise<unknown> {
  const { args, tenantId, identity } = ctx;
  const documentId = idArg(ctx, 'documentId', 'a document');
  const outcome = args.outcome;
  if (outcome !== 'accepted' && outcome !== 'declined') {
    throw new Error("outcome must be 'accepted' or 'declined'");
  }
  const r = await recordEstimateOutcome(tenantId, documentId, outcome, identity.technicianRef);
  const d = r.document;
  return {
    documentId: d.id,
    number: d.number,
    outcome: d.outcome,
    recorded: outcome === 'accepted' ? 'estimate approved' : 'estimate declined',
    ...(await moneyAfter(tenantId, d.job_id)),
  };
}

async function handleListDocuments(ctx: ToolContext): Promise<unknown> {
  const { tenantId } = ctx;
  const targets = ['jobId', 'customerId'].filter((k) => given(ctx, k));
  if (targets.length !== 1) throw new Error('give exactly one of jobId, customerId');
  const filter =
    targets[0] === 'jobId'
      ? { jobId: idArg(ctx, 'jobId', 'a job') }
      : { customerId: idArg(ctx, 'customerId', 'a customer') };
  const docs = await listDocuments(tenantId, filter);
  return {
    documents: docs.map((d) => ({ ...shape(d), unsettled: d.unsettled })),
    ...(docs.length === 0 ? { note: 'No invoices or estimates made here yet.' } : {}),
  };
}

export const documentsTools = {
  domain: 'documents',
  admin: ADMIN_TOOLS,
  handlers: {
    draft_document: handleDraftDocument,
    issue_document: handleIssueDocument,
    void_document: handleVoidDocument,
    record_estimate_outcome: handleRecordEstimateOutcome,
    list_documents: handleListDocuments,
  },
} satisfies DomainTools;
