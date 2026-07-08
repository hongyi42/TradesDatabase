import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import {
  annotateResolvedReviewItem,
  appendRawCapture,
  captureHasLinkedVisit,
  casTechnician,
  findRetractionsFor,
  foldRetractions,
  getJob,
  getCustomer,
  getOpenReviewItem,
  getRawCapture,
  getRawCaptureByExternalId,
  searchCustomers,
  getCustomerContext,
  getTechnician,
  findTechnicianByTelegramUserId,
  getPoolRowByTechnician,
  listFreeSandboxes,
  claimSandbox,
  updateTechnician,
  getTenant,
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
  updateOpenReviewItemDetail,
  upsertOpenReviewItem,
  type CaptureChannel,
  type Json,
  type TechnicianTier,
} from '../db/index.js';
import { recordFieldNote, type ResolvedIdentity } from '../writePath/recordFieldNote.js';
import { matchIdentity, type MatchResult } from '../writePath/identityMatch.js';
import { sonnetExtractor, type ExtractedFields } from '../writePath/extract.js';
import {
  requireOutboundCapable,
  sendGmailEmail as liveSendGmailEmail,
} from '../composio/outbound.js';
import { teardownPersonSession as liveTeardownSession } from '../composio/sessions.js';
import { formatEmailRawText } from '../email/format.js';
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
import { listDayStops } from '../routes/daySource.js';
import { optimizeStopOrder as liveOptimizeStopOrder } from '../routes/googleRoutes.js';
import { buildMapsDeepLink, type RouteStop } from '../routes/deepLink.js';
import { localDateISO } from '../schedule/availability.js';

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
  sendEmail?: typeof liveSendGmailEmail;
  teardownSession?: typeof liveTeardownSession;
  optimizeStopOrder?: typeof liveOptimizeStopOrder; // Google Routes seam — tests never need the key
}

const TECH_CHANNELS: CaptureChannel[] = ['technician_voice', 'technician_note', 'technician_photo'];
const BRIEF_FOCUSES: BriefFocus[] = ['next_visit', 'full_history'];
const TIERS: TechnicianTier[] = ['manager', 'technician'];

