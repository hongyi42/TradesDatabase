// The manager's access tools: who may open what, beyond a technician's own view.
//
// One domain's slice of the spine's tool surface (the src/mcp/tools/ split,
// 2026-09-12). Access plan A
// (thoughts/shared/plans/2026-09-19-access-plan-a-the-managers-access-tools.md).
//
// A technician's seat reads only what she is serving (technician_view_of, plan 2
// of the retrieval layer); everything else answers "outside your view". These
// four tools are how a MANAGER widens that: one grant at a time (grant_access,
// revoke_access, list_access) or the firm's own rule (set_technician_view).
//
// ALL FOUR ARE ADMIN, and the planner holds none of them (operator, 2026-09-19):
// the desk opens narrow asks in the moment (plan B), the planner only reads the
// history (v_access_grants). A planner tool would also fire in shadow runs and
// in the Calls-worker's focused passes, which share the team-lead schemas.
//
// MONEY IS SENSITIVE BY DEFAULT (operator, 2026-09-15 and 2026-09-19): a
// technician is told money as status words unless a manager opens the figures —
// firm-wide (money: 'amounts' on the firm's rule), for one person (a
// person-wide grant, `everywhere`), or on one job or customer (`money: true`).
//
// Tier membership is DECLARATIVE only: listing a tool under `admin` puts it in
// ADMIN_TOOL_NAMES, and the hub gates it by name before any handler here runs.
import {
  CAPTURE_CHANNELS,
  TECHNICIAN_DEFAULT_CHANNELS,
  TECHNICIAN_JOB_SCOPES,
  closeAccessRequest,
  contextOf,
  createOfficeMessage,
  getAccessGrant,
  getAccessRequest,
  getCustomer,
  getJob,
  getTechnician,
  getTechnicianView,
  getTechnicianViewRule,
  getTenant,
  insertAccessGrant,
  isInactiveState,
  listLiveAccessGrants,
  listOpenAccessRequests,
  queuePersonPush,
  reopenAccessRequest,
  revokeAccessGrant,
  rowCapNote,
  setTechnicianViewRule,
  viewHasCustomer,
  viewHasJob,
  viewShowsMoney,
} from '../../db/index.js';
import type {
  AccessGrantWithNames,
  AccessRequest,
  AccessWants,
  CaptureChannel,
  GrantOpens,
  TechnicianJobScope,
  TechnicianViewRule,
} from '../../db/index.js';
import { TEAM_LEAD_REF } from '../../teamLead/identity.js';
import { localDateISO } from '../../schedule/availability.js';
import { servedDayPhrase } from '../../schedule/dateResolve.js';
import { UUID_RE } from './shared.js';
import type { DomainTools, ToolContext } from './types.js';

const DAY_MS = 86_400_000;
// A manager's plain "yes" (operator, 2026-09-19): the record, for a week.
const DEFAULT_GRANT_DAYS = 7;
const MAX_GRANT_DAYS = 365;
// capture_tags.tag's own CHECK (migration 20260917120000): a hidden tag that
// could never be written is a rule that can never fire.
const TAG_RE = /^[a-z][a-z0-9_]{0,39}$/;
const RULE_FIELDS = ['jobScope', 'money', 'technicianChannels', 'hiddenTags'] as const;
type RuleField = (typeof RULE_FIELDS)[number];

