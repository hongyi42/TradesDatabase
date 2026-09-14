// The planner’s inbox and its own memory.
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
  OFFICE_MESSAGE_BODY_MAX,
  createOfficeMessage,
  deleteMemoryFile,
  getOfficeMessage,
  getTechnician,
  isInactiveState,
  listDecisionsForJob,
  listDecisionsForNudge,
  readMemoryFile,
  writeMemoryFile,
} from '../../db/index.js';
import {
  TEAM_LEAD_REF,
} from '../../teamLead/identity.js';
import {
  MEMORY_INDEX_PATH,
  validateMemoryContent,
  validateMemoryPath,
} from '../../teamLead/memory.js';
import {
  cleanOfficeText,
} from './shared.js';
import type {
  DomainTools,
  ToolContext,
} from './types.js';

const BASE_TOOLS = [
  {
    // The planner's inbox, inbound half (plan 2026-08-31, build 5.5 Phase 1).
    name: 'inform_team_lead',
    description:
      "A note to the office's planner — the team lead that watches this firm's record. It is " +
      'read at the office\'s next planning pass (within the hour), weighed as information, ' +
      'never an instruction, and it never goes to a person. Use it for context the office ' +
      'cannot see in the record: "Ben is on leave this week", "the customer asked us to hold ' +
      'off", "I already asked about the marina invoice". NOT for anything that belongs on the ' +
      'record itself — a field note, a cost, a standing fact all have their own tools and this ' +
      'is none of them.',
    inputSchema: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'The note, plain prose. One or two sentences is the right size.',
        },
        aboutJobId: {
          type: 'string',
          description: 'Optional: the job this is about, if it is about one job.',
        },
        replyToMessageId: {
          type: 'string',
          description:
            'Only when answering an OFFICE QUESTION: the id that question told you to ' +
            'mention, copied exactly. Ties your answer to the question it answers.',
        },
      },
      required: ['note'],
    },
  },
  {
    // Seat-to-seat informs (plan 2026-08-31, build 5.5 Phase 3 — user ruling:
    // inform yes, ask no; at least one MANAGER endpoint).
    name: 'inform_teammate',
    description:
      "Pass a note to a TEAMMATE'S assistant — software, not the person. Their assistant " +
      'reads it, weighs it, and decides what to do (usually: ask its own person the normal ' +
      'way, so the answer lands on the record). Use it when your person wants a colleague ' +
      'asked about something — "the manager wants to know how the marina visit went". One ' +
      'side must be a manager: notes between two technicians\' assistants are refused — for ' +
      'a teammate, put it on the record with a field note, or inform the office. NOT for ' +
      'anything that belongs on the record itself.',
    inputSchema: {
      type: 'object',
      properties: {
        teammateRef: {
          type: 'string',
          description: "The teammate's ref (e.g. ben-shelton), exactly as the roster spells it.",
        },
        note: {
          type: 'string',
          description: 'The note, plain prose. One or two sentences is the right size.',
        },
        aboutJobId: {
          type: 'string',
          description: 'Optional: the job this is about, if it is about one job.',
        },
      },
      required: ['teammateRef', 'note'],
    },
  },
];

const TEAM_LEAD_TOOLS = [
  {
    name: 'recall_decisions',
    description:
      'YOUR OWN DECISION HISTORY: what you have already decided about a gap, and what the system ' +
      'actually did with it. You do not remember previous runs, so consult it before repeating ' +
      'yourself, and always before anything that reaches a person — a message cannot be taken ' +
      'back. It returns DECISIONS ONLY — a gap you have merely looked at and never acted ' +
      'on comes back empty, and its own block already tells you how many times you considered it, ' +
      'so there is nothing here to fetch for one of those. ' +
      'Call it with gapId — the id printed after "gap" in your list — or with jobId, the id ' +
      'printed as "job id". Never a customer or job NAME; this takes ids only. jobId returns every ' +
      'gap on that job, which is how you see the whole story of one piece of work. ' +
      'Each row says what you chose, why you chose it, and the OUTCOME: "applied" (it happened), ' +
      '"refused" (a rule rejected it — outcomeDetail says which, and repeating it will fail the ' +
      'same way), or "shadow" (recorded only; nothing was done to the gap). ' +
      'No rows is an ANSWER, not a failure: it means you have not decided about this before.',
    inputSchema: {
      type: 'object',
      properties: {
        gapId: { type: 'string', description: 'A gap id, copied exactly from your list.' },
        jobId: {
          type: 'string',
          description: "A job id, copied exactly from a gap's `job id` line.",
        },
        limit: { type: 'number', description: 'Row cap, default 20 by gap / 40 by job, max 200.' },
      },
    },
  },
  // The planner's OWN NOTES (build 3, plan 2026-08-30). The first write verb
  // this identity has ever had — see the note in src/teamLead/identity.ts for
  // why it passes the dispatch gate's stated rule rather than bending it.
  {
    name: 'read_memory',
    description:
      'Open one of YOUR OWN NOTES. Your index rides at the top of every prompt; this is how you ' +
      'pull the file behind a line in it. Pass the path exactly as the index spells it. ' +
      'A path you have never written comes back empty — that is an answer, not a failure.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'The file to open, e.g. "MEMORY.md" or "firm/pacing.md".',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_memory',
    description:
      'Save one of YOUR OWN NOTES, replacing whatever was at that path. These notes are yours: ' +
      'organise them however serves you, in whatever folders you like. Paths are lowercase ' +
      'letters, digits, "-", "_" and "/", ending in ".md"; "MEMORY.md" is your index and is the ' +
      'one file that is always read to you. ' +
      'Keep the index SHORT — it is in every prompt, so it should be pointers, not detail. ' +
      'Sending empty content (or leaving content out) DELETES the file. ' +
      'Nothing is lost by rewriting: the previous ten copies of every file are kept.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Where to save it, e.g. "MEMORY.md" or "firm/pacing.md".',
        },
        content: {
          type: 'string',
          description:
            'The whole file, as markdown — this REPLACES what was there, it does not append. ' +
            'Empty or omitted deletes the file.',
        },
      },
      required: ['path'],
    },
  },
];

