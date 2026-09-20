import { describe, expect, test } from 'vitest';
import type { Customer, Job, Observation, OfficeMessage, PersonPush, Technician } from '../db/index.js';
import {
  answerAccessRequest,
  type AccessDeskDeps,
  type AccessRequestInput,
} from './accessDesk.js';

// ── hermetic: every collaborator stubbed, no database and no model ──────────
//
// The desk's ONE write is a grant, and the whole point of the design is that
// code fixes every field of it. So these tests assert on what was WRITTEN, not
// on what the model said — a test that trusted the decision would pass while
// the grant opened the wrong thing.

const TENANT = 't1';
const TECH_ID = '11111111-1111-4111-8111-111111111111';
const JOB_ID = '22222222-2222-4222-8222-222222222222';
const CUST_ID = '33333333-3333-4333-8333-333333333333';

const job = (over: Partial<Job> = {}): Job =>
  ({
    id: JOB_ID,
    tenant_id: TENANT,
    customer_id: CUST_ID,
    title: 'boiler swap',
    status: 'open',
    ...over,
  }) as unknown as Job;

const customer = (over: Partial<Customer> = {}): Customer =>
  ({ id: CUST_ID, tenant_id: TENANT, name: 'Alice Byrne', ...over }) as unknown as Customer;

const manager = (over: Partial<Technician> = {}): Technician =>
  ({
    id: 'mgr-uuid-1',
    tenant_id: TENANT,
    ref: 'dana-reed',
    display_name: 'Dana Reed',
    tier: 'manager',
    state: 'active',
    sandbox_ref: 'sbx-1',
    telegram_user_id: '900',
    ...over,
  }) as unknown as Technician;

const emptyView = () => ({
  allScope: false,
  jobIds: new Set<string>(),
  customerIds: new Set<string>(),
  moneyAll: false,
  moneyJobIds: new Set<string>(),
  moneyCustomerIds: new Set<string>(),
});

interface Recorded {
  grants: never[];
  pushes: Parameters<NonNullable<AccessDeskDeps['queuePush']>>[0][];
  requests: Parameters<NonNullable<AccessDeskDeps['openRequest']>>[0][];
  messages: Record<string, unknown>[];
}

function stub(over: Partial<AccessDeskDeps> = {}) {
  const rec: Recorded = { grants: [], pushes: [], requests: [], messages: [] };
  const deps: AccessDeskDeps = {
    now: () => new Date('2026-09-19T17:00:00Z'),
    memoryIndex: async () => '- firm/pacing.md',
    getJob: async () => job(),
    getCustomer: async () => customer(),
    listOpenJobs: async () => [job()],
    technicianView: async () => emptyView(),
    findRequest: async () => null,
    firmTenant: async () => ({ id: TENANT, timezone: 'America/Los_Angeles' }) as never,
    listManagers: async () => [manager()],
    queuePush: (async (p: Parameters<NonNullable<AccessDeskDeps['queuePush']>>[0]) => {
      rec.pushes.push(p);
      return { id: 'push-1' } as unknown as PersonPush;
    }) as NonNullable<AccessDeskDeps['queuePush']>,
    openRequest: (async (r: Parameters<NonNullable<AccessDeskDeps['openRequest']>>[0]) => {
      rec.requests.push(r);
      return { id: 'obs-1', noticed_at: '2026-09-19T17:00:00Z' } as unknown as Observation;
    }) as NonNullable<AccessDeskDeps['openRequest']>,
    createMessage: (async (m: Record<string, unknown>) => {
      rec.messages.push(m);
      return { id: `msg-${rec.messages.length}` } as unknown as OfficeMessage;
    }) as unknown as NonNullable<AccessDeskDeps['createMessage']>,
    markRead: async () => 1,
    ...over,
  };
  return { deps, rec };
}

const ask = (over: Partial<AccessRequestInput> = {}): AccessRequestInput => ({
  tenantId: TENANT,
  askerRef: 'sam-teixeira',
  askerName: 'Sam Teixeira',
  askerTier: 'technician',
  askerTechnicianId: TECH_ID,
  activeManager: false,
  why: 'I am at the gate and need the code',
  jobId: JOB_ID,
  wants: 'record',
  ...over,
});

