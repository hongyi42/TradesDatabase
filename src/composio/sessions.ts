import { updateTechnician, type Technician, type TechnicianTier } from '../db/index.js';
import { compositeUserId, getComposioClient, type PairingClient } from './pairing.js';

// Per-person Composio sessions (Tool Router GA) — the tier boundary. A session's
// tool restrictions are EXECUTION-enforced by Composio (live-verified 2026-07-04:
// HTTP 400, code 4310 / slug ToolRouterV2_ToolNotInEnabledList — the docs say
// 403; match on code/slug, never HTTP status). See docs/nemoclaw-tech-agent.md §7.
//
// HARD RULE: sessions are ALWAYS created with an explicit per-tier config — a
// bare session defaults to the ENTIRE catalog with manageConnections enabled.
// No code path may call client.sessions.create except through this module;
// sessions.test.ts pins the config for both tiers.

// The technician starter tool list (product-configurable; user decision
// 2026-07-04). GMAIL_SEND_EMAIL is NEVER here — technician send goes through
// the spine's two-step send_email tool. GMAIL_REPLY_TO_THREAD is also a send
// (it dispatches immediately) and is likewise excluded. Slugs live-verified in
// Phase 5 (the May-2026 catalog consolidation renamed tools; a stale slug
// silently enables nothing).
export const TECHNICIAN_GMAIL_TOOLS = [
  'GMAIL_FETCH_EMAILS',
  'GMAIL_CREATE_EMAIL_DRAFT',
  'GMAIL_GET_PROFILE',
];

// The explicit per-tier session configs — the ONLY place they are defined.
// manager: entire catalog (intentionally NO toolkit/tool restriction) +
// self-serve connector pairing; safety is disclosure + context-engineered
// confirmation in the agent manifest (user decision, accepted risk).
// technician: fixed direct-tools list, no discovery meta-tools, no
// connection management, send structurally impossible (4310).
export function sessionConfigForTier(tier: TechnicianTier): Record<string, unknown> {
  if (tier === 'manager') {
    return { manageConnections: true, mcp: true };
  }
  return {
    sessionPreset: 'direct_tools',
    toolkits: ['gmail'],
    tools: { gmail: TECHNICIAN_GMAIL_TOOLS },
    manageConnections: false,
    mcp: true,
  };
}

export interface SessionDeps {
  client?: PairingClient;
  update?: typeof updateTechnician;
}

export type EnsureSessionResult =
  | { status: 'created'; sessionId: string }
  | { status: 'exists'; sessionId: string }
  | { status: 'skipped'; reason: string };

// Idempotent per-person provisioning — the lifecycle sweep's unit of work.
// Only ACTIVE rows get sessions; the id is persisted on the roster row and
// kept after offboarding (audit), like ca_*/ti_*.
export async function ensurePersonSession(
  tech: Technician,
  deps: SessionDeps = {},
): Promise<EnsureSessionResult> {
  if (tech.state !== 'active') {
    return { status: 'skipped', reason: `state is ${tech.state}` };
  }
  if (tech.composio_session_id) {
    return { status: 'exists', sessionId: tech.composio_session_id };
  }
  const client = deps.client ?? getComposioClient();
  const update = deps.update ?? updateTechnician;
  const created = await client.sessions.create(
    compositeUserId(tech),
    sessionConfigForTier(tech.tier),
  );
  const sessionId = pickString(created, 'id', 'sessionId', 'session_id');
  if (!sessionId) throw new Error('Composio returned no session id');
  try {
    await update(tech.id, { composio_session_id: sessionId });
  } catch (err) {
    // Compensating delete: a live session whose id never landed on the roster
    // is unreachable by every teardown path — the next sweep would mint
    // another (review finding: unbounded orphan sessions on a persistent DB
    // failure). Best-effort; if this also fails the orphan is at least logged.
    try {
      await client.sessions.delete(sessionId);
    } catch {
      console.error(`[sessions] orphaned Composio session ${sessionId} for ${tech.ref} — delete it manually`);
    }
    throw err;
  }
  return { status: 'created', sessionId };
}

// Tear a person's session down and clear the roster column — deactivation and
// tier-change hygiene. The column is NULLED on success (unlike ca_*/ti_*): a
// null column is what lets the sweep re-mint with the CURRENT tier config on
// reactivation, and what marks "nothing leaked" for the expiry retry pass
// (review finding: a deactivated manager's session otherwise stays fully live
// through the grace period — manageConnections can mint NEW accounts, so the
// disabled-account 4302 backstop does not cover it).
export async function teardownPersonSession(
  tech: Technician,
  deps: SessionDeps = {},
): Promise<{ status: 'deleted' | 'none' }> {
  if (!tech.composio_session_id) return { status: 'none' };
  const client = deps.client ?? getComposioClient();
  const update = deps.update ?? updateTechnician;
  try {
    await client.sessions.delete(tech.composio_session_id);
  } catch (err) {
    if ((err as { status?: number })?.status !== 404) throw err; // already gone = success
  }
  await update(tech.id, { composio_session_id: null });
  return { status: 'deleted' };
}

// The session's MCP endpoint for gateway registration. SENSITIVE — grants the
// person's whole session; print/inject via the control plane only, never log
// or store it (custody rule, docs §7).
export async function getSessionMcpUrl(
  tech: Technician,
  deps: SessionDeps = {},
): Promise<string> {
  if (!tech.composio_session_id) {
    throw new Error(`'${tech.ref}' has no session — run the lifecycle sweep first`);
  }
  const client = deps.client ?? getComposioClient();
  const used = await client.sessions.use(tech.composio_session_id, { mcp: true });
  const mcp = used.mcp as Record<string, unknown> | undefined;
  const url = pickString(mcp ?? {}, 'url') ?? pickString(used, 'mcpUrl', 'mcp_url');
  if (!url) throw new Error('Composio returned no mcp.url for the session');
  return url;
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}