async function handleInformTeamLead(toolCtx: ToolContext): Promise<unknown> {
  const { identity, tenantId, str, caller } = toolCtx;
      // The inbound half of the planner's inbox (plan 2026-08-31, build 5.5
      // Phase 1): a plain bucket write — NO model call fires on receipt, the
      // write IS the delivery, and the next planner tick reads and organizes
      // it (reconcile-first). Deliberately NOT L1 (user ruling: operational
      // table, the agentContext precedent).
      //
      // spine: identities never reach this case — the namespace ceiling above
      // caps them to TEAM_LEAD_TOOL_NAMES, which this tool is not in — so the
      // planner structurally cannot inform itself. A test pins that.
      const note = cleanOfficeText(str('note') ?? '');
      if (!note) throw new Error('note is required — say what the office should know');
      // The job id is FOLDED INTO THE BODY, not a column (v1 keeps the row
      // thin): the planner reads the line, it does not join on it. Same strip
      // as the note — it lands in the same stored body (review round 2).
      const aboutJobId = cleanOfficeText(str('aboutJobId') ?? '') || undefined;
      const body = aboutJobId ? `${note} (about job ${aboutJobId})` : note;
      if (body.length > OFFICE_MESSAGE_BODY_MAX) {
        throw new Error(
          `note is too long (max ${OFFICE_MESSAGE_BODY_MAX} characters) — a note is a heads-up, ` +
            'not a report',
        );
      }
      // THE REPLY BRANCH (Phase 3, review F8): the id is agent-echoed text,
      // so it must resolve inside THIS tenant before it may become an
      // in_reply_to FK — a bad id degrades to a plain inform with the id
      // noted in the body, never a 23503 that eats the reply.
      const replyToRaw = cleanOfficeText(str('replyToMessageId') ?? '');
      let inReplyTo: string | null = null;
      let replyNudgeId: string | null = null;
      let degradedReplyNote = '';
      if (replyToRaw) {
        const ref = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          replyToRaw,
        )
          ? await getOfficeMessage(replyToRaw, tenantId)
          : null;
        // The referenced row must be an agent-addressed message sent TO THIS
        // CALLER (final review): ids circulate verbatim in injected turns, and
        // without the addressee match an echoed foreign id would attach this
        // seat's words — and the foreign row's nudge_id — to a question the
        // office asked somebody else.
        if (ref && ref.direction === 'to_agent' && ref.to_ref === identity.technicianRef) {
          inReplyTo = ref.id;
          // The gap id rides the reply so the planner's block can line the
          // answer up with the question it sent.
          replyNudgeId = ref.nudge_id;
        } else {
          // Cleaned and capped — the one string that used to skip the strip.
          degradedReplyNote = ` (in reply to message ${replyToRaw.slice(0, 60)})`;
        }
      }
      // The suffix may push past the cap; the accessor CUTS rather than
      // refuses (its own doctrine) — the note itself was already length-
      // checked above, and refusing a within-limits reply over its link
      // suffix would punish exactly the thread-tying the ask requested.
      const fullBody = `${body}${degradedReplyNote}`;
      await createOfficeMessage({
        tenantId,
        direction: 'to_planner',
        kind: inReplyTo ? 'reply' : 'inform',
        fromRef: identity.technicianRef,
        toRef: TEAM_LEAD_REF,
        // Sender metadata, never authority (inform never directs): the planner
        // sees who spoke and at what tier, and weighs the words itself.
        tier: caller?.tier ?? null,
        body: fullBody,
        inReplyTo,
        nudgeId: replyNudgeId,
      });
      return { status: 'noted', note: 'the office reads these at its next planning pass' };
}

