import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import {
  getJob,
  getCustomer,
  getOpenReviewItem,
  searchCustomers,
  getCustomerContext,
  getTechnician,
  insertTechnician,
  isInactiveState,
  isSeatCapError,
  isUniqueViolation,
  listOpenReviewItems,
  listRawCapturesForJob,
  listRawCapturesForCustomer,
  listTeam,
  resolveReviewItem,
  setTechnicianState,
  upsertOpenReviewItem,
  type CaptureChannel,
  type TechnicianTier,
} from '../db/index.js';
import { recordFieldNote } from '../writePath/recordFieldNote.js';
import type { Extractor } from '../writePath/extract.js';
import {
  sonnetBriefer,
  sonnetAnswerer,
  type Briefer,
  type Answerer,
  type BriefFocus,
} from '../synthesis/index.js';
import { identityFromEnv, type RequestIdentity } from './identity.js';

// The single boundary the agent calls. The agent never holds the Supabase or
// Anthropic keys — this server (launched by the gateway with those secrets in
// env) is the only thing that touches the spine. The (tenant, technician)
// identity is supplied per request via deps.identity — env-pinned for stdio, the
// gateway's signed header for the central HTTP server — never from model args, so
// the agent cannot address another firm's data or claim another technician.
export interface ServerDeps {
  extract?: Extractor; // injectable so tests don't call the live model
  brief?: Briefer; // injectable briefing synthesizer (same reason)
  answer?: Answerer; // injectable Q&A synthesizer (same reason)
  identity?: RequestIdentity; // gateway-pinned tenant + technician for this request
}

const TECH_CHANNELS: CaptureChannel[] = ['technician_voice', 'technician_note', 'technician_photo'];
const BRIEF_FOCUSES: BriefFocus[] = ['next_visit', 'full_history'];
const TIERS: TechnicianTier[] = ['manager', 'technician'];

// The technician tool surface — what every badge sees (the doorman runbook's
// "7 tools" verification counts exactly these).
const TOOLS = [
  {
    name: 'record_field_note',
    description:
      'Record a technician field note into the spine (L1 → extract → identity match → L2/L3). ' +
      'Returns {status, captureId, ...}. If status is needs_confirmation or needs_disambiguation, ' +
      'ask the technician, then call again with the same captureId plus confirmed:{address} (or {customerId}).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note text (voice already transcribed to text).' },
        blobPath: { type: 'string', description: 'Optional object-store pointer for audio/photo.' },
        channel: { type: 'string', enum: TECH_CHANNELS, description: 'Defaults to technician_note.' },
        captureId: { type: 'string', description: 'Set only when resuming after a confirmation.' },
        confirmed: {
          type: 'object',
          properties: { customerId: { type: 'string' }, address: { type: 'string' } },
        },
      },
      required: [],
    },
  },
  {
    name: 'find_customer',
    description: 'Search customers by name, phone, or address.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'get_customer_context',
    description: "Brief on a customer: their jobs, recent visits, and recent raw captures.",
    inputSchema: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
  },
  {
    name: 'get_job',
    description: 'Fetch one job by id.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'list_recent_captures',
    description: 'List raw captures for a job (jobId) or a customer (customerId), newest first.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, customerId: { type: 'string' } },
    },
  },
  {
    name: 'brief_customer',
    description:
      'Generate a grounded, cited briefing on a customer from their record. focus=next_visit ' +
      '(pre-visit cheat-sheet, default) or full_history (the relationship over time). ' +
      'Returns {briefing, citations:[{claim, captureId}]}.',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        focus: { type: 'string', enum: ['next_visit', 'full_history'] },
      },
      required: ['customerId'],
    },
  },
  {
    name: 'answer_customer_question',
    description:
      'Answer a free-text question about a customer using only their record (says so if the ' +
      'record lacks the answer). Returns {answer, citations:[{claim, captureId}]}.',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        question: { type: 'string' },
      },
      required: ['customerId', 'question'],
    },
  },
];

