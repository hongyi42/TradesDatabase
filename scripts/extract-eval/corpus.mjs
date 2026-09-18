// The extractor eval's corpus — hand-written, NEVER taken from the pilot.
//
// Pilot rows would make the baseline unreproducible (they change under us) and
// would drag customer text into a file anyone can read. Every message here is
// invented, and the labels are what a careful reader of CLAUDE.md's rung-10
// rules would say the door should conclude.
//
// WHAT IS LABELLED, and why only three fields: these are the three the DOOR
// gates on. `visitCommitted === true` is the only value that raises a
// commitment ask; `touchesOperations === false` is the only value that skips;
// `statusSignal` is the only field that can move a job. Everything else the
// extractor returns is copy the planner reads, not a gate — grading it would
// measure prose, and a model's prose differs run to run without being wrong.
//
// So each fixture states the door's reading, not the raw JSON:
//   committed — extracted.visitCommitted === true
//   skips     — extracted.touchesOperations === false
//   status    — extracted.statusSignal ?? null
// An absent field and an explicit false are the same answer to the door here,
// which is exactly why the labels are written in the door's terms.

/** @typedef {{ id: string, text: string, fromTheFirm?: boolean, earlier?: object[], candidates?: {title: string|null, status: string}[], expect: { committed: boolean, skips: boolean, status: 'completed'|'in_progress'|null } }} Fixture */

// Bump when any text, label or fixture changes: a baseline is only comparable
// to a later run of the SAME corpus, and "92%" with no version beside it is a
// number nobody can check.
export const CORPUS_VERSION = 2;

const TAP = { title: 'Kitchen tap dripping', status: 'in_progress' };
const BOILER = { title: 'Boiler diagnostic', status: 'open' };

/** @type {Fixture[]} */
export const FIXTURES = [
  {
    id: 'commitment-outbound',
    fromTheFirm: true,
    text: "Hi Delphine,\n\nWe'll send a technician out on Wednesday 16 September between 10am and 12pm to sort the dripping bathroom faucet.\n\nSam\nNorthside Plumbing",
    expect: { committed: true, skips: false, status: null },
  },
  {
    id: 'customer-asks',
    text: 'Hi — the boiler is making a banging noise again. Could someone come and look at it?',
    expect: { committed: false, skips: false, status: null },
  },
  {
    id: 'thank-you',
    // Deliberately says nothing about the state of any work: "the heat has been
    // perfect all week" would be a fair read of "the job is finished", and then
    // a `completed` here would be an honest disagreement rather than a miss.
    text: 'Thanks so much for getting back to me so quickly — really appreciate it.',
    expect: { committed: false, skips: true, status: null },
  },
  {
    id: 'work-finished',
    text: 'Just to let you know your engineer finished the repair this morning and everything is running again.',
    expect: { committed: false, skips: false, status: 'completed' },
  },
  {
    id: 'firm-confirms',
    fromTheFirm: true,
    text: 'Yes, Thursday morning works on our side — we will see you then.\n\nSam\nNorthside Plumbing\n0161 555 0102',
    expect: { committed: true, skips: false, status: null },
  },
  {
    id: 'reschedule-in-thread',
    earlier: [
      {
        messageId: 'm1',
        from: 'office@northside.test',
        to: 'iris@example.test',
        subject: 'Your radiator',
        body: 'We have you down for Tuesday at 9am.',
        at: '2026-09-08T10:00:00.000Z',
      },
    ],
    text: 'Could we do Friday afternoon instead? Tuesday no longer works for me.',
    expect: { committed: false, skips: false, status: null },
  },
  {
    // THE NINTH SHAPE, and the one that pins a ruling: the job is named only
    // three messages up, and the firm ALREADY offered Thursday there. So
    // `visitCommitted` must be FALSE — EXTRACTION_SYSTEM says a visit agreed in
    // an earlier message "is already handled" — and once Phase 2 shows a
    // candidate list beside this, the plan accepts that it still gets no pick,
    // because earlier messages may supply identity only.
    id: 'thursday-works-thread',
    earlier: [
      {
        messageId: 'm1',
        from: 'iris@example.test',
        to: 'office@northside.test',
        subject: 'Kitchen tap',
        body: 'The kitchen tap is dripping again, worse than last time.',
        at: '2026-09-08T09:00:00.000Z',
      },
      {
        messageId: 'm2',
        from: 'office@northside.test',
        to: 'iris@example.test',
        subject: 'Re: Kitchen tap',
        body: 'We could come Thursday morning if that suits.',
        at: '2026-09-08T11:00:00.000Z',
      },
    ],
    text: 'Thursday works.',
    expect: { committed: false, skips: false, status: null },
  },
  {
    id: 'quote-request',
    text: 'What would you charge to replace the whole boiler? No rush, just budgeting.',
    expect: { committed: false, skips: false, status: null },
  },
  {
    id: 'wrong-number',
    text: 'Sorry, wrong number — ignore this.',
    expect: { committed: false, skips: true, status: null },
  },
];

// THE TWINS. The same judgement with a candidate list in front of it — the only
// prompts this change actually alters. Without them the eval re-scores messages
// whose prompt did not move and calls that a no-regression result.
//
// The risk they exist to catch is named in EXTRACTION_SYSTEM: a visit the firm
// agreed to EARLIER "is already handled, so it must NOT set visitCommitted". A
// list of the customer's open jobs sitting beside the message could read that
// way and suppress a live promise — the exact failure this whole arc started on.
const byId = (id) => {
  const f = FIXTURES.find((x) => x.id === id);
  if (!f) throw new Error(`extract-eval corpus: no fixture '${id}'`);
  return f;
};

/** @type {Fixture[]} */
export const CANDIDATE_TWINS = [
  {
    id: 'commitment-outbound+candidates',
    fromTheFirm: true,
    text: byId('commitment-outbound').text,
    candidates: [BOILER, TAP],
    expect: { committed: true, skips: false, status: null },
  },
  {
    id: 'thank-you+candidates',
    text: byId('thank-you').text,
    candidates: [BOILER, TAP],
    expect: { committed: false, skips: true, status: null },
  },
  {
    // THE ONE WITH AN ANSWER. Without it every expectation is "none", and a
    // regression where the candidate block never renders at all still scores
    // 100% — the metric would have no failure mode.
    id: 'names-the-tap+candidates',
    text: 'The kitchen tap you looked at is dripping again — same as before, worse in the mornings.',
    candidates: [BOILER, TAP],
    expect: { committed: false, skips: false, status: null },
  },
  {
    id: 'work-finished+candidates',
    text: byId('work-finished').text,
    candidates: [BOILER, TAP],
    expect: { committed: false, skips: false, status: 'completed' },
  },
];

// Which candidate the message is about, for the twins that have an answer. Null
// means "none of them" — the specimen's own case, and the one a count can never
// express. Graded only once Phase 2 renders the list.
export const CHOICE_EXPECT = {
  'commitment-outbound+candidates': null, // a bathroom faucet is neither of these
  'names-the-tap+candidates': 2, // "the kitchen tap" IS candidate 2
  'thank-you+candidates': null, // thanks for a quick reply names no work at all
  'work-finished+candidates': null, // "the repair" names neither job
};
