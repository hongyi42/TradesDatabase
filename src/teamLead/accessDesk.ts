import {
  createOfficeMessage,
  findOpenAccessRequest,
  getCustomer,
  hasLapsed,
  lapseAccessRequest,
  getJob,
  getTechnicianView,
  getTenant,
  listManagersWithTelegram,
  listOpenJobsForCustomer,
  markOfficeMessagesRead,
  openAccessRequest,
  queuePersonPush,
  requestKeyOf,
  viewHasCustomer,
  viewHasJob,
  viewShowsMoney,
  type AccessWants,
} from '../db/index.js';
import { localDateISO } from '../schedule/availability.js';
import { servedDayPhrase } from '../schedule/dateResolve.js';
import { renderMemoryIndex } from './memory.js';
import { TEAM_LEAD_REF } from './identity.js';

// THE DESK AS THE FILTER (access plan B; operator, 2026-09-19: "the seat asks
// the office, who is basically a filter before the message goes to the
// manager").
//
// A technician's seat hits "outside your view", asks its person, and on their
// yes calls ask_team_lead with an accessRequest. This is what happens next, and
// there are exactly two outcomes that do anything:
//
//   NARROW — one job, the record only. The desk decides it here, in the moment,
//     with one bounded model call, and opens it for a day. This is the whole
//     reason the flow exists: a technician at a gate at 7am needs the code now,
//     and "wait for a manager" is what happens today, which is why nothing gets
//     opened.
//   EVERYTHING ELSE — money, every note, or wider than one job. Filed as a
//     request and texted to every reachable manager. Money is sensitive BY
//     DEFAULT and is never opened here (operator, 2026-09-19): the firm opens
//     it permanently, or a manager opens it per ask, and neither is the desk's.
//
// CODE DOES THE WRITE, BY CONSTRUCTION. The model returns one word; every field
// of the grant is fixed here (that job, `record`, no money, 24 hours) and the
// grant's `reason` is the technician's own words quoted by code, never the
// model's. So no model output reaches a grant field and there is nothing for a
// ceiling to check.
//
// THE FALLBACK ALWAYS MOVES TOWARDS A HUMAN. A timeout, a model error, a
// malformed decision — all of them ask a manager. Nothing here fails open.
//
// The general desk loop (desk.ts) is untouched: it stays read-only, and this
// module is reached only when ask_team_lead carries an accessRequest.

// UUID-SHAPED FIRST (the record_caller / grant_access precedent): these ids
// come from a model, and a malformed one reaches a uuid-typed column and comes
// back as `invalid input syntax for type uuid` — a raw database error in text a
// technician's seat may read out. Written here rather than imported from
// src/mcp/tools/shared.ts on purpose: src/teamLead must not import the MCP
// surface (desk.ts's no-static-cycle rule), and a uuid's shape is not a rule
// that can drift.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;


export interface AccessRequestInput {
  tenantId: string;
  /** The asker's roster ref (their technician ref). Identity, never chat text. */
  askerRef: string;
  /** Their display name — what the manager's text and the planner's line say. */
  askerName: string;
  askerTier: string | null;
  /** The asker's roster uuid — null for a badge with no roster row. */
  askerTechnicianId: string | null;
  /** The repo's one active-manager predicate, decided by the caller. */
  activeManager: boolean;
  /** The technician's own reason — ask_team_lead's `question`. */
  why: string;
  jobId?: string;
  customerId?: string;
  wants: AccessWants;
}

export interface AccessDeskDeps {
  now?: () => Date;
  memoryIndex?: typeof renderMemoryIndex;
  getJob?: typeof getJob;
  getCustomer?: typeof getCustomer;
  listOpenJobs?: typeof listOpenJobsForCustomer;
  technicianView?: typeof getTechnicianView;
  listManagers?: typeof listManagersWithTelegram;
  queuePush?: typeof queuePersonPush;
  openRequest?: typeof openAccessRequest;
  findRequest?: typeof findOpenAccessRequest;
  lapseRequest?: typeof lapseAccessRequest;
  createMessage?: typeof createOfficeMessage;
  markRead?: typeof markOfficeMessagesRead;
  firmTenant?: typeof getTenant;
}