const ADMIN_TOOLS = [
  {
    name: 'grant_access',
    description:
      'Open part of the record to ONE technician (manager only). A technician sees the ' +
      'customers whose unfinished work they have a trip on, their own jobs and their own notes; ' +
      'anything else answers "outside your view". A grant opens exactly one of: a JOB (jobId — ' +
      "also opens that customer's details), a CUSTOMER (customerId — every job of theirs, " +
      'finished ones too), or with everywhere:true, MONEY FIGURES on everything that technician ' +
      'can already open (it opens nothing new). opens: "record" (the default — the record and ' +
      'technicians\' notes; calls, emails and manager-only notes stay closed) or ' +
      '"record_and_notes" (every note on it, as you see them). money:true also shows the dollar ' +
      'figures there; without it a technician is told money only in words ("invoiced, not yet ' +
      'paid"). It lasts `days` (default 7) or, with standing:true, until revoked — EXCEPT an ' +
      'everywhere grant, which stands until revoked by DEFAULT; pass standing:false there to ' +
      'make it last `days` instead. A plain "yes" from the manager means the defaults. ' +
      'ANSWERING A REQUEST: pass requestId (list_access shows the open ones) and nothing else is ' +
      'needed — it fills in who asked and what they asked for, closes the request, and texts ' +
      'them the answer. Do not pass `technician` with it. Without a requestId the technician is ' +
      'NOT told automatically — relay the note, which says which case you are in. ' +
      'The ids here are for YOUR next call only: never say an id or a roster ref to your ' +
      'person — name the technician and the job in words.',
    inputSchema: {
      type: 'object',
      properties: {
        technician: {
          type: 'string',
          description:
            'Their roster ref, as list_team shows it. Not needed with requestId, and it must not ' +
            'disagree with it.',
        },
        jobId: { type: 'string', description: 'Open this one job (and its customer\'s details).' },
        customerId: {
          type: 'string',
          description: 'Open this customer: every job of theirs, finished ones too.',
        },
        everywhere: {
          type: 'boolean',
          description: 'true = money figures on everything they can already open. Needs money:true.',
        },
        opens: {
          type: 'string',
          enum: ['record', 'record_and_notes'],
          description: 'record (default) or record_and_notes (every note, calls and emails included).',
        },
        money: { type: 'boolean', description: 'true = also show the dollar figures there.' },
        days: { type: 'number', description: 'How many days it lasts, 1–365. Default 7.' },
        standing: {
          type: 'boolean',
          description:
            'true = until revoked (no end date). An everywhere grant is standing unless you pass false.',
        },
        requestId: {
          type: 'string',
          description: "The request this answers, from list_access. Fills in who and what they asked for.",
        },
        reason: { type: 'string', description: 'Why, in a few words. Kept on the record.' },
      },
      // `technician` is NOT required: a requestId supplies it, which is what
      // lets a manager answer an access text with a plain "yes". The handler
      // refuses the case where neither is given.
      required: ['reason'],
    },
  },
  {
    name: 'list_access',
    description:
      "What the firm's technicians may see beyond the default (manager only): the firm's own " +
      'rule, setting by setting, every grant that is open right now — who, what, until when, ' +
      'who granted it and why — and openRequests, the technicians still waiting on an answer. ' +
      'Each grant carries the id revoke_access takes; each request the id grant_access and ' +
      'decline_access take. Those ids are for YOUR next call only: never say an id or a roster ' +
      'ref to your person — name the technician and the job in words.',
    inputSchema: {
      type: 'object',
      properties: {
        technician: { type: 'string', description: 'Only this technician\'s grants (roster ref).' },
      },
    },
  },
  {
    name: 'revoke_access',
    description:
      'End one grant now (manager only), by the id list_access shows. The grant stays on the ' +
      'record, stamped revoked; nothing is deleted. The technician is not told automatically. ' +
      'Access is the UNION of every grant plus the firm\'s rule, so revoking one grant may close ' +
      'nothing — read the reply, which says what is actually shut. The id is for your own next ' +
      'call: never say an id or a roster ref to your person.',
    inputSchema: {
      type: 'object',
      properties: {
        grantId: { type: 'string', description: 'The grant id, from list_access.' },
        reason: { type: 'string', description: 'Why, in a few words. Kept on the record.' },
      },
      required: ['grantId', 'reason'],
    },
  },
  {
    name: 'decline_access',
    description:
      "Say NO to a technician's request to open part of the record (manager only), by the id " +
      'list_access shows under openRequests. They are texted your reason in your own words, so ' +
      'write it for them to read. Use this rather than ignoring a request: an unanswered one ' +
      'keeps waiting and the office keeps chasing it. The id is for your own next call — never ' +
      'say an id or a roster ref to your person.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'The request id, from list_access.' },
        reason: {
          type: 'string',
          description: 'Why, in a few words. THE TECHNICIAN IS TOLD THIS, so say it to them.',
        },
      },
      required: ['requestId', 'reason'],
    },
  },
  {
    name: 'set_technician_view',
    description:
      "Set the firm's own rule for what EVERY technician sees (manager only). Changes only the " +
      'settings you name; reset puts named settings back to the default. jobScope: ' +
      '"own_trips" (only jobs they have a trip on), "serving" (default — plus the unfinished ' +
      'jobs of customers they are serving), "serving_history" (plus those customers\' finished ' +
      'jobs), "whole_firm" (every customer and job). money: "status" (default — words only, no ' +
      'figures) or "amounts" (dollar figures for every technician, on everything they can open). ' +
      'technicianChannels: which kinds of note technicians may read (default: technician voice ' +
      'notes, notes and photos). hiddenTags: note tags kept from technicians. Reply with what ' +
      'changed, old to new.',
    inputSchema: {
      type: 'object',
      properties: {
        jobScope: { type: 'string', enum: [...TECHNICIAN_JOB_SCOPES] },
        money: { type: 'string', enum: ['status', 'amounts'] },
        technicianChannels: { type: 'array', items: { type: 'string', enum: [...CAPTURE_CHANNELS] } },
        hiddenTags: { type: 'array', items: { type: 'string' } },
        reset: { type: 'array', items: { type: 'string', enum: [...RULE_FIELDS] } },
      },
    },
  },
];

// ── helpers ──────────────────────────────────────────────────────────────────

// A boolean argument, or undefined when absent. A non-boolean is REJECTED, never
// coerced: "money": "yes" silently becoming false would close what the manager
// asked to open.
function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw new Error(`${key} must be true or false`);
  return v;
}

// UUID-SHAPED FIRST (the record_caller precedent): a malformed id would reach a
// uuid-typed column and come back as a raw database error.
function checkedId(v: string | undefined, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (!UUID_RE.test(v)) throw new Error(`${what} is not a valid id: take it from find_customer or get_job`);
  return v;
}

