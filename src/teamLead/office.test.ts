import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { insertTechnician } from '../db/technicians.js';
import { createPendingNudge } from '../db/nudges.js';
import { OFFICE_MESSAGE_BODY_MAX } from '../db/officeMessages.js';
import { hasModelCredentials } from '../model/forcedTool.js';
import { dispatchForIdentity, TEAM_LEAD_TOOL_SCHEMAS } from '../mcp/server.js';
import type { ForcedToolSpec } from '../model/forcedTool.js';
import type { ToolLoopResult } from '../model/toolLoop.js';
import type {
  AccessRequest,
  Customer,
  Job,
  Nudge,
  OfficeMessage,
  TechnicianView,
} from '../db/index.js';
import {
  answerAsOffice,
  askerHistory,
  ASKER_HISTORY_TOOL,
  CATALOG_TOOL,
  catalogLookup,
  MANAGER_FACING_TOOLS,
  OFFICE_FALLBACK_NOTE,
  OFFICE_NARROW_REMINDER,
  officeToolsFor,
  renderAskerState,
  runOfficeDoor,
  type OfficeDoorDeps,
  type OfficeWaitingDeps,
} from './office.js';
import { ANSWER_TOOL, OFFICE_SYSTEM } from './officePrompt.js';
import { TEAM_LEAD_REF } from './identity.js';

// ── fixtures ─────────────────────────────────────────────────────────────────

const T = 't1';
const CUST = '11111111-1111-4111-8111-111111111111';
const JOB_IN = '22222222-2222-4222-8222-222222222222';
const JOB_OUT = '33333333-3333-4333-8333-333333333333';
const JOB_DONE = '44444444-4444-4444-8444-444444444444';

const view = (jobIds: string[] = []): TechnicianView => ({
  allScope: false,
  jobIds: new Set(jobIds),
  customerIds: new Set(),
  moneyAll: false,
  moneyJobIds: new Set(),
  moneyCustomerIds: new Set(),
});

const customer = (over: Partial<Customer> = {}): Customer =>
  ({
    id: CUST,
    tenant_id: T,
    name: 'Marina Holdings',
    phone: '+12065550100',
    address_line1: '12 Oak St',
    ...over,
  }) as unknown as Customer;

const job = (id: string, status: string, title: string): Job =>
  ({ id, tenant_id: T, customer_id: CUST, status, title }) as unknown as Job;

const SCHEMAS: ForcedToolSpec[] = [
  'spine_read',
  'recall_decisions',
  'read_memory',
  'write_memory',
  'read_job_note',
  'write_job_note',
  'record_caller',
  'get_customer_context',
].map((name) => ({ name, description: name, inputSchema: { type: 'object', properties: {} } }));

const TECH = { kind: 'technician' as const, technicianId: 'tech-1', ref: 'ben-shelton' };

// ── the catalog: the index, never the dictionary ─────────────────────────────