export type AccessDeskStatus =
  // 'opened' is GONE (operator, 2026-09-20): only a manager or the firm's own
  // rule widens a view, so the desk can no longer answer by opening anything.
  | 'asked_manager'
  | 'already_open'
  | 'already_asked'
  | 'refused';

export interface AccessDeskAnswer {
  status: AccessDeskStatus;
  answer: string;
}

// ── words ────────────────────────────────────────────────────────────────────

// NO IDS AND NO ROSTER REFS IN ANY OF THESE. They are read out to a person in a
// chat (the standing rule from the 2026-09-14 finding, and the live leak plan A
// hit on 2026-09-19): a job is its title and its customer, a person is their
// name.
interface Target {
  jobId?: string;
  customerId: string;
  jobTitle?: string | null;
  customerName: string;
}

const jobWords = (t: Target): string =>
  t.jobTitle ? `the "${t.jobTitle}" job for ${t.customerName}` : `${t.customerName}'s job`;

// What was asked for, in words — the same phrase in the technician's answer,
// the manager's text and the planner's line, so the three never disagree.
function whatWords(t: Target, wants: AccessWants): string {
  const where = t.jobId ? jobWords(t) : `${t.customerName}'s record — every job of theirs`;
  if (wants === 'money') return `the money figures on ${where}`;
  if (wants === 'notes') return `every note on ${where}, calls and emails included`;
  return where;
}

// ── the desk ─────────────────────────────────────────────────────────────────

