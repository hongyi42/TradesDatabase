import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import {
  casTechnician,
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
  resolveOpenReviewItemFor,
  resolveReviewItem,
  upsertOpenReviewItem,
  type CaptureChannel,
  type TechnicianTier,
} from '../db/index.js';
import { recordFieldNote } from '../writePath/recordFieldNote.js';
import {
  checkPairing as liveCheckPairing,
  createConnectLink as liveCreateConnectLink,
  unpair as liveUnpair,
} from '../composio/pairing.js';
import {
  disablePairing as liveDisablePairing,
  enablePairing as liveEnablePairing,
} from '../composio/offboarding.js';
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
  // Composio pairing seams — injectable so tests never need COMPOSIO_API_KEY.
  connectLink?: typeof liveCreateConnectLink;
  checkPairing?: typeof liveCheckPairing;
  unpair?: typeof liveUnpair;
  disablePairing?: typeof liveDisablePairing;
  enablePairing?: typeof liveEnablePairing;
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
    name: 'reactivate_technician_seat',
    description:
      'Undo a deactivation during its grace period (manager only): the person returns to ' +
      'active, their seat is re-occupied, and their mail connection is switched back on. ' +
      'Not possible once the grace period has expired (permanently offboarded).',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'The roster ref to reactivate.' } },
      required: ['ref'],
    },
  },
  {
    name: 'get_connect_link',
    description:
      "Get a Gmail connect link for a team member (manager only). Forward it to that person — " +
      "they sign in to Google and approve; the link is SENSITIVE, share it only with them. " +
      "Once they approve, a verification item appears in list_pending_reviews asking you to " +
      "confirm the connected mailbox address.",
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string', description: 'The roster ref to pair.' } },
      required: ['ref'],
    },
  },
  {
    name: 'resolve_review',
    description:
      'Close a review item (manager only) as resolved (handled) or dismissed (not an issue). ' +
      'For a pairing verification: resolved = the mailbox is right (person goes active); ' +
      'dismissed = wrong mailbox (pairing is torn down for a fresh connect link).',
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

// The one manager-facing seat-cap message — every tool that can hit the DB
// trigger says the same thing (three call sites; drift means inconsistent
// guidance depending on which tool hit the cap).
function seatCapMessage(tier: TechnicianTier): string {
  return `no free ${tier} seats — deactivate someone or purchase a seat`;
}

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

  // ONE roster read gates every call. Badge revocation propagates to hosts on
  // the ≤5-min pull, so a deactivated person's badge can briefly outlive their
  // roster state — this check makes "deactivation cuts access instantly" true
  // server-side for ALL tools, not just admin ones (review finding: the docs
  // claimed it while only mail + admin tools enforced it). A badge with NO
  // roster row keeps the documented plain-technician surface.
  const caller = await getTechnician(tenantId, identity.technicianRef);
  if (caller && isInactiveState(caller.state)) {
    throw new Error('this badge belongs to a deactivated team member');
  }
  // The real tier gate (the tools/list filter is cosmetic): applied by tool
  // NAME so no admin case can be added without it. Reuses the read above —
  // same predicate as isActiveManager.
  if (ADMIN_TOOL_NAMES.has(name) && !(caller && caller.tier === 'manager' && caller.state === 'active')) {
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
      // One CAS write from the state we validated: a concurrent transition
      // (e.g. the pairing sweep advancing invited→pending_verification) makes
      // this confirm restart rather than being blindly overwritten. The same
      // write stamps the grace-period clock the expiry sweep reads.
      const claimed = await casTechnician(target.id, target.state, {
        state: 'offboarding',
        offboarding_started_at: new Date().toISOString(),
      });
      if (!claimed) {
        throw new Error('state changed while confirming — call again without confirmId to restart');
      }
      // Disable-first grace period: switch the pairing OFF (reversible via
      // reactivate). Advisory — the roster gate already drops their mail, and
      // the expiry teardown is the backstop if Composio is unreachable now.
      try {
        await (deps.disablePairing ?? liveDisablePairing)(target);
      } catch {
        /* advisory */
      }
      // A still-open pairing_verification item must not survive into
      // offboarding — resolving it later could read as a verification verdict
      // for someone already removed (plan review finding). Advisory close.
      try {
        await resolveOpenReviewItemFor(tenantId, 'pairing_verification', ref, 'resolved', 'person deactivated');
      } catch {
        /* advisory */
      }
      try {
        await resolveReviewItem(item.id, tenantId, 'resolved',
          `deactivation confirmed by ${identity.technicianRef}`);
      } catch {
        // Advisory once the state is changed — a retry (already_deactivated
        // branch) or the next deactivate call self-heals the open item.
      }
      return { status: 'deactivated', ref };
    }
    case 'reactivate_technician_seat': {
      const ref = str('ref');
      if (!ref) throw new Error('ref is required');
      const target = await getTechnician(tenantId, ref);
      if (!target) throw new Error(`technician '${ref}' not found`);
      // RETRY SURFACE: reactivation already ran but the pairing re-enable
      // failed (Composio blip) — calling again re-runs the enable instead of
      // erroring, because no other tool can (review finding: mail stays dark
      // indefinitely otherwise; enable is idempotent on an enabled account).
      if (target.state === 'active' && target.composio_connected_account_id) {
        let pairingRestored = true;
        try {
          await (deps.enablePairing ?? liveEnablePairing)(target);
        } catch {
          pairingRestored = false;
        }
        return { status: 'already_active', ref, pairingRestored };
      }
      if (target.state === 'offboarded') {
        throw new Error(`'${ref}' is permanently offboarded — add a new seat instead`);
      }
      if (target.state !== 'offboarding') {
        throw new Error(`'${ref}' is not deactivated (state: ${target.state})`);
      }
      // Back to 'active' when a pairing exists (the realistic case — known
      // accepted edge: a pending_verification deactivation returns as active
      // without a mailbox confirmation, the manager drove both actions).
      // NO pairing (deactivated while still invited) → back to 'invited':
      // 'active' would be a dead-end — get_connect_link refuses active rows
      // and checkPairing only acts on invited, so their mailbox could never
      // be paired (review finding).
      const restoredState = target.composio_connected_account_id ? 'active' : 'invited';
      // ONE CAS write restores state + clears the clock atomically: no window
      // where a crash leaves an active row still carrying a grace clock, and
      // a concurrent expiry claim (offboarding→offboarded) wins cleanly — we
      // report the truth instead of resurrecting into a torn-down pairing.
      let restored;
      try {
        restored = await casTechnician(target.id, 'offboarding', {
          state: restoredState,
          offboarding_started_at: null,
        });
      } catch (err) {
        if (isSeatCapError(err)) throw new Error(seatCapMessage(target.tier));
        throw err;
      }
      if (!restored) {
        throw new Error(`'${ref}' changed state while reactivating — check list_team and retry`);
      }
      // An open grace-period reminder is now moot — and if it stayed open, a
      // SECOND deactivation episode's reminder would collide with it and show
      // the stale deadline (review finding). Advisory close.
      try {
        await resolveOpenReviewItemFor(tenantId, 'offboarding_reminder', ref, 'resolved', 'reactivated during grace period');
      } catch {
        /* advisory */
      }
      // Switch the pairing back on. Advisory, but SURFACED: if this fails the
      // person is active with dark mail — the manager retries via this tool.
      let pairingRestored: boolean | null = null;
      if (target.composio_connected_account_id) {
        try {
          await (deps.enablePairing ?? liveEnablePairing)(target);
          pairingRestored = true;
        } catch {
          pairingRestored = false;
        }
      }
      return {
        status: 'reactivated',
        ref,
        state: restoredState,
        pairingRestored,
        ...(restoredState === 'invited' && {
          note: 'no mailbox was ever connected — use get_connect_link to pair them',
        }),
      };
    }
    case 'get_connect_link': {
      const ref = str('ref');
      if (!ref) throw new Error('ref is required');
      const target = await getTechnician(tenantId, ref);
      if (!target) throw new Error(`technician '${ref}' not found`);
      if (isInactiveState(target.state)) {
        throw new Error(`'${ref}' is deactivated — reactivate the seat first`);
      }
      if (target.state === 'active') {
        throw new Error(`'${ref}' is already connected and active`);
      }
      // One definition for both "already connected" exits below — the literal
      // was duplicated and would drift (review finding).
      const awaiting = (email: string | null) => ({
        status: 'awaiting_verification',
        ref,
        email,
        note: 'already connected — confirm or dismiss the pairing in list_pending_reviews',
      });
      if (target.state === 'pending_verification') {
        return awaiting(target.connected_email);
      }
      // state === 'invited'. Cooldown BEFORE any Composio call — the one rate
      // limit on the link-minting surface (structural, replica-safe: the clock
      // lives on the roster row).
      if (
        target.link_issued_at &&
        Date.now() - Date.parse(target.link_issued_at) < 5 * 60_000
      ) {
        throw new Error('a link was just issued for this person — wait a few minutes, then try again');
      }
      // Consent may already have completed before any sweep ran: checkPairing
      // advances the row and opens the verification item itself.
      const check = await (deps.checkPairing ?? liveCheckPairing)(target);
      if (check.status === 'paired') {
        return awaiting(check.email);
      }
      const { url } = await (deps.connectLink ?? liveCreateConnectLink)(target);
      return {
        status: 'link_created',
        ref,
        url,
        note: 'Forward this link ONLY to this person. They sign in to Google and approve; ' +
          'you will then get a verification item to confirm the mailbox.',
      };
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
      // ONE point read, then dispatch on the item's kind — behavioral kinds
      // add a branch here, not another guaranteed-null DB probe per call
      // (review finding: the sequential kind-filtered reads pattern costs two
      // wasted round trips on every common resolve and won't scale).
      const open = await getOpenReviewItem(reviewItemId, tenantId);
      if (!open) throw new Error('review item not found');
      // A pending_deactivation item is a live confirm token, not a review to
      // "handle": marking it resolved here would read as a completed
      // deactivation that never ran. Dismissing it (= cancel) is legitimate.
      if (open.kind === 'pending_deactivation' && resolution === 'resolved') {
        throw new Error(
          `this is a pending deactivation for '${open.subject_ref}' — confirm it via ` +
            `deactivate_technician_seat, or dismiss it to cancel`,
        );
      }
      // A pairing_verification verdict acts BEFORE the item closes (state-first,
      // mirroring deactivate): resolved = right mailbox → active; dismissed =
      // wrong mailbox → unpair back to invited. Both act ONLY while the row is
      // still pending_verification — a stale item on an offboarding/offboarded
      // row must neither resurrect nor unpair anyone; it just closes. The
      // state advance is a CAS so a deactivate landing mid-call wins.
      if (open.kind === 'pairing_verification') {
        const target = await getTechnician(tenantId, open.subject_ref);
        if (target && target.state === 'pending_verification') {
          if (resolution === 'resolved') {
            try {
              await casTechnician(target.id, 'pending_verification', { state: 'active' });
            } catch (err) {
              if (isSeatCapError(err)) throw new Error(seatCapMessage(target.tier));
              throw err;
            }
          } else {
            await (deps.unpair ?? liveUnpair)(target);
          }
        }
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