async function firmTimezone(tenantId: string): Promise<string> {
  return (await getTenant(tenantId))?.timezone ?? 'UTC';
}

// "until Friday 2026-09-26" in the firm's own calendar, or "until revoked".
const untilWords = (expiresAt: string | null, tz: string): string =>
  expiresAt ? `until ${servedDayPhrase(localDateISO(expiresAt, tz))}` : 'until revoked';

// What a grant opens, in words, from the names embedded with it.
//
// A NULLED EMBED MEANS THE ROW NAMES ANOTHER FIRM'S RECORD, and such a grant
// opens NOTHING: technician_view_of re-checks the tenant on every join, and
// sameFirmNames drops the embed for the same reason. Saying `the "untitled"
// job` there would describe a dead row as opening a job and a customer's
// details — the one description a manager must not be given, because the fix
// (grant the right id) looks unnecessary. Plan B writes grants through the same
// writer, which is what made this reachable.
function grantWhat(g: AccessGrantWithNames): string {
  if (g.job_id) {
    if (!g.jobs) return 'a record on another firm — this grant opens nothing';
    const customer = g.jobs.customers?.name;
    return `the "${g.jobs.title ?? 'untitled'}" job${customer ? ` for ${customer}` : ''} and that customer's details`;
  }
  if (g.customer_id) {
    if (!g.customers) return 'a record on another firm — this grant opens nothing';
    return `every job of ${g.customers.name}, finished ones too, and their details`;
  }
  return `money figures on everything ${g.technicians?.display_name ?? 'they'} can already open`;
}

// The extra words a scoped grant needs: which notes, and whether figures.
function grantDetail(opens: string | null, money: boolean): string {
  if (opens === null) return '';
  const notes =
    opens === 'record_and_notes'
      ? 'every note on it, calls and emails included'
      : "technicians' notes on it (calls, emails and manager-only notes stay closed)";
  return `, with ${notes}, and ${money ? 'the dollar figures' : 'money in words only, no figures'}`;
}

const SCOPE_WORDS: Record<TechnicianJobScope, string> = {
  own_trips: 'only the jobs they have a trip on',
  serving: 'the customers whose unfinished work they have a trip on, and those customers\' unfinished jobs',
  serving_history: "the customers they are serving, and all of those customers' jobs, finished ones too",
  whole_firm: 'every customer and every job',
};

// The defaults are the database's (technician_view_of); this module only says
// them in words.

// The firm's rule, one plain line per setting, the default named as such.
function ruleWords(rule: Pick<TechnicianViewRule, 'job_scope' | 'money' | 'technician_channels' | 'hidden_tags'> | null) {
  const scope = (rule?.job_scope ?? null) as TechnicianJobScope | null;
  const channels = rule?.technician_channels ?? null;
  const tags = rule?.hidden_tags ?? null;
  return {
    jobScope: scope ? SCOPE_WORDS[scope] : `${SCOPE_WORDS.serving} (the default)`,
    money:
      rule?.money === 'amounts'
        ? 'dollar figures on everything they can open'
        : 'status in words only, no figures (the default)',
    // `{}` IS NOT BLANK — it is every note closed but her own. Rendering the
    // empty join gave a manager an empty string for the strictest setting there
    // is, which reads as "nothing set" (its exact opposite).
    technicianChannels: channels
      ? channels.length > 0
        ? channels.join(', ')
        : 'no kinds of note at all — technicians read only their own notes'
      : `${TECHNICIAN_DEFAULT_CHANNELS.join(', ')} (the default)`,
    hiddenTags: tags && tags.length > 0 ? tags.join(', ') : 'none (the default)',
  };
}

// What a request asked for, in words, off its context.
const requestWords = (req: AccessRequest): string => contextOf(req).targetName ?? 'what they asked for';

// WHO GRANTED IT, IN WORDS. `granted_by` and `revoked_by` are roster REFS (and
// 'spine:team-lead' for a desk-opened grant), and these strings are read out to
// a person — the same rule this tool's own description states. A ref that no
// longer matches a roster row still has to render, so the fallback says the
// role rather than the ref.
async function actorWords(tenantId: string, ref: string | null): Promise<string> {
  if (!ref) return 'someone';
  if (ref === TEAM_LEAD_REF) return 'the office';
  try {
    return (await getTechnician(tenantId, ref))?.display_name ?? 'a manager';
  } catch {
    return 'a manager';
  }
}

// THE PLANNER HEARS EVERY ANSWER. One inform per grant, decline and revoke, in
// words — the planner grants nothing itself (operator, 2026-09-19) but it is
// the thing that chases what goes unanswered, and it cannot chase what it never
// saw. Best-effort: the access decision is already committed, and a failed
// office write must never turn it into an error the manager's seat reports.
async function tellThePlanner(tenantId: string, managerRef: string, body: string): Promise<void> {
  try {
    await createOfficeMessage({
      tenantId,
      direction: 'to_planner',
      kind: 'inform',
      fromRef: managerRef,
      toRef: TEAM_LEAD_REF,
      // Sender metadata, never authority — the office.ts inform precedent.
      tier: 'manager',
      body,
    });
  } catch (err) {
    console.error(`access: the planner was not told (${body.slice(0, 60)}…)`, err);
  }
}