describe('catalogLookup — names and ids, nothing else', () => {
  const deps = {
    searchCustomers: vi.fn(async () => [
      customer(),
      // searchCustomers also matches phone and street; the catalog must not.
      customer({ id: '55555555-5555-4555-8555-555555555555', name: 'Acme Plumbing' }),
    ]),
    getCustomer: vi.fn(async () => customer()),
    listJobsForCustomer: vi.fn(async () => [
      job(JOB_IN, 'in_progress', 'Water heater swap'),
      job(JOB_OUT, 'open', 'Mold remediation, tenant lawsuit'),
      job(JOB_DONE, 'paid', 'Old boiler'),
    ]),
  };

  test('a customer search returns id + name only, and only name matches', async () => {
    const res = await catalogLookup(T, view(), { query: 'marina' }, deps);
    expect(res.customers).toEqual([{ id: CUST, name: 'Marina Holdings' }]);
    const blob = JSON.stringify(res);
    expect(blob).not.toContain('12 Oak St');
    expect(blob).not.toContain('+1206');
  });

  test('a query with a comma still matches the name (the search blanks it too)', async () => {
    const res = await catalogLookup(T, view(), { query: 'Marina, Holdings' }, {
      ...deps,
      searchCustomers: vi.fn(async () => [customer({ name: 'Marina  Holdings' })]),
    });
    expect(res.customers).toHaveLength(1);
  });

  test('an address or phone query finds nothing (no probing through the catalog)', async () => {
    expect((await catalogLookup(T, view(), { query: '12 Oak' }, deps)).customers).toEqual([]);
    expect((await catalogLookup(T, view(), { query: '555' }, deps)).customers).toEqual([]);
  });

  test("a customer's jobs are ids with two marks — never a title", async () => {
    const res = await catalogLookup(T, view([JOB_IN]), { customerId: CUST }, deps);
    expect(res.jobs).toEqual([
      { id: JOB_IN, customerId: CUST, unfinished: true, inTheirView: true },
      { id: JOB_OUT, customerId: CUST, unfinished: true, inTheirView: false },
      { id: JOB_DONE, customerId: CUST, unfinished: false, inTheirView: false },
    ]);
    for (const row of res.jobs ?? []) {
      expect(Object.keys(row).sort()).toEqual(['customerId', 'id', 'inTheirView', 'unfinished']);
    }
    const blob = JSON.stringify(res);
    expect(blob).not.toContain('Water heater');
    expect(blob).not.toContain('Mold');
  });

  test('a malformed or another firm\'s customer id lists nothing', async () => {
    expect((await catalogLookup(T, view(), { customerId: 'not-a-uuid' }, deps)).jobs).toEqual([]);
    const foreign = { ...deps, getCustomer: vi.fn(async () => customer({ tenant_id: 'other' })) };
    expect((await catalogLookup(T, view(), { customerId: CUST }, foreign)).jobs).toEqual([]);
  });
});

// ── the asker's own business ─────────────────────────────────────────────────

describe('askerHistory — only the person asking, and no job titles', () => {
  const msg = (over: Partial<OfficeMessage>): OfficeMessage =>
    ({ id: 'm', created_at: '2026-09-22T10:00:00Z', kind: 'inform', body: '', ...over }) as OfficeMessage;
  const request = (over: Partial<AccessRequest>): AccessRequest =>
    ({
      id: 'r1',
      noticed_at: '2026-09-22T09:00:00Z',
      status: 'dismissed',
      dismiss_reason: 'declined by Sam: not today',
      context: {
        jobId: JOB_OUT,
        customerId: CUST,
        wants: 'record',
        why: 'need the gate code',
        targetName: 'the "Mold remediation, tenant lawsuit" job for Marina Holdings',
        managersTexted: ['Sam'],
      },
      ...over,
    }) as unknown as AccessRequest;

  test('reads by the verified ref and roster id; renders the decline, never targetName', async () => {
    const listMessages = vi.fn(async () => [
      msg({ from_ref: 'ben-shelton', to_ref: TEAM_LEAD_REF, body: 'running late at the marina' }),
    ]);
    const listRequests = vi.fn(async () => [request({})]);
    const listNudges = vi.fn(async () =>
      [
        { technician_id: 'tech-1', kind: 'overdue_visit_gap', status: 'asked', question: 'How did it go?' },
        { technician_id: 'tech-OTHER', kind: 'job_cost_gap', status: 'asked', question: 'SECRET other' },
      ] as unknown as Nudge[],
    );
    const out = await askerHistory(T, TECH, { listMessages, listRequests, listNudges });
    expect(listMessages).toHaveBeenCalledWith(T, 'ben-shelton', expect.any(String));
    expect(listRequests).toHaveBeenCalledWith(T, 'tech-1', expect.any(String));
    expect(out).toContain('running late at the marina');
    expect(out).toContain('How did it go?');
    expect(out).not.toContain('SECRET other');
    expect(out).toContain('declined by Sam: not today');
    expect(out).toContain(JOB_OUT);
    expect(out).not.toContain('Mold');
  });

  test("an old access ask row's code-written body (a job title) is not shown", async () => {
    const out = await askerHistory(T, TECH, {
      listMessages: async () => [
        msg({
          kind: 'ask',
          from_ref: 'ben-shelton',
          body: 'Asked to open the "Mold remediation, tenant lawsuit" job for Marina: "gate code"',
        }),
        msg({ kind: 'ask', from_ref: 'ben-shelton', body: 'am I square with the office?' }),
      ],
      listNudges: async () => [],
      listRequests: async () => [],
    });
    expect(out).not.toContain('Mold');
    expect(out).toContain('(an access request');
    // Their own question is their own words, and stays.
    expect(out).toContain('am I square with the office?');
  });

  test('a roster-less asker has no requests to read', async () => {
    const listRequests = vi.fn(async () => [request({})]);
    await askerHistory(T, { ...TECH, technicianId: null }, {
      listMessages: async () => [],
      listNudges: async () => [],
      listRequests,
    });
    expect(listRequests).not.toHaveBeenCalled();
  });
});

