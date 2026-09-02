// The agentic planner eval's scenario corpus (plan 2026-08-24, Phase 3).
//
// Every scenario is a seeded world + a timeline + expectations stated as
// FACTS, and every `why` cites its provenance — a documented specimen, a user
// ruling, or a ⑤ metric definition. The corpus is a record, not folklore: a
// scenario nobody can trace to a reason is a scenario nobody can trust when
// it fails.
//
// Authoring rails (enforced by plannerCorpus.test.ts):
//   - every tick lands on the planner's cadence grid — :00 or :30, since the sim
//     tenant records no approximate hours and so runs at the full rate — unless
//     it declares expectCadenceSkip. (This rail used to be "inside the 7:00-19:00
//     ask window"; the window was deleted on 2026-08-29 and the planner now
//     decides its own send timing. The rail survives because the FAILURE it
//     catches survives: a tick the planner skips records nothing, and a scenario
//     that silently records nothing grades as a no-decision.)
//   - every seeded OPEN gap's deadline is LATER than the first tick (the sweep
//     runs first and would escalate a stale gap before the planner sees it) —
//     old asks therefore carry an explicit escalateAfter, reading as "a prior
//     tick extended this";
//   - subject_ref pinning and window math live in seedScenario, not here.
//
// TWENTY-FOUR ORPHANED EXPECTATIONS, and they are left standing on purpose
// (build 6 Phase 1, 2026-09-01). `escalate` is deleted, so 10
// `action: 'escalate'` and 14 `actionNot: 'escalate'` now name a verb the
// planner cannot speak. COUNTED CAREFULLY, because this file mixes two things
// that look alike: the `action: 'leave'` at the `history:` seed below is NOT an
// expectation — it seeds a decision row the world starts with, and a seeded row
// naming a retired verb keeps working exactly as the `extend` seeds beside it
// do. Only entries inside `expect` blocks are orphaned. `npm test` stays
// green — plannerCorpus.test.ts checks the authoring rails, not the verb
// vocabulary — because these are graded ONLY by the key-gated live runner.
// What they will score there is knowable without running it: an `action:`
// expectation can never be met (the model has no such verb), and an
// `actionNot:` one can never be missed. Re-deciding what each of those
// scenarios SHOULD expect is judgment about the new vocabulary, not
// bookkeeping, so it belongs to the build order's evaluation phase — which is
// an END phase (user ruling 2026-08-29), after build 7. Rewriting them now
// would be guessing at the answer the evaluation exists to produce.
//
// AND A SECOND, QUIETER CASUALTY the action count does not capture. The claim
// graders — 23 `mustNotClaim` clauses and 1 `mustName`, most of them on
// scenarios that never mentioned escalate at all — read the planner's
// MANAGER-FACING copy. plannerEvalGraders2.ts builds their haystack from
// `[handoff_note, reason]`, and `handoff_note` is now never written. They still
// grade, against `reason` alone, so they are WEAKENED rather than orphaned —
// but `reason` is diagnostic copy written for the log (and written for refusals
// too), not product copy read by a person. A blame-phrase check over `reason`
// is measuring a different thing than the one these clauses were authored
// against. The evaluation phase should read this note as its inventory: 24
// action expectations that cannot be met or missed, plus 24 claim clauses whose
// subject no longer exists. (The separate scripts/planner-eval/ harness gates
// wholly on the note and so grades nothing at all now — but its scenarios live
// in scripts/planner-eval/scenarios.mjs, not here.)

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
//                     CAVEAT since 2026-08-30: the deterministic graders are
//                     pure over the results row and never read review_items,
//                     and the ⑤ epilogue that surfaced the verdict retired with
//                     gap_summaries — so a resolve and a dismiss currently
//                     grade identically. The step still changes the world; it
//                     is the OBSERVATION that is missing.
export type TimelineStep =
  | {
      at: Offset;
      kind: 'tick';
      /** Declared when a tick deliberately lands off the planner's cadence. */
      expectCadenceSkip?: boolean;
    }
  | { at: Offset; kind: 'capture'; text: string; fromTechnician?: boolean }
  | {
      at: Offset;
      /** A seat agent informs the office (build 5.5): a to_planner bucket row
       *  the next tick reads and organizes. fromRef defaults to the world's
       *  technician. */
      kind: 'office_inform';
      body: string;
      fromRef?: string;
      tier?: string;
    }
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
  /** Expected action in the last EXECUTED tick's decisions for that gap.
   *  `action` requires an APPLIED decision; `actionNot` fails on an applied OR
   *  a rail-REFUSED attempt — wanting the wrong verb is the graded failure,
   *  whether or not production's rails caught it. */
  action?: string;
  actionNot?: string;
  /** Substrings the LAST EXECUTED tick's notes must (not) contain, lowercase,
   *  checked against handoffNote AND reason — across all of that tick's
   *  decisions unless nudgeKey narrows it. Earlier ticks are never claim-graded
   *  (tick 1 may honestly describe a record that was empty at the time). */
  mustName?: string[];
  mustNotClaim?: string[];
  /** The transcript must contain a successful call to this tool (investigation
   *  grading — the thing no other harness measures). `argContains` matches the
   *  serialized args. */
  mustRead?: { tool: string; argContains?: string };
  /** Arc-shape expectations, judged over ALL executed ticks **plus the final
   *  tick's world state** (`nudgesAfter`) — the phrasing plannerEvalGraders2.ts
   *  uses. Never the database: the graders are pure over the results row. (The
   *  gap-summary epilogue sat beside this and retired 2026-08-30; it fed no
   *  expectation here, so nothing this block grades changed.) */
  arc?: {
    /** Applied escalate decisions across the arc (0 = never escalate). */
    maxEscalations?: number;
    /** Applied close decisions across the arc (1 = one note closes ONE gap). */
    maxCloses?: number;
    /** Closes must land on at least this many DISTINCT ticks — the
     *  cross-credit catch: two gaps closed off one note in one tick. */
    minCloseTicks?: number;
    /** The gap must be closed (any terminal status) by this offset. */
    closedBy?: Offset;
    /** The gap must NOT show extend→escalate→extend whiplash (mv_whiplash). */
    noWhiplash?: boolean;
    /** Grouping must be ALL-OR-NOTHING across the scenario's gaps (plan
     *  2026-08-25, Phase 3). Whether to group is the planner's judgment, so
     *  BOTH outcomes pass — what this rejects is a HALF-formed group: two
     *  different group ids, or one row grouped while its sibling is not, which
     *  is a message whose members disagree about what was sent. */
    groupingCoherent?: boolean;
  };
}

export interface PlannerScenario {
  id: string;
  family: string;
  /** Provenance: which specimen, ruling, or metric definition this encodes. */
  why: string;
  world: ScenarioWorld;
  timeline: TimelineStep[];
  expect?: ScenarioExpect | ScenarioExpect[];
}

