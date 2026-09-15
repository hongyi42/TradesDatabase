// Customers and jobs.
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
  DURATION_LADDER,
  JOB_PRIORITIES,
  MAX_DURATION_MINUTES,
  TERMINAL_JOB_STATUSES,
  annotateResolvedReviewItem,
  appendJobCorrespondence,
  correspondenceEntries,
  createJob,
  factSourceIds,
  findJobTypeDurationMinutes,
  findRetractionsFor,
  foldRetractedCorrespondence,
  foldRetractedFacts,
  formatDuration,
  getCustomer,
  getCustomerContents,
  getJob,
  getObservationForTenant,
  getOpenReviewItem,
  getRawCapture,
  getTechnician,
  listJobsForCustomer,
  listL2CitingCapture,
  listMoneyEventsForJob,
  listOpenJobsForCustomer,
  resolveOpenReviewItemFor,
  resolveReviewItem,
  searchCustomers,
  summarizeMoney,
  technicianMoneyView,
  upsertOpenReviewItem,
} from '../../db/index.js';
import type {
  JobPriority,
  Json,
} from '../../db/index.js';
import {
  emailAddressOf,
  isOwnMailbox,
  soleRecipientOf,
} from '../../email/format.js';
import {
  cancelJob,
  jobVisitsStillApproved,
  openWorkSteer,
  previewCancelJob,
  snapshotJobVisits,
  updateJobIdentity,
  type ApprovedJobVisit,
} from '../../schedule/booking.js';
import {
  correspondenceOf,
  recordFieldNote,
} from '../../writePath/recordFieldNote.js';
import type {
  ResolvedIdentity,
} from '../../writePath/recordFieldNote.js';
import {
  UUID_RE,
  callerTierOf,
  inboundAskFor,
  leanGrounding,
  recordCallerThroughTheDoor,
  refuseNameAsAddress,
} from './shared.js';
import type {
  DomainTools,
  ToolContext,
} from './types.js';

const BASE_TOOLS = [
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
    description:
      'The CONTENTS PAGE for a customer — fixed size, never their whole history. It carries the ' +
      'profile and standing facts; up to 10 jobs — every job still in progress, unbooked or ' +
      'unpaid first, then the newest finished ones — each with status, attributes, ' +
      'noteCount (notes you may read), restrictedCount (notes on file but outside your view), ' +
      'retractedCount (managers: notes retracted as recorded in error — ' +
      'list_recent_captures(jobId, includeRetracted: true) shows each with its reason), ' +
      "lastCaptureAt, lastVisitAt and `newest` — the newest note's first 200 characters with its " +
      'captureId; olderJobs says how many more (finished) jobs are on file but not shown — ' +
      'get_job(jobId) reads one; customerLevelNotes is what was filed ' +
      'on the customer with no job. To READ a job\'s notes call list_recent_captures(jobId) — it ' +
      'pages; for one note\'s full words call get_capture(captureId). Answer from what is on the ' +
      'page when it is enough, and open only what you need. ' +
      "upcomingVisits is the schedule ahead — use it for \"when is X's next visit?\" " +
      'and read each entry as-is: date + startTime are the visit as booked, and an entry with ' +
      'untimed:true is a REAL booked visit with NO time set yet — say exactly that (never say ' +
      'nothing is scheduled when an untimed entry exists, and never invent a day or time for ' +
      'one; nothing in the record says when it should happen). ' +
      "When you NAME a visit's day, SAY the entry's `phrase` VERBATIM (\"Tuesday 2026-08-18\") — " +
      'never re-derive the weekday or restate the date yourself; you are unreliable at both. ' +
      "Each job's lastVisitAt is past work evidence, not the schedule. When the result carries an " +
      'openWorkNote, the customer has work with NO visit booked: "next opening / availability / ' +
      'earliest you could come" questions are about THAT work — answer them with ' +
      'find_slots(jobId), never from upcomingVisits. moneyByJob is the money position per job; ' +
      'A job\'s attributes.correspondence is WHAT THE CUSTOMER SAID about it on their own calls ' +
      'and emails, each entry naming the capture it came from — their words, not the firm\'s. ' +
      'within it, materialCostCents is what that job COST the firm in parts/materials — never ' +
      'add it to invoiced/paid/balance due, and never call revenue minus it "margin" or ' +
      '"profit" (it carries no labour).',
    inputSchema: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
  },
  {
    name: 'get_job',
    description:
      'Fetch one job by id. If a money summary comes back, materialCostCents is what the job ' +
      'COST the firm in parts/materials — never add it to invoiced/paid/balance due, and never ' +
      'call revenue minus it "margin" or "profit" (there is no labour rate in it). ' +
      'attributes.correspondence is WHAT THE CUSTOMER SAID about this job on their own calls and ' +
      'emails, newest last, each entry naming the capture it came from — their words and their ' +
      'requests, not the firm\'s notes or anything a technician did.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
];

