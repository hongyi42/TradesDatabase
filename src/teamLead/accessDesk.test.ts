import { describe, expect, test, vi } from 'vitest';
import type { AccessGrant, Customer, Job, Observation, OfficeMessage, PersonPush, Technician } from '../db/index.js';
import {
  answerAccessRequest,
  type AccessDecision,
  type AccessDeskDeps,
  type AccessRequestInput,
} from './accessDesk.js';
import { TEAM_LEAD_REF } from './identity.js';

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
  grants: Parameters<NonNullable<AccessDeskDeps['insertGrant']>>[0][];
  pushes: Parameters<NonNullable<AccessDeskDeps['queuePush']>>[0][];
  requests: Parameters<NonNullable<AccessDeskDeps['openRequest']>>[0][];
  messages: Record<string, unknown>[];
  decideCalls: { user: string }[];
}

function stub(over: Partial<AccessDeskDeps> = {}, decision: AccessDecision | Error = { decision: 'open', reason: 'on his way there' }) {
  const rec: Recorded = { grants: [], pushes: [], requests: [], messages: [], decideCalls: [] };
  const deps: AccessDeskDeps = {
    now: () => new Date('2026-09-19T17:00:00Z'),
    memoryIndex: async () => '- firm/pacing.md',
    getJob: async () => job(),
    getCustomer: async () => customer(),
    listOpenJobs: async () => [job()],
    // Hermetic by DEFAULT: without this the crew read reaches the real
    // database, which a try/catch then swallows — every test would still pass
    // while quietly making a network call.
    listJobVisits: async () => [],
    technicianView: async () => emptyView(),
    findRequest: async () => null,
    firmTenant: async () => ({ id: TENANT, timezone: 'America/Los_Angeles' }) as never,
    decide: async (input) => {
      rec.decideCalls.push({ user: input.user });
      if (decision instanceof Error) throw decision;
      return decision;
    },
    insertGrant: (async (g: Parameters<NonNullable<AccessDeskDeps['insertGrant']>>[0]) => {
      rec.grants.push(g);
      return { id: 'grant-1', ...g } as unknown as AccessGrant;
    }) as NonNullable<AccessDeskDeps['insertGrant']>,
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

describe('the access desk — the narrow ask it may open itself', () => {
  test('opens ONE job, record only, no money, for a day — every field fixed by code', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask(), deps);

    expect(out.status).toBe('opened');
    expect(rec.grants).toHaveLength(1);
    const g = rec.grants[0];
    expect(g.jobId).toBe(JOB_ID);
    expect(g.customerId).toBeUndefined();
    expect(g.opens).toBe('record');
    expect(g.opensMoney).toBe(false);
    expect(g.grantedBy).toBe(TEAM_LEAD_REF);
    expect(g.requestedBy).toBe('sam-teixeira');
    // Exactly 24 hours from the injected clock.
    expect(g.expiresAt).toBe(new Date('2026-09-20T17:00:00Z').toISOString());
    // THE REASON IS THE TECHNICIAN'S WORDS, quoted by code — never the model's.
    expect(g.reason).toBe('asked by Sam Teixeira: I am at the gate and need the code');
    expect(g.reason).not.toContain('on his way there');
    // Nothing was filed and nobody was texted: it is answered.
    expect(rec.requests).toHaveLength(0);
    expect(rec.pushes).toHaveLength(0);
  });

  test('the answer names the day and the job in words, and carries no ids', async () => {
    const { deps } = stub();
    const out = await answerAccessRequest(ask(), deps);
    expect(out.answer).toContain('boiler swap');
    expect(out.answer).toContain('Alice Byrne');
    expect(out.answer).not.toContain(JOB_ID);
    expect(out.answer).not.toContain(CUST_ID);
    expect(out.answer).not.toContain('sam-teixeira');
    // Firm-local: 17:00 UTC + 24h is still Sunday the 20th in Los Angeles.
    expect(out.answer).toMatch(/Sunday/);
  });

  test('writes the desk pair the planner reads — the outcome leads, the reason rides behind', async () => {
    const { deps, rec } = stub();
    await answerAccessRequest(ask(), deps);
    expect(rec.messages).toHaveLength(2);
    expect(rec.messages[0]).toMatchObject({ kind: 'ask', fromRef: 'sam-teixeira', toRef: TEAM_LEAD_REF });
    expect(rec.messages[1]).toMatchObject({ kind: 'desk', fromRef: TEAM_LEAD_REF, status: 'read' });
    const body = rec.messages[1].body as string;
    expect(body.startsWith('Opened for you until')).toBe(true);
    expect(body).toContain('on his way there');
  });

  test('a customer ask with exactly one unfinished job she cannot open becomes that job', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask({ jobId: undefined, customerId: CUST_ID }), deps);
    expect(out.status).toBe('opened');
    expect(rec.grants[0].jobId).toBe(JOB_ID);
    expect(rec.grants[0].customerId).toBeUndefined();
  });

  // THE DEAD END THIS PREVENTS: get_customer_context offers `{ customerId }`
  // exactly when the customer IS in view but has jobs that are not, and such a
  // customer normally has one unfinished job — the one she has a trip on.
  // Narrowing to it would answer "already open to you" to somebody asking for
  // the history, file nothing and text nobody.
  test('a customer ask is NOT narrowed to a job she can already open — it goes to a manager', async () => {
    const { deps, rec } = stub({
      technicianView: async () => ({ ...emptyView(), jobIds: new Set([JOB_ID]) }),
    });
    const out = await answerAccessRequest(ask({ jobId: undefined, customerId: CUST_ID }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.grants).toHaveLength(0);
    expect(rec.requests).toHaveLength(1);
    expect(rec.requests[0].context.jobId).toBeUndefined();
    expect(rec.requests[0].context.requestKey).toBe(`${TECH_ID}:c:${CUST_ID}:record`);
    expect(rec.pushes).toHaveLength(1);
  });
});