// ── what each audience is handed ─────────────────────────────────────────────

describe('officeToolsFor — the tier gate is the tool list', () => {
  test('a technician-facing office gets notes + the two scoped tools, no record reads', () => {
    const names = officeToolsFor(TECH, SCHEMAS).map((t) => t.name);
    expect(names).toEqual([
      'read_memory',
      'write_memory',
      'read_job_note',
      'write_job_note',
      CATALOG_TOOL.name,
      ASKER_HISTORY_TOOL.name,
    ]);
    expect(names).not.toContain('spine_read');
    expect(names).not.toContain('recall_decisions');
    expect(names).not.toContain('record_caller');
  });

  test('a manager-facing office gets the reads and notes, and not the scoped tools', () => {
    const names = officeToolsFor({ kind: 'manager' }, SCHEMAS).map((t) => t.name);
    expect(names).toEqual([
      'spine_read',
      'recall_decisions',
      'read_memory',
      'write_memory',
      'read_job_note',
      'write_job_note',
    ]);
  });
});

// ── the runner ────────────────────────────────────────────────────────────────

type Exec = (name: string, args: Record<string, unknown>) => Promise<unknown>;

function loopThat(script: (exec: Exec) => Promise<string>, seen: { tools?: ForcedToolSpec[]; req?: unknown } = {}) {
  return (async (req: unknown, tools: ForcedToolSpec[], exec: Exec): Promise<ToolLoopResult> => {
    seen.req = req;
    seen.tools = tools;
    const text = await script(exec);
    return { text, turns: 1, calls: [], stalledWarnings: 0 };
  }) as unknown as NonNullable<OfficeDoorDeps['runLoop']>;
}

const doorInput = (over = {}) => ({
  tenantId: T,
  facing: TECH,
  userMessage: 'QUESTION from ben-shelton: am I square?',
  terminal: ANSWER_TOOL,
  schemas: SCHEMAS,
  dispatch: vi.fn(async () => 'dispatched'),
  lane: 'office',
  ...over,
});

describe('runOfficeDoor', () => {
  test('the terminal tool is handed to the loop and its args come back', async () => {
    const seen: { tools?: ForcedToolSpec[] } = {};
    const res = await runOfficeDoor(doorInput(), {
      memoryIndex: async () => '',
      runLoop: loopThat(async (exec) => {
        await exec('answer', { text: 'nothing open for you' });
        return '';
      }, seen),
    });
    expect(seen.tools?.map((t) => t.name)).toContain('answer');
    expect(res.args).toEqual({ text: 'nothing open for you' });
  });

  test('a text-only ending leaves args null and returns the text', async () => {
    const res = await runOfficeDoor(doorInput(), {
      memoryIndex: async () => '',
      runLoop: loopThat(async () => 'you are square'),
    });
    expect(res).toEqual({ args: null, text: 'you are square' });
  });

  test('the scoped tools run locally; the rest dispatch as the team lead', async () => {
    const input = doorInput();
    const got: unknown[] = [];
    await runOfficeDoor(input, {
      memoryIndex: async () => '',
      technicianView: async () => view(),
      catalog: { searchCustomers: async () => [customer()] },
      history: { listMessages: async () => [], listNudges: async () => [], listRequests: async () => [] },
      runLoop: loopThat(async (exec) => {
        got.push(await exec('catalog_lookup', { query: 'marina' }));
        got.push(await exec('asker_history', {}));
        got.push(await exec('read_memory', { path: 'MEMORY.md' }));
        return '';
      }),
    });
    expect(got[0]).toEqual({ customers: [{ id: CUST, name: 'Marina Holdings' }] });
    expect(String(got[1])).toContain('WHAT THE OFFICE HAS OPEN FOR THIS PERSON');
    expect(input.dispatch).toHaveBeenCalledTimes(1);
    expect(input.dispatch).toHaveBeenCalledWith('read_memory', { path: 'MEMORY.md' }, {
      tenantId: T,
      technicianRef: TEAM_LEAD_REF,
    });
  });

  test('a tool the door was not given is refused before anything runs', async () => {
    const input = doorInput();
    let err: unknown;
    await runOfficeDoor(input, {
      memoryIndex: async () => '',
      runLoop: loopThat(async (exec) => {
        try {
          await exec('spine_read', { sql: 'select 1' });
        } catch (e) {
          err = e;
        }
        return '';
      }),
    });
    expect(String(err)).toContain('not a tool this door was given');
    expect(input.dispatch).not.toHaveBeenCalled();
  });
});

