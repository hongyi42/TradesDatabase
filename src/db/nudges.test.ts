import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  createPendingNudge,
  listNudgedSubjectRefs,
  listNudgesByStatus,
  markNudgeAsked,
  listQueuedNudgesInGroupForHost,
  markNudgeAskedGroup,
  markNudgeGroupQueued,
  markNudgeOutcome,
  markNudgeQueued,
  listAskedNudgesForTechnicianJob,
  setNudgeAnsweredBy,
  setNudgeSchedule,
} from './nudges.js';
import { createTenant } from './tenants.js';

// Integration test against the LOCAL stack (testEnvGuard enforces local-only).
// Exercises the nudge lifecycle guards the watcher/compose/transport steps
// lean on: the ask-once-EVER unique index, the status-guarded transitions,
// the per-person budget read, and the review_items once-ever backstop index
// this migration added for Feature A.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let tenantB: string | undefined;
let techId: string;
let hostId: string | undefined;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query('truncate table nudges cascade');
  // A dedicated recipient row — seat_exempt so the seat-cap trigger never
  // depends on how much roster the current seed left behind.
  const tech = await pg.query<{ id: string }>(
    `insert into technicians (tenant_id, ref, display_name, tier, state, seat_exempt)
     values ($1, 'nudge-test-tech', 'Nudge Test Tech', 'technician', 'active', true)
     returning id`,
    [tenantId],
  );
  techId = tech.rows[0].id;
});

afterAll(async () => {
  await pg.query('truncate table nudges cascade');
  await pg.query("delete from review_items where subject_ref like 'nudge-bt-%'");
  await pg.query('delete from technicians where id = $1', [techId]);
  if (hostId) await pg.query('delete from hosts where id = $1', [hostId]);
  if (tenantB) await pg.query('delete from tenants where id = $1', [tenantB]);
  await pg.end();
});

describe('createPendingNudge — ask once per subject, ever', () => {
  test('first insert lands pending; the repeat converges to null', async () => {
    const first = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-dedup-1',
      technicianId: techId,
      context: { jobTitle: 'Furnace tune-up' },
    });
    expect(first?.status).toBe('pending');
    expect(first?.actor_ref).toBe('spine:team-lead');

    const repeat = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-dedup-1',
      technicianId: techId,
    });
    expect(repeat).toBeNull(); // the unique index IS the dedup

    // Even after the first is CLOSED, the subject stays blocked — the index
    // is deliberately not partial (an assignment's end never recurs).
    await markNudgeOutcome(first!.id, tenantId, 'cancelled', 'test close');
    const afterClose = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-dedup-1',
      technicianId: techId,
    });
    expect(afterClose).toBeNull();
  });
});

describe('status-guarded transitions', () => {
  test('pending→queued→asked walks; wrong-state writes refuse with null', async () => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-walk-1',
      technicianId: techId,
    });
    expect(n).not.toBeNull();

    // asked before queued: refused (the runner can only ack a composed row)
    expect(await markNudgeAsked(n!.id, tenantId)).toBeNull();

    const queued = await markNudgeQueued(n!.id, tenantId, 'How did the visit go?');
    expect(queued?.status).toBe('queued');
    expect(queued?.question).toBe('How did the visit go?');
    expect(queued?.queued_at).not.toBeNull();

    // queued→queued: refused (compose must not double-write)
    expect(await markNudgeQueued(n!.id, tenantId, 'second question')).toBeNull();

    const asked = await markNudgeAsked(n!.id, tenantId);
    expect(asked?.status).toBe('asked');
    expect(asked?.asked_at).not.toBeNull();

    const answered = await markNudgeOutcome(n!.id, tenantId, 'answered', 'capture landed');
    expect(answered?.status).toBe('answered');
    expect(answered?.resolved_at).not.toBeNull();

    // Terminal is terminal: a racing escalation sweep must not overwrite.
    expect(await markNudgeOutcome(n!.id, tenantId, 'escalated')).toBeNull();
  });

  test('fromStatuses narrows the outcome guard: the expiry write loses to a racing delivery ack', async () => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-race-1',
      technicianId: techId,
    });
    await markNudgeQueued(n!.id, tenantId, 'q');
    await markNudgeAsked(n!.id, tenantId); // the ack landed first
    // The expiry sweep's "never delivered" close is pending|queued-scoped —
    // on an asked row it must write NOTHING (the 24h escalation owns it now).
    expect(
      await markNudgeOutcome(n!.id, tenantId, 'failed', 'never delivered', ['pending', 'queued']),
    ).toBeNull();
    const still = await listNudgesByStatus(tenantId, ['asked']);
    expect(still.some((row) => row.id === n!.id)).toBe(true);
  });


  test('cross-tenant ids resolve nothing', async () => {
    tenantB = (await createTenant('Nudge Test Tenant B')).id;
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-xtenant-1',
      technicianId: techId,
    });
    expect(await markNudgeQueued(n!.id, tenantB, 'stolen question')).toBeNull();
    expect(await markNudgeOutcome(n!.id, tenantB, 'cancelled')).toBeNull();
    expect(await listNudgesByStatus(tenantB, ['pending'])).toEqual([]);
    expect(await listNudgedSubjectRefs(tenantB, 'overdue_visit_gap', ['asg-xtenant-1'])).toEqual(
      [],
    );
  });
});