const ADMIN_TOOLS = [
  {
    // RUNG 10. Until this existed there was NO way to open a job without also
    // putting a visit on the calendar: `book_visit`'s customerId path minted a
    // shell as a side effect of booking. A customer who rings for a quote wants
    // the job on file and nobody sent out yet, and the office now asks a
    // manager exactly that question — so the answer needs a verb.
    name: 'open_job',
    description:
      'Open a job for a customer WITHOUT putting anything on the calendar (manager only) — ' +
      'one step, no confirmation: a job is cancellable, and the manager just asked for it. ' +
      'Use it when the office tells you a customer got in touch and asks whether to open the ' +
      'job, and the manager says yes but nobody is being sent out yet (a quote, an estimate, ' +
      'work to schedule later). If they ALSO want someone sent, use book_visit instead — it mints ' +
      'the job in the same call, so do not call both: give it the day and both times if the ' +
      'manager stated them, or `untimed: true` if the timing genuinely is not settled. REFUSED when the customer already has open work, with the list: pass ' +
      'the matching job to whatever you do next, or forceNewJob:true only if this is genuinely ' +
      'different new work. Returns the job with its id and title — tell the manager the title, ' +
      'in the same breath, because it is your words that reached the permanent record.',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string', description: 'The customer this job is for (find_customer).' },
        title: {
          type: 'string',
          description:
            "Short title for the work, in the manager's or the caller's words — e.g. " +
            '"no heat upstairs". Say it back to the manager: it goes on the record.',
        },
        jobType: { type: 'string', description: 'Trade/category, e.g. "hvac", "plumbing".' },
        priority: {
          type: 'string',
          enum: JOB_PRIORITIES,
          description: 'Triage tier. Defaults to routine.',
        },
        forceNewJob: {
          type: 'boolean',
          description:
            'ONLY when the customer has open work already AND this is genuinely different ' +
            'new work. Read the refusal list first.',
        },
      },
      required: ['customerId', 'title'],
    },
  },
  {
    name: 'cancel_job',
    description:
      'Cancel the WORK itself (manager only) — TERMINAL: the job closes for good (there is ' +
      'no un-cancel; work that revives later is a NEW job), it leaves the loose bucket, and ' +
      'every remaining scheduled visit comes off the calendar with it. ALWAYS two-step: the ' +
      'first call returns {status:"needs_confirmation", confirmId} with a preview naming the ' +
      'job and each visit that would die — show it, get an ' +
      'explicit yes, call again with ONLY confirmId. Call with jobId + reason. For taking ' +
      'ONE visit off the calendar while the work continues, use unschedule_visit instead. ' +
      'If the manager\'s words could mean either ("cancel the Hendersons"), ASK which they ' +
      'mean — never guess. When the result carries boardNote, ALWAYS end your report with ' +
      'its exact [See it on the board](…) line.',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job (the WORK) to cancel. First call only.' },
        reason: { type: 'string', description: 'Why (kept on the record). First call only.' },
        confirmId: { type: 'string', description: 'Set ONLY on the confirming second call.' },
      },
      required: [],
    },
  },
  {
    name: 'update_job',
    description:
      "Correct an existing job's IDENTITY (manager only): title, jobType, priority, and/or " +
      'durationMinutes — pass jobId plus any of them. Reversible and internal → done in ONE ' +
      'call; ALWAYS ' +
      'tell the manager exactly what changed (old → new). THIS is how a wrong or assumed job ' +
      'title gets fixed — the title displays on the board and every schedule read, so correct ' +
      'it here, never by only recording a fact. Setting durationMinutes is what makes the job ' +
      'PLACEABLE: scheduling reads the job’s own length FIRST; the jobType’s stored ' +
      'set_job_duration value is only the fallback when the job has no length of its own. ' +
      'If an edit leaves the job (or its newly set type) without a usable length, the result ' +
      'warns — relay that warning. ' +
      'Pass jobType: null to CLEAR a mistaken type back to untyped. It never touches visits, ' +
      'dates, times, or job status (move_visit / unschedule_visit own those).',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string', description: 'The job to correct.' },
        title: { type: 'string', description: 'New title, as the manager states the work.' },
        jobType: {
          type: ['string', 'null'],
          description:
            "New job type (free text, stored lowercase — match set_job_duration's types so " +
            'the stored duration applies). Pass null to CLEAR a mistaken type back to untyped.',
        },
        priority: {
          type: 'string',
          enum: ['emergency', 'urgent', 'routine', 'maintenance'],
          description: 'New triage tier.',
        },
        durationMinutes: {
          type: ['integer', 'null'],
          // NO enum — free minutes are allowed. The rungs are OFFERED in the
          // text so the agent proposes them as choices; a manager who says
          // "20 minutes" gets 20, not a rounded lie.
          minimum: 1,
          maximum: MAX_DURATION_MINUTES,
          description:
            'How long this job takes, in whole minutes. Offer these first: ' +
            `${DURATION_LADDER.join(', ')}. Any other whole number is fine if the manager ` +
            'states one. ASK the manager; NEVER pick a length yourself. Pass null to clear ' +
            'it back to unknown.',
        },
      },
      required: ['jobId'],
    },
  },
];

const TEAM_LEAD_TOOLS = [
  {
    name: 'record_caller',
    description:
      'SETTLE WHO CALLED, and write it down. For an item that says nobody on file matches the ' +
      'sender: name the customer it really was with `customerId`, or the one to create with ' +
      '`newCustomer` once a manager has said so. Exactly one of the two. Everything this writes ' +
      'CITES the call, so the record can always answer where a customer, a job or a trip came ' +
      'from. ' +
      'LINKING somebody we already know needs nobody\'s permission — a customer at a new number ' +
      'or a new address is a fact you established, not a decision. CREATING a customer, opening ' +
      'a job with `openJob`, and booking a trip with `bookVisit` are asked first, and that goes ' +
      'double for the trip: something on the board is a promise to a person. ' +
      'A booked trip is UNTIMED — on the board with no day and no time — because when it happens ' +
      'is the manager\'s to say. If they DID give you a day, book it here anyway and then SAY that ' +
      'day back in your reply so it can be placed — and if you hold `move_visit`, place it there ' +
      'yourself. A day you were told must never be dropped. ' +
      'The item RETIRES ITSELF once the record cites the call — never close it by hand, and ' +
      'never tell anyone it is closed; what you write is what closes it.',
    inputSchema: {
      type: 'object',
      properties: {
        observationId: {
          type: 'string',
          description:
            'The item id, copied exactly — off its `gap` line if you are planning, or out of ' +
            'the note the office sent you if you were asked about it.',
        },
        customerId: {
          type: 'string',
          description:
            'The customer this really was — use it when a lookup found them at a different ' +
            'number or address. Never together with `newCustomer`.',
        },
        newCustomer: {
          type: 'object',
          description:
            'Create the customer from what the caller gave. Only after a manager has said so.',
          properties: {
            name: { type: 'string', description: 'Their name, as they gave it.' },
            phone: { type: 'string' },
            email: { type: 'string' },
            addressLine1: { type: 'string' },
            city: { type: 'string' },
            state: { type: 'string' },
            postalCode: { type: 'string' },
          },
          required: ['name'],
        },
        openJob: {
          type: 'object',
          description:
            'Open a job for this caller as well. Leave it out and nothing is opened — the call ' +
            'is simply filed against whoever you named.',
          properties: {
            title: { type: 'string', description: 'What the work is, in a few words.' },
            jobType: { type: 'string' },
          },
        },
        bookVisit: {
          type: 'boolean',
          description:
            'true books an UNTIMED trip on the job — only when a manager said someone is going. ' +
            'false records that nobody is going, and asks nothing further. Leave it out and the ' +
            'usual question is raised if the firm agreed to come out.',
        },
      },
      required: ['observationId'],
    },
  },
];

