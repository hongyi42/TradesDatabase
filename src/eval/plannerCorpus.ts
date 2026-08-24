// The agentic planner eval's scenario corpus (plan 2026-08-24).
//
// Phase 1 ships the SHAPE and two smoke scenarios; Phase 3 fills the corpus
// (~60 scenarios across the failure families). Every scenario is a seeded
// world + a timeline + expectations stated as facts, and every `why` cites its
// provenance — a documented specimen, a user ruling, or a metric definition —
// because a corpus is a record, not folklore.

import type { Offset, ScenarioWorld, SimMoneyKind } from './plannerSim.js';

// A scenario's life, as ordered steps at offsets from t0 (monotonic — runArc
// throws on a backwards clock). 'tick' runs sweep+planner; the event kinds
// simulate the world moving between ticks:
//   capture         — a note lands on the scenario's job (append-only L1)
//   money           — a ledger row lands on the job
//   deliver         — the ask goes OUT: pending/queued → asked. Compose and
//                     the box are out of the eval loop, so nothing else moves
//                     a row to 'asked'; without this, send/hold arcs stall
//                     until the 18h expiry.
//   manager_resolve — the manager settles the review item citing the gap.
//                     Also what lets an escalated arc's gap-summary epilogue
//                     escape the 7-day holdback (summarize.ts:118-124).
export type TimelineStep =
  | {
      at: Offset;
      kind: 'tick';
      /** Declared when a tick deliberately lands outside the ask window. */
      expectWindowSkip?: boolean;
    }
  | { at: Offset; kind: 'capture'; text: string; fromTechnician?: boolean }
  | { at: Offset; kind: 'money'; moneyKind: SimMoneyKind; amountCents?: number | null }
  | { at: Offset; kind: 'deliver'; nudgeKey: string }
  | {
      at: Offset;
      kind: 'manager_resolve';
      nudgeKey: string;
      outcome: 'resolved' | 'dismissed';
      note?: string;
    };

export interface ScenarioExpect {
  /** Which gap the expectation grades. Default: the world's sole nudge key —
   *  multi-gap scenarios MUST name one (ambiguous otherwise). */
  nudgeKey?: string;
  /** Expected action on the FINAL tick's decision for the named nudge key. */
  action?: string;
  actionNot?: string;
  /** Substrings the decision's note/reason must (not) contain — grading is
   *  Phase 4; carried on the scenario from the start so authoring and grading
   *  share one vocabulary. */
  mustName?: string[];
  mustNotClaim?: string[];
}

export interface PlannerScenario {
  id: string;
  family: string;
  /** Provenance: which specimen, ruling, or metric definition this encodes. */
  why: string;
  world: ScenarioWorld;
  timeline: TimelineStep[];
  expect?: ScenarioExpect;
}

// ── smoke scenarios (Phase 1) ────────────────────────────────────────────────

export const SMOKE_SCENARIOS: PlannerScenario[] = [
  {
    id: 'SMOKE-1',
    family: 'smoke',
    why:
      'Harness proof: an asked visit gap with a watched history. The history line ends with ' +
      '"Use recall_decisions for the detail", so deciding well invites a real read; the ' +
      'seeded escalate_after keeps the sweep from eating the gap before the planner sees it.',
    world: {
      customer: { name: 'Marisol Duarte' },
      job: { title: 'Tankless descaling', status: 'in_progress' },
      technician: { ref: 'smoke-ben', name: 'Ben Shelton' },
      // 'confirmed', NOT 'completed': the visit spec's `moot` closes a gap
      // whose visit reads cancelled/completed — production's open visit gaps
      // sit on visits still confirmed, and so must seeded ones.
      visit: { startsAt: '-32h', endsAt: '-30.5h' },
      nudges: [
        {
          key: 'gap',
          kind: 'overdue_visit_gap',
          status: 'asked',
          createdAt: '-31h',
          askedAt: '-30h',
          // A prior extend moved the deadline PAST the first tick — without it
          // the sweep escalates a 30h-old ask before the planner ever runs.
          escalateAfter: '+2h',
          question: 'How did the descaling at Marisol Duarte go? Anything worth noting down?',
        },
      ],
      history: [
        { at: '-20h', nudgeKey: 'gap', action: 'leave', outcome: 'applied', reason: 'early yet' },
        {
          at: '-8h',
          nudgeKey: 'gap',
          action: 'extend',
          outcome: 'applied',
          reason: 'end of working day; give the morning a chance',
          escalateAfter: '+2h',
        },
      ],
      // Post-ask, answers a DIFFERENT question — it renders into the block's
      // evidence list (and exercises the capture-seeding path end to end),
      // while a good decision still has to judge that it answers nothing.
      evidence: [
        { at: '-4h', text: 'Dropped the spare cartridges at the shop, van is restocked.' },
      ],
    },
    timeline: [{ at: '+0h', kind: 'tick' }],
  },
  {
    id: 'SMOKE-2',
    family: 'smoke',
    why:
      'Harness proof, money in the block: the 2026-08-19 Tankless specimen shape — a payment ' +
      'landed after the ask, so whatever the decision, a "nothing on record" claim is false.',
    world: {
      customer: { name: 'Henderson Family' },
      job: { title: 'Boiler swap', status: 'completed' },
      technician: { ref: 'smoke-priya', name: 'Priya Natarajan' },
      visit: { startsAt: '-26h', endsAt: '-24h', status: 'completed' },
      nudges: [
        {
          key: 'gap',
          kind: 'job_cost_gap',
          status: 'asked',
          createdAt: '-9h',
          askedAt: '-8h',
          question: 'What did the boiler swap run in parts and materials?',
        },
      ],
      money: [{ at: '-4h', kind: 'payment_received', amountCents: 50_000 }],
    },
    timeline: [{ at: '+0h', kind: 'tick' }],
    expect: { mustNotClaim: ['nothing has', 'no record', 'nothing is on'] },
  },
  {
    id: 'ARC-SMOKE',
    family: 'smoke',
    why:
      'Harness proof, multi-tick: a cost gap whose LEDGER fills between ticks. Tick 1 sees an ' +
      'open hole; a material_cost lands mid-arc; tick 2’s THE RECORD line then authorizes a ' +
      'record-basis close — the code-computed fact doctrine, moving under the model’s feet.',
    world: {
      customer: { name: 'Ivan Petrov' },
      job: { title: 'Furnace igniter replacement', status: 'completed' },
      technician: { ref: 'smoke-dee', name: 'Dee Marsh' },
      visit: { startsAt: '-8h', endsAt: '-6h', status: 'completed' },
      nudges: [
        {
          key: 'gap',
          kind: 'job_cost_gap',
          status: 'asked',
          createdAt: '-3h',
          askedAt: '-2h',
          question: 'What did the igniter job run in parts?',
        },
      ],
    },
    timeline: [
      { at: '+0h', kind: 'tick' },
      { at: '+1h', kind: 'money', moneyKind: 'material_cost', amountCents: 8_500 },
      { at: '+1.5h', kind: 'tick' },
    ],
    expect: { action: 'close' },
  },
];

export const ALL_SCENARIOS: PlannerScenario[] = [...SMOKE_SCENARIOS];
