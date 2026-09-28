import { seatHeaders } from './identity.js';
import { MANAGER_DOCTRINE, TECHNICIAN_DOCTRINE } from './doctrine.js';
import type { TurnPolicy } from './turnPolicy.js';
import { FILE_TOOL_NAMES, type FileTool } from './fileTools.js';

// The ONLY file that loads @github/copilot-sdk (1.0.14). The SDK is not a
// dependency of this repo — Render installs the root package.json on every
// build and would download the engine binary for nothing — so it is loaded
// through a NON-LITERAL specifier (TypeScript does not try to resolve it) from
// the box package's node_modules (Box_Setup_Stuff/seat-glue/package.json), and
// typed with the small local interfaces below, checked by hand against the
// 1.0.14 .d.ts files (types.d.ts, session.d.ts, client.d.ts).
const SDK_SPECIFIER: string = '@github/copilot-sdk';

export type EngineEvent = { type: string; data?: unknown };

export interface BlobAttachment {
  type: 'blob';
  data: string;
  mimeType: string;
  displayName?: string;
}

export interface EngineSession {
  readonly sessionId: string;
  /**
   * The session's RPC surface — only the mode switch the manager seat uses
   * (1.0.14 generated/rpc.d.ts:24776-24791, @experimental). OPTIONAL so a fake
   * session without it still type-checks; the glue treats its absence as
   * "cannot switch", never as an error.
   */
  readonly rpc?: { mode: { set(p: { mode: 'plan' | 'interactive' }): Promise<unknown>; get(): Promise<string> } };
  send(options: { prompt: string; mode?: 'enqueue' | 'immediate'; attachments?: BlobAttachment[] }): Promise<string>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
  on(handler: (event: EngineEvent) => void): () => void;
}

interface PermissionRequestLike {
  kind: string;
  serverName?: string;
  toolName?: string;
  toolCallId?: string;
}

/** 1.0.14 types.d.ts:990-1022 (UserInputRequest / UserInputResponse). */
export interface UserInputRequestLike {
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
}
export interface UserInputResponseLike {
  answer: string;
  wasFreeform: boolean;
}
/** 1.0.14 types.d.ts:1023-1051 (ExitPlanModeRequest / ExitPlanModeResult). */
export interface ExitPlanRequestLike {
  summary: string;
  planContent?: string;
  actions: string[];
  recommendedAction: string;
}
export interface ExitPlanResultLike {
  approved: boolean;
  selectedAction?: string;
  feedback?: string;
}
/** What the Seat hands the engine for a manager: how to ask its person, and how to show a plan. */
export interface SeatHooks {
  onUserInput(req: UserInputRequestLike): Promise<UserInputResponseLike>;
  onExitPlan(req: ExitPlanRequestLike): Promise<ExitPlanResultLike>;
}

interface EngineClient {
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  ping(message?: string): Promise<unknown>;
  createSession(config: Record<string, unknown>): Promise<EngineSession>;
  resumeSession(sessionId: string, config: Record<string, unknown>): Promise<EngineSession>;
}

interface SdkModule {
  CopilotClient: new (options: Record<string, unknown>) => EngineClient;
}

export interface EngineConfig {
  seatRef: string;
  stateDir: string;
  tz: string;
  model: string;
  openrouterKey: string;
  spineUrl: string;
  seatToken: string;
  /** From /seat/whoami (step 2a): picks the rulebook, Composio and the two built-ins. */
  tier: 'manager' | 'technician';
  /** Step 2b: a manager's file tools (fileTools.ts). Absent = no sandbox. */
  tools?: FileTool[];
  /** Step 2b: the skill folders, loaded for a manager who has file tools (a skill's scripts run there). */
  skillsDir?: string;
  /** The skills in skillsDir (name + description from each SKILL.md), listed in the rulebook. */
  skills?: Array<{ name: string; description: string }>;
}

/**
 * The rulebook REPLACES the engine's system prompt, and with it the engine's own
 * list of skills — measured 2026-09-28: the skill was loaded and enabled
 * (session.rpc.skills.list) yet the model never used it. So the glue lists them.
 */
