// Seats, pairing and the firm profile.
//
// One domain's slice of the spine's tool surface: the definitions it contributes
// to each tier's catalog, and the handler behind each name. Split out of
// src/mcp/server.ts on 2026-09-12 (research 2026-09-09
// code-graph-as-source-of-truth §6.1 fix 3) so that adding a tool here touches
// no file another feature is also editing.
//
// Tier membership is DECLARATIVE only: listing a tool under `admin` is what puts
// it in ADMIN_TOOL_NAMES, and the hub applies that gate by name before any
// handler here runs. A handler never checks a tier itself.
import {
  disablePairing as liveDisablePairing,
  enablePairing as liveEnablePairing,
} from '../../composio/offboarding.js';
import {
  teardownPersonSession as liveTeardownSession,
} from '../../composio/sessions.js';
import {
  PROFILE_STRING_FIELDS,
  annotateResolvedReviewItem,
  cancelSandboxRetirement as liveCancelRetirement,
  casTechnician,
  claimSandbox,
  dismissOpenObservationsForRef,
  findTechnicianByTelegramUserId,
  getOpenReviewItem,
  getPoolRowByTechnician,
  getTechnician,
  getTenantProfile,
  insertTechnician,
  isInactiveState,
  isSeatCapError,
  isUniqueViolation,
  listFreeSandboxes,
  listPoolRows,
  listTeam,
  profileEcho,
  profileGaps,
  requestSandboxRetirement as liveRequestRetirement,
  resolveOpenReviewItemFor,
  resolveReviewItem,
  setTechnicianSkills,
  updateTechnician,
  upsertOpenReviewItem,
  upsertTenantProfile,
} from '../../db/index.js';
import type {
  LicenseNumber,
  TechnicianTier,
  TenantProfilePatch,
} from '../../db/index.js';
import {
  TIERS,
  resolveScheduleInputTarget,
  seatCapMessage,
  slugify,
} from './shared.js';
import type {
  StagedSeatDetail,
} from './shared.js';
import type {
  DomainTools,
  ToolContext,
} from './types.js';