export async function answerAccessRequest(
  input: AccessRequestInput,
  deps: AccessDeskDeps = {},
): Promise<AccessDeskAnswer> {
  const { tenantId, askerTechnicianId, wants } = input;
  const now = deps.now ?? (() => new Date());
  const readJob = deps.getJob ?? getJob;
  const readCustomer = deps.getCustomer ?? getCustomer;
  const openJobs = deps.listOpenJobs ?? listOpenJobsForCustomer;
  const readView = deps.technicianView ?? getTechnicianView;
  const findRequest = deps.findRequest ?? findOpenAccessRequest;

  // 1. WHO IS ASKING. A manager already sees everything, so there is nothing to
  // open; a badge with no roster row has no view to widen and no id to hang a
  // grant on. Both are refusals in words, not errors — the seat should say
  // something sensible rather than surface a stack trace to a person.
  if (input.activeManager) {
    return {
      status: 'refused',
      answer:
        'You already see the whole record — every customer, every job. There is nothing for me ' +
        'to open.',
    };
  }
  if (!askerTechnicianId) {
    return {
      status: 'refused',
      answer:
        'I could not find you on the team list, so I cannot ask for access on your behalf. A ' +
        'manager can sort that out.',
    };
  }

  // 2. WHAT IS BEING ASKED FOR. Exactly one target, and it must be this firm's
  // — another firm's id answers exactly like an unknown one.
  if (!input.jobId && !input.customerId) {
    return {
      status: 'refused',
      answer: 'I need to know which job or which customer you need. Ask me again and name one.',
    };
  }
  if (input.jobId && input.customerId) {
    return {
      status: 'refused',
      answer: 'Name one thing at a time — either the job or the customer.',
    };
  }

  // The view is read ONCE, before the target is resolved: both the narrowing
  // below and the "already open" answers below that are questions about it.
  const view = await readView(tenantId, askerTechnicianId);

  let target: Target;
  if (input.jobId) {
    if (!UUID_SHAPE.test(input.jobId)) {
      return { status: 'refused', answer: 'I cannot find that job on this firm.' };
    }
    const job = await readJob(input.jobId);
    if (!job || job.tenant_id !== tenantId) {
      return { status: 'refused', answer: 'I cannot find that job on this firm.' };
    }
    const customer = await readCustomer(job.customer_id);
    if (!customer || customer.tenant_id !== tenantId) {
      return { status: 'refused', answer: 'I cannot find that job on this firm.' };
    }
    target = {
      jobId: job.id,
      customerId: customer.id,
      jobTitle: job.title,
      customerName: customer.name,
    };
  } else {
    if (!UUID_SHAPE.test(input.customerId as string)) {
      return { status: 'refused', answer: 'I cannot find that customer on this firm.' };
    }
    const customer = await readCustomer(input.customerId as string);
    if (!customer || customer.tenant_id !== tenantId) {
      return { status: 'refused', answer: 'I cannot find that customer on this firm.' };
    }
    target = { customerId: customer.id, customerName: customer.name };
    // A CUSTOMER ASK BECOMES A JOB ASK when there is exactly one unfinished job
    // on that customer AND SHE CANNOT ALREADY OPEN IT — the ordinary case
    // behind "I need to get into this address today". Two or more, or none,
    // stays customer-wide and goes to a manager: choosing between them is not
    // the desk's call, and "every job of theirs, finished ones too" is a
    // different thing to open.
    //
    // THE IN-VIEW TEST IS LOAD-BEARING, and leaving it out dead-ends the
    // commonest ask of all. get_customer_context offers `{ customerId }`
    // exactly when the customer IS in view but has jobs that are not
    // (customers.ts, `jobsOutsideView`), and under the default scope such a
    // customer normally has one unfinished job — the one she has a trip on.
    // Narrowing to THAT job would answer "it is already open to you" to
    // somebody asking for the history, file nothing, and text nobody.
    //
    // EVERY WIDTH, not just `record` (2026-09-20). The gate used to be
    // `wants === 'record'` because narrowing decided whether the DESK could
    // open it. The desk opens nothing now, so narrowing is only about what the
    // MANAGER is asked for — and it has to happen HERE, because the seat
    // cannot do it. A customer outside her view answers with NO job ids at all
    // (find_customer gives id+name, get_customer_context gives `jobs: []`), so
    // a seat asking about one job of a customer it cannot see has no id to
    // name and must ask customer-wide. Measured twice on the pilot: she asked
    // about one job, the manager was asked to open every job that customer
    // ever had, and granted it. Telling the seat to "use jobId" cannot fix
    // that; it has no jobId to use.
    const live = await openJobs(customer.id);
    if (live.length === 1) {
      const only = live[0];
      // …unless the narrowed job would already answer her, in which case
      // narrowing would dead-end a legitimately customer-wide ask (she asks
      // wide precisely because the jobs she cannot see are the hidden ones).
      // `notes` is never "already satisfied": the view answers whether she may
      // open a job, never whether she may read every note on it.
      const alreadySatisfied =
        wants === 'record'
          ? viewHasJob(view, only.id)
          : wants === 'money'
            ? viewHasJob(view, only.id) && viewShowsMoney(view, { jobId: only.id })
            : false;
      if (!alreadySatisfied) target = { ...target, jobId: only.id, jobTitle: only.title };
    }
  }

  // 3. IS IT ALREADY OPEN? Asked before anything is filed, because the honest
  // answer to "ask a manager for the gate code" is sometimes "you can already
  // read it". A CUSTOMER-wide ask and a NOTES ask are never short-circuited:
  // the view answers "may she open this job", not "may she read every note on
  // it", so a yes there would be a different question's answer.
  if (target.jobId && wants === 'record' && viewHasJob(view, target.jobId)) {
    return {
      status: 'already_open',
      answer: `${jobWords(target)} is already open to you — ask me for it again and it will be there.`,
    };
  }
  // MONEY IS ONLY "ALREADY OPEN" IF THE RECORD IS TOO. The firm's rule can say
  // `amounts` while the job itself stays outside her view — and then the
  // figures are open on a page she cannot read, so "ask again and they will be
  // in the answer" would be false. She needs the record, which is a manager's
  // call; fall through rather than answer with a door that does not open.
  const canOpenTarget = target.jobId
    ? viewHasJob(view, target.jobId)
    : viewHasCustomer(view, target.customerId);
  if (
    wants === 'money' &&
    canOpenTarget &&
    viewShowsMoney(view, { jobId: target.jobId, customerId: target.customerId })
  ) {
    return {
      status: 'already_open',
      answer:
        `You can already be told the figures on ${target.jobId ? jobWords(target) : `${target.customerName}'s work`} — ` +
        'ask again and they will be in the answer.',
    };
  }

  // 4. HAS SHE ALREADY ASKED? One open request per person per thing per width:
  // a retried seat call, or the same ask twice in a morning, must not text
  // every manager twice.
  // KEYED ON WHAT SHE ASKED, not on what the desk narrowed it to. The
  // narrowing depends on how many live jobs that customer has RIGHT NOW, so a
  // customer-wide ask at 9am (one live job, narrowed to it) and the same ask at
  // 11am (a second job opened, so not narrowed) would key differently and text
  // every manager twice — the exact thing the key exists to prevent.
  const requestKey = requestKeyOf({
    technicianId: askerTechnicianId,
    jobId: input.jobId,
    customerId: input.customerId ?? target.customerId,
    wants,
  });
  const waiting = await findRequest(tenantId, requestKey);
  if (waiting && !hasLapsed(waiting, now())) {
    const tz = await firmTz(tenantId, deps);
    return {
      status: 'already_asked',
      answer:
        `You asked for that on ${servedDayPhrase(localDateISO(waiting.noticed_at, tz))} and it is ` +
        'still with your manager. I have not sent it again.',
    };
  }
  // A DAY OLD AND UNANSWERED IS GONE (operator, 2026-09-19). Move the row here,
  // at the only moment it matters — the unique index keys on status, so leaving
  // it open would refuse her a second ask forever. Then fall through and file a
  // fresh one, which texts the managers again. Best-effort: if the close fails
  // the insert below collides and she is told it is still waiting, which is the
  // old behaviour and not a loss.
  if (waiting) {
    try {
      await (deps.lapseRequest ?? lapseAccessRequest)(tenantId, waiting.id);
    } catch (err) {
      console.error(`[accessDesk] tenant ${tenantId}: could not lapse request ${waiting.id}`, err);
    }
  }

  // 5. TO THE MANAGERS — EVERY REQUEST, WITHOUT EXCEPTION (operator ruling,
  // 2026-09-20). The desk used to decide the narrow case itself, with one
  // bounded model call, and open one job's record for a day. That is gone.
  //
  // THE REASON IS A PROMISE, NOT A PERFORMANCE PROBLEM. The firm tells its
  // customers that a technician sees the work they are on and nothing else,
  // unless the firm widens it deliberately — the firm-wide rule, or a manager's
  // grant. An office that could open a record on its own judgment made that
  // promise untrue, however narrow the opening and however good the judgment.
  // It is the manager's consent that the promise is about.
  //
  // What this removes is worth stating plainly: there is now NO path anywhere
  // in this flow where a model's decision causes a write. The desk reads, it
  // files, it texts. Every widening of a view is a person's choice.
  return askTheManagers(input, target, requestKey, deps);
}

