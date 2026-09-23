import { describe, expect, test } from 'vitest';
import type { Customer, Job, Observation, OfficeMessage, PersonPush, Technician } from '../db/index.js';
import type { ToolLoopResult } from '../model/toolLoop.js';
import {
  routeAccessAsOffice,
  type AccessDoorDeps as AccessDeskDeps,
  type AccessRequestInput,
} from './office.js';

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
    // THE FALLBACK IS WHAT THESE TESTS PIN (plan 2026-09-22): with no model the
    // office's access door runs today's code path, unchanged — so every test
    // below the office's own block is the old access desk's, verbatim.
    runLoop: (async () => {
      throw new Error('no model');
    }) as unknown as NonNullable<AccessDeskDeps['runLoop']>,
    listJobs: async () => [job()],
    history: { listMessages: async () => [], listNudges: async () => [], listRequests: async () => [] },
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
    const out = await routeAccessAsOffice(ask(), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.grants).toHaveLength(0);
    expect(rec.requests).toHaveLength(1);
    expect(rec.pushes).toHaveLength(1);
  });

  test('a customer ask with one unfinished job also goes to a manager', async () => {
    const { deps, rec } = stub();
    const out = await routeAccessAsOffice(ask({ jobId: undefined, customerId: CUST_ID }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.grants).toHaveLength(0);
    // …but it is still NARROWED to the one job, so the manager is asked to open
    // the least that answers the question.
    expect(rec.requests[0].context.jobId).toBe(JOB_ID);
  });

  test('NO REQUEST OF ANY SHAPE writes a grant', async () => {
    for (const w of ['record', 'notes', 'money'] as const) {
      const { deps, rec } = stub();
      const out = await routeAccessAsOffice(ask({ wants: w }), deps);
      expect(out.status).toBe('asked_manager');
      expect(rec.grants).toHaveLength(0);
    }
  });

  test('the answer never claims anything was opened', async () => {
    const { deps } = stub();
    const out = await routeAccessAsOffice(ask(), deps);
    expect(out.answer).not.toMatch(/Opened for you/i);
    expect(out.answer).toContain('Asked your manager');
  });

  test('the desk pair records the ask and the outcome for the planner', async () => {
    const { deps, rec } = stub();
    await routeAccessAsOffice(ask(), deps);
    expect(rec.messages).toHaveLength(2);
    expect(rec.messages[0]).toMatchObject({ kind: 'ask' });
    expect(rec.messages[1]).toMatchObject({ kind: 'desk', status: 'read' });
    // TITLE-FREE: asker_history shows these rows to her, and she may not be able
    // to see the job it names (review, plan phase 1).
    expect(String(rec.messages[0].body)).toMatch(/^Asked to open /);
    expect(String(rec.messages[0].body)).not.toContain('boiler swap');
  });
});