const ADMIN_TOOLS = [
  {
    name: 'add_technician_seat',
    description:
      'Add a person to the team roster (manager only) — TWO-STEP, because it is not ' +
      'reversible: it mints a permanent never-reused ref from the display name (e.g. ' +
      '"Jane Doe" → jane-doe) and occupies one purchased seat of the tier. First call with ' +
      'displayName (+ optional tier): NOTHING is added; you get {status:"needs_confirmation", ' +
      'confirmId} with the minted ref. Show the manager; only on their explicit yes call ' +
      'again with ONLY confirmId — that returns the roster row. Fails if no seat is free or ' +
      'the ref is already taken (disambiguate with a middle name or employee id). ' +
      'Pass seatExempt:true to add a SCHEDULE-ONLY person (e.g. a part-timer/helper) who ' +
      'occupies NO seat: they can be booked on visits and appear on the board, but can NEVER ' +
      'have an assistant, Telegram access, or an email pairing (technician tier only).',
    inputSchema: {
      type: 'object',
      properties: {
        displayName: { type: 'string', description: "The person's full name. First call only." },
        tier: { type: 'string', enum: TIERS, description: 'Defaults to technician. First call only.' },
        seatExempt: {
          type: 'boolean',
          description:
            'true = add a schedule-only person who occupies NO seat: bookable on visits and ' +
            'visible on the board, but can NEVER have an assistant, Telegram, or email ' +
            'pairing. First call only.',
        },
        confirmId: { type: 'string', description: 'Set ONLY on the confirming second call.' },
      },
      required: [],
    },
  },
  {
    name: 'deactivate_technician_seat',
    description:
      'Deactivate a team member (manager only). Two-step: first call returns ' +
      '{status:"needs_confirmation", confirmId} — confirm with the person, then call again ' +
      'with the same ref plus confirmId. Frees the seat immediately (a schedule-only person ' +
      'occupies NO seat, so deactivating them frees nothing); history stays attributed. ' +
      "If they have an assistant sandbox, confirming also permanently destroys it (including " +
      'its chat memory) and recycles the slot into the pool as a fresh blank.',
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
  // (`get_connect_link` stood here until 2026-09-19, when the operator moved
  // email connections out of the manager's bot and onto a settings page that
  // is not built yet: "For now, let's get rid of email connections from the
  // manager's bot." The pairing machinery it drove — createConnectLink,
  // checkPairing, unpair — stays in src/composio/pairing.ts for that page.)
  {
    name: 'bind_telegram',
    description:
      "Connect a team member to their Telegram account (manager only). Give the roster ref and " +
      "the person's NUMERIC Telegram user id (they get it from @userinfobot). Their agent sandbox " +
      "then answers only that Telegram account. If the person has no sandbox yet, one is claimed " +
      "automatically from the cold pool. The binding reaches the box within ~5 minutes. Re-call " +
      "to fix a wrong id — it returns the previous value. ALWAYS relay botUsername from the " +
      "result to the manager: the person must open that bot in Telegram and send /start " +
      "themselves (bots cannot message first). If botUsername is null, the operator has not " +
      "recorded this sandbox's bot handle — tell the manager to ask their operator for it; " +
      "never guess a handle. Schedule-only people (added with seatExempt) are refused — they " +
      "cannot have an assistant.",
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
    name: 'list_team',
    description:
      'List the team roster (manager only): ref, display name, tier, state, seatExempt (true = ' +
      'schedule-only person, no seat/assistant), skills (their CURRENT skill list — read this ' +
      'BEFORE filtering by skill or calling set_technician_skills; [] = skills unknown, never ' +
      'excluded), availabilityConfigured (false = no working pattern yet — the scheduler cannot ' +
      'book them until set_availability), sandbox assignment, ' +
      "and botUsername — the Telegram bot (@handle) each person's agent answers on. USE THIS to " +
      'answer "which bot does X use / talk to?" — never inspect configs or guess. botUsername ' +
      'null means the handle is not on record: tell the manager to ask their operator — EXCEPT ' +
      'for seatExempt rows, where null is structural (a schedule-only person can never have a ' +
      'bot; never send the manager to an operator for one).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_technician_skills',
    description:
      "REPLACE a team member's skill list (manager only), e.g. [\"boilers\",\"gas-line\"]. " +
      'Done immediately in ONE call — echo the stored list. Free vocabulary, stored ' +
      'lowercase. Skills are OPTIONAL: an empty/unset list means "unknown" and NEVER excludes ' +
      'the person from scheduling — only a non-empty list that lacks a required skill does. ' +
      'This call replaces the whole list, so include existing skills when adding one (see ' +
      'list_team for the current list).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'The roster ref.' },
        skills: {
          type: 'array',
          items: { type: 'string' },
          description: 'The FULL skill list (replaces the old one). [] = clear to "unknown".',
        },
      },
      required: ['ref', 'skills'],
    },
  },
  {
    name: 'set_firm_profile',
    description:
      "Set the firm's business-identity profile (manager only) — what customer-facing " +
      'documents (invoices, estimates) will print: business/legal name, address, phone, ' +
      'email, contractor license numbers, and a disclosure footer. ONE call, commits ' +
      'immediately — pass any subset of fields and only those change (null clears a field); ' +
      'call with NO fields to just see the current profile. The reply echoes the full saved ' +
      'profile plus gaps (likely-required fields still missing) — relay BOTH to the manager. ' +
      'Every field is optional: display rules are state-specific, so gaps warn, never block. ' +
      'licenseNumbers is a LIST of {label, number} because firms hold several (e.g. ' +
      "{label: 'TX TACL', number: 'TACLA12345E'}), and setting it REPLACES the whole list. " +
      'State-mandated invoice wording goes in disclosureFooter — for Texas, TDLR requires ' +
      'the license number AND its disclosure paragraph on invoices/proposals; offer this ' +
      "template and have the manager verify current wording: 'Regulated by The Texas " +
      'Department of Licensing and Regulation, P.O. Box 12157, Austin, TX 78711, ' +
      "1-800-803-9202, www.tdlr.texas.gov'.",
    inputSchema: {
      type: 'object',
      // Key-closed: unknown/misspelled fields are refused at dispatch, never
      // silently dropped. minLength pins that '' is refused — null, not the
      // empty string, is the clear.
      additionalProperties: false,
      properties: {
        displayName: {
          type: ['string', 'null'],
          minLength: 1,
          description: 'Trading/DBA name as it should print. Pass null to clear any field.',
        },
        legalName: {
          type: ['string', 'null'],
          minLength: 1,
          description: 'Registered legal entity name, if it differs from displayName.',
        },
        addressLine1: { type: ['string', 'null'], minLength: 1, description: 'Street address.' },
        addressLine2: { type: ['string', 'null'], minLength: 1, description: 'Suite/unit, if any.' },
        city: { type: ['string', 'null'], minLength: 1 },
        state: {
          type: ['string', 'null'],
          minLength: 1,
          description: '2-letter state code, e.g. TX (stored uppercase; full names refused).',
        },
        postalCode: { type: ['string', 'null'], minLength: 1 },
        phone: { type: ['string', 'null'], minLength: 1, description: 'Business phone as printed.' },
        email: { type: ['string', 'null'], minLength: 1, description: 'Business email as printed.' },
        licenseNumbers: {
          type: ['array', 'null'],
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', minLength: 1, description: "Which license, e.g. 'TX TACL'." },
              number: {
                type: 'string',
                minLength: 1,
                description: 'The license number exactly as issued.',
              },
            },
            required: ['label', 'number'],
          },
          description:
            'FULL replacement of the license list — include every license each time. ' +
            'null (or []) clears the list.',
        },
        disclosureFooter: {
          type: ['string', 'null'],
          minLength: 1,
          description:
            'Free-text footer printed on customer documents — state-mandated disclosure ' +
            'wording lives here. null clears.',
        },
      },
      required: [],
    },
  },
];

