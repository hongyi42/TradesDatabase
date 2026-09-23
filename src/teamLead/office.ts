import type { ForcedToolSpec } from '../model/forcedTool.js';
import { runToolLoop } from '../model/toolLoop.js';
import {
  addManagersTexted,
  createOfficeMessage,
  findOpenAccessRequest,
  getCustomer,
  getJob,
  getTenant,
  hasLapsed,
  lapseAccessRequest,
  listManagersWithTelegram,
  listOpenJobsForCustomer,
  openAccessRequest,
  queuePersonPush,
  requestKeyOf,
  viewHasCustomer,
  viewShowsMoney,
  type AccessRequest,
  type AccessWants,
  type Technician,
  getTechnicianView,
  listJobsForCustomer,
  listNudgesByStatus,
  listOfficeMessagesForRef,
  listRecentAccessRequestsFor,
  markOfficeMessagesRead,
  OFFICE_MESSAGE_BODY_MAX,
  OPEN_NUDGE_STATUSES,
  searchCustomersByName,
  viewHasJob,
  type Nudge,
  type TechnicianView,
  contextOf,
} from '../db/index.js';
import { renderMemoryIndex } from './memory.js';
import { TEAM_LEAD_REF } from './identity.js';
import { PLANNER_MAX_TOKENS, PLANNER_REASONING } from './planner.js';
import { ANSWER_TOOL, officeSystemFor, ROUTE_ACCESS_TOOL } from './officePrompt.js';
import { localDateISO } from '../schedule/availability.js';
import { servedDayPhrase } from '../schedule/dateResolve.js';

// THE OFFICE (plan 2026-09-22, "the office: one agent, three doors"; rung 10c
// added a fourth, a seat's message, and gave each door its own prompt).
//
// One runner for the doors where a seat is WAITING — its question, and its
// access ask. (The call and message doors are the planner's focused pass
// running on the office's prompt; see runPlanner.) Both waiting doors are the
// same agent, the same doctrine and the same model as the rest of the team lead
// — each loading only the sections it uses (officeSystemFor); what
// differs per call is WHO IS FACING IT, and that is decided here, by code:
//
//   * a MANAGER gets the team lead's reads (spine_read, recall_decisions) and its
//     notes — a manager may be told anything the firm knows;
//   * ANYBODY ELSE gets the office's notes plus two tools that exist only here:
//     `catalog_lookup` (the firm as NAMES AND IDS — the index, never the
//     dictionary) and `asker_history` (this person's own business with the
//     office). No record reads: their own seat already has those, scoped to them.
//
// So what a technician-facing office can SEE is bounded by mechanism. What it
// SAYS is steered by the office's prompt — and the notes, which carry contents, stay
// prompt-guarded by the operator's 2026-09-01 ruling (the known hole).
//
// NO SHORT CLOCK (operator, 2026-09-22): a waiting person tolerates minutes, and
// a short clock cost answers their quality. Speed is the prompt's job.

// Four minutes, inside the seat's own tool-call timeout (the Copilot SDK seat is
// set to 300s; see the plan's Decisions for the OpenClaw seats' 60s hole).
export const OFFICE_WAITING_BUDGET_MS = 240_000;
// The asker's side of the contract, enforced at the tool boundary.
export const OFFICE_QUESTION_MAX = 500;
// One agent, one effort and one output budget — tune from traces, not by door.
export const OFFICE_REASONING = PLANNER_REASONING;
export const OFFICE_MAX_TOKENS = PLANNER_MAX_TOKENS;

// UUID-SHAPED FIRST: these ids come from a model, and a malformed one reaching a
// uuid-typed column returns a raw database error instead of an answer.
export const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type Facing =
  | { kind: 'manager' }
  | { kind: 'technician'; technicianId: string | null; ref: string };