// A customer row as a seat may see it: without phone_key, the generated MATCHING
// key (20260916130100). The accuracy rules tell a seat to copy numbers character
// for character, so bare digits beside the written phone are something it may quote.
function withoutPhoneKey<T extends { phone_key?: unknown }>(row: T): Omit<T, 'phone_key'> {
  const { phone_key, ...shown } = row;
  void phone_key;
  return shown;
}

async function handleFindCustomer(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str } = toolCtx;
      const query = str('query');
      if (!query) throw new Error('query is required');
      const rows = (await searchCustomers(tenantId, query)).map(withoutPhoneKey);
      // Fold standing facts whose evidence was retracted (one lookup across
      // all rows) — a retracted fact must not stay visible in name lookups
      // when context/briefings already hide it (fold is the removal path).
      const ids = [...new Set(rows.flatMap((c) => factSourceIds(c.attributes)))];
      if (ids.length === 0) return rows;
      const retracted = new Set(
        (await findRetractionsFor(ids))
          .map((r) => r.retracts_capture_id)
          .filter((id): id is string => !!id),
      );
      if (retracted.size === 0) return rows;
      return rows.map((c) => ({ ...c, attributes: foldRetractedFacts(c.attributes, retracted) }));
}

async function handleGetCustomerContext(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str, activeManager } = toolCtx;
      const customerId = str('customerId');
      if (!customerId) throw new Error('customerId is required');
      // THE CONTENTS PAGE (plan 2026-09-15-the-retrieval-layer-1). The database
      // does the counting under the caller's tier; nothing here grows with the
      // customer's history. The tenant guard is inside the read: a cross-tenant
      // (or unknown) id reads as no such customer — in words, so the model does
      // not read a blank as a failed lookup and retry.
      const contents = await getCustomerContents(tenantId, customerId, callerTierOf(toolCtx));
      if (!contents) {
        return { customer: null, jobs: [], note: 'no such customer on this firm' };
      }
      // Served steering at the exact decision point (the B03 flake, 2026-08-14):
      // asked "when is the next OPENING for X's work?", the model reads this
      // context, sees the booked visits, and answers with the next VISIT —
      // the queued job with no visit is the one the question was about. Name
      // that work and the verb that answers for it, in the result itself.
      const scheduledJobIds = new Set(contents.upcomingVisits.map((v) => v.jobId));
      const unscheduled = contents.jobs.filter(
        (j) => (j.status === 'open' || j.status === 'in_progress') && !scheduledJobIds.has(j.id),
      );
      // Money position per job (money-ledger plan): summaries only — the entry
      // list lives on get_job. Jobs with an empty ledger are OMITTED from the
      // map (absence = "no money recorded"; a zero-summary would read as
      // "fully paid"). Technicians get door numbers only.
      const moneyByJob: Record<string, unknown> = {};
      for (const j of contents.jobs) {
        if (j.money) moneyByJob[j.id] = activeManager ? j.money : technicianMoneyView(j.money);
      }
      const contextResult: Record<string, unknown> = {
        // The contents function emits the whole customers row (customers%rowtype).
        customer: withoutPhoneKey(contents.customer),
        // The job row plus the layer's counts; `money` leaves the row for the
        // tier-filtered map above (undefined is dropped by JSON.stringify).
        // retractedCount is a manager/planner signal; a technician never sees the key.
        jobs: contents.jobs.map((j) => ({
          ...j,
          money: undefined,
          ...(callerTierOf(toolCtx) === 'technician' ? { retractedCount: undefined } : {}),
        })),
        olderJobs: contents.olderJobs,
        customerLevelNotes: contents.customerLevel,
        upcomingVisits: contents.upcomingVisits,
        ...(Object.keys(moneyByJob).length > 0 ? { moneyByJob } : {}),
        ...(unscheduled.length && !leanGrounding()
          ? {
              openWorkNote:
                `UNSCHEDULED work on file: ${unscheduled.map((j) => `'${j.title}' (jobId ${j.id})`).join('; ')}. ` +
                'upcomingVisits answers what IS booked; a question about when work COULD happen — an ' +
                'opening, availability, the earliest someone could come — is a find_slots(jobId) ' +
                'question about THESE jobs, never answered from the booked schedule.',
            }
          : {}),
        // Absence in words, and the way onward: a page is not the history.
        note:
          (contents.jobsTotal === 0 ? 'No jobs on file for this customer. ' : '') +
          (contents.olderJobs > 0
            ? `${contents.olderJobs} more job${contents.olderJobs === 1 ? '' : 's'} on file not shown ` +
              '(live work is always shown first). '
            : '') +
          'This is the contents page. list_recent_captures(jobId) pages a job\'s notes; ' +
          'get_capture(captureId) gives one note in full.',
      };
      // Lean serves the RECORD only: the derived schedule-ahead block goes with
      // the other crutches, and openWorkNote goes with it because its steering
      // names the field it rides on.
      if (leanGrounding()) delete contextResult.upcomingVisits;
      return contextResult;
}