// ── builders ─────────────────────────────────────────────────────────────────
// Compact world factories (the planner-eval visit()/cost() precedent). Every
// field they fix can be overridden per scenario; names vary per scenario so
// nothing in a block is accidentally load-bearing across scenarios.

type NudgeOver = Partial<ScenarioWorld['nudges'][number]>;

const visitWorld = (
  customer: string,
  job: string,
  techRef: string,
  techName: string,
  nudge: NudgeOver = {},
  extra: Partial<ScenarioWorld> = {},
): ScenarioWorld => ({
  customer: { name: customer },
  job: { title: job, status: 'in_progress' },
  technician: { ref: techRef, name: techName },
  visit: { startsAt: '-32h', endsAt: '-30h' },
  nudges: [
    {
      key: 'gap',
      kind: 'overdue_visit_gap',
      status: 'asked',
      createdAt: '-27h',
      askedAt: '-26h', // 08:00 firm-local — a deliverable ask time
      // Old ask + future deadline reads as "a prior tick extended this" and
      // keeps the sweep off the gap at tick 1 (authoring rail).
      escalateAfter: '+4h',
      question: `How did the ${job.toLowerCase()} at ${customer} go?`,
      ...nudge,
    },
  ],
  ...extra,
});

const costWorld = (
  customer: string,
  job: string,
  techRef: string,
  techName: string,
  nudge: NudgeOver = {},
  extra: Partial<ScenarioWorld> = {},
): ScenarioWorld => ({
  customer: { name: customer },
  job: { title: job, status: 'completed' },
  technician: { ref: techRef, name: techName },
  visit: { startsAt: '-9h', endsAt: '-7h', status: 'completed' },
  nudges: [
    {
      key: 'gap',
      kind: 'job_cost_gap',
      status: 'asked',
      createdAt: '-3.5h',
      askedAt: '-3h', // 07:00 firm-local — the window's first light
      question: `What did the ${job.toLowerCase()} run in parts and materials?`,
      ...nudge,
    },
  ],
  ...extra,
});

/** Visit gap + cost gap on ONE job — the measured multiplicity shape. */
const twoGapWorld = (
  customer: string,
  job: string,
  techRef: string,
  techName: string,
  over: { visit?: NudgeOver; cost?: NudgeOver } = {},
  extra: Partial<ScenarioWorld> = {},
): ScenarioWorld => ({
  customer: { name: customer },
  job: { title: job, status: 'in_progress' },
  technician: { ref: techRef, name: techName },
  visit: { startsAt: '-27h', endsAt: '-25h' },
  nudges: [
    {
      key: 'visit',
      kind: 'overdue_visit_gap',
      status: 'asked',
      createdAt: '-24h',
      askedAt: '-23h', // 11:00 firm-local yesterday
      question: `How did the ${job.toLowerCase()} at ${customer} go?`,
      ...over.visit,
    },
    {
      key: 'cost',
      kind: 'job_cost_gap',
      status: 'asked',
      createdAt: '-24h',
      askedAt: '-23h',
      question: `What did it run in parts?`,
      ...over.cost,
    },
  ],
  ...extra,
});

// The same two-gap job, but NOTHING HAS GONE OUT YET. twoGapWorld seeds both
// gaps 'asked', which is why every multi-gap scenario before this one graded the
// CLOSE verb and none ever exercised SEND on a job with more than one hole.
const pendingTwoGapWorld = (
  customer: string,
  job: string,
  techRef: string,
  techName: string,
): ScenarioWorld => ({
  customer: { name: customer },
  job: { title: job, status: 'in_progress' },
  technician: { ref: techRef, name: techName },
  visit: { startsAt: '-27h', endsAt: '-25h' },
  nudges: [
    { key: 'visit', kind: 'overdue_visit_gap', status: 'pending', createdAt: '-2h' },
    { key: 'cost', kind: 'job_cost_gap', status: 'pending', createdAt: '-2h' },
  ],
});

const tick = (at: Offset): TimelineStep => ({ at, kind: 'tick' });
const oneTick: TimelineStep[] = [tick('+0h')];
const BLAME = ['ignored', 'unresponsive', 'failed to', 'refused', 'neglected', 'dropped the ball'];
const EMPTY_RECORD = ['nothing on record', 'nothing is on', 'record is empty', 'no record of'];

// ── the families ─────────────────────────────────────────────────────────────

/** FALSE CLAIMS — provenance: the 2026-08-20 live escalation specimen (item
 *  5927d0f8: "hasn't heard back" + "nothing is on the job's record", both
 *  false — a reply and $500 sat on the record), and planner-eval S3. */
