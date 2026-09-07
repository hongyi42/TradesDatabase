import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  PINGED_KINDS,
  captureHasObservation,
  claimObservationPing,
  clearObservationAsked,
  createObservation,
  listObservationsByStatus,
  listObservedSubjectRefs,
  listUnpingedObservations,
  markObservationAsked,
  setObservationStatus,
  stampObservationsPinged,
} from './observations.js';
import { createNudgeFromObservation } from './nudges.js';
import {
  listDecisionsForNudge,
  listDecisionsForNudges,
  recordNudgeDecisions,
} from './nudgeDecisions.js';

// Writes go through the app path (supabase-js); direct pg is the INDEPENDENT
// read-back channel and the cleanup — the jobNotes/plannerMemory convention.
//
// NO TRUNCATION here, deliberately: nudges and nudge_decisions are SHARED
// tables other test files write concurrently, and observations gains writers in
// later phases. Isolation is by unique subject refs per run; cleanup deletes
// exactly the rows this file created (observation deletes cascade their
// decision rows by design — one of the behaviours under test).
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
const RUN = `obs-${Date.now()}`;
let seq = 0;
const subject = (): string => `${RUN}-${(seq += 1)}`;
const createdIds: string[] = [];

async function mkObservation(over: { technicianId?: string | null } = {}) {
  const row = await createObservation({
    tenantId,
    kind: 'overdue_visit_gap',
    subjectRef: subject(),
    technicianId: over.technicianId ?? null,
    context: { jobTitle: 'Test job' },
  });
  if (!row) throw new Error('fixture create returned null');
  createdIds.push(row.id);
  return row;
}

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  if (createdIds.length > 0) {
    // Nudges first (same ids as their observations — no FK, but tidy either
    // way), then observations; decision rows cascade from the observation.
    await pg.query('delete from nudges where id = any($1::uuid[])', [createdIds]);
    await pg.query('delete from observations where id = any($1::uuid[])', [createdIds]);
  }
  await pg.end();
});