async function handleGetJob(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str, activeManager } = toolCtx;
      const jobId = str('jobId');
      if (!jobId) throw new Error('jobId is required');
      const job = await getJob(jobId);
      // Tenant guard: a cross-tenant (or unknown) id reads as not found.
      if (!job || job.tenant_id !== tenantId) return null;
      // Money position + retraction fold are independent reads — parallel
      // (one round-trip of latency instead of two on every get_job).
      // BOTH kinds of cited evidence (rung 10): standing facts AND the
      // correspondence entries, which carry their own capture ids. Scanning
      // only the facts would leave a retracted customer email visible here
      // while the context view had already dropped it — and the retraction
      // preview now PROMISES that it goes. "The raw-row tool must agree with
      // the folded context view" is the rule below; this is what keeps it true.
      const factIds = [
        ...factSourceIds(job.attributes),
        ...correspondenceEntries(job.attributes).map((e) => e.captureId),
      ];
      const [moneyEvents, retractionRows] = await Promise.all([
        listMoneyEventsForJob(tenantId, jobId),
        factIds.length > 0 ? findRetractionsFor(factIds) : Promise.resolve([]),
      ]);
      // Money attached ONLY when the ledger has entries: absence = "money was
      // never recorded here" (a zero-summary on an untracked job would read as
      // "fully paid"). A fully-VOIDED ledger still attaches its zeros — that
      // is truthful: money was discussed and nothing is owed. Tier split:
      // managers also get the recent entries (ids are what correction/void
      // cite); technicians get the door numbers only — no methods, no refs,
      // no history (payment detail is manager_only by standing policy;
      // technicianMoneyView is the ONE definition of that boundary).
      const moneySummary = summarizeMoney(moneyEvents);
      const money =
        moneyEvents.length === 0
          ? {}
          : {
              money: activeManager
                ? {
                    ...moneySummary,
                    recentEvents: moneyEvents.slice(-10).map((e) => ({
                      id: e.id,
                      kind: e.kind,
                      amountCents: e.amount_cents,
                      occurredAt: e.occurred_at,
                      method: e.method,
                      externalRef: e.external_ref,
                      correctsEventId: e.corrects_event_id,
                    })),
                  }
                : technicianMoneyView(moneySummary),
            };
      // Fold standing facts whose evidence was retracted — the raw-row tool
      // must agree with the folded context view. Single exit: every branch
      // carries both the fold result and the money block (review finding: a
      // future early return must not silently drop one of them).
      const retracted = new Set(
        retractionRows.map((r) => r.retracts_capture_id).filter((id): id is string => !!id),
      );
      const attributes =
        retracted.size > 0
          ? foldRetractedCorrespondence(foldRetractedFacts(job.attributes, retracted), retracted)
          : job.attributes;
      return { ...job, attributes, ...money };
}

async function handleOpenJob(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str } = toolCtx;
      const customerId = str('customerId');
      const title = str('title')?.trim();
      if (!customerId) throw new Error('customerId is required');
      if (!title) throw new Error('title is required — it goes on the permanent record');
      // Tenant guard on the parent, the get_job precedent: a cross-tenant id
      // reads as not found rather than as a foreign customer.
      const customer = await getCustomer(customerId);
      if (!customer || customer.tenant_id !== tenantId) throw new Error('customer not found');
      const priorityArg = str('priority');
      if (priorityArg && !JOB_PRIORITIES.includes(priorityArg as JobPriority)) {
        throw new Error(`invalid priority: ${priorityArg}`);
      }
      // THE SAME MINT GUARD book_visit's customerId path has, and it has to be
      // the same TEST as well as the same words, or the two surfaces disagree
      // about what a duplicate is: `resolveBooking` fires on a title that NAMES
      // an open job (the agent parroting the manager's words for work that
      // exists), and a genuinely distinct title mints without ceremony. A
      // stricter rule here would refuse an open that book_visit would have
      // allowed, and send the agent round a loop the steer cannot resolve.
      if (args.forceNewJob !== true) {
        const openWork = await listOpenJobsForCustomer(customer.id);
        const stated = title.toLowerCase();
        if (openWork.some((j) => (j.title ?? '').trim().toLowerCase() === stated)) {
          throw new Error(
            openWorkSteer('opened', openWork) +
              ' (This tool only opens NEW work — to act on the job already on file, use it ' +
              'directly: book_visit with its jobId, or update_job.)',
          );
        }
      }
      // The call this answers, if there is exactly one waiting (rung 10).
      const ask = await inboundAskFor(tenantId, { customerId: customer.id });
      const job = await createJob({
        tenantId,
        customerId: customer.id,
        title,
        jobType: str('jobType') ?? null,
        ...(priorityArg ? { priority: priorityArg as JobPriority } : {}),
        ...(ask ? { sourceCaptureId: ask.captureId } : {}),
      });
      if (ask) {
        // Advisory, like book_visit's: the job is open either way, and the
        // words are still in L1 and in the observation.
        try {
          await appendJobCorrespondence(
            job.id,
            correspondenceOf(ask.captureId, ask.channel, ask.capturedAt, {
              followUp: ask.followUp ?? null,
              attributes: ask.attributes ?? null,
            }),
          );
        } catch (err) {
          console.error(
            `open_job: job ${job.id} was opened, but the caller's words were not copied onto it`,
            err,
          );
        }
      }
      return {
        status: 'opened',
        jobId: job.id,
        jobTitle: job.title,
        customer: customer.name,
        jobType: job.job_type,
        jobPriority: job.priority,
        // The observation is NOT touched here: closing it is the planner's, on
        // the citation this just left behind (the record is planner-kept).
        note:
          'The job is open and NOTHING is on the calendar. Tell the manager the title above — ' +
          'your words reached the record. If they want someone sent out, book_visit with the ' +
          'jobId — with the day and both times if they gave them, or `untimed: true` if the ' +
          'timing is not settled.',
      };
}

