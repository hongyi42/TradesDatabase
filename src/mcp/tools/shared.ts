// Helpers shared by the domain tool modules in this directory, lifted out of
// src/mcp/server.ts on 2026-09-12 when the tool registry was split by domain
// (research 2026-09-09 code-graph-as-source-of-truth §6.1 fix 3). Nothing here
// changed: these are the same functions, moved so a domain module can reach them
// without importing the hub.
//
// Four of them — oneShotNoteStamp, refuseNameAsAddress, attributeAnswerToGap and
// openQuestionsFor — are part of server.ts's public surface and are re-exported
// from there, so every existing importer is unaffected.

import {
  PINGED_KINDS,
  findFoldImpact,
  findRetractionsFor,
  getCustomer,
  getTechnician,
  isFactBundle,
  isInactiveState,
  isUniqueViolation,
  listAskedNudgesForTechnicianJob,
  listObservationsByStatus,
  setNudgeAnsweredBy,
} from '../../db/index.js';
import type {
  CallerTier,
  CaptureChannel,
  FoldImpact,
  Json,
  TechnicianTier,
} from '../../db/index.js';
import type {
  ExtractedFields,
} from '../../writePath/extract.js';
import type {
  ToolContext,
} from './types.js';
import type {
  MatchResult,
} from '../../writePath/identityMatch.js';
import {
  recordFieldNote,
} from '../../writePath/recordFieldNote.js';
import type {
  ResolvedIdentity,
} from '../../writePath/recordFieldNote.js';
import type {
  RequestIdentity,
} from '../identity.js';
import {
  createHash,
} from 'node:crypto';

export const TECH_CHANNELS: CaptureChannel[] = ['technician_voice', 'technician_note', 'technician_photo'];
export const TIERS: TechnicianTier[] = ['manager', 'technician'];

// Who is asking, for the retrieval layer's tier gate. From the VERIFIED
// identity the hub established, never from a tool argument: the planner is the
// `spine:` namespace, a manager is an ACTIVE manager roster row (the same
// predicate as the admin-tool gate), and everyone else is a technician.
export const callerTierOf = (ctx: ToolContext): CallerTier =>
  ctx.identity.technicianRef.startsWith('spine:')
    ? 'planner'
    : ctx.activeManager
      ? 'manager'
      : 'technician';

// GROUNDING_BARE=1 (date-eval bare-clock arm, 2026-08-23): the model's ONLY
// date help is the firm-local `now` rider. Read at module load — the flag
// rides a deploy — and it implies GROUNDING_LEAN (see leanGrounding). It
// (a) hides resolve_date from tools/list (dispatch stays alive: the planner's
// loop still carries the tool), and (b) removes the date-discipline steering
// from tool descriptions, keeping only schema facts. Never set in normal
// operation.
export const GROUNDING_BARE = process.env.GROUNDING_BARE === '1';


// One hygiene strip for every office-channel string a seat writes (final
// review: three inline copies were already drifting): these bodies are
// rendered verbatim into the planner's prompt, so control characters and
// whitespace runs must not fake structure there.
export const cleanOfficeText = (v: string): string =>
  v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

// Shared target resolution for the schedule-input verbs (set_availability,
// time off, skills): known roster ref, not inactive. Deliberately NO
// seat-exempt fence — schedule-only people are exactly who these inputs make
// schedulable (the identity verbs fence exempt rows; these are not identity
// verbs). Mirrors booking.ts's resolveTechnician contract.
export async function resolveScheduleInputTarget(tenantId: string, ref: string) {
  const target = await getTechnician(tenantId, ref);
  if (!target) throw new Error(`technician '${ref}' not found on the roster`);
  if (isInactiveState(target.state)) {
    throw new Error(`technician '${ref}' is deactivated — reactivate the seat first`);
  }
  return target;
}

