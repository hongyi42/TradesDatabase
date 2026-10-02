// The money ledger.
//
// One domain's slice of the spine's tool surface: the definitions it contributes
// to each tier's catalog, and the handler behind each name. Split out of
// src/mcp/server.ts on 2026-09-12 (research 2026-09-09
// code-graph-as-source-of-truth §6.1 fix 3) so that adding a tool here touches
// no file another feature is also editing.
//
// Tier membership is DECLARATIVE only: listing a tool under `admin` is what puts
// it in ADMIN_TOOL_NAMES, and the hub applies that gate by name before any
// handler here runs. A handler never checks a tier itself.
import {
  MONEY_EVENT_KINDS,
  appendMoneyEvent,
  getJob,
  getMoneyEventByDedupeKey,
  getObservationForTenant,
  getRawCapture,
  hitRowCap,
  isUniqueViolation,
  listMoneyEventsCitingCapture,
  listMoneyEventsForJob,
  namesIssuedNumber,
  rowCapNote,
  summarizeMoney,
  syncJobStatusForMoney,
} from '../../db/index.js';
import type {
  Json,
  MoneyEventKind,
} from '../../db/index.js';
import { UUID_RE } from './shared.js';
import type {
  DomainTools,
  ToolContext,
} from './types.js';

const ADMIN_TOOLS = [
  {
    name: 'record_money_event',
    description:
      "Record one money FACT on a job's ledger (manager only): a fee charged, an estimate " +
      'presented/approved/declined, a change order, an invoice issued, a payment ' +
      'received/refunded, a credit, a write-off, a material cost, or a correction/void of an ' +
      "earlier entry. 'material_cost' is the ONE cost kind: what the job COST the firm in " +
      'parts/materials. It never affects balance due and never moves job status — recording it ' +
      'is bookkeeping for the firm, not something the customer owes. It is also not a profit ' +
      'figure: there is no labour rate, so revenue minus this is NOT margin. ' +
      'ONE call — it commits immediately and replies with the updated money summary ' +
      '(quoted / invoiced / paid / balance due, plus materialCost) and any job-status change; ' +
      'ALWAYS relay those back to the manager — but report the number that actually MOVED: ' +
      'recording a material cost does not change balance due, and saying it did is misleading. ' +
      'Amounts are IN CENTS ($450 = 45000) and always positive — ' +
      'the kind carries the direction. Mistakes are never edited, they are cancelled WHOLE by ' +
      "a NEW entry: kind 'correction' (with correctsEventId) cancels any entry; " +
      "'invoice_voided' (with correctsEventId) cancels an invoice AND walks the job status " +
      'back down. A void/correction cancels the ENTIRE cited entry — for a partial adjustment ' +
      '("knock $50 off"), cancel the entry and re-enter the right amount; a MISTAKEN ' +
      'void/correction is fixed by re-issuing the cancelled entry, never by correcting the ' +
      'correction. A deposit or mid-project milestone invoice must pass progress: true so it ' +
      'records the money WITHOUT marking the job completed. Job status follows the ledger ' +
      'automatically (a real invoice ⇒ completed → invoiced; balance cleared ⇒ paid) — ' +
      'never ask the manager to update status separately.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job this money fact belongs to.' },
        kind: {
          type: 'string',
          enum: [...MONEY_EVENT_KINDS],
          description: 'Which money fact this is.',
        },
        amountCents: {
          type: 'integer',
          minimum: 0,
          description:
            'Amount in cents, positive ($450 = 45000). Required for every kind except ' +
            'estimate_declined and correction/invoice_voided (optional there — a ' +
            'void/correction cancels its target WHOLE; if stated it must equal the ' +
            "cancelled entry's amount).",
        },
        occurredAt: {
          type: 'string',
          description: 'ISO timestamp when it actually happened, if the manager states one; omit = now.',
        },
        method: {
          type: 'string',
          description:
            'How the money moved, as stated (check / card / cash / ach / financing) — payment kinds only.',
        },
        externalRef: {
          type: 'string',
          description: 'Outside reference if any: invoice number, check number, processor id.',
        },
        note: { type: 'string', description: 'Short free-text context, stored with the entry.' },
        progress: {
          type: 'boolean',
          description:
            'true = deposit / progress / milestone invoice — records the money without implying ' +
            'the job is done.',
        },
        sourceCaptureId: {
          type: 'string',
          description:
            'The capture this amount came from, when you recorded the message it came from in ' +
            'this same conversation — copy the id record_field_note returned. Omit if there is ' +
            'none; a wrong id costs the link, never the entry.',
        },
        correctsEventId: {
          type: 'integer',
          description:
            "REQUIRED for kinds 'correction' and 'invoice_voided': the ledger entry id being " +
            'cancelled (ids appear in get_job money.recentEvents).',
        },
      },
      required: ['jobId', 'kind'],
    },
  },
];

