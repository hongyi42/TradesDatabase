import {
  listNudgesByStatus,
  listTenantIdsWithTelegramBindings,
  markNudgeOutcome,
  markNudgeQueued,
  setNudgeAttempts,
  type Nudge,
} from '../db/index.js';
import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';
import { TEAM_LEAD_REF } from './identity.js';

// The compose turn (plan 2026-08-15 feature B, Phase 3): the ONLY model call
// in the ladder. The watcher already decided a gap exists and who to ask; the
// model's whole job is to write ONE colleague-tone question — or decline. It
// sees NOTHING but the code-built context on the nudge row (fabrication
// guard, direction constraint 8), and code assembles the delivered message
// around its sentence: the evidence line's date is CODE-printed (bare date,
// no weekday, so the weekday guard has nothing to mismatch) and the standing
// footer directs the receiving agent (result-embedded directive — prompt
// rules are steering, not enforcement).

export const MAX_COMPOSE_ATTEMPTS = 3;

const COMPOSE_TOOL: ForcedToolSpec = {
  name: 'compose_nudge',
  description:
    'Decide whether to ask the technician about this visit, and write the one question.',
  inputSchema: {
    type: 'object',
    properties: {
      ask: { type: 'boolean', description: 'false = decline to ask (explain in reason)' },
      question: {
        type: 'string',
        description: 'ONE short, warm question. Empty string when ask=false.',
      },
      reason: { type: 'string', description: 'One line: why ask, or why decline.' },
    },
    required: ['ask', 'question', 'reason'],
    additionalProperties: false,
  },
};

// Copy doctrine (user-ratified 2026-08-16) baked into the ONLY prompt the
// identity has: warm, plain, about the JOB, no operator jargon, no invented
// facts, and NO dates — the code-printed evidence line owns the date.
const COMPOSE_SYSTEM =
  'You write ONE short, warm, colleague-tone question from a trades company\'s office ' +
  'assistant to a field technician, asking how a recent job visit went — nothing has been ' +
  'recorded about it yet, and the office wants the job\'s record complete. Rules: plain ' +
  'everyday language; never the word "spine" or any internal jargon; ask about the JOB, ' +
  'never imply the person is behind or in trouble; "nothing to report" must feel like a ' +
  'perfectly fine answer; do NOT invent any fact, name, price, link, or detail beyond the ' +
  'evidence given; do NOT mention any date or weekday (the message around your question ' +
  'prints the date); one or two sentences at most. If the evidence is too thin or looks ' +
  'contradictory, decline with ask=false and explain in reason.';

export interface ComposeContext {
  customerName: string;
  jobTitle: string;
  technicianName: string;
  endsAtLocal: string;
}

// Fail-closed context reader: compose runs a model on these fields, so a
// tampered/thin row is DECLINED (cancelled), never guessed around.
export function readComposeContext(n: Nudge): ComposeContext | null {
  const c = (n.context ?? {}) as Record<string, unknown>;
  const s = (k: string): string | null =>
    typeof c[k] === 'string' && (c[k] as string).length > 0 ? (c[k] as string) : null;
  const customerName = s('customerName');
  const jobTitle = s('jobTitle');
  const technicianName = s('technicianName');
  const endsAtLocal = s('endsAtLocal');
  if (!customerName || !jobTitle || !technicianName || !endsAtLocal) return null;
  return { customerName, jobTitle, technicianName, endsAtLocal };
}

// The full deliverable: model question + code-printed evidence + the standing
// footer for the RECEIVING agent (the box runner injects this into the
// technician's own agent session; the agent's reply is what reaches their
// Telegram). Stored whole in nudges.question so the transport stays dumb and
// the audit shows exactly what was delivered.
export function assembleNudgeMessage(question: string, ctx: ComposeContext): string {
  const bareDate = ctx.endsAtLocal.slice(0, 10);
  return (
    `${question.trim()}\n\n` +
    `(re: ${ctx.customerName} — ${ctx.jobTitle}, visit on ${bareDate})\n\n` +
    `Note for the assistant: this is a routine record-keeping check from the office. First ` +
    `check this conversation — if ${ctx.technicianName} already said how this visit went, ` +
    `record that instead of re-asking. Otherwise pass the question on in your own words if ` +
    `that reads better, and when they answer — even "nothing to report" — save it with ` +
    `record_field_note for this job so the record is complete.`
  );
}