describe('listNudgedSubjectRefs — the fresh-gap pre-filter', () => {
  test('returns only the subjects ever nudged, any status; empty input short-circuits', async () => {
    const a = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-filter-a',
      technicianId: techId,
    });
    await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: 'asg-filter-b',
      technicianId: techId,
    });
    // A CLOSED nudge still counts — the filter is any-status by design.
    await markNudgeOutcome(a!.id, tenantId, 'cancelled');

    const hit = await listNudgedSubjectRefs(tenantId, 'overdue_visit_gap', [
      'asg-filter-a',
      'asg-filter-b',
      'asg-filter-never',
    ]);
    expect(hit.sort()).toEqual(['asg-filter-a', 'asg-filter-b']);

    expect(await listNudgedSubjectRefs(tenantId, 'overdue_visit_gap', [])).toEqual([]);
  });
});

describe('review_items once-ever backstop index (Feature A debt, paid here)', () => {
  test('a duplicate overdue_visit_gap subject fails at the DB even bypassing the app guard', async () => {
    await pg.query(
      `insert into review_items (tenant_id, kind, subject_ref, status, resolution, resolved_at)
       values ($1, 'overdue_visit_gap', 'nudge-bt-1', 'resolved', 'closed once', now())`,
      [tenantId],
    );
    // The open-only partial index would NOT block this (first row is closed);
    // the new any-status index must.
    await expect(
      pg.query(
        `insert into review_items (tenant_id, kind, subject_ref)
         values ($1, 'overdue_visit_gap', 'nudge-bt-1')`,
        [tenantId],
      ),
    ).rejects.toMatchObject({ code: '23505' });

    // Other kinds keep their open-only semantics — same subject, closed row,
    // fresh open row is fine.
    await pg.query(
      `insert into review_items (tenant_id, kind, subject_ref, status, resolution, resolved_at)
       values ($1, 'call_action', 'nudge-bt-2', 'resolved', 'closed once', now())`,
      [tenantId],
    );
    await pg.query(
      `insert into review_items (tenant_id, kind, subject_ref)
       values ($1, 'call_action', 'nudge-bt-2')`,
      [tenantId],
    );
  });
});