export function skillsSection(skills: Array<{ name: string; description: string }>): string {
  if (!skills.length) return '';
  return [
    '## Skills',
    '',
    'Before a task one of these covers, load it with the `skill` tool and follow it:',
    ...skills.map((k) => `- ${k.name}: ${k.description}`),
  ].join('\n');
}

// The tool servers a seat may call. serverName is the mcpServers KEY (measured
// live, step 1: 'spine'); 'trades-spine' (the server's self-reported name) stays
// accepted. 'composio' is the manager seat's second server (step 2a): the Render
// /composio relay, same seat token. Every call to any of them is pending from
// the permission handler (turnPolicy rule 2), so a Composio call is never
// aborted mid-flight either.
export const SPINE_NAMES = new Set(['spine', 'trades-spine']);
/** SPINE_NAMES are the spine alone (step 3's transcript records only its calls). */
export const TOOL_SERVERS = new Set([...SPINE_NAMES, 'composio']);
// Built-in tools a manager seat allows (availableTools). Whether the engine asks
// permission for them at all is UNMEASURED (plan 2a review): if it does, approve
// them by name here rather than let the default reject hide the buttons.
export const MANAGER_BUILTINS = new Set(['ask_user', 'exit_plan_mode', 'skill']);
let loggedServerName = false;
let loggedNonMcpKind = false;
let loggedCustomCallId = false;

export async function startEngine(opts: { baseDirectory: string; tz: string }): Promise<EngineClient> {
  const sdk = (await import(SDK_SPECIFIER)) as SdkModule;
  const client = new sdk.CopilotClient({
    mode: 'empty',
    baseDirectory: opts.baseDirectory,
    // An explicit allowlist, never process.env: the glue's env holds the bot
    // token, the seat token and the OpenRouter key, and none of them may reach
    // the engine process (the seat token travels only as the MCP header). The key travels only in provider.apiKey.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TZ: opts.tz },
    logLevel: 'warning',
  });
  await client.start();
  return client;
}