// ── the manager path ─────────────────────────────────────────────────────────

async function askTheManagers(
  input: AccessRequestInput,
  target: Target,
  requestKey: string,
  deps: AccessDeskDeps,
): Promise<AccessDeskAnswer> {
  const { tenantId, askerRef, askerTechnicianId, why, wants } = input;
  const what = whatWords(target, wants);

  // REACHABLE means texted, not merely listed. The delivery leg skips a person
  // with no sandbox (src/control/nudgeQueue.ts), so naming one to the
  // technician would be a promise nothing keeps.
  const managers = (await (deps.listManagers ?? listManagersWithTelegram)(tenantId)).filter(
    (m) => !!m.sandbox_ref,
  );
  const names = managers.map((m) => m.display_name);

  const request = await (deps.openRequest ?? openAccessRequest)({
    tenantId,
    technicianId: askerTechnicianId as string,
    context: {
      requestKey,
      technicianRef: askerRef,
      technicianName: input.askerName,
      ...(target.jobId ? { jobId: target.jobId } : {}),
      customerId: target.customerId,
      targetName: what,
      wants,
      why,
      managersTexted: names,
    },
  });
  // Null = somebody filed the same ask between step 4 and here. Converge on it
  // rather than texting a second time.
  if (!request) {
    return {
      status: 'already_asked',
      answer: 'That one is already with your manager — I have not sent it again.',
    };
  }

  // One text each, and the body says how to answer. NO IDS: the manager's seat
  // finds the request with list_access.
  //
  // THE MENU IS WIDTH-AWARE, and that is not cosmetic. A plain "yes" answers
  // the question that was ASKED — grant_access fills `money` and `opens` from
  // the request — so on a money ask "yes" already opens the figures. Offering
  // "yes with prices" beside it would imply the plain yes withholds them, and
  // a manager meaning "the record, not the numbers" would open the numbers.
  // The ledger has no delete path, so that mistake is only revocable, never
  // undoable.
  const menu =
    wants === 'money'
      ? 'Reply yes to open the figures, yes for good to leave them open, or no.'
      : wants === 'notes'
        ? 'Reply yes to open every note on it, yes for good to leave it open, or no.'
        : 'Reply to answer: yes, yes for good, yes with prices, or no.';
  const body = `${input.askerName} asks to open ${what} — they say: "${why}". ${menu}`;
  for (const m of managers) {
    try {
      await (deps.queuePush ?? queuePersonPush)({
        tenantId,
        technicianId: m.id,
        kind: 'access',
        body,
      });
    } catch (err) {
      // One manager's failed queue write must not lose the other's text, nor
      // the request — which is already filed and which the planner will chase.
      console.error(`[accessDesk] tenant ${tenantId}: could not queue the access text for ${m.ref}`, err);
    }
  }

  // WHAT IS PROMISED IS WHAT IS GUARANTEED. A manager's yes or no texts her; an
  // unanswered request simply lapses after a day, with nothing running on a
  // timer to tell her so (operator, 2026-09-19 — the office does not follow
  // up). So the desk says it has asked and points her back here, rather than
  // promising a message that may never come.
  const answer =
    names.length > 0
      ? `Asked your manager by text (${listNames(names)}). If they open it you'll get a message ` +
        "here; if you hear nothing, ask me about this job again and I'll tell you where it got to."
      : 'No manager could be texted just now. Your request is on the office record, but nobody ' +
        'has been alerted — if it matters today, catch a manager yourself.';
  await recordPair(input, target, answer, null, deps);
  return { status: 'asked_manager', answer };
}