// THE DESK CANNOT OPEN ANYTHING (operator ruling, 2026-09-20). It briefly
// could, for one narrow shape — one job, the record, a day — decided by a
// bounded model call. That was withdrawn: the firm promises its customers that
// a technician sees their own work unless the firm widens it deliberately, and
// an office opening a record on its own judgment makes that untrue however
// narrow the opening. These tests pin the absence.
describe('the access desk — it can no longer open anything itself', () => {
  test('the narrow shape that USED to be opened now goes to a manager', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask(), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.grants).toHaveLength(0);
    expect(rec.requests).toHaveLength(1);
    expect(rec.pushes).toHaveLength(1);
  });

  test('a customer ask with one unfinished job also goes to a manager', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask({ jobId: undefined, customerId: CUST_ID }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.grants).toHaveLength(0);
    // …but it is still NARROWED to the one job, so the manager is asked to open
    // the least that answers the question.
    expect(rec.requests[0].context.jobId).toBe(JOB_ID);
  });

  test('NO REQUEST OF ANY SHAPE writes a grant', async () => {
    for (const w of ['record', 'notes', 'money'] as const) {
      const { deps, rec } = stub();
      const out = await answerAccessRequest(ask({ wants: w }), deps);
      expect(out.status).toBe('asked_manager');
      expect(rec.grants).toHaveLength(0);
    }
  });

  test('the answer never claims anything was opened', async () => {
    const { deps } = stub();
    const out = await answerAccessRequest(ask(), deps);
    expect(out.answer).not.toMatch(/Opened for you/i);
    expect(out.answer).toContain('Asked your manager');
  });

  test('the desk pair records the ask and the outcome for the planner', async () => {
    const { deps, rec } = stub();
    await answerAccessRequest(ask(), deps);
    expect(rec.messages).toHaveLength(2);
    expect(rec.messages[0]).toMatchObject({ kind: 'ask' });
    expect(rec.messages[1]).toMatchObject({ kind: 'desk', status: 'read' });
  });
});

describe('the access desk — what always goes to a manager', () => {
  test('a money ask is texted to every reachable manager', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);

    expect(out.status).toBe('asked_manager');
    expect(rec.grants).toHaveLength(0);
    expect(rec.requests).toHaveLength(1);
    expect(rec.requests[0].context.wants).toBe('money');
    expect(rec.requests[0].context.requestKey).toBe(`${TECH_ID}:${JOB_ID}:money`);
    expect(rec.pushes).toHaveLength(1);
    expect(rec.pushes[0].kind).toBe('access');
    expect(rec.pushes[0].body).toContain('Sam Teixeira');
    expect(rec.pushes[0].body).toContain('I am at the gate and need the code');
    // No ids in a manager's text either — the seat finds it with list_access.
    expect(rec.pushes[0].body).not.toContain(JOB_ID);
    expect(out.answer).toContain('Dana Reed');
    // WHAT IS PROMISED IS WHAT IS GUARANTEED (operator, 2026-09-19): nothing
    // runs on a timer, so the desk must not promise a message that may never
    // come. A manager's answer texts her; silence does not.
    expect(out.answer).not.toContain("You'll get a message here when they answer");
    expect(out.answer).toContain('ask me about this job again');
  });

  test('a notes ask goes the same way', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask({ wants: 'notes' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests[0].context.wants).toBe('notes');
  });

  // THE MANAGER MUST BE ASKED FOR THE LEAST THAT ANSWERS HER, and only the
  // office can arrange that. A customer outside her view lists NO job ids
  // (find_customer gives id+name, get_customer_context gives `jobs: []`), so a
  // seat asking about one job of a customer it cannot see has nothing to name.
  // Measured twice on the pilot: she asked about one job, the manager was asked
  // to open every job that customer ever had, and granted it.
  test('a MONEY ask on a customer with one unfinished job is narrowed to that job', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask({ jobId: undefined, customerId: CUST_ID, wants: 'money' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests[0].context.jobId).toBe(JOB_ID);
    expect(rec.requests[0].context.targetName).toContain('boiler swap');
    expect(rec.requests[0].context.targetName).not.toContain('every job');
  });

  test('a NOTES ask is narrowed the same way', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask({ jobId: undefined, customerId: CUST_ID, wants: 'notes' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests[0].context.jobId).toBe(JOB_ID);
  });

  test('…but NOT when the narrowed job would already answer her', async () => {
    // She can open the job and be told its figures already, so narrowing would
    // dead-end an ask that is legitimately about the jobs she CANNOT see.
    const { deps, rec } = stub({
      technicianView: async () => ({
        ...emptyView(), jobIds: new Set([JOB_ID]), moneyJobIds: new Set([JOB_ID]),
      }),
    });
    await answerAccessRequest(ask({ jobId: undefined, customerId: CUST_ID, wants: 'money' }), deps);
    expect(rec.requests[0].context.jobId).toBeUndefined();
  });

  test('a customer with two unfinished jobs stays customer-wide and is not narrowed', async () => {
    const { deps, rec } = stub({
      listOpenJobs: async () => [job(), job({ id: '44444444-4444-4444-8444-444444444444', title: 'tap' })],
    });
    const out = await answerAccessRequest(ask({ jobId: undefined, customerId: CUST_ID }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests[0].context.jobId).toBeUndefined();
    expect(rec.requests[0].context.requestKey).toBe(`${TECH_ID}:c:${CUST_ID}:record`);
  });




  test('a manager with no sandbox is not named and not texted — the push leg would skip them', async () => {
    const { deps, rec } = stub({
      listManagers: async () => [manager({ sandbox_ref: null }), manager({ id: 'm2', ref: 'kim', display_name: 'Kim Ng' })],
    });
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);
    expect(rec.pushes).toHaveLength(1);
    expect(rec.pushes[0].technicianId).toBe('m2');
    expect(out.answer).toContain('Kim Ng');
    expect(out.answer).not.toContain('Dana Reed');
    expect(rec.requests[0].context.managersTexted).toEqual(['Kim Ng']);
  });

  test('nobody reachable: the request is still filed, and the answer says so honestly', async () => {
    const { deps, rec } = stub({ listManagers: async () => [] });
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests).toHaveLength(1);
    expect(rec.pushes).toHaveLength(0);
    expect(out.answer).toContain('No manager could be texted');
    // Honest about what did NOT happen: nobody was alerted, so she should not
    // sit waiting on a message.
    expect(out.answer).toContain('nobody has been alerted');
  });

  test('one manager\'s failed text does not lose the other, nor the request', async () => {
    let n = 0;
    const { deps, rec } = stub({
      listManagers: async () => [manager(), manager({ id: 'm2', ref: 'kim', display_name: 'Kim Ng' })],
      queuePush: (async (p: Parameters<NonNullable<AccessDeskDeps['queuePush']>>[0]) => {
        if (++n === 1) throw new Error('queue write failed');
        rec.pushes.push(p);
        return { id: 'push-2' } as unknown as PersonPush;
      }) as NonNullable<AccessDeskDeps['queuePush']>,
    });
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.pushes).toHaveLength(1);
    expect(rec.requests).toHaveLength(1);
  });
});