// Mint a ref from a display name: lowercase, non-alphanumeric runs → '-'. The
// output alphabet is [a-z0-9-], so a minted ref can never collide with the
// reserved `connector:` namespace.
export function slugify(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Audit channels: L1 rows that exist to hold the ACTOR accountable for an
// agent-performed action. Self-retraction would defeat their purpose (recorded
// exception 2026-07-04: the audit matters most when the action was personal or
// inappropriate), so retracting one requires a manager badge even for its
// author — logIngest and the send_email capture stamp the acting person's own
// roster ref, so an author-only rule would allow self-cleanup (review finding).
// Retraction on these is MANAGER-ONLY, even for their author: the send capture
// and logIngest stamp the acting person's own roster ref, so an author-only rule
// would let someone scrub their own audit trail from default views.
// RUNG 10B.3 WIDENED WHAT `outbound_email` MEANS: it is no longer only what the
// agent sent on someone's behalf — a manager's own hand-typed Gmail reply now
// arrives on this channel too. The manager-only rule is kept over it deliberately
// (the firm's outbound word to a customer is exactly the record a mistake would
// want removed), with one consequence worth stating: a technician-tier seat
// cannot retract their own captured reply, including one the classifier passed
// as work in error. A manager can.
export const AUDIT_CHANNELS = new Set<CaptureChannel>(['outbound_email', 'agent_action']);

// The staged copy of a seat add (review_items.detail, kind pending_seat_add).
// ONE shape for the stage echo and the confirm read, so the two can never
// drift (the StagedNoteDetail precedent). All fields optional: detail is
// persisted JSON — pre-feature rows may lack newer keys (seatExempt missing
// reads as false at BOTH sites, so preview == commit for any shape).
export interface StagedSeatDetail {
  ref?: string;
  displayName?: string;
  tier?: TechnicianTier;
  seatExempt?: boolean;
  stagedAt?: string;
}

// The staged copy of a field note (review_items.detail, kind pending_field_note).
// The staged copy is the note of record: commit reads ONLY this — never fresh
// args — so what the technician confirmed is exactly what lands.
export interface StagedNoteDetail {
  text: string | null;
  blobPath: string | null;
  channel: CaptureChannel;
  extracted: ExtractedFields;
  stagedAt: string;
  resolved?: ResolvedIdentity;
  // The identity question, stored so the needs_identity response can echo the
  // ITEM's question — racing stages may return the other call's row, and the
  // question must describe the note that will actually commit (review finding).
  suggestion?: { address: string; visitId: string };
  identityReason?: string;
}

// The one-shot path's idempotency stamp (plan ②, 2026-08-21). The staged path
// gets its stamp for free — `note:<confirmId>` — because a review item exists to
// name it. A one-shot call has no item, so a retried tool call would write a
// SECOND permanent L1 row and a SECOND visit, and L1 has no delete.
//
// Every field that could distinguish two legitimately-different notes is in the
// key, because a collision is a note SILENTLY LOST:
//   * channel/text/blobPath — a note may be a photo with no text at all, so
//     hashing text alone makes two different photos for one customer collide.
//   * identity — "done" for the Hendersons and "done" for the Duartes are not
//     the same note.
// There is deliberately NO date component: it would buy a rare same-note
// re-record at the cost of a midnight-straddle double write, and identity
// already separates the cases that matter. The accepted consequence is that a
// genuinely repeated identical note about the same customer comes back
// `duplicate` — which the caller must report honestly, never as `recorded`.
//
// Only ever called where identity resolved to an EXISTING customer/job, so
// there is no createFrom limb to get wrong.
export function oneShotNoteStamp(input: {
  tenantId: string;
  technicianRef: string;
  channel: CaptureChannel;
  resolved: ResolvedIdentity;
  text: string | null;
  blobPath: string | null;
}): string {
  // BOTH ids, not customerId-or-jobId: two notes on two jobs of the same
  // customer with identical text ("done, all good") are different notes, and a
  // collision does not merely skip a write — it answers `duplicate`, so the
  // second note is silently never recorded and the agent reports success.
  const identity = `${input.resolved.customerId ?? ''}|job:${input.resolved.jobId ?? ''}`;
  const h = createHash('sha256')
    .update(
      [
        input.tenantId,
        input.technicianRef,
        input.channel,
        identity,
        input.text ?? '',
        input.blobPath ?? '',
      ].join('\u0000'),
    )
    .digest('hex');
  return `note:${h}`;
}

// MatchResult → the staged resolution, or undefined while identity is unknown.
// A confirmed answer that matched no existing customer resolves to create-new;
// the FULL draft is built here (schedule prefill > extracted/confirmed) so the
// preview shows exactly the customer commit will create.
// AN ADDRESS IS WHERE THEY ARE, NOT WHO THEY ARE (rung 10b.2).
//
// Two doors mint a customer from a name plus an address — `record_field_note`'s
// confirm (via resolutionFrom) and `record_caller`'s `newCustomer` — and BOTH
// need this, which is why it is a function rather than an inline check. The
// first version guarded only the note door; rung 10b.2 had just finished telling
// the manager's seat to stop using that one, so the guard was on the door nobody
// takes and absent from the door everybody now takes (review finding).
//
// Why it exists: on the note path `address` does double duty — it both UNLOCKS
// the mint and becomes `address_line1` unchecked — so a caller with no address
// to give is pressured to put SOMETHING in the field. Live specimen 2026-09-08:
// a customer created with `address_line1 = 'Ruth Bramley'`, her own name.
//
// REFUSED, not nulled: the caller believes it is recording an address and will
// go on to tell a manager so. And there is no address updater anywhere in the
// app (src/db/customers.ts), so a fabrication here is permanent.
//
// Normalized past the one-character retry — the refusal quotes the string back,
// which is exactly the prompt that produces "Ruth Bramley," on the next attempt.
// Internal whitespace is collapsed and surrounding punctuation stripped, so the
// evasions are a different STRING rather than a different spelling of the name.
export const addressKey = (value: string | null | undefined): string =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[.,;:'"\-\s]+|[.,;:'"\-\s]+$/g, '');

export function refuseNameAsAddress(
  address: string | null | undefined,
  customerName: string | null | undefined,
): void {
  const claimed = addressKey(address);
  const name = addressKey(customerName);
  if (!claimed || !name || claimed !== name) return;
  throw new Error(
    `"${address?.trim()}" is the customer's NAME, not an address — an address is where they ` +
      'are. If you were not given one, leave the address out. If that really IS the address ' +
      '(a house or farm name), write enough of it to read as a place — add the street, the ' +
      'town or the postcode — so the record does not just repeat their name.',
  );
}

export function resolutionFrom(
  match: MatchResult,
  confirmed: { customerId?: string; address?: string } | undefined,
  extracted: ExtractedFields,
): ResolvedIdentity | undefined {
  if (match.status === 'matched' && match.customerId) {
    return { customerId: match.customerId, ...(match.jobId ? { jobId: match.jobId } : {}) };
  }
  if (confirmed && (match.createFrom || confirmed.address)) {
    const draft = match.createFrom;
    refuseNameAsAddress(confirmed.address, draft?.customerName ?? extracted.customerName);
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
// NOTE (2026-08-21): only a createFrom resolution stages now, so the
// customerId limb below is currently unreachable. Kept rather than deleted —
// it is the correct rendering if anything ever stages a known customer again,
// and a preview that silently mis-renders is worse than a dead branch.
export async function stagedNotePreview(detail: StagedNoteDetail): Promise<{
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

// Tie an answer back to the question it answered (plan 2026-08-22, Phase 1).
//
// There is no ref code in the message and there is not going to be: under
// `--deliver` the question passes through an agent whose own footer tells it to
// strip "any internal detail", so a ref would arrive stripped and silent; under a
// direct send the technician would read `(ref K7M2QX4P)` in their chat, which is
// the same machine-artifact-in-a-human's-face mistake as showing a manager the
// planner's reasoning. So the spine attributes from what it already knows: WHO
// recorded the note, WHICH job it landed on, and which of its own gaps are open.
//
// EXACTLY ONE open gap for that person on that job → stamp it. Two or more →
// stamp NOTHING. Code cannot tell which question a sentence answers, and the
// planner reads the words, so an ambiguous case is deliberately handed up rather
// than guessed at (the `sharesJob` warning in buildGapView is the other half).
//
// Never throws. A lost link is a lost link; a lost note is a lost note, and L1
// is undeletable — attribution must not be able to fail a write that landed.
// Exported so a test can prove that with a REAL database error rather than a
// stub — the swallow is the whole safety property here.
export async function attributeAnswerToGap(input: {
  tenantId: string;
  // technicians.id. Null for a ROSTER-LESS badge (record_field_note serves them
  // by design — see the subjectRef note in its dispatch), which has no roster row
  // to scope gaps by. Fail closed: attribute nothing.
  technicianId: string | null;
  jobId: string | undefined;
  captureId: string;
}): Promise<void> {
  const { tenantId, technicianId, jobId, captureId } = input;
  if (!technicianId || !jobId) return;
  try {
    const open = await listAskedNudgesForTechnicianJob(tenantId, technicianId, jobId);
    if (open.length !== 1) return;
    await setNudgeAnsweredBy(open[0].id, tenantId, captureId);
  } catch (err) {
    console.error(
      `[attribution] capture ${captureId} not linked to a gap on job ${jobId} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// What the office still has open on THIS job for THIS person, in the words the
// person actually saw. Handed back on a recorded note so their assistant can
// follow up while they are still holding the phone.
//
// This is the SEAT AGENT's own turn, not a second office turn. Waking the
// planner on an answer was ruled out (2026-08-25): a planner-written sentence
// dropping into a live conversation is two voices in one chat, and the planner
// holds no technician write tools if it stayed. ④b's zero-inference rule binds
// the ASK leg only — the seat agent already reasons freely once someone replies.
//
// The just-answered gap is NOT excluded, and cannot be: attributeAnswerToGap
// declines to stamp at two-or-more asked — exactly the batched case — so no
// "which one did they just close" signal exists to filter on. §0k clause 1a
// carries it instead: the agent compares this list against what the person said.
// Reporting what is open is honest; guessing which one they closed is not.
//
// Deduped by TEXT, not by row: every member of an ask-group stores the same full
// grouped message in `question`, so ONE message covering three gaps must read
// back as ONE thing the person was asked, not three.
//
// Never throws, for the same reason attributeAnswerToGap never throws: by the
// time this runs the note is already in undeletable L1. A follow-up that cannot
// be offered is a missed follow-up; a landed note reported as failed is a
// permanent lie. Exported so a test can prove the swallow against a REAL
// database error rather than a stub.
export async function openQuestionsFor(input: {
  tenantId: string;
  // Null for a ROSTER-LESS badge, exactly as in attributeAnswerToGap — no roster
  // row to scope gaps by, so there is nothing to report. Fail closed.
  technicianId: string | null;
  jobId: string | undefined;
}): Promise<{ question: string }[]> {
  const { tenantId, technicianId, jobId } = input;
  if (!technicianId || !jobId) return [];
  try {
    const asked = await listAskedNudgesForTechnicianJob(tenantId, technicianId, jobId);
    return [...new Set(asked.map((n) => n.question).filter((q): q is string => !!q))].map(
      (question) => ({ question }),
    );
  } catch (err) {
    console.error(
      `[openQuestions] job ${jobId} lookup failed — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// The ONE commit for a field note, shared by all three paths that record one
// (plan ②, 2026-08-21): the one-shot call, the identity resume, and the
// legacy staged confirm. Sharing it is not tidiness — L1 is undeletable, so
// "did this already land?" must be answered identically everywhere. A path
// that reported `recorded` on a duplicate would tell a technician their note
// was written twice when it was written once, or hide a half-written record.
export async function commitNote(input: {
  tenantId: string;
  technicianRef: string;
  text: string | null;
  blobPath: string | null;
  channel: CaptureChannel;
  resolved: ResolvedIdentity;
  externalId: string;
  sourceMeta?: Json;
  extracted: ExtractedFields;
  // The staged paths know how to describe an already-landed commit against
  // their token (complete vs partial). The one-shot path has no token, so it
  // falls back to the plain duplicate report below.
  reportExisting?: (captureId: string) => Promise<Record<string, unknown>>;
  retryHint?: string;
  // The badge's roster row id, for gap attribution below. Threaded through the
  // ONE commit rather than each of its three call sites on purpose: an answer
  // most often lands on a RESUME path, and a per-site hook is exactly the kind
  // of thing that gets added to the obvious site and forgotten on the other two.
  //
  // REQUIRED, not optional — typecheck is the pin. Two of the three sites are
  // covered by tests; the third (the legacy staged confirm) is reachable only
  // for a createFrom resolution, which mints a NEW customer and therefore a job
  // with no gaps on it, so no test can distinguish it passing this from not.
  // Making the field mandatory is what defends that site, and every site added
  // after this one.
  answeredByTechnicianId: string | null;
}): Promise<Record<string, unknown>> {
  let result;
  try {
    result = await recordFieldNote(
      {
        tenantId: input.tenantId,
        technicianRef: input.technicianRef,
        text: input.text,
        blobPath: input.blobPath,
        channel: input.channel,
        resolved: input.resolved,
        externalId: input.externalId,
        ...(input.sourceMeta ? { sourceMeta: input.sourceMeta } : {}),
      },
      // Replay: no model call, and the commit cannot extract differently than
      // the identity match the technician was answering.
      { extract: async () => input.extracted },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `note NOT recorded: ${msg} — ${input.retryHint ?? 'call again with the same note text'}`,
    );
  }
  if (result.status === 'duplicate') {
    if (input.reportExisting) return await input.reportExisting(result.captureId);
    // One-shot: the content stamp already matched, so this exact note is
    // already on the record. Say so plainly rather than claiming a new write.
    return {
      status: 'duplicate',
      captureId: result.captureId,
      // Deliberately "was already recorded", not "is on the record": a manager
      // may have retracted it, which folds it out of every read while the row
      // survives. recordFieldNote answers `duplicate` either way.
      note: 'this exact note was already recorded — nothing was written twice',
    };
  }
  // AFTER `recorded`, never before: recordFieldNote resolves the job only after
  // the L1 append, so the capture id and job id this needs do not exist until
  // here. A `duplicate` returned above deliberately does not reach this — that
  // note was attributed (or not) on the delivery that actually landed it.
  await attributeAnswerToGap({
    tenantId: input.tenantId,
    technicianId: input.answeredByTechnicianId,
    jobId: result.jobId,
    captureId: result.captureId,
  });
  const openQuestions = await openQuestionsFor({
    tenantId: input.tenantId,
    technicianId: input.answeredByTechnicianId,
    jobId: result.jobId,
  });
  return {
    status: 'recorded',
    captureId: result.captureId,
    customerId: result.customerId,
    jobId: result.jobId,
    visitId: result.visitId,
    // The trip's lifecycle in one word, so the seat can say "reported" rather
    // than infer it from a status and a timestamp it was never given.
    ...(result.stage ? { stage: result.stage } : {}),
    // No ids: no technician tool takes a gap id, and a ref in a person's face is
    // the machine artifact the (re: …) anchor exists to keep out of the chat.
    ...(openQuestions.length > 0 ? { openQuestions } : {}),
  };
}

// The one manager-facing seat-cap message — every tool that can hit the DB
// trigger says the same thing (three call sites; drift means inconsistent
// guidance depending on which tool hit the cap).
export function seatCapMessage(tier: TechnicianTier): string {
  return `no free ${tier} seats — deactivate someone or purchase a seat`;
}

// The current unwrapped value of ONE standing-fact key on a customer/job row,
// with a retracted fact reading as absent (the fold rule). Shared by the
// record_standing_fact stage preview and its commit drift guard — preview ==
// commit means the value shown as "replaces X" must still be X when the write
// lands. Object.hasOwn (not `in`): a key like 'constructor' must not read an
// inherited prototype member as a previous value.
export async function currentFactValue(attributes: Json, key: string): Promise<Json | undefined> {
  const obj =
    attributes && typeof attributes === 'object' && !Array.isArray(attributes)
      ? (attributes as Record<string, Json>)
      : {};
  if (!Object.hasOwn(obj, key)) return undefined;
  const raw = obj[key] ?? null;
  if (!isFactBundle(raw)) return raw; // plain (seed/legacy) value
  const retractions = await findRetractionsFor([raw.sourceCaptureId]);
  return retractions.length > 0 ? undefined : raw.value;
}

// Best-effort fold-impact scan for retract_capture's CONFIRM responses: the
// retraction has already committed, so this advisory read must never turn a
// landed retraction into an error (the token is consumed — a retry would
// dead-end in "confirmation not found" → restage → "already retracted"). The
// stage-side scan stays strict: nothing has committed yet, and a preview
// without the fold list would silently regress to agent guesswork.
export async function tryFindFoldImpact(
  tenantId: string,
  captureId: string,
): Promise<FoldImpact | undefined> {
  try {
    return await findFoldImpact(tenantId, captureId);
  } catch {
    return undefined;
  }
}

// Must stay true to record_standing_fact's stage branch (one open staged
// batch per person; a new stage supersedes an unconfirmed one) — if that
// supersede behavior changes, change this hint in the same commit.
export const RESTORE_HINT =
  'These standing facts disappeared with the retracted evidence. Ask the person which are ' +
  'still true, then restore them by STAGING record_standing_fact — no "want me to?" first; ' +
  'the staged preview is the question. One call per affected customer/job, SEQUENTIALLY: ' +
  'stage one, get its yes, confirm it, then stage the next (a new stage supersedes an ' +
  'unconfirmed one).';

export function restoreHintFor(impact: FoldImpact | undefined): string | undefined {
  return impact && impact.facts.length > 0 ? RESTORE_HINT : undefined;
}

// The one shape both confirm-path successes return (main commit + late-retry
// crash-heal): keeping them structurally identical is load-bearing — a retried
// confirm must not look different from a first-try confirm. The scan is
// advisory here (see tryFindFoldImpact), and an absent list must not read as
// "nothing folded": say the scan failed and point back at the staged preview.
// What survives a retraction but loses the note as its evidence: booked trips
// (rung 9b) and money entries (2026-09-15). Present only when something is in
// it, and both arrays ride together so a reader never mistakes a missing key
// for an empty list.
export function losingEvidenceOf(
  impact: FoldImpact,
): { visits: FoldImpact['visitsLosingEvidence']; money: FoldImpact['moneyLosingEvidence'] } | undefined {
  return impact.visitsLosingEvidence.length > 0 || impact.moneyLosingEvidence.length > 0
    ? { visits: impact.visitsLosingEvidence, money: impact.moneyLosingEvidence }
    : undefined;
}

// MONEY NEVER FOLDS (operator ruling 2026-09-15): the entries still count, and
// the only right fix for a wrong amount is a correction in the ledger — which
// is a manager's verb. Worded per tier so a technician is never told to call a
// tool they cannot reach.
export function moneyLosingEvidenceNote(activeManager: boolean): string {
  return (
    'The money entries under money STILL COUNT — retracting a note never changes money. ' +
    (activeManager
      ? 'If an amount was wrong, correct it with record_money_event (kind correction, ' +
        'correctsEventId = its eventId).'
      : 'If an amount was wrong, tell the manager with inform_team_lead, naming the entry, ' +
        'so they can correct it — you cannot change money yourself.')
  );
}

export async function retractedResult(
  tenantId: string,
  captureId: string | null,
  retractionId: string,
  activeManager = false,
): Promise<Record<string, unknown>> {
  const impact = captureId ? await tryFindFoldImpact(tenantId, captureId) : undefined;
  const losing = impact && losingEvidenceOf(impact);
  return {
    status: 'retracted',
    captureId,
    retractionId,
    // `alsoRemoved` must name ONLY what actually went. Trips that merely lost
    // this note as evidence ride alongside under their own key (rung 9b) —
    // folding them into alsoRemoved would tell the manager a live appointment
    // had disappeared. Money rides there too: it never goes.
    alsoRemoved: impact && {
      facts: impact.facts,
      visits: impact.visits,
      correspondence: impact.correspondence,
    },
    ...(losing ? { alsoLostEvidence: losing } : {}),
    ...(losing && losing.money.length > 0 ? { moneyNote: moneyLosingEvidenceNote(activeManager) } : {}),
    ...(impact === undefined
      ? {
          alsoRemovedNote:
            'fold-impact scan failed after the retraction committed — treat the staged ' +
            "preview's willAlsoRemove as the fold list and offer restores from it",
        }
      : {}),
    restoreHint: restoreHintFor(impact),
  };
}

// RUNG 10 — WHICH CALL IS THIS CREATION ANSWERING?
//
// The office texted a manager about an inbound call; the manager said yes; their
// agent now opens a job or books a visit. Nothing in that chat carries the call's
// id — the manager types "yes, open it" — so the link has to be re-derived here,
// from the one open observation this customer (or this job) has waiting.
//
// THREE NARROWINGS, and each one exists because citing the WRONG call is worse
// than citing none — a false citation lets the planner close a real ask on work
// that has nothing to do with it, and puts one caller's words permanently onto
// another's job.
//
//  1. IT MUST HAVE BEEN ASKED. `asked_at` set means the office actually texted
//     a manager about this call. If nobody was ever told, the manager's agent
//     is not answering it — it is doing something else for the same customer.
//  2. RECENTLY. A manager may answer the next morning; they do not answer a
//     fortnight later. Without a bound, an ask nobody ever answered would be
//     consumed by the next unrelated booking for that customer, forever.
//  3. THE SHAPE MUST MATCH. A booking that MINTS a job can only be answering an
//     ask that had no job on file; one onto an existing job must name that job.
//
// And then EXACTLY ONE, or nothing: two candidates means the agent could be
// answering either. Zero is the ordinary case — most bookings answer no call.
//
// This never TOUCHES the observation. Closing it is the planner's, on the
// citation this leaves behind (the record is planner-kept).
export const CITE_ASK_WINDOW_MS = 7 * 24 * 3_600_000;

export async function inboundAskFor(
  tenantId: string,
  target: { customerId?: string; jobId?: string },
): Promise<{
  captureId: string;
  channel: CaptureChannel;
  capturedAt: string;
  followUp?: string;
  attributes?: Json;
} | null> {
  if (!target.customerId && !target.jobId) return null;
  let open: Awaited<ReturnType<typeof listObservationsByStatus>>;
  try {
    open = await listObservationsByStatus(tenantId, ['open']);
  } catch (err) {
    // ADVISORY. A booking that lands without its citation is a booking; a
    // booking refused because a read failed is a manager blocked.
    console.error('inboundAskFor: the observation read failed — booking without a citation', err);
    return null;
  }
  const floor = Date.now() - CITE_ASK_WINDOW_MS;
  const matches = open.filter((o) => {
    if (!(PINGED_KINDS as string[]).includes(o.kind)) return false;
    // (1) and (2): somebody was actually told, and recently enough that this
    // creation could plausibly be their answer.
    if (!o.asked_at || Date.parse(o.asked_at) < floor) return false;
    const c = (o.context ?? {}) as Record<string, unknown>;
    // (3) MATCH ON WHAT THE CALLER NAMED, never on the other field: a booking
    // onto an existing job must name that job, and a booking that mints one can
    // only answer an ask that had no job on file.
    return target.jobId
      ? c.jobId === target.jobId
      : c.customerId === target.customerId && !c.jobId;
  });
  if (matches.length !== 1) {
    if (matches.length > 1) {
      console.warn(
        `inboundAskFor: ${matches.length} open inbound asks for ` +
          `${target.jobId ? `job ${target.jobId}` : `customer ${target.customerId}`} — ` +
          'citing none, because citing the wrong one would let the planner close the other',
      );
    }
    return null;
  }
  const c = (matches[0].context ?? {}) as Record<string, unknown>;
  const asked = (c.asked ?? {}) as Record<string, unknown>;
  return {
    captureId: typeof c.captureId === 'string' ? c.captureId : matches[0].subject_ref,
    // THE CALL'S OWN CHANNEL AND TIME, not this moment's. A correspondence
    // entry says what the customer said and when they said it; stamping the
    // booking's clock and a hardcoded 'phone_call' would tell every later
    // reader — the brief renders these verbatim — that an emailer phoned, at
    // the hour the manager happened to answer. The write path's own copy
    // carries the real values; these two homes must not disagree.
    channel: (typeof c.channel === 'string' ? c.channel : 'phone_call') as CaptureChannel,
    capturedAt: typeof c.capturedAt === 'string' ? c.capturedAt : matches[0].noticed_at,
    // ONLY the two fields a correspondence entry may carry. `workPerformed`
    // rides in the observation for the planner's eyes and stops there — the
    // report and the bill stay technician-only (rung 9b's line).
    ...(typeof asked.followUp === 'string' ? { followUp: asked.followUp } : {}),
    ...(asked.attributes && typeof asked.attributes === 'object' && !Array.isArray(asked.attributes)
      ? { attributes: asked.attributes as Json }
      : {}),
  };
}

// Stable comparison encoding for a fact-value slot: undefined (absent) is
// distinct from every JSON value; object values compare by their
// jsonb-normalized shape (both sides round-tripped through Postgres jsonb).
export function encodeFactValue(v: Json | undefined): string {
  return v === undefined ? '\u0000absent' : JSON.stringify(v ?? null);
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
export async function isActiveManager(identity: RequestIdentity): Promise<boolean> {
  const caller = await getTechnician(identity.tenantId, identity.technicianRef);
  return !!caller && caller.tier === 'manager' && caller.state === 'active';
}

// The in-process entry for spine-internal callers (the team-lead planner). It
// exists so `dispatch` itself stays module-private: everything that reaches the
// tools still passes the SAME gates in the SAME order — deactivation, the
// spine: namespace ceiling, the manager tier gate — because there is only one
// door and this is a handle on it, not a second one.
//
// `identity` is a parameter rather than a default because there is no ambient
// team-lead identity: the caller must name the tenant it is acting for, exactly
// as the gateway does for a badge.
// The read-based idempotency guard in `record_caller` is not a lock — the window
// between it and the write spans a live extractor call — so the DATABASE is the
// authority: uq_customers_one_per_capture refuses a second customer from one
// capture. When it fires, the loser must get the same deliberate steer the read
// path gives ("name it with `customerId`"), not a raw Postgres constraint string
// that reads as a system fault the planner will simply retry.
// Model-supplied ids reach uuid-typed PostgREST filters, where a malformed one
// raises 22P02 rather than an empty result — an error the caller reads as a
// system fault and retries. Same shape as the inbound webhook's tenant rail and
// the planner's own UUID_ISH_RE, for the same reason.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordCallerThroughTheDoor<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    // ON THE CONSTRAINT NAME, not merely on 23505. The door also runs createJob,
    // bookVisit and appendScheduleEvent; translating ANY unique violation into
    // "a customer already exists" would one day hand the planner a confidently
    // wrong steer down a path that cannot fix the real failure, with the actual
    // constraint name reaching no log line.
    if (isUniqueViolation(err) && String(err).includes('uq_customers_one_per_capture')) {
      throw new Error(
        'a customer was already created from this call while this was running — read the item ' +
          'again and name that customer with `customerId` instead.',
      );
    }
    throw err;
  }
}

// GROUNDING_LEAN=1 strips the derived date/schedule crutches added for the
// GLM-era seat model — get_customer_context upcomingVisits/openWorkNote — while
// keeping the `now` rider, resolve_date, and every correctness filter (the
// v_schedule status filter is a bug fix, not a crutch, and is untouched).
// get_team_schedule's counts are NO LONGER stripped: since retrieval layer 4
// they are the page itself, not a crutch beside a dump. Date-eval Arm B
// (2026-08-23): measure a frontier model WITHOUT the scaffolding. Read per
// CALL, not at module load, so the eval window flips it via Render env with
// no build, and tests toggle it around individual calls. Never set it in
// normal operation.
export const leanGrounding = () =>
  process.env.GROUNDING_LEAN === '1' || process.env.GROUNDING_BARE === '1';

// Read a non-negative-integer env override, falling back to the safe default
// for anything that isn't one. Bare `Number(process.env.X ?? d)` returns NaN on
// a malformed value (e.g. "512px"), and every `count >= NaN` / `len > NaN`
// comparison is then false — silently DISABLING the web caps that compensate
// for shipping fetch without a confirm gate. A typo must fall back to the
// documented limit, never turn the guard off.
export function safeEnvInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback; // Number('') is 0 — would block everything
  const n = Number(trimmed);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}
