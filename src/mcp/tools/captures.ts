// Captures, notes and the standing-fact record.
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
  CORRESPONDENCE_KEY,
  PINGED_KINDS,
  appendRawCapture,
  captureHasLinkedVisit,
  findFoldImpact,
  findOpenReviewItem,
  findRetractionsFor,
  foldRetractions,
  getCustomer,
  getJob,
  getOpenReviewItem,
  getRawCapture,
  getRawCaptureByExternalId,
  insertCustomerCapture,
  insertJobCapture,
  insertVisitNote,
  isFactBundle,
  isUniqueViolation,
  listCustomerCapturesForCapture,
  listJobCapturesForCapture,
  listObservationsByStatus,
  listRawCapturesForCustomer,
  listRawCapturesForJob,
  listVisitNotesForCapture,
  readJobNote,
  resolveOpenReviewItemFor,
  resolveReviewItem,
  setObservationStatus,
  trySetCustomerAttribute,
  trySetJobAttribute,
  updateOpenReviewItemDetail,
  upsertOpenReviewItem,
  writeJobNote,
} from '../../db/index.js';
import type {
  CaptureChannel,
  Customer,
  Job,
  Json,
} from '../../db/index.js';
import {
  validateJobNoteContent,
} from '../../teamLead/jobNotes.js';
import {
  defaultExtractor,
} from '../../writePath/extract.js';
import {
  matchIdentity,
} from '../../writePath/identityMatch.js';
import {
  AUDIT_CHANNELS,
  TECH_CHANNELS,
  commitNote,
  currentFactValue,
  encodeFactValue,
  oneShotNoteStamp,
  resolutionFrom,
  retractedResult,
  stagedNotePreview,
} from './shared.js';
import type {
  StagedNoteDetail,
} from './shared.js';
import type {
  DomainTools,
  ToolContext,
} from './types.js';

const BASE_TOOLS = [
  {
    name: 'record_field_note',
    description:
      'Record a technician field note into the permanent company record. ONE call: pass the ' +
      'text and it is recorded — do NOT ask "shall I record that?" first. Two answers mean it ' +
      'did not land yet: needs_identity (we cannot tell which customer — ask them, then call ' +
      'again with confirmId + confirmed:{customerId|address}), and needs_confirmation (the ' +
      'answer would CREATE a new customer, so show the preview and call again with ONLY ' +
      'confirmId on their explicit yes). Recording is permanent — there is no delete; a mistake ' +
      'is fixed by recording the correction and then retract_capture. A recorded answer may come ' +
      'back with openQuestions — what the office still has open on that job, which MAY include ' +
      'the one they just answered. Judge from what the person actually said and ask ONE thing ' +
      'they have genuinely not covered, now. Write it as TWO SHORT PARAGRAPHS: confirm what you ' +
      'recorded, then a BLANK LINE, then the question on its own line — a question tacked onto a ' +
      'confirmation reads as a footer. Keep it to six words or fewer and stop at the question ' +
      'mark ("What did the parts cost?"): never append "on that one" or any similar tail. ' +
      'It is YOUR question: never say it came from the office or anyone else, never mention a ' +
      'queue or a list, and never repeat the "(re: …)" line the text may end with. RECORD their ' +
      'reply with record_field_note, passing confirmed:{customerId} from the answer you just ' +
      'recorded so it lands on the same record. If they do not engage, drop it.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note text (voice already transcribed to text).' },
        blobPath: { type: 'string', description: 'Optional object-store pointer for audio/photo.' },
        channel: { type: 'string', enum: TECH_CHANNELS, description: 'Defaults to technician_note.' },
        confirmId: {
          type: 'string',
          description:
            'Only for following up a needs_identity or needs_confirmation answer. With ' +
            'confirmed: supplies the missing customer. ALONE: confirms a new-customer preview.',
        },
        confirmed: {
          type: 'object',
          description:
            'Which customer this note is for. With confirmId: the technician\'s answer to a ' +
            'needs_identity question. ALONE (no confirmId): you already know the customer, so ' +
            'the note records straight away instead of asking them who it was for — this is how ' +
            'you file a reply to a follow-up you asked about a note you just recorded.',
          properties: { customerId: { type: 'string' }, address: { type: 'string' } },
        },
      },
      required: [],
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
    name: 'retract_capture',
    description:
      'Retract a wrongly recorded capture — two-step. The record is append-only, so this never ' +
      'deletes: it permanently marks the capture as recorded-in-error (with your reason); the ' +
      'note, any trip the note itself created, AND any standing fact citing it as evidence all ' +
      'stop appearing in briefings/context/lists automatically — retracting a fact\'s evidence ' +
      'capture IS how a wrong standing fact is removed (no follow-up write needed). The staged ' +
      "preview's willAlsoRemove lists exactly which standing facts, visits AND caller " +
      'correspondence (what a customer said, kept on a job) will disappear — ' +
      'show it to the person as part of the confirmation. A trip that was BOOKED separately and ' +
      'merely mentioned in this note does NOT disappear: it keeps its place on the schedule and ' +
      'only loses this note as evidence, and it is listed under alsoLosesEvidence instead. Never ' +
      'tell anyone a booked visit is going away because of a retraction. The confirm response ' +
      'echoes the final list as alsoRemoved (correspondence included, plus alsoLostEvidence) ' +
      'with a restoreHint when ' +
      'facts folded; if alsoRemoved is absent, the ' +
      'post-commit scan failed — fall back to the staged willAlsoRemove. Only other side ' +
      'effects the note caused — e.g. a job status change — are NOT auto-reverted. ' +
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
  {
    name: 'record_standing_fact',
    description:
      'Record durable standing facts about ONE customer or job ("prefers email", "gate code ' +
      '4321") onto their permanent record — two-step, and it STAYS two-step even though ' +
      'record_field_note no longer is: a note describes one trip and can be retracted, while a ' +
      'standing fact lands in every future briefing. EVERY fact from the same ' +
      'conversation about the same customer/job goes in ONE call: first call with customerId ' +
      "OR jobId + facts:[{key,value},…] (+ sourceText, the person's exact words): NOTHING is " +
      'recorded; you get needs_confirmation with ONE preview listing every fact (and the ' +
      'previous value when overwriting). Show the person EXACTLY the preview; only on their ' +
      'explicit yes call again with ONLY confirmId — the STAGED copy is what gets recorded, ' +
      'all facts under a single confirmation. To fix a wrong fact: re-record the key with the ' +
      "right value, or retract the fact's evidence capture (which removes it automatically).",
    inputSchema: {
      type: 'object',
      properties: {
        customerId: {
          type: 'string',
          description: 'Target customer (exactly one of customerId/jobId). First call only.',
        },
        jobId: {
          type: 'string',
          description: 'Target job (exactly one of customerId/jobId). First call only.',
        },
        facts: {
          type: 'array',
          description:
            'The facts to record — put ALL facts from this conversation here (max 10), one call, one confirmation. First call only.',
          items: {
            type: 'object',
            properties: {
              key: {
                type: 'string',
                description: 'Fact name, e.g. prefers_contact, gate_code (normalized to snake_case).',
              },
              value: {
                type: ['string', 'number', 'boolean'],
                description: 'The fact value (strings up to 500 chars).',
              },
            },
            required: ['key', 'value'],
          },
        },
        key: { type: 'string', description: 'Single-fact alternative to facts[]. First call only.' },
        value: {
          type: ['string', 'number', 'boolean'],
          description: 'Single-fact alternative to facts[]. First call only.',
        },
        sourceText: {
          type: 'string',
          description: "The person's verbatim words — stored permanently as the facts' evidence. First call only.",
        },
        confirmId: { type: 'string', description: 'Set ONLY on the confirming second call; ALONE it records the staged facts.' },
      },
      required: [],
    },
  },
];