// ── setNudgeSchedule: the planner's only write onto a nudge (Phase 2) ───────
describe('setNudgeSchedule', () => {
  const openRow = async (subjectRef: string) => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef,
      technicianId: techId,
      context: { jobId: 'j-sched' },
    });
    if (!n) throw new Error('fixture nudge was not created');
    return n;
  };

  test('stamps both columns, and an unstamped row reads null (the code default)', async () => {
    const n = await openRow('asg-sched-1');
    expect(n.not_before).toBeNull();
    expect(n.escalate_after).toBeNull();

    const updated = await setNudgeSchedule(n.id, tenantId, {
      notBefore: '2026-08-20T15:00:00.000Z',
      escalateAfter: '2026-08-21T15:00:00.000Z',
    });
    expect(updated?.not_before).toBe('2026-08-20T15:00:00+00:00');
    expect(updated?.escalate_after).toBe('2026-08-21T15:00:00+00:00');
  });

  test('an omitted key is LEFT ALONE; an explicit null CLEARS it', async () => {
    // The distinction is load-bearing: "no opinion this tick" and "forget what I
    // said last tick" are different instructions from the planner.
    const n = await openRow('asg-sched-2');
    await setNudgeSchedule(n.id, tenantId, {
      notBefore: '2026-08-20T15:00:00.000Z',
      escalateAfter: '2026-08-21T15:00:00.000Z',
    });

    const partial = await setNudgeSchedule(n.id, tenantId, { notBefore: null });
    expect(partial?.not_before).toBeNull();
    expect(partial?.escalate_after).toBe('2026-08-21T15:00:00+00:00'); // untouched
  });

  test('an explicit undefined leaves the column ALONE — the Phase-4 call shape', async () => {
    // The planner spreads a decision object whose fields are optional, so both
    // KEYS arrive with one value undefined. Keying on `in` would read "no opinion
    // about escalation this tick" as "clear it", erasing last tick's deadline.
    const n = await openRow('asg-sched-6');
    await setNudgeSchedule(n.id, tenantId, {
      notBefore: '2026-08-20T15:00:00.000Z',
      escalateAfter: '2026-08-21T15:00:00.000Z',
    });
    const decision: { notBefore?: string | null; escalateAfter?: string | null } = {
      notBefore: '2026-08-22T15:00:00.000Z',
    };
    const after = await setNudgeSchedule(n.id, tenantId, {
      notBefore: decision.notBefore,
      escalateAfter: decision.escalateAfter, // undefined — no opinion, not "clear it"
    });
    expect(after?.not_before).toBe('2026-08-22T15:00:00+00:00');
    expect(after?.escalate_after).toBe('2026-08-21T15:00:00+00:00');
  });

  test('an empty patch is refused where the caller is named, not as a database error', async () => {
    const n = await openRow('asg-sched-3');
    await expect(setNudgeSchedule(n.id, tenantId, {})).rejects.toThrow(/nothing to set/);
  });

  test('a CLOSED row is never re-scheduled — the planner must lose a race it lost', async () => {
    // A planner call takes seconds; a delivery ack or an auto-resolve can land in
    // that window. The write must return null rather than put a deadline back on
    // a gap that is already done.
    const n = await openRow('asg-sched-4');
    await markNudgeOutcome(n.id, tenantId, 'answered', 'a note landed');
    const late = await setNudgeSchedule(n.id, tenantId, {
      escalateAfter: '2026-08-21T15:00:00.000Z',
    });
    expect(late).toBeNull();
    const [row] = await listNudgesByStatus(tenantId, ['answered']).then((rows) =>
      rows.filter((r) => r.subject_ref === 'asg-sched-4'),
    );
    expect(row.escalate_after).toBeNull();
  });

  test('another tenant cannot schedule this row', async () => {
    // A bare non-matching uuid is enough — the guard is the tenant_id predicate,
    // and inventing a second tenant row here would leak one past the cleanup.
    const n = await openRow('asg-sched-5');
    const cross = await setNudgeSchedule(n.id, '00000000-0000-0000-0000-0000000000ff', {
      notBefore: '2026-08-20T15:00:00.000Z',
    });
    expect(cross).toBeNull();
  });
});