const flat = (text: string, max: number): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max)}…`;
};

// ── the tools a door is handed ───────────────────────────────────────────────

// ALLOWLISTS, not denylists: the team-lead surface grows a verb per build, and a
// denylist would hand each new one to a waiting door automatically, failing open.
export const MANAGER_FACING_TOOLS: ReadonlySet<string> = new Set([
  'spine_read',
  'recall_decisions',
  'read_memory',
  'write_memory',
  'read_job_note',
  'write_job_note',
]);
export const TECHNICIAN_FACING_TOOLS: ReadonlySet<string> = new Set([
  'read_memory',
  'write_memory',
  'read_job_note',
  'write_job_note',
]);

export const CATALOG_TOOL: ForcedToolSpec = {
  name: 'catalog_lookup',
  description:
    "The firm's catalog — customers and jobs as NAMES AND IDS ONLY, each job marked with " +
    'whether it is unfinished and whether it is in the asking person\'s view. Use it to know ' +
    'what exists and what they can open. It never shows a job title, an address, money or a ' +
    'note. Give `query` to find customers by name (at most 20 matches — make it specific), or ' +
    '`customerId` to list that customer\'s jobs.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Part of a customer name.' },
      customerId: { type: 'string', description: "A customer id, to list that customer's jobs." },
    },
  },
};

export const ASKER_HISTORY_TOOL: ForcedToolSpec = {
  name: 'asker_history',
  description:
    'Everything between the office and the person asking: messages either way over the last ' +
    'month, what the office has open with them, and their recent access requests with how each ' +
    'ended. Only ever about the person asking.',
  inputSchema: { type: 'object', properties: {} },
};

/** The schemas a door hands the loop, for who is facing it. */
export function officeToolsFor(
  facing: Facing,
  schemas: ReadonlyArray<ForcedToolSpec>,
): ForcedToolSpec[] {
  const allow = facing.kind === 'manager' ? MANAGER_FACING_TOOLS : TECHNICIAN_FACING_TOOLS;
  const handed = schemas.filter((t) => allow.has(t.name));
  return facing.kind === 'manager' ? handed : [...handed, CATALOG_TOOL, ASKER_HISTORY_TOOL];
}

// ── the catalog: the index, never the dictionary ─────────────────────────────

export interface CatalogCustomer {
  id: string;
  name: string;
}
export interface CatalogJob {
  id: string;
  customerId: string;
  /** open or in progress — the same test the old narrowing rule used. */
  unfinished: boolean;
  inTheirView: boolean;
}

export interface CatalogDeps {
  searchCustomers?: typeof searchCustomersByName;
  getCustomer?: typeof getCustomer;
  listJobsForCustomer?: typeof listJobsForCustomer;
}

/**
 * NAME AND ID, nothing else — that is already what find_customer gives a
 * technician for a customer outside their view, so the catalog adds no exposure.
 * A name match only: a phone or street match handed back would let an address
 * be probed for ("is 12 Oak St a customer?").
 */
export async function catalogLookup(
  tenantId: string,
  view: TechnicianView,
  args: { query?: unknown; customerId?: unknown },
  deps: CatalogDeps = {},
): Promise<{ customers?: CatalogCustomer[]; jobs?: CatalogJob[] }> {
  if (typeof args.customerId === 'string' && args.customerId.trim()) {
    const id = args.customerId.trim();
    // Shape, then tenant: listJobsForCustomer takes no tenant, so the customer
    // row's own tenant is the proof the jobs are this firm's.
    if (!UUID_SHAPE.test(id)) return { jobs: [] };
    const customer = await (deps.getCustomer ?? getCustomer)(id);
    if (!customer || customer.tenant_id !== tenantId) return { jobs: [] };
    const jobs = await (deps.listJobsForCustomer ?? listJobsForCustomer)(customer.id);
    return {
      jobs: jobs.map((j) => ({
        id: j.id,
        customerId: customer.id,
        unfinished: j.status === 'open' || j.status === 'in_progress',
        inTheirView: viewHasJob(view, j.id),
      })),
    };
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return { customers: [] };
  // A NAME-ONLY search (searchCustomersByName), then the same test again here —
  // the belt: nothing but a name match may come back, whatever the accessor does.
  const needle = query.toLowerCase();
  const rows = await (deps.searchCustomers ?? searchCustomersByName)(tenantId, query);
  return {
    customers: rows
      .filter((c) => c.tenant_id === tenantId && c.name.toLowerCase().includes(needle))
      .map((c) => ({ id: c.id, name: c.name })),
  };
}

// ── the asker's own business with the office ─────────────────────────────────

/** What the office currently has open for ONE person — their own questions and
 *  nothing else. (Moved from the desk, which inlined it for the same reason.) */
export function renderAskerState(rows: Nudge[], askerTechnicianId: string | null): string {
  const own = askerTechnicianId ? rows.filter((n) => n.technician_id === askerTechnicianId) : [];
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

export interface AskerHistoryDeps {
  listMessages?: typeof listOfficeMessagesForRef;
  listNudges?: typeof listNudgesByStatus;
  listRequests?: typeof listRecentAccessRequestsFor;
  now?: () => Date;
}

const DAY_MS = 24 * 3_600_000;

/** How the access door's transcript ask row begins (recordPair below; rows from
 *  before 2026-09-22 began the same way and named the job by title). */
export const ACCESS_ASK_PREFIX = 'Asked to open ';

/**
 * This person's business with the office, and nobody else's: the ref and the
 * roster id are the VERIFIED caller's, closed over by the door — never an
 * argument the model supplies. Access requests render from their ids and fields,
 * never `targetName`, which carries a job title the asker may not be able to see.
 */
export async function askerHistory(
  tenantId: string,
  facing: Extract<Facing, { kind: 'technician' }>,
  deps: AskerHistoryDeps = {},
): Promise<string> {
  const now = (deps.now ?? (() => new Date()))().getTime();
  const [messages, nudges, requests] = await Promise.all([
    (deps.listMessages ?? listOfficeMessagesForRef)(
      tenantId,
      facing.ref,
      new Date(now - 30 * DAY_MS).toISOString(),
    ),
    (deps.listNudges ?? listNudgesByStatus)(tenantId, [...OPEN_NUDGE_STATUSES]),
    facing.technicianId
      ? (deps.listRequests ?? listRecentAccessRequestsFor)(
          tenantId,
          facing.technicianId,
          new Date(now - 14 * DAY_MS).toISOString(),
        )
      : Promise.resolve([]),
  ]);
  const lines = [renderAskerState(nudges, facing.technicianId), ''];
  lines.push(
    messages.length === 0
      ? 'MESSAGES WITH THE OFFICE (30 days): none.'
      : 'MESSAGES WITH THE OFFICE (30 days, newest first):',
  );
  for (const m of messages) {
    const who = m.from_ref === facing.ref ? 'they said' : 'the office said';
    // An ACCESS ask row's body was written by code, not by them, and before
    // 2026-09-22 it named the job by title — a title they may not be able to
    // see. Its content is already below, built from ids, so the body is not shown.
    const body =
      m.kind === 'ask' && m.body.startsWith(ACCESS_ASK_PREFIX)
        ? '(an access request — see THEIR ACCESS REQUESTS)'
        : flat(m.body, 300);
    lines.push(`  - ${m.created_at} ${who} (${m.kind}): ${body}`);
  }
  lines.push('');
  lines.push(
    requests.length === 0
      ? 'THEIR ACCESS REQUESTS (14 days): none.'
      : 'THEIR ACCESS REQUESTS (14 days, newest first):',
  );
  for (const r of requests) {
    const c = contextOf(r);
    const target = c.jobId ? `job ${c.jobId} (customer ${c.customerId})` : `customer ${c.customerId}`;
    // A day-old open row has LAPSED (REQUEST_LAPSE_MS) even though nothing has
    // moved it yet — the lapse is applied where it is read. Shown as waiting, it
    // would talk the office out of ever asking again (final review).
    const ending =
      r.status === 'dismissed'
        ? `ended: ${r.dismiss_reason ?? 'settled'}`
        : hasLapsed(r, new Date(now))
          ? 'LAPSED — over a day with no answer; it no longer holds, and asking again files a fresh request'
          : 'still waiting on a manager';
    const asked = c.managersTexted?.length ? `; asked ${c.managersTexted.join(', ')}` : '';
    lines.push(
      `  - ${r.noticed_at} wanted ${c.wants ?? 'record'} on ${target}` +
        `${c.why ? `, because "${flat(c.why, 200)}"` : ''}${asked}; ${ending}`,
    );
  }
  return lines.join('\n');
}

// ── the runner ────────────────────────────────────────────────────────────────

export type OfficeDispatch = (
  name: string,
  args: Record<string, unknown>,
  identity: { tenantId: string; technicianRef: string },
) => Promise<unknown>;

export interface OfficeDoorInput {
  tenantId: string;
  facing: Facing;
  /** Everything the door knows, already rendered: who is asking and what. */
  userMessage: string;
  /** Which waiting door this is — it picks the prompt (each door loads only
   *  the doctrine it uses; officeSystemFor). Named by the caller rather than
   *  read off `terminal`, so a new door cannot silently inherit another's. */
  door: 'question' | 'access';
  /** The door's terminal tool — calling it IS the outcome. */
  terminal: ForcedToolSpec;
  /** The team lead's schemas (handed in by the MCP server — no import cycle). */
  schemas: ReadonlyArray<ForcedToolSpec>;
  dispatch?: OfficeDispatch;
  /** Cost lane label, per door. */
  lane: string;
  /** Aborted when the seat hangs up — the loop stops at its next turn. */
  signal?: AbortSignal;
  /** Checks the terminal tool's arguments. A message REFUSES the call, and the
   *  model hears why and may retry — as submit_plan is validated in its executor,
   *  rather than letting a malformed ending end the loop. */
  validate?: (args: Record<string, unknown>) => string | null;
  /** The asker's view, when the door has already read it. */
  view?: TechnicianView;
  /** Tools this door leaves out (its content is already in the message). */
  omit?: ReadonlyArray<string>;
}

export interface OfficeDoorDeps {
  memoryIndex?: typeof renderMemoryIndex;
  runLoop?: typeof runToolLoop;
  technicianView?: typeof getTechnicianView;
  catalog?: CatalogDeps;
  history?: AskerHistoryDeps;
}

export interface OfficeDoorResult {
  /** The terminal tool's arguments, or null when the loop ended in plain text. */
  args: Record<string, unknown> | null;
  /** The loop's final text — the question door's fallback answer. */
  text: string;
}

export async function runOfficeDoor(
  input: OfficeDoorInput,
  deps: OfficeDoorDeps = {},
): Promise<OfficeDoorResult> {
  const { tenantId, facing, terminal } = input;
  const runLoop = deps.runLoop ?? runToolLoop;

  // The notes ride every door, as they rode every desk: without them the office
  // answers as a stranger wearing its name. Degrade to none on a failed read.
  let index = '';
  try {
    index = await (deps.memoryIndex ?? renderMemoryIndex)(tenantId);
  } catch (err) {
    console.error(`[office] tenant ${tenantId}: memory read failed — answering without`, err);
  }

  // Read the view ONCE per door, lazily: only the catalog needs it.
  let view: TechnicianView | null = input.view ?? null;
  const viewOf = async (): Promise<TechnicianView> => {
    if (!view) {
      const id = facing.kind === 'technician' ? facing.technicianId : null;
      view = await (deps.technicianView ?? getTechnicianView)(tenantId, id);
    }
    return view;
  };

  const omit = new Set(input.omit ?? []);
  const tools = [...officeToolsFor(facing, input.schemas).filter((t) => !omit.has(t.name)), terminal];
  const handed = new Set(tools.map((t) => t.name));
  let captured: Record<string, unknown> | null = null;

  const user = [
    ...(index ? ["THE OFFICE'S OWN NOTES — the index:", index, ''] : []),
    input.userMessage,
  ].join('\n');

  const result = await runLoop(
    {
      system: officeSystemFor(input.door),
      user,
      maxTokens: OFFICE_MAX_TOKENS,
      label: 'office',
      reasoningEffort: OFFICE_REASONING,
      budgetMs: OFFICE_WAITING_BUDGET_MS,
      maxTurns: null,
      terminalTool: terminal.name,
      ...(input.signal ? { signal: input.signal } : {}),
    },
    tools,
    async (name, args) => {
      // The loop refuses unknown names itself; this is the belt behind it.
      if (!handed.has(name)) throw new Error(`'${name}' is not a tool this door was given`);
      if (name === terminal.name) {
        const problem = input.validate?.(args) ?? null;
        if (problem) throw new Error(problem);
        captured = args;
        return 'ok';
      }
      if (facing.kind === 'technician' && name === CATALOG_TOOL.name) {
        return catalogLookup(tenantId, await viewOf(), args, deps.catalog);
      }
      if (facing.kind === 'technician' && name === ASKER_HISTORY_TOOL.name) {
        return askerHistory(tenantId, facing, deps.history);
      }
      if (!input.dispatch) throw new Error(`no dispatcher for '${name}'`);
      return input.dispatch(name, args, { tenantId, technicianRef: TEAM_LEAD_REF });
    },
    { tenantId, technicianRef: TEAM_LEAD_REF, lane: input.lane },
  );
  return { args: captured, text: result.text };
}

// ── door 1: a seat's question ─────────────────────────────────────────────────

// The degrade note, one copy: the ask row is already in the bucket unread, so
// this sentence is TRUE the moment it is returned.
export const OFFICE_FALLBACK_NOTE =
  'the office could not answer right now — it will see your question at its next planning pass';

// RESTATED beside the question for a non-manager, not left to the system prompt
// alone (the desk's lesson, 2026-09-01: description-only wording was too weak for
// the live model, and this is the one rule that changes per asker). USE THE NOTES
// comes first — "do not read your notes" reads as "do not consult them".
export const OFFICE_NARROW_REMINDER = [
  'THIS PERSON IS NOT A MANAGER. Read your notes as usual; what is narrowed is only what may',
  'leave this call: their own work, never a note quoted, never what your notes say about',
  'someone else, never your judgment of them, never a money amount, never a job or customer',
  'outside their view beyond its name.',
].join('\n');

export interface OfficeQuestionInput {
  tenantId: string;
  /** The asker's roster ref — becomes from_ref. The VERIFIED caller, never chat text. */
  askerRef: string;
  /** The asker's tier — METADATA on the ask row; the capability is `managerDesk`. */
  askerTier: string | null;
  /** The repo's one active-manager predicate, decided by the caller (an invited
   *  manager's pre-minted badge is manager-TIER but not yet a manager here). */
  managerDesk: boolean;
  /** The asker's roster uuid; null for a badge with no roster row. */
  askerTechnicianId: string | null;
  question: string;
}

export interface OfficeWaitingDeps extends OfficeDoorDeps {
  /** The team-lead schemas + the door they dispatch through, handed IN by the
   *  MCP server — office.ts must not import src/mcp/server.ts (import cycle). */
  toolSchemas?: ReadonlyArray<ForcedToolSpec>;
  dispatch?: OfficeDispatch;
  createMessage?: typeof createOfficeMessage;
  markRead?: typeof markOfficeMessagesRead;
  listNudges?: typeof listNudgesByStatus;
  /** The seat's hang-up (the HTTP request closed before the reply). */
  signal?: AbortSignal;
}

export interface OfficeAnswer {
  answer: string | null;
  /** Present only when answer is null — the honest degrade. */
  note?: string;
  /** The ask row's id — unread when the office failed, read when it answered. */
  askId: string;
}

const facingFor = (
  managerDesk: boolean,
  askerRef: string,
  askerTechnicianId: string | null,
): Facing =>
  managerDesk
    ? { kind: 'manager' }
    : { kind: 'technician', technicianId: askerTechnicianId, ref: askerRef };

export async function answerAsOffice(
  input: OfficeQuestionInput,
  deps: OfficeWaitingDeps = {},
): Promise<OfficeAnswer> {
  const { tenantId, askerRef, askerTier, askerTechnicianId, managerDesk, question } = input;
  const createMessage = deps.createMessage ?? createOfficeMessage;
  const markRead = deps.markRead ?? markOfficeMessagesRead;

  // THE ASK ROW FIRST, born unread: a crash anywhere below leaves the question in
  // the bucket for the next review — "the office will see it", never swallowed.
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
    const facing = facingFor(managerDesk, askerRef, askerTechnicianId);
    const who = `${askerRef}${askerTier ? ` (${askerTier})` : ''}`;
    const lines = ['THIS IS A QUESTION from a seat that is waiting — end with `answer`.'];
    if (facing.kind === 'manager') {
      lines.push(`THE PERSON ASKING is a MANAGER: ${who}.`);
    } else {
      // Their own open questions, inlined — the commonest question is "am I
      // square with the office?", and it should not cost a tool call.
      const open = await (deps.listNudges ?? listNudgesByStatus)(tenantId, [...OPEN_NUDGE_STATUSES]);
      lines.push(`THE PERSON ASKING is NOT a manager: ${who}.`, '', renderAskerState(open, askerTechnicianId));
      lines.push('', OFFICE_NARROW_REMINDER);
    }
    lines.push('', `QUESTION: ${question}`);

    const res = await runOfficeDoor(
      {
        tenantId,
        facing,
        userMessage: lines.join('\n'),
        door: 'question',
        terminal: ANSWER_TOOL,
        schemas: deps.toolSchemas ?? [],
        dispatch: deps.dispatch,
        lane: 'office-question',
        validate: (a) =>
          typeof a.text === 'string' && a.text.trim()
            ? null
            : '`answer` needs `text`: the words the seat should hear.',
        ...(deps.signal ? { signal: deps.signal } : {}),
      },
      deps,
    );
    // The terminal tool is the answer; a plain-text ending is used as one.
    // Capped at the transcript's own limit, so the asker and the auditor read
    // the same text.
    // A PRESENT-but-malformed `answer` is a failure, not a cue to fall back on
    // the text: on a terminal turn that text is the model's preamble ("let me
    // check…"), and it would reach the seat as the office's answer.
    if (res.args !== null && typeof res.args.text !== 'string') {
      throw new Error('the office called answer without text');
    }
    const raw = res.args !== null ? (res.args.text as string) : res.text;
    const answer = raw.trim().slice(0, OFFICE_MESSAGE_BODY_MAX);
    if (!answer) throw new Error('the office returned no answer');

    // Transcript: the answer, born READ — a record of what was said in the
    // office's name, not queue work. in_reply_to ties the pair for the review.
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
    try {
      await markRead(tenantId, [ask.id], new Date().toISOString());
    } catch (err) {
      console.error(`[office] tenant ${tenantId}: marking the answered ask read failed`, err);
    }
    return { answer, askId: ask.id };
  } catch (err) {
    console.error(`[office] tenant ${tenantId}: could not answer — the ask stays queued`, err);
    return { answer: null, note: OFFICE_FALLBACK_NOTE, askId: ask.id };
  }
}

// ── door 2: a seat's access ask ───────────────────────────────────────────────
//
// THE OFFICE JUDGES, CODE GUARDS (operator doctrine, 2026-09-22). The office
// decides what to ask for (narrowing a customer-wide ask to one job), whether a
// repeat goes out and to whom (it is shown her recent requests, a manager's "no"
// included), which managers, and the words. Code keeps what must never be a
// model's: the refusals (a manager, a roster-less badge, one real target on this
// firm), the dedup index, the lapse that frees it, the line that names the target
// (the office only ever saw ids), and the reply menu (a plain "yes" on a money
// ask opens the figures, and the ledger has no delete).
//
// ONLY A MANAGER OPENS ANYTHING (2026-09-20): nothing on this path writes a grant.
//
// A REQUEST IS NEVER LOST (operator, 2026-09-22): if the office fails, or ends
// without deciding, today's code path runs — narrow by rule, file, text every
// reachable manager. The one exception is a seat that has hung up: nobody is
// there to be told, so nothing is filed or sent.

export type AccessDeskStatus = 'asked_manager' | 'already_open' | 'already_asked' | 'refused';

export interface AccessDeskAnswer {
  status: AccessDeskStatus;
  answer: string;
}

export interface AccessRequestInput {
  tenantId: string;
  /** The asker's roster ref. Identity, never chat text. */
  askerRef: string;
  /** Their display name — what the manager's text says. */
  askerName: string;
  askerTier: string | null;
  /** The asker's roster uuid — null for a badge with no roster row. */
  askerTechnicianId: string | null;
  /** The repo's one active-manager predicate, decided by the caller. */
  activeManager: boolean;
  /** The technician's own reason — ask_team_lead's `question`. */
  why: string;
  jobId?: string;
  customerId?: string;
  wants: AccessWants;
}

export interface AccessDoorDeps extends OfficeWaitingDeps {
  now?: () => Date;
  getJob?: typeof getJob;
  getCustomer?: typeof getCustomer;
  listOpenJobs?: typeof listOpenJobsForCustomer;
  listJobs?: typeof listJobsForCustomer;
  listManagers?: typeof listManagersWithTelegram;
  queuePush?: typeof queuePersonPush;
  openRequest?: typeof openAccessRequest;
  findRequest?: typeof findOpenAccessRequest;
  lapseRequest?: typeof lapseAccessRequest;
  addManagers?: typeof addManagersTexted;
  firmTenant?: typeof getTenant;
}

// ── words (NO IDS AND NO ROSTER REFS: they are read out to a person) ─────────

interface Target {
  jobId?: string;
  customerId: string;
  jobTitle?: string | null;
  customerName: string;
}

const jobWords = (t: Target): string =>
  t.jobTitle ? `the "${t.jobTitle}" job for ${t.customerName}` : `${t.customerName}'s job`;