const TEAM_LEAD_TOOLS = [
  // The planner's per-job NOTEPADS (plan 2026-08-30). Addressed by the JOB, not
  // through the memory index — see src/teamLead/jobNotes.ts for why the two
  // stores are separate.
  {
    name: 'read_job_note',
    description:
      'Open YOUR NOTE on one job — what you worked out about this piece of work last time you ' +
      'looked at it. A gap whose job has a note says so in its block; pass the `job id` printed ' +
      'there. A job you have never written about comes back empty, which is an answer, not a ' +
      'failure.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: "A job id, copied exactly from a gap's `job id`." },
      },
      required: ['jobId'],
    },
  },
  {
    name: 'write_job_note',
    description:
      'Save YOUR NOTE on one job, replacing whatever it said before. This is for what you ' +
      'understand about ONE piece of work — who answers, what has already been chased, what you ' +
      'are waiting on — as opposed to your MEMORY.md notes, which are about the firm as a whole. ' +
      'Write what you would want to read the next time this job needs a decision. ' +
      'A note cannot be deleted, only replaced, and the previous ten versions are kept — so ' +
      'rewriting costs nothing, but there is no way to blank one.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: "A job id, copied exactly from a gap's `job id`." },
        content: {
          type: 'string',
          description:
            'The whole note — this REPLACES what was there, it does not append. Plain prose.',
        },
      },
      required: ['jobId', 'content'],
    },
  },
];