async function handleCancelJob(toolCtx: ToolContext): Promise<unknown> {
  const { identity, tenantId, str } = toolCtx;
      const subjectRef = identity.technicianRef;
      const confirmId = str('confirmId');
      if (!confirmId) {
        // STAGE — always. Terminal per the job state machine, so the doctrine's
        // irreversible arm applies: there is NO one-shot path, even for a
        // visit-less promise-free job (unschedule_visit's one-shot arm is what
        // reversibility buys; this verb has none to spend).
        const jobId = str('jobId');
        const reason = str('reason')?.trim();
        if (!jobId) throw new Error('jobId is required');
        if (!reason) throw new Error('reason is required — say why the work is being cancelled');
        // WHAT IS BEING APPROVED: exactly these live visits at these times,
        // read BEFORE the preview (a change between the reads refuses at the
        // yes). Wall-clock form — list_pending_reviews shows this detail to the
        // model. Without it the yes cancelled whatever the job had AT yes-time,
        // including a visit booked or moved after the manager read the preview.
        const approvedVisits = await snapshotJobVisits(tenantId, jobId);
        const preview = await previewCancelJob(tenantId, jobId);
        // Staging replaces any prior staged job-cancel BY THIS CALLER (the
        // unschedule_visit idiom: subjectRef = caller, per-caller supersede +
        // only-the-stager-confirms; the jobId rides in the detail).
        await resolveOpenReviewItemFor(
          tenantId,
          'pending_job_cancel',
          subjectRef,
          'dismissed',
          'superseded by a new job-cancel request',
        );
        const item = await upsertOpenReviewItem({
          tenantId,
          kind: 'pending_job_cancel',
          subjectRef,
          detail: {
            jobId,
            reason,
            preview: preview as unknown as Json,
            approvedVisits: approvedVisits as unknown as Json,
            stagedAt: new Date().toISOString(),
          } as unknown as Json,
        });
        const staged = (item.detail ?? {}) as { preview?: unknown };
        return {
          status: 'needs_confirmation',
          confirmId: item.id,
          preview: staged.preview ?? preview,
          note:
            'Nothing was cancelled. This is TERMINAL — show the manager exactly this ' +
            'preview: the JOB closes for good and every listed visit comes off the calendar. ' +
            'On their explicit yes call again with ONLY confirmId.',
        };
      }
      // CONFIRM — consume-first (unschedule_visit idiom).
      const item = await getOpenReviewItem(confirmId, tenantId, {
        kind: 'pending_job_cancel',
        subjectRef,
      });
      if (!item) {
        throw new Error('confirmation not found — call cancel_job again with jobId + reason to restage');
      }
      const d = (item.detail ?? {}) as {
        jobId?: string;
        reason?: string;
        stagedAt?: string;
        approvedVisits?: ApprovedJobVisit[];
      };
      if (d.stagedAt && Date.now() - Date.parse(d.stagedAt) > 15 * 60_000) {
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'confirmation expired');
        throw new Error('confirmation expired — restage the job cancellation and confirm again');
      }
      if (!d.jobId || !d.reason) {
        throw new Error('staged job cancellation is malformed — restage with jobId + reason');
      }
      // THE YES COVERS WHAT WAS SHOWN. Checked before the token is consumed, so
      // a refusal cancels nothing; cancelJob repeats it with a compare-and-set
      // per visit for a change that lands after this read.
      if (!Array.isArray(d.approvedVisits)) {
        await resolveReviewItem(item.id, tenantId, 'dismissed', 'staged before the visit check existed');
        throw new Error('this confirmation predates a safety check — nothing was cancelled; restage the job cancellation and confirm again');
      }
      let stillApproved: boolean;
      try {
        stillApproved = await jobVisitsStillApproved(tenantId, d.jobId, d.approvedVisits);
      } catch (err) {
        // The job is gone or already closed (e.g. cancelled on the console):
        // this token can never succeed, so it must not sit in the review list
        // answering every retry with the same error until it expires.
        await resolveReviewItem(
          item.id,
          tenantId,
          'dismissed',
          `job no longer cancellable: ${err instanceof Error ? err.message : String(err)}`,
        );
        throw err;
      }
      if (!stillApproved) {
        await resolveReviewItem(item.id, tenantId, 'dismissed', "the job's visits changed while the confirmation was pending");
        throw new Error(
          "job NOT cancelled: its visits changed since the manager approved (one was booked, moved or " +
            'removed) — nothing was cancelled; restage to show them what it has now',
        );
      }
      const consumed = await resolveReviewItem(
        item.id,
        tenantId,
        'resolved',
        `job cancellation confirmed by ${subjectRef}`,
      );
      if (!consumed) {
        throw new Error('already confirmed or cancelled — nothing was changed by this call');
      }
      let result;
      try {
        result = await cancelJob({
          tenantId,
          jobId: d.jobId,
          reason: d.reason,
          actorRef: subjectRef,
          approvedVisits: d.approvedVisits,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
          await annotateResolvedReviewItem(
            confirmId,
            tenantId,
            `confirmed but job cancellation FAILED (${msg}) — check get_team_schedule before retrying`,
          );
        } catch {
          /* advisory */
        }
        throw new Error(`job NOT cancelled: ${msg}`);
      }
      return {
        status: 'cancelled',
        jobId: result.job.id,
        jobTitle: result.job.title,
        visitsCancelled: result.cancelledVisits.map((v) => ({
          visitId: v.id,
          // Placed day, else the unplaced range's day (plan 4b-2).
          day: v.starts_at?.slice(0, 10) ?? null,
        })),
        note:
          'The WORK is cancelled — the job left the loose bucket and the visits above are ' +
          'off the calendar. Tell the manager exactly what died; affected technicians were ' +
          'notified per visit.',
      };
}


    // RUNG 10B — THE PLANNER'S FIRST WRITE TO THE RECORD, and it goes through the
    // ONE DOOR rather than around it: this re-runs `recordFieldNote` for the very
    // capture the item is about, with the identity the planner settled and what a
    // manager decided. Nothing here writes a customer, a job or a visit itself —
    // the door does, and every row it writes cites the call, exactly as it would
    // have if code had recognised the caller in the first place.