describe('observations', () => {
  test('a create round-trips through the status list', async () => {
    const row = await mkObservation();
    expect(row.status).toBe('open');
    expect(row.noticed_at).toBeTruthy();
    const open = await listObservationsByStatus(tenantId, ['open']);
    expect(open.some((o) => o.id === row.id)).toBe(true);
  });

  test('a subject is noticed once EVER — the unique survives every status', async () => {
    const row = await mkObservation();
    const again = () =>
      createObservation({
        tenantId,
        kind: 'overdue_visit_gap',
        subjectRef: row.subject_ref,
        technicianId: null,
      });
    // open blocks
    expect(await again()).toBeNull();
    // dismissed blocks. NOT because dismissal blocks it — the index and the
    // any-status read are the DETECTOR'S MEMORY, and they hold whatever the
    // status is (the two mechanisms are separated in observations.ts's own
    // header since build 7). What dismissal does is hide the row from the
    // PLANNER, whose read is ['open'].
    await setObservationStatus(
      row.id,
      tenantId,
      { status: 'dismissed', dismissReason: 'x', dismissedAt: new Date().toISOString() },
      ['open'],
    );
    expect(await again()).toBeNull();
    // asked blocks
    await setObservationStatus(row.id, tenantId, { status: 'asked' }, ['dismissed']);
    expect(await again()).toBeNull();
  });

  test('the once-ever rule is the DETECTOR\'s alone — a planner row may repeat a subject', async () => {
    // Build 7 Phase 1. uq_observations_subject_ever is partial on
    // author='detector', because the index exists to compensate for the sweep's
    // statelessness. The planner sees its whole open set every tick and needs no
    // such rule — left whole, the index would have meant one planner
    // observation per subject FOREVER.
    const ref = subject();
    const mkPlanner = () =>
      createObservation({
        tenantId,
        kind: 'planner_observation',
        subjectRef: ref,
        technicianId: null,
        author: 'planner',
      });
    const first = await mkPlanner();
    const second = await mkPlanner();
    if (!first || !second) throw new Error('a planner row must never dedupe to null');
    createdIds.push(first.id, second.id);
    expect(second.id).not.toBe(first.id);
    expect(first.author).toBe('planner');

    // …while the DEFAULT author still dedupes, on the very same kind — so it is
    // the author that decides, not the kind.
    const detectorRef = subject();
    const mkDetector = () =>
      createObservation({
        tenantId,
        kind: 'planner_observation',
        subjectRef: detectorRef,
        technicianId: null,
      });
    const d1 = await mkDetector();
    if (!d1) throw new Error('the first detector row must exist');
    createdIds.push(d1.id);
    expect(d1.author).toBe('detector');
    expect(await mkDetector()).toBeNull();
  });

  test('dismiss is guarded to open rows — an asked row refuses', async () => {
    const row = await mkObservation();
    await setObservationStatus(row.id, tenantId, { status: 'asked' }, ['open']);
    const moved = await setObservationStatus(
      row.id,
      tenantId,
      { status: 'dismissed', dismissReason: 'too late', dismissedAt: new Date().toISOString() },
      ['open'],
    );
    expect(moved).toBeNull();
    const { rows } = await pg.query('select status from observations where id = $1', [row.id]);
    expect(rows[0].status).toBe('asked');
  });

  test('recover is guarded to dismissed rows, and CLEARS the dismissal', async () => {
    const row = await mkObservation();
    // recover on an open row refuses
    expect(
      await setObservationStatus(row.id, tenantId, { status: 'open' }, ['dismissed']),
    ).toBeNull();
    await setObservationStatus(
      row.id,
      tenantId,
      { status: 'dismissed', dismissReason: 'noise', dismissedAt: new Date().toISOString() },
      ['open'],
    );
    const back = await setObservationStatus(
      row.id,
      tenantId,
      { status: 'open', dismissReason: null, dismissedAt: null },
      ['dismissed'],
    );
    expect(back?.status).toBe('open');
    expect(back?.dismiss_reason).toBeNull();
    expect(back?.dismissed_at).toBeNull();
  });

  test('listObservedSubjectRefs answers ANY status and only the asked-for kind', async () => {
    const a = await mkObservation();
    await setObservationStatus(
      a.id,
      tenantId,
      { status: 'dismissed', dismissReason: 'x', dismissedAt: new Date().toISOString() },
      ['open'],
    );
    const hits = await listObservedSubjectRefs(tenantId, 'overdue_visit_gap', [
      a.subject_ref,
      `${RUN}-never-created`,
    ]);
    expect(hits).toEqual([a.subject_ref]);
    // Same subject, different kind: not observed under that name.
    expect(await listObservedSubjectRefs(tenantId, 'job_cost_gap', [a.subject_ref])).toEqual([]);
    expect(await listObservedSubjectRefs(tenantId, 'overdue_visit_gap', [])).toEqual([]);
  });

  test('listObservedSubjectRefs is the DETECTOR\'s memory — a planner row is not in it', async () => {
    // Build 7 Phase 1, and this test guards a PERFORMANCE property as much as a
    // semantic one. The read carries `.eq('author','detector')` because a
    // partial index is only usable when the query implies its predicate —
    // without it the sweep's dedup became a full-table scan on a table that
    // never deletes. Deleting the filter would leave every assertion below
    // passing EXCEPT the planner-row one, which is why that one is here.
    const ref = subject();
    const planner = await createObservation({
      tenantId,
      kind: 'overdue_visit_gap', // the DETECTOR's kind, deliberately
      subjectRef: ref,
      technicianId: null,
      author: 'planner',
    });
    if (!planner) throw new Error('a planner row must never dedupe to null');
    createdIds.push(planner.id);
    // The detector has not noticed this subject: a planner row is not its memory.
    expect(await listObservedSubjectRefs(tenantId, 'overdue_visit_gap', [ref])).toEqual([]);
    // …so the detector is still free to notice it, on the very same subject.
    const detector = await createObservation({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: ref,
      technicianId: null,
    });
    if (!detector) throw new Error('the detector must still be able to notice this subject');
    createdIds.push(detector.id);
    expect(await listObservedSubjectRefs(tenantId, 'overdue_visit_gap', [ref])).toEqual([ref]);
  });

  test('a decisions row may point at an observation ALONE — and both-null refuses', async () => {
    const row = await mkObservation();
    // observation_id only: satisfies nudge_decisions_subject_check.
    const ins = await pg.query(
      `insert into nudge_decisions
         (tenant_id, observation_id, mode, action, confidence, reason, outcome)
       values ($1, $2, 'live', 'dismiss', 'high', 'test', 'applied')
       returning id`,
      [tenantId, row.id],
    );
    expect(ins.rows[0].id).toBeTruthy();
    // NEITHER SUBJECT IS NOW LEGAL (build 6.5 Phase 3, migration
    // 20260903120000). This test used to pin the opposite — the CHECK refused
    // it with 23514 — and the constraint was dropped rather than widened,
    // because a both-null row is not a decision that lost its gap: it is a
    // MESSAGE TO A PERSON that no gap ever raised. `to_ref` says who.
    const gapless = await pg.query(
      `insert into nudge_decisions
         (tenant_id, mode, action, confidence, reason, outcome, to_ref)
       values ($1, 'live', 'inform_agent', 'high', 'a word to the manager', 'applied',
               'manager-sam')
       returning id, nudge_id, observation_id, to_ref`,
      [tenantId],
    );
    expect(gapless.rows[0].nudge_id).toBeNull();
    expect(gapless.rows[0].observation_id).toBeNull();
    expect(gapless.rows[0].to_ref).toBe('manager-sam');
    // And it belongs to no gap's history — asserted through the READER that
    // makes the claim, not through a SQL predicate that merely agrees with it.
    const history = await listDecisionsForNudges(tenantId, [row.id]);
    expect(history.get(row.id) ?? []).toHaveLength(1); // the dismiss, not the message
    expect((history.get(row.id) ?? []).every((d) => d.observation_id === row.id)).toBe(true)
  });

  test('deleting an observation cascades its decision rows', async () => {
    const row = await mkObservation();
    await pg.query(
      `insert into nudge_decisions
         (tenant_id, observation_id, mode, action, confidence, reason, outcome)
       values ($1, $2, 'live', 'recover', 'high', 'test', 'applied')`,
      [tenantId, row.id],
    );
    await pg.query('delete from observations where id = $1', [row.id]);
    const left = await pg.query('select count(*)::int as n from nudge_decisions where observation_id = $1', [
      row.id,
    ]);
    expect(left.rows[0].n).toBe(0);
  });

  test('createNudgeFromObservation: same id, born queued — and a taken id returns null', async () => {
    const row = await mkObservation();
    const nudge = await createNudgeFromObservation({
      id: row.id,
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: row.subject_ref,
      technicianId: null,
      context: row.context,
      question: 'How did the tankless swap go?',
    });
    expect(nudge?.id).toBe(row.id); // ONE GAP, ONE ID — the design's whole point
    expect(nudge?.status).toBe('queued');
    expect(nudge?.queued_at).toBeTruthy();
    expect(nudge?.question).toBe('How did the tankless swap go?');
    // The race: a second send with the same id converges to null, not a throw
    // and not a second question.
    const again = await createNudgeFromObservation({
      id: row.id,
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: row.subject_ref,
      technicianId: null,
      context: row.context,
      question: 'duplicate',
    });
    expect(again).toBeNull();
  });

  test('a relic nudge on the subject also refuses the send — asked once, ever', async () => {
    const row = await mkObservation();
    // A pre-split relic: a nudge already exists for this subject under its own id.
    const relic = await pg.query(
      `insert into nudges (tenant_id, kind, subject_ref, status) values ($1, $2, $3, 'answered')
       returning id`,
      [tenantId, 'overdue_visit_gap', row.subject_ref],
    );
    createdIds.push(relic.rows[0].id as string);
    const nudge = await createNudgeFromObservation({
      id: row.id,
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: row.subject_ref,
      technicianId: null,
      context: row.context,
      question: 'should not land',
    });
    expect(nudge).toBeNull(); // uq_nudges_subject_ever holds
  });

  test('ONE id, TWO stages, ONE history: pre-ask and post-ask decisions come back under one key', async () => {
    // The same-id design's whole payoff (plan 2026-08-31): a dismiss recorded
    // against the OBSERVATION and an extend recorded against the NUDGE — same
    // uuid — are one gap's history. Written through the real writer, read
    // through the real reader; no unit stub could prove the FK/or() plumbing.
    const row = await mkObservation();
    await recordNudgeDecisions([
      {
        tenantId,
        nudgeId: row.id,
        subject: 'observation',
        mode: 'live',
        action: 'dismiss',
        confidence: 'high',
        reason: 'pre-ask stage',
        outcome: 'applied',
      },
    ]);
    const sent = await createNudgeFromObservation({
      id: row.id,
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: row.subject_ref,
      technicianId: null,
      context: row.context,
      question: 'the ask stage begins',
    });
    expect(sent?.id).toBe(row.id);
    await recordNudgeDecisions([
      {
        tenantId,
        nudgeId: row.id,
        mode: 'live',
        action: 'extend',
        confidence: 'high',
        reason: 'post-ask stage',
        outcome: 'applied',
      },
    ]);
    const history = await listDecisionsForNudges(tenantId, [row.id]);
    const rows = history.get(row.id) ?? [];
    expect(rows.map((r) => r.action)).toEqual(['dismiss', 'extend']); // oldest first, ONE key
    expect(rows[0].observation_id).toBe(row.id);
    expect(rows[0].nudge_id).toBeNull();
    expect(rows[1].nudge_id).toBe(row.id);
    // And the recall path spans both stages too.
    const recall = await listDecisionsForNudge(tenantId, row.id);
    expect(recall.map((r) => r.action)).toEqual(['extend', 'dismiss']); // newest first
  });

  test('ACL posture: RLS on, anon/authenticated hold zero privileges', async () => {
    const rls = await pg.query(`select relrowsecurity from pg_class where relname = 'observations'`);
    expect(rls.rows[0]?.relrowsecurity).toBe(true);
    const priv = await pg.query(
      `select has_table_privilege('anon', 'public.observations', 'SELECT') as a_sel,
              has_table_privilege('anon', 'public.observations', 'INSERT') as a_ins,
              has_table_privilege('authenticated', 'public.observations', 'SELECT') as u_sel,
              has_table_privilege('authenticated', 'public.observations', 'UPDATE') as u_upd`,
    );
    expect(Object.values(priv.rows[0]).some(Boolean)).toBe(false);
    // The view is spine_reader's, not the public keys'.
    const view = await pg.query(
      `select has_table_privilege('spine_reader', 'public.v_observations', 'SELECT') as r,
              has_table_privilege('anon', 'public.v_observations', 'SELECT') as a,
              has_table_privilege('authenticated', 'public.v_observations', 'SELECT') as u`,
    );
    expect(view.rows[0].r).toBe(true);
    expect(view.rows[0].a).toBe(false);
    expect(view.rows[0].u).toBe(false);
  });
});