async function handleRecordMoneyEvent(toolCtx: ToolContext): Promise<unknown> {
  const { args, identity, tenantId, str } = toolCtx;
      // Non-string/number args rejected, never coerced-to-absent (find_slots
      // rule) — EVERY arg, because this row is append-only: a numeric
      // externalRef (check numbers are numbers) silently dropped by str()
      // would be unfixable except by void-and-re-enter (review finding).
      for (const k of [
        'jobId', 'kind', 'occurredAt', 'method', 'externalRef', 'note', 'sourceCaptureId',
      ]) {
        if (args[k] !== undefined && typeof args[k] !== 'string') {
          throw new Error(`${k} must be a string`);
        }
      }
      // progress must be a real boolean: a "true" STRING coerced-to-absent
      // would record a milestone invoice as a real one and walk the job's
      // status — the exact failure the progress guard exists to prevent.
      if (args.progress !== undefined && typeof args.progress !== 'boolean') {
        throw new Error('progress must be a boolean');
      }
      const jobId = str('jobId');
      if (!jobId) throw new Error('jobId is required');
      const kindArg = str('kind');
      if (!kindArg) throw new Error('kind is required');
      if (args.amountCents !== undefined && typeof args.amountCents !== 'number') {
        throw new Error('amountCents must be a number of cents');
      }
      if (args.correctsEventId !== undefined && typeof args.correctsEventId !== 'number') {
        throw new Error('correctsEventId must be the numeric ledger entry id');
      }
      const detail: Record<string, Json> = {};
      const noteArg = str('note');
      if (noteArg) detail.note = noteArg;
      if (args.progress === true) detail.progress = true;
      // One-shot by doctrine: a ledger row is reversible via correction/void,
      // so no staging. Kind vocabulary, amount rules, tenant/job coherence and
      // reference rules all live in the typed layer — ONE write-side guard for
      // every surface (review finding: pre-duplicating them here bought only a
      // second error phrasing and a wasted job read); its errors are
      // instructive — surface them verbatim.
      const event = await appendMoneyEvent({
        tenantId,
        jobId,
        kind: kindArg as MoneyEventKind,
        amountCents: (args.amountCents as number | undefined) ?? null,
        occurredAt: str('occurredAt') ?? null,
        actorRef: identity.technicianRef,
        // Where this amount came from, when the agent recorded the message it
        // came from in the same conversation. Validated and tenant-guarded in
        // the typed layer, beside the job and correctsEventId coherence checks —
        // ONE write-side guard for every surface, per this dispatch's own rule.
        sourceCaptureId: str('sourceCaptureId') ?? null,
        correctsEventId: (args.correctsEventId as number | undefined) ?? null,
        method: str('method') ?? null,
        externalRef: str('externalRef') ?? null,
        detail,
      });
      // The entry is LANDED from here on. Any failure below must still report
      // success: manual entries carry no dedupe key, so an isError reply would
      // invite a retry that double-records into an append-only table (the
      // standing "failed-turn writes may have LANDED" trap — review finding).
      let statusMove: Awaited<ReturnType<typeof syncJobStatusForMoney>> = null;
      let events: Awaited<ReturnType<typeof listMoneyEventsForJob>> | null = null;
      let statusSyncWarning: string | undefined;
      try {
        statusMove = await syncJobStatusForMoney(tenantId, jobId);
        events = await listMoneyEventsForJob(tenantId, jobId);
      } catch (err) {
        statusSyncWarning =
          'the entry WAS recorded, but the follow-up status/summary step failed ' +
          `(${err instanceof Error ? err.message : String(err)}) — do NOT re-record it; ` +
          'call get_job to see the current position and status';
      }
      return {
        status: 'recorded',
        eventId: event.id,
        kind: event.kind,
        amountCents: event.amount_cents,
        ...(events ? { money: summarizeMoney(events) } : {}),
        // Told, not paged (operator ruling 2026-09-15): read in id order, so a
        // cut at the row limit drops the newest entries — this one included.
        ...(events && hitRowCap(events.length) ? { moneyNote: rowCapNote('ledger entries') } : {}),
        ...(statusMove ? { jobStatusChange: statusMove } : {}),
        ...(statusSyncWarning ? { statusSyncWarning } : {}),
        note:
          'One-shot: recorded. Tell the manager what was recorded, the number that MOVED ' +
          '(balance due for a receivable; the cost total for a material cost — a cost never ' +
          'changes balance due), and ' +
          `any status change. A wrong ENTRY is cancelled whole with kind 'correction' (or ` +
          `'invoice_voided' for an invoice) citing eventId ${event.id} — a partial adjustment ` +
          'is cancel-then-re-enter. A mistaken void/correction is fixed by RE-ISSUING the ' +
          'cancelled entry, never by correcting the correction.',
      };
}