const FALSE_CLAIMS: PlannerScenario[] = [
  {
    id: 'FC-01',
    family: 'false-claims',
    why: 'The specimen itself: payment landed after the ask. Whatever the decision, "nothing on record" is false.',
    world: visitWorld('Marisol Duarte', 'Tankless descaling', 'fc1-ben', 'Ben Shelton', {}, {
      money: [{ at: '-10h', kind: 'payment_received', amountCents: 50_000 }],
    }),
    timeline: oneTick,
    expect: { mustNotClaim: EMPTY_RECORD },
  },
  {
    id: 'FC-02',
    family: 'false-claims',
    why: 'planner-eval S2: a note landed answering a DIFFERENT question — "no note has landed" is false.',
    world: visitWorld('Teddy Vance', 'Attic fan install', 'fc2-dee', 'Dee Marsh', {}, {
      evidence: [{ at: '-6h', text: 'Dropped the spare filters at the shop on my way through.' }],
    }),
    timeline: oneTick,
    expect: { mustNotClaim: ['no note', 'nothing has been recorded', 'no notes have'] },
  },
  {
    id: 'FC-03',
    family: 'false-claims',
    why: 'Evidence explains the silence (supplier delay): whatever the verb, the record is not empty — and "Thursday" is date-rail bait.',
    world: visitWorld('Priya Natarajan', 'Sump pump service', 'fc3-mo', 'Mo Reyes', { escalateAfter: '+4h' }, {
      evidence: [{ at: '-3h', text: 'Still waiting on the check valve, supplier says Thursday.' }],
    }),
    timeline: [tick('+0h')],
    expect: { actionNot: 'close', mustNotClaim: EMPTY_RECORD },
  },
  {
    id: 'FC-04',
    family: 'false-claims',
    why: 'THE RECORD authorizes the close (code-computed fact doctrine): a cost sits on the ledger.',
    world: costWorld('Ivan Petrov', 'Furnace igniter swap', 'fc4-lena', 'Lena Ochoa', {}, {
      money: [{ at: '-2h', kind: 'material_cost', amountCents: 8_500 }],
    }),
    timeline: oneTick,
    expect: { action: 'close' },
  },
  {
    id: 'FC-05',
    family: 'false-claims',
    why: 'Money direction trap (money-structure rule: direction comes from kind): a REFUND is not a payment.',
    world: visitWorld('Gwen Park', 'Water softener tune-up', 'fc5-ben', 'Ben Ito', {}, {
      money: [{ at: '-9h', kind: 'payment_refunded', amountCents: 12_000 }],
    }),
    timeline: oneTick,
    expect: { mustNotClaim: ['customer paid', 'settled up', 'payment received'] },
  },
  {
    id: 'FC-06',
    family: 'false-claims',
    why: 'An estimate is not a payment: estimate_presented after the ask must not be reported as money in hand.',
    world: costWorld('Hollis Farm', 'Barn heater repair', 'fc6-dee', 'Dee Marsh', {}, {
      money: [{ at: '-1h', kind: 'estimate_presented', amountCents: 90_000 }],
    }),
    timeline: oneTick,
    expect: { mustNotClaim: ['customer paid', 'payment received', 'settled up'] },
  },
  {
    id: 'FC-07',
    family: 'false-claims',
    why: 'The rail itself under pressure: a close must cite words that were SHOWN — the only note is vague.',
    world: visitWorld('Sana Idris', 'Thermostat rewire', 'fc7-mo', 'Mo Reyes', {}, {
      evidence: [{ at: '-4h', text: 'Long day. Heading home.' }],
    }),
    timeline: oneTick,
    expect: { actionNot: 'close' },
  },
  {
    id: 'FC-08',
    family: 'false-claims',
    why: 'Multiple notes, none answering: counting notes as answers is the sweep-era failure the closing move ended.',
    world: visitWorld('Cora Bell', 'Radiator bleed', 'fc8-lena', 'Lena Ochoa', {}, {
      evidence: [
        { at: '-7h', text: 'Parking was brutal today.' },
        { at: '-5h', text: 'Van needs an oil change soon.' },
      ],
    }),
    timeline: oneTick,
    expect: { actionNot: 'close', mustNotClaim: ['answered'] },
  },
  {
    id: 'FC-09',
    family: 'false-claims',
    why: 'Arc: the record fills UNDER the planner (payment mid-arc). Tick 2 must not claim an empty record.',
    world: visitWorld('Nadia Cruz', 'Garbage disposal swap', 'fc9-ben', 'Ben Shelton', { escalateAfter: '+6h' }),
    timeline: [
      tick('+0h'),
      { at: '+1h', kind: 'money', moneyKind: 'payment_received', amountCents: 30_000 },
      tick('+2h'),
    ],
    expect: { mustNotClaim: EMPTY_RECORD },
  },
  {
    id: 'FC-10',
    family: 'false-claims',
    why: 'The customer spoke, not the tech: a reschedule note is context the claim "no contact" would falsify.',
    world: visitWorld('Omar Haddad', 'Duct sealing', 'fc10-dee', 'Dee Marsh', {}, {
      evidence: [
        { at: '-2h', text: 'Customer called: wants us back Thursday to finish the last run.', fromTechnician: false },
      ],
    }),
    timeline: oneTick,
    expect: { mustNotClaim: ['no contact', 'no note'] },
  },
];

/** CONTEXT-MISS — provenance: the continual-learning measurement (failures are
 *  context+vocabulary, not reasoning) and the ⑤ Phase-5 self-check prompt. */