// Seat-management tools — MANAGER-tier badges only. Listed only to managers and
// re-gated at dispatch (requireManager), so a technician badge structurally has
// no admin surface even if it guesses the tool names.
const ADMIN_TOOLS = [
  {
    name: 'add_technician_seat',
    description:
      'Add a person to the team roster (manager only). Mints their permanent ref from the ' +
      'display name (e.g. "Jane Doe" → jane-doe) and occupies one purchased seat of the tier. ' +
      'Fails if no seat is free or the ref is already taken (disambiguate with a middle name ' +
      'or employee id). Returns the roster row incl. the minted ref.',
    inputSchema: {
      type: 'object',
      properties: {
        displayName: { type: 'string', description: "The person's full name." },
        tier: { type: 'string', enum: TIERS, description: 'Defaults to technician.' },
      },
      required: ['displayName'],
    },
  },
  {
    name: 'deactivate_technician_seat',
    description:
      'Deactivate a team member (manager only). Two-step: first call returns ' +
      '{status:"needs_confirmation", confirmId} — confirm with the person, then call again ' +
      'with the same ref plus confirmId. Frees the seat immediately; history stays attributed.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The roster ref to deactivate.' },
        confirmId: { type: 'string', description: 'Set only on the confirming second call.' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'list_team',
    description:
      'List the team roster: ref, display name, tier, state, sandbox assignment (manager only).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_pending_reviews',
    description:
      'List open review items needing a decision (manager only): schedule-sheet name typos ' +
      '(with a did-you-mean suggestion), email from unrecognized team refs, pending confirmations.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'resolve_review',
    description:
      'Close a review item (manager only) as resolved (handled) or dismissed (not an issue).',
    inputSchema: {
      type: 'object',
      properties: {
        reviewItemId: { type: 'string' },
        resolution: { type: 'string', enum: ['resolved', 'dismissed'] },
        note: { type: 'string', description: 'Optional short note recorded on the item.' },
      },
      required: ['reviewItemId', 'resolution'],
    },
  },
];