async function handleRecordCaller(toolCtx: ToolContext): Promise<unknown> {
  const { args, deps, identity, tenantId, str } = toolCtx;
      const observationId = str('observationId');
      if (!observationId) {
        throw new Error("observationId is required — copy it from the item's `gap` line, or from the note the office sent you");
      }
      // UUID-SHAPED FIRST. These ids go straight into uuid-typed PostgREST
      // filters, where a malformed one raises 22P02 — a raw database error the
      // model reads as a system fault and simply retries, instead of the steer
      // below. The planner.ts UUID rail exists for the same trap.
      if (!UUID_RE.test(observationId)) {
        throw new Error(
          'No such item on this firm — check the id against the gap, or the office note, you copied it from.',
        );
      }
      const obs = await getObservationForTenant(observationId, tenantId);
      if (!obs) {
        throw new Error(
          'No such item on this firm — check the id against the gap, or the office note, you copied it from.',
        );
      }
      if (obs.kind !== 'inbound_unmatched') {
        throw new Error(
          `record_caller is for an item that says nobody on file matches the sender; ` +
            `${observationId} is a ${obs.kind}. The caller there is already known.`,
        );
      }
      if (obs.status !== 'open') {
        throw new Error(`that item is already ${obs.status} — there is nothing left to record.`);
      }
      // The call itself. `subject_ref` is the L1 capture id for this kind.
      const capture = await getRawCapture(obs.subject_ref);
      if (!capture || capture.tenant_id !== tenantId) {
        throw new Error('the call this item is about is not on file — nothing to record it onto.');
      }
      if (!capture.technician_ref) {
        // The column is nullable (pre-column rows), and the door attributes
        // everything it writes to a person. Refuse rather than invent one.
        throw new Error('that call has nobody on it, so it cannot be recorded — raise it instead.');
      }
      // Hoisted: the door's call is inside a closure, where the narrowing above
      // does not survive.
      const capturedBy = capture.technician_ref;

      const customerId = str('customerId');
      const newCustomer =
        args.newCustomer && typeof args.newCustomer === 'object' && !Array.isArray(args.newCustomer)
          ? (args.newCustomer as Record<string, unknown>)
          : undefined;
      if (!!customerId === !!newCustomer) {
        throw new Error(
          'name exactly ONE of `customerId` (somebody already on file) or `newCustomer` ' +
            '(somebody a manager said to create).',
        );
      }
      // BY HAND, because `required` in the inputSchema is decorative here:
      // coerceBySchema only coerces declared TYPES and never enforces required
      // (the write_memory precedent). Unvalidated, `newCustomer: {}` mints a row
      // literally called "Unknown customer" — the door's fallback — and a
      // nameless person on the record is worse than a refusal.
      const newName = typeof newCustomer?.name === 'string' ? newCustomer.name.trim() : '';
      if (newCustomer && !newName) {
        throw new Error(
          '`newCustomer` needs a `name` — record who the caller said they were, or name them ' +
            'with `customerId` if they turn out to be somebody already on file.',
        );
      }

      // IDEMPOTENT BY READING THE RECORD FIRST. A retry after a downstream throw
      // must not mint a SECOND customer or job citing this same call: those rows
      // are L1-pinned, so they can never be deleted (a stamped capture makes its
      // customer permanently undeletable). What already cites the capture is the
      // authority on what this call still has left to do.
      const already = await listL2CitingCapture([capture.id]);
      if (newCustomer && already.some((r) => r.kind === 'customer')) {
        const existing = already.find((r) => r.kind === 'customer');
        throw new Error(
          `a customer was already created from this call (${existing?.id}) — name it with ` +
            '`customerId` instead of creating a second one.',
        );
      }
      if (customerId && !UUID_RE.test(customerId)) {
        throw new Error('no such customer on this firm — look them up before naming them.');
      }
      if (customerId) {
        const target = await getCustomer(customerId);
        if (!target || target.tenant_id !== tenantId) {
          throw new Error('no such customer on this firm — look them up before naming them.');
        }
      }
      // A job already opened from this call is done; asking for it again would
      // mint a twin. Silently dropped rather than refused, so a retry finishes
      // the parts that did NOT land instead of failing whole.
      const jobAlreadyOpened = already.some((r) => r.kind === 'job');
      const openJobArg =
        args.openJob && typeof args.openJob === 'object' && !Array.isArray(args.openJob)
          ? (args.openJob as Record<string, unknown>)
          : undefined;
      const openJob =
        jobAlreadyOpened || !openJobArg
          ? undefined
          : {
              title: typeof openJobArg.title === 'string' ? openJobArg.title : null,
              jobType: typeof openJobArg.jobType === 'string' ? openJobArg.jobType : null,
            };
      const bookVisitArg = typeof args.bookVisit === 'boolean' ? args.bookVisit : undefined;
      // WHAT THIS CALL WILL LEAVE BEHIND, predicted before it runs — and the
      // prediction has to model what the DOOR does, not what reads convenient.
      // A call that nothing CITES can never become moot, so the item would sit
      // open forever while this tool told the planner to leave it alone.
      //
      // The door resolves the job as: the customer's most recent NON-TERMINAL
      // job, else mint one when `openJob` says so, else file the call onto their
      // most recent job of any status. And the citation only counts when the job
      // it lands on is not CANCELLED (listL2CitingCapture drops those, because a
      // rolled-back shell is not an answer).
      //
      // Creating a customer always cites (customers.source_capture_id), so only
      // the LINK path needs either check.
      const onFile = customerId ? await listJobsForCustomer(customerId) : [];
      const liveJobs = onFile.filter((j) => !TERMINAL_JOB_STATUSES.has(j.status));
      if (customerId && !openJob && !onFile.some((j) => j.status !== 'cancelled')) {
        throw new Error(
          'there is nothing to file this call onto — that customer has no job it could land on. ' +
            'Pass `openJob` as well. If there is no work in the call at all, say so to the office ' +
            'instead of recording it.',
        );
      }
      // A TRIP NEEDS A JOB TO SIT ON — a LIVE one. `openJob` here is the request
      // AFTER the already-opened drop above, so this reads the same job the door
      // will: a customer whose only jobs are paid or declined has nothing a visit
      // can hang on, and without this the door would file the call, book nothing,
      // and the planner would tell a manager somebody is going.
      if (bookVisitArg === true && !openJob && liveJobs.length === 0) {
        throw new Error(
          'a trip needs a job to sit on — pass `openJob` as well, or name a customer who ' +
            'already has one open.',
        );
      }

      const meta =
        capture.metadata && typeof capture.metadata === 'object' && !Array.isArray(capture.metadata)
          ? (capture.metadata as Record<string, unknown>)
          : {};
      const metaFrom = typeof meta.from === 'string' ? meta.from : null;
      const metaTo = typeof meta.to === 'string' ? meta.to : null;
      // NOT THE FIRM'S OWN ADDRESS (rung 10b.2). A message the firm sent to
      // itself carries our mailbox in `from`, and a live specimen had the
      // extractor report it as the caller's email. Stored on a customer it
      // becomes an identity KEY, so every later message from our own mailbox
      // would match that one person. Refused rather than silently dropped: the
      // caller of this tool believes it is recording the customer's address, and
      // quietly writing null would leave them saying so to a manager.
      // …and the address they gave is not just the caller's name again. Same
      // guard the note door has, on the door rung 10b.2 tells the seat to use.
      refuseNameAsAddress(
        typeof newCustomer?.addressLine1 === 'string' ? newCustomer.addressLine1 : null,
        newName,
      );
      const newEmail = typeof newCustomer?.email === 'string' ? newCustomer.email : null;
      // The paired mailbox for the person this message was delivered under —
      // authoritative where the `to` header is ambiguous (several recipients),
      // and the reason this guard can stay conservative without going blind.
      // Read UNCONDITIONALLY: the fallback suppression below needs it too, and
      // that path runs on the name-only answer — which is the one this tool's
      // own refusal message steers a manager towards.
      const capturedByTech = await getTechnician(tenantId, capturedBy);
      // SCOPED BY DIRECTION (rung 10b.3). The heuristic arm of `isOwnMailbox`
      // reads a SOLE RECIPIENT as evidence of the mailbox a message arrived at
      // — true for inbound, and exactly backwards for the firm's own mail,
      // where the sole recipient is the CUSTOMER. Unscoped, this refuses the
      // right answer: the ask renders "sent to iris@homeowner.test", the
      // planner answers with that address, and the tool tells it — untruthfully
      // — that the customer's own address is the firm's mailbox. On an outbound
      // capture the firm is the SENDER, so that is what a claimed email must
      // not be.
      const outboundCapture = capture.channel === 'outbound_email';
      const claimsOurMailbox = outboundCapture
        ? isOwnMailbox(newEmail, metaFrom, capturedByTech?.connected_email)
        : isOwnMailbox(newEmail, metaTo, capturedByTech?.connected_email);
      if (newEmail && claimsOurMailbox) {
        throw new Error(
          `${emailAddressOf(newEmail)} is this firm's own mailbox, not the caller's — it is the ` +
            `address the message ${outboundCapture ? 'was SENT FROM' : 'ARRIVED at'}. Record them ` +
            'without an email, or with the address they actually write from.',
        );
      }
      const resolved: ResolvedIdentity = customerId
        ? { customerId }
        : {
            createFrom: {
              customerName: newName || null,
              phone: typeof newCustomer?.phone === 'string' ? newCustomer.phone : null,
              email: typeof newCustomer?.email === 'string' ? newCustomer.email : null,
              addressLine1:
                typeof newCustomer?.addressLine1 === 'string' ? newCustomer.addressLine1 : null,
              city: typeof newCustomer?.city === 'string' ? newCustomer.city : null,
              state: typeof newCustomer?.state === 'string' ? newCustomer.state : null,
              postalCode:
                typeof newCustomer?.postalCode === 'string' ? newCustomer.postalCode : null,
            },
          };
      const r = await recordCallerThroughTheDoor(() => recordFieldNote({
        tenantId,
        technicianRef: capturedBy,
        channel: capture.channel,
        text: capture.raw_text,
        blobPath: capture.blob_path,
        captureId: capture.id,
        sourceMeta: capture.metadata,
        // THE SAME KEYS THE DOOR HAD THE FIRST TIME. A customer created here
        // keeps the caller's number and the address they wrote from, so the next
        // message from them is recognised by code and never becomes a second
        // item on this list.
        fallbackPhone: typeof meta.fromNumber === 'string' ? meta.fromNumber : null,
        // …and the same own-mailbox rule the webhook applies (rung 10b.2): this
        // is a RE-ENTRY on that capture, so it must not resurrect a key the
        // first pass was right to withhold.
        // …WHICH REVERSES ON THE FIRM'S OWN MAIL (rung 10b.3), exactly as the
        // door does. On an `outbound_email` capture `From` is US, so taking it
        // would file the FIRM'S OWN ADDRESS on the customer the planner is
        // creating — the 10b.2 incident reproduced through the new door, and it
        // lands precisely on the name-only answer this tool's refusal message
        // steers a manager towards (`createFrom.email` is null there, so the
        // `??` in recordFieldNote falls through to this value). Who it went TO
        // is the key, unique-or-nothing.
        fallbackEmail:
          capture.channel === 'outbound_email'
            ? soleRecipientOf(metaTo)
            : isOwnMailbox(metaFrom, metaTo, capturedByTech?.connected_email)
              ? null
              : emailAddressOf(metaFrom),
        threadId: typeof meta.threadId === 'string' ? meta.threadId : null,
        resolved,
        // WHO ASKED FOR THIS. The door books with `actorRef`, and it used to be
        // hardcoded to the team lead — true while the planner was the only
        // caller, a lie now that a manager's seat can reach this door. The
        // schedule event must name whoever actually decided.
        decided: {
          ...(openJob ? { openJob } : {}),
          ...(bookVisitArg !== undefined ? { bookVisit: bookVisitArg } : {}),
          actorRef: identity.technicianRef,
        },
      },
      // The injected extractor, like every other door on this surface — the
      // default is the live model, and a test must be able to reach this path
      // without one.
      deps.extract ? { extract: deps.extract } : {}));
      // A RETRACTED CALL IS NOT A RECORDING. The door returns 'duplicate' for a
      // capture somebody marked recorded-in-error, having written nothing;
      // reporting that as `ok` would tell the planner the caller was recorded and
      // leave the item open with no explanation.
      if (r.status === 'duplicate') {
        throw new Error(
          'that call was retracted — somebody marked it recorded in error, so nothing was ' +
            'written. Do not record it: say so to the office instead.',
        );
      }
      // WHAT ACTUALLY LANDED, read back rather than assumed. The door REUSES a
      // customer's existing open job rather than minting a second one, so
      // `openJob` can be a no-op — and reporting the reused job as though this
      // call had opened it would have the planner relay "the job is open" for
      // work nobody created. Same for a trip: a job with a live visit takes no
      // second one. What cites the capture is the difference, and it is a fact.
      const wrote = await listL2CitingCapture([capture.id]);
      const openedJob = r.jobId ? wrote.some((w) => w.kind === 'job' && w.id === r.jobId) : false;
      const bookedVisit = r.visitId
        ? wrote.some((w) => w.kind === 'visit' && w.id === r.visitId)
        : false;
      return {
        status: 'ok',
        observationId,
        captureId: capture.id,
        customerId: r.customerId,
        customer: customerId ? 'linked' : 'created',
        ...(r.jobId
          ? { jobId: r.jobId, job: openedJob ? 'opened from this call' : 'already on file' }
          : {}),
        ...(r.visitId
          ? { visitId: r.visitId, visit: bookedVisit ? 'booked' : 'already on the board' }
          : {}),
        // The door may still raise the OTHER question — whether somebody should
        // go out — when the call carried a promise and nothing was decided about
        // it. Saying so beats the planner discovering a second item next pass.
        ...(r.observationId ? { alsoAsked: r.observationId } : {}),
        // THE ONE CHECK THAT COVERS SHAPES NOBODY ENUMERATED. Everything above
        // predicts; this READS. If nothing on the record cites the call, the item
        // cannot become moot however well the write went, and telling the planner
        // to leave it alone would strand it open forever.
        // Worded for BOTH callers since rung 10b.2: "at your next pass" was true
        // of the planner and meaningless to a manager's seat, which has no pass.
        note:
          wrote.length > 0
            ? 'the caller is on the record now — this item retires itself once the record cites ' +
              'the call, so leave it alone.'
            : 'the caller is recorded, BUT nothing on the record cites this call, so this item ' +
              'will not retire itself. Say who it turned out to be: dismiss the item yourself ' +
              'if that is a decision you make, otherwise tell the office with inform_team_lead.',
      };
}