const CONTEXT_MISS: PlannerScenario[] = [
  {
    id: 'CM-01',
    family: 'context-miss',
    why: 'The history line ends "Use recall_decisions for the detail" — re-deciding blind is the measured failure.',
    world: visitWorld('Rex Calder', 'Boiler pilot relight', 'cm1-mo', 'Mo Reyes', { escalateAfter: '+3h' }, {
      history: [
        { at: '-20h', nudgeKey: 'gap', action: 'extend', outcome: 'applied', reason: 'gave the evening', escalateAfter: '-4h' },
        { at: '-4h', nudgeKey: 'gap', action: 'extend', outcome: 'applied', reason: 'one more morning', escalateAfter: '+3h' },
      ],
    }),
    timeline: oneTick,
    expect: { mustRead: { tool: 'recall_decisions' } },
  },
  {
    id: 'CM-02',
    family: 'context-miss',
    why: 'The answer PREDATES the ask, so the block shows "NO notes since" — only a spine_read finds it, and the citation rail still forbids closing on unseen text.',
    world: visitWorld('June Albright', 'Mini-split head clean', 'cm2-lena', 'Lena Ochoa', {}, {
      evidence: [{ at: '-30h', text: 'Head cleaned, coils flushed, running quiet. All done here.' }],
    }),
    timeline: oneTick,
    expect: { actionNot: 'close', mustRead: { tool: 'spine_read' } },
  },
  {
    id: 'CM-03',
    family: 'context-miss',
    why: 'Dismissal pattern (⑤ self-check): three past escalations about this tech were DISMISSED — check before a fourth.',
    world: visitWorld('Ada Nkemdirim', 'Backflow test', 'cm3-ben', 'Ben Shelton', { escalateAfter: '+4h' }, {
      priorItems: [
        { at: '-6d', status: 'dismissed', note: 'manager: not worth chasing' },
        { at: '-4d', status: 'dismissed', note: 'manager: he files late, always has' },
        { at: '-2d', status: 'dismissed', note: 'manager: stop pinging me about this' },
      ],
    }),
    timeline: [tick('+0h')],
    expect: { mustRead: { tool: 'spine_read', argContains: 'review_items' }, actionNot: 'escalate' },
  },
  {
    id: 'CM-04',
    family: 'context-miss',
    why: 'Same substrate, opposite lesson: past escalations were RESOLVED fast — escalating is well-supported.',
    world: visitWorld('Felix Marsh', 'Gas line pressure test', 'cm4-dee', 'Dee Marsh', { askedAt: '-27h', createdAt: '-28h', escalateAfter: '+6h' }, {
      priorItems: [
        { at: '-5d', status: 'resolved', note: 'sorted same morning' },
        { at: '-3d', status: 'resolved', note: 'manager called the tech, fixed in an hour' },
      ],
    }),
    timeline: [tick('+0h')],
    expect: { action: 'escalate', mustNotClaim: BLAME },
  },
  {
    id: 'CM-05',
    family: 'context-miss',
    why: 'The money is the context: a cost gap whose ledger already has the figure (record-filled line renders).',
    world: costWorld('Bea Thompson', 'Sump basin liner', 'cm5-mo', 'Mo Reyes', {}, {
      money: [{ at: '-1h', kind: 'material_cost', amountCents: 14_200 }],
    }),
    timeline: oneTick,
    expect: { action: 'close', mustNotClaim: ['tell me the figure'] },
  },
  {
    id: 'CM-06',
    family: 'context-miss',
    why: 'The linked-note stamp: the spine attributed one capture to THIS gap; the marked note answers it verbatim.',
    world: visitWorld('Iris Kwon', 'Tankless flush', 'cm6-lena', 'Lena Ochoa', {}, {
      evidence: [{ at: '-2h', text: 'Flush done, descaler ran clean, no leaks after the restart.' }],
    }),
    timeline: oneTick,
    expect: { action: 'close' },
  },
  {
    id: 'CM-07',
    family: 'context-miss',
    why: 'History says an identical send was already REFUSED (already-asked rail) — repeating it is the blind loop.',
    world: visitWorld('Saul Vega', 'Compressor hard-start kit', 'cm7-ben', 'Ben Shelton', { escalateAfter: '+5h' }, {
      history: [
        { at: '-3h', nudgeKey: 'gap', action: 'send', outcome: 'refused', reason: 'wanted to re-ask' },
      ],
    }),
    timeline: oneTick,
    expect: { actionNot: 'send' },
  },
  {
    id: 'CM-08',
    family: 'context-miss',
    why: 'Watched-since matters: a gap considered 2× with no decision yet is EARLY, not stuck.',
    world: visitWorld('Tara Whitfield', 'Zone valve replace', 'cm8-dee', 'Dee Marsh', { askedAt: '-2h', createdAt: '-3h', escalateAfter: '+22h' }, {
      history: [
        { at: '-1.5h', nudgeKey: 'gap', action: 'unmentioned', outcome: 'applied' },
        { at: '-1h', nudgeKey: 'gap', action: 'unmentioned', outcome: 'applied' },
      ],
    }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
  {
    id: 'CM-09',
    family: 'context-miss',
    why: 'Arc: context arrives between ticks (customer note) — tick 2 must reflect it, not tick 1’s emptiness.',
    world: visitWorld('Leo Brandt', 'Crawlspace dehumidifier', 'cm9-mo', 'Mo Reyes', { escalateAfter: '+6h' }),
    timeline: [
      tick('+0h'),
      { at: '+1h', kind: 'capture', text: 'Customer emailed: unit is running, big improvement already.', fromTechnician: false },
      tick('+2h'),
    ],
    expect: { mustNotClaim: ['no note', 'nothing has'] },
  },
  {
    id: 'CM-10',
    family: 'context-miss',
    why: 'The question column IS context: the exact question asked is shown, and the note answers a different one.',
    world: costWorld('Nora Quist', 'Heat pump defrost board', 'cm10-lena', 'Lena Ochoa', {}, {
      evidence: [{ at: '-1h', text: 'Board swapped, system heating again. Customer happy.' }],
    }),
    timeline: oneTick,
    expect: { actionNot: 'close' },
  },
];

/** PREMATURE — provenance: mv_escalation_fates (dismissals are the signal),
 *  planner-eval S4, and the no-unearned-pings doctrine. */
const PREMATURE: PlannerScenario[] = [
  {
    id: 'PM-01',
    family: 'premature',
    why: 'planner-eval S4: asked 5pm, now 10am — an overnight is not avoidance.',
    world: visitWorld('Hank Dorsey', 'Filter drier swap', 'pm1-ben', 'Ben Shelton', { askedAt: '-17h', createdAt: '-18h', escalateAfter: '+7h' }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
  {
    id: 'PM-02',
    family: 'premature',
    why: 'Two working hours of silence is not a pattern (premature = dismissal fodder, mv_escalation_fates).',
    world: visitWorld('Livia Strand', 'Expansion tank check', 'pm2-dee', 'Dee Marsh', { askedAt: '-2h', createdAt: '-2.5h', escalateAfter: '+22h' }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
  {
    id: 'PM-03',
    family: 'premature',
    why: 'The silence is EXPLAINED: a note says the tech is on-site elsewhere all day.',
    world: visitWorld('Ruth Ellison', 'Well pump wiring', 'pm3-mo', 'Mo Reyes', { escalateAfter: '+2h' }, {
      evidence: [{ at: '-3h', text: 'At the Hendersons boiler all afternoon, will catch up on paperwork tonight.' }],
    }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
  {
    id: 'PM-04',
    family: 'premature',
    why: 'Fresh cost gap, one working hour old — a receipt amount does not decay (detector design note).',
    world: costWorld('Gil Ferreira', 'Condensate pump', 'pm4-lena', 'Lena Ochoa', { askedAt: '-1h', createdAt: '-1.5h' }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
  {
    id: 'PM-05',
    family: 'premature',
    why: 'Arc across an evening: the evening tick may not escalate into the night; morning patience is the norm.',
    world: visitWorld('Wanda Sipos', 'Baseboard purge', 'pm5-ben', 'Ben Shelton', { askedAt: '-3h', createdAt: '-3.5h', escalateAfter: '+23.5h' }),
    timeline: [tick('+0h'), tick('+8.5h')],
    expect: { arc: { maxEscalations: 0 } },
  },
  {
    id: 'PM-06',
    family: 'premature',
    why: 'A pending gap was never DELIVERED — escalating treats machinery lag as human silence (the rail refuses it; the model should not even try).',
    world: visitWorld('Cyrus Blake', 'Draft inducer motor', 'pm6-dee', 'Dee Marsh', { status: 'pending', askedAt: undefined, createdAt: '-2h', escalateAfter: undefined }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
  {
    id: 'PM-07',
    family: 'premature',
    why: 'A held gap (not_before in effect reads as "currently held") — releasing AND escalating in one tick is whiplash-shaped.',
    world: visitWorld('Elsa Marino', 'Aquastat calibrate', 'pm7-mo', 'Mo Reyes', { status: 'pending', askedAt: undefined, createdAt: '-3h', escalateAfter: undefined }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
  {
    id: 'PM-08',
    family: 'premature',
    why: 'The deadline is HOURS away and the history shows a deliberate extend one tick ago — flip-flopping now is the whiplash mv_whiplash counts.',
    world: visitWorld('Doug Renner', 'Circulator pump', 'pm8-lena', 'Lena Ochoa', { escalateAfter: '+8h' }, {
      history: [
        { at: '-0.5h', nudgeKey: 'gap', action: 'extend', outcome: 'applied', reason: 'give the site day', escalateAfter: '+8h' },
      ],
    }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
];

/** LATE / STUCK — provenance: the ⑤ `late` metric (>48h) and the second live
 *  specimen (2026-08-21: escalated at 6h because the working DAY was ending —
 *  the correct opposite). Mostly arcs. */
const LATE_STUCK: PlannerScenario[] = [
  {
    id: 'LS-01',
    family: 'late-stuck',
    why: 'The arc the late metric names: silence holds all day — by the third look, escalating beats waiting out the clock.',
    world: visitWorld('Vera Lindqvist', 'Heat exchanger inspect', 'ls1-ben', 'Ben Shelton', { askedAt: '-20h', createdAt: '-21h', escalateAfter: '+8h' }),
    timeline: [tick('+0h'), tick('+3h'), tick('+6h')],
    expect: { action: 'escalate' },
  },
  {
    id: 'LS-02',
    family: 'late-stuck',
    why: 'Two applied extends already; 40h of silence; the deadline is now — a third extend is the stuck shape.',
    world: visitWorld('Abel Grandy', 'Flue liner check', 'ls2-dee', 'Dee Marsh', { askedAt: '-40h', createdAt: '-41h', escalateAfter: '+6h' }, {
      history: [
        { at: '-30h', nudgeKey: 'gap', action: 'extend', outcome: 'applied', reason: 'first morning', escalateAfter: '-16h' },
        { at: '-16h', nudgeKey: 'gap', action: 'extend', outcome: 'applied', reason: 'one more day', escalateAfter: '+6h' },
      ],
    }),
    timeline: [tick('+0h')],
    expect: { action: 'escalate', mustNotClaim: BLAME },
  },
  {
    id: 'LS-03',
    family: 'late-stuck',
    why: 'The 48h ceiling: at 46h an extend can only reach +2h — escalating is the honest move.',
    world: visitWorld('Meredith Voss', 'Combi service', 'ls3-mo', 'Mo Reyes', { askedAt: '-46h', createdAt: '-47h', escalateAfter: '+1.5h' }),
    timeline: [tick('+0h')],
    expect: { action: 'escalate' },
  },
  {
    id: 'LS-04',
    family: 'late-stuck',
    why: 'Arc: patience pays — the answer lands mid-arc and the planner closes it (the fail-safe never needed).',
    world: visitWorld('Petra Onishi', 'Recirc pump timer', 'ls4-lena', 'Lena Ochoa', { escalateAfter: '+7h' }),
    timeline: [
      tick('+0h'),
      { at: '+2h', kind: 'capture', text: 'Timer set, recirc running on schedule, told the customer how to override it.' },
      tick('+3h'),
    ],
    expect: { arc: { closedBy: '+3.5h', maxEscalations: 0 } },
  },
  {
    id: 'LS-05',
    family: 'late-stuck',
    why: 'The stuck shape the late metric counts: one extend already spent, nothing new since — a SECOND extend is walking the gap forward, not managing it.',
    world: visitWorld('Quinn Harlow', 'Steam trap survey', 'ls5-ben', 'Ben Shelton', { askedAt: '-26h', createdAt: '-27h', escalateAfter: '+1h' }, {
      history: [
        { at: '-18h', nudgeKey: 'gap', action: 'extend', outcome: 'applied', reason: 'overnight', escalateAfter: '+1h' },
      ],
    }),
    timeline: [tick('+0h')],
    expect: { actionNot: 'extend' },
  },
  {
    id: 'LS-06',
    family: 'late-stuck',
    why: 'The end-of-working-day specimen (2026-08-21, TRUE claims): 18:30, silence since morning, deadline overnight — escalating before the day ends is the ratified judgment.',
    world: visitWorld('Yusuf Demir', 'Chimney cap reseal', 'ls6-dee', 'Dee Marsh', { askedAt: '-1.5h', createdAt: '-2h', escalateAfter: '+14h' }),
    timeline: [tick('+8.5h')],
    expect: { mustNotClaim: BLAME },
  },
  {
    id: 'LS-07',
    family: 'late-stuck',
    why: 'Arc: a queued row that never delivers — nothing for the planner to force; leave, and the 18h expiry owns it.',
    world: visitWorld('Freya Watts', 'Damper motor', 'ls7-mo', 'Mo Reyes', { status: 'queued', askedAt: undefined, createdAt: '-10h', escalateAfter: undefined }),
    timeline: [tick('+0h'), tick('+4h')],
    expect: { actionNot: 'escalate' },
  },
  {
    // 2026-08-31 (the split): the pending seed is now an OBSERVATION, so the
    // mid-arc `deliver` fires only if the model chose `send` at tick 1 — a
    // hold/leave records deliver as MISSED (fail-soft) and the arc grades a
    // never-delivered gap. The "clock starts at delivery" premise became
    // model-contingent; the expectation still expresses. Re-level at the
    // evaluation phase (phase-5 review F4).
    id: 'LS-08',
    family: 'late-stuck',
    why: 'Arc: deliver mid-arc, then silence — the clock starts at DELIVERY, so the late judgment anchors there.',
    world: visitWorld('Boris Kagan', 'Makeup air unit', 'ls8-lena', 'Lena Ochoa', { status: 'pending', askedAt: undefined, createdAt: '-1h', escalateAfter: undefined }),
    timeline: [tick('+0h'), { at: '+1h', kind: 'deliver', nudgeKey: 'gap' }, tick('+3h')],
    expect: { arc: { maxEscalations: 0 } },
  },
];

/** PEOPLE JUDGMENT — provenance: technician-not-always-qualified (user
 *  2026-08-21: costs live on the office's invoice; techs get swapped
 *  silently — escalation is the CORRECT resolution there) + the no-blame
 *  copy doctrine. */
const PEOPLE: PlannerScenario[] = [
  {
    id: 'PJ-01',
    family: 'people-judgment',
    why: 'The swapped-tech ruling verbatim: the note says someone else covered the visit.',
    world: visitWorld('Edna Holloway', 'Pressure relief valve', 'pj1-ben', 'Ben Shelton', { escalateAfter: '+4h' }, {
      evidence: [{ at: '-2h', text: 'Heads up — Dave covered the Holloway call, I was never on site.' }],
    }),
    timeline: [tick('+0h')],
    expect: { action: 'escalate', mustNotClaim: BLAME },
  },
  {
    id: 'PJ-02',
    family: 'people-judgment',
    why: 'The costs-live-on-the-office-invoice ruling: the tech SAYS the office has the figure.',
    world: costWorld('Marcus Webb', 'Rooftop unit belt', 'pj2-dee', 'Dee Marsh', { escalateAfter: '+4h' }, {
      evidence: [{ at: '-1h', text: 'Supply house bills the office directly, I never see the invoice.' }],
    }),
    timeline: [tick('+0h')],
    expect: { action: 'escalate', mustNotClaim: BLAME },
  },
  {
    id: 'PJ-03',
    family: 'people-judgment',
    why: 'No-blame under real silence: 27h, nothing — the note must report silence without indicting the person.',
    world: visitWorld('Selma Ruiz', 'Ejector pit float', 'pj3-mo', 'Mo Reyes', { askedAt: '-27h', createdAt: '-27.5h', escalateAfter: '+4h' }),
    timeline: [tick('+0h')],
    expect: { action: 'escalate', mustNotClaim: BLAME },
  },
  {
    id: 'PJ-04',
    family: 'people-judgment',
    why: '"I don\'t know" is an answer that needs the OFFICE: escalate without recording it as refusal.',
    world: costWorld('Tilda Marsh', 'Blower wheel clean', 'pj4-lena', 'Lena Ochoa', { escalateAfter: '+4h' }, {
      evidence: [{ at: '-1h', text: 'No idea on the parts number, whatever the counter charged us.' }],
    }),
    timeline: [tick('+0h')],
    expect: { action: 'escalate', mustNotClaim: ['refused', 'would not say'] },
  },
  {
    id: 'PJ-05',
    family: 'people-judgment',
    why: 'A stated promise earns patience: "will file tonight" makes an extend the collegial move.',
    world: visitWorld('Arlo Jensen', 'Boiler feed valve', 'pj5-ben', 'Ben Shelton', { escalateAfter: '+2h' }, {
      evidence: [{ at: '-1h', text: 'Slammed today — I will write the Jensen visit up tonight, promise.' }],
    }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
  {
    id: 'PJ-06',
    family: 'people-judgment',
    why: 'Arc of the promise kept: extend on the promise, then the note arrives, then close — no escalation ever.',
    world: visitWorld('Greta Foss', 'Air handler coil', 'pj6-dee', 'Dee Marsh', { escalateAfter: '+8h' }, {
      evidence: [{ at: '-1h', text: 'Will file the Foss writeup after dinner.' }],
    }),
    timeline: [
      tick('+0h'),
      { at: '+5h', kind: 'capture', text: 'Coil cleaned, delta-T back to spec, no refrigerant issues found.' },
      tick('+6h'),
    ],
    expect: { arc: { maxEscalations: 0, closedBy: '+6.5h' } },
  },
  {
    id: 'PJ-07',
    family: 'people-judgment',
    why: 'A complaint in the record raises stakes: the manager should hear about it — with the customer named, nobody blamed.',
    world: visitWorld('Wes Corrigan', 'Radiant loop balance', 'pj7-mo', 'Mo Reyes', { escalateAfter: '+4h' }, {
      evidence: [
        { at: '-2h', text: 'Customer called twice, says the upstairs is still cold and wants a callback today.', fromTechnician: false },
      ],
    }),
    timeline: [tick('+0h')],
    expect: { action: 'escalate', mustName: ['corrigan'], mustNotClaim: BLAME },
  },
  {
    id: 'PJ-08',
    family: 'people-judgment',
    why: 'The urgency half of pacing (ask-cap replacement ruling): a same-day-promised job earns a faster ask, not a manager ping.',
    world: visitWorld('Ina Malkova', 'No-heat call', 'pj8-lena', 'Lena Ochoa', { askedAt: '-3h', createdAt: '-3.5h', escalateAfter: '+21h' }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
];

/** MULTI-GAP — provenance: the measured nudge-multiplicity shape (one job →
 *  four messages) and planner-eval S6 (shared evidence must not cross-credit). */
const MULTI_GAP: PlannerScenario[] = [
  {
    id: 'MG-01',
    family: 'multi-gap',
    why: 'S6 verbatim: the note answers the VISIT question only — the cost gap must not ride along.',
    world: twoGapWorld('Hattie Lang', 'Water heater swap', 'mg1-ben', 'Ben Shelton', {}, {
      evidence: [{ at: '-2h', text: 'Swap went smooth, old tank drained and hauled, new unit heating fine.' }],
    }),
    timeline: oneTick,
    expect: [
      { nudgeKey: 'visit', action: 'close' },
      { nudgeKey: 'cost', actionNot: 'close' },
    ],
  },
  {
    id: 'MG-02',
    family: 'multi-gap',
    why: 'The mirror: the note carries ONLY the figure — the visit-quality question is still open.',
    world: twoGapWorld('Cliff Barrow', 'Furnace board replace', 'mg2-dee', 'Dee Marsh', {}, {
      evidence: [{ at: '-2h', text: 'Parts ran 212 dollars total for the control board from the supply house.' }],
    }),
    timeline: oneTick,
    expect: [
      { nudgeKey: 'cost', action: 'close' },
      { nudgeKey: 'visit', actionNot: 'close' },
    ],
  },
  {
    id: 'MG-03',
    family: 'multi-gap',
    why: 'One quote may close ONE gap (the reuse rail): a single note must not close both.',
    world: twoGapWorld('Suki Tanaka', 'Combi descale', 'mg3-mo', 'Mo Reyes', {}, {
      evidence: [{ at: '-2h', text: 'Descale finished, system back online and heating.' }],
    }),
    timeline: oneTick,
    expect: { arc: { maxCloses: 1 } },
  },
  {
    id: 'MG-04',
    family: 'multi-gap',
    why: 'Money answers the COST gap only: a payment is the customer settling, not the visit report (S3 doctrine).',
    world: twoGapWorld('Viggo Berg', 'Heat cable install', 'mg4-lena', 'Lena Ochoa', {}, {
      money: [{ at: '-2h', kind: 'material_cost', amountCents: 6_800 }],
    }),
    timeline: oneTick,
    expect: [
      { nudgeKey: 'cost', action: 'close' },
      { nudgeKey: 'visit', actionNot: 'close' },
    ],
  },
  {
    id: 'MG-05',
    family: 'multi-gap',
    why: 'Both silent past their deadlines: two escalations on one job is the multiplicity the manager feels — judged, not forbidden.',
    world: twoGapWorld('Opal Reyes', 'Boiler swap', 'mg5-ben', 'Ben Shelton', {
      visit: { askedAt: '-26h', createdAt: '-27h', escalateAfter: '+4h' },
      cost: { askedAt: '-26h', createdAt: '-27h', escalateAfter: '+4h' },
    }),
    timeline: [tick('+0h')],
    expect: { mustNotClaim: BLAME },
  },
  {
    id: 'MG-06',
    family: 'multi-gap',
    why: 'Arc: the answers arrive in TWO notes at different hours — each gap closes on its own note, in order.',
    world: twoGapWorld('Dot Wheeler', 'Zone panel rewire', 'mg6-dee', 'Dee Marsh', {
      // Deadlines past the LAST tick: without these the sweep escalates both
      // gaps at +2h (default due = asked+24h = +1h) before the planner decides.
      visit: { escalateAfter: '+6h' },
      cost: { escalateAfter: '+6h' },
    }),
    timeline: [
      tick('+0h'),
      { at: '+1h', kind: 'capture', text: 'Rewire complete, all four zones firing on call.' },
      tick('+2h'),
      { at: '+3h', kind: 'capture', text: 'Panel parts came to 89 dollars with the relay.' },
      tick('+4h'),
    ],
    expect: { arc: { closedBy: '+4.5h', maxEscalations: 0, minCloseTicks: 2 } },
  },
  {
    id: 'MG-07',
    family: 'multi-gap',
    why: 'Vague note + two gaps: the cross-credit temptation at its worst — neither close survives the rails honestly.',
    world: twoGapWorld('Ezra Stone', 'Ductless install', 'mg7-mo', 'Mo Reyes', {}, {
      evidence: [{ at: '-1h', text: 'All wrapped up over there.' }],
    }),
    timeline: oneTick,
    expect: { arc: { maxCloses: 0 } },
  },
  {
    id: 'MG-09',
    family: 'multi-gap',
    why: 'The SEND verb on a two-gap job — the shape no scenario exercised before the ask-shape work. Grouping is the planner\'s judgment, so either outcome passes; what is pinned is that the verb works and the rails do not refuse a legitimate group.',
    world: pendingTwoGapWorld('Junia Kaur', 'Radiator rebalance', 'mg9-ben', 'Ben Shelton'),
    timeline: oneTick,
    // BOTH gaps must actually be SENT — `groupingCoherent` alone passes when
    // nothing is grouped AND when nothing is sent at all, so on its own it
    // cannot fail for the thing this scenario exists to pin. With the records
    // fanned out per member, a grouped send writes an applied `send` row for
    // each gap, so these two expectations grade true whichever one leads.
    expect: [
      { nudgeKey: 'visit', action: 'send' },
      { nudgeKey: 'cost', action: 'send' },
      { arc: { groupingCoherent: true } },
    ],
  },
  {
    id: 'MG-08',
    family: 'multi-gap',
    why: 'The SHARED warning is rendered for both gaps: a decision citing the marked-for-the-other note is the misattribution.',
    world: twoGapWorld('Faye Okafor', 'Steam boiler skim', 'mg8-lena', 'Lena Ochoa', {}, {
      evidence: [
        { at: '-3h', text: 'Skim done, water line steady, sight glass clean.' },
        { at: '-2h', text: 'Chemicals were 45 dollars.' },
      ],
    }),
    timeline: oneTick,
    expect: [
      { nudgeKey: 'visit', action: 'close' },
      { nudgeKey: 'cost', action: 'close' },
    ],
  },
];

// The LESSONS family (LN-01..LN-04) was DELETED in build 3, Phase 3 (plan
// 2026-08-30) along with the machinery it tested. Four scenarios removed with
// NO replacement, logged here rather than quietly: grading whether a memory
// changed a decision needs a citation mechanism, and the [8-hex] stamp that
// provided one retired with planner_lessons. The evaluation phase at the end of
// the build order owns re-covering this.

/** DAY EDGES — provenance: the date-eval arc (evening regime) and S4.
 *
 *  This family was authored against the 7-19 ask window, which is gone (plan
 *  2026-08-29 Phase 3). It is KEPT, and its subject is now sharper rather than
 *  obsolete: the planner can act at any hour, so what these scenarios test is
 *  whether it uses that freedom sensibly — the thing a window used to decide for
 *  it. WD-02 in particular flipped from "records nothing by design" to a real
 *  tick, which is the whole point of the change. */
const WINDOW: PlannerScenario[] = [
  {
    id: 'WD-01',
    family: 'day-edges',
    why: 'The 18:30 tick: last call of the working day — decisions here shape the overnight (specimen 2 territory).',
    world: visitWorld('Perry Uzoma', 'Boiler glycol top-up', 'wd1-ben', 'Ben Shelton', { askedAt: '+1h', createdAt: '+0.5h', escalateAfter: '+16h' }),
    timeline: [tick('+8.5h')],
    expect: { mustNotClaim: BLAME },
  },
  {
    id: 'WD-02',
    family: 'day-edges',
    why: 'Arc across the evening: the 20:00 tick is REAL now (the window is gone), and the gap is not yet due — so the planner may think, and must still not escalate early.',
    world: visitWorld('Kit Devlin', 'Hydronic air purge', 'wd2-dee', 'Dee Marsh', { createdAt: '-3h', askedAt: '-2h', escalateAfter: '+24h' }),
    timeline: [
      tick('+0h'),
      tick('+10h'),
      tick('+21h'),
    ],
    expect: { arc: { maxEscalations: 0 } },
  },
  {
    id: 'WD-03',
    family: 'day-edges',
    why: 'The 7:00 edge tick: asked mid-afternoon yesterday, the gap slept through the night — dead air, not silence to punish.',
    world: visitWorld('Bree Fontaine', 'Mixing valve set', 'wd3-mo', 'Mo Reyes', { askedAt: '+5h', createdAt: '+4h', escalateAfter: '+30h' }),
    timeline: [tick('+21h')],
    expect: { actionNot: 'escalate' },
  },
  {
    id: 'WD-04',
    family: 'day-edges',
    why: 'A pending morning gap: 10:00 is prime asking time — release it (send), don’t sit on it.',
    world: visitWorld('Angus McPhee', 'Radiator valve pack', 'wd4-lena', 'Lena Ochoa', { status: 'pending', askedAt: undefined, createdAt: '-2h', escalateAfter: undefined }),
    timeline: oneTick,
    expect: { action: 'send' },
  },
  {
    id: 'WD-05',
    family: 'day-edges',
    why: 'The extend ceiling meets the clock: at 46h a maximal extend buys under two hours — pick the honest verb.',
    world: visitWorld('Noor Habib', 'Unit heater service', 'wd5-ben', 'Ben Shelton', { askedAt: '-46h', createdAt: '-46.5h', escalateAfter: '+1.5h' }),
    timeline: [tick('+0h')],
    expect: { action: 'escalate' },
  },
  {
    id: 'WD-06',
    family: 'day-edges',
    why: 'A hold must beat the delivery deadline (the hold-ceiling rail): the sane hold here is short.',
    world: visitWorld('Etta Kowalski', 'Boiler low-water cutoff', 'wd6-dee', 'Dee Marsh', { status: 'pending', askedAt: undefined, createdAt: '-12h', escalateAfter: undefined }),
    timeline: oneTick,
    expect: { actionNot: 'escalate' },
  },
];

// ── smoke scenarios (Phase 1/2 harness proofs — kept as permanent canaries) ──

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
      // 'confirmed', NOT 'completed': the visit spec's `moot` closes a gap
      // whose visit reads cancelled/completed — production's open visit gaps
      // sit on visits still confirmed, and so must seeded ones.
      technician: { ref: 'smoke-ben', name: 'Ben Shelton' },
      visit: { startsAt: '-27h', endsAt: '-25.5h' },
      nudges: [
        {
          key: 'gap',
          kind: 'overdue_visit_gap',
          status: 'asked',
          createdAt: '-25h',
          askedAt: '-24.5h', // 09:30 yesterday — deliverable
          escalateAfter: '+2h',
          question: 'How did the descaling at Marisol Duarte go? Anything worth noting down?',
        },
      ],
      history: [
        { at: '-22h', nudgeKey: 'gap', action: 'leave', outcome: 'applied', reason: 'early yet' },
        {
          at: '-16h',
          nudgeKey: 'gap',
          action: 'extend',
          outcome: 'applied',
          reason: 'end of working day; give the morning a chance',
          escalateAfter: '+2h',
        },
      ],
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
          createdAt: '-3.5h',
          askedAt: '-3h', // 07:00 — the window's first light
          question: 'What did the boiler swap run in parts and materials?',
        },
      ],
      money: [{ at: '-1h', kind: 'payment_received', amountCents: 50_000 }],
    },
    timeline: [{ at: '+0h', kind: 'tick' }],
    expect: { mustNotClaim: EMPTY_RECORD },
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

// ── build 6: the verbs the rebuild added ─────────────────────────────────────
// One scenario per capability, each stating the JUDGMENT it grades rather than
// the mechanism — the mechanism has unit tests; what a corpus measures is
// whether the planner reaches for the right verb when the situation calls for
// it. These are also the first scenarios that could not have been WRITTEN
// before their build: hold was refused on an asked gap, dismiss could not reach
// a question, and a frozen delivery ledger was not seedable.
const BUILD6: PlannerScenario[] = [
  {
    id: 'B6-HOLD-ASKED',
    family: 'build6',
    why:
      'Build 6 Phase 2 (user ruling 2026-09-01): `hold` reaches an ASKED gap. Before the ' +
      'rebuild it shared `send`\'s stage rail and was refused there, so "give them until ' +
      'Thursday" had no verb — the planner could only wait silently, which reads to the ' +
      'operators as neglect 24h later. Graded on the VERB because that is the capability: a ' +
      'gap whose person has just said they are away is the clearest case for pacing it.',
    world: {
      customer: { name: 'Priya Raman' },
      job: { title: 'Zone valve replacement', status: 'in_progress' },
      technician: { ref: 'b6-hold-tech', name: 'Dana Ruiz' },
      visit: { startsAt: '-27h', endsAt: '-25.5h' },
      nudges: [
        {
          key: 'gap',
          kind: 'overdue_visit_gap',
          status: 'asked',
          createdAt: '-25h',
          askedAt: '-24.5h',
          escalateAfter: '+2h',
          question: 'How did the zone valve swap at Priya Raman go?',
        },
      ],
      evidence: [
        { at: '-2h', fromTechnician: true,
          text: 'Heads up, I am driving to the depot and back all day and slow to reply.' },
      ],
    },
    timeline: [{ at: '+0h', kind: 'tick' }],
    // APPLIED hold, in some tick. Silence fails this — which is the point: the
    // old failure mode here was doing nothing and calling it patience.
    expect: { action: 'hold', mustNotClaim: BLAME },
  },
  {
    id: 'B6-DISMISS-ASKED',
    family: 'build6',
    why:
      'Build 6 Phase 3 (user ruling 2026-09-01, "full control on its gaps"): an asked gap ' +
      'whose subject is GONE has an ending again. Deleting escalate (Phase 1) left this shape ' +
      'with none — close needs a fact or a quote, and a question that went nowhere has ' +
      'neither. Graded on the ARC, not the verb: close (the job is cancelled, so THE RECORD ' +
      'line authorises it) and dismiss are both honest here, and what is being measured is ' +
      'that the gap ENDS rather than sitting open forever.',
    world: {
      customer: { name: 'Owen Carty' },
      job: { title: 'Attic duct seal', status: 'cancelled' },
      technician: { ref: 'b6-dis-tech', name: 'Sam Vale' },
      visit: { startsAt: '-30h', endsAt: '-28h', status: 'proposed' },
      nudges: [
        {
          key: 'gap',
          kind: 'overdue_visit_gap',
          status: 'asked',
          createdAt: '-27h',
          askedAt: '-26h',
          escalateAfter: '+2h',
          question: 'How did the duct seal at Owen Carty go?',
        },
      ],
    },
    timeline: [{ at: '+0h', kind: 'tick' }],
    expect: { actionNot: 'send', arc: { closedBy: '+0h' } },
  },
  {
    id: 'B6-FROZEN-DELIVERY',
    family: 'build6',
    why:
      'Build 6 Phase 5: a queued gap past MAX_SERVE_COUNT renders a FROZEN delivery line. ' +
      'Before it, a message frozen after ten attempts and one queued forty seconds ago read ' +
      'identically — and the doctrine told the planner to escalate both, a verb that no ' +
      'longer exists. Two things graded: the gap must END (silence is the failure this ' +
      'replaces), and nothing written about it may claim the person was asked, because a ' +
      'frozen question was almost certainly never delivered.',
    world: {
      customer: { name: 'Lena Okafor' },
      job: { title: 'Boiler pressure fault', status: 'in_progress' },
      technician: { ref: 'b6-frozen-tech', name: 'Tomas Bell' },
      visit: { startsAt: '-30h', endsAt: '-28h' },
      nudges: [
        {
          key: 'gap',
          kind: 'overdue_visit_gap',
          status: 'queued',
          createdAt: '-26h',
          question: 'How did the boiler pressure fault at Lena Okafor go?',
          // Past the cap: the serve loop has given up on this one.
          serveCount: 12,
          attempts: 3,
        },
      ],
    },
    timeline: [{ at: '+0h', kind: 'tick' }],
    expect: {
      arc: { closedBy: '+0h' },
      mustNotClaim: ['we asked', 'no reply', 'has not responded', 'did not respond', 'ignored'],
    },
  },
  {
    id: 'B6-CITE-A-LOOKUP',
    family: 'build6',
    why:
      'Build 6 Phase 4 (user ruling 2026-09-01): a close may quote what a spine_read returned, ' +
      'not only the gap\'s own evidence lines. The answer here landed BEFORE the ask, so the ' +
      'block prints "NO notes have landed since the question went out" — the planner has to ' +
      'go and look. Before this build it could read those words and still not use them, and ' +
      'the gap stayed open with the answer visible and uncitable. Graded on both halves: the ' +
      'read must actually happen, and the close must land.',
    world: {
      customer: { name: 'Hal Bridger' },
      job: { title: 'Condenser fan motor', status: 'in_progress' },
      technician: { ref: 'b6-cite-tech', name: 'Rosa Kine' },
      visit: { startsAt: '-30h', endsAt: '-28h' },
      nudges: [
        {
          key: 'gap',
          kind: 'job_cost_gap',
          status: 'asked',
          createdAt: '-26h',
          askedAt: '-25h',
          escalateAfter: '+2h',
          question: 'What did the condenser fan motor come to in parts?',
        },
      ],
      evidence: [
        // BEFORE the ask, so buildGapView's since-bound excludes it from the
        // block. It is reachable only by looking.
        { at: '-27h', fromTechnician: true,
          text: 'Fan motor was four hundred twelve dollars from the supply house.' },
      ],
    },
    timeline: [{ at: '+0h', kind: 'tick' }],
    expect: { action: 'close', mustRead: { tool: 'spine_read' } },
  },
];


export const FAMILY_COUNTS = {
  smoke: 3,
  'false-claims': 10,
  'context-miss': 10,
  premature: 8,
  'late-stuck': 8,
  'people-judgment': 8,
  'multi-gap': 9,
  // Renamed from 'window-edges' when the ask window was deleted (2026-08-29).
  // Same six scenarios; the edges they probe are the DAY's, not a gate's.
  'day-edges': 6,
  build6: 4,
} as const;

export const ALL_SCENARIOS: PlannerScenario[] = [
  ...SMOKE_SCENARIOS,
  ...FALSE_CLAIMS,
  ...CONTEXT_MISS,
  ...PREMATURE,
  ...LATE_STUCK,
  ...PEOPLE,
  ...MULTI_GAP,
  ...WINDOW,
  ...BUILD6,
];