describe('the access desk — what it answers without filing anything', () => {
  test('a job already in her view is not asked for again', async () => {
    const { deps, rec } = stub({
      technicianView: async () => ({ ...emptyView(), jobIds: new Set([JOB_ID]) }),
    });
    const out = await answerAccessRequest(ask(), deps);
    expect(out.status).toBe('already_open');
    expect(out.answer).toContain('already open to you');
    expect(rec.grants).toHaveLength(0);
    expect(rec.requests).toHaveLength(0);
    expect(rec.pushes).toHaveLength(0);
  });

  test('money the firm already opens, on a job she can open, is not asked for again', async () => {
    const { deps, rec } = stub({
      technicianView: async () => ({ ...emptyView(), moneyAll: true, jobIds: new Set([JOB_ID]) }),
    });
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);
    expect(out.status).toBe('already_open');
    expect(rec.requests).toHaveLength(0);
    expect(rec.pushes).toHaveLength(0);
  });

  // The firm's rule can open the FIGURES while the job stays outside her view.
  // "Ask again and they will be in the answer" would then be false: the page
  // the figures sit on does not open. She needs the record, and that is a
  // manager's call.
  test('firm-wide money on a job she cannot open is NOT called already open', async () => {
    const { deps, rec } = stub({
      technicianView: async () => ({ ...emptyView(), moneyAll: true }),
    });
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests).toHaveLength(1);
    expect(rec.pushes).toHaveLength(1);
  });

  test('a NOTES ask is never short-circuited by the view — it is a different question', async () => {
    const { deps, rec } = stub({
      technicianView: async () => ({ ...emptyView(), jobIds: new Set([JOB_ID]) }),
    });
    const out = await answerAccessRequest(ask({ wants: 'notes' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests).toHaveLength(1);
  });

  test('the same ask twice says when it went and does not text again', async () => {
    const { deps, rec } = stub({
      // Three hours ago: still live.
      findRequest: async () =>
        ({ id: 'obs-1', noticed_at: '2026-09-19T14:00:00Z' }) as unknown as Observation,
    });
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);
    expect(out.status).toBe('already_asked');
    expect(rec.requests).toHaveLength(0);
    expect(rec.pushes).toHaveLength(0);
  });

  // A DAY OLD IS GONE (operator, 2026-09-19): the office does not follow up, so
  // an unanswered request lapses — and the lapse has to MOVE the row, because
  // the unique index keys on status and would otherwise refuse her forever.
  test('a day-old request lapses and the ask goes again, rather than being refused', async () => {
    const lapsed: string[] = [];
    const { deps, rec } = stub({
      findRequest: async () =>
        ({ id: 'obs-old', noticed_at: '2026-09-18T16:00:00Z' }) as unknown as Observation,
      lapseRequest: (async (_t: string, id: string) => {
        lapsed.push(id);
        return null;
      }) as never,
    });
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);
    expect(lapsed).toEqual(['obs-old']);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests).toHaveLength(1); // a FRESH one
    expect(rec.pushes).toHaveLength(1); // …and the managers hear about it again
  });

  test('a failed lapse costs nothing: she is told it is still waiting', async () => {
    const { deps, rec } = stub({
      findRequest: async () =>
        ({ id: 'obs-old', noticed_at: '2026-09-18T16:00:00Z' }) as unknown as Observation,
      lapseRequest: (async () => {
        throw new Error('close failed');
      }) as never,
      openRequest: async () => null, // the index still holds the old row
    });
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);
    expect(out.status).toBe('already_asked');
    expect(rec.pushes).toHaveLength(0);
  });

  test('a request filed between the check and the write converges instead of texting twice', async () => {
    const { deps, rec } = stub({ openRequest: async () => null });
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);
    expect(out.status).toBe('already_asked');
    expect(rec.pushes).toHaveLength(0);
  });
});