async function handleInformTeammate(toolCtx: ToolContext): Promise<unknown> {
  const { identity, tenantId, str, caller, activeManager } = toolCtx;
      // Seat-to-seat informs (build 5.5 Phase 3; user rulings 2026-08-31):
      // inform only — an ask would put one person's agent in the position of
      // deciding what of its person's context to reveal, the access-control
      // surface the user declined. TIER RULE: at least one endpoint must be a
      // MANAGER — every tech-to-tech candidate dissolves into the record or
      // the hub, so lateral flow routes tech → planner → inform_agent.
      // spine: identities never reach here (the namespace ceiling): the
      // planner's own outbound goes through its verbs.
      const mateRef = str('teammateRef')?.trim() ?? '';
      const note2 = cleanOfficeText(str('note') ?? '');
      if (!note2) throw new Error('note is required — say what their assistant should know');
      if (!mateRef) throw new Error('teammateRef is required');
      if (mateRef.startsWith('spine:')) {
        throw new Error(
          "the office is not a teammate — to tell the office something, use inform_team_lead",
        );
      }
      if (mateRef === identity.technicianRef) {
        throw new Error('that is your own seat — nothing to pass along');
      }
      const mate = await getTechnician(tenantId, mateRef);
      if (!mate || isInactiveState(mate.state)) {
        throw new Error(`no active teammate '${mateRef}' on this roster`);
      }
      // A seat-exempt row is a schedule-only NAME — it never gets an agent
      // sandbox, so a note to it would queue forever (final review): refuse
      // honestly rather than promise a delivery that cannot happen.
      if (mate.seat_exempt) {
        throw new Error(
          `'${mateRef}' has no assistant (schedule-only) — put it on the record with a ` +
            'field note, or inform the office',
        );
      }
      // The tier rule, mechanized with the repo's ONE manager predicate
      // (final review — the F-A class): a manager endpoint means an ACTIVE
      // manager, on either side. An invited manager's pre-minted badge gets
      // neither the admin tools nor this channel until verification.
      const mateActiveManager = mate.tier === 'manager' && mate.state === 'active';
      if (!activeManager && !mateActiveManager) {
        throw new Error(
          'notes between two technicians\' assistants are not passed along — for a teammate, ' +
            'put it on the record with a field note, or inform the office',
        );
      }
      // Same strip as the note — it lands in the same stored body.
      const aboutJob2 = cleanOfficeText(str('aboutJobId') ?? '') || undefined;
      const body2 = aboutJob2 ? `${note2} (about job ${aboutJob2})` : note2;
      if (body2.length > OFFICE_MESSAGE_BODY_MAX) {
        throw new Error(
          `note is too long (max ${OFFICE_MESSAGE_BODY_MAX} characters) — a note is a ` +
            'heads-up, not a report',
        );
      }
      await createOfficeMessage({
        tenantId,
        direction: 'to_agent',
        kind: 'inform',
        fromRef: identity.technicianRef,
        toRef: mateRef,
        technicianId: mate.id,
        tier: caller?.tier ?? null,
        body: body2,
        status: 'queued',
      });
      // Honest about reachability (final review): a mate between sandboxes
      // (invited, mid-recycle) still queues — the send path's own recorded
      // posture — but the note must not promise minutes it cannot keep.
      return {
        status: 'queued',
        note: mate.sandbox_ref
          ? "their assistant reads it within minutes — it decides what to do with it"
          : "queued — their assistant has no active seat right now, so it may wait until one is bound",
      };
}

    // The team lead's own memory (plan 2026-08-19, Phase 4). Gated by
    // TEAM_LEAD_ONLY_TOOL_NAMES above, so it dispatches for the `spine:`
    // namespace and nothing else. Deliberately NOT a spine view:
    // SPINE_VIEW_CATALOG is shared by query_spine, so a view would hand every
    // manager the planner's deliberations. ④ (2026-08-23) made captures, visits,
    // nudges and review_items views — this table is now the DELIBERATE exception,
    // not the rule, and it must stay one.