// THE TECHNICIAN HEARS EVERY ANSWER, yes and no (operator accepted). Same
// best-effort posture, and the same reason.
async function textTheTechnician(tenantId: string, technicianId: string, body: string): Promise<void> {
  try {
    await queuePersonPush({ tenantId, technicianId, kind: 'access', body });
  } catch (err) {
    console.error('access: the technician was not texted about the answer', err);
  }
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleGrantAccess(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str, identity } = toolCtx;
  const reason = str('reason')?.trim();
  if (!reason) throw new Error('reason is required: say why, in a few words');

  // ── ANSWERING A REQUEST ────────────────────────────────────────────────────
  // The request supplies who and what, so the manager's seat can answer a text
  // with a plain "yes"; anything the manager DOES name overrides it, because a
  // manager saying "yes, but only the one job" is deciding, not mis-filling.
  const requestId = checkedId(str('requestId'), 'requestId');
  let request: AccessRequest | null = null;
  if (requestId) {
    request = await getAccessRequest(tenantId, requestId);
    if (!request) {
      throw new Error('no request with that id on this firm: list_access shows the open ones');
    }
    if (request.status === 'dismissed') {
      // WHAT BECAME OF IT — the dismissal reason is the whole record, and a
      // bare "already answered" would send the seat looking for a bug. Not
      // "answered", though: the office can set one aside too, and telling a
      // manager somebody answered it when nobody did is worse than vague.
      throw new Error(
        `that request is no longer open: ${request.dismiss_reason ?? 'settled'}. Nothing changed.`,
      );
    }
  }
  const reqCtx = request ? contextOf(request) : {};

  // WHO. A request's own technician is the AUTHORITY, and a manager naming a
  // different one is refused rather than obeyed: obeying it would open the job
  // for the named person, text THEM about someone else's ask, and close the
  // requester's request as answered — leaving her never told, unable to ask
  // again into the same channel, and with nothing opened.
  const namedRef = str('technician');
  if (request && namedRef && namedRef !== reqCtx.technicianRef) {
    throw new Error(
      `that request is ${reqCtx.technicianName ?? 'someone else'}'s — answer it as it stands ` +
        '(requestId alone), or grant this other person access separately, without requestId',
    );
  }
  const ref = namedRef ?? reqCtx.technicianRef;
  if (!ref) throw new Error('technician is required: their roster ref, as list_team shows it');

  // WHAT. Count what the MANAGER named first, so "name exactly one" still fires
  // on two of them; the request fills in only when they named no scope at all.
  const namedJobId = checkedId(str('jobId'), 'jobId');
  const namedCustomerId = checkedId(str('customerId'), 'customerId');
  const everywhere = optBool(args, 'everywhere') === true;
  const namedScopes = [namedJobId, namedCustomerId, everywhere || undefined].filter(
    (x) => x !== undefined,
  ).length;
  if (namedScopes > 1) {
    throw new Error('name exactly one of jobId, customerId, or everywhere: true');
  }
  // A request names a job AND its customer; the job is the narrower of the two
  // and is what the technician asked about, so it wins. `everywhere` is a scope
  // the manager named, so it simply replaces the request's — answering "open
  // the figures everywhere" to a one-job ask is a decision, not a mis-fill.
  const fromRequest =
    namedScopes === 0 && request
      ? {
          jobId: checkedId(reqCtx.jobId, 'the request\'s jobId'),
          customerId: reqCtx.jobId ? undefined : checkedId(reqCtx.customerId, 'the request\'s customerId'),
        }
      : { jobId: undefined, customerId: undefined };
  const scoped = {
    jobId: namedJobId ?? fromRequest.jobId,
    customerId: namedCustomerId ?? fromRequest.customerId,
  };
  if ([scoped.jobId, scoped.customerId, everywhere || undefined].filter((x) => x !== undefined).length !== 1) {
    throw new Error('name exactly one of jobId, customerId, or everywhere: true');
  }
  // `null` reads as "not given", like every other optional here: a model that
  // fills unused optionals with null must not be sent down a two-turn dead end.
  if (args.opens !== undefined && args.opens !== null
      && args.opens !== 'record' && args.opens !== 'record_and_notes') {
    throw new Error('opens must be "record" or "record_and_notes"');
  }
  // What the technician ASKED for fills in what the manager did not say. A
  // request for every note becomes `record_and_notes`; one for figures becomes
  // money — so a manager's plain "yes" answers the question that was actually
  // put to them, rather than silently granting the narrowest thing.
  const wants = reqCtx.wants as AccessWants | undefined;
  const namedOpens = (args.opens === undefined || args.opens === null
    ? undefined
    : args.opens) as GrantOpens | undefined;
  const opensArg =
    namedOpens ?? (wants === 'notes' ? ('record_and_notes' as GrantOpens) : undefined);
  const money = optBool(args, 'money') ?? wants === 'money';
  const standing = optBool(args, 'standing') ?? false;
  let days: number | undefined;
  if (args.days !== undefined && args.days !== null) {
    if (typeof args.days !== 'number' || !Number.isInteger(args.days) || args.days < 1 || args.days > MAX_GRANT_DAYS) {
      throw new Error(`days must be a whole number from 1 to ${MAX_GRANT_DAYS}`);
    }
    days = args.days;
  }
  if (standing && days !== undefined) throw new Error('give days or standing: true, not both');
  if (everywhere) {
    if (!money) throw new Error('everywhere opens money figures only: pass money: true with it');
    if (opensArg !== undefined) throw new Error('everywhere opens no record, only figures: leave opens out');
  }

  const tech = await getTechnician(tenantId, ref);
  if (!tech) throw new Error(`technician '${ref}' not found on the roster: list_team shows the refs`);
  if (tech.tier === 'manager') {
    throw new Error(`${tech.display_name} is a manager, and managers already see the whole record`);
  }
  if (isInactiveState(tech.state)) {
    throw new Error(`${tech.display_name}'s seat is deactivated: reactivate it first`);
  }
  // getJob / getCustomer take no tenant: the firm is checked here, and another
  // firm's id answers exactly like an unknown one.
  if (scoped.jobId) {
    const job = await getJob(scoped.jobId);
    if (!job || job.tenant_id !== tenantId) throw new Error('job not found on this firm');
  }
  if (scoped.customerId) {
    const customer = await getCustomer(scoped.customerId);
    if (!customer || customer.tenant_id !== tenantId) throw new Error('customer not found on this firm');
  }

  // A person-wide money grant is standing unless told otherwise; everything else
  // lasts the manager's days, or the default week. `standing: false` is an
  // INSTRUCTION, not an absent argument — on the everywhere path it used to be
  // read as "say nothing", which silently produced the standing grant the
  // manager had just declined.
  const standingGiven = optBool(args, 'standing');
  const expiresAt =
    standing || (everywhere && days === undefined && standingGiven === undefined)
      ? null
      : new Date(Date.now() + (days ?? DEFAULT_GRANT_DAYS) * DAY_MS).toISOString();
  const opens: GrantOpens | null = everywhere ? null : (opensArg ?? 'record');
  const until = untilWords(expiresAt, await firmTimezone(tenantId));
  const manager = toolCtx.caller?.display_name ?? identity.technicianRef;

  // THE FIRST ANSWER WINS, and the ORDER is what makes that structural.
  //
  // Close the request first, under its own status guard: of two managers
  // answering the same text at once, exactly one close succeeds, and the loser
  // stops here having written nothing. Insert-first would have both write a
  // grant, and the ledger has NO DELETE PATH — the losing grant could never be
  // taken back, only revoked, leaving a permanent row nobody decided on.
  if (request) {
    const closed = await closeAccessRequest(
      tenantId,
      request.id,
      `opened by ${manager} ${until}`,
    );
    if (!closed) {
      throw new Error(
        'that request was answered a moment ago by someone else; nothing changed. ' +
          'list_access shows what is open now.',
      );
    }
  }

  let inserted;
  try {
    inserted = await insertAccessGrant({
      tenantId,
      technicianId: tech.id,
      ...(scoped.jobId ? { jobId: scoped.jobId } : {}),
      ...(scoped.customerId ? { customerId: scoped.customerId } : {}),
      opens,
      opensMoney: money,
      expiresAt,
      ...(request ? { requestedBy: reqCtx.technicianRef ?? ref } : {}),
      grantedBy: identity.technicianRef,
      reason,
    });
  } catch (err) {
    // The request was closed on the promise of a grant that did not land. Put
    // it back, so the ask is still waiting rather than silently answered by
    // nothing — and never mask the insert's own error, which is what the
    // manager's seat has to act on.
    if (request) {
      try {
        await reopenAccessRequest(tenantId, request.id);
      } catch (reopenErr) {
        console.error(`grant_access: request ${request.id} was closed but not reopened`, reopenErr);
      }
    }
    throw err;
  }

  const g = await getAccessGrant(inserted.id, tenantId);
  if (!g) throw new Error('the grant was recorded but could not be read back: check list_access');
  const what = grantWhat(g);

  await tellThePlanner(
    tenantId,
    identity.technicianRef,
    `Opened ${what} for ${tech.display_name} ${until}` +
      (request ? ` — they had asked: "${reqCtx.why ?? ''}"` : '') +
      `. Why: ${reason}`,
  );
  if (request) {
    // WHAT WAS GRANTED, not what was asked — the manager may have opened
    // something narrower (one job of the customer she named, or the record
    // without the figures). Telling her she has what she asked for would send
    // her back to a page that is still half closed, with the request now
    // closed behind her.
    await textTheTechnician(
      tenantId,
      // The request's own person: `tech` is the same row (a mismatched
      // `technician` was refused above), and saying so here keeps it true if
      // that guard is ever loosened.
      request.technician_id ?? tech.id,
      `${manager} opened ${what} for you ${until}. Ask me again and I'll read it.`,
    );
  }

  return {
    granted: {
      id: g.id,
      technician: tech.display_name,
      what,
      notes: opens === 'record_and_notes',
      money,
      until,
      ...(request ? { answeredRequest: true } : {}),
    },
    note:
      `${tech.display_name} can now open ${what}${grantDetail(opens, money)}, ${until}. ` +
      (request
        ? 'They have been texted, so there is nothing to relay.'
        : 'They are not told automatically yet: let them know.'),
  };
}

