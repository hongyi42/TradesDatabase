import { describe, expect, test } from 'vitest';
import { gradeScenario, investigationStats, type GradableRow } from './plannerEvalGraders2.js';
import type { NudgeDecision, Nudge } from '../db/index.js';

// Pure-fixture tests: one passing row, then one per failure kind. The fixtures
// build only the fields the graders read (cast at the edges) — a grader that
// starts reading a new field will fail loudly here, which is the point.

const T0 = Date.parse('2026-08-24T17:00:00.000Z');
const GAP = '11111111-1111-1111-1111-111111111111';
const GAP2 = '22222222-2222-2222-2222-222222222222';

const decision = (over: Partial<NudgeDecision>): NudgeDecision =>
  ({
    id: 'd',
    nudge_id: GAP,
    action: 'escalate',
    outcome: 'applied',
    reason: 'silence held all day',
    handoff_note: null,
    question_draft: null,
    decided_at: new Date(T0).toISOString(),
    ...over,
  }) as NudgeDecision;

const nudge = (over: Partial<Nudge>): Nudge =>
  ({ id: GAP, status: 'escalated', resolved_at: new Date(T0).toISOString(), ...over }) as Nudge;

const call = (name: string, ok = true, args: Record<string, unknown> = {}) => ({
  turn: 1,
  name,
  args,
  ok,
  result: '',
});

const row = (over: Partial<GradableRow>): GradableRow => ({
  id: 'FIX',
  seeded: { nudgeIds: { gap: GAP } },
  ticks: [
    {
      nowIso: new Date(T0).toISOString(),
      decisions: [decision({})],
      toolCalls: [call('recall_decisions'), call('submit_plan')],
      nudgesAfter: [nudge({})],
    },
  ],
  ...over,
});

const kinds = (r: GradableRow, e: GradableRow['expect']) =>
  gradeScenario({ ...r, expect: e }, T0).map((f) => f.kind);