export interface ComposeDeps {
  listTenants?: typeof listTenantIdsWithTelegramBindings;
  listNudges?: typeof listNudgesByStatus;
  run?: typeof runForcedTool;
  markQueued?: typeof markNudgeQueued;
  markOutcome?: typeof markNudgeOutcome;
  setAttempts?: typeof setNudgeAttempts;
}

export interface ComposeSummary {
  composed: number;
  cancelled: number;
  failed: number;
  rowErrors: number;
}

export async function runTeamLeadCompose(deps: ComposeDeps = {}): Promise<ComposeSummary> {
  const listTenants = deps.listTenants ?? listTenantIdsWithTelegramBindings;
  const listNudges = deps.listNudges ?? listNudgesByStatus;
  const run = deps.run ?? runForcedTool;
  const markQueued = deps.markQueued ?? markNudgeQueued;
  const markOutcome = deps.markOutcome ?? markNudgeOutcome;
  const setAttempts = deps.setAttempts ?? setNudgeAttempts;

  const summary: ComposeSummary = { composed: 0, cancelled: 0, failed: 0, rowErrors: 0 };

  for (const tenantId of await listTenants()) {
    // Kind-scoped on purpose: this prompt knows how to ask about ONE gap
    // archetype. A future second detector brings its own prompt and widens
    // this filter deliberately, not by accident.
    const pending = (await listNudges(tenantId, ['pending'])).filter(
      (n) => n.kind === 'overdue_visit_gap',
    );
    for (const n of pending) {
      try {
        const ctx = readComposeContext(n);
        if (!ctx) {
          // Thin/tampered evidence: never ask a model to guess around it.
          const moved = await markOutcome(n.id, tenantId, 'cancelled', 'context incomplete');
          if (moved) summary.cancelled += 1;
          continue;
        }
        const args = await run(
          COMPOSE_TOOL,
          {
            system: COMPOSE_SYSTEM,
            user:
              `Customer: ${ctx.customerName}\n` +
              `Job: ${ctx.jobTitle}\n` +
              `Technician: ${ctx.technicianName}\n` +
              `The scheduled visit ended hours ago; no field note and no status change since.`,
            maxTokens: 300,
            label: 'teamLeadCompose',
            reasoningEffort: 'none',
          },
          { tenantId, technicianRef: TEAM_LEAD_REF },
        );
        if (args.ask !== true) {
          const reason = typeof args.reason === 'string' ? args.reason : 'model declined';
          const moved = await markOutcome(n.id, tenantId, 'cancelled', `declined: ${reason}`);
          if (moved) summary.cancelled += 1;
          continue;
        }
        const question = typeof args.question === 'string' ? args.question.trim() : '';
        if (question.length === 0 || question.length > 500) {
          throw new Error(`compose returned an unusable question (${question.length} chars)`);
        }
        const queued = await markQueued(n.id, tenantId, assembleNudgeMessage(question, ctx));
        if (queued) summary.composed += 1; // null = the row moved under us — drop the write
      } catch (err) {
        // Per-row isolation: one bad row/model blip never blocks the sweep.
        summary.rowErrors += 1;
        console.error(`[teamLeadCompose] nudge ${n.id} failed`, err);
        const attempts = n.attempts + 1;
        try {
          await setAttempts(n.id, tenantId, attempts);
          if (attempts >= MAX_COMPOSE_ATTEMPTS) {
            const moved = await markOutcome(
              n.id,
              tenantId,
              'failed',
              `compose failed ${attempts}x: ${err instanceof Error ? err.message : String(err)}`,
            );
            if (moved) summary.failed += 1;
          }
        } catch (bookkeepingErr) {
          // Attempts bookkeeping failing must not mask the original error;
          // the row simply retries next tick.
          console.error(`[teamLeadCompose] nudge ${n.id} attempts write failed`, bookkeepingErr);
        }
      }
    }
  }
  return summary;
}