// THE OFFICE RECORDS AN INVOICE THE FIRM ALREADY SENT (operator 2026-09-30:
// "if the invoice is sent out to a customer already, then it's ok to just record
// it"). Until then the office could only text the manager and wait for their
// seat to record it. Sending it to the customer IS the firm issuing it, so the
// office records it itself and tells the manager after.
//
// The office judges (is this an invoice the firm issued, what is the amount,
// which job); the code only guards what judgment cannot: the item must be an
// open `outbound_invoice`, the ledger row cites that email, the entry is the
// mailbox owner's (they sent it), and it lands ONCE per email — a dedupe key,
// plus a refusal when anything on the ledger already cites the email or names
// the same number.
const TEAM_LEAD_TOOLS = [
  {
    name: 'record_sent_invoice',
    description:
      "Put an invoice the firm ALREADY EMAILED to a customer on that job's ledger, from an " +
      '`outbound_invoice` item. Only when the email or its attachment plainly shows the amount ' +
      'and the job — read them, never guess. The entry cites the email and is dated when it was ' +
      'sent; the job moves to invoiced on its own. Then text the manager what you recorded. If ' +
      'the amount, the job or whether it is really an invoice is unclear, do NOT call this — ' +
      'ask the manager instead. The item retires itself once the ledger cites the email.',
    inputSchema: {
      type: 'object',
      properties: {
        observationId: {
          type: 'string',
          description: "The item id, copied exactly off its `gap` line.",
        },
        jobId: {
          type: 'string',
          description: "The job the invoice is for — the item's job if it was filed on one.",
        },
        amountCents: {
          type: 'integer',
          minimum: 1,
          description: 'The invoice TOTAL in cents, as the invoice states it ($242.55 = 24255).',
        },
        invoiceNumber: {
          type: 'string',
          description: "The firm's own invoice number, as printed, if it has one.",
        },
        progress: {
          type: 'boolean',
          description: 'true = a deposit / progress / milestone invoice, not the final bill.',
        },
      },
      required: ['observationId', 'jobId', 'amountCents'],
    },
  },
];