async function handleDeclineAccess(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str, identity } = toolCtx;
  const requestId = str('requestId');
  if (!requestId) throw new Error('requestId is required: list_access shows the open requests');
  const reason = str('reason')?.trim();
  if (!reason) throw new Error('reason is required: say why, in a few words — the technician is told');
  const none = {
    declined: false,
    note: 'no request with that id on this firm: list_access shows the open ones',
  };
  if (!UUID_RE.test(requestId)) return none;
  const request = await getAccessRequest(tenantId, requestId);
  if (!request) return none;
  if (request.status === 'dismissed') {
    return {
      declined: false,
      note: `that request is no longer open: ${request.dismiss_reason ?? 'settled'}. Nothing changed.`,
    };
  }
  const manager = toolCtx.caller?.display_name ?? identity.technicianRef;
  const closed = await closeAccessRequest(tenantId, request.id, `declined by ${manager}: ${reason}`);
  if (!closed) {
    return {
      declined: false,
      note: 'that request was answered a moment ago by someone else; nothing changed',
    };
  }
  const what = requestWords(request);
  const ctx = contextOf(request);
  await tellThePlanner(
    tenantId,
    identity.technicianRef,
    `Said no to opening ${what} for ${ctx.technicianName ?? 'a technician'}. Why: ${reason}`,
  );
  if (request.technician_id) {
    await textTheTechnician(
      tenantId,
      request.technician_id,
      `${manager} said no to opening ${what}: ${reason}`,
    );
  }
  return {
    declined: true,
    note: `${ctx.technicianName ?? 'They'} have been texted that the answer is no, with your reason.`,
  };
}