// The technician tool surface — what every badge sees (the doorman runbook's
// "10 tools" verification counts exactly these).
const TOOLS = [
  {
    name: 'record_field_note',
    description:
      'Record a technician field note into the permanent company record — two-step. First call ' +
      'with text: NOTHING is recorded; you get back needs_identity (ask the technician which ' +
      'customer, then call again with confirmId + confirmed:{customerId|address}) or ' +
      'needs_confirmation with a preview. Show the technician EXACTLY the preview (customer + ' +
      'note text); only on their explicit yes call again with ONLY confirmId — the STAGED copy ' +
      'is what gets recorded, permanently (there is no delete; a mistake needs retract_capture).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note text (voice already transcribed to text). First call only.' },
        blobPath: { type: 'string', description: 'Optional object-store pointer for audio/photo. First call only.' },
        channel: { type: 'string', enum: TECH_CHANNELS, description: 'Defaults to technician_note. First call only.' },
        confirmId: { type: 'string', description: 'Set on follow-up calls; ALONE it records the staged note.' },
        confirmed: {
          type: 'object',
          description: 'With confirmId: the technician\'s answer to a needs_identity question.',
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
    description:
      'List raw captures for a job (jobId) or a customer (customerId), newest first. Retracted ' +
      'captures are hidden; managers may pass includeRetracted:true for the full labeled trail.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        customerId: { type: 'string' },
        includeRetracted: {
          type: 'boolean',
          description: 'Manager badges only: include retracted captures, labeled with their retraction.',
        },
      },
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
  {
    name: 'get_schedule',
    description:
      "Your schedule as a day-by-day route: for each day in [from,to] (YYYY-MM-DD; both " +
      "optional — default is today in the firm's timezone; range is capped at 14 days) returns " +
      'your stops in best driving order, total drive minutes, and a Google Maps link (mapsUrl) ' +
      "that opens the whole day's route for navigation. Relay each day's mapsUrl to the person " +
      'VERBATIM as a tappable link. days:[] means no stops in the range. driveMinutes null = ' +
      'not measured; optimizeFailed true = stops are in scheduled (not drive-optimized) order; ' +
      'a day may also carry unroutableStops (time-ordered, no usable address, not in the ' +
      'link) — mention them to the person alongside the driving list.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date YYYY-MM-DD (default: today, UTC).' },
        to: { type: 'string', description: 'End date YYYY-MM-DD inclusive (default: from).' },
      },
      required: [],
    },
  },
  {
    name: 'send_email',
    description:
      'Send an email from your own paired mailbox — two-step. First call with to/subject/body: ' +
      'nothing is sent; you get {status:"needs_confirmation", confirmId} back. Show the person ' +
      'EXACTLY what will be sent (to, subject, body). Only when they approve, call again with ' +
      'ONLY confirmId — the STAGED copy is what gets sent, fresh args are ignored. Every sent ' +
      'email is permanently recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient email address (first call only).' },
        subject: { type: 'string', description: 'Subject line (first call only).' },
        body: { type: 'string', description: 'Plain-text body (first call only).' },
        confirmId: { type: 'string', description: 'Set ONLY on the confirming second call.' },
      },
      required: [],
    },
  },
  {
    name: 'retract_capture',
    description:
      'Retract a wrongly recorded capture — two-step. The record is append-only, so this never ' +
      'deletes: it permanently marks the capture as recorded-in-error (with your reason); the ' +
      'note and its visit stop appearing in briefings/context/lists (facts the note already ' +
      'wrote onto the job/customer record — e.g. a status change — are NOT auto-reverted). ' +
      'First call with captureId + reason: nothing happens yet; you get ' +
      '{status:"needs_confirmation", confirmId}. Show the person the capture and the reason; ' +
      "only on their explicit yes call again with ONLY confirmId. Only the capture's author or " +
      'a manager may retract; agent-action audit records are manager-only. To fix a wrong note: ' +
      'record the corrected note first, then retract the wrong one.',
    inputSchema: {
      type: 'object',
      properties: {
        captureId: { type: 'string', description: 'The capture to retract (first call only).' },
        reason: {
          type: 'string',
          description: 'Why it is being retracted (first call only; stored permanently).',
        },
        confirmId: { type: 'string', description: 'Set ONLY on the confirming second call.' },
      },
      required: [],
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
    name: 'bind_telegram',
    description:
      "Connect a team member to their Telegram account (manager only). Give the roster ref and " +
      "the person's NUMERIC Telegram user id (they get it from @userinfobot). Their agent sandbox " +
      "then answers only that Telegram account. If the person has no sandbox yet, one is claimed " +
      "automatically from the cold pool. The binding reaches the box within ~5 minutes. Re-call " +
      "to fix a wrong id — it returns the previous value.",
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The roster ref to bind.' },
        telegramUserId: {
          type: 'string',
          description: "The person's numeric Telegram user id (digits only, via @userinfobot).",
        },
      },
      required: ['ref', 'telegramUserId'],
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

// Audit channels: L1 rows that exist to hold the ACTOR accountable for an
// agent-performed action. Self-retraction would defeat their purpose (recorded
// exception 2026-07-04: the audit matters most when the action was personal or
// inappropriate), so retracting one requires a manager badge even for its
// author — logIngest and the send_email capture stamp the acting person's own
// roster ref, so an author-only rule would allow self-cleanup (review finding).
const AUDIT_CHANNELS = new Set<CaptureChannel>(['outbound_email', 'agent_action']);

// The staged copy of a field note (review_items.detail, kind pending_field_note).
// The staged copy is the note of record: commit reads ONLY this — never fresh
// args — so what the technician confirmed is exactly what lands.
interface StagedNoteDetail {
  text: string | null;
  blobPath: string | null;
  channel: CaptureChannel;
  extracted: ExtractedFields;
  stagedAt: string;
  resolved?: ResolvedIdentity;
  // The identity question, stored so the needs_identity response can echo the
  // ITEM's question — racing stages may return the other call's row, and the
  // question must describe the note that will actually commit (review finding).
  suggestion?: { address: string; scheduleEntryId: string };
  identityReason?: string;
}

// MatchResult → the staged resolution, or undefined while identity is unknown.
// A confirmed answer that matched no existing customer resolves to create-new;
// the FULL draft is built here (schedule prefill > extracted/confirmed) so the
// preview shows exactly the customer commit will create.
function resolutionFrom(
  match: MatchResult,
  confirmed: { customerId?: string; address?: string } | undefined,
  extracted: ExtractedFields,
): ResolvedIdentity | undefined {
  if (match.status === 'matched' && match.customerId) {
    return { customerId: match.customerId, ...(match.jobId ? { jobId: match.jobId } : {}) };
  }
  if (confirmed && (match.createFrom || confirmed.address)) {
    const draft = match.createFrom;
    return {
      createFrom: {
        // Trim-normalize the name so preview and commit agree: '' / whitespace
        // must read as "no name" in BOTH (commit falls through to 'Unknown
        // customer'; the preview must not invent a stand-in — review finding).
        customerName: (draft?.customerName ?? extracted.customerName)?.trim() || null,
        phone: draft?.phone ?? extracted.phone ?? null,
        addressLine1: draft?.addressLine1 ?? confirmed.address ?? extracted.address ?? null,
        city: draft?.city ?? extracted.city ?? null,
        state: draft?.state ?? extracted.state ?? null,
        postalCode: draft?.postalCode ?? extracted.postalCode ?? null,
      },
    };
  }
  return undefined;
}

// What the technician must be shown before confirming. newCustomer flags a
// create-on-confirm so the agent can say "…for NEW customer Jane, 12 Oak St".
async function stagedNotePreview(detail: StagedNoteDetail): Promise<{
  customerName: string | null;
  newCustomer: boolean;
  address: string | null;
  text: string | null;
  channel: CaptureChannel;
}> {
  if (detail.resolved?.customerId) {
    const customer = await getCustomer(detail.resolved.customerId);
    return {
      customerName: customer?.name ?? null,
      newCustomer: false,
      address: customer?.address_line1 ?? null,
      text: detail.text,
      channel: detail.channel,
    };
  }
  const draft = detail.resolved?.createFrom;
  return {
    // Exactly what commit will name the customer — a nameless draft becomes
    // 'Unknown customer' there, so the preview must say so, not substitute
    // the address as a stand-in name (preview == commit; review finding).
    customerName: draft?.customerName ?? 'Unknown customer',
    newCustomer: true,
    address: draft?.addressLine1 ?? null,
    text: detail.text,
    channel: detail.channel,
  };
}

// The one manager-facing seat-cap message — every tool that can hit the DB
// trigger says the same thing (three call sites; drift means inconsistent
// guidance depending on which tool hit the cap).
function seatCapMessage(tier: TechnicianTier): string {
  return `no free ${tier} seats — deactivate someone or purchase a seat`;
}

// Admin tools require an ACTIVE manager-tier roster row for the caller's badge
// identity. Tier lives in the technicians table (single source of truth), not
// in the badge — so revoking manager status is a DB update, no badge rotation.
// ⚠ Demotion procedure MUST also tear down the person's Composio session
// (teardownPersonSession — nulls composio_session_id so the sweep re-mints at
// the new tier): ensurePersonSession short-circuits on an existing id, so a
// stale manager session otherwise keeps the full catalog + manageConnections
// indefinitely (review finding; see Box_Setup_Stuff §0b).
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
  // ONE definition of "active manager" for this request — the admin-tool gate
  // and the sensitivity filter must never drift apart (same predicate as
  // isActiveManager; review finding: it was hand-written three times).
  const activeManager = !!caller && caller.tier === 'manager' && caller.state === 'active';
  // The real tier gate (the tools/list filter is cosmetic): applied by tool
  // NAME so no admin case can be added without it.
  if (ADMIN_TOOL_NAMES.has(name) && !activeManager) {
    throw new Error('admin tools require a manager badge');
  }
  // Sensitivity filter: manager-only L1 rows (e.g. payment agent_actions from
  // the log-ingestion audit) are dropped from every capture-bearing read for
  // non-manager badges. In-memory post-filter — deliberately NOT a PostgREST
  // neq filter (NULL-vs-neq trap). The REQUIRED `sensitivity` key on the
  // constraint is load-bearing: a narrowed `.select('col, …')` that drops the
  // column must fail typecheck here, not silently fail open (review finding).
  const dropSensitive = <T extends { sensitivity: string | null }>(rows: T[]): T[] =>
    activeManager ? rows : rows.filter((r) => r.sensitivity !== 'manager_only');

  switch (name) {
    case 'record_field_note': {
      const channelArg = str('channel');
      if (channelArg && !TECH_CHANNELS.includes(channelArg as CaptureChannel)) {
        throw new Error(`invalid channel: ${channelArg}`);
      }
      const channel: CaptureChannel = (channelArg as CaptureChannel | undefined) ?? 'technician_note';
      const confirmed = args.confirmed as { customerId?: string; address?: string } | undefined;
      // Tenant-guard any model-supplied customerId BEFORE it can enter a staged
      // resolution: a forged id would otherwise attach the note to another
      // firm's customer/job at commit. (The address/phone/schedule branches are
      // already tenant-scoped inside matchIdentity.)
      if (confirmed?.customerId) {
        const customer = await getCustomer(confirmed.customerId);
        if (!customer || customer.tenant_id !== tenantId) {
          throw new Error('customer not found');
        }
      }
      // subjectRef is the badge identity, NOT caller.ref: this tool serves
      // roster-less badges too (caller is null for them), unlike send_email.
      const subjectRef = identity.technicianRef;
      const confirmId = str('confirmId');

      if (!confirmId) {
        // STAGE. Nothing is written to L1/L2 here — the note is held as a
        // review item until the technician's explicit yes.
        const text = str('text');
        const blobPath = str('blobPath');
        if (!text && !blobPath) throw new Error('text or blobPath is required to stage a note');
        // The ?? fallback is mandatory: production constructs the server with
        // no extract dep (stdio main() / httpServer) — only tests inject stubs.
        const extracted = await (deps.extract ?? sonnetExtractor)(text ?? '');
        const stagedAt = new Date().toISOString();
        const match = await matchIdentity({
          tenantId,
          technicianRef: subjectRef,
          capturedAt: stagedAt,
          extracted,
          confirmed,
        });
        const resolved = resolutionFrom(match, confirmed, extracted);
        // One staged note per person: a re-stage supersedes any open one.
        await resolveOpenReviewItemFor(
          tenantId,
          'pending_field_note',
          subjectRef,
          'dismissed',
          'superseded by a new note',
        );
        const detail: StagedNoteDetail = {
          text: text ?? null,
          blobPath: blobPath ?? null,
          channel,
          extracted,
          stagedAt,
          ...(resolved ? { resolved } : {}),
          ...(match.suggestion ? { suggestion: match.suggestion } : {}),
          ...(match.reason ? { identityReason: match.reason } : {}),
        };
        const item = await upsertOpenReviewItem({
          tenantId,
          kind: 'pending_field_note',
          subjectRef,
          detail: detail as unknown as Json,
        });
        // Echo the ITEM's detail for EVERY field, not local state: two racing
        // stage calls can make the upsert return the other call's open row,
        // and both the staged copy AND the identity question shown must
        // describe the note that will commit (same rule as send_email).
        const staged = (item.detail ?? {}) as unknown as StagedNoteDetail;
        if (!staged.resolved) {
          return {
            status: 'needs_identity',
            confirmId: item.id,
            suggestion: staged.suggestion,
            reason: staged.identityReason,
            note: 'Nothing was recorded. Ask the technician which customer this is, then call again with confirmId + confirmed:{customerId} (or {address}).',
          };
        }
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          preview: await stagedNotePreview(staged),
          note: 'Nothing was recorded yet. Show the technician exactly this preview; on their explicit yes call again with ONLY confirmId.',
        };
      }

      // Guarded token lookup: forged / another person's / consumed confirmId
      // matches nothing (every predicate in the WHERE clause).
      const item = await getOpenReviewItem(confirmId, tenantId, {
        kind: 'pending_field_note',
        subjectRef,
      });
      if (!item) {
        throw new Error('confirmation not found — call record_field_note again with the note text to restage');
      }
      const detail = (item.detail ?? {}) as unknown as StagedNoteDetail;

      // One outcome for "the commit already landed" (late retry after a crash
      // between commit and consume). Complete (visit linked) → report the
      // duplicate honestly; partial (crash mid-L2) → do NOT reassure: the
      // note's visit facts are missing and only a fresh full record + a
      // manager retraction of the partial capture heals it (review findings).
      const reportExisting = async (existingCaptureId: string) => {
        if (await captureHasLinkedVisit(existingCaptureId)) {
          try {
            await resolveReviewItem(item.id, tenantId, 'resolved', `note recorded by ${subjectRef}`);
          } catch {
            /* advisory */
          }
          return {
            status: 'duplicate',
            captureId: existingCaptureId,
            note: 'this staged note was already recorded by an earlier confirm — nothing was written twice',
          };
        }
        try {
          await resolveReviewItem(
            item.id,
            tenantId,
            'dismissed',
            'earlier commit left a partial record (no visit)',
          );
        } catch {
          /* advisory */
        }
        throw new Error(
          `an earlier confirm only PARTIALLY recorded this note (capture ${existingCaptureId} is missing its visit details) — ` +
            'restage the note to record it fully, then have a manager retract the partial capture',
        );
      };

      if (detail.stagedAt && Date.now() - Date.parse(detail.stagedAt) > 15 * 60_000) {
        // Before dismissing into a restage, check whether a commit already
        // landed under this token: a restage mints a NEW externalId stamp, so
        // dismissing here after a commit-then-crash would double-write the
        // note permanently (review finding).
        const landed = await getRawCaptureByExternalId(tenantId, `note:${item.id}`);
        if (landed) return reportExisting(landed.id);
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'staging expired');
        throw new Error('staged note expired — restage with the note text and confirm again');
      }

      if (confirmed) {
        // IDENTITY RESUME: re-match the STORED extraction with the technician's
        // answer; the resolution is persisted so commit uses exactly it.
        // capturedAt = stagedAt keeps the schedule branch on the staging day
        // (a re-match across midnight must not resolve differently).
        const extracted = detail.extracted ?? {};
        const match = await matchIdentity({
          tenantId,
          technicianRef: subjectRef,
          capturedAt: detail.stagedAt ?? new Date().toISOString(),
          extracted,
          confirmed,
        });
        const resolved = resolutionFrom(match, confirmed, extracted);
        if (!resolved) {
          return {
            status: 'needs_identity',
            confirmId: item.id,
            suggestion: match.suggestion,
            reason: match.reason,
            note: 'Still ambiguous — ask the technician and call again with confirmId + confirmed:{customerId} (or {address}).',
          };
        }
        const newDetail: StagedNoteDetail = { ...detail, resolved };
        const updated = await updateOpenReviewItemDetail(
          item.id,
          tenantId,
          newDetail as unknown as Json,
        );
        if (!updated) {
          throw new Error('confirmation not found — call record_field_note again with the note text to restage');
        }
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          preview: await stagedNotePreview(newDetail),
          note: 'Nothing was recorded yet. Show the technician exactly this preview; on their explicit yes call again with ONLY confirmId.',
        };
      }

      // FINAL CONFIRM (confirmId alone). The staged copy is the note of record.
      if (!detail.resolved) {
        throw new Error('customer not resolved — call again with confirmId + confirmed:{customerId|address} first');
      }
      if (detail.text == null && detail.blobPath == null) {
        throw new Error('staged note is malformed — restage with the note text');
      }
      // COMMIT FIRST, consume second: the commit is idempotent (externalId
      // stamp `note:<confirmId>` + orphan heal), so a crash mid-commit leaves
      // the token open and a retried confirm converges on ONE L1 row —
      // consume-first would orphan a half-written permanent row instead.
      let result;
      try {
        result = await recordFieldNote(
          {
            tenantId,
            technicianRef: subjectRef,
            text: detail.text,
            blobPath: detail.blobPath,
            channel: detail.channel ?? 'technician_note',
            resolved: detail.resolved,
            externalId: `note:${item.id}`,
            sourceMeta: { stagedConfirmId: item.id },
          },
          // Replay the staged extraction: no model call, and commit cannot
          // extract differently than what the technician was shown.
          { extract: async () => detail.extracted ?? {} },
        );
      } catch (err) {
        // The token is still open (consume hasn't run): a retry with the SAME
        // confirmId re-runs this commit under the SAME externalId and heals.
        // Restaging instead would mint a new stamp and could double-write.
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `note NOT recorded: ${msg} — the staged note is still held; retry with the SAME confirmId (do not restage)`,
        );
      }
      if (result.status === 'duplicate') {
        // Idempotent retry after a crash between commit and consume — but
        // only reassure if the earlier commit actually completed (visit
        // linked); a mid-L2 crash must surface, not read as success.
        return await reportExisting(result.captureId);
      }
      try {
        await resolveReviewItem(item.id, tenantId, 'resolved', `note recorded by ${subjectRef}`);
      } catch {
        /* advisory — a retried confirm hits the externalId dedup (duplicate) */
      }
      return {
        status: 'recorded',
        captureId: result.captureId,
        customerId: result.customerId,
        jobId: result.jobId,
        visitId: result.visitId,
      };
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
      return { ...ctx, recentCaptures: dropSensitive(ctx.recentCaptures) };
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
      // Audit toggle is manager-only (user decision 2026-07-06): technicians
      // always get the folded view.
      const includeRetracted = args.includeRetracted === true;
      if (includeRetracted && !activeManager) {
        throw new Error('includeRetracted requires a manager badge');
      }
      // Tenant guard via the parent: captures inherit the job's/customer's tenant,
      // so verifying the parent gates the whole list (a mismatch reads as empty).
      let rows;
      if (jobId) {
        const job = await getJob(jobId);
        if (!job || job.tenant_id !== tenantId) return [];
        rows = dropSensitive(await listRawCapturesForJob(jobId));
      } else if (customerId) {
        const customer = await getCustomer(customerId);
        if (!customer || customer.tenant_id !== tenantId) return [];
        rows = dropSensitive(await listRawCapturesForCustomer(customerId));
      } else {
        throw new Error('list_recent_captures requires jobId or customerId');
      }
      const retractions = await findRetractionsFor(rows.map((r) => r.id));
      if (!includeRetracted) return foldRetractions(rows, retractions);
      // Manager full trail: retracted rows labeled with their retraction (at
      // most one per target — unique index); retraction rows stamped into
      // this list appear as-is.
      const byTarget = new Map(retractions.map((r) => [r.retracts_capture_id, r]));
      return rows.map((row) => {
        const retraction = byTarget.get(row.id);
        return retraction
          ? {
              ...row,
              retracted: true,
              retraction: {
                id: retraction.id,
                reason: retraction.raw_text,
                by: retraction.technician_ref,
                at: retraction.captured_at,
              },
            }
          : row;
      });
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
      return (deps.brief ?? sonnetBriefer)(
        { ...ctx, recentCaptures: dropSensitive(ctx.recentCaptures) },
        focus,
      );
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
      return (deps.answer ?? sonnetAnswerer)(
        { ...ctx, recentCaptures: dropSensitive(ctx.recentCaptures) },
        question,
      );
    }
    case 'get_schedule': {
      // Whose schedule = the badge identity, never an arg — a technician can
      // only ever fetch their own days.
      // Non-string args must be rejected, not coerced: str() maps {from: 123}
      // to undefined and the default would silently answer about TODAY with
      // status ok (the SDK does not validate args against inputSchema).
      if (
        (args.from !== undefined && typeof args.from !== 'string') ||
        (args.to !== undefined && typeof args.to !== 'string')
      ) {
        return { status: 'invalid_range', note: 'from/to must be YYYY-MM-DD strings' };
      }
      // Default "today" is the FIRM's local day, not UTC: for a Pacific-time
      // tenant every evening ask would otherwise default to tomorrow.
      let from = str('from');
      let to = str('to');
      if (!from) {
        const tz = (await getTenant(tenantId))?.timezone ?? 'UTC';
        from = localDateISO(new Date().toISOString(), tz);
      }
      to ??= from;
      const DATE = /^\d{4}-\d{2}-\d{2}$/;
      if (!DATE.test(from) || !DATE.test(to) || from > to) {
        return { status: 'invalid_range', note: 'from/to must be YYYY-MM-DD with from <= to' };
      }
      const spanDays =
        (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
      // Regex-valid but impossible dates (month 13) parse to NaN — reject them
      // with an accurate note, distinct from the span cap.
      if (!Number.isFinite(spanDays)) {
        return { status: 'invalid_range', note: 'from/to is not a real calendar date' };
      }
      if (spanDays > 14) {
        return { status: 'invalid_range', note: 'range is capped at 14 days' };
      }
      const optimize = deps.optimizeStopOrder ?? liveOptimizeStopOrder;
      const dayStops = await listDayStops(tenantId, identity.technicianRef, from, to);
      // Days are independent — optimize them concurrently (a 14-day ask is one
      // round-trip's latency, not fourteen). Promise.all preserves input order.
      const days = await Promise.all(
        dayStops.map(async (day) => {
          // `order` from the optimizer indexes the ROUTABLE list only.
          // Unroutable stops (no usable address) go in their own time-ordered
          // field: splicing them into the drive-ordered list would misstate
          // the driving sequence, and appending them at the end would misstate
          // the day's chronology.
          const routable = day.stops.filter(
            (s): s is RouteStop & { address: string } => s.address !== null,
          );
          const unroutableStops = day.stops.filter((s) => s.address === null);
          let ordered: RouteStop[] = routable;
          let driveMinutes: number | null = null;
          let optimizeFailed = false;
          try {
            const result = await optimize(routable);
            ordered = result.order.map((i) => routable[i]);
            driveMinutes = result.totalMinutes;
          } catch {
            // Google failure must not eat the schedule: deliver the day in
            // scheduled order with no drive estimate.
            optimizeFailed = true;
          }
          const link = buildMapsDeepLink(ordered);
          return {
            date: day.date,
            stops: ordered,
            ...(unroutableStops.length > 0 ? { unroutableStops } : {}),
            driveMinutes,
            mapsUrl: link.url,
            linkTruncated: link.linkTruncated,
            ...(optimizeFailed ? { optimizeFailed: true } : {}),
          };
        }),
      );
      return { status: 'ok', from, to, days };
    }
    case 'send_email': {
      // Both steps require an active, paired caller — checked FIRST so a
      // roster-less badge sending only confirmId gets the clean 'no roster
      // row' error, never a TypeError on caller.ref.
      requireOutboundCapable(caller);
      const confirmId = str('confirmId');
      if (!confirmId) {
        // STAGE. The staged copy is the send of record; a re-stage supersedes
        // any open token (differing or not) so exactly one confirmable payload
        // exists per person at a time.
        const to = str('to');
        const subject = str('subject');
        const body = str('body');
        if (!to || !subject || !body) {
          throw new Error('to, subject, and body are required to stage a send');
        }
        await resolveOpenReviewItemFor(
          tenantId,
          'pending_outbound_send',
          caller.ref,
          'dismissed',
          'superseded by a new send request',
        );
        const item = await upsertOpenReviewItem({
          tenantId,
          kind: 'pending_outbound_send',
          subjectRef: caller.ref,
          detail: { to, subject, body, stagedAt: new Date().toISOString() },
        });
        // Echo the ITEM's detail, not the local args: two racing stage calls
        // can make the upsert return the other call's open row (partial-unique
        // conflict), and the staged copy is what gets sent — the person must
        // be shown exactly that copy (review finding).
        const staged = (item.detail ?? {}) as { to?: string; subject?: string; body?: string };
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          to: staged.to ?? to,
          subject: staged.subject ?? subject,
          body: staged.body ?? body,
          note: 'Nothing was sent. Show the person exactly this content; on their approval call send_email again with ONLY confirmId.',
        };
      }
      // CONFIRM. Token lookup with every guard in the WHERE clause: a forged
      // or another person's confirmId matches nothing.
      const item = await getOpenReviewItem(confirmId, tenantId, {
        kind: 'pending_outbound_send',
        subjectRef: caller.ref,
      });
      if (!item) {
        throw new Error('confirmation not found — call send_email again with to/subject/body to restage');
      }
      const detail = (item.detail ?? {}) as { to?: string; subject?: string; body?: string; stagedAt?: string };
      if (!detail.to || !detail.subject || detail.body === undefined) {
        throw new Error('staged send is malformed — restage with to/subject/body');
      }
      if (detail.stagedAt && Date.now() - Date.parse(detail.stagedAt) > 15 * 60_000) {
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'confirmation expired');
        throw new Error('confirmation expired — restage the send and confirm again');
      }
      // CONSUME FIRST, send second (at-most-once): losing this race means
      // someone else already confirmed or cancelled — never send twice.
      const consumed = await resolveReviewItem(
        item.id,
        tenantId,
        'resolved',
        `send confirmed by ${identity.technicianRef}`,
      );
      if (!consumed) {
        throw new Error('already confirmed or cancelled — nothing was sent by this call');
      }
      let sent;
      try {
        sent = await (deps.sendEmail ?? liveSendGmailEmail)(caller, {
          to: detail.to,
          subject: detail.subject,
          body: detail.body,
        });
      } catch (err) {
        // The token is consumed and the email was NOT sent: report plainly and
        // require a fresh stage (at-most-once — a retry on a consumed token
        // could otherwise double-send). Re-annotate the consumed item so the
        // durable record never reads as a confirmed send that ran (review
        // finding); advisory — the caller-facing error is the authority.
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await annotateResolvedReviewItem(
            confirmId,
            tenantId,
            `confirmed but send FAILED (${msg}) — nothing was sent`,
          );
        } catch {
          /* advisory */
        }
        throw new Error(`email NOT sent: ${msg} — restage with to/subject/body to try again`);
      }
      // Advisory L1 capture (capture-all, no classifier — recorded exception):
      // a capture failure never un-reports a real send.
      let captured = false;
      try {
        await appendRawCapture({
          tenantId,
          channel: 'outbound_email',
          technicianRef: caller.ref,
          rawText: formatEmailRawText({
            from: caller.connected_email ?? caller.ref,
            subject: detail.subject,
            body: detail.body,
          }),
          externalId: sent.messageId ? `sent:${sent.messageId}` : `sent:confirm:${confirmId}`,
          metadata: {
            to: detail.to,
            subject: detail.subject,
            sentVia: 'GMAIL_SEND_EMAIL',
            threadId: sent.threadId,
          },
        });
        captured = true;
      } catch {
        /* advisory */
      }
      return {
        status: 'sent',
        to: detail.to,
        subject: detail.subject,
        messageId: sent.messageId,
        captured,
      };
    }
    case 'retract_capture': {
      const subjectRef = identity.technicianRef;
      const confirmId = str('confirmId');
      if (!confirmId) {
        // STAGE. Nothing is written; the request is held as a review item.
        const captureId = str('captureId');
        const reason = str('reason')?.trim();
        if (!captureId) throw new Error('captureId is required');
        if (!reason) {
          throw new Error('reason is required — say why this capture is being retracted');
        }
        const target = await getRawCapture(captureId);
        // Tenant guard: a cross-tenant (or unknown) id reads as not found.
        if (!target || target.tenant_id !== tenantId) throw new Error('capture not found');
        if (target.retracts_capture_id !== null) {
          throw new Error('cannot retract a retraction');
        }
        if ((await findRetractionsFor([target.id])).length > 0) {
          throw new Error('this capture is already retracted');
        }
        // Audit rows are manager-only retractions EVEN FOR THEIR AUTHOR: the
        // send capture and logIngest stamp the acting person's own roster ref,
        // so an author-only rule would let someone scrub their own audit trail
        // from default views (review finding; recorded exception 2026-07-04).
        if (AUDIT_CHANNELS.has(target.channel) && !activeManager) {
          throw new Error('this is an agent-action audit record — only a manager can retract it');
        }
        // Otherwise: author or active manager (user decision 2026-07-06).
        if (target.technician_ref !== subjectRef && !activeManager) {
          throw new Error('only the author or a manager can retract a capture');
        }
        await resolveOpenReviewItemFor(
          tenantId,
          'pending_retraction',
          subjectRef,
          'dismissed',
          'superseded by a new retraction request',
        );
        const item = await upsertOpenReviewItem({
          tenantId,
          kind: 'pending_retraction',
          subjectRef,
          detail: {
            captureId: target.id,
            reason,
            targetPreview: (target.raw_text ?? '').slice(0, 200),
            stagedAt: new Date().toISOString(),
          },
        });
        // Echo the ITEM's detail (racing stages — same rule as send_email).
        const staged = (item.detail ?? {}) as {
          captureId?: string;
          reason?: string;
          targetPreview?: string;
        };
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          captureId: staged.captureId ?? target.id,
          reason: staged.reason ?? reason,
          targetPreview: staged.targetPreview,
          note: 'Nothing was retracted. Show the person the capture and this reason; on their explicit yes call again with ONLY confirmId. A retraction is permanent (the audit trail keeps both rows).',
        };
      }
      // CONFIRM. Guarded token lookup, then commit-first (the unique index +
      // externalId stamp make the commit race- and retry-safe), consume second.
      const item = await getOpenReviewItem(confirmId, tenantId, {
        kind: 'pending_retraction',
        subjectRef,
      });
      if (!item) {
        throw new Error('confirmation not found — call retract_capture again with captureId + reason to restage');
      }
      const detail = (item.detail ?? {}) as {
        captureId?: string;
        reason?: string;
        stagedAt?: string;
      };
      if (detail.stagedAt && Date.now() - Date.parse(detail.stagedAt) > 15 * 60_000) {
        // Late retry after a commit-then-crash: if this token's retraction
        // already landed, report success instead of expiring into a confusing
        // restage → "already retracted" dead end.
        const landed = await getRawCaptureByExternalId(tenantId, `retract:${item.id}`);
        if (landed) {
          try {
            await resolveReviewItem(item.id, tenantId, 'resolved', `retraction confirmed by ${subjectRef}`);
          } catch {
            /* advisory */
          }
          return { status: 'retracted', captureId: landed.retracts_capture_id, retractionId: landed.id };
        }
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'confirmation expired');
        throw new Error('confirmation expired — restage the retraction and confirm again');
      }
      if (!detail.captureId || !detail.reason) {
        throw new Error('staged retraction is malformed — restage with captureId + reason');
      }
      const target = await getRawCapture(detail.captureId);
      if (!target || target.tenant_id !== tenantId) throw new Error('capture not found');
      let retractionId: string;
      try {
        const row = await appendRawCapture({
          tenantId,
          channel: 'retraction',
          technicianRef: subjectRef,
          rawText: detail.reason,
          retractsCaptureId: target.id,
          // Copy the target's stamps so the retraction surfaces in the same
          // stamped lists its target does.
          customerId: target.customer_id,
          jobId: target.job_id,
          visitId: target.visit_id,
          externalId: `retract:${item.id}`,
          metadata: { retractedBy: subjectRef },
        });
        retractionId = row.id;
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // Two indexes can fire: our own externalId (this confirm's retry after
        // a crash between commit and consume → success) or the one-retraction-
        // per-target index (a concurrent retraction won → report, cancel token).
        const existing = (await findRetractionsFor([target.id]))[0];
        if (existing && existing.external_id === `retract:${item.id}`) {
          retractionId = existing.id;
        } else {
          await resolveReviewItem(item.id, tenantId, 'dismissed', 'already retracted by a concurrent confirm');
          throw new Error('this capture was already retracted — nothing was written twice');
        }
      }
      try {
        await resolveReviewItem(item.id, tenantId, 'resolved', `retraction confirmed by ${subjectRef}`);
      } catch {
        /* advisory — the retry path above treats the landed row as success */
      }
      return { status: 'retracted', captureId: target.id, retractionId };
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
      // Session teardown at deactivation (review finding): unlike the paired
      // account, a session cannot be "disabled" — and a live MANAGER session
      // carries manageConnections, which can mint a NEW connected account and
      // bypass the disable above for the whole grace period. Delete it now
      // (both tiers, uniform); the column is nulled so reactivation re-mints
      // with the person's CURRENT tier on the next 15-min sweep. Cost: the
      // sandbox's session mcp.url must be re-wired by the operator after a
      // reactivation (documented in Box_Setup_Stuff §0b). Advisory — the
      // expiry sweep retries leaked sessions every tick.
      try {
        await (deps.teardownSession ?? liveTeardownSession)(target);
      } catch {
        /* advisory — expiry retry pass is the backstop */
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
    case 'bind_telegram': {
      const ref = str('ref');
      if (!ref) throw new Error('ref is required');
      const telegramUserId = str('telegramUserId');
      // Text, digit-only, ≤20 (Telegram ids are ints; stored as text for JS
      // number-precision safety — see the migration). Only ever compared.
      if (!telegramUserId || !/^[0-9]{1,20}$/.test(telegramUserId)) {
        throw new Error(
          'telegramUserId must be the numeric Telegram user id — digits only, from @userinfobot',
        );
      }
      const target = await getTechnician(tenantId, ref);
      if (!target) throw new Error(`technician '${ref}' not found`);
      if (isInactiveState(target.state)) {
        throw new Error(`'${ref}' is deactivated — reactivate the seat first`);
      }
      // Reject an id already answering SOMEONE ELSE's sandbox; a self-hit is a
      // harmless re-bind of the same person. No DB uniqueness — this is the guard
      // (residual concurrent race accepted, same as the seat-cap trigger).
      const holder = await findTechnicianByTelegramUserId(tenantId, telegramUserId);
      if (holder && holder.ref !== ref) {
        throw new Error(
          `Telegram id ${telegramUserId} is already bound to '${holder.ref}' — ` +
            'check the id, or unbind them first',
        );
      }
      // Auto-claim a cold sandbox when the hire has none, so a chat-only bind
      // needs no operator. Recover a prior claim whose roster write failed
      // mid-flight (idempotent) before taking a fresh one. The claim of the pool
      // row still precedes the roster write (claim-first self-heals on retry via
      // getPoolRowByTechnician), but the sandbox and the Telegram id land in ONE
      // roster write — so a partial failure can never leave a claimed sandbox
      // with no binding, and it saves a round-trip.
      const patch: { telegram_user_id: string; host_id?: string; sandbox_ref?: string } = {
        telegram_user_id: telegramUserId,
      };
      let sandboxRef = target.sandbox_ref;
      if (!sandboxRef) {
        let pool = await getPoolRowByTechnician(target.id);
        if (!pool) {
          for (const free of await listFreeSandboxes(tenantId)) {
            const claimed = await claimSandbox(free.id, target.id);
            if (claimed) {
              pool = claimed;
              break;
            }
          }
        }
        if (!pool) {
          throw new Error('no free sandbox in the cold pool — contact support to add capacity');
        }
        patch.host_id = pool.host_id;
        patch.sandbox_ref = pool.sandbox_ref;
        sandboxRef = pool.sandbox_ref;
      }
      const previousTelegramUserId = target.telegram_user_id;
      await updateTechnician(target.id, patch);
      return {
        status: previousTelegramUserId ? 'rebound' : 'bound',
        ref,
        telegramUserId,
        sandboxRef,
        previousTelegramUserId,
        note: 'applies to the box within ~5 minutes',
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
      // Same live-token rule for a staged send: "resolved" here would read as
      // a confirmed send that never ran. Dismissing (= cancel) is legitimate.
      if (open.kind === 'pending_outbound_send' && resolution === 'resolved') {
        throw new Error(
          `this is a staged email send for '${open.subject_ref}' — confirm it via send_email, ` +
            `or dismiss it to cancel`,
        );
      }
      // Same rule for a staged field note: it commits only via
      // record_field_note's confirm call.
      if (open.kind === 'pending_field_note' && resolution === 'resolved') {
        throw new Error(
          `this is a staged field note for '${open.subject_ref}' — confirm it via ` +
            `record_field_note, or dismiss it to cancel`,
        );
      }
      // And for a staged retraction: it commits only via retract_capture.
      if (open.kind === 'pending_retraction' && resolution === 'resolved') {
        throw new Error(
          `this is a staged retraction for '${open.subject_ref}' — confirm it via ` +
            `retract_capture, or dismiss it to cancel`,
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
    // Tier-filtered surface: technician badges see exactly the 10 spine tools
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