async function handleRecordSentInvoice(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str } = toolCtx;
  for (const k of ['observationId', 'jobId', 'invoiceNumber']) {
    if (args[k] !== undefined && typeof args[k] !== 'string') throw new Error(`${k} must be a string`);
  }
  if (args.progress !== undefined && typeof args.progress !== 'boolean') {
    throw new Error('progress must be a boolean');
  }
  const amount = args.amountCents;
  if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
    throw new Error('amountCents must be the invoice total in whole cents, above zero ($242.55 = 24255)');
  }
  const observationId = str('observationId');
  const jobId = str('jobId');
  if (!observationId || !jobId) throw new Error('observationId and jobId are required');
  const notHere = 'No such item on this firm — check the id against the gap you copied it from.';
  if (!UUID_RE.test(observationId)) throw new Error(notHere);
  if (!UUID_RE.test(jobId)) throw new Error('No such job on this firm — check the job id.');
  const obs = await getObservationForTenant(observationId, tenantId);
  if (!obs) throw new Error(notHere);
  if (obs.kind !== 'outbound_invoice') {
    throw new Error(`record_sent_invoice is for an email the firm sent; ${observationId} is a ${obs.kind}.`);
  }
  if (obs.status !== 'open') throw new Error(`that item is already ${obs.status} — there is nothing left to record.`);
  const capture = await getRawCapture(obs.subject_ref);
  if (!capture || capture.tenant_id !== tenantId) {
    throw new Error('the email this item is about is not on file — nothing to record it from.');
  }
  if (!capture.technician_ref) throw new Error('that email has nobody on it, so it cannot be recorded.');
  const job = await getJob(jobId);
  if (!job || job.tenant_id !== tenantId) throw new Error('No such job on this firm — check the job id.');
  const ctx = (obs.context ?? {}) as Record<string, unknown>;
  const customerId = typeof ctx.customerId === 'string' ? ctx.customerId : null;
  if (customerId && job.customer_id !== customerId) {
    throw new Error(
      "that job belongs to another customer than the one this email went to — use one of the " +
        "recipient's jobs, or ask the manager which job it is.",
    );
  }
  // ONCE. Anything already citing the email means it is recorded (the manager's
  // seat may have done it); a number already on the books is the same invoice.
  const citing = await listMoneyEventsCitingCapture(tenantId, capture.id);
  if (citing.length > 0) {
    throw new Error(
      `the ledger already cites this email (entry ${citing.map((e) => e.id).join(', ')}) — it is ` +
        'recorded; do not record it again.',
    );
  }
  const invoiceNumber = str('invoiceNumber')?.trim() || null;
  if (invoiceNumber && (await namesIssuedNumber(tenantId, invoiceNumber))) {
    throw new Error(
      `invoice ${invoiceNumber} is already on the books — this email is that same invoice, not a new one.`,
    );
  }
  const dedupeKey = `sent:${capture.id}:invoice`;
  let event;
  try {
    event = await appendMoneyEvent({
      tenantId,
      jobId,
      kind: 'invoice_issued',
      amountCents: amount,
      // When it went to the customer — sending it is the firm issuing it.
      occurredAt: capture.captured_at ?? null,
      // Their invoice: the mailbox owner sent it. The office only wrote it down.
      actorRef: capture.technician_ref,
      sourceCaptureId: capture.id,
      externalRef: invoiceNumber,
      dedupeKey,
      detail: {
        recordedBy: 'office',
        observationId,
        ...(args.progress === true ? { progress: true } : {}),
      },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const prior = await getMoneyEventByDedupeKey(tenantId, dedupeKey);
    throw new Error(
      `this email is already recorded${prior ? ` (entry ${prior.id})` : ''} — do not record it again.`,
    );
  }
  // LANDED. A failure below still reports success: a retry would only be refused.
  let statusMove: Awaited<ReturnType<typeof syncJobStatusForMoney>> = null;
  let warning: string | undefined;
  try {
    statusMove = await syncJobStatusForMoney(tenantId, jobId);
  } catch (err) {
    warning =
      'the invoice WAS recorded, but moving the job status failed ' +
      `(${err instanceof Error ? err.message : String(err)}) — do not record it again.`;
  }
  return {
    status: 'recorded',
    eventId: event.id,
    amountCents: event.amount_cents,
    ...(invoiceNumber ? { invoiceNumber } : {}),
    ...(statusMove ? { jobStatusChange: statusMove } : {}),
    ...(warning ? { warning } : {}),
    note:
      'Recorded. Now text the manager whose mailbox sent it what you put on the books — the ' +
      'customer, the job, the invoice number and the amount — and that they can tell you if it ' +
      'is wrong. Their seat voids it if so.',
  };
}

export const moneyTools = {
  domain: 'money',
  admin: ADMIN_TOOLS,
  teamLead: TEAM_LEAD_TOOLS,
  handlers: {
    record_money_event: handleRecordMoneyEvent,
    record_sent_invoice: handleRecordSentInvoice,
  },
} satisfies DomainTools;