// ── door 1: a seat's question (ported from the desk's tests) ─────────────────

type SeenQ = { req?: { system: string; user: string }; tools?: ForcedToolSpec[] };

function askRow(over: Partial<OfficeMessage> = {}): OfficeMessage {
  return { id: 'ask-1', tenant_id: T, direction: 'to_planner', kind: 'ask', status: 'unread', ...over } as unknown as OfficeMessage;
}

function questionDeps(over: Partial<OfficeWaitingDeps> = {}, seen: SeenQ = {}) {
  const created: unknown[] = [];
  const markRead = vi.fn<(tenantId: string, ids: string[], nowIso: string) => Promise<number>>(async () => 1);
  const deps: OfficeWaitingDeps & { created: unknown[] } = {
    toolSchemas: SCHEMAS,
    dispatch: vi.fn(async () => ({})),
    memoryIndex: async () => '- firm/pacing.md — how patient to be',
    runLoop: (async (
      req: { system: string; user: string },
      tools: ForcedToolSpec[],
      exec: Exec,
    ): Promise<ToolLoopResult> => {
      seen.req = req;
      seen.tools = tools;
      await exec('answer', { text: 'the office has nothing open for you' });
      return { text: '', turns: 1, calls: [], stalledWarnings: 0 };
    }) as unknown as NonNullable<OfficeWaitingDeps['runLoop']>,
    createMessage: (async (input: unknown) => {
      created.push(input);
      return askRow();
    }) as unknown as NonNullable<OfficeWaitingDeps['createMessage']>,
    markRead,
    listNudges: async () => [],
    created,
    ...over,
  };
  return deps;
}

const q = {
  tenantId: T,
  askerRef: 'ben-shelton',
  askerTier: 'technician' as string | null,
  managerDesk: false,
  askerTechnicianId: 'tech-1' as string | null,
  question: 'am I square with the office?',
};

describe('answerAsOffice — who is facing it decides the tools', () => {
  test('a technician gets the technician set, their own open questions inlined, and the reminder', async () => {
    const seen: SeenQ = {};
    const listNudges = vi.fn(async () =>
      [
        { technician_id: 'tech-1', kind: 'overdue_visit_gap', status: 'asked', question: 'How did the marina visit go?' },
        { technician_id: 'tech-OTHER', kind: 'job_cost_gap', status: 'asked', question: 'SECRET other-person question' },
      ] as unknown as Nudge[],
    );
    const res = await answerAsOffice(q, questionDeps({ listNudges }, seen));
    expect(res.answer).toBe('the office has nothing open for you');
    expect(seen.req!.system).toBe(OFFICE_SYSTEM);
    expect(seen.tools!.map((t) => t.name)).toEqual([
      'read_memory',
      'write_memory',
      'read_job_note',
      'write_job_note',
      'catalog_lookup',
      'asker_history',
      'answer',
    ]);
    expect(seen.req!.user).toContain('How did the marina visit go?');
    expect(seen.req!.user).not.toContain('SECRET other-person question');
    expect(seen.req!.user).toContain(OFFICE_NARROW_REMINDER);
    // The reminder sits AFTER the notes, next to the question it governs.
    expect(seen.req!.user.indexOf(OFFICE_NARROW_REMINDER)).toBeGreaterThan(
      seen.req!.user.indexOf("THE OFFICE'S OWN NOTES"),
    );
  });

  test('a roster-less asker, and a manager-TIER badge without the capability, are technician-facing', async () => {
    for (const over of [
      { askerTier: null, askerTechnicianId: null },
      { askerTier: 'manager', managerDesk: false },
    ]) {
      const seen: SeenQ = {};
      await answerAsOffice({ ...q, ...over }, questionDeps({}, seen));
      expect(seen.tools!.map((t) => t.name)).toEqual([
        'read_memory',
        'write_memory',
        'read_job_note',
        'write_job_note',
        'catalog_lookup',
        'asker_history',
        'answer',
      ]);
      expect(seen.req!.user).toContain(OFFICE_NARROW_REMINDER);
    }
  });

  test('an active manager gets the reads and notes, and no reminder', async () => {
    const seen: SeenQ = {};
    await answerAsOffice({ ...q, askerTier: 'manager', managerDesk: true }, questionDeps({}, seen));
    expect(seen.tools!.map((t) => t.name)).toEqual([...MANAGER_FACING_TOOLS, 'answer']);
    expect(seen.req!.user).not.toContain(OFFICE_NARROW_REMINDER);
  });
});