// What was asked for, in words — for the MANAGER, who may see anything.
function whatWords(t: Target, wants: AccessWants): string {
  const where = t.jobId ? jobWords(t) : `${t.customerName}'s record — every job of theirs`;
  if (wants === 'money') return `the money figures on ${where}`;
  if (wants === 'notes') return `every note on ${where}, calls and emails included`;
  return where;
}

// The same, WITHOUT a job title — for the transcript row, which the office later
// shows the technician through asker_history. She may not be able to see a job
// the office narrowed to, so its title never goes in a row she is shown.
function titleFreeWords(t: Target, wants: AccessWants): string {
  const where = t.jobId ? `the job you asked about for ${t.customerName}` : `${t.customerName}'s record`;
  return wants === 'money' ? `the figures on ${where}` : wants === 'notes' ? `the notes on ${where}` : where;
}

// A plain "yes" answers the question that was ASKED — grant_access fills `money`
// and `opens` from the request — so the menu is width-aware: offering "yes with
// prices" beside a money ask would imply the plain yes withholds them.
function replyMenu(wants: AccessWants): string {
  return wants === 'money'
    ? 'Reply yes to open the figures, yes for good to leave them open, or no.'
    : wants === 'notes'
      ? 'Reply yes to open every note on it, yes for good to leave it open, or no.'
      : 'Reply to answer: yes, yes for good, yes with prices, or no.';
}

