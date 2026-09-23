import type { ForcedToolSpec } from '../model/forcedTool.js';
import { runToolLoop } from '../model/toolLoop.js';
import {
  getCustomer,
  getTechnicianView,
  listJobsForCustomer,
  listNudgesByStatus,
  listOfficeMessagesForRef,
  listRecentAccessRequestsFor,
  OPEN_NUDGE_STATUSES,
  searchCustomers,
  viewHasJob,
  type Nudge,
  type TechnicianView,
  contextOf,
} from '../db/index.js';
import { renderMemoryIndex } from './memory.js';
import { TEAM_LEAD_REF } from './identity.js';
import { PLANNER_MAX_TOKENS, PLANNER_REASONING } from './planner.js';
import { OFFICE_SYSTEM } from './officePrompt.js';

// THE OFFICE (plan 2026-09-22, "the office: one agent, three doors").
//
// One runner for the doors where a seat is WAITING — its question, and its
// access ask. (The third door, an inbound call, is the planner's focused pass
// running on OFFICE_SYSTEM; see runPlanner.) Both waiting doors are the same
// agent, the same prompt and the same model as the rest of the team lead; what
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
// SAYS is steered by OFFICE_SYSTEM — and the notes, which carry contents, stay
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
  searchCustomers?: typeof searchCustomers;
  getCustomer?: typeof getCustomer;
  listJobsForCustomer?: typeof listJobsForCustomer;
}

/**
 * NAME AND ID, nothing else — that is already what find_customer gives a
 * technician for a customer outside their view, so the catalog adds no exposure.
 * A name match only: searchCustomers also matches phone and street, and handing
 * those hits back would let an address be probed for ("is 12 Oak St a customer?").
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
  // searchCustomers blanks these before matching; do the same, or a name with
  // a comma in the query could never match its own row.
  const needle = query.replace(/[,()]/g, ' ').toLowerCase().trim();
  const rows = await (deps.searchCustomers ?? searchCustomers)(tenantId, query);
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

/** How the access door's transcript ask row begins (accessDesk.ts recordPair,
 *  and the office's own access door after it). */
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
    const ending =
      r.status === 'dismissed' ? `ended: ${r.dismiss_reason ?? 'settled'}` : 'still waiting on a manager';
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
  /** The door's terminal tool — calling it IS the outcome. */
  terminal: ForcedToolSpec;
  /** The team lead's schemas (handed in by the MCP server — no import cycle). */
  schemas: ReadonlyArray<ForcedToolSpec>;
  dispatch?: OfficeDispatch;
  /** Cost lane label, per door. */
  lane: string;
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
  let view: TechnicianView | null = null;
  const viewOf = async (): Promise<TechnicianView> => {
    if (!view) {
      const id = facing.kind === 'technician' ? facing.technicianId : null;
      view = await (deps.technicianView ?? getTechnicianView)(tenantId, id);
    }
    return view;
  };

  const tools = [...officeToolsFor(facing, input.schemas), terminal];
  const handed = new Set(tools.map((t) => t.name));
  let captured: Record<string, unknown> | null = null;

  const user = [
    ...(index ? ["THE OFFICE'S OWN NOTES — the index:", index, ''] : []),
    input.userMessage,
  ].join('\n');

  const result = await runLoop(
    {
      system: OFFICE_SYSTEM,
      user,
      maxTokens: OFFICE_MAX_TOKENS,
      label: 'office',
      reasoningEffort: OFFICE_REASONING,
      budgetMs: OFFICE_WAITING_BUDGET_MS,
      maxTurns: null,
      terminalTool: terminal.name,
    },
    tools,
    async (name, args) => {
      // The loop refuses unknown names itself; this is the belt behind it.
      if (!handed.has(name)) throw new Error(`'${name}' is not a tool this door was given`);
      if (name === terminal.name) {
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
