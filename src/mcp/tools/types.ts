// The contract between the hub (src/mcp/server.ts) and each domain's tool
// module. Split out 2026-09-12: every feature used to add a tool by editing the
// one tool table AND the one dispatch switch in server.ts, which is what made
// two features touching different domains collide on the same symbol and forced
// every parallel-work verdict to "stack" (research 2026-09-09
// code-graph-as-source-of-truth §6.1 fix 3). Now a domain owns its own file and
// the hub only aggregates.
//
// WHAT DELIBERATELY DID NOT MOVE: the six tier gates. They live in the hub,
// applied by tool NAME before any handler runs, because deny-by-default only
// holds if adding a tool cannot forget its guard. A domain module declares WHICH
// tier a tool belongs to (`base` / `admin` / `teamLead`); it never decides
// whether the caller has passed one.
import type { Technician } from '../../db/technicians.js';
import type { RequestIdentity } from '../identity.js';
import type { ServerDeps } from '../server.js';

/** A tool definition exactly as `tools/list` returns it. */
export interface ToolDef {
  name: string;
  description: string;
  // Permissive on purpose: these literals are not `as const`, so `type: 'object'`
  // widens to `string` exactly as it did when the tables lived in the hub — which
  // is why TEAM_LEAD_TOOL_SCHEMAS has always cast to JsonSchemaObject. Declaring
  // the narrow type here would reject every existing definition.
  inputSchema: Record<string, unknown>;
}

/**
 * Everything the hub has already established by the time a handler runs: the
 * request, its identity, and the three facts the gates computed on the way in.
 * A handler reads this and nothing else from the hub.
 */
export interface ToolContext {
  /** The tool being called — handlers registered under two names read it. */
  name: string;
  args: Record<string, unknown>;
  deps: ServerDeps;
  identity: RequestIdentity;
  tenantId: string;
  /** `args[k]` when it is a string, else undefined. */
  str: (k: string) => string | undefined;
  /** A list of roster refs; absent = unsaid, malformed = thrown (rung 9c). */
  strArray: (k: string) => string[] | undefined;
  /** The caller's roster row — null when the badge has none. */
  caller: Technician | null;
  activeManager: boolean;
  /** Drops manager-only L1 rows for non-manager badges. */
  dropSensitive: <T extends { sensitivity: string | null }>(rows: T[]) => T[];
}

export type ToolHandler = (ctx: ToolContext) => Promise<unknown>;

/**
 * One domain's contribution to the server: its tools, tagged by the tier that
 * may see and call them, and the handler for each.
 *
 * The tier arrays are what the hub concatenates into TOOLS / ADMIN_TOOLS /
 * TEAM_LEAD_TOOLS, from which every gate and catalog is still derived — so a
 * tool listed under `admin` is gated by ADMIN_TOOL_NAMES the day it is added,
 * exactly as when the arrays were hand-written.
 */
export interface DomainTools {
  /** For error messages and the aggregation test. */
  domain: string;
  /** Visible to every badge (the old `TOOLS`). */
  base?: readonly ToolDef[];
  /** Manager-tier only (the old `ADMIN_TOOLS`). */
  admin?: readonly ToolDef[];
  /** The planner's own surface (the old `TEAM_LEAD_TOOLS`). */
  teamLead?: readonly ToolDef[];
  /** name → handler. Two names may share one handler. */
  handlers: Readonly<Record<string, ToolHandler>>;
}