async function handleAddTechnicianSeat(toolCtx: ToolContext): Promise<unknown> {
  const { args, identity, tenantId, str } = toolCtx;
      // Two-step (doctrine 2026-07-17): the mint is IRREVERSIBLE — a permanent
      // never-reused ref plus a burned seat — so it confirms, exactly the class
      // the one-shot schedule ops are not. Same token machinery as book_visit.
      const subjectRef = identity.technicianRef;
      const confirmId = str('confirmId');
      if (!confirmId) {
        // STAGE — nothing is inserted here.
        const displayName = str('displayName')?.trim();
        if (!displayName) throw new Error('displayName is required');
        const tierArg = str('tier');
        if (tierArg && !TIERS.includes(tierArg as TechnicianTier)) {
          throw new Error(`invalid tier: ${tierArg}`);
        }
        const tier: TechnicianTier = (tierArg as TechnicianTier | undefined) ?? 'technician';
        // Non-boolean must be rejected, not coerced — the SDK does not validate
        // args against inputSchema (the get_schedule precedent).
        if (args.seatExempt !== undefined && typeof args.seatExempt !== 'boolean') {
          throw new Error('seatExempt must be a boolean');
        }
        const seatExempt = args.seatExempt === true;
        // A seat-exempt manager is meaningless (managers exist to run agents)
        // and would silently dodge the manager cap.
        if (seatExempt && tier === 'manager') {
          throw new Error(
            'seatExempt applies to technician-tier rows only — a manager needs a real seat',
          );
        }
        const ref = slugify(displayName);
        // Slug alphabet is ASCII: a fully non-Latin name slugs to '' — ask for a
        // romanized form rather than failing with a false "no letters" claim.
        if (!ref) {
          throw new Error(
            'displayName must contain ASCII letters or digits — use a romanized spelling to mint the ref',
          );
        }
        // Stage-time dup pre-check so the common mistake fails BEFORE a yes;
        // the cap (a moving target) surfaces at confirm via the insert itself.
        if (await getTechnician(tenantId, ref)) {
          throw new Error(
            `ref '${ref}' is taken — disambiguate (add a middle name or employee id)`,
          );
        }
        await resolveOpenReviewItemFor(
          tenantId,
          'pending_seat_add',
          subjectRef,
          'dismissed',
          'superseded by a new seat request',
        );
        const item = await upsertOpenReviewItem({
          tenantId,
          kind: 'pending_seat_add',
          subjectRef,
          detail: { ref, displayName, tier, seatExempt, stagedAt: new Date().toISOString() },
        });
        // Echo the ITEM's staged detail, not local state (racing stages — same
        // rule as send_email/book_visit): what is SHOWN must be what a confirm
        // of this confirmId would mint. No local fallback — a partial detail
        // shown as local values would display one ref while the token mints
        // another, so refuse it loudly instead (mirrors the confirm guard).
        const staged = (item.detail ?? {}) as StagedSeatDetail;
        if (!staged.ref || !staged.displayName || !staged.tier) {
          throw new Error('staged seat is malformed — call add_technician_seat again to restage');
        }
        // Missing seatExempt reads as FALSE here AND at confirm — a stale
        // pre-feature detail shape previews exactly what it will commit.
        const stagedExempt = staged.seatExempt === true;
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          preview: {
            ref: staged.ref,
            displayName: staged.displayName,
            tier: staged.tier,
            seatExempt: stagedExempt,
          },
          note: stagedExempt
            ? `Nothing was added. This will NOT occupy a seat — schedule-only person (no ` +
              `assistant, no Telegram, no email). It still mints the permanent ref ` +
              `'${staged.ref}'. Show the manager; on their explicit yes call again with ` +
              `ONLY confirmId.`
            : `Nothing was added. This will occupy one ${staged.tier} seat and mint the ` +
              `permanent ref '${staged.ref}'. Show the manager; on their explicit yes ` +
              `call again with ONLY confirmId.`,
        };
      }
      // CONFIRM — guarded token lookup → expiry → CONSUME FIRST → insert.
      const item = await getOpenReviewItem(confirmId, tenantId, {
        kind: 'pending_seat_add',
        subjectRef,
      });
      if (!item) {
        throw new Error('confirmation not found — call add_technician_seat again with displayName to restage');
      }
      const d = (item.detail ?? {}) as StagedSeatDetail;
      if (d.stagedAt && Date.now() - Date.parse(d.stagedAt) > 15 * 60_000) {
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'confirmation expired');
        throw new Error('confirmation expired — restage the seat and confirm again');
      }
      if (!d.ref || !d.displayName || !d.tier) {
        throw new Error('staged seat is malformed — restage with displayName');
      }
      const consumed = await resolveReviewItem(
        item.id,
        tenantId,
        'resolved',
        `seat confirmed by ${subjectRef}`,
      );
      if (!consumed) {
        throw new Error('already confirmed or cancelled — no seat was added by this call');
      }
      // Missing key = a token staged before this feature deployed — commit it
      // as the seat-occupying add it was staged as; never guess exemption.
      // (seatExempt implies state 'active' — derived inside insertTechnician.)
      try {
        const created = await insertTechnician({
          tenantId,
          ref: d.ref,
          displayName: d.displayName,
          tier: d.tier,
          seatExempt: d.seatExempt === true,
        });
        // Availability is a REQUIRED onboarding step (user decision
        // 2026-07-20): open the standing obligation, pairing_verification
        // style. Advisory — the seat IS added; a failed reminder must not
        // report the add as failed.
        try {
          await upsertOpenReviewItem({
            tenantId,
            kind: 'availability_setup',
            subjectRef: created.ref,
            detail: { ref: created.ref, displayName: created.display_name },
          });
        } catch {
          /* advisory */
        }
        // AN ALLOWLIST, not `...created`: this result goes into the model's
        // context, and the row carries badge_hash, the Composio handles and the
        // Telegram id (list_team projects those out too). A column added later
        // stays hidden until someone decides the model should see it.
        return {
          id: created.id,
          ref: created.ref,
          display_name: created.display_name,
          tier: created.tier,
          state: created.state,
          seat_exempt: created.seat_exempt,
          skills: created.skills,
          service_cities: created.service_cities,
          sandbox_ref: created.sandbox_ref,
          created_at: created.created_at,
          note:
            `REQUIRED next step: ask the manager for ${created.display_name}'s working days ` +
            `and call set_availability now. Until a pattern is set, the scheduler will ` +
            `never book ${created.display_name} (manual booking still works, with a warning).`,
        };
      } catch (err) {
        // Cap first: at capacity the BEFORE-trigger fires before the unique
        // constraint, so a duplicate-at-cap reports the cap (observed live).
        const msg = isSeatCapError(err)
          ? `no free ${d.tier} seats — deactivate someone or purchase a seat`
          : isUniqueViolation(err)
            ? `ref '${d.ref}' is taken — disambiguate (add a middle name or employee id)`
            : err instanceof Error
              ? err.message
              : String(err);
        try {
          await annotateResolvedReviewItem(
            confirmId,
            tenantId,
            `confirmed but seat add FAILED (${msg}) — no seat was added`,
          );
        } catch {
          /* advisory */
        }
        throw new Error(`seat NOT added: ${msg} — restage to try again`);
      }
}

