import { describe, expect, test, vi } from 'vitest';
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
  askerHistory,
  ASKER_HISTORY_TOOL,
  CATALOG_TOOL,
  catalogLookup,
  officeToolsFor,
  runOfficeDoor,
  type OfficeDoorDeps,
} from './office.js';
import { ANSWER_TOOL } from './officePrompt.js';
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