const listNames = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const STOPPED: AccessDeskAnswer = {
  status: 'refused',
  answer: 'Stopped — nothing was sent to a manager.',
};

// ── the door ──────────────────────────────────────────────────────────────────

export async function routeAccessAsOffice(
  input: AccessRequestInput,
  deps: AccessDoorDeps = {},
): Promise<AccessDeskAnswer> {
  const { tenantId, askerTechnicianId, wants } = input;
  const readJob = deps.getJob ?? getJob;
  const readCustomer = deps.getCustomer ?? getCustomer;
  const readView = deps.technicianView ?? getTechnicianView;

  // 1. WHO IS ASKING — refusals in words, never errors.
  if (input.activeManager) {
    return {
      status: 'refused',
      answer:
        'You already see the whole record — every customer, every job. There is nothing for me ' +
        'to open.',
    };
  }
  if (!askerTechnicianId) {
    return {
      status: 'refused',
      answer:
        'I could not find you on the team list, so I cannot ask for access on your behalf. A ' +
        'manager can sort that out.',
    };
  }

  // 2. WHAT IS BEING ASKED FOR — exactly one target, this firm's. Another firm's
  // id answers exactly like an unknown one.
  if (!input.jobId && !input.customerId) {
    return {
      status: 'refused',
      answer: 'I need to know which job or which customer you need. Ask me again and name one.',
    };
  }
  if (input.jobId && input.customerId) {
    return { status: 'refused', answer: 'Name one thing at a time — either the job or the customer.' };
  }
  const view = await readView(tenantId, askerTechnicianId);
  let asked: Target;
  if (input.jobId) {
    const notFound = { status: 'refused' as const, answer: 'I cannot find that job on this firm.' };
    if (!UUID_SHAPE.test(input.jobId)) return notFound;
    const job = await readJob(input.jobId);
    if (!job || job.tenant_id !== tenantId) return notFound;
    const customer = await readCustomer(job.customer_id);
    if (!customer || customer.tenant_id !== tenantId) return notFound;
    asked = { jobId: job.id, customerId: customer.id, jobTitle: job.title, customerName: customer.name };
  } else {
    const notFound = { status: 'refused' as const, answer: 'I cannot find that customer on this firm.' };
    if (!UUID_SHAPE.test(input.customerId as string)) return notFound;
    const customer = await readCustomer(input.customerId as string);
    if (!customer || customer.tenant_id !== tenantId) return notFound;
    asked = { customerId: customer.id, customerName: customer.name };
  }
  // KEYED ON WHAT SHE ASKED, not on what it was narrowed to: narrowing depends on
  // how many live jobs the customer has right now, and the same ask at 9am and
  // 11am must key the same or every manager is texted twice.
  const requestKey = requestKeyOf({
    technicianId: askerTechnicianId,
    jobId: input.jobId,
    customerId: input.customerId ?? asked.customerId,
    wants,
  });
  const managers = (await (deps.listManagers ?? listManagersWithTelegram)(tenantId)).filter(
    (m) => !!m.sandbox_ref, // REACHABLE means texted: the push leg skips a seat-less person
  );

  // 3. THE OFFICE DECIDES.
  let decision: Record<string, unknown> | null = null;
  try {
    decision = await askTheOffice(input, asked, view, managers, deps);
  } catch (err) {
    if (deps.signal?.aborted) return STOPPED;
    console.error(`[office] tenant ${tenantId}: the access door fell back to code`, err);
  }
  if (deps.signal?.aborted) return STOPPED;

  // 4. CODE APPLIES IT — or, with no usable decision, today's path.
  try {
    if (decision && isRouteDecision(decision)) {
      return await applyDecision(input, asked, requestKey, view, managers, decision, deps);
    }
  } catch (err) {
    console.error(`[office] tenant ${tenantId}: applying the office's access decision failed`, err);
  }
  return routeByCode(input, asked, requestKey, view, managers, deps);
}