async function handleRecordFieldNote(toolCtx: ToolContext): Promise<unknown> {
  const { args, deps, identity, tenantId, str, caller } = toolCtx;
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
        const extracted = await (deps.extract ?? defaultExtractor)(text ?? '', {
          tenantId,
          technicianRef: subjectRef,
        });
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
        // ONE-SHOT (plan ②, 2026-08-21): identity resolved to a customer or job
        // that ALREADY EXISTS → record now. The confirm it replaces bought
        // ceremony, not safety: a wrong note is retractable by its own author,
        // and stopping at "shall I?" made the agent answer "Recorded!" to a
        // technician who was not done (live specimen, 2026-08-19).
        //
        // A `createFrom` resolution deliberately does NOT come here. That call
        // would MINT A CUSTOMER, and a customer pinned by a stamped capture
        // cannot be removed — so the preview survives exactly where
        // revertability ends (user, 2026-08-21).
        // customerId, NOT `customerId || jobId`: recordFieldNote maps a
        // jobId-only resolution to needs_disambiguation and MINTS an "Unknown
        // customer" — the exact thing the carve-out below exists to prevent.
        // resolutionFrom never returns jobId alone today; this keeps that from
        // mattering if it ever does.
        if (resolved?.customerId) {
          return await commitNote({
            tenantId,
            technicianRef: subjectRef,
            text: text ?? null,
            blobPath: blobPath ?? null,
            channel,
            resolved,
            answeredByTechnicianId: caller?.id ?? null,
            externalId: oneShotNoteStamp({
              tenantId,
              technicianRef: subjectRef,
              channel,
              resolved,
              text: text ?? null,
              blobPath: blobPath ?? null,
            }),
            // Replay the extraction the identity match just used. Without this
            // the write path calls the model a SECOND time and can extract
            // differently than the match that chose this customer.
            extracted,
          });
        }
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
        // Before telling the agent to restage, check whether this token's commit
        // ALREADY LANDED. It used to be safe not to: a restage produced a
        // preview, so a human stood between the retry and a second write. Since
        // the one-shot change that backstop is gone — the agent re-sends the
        // text and it records under a DIFFERENT stamp (`note:<sha256>` vs
        // `note:<item.id>`), which recordFieldNote's dedup cannot see across.
        // Two permanent captures, two visits, no delete. Same check the TTL
        // branch below already makes, for the same reason.
        const landed = await getRawCaptureByExternalId(tenantId, `note:${confirmId}`);
        if (landed) {
          return {
            status: 'duplicate',
            captureId: landed.id,
            note: 'this note was already recorded by an earlier confirm — do NOT send it again',
          };
        }
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
        // The technician just supplied the missing datum, and a missing datum
        // was never a confirmation — so an EXISTING customer/job records now.
        // A createFrom still previews (it would mint a customer).
        if (resolved.customerId || resolved.jobId) {
          const out = await commitNote({
            tenantId,
            technicianRef: subjectRef,
            text: detail.text ?? null,
            blobPath: detail.blobPath ?? null,
            channel: detail.channel ?? 'technician_note',
            resolved,
            // The item exists, so it still owns the stamp — no content hash
            // needed, and a retry with the same confirmId converges on it.
            externalId: `note:${item.id}`,
            sourceMeta: { stagedConfirmId: item.id },
            extracted: detail.extracted ?? {},
            answeredByTechnicianId: caller?.id ?? null,
            reportExisting,
          });
          try {
            await resolveReviewItem(item.id, tenantId, 'resolved', `note recorded by ${subjectRef}`);
          } catch {
            /* advisory — a retried confirm hits the externalId dedup */
          }
          return out;
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
      //
      // This branch survives plan ②'s one-shot change on purpose: tokens staged
      // before the deploy must still be able to land.
      const out = await commitNote({
        tenantId,
        technicianRef: subjectRef,
        text: detail.text,
        blobPath: detail.blobPath,
        channel: detail.channel ?? 'technician_note',
        resolved: detail.resolved,
        externalId: `note:${item.id}`,
        sourceMeta: { stagedConfirmId: item.id },
        extracted: detail.extracted ?? {},
        answeredByTechnicianId: caller?.id ?? null,
        // Only reassure if the earlier commit actually COMPLETED (visit
        // linked); a mid-L2 crash must surface, not read as success.
        reportExisting,
        // The token is still open (consume hasn't run): a retry with the SAME
        // confirmId re-runs under the SAME externalId and heals. Restaging
        // instead would mint a new stamp and could double-write.
        retryHint:
          'the staged note is still held; retry with the SAME confirmId (do not restage)',
      });
      if (out.status === 'duplicate') return out;
      try {
        await resolveReviewItem(item.id, tenantId, 'resolved', `note recorded by ${subjectRef}`);
      } catch {
        /* advisory — a retried confirm hits the externalId dedup (duplicate) */
      }
      return out;
}

async function handleListRecentCaptures(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str, activeManager, dropSensitive } = toolCtx;
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

async function handleRetractCapture(toolCtx: ToolContext): Promise<unknown> {
  const { identity, tenantId, str, activeManager } = toolCtx;
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
        // Server-guaranteed blast radius: everything that folds with this
        // retraction, shown in the preview so the warning never depends on
        // the agent noticing. Strict (stage commits nothing; a failed scan
        // fails the stage, not the record) — advisory on confirm. Computed
        // for the ECHOED capture, after the upsert: on a racing stage the
        // item can be the other call's row, and the fold list must describe
        // the capture the confirmId will actually retract (review finding).
        const impact = await findFoldImpact(tenantId, staged.captureId ?? target.id);
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          captureId: staged.captureId ?? target.id,
          reason: staged.reason ?? reason,
          targetPreview: staged.targetPreview,
          willAlsoRemove: {
            facts: impact.facts,
            visits: impact.visits,
            correspondence: impact.correspondence,
          },
          ...(impact.visitsLosingEvidence.length > 0
            ? { alsoLosesEvidence: { visits: impact.visitsLosingEvidence } }
            : {}),
          note: 'Nothing was retracted. Show the person the capture and this reason; on their explicit yes call again with ONLY confirmId. A retraction is permanent (the audit trail keeps both rows). If willAlsoRemove.facts, willAlsoRemove.visits or willAlsoRemove.correspondence has entries, the shown preview MUST include them. If alsoLosesEvidence.visits has entries, say those trips STAY on the schedule and only lose this note — never that they disappear.',
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
          // retracts_capture_id is non-null for any row found via retract:*
          // externalId, but the column type is nullable — retractedResult
          // guards it (never `?? ''`: an empty id would scan nothing and
          // report an empty impact).
          return await retractedResult(tenantId, landed.retracts_capture_id, landed.id);
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
        // The retraction FOLLOWS its target onto EVERY link it has — the trip
        // (rung 9b, visit_notes), the job (rung 10, job_captures) and the
        // CUSTOMER (2026-09-12, customer_captures, for a capture the door could
        // place on a person but not on a job). The target reached them through
        // those links, so the retraction has to travel the same roads or it
        // lands on the record with no connection to the thing it neutralizes —
        // invisible to every reader that walks the link.
        // Advisory: a retraction that is written but not linked is still a valid
        // retraction, so this must never fail the confirm.
        try {
          for (const link of await listVisitNotesForCapture(target.id)) {
            // capture_id is an id-only FK, so the link's own tenant is the only
            // proof the trip is ours — check it before writing a row that would
            // stamp this tenant onto another firm's visit. Not reachable today
            // (a capture's links are written with the capture's tenant), which
            // is exactly why it must be asserted rather than assumed.
            if (link.tenant_id !== tenantId) continue;
            await insertVisitNote({ tenantId, visitId: link.visit_id, captureId: row.id });
          }
          for (const link of await listJobCapturesForCapture(target.id)) {
            if (link.tenant_id !== tenantId) continue; // same id-only-FK guard
            await insertJobCapture({ tenantId, jobId: link.job_id, captureId: row.id });
          }
          for (const link of await listCustomerCapturesForCapture(target.id)) {
            if (link.tenant_id !== tenantId) continue; // same id-only-FK guard
            await insertCustomerCapture({
              tenantId,
              customerId: link.customer_id,
              captureId: row.id,
            });
          }
          // AND THE ASK DIES WITH IT (rung 10). An inbound observation carries
          // its own verbatim copy of the caller's words in `context.words`, and
          // no fold reaches inside an observation — so without this the planner
          // would keep being shown a capture a manager has formally marked
          // recorded-in-error, and could still text somebody about it.
          // Retraction IS the manager saying "this should not be on the
          // record", which is exactly what dismissing the ask means; `recover`
          // is there if they change their mind.
          for (const o of await listObservationsByStatus(tenantId, ['open'])) {
            if (o.subject_ref !== target.id) continue;
            if (!(PINGED_KINDS as string[]).includes(o.kind)) continue;
            await setObservationStatus(
              o.id,
              tenantId,
              {
                status: 'dismissed',
                dismissReason: `the capture was retracted by ${subjectRef}: ${detail.reason}`,
                dismissedAt: new Date().toISOString(),
              },
              ['open'],
            );
          }
        } catch (err) {
          console.error(
            `retract_capture: retraction ${row.id} not fully followed through (links/ask) — ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
        }
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
      // Advisory recompute (facts can change inside the 15-min stage window;
      // the scan reads stored bundles, which the read-time fold never
      // rewrites, so post-commit results equal pre-commit ones).
      return await retractedResult(tenantId, target.id, retractionId);
}

async function handleRecordStandingFact(toolCtx: ToolContext): Promise<unknown> {
  const { args, identity, tenantId, str } = toolCtx;
      const subjectRef = identity.technicianRef;
      const confirmId = str('confirmId');

      if (!confirmId) {
        // STAGE. Nothing is written — the facts are held as ONE review item
        // (one preview, one confirmation for the whole batch) until the
        // person's explicit yes. Batching exists because facts arrive in
        // conversation clumps: staging them one-per-call superseded the
        // earlier token and forced a confusing extra confirmation (live E2E
        // finding 2026-07-14).
        const customerIdArg = str('customerId');
        const jobIdArg = str('jobId');
        if ((customerIdArg ? 1 : 0) + (jobIdArg ? 1 : 0) !== 1) {
          throw new Error('provide exactly one of customerId or jobId');
        }
        // Facts arrive as facts:[{key,value},…] or the single key+value form.
        const factsArg = args.facts;
        if (factsArg !== undefined && (args.key !== undefined || args.value !== undefined)) {
          throw new Error('provide either facts[] or a single key+value, not both');
        }
        let rawFacts: Array<{ key?: unknown; value?: unknown }>;
        if (factsArg !== undefined) {
          if (!Array.isArray(factsArg) || factsArg.length === 0) {
            throw new Error('facts must be a non-empty array of {key, value}');
          }
          if (factsArg.length > 10) throw new Error('at most 10 facts per call');
          rawFacts = factsArg as Array<{ key?: unknown; value?: unknown }>;
        } else {
          rawFacts = [{ key: args.key, value: args.value }];
        }
        const seenKeys = new Set<string>();
        const facts: Array<{ key: string; value: string | number | boolean; previousValue?: Json }> =
          rawFacts.map((f) => {
            const rawKey = f && typeof f === 'object' && typeof f.key === 'string' ? f.key : undefined;
            if (!rawKey) throw new Error('key is required for every fact');
            const key = rawKey
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, '_')
              .replace(/^_+|_+$/g, '');
            if (!key || key.length > 64) {
              throw new Error('key must contain letters/digits and be at most 64 characters when normalized');
            }
            // RESERVED (rung 10): `correspondence` is the job's APPENDED list of
            // what customers said, written by the inbound write-path. A standing
            // fact is a scalar bundle, so writing this key would replace the
            // whole array and lose every entry — silently, and with no undo.
            if (key === CORRESPONDENCE_KEY) {
              // Refused on a CUSTOMER target too, though correspondence only
              // ever lives on a job: one reserved word beats a key that means
              // one thing here and another there.
              throw new Error(
                `'${CORRESPONDENCE_KEY}' is reserved — on a job it holds what customers said ` +
                  'on their calls and emails, written by the record itself, not by this tool; ' +
                  'use a different key',
              );
            }
            // Post-normalization dedupe: "Gate Code" and "gate_code" are the
            // same fact — a batch writing one key twice is ambiguous.
            if (seenKeys.has(key)) throw new Error(`duplicate fact key after normalization: ${key}`);
            seenKeys.add(key);
            const value = f.value;
            if (
              typeof value !== 'string' &&
              typeof value !== 'boolean' &&
              !(typeof value === 'number' && Number.isFinite(value))
            ) {
              throw new Error('value must be a string, number, or boolean');
            }
            if (typeof value === 'string' && value.length > 500) {
              throw new Error('value is too long (max 500 characters) — long context belongs in record_field_note');
            }
            return { key, value };
          });
        // Tenant-guard the target BEFORE it can enter a staged commit: a forged
        // id would otherwise write a fact onto another firm's record.
        let target: 'customer' | 'job';
        let targetId: string;
        let customerId: string;
        let targetName: string | null;
        let currentAttributes: Json;
        if (customerIdArg) {
          const customer = await getCustomer(customerIdArg);
          if (!customer || customer.tenant_id !== tenantId) throw new Error('customer not found');
          target = 'customer';
          targetId = customer.id;
          customerId = customer.id;
          targetName = customer.name;
          currentAttributes = customer.attributes;
        } else {
          const job = await getJob(jobIdArg as string);
          if (!job || job.tenant_id !== tenantId) throw new Error('job not found');
          const customer = await getCustomer(job.customer_id);
          target = 'job';
          targetId = job.id;
          customerId = job.customer_id;
          targetName = `${customer?.name ?? 'unknown customer'}: ${job.title ?? '(untitled job)'}`;
          currentAttributes = job.attributes;
        }
        // Each fact's previous value (unwrapped, retraction-folded — a
        // retracted key reads as absent on every surface, so the preview
        // treats the write as new) rides into the preview so an overwrite is
        // confirmed as an overwrite, never silently. The commit re-checks the
        // exact values (preview == commit): a fact someone ELSE records
        // between stage and confirm must never be clobbered unpreviewed.
        for (const f of facts) {
          const previousValue = await currentFactValue(currentAttributes, f.key);
          if (previousValue !== undefined) f.previousValue = previousValue;
        }
        // One staged BATCH per person: a re-stage supersedes any open one —
        // UNLESS that token's evidence capture already LANDED (a confirm
        // crashed between commit and consume). Dismissing it would strand a
        // permanent evidence row with no path left to finish or honestly
        // report its merge (review finding); it converges via its own
        // confirmId first.
        const openFact = await findOpenReviewItem(tenantId, 'pending_standing_fact', subjectRef);
        if (openFact) {
          if (await getRawCaptureByExternalId(tenantId, `fact:${openFact.id}`)) {
            throw new Error(
              `your previous fact confirmation is still unfinished — call record_standing_fact with confirmId ${openFact.id} first (it completes or reports honestly), then stage this fact`,
            );
          }
          await resolveReviewItem(openFact.id, tenantId, 'dismissed', 'superseded by a new fact');
        }
        const item = await upsertOpenReviewItem({
          tenantId,
          kind: 'pending_standing_fact',
          subjectRef,
          detail: {
            target,
            targetId,
            customerId,
            targetName,
            facts: facts as unknown as Json,
            // `|| null`, not `?? null`: an empty/whitespace sourceText must
            // fall back to the canonical rendering at commit — '' would
            // otherwise become the permanent (undeletable) L1 evidence text.
            sourceText: str('sourceText')?.trim() || null,
            stagedAt: new Date().toISOString(),
          },
        });
        // Echo the ITEM's detail, not local state: two racing stage calls can
        // make the upsert return the other call's open row, and the staged
        // copy is what commits (same rule as send_email / record_field_note).
        const staged = (item.detail ?? {}) as {
          target?: string;
          targetName?: string | null;
          facts?: Array<{ key: string; value: Json; previousValue?: Json }>;
        };
        const stagedFacts = staged.facts ?? [];
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          preview: {
            target: staged.target,
            targetName: staged.targetName,
            facts: stagedFacts,
            // Single-fact calls keep the flat preview fields (agent/back-compat).
            ...(stagedFacts.length === 1
              ? {
                  key: stagedFacts[0].key,
                  value: stagedFacts[0].value,
                  ...(Object.hasOwn(stagedFacts[0], 'previousValue')
                    ? { previousValue: stagedFacts[0].previousValue }
                    : {}),
                }
              : {}),
          },
          note: 'Nothing was recorded. Show the person exactly these facts — ONE confirmation covers all of them; on their explicit yes call again with ONLY confirmId.',
        };
      }

      // CONFIRM. Guarded token lookup: forged / another person's / consumed
      // confirmId matches nothing (every predicate in the WHERE clause).
      const item = await getOpenReviewItem(confirmId, tenantId, {
        kind: 'pending_standing_fact',
        subjectRef,
      });
      if (!item) {
        throw new Error('confirmation not found — call record_standing_fact again with the fact to restage');
      }
      const detail = (item.detail ?? {}) as {
        target?: 'customer' | 'job';
        targetId?: string;
        customerId?: string;
        facts?: Array<{ key?: string; value?: string | number | boolean; previousValue?: Json }>;
        // Legacy single-fact shape (a token staged before the batch deploy):
        key?: string;
        value?: string | number | boolean;
        previousValue?: Json;
        sourceText?: string | null;
        stagedAt?: string;
      };
      // Normalize the legacy single-fact detail into the batch shape so a
      // pre-deploy token still confirms correctly.
      const stagedFacts =
        detail.facts ??
        (detail.key !== undefined && detail.value !== undefined
          ? [
              {
                key: detail.key,
                value: detail.value,
                ...(Object.hasOwn(detail, 'previousValue') ? { previousValue: detail.previousValue } : {}),
              },
            ]
          : undefined);
      // Malformed check FIRST (before expiry): a malformed detail can never
      // have committed — the commit below validates these same fields — so no
      // landed capture can exist for it and the order is safe.
      if (
        !detail.target ||
        !detail.targetId ||
        !detail.customerId ||
        !stagedFacts ||
        stagedFacts.length === 0 ||
        stagedFacts.some((f) => !f.key || f.value === undefined)
      ) {
        throw new Error('staged fact is malformed — restage with the fact');
      }
      // Narrowed locals — closures below must see the narrowed types.
      const target = detail.target;
      const targetId = detail.targetId;
      const facts = stagedFacts as Array<{ key: string; value: string | number | boolean; previousValue?: Json }>;
      const prevEncOf = (f: { previousValue?: Json }) =>
        encodeFactValue(Object.hasOwn(f, 'previousValue') ? f.previousValue : undefined);

      // Read + guard the target row (tenant + attributes shape).
      const readTarget = async () => {
        const row = target === 'customer' ? await getCustomer(targetId) : await getJob(targetId);
        if (!row || row.tenant_id !== tenantId) throw new Error(`${target} not found`);
        return row;
      };
      // Guarded, idempotent merge of ONE fact: commit ONLY if the key still
      // reads exactly as previewed (preview == commit for overwrites).
      //  'already'  — the key's bundle cites this token's capture: an earlier
      //               commit landed; success without rewriting (a stale replay
      //               must never revert a NEWER fact — review finding).
      //  'conflict' — the key changed since staging (another writer, or our
      //               write was itself overwritten): never clobber it.
      //  'applied'  — the CAS write landed against the checked snapshot.
      const guardedMerge = async (
        capture: { id: string; captured_at: string },
        f: { key: string; value: string | number | boolean; previousValue?: Json },
      ): Promise<'applied' | 'already' | 'conflict'> => {
        const bundle: Json = {
          value: f.value,
          sourceCaptureId: capture.id,
          recordedAt: capture.captured_at, // deterministic: retries converge
        };
        for (let attempt = 0; attempt < 3; attempt++) {
          const row = await readTarget();
          const attrs =
            row.attributes && typeof row.attributes === 'object' && !Array.isArray(row.attributes)
              ? (row.attributes as Record<string, Json>)
              : null;
          if (!attrs) throw new Error(`attributes on this ${target} is not a JSON object — refusing to overwrite it`);
          const current = Object.hasOwn(attrs, f.key) ? (attrs[f.key] ?? null) : undefined;
          if (current !== undefined && isFactBundle(current) && current.sourceCaptureId === capture.id) {
            return 'already';
          }
          if (encodeFactValue(await currentFactValue(row.attributes, f.key)) !== prevEncOf(f)) {
            return 'conflict';
          }
          const updated =
            target === 'customer'
              ? await trySetCustomerAttribute(row as Customer, f.key, bundle)
              : await trySetJobAttribute(row as Job, f.key, bundle);
          if (updated) return 'applied';
          // CAS miss: the row changed under us — re-read and re-check.
        }
        throw new Error(`this ${target} is being updated concurrently`);
      };
      // Merge the whole batch against a landed capture and report honestly:
      // applied/already keys succeed; a (rare, post-capture) per-key conflict
      // is skipped — NEVER clobbered — and named in the result.
      const mergeBatch = async (capture: { id: string; captured_at: string }) => {
        const recordedKeys: string[] = [];
        const conflictKeys: string[] = [];
        for (const f of facts) {
          const outcome = await guardedMerge(capture, f);
          if (outcome === 'conflict') conflictKeys.push(f.key);
          else recordedKeys.push(f.key);
        }
        if (recordedKeys.length === 0) {
          // Everything conflicted — nothing of this token can ever land.
          try {
            await resolveReviewItem(item.id, tenantId, 'dismissed', 'facts changed while confirmation was pending');
          } catch {
            /* advisory */
          }
          throw new Error(
            `facts NOT recorded: ${conflictKeys.map((k) => `'${k}'`).join(', ')} changed on this ${target} while the confirmation was pending — nothing was overwritten; restage to see the current values`,
          );
        }
        try {
          await resolveReviewItem(
            item.id,
            tenantId,
            'resolved',
            `facts recorded by ${subjectRef}` +
              (conflictKeys.length > 0 ? ` (skipped changed keys: ${conflictKeys.join(', ')})` : ''),
          );
        } catch {
          /* advisory — a replay treats the landed state as success */
        }
        return {
          status: 'recorded',
          captureId: capture.id,
          target,
          targetId,
          keys: recordedKeys,
          // Single-fact calls keep the flat key field (back-compat).
          ...(facts.length === 1 ? { key: facts[0].key } : {}),
          ...(conflictKeys.length > 0
            ? {
                conflictKeys,
                note: 'these keys changed while confirming and were NOT overwritten — restage them to see the current values',
              }
            : {}),
        };
      };
      // THE RESERVED KEY, CHECKED ON THE CONFIRM PATH TOO (rung 10). The stage
      // branch refuses it, but confirm re-reads `detail.facts` off the staged
      // item and re-validates nothing — so a token staged BEFORE this deploy
      // would still reach trySetJobAttribute and replace the whole
      // correspondence ARRAY with a scalar fact bundle. That is the one
      // destructive write on this path and it has no undo.
      //
      // HERE, not inside guardedMerge, and the position is the whole fix: a
      // throw after the L1 append would strand a permanent orphan capture and
      // leave the token open, and the wrapper below would tell the agent to
      // "retry with the SAME confirmId to converge" — which it never can. A
      // reserved key can only ever fail, so the token dies now, before
      // anything lands (the conflictOut posture).
      const reserved = facts.filter((f) => f.key === CORRESPONDENCE_KEY);
      if (reserved.length > 0) {
        try {
          await resolveReviewItem(item.id, tenantId, 'dismissed', 'reserved key');
        } catch {
          /* advisory */
        }
        throw new Error(
          `facts NOT recorded: '${CORRESPONDENCE_KEY}' is reserved — it holds what customers ` +
            'said about this job, written from their calls and emails; restage under a ' +
            'different key',
        );
      }

      const conflictOut = async (changedKeys: string[]): Promise<never> => {
        // The token dies: retrying it could only re-hit the conflict, and the
        // technician must see the CURRENT values before overwriting them.
        try {
          await resolveReviewItem(item.id, tenantId, 'dismissed', 'facts changed while confirmation was pending');
        } catch {
          /* advisory */
        }
        throw new Error(
          `facts NOT recorded: ${changedKeys.map((k) => `'${k}'`).join(', ')} changed on this ${target} while the confirmation was pending — nothing was overwritten; restage to see the current values`,
        );
      };

      if (detail.stagedAt && Date.now() - Date.parse(detail.stagedAt) > 15 * 60_000) {
        // Late retry after a commit-then-crash: if this token's capture already
        // landed, finish the guarded merge and report honestly instead of
        // expiring into a confusing restage.
        const landed = await getRawCaptureByExternalId(tenantId, `fact:${item.id}`);
        if (landed) return await mergeBatch(landed);
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'staging expired');
        throw new Error('staged fact expired — restage and confirm again');
      }

      // COMMIT FIRST, consume second: (1) the ONE L1 evidence capture for the
      // whole batch, idempotent via the externalId stamp; (2) the guarded
      // per-fact merges. A crash between them leaves the token open and a
      // retried confirm converges. One capture per batch also means one
      // retraction removes the whole batch — the evidence and its facts share
      // a lifecycle.
      let capture = await getRawCaptureByExternalId(tenantId, `fact:${item.id}`);
      if (!capture) {
        // Drift pre-check on EVERY key BEFORE the L1 append: a conflict
        // discovered after the evidence landed would strand a permanent
        // orphan capture; caught here, the failure leaves no row at all.
        // (mergeBatch re-checks under the CAS for the residual window.)
        const row = await readTarget();
        const changed: string[] = [];
        for (const f of facts) {
          if (encodeFactValue(await currentFactValue(row.attributes, f.key)) !== prevEncOf(f)) {
            changed.push(f.key);
          }
        }
        if (changed.length > 0) return await conflictOut(changed);
        const canonical =
          facts.length === 1
            ? `Standing fact: ${facts[0].key} = ${String(facts[0].value)}`
            : `Standing facts: ${facts.map((f) => `${f.key} = ${String(f.value)}`).join('; ')}`;
        try {
          capture = await appendRawCapture({
            tenantId,
            channel: 'technician_note',
            technicianRef: subjectRef,
            rawText: detail.sourceText ?? canonical,
            externalId: `fact:${item.id}`,
            customerId: detail.customerId,
            ...(target === 'job' ? { jobId: targetId } : {}),
            metadata: { standingFactKeys: facts.map((f) => f.key), target, stagedConfirmId: item.id },
          });
        } catch (err) {
          // TOCTOU backstop: this token's capture landed concurrently — reuse it.
          if (isUniqueViolation(err)) {
            capture = await getRawCaptureByExternalId(tenantId, `fact:${item.id}`);
          }
          if (!capture) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(
              `facts NOT recorded: ${msg} — the staged facts are still held; retry with the SAME confirmId (do not restage)`,
            );
          }
        }
      }
      try {
        return await mergeBatch(capture);
      } catch (err) {
        // A conflict dismissal from mergeBatch passes through untouched; an
        // infrastructure error keeps the token open — a retry with the SAME
        // confirmId re-runs this commit under the SAME externalId and
        // converges (already-applied keys are recognized, not rewritten).
        // "may be partially recorded", not "NOT recorded": earlier facts in
        // the batch can already have applied before the failure (review
        // finding — the wording must never claim less landed than did).
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('NOT recorded')) throw err;
        throw new Error(
          `facts may be only PARTIALLY recorded: ${msg} — the staged facts are still held; retry with the SAME confirmId to converge (do not restage)`,
        );
      }
}

    // The planner's own notes (build 3, plan 2026-08-30). Gated by
    // TEAM_LEAD_ONLY_TOOL_NAMES above like recall_decisions, so these dispatch
    // for the `spine:` namespace and nothing else — memory is FIRM-SCOPED and
    // the firm is `tenantId` from the verified HMAC identity, never an argument.
    // The planner's per-job notepads (plan 2026-08-30). Gated by
    // TEAM_LEAD_ONLY_TOOL_NAMES like the memory verbs, so they dispatch for the
    // `spine:` namespace and nothing else.
    //
    // BOTH RESOLVE THE JOB AND CHECK ITS TENANT FIRST. The job_id foreign key
    // proves a job EXISTS; it never proves it belongs to the caller's firm, and
    // getJob takes only an id. Without this a note could be written against
    // another firm's job — keyed to the caller so it could not leak, but still
    // a row about work they do not own. Reads as NOT FOUND rather than as an
    // error, the get_job posture: a distinct error would confirm the id exists.
async function handleReadJobNote(toolCtx: ToolContext): Promise<unknown> {
  const { name, args, tenantId, str } = toolCtx;
      const jobId = str('jobId');
      if (!jobId) throw new Error('jobId is required (copy it from the gap\'s `job id` line)');
      const job = await getJob(jobId);
      if (!job || job.tenant_id !== tenantId) {
        return {
          status: 'ok',
          jobId,
          exists: false,
          note: 'No such job on this firm — check the id against the gap you are looking at.',
        };
      }
      if (name === 'read_job_note') {
        const row = await readJobNote(tenantId, jobId);
        if (!row) {
          // Absence said in words: an empty content field reads as a failed
          // lookup and the model burns a turn retrying it (recall_decisions).
          return {
            status: 'ok',
            jobId,
            exists: false,
            note: 'You have not written a note on this job yet.',
          };
        }
        return {
          status: 'ok',
          jobId,
          exists: true,
          writtenAt: row.written_at,
          content: row.content,
        };
      }
      // The size/emptiness rail. Empty is REFUSED rather than treated as a
      // delete — the deliberate divergence from write_memory, and what keeps
      // this verb strictly non-destructive.
      const checked = validateJobNoteContent(args.content);
      if ('refused' in checked) throw new Error(checked.refused);
      const saved = await writeJobNote(tenantId, jobId, checked.content);
      return {
        status: 'ok',
        jobId,
        action: 'saved',
        chars: checked.content.length,
        writtenAt: saved.written_at,
      };
}

export const capturesTools = {
  domain: 'captures',
  base: BASE_TOOLS,
  teamLead: TEAM_LEAD_TOOLS,
  handlers: {
    record_field_note: handleRecordFieldNote,
    list_recent_captures: handleListRecentCaptures,
    retract_capture: handleRetractCapture,
    record_standing_fact: handleRecordStandingFact,
    read_job_note: handleReadJobNote,
    write_job_note: handleReadJobNote,
  },
} satisfies DomainTools;