// Attribution (plan 2026-08-22, Phase 1): which gap an answer answered.
describe('attribution — an answer remembers its question', () => {
  const JOB_A = '11111111-1111-4111-8111-111111111111';
  const JOB_B = '22222222-2222-4222-8222-222222222222';
  const CAP_1 = '33333333-3333-4333-8333-333333333331';
  const CAP_2 = '33333333-3333-4333-8333-333333333332';

  let otherTechId: string;
  beforeAll(async () => {
    const t = await pg.query<{ id: string }>(
      `insert into technicians (tenant_id, ref, display_name, tier, state, seat_exempt)
       values ($1, 'nudge-attr-other', 'Other Tech', 'technician', 'active', true)
       on conflict (tenant_id, ref) do update set display_name = excluded.display_name
       returning id`,
      [tenantId],
    );
    otherTechId = t.rows[0].id;
  });
  afterAll(async () => {
    // This inner hook runs BEFORE the file-level truncate, so the recipient's
    // own rows have to go first — nudges.technician_id is a real FK.
    await pg.query('delete from nudges where technician_id = $1', [otherTechId]);
    await pg.query('delete from technicians where id = $1', [otherTechId]);
  });

  const gapOn = async (subjectRef: string, jobId: string, technicianId = techId) => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef,
      technicianId,
      context: { jobId },
    });
    if (!n) throw new Error('fixture nudge was not created');
    return n;
  };
  // pending -> queued -> asked: the only state in which a person could be
  // replying to anything.
  const askedGapOn = async (subjectRef: string, jobId: string, technicianId = techId) => {
    const n = await gapOn(subjectRef, jobId, technicianId);
    await markNudgeQueued(n.id, tenantId, 'How did it go?');
    const asked = await markNudgeAsked(n.id, tenantId);
    if (!asked) throw new Error('fixture nudge was not asked');
    return asked;
  };

  test('finds only THIS person’s ASKED gaps on THIS job', async () => {
    const mine = await askedGapOn('asg-attr-1', JOB_A);
    await askedGapOn('asg-attr-2', JOB_B); // same person, different job
    await askedGapOn('asg-attr-3', JOB_A, otherTechId); // same job, different person

    const found = await listAskedNudgesForTechnicianJob(tenantId, techId, JOB_A);
    expect(found.map((n) => n.id)).toEqual([mine.id]);
  });

  test('a PENDING or QUEUED gap is invisible — nobody has been asked anything yet', async () => {
    // The narrowing that makes attribution work at all. A pending gap can sit
    // for hours (not_before gates compose only, and `hold` may push it to the
    // 18h ceiling); any routine note in that window would otherwise be stamped
    // as the ANSWER to a question nobody has been asked — and first-write-wins
    // means the real answer could never claim the slot afterwards.
    await pg.query('update nudges set status = $1 where tenant_id = $2', ['answered', tenantId]);
    const pending = await gapOn('asg-attr-pending', JOB_A);
    expect(pending.status).toBe('pending');
    expect(await listAskedNudgesForTechnicianJob(tenantId, techId, JOB_A)).toEqual([]);

    await markNudgeQueued(pending.id, tenantId, 'How did it go?');
    expect(await listAskedNudgesForTechnicianJob(tenantId, techId, JOB_A)).toEqual([]);

    await markNudgeAsked(pending.id, tenantId);
    const asked = await listAskedNudgesForTechnicianJob(tenantId, techId, JOB_A);
    expect(asked.map((r) => r.id)).toEqual([pending.id]);
  });

  test('an unasked SIBLING gap on the job does not make the real answer ambiguous', async () => {
    // Two gaps on one job, only ONE of them asked: the count attribution keys on
    // must be 1, or a brand-new cost gap would silently block the answer to the
    // visit question that actually went out.
    await pg.query('update nudges set status = $1 where tenant_id = $2', ['answered', tenantId]);
    const askedOne = await askedGapOn('asg-attr-sib-a', JOB_A);
    await gapOn('asg-attr-sib-b', JOB_A); // pending — never delivered
    const found = await listAskedNudgesForTechnicianJob(tenantId, techId, JOB_A);
    expect(found.map((r) => r.id)).toEqual([askedOne.id]);
  });

  test('a CLOSED gap is not asked any more, and another tenant sees nothing', async () => {
    const n = await askedGapOn('asg-attr-4', JOB_A);
    // Two open now (asg-attr-1 from above and this one) — close this one and the
    // remaining single row is what attribution would act on.
    await markNudgeOutcome(n.id, tenantId, 'answered', 'closed for this test');
    const open = await listAskedNudgesForTechnicianJob(tenantId, techId, JOB_A);
    expect(open.map((r) => r.id)).not.toContain(n.id);

    const cross = await listAskedNudgesForTechnicianJob(
      '00000000-0000-0000-0000-0000000000ff',
      techId,
      JOB_A,
    );
    expect(cross).toEqual([]);
  });

  test('stamps once and a LATER capture never overwrites the first', async () => {
    const n = await gapOn('asg-attr-5', JOB_B);
    expect(n.answered_by_capture_id).toBeNull();

    const first = await setNudgeAnsweredBy(n.id, tenantId, CAP_1);
    expect(first?.answered_by_capture_id).toBe(CAP_1);

    // A DIFFERENT capture id, deliberately: the same id would pass even if the
    // guard were broken, and `.eq(col, null)` (which matches zero rows) would
    // make a same-id assertion pass for exactly the wrong reason.
    const second = await setNudgeAnsweredBy(n.id, tenantId, CAP_2);
    expect(second).toBeNull(); // the guard refused it
    const [row] = (await listNudgesByStatus(tenantId, ['pending'])).filter(
      (r) => r.id === n.id,
    );
    expect(row.answered_by_capture_id).toBe(CAP_1); // still the first
  });

  test('another tenant cannot stamp this row', async () => {
    const n = await gapOn('asg-attr-6', JOB_B);
    const cross = await setNudgeAnsweredBy(n.id, '00000000-0000-0000-0000-0000000000ff', CAP_1);
    expect(cross).toBeNull();
  });

  test('a CLOSED gap can still be stamped — the answer is a historical fact', async () => {
    // Deliberately NOT status-guarded (unlike every lifecycle write here): a
    // sweep closing the gap a moment before the note lands must not erase the
    // record of WHICH capture answered it.
    const n = await gapOn('asg-attr-7', JOB_B);
    await markNudgeOutcome(n.id, tenantId, 'answered', 'a note landed');
    const stamped = await setNudgeAnsweredBy(n.id, tenantId, CAP_1);
    expect(stamped?.answered_by_capture_id).toBe(CAP_1);
  });
});