describe('the access desk — what always goes to a manager', () => {
  test('money never reaches the model and is texted to every reachable manager', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask({ wants: 'money' }), deps);

    expect(out.status).toBe('asked_manager');
    expect(rec.decideCalls).toHaveLength(0); // sensitive asks skip the call entirely
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

  test('every note also skips the model', async () => {
    const { deps, rec } = stub();
    const out = await answerAccessRequest(ask({ wants: 'notes' }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.decideCalls).toHaveLength(0);
    expect(rec.requests[0].context.wants).toBe('notes');
  });

  test('a customer with two unfinished jobs stays customer-wide and is not narrowed', async () => {
    const { deps, rec } = stub({
      listOpenJobs: async () => [job(), job({ id: '44444444-4444-4444-8444-444444444444', title: 'tap' })],
    });
    const out = await answerAccessRequest(ask({ jobId: undefined, customerId: CUST_ID }), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.decideCalls).toHaveLength(0);
    expect(rec.requests[0].context.jobId).toBeUndefined();
    expect(rec.requests[0].context.requestKey).toBe(`${TECH_ID}:c:${CUST_ID}:record`);
  });

  test('ask_manager from the model files the request and texts, and opens nothing', async () => {
    const { deps, rec } = stub({}, { decision: 'ask_manager', reason: 'the reason does not fit the work' });
    const out = await answerAccessRequest(ask(), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.decideCalls).toHaveLength(1);
    expect(rec.grants).toHaveLength(0);
    expect(rec.pushes).toHaveLength(1);
  });

  test('a model failure asks a manager — it never fails open', async () => {
    const { deps, rec } = stub({}, new Error('provider 500'));
    const out = await answerAccessRequest(ask(), deps);
    expect(out.status).toBe('asked_manager');
    expect(rec.grants).toHaveLength(0);
    expect(rec.pushes).toHaveLength(1);
  });

  test('a timeout asks a manager', async () => {
    vi.useFakeTimers();
    try {
      const { deps, rec } = stub({
        // Never resolves: only the race's timer can settle this.
        decide: () => new Promise<AccessDecision>(() => {}),
      });
      const pending = answerAccessRequest(ask(), deps);
      await vi.advanceTimersByTimeAsync(21_000);
      const out = await pending;
      expect(out.status).toBe('asked_manager');
      expect(rec.grants).toHaveLength(0);
      expect(rec.pushes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
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
    expect(rec.decideCalls).toHaveLength(0);
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

describe('the access desk — what the model is shown', () => {
  test('the decision call gets the ask, the reason and the job — and is not given the ids', async () => {
    const { deps, rec } = stub();
    await answerAccessRequest(ask(), deps);
    const user = rec.decideCalls[0].user;
    expect(user).toContain('Sam Teixeira');
    expect(user).toContain('I am at the gate and need the code');
    expect(user).toContain('boiler swap');
    expect(user).toContain('Alice Byrne');
  });

  test('the model is told who is booked on the job — the plan\'s strongest evidence', async () => {
    const { deps, rec } = stub({
      listJobVisits: async () =>
        [
          {
            id: 'v1',
            tenant_id: TENANT,
            status: 'confirmed',
            visit_participants: [
              { technician_id: 'x', tenant_id: TENANT, technicians: { ref: 'kim', display_name: 'Kim Ng', tenant_id: TENANT } },
            ],
          },
          // A cancelled trip is not who is booked on it.
          {
            id: 'v2',
            tenant_id: TENANT,
            status: 'cancelled',
            visit_participants: [
              { technician_id: 'y', tenant_id: TENANT, technicians: { ref: 'gone', display_name: 'Gone Person', tenant_id: TENANT } },
            ],
          },
        ] as never,
    });
    await answerAccessRequest(ask(), deps);
    const user = rec.decideCalls[0].user;
    expect(user).toContain('Booked on it: Kim Ng');
    expect(user).not.toContain('Gone Person');
  });

  test('a failed crew read costs an input, never the decision', async () => {
    const { deps, rec } = stub({
      listJobVisits: async () => {
        throw new Error('visits read failed');
      },
    });
    const out = await answerAccessRequest(ask(), deps);
    expect(out.status).toBe('opened');
    expect(rec.decideCalls[0].user).toContain('Booked on it: nobody');
  });

  test('a grant that fails to write is not reported as opened', async () => {
    const { deps } = stub({
      insertGrant: (async () => {
        throw new Error('insert failed');
      }) as NonNullable<AccessDeskDeps['insertGrant']>,
    });
    await expect(answerAccessRequest(ask(), deps)).rejects.toThrow('insert failed');
  });

  test('a failed desk-pair write does not undo a grant that already landed', async () => {
    const { deps, rec } = stub({
      createMessage: (async () => {
        throw new Error('office write failed');
      }) as unknown as NonNullable<AccessDeskDeps['createMessage']>,
    });
    const out = await answerAccessRequest(ask(), deps);
    expect(out.status).toBe('opened');
    expect(rec.grants).toHaveLength(1);
  });
});