const listNames = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// ── the planner's copy ───────────────────────────────────────────────────────

// THE DESK PAIR the planner reads on its next run (desk.ts's shape): the ask in
// the technician's words, and the outcome born READ, because it is a record of
// what was said in the office's name rather than queue work.
//
// BEST-EFFORT, DELIBERATELY. By the time this runs the grant is written or the
// managers are texted; a failed transcript write must never undo that or turn a
// done thing into an error the seat reports. The planner's appendix can drop a
// pair in a burst anyway — v_access_grants and the open request are the
// complete record, and this is the readable one.
async function recordPair(
  input: AccessRequestInput,
  target: Target,
  outcome: string,
  deskReason: string | null,
  deps: AccessDeskDeps,
): Promise<void> {
  const createMessage = deps.createMessage ?? createOfficeMessage;
  try {
    const ask = await createMessage({
      tenantId: input.tenantId,
      direction: 'to_planner',
      kind: 'ask',
      fromRef: input.askerRef,
      toRef: TEAM_LEAD_REF,
      tier: input.askerTier,
      body: `Asked to open ${whatWords(target, input.wants)}: "${input.why}"`,
    });
    await createMessage({
      tenantId: input.tenantId,
      direction: 'to_planner',
      kind: 'desk',
      fromRef: TEAM_LEAD_REF,
      toRef: input.askerRef,
      // The outcome LEADS, because the planner's appendix cuts this at 300
      // characters. The model's reasoning rides behind it, where losing it
      // costs nothing.
      body: deskReason ? `${outcome} (${deskReason})` : outcome,
      inReplyTo: ask.id,
      status: 'read',
    });
    try {
      await (deps.markRead ?? markOfficeMessagesRead)(
        input.tenantId,
        [ask.id],
        new Date().toISOString(),
      );
    } catch (err) {
      console.error(`[accessDesk] tenant ${input.tenantId}: marking the access ask read failed`, err);
    }
  } catch (err) {
    console.error(`[accessDesk] tenant ${input.tenantId}: the desk pair was not recorded`, err);
  }
}

async function firmTz(tenantId: string, deps: AccessDeskDeps): Promise<string> {
  try {
    return (await (deps.firmTenant ?? getTenant)(tenantId))?.timezone ?? 'UTC';
  } catch {
    return 'UTC';
  }
}
