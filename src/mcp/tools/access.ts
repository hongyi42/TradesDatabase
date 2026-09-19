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
  getAccessGrant,
  getCustomer,
  getJob,
  getTechnician,
  getTechnicianViewRule,
  getTenant,
  insertAccessGrant,
  isInactiveState,
  listLiveAccessGrants,
  revokeAccessGrant,
  rowCapNote,
  setTechnicianViewRule,
} from '../../db/index.js';
import type {
  AccessGrantWithNames,
  CaptureChannel,
  GrantOpens,
  TechnicianJobScope,
  TechnicianViewRule,
} from '../../db/index.js';
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
      'paid"). It lasts `days` (default 7) or, with standing:true, until revoked. A plain "yes" ' +
      'from the manager means the defaults. The technician is NOT told automatically — relay ' +
      'the note, which says so.',
    inputSchema: {
      type: 'object',
      properties: {
        technician: { type: 'string', description: 'Their roster ref, as list_team shows it.' },
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
        standing: { type: 'boolean', description: 'true = until revoked (no end date).' },
        reason: { type: 'string', description: 'Why, in a few words. Kept on the record.' },
      },
      required: ['technician', 'reason'],
    },
  },
  {
    name: 'list_access',
    description:
      "What the firm's technicians may see beyond the default (manager only): the firm's own " +
      'rule, setting by setting, and every grant that is open right now — who, what, until when, ' +
      'who granted it and why. Each grant carries the id revoke_access takes.',
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
      'record, stamped revoked; nothing is deleted. The technician is not told automatically.',
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
function grantWhat(g: AccessGrantWithNames): string {
  if (g.job_id) {
    const customer = g.jobs?.customers?.name;
    return `the "${g.jobs?.title ?? 'untitled'}" job${customer ? ` for ${customer}` : ''} and that customer's details`;
  }
  if (g.customer_id) return `every job of ${g.customers?.name ?? 'that customer'}, finished ones too, and their details`;
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
    technicianChannels: channels
      ? channels.join(', ')
      : `${TECHNICIAN_DEFAULT_CHANNELS.join(', ')} (the default)`,
    hiddenTags: tags && tags.length > 0 ? tags.join(', ') : 'none (the default)',
  };
}

// ── handlers ─────────────────────────────────────────────────────────────────

async function handleGrantAccess(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str, identity } = toolCtx;
  const ref = str('technician');
  if (!ref) throw new Error('technician is required: their roster ref, as list_team shows it');
  const reason = str('reason')?.trim();
  if (!reason) throw new Error('reason is required: say why, in a few words');
  const jobId = checkedId(str('jobId'), 'jobId');
  const customerId = checkedId(str('customerId'), 'customerId');
  const everywhere = optBool(args, 'everywhere') === true;
  if ([jobId, customerId, everywhere || undefined].filter((x) => x !== undefined).length !== 1) {
    throw new Error('name exactly one of jobId, customerId, or everywhere: true');
  }
  // `null` reads as "not given", like every other optional here: a model that
  // fills unused optionals with null must not be sent down a two-turn dead end.
  if (args.opens !== undefined && args.opens !== null
      && args.opens !== 'record' && args.opens !== 'record_and_notes') {
    throw new Error('opens must be "record" or "record_and_notes"');
  }
  const opensArg = (args.opens ?? undefined) as GrantOpens | undefined;
  const money = optBool(args, 'money') ?? false;
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
  if (jobId) {
    const job = await getJob(jobId);
    if (!job || job.tenant_id !== tenantId) throw new Error('job not found on this firm');
  }
  if (customerId) {
    const customer = await getCustomer(customerId);
    if (!customer || customer.tenant_id !== tenantId) throw new Error('customer not found on this firm');
  }

  // A person-wide money grant is standing unless told otherwise; everything else
  // lasts the manager's days, or the default week.
  const expiresAt =
    standing || (everywhere && days === undefined)
      ? null
      : new Date(Date.now() + (days ?? DEFAULT_GRANT_DAYS) * DAY_MS).toISOString();
  const opens: GrantOpens | null = everywhere ? null : (opensArg ?? 'record');
  const inserted = await insertAccessGrant({
    tenantId,
    technicianId: tech.id,
    ...(jobId ? { jobId } : {}),
    ...(customerId ? { customerId } : {}),
    opens,
    opensMoney: money,
    expiresAt,
    grantedBy: identity.technicianRef,
    reason,
  });
  const g = await getAccessGrant(inserted.id, tenantId);
  if (!g) throw new Error('the grant was recorded but could not be read back: check list_access');
  const what = grantWhat(g);
  const until = untilWords(expiresAt, await firmTimezone(tenantId));
  return {
    granted: {
      id: g.id,
      technician: tech.display_name,
      what,
      notes: opens === 'record_and_notes',
      money,
      until,
    },
    note:
      `${tech.display_name} can now open ${what}${grantDetail(opens, money)}, ${until}. ` +
      'They are not told automatically yet: let them know.',
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
  const [rule, live, tz] = await Promise.all([
    getTechnicianViewRule(tenantId),
    listLiveAccessGrants(tenantId, technicianId ? { technicianId } : {}),
    firmTimezone(tenantId),
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
  return {
    firmRule: ruleWords(rule),
    grants,
    count: grants.length,
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
    return { revoked: false, note: `that grant was already revoked (by ${g.revoked_by}); nothing changed` };
  }
  if (g.expires_at && Date.parse(g.expires_at) <= Date.now()) {
    return { revoked: false, note: 'that grant has already ended; nothing changed' };
  }
  const done = await revokeAccessGrant(g.id, tenantId, identity.technicianRef, reason);
  if (!done) return { revoked: false, note: 'that grant was revoked a moment ago by someone else; nothing changed' };
  return {
    revoked: true,
    note: `${name} can no longer open ${grantWhat(g)}. They are not told automatically: let them know if it matters.`,
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
  const changes = RULE_FIELDS.filter(
    (f) => JSON.stringify(stored[f][0]) !== JSON.stringify(stored[f][1]),
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
    grant_access: handleGrantAccess,
    list_access: handleListAccess,
    revoke_access: handleRevokeAccess,
    set_technician_view: handleSetTechnicianView,
  },
} satisfies DomainTools;