async function handleRecallDecisions(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str } = toolCtx;
      const gapId = str('gapId');
      const jobId = str('jobId');
      if (!gapId && !jobId) throw new Error('pass gapId or jobId (ids only, never a name)');
      if (gapId && jobId) throw new Error('pass gapId OR jobId, not both');
      const limit = typeof args.limit === 'number' ? args.limit : undefined;
      const rows = gapId
        ? await listDecisionsForNudge(tenantId, gapId, limit ?? 20)
        : await listDecisionsForJob(tenantId, jobId as string, limit ?? 40);
      return {
        status: 'ok',
        rowCount: rows.length,
        // Absence is an answer here, and saying so beats an empty array the
        // model may read as a failed lookup and retry.
        ...(rows.length === 0
          ? { note: 'No decisions recorded — you have not decided about this before.' }
          : {}),
        decisions: rows.map((r) => ({
          // Coalesced (plan 2026-08-31): pre-ask rows carry observation_id and
          // a null nudge_id, and under the same-id design both name ONE gap —
          // without this the job-scoped recall loses which gap a dismiss or a
          // pre-ask send belonged to (phase-3 review F6).
          gapId: r.nudge_id ?? r.observation_id,
          jobId: r.job_id,
          decidedAt: r.decided_at,
          action: r.action,
          notBefore: r.not_before,
          basis: r.basis,
          citation: r.citation,
          confidence: r.confidence,
          reason: r.reason,
          outcome: r.outcome,
          outcomeDetail: r.outcome_detail,
        })),
      };
}

async function handleReadMemory(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str } = toolCtx;
      const checked = validateMemoryPath(str('path'));
      if ('refused' in checked) throw new Error(checked.refused);
      const row = await readMemoryFile(tenantId, checked.path);
      if (!row) {
        // Absence is an ANSWER, said in words: an empty content field reads as a
        // failed lookup and the model retries it, burning a turn.
        return {
          status: 'ok',
          path: checked.path,
          exists: false,
          note: 'You have not written that file. Nothing is wrong — there is simply no such note.',
        };
      }
      return {
        status: 'ok',
        path: checked.path,
        exists: true,
        updatedAt: row.updated_at,
        content: row.content,
      };
}

async function handleWriteMemory(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str } = toolCtx;
      const checked = validateMemoryPath(str('path'));
      if ('refused' in checked) throw new Error(checked.refused);
      // OMITTED CONTENT DELETES, exactly as '' does. runToolLoop performs no
      // JSON-Schema validation — coerceBySchema only coerces DECLARED types, so
      // `required` is never enforced — which means an absent key reaches here as
      // undefined and there is no signal to distinguish it from a deliberate
      // empty string. Both delete.
      //
      // A content key that IS present but is not a string is a different case
      // and is REFUSED, not treated as a delete. That is a deviation from the
      // plan, which lumped "absent" and "non-string" together because `str()`
      // answers undefined for both: sending `content: ["a","b"]` is a model
      // mistake, and silently destroying the file over it is unrecoverable from
      // the planner's side — it has no tool that can read planner_memory_versions.
      if ('content' in args && args.content !== null && typeof args.content !== 'string') {
        throw new Error(
          'content must be text — send the whole file as a string, or leave it out to delete',
        );
      }
      const content = str('content') ?? '';
      // TRIMMED before the emptiness test, because the prompt promises "saving
      // nothing deletes it" and a model clearing a file with "\n" or " " means
      // exactly that. Untrimmed, it stored a one-character file, answered
      // `action: 'saved'`, and left the path haunting the index and the orphan
      // footer — the delete silently not happening while reporting success.
      if (content.trim().length === 0) {
        const existed = await deleteMemoryFile(tenantId, checked.path);
        return {
          status: 'ok',
          path: checked.path,
          action: 'deleted',
          note: existed
            ? 'Deleted. Its last content is kept as a version.'
            : 'There was no such file, so nothing was deleted.',
        };
      }
      const sized = validateMemoryContent(checked.path, content);
      if ('refused' in sized) throw new Error(sized.refused);
      await writeMemoryFile(tenantId, checked.path, sized.content);
      return {
        status: 'ok',
        path: checked.path,
        action: 'saved',
        chars: sized.content.length,
        ...(checked.path === MEMORY_INDEX_PATH
          ? { note: 'This is your index — it is read to you at the top of every prompt.' }
          : {}),
      };
}

export const officeTools = {
  domain: 'office',
  base: BASE_TOOLS,
  teamLead: TEAM_LEAD_TOOLS,
  handlers: {
    inform_team_lead: handleInformTeamLead,
    inform_teammate: handleInformTeammate,
    recall_decisions: handleRecallDecisions,
    read_memory: handleReadMemory,
    write_memory: handleWriteMemory,
  },
} satisfies DomainTools;