describe('the access desk — who may ask, and for what', () => {
  test('a manager is refused: they already see everything', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask({ activeManager: true }), deps);
    expect(out.status).toBe('refused');
    expect(rec.grants).toHaveLength(0);
    expect(rec.requests).toHaveLength(0);
  });

  test('a badge with no roster row is refused in words', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask({ askerTechnicianId: null }), deps);
    expect(out.status).toBe('refused');
    expect(out.answer).toContain('team list');
    expect(rec.requests).toHaveLength(0);
  });

  test('another firm\'s job answers exactly like an unknown one — no database error', async () => {
    const { deps, rec } = stub({ getJob: async () => job({ tenant_id: 'other-firm' }) });
    const out = await answerAccessRequest(ask(), deps);
    expect(out.status).toBe('refused');
    expect(out.answer).toContain('cannot find that job');
    expect(rec.grants).toHaveLength(0);
    expect(rec.requests).toHaveLength(0);
  });

  test('a malformed job id is refused in words, with no database read', async () => {
    let read = 0;
    const { deps, rec } = stub({
      getJob: async () => {
        read++;
        return job();
      },
    });
    const out = await answerAccessRequest(ask({ jobId: 'not-a-uuid' }), deps);
    expect(out.status).toBe('refused');
    expect(out.answer).toContain('cannot find that job');
    // The point of the guard: a uuid-typed column never sees it, so the seat is
    // never handed `invalid input syntax for type uuid`.
    expect(out.answer).not.toContain('uuid');
    expect(read).toBe(0);
    expect(rec.requests).toHaveLength(0);
  });

  test('a malformed customer id is refused in words, with no database read', async () => {
    let read = 0;
    const { deps } = stub({
      getCustomer: async () => {
        read++;
        return customer();
      },
    });
    const out = await answerAccessRequest(ask({ jobId: undefined, customerId: 'nope' }), deps);
    expect(out.status).toBe('refused');
    expect(out.answer).toContain('cannot find that customer');
    expect(read).toBe(0);
  });

  test('naming neither a job nor a customer is refused', async () => {
    const { deps } = stub();
    const out = await answerAccessRequest(ask({ jobId: undefined }), deps);
    expect(out.status).toBe('refused');
  });

  test('naming both is refused', async () => {
    const { deps } = stub();
    const out = await answerAccessRequest(ask({ customerId: CUST_ID }), deps);
    expect(out.status).toBe('refused');
  });
});