// ── plan 2026-08-25 Phase 2: the group writers ──────────────────────────────
describe('ask-groups — one message, several rows', () => {
  const pending = async (subjectRef: string) => {
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef,
      technicianId: techId,
      context: { jobTitle: 'Boiler swap', jobId: 'j-group' },
    });
    if (!n) throw new Error(`could not seed ${subjectRef}`);
    return n;
  };

  test('markNudgeGroupQueued moves only PENDING members and returns exactly those', async () => {
    const a = await pending('grp-a1');
    const b = await pending('grp-a2');
    const c = await pending('grp-a3');
    // c is already queued by another writer — the group write must not move it
    // again, and must not claim it did.
    await markNudgeQueued(c.id, tenantId, 'someone else got there first');

    const moved = await markNudgeGroupQueued([a.id, b.id, c.id], tenantId, 'one message', a.id);
    expect(moved.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    for (const row of moved) {
      expect(row.status).toBe('queued');
      expect(row.question).toBe('one message');
      // The group id IS the lead's own row id, so the lead is self-identifying.
      expect(row.ask_group_id).toBe(a.id);
      expect(row.queued_at).not.toBeNull();
    }
    const untouched = (await listNudgesByStatus(tenantId, ['queued'])).find((r) => r.id === c.id);
    expect(untouched?.question).toBe('someone else got there first');
    expect(untouched?.ask_group_id).toBeNull();
  });

  test('markNudgeAskedGroup moves the whole group on ONE shared asked_at', async () => {
    const a = await pending('grp-b1');
    const b = await pending('grp-b2');
    await markNudgeGroupQueued([a.id, b.id], tenantId, 'one message', a.id);

    const asked = await markNudgeAskedGroup(a.id, tenantId, a.id);
    expect(asked.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
    // They left in one message, so their escalation clocks start together — two
    // timestamps here would let the sweep escalate half a message.
    expect(new Set(asked.map((r) => r.asked_at))).toHaveProperty('size', 1);
    for (const row of asked) expect(row.status).toBe('asked');
  });

  test('markNudgeAskedGroup with a null group behaves exactly like markNudgeAsked', async () => {
    const solo = await pending('grp-c1');
    await markNudgeQueued(solo.id, tenantId, 'on its own');
    const moved = await markNudgeAskedGroup(solo.id, tenantId, null);
    expect(moved).toHaveLength(1);
    expect(moved[0].id).toBe(solo.id);
    expect(moved[0].status).toBe('asked');
    // …and a second report finds nothing left to move (queued-only guard).
    expect(await markNudgeAskedGroup(solo.id, tenantId, null)).toEqual([]);
  });

  test('listQueuedNudgesInGroupForHost is HOST-scoped and returns nothing for another host', async () => {
    // The accessor whose tenantId parameter was dropped: scoping now rests
    // entirely on the technicians!inner join, so it gets its own assertion.
    const a = await pending('grp-e1');
    const b = await pending('grp-e2');
    await markNudgeGroupQueued([a.id, b.id], tenantId, 'one message', a.id);
    const host = await pg.query<{ id: string }>(
      `insert into hosts (name, token_hash) values ('nudge-test-host', 'nudge-test-hash') returning id`,
    );
    hostId = host.rows[0].id;
    await pg.query('update technicians set host_id = $1 where id = $2', [hostId, techId]);

    const mine = await listQueuedNudgesInGroupForHost(a.id, hostId);
    expect(mine.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());

    const theirs = await listQueuedNudgesInGroupForHost(
      a.id,
      '00000000-0000-0000-0000-0000000000ff',
    );
    expect(theirs).toEqual([]);
  });

  test('a lead that is not among its own members is REFUSED', async () => {
    // Otherwise no row satisfies `id = ask_group_id`, the group is leaderless
    // from birth, and the serve loop freezes it until the 18h expiry.
    const a = await pending('grp-f1');
    await expect(
      markNudgeGroupQueued([a.id], tenantId, 'one message', '00000000-0000-0000-0000-0000000000aa'),
    ).rejects.toThrow(/not among its own members/);
    // …and nothing moved.
    const after = await listNudgesByStatus(tenantId, ['pending']);
    expect(after.some((r) => r.id === a.id)).toBe(true);
  });

  test('a group write is tenant-scoped', async () => {
    const a = await pending('grp-d1');
    const moved = await markNudgeGroupQueued(
      [a.id],
      '00000000-0000-0000-0000-0000000000ff',
      'wrong tenant',
      a.id,
    );
    expect(moved).toEqual([]);
  });
});