// A staged deactivation is live for 15 minutes — the life every staged token
// has (add_technician_seat's confirm, above). A row with no stagedAt predates
// the expiry and is never "expired".
const DEACTIVATION_TOKEN_MS = 15 * 60_000;
function isExpiredToken(item: { detail: unknown }): boolean {
  const stagedAt = (item.detail as { stagedAt?: unknown } | null)?.stagedAt;
  return typeof stagedAt === 'string' && Date.now() - Date.parse(stagedAt) > DEACTIVATION_TOKEN_MS;
}

async function handleDeactivateTechnicianSeat(toolCtx: ToolContext): Promise<unknown> {
  const { deps, identity, tenantId, str } = toolCtx;
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
          detail: { requestedBy: identity.technicianRef, stagedAt: new Date().toISOString() },
        });
        await resolveReviewItem(stale.id, tenantId, 'resolved', 'already deactivated');
        return { status: 'already_deactivated', ref };
      }
      const confirmId = str('confirmId');
      if (!confirmId) {
        // Two-step confirm, persisted in review_items so any replica can serve
        // the confirming call (stateless server). Repeat calls return the same
        // confirmId via the one-open-item dedup — while it is still LIVE.
        //
        // EXPIRY (2026-09-19). A staged deactivation lapses after 15 minutes like
        // every other token; until the review queue was retired,
        // `resolve_review dismissed` was its only cancel, and without one a
        // forgotten confirmId stayed valid forever. The dedup would hand an
        // expired row straight back, and the manager's "yes" would then be
        // refused — so an expired open row is dismissed here and a fresh one
        // staged. A live row is returned untouched.
        const stage = () =>
          upsertOpenReviewItem({
            tenantId,
            kind: 'pending_deactivation',
            subjectRef: ref,
            detail: { requestedBy: identity.technicianRef, stagedAt: new Date().toISOString() },
          });
        let item = await stage();
        if (isExpiredToken(item)) {
          await resolveReviewItem(item.id, tenantId, 'dismissed', 'confirmation expired');
          item = await stage();
        }
        // Destruction is part of what the manager is confirming — say it in
        // THE one confirmation (no second prompt), and only when confirming
        // will actually destroy something: retirement stamps POOL rows, so a
        // legacy assignment (roster sandbox_ref, no pool row) gets no warning
        // — and no destruction. The pool row also catches the inverse edge
        // (claim landed, roster patch lost): warn, because it WILL recycle.
        const poolRow = await getPoolRowByTechnician(target.id);
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          ref,
          displayName: target.display_name,
          ...(poolRow &&
            !poolRow.retired_at && {
              note:
                `confirming permanently destroys ${target.display_name}'s assistant and its ` +
                'chat memory; the sandbox is recycled into your pool as a fresh blank within ~15 minutes',
            }),
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
      // The same 15-minute life every other token has (the staging comment
      // above). A legacy row with no stagedAt passes, as it always did.
      if (isExpiredToken(item)) {
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'confirmation expired');
        throw new Error('confirmation expired — call again without confirmId to restart');
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
      // Mark their sandbox for recycling — the box destroys + re-pools it on
      // its next pull (reactivation during grace cancels a still-pending
      // request). Advisory: nothing re-drives a missed stamp automatically;
      // support can stamp the row by hand.
      try {
        await (deps.requestRetirement ?? liveRequestRetirement)(target.id);
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

async function handleReactivateTechnicianSeat(toolCtx: ToolContext): Promise<unknown> {
  const { deps, tenantId, str } = toolCtx;
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
      // 'active' would be a dead-end — the pairing path (checkPairing; the
      // connect link lives on the settings page from 2026-09-19) only acts on
      // invited, so their mailbox could never be paired (review finding).
      // Seat-exempt rows are the exception: they NEVER pair, so 'invited'
      // would be a permanent stuck-looking state — they live in 'active'.
      const restoredState =
        target.seat_exempt || target.composio_connected_account_id ? 'active' : 'invited';
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
      // The grace-period heads-up is moot now. It is an observation since the
      // review queue's retirement (2026-09-19), keyed per episode, so a second
      // deactivation raises its own — this only stops the planner telling a
      // manager about a removal that has just been undone. Advisory close.
      try {
        await dismissOpenObservationsForRef(tenantId, 'offboarding_reminder', ref, 'reactivated during the grace period');
      } catch {
        /* advisory */
      }
      // Cancel a still-pending sandbox retirement — the undo must land before
      // the box's next pull destroys their assistant. Advisory; if nothing was
      // pending AND no pool row points at them, there is no live sandbox (it
      // was already recycled, or none was ever claimed) — say so and route the
      // manager to bind_telegram rather than leaving them to discover it.
      let hasSandbox = true;
      try {
        await (deps.cancelRetirement ?? liveCancelRetirement)(target.id);
        // Pool row = live claim; roster sandbox_ref alone = legacy assignment
        // (pre-pool rows have no pool row but a very alive sandbox). Only when
        // BOTH are gone is there provably nothing to answer on.
        hasSandbox =
          target.sandbox_ref !== null || (await getPoolRowByTechnician(target.id)) !== null;
      } catch {
        /* advisory — err on silence over a wrong "gone" note */
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
      const notes: string[] = [];
      if (restoredState === 'invited') {
        notes.push(
          'no mailbox was ever paired — pairing a mailbox moves to the settings page, which is ' +
            'not built yet',
        );
      }
      // Seat-exempt rows NEVER have a sandbox and bind_telegram refuses them —
      // pushing this note would instruct the manager into a dead end.
      if (!hasSandbox && !target.seat_exempt) {
        notes.push(
          'no live assistant sandbox for this person (a previous one may have been recycled) — ' +
            'use bind_telegram to claim a fresh one',
        );
      }
      return {
        status: 'reactivated',
        ref,
        state: restoredState,
        pairingRestored,
        ...(notes.length > 0 && { note: notes.join('; ') }),
      };
}

async function handleBindTelegram(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str } = toolCtx;
      const ref = str('ref');
      if (!ref) throw new Error('ref is required');
      const telegramUserId = str('telegramUserId');
      // Text, digit-only, ≤20 (Telegram ids are ints; stored as text for JS
      // number-precision safety — see the migration). Only ever compared.
      //
      // POSITIVE and at least five digits, not merely "digits". The old rule was
      // /^[0-9]{1,20}$/, which accepts '0' — and '0' reached a live row on
      // 2026-09-19. That is WORSE than leaving the row unbound: the push leg's
      // liveness gate only asks whether the field is set, so the row is SERVED,
      // the send fails at Telegram, and the row burns its attempts until it
      // freezes. An unbound row is skipped and costs nothing. A validator for an
      // identifier must reject the impossible values, not just the wrong type.
      if (!telegramUserId || !/^[1-9][0-9]{4,19}$/.test(telegramUserId)) {
        throw new Error(
          'telegramUserId must be the numeric Telegram user id — a positive number of at ' +
            "least 5 digits, from @userinfobot ('0' and leading zeros are not accounts)",
        );
      }
      const target = await getTechnician(tenantId, ref);
      if (!target) throw new Error(`technician '${ref}' not found`);
      // Schedule-only fence FIRST (user decision 2026-07-19): a seat-exempt
      // person is a name on the schedule and nothing more — binding would
      // auto-claim an agent sandbox they must not have. Before the state
      // check: exemption is permanent, so "reactivate the seat first" would
      // steer the manager into a pointless (and board-visible) reactivation
      // that ends at this same refusal.
      if (target.seat_exempt) {
        throw new Error(
          `'${ref}' is schedule-only (no seat) — they cannot have an assistant or Telegram access`,
        );
      }
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
      // The bot handle is the only way the person can OPEN the chat (bots can't
      // message first) — resolve it from the pool row on both paths. Legacy
      // host assignments (no pool row) and pre-handle registrations yield null, which
      // the tool description turns into "ask your operator", never a guess.
      let botUsername: string | null = null;
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
          // Honest emptiness: a swap-in-progress means a blank is minutes away
          // (the recycler is rebuilding the deactivated member's sandbox) —
          // "contact support" is only true when nothing is in flight.
          const recycling = (await listPoolRows(tenantId)).some(
            (r) => r.retire_requested_at && !r.retired_at,
          );
          throw new Error(
            recycling
              ? 'no free sandbox yet — one is being recycled and should be ready in ~15 minutes; try again then'
              : 'no free sandbox in the cold pool — contact support to add capacity',
          );
        }
        patch.host_id = pool.host_id;
        patch.sandbox_ref = pool.sandbox_ref;
        sandboxRef = pool.sandbox_ref;
        botUsername = pool.bot_username;
      } else {
        botUsername = (await getPoolRowByTechnician(target.id))?.bot_username ?? null;
      }
      const previousTelegramUserId = target.telegram_user_id;
      await updateTechnician(target.id, patch);
      return {
        status: previousTelegramUserId ? 'rebound' : 'bound',
        ref,
        telegramUserId,
        sandboxRef,
        botUsername,
        previousTelegramUserId,
        note:
          'applies to the box within ~5 minutes' +
          (botUsername
            ? `; the person must open ${botUsername} in Telegram and send /start`
            : '; no bot handle on record for this sandbox — ask your operator which bot to open'),
      };
}