// ---- Rung 10: the two markers ---------------------------------------------
//
// `pinged_at` = the planner was CALLED about this row; `asked_at` = a message
// actually went out. They are separate so a planner that reads an item and
// decides to WAIT has not consumed the ask, and so the focused pass and the
// half-hourly heartbeat can never both text a manager about one call.
describe('the ping markers (rung 10)', () => {
  const mkInbound = async (kind: 'inbound_new_job' | 'inbound_commitment' = 'inbound_new_job') => {
    const row = await createObservation({
      tenantId,
      kind,
      subjectRef: subject(),
      technicianId: null,
      context: { words: 'they called' },
    });
    if (!row) throw new Error('fixture create returned null');
    createdIds.push(row.id);
    return row;
  };
  const mine = (rows: { id: string }[], ids: string[]) => rows.filter((r) => ids.includes(r.id));

  test('PINGED_KINDS names the kinds the loop watches — kind-blind helpers, one list', () => {
    expect(PINGED_KINDS).toEqual(['inbound_new_job', 'inbound_commitment']);
  });

  test('captureHasObservation is the write-path’s processed marker', async () => {
    const row = await mkInbound();
    expect(await captureHasObservation(row.subject_ref)).toBe(true);
    expect(await captureHasObservation('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  test('the unpinged read finds open, unpinged, unasked rows of these kinds only', async () => {
    const fresh = await mkInbound();
    const committed = await mkInbound('inbound_commitment');
    const other = await mkObservation(); // an overdue_visit_gap — not this loop's
    const rows = await listUnpingedObservations(PINGED_KINDS, 1000);
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(fresh.id);
    expect(ids).toContain(committed.id);
    expect(ids).not.toContain(other.id);
    // Oldest first — the loop drains in the order the calls arrived.
    const times = rows.map((r) => r.noticed_at);
    expect([...times].sort()).toEqual(times);
  });

  test('a claim is exclusive: the second worker gets null, and the row leaves the read', async () => {
    const row = await mkInbound();
    const claimed = await claimObservationPing(row.id);
    expect(claimed?.id).toBe(row.id);
    expect(claimed?.pinged_at).not.toBeNull();
    expect(await claimObservationPing(row.id)).toBeNull(); // somebody else has it
    const rows = await listUnpingedObservations(PINGED_KINDS, 1000);
    expect(rows.map((r) => r.id)).not.toContain(row.id);
  });

  test('the ask is once: a stamp the first time, null after, and not_before is set', async () => {
    const row = await mkInbound();
    const notBefore = new Date(Date.now() + 86_400_000).toISOString();
    const stamp = await markObservationAsked(row.id, notBefore);
    expect(stamp).not.toBeNull();
    expect(await markObservationAsked(row.id, notBefore)).toBeNull(); // never twice
    // `new Date(...)`, not Date.parse: node-postgres hands back a Date object
    // for timestamptz, and Date.parse would stringify it and lose the
    // milliseconds — the two sides would differ by up to 999ms at random.
    const { rows } = await pg.query<{ asked_at: Date; not_before: Date }>(
      'select asked_at, not_before from observations where id = $1',
      [row.id],
    );
    expect(new Date(rows[0].asked_at).getTime()).toBe(Date.parse(stamp as string));
    expect(new Date(rows[0].not_before).getTime()).toBe(Date.parse(notBefore));
    // An asked row is out of the loop's read as surely as a pinged one.
    expect(mine(await listUnpingedObservations(PINGED_KINDS, 1000), [row.id])).toHaveLength(0);
  });

  test('a dismissed row cannot be asked about — the guard names the status too', async () => {
    const row = await mkInbound();
    await setObservationStatus(row.id, tenantId, { status: 'dismissed' }, ['open']);
    expect(await markObservationAsked(row.id, new Date().toISOString())).toBeNull();
  });

  test('the compensation clears ONLY its own stamp — a failed send must not eat a later ask', async () => {
    const row = await mkInbound();
    const stamp = (await markObservationAsked(row.id, new Date().toISOString())) as string;
    // Somebody else's stamp: refused silently, the ask stands.
    await clearObservationAsked(row.id, new Date(Date.parse(stamp) - 5000).toISOString());
    const still = await pg.query('select asked_at from observations where id = $1', [row.id]);
    expect(still.rows[0].asked_at).not.toBeNull();
    // Its own: cleared, so the row can be asked about again.
    await clearObservationAsked(row.id, stamp);
    const cleared = await pg.query('select asked_at from observations where id = $1', [row.id]);
    expect(cleared.rows[0].asked_at).toBeNull();
    expect(await markObservationAsked(row.id, new Date().toISOString())).not.toBeNull();
  });

  test('the heartbeat’s best-effort stamp never overwrites a real claim', async () => {
    const shown = await mkInbound();
    const claimed = await mkInbound();
    const first = await claimObservationPing(claimed.id);
    await stampObservationsPinged([shown.id, claimed.id]);
    const { rows } = await pg.query<{ id: string; pinged_at: Date }>(
      'select id, pinged_at from observations where id = any($1::uuid[])',
      [[shown.id, claimed.id]],
    );
    const byId = new Map(rows.map((r) => [r.id, r.pinged_at]));
    expect(byId.get(shown.id)).not.toBeNull();
    expect(new Date(byId.get(claimed.id) as Date).getTime()).toBe(
      Date.parse(first?.pinged_at as string),
    );
  });

  test('an empty id list is a no-op, and an empty kind list reads nothing', async () => {
    await expect(stampObservationsPinged([])).resolves.toBeUndefined();
    expect(await listUnpingedObservations([], 10)).toEqual([]);
  });
});
