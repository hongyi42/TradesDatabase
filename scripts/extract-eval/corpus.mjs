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
//
// ─────────────────────────────────────────────────────────────────────────────
// v3: THE TEXT NOW LOOKS LIKE WHAT THE DOOR ACTUALLY RECEIVES.
//
// v2's fixtures were bare one-liners. Production never sends the extractor a
// bare one-liner: EVERY email path builds `formatEmailRawText`
// (`src/email/format.ts:13`) — `Subject: …\nFrom: …\n\n<body>` — the inbound
// webhook and pull (`src/inbound/gmail.ts:102`), the firm's own sent mail
// (`src/inbound/gmailSent.ts:82`) and the assistant's sends
// (`src/mcp/tools/comms.ts:383`) alike. And NOTHING in that path strips a
// quoted reply tail, a signature block or a mobile footer: the body is
// Composio's `message_text` verbatim (`src/inbound/gmail.ts:39`). A phone call
// is the other shape — a bare transcript, no headers (`src/calls/worker.ts:130`).
//
// That gap mattered for one field in particular. `EXTRACTION_SYSTEM` says a
// visit the firm agreed to in an EARLIER message "is already handled, so it
// must NOT set visitCommitted" (`extract.ts:123-125`) — a rule that assumes
// earlier messages arrive AS earlier messages. In real mail the earlier offer
// is sitting INSIDE the body being judged, under "On Tue, 8 Sep… wrote:". So
// the model is asked "does this message commit a visit?" about a blob holding
// both the new sentence and the old promise, and reading that as already
// handled is precisely the suppression that lost the live specimen's
// appointment. v2 could not produce it. v3 pairs both commitment fixtures with
// a quoted-tail twin so the bare and quoted forms can be compared directly.
//
// ONE SHAPE IS DELIBERATELY ABSENT: a thank-you whose quoted tail carries the
// firm's dated promise. Its right answer is not settled — `EXTRACTION_SYSTEM`
// ends "when in any doubt, leave it true", so an extractor answering
// `touchesOperations: true` there is OBEYING the prompt, and scoring it against
// `skips: true` would manufacture a failure out of correct behaviour. Recorded
// as a known untested shape rather than graded wrongly.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT "COMMITTED" MEANS — operator ruling 2026-09-17, option B.
//
// `committed` answers: IS A VISIT NOW AGREED, as of this message, whoever said
// so. Not "is this message the firm agreeing" (v2's rule, rejected): a firm
// that offers a slot and a customer who accepts it produces an agreed visit
// where NEITHER message is the firm agreeing, so that reading raised nothing at
// any point in the commonest booking flow there is — a silent loss identical in
// shape to the live specimen. B fails toward telling the planner, and the
// system has rails for over-telling (a capture landing on a job with a live
// visit asks nothing; the send rail stops a second nudge) where it has none for
// a promise nobody ever raised.
//
// An offer alone is not agreement ("we could come Thursday if that suits") and
// a request alone is not ("could someone come out?"). The firm stating it will
// attend IS agreement without waiting for a reply.

/** @typedef {{ messageId: string, from: string, to: string, subject: string, body: string, at: string }} ThreadMessage */
/** @typedef {{ id: string, text: string, fromTheFirm?: boolean, earlier?: ThreadMessage[], candidates?: {title: string|null, status: string}[], expect: { committed: boolean, skips: boolean, status: 'completed'|'in_progress'|null } }} Fixture */

// Bump when any text, label or fixture changes: a baseline is only comparable
// to a later run of the SAME corpus, and "92%" with no version beside it is a
// number nobody can check.
export const CORPUS_VERSION = 3;

const TAP = { title: 'Kitchen tap dripping', status: 'in_progress' };
const BOILER = { title: 'Boiler diagnostic', status: 'open' };

// The firm and three customers, so a signature block is always attributable to
// somebody and the "never take identity from OUR signature" rule is exercised.
const FIRM_FROM = 'Sam Okafor <office@northside.test>';
const FIRM_SIG = 'Sam\nNorthside Plumbing\n0161 555 0102';

/** Real email shape: the header prefix every path builds, then the body. */
const mail = (subject, from, body) => `Subject: ${subject}\nFrom: ${from}\n\n${body}`;

/** A quoted reply tail, the way a mail client appends one. */
const quoted = (when, who, lines) =>
  `On ${when}, ${who} wrote:\n${lines.map((l) => (l ? `> ${l}` : '>')).join('\n')}`;