// Mint a ref from a display name: lowercase, non-alphanumeric runs → '-'. The
// output alphabet is [a-z0-9-], so a minted ref can never collide with the
// reserved `connector:` namespace.
function slugify(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The names the dispatch gate keys on: EVERY tool in ADMIN_TOOLS is gated
// before the switch, so adding an admin tool cannot forget its guard.
const ADMIN_TOOL_NAMES = new Set(ADMIN_TOOLS.map((t) => t.name));

// Admin tools require an ACTIVE manager-tier roster row for the caller's badge
// identity. Tier lives in the technicians table (single source of truth), not
// in the badge — so revoking manager status is a DB update, no badge rotation.
// One predicate shared by the dispatch gate and the tools/list filter, so the
// two can never disagree about who counts as a manager.
async function isActiveManager(identity: RequestIdentity): Promise<boolean> {
  const caller = await getTechnician(identity.tenantId, identity.technicianRef);
  return !!caller && caller.tier === 'manager' && caller.state === 'active';
}

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  deps: ServerDeps,
): Promise<unknown> {
  const identity = deps.identity;
  if (!identity) throw new Error('identity is required');
  const { tenantId } = identity;
  const str = (k: string): string | undefined =>
    typeof args[k] === 'string' ? (args[k] as string) : undefined;

  // The real tier gate (the tools/list filter is cosmetic): applied by tool
  // NAME so no admin case can be added without it.
  if (ADMIN_TOOL_NAMES.has(name) && !(await isActiveManager(identity))) {
    throw new Error('admin tools require a manager badge');
  }

  switch (name) {
    case 'record_field_note': {
      const channelArg = str('channel');
      if (channelArg && !TECH_CHANNELS.includes(channelArg as CaptureChannel)) {
        throw new Error(`invalid channel: ${channelArg}`);
      }
      const channel: CaptureChannel = (channelArg as CaptureChannel | undefined) ?? 'technician_note';
      const confirmed = args.confirmed as { customerId?: string; address?: string } | undefined;
      // Tenant-guard the WRITE path too: a model-supplied confirmed.customerId wins
      // outright in matchIdentity, so without this a forged id would attach the
      // visit to another firm's customer/job. (The read-tool guards don't cover
      // writes; the address/phone/schedule match branches are already tenant-scoped.)
      if (confirmed?.customerId) {
        const customer = await getCustomer(confirmed.customerId);
        if (!customer || customer.tenant_id !== tenantId) {
          throw new Error('customer not found');
        }
      }
      return recordFieldNote(
        {
          tenantId,
          technicianRef: identity.technicianRef,
          text: str('text') ?? null,
          blobPath: str('blobPath') ?? null,
          channel,
          captureId: str('captureId'),
          confirmed,
        },
        { extract: deps.extract },
      );
    }
    case 'find_customer': {
      const query = str('query');
      if (!query) throw new Error('query is required');
      return searchCustomers(tenantId, query);
    }
    case 'get_customer_context': {
      const customerId = str('customerId');
      if (!customerId) throw new Error('customerId is required');
      const ctx = await getCustomerContext(customerId);
      // Tenant guard: a cross-tenant (or unknown) id reads as an empty record.
      if (!ctx.customer || ctx.customer.tenant_id !== tenantId) {
        return { customer: null, jobs: [], recentVisits: [], recentCaptures: [] };
      }
      return ctx;
    }
    case 'get_job': {
      const jobId = str('jobId');
      if (!jobId) throw new Error('jobId is required');
      const job = await getJob(jobId);
      // Tenant guard: a cross-tenant (or unknown) id reads as not found.
      return job && job.tenant_id === tenantId ? job : null;
    }
    case 'list_recent_captures': {
      const jobId = str('jobId');
      const customerId = str('customerId');
      // Tenant guard via the parent: captures inherit the job's/customer's tenant,
      // so verifying the parent gates the whole list (a mismatch reads as empty).
      if (jobId) {
        const job = await getJob(jobId);
        if (!job || job.tenant_id !== tenantId) return [];
        return listRawCapturesForJob(jobId);
      }
      if (customerId) {
        const customer = await getCustomer(customerId);
        if (!customer || customer.tenant_id !== tenantId) return [];
        return listRawCapturesForCustomer(customerId);
      }
      throw new Error('list_recent_captures requires jobId or customerId');
    }
    case 'brief_customer': {
      const customerId = str('customerId');
      if (!customerId) throw new Error('customerId is required');
      const focusArg = str('focus');
      // The SDK doesn't validate args against inputSchema, so check the enum here
      // (mirrors the channel guard on record_field_note).
      if (focusArg && !BRIEF_FOCUSES.includes(focusArg as BriefFocus)) {
        throw new Error(`invalid focus: ${focusArg}`);
      }
      const ctx = await getCustomerContext(customerId);
      // Guard a bad/cross-tenant id with a clean error before spending a model call.
      if (!ctx.customer || ctx.customer.tenant_id !== tenantId) {
        throw new Error('customer not found');
      }
      const focus = (focusArg as BriefFocus | undefined) ?? 'next_visit';
      return (deps.brief ?? sonnetBriefer)(ctx, focus);
    }
    case 'answer_customer_question': {
      const customerId = str('customerId');
      if (!customerId) throw new Error('customerId is required');
      const question = str('question');
      if (!question) throw new Error('question is required');
      const ctx = await getCustomerContext(customerId);
      if (!ctx.customer || ctx.customer.tenant_id !== tenantId) {
        throw new Error('customer not found');
      }
      return (deps.answer ?? sonnetAnswerer)(ctx, question);
    }
    case 'add_technician_seat': {
      const displayName = str('displayName')?.trim();
      if (!displayName) throw new Error('displayName is required');
      const tierArg = str('tier');
      if (tierArg && !TIERS.includes(tierArg as TechnicianTier)) {
        throw new Error(`invalid tier: ${tierArg}`);
      }
      const tier: TechnicianTier = (tierArg as TechnicianTier | undefined) ?? 'technician';
      const ref = slugify(displayName);
      // Slug alphabet is ASCII: a fully non-Latin name slugs to '' — ask for a
      // romanized form rather than failing with a false "no letters" claim.
      if (!ref) {
        throw new Error(
          'displayName must contain ASCII letters or digits — use a romanized spelling to mint the ref',
        );
      }
      try {
        return await insertTechnician({ tenantId, ref, displayName, tier });
      } catch (err) {
        // Cap first: at capacity the BEFORE-trigger fires before the unique
        // constraint, so a duplicate-at-cap reports the cap (observed live).
        if (isSeatCapError(err)) {
          throw new Error(`no free ${tier} seats — deactivate someone or purchase a seat`);
        }
        if (isUniqueViolation(err)) {
          throw new Error(
            `ref '${ref}' is taken — disambiguate (add a middle name or employee id)`,
          );
        }
        throw err;
      }
    }
    case 'deactivate_technician_seat': {
      const ref = str('ref');
      if (!ref) throw new Error('ref is required');
      if (ref === identity.technicianRef) throw new Error('cannot deactivate yourself');
      const target = await getTechnician(tenantId, ref);
      if (!target) throw new Error(`technician '${ref}' not found`);
      if (isInactiveState(target.state)) {
        // Idempotent + self-healing: a repeat/retried call also closes any
        // pending item left open by an earlier partial failure.
        const stale = await upsertOpenReviewItem({
          tenantId,
          kind: 'pending_deactivation',
          subjectRef: ref,
          detail: { requestedBy: identity.technicianRef },
        });
        await resolveReviewItem(stale.id, tenantId, 'resolved', 'already deactivated');
        return { status: 'already_deactivated', ref };
      }
      const confirmId = str('confirmId');
      if (!confirmId) {
        // Two-step confirm, persisted in review_items so any replica can serve
        // the confirming call (stateless server). Repeat calls return the same
        // confirmId via the one-open-item dedup.
        const item = await upsertOpenReviewItem({
          tenantId,
          kind: 'pending_deactivation',
          subjectRef: ref,
          detail: { requestedBy: identity.technicianRef },
        });
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          ref,
          displayName: target.display_name,
        };
      }
      // Validate the token with a point read whose guards all live in the WHERE
      // clause (id + tenant + open + kind + subject): a forged or mismatched id
      // matches nothing and nothing is resolved.
      const item = await getOpenReviewItem(confirmId, tenantId, {
        kind: 'pending_deactivation',
        subjectRef: ref,
      });
      if (!item) {
        throw new Error('confirmation not found — call again without confirmId to restart');
      }
      // State change FIRST, token cleanup second: if the state write fails the
      // token stays open and the confirm is retryable; the reverse order would
      // consume the token and record a "confirmed" deactivation that never ran.
      await setTechnicianState(target.id, 'offboarding');
      try {
        await resolveReviewItem(item.id, tenantId, 'resolved',
          `deactivation confirmed by ${identity.technicianRef}`);
      } catch {
        // Advisory once the state is changed — a retry (already_deactivated
        // branch) or the next deactivate call self-heals the open item.
      }
      return { status: 'deactivated', ref };
    }
    case 'list_team': {
      // Roster facts only — Composio account/trigger ids stay server-side.
      return (await listTeam(tenantId)).map((t) => ({
        ref: t.ref,
        displayName: t.display_name,
        tier: t.tier,
        state: t.state,
        sandboxRef: t.sandbox_ref,
      }));
    }
    case 'list_pending_reviews': {
      return listOpenReviewItems(tenantId);
    }
    case 'resolve_review': {
      const reviewItemId = str('reviewItemId');
      if (!reviewItemId) throw new Error('reviewItemId is required');
      const resolution = str('resolution');
      if (resolution !== 'resolved' && resolution !== 'dismissed') {
        throw new Error(`invalid resolution: ${resolution ?? '(missing)'}`);
      }
      // A pending_deactivation item is a live confirm token, not a review to
      // "handle": marking it resolved here would read as a completed
      // deactivation that never ran. Dismissing it (= cancel the deactivation)
      // is legitimate; resolving it is only done by the deactivate flow itself.
      const token = await getOpenReviewItem(reviewItemId, tenantId, {
        kind: 'pending_deactivation',
      });
      if (token && resolution === 'resolved') {
        throw new Error(
          `this is a pending deactivation for '${token.subject_ref}' — confirm it via ` +
            `deactivate_technician_seat, or dismiss it to cancel`,
        );
      }
      const item = await resolveReviewItem(reviewItemId, tenantId, resolution, str('note') ?? null);
      if (!item) throw new Error('review item not found');
      return item;
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function createServer(deps: ServerDeps = {}): Server {
  const server = new Server(
    { name: 'trades-spine', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Tier-filtered surface: technician badges see exactly the 7 spine tools
    // (the doorman runbook's verification count); active managers additionally
    // see the seat-management tools. Discovery is cosmetic — dispatch re-gates
    // every admin call — so a roster hiccup degrades to the technician surface
    // rather than erroring the list.
    const admin = deps.identity
      ? await isActiveManager(deps.identity).catch(() => false)
      : false;
    return { tools: admin ? [...TOOLS, ...ADMIN_TOOLS] : TOOLS };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await dispatch(name, (args ?? {}) as Record<string, unknown>, deps);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  return server;
}

async function main(): Promise<void> {
  const server = createServer({ identity: identityFromEnv() });
  await server.connect(new StdioServerTransport());
}

// Start the stdio server only when executed directly (node dist/mcp/server.js),
// not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