describe('answerAsOffice — transcript and degrade', () => {
  test('writes the ask, then the answer (in_reply_to, born read), then marks the ask read', async () => {
    const deps = questionDeps();
    const res = await answerAsOffice(q, deps);
    expect(res.answer).toBeTruthy();
    expect(deps.created).toHaveLength(2);
    expect(deps.created[0]).toMatchObject({ direction: 'to_planner', kind: 'ask', fromRef: 'ben-shelton', tier: 'technician', body: q.question });
    expect(deps.created[1]).toMatchObject({ kind: 'desk', fromRef: TEAM_LEAD_REF, toRef: 'ben-shelton', inReplyTo: 'ask-1', status: 'read' });
    expect(deps.markRead).toHaveBeenCalledWith(T, ['ask-1'], expect.any(String));
  });

  test('an answer call without text is a failure, never the preamble', async () => {
    const deps = questionDeps({
      runLoop: (async (_r: unknown, _t: unknown, exec: Exec): Promise<ToolLoopResult> => {
        await exec('answer', {});
        return { text: 'let me check…', turns: 1, calls: [], stalledWarnings: 0 };
      }) as unknown as NonNullable<OfficeWaitingDeps['runLoop']>,
    });
    const res = await answerAsOffice(q, deps);
    expect(res.answer).toBeNull();
    expect(res.note).toBe(OFFICE_FALLBACK_NOTE);
  });

  test('renderAskerState is honest about nothing, and the reminder puts USE THE NOTES first', () => {
    expect(renderAskerState([], 'tech-1')).toContain('nothing');
    expect(renderAskerState([], null)).toContain('nothing');
    // The desk's 2026-09-01 lesson: "do not read your notes" reads as "do not
    // consult them", so the permission precedes the narrowing.
    expect(OFFICE_NARROW_REMINDER.indexOf('Read your notes as usual')).toBeGreaterThanOrEqual(0);
    expect(OFFICE_NARROW_REMINDER.indexOf('Read your notes as usual')).toBeLessThan(
      OFFICE_NARROW_REMINDER.indexOf('never a note quoted'),
    );
  });

  test('a plain-text ending is used as the answer', async () => {
    const deps = questionDeps({
      runLoop: (async (): Promise<ToolLoopResult> => ({ text: 'you are square', turns: 1, calls: [], stalledWarnings: 0 })) as unknown as NonNullable<OfficeWaitingDeps['runLoop']>,
    });
    expect((await answerAsOffice(q, deps)).answer).toBe('you are square');
  });

  test('a loop failure keeps the ask UNREAD and returns the honest degrade', async () => {
    const deps = questionDeps({
      runLoop: (async () => {
        throw new Error('provider down');
      }) as unknown as NonNullable<OfficeWaitingDeps['runLoop']>,
    });
    const res = await answerAsOffice(q, deps);
    expect(res).toMatchObject({ answer: null, note: OFFICE_FALLBACK_NOTE });
    expect(deps.created).toHaveLength(1);
    expect(deps.markRead).not.toHaveBeenCalled();
  });

  test('an empty answer is a failure, not an answer', async () => {
    const deps = questionDeps({
      runLoop: (async (): Promise<ToolLoopResult> => ({ text: '   ', turns: 1, calls: [], stalledWarnings: 0 })) as unknown as NonNullable<OfficeWaitingDeps['runLoop']>,
    });
    expect((await answerAsOffice(q, deps)).answer).toBeNull();
    expect(deps.markRead).not.toHaveBeenCalled();
  });

  test('an over-long answer is cut to the transcript cap', async () => {
    const deps = questionDeps({
      runLoop: (async (_r: unknown, _t: unknown, exec: Exec): Promise<ToolLoopResult> => {
        await exec('answer', { text: 'x'.repeat(OFFICE_MESSAGE_BODY_MAX + 100) });
        return { text: '', turns: 1, calls: [], stalledWarnings: 0 };
      }) as unknown as NonNullable<OfficeWaitingDeps['runLoop']>,
    });
    expect((await answerAsOffice(q, deps)).answer).toHaveLength(OFFICE_MESSAGE_BODY_MAX);
  });

  test('the notes ride every question; a failed read answers without them', async () => {
    const seen: SeenQ = {};
    await answerAsOffice(q, questionDeps({}, seen));
    expect(seen.req!.user).toContain('- firm/pacing.md — how patient to be');
    await answerAsOffice(
      q,
      questionDeps(
        {
          memoryIndex: async () => {
            throw new Error('db hiccup');
          },
        },
        seen,
      ),
    );
    expect(seen.req!.user).not.toContain("THE OFFICE'S OWN NOTES");
  });
});

