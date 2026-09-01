import type { ForcedToolSpec } from '../model/forcedTool.js';
import { runToolLoop } from '../model/toolLoop.js';
import {
  createOfficeMessage,
  listNudgesByStatus,
  markOfficeMessagesRead,
  OFFICE_MESSAGE_BODY_MAX,
  OPEN_NUDGE_STATUSES,
  type Nudge,
} from '../db/index.js';
import { renderMemoryIndex } from './memory.js';
import { TEAM_LEAD_REF } from './identity.js';
import {
  DESK_BUDGET_MS,
  DESK_MAX_TOKENS,
  DESK_MAX_TURNS,
  DESK_NARROW_DISCLOSURE,
  DESK_REASONING,
  DESK_SYSTEM,
} from './deskPrompt.js';

// The Q&A desk (plan 2026-08-31 "the planner's inbox", build 5.5, Phase 2):
// a bounded, read-only model call wearing the planner's memory, answering a
// seat agent's question INSIDE that agent's own tool call.
//
// IDENTITY: the desk runs server-side under TEAM_LEAD_REF — no new namespace.
// What keeps it read-only is the toolset: the write tools are excluded from
// the schemas handed to the loop, and the loop refuses any name outside the
// schemas it was given before the executor runs (the dispatch gate's spine
// ceiling would NOT stop write_memory — it is on the team-lead allowlist —
// so the filter here is the mechanism, not a redundancy). The desk cannot
// reach ask_team_lead or any seat tool either: they are outside
// TEAM_LEAD_TOOL_NAMES, so a desk-inside-desk recursion is structurally
// impossible.
//
// TIER IS THE TOOLSET (user choice "mirror existing rules", mechanized):
// an ACTIVE manager's desk gets the full team-lead READ surface (the repo's
// one manager predicate — isActiveManager's, decided by the caller); everyone
// else's desk gets NO dispatched tools at all — the handler pre-reads the
// asker's own open questions and inlines them, so the model cannot READ past
// that asker's own state. It serves the flagship "am I square with the
// office?" case. A roster-less asker gets the technician treatment.
//
// THE NOTES ARE THE EXCEPTION, and knowing which half is mechanism matters:
// the planner's memory index rides EVERY desk (user ruling, 2026-09-01 —
// "if the desk gets no MEMORY.md then it's not really an accurate
// representation of the planner… this is not a high stakes item"). So the
// TOOLS are bounded by mechanism and the NOTES by prompt (DESK_SYSTEM's
// discretion rules plus DESK_NARROW_DISCLOSURE, restated per non-manager
// asker in the user message). Do not describe the non-manager path as
// leak-proof: it is read-bounded, deliberately not disclosure-proof.

// The desk's toolset is an ALLOWLIST, not a denylist (final review): the
// team-lead surface grows a write verb per build, and a denylist would hand
// each new one to the desk automatically — failing OPEN, against the repo's
// deny-by-default doctrine. A new READ tool must be added here on purpose.
export const DESK_READ_TOOLS: ReadonlySet<string> = new Set([
  'spine_read',
  'recall_decisions',
  'read_memory',
  'read_job_note',
]);

// The degrade note, one copy: the ask row is already in the bucket unread, so
// this sentence is TRUE the moment it is returned.
export const DESK_FALLBACK_NOTE =
  'the desk could not answer right now — the office will see your question at its next ' +
  'planning pass';

const flat = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
};

export interface DeskQuestionInput {
  tenantId: string;
  /** The asker's display ref (their technician ref) — becomes from_ref. */
  askerRef: string;
  /** The asker's roster tier, or null for a roster-less badge. METADATA — it
   *  rides the ask row; the CAPABILITY decision is managerDesk below. */
  askerTier: string | null;
  /** Whether this asker gets the manager desk (the full team-lead read
   *  surface). The CALLER decides it with the repo's one active-manager
   *  predicate — tier === 'manager' AND state === 'active' (review F-A: an
   *  invited manager's pre-minted badge is manager-TIER but must get the
   *  self-scoped desk until verification, exactly as it gets no admin tool). */
  managerDesk: boolean;
  /** The asker's roster uuid, for the technician path's self-scoped pre-read. */
  askerTechnicianId: string | null;
  question: string;
}

export interface DeskDeps {
  /**
   * The team-lead tool schemas + the door they dispatch through, handed IN by
   * the MCP server's tool case rather than imported — desk.ts must not
   * statically import src/mcp/server.ts (it would close an import cycle), and
   * a test stubs both without ever building a server.
   */
  toolSchemas?: ReadonlyArray<ForcedToolSpec>;
  dispatch?: (
    name: string,
    args: Record<string, unknown>,
    identity: { tenantId: string; technicianRef: string },
  ) => Promise<unknown>;
  memoryIndex?: typeof renderMemoryIndex;
  runLoop?: typeof runToolLoop;
  createMessage?: typeof createOfficeMessage;
  markRead?: typeof markOfficeMessagesRead;
  listNudges?: typeof listNudgesByStatus;
}

/** What the office currently has open for ONE person, inlined for the
 *  technician-tier desk — their own questions and nothing else. */