interface RouteDecision {
  outcome: 'ask' | 'already_open' | 'already_asked' | 'refuse';
  jobId?: string;
  managers?: string[];
  managerMessage?: string;
  replyToAsker: string;
  reason: string;
}

function isRouteDecision(d: Record<string, unknown>): d is Record<string, unknown> & RouteDecision {
  const optText = (v: unknown) => v === undefined || v === null || typeof v === 'string';
  return (
    ['ask', 'already_open', 'already_asked', 'refuse'].includes(d.outcome as string) &&
    typeof d.replyToAsker === 'string' &&
    d.replyToAsker.trim().length > 0 &&
    optText(d.jobId) &&
    optText(d.managerMessage) &&
    optText(d.reason) &&
    (d.managers === undefined ||
      d.managers === null ||
      (Array.isArray(d.managers) && d.managers.every((m) => typeof m === 'string')))
  );
}

async function askTheOffice(
  input: AccessRequestInput,
  asked: Target,
  view: TechnicianView,
  managers: Technician[],
  deps: AccessDoorDeps,
): Promise<Record<string, unknown> | null> {
  const { tenantId } = input;
  const facing = {
    kind: 'technician' as const,
    technicianId: input.askerTechnicianId,
    ref: input.askerRef,
  };
  // THE CATALOG ROWS for the target customer — ids and marks, never titles.
  const catalog = await catalogLookup(tenantId, view, { customerId: asked.customerId }, {
    getCustomer: deps.getCustomer,
    listJobsForCustomer: deps.listJobs,
  });
  const history = await askerHistory(tenantId, facing, deps.history);
  const targetLine = asked.jobId
    ? `job ${asked.jobId} of customer "${asked.customerName}" (${asked.customerId})`
    : `customer "${asked.customerName}" (${asked.customerId}) — every job of theirs`;
  const inView = asked.jobId ? viewHasJob(view, asked.jobId) : viewHasCustomer(view, asked.customerId);
  const money = viewShowsMoney(view, { jobId: asked.jobId, customerId: asked.customerId });
  const lines = [
    'THIS IS AN ACCESS ASK from a seat that is waiting — end with `route_access`.',
    `THE PERSON ASKING is NOT a manager: ${input.askerName} (${input.askerRef}).`,
    `THEY ASK FOR: ${input.wants} on ${targetLine}.`,
    `THEIR REASON, in their words: "${input.why}"`,
    `WHAT THEIR VIEW SAYS NOW: they ${inView ? 'CAN' : 'cannot'} open that; money figures there ` +
      `are ${money ? 'OPEN' : 'not open'} to them.`,
    "THAT CUSTOMER'S JOBS (the catalog — ids and marks only):",
    ...(catalog.jobs ?? []).map(
      (j) =>
        `  - ${j.id}: ${j.unfinished ? 'unfinished' : 'finished'}, ` +
        `${j.inTheirView ? 'in their view' : 'NOT in their view'}`,
    ),
    'THE MANAGERS YOU CAN ASK (names to copy into `managers`):',
    ...(managers.length > 0
      ? managers.map((m) => `  - ${m.display_name}`)
      : ['  - nobody can be texted right now']),
    '',
    history,
    '',
    OFFICE_NARROW_REMINDER,
  ];
  const res = await runOfficeDoor(
    {
      tenantId,
      facing,
      userMessage: lines.join('\n'),
      door: 'access',
      terminal: ROUTE_ACCESS_TOOL,
      schemas: deps.toolSchemas ?? [],
      dispatch: deps.dispatch,
      lane: 'office-access',
      view,
      // Her history is already in the message above.
      omit: [ASKER_HISTORY_TOOL.name],
      validate: (a) =>
        isRouteDecision(a)
          ? null
          : '`route_access` needs an `outcome` from the list and a non-empty `replyToAsker`; ' +
            '`managers` is a list of names, and `jobId` and `managerMessage` are text.',
      ...(deps.signal ? { signal: deps.signal } : {}),
    },
    deps,
  );
  return res.args;
}