/** @type {Fixture[]} */
export const FIXTURES = [
  {
    // THE SPECIMEN'S OWN MESSAGE. The firm states it will attend, on a named
    // day, in a named window. Nothing conditional, nothing to accept.
    id: 'commitment-outbound',
    fromTheFirm: true,
    text: mail(
      'Re: Bathroom faucet',
      FIRM_FROM,
      "Hi Delphine,\n\nWe'll send a technician out on Wednesday 16 September between 10am and 12pm to sort the dripping bathroom faucet.\n\n" +
        FIRM_SIG,
    ),
    expect: { committed: true, skips: false, status: null },
  },
  {
    // THE SAME PROMISE, in the shape a reply actually arrives in. If this
    // scores below its bare twin, the quoted tail is suppressing a live
    // commitment — the specimen's failure, reproduced in the corpus.
    id: 'commitment-outbound-quoted',
    fromTheFirm: true,
    text: mail(
      'Re: Bathroom faucet',
      FIRM_FROM,
      "Hi Delphine,\n\nWe'll send a technician out on Wednesday 16 September between 10am and 12pm to sort the dripping bathroom faucet.\n\n" +
        FIRM_SIG +
        '\n\n' +
        quoted('Mon, 14 Sep 2026 at 18:22', 'Delphine Warrick <delphine@example.test>', [
          'Hello,',
          '',
          'The bathroom faucet has started dripping again, not the kitchen one',
          "this time. It's slow but it's constant and it's staining the basin.",
          'Any chance someone could take a look this week? Mornings are easiest',
          'for me.',
          '',
          'Thanks,',
          'Delphine',
        ]),
    ),
    expect: { committed: true, skips: false, status: null },
  },
  {
    id: 'customer-asks',
    text: mail(
      'Boiler banging again',
      'Marcus Reid <marcus@example.test>',
      'Hi — the boiler is making a banging noise again. Could someone come and look at it?\n\nThanks,\nMarcus Reid\n07700 900 118',
    ),
    expect: { committed: false, skips: false, status: null },
  },
  {
    // Deliberately says nothing about the state of any work, and its subject
    // line is neutral too: "Re: Your appointment" would put operational content
    // in the header and make `skips` arguable.
    id: 'thank-you',
    text: mail(
      'Re: Quick question',
      'Iris Bell <iris@example.test>',
      'Thanks so much for getting back to me so quickly — really appreciate it.\n\nSent from my iPhone',
    ),
    expect: { committed: false, skips: true, status: null },
  },
  {
    id: 'work-finished',
    text: mail(
      'All sorted',
      'Iris Bell <iris@example.test>',
      'Just to let you know your engineer finished the repair this morning and everything is running again.\n\nBest,\nIris',
    ),
    expect: { committed: false, skips: false, status: 'completed' },
  },
  {
    // DIRECTION 1 of agreement: the customer proposed, the firm accepts. Under
    // ruling B a visit is now agreed, so `committed` is true. v2 measured this
    // 0/3 with the same label — the bare form gives the model no sight of what
    // "Yes" is answering, and its twin below is the controlled comparison.
    id: 'firm-confirms',
    fromTheFirm: true,
    text: mail(
      'Re: Thursday?',
      FIRM_FROM,
      'Yes, Thursday morning works on our side — we will see you then.\n\n' + FIRM_SIG,
    ),
    expect: { committed: true, skips: false, status: null },
  },
  {
    // The same acceptance with the proposal it answers quoted beneath. Bare
    // says false and quoted says true → the model needed the context. Both
    // false → commitment recognition itself is weak, which is Phase 5's target.
    id: 'firm-confirms-quoted',
    fromTheFirm: true,
    text: mail(
      'Re: Thursday?',
      FIRM_FROM,
      'Yes, Thursday morning works on our side — we will see you then.\n\n' +
        FIRM_SIG +
        '\n\n' +
        quoted('Tue, 15 Sep 2026 at 09:04', 'Marcus Reid <marcus@example.test>', [
          'Hi Sam,',
          '',
          'Could you do Thursday morning for the radiator? I can be in any',
          'time before one.',
          '',
          'Marcus',
        ]),
    ),
    expect: { committed: true, skips: false, status: null },
  },
  {
    // The booked slot is being withdrawn and the replacement is only requested,
    // so nothing is agreed as of this message.
    id: 'reschedule-in-thread',
    earlier: [
      {
        messageId: 'm1',
        from: 'Northside Plumbing <office@northside.test>',
        to: 'iris@example.test',
        subject: 'Your radiator',
        body: 'We have you down for Tuesday at 9am. Give us a shout if that changes.\n\n' + FIRM_SIG,
        at: '2026-09-08T10:00:00.000Z',
      },
    ],
    text: mail(
      'Re: Your radiator',
      'Iris Bell <iris@example.test>',
      'Could we do Friday afternoon instead? Tuesday no longer works for me.\n\nIris\n\n' +
        quoted('Tue, 8 Sep 2026 at 11:00', 'Northside Plumbing <office@northside.test>', [
          'We have you down for Tuesday at 9am. Give us a shout if that changes.',
          '',
          'Sam',
          'Northside Plumbing',
        ]),
    ),
    expect: { committed: false, skips: false, status: null },
  },
  {
    // DIRECTION 2, and the commonest one: the firm offered, the customer
    // accepts. RELABELLED true at v3 under ruling B — v2 called this false on
    // the rejected "is THIS message the firm agreeing" reading, which raised
    // nothing for either half of this exchange.
    //
    // The offer now appears TWICE, as it does in production: once in the fetched
    // thread context and once inside the quoted tail of the body being judged.
    id: 'thursday-works-thread',
    earlier: [
      {
        messageId: 'm1',
        from: 'Iris Bell <iris@example.test>',
        to: 'office@northside.test',
        subject: 'Kitchen tap',
        body: 'The kitchen tap is dripping again, worse than last time.\n\nIris',
        at: '2026-09-08T09:00:00.000Z',
      },
      {
        messageId: 'm2',
        from: 'Northside Plumbing <office@northside.test>',
        to: 'iris@example.test',
        subject: 'Re: Kitchen tap',
        body: 'We could come Thursday morning if that suits.\n\n' + FIRM_SIG,
        at: '2026-09-08T11:00:00.000Z',
      },
    ],
    text: mail(
      'Re: Kitchen tap',
      'Iris Bell <iris@example.test>',
      'Thursday works.\n\nSent from my iPhone\n\n' +
        quoted('Tue, 8 Sep 2026 at 11:02', 'Northside Plumbing <office@northside.test>', [
          'We could come Thursday morning if that suits.',
          '',
          'Sam',
          'Northside Plumbing',
          '0161 555 0102',
        ]),
    ),
    expect: { committed: true, skips: false, status: null },
  },
  {
    // SIX MESSAGES, and one earlier body over THREAD_MESSAGE_CHARS (600) so the
    // cut in renderThreadContext is exercised for the first time. A DEAD offer
    // sits in the history — Monday, declined — and the live one is accepted in
    // the latest message, so "already handled" must not fire off the dead one.
    id: 'long-thread-accept',
    earlier: [
      {
        messageId: 'm1',
        from: 'Marcus Reid <marcus@example.test>',
        to: 'office@northside.test',
        subject: 'Hall radiator cold',
        body: 'The hall radiator is stone cold while the rest of the house is fine. I bled it last weekend and got nothing but water. Can you take a look?\n\nMarcus',
        at: '2026-09-10T08:12:00.000Z',
      },
      {
        messageId: 'm2',
        from: 'Northside Plumbing <office@northside.test>',
        to: 'marcus@example.test',
        subject: 'Re: Hall radiator cold',
        body: 'Sounds like the valve. We could come Monday morning if that works.\n\n' + FIRM_SIG,
        at: '2026-09-10T09:30:00.000Z',
      },
      {
        messageId: 'm3',
        from: 'Marcus Reid <marcus@example.test>',
        to: 'office@northside.test',
        subject: 'Re: Hall radiator cold',
        body: "Monday is no good I'm afraid, I'm away until Tuesday night. Would later in the week be possible? And do you need to order the valve first?\n\nMarcus",
        at: '2026-09-10T12:04:00.000Z',
      },
      {
        messageId: 'm4',
        from: 'Northside Plumbing <office@northside.test>',
        to: 'marcus@example.test',
        subject: 'Re: Hall radiator cold',
        body:
          'Thanks Marcus. I had a look at the notes from the last visit and the valve we replaced then is a different pattern to the one on the hall radiator, so we would want to bring both sizes with us rather than order on the day. The part store has the 15mm in stock and the 22mm is due in on Tuesday, so either way we are covered for a Wednesday afternoon slot. One thing worth saying now: if the bleed screw is seized when we get there it turns into a longer job and we may need to come back with the pump, but that is unusual on a system your age and we will tell you on the day rather than guess. Let us know if Wednesday afternoon still suits and we will hold it.\n\n' +
          FIRM_SIG,
        at: '2026-09-11T08:45:00.000Z',
      },
      {
        messageId: 'm5',
        from: 'Marcus Reid <marcus@example.test>',
        to: 'office@northside.test',
        subject: 'Re: Hall radiator cold',
        body: 'Understood on the parts. Let me check with my wife about Wednesday and come back to you today.\n\nMarcus',
        at: '2026-09-11T09:20:00.000Z',
      },
    ],
    text: mail(
      'Re: Hall radiator cold',
      'Marcus Reid <marcus@example.test>',
      "Wednesday afternoon is good, let's do that. Anytime after one is fine.\n\nMarcus\n\n" +
        quoted('Fri, 11 Sep 2026 at 08:45', 'Northside Plumbing <office@northside.test>', [
          'Let us know if Wednesday afternoon still suits and we will hold it.',
          '',
          'Sam',
          'Northside Plumbing',
        ]),
    ),
    expect: { committed: true, skips: false, status: null },
  },
  {
    id: 'quote-request',
    text: mail(
      'Boiler replacement cost',
      'Marcus Reid <marcus@example.test>',
      'What would you charge to replace the whole boiler? No rush, just budgeting.\n\nMarcus',
    ),
    expect: { committed: false, skips: false, status: null },
  },
  {
    // A PHONE CALL, which is the other text shape the door sees: a bare
    // transcript, no headers (`src/calls/worker.ts:130`). Every other fixture
    // here is email, so without one of these the corpus would test one channel
    // and claim to test the door.
    id: 'wrong-number',
    text: "Oh — sorry, I think I've got the wrong number. I was after the vet on Bridge Street. Sorry to bother you.",
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
    text: mail(
      'Tap again',
      'Iris Bell <iris@example.test>',
      'The kitchen tap you looked at is dripping again — same as before, worse in the mornings.\n\nIris',
    ),
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