describe('gradeScenario — one fixture per failure kind', () => {
  test('a conforming row passes everything at once', () => {
    const r = row({});
    expect(
      kinds(r, {
        action: 'escalate',
        actionNot: 'close',
        mustName: ['silence'],
        mustNotClaim: ['nothing on record'],
        mustRead: { tool: 'recall_decisions' },
        arc: { maxEscalations: 1, maxCloses: 0, closedBy: '+1h', noWhiplash: true },
      }),
    ).toEqual([]);
  });

  test('harness errors short-circuit', () => {
    expect(kinds(row({ harnessError: 'boom' }), { action: 'close' })).toEqual(['harness-error']);
  });

  test('wrong-action: expected verb absent or unapplied', () => {
    expect(kinds(row({}), { action: 'close' })).toEqual(['wrong-action']);
    const refused = row({});
    refused.ticks[0].decisions = [decision({ outcome: 'refused' })];
    expect(kinds(refused, { action: 'escalate' })).toEqual(['wrong-action']);
  });

  test('forbidden-action counts rail-refused ATTEMPTS', () => {
    const r = row({});
    r.ticks[0].decisions = [decision({ action: 'extend', outcome: 'refused' })];
    expect(kinds(r, { actionNot: 'extend' })).toEqual(['forbidden-action']);
  });

  test('claims: false-claim and missing-name grade the LAST tick only', () => {
    const r = row({});
    r.ticks = [
      {
        ...r.ticks[0],
        decisions: [decision({ reason: 'nothing on record yet — early tick honesty' })],
      },
      {
        ...r.ticks[0],
        decisions: [decision({ handoff_note: 'Sump pump service (Priya) needs a decision.' })],
      },
    ];
    expect(kinds(r, { mustNotClaim: ['nothing on record'] })).toEqual([]); // tick 1 not graded
    expect(kinds(r, { mustName: ['sump pump'] })).toEqual([]);
    expect(kinds(r, { mustName: ['boiler'] })).toEqual(['missing-name']);
    r.ticks[1].decisions = [decision({ handoff_note: 'Nothing on record for this job.' })];
    expect(kinds(r, { mustNotClaim: ['nothing on record'] })).toEqual(['false-claim']);
  });

  test('missing-read: tool, success, and argContains all matter', () => {
    const r = row({});
    r.ticks[0].toolCalls = [call('spine_read', true, { sql: 'select * from v_review_items' })];
    expect(kinds(r, { mustRead: { tool: 'spine_read', argContains: 'review_items' } })).toEqual([]);
    expect(kinds(r, { mustRead: { tool: 'recall_decisions' } })).toEqual(['missing-read']);
    r.ticks[0].toolCalls = [call('spine_read', false, { sql: 'v_review_items' })];
    expect(kinds(r, { mustRead: { tool: 'spine_read' } })).toEqual(['missing-read']);
  });

  test('lessonCited both directions', () => {
    const cited = row({});
    cited.ticks[0].decisions = [decision({ reason: 'batching per [abcd1234]' })];
    expect(kinds(cited, { lessonCited: true })).toEqual([]);
    expect(kinds(cited, { lessonCited: false })).toEqual(['lesson-cited-for-show']);
    expect(kinds(row({}), { lessonCited: true })).toEqual(['lesson-not-cited']);
  });

  test('arc caps: escalations, closes, cross-credit spread', () => {
    const r = row({});
    r.ticks = [
      { ...r.ticks[0], decisions: [decision({ action: 'close', citation: 'x' } as never)] },
      {
        ...r.ticks[0],
        decisions: [
          decision({ id: 'd2', nudge_id: GAP2, action: 'close' }),
          decision({ id: 'd3', action: 'escalate' }),
        ],
      },
    ];
    r.seeded = { nudgeIds: { a: GAP, b: GAP2 } };
    expect(kinds(r, { arc: { maxEscalations: 0 } })).toEqual(['arc-escalations']);
    expect(kinds(r, { arc: { maxCloses: 1 } })).toEqual(['arc-closes']);
    expect(kinds(r, { arc: { minCloseTicks: 2 } })).toEqual([]); // closes on 2 ticks
    r.ticks[0].decisions = [];
    r.ticks[1].decisions.push(decision({ id: 'd4', action: 'close' }));
    expect(kinds(r, { arc: { minCloseTicks: 2 } })).toEqual(['arc-cross-credit']);
  });

  test('arc closedBy: open past the deadline and late closes both fail', () => {
    const open = row({});
    open.ticks[0].nudgesAfter = [nudge({ status: 'asked', resolved_at: null })];
    expect(kinds(open, { arc: { closedBy: '+1h' } })).toEqual(['arc-not-closed']);
    const late = row({});
    late.ticks[0].nudgesAfter = [
      nudge({ resolved_at: new Date(T0 + 2 * 3_600_000).toISOString() }),
    ];
    expect(kinds(late, { arc: { closedBy: '+1h' } })).toEqual(['arc-closed-late']);
  });

  test('arc escalations are SWEEP-AWARE: a gap ending escalated with no planner escalate counts', () => {
    const r = row({});
    r.ticks[0].decisions = []; // planner said nothing
    r.ticks[0].nudgesAfter = [nudge({ status: 'escalated' })]; // sweep handed it off
    expect(kinds(r, { arc: { maxEscalations: 0 } })).toEqual(['arc-escalations']);
    // ...but a planner-authored escalate on the same gap is counted ONCE.
    const r2 = row({});
    r2.ticks[0].decisions = [decision({ action: 'escalate' })];
    r2.ticks[0].nudgesAfter = [nudge({ status: 'escalated' })];
    expect(kinds(r2, { arc: { maxEscalations: 1 } })).toEqual([]);
  });

  test('arc whiplash: extend after escalate across ticks', () => {
    const r = row({});
    r.ticks = [
      { ...r.ticks[0], decisions: [decision({ action: 'escalate' })] },
      { ...r.ticks[0], decisions: [decision({ id: 'd2', action: 'extend' })] },
    ];
    expect(kinds(r, { arc: { noWhiplash: true } })).toEqual(['arc-whiplash']);
  });

  test('nudgeKey narrows grading; unmentioned rows are never decisions', () => {
    const r = row({});
    r.seeded = { nudgeIds: { a: GAP, b: GAP2 } };
    r.ticks[0].decisions = [
      decision({ action: 'close', nudge_id: GAP2 }),
      decision({ id: 'u', action: 'unmentioned' }),
    ];
    expect(kinds(r, { nudgeKey: 'a', actionNot: 'close' })).toEqual([]); // b closed, a graded
    expect(kinds(r, { nudgeKey: 'b', actionNot: 'close' })).toEqual(['forbidden-action']);
    expect(kinds(r, { nudgeKey: 'a', action: 'leave' })).toEqual(['wrong-action']); // unmentioned ≠ leave
  });

  test('investigationStats counts successful non-submit reads and real decisions', () => {
    const r = row({});
    r.ticks[0].toolCalls = [call('spine_read'), call('spine_read', false), call('submit_plan')];
    r.ticks[0].decisions = [decision({}), decision({ id: 'u', action: 'unmentioned' })];
    expect(investigationStats(r)).toEqual({ reads: 1, decisions: 1 });
  });
});