async function applyDecision(
  input: AccessRequestInput,
  asked: Target,
  requestKey: string,
  view: TechnicianView,
  managers: Technician[],
  d: RouteDecision,
  deps: AccessDoorDeps,
): Promise<AccessDeskAnswer> {
  let reply = d.replyToAsker.trim();
  const findRequest = deps.findRequest ?? findOpenAccessRequest;
  const waiting = await findRequest(input.tenantId, requestKey);
  const now = (deps.now ?? (() => new Date()))();
  const live = !!waiting && !hasLapsed(waiting, now);
  // FACT GUARDS, like honest(): "already open" and "already asked" are both
  // checkable, and a wrong one would lose the request on a factual slip rather
  // than a judgment. Their words go too — "it is already open to you" / "it is
  // with your manager" is false the moment a manager is actually asked.
  if (
    (d.outcome === 'already_open' && !alreadyOpen(asked, input.wants, view)) ||
    (d.outcome === 'already_asked' && !live)
  ) {
    d = { ...d, outcome: 'ask' };
    reply = askedReply(managers);
  }
  if (d.outcome !== 'ask') {
    const status: AccessDeskStatus = d.outcome === 'refuse' ? 'refused' : d.outcome;
    logReason(input, d);
    await recordPair(input, asked, reply, deps);
    return { status, answer: reply };
  }

  // WHAT TO ASK FOR: the office's job only if it really is one of the asked
  // customer's jobs on this firm — otherwise what she asked for, unchanged.
  let target = asked;
  if (!asked.jobId && typeof d.jobId === 'string' && UUID_SHAPE.test(d.jobId)) {
    const job = await (deps.getJob ?? getJob)(d.jobId);
    if (job && job.tenant_id === input.tenantId && job.customer_id === asked.customerId) {
      target = { ...asked, jobId: job.id, jobTitle: job.title };
    }
  }

  // WHO: the office's names, resolved against who can actually be texted. None
  // valid → every reachable manager (a lost request costs more than a text).
  const wanted = new Set((d.managers ?? []).map((n) => String(n).trim().toLowerCase()));
  const chosen = managers.filter((m) => wanted.has(m.display_name.trim().toLowerCase()));
  const toText = chosen.length > 0 ? chosen : managers;

  const body = managerBody(input, target, d.managerMessage);
  logReason(input, d);

  if (deps.signal?.aborted) return STOPPED; // the last check before anything leaves
  if (waiting && live) {
    // STILL WAITING: no second row. Text only managers it has not been put to.
    const wctx = contextOf(waiting);
    const already = new Set((wctx.managersTexted ?? []).map((n) => n.toLowerCase()));
    const fresh = toText.filter((m) => !already.has(m.display_name.toLowerCase()));
    if (fresh.length === 0) {
      await recordPair(input, asked, reply, deps);
      return { status: 'already_asked', answer: reply };
    }
    // CLAIM, THEN TEXT: two repeats racing on one waiting row must not both text
    // the same manager. The loser of the compare-and-set sends nothing.
    const claimed = await (deps.addManagers ?? addManagersTexted)(
      input.tenantId,
      waiting,
      fresh.map((m) => m.display_name),
    );
    if (!claimed) {
      const answer = 'That one is already with your manager — I have not sent it again.';
      await recordPair(input, asked, answer, deps);
      return { status: 'already_asked', answer };
    }
    // THE WAITING ROW'S TARGET, not this repeat's: a manager's yes grants what
    // the row says, so the text must describe exactly that (review, phase 3).
    const waitingBody =
      `${input.askerName} asks to open ${wctx.targetName ?? 'what they asked for'} — they say: ` +
      `"${wctx.why ?? input.why}".` +
      (d.managerMessage?.trim() ? ` ${d.managerMessage.trim()}` : '') +
      ` ${replyMenu(wctx.wants ?? input.wants)}`;
    await textManagers(input.tenantId, fresh, waitingBody, deps);
    await recordPair(input, asked, reply, deps);
    return { status: 'asked_manager', answer: honest(reply, fresh) };
  }
  if (waiting) {
    // A DAY OLD AND UNANSWERED IS GONE — move it, or the index refuses her forever.
    try {
      await (deps.lapseRequest ?? lapseAccessRequest)(input.tenantId, waiting.id);
    } catch (err) {
      console.error(`[office] tenant ${input.tenantId}: could not lapse request ${waiting.id}`, err);
    }
  }
  const filed = await fileRequest(input, target, requestKey, toText, deps);
  if (!filed) {
    // Filed by somebody else between the check and the write: converge.
    return { status: 'already_asked', answer: 'That one is already with your manager — I have not sent it again.' };
  }
  await textManagers(input.tenantId, toText, body, deps);
  await recordPair(input, asked, reply, deps);
  return { status: 'asked_manager', answer: honest(reply, toText) };
}