async function handleListAccess(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str } = toolCtx;
  const ref = str('technician');
  let technicianId: string | undefined;
  if (ref) {
    const tech = await getTechnician(tenantId, ref);
    if (!tech) throw new Error(`technician '${ref}' not found on the roster: list_team shows the refs`);
    technicianId = tech.id;
  }
  const [rule, live, tz, open] = await Promise.all([
    getTechnicianViewRule(tenantId),
    listLiveAccessGrants(tenantId, technicianId ? { technicianId } : {}),
    firmTimezone(tenantId),
    listOpenAccessRequests(tenantId),
  ]);
  const grants = live.rows.map((g) => ({
    id: g.id,
    technician: g.technicians?.display_name ?? null,
    technicianRef: g.technicians?.ref ?? null,
    what: grantWhat(g),
    notes: g.opens === 'record_and_notes',
    money: g.opens_money,
    until: untilWords(g.expires_at, tz),
    grantedBy: g.granted_by,
    reason: g.reason,
    grantedOn: servedDayPhrase(localDateISO(g.created_at, tz)),
  }));
  // WHAT IS STILL WAITING. This is where a manager's seat looks after an access
  // text, so it carries the id grant_access and decline_access take — and
  // nothing else here is the answer to "who is waiting on me".
  const requests = open
    .filter((r) => !technicianId || r.technician_id === technicianId)
    .map((r) => {
      const c = contextOf(r);
      return {
        id: r.id,
        technician: c.technicianName ?? null,
        asked: c.targetName ?? null,
        wants: c.wants ?? null,
        why: c.why ?? null,
        askedOn: servedDayPhrase(localDateISO(r.noticed_at, tz)),
        managersTexted: c.managersTexted ?? [],
      };
    });
  return {
    firmRule: ruleWords(rule),
    grants,
    count: grants.length,
    openRequests: requests,
    ...(requests.length === 1
      ? { requestNote: 'One request is waiting: a plain "yes" from the manager answers it.' }
      : requests.length > 1
        ? {
            requestNote:
              `${requests.length} requests are waiting — ask which one they mean before answering, ` +
              'by naming the technician and what they asked for.',
          }
        : {}),
    ...(live.capped ? { note: rowCapNote('grants') } : {}),
  };
}