export function sessionConfig(cfg: EngineConfig, policy: TurnPolicy, hooks?: SeatHooks): Record<string, unknown> {
  const manager = cfg.tier === 'manager';
  // File tools are a manager's only (step 2b); a technician config never carries them.
  const fileTools = manager ? (cfg.tools ?? []) : [];
  const spine = {
    type: 'http',
    url: cfg.spineUrl,
    tools: ['*'],
    // ask_team_lead becomes the whole office, with up to 240 s to answer
    // (desk→office merge). The SDK's own default is 60 s — at that the seat
    // would give up while the office keeps working and its answer is lost.
    timeout: 300_000,
    headers: { ...seatHeaders(cfg.seatToken) },
  };
  return {
    model: cfg.model,
    provider: {
      type: 'openai',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: cfg.openrouterKey,
      // Step 0: completions lost Gemini's reasoning details after a tool call
      // (400 on ~1 in 10 tool turns); responses gave 0 of 38.
      wireApi: 'responses',
      // A compaction trigger: the engine does not know "@preset/…" and may guess
      // its window, as it guessed vision:false.
      maxPromptTokens: 100_000,
    },
    modelCapabilities: {
      supports: { vision: true },
      limits: { vision: { supported_media_types: ['image/jpeg', 'image/png'] } },
    },
    // Spine results are capped at 20k chars. The engine would spill a large one
    // to a file on the BOX, which no tool can read: a manager's file tools act
    // on the sandbox (step 2b), and export_query is how full results reach it.
    largeOutput: { enabled: false },
    // NOT reasoningSummary:'none' — measured 2026-09-22 through OpenRouter +
    // @preset/trades-seats, Gemini 3.8 Flash writes its thought summaries
    // ("**Title** I am …") as message text before every tool call regardless.
    // The only defence is seat.ts holding back text from any model call that
    // ends in a tool request. Do not remove that hold on the strength of a setting.
    systemMessage: {
      mode: 'replace',
      content: manager
        ? [MANAGER_DOCTRINE, fileTools.length && cfg.skillsDir ? skillsSection(cfg.skills ?? []) : ''].filter(Boolean).join('\n\n')
        : TECHNICIAN_DOCTRINE,
    },
    // All tools loaded, tool search OFF (measured 2026-09-23: a wash at ~49 tools).
    availableTools: manager
      ? ['mcp:*', 'builtin:ask_user', 'builtin:exit_plan_mode', ...(fileTools.length ? ['custom:*', 'builtin:skill'] : [])]
      : ['mcp:*'],
    ...(fileTools.length ? { tools: fileTools } : {}),
    // Skills (step 2b): our own folders only — mode "empty" already leaves out
    // every runtime-bundled skill. A manager without file tools gets none: a
    // skill's scripts run on the sandbox.
    ...(fileTools.length && cfg.skillsDir ? { enableSkills: true, skillDirectories: [cfg.skillsDir] } : {}),
    toolSearch: { enabled: false },
    mcpServers: manager
      ? {
          spine,
          // The Render /composio relay (src/composio/relayHandler.ts) accepts the
          // seat token and pins the person's own Composio session.
          composio: { ...spine, url: new URL('/composio', cfg.spineUrl).toString() },
        }
      : { spine },
    onPermissionRequest: (r: PermissionRequestLike) => {
      if (r.kind === 'mcp' && !loggedServerName) {
        loggedServerName = true;
        console.log(`seat-glue: first MCP permission request — serverName=${JSON.stringify(r.serverName)}`);
      }
      if (r.kind === 'mcp' && r.serverName && TOOL_SERVERS.has(r.serverName)) {
        // Pending from HERE, before the call goes out (turnPolicy rule 2).
        policy.onToolPending(r.toolCallId, r.toolName);
        return { kind: 'approve-once' };
      }
      // Step 2b: our own file tools. Pending from HERE too, so a Stop waits for
      // them (run_command alone is abort-safe: its handler kills the process).
      if (r.kind === 'custom-tool' && fileTools.length && r.toolName && FILE_TOOL_NAMES.has(r.toolName)) {
        if (!loggedCustomCallId) {
          loggedCustomCallId = true;
          console.log(`seat-glue: first custom-tool permission request — toolCallId=${JSON.stringify(r.toolCallId)}`);
        }
        policy.onToolPending(r.toolCallId, r.toolName);
        return { kind: 'approve-once' };
      }
      if (r.kind !== 'mcp' && !loggedNonMcpKind) {
        loggedNonMcpKind = true;
        console.log(`seat-glue: first non-MCP permission request — kind=${r.kind} tool=${JSON.stringify(r.toolName)}`);
      }
      if (manager && r.kind !== 'mcp' && r.toolName && MANAGER_BUILTINS.has(r.toolName)) return { kind: 'approve-once' };
      console.error(`seat-glue: refused a ${r.kind} permission request (${r.serverName ?? r.toolName ?? '?'})`);
      return { kind: 'reject' };
    },
    ...(manager && hooks
      ? {
          onUserInputRequest: (req: UserInputRequestLike) => hooks.onUserInput(req),
          onExitPlanModeRequest: (req: ExitPlanRequestLike) => hooks.onExitPlan(req),
        }
      : {}),
  };
}

/**
 * Resume the seat's conversation when one is on record; start one otherwise.
 * Resume re-supplies the whole config (the SDK does not persist it). A resume
 * that fails starts a fresh conversation rather than leaving the seat dead.
 */
export async function openSession(
  client: EngineClient,
  cfg: EngineConfig,
  policy: TurnPolicy,
  sessionId: string | null,
  hooks?: SeatHooks,
): Promise<EngineSession> {
  const config = sessionConfig(cfg, policy, hooks);
  if (sessionId) {
    try {
      return await client.resumeSession(sessionId, config);
    } catch (err) {
      console.error(
        `seat-glue: could not resume ${sessionId} (${err instanceof Error ? err.message : String(err)}) — starting fresh`,
      );
    }
  }
  return client.createSession({ ...config, sessionId: `${cfg.seatRef}-${Date.now()}` });
}

export type { EngineClient };