async function handleUpdateJob(toolCtx: ToolContext): Promise<unknown> {
  const { args, identity, tenantId, str } = toolCtx;
      // Non-string args rejected, never coerced-to-absent (find_slots rule).
      // jobType additionally accepts NULL = clear back to untyped (the undo
      // for a mistakenly typed job — a set type is scheduling-authoritative).
      for (const k of ['jobId', 'title', 'priority']) {
        if (args[k] !== undefined && typeof args[k] !== 'string') {
          throw new Error(`${k} must be a string`);
        }
      }
      if (args.jobType !== undefined && args.jobType !== null && typeof args.jobType !== 'string') {
        throw new Error('jobType must be a string (or null to clear the type)');
      }
      const jobId = str('jobId');
      if (!jobId) throw new Error('jobId is required');
      // '' must not silently skip validation-and-vanish (coerced-absent trap).
      if (args.priority !== undefined && !JOB_PRIORITIES.includes(args.priority as JobPriority)) {
        throw new Error(`invalid priority: ${String(args.priority)}`);
      }
      const priorityArg = args.priority as JobPriority | undefined;
      const jobTypeArg = args.jobType as string | null | undefined;
      // No dispatch-level duration validation (final-review finding): the
      // typed layer (updateJobDetails) throws the identical shared
      // durationError(), which the tool handler surfaces verbatim — a copy
      // here would be a second bound to keep in sync for zero observable
      // difference. (Priority differs: the typed layer does NOT validate it,
      // so its dispatch guard above earns its place.)
      const durationArg = args.durationMinutes as number | null | undefined;
      // Shared core (plan 4a.5): tenant guard + CAS write + the job_updated
      // ledger event live in ONE body the board endpoint calls too.
      const { previous: job, updated } = await updateJobIdentity(
        tenantId,
        jobId,
        {
          ...(str('title') !== undefined ? { title: str('title')! } : {}),
          ...(jobTypeArg !== undefined ? { jobType: jobTypeArg } : {}),
          ...(priorityArg !== undefined ? { priority: priorityArg } : {}),
          ...(durationArg !== undefined ? { durationMinutes: durationArg } : {}),
        },
        identity.technicianRef,
      );
      // Placeability warning (final-review findings): the invariant is that
      // every edit which touches a SCHEDULING INPUT and leaves something
      // without a usable length says so NOW, not as a surprise error at the
      // next find_slots. Two triggers:
      //  (a) a newly SET type with no stored duration — warned even when this
      //      job schedules by its own length, because the signal is about the
      //      TYPE being unwired tenant-wide (the next job of that type has no
      //      own length to fall back on);
      //  (b) a duration OR TYPE clear that strands the job (no own length,
      //      and no configured type duration to fall back to) — the null-
      //      duration arm is new in this plan; the type-clear arm closes a
      //      pre-existing silent case (round-2 review finding).
      // Title-only edits never reach the lookup (mightWarn gates the read).
      const mightWarn =
        (jobTypeArg !== undefined && updated.job_type) ||
        durationArg === null ||
        jobTypeArg === null;
      const storedForType =
        mightWarn && updated.job_type
          ? await findJobTypeDurationMinutes(tenantId, updated.job_type)
          : null;
      const placeable = updated.duration_minutes !== null || storedForType !== null;
      let typeWarning: string | undefined;
      if (jobTypeArg !== undefined && updated.job_type && storedForType === null) {
        typeWarning = placeable
          ? `no stored duration for '${updated.job_type}' yet — this job still schedules by ` +
            `its own recorded length (${formatDuration(updated.duration_minutes!)}), but other ` +
            `'${updated.job_type}' jobs will not; set_job_duration makes the type schedulable ` +
            'in general'
          : `no stored duration for '${updated.job_type}' yet — set this job's ` +
            'durationMinutes (update_job) to make it placeable, or set_job_duration to ' +
            'make the type schedulable in general';
      } else if ((durationArg === null || jobTypeArg === null) && !placeable) {
        typeWarning =
          'this job now has no usable length — scheduling will ask; set durationMinutes ' +
          "(update_job) to make it placeable, or store its type's duration with set_job_duration";
      }
      // Old → new per changed field: the echo IS the disclosure — the manager
      // hears exactly what the record now says (job-identity lesson).
      const change = (from: unknown, to: unknown) => ({ from: from ?? null, to: to ?? null });
      return {
        status: 'ok',
        jobId,
        customerId: job.customer_id,
        changes: {
          ...(str('title') !== undefined ? { title: change(job.title, updated.title) } : {}),
          ...(jobTypeArg !== undefined ? { jobType: change(job.job_type, updated.job_type) } : {}),
          ...(priorityArg !== undefined
            ? { priority: change(job.priority, updated.priority) }
            : {}),
          ...(durationArg !== undefined
            ? { durationMinutes: change(job.duration_minutes, updated.duration_minutes) }
            : {}),
        },
        ...(typeWarning ? { warning: typeWarning } : {}),
        note:
          'Done in one step — correctable the same way (set a new value; jobType: null clears ' +
          'the type). Tell the manager exactly what changed, old → new.',
      };
}

export const customersTools = {
  domain: 'customers',
  base: BASE_TOOLS,
  admin: ADMIN_TOOLS,
  teamLead: TEAM_LEAD_TOOLS,
  handlers: {
    find_customer: handleFindCustomer,
    get_customer_context: handleGetCustomerContext,
    get_job: handleGetJob,
    open_job: handleOpenJob,
    cancel_job: handleCancelJob,
    record_caller: handleRecordCaller,
    update_job: handleUpdateJob,
  },
} satisfies DomainTools;