async function handleRevokeAccess(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str, identity } = toolCtx;
  const grantId = str('grantId');
  if (!grantId) throw new Error('grantId is required: list_access shows each grant\'s id');
  const reason = str('reason')?.trim();
  if (!reason) throw new Error('reason is required: say why, in a few words');
  const none = { revoked: false, note: 'no grant with that id on this firm: list_access shows the open ones' };
  if (!UUID_RE.test(grantId)) return none;
  const g = await getAccessGrant(grantId, tenantId);
  if (!g) return none;
  const name = g.technicians?.display_name ?? 'The technician';
  if (g.revoked_at) {
    return {
      revoked: false,
      note:
        `that grant was already revoked (by ${await actorWords(tenantId, g.revoked_by)}); ` +
        'nothing changed',
    };
  }
  if (g.expires_at && Date.parse(g.expires_at) <= Date.now()) {
    return { revoked: false, note: 'that grant has already ended; nothing changed' };
  }
  const done = await revokeAccessGrant(g.id, tenantId, identity.technicianRef, reason);
  if (!done) return { revoked: false, note: 'that grant was revoked a moment ago by someone else; nothing changed' };

  // WHAT IS ACTUALLY CLOSED NOW — asked of the view, after the revoke.
  //
  // Access is the UNION of every live grant, the firm's own rule, and the work
  // she is serving. "<Name> can no longer open <what>" was therefore a guess,
  // and a manager acts on that sentence: revoking one of two overlapping
  // grants, or a person-wide money grant while the firm's rule already says
  // `amounts`, left them believing they had closed something they had not.
  // Best-effort — the revoke is already committed, so a failed read must not
  // turn a done thing into an error. It costs the extra sentence, never the act.
  let stillOpen: 'grant' | 'otherwise' | null = null;
  let throughGrant: AccessGrantWithNames | undefined;
  try {
    const view = await getTechnicianView(tenantId, g.technician_id);
    const opensRecordStill = g.job_id
      ? viewHasJob(view, g.job_id)
      : g.customer_id
        ? viewHasCustomer(view, g.customer_id)
        : false;
    const opensMoneyStill =
      g.opens_money &&
      (g.job_id || g.customer_id
        ? viewShowsMoney(view, { jobId: g.job_id, customerId: g.customer_id })
        : view.moneyAll);
    if (opensRecordStill || opensMoneyStill) {
      const live = await listLiveAccessGrants(tenantId, { technicianId: g.technician_id });
      // WHAT ELSE OPENS THE SAME THING — and it has to be read in BOTH
      // directions. technician_view_of adds a job grant's customer to
      // customer_ids, so a live JOB grant keeps that customer open after the
      // customer grant is revoked; matching only customer-to-customer missed
      // it and sent the manager to change the firm's rule, which would not
      // have closed it. A person-wide money grant is only ever kept open by
      // ANOTHER person-wide grant (or the firm's rule) — a job-scoped money
      // grant cannot produce moneyAll, so it must not be offered as the cause.
      throughGrant = live.rows.find((o) => {
        if (o.id === g.id) return false;
        if (g.job_id) return o.job_id === g.job_id || o.customer_id === g.jobs?.customer_id;
        if (g.customer_id) {
          return o.customer_id === g.customer_id || o.jobs?.customer_id === g.customer_id;
        }
        return o.job_id === null && o.customer_id === null && o.opens_money;
      });
      stillOpen = throughGrant ? 'grant' : 'otherwise';
    }
  } catch (err) {
    console.error(`revoke_access: could not re-read ${name}'s view after the revoke`, err);
  }

  const what = grantWhat(g);
  // Both of these are post-commit decoration: the revoke has already landed, so
  // a transient read here must cost the extra sentence, never turn a done thing
  // into an error the manager would retry.
  let granter = 'someone';
  let otherUntil = '';
  if (stillOpen === 'grant') {
    try {
      granter = await actorWords(tenantId, throughGrant?.granted_by ?? null);
      otherUntil = untilWords(throughGrant?.expires_at ?? null, await firmTimezone(tenantId));
    } catch (err) {
      console.error('revoke_access: could not describe the overlapping grant', err);
    }
  }
  const tail =
    stillOpen === 'grant'
      ? ` — but they still open it through another grant, granted by ${granter}` +
        `${otherUntil ? `, ${otherUntil}` : ''}. ` +
        'Revoke that one too if you meant to close it.'
      : stillOpen === 'otherwise'
        ? " — but they can still open it anyway: it is either within what the firm opens to every " +
          'technician (list_access shows the rule) or it is their own work. Closing it takes a ' +
          'change to the firm\'s rule, not a revoke.'
        : '';
  await tellThePlanner(
    tenantId,
    identity.technicianRef,
    `Revoked ${name}'s access to ${what}. Why: ${reason}` +
      (stillOpen ? ' (they can still open it another way).' : '.'),
  );
  return {
    revoked: true,
    stillOpen: stillOpen !== null,
    note:
      (stillOpen
        ? `That grant is revoked${tail}`
        : `${name} can no longer open ${what}.`) +
      ' They are not told automatically: let them know if it matters.',
  };
}