/** Whether the view already answers the ask — the fallback's own tests, as one. */
function alreadyOpen(t: Target, wants: AccessWants, view: TechnicianView): boolean {
  if (wants === 'notes') return false; // the view never answers "every note"
  // A customer-wide RECORD ask is never answered by the view: one granted job puts
  // the customer in it while their other jobs stay shut (routeByCode's rule too).
  if (wants === 'record') return t.jobId ? viewHasJob(view, t.jobId) : false;
  const canOpen = t.jobId ? viewHasJob(view, t.jobId) : viewHasCustomer(view, t.customerId);
  return canOpen && viewShowsMoney(view, { jobId: t.jobId, customerId: t.customerId });
}

/** Code's own "I asked" sentence — the fallback's words, for when the office's are
 *  wrong. */
function askedReply(managers: Technician[]): string {
  const names = managers.map((m) => m.display_name);
  return names.length > 0
    ? `Asked your manager by text (${listNames(names)}). If they open it you'll get a message ` +
        "here; if you hear nothing, ask me about this job again and I'll tell you where it got to."
    : honest('', []);
}

// A FACT GUARD, not a wording rule: with nobody reachable, the office's reply
// cannot say a manager was asked, so code says what is true.
function honest(reply: string, texted: Technician[]): string {
  return texted.length > 0
    ? reply
    : 'No manager could be texted just now. Your request is on the office record, but nobody ' +
        'has been alerted — if it matters today, catch a manager yourself.';
}

function managerBody(input: AccessRequestInput, target: Target, officeWords?: string): string {
  const head = `${input.askerName} asks to open ${whatWords(target, input.wants)} — they say: "${input.why}".`;
  const mid = typeof officeWords === 'string' && officeWords.trim() ? ` ${officeWords.trim()}` : '';
  return `${head}${mid} ${replyMenu(input.wants)}`;
}

async function fileRequest(
  input: AccessRequestInput,
  target: Target,
  requestKey: string,
  toText: Technician[],
  deps: AccessDoorDeps,
): Promise<AccessRequest | null> {
  return (deps.openRequest ?? openAccessRequest)({
    tenantId: input.tenantId,
    technicianId: input.askerTechnicianId as string,
    context: {
      requestKey,
      technicianRef: input.askerRef,
      technicianName: input.askerName,
      ...(target.jobId ? { jobId: target.jobId } : {}),
      customerId: target.customerId,
      targetName: whatWords(target, input.wants),
      technicianWords: titleFreeWords(target, input.wants),
      wants: input.wants,
      why: input.why,
      managersTexted: toText.map((m) => m.display_name),
    },
  });
}