describe('the access desk — what always goes to a manager', () => {
  test('a money ask is texted to every reachable manager', async () => {
    const { deps, rec } = stub();
    const out = await routeAccessAsOffice(ask({ wants: 'money' }), deps);

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
    const out = await routeAccessAsOffice(ask({ wants: 'notes' }), deps);
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
    const out = await routeAccessAsOffice(ask({ jobId: undefined, customerId: CUST_ID, wants: 'money' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests[0].context.jobId).toBe(JOB_ID);
    expect(rec.requests[0].context.targetName).toContain('boiler swap');
    expect(rec.requests[0].context.targetName).not.toContain('every job');
  });

  test('a NOTES ask is narrowed the same way', async () => {
    const { deps, rec } = stub();
    const out = await routeAccessAsOffice(ask({ jobId: undefined, customerId: CUST_ID, wants: 'notes' }), deps);
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
    await routeAccessAsOffice(ask({ jobId: undefined, customerId: CUST_ID, wants: 'money' }), deps);
    expect(rec.requests[0].context.jobId).toBeUndefined();
  });

  test('a customer with two unfinished jobs stays customer-wide and is not narrowed', async () => {
    const { deps, rec } = stub({
      listOpenJobs: async () => [job(), job({ id: '44444444-4444-4444-8444-444444444444', title: 'tap' })],
    });
    const out = await routeAccessAsOffice(ask({ jobId: undefined, customerId: CUST_ID }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests[0].context.jobId).toBeUndefined();
    expect(rec.requests[0].context.requestKey).toBe(`${TECH_ID}:c:${CUST_ID}:record`);
  });




  test('a manager with no sandbox is not named and not texted — the push leg would skip them', async () => {
    const { deps, rec } = stub({
      listManagers: async () => [manager({ sandbox_ref: null }), manager({ id: 'm2', ref: 'kim', display_name: 'Kim Ng' })],
    });
    const out = await routeAccessAsOffice(ask({ wants: 'money' }), deps);
    expect(rec.pushes).toHaveLength(1);
    expect(rec.pushes[0].technicianId).toBe('m2');
    expect(out.answer).toContain('Kim Ng');
    expect(out.answer).not.toContain('Dana Reed');
    expect(rec.requests[0].context.managersTexted).toEqual(['Kim Ng']);
  });

  test('nobody reachable: the request is still filed, and the answer says so honestly', async () => {
    const { deps, rec } = stub({ listManagers: async () => [] });
    const out = await routeAccessAsOffice(ask({ wants: 'money' }), deps);
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
    const out = await routeAccessAsOffice(ask({ wants: 'money' }), deps);
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
    const out = await routeAccessAsOffice(ask(), deps);
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
    const out = await routeAccessAsOffice(ask({ wants: 'money' }), deps);
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
    const out = await routeAccessAsOffice(ask({ wants: 'money' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests).toHaveLength(1);
    expect(rec.pushes).toHaveLength(1);
  });

  test('a NOTES ask is never short-circuited by the view — it is a different question', async () => {
    const { deps, rec } = stub({
      technicianView: async () => ({ ...emptyView(), jobIds: new Set([JOB_ID]) }),
    });
    const out = await routeAccessAsOffice(ask({ wants: 'notes' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests).toHaveLength(1);
  });

  test('the same ask twice says when it went and does not text again', async () => {
    const { deps, rec } = stub({
      // Three hours ago: still live.
      findRequest: async () =>
        ({ id: 'obs-1', noticed_at: '2026-09-19T14:00:00Z' }) as unknown as Observation,
    });
    const out = await routeAccessAsOffice(ask({ wants: 'money' }), deps);
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
    const out = await routeAccessAsOffice(ask({ wants: 'money' }), deps);
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
    const out = await routeAccessAsOffice(ask({ wants: 'money' }), deps);
    expect(out.status).toBe('already_asked');
    expect(rec.pushes).toHaveLength(0);
  });

  test('a request filed between the check and the write converges instead of texting twice', async () => {
    const { deps, rec } = stub({ openRequest: async () => null });
    const out = await routeAccessAsOffice(ask({ wants: 'money' }), deps);
    expect(out.status).toBe('already_asked');
    expect(rec.pushes).toHaveLength(0);
  });
});

describe('the access desk — who may ask, and for what', () => {
  test('a manager is refused: they already see everything', async () => {
    const { deps, rec } = stub();
    const out = await routeAccessAsOffice(ask({ activeManager: true }), deps);
    expect(out.status).toBe('refused');
    expect(rec.grants).toHaveLength(0);
    expect(rec.requests).toHaveLength(0);
  });

  test('a badge with no roster row is refused in words', async () => {
    const { deps, rec } = stub();
    const out = await routeAccessAsOffice(ask({ askerTechnicianId: null }), deps);
    expect(out.status).toBe('refused');
    expect(out.answer).toContain('team list');
    expect(rec.requests).toHaveLength(0);
  });

  test('another firm\'s job answers exactly like an unknown one — no database error', async () => {
    const { deps, rec } = stub({ getJob: async () => job({ tenant_id: 'other-firm' }) });
    const out = await routeAccessAsOffice(ask(), deps);
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
    const out = await routeAccessAsOffice(ask({ jobId: 'not-a-uuid' }), deps);
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
    const out = await routeAccessAsOffice(ask({ jobId: undefined, customerId: 'nope' }), deps);
    expect(out.status).toBe('refused');
    expect(out.answer).toContain('cannot find that customer');
    expect(read).toBe(0);
  });

  test('naming neither a job nor a customer is refused', async () => {
    const { deps } = stub();
    const out = await routeAccessAsOffice(ask({ jobId: undefined }), deps);
    expect(out.status).toBe('refused');
  });

  test('naming both is refused', async () => {
    const { deps } = stub();
    const out = await routeAccessAsOffice(ask({ customerId: CUST_ID }), deps);
    expect(out.status).toBe('refused');
  });
});

// ── the office's own judgment (plan 2026-09-22) ───────────────────────────────
//
// A scripted model calls route_access; these assert on what CODE did with it —
// who was texted, what was filed, what the words were — never on the model.

type Exec = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const decides = (args: Record<string, unknown>, seen: { user?: string } = {}) =>
  (async (req: { user: string }, _tools: unknown, exec: Exec): Promise<ToolLoopResult> => {
    seen.user = req.user;
    await exec('route_access', args);
    return { text: '', turns: 1, calls: [], stalledWarnings: 0 };
  }) as unknown as NonNullable<AccessDeskDeps['runLoop']>;

const sam = manager({ id: 'mgr-sam', ref: 'sam-lee', display_name: 'Sam Lee' });
const dana = manager();
const twoManagers = { listManagers: async () => [dana, sam] };
const askSam = {
  outcome: 'ask',
  managers: ['Sam Lee'],
  managerMessage: 'She is on site now.',
  replyToAsker: 'I have asked Sam for you.',
  reason: 'Sam looks after her.',
};

describe('the office decides — code applies', () => {
  test('the named manager is texted, and only them; the reply is the office\'s words', async () => {
    const { deps, rec } = stub({ ...twoManagers, runLoop: decides(askSam) });
    const out = await routeAccessAsOffice(ask(), deps);
    expect(out).toEqual({ status: 'asked_manager', answer: 'I have asked Sam for you.' });
    expect(rec.pushes.map((p) => p.technicianId)).toEqual(['mgr-sam']);
    expect(rec.requests[0].context.managersTexted).toEqual(['Sam Lee']);
    // Code's headline (with the title the office never saw), then the office's
    // words, then the width menu.
    const body = rec.pushes[0].body;
    expect(body).toContain('Sam Teixeira asks to open the "boiler swap" job for Alice Byrne');
    expect(body).toContain('She is on site now.');
    expect(body.indexOf('She is on site now.')).toBeLessThan(body.indexOf('Reply to answer'));
  });

  test('no valid name → every reachable manager (a lost request costs more than a text)', async () => {
    const { deps, rec } = stub({ ...twoManagers, runLoop: decides({ ...askSam, managers: ['Nobody'] }) });
    await routeAccessAsOffice(ask(), deps);
    expect(rec.pushes.map((p) => p.technicianId).sort()).toEqual(['mgr-sam', 'mgr-uuid-1']);
  });

  test("the office's jobId narrows a customer ask — only if it is that customer's job, on this firm", async () => {
    const OTHER = '44444444-4444-4444-8444-444444444444';
    for (const [jobId, getJobRow, expected] of [
      [JOB_ID, job(), JOB_ID],
      [OTHER, job({ id: OTHER, customer_id: 'someone-else' }), undefined],
      [OTHER, job({ id: OTHER, tenant_id: 'other-firm' }), undefined],
      ['not-a-uuid', job(), undefined],
    ] as const) {
      const { deps, rec } = stub({
        getJob: async () => getJobRow,
        runLoop: decides({ ...askSam, managers: [], jobId }),
      });
      await routeAccessAsOffice(ask({ jobId: undefined, customerId: CUST_ID }), deps);
      expect(rec.requests[0].context.jobId).toBe(expected);
    }
  });

  test('the office is shown the catalog as ids and marks — never a job title', async () => {
    const seen: { user?: string } = {};
    const { deps } = stub({ runLoop: decides(askSam, seen) });
    await routeAccessAsOffice(ask({ jobId: undefined, customerId: CUST_ID }), deps);
    expect(seen.user).toContain(JOB_ID);
    expect(seen.user).toContain('NOT in their view');
    expect(seen.user).not.toContain('boiler swap');
    expect(seen.user).toContain('Dana Reed');
  });

  test("a manager's earlier NO is in front of the office (Ben asks, Sam declines, Ben asks again)", async () => {
    const seen: { user?: string } = {};
    const { deps } = stub({
      runLoop: decides(askSam, seen),
      history: {
        listMessages: async () => [],
        listNudges: async () => [],
        listRequests: async () =>
          [
            {
              id: 'r0',
              noticed_at: '2026-09-19T16:00:00Z',
              status: 'dismissed',
              dismiss_reason: 'declined by Sam Lee: wrong button',
              context: { jobId: JOB_ID, customerId: CUST_ID, wants: 'record', managersTexted: ['Sam Lee'] },
            },
          ] as unknown as Observation[],
      },
    });
    await routeAccessAsOffice(ask(), deps);
    expect(seen.user).toContain('declined by Sam Lee: wrong button');
  });

  test('a request still waiting: no second row, and only a manager not yet asked is texted', async () => {
    const waiting = {
      id: 'obs-1',
      noticed_at: '2026-09-19T14:00:00Z',
      context: {
        managersTexted: ['Dana Reed'],
        targetName: "Alice Byrne's record — every job of theirs",
        wants: 'record',
        why: 'first time I asked',
      },
    } as unknown as Observation;
    const added: string[][] = [];
    const addManagers = (async (_t: string, _r: Observation, names: string[]) => {
      added.push(names);
      return waiting;
    }) as unknown as NonNullable<AccessDeskDeps['addManagers']>;
    // Asking Dana again sends nothing.
    let s = stub({ ...twoManagers, findRequest: async () => waiting, addManagers, runLoop: decides({ ...askSam, managers: ['Dana Reed'] }) });
    let out = await routeAccessAsOffice(ask(), s.deps);
    expect(out.status).toBe('already_asked');
    expect(s.rec.requests).toHaveLength(0);
    expect(s.rec.pushes).toHaveLength(0);
    // Going to Sam texts Sam only, and records that he was asked.
    s = stub({ ...twoManagers, findRequest: async () => waiting, addManagers, runLoop: decides(askSam) });
    out = await routeAccessAsOffice(ask(), s.deps);
    expect(out.status).toBe('asked_manager');
    expect(s.rec.requests).toHaveLength(0);
    expect(s.rec.pushes.map((p) => p.technicianId)).toEqual(['mgr-sam']);
    expect(added).toEqual([['Sam Lee']]);
    // The text describes what the WAITING row would grant, not this repeat's
    // target (review, phase 3): a yes opens what the row says.
    expect(s.rec.pushes[0].body).toContain("Alice Byrne's record — every job of theirs");
    expect(s.rec.pushes[0].body).not.toContain('boiler swap');
  });

  test('two repeats racing on one waiting row: the loser of the claim texts nobody', async () => {
    const waiting = {
      id: 'obs-1',
      noticed_at: '2026-09-19T14:00:00Z',
      context: { managersTexted: ['Dana Reed'], targetName: 'x', wants: 'record' },
    } as unknown as Observation;
    const { deps, rec } = stub({
      ...twoManagers,
      findRequest: async () => waiting,
      addManagers: (async () => null) as unknown as NonNullable<AccessDeskDeps['addManagers']>,
      runLoop: decides(askSam),
    });
    const out = await routeAccessAsOffice(ask(), deps);
    expect(out.status).toBe('already_asked');
    expect(rec.pushes).toHaveLength(0);
    expect(rec.messages.map((m) => m.kind)).toEqual(['ask', 'desk']); // the review still sees it
  });

  test("a wrong 'already_open' is checked against the view and asked instead", async () => {
    const { deps, rec } = stub({
      runLoop: decides({ outcome: 'already_open', replyToAsker: 'it is open', reason: 'r' }),
    });
    const out = await routeAccessAsOffice(ask(), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests).toHaveLength(1);
    // …and its words go with it: she is told a manager was asked, not "it is open".
    expect(out.answer).not.toBe('it is open');
    expect(out.answer).toContain('Asked your manager');
  });

  test('a customer-wide record ask is never "already open" — one granted job does not open the rest', async () => {
    const { deps, rec } = stub({
      technicianView: async () => ({ ...emptyView(), customerIds: new Set([CUST_ID]) }),
      runLoop: decides({ outcome: 'already_open', replyToAsker: 'it is open', reason: 'r' }),
    });
    const out = await routeAccessAsOffice(ask({ jobId: undefined, customerId: CUST_ID }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests).toHaveLength(1);
  });

  test("the office's reason rides the ask row, never the answer row she can be shown", async () => {
    const { deps, rec } = stub({ runLoop: decides({ ...askSam, reason: 'she seems careless' }) });
    await routeAccessAsOffice(ask(), deps);
    expect(String(rec.messages[0].body)).toContain('she seems careless');
    expect(String(rec.messages[1].body)).not.toContain('she seems careless');
  });

  test('a filed request carries title-free words for anything read out to her', async () => {
    const { deps, rec } = stub({ runLoop: decides({ ...askSam, jobId: JOB_ID }) });
    await routeAccessAsOffice(ask({ jobId: undefined, customerId: CUST_ID }), deps);
    expect(rec.requests[0].context.targetName).toContain('boiler swap'); // the managers' words
    expect(rec.requests[0].context.technicianWords).not.toContain('boiler swap');
    expect(rec.requests[0].context.technicianWords).toContain('Alice Byrne');
  });

  test('already_open / already_asked / refuse reply in the office\'s words and file nothing', async () => {
    for (const outcome of ['already_open', 'already_asked', 'refuse'] as const) {
      const { deps, rec } = stub({
        runLoop: decides({ outcome, replyToAsker: `said ${outcome}`, reason: 'r' }),
        // In her view, so an already_open is TRUE and the fact guard lets it stand.
        technicianView: async () => ({ ...emptyView(), jobIds: new Set([JOB_ID]) }),
      });
      const out = await routeAccessAsOffice(ask(), deps);
      expect(out.status).toBe(outcome === 'refuse' ? 'refused' : outcome);
      expect(out.answer).toBe(`said ${outcome}`);
      expect(rec.requests).toHaveLength(0);
      expect(rec.pushes).toHaveLength(0);
    }
  });

  test('nobody reachable: the reply says so, whatever the office wrote', async () => {
    const { deps } = stub({ listManagers: async () => [], runLoop: decides(askSam) });
    const out = await routeAccessAsOffice(ask(), deps);
    expect(out.answer).toContain('No manager could be texted');
  });

  test('a decision with no reply, or no decision at all, takes the code path', async () => {
    for (const runLoop of [
      decides({ outcome: 'ask', reason: 'no reply' }),
      (async (): Promise<ToolLoopResult> => ({ text: 'hmm', turns: 1, calls: [], stalledWarnings: 0 })) as unknown as NonNullable<AccessDeskDeps['runLoop']>,
    ]) {
      const { deps, rec } = stub({ ...twoManagers, runLoop });
      const out = await routeAccessAsOffice(ask(), deps);
      expect(out.status).toBe('asked_manager');
      expect(rec.pushes).toHaveLength(2); // the fallback texts every reachable manager
    }
  });

  test('a failure applying the decision still files and texts (never lost)', async () => {
    let calls = 0;
    const { deps, rec } = stub({
      runLoop: decides(askSam),
      findRequest: async () => {
        calls++;
        if (calls === 1) throw new Error('db blip');
        return null;
      },
    });
    const out = await routeAccessAsOffice(ask(), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.requests).toHaveLength(1);
    expect(rec.pushes).toHaveLength(1);
  });
});

describe('the seat hangs up', () => {
  test('aborted during the office: nothing is filed or texted, and there is no fallback', async () => {
    const hangUp = new AbortController();
    const { deps, rec } = stub({
      signal: hangUp.signal,
      runLoop: (async () => {
        hangUp.abort();
        throw new Error('the caller hung up');
      }) as unknown as NonNullable<AccessDeskDeps['runLoop']>,
    });
    const out = await routeAccessAsOffice(ask(), deps);
    expect(out.answer).toContain('Stopped');
    expect(rec.requests).toHaveLength(0);
    expect(rec.pushes).toHaveLength(0);
  });

  test('the fallback checks the hang-up before it lapses a stale request', async () => {
    const hangUp = new AbortController();
    const lapsed: string[] = [];
    const { deps, rec } = stub({
      signal: hangUp.signal,
      findRequest: async () => {
        hangUp.abort();
        return { id: 'obs-old', noticed_at: '2026-09-18T16:00:00Z' } as unknown as Observation;
      },
      lapseRequest: (async (_t: string, id: string) => {
        lapsed.push(id);
        return null;
      }) as never,
    });
    await routeAccessAsOffice(ask(), deps);
    expect(lapsed).toEqual([]);
    expect(rec.requests).toHaveLength(0);
  });

  test('aborted after the decision, before the first write: nothing leaves', async () => {
    const hangUp = new AbortController();
    const { deps, rec } = stub({
      signal: hangUp.signal,
      runLoop: (async (_r: unknown, _t: unknown, exec: Exec): Promise<ToolLoopResult> => {
        await exec('route_access', askSam);
        hangUp.abort();
        return { text: '', turns: 1, calls: [], stalledWarnings: 0 };
      }) as unknown as NonNullable<AccessDeskDeps['runLoop']>,
    });
    await routeAccessAsOffice(ask(), deps);
    expect(rec.requests).toHaveLength(0);
    expect(rec.pushes).toHaveLength(0);
  });
});