async function handleSetTechnicianView(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, identity } = toolCtx;
  const reset = args.reset === undefined || args.reset === null ? [] : args.reset;
  if (!Array.isArray(reset) || reset.some((f) => !(RULE_FIELDS as readonly unknown[]).includes(f))) {
    throw new Error(`reset must be a list of setting names: ${RULE_FIELDS.join(', ')}`);
  }
  const resetting = new Set(reset as RuleField[]);
  // Named = the settings this call states, `hiddenTags: []` included: it is a
  // real instruction ("hide nothing"), normalised to null further down.
  const named = RULE_FIELDS.filter((f) => args[f] !== undefined && args[f] !== null);
  if (named.length === 0 && resetting.size === 0) {
    throw new Error(`name at least one setting to change (${RULE_FIELDS.join(', ')}), or reset one`);
  }
  const both = named.filter((f) => resetting.has(f));
  if (both.length > 0) throw new Error(`${both.join(', ')}: set it or reset it, not both`);

  if (args.jobScope !== undefined && args.jobScope !== null
      && !(TECHNICIAN_JOB_SCOPES as readonly unknown[]).includes(args.jobScope)) {
    throw new Error(`jobScope must be one of: ${TECHNICIAN_JOB_SCOPES.join(', ')}`);
  }
  if (args.money !== undefined && args.money !== null && args.money !== 'status' && args.money !== 'amounts') {
    throw new Error('money must be "status" (words only) or "amounts" (dollar figures)');
  }
  if (args.technicianChannels !== undefined && args.technicianChannels !== null) {
    const ch = args.technicianChannels;
    if (!Array.isArray(ch) || ch.some((c) => !(CAPTURE_CHANNELS as readonly unknown[]).includes(c))) {
      throw new Error(`technicianChannels must be a list of: ${CAPTURE_CHANNELS.join(', ')}`);
    }
    // In the database an empty list means NO channels, not the default: every
    // note but a technician's own would close. Asked for by name, never by [].
    if (ch.length === 0) {
      throw new Error(
        'an empty list would close every note to technicians except their own: to go back to ' +
          'the default, use reset: ["technicianChannels"]',
      );
    }
  }
  if (args.hiddenTags !== undefined && args.hiddenTags !== null) {
    const tags = args.hiddenTags;
    if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string' || !TAG_RE.test(t))) {
      throw new Error('hiddenTags must be a list of lowercase tags (letters, digits, underscores)');
    }
    // An empty list IS the default (hide nothing), unlike technicianChannels
    // where `{}` means "read nothing". Read as a reset, so "hide nothing" has
    // ONE stored shape (null) and clearing the list really clears it — mapping
    // it to null in `args` instead would read as "not given" and keep the old
    // tags, which is the opposite of what the manager asked for.
    if (tags.length === 0) {
      resetting.add('hiddenTags');
      delete args.hiddenTags;
    }
  }

  const current = await getTechnicianViewRule(tenantId);
  const before = {
    job_scope: current?.job_scope ?? null,
    money: current?.money ?? null,
    technician_channels: current?.technician_channels ?? null,
    hidden_tags: current?.hidden_tags ?? null,
  };
  const pick = <T>(field: RuleField, given: unknown, was: T): T | null =>
    resetting.has(field) ? null : given !== undefined && given !== null ? (given as T) : was;
  const after = {
    job_scope: pick('jobScope', args.jobScope, before.job_scope),
    money: pick('money', args.money, before.money),
    technician_channels: pick('technicianChannels', args.technicianChannels, before.technician_channels),
    hidden_tags: pick('hiddenTags', args.hiddenTags, before.hidden_tags),
  };
  const allDefault = Object.values(after).every((v) => v === null);
  await setTechnicianViewRule(
    tenantId,
    allDefault
      ? null
      : {
          jobScope: after.job_scope as TechnicianJobScope | null,
          money: after.money as 'status' | 'amounts' | null,
          technicianChannels: after.technician_channels as CaptureChannel[] | null,
          hiddenTags: after.hidden_tags,
        },
    identity.technicianRef,
  );
  const was = ruleWords(before);
  const now = ruleWords(after);
  // Diffed on the STORED values, not on the words: `hiddenTags: []` against a
  // firm that had none is a real write, and both sides read "none (the
  // default)". Saying "nothing changed" there would be a lie about the record.
  const stored: Record<RuleField, [unknown, unknown]> = {
    jobScope: [before.job_scope, after.job_scope],
    money: [before.money, after.money],
    technicianChannels: [before.technician_channels, after.technician_channels],
    hiddenTags: [before.hidden_tags, after.hidden_tags],
  };
  // TWO DIFFERENT QUESTIONS, and conflating them is what produced "money:
  // changed from status in words only (the default) to status in words only
  // (the default)". The STORED diff decides whether to write (storing
  // `money: 'status'` over a null that meant the same thing is a real write, and
  // "nothing changed" would be a lie about the record). The WORDS decide what to
  // REPORT, because a manager acts on the sentence, and a change whose two sides
  // read identically is not a change they can act on.
  const changes = RULE_FIELDS.filter(
    (f) => JSON.stringify(stored[f][0]) !== JSON.stringify(stored[f][1]) && was[f] !== now[f],
  ).map((f) => ({ setting: f, from: was[f], to: now[f] }));
  return {
    rule: now,
    changes,
    note:
      changes.length === 0
        ? 'Nothing changed: that is already how the firm is set.'
        : 'Every technician now sees by this rule, from their next question. Tell the manager ' +
          'exactly what changed, old to new.',
  };
}

export const accessTools = {
  domain: 'access',
  admin: ADMIN_TOOLS,
  handlers: {
    decline_access: handleDeclineAccess,
    grant_access: handleGrantAccess,
    list_access: handleListAccess,
    revoke_access: handleRevokeAccess,
    set_technician_view: handleSetTechnicianView,
  },
} satisfies DomainTools;