async function handleListTeam(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId } = toolCtx;
      // Roster facts only — Composio account/trigger ids stay server-side.
      // botUsername rides along so a manager can re-ask "which bot does X use?"
      // any time, not just in the bind-time reply (null = handle not on record).
      const poolBotByTechnician = new Map(
        (await listPoolRows(tenantId))
          .filter((p) => p.technician_id)
          .map((p) => [p.technician_id, p.bot_username]),
      );
      // A named object, never a bare array (retrieval layer 4): arrays get no
      // `now` rider.
      return {
        team: (await listTeam(tenantId)).map((t) => ({
          ref: t.ref,
          displayName: t.display_name,
          tier: t.tier,
          state: t.state,
          seatExempt: t.seat_exempt,
          skills: t.skills,
          availabilityConfigured: t.availability !== null,
          sandboxRef: t.sandbox_ref,
          botUsername: poolBotByTechnician.get(t.id) ?? null,
        })),
      };
}

async function handleSetTechnicianSkills(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str } = toolCtx;
      const ref = str('ref');
      if (!ref) throw new Error('ref is required');
      if (!Array.isArray(args.skills) || args.skills.some((s) => typeof s !== 'string')) {
        throw new Error('skills must be an array of strings (may be empty to clear)');
      }
      const target = await resolveScheduleInputTarget(tenantId, ref);
      const updated = await setTechnicianSkills(target.id, args.skills as string[]);
      return {
        status: 'ok',
        ref,
        skills: updated.skills,
        note:
          updated.skills.length === 0
            ? `${target.display_name}'s skill list is now empty — they count as "skills ` +
              'unknown" and are never excluded from scheduling on that basis. Tell the manager.'
            : `${target.display_name}'s skills are now: ${updated.skills.join(', ')} (full ` +
              'replacement). Tell the manager exactly this.',
      };
}

