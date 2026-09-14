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
  listMoneyEventsForJob,
  summarizeMoney,
  syncJobStatusForMoney,
} from '../../db/index.js';
import type {
  Json,
  MoneyEventKind,
} from '../../db/index.js';
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

export const moneyTools = {
  domain: 'money',
  admin: ADMIN_TOOLS,
  handlers: {
    record_money_event: handleRecordMoneyEvent,
  },
} satisfies DomainTools;
