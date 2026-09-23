import { signedHeaders } from './identity.js';
import { TECHNICIAN_DOCTRINE } from './doctrine.js';
import type { TurnPolicy } from './turnPolicy.js';

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
  secret: string;
  tenantId: string;
  technicianRef: string;
}

// The types do not say whether a permission request's serverName is the key in
// mcpServers ('spine') or the server's self-reported name ('trades-spine',
// src/mcp/server.ts). Both are accepted; the first live call logs which it is.
export const SPINE_NAMES = new Set(['spine', 'trades-spine']);
let loggedServerName = false;

export async function startEngine(opts: { baseDirectory: string; tz: string }): Promise<EngineClient> {
  const sdk = (await import(SDK_SPECIFIER)) as SdkModule;
  const client = new sdk.CopilotClient({
    mode: 'empty',
    baseDirectory: opts.baseDirectory,
    // An explicit allowlist, never process.env: the glue's env holds the bot
    // token, the identity secret and the OpenRouter key, and none of them may
    // reach the engine process. The key travels only in provider.apiKey.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TZ: opts.tz },
    logLevel: 'warning',
  });
  await client.start();
  return client;
}

export function sessionConfig(cfg: EngineConfig, policy: TurnPolicy): Record<string, unknown> {
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
    // Spine results are capped at 20k chars; a spill file is unreadable anyway
    // (no file tool in mode "empty").
    largeOutput: { enabled: false },
    // NOT reasoningSummary:'none' — measured 2026-09-22 through OpenRouter +
    // @preset/trades-seats, Gemini 3.8 Flash writes its thought summaries
    // ("**Title** I am …") as message text before every tool call regardless.
    // The only defence is seat.ts holding back text from any model call that
    // ends in a tool request. Do not remove that hold on the strength of a setting.
    systemMessage: { mode: 'replace', content: TECHNICIAN_DOCTRINE },
    availableTools: ['mcp:*'],
    toolSearch: { enabled: false },
    mcpServers: {
      spine: {
        type: 'http',
        url: cfg.spineUrl,
        tools: ['*'],
        // ask_team_lead becomes the whole office, with up to 240 s to answer
        // (desk→office merge). The SDK's own default is 60 s — at that the seat
        // would give up while the office keeps working and its answer is lost.
        timeout: 300_000,
        headers: { ...signedHeaders(cfg.secret, cfg.tenantId, cfg.technicianRef) },
      },
    },
    onPermissionRequest: (r: PermissionRequestLike) => {
      if (r.kind === 'mcp' && !loggedServerName) {
        loggedServerName = true;
        console.log(`seat-glue: first MCP permission request — serverName=${JSON.stringify(r.serverName)}`);
      }
      if (r.kind === 'mcp' && r.serverName && SPINE_NAMES.has(r.serverName)) {
        // Pending from HERE, before the call goes out (turnPolicy rule 2).
        policy.onToolPending(r.toolCallId, r.toolName);
        return { kind: 'approve-once' };
      }
      console.error(`seat-glue: refused a ${r.kind} permission request (${r.serverName ?? r.toolName ?? '?'})`);
      return { kind: 'reject' };
    },
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
): Promise<EngineSession> {
  const config = sessionConfig(cfg, policy);
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
