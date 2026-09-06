// The situations the planner's manager copy has to survive (plan 2026-08-22).
//
// Every scenario is a real `Nudge` row put through the REAL buildGapView, so
// the model sees the block production renders — never a hand-written imitation.
// `expect` states what a correct note must and must not contain, in facts
// rather than wording: we are measuring judgment, not phrasing.

const HOUR = 3_600_000;
export const NOW = '2026-08-19T17:00:00.000Z'; // Wednesday, 10:00 AM firm-local
export const TZ = 'America/Los_Angeles';

const ago = (h) => new Date(Date.parse(NOW) - h * HOUR).toISOString();

const visit = (over = {}) => ({
  id: 'n-visit', tenant_id: 't1', kind: 'overdue_visit_gap', subject_ref: 'a1',
  technician_id: 'tech-1', status: 'asked', asked_at: ago(30), question: null,
  attempts: 0, serve_count: 1, actor_ref: 'spine:team-lead', resolution: null,
  queued_at: null, not_before: null, escalate_after: null, resolved_at: null,
  created_at: ago(40), updated_at: ago(30),
  context: {
    customerName: 'Marisol Duarte', jobTitle: 'Tankless descaling',
    technicianRef: 'ben-shelton', technicianName: 'Ben Shelton',
    visitId: 'a1', jobId: 'j-tankless',
    startsAtLocal: '2026-08-18T12:00:00.000Z', endsAtLocal: '2026-08-18T13:30:00.000Z',
  },
  ...over,
});

const cost = (over = {}) => ({
  ...visit(), id: 'n-cost', kind: 'job_cost_gap', subject_ref: 'j-boiler',
  context: {
    customerName: 'Henderson Family', jobTitle: 'Boiler swap',
    technicianRef: 'ben-shelton', technicianName: 'Ben Shelton',
    jobId: 'j-boiler', endsAtLocal: '2026-08-18T18:00:00.000Z',
  },
  ...over,
});

const capture = (text, hoursAgo, jobId) => ({
  jobId,
  capture: { raw_text: text, captured_at: ago(hoursAgo) },
});

export const SCENARIOS = [
  {
    id: 'S1-silence',
    why: 'The plain case: asked, nothing came back, the deadline has passed.',
    nudges: [visit()],
    evidence: [],
    expect: {
      action: 'escalate',
      mustName: ['Tankless descaling', 'Marisol Duarte'],
      mustNotClaim: ['the technician ignored', 'refused', 'failed to'],
    },
  },
  {
    id: 'S2-answered-something-else',
    why:
      'A note landed, but it answers a DIFFERENT question. The sweep would have ' +
      'closed this gap on activity alone; the planner is supposed to see that it ' +
      'does not answer what was asked.',
    nudges: [visit()],
    evidence: [capture('Dropped off the spare filters at the shop.', 4, 'j-tankless')],
    expect: {
      action: 'escalate',
      mustNotClaim: ['nothing has been recorded', 'no note'],
      note: 'a note DID land — a note saying nothing landed is false',
    },
  },
  {
    id: 'S3-money-answered-it',
    why:
      'The 2026-08-19 Tankless specimen. The customer paid; the record is not ' +
      'empty. A note telling a manager nothing happened is the exact failure ' +
      'plan ① widened the eye to prevent.',
    nudges: [visit()],
    evidence: [],
    money: [
      { kind: 'payment_received', amount_cents: 50000, occurred_at: ago(20), created_at: ago(20), note: null },
    ],
    // CORRECTED 2026-08-22. This first asserted the planner must NOT escalate,
    // which contradicts the shipped doctrine: PLANNER_SYSTEM says outright that
    // "a payment tells you the customer settled up; it does not tell you how
    // the work went", and plan ① ratified that the PLANNER judges whether a
    // fact answers the question — code only states the fact. The planner
    // escalated and was right to; the expectation was wrong.
    //
    // What is still measurable here, and is the real risk: whatever it decides,
    // the note must not tell a manager the record is empty when $500 is sitting
    // on it.
    expect: {
      mustNotClaim: ['nothing has', 'no record', 'nothing is on'],
      note: 'money landed after the ask — the DECISION is the planner\'s to make, the CLAIM is not',
    },
  },
  {
    id: 'S4-end-of-day',
    why:
      'Asked at 5pm firm-local, now 10am the next day. Escalating treats an ' +
      'overnight as avoidance. `extend` exists for exactly this.',
    nudges: [visit({ asked_at: ago(17) })],
    evidence: [],
    expect: { actionNot: 'escalate' },
  },
  {
    id: 'S5-cost-gap',
    why: 'The cost half — a figure the technician may not even know.',
    nudges: [cost()],
    evidence: [],
    expect: {
      action: 'escalate',
      mustName: ['Boiler swap', 'Henderson'],
      mustNotClaim: ['ignored', 'failed to', 'unresponsive'],
    },
  },
  {
    id: 'S6-two-gaps-one-job',
    why:
      'Two gaps share a job, so they share their evidence. A note that credits ' +
      'one gap with the other question\'s answer is the misattribution the date ' +
      'rail cannot catch.',
    nudges: [visit({ id: 'n-a' }), cost({ id: 'n-b', context: { ...cost().context, jobId: 'j-tankless' } })],
    evidence: [capture('Descaling done, unit is running clean.', 3, 'j-tankless')],
    expect: { note: 'the VISIT gap is answered; the COST gap is not' },
  },
];