async function textManagers(
  tenantId: string,
  managers: Technician[],
  body: string,
  deps: AccessDoorDeps,
): Promise<void> {
  for (const m of managers) {
    try {
      await (deps.queuePush ?? queuePersonPush)({ tenantId, technicianId: m.id, kind: 'access', body });
    } catch (err) {
      // One manager's failed queue write must not lose the other's text, nor the
      // request, which is already filed.
      console.error(`[office] tenant ${tenantId}: could not queue the access text for ${m.ref}`, err);
    }
  }
}

// ── the fallback: today's code path, unchanged in what it does ───────────────

async function routeByCode(
  input: AccessRequestInput,
  asked: Target,
  requestKey: string,
  view: TechnicianView,
  managers: Technician[],
  deps: AccessDoorDeps,
): Promise<AccessDeskAnswer> {
  const { tenantId, wants } = input;
  let target = asked;
  // A CUSTOMER ASK BECOMES A JOB ASK when there is exactly one unfinished job on
  // that customer AND she cannot already open it (so a customer-wide ask for the
  // history is not dead-ended by a job she already has).
  if (!asked.jobId) {
    const live = await (deps.listOpenJobs ?? listOpenJobsForCustomer)(asked.customerId);
    if (live.length === 1) {
      const only = live[0];
      const alreadySatisfied =
        wants === 'record'
          ? viewHasJob(view, only.id)
          : wants === 'money'
            ? viewHasJob(view, only.id) && viewShowsMoney(view, { jobId: only.id })
            : false;
      if (!alreadySatisfied) target = { ...asked, jobId: only.id, jobTitle: only.title };
    }
  }
  // IS IT ALREADY OPEN? A notes ask is never short-circuited: the view answers
  // "may she open this job", not "may she read every note on it".
  if (target.jobId && wants === 'record' && viewHasJob(view, target.jobId)) {
    return {
      status: 'already_open',
      answer: `${jobWords(target)} is already open to you — ask me for it again and it will be there.`,
    };
  }
  // Money is only "already open" if the record is too.
  const canOpenTarget = target.jobId ? viewHasJob(view, target.jobId) : viewHasCustomer(view, target.customerId);
  if (wants === 'money' && canOpenTarget && viewShowsMoney(view, { jobId: target.jobId, customerId: target.customerId })) {
    return {
      status: 'already_open',
      answer:
        `You can already be told the figures on ${target.jobId ? jobWords(target) : `${target.customerName}'s work`} — ` +
        'ask again and they will be in the answer.',
    };
  }
  const waiting = await (deps.findRequest ?? findOpenAccessRequest)(tenantId, requestKey);
  const now = (deps.now ?? (() => new Date()))();
  if (waiting && !hasLapsed(waiting, now)) {
    const tz = await firmTz(tenantId, deps);
    return {
      status: 'already_asked',
      answer:
        `You asked for that on ${servedDayPhrase(localDateISO(waiting.noticed_at, tz))} and it is ` +
        'still with your manager. I have not sent it again.',
    };
  }
  if (deps.signal?.aborted) return STOPPED; // before the first write, the lapse included
  if (waiting) {
    try {
      await (deps.lapseRequest ?? lapseAccessRequest)(tenantId, waiting.id);
    } catch (err) {
      console.error(`[office] tenant ${tenantId}: could not lapse request ${waiting.id}`, err);
    }
  }
  const filed = await fileRequest(input, target, requestKey, managers, deps);
  if (!filed) {
    return { status: 'already_asked', answer: 'That one is already with your manager — I have not sent it again.' };
  }
  await textManagers(tenantId, managers, managerBody(input, target), deps);
  const answer = askedReply(managers);
  await recordPair(input, asked, answer, deps);
  return { status: 'asked_manager', answer };
}

// THE OFFICE'S REASON GOES TO THE LOG, and nowhere in the record (final review).
// Not the answer row — asker_history shows that to her, and the reason is the
// office's private judgment. Not the ask row either — v_office_messages exposes
// ask rows to spine_read, which would make the office's own guess citable as if
// she had said it (the rule migration 20260916130000 exists for).
function logReason(input: AccessRequestInput, d: RouteDecision): void {
  if (typeof d.reason === 'string' && d.reason.trim()) {
    console.info(`[office] tenant ${input.tenantId}: access ${d.outcome} for ${input.askerRef} — ${d.reason.trim()}`);
  }
}

// ── the transcript pair the review reads ─────────────────────────────────────

// The ask in the technician's words and the outcome born READ. Best-effort: by
// now the managers are texted, and a failed transcript write must not undo that.
// TITLE-FREE (see titleFreeWords): asker_history shows these rows to her.
async function recordPair(
  input: AccessRequestInput,
  asked: Target,
  outcome: string,
  deps: AccessDoorDeps,
): Promise<void> {
  const createMessage = deps.createMessage ?? createOfficeMessage;
  try {
    const ask = await createMessage({
      tenantId: input.tenantId,
      direction: 'to_planner',
      kind: 'ask',
      fromRef: input.askerRef,
      toRef: TEAM_LEAD_REF,
      tier: input.askerTier,
      body: `${ACCESS_ASK_PREFIX}${titleFreeWords(asked, input.wants)}: "${input.why}"`,
    });
    await createMessage({
      tenantId: input.tenantId,
      direction: 'to_planner',
      kind: 'desk',
      fromRef: TEAM_LEAD_REF,
      toRef: input.askerRef,
      body: outcome,
      inReplyTo: ask.id,
      status: 'read',
    });
    try {
      await (deps.markRead ?? markOfficeMessagesRead)(input.tenantId, [ask.id], new Date().toISOString());
    } catch (err) {
      console.error(`[office] tenant ${input.tenantId}: marking the access ask read failed`, err);
    }
  } catch (err) {
    console.error(`[office] tenant ${input.tenantId}: the access transcript was not recorded`, err);
  }
}

async function firmTz(tenantId: string, deps: AccessDoorDeps): Promise<string> {
  try {
    return (await (deps.firmTenant ?? getTenant)(tenantId))?.timezone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}