// ── key-gated live smoke (the desk's, carried over): a REAL office answer over
// the local stack, transcript verified by independent pg read-back ──────────

describe.skipIf(!hasModelCredentials())('the office question door (live model, local stack)', () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  let tenantId: string;
  let techId: string;
  const RUN = `office-live-${Date.now()}`;
  const nudgeIds: string[] = [];

  beforeAll(async () => {
    await pg.connect();
    const { data, error } = await getClient().from('tenants').select('id').eq('name', 'Default Tenant').single();
    if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
    tenantId = data.id;
    techId = (await insertTechnician({ tenantId, ref: `${RUN}-tech`, displayName: 'Office Live Tech', seatExempt: true })).id;
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: `${RUN}-subject`,
      technicianId: techId,
      context: { jobTitle: 'Marina boiler check', customerName: 'Harborside' },
    });
    if (n) nudgeIds.push(n.id);
  });

  afterAll(async () => {
    await pg.query('delete from office_messages where tenant_id = $1 and (from_ref = $2 or to_ref = $2)', [tenantId, `${RUN}-tech`]);
    if (nudgeIds.length > 0) await pg.query('delete from nudges where id = any($1::uuid[])', [nudgeIds]);
    await pg.query('delete from technicians where id = $1', [techId]);
    await pg.end();
  });

  test('answers a technician "am I square" and writes the transcript pair', async () => {
    const res = await answerAsOffice({
      tenantId,
      askerRef: `${RUN}-tech`,
      askerTier: 'technician',
      managerDesk: false,
      askerTechnicianId: techId,
      question: 'Is the office waiting on anything from me right now?',
    }, {
      // The real team-lead surface and door, as the MCP server hands them in.
      toolSchemas: TEAM_LEAD_TOOL_SCHEMAS as readonly ForcedToolSpec[],
      dispatch: (n, a, id) => dispatchForIdentity(n, a, id),
    });
    console.log('[office live] answer:', res.answer ?? `(degraded: ${res.note})`);
    const { rows } = await pg.query(
      'select kind, status, in_reply_to from office_messages where tenant_id = $1 and (from_ref = $2 or to_ref = $2) order by created_at',
      [tenantId, `${RUN}-tech`],
    );
    if (res.answer) {
      expect(rows.map((r) => r.kind)).toEqual(['ask', 'desk']);
      expect(rows[0].status).toBe('read'); // answered — left the unread queue
      expect(rows[1].status).toBe('read'); // transcript, born read
      expect(rows[1].in_reply_to).not.toBeNull();
    } else {
      expect(rows.map((r) => r.kind)).toEqual(['ask']);
      expect(rows[0].status).toBe('unread');
    }
  }, 300_000);
});