export function renderAskerState(rows: Nudge[], askerTechnicianId: string | null): string {
  const own = askerTechnicianId
    ? rows.filter((n) => n.technician_id === askerTechnicianId)
    : [];
  if (own.length === 0) {
    return 'WHAT THE OFFICE HAS OPEN FOR THIS PERSON: nothing — no open questions for them.';
  }
  const lines = ['WHAT THE OFFICE HAS OPEN FOR THIS PERSON (their own questions only):'];
  for (const n of own) {
    lines.push(
      `  - ${n.kind}, status ${n.status}` +
        (n.question ? `: "${flat(n.question, 300)}"` : ' (no question written yet)') +
        (n.asked_at ? ` — went out ${n.asked_at}` : ''),
    );
  }
  return lines.join('\n');
}

export interface DeskAnswer {
  answer: string | null;
  /** Present only when answer is null — the honest degrade. */
  note?: string;
  /** The ask row's id — unread when the desk failed, read when it answered. */
  askId: string;
}

export async function answerDeskQuestion(
  input: DeskQuestionInput,
  deps: DeskDeps = {},
): Promise<DeskAnswer> {
  const { tenantId, askerRef, askerTier, askerTechnicianId, managerDesk, question } = input;
  const memoryIndex = deps.memoryIndex ?? renderMemoryIndex;
  const runLoop = deps.runLoop ?? runToolLoop;
  const createMessage = deps.createMessage ?? createOfficeMessage;
  const markRead = deps.markRead ?? markOfficeMessagesRead;
  const listNudges = deps.listNudges ?? listNudgesByStatus;

  // THE ASK ROW FIRST, born unread: a crash anywhere below leaves the question
  // in the bucket for the next tick — the failure mode is "the office will see
  // it", never a silently swallowed question.
  const ask = await createMessage({
    tenantId,
    direction: 'to_planner',
    kind: 'ask',
    fromRef: askerRef,
    toRef: TEAM_LEAD_REF,
    tier: askerTier,
    body: question,
  });

  try {
    // The planner's own notes, for EVERY asker (user ruling — see the header):
    // without them the desk answers as a stranger wearing the planner's name.
    // Degrade to '' on failure: the notes are an enhancement, the records are
    // the job (the planner's own memory-read posture).
    let index = '';
    try {
      index = await memoryIndex(tenantId);
    } catch (err) {
      console.error(`[desk] tenant ${tenantId}: memory read failed — answering without`, err);
    }

    let tools: ForcedToolSpec[] = [];
    let askerState = '';
    if (managerDesk) {
      tools = (deps.toolSchemas ?? []).filter((t) => DESK_READ_TOOLS.has(t.name));
    } else {
      // Self-scoped pre-read, inlined: the technician desk gets no dispatched
      // tools at all, so the model structurally cannot read beyond this.
      const open = await listNudges(tenantId, [...OPEN_NUDGE_STATUSES]);
      askerState = renderAskerState(open, askerTechnicianId);
    }

    const user = [
      ...(index ? ['THE OFFICE\'S OWN NOTES — the index:', index, ''] : []),
      ...(askerState ? [askerState, ''] : []),
      // Restated HERE, next to the question, for a non-manager asker: this is
      // the one rule that varies per call, and the notes above are in front of
      // the model either way.
      ...(managerDesk ? [] : [DESK_NARROW_DISCLOSURE, '']),
      `QUESTION from ${askerRef}${askerTier ? ` (${askerTier})` : ''}: ${question}`,
    ].join('\n');

    const dispatch = deps.dispatch;
    const result = await runLoop(
      {
        system: DESK_SYSTEM,
        user,
        maxTokens: DESK_MAX_TOKENS,
        label: 'teamLeadDesk',
        reasoningEffort: DESK_REASONING,
        budgetMs: DESK_BUDGET_MS,
        maxTurns: DESK_MAX_TURNS,
        // No terminal tool — the loop returns on the first text-only turn, and
        // that text IS the answer.
      },
      tools,
      async (name, args) => {
        if (!dispatch) throw new Error(`no dispatcher for '${name}'`);
        return dispatch(name, args, { tenantId, technicianRef: TEAM_LEAD_REF });
      },
      { tenantId, technicianRef: TEAM_LEAD_REF, lane: 'desk' },
    );
    // Capped at the transcript's own limit (final review): the transcript is
    // the audit of what was said in the planner's name, and an answer longer
    // than the row can hold would make the asker and the auditor read
    // different texts. Four sentences fit many times over.
    const answer = result.text.trim().slice(0, OFFICE_MESSAGE_BODY_MAX);
    if (!answer) throw new Error('the loop returned no text');

    // Transcript: the answer, born READ — it is a record of what was said in
    // the planner's name, not queue work. in_reply_to ties the pair for the
    // next tick's appendix.
    await createMessage({
      tenantId,
      direction: 'to_planner',
      kind: 'desk',
      fromRef: TEAM_LEAD_REF,
      toRef: askerRef,
      body: answer,
      inReplyTo: ask.id,
      status: 'read',
    });
    // The answered ask leaves the unread queue. Best-effort: if this write
    // fails the tick re-reads an already-answered question, which costs a
    // redundant line in one briefing — never a lost one.
    try {
      await markRead(tenantId, [ask.id], new Date().toISOString());
    } catch (err) {
      console.error(`[desk] tenant ${tenantId}: marking the answered ask read failed`, err);
    }
    return { answer, askId: ask.id };
  } catch (err) {
    // Any model/loop failure: the ask row stays UNREAD, so the deciding
    // planner sees the question next tick — the degrade the note promises.
    console.error(`[desk] tenant ${tenantId}: could not answer — the ask stays queued`, err);
    return { answer: null, note: DESK_FALLBACK_NOTE, askId: ask.id };
  }
}