async function handleSetFirmProfile(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId } = toolCtx;
      // KEY-closed surface: unknown/misspelled arg names are REFUSED, never
      // silently dropped (review finding) — with required:[] and the no-field
      // read mode below, a call made of unrecognized keys (snake_case, typos)
      // would otherwise flip into a success-shaped read while the manager is
      // told the profile was saved. The roster is imported from the typed
      // layer, so it cannot drift from what the patch actually accepts. VALUE
      // validation (string-ness, empty strings, state format, license entry
      // shape) lives in that typed layer — the single write-side guard for
      // every surface; its errors are instructive, surface them verbatim.
      const knownKeys = [...PROFILE_STRING_FIELDS, 'licenseNumbers'];
      const unknown = Object.keys(args).filter((k) => !knownKeys.includes(k as never));
      if (unknown.length > 0) {
        throw new Error(
          `unknown field(s): ${unknown.join(', ')} — the profile fields are ` +
            knownKeys.join(', '),
        );
      }
      const patch: TenantProfilePatch = {};
      for (const k of PROFILE_STRING_FIELDS) {
        if (args[k] !== undefined) patch[k] = args[k] as string | null;
      }
      if (args.licenseNumbers !== undefined) {
        patch.licenseNumbers = args.licenseNumbers as LicenseNumber[] | null;
      }
      // No fields = a READ: echo the current profile without writing (plan
      // decision: the echo IS the get — no separate get tool).
      const saved =
        Object.keys(patch).length === 0
          ? await getTenantProfile(tenantId)
          : await upsertTenantProfile(tenantId, patch);
      const gaps = profileGaps(saved);
      return {
        status: 'ok',
        profile: saved ? profileEcho(saved) : null,
        ...(gaps.length > 0 ? { gaps } : {}),
        note:
          (saved === null
            ? 'No profile recorded yet — every field is still to be set. '
            : Object.keys(patch).length === 0
              ? 'Current profile, nothing changed. '
              : 'One-shot: saved — correctable the same way (set a new value, or null to ' +
                'clear). Read the profile back to the manager exactly as stored. ') +
          (gaps.length > 0
            ? 'Mention the gaps: these fields are commonly required on invoices and are ' +
              'still missing.'
            : 'No gaps — the common invoice-header fields are all present.'),
      };
}

export const rosterTools = {
  domain: 'roster',
  admin: ADMIN_TOOLS,
  handlers: {
    add_technician_seat: handleAddTechnicianSeat,
    deactivate_technician_seat: handleDeactivateTechnicianSeat,
    reactivate_technician_seat: handleReactivateTechnicianSeat,
    bind_telegram: handleBindTelegram,
    list_team: handleListTeam,
    set_technician_skills: handleSetTechnicianSkills,
    set_firm_profile: handleSetFirmProfile,
  },
} satisfies DomainTools;
