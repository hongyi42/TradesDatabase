import { describe, expect, test } from 'vitest';
import {
  EXTRACTION_SYSTEM,
  EXTRACTION_TOOL,
  renderExtractionUser,
  renderCandidateJobs,
  CANDIDATE_TITLE_CHARS,
  renderThreadContext,
} from './extract.js';
import type { ThreadMessage } from '../email/format.js';

// A SCHEMA PIN, not a model test. `visitCommitted` is the one field that decides
// whether an inbound call raises an ask, and it FAILS OPEN: absent reads as "not
// committed", so a field silently dropped from the forced tool would quietly
// stop every commitment reaching a manager, with nothing to notice it. The
// forced-tool spec is also the only place the model is told the rule.
describe('the extraction tool schema (rung 10)', () => {
  const props = (EXTRACTION_TOOL.inputSchema as {
    properties: Record<string, { type?: string; description?: string }>;
  }).properties;

  test('visitCommitted is a boolean the model can set', () => {
    expect(props.visitCommitted).toBeDefined();
    expect(props.visitCommitted.type).toBe('boolean');
  });

  test('its description draws the line the whole rung rests on', () => {
    const desc = props.visitCommitted.description ?? '';
    // AMENDED 2026-09-17 (operator ruling, option B). The line is "a visit is
    // NOW AGREED", not "the firm said yes". The old wording — "ONLY if the
    // business agreed to send someone out" — raised nothing for the commonest
    // booking flow there is: the firm offers a slot (not agreement) and the
    // customer accepts it (not the firm speaking), so a visit exists on the
    // customer's calendar and neither message ever asked anybody.
    expect(desc).toMatch(/now agreed/i);
    expect(desc).toMatch(/customer accepting a time the firm offered/i);
    expect(desc).not.toMatch(/only if the business agreed/i);
    // UNCHANGED, and the half that keeps the rung honest: a caller REQUESTING a
    // visit must not set it, or every enquiry would text a manager.
    expect(desc).toMatch(/never true because someone asked/i);
  });

  // THE MODEL NAMES THE JOB. Both fields are optional and mean nothing without a
  // rendered list, so the pin is on the SHAPE and on one word of the
  // description: `jobChoice` must stay a NUMBER. Were it ever widened to a
  // string the door would start receiving ids it cannot verify against the list
  // it showed, which is the failure the number exists to prevent.
  test('jobChoice is a number keyed to the list shown, with a reason beside it', () => {
    expect(props.jobChoice).toBeDefined();
    expect(props.jobChoice.type).toBe('number');
    expect(props.jobChoice.description ?? '').toMatch(/number/i);
    expect(props.jobChoiceReason).toBeDefined();
    expect(props.jobChoiceReason.type).toBe('string');
  });

  // The MIRROR of visitCommitted, and it fails the OTHER way: absent reads as
  // "ask", so a dropped field degrades to waking the planner for everything
  // rather than silencing it. It asks about the OPERATIONS LAYER (job, visit,
  // schedule, parts, money) — a property of the text — never about whether
  // someone ought to care, which this call has no standing to judge. That is the safe direction, which is exactly why
  // it needs a pin — the failure is invisible in production, showing up only as
  // a planner bill nobody can explain.
  test('touchesOperations is a boolean, and false is the narrow case', () => {
    expect(props.touchesOperations).toBeDefined();
    expect(props.touchesOperations.type).toBe('boolean');
    const desc = props.touchesOperations.description ?? '';
    // The model must be told that false is the exception, not the default.
    expect(desc).toMatch(/false only/i);
    expect(desc).toMatch(/doubt, true/i);
    // The schema said "an acknowledgement of something already agreed" until
    // 2026-09-17, when the eval measured that reading skipping real operational
    // replies: "Thursday works." came back false in 9 runs of 10.
    expect(desc).toMatch(/length and tone are not the test/i);
    expect(desc).not.toMatch(/acknowledgement/i);
    // THE RE-FRAME, pinned. The first version asked "does anyone need to act on
    // this?" — a judgment about people, which this call cannot make: it has no
    // customer, no history, no schedule. It now names the operations-layer
    // objects, which the TEXT can answer for. Losing that enumeration would
    // silently return the question to the one that could not be answered.
    for (const object of ['job', 'visit', 'schedule', 'money']) {
      expect(desc.toLowerCase(), `the model is told ${object} counts`).toContain(object);
    }
  });

  test('the fields inbound depends on are all still declared', () => {
    for (const key of ['jobTitle', 'jobType', 'address', 'followUp', 'attributes']) {
      expect(props[key], `${key} feeds the observation and the correspondence entry`).toBeDefined();
    }
  });
});

// RUNG 10B — THE CONVERSATION, RENDERED. A reply's own words are often useless
// alone ("Friday afternoon instead?") while the name and the number sit three
// messages up. What the model is SHOWN is bounded, ordered, and labelled.
describe('renderThreadContext (rung 10b)', () => {
  const msg = (n: number, over: Partial<ThreadMessage> = {}): ThreadMessage => ({
    messageId: `m${n}`,
    from: `sender${n}@example.test`,
    to: 'office@firm.test',
    subject: `Subject ${n}`,
    body: `body ${n}`,
    at: `2026-09-0${n}T10:00:00.000Z`,
    ...over,
  });

  test('empty in, empty out — and no header for a thread with nothing earlier', () => {
    expect(renderThreadContext([])).toBe('');
  });

  test('the LAST EIGHT only, oldest first', () => {
    const many = Array.from({ length: 12 }, (_, i) => msg(i + 1, { body: `body ${i + 1}` }));
    const out = renderThreadContext(many);
    expect(out).toContain('EARLIER IN THIS CONVERSATION (context only)');
    expect(out).not.toContain('body 4'); // dropped: only the last eight survive
    expect(out).toContain('body 5');
    expect(out).toContain('body 12');
    // Oldest first: the earliest survivor appears before the newest.
    expect(out.indexOf('body 5')).toBeLessThan(out.indexOf('body 12'));
    expect(out.split('---')).toHaveLength(8);
  });

  test('each message is cut at 600 characters', () => {
    const out = renderThreadContext([msg(1, { body: 'x'.repeat(1200) })]);
    expect(out).toContain('x'.repeat(600));
    expect(out).not.toContain('x'.repeat(601));
    expect(out).toContain('\u2026');
  });

  test('a message missing its headers still renders its words', () => {
    const out = renderThreadContext([
      { messageId: null, from: null, to: null, subject: null, body: 'just the words', at: null },
    ]);
    expect(out).toContain('just the words');
  });
});

describe('the extraction system prompt (rung 10b)', () => {
  test('identity may come from earlier messages; judgments may not', () => {
    expect(EXTRACTION_SYSTEM).toContain('EARLIER MESSAGES');
    expect(EXTRACTION_SYSTEM).toContain('LATEST MESSAGE alone');
    // The four fields the latest message alone decides — named, so a future
    // edit cannot quietly widen what the history is allowed to answer.
    for (const field of ['jobTitle', 'statusSignal', 'visitCommitted', 'touchesOperations']) {
      expect(EXTRACTION_SYSTEM).toContain(field);
    }
  });

  // RUNG 10B.3. The firm's own SENT mail now reaches this extractor. The rule
  // above covers the firm's replies only as EARLIER context; when OUR reply is
  // the message being judged, it has to be restated or the model reads our
  // signature block as the customer's identity — the same failure `isOwnMailbox`
  // exists to prevent, arriving through a new door.
  test("the prompt tells the model what to do when the LATEST message is the firm's own", () => {
    expect(EXTRACTION_SYSTEM).toContain("YOUR OWN FIRM'S REPLY");
    // Identity is refused; what the firm SAYS still counts in full.
    expect(EXTRACTION_SYSTEM).toContain('signature block');
    expect(EXTRACTION_SYSTEM).toContain('IS a commitment');
  });

  // PHASE 5, STEP 1. Both sentences were written against a measurement, not a
  // hunch (scripts/extract-eval, corpus v3, 2026-09-17): "an acknowledgement"
  // in the touchesOperations exemption was matching short operational replies
  // by FORM — "Thursday works." skipped in 9 runs of 10 — and the firm
  // agreeing a date was coming back `in_progress`, which `open` accepts as a
  // transition and so flips a job to work-underway before anybody has been out.
  // Pinned because a later tidy-up of this prompt would silently restore both.
  test('a short operational reply is not chit-chat, and arranging a visit is not work underway', () => {
    expect(EXTRACTION_SYSTEM).toContain('LENGTH AND TONE ARE NOT THE TEST');
    expect(EXTRACTION_SYSTEM).toContain('ARRANGING A VISIT IS NOT WORK UNDERWAY');
    // The word that was doing the damage is gone from the exemption list.
    expect(EXTRACTION_SYSTEM).not.toContain('an acknowledgement, an auto-reply');
  });

  // PHASE 5, STEP 2 — operator ruling 2026-09-17 (option B). `visitCommitted`
  // asks whether a visit is AGREED, not whether this message is the firm
  // agreeing: the rejected reading raised nothing for either half of "firm
  // offers a slot" + "customer accepts it", which is how most bookings happen.
  // The second pin is the quoted-tail half, measured: "Thursday works."
  // answered committed 3/3 bare and 0/10 with the firm's offer quoted beneath.
  test('an acceptance agrees the visit, and quoted history is not "already handled"', () => {
    expect(EXTRACTION_SYSTEM).toContain('A VISIT IS NOW AGREED as of this message');
    expect(EXTRACTION_SYSTEM).toContain('AN OFFER MADE EARLIER IS NOT AN AGREEMENT');
    expect(EXTRACTION_SYSTEM).toContain('quoted');
    // The rejected wording must not creep back.
    expect(EXTRACTION_SYSTEM).not.toContain('ONLY when the BUSINESS agreed');
  });
});

describe('renderExtractionUser (rung 10b.3)', () => {
  const earlier: ThreadMessage[] = [
    {
      messageId: 'm1',
      from: 'iris@homeowner.test',
      to: 'office@firm.test',
      subject: 'Radiator',
      body: 'still cold upstairs',
      at: '2026-09-08T10:00:00.000Z',
    },
  ];

  test("the firm's own reply is LABELLED as such — the model cannot tell from the text", () => {
    const user = renderExtractionUser('Subject: Re\nFrom: office@firm.test\n\nThursday works.', {
      earlier: [],
      fromTheFirm: true,
    });
    expect(user).toContain("YOUR OWN FIRM'S REPLY");
    expect(user).toContain('Thursday works.');
  });

  test('an inbound message with no thread is passed through BARE, exactly as before', () => {
    // The one shape that must not shift: labelling it would change the prompt
    // for every ordinary email and call in the system for no gain.
    expect(renderExtractionUser('unit still noisy')).toBe('unit still noisy');
    expect(renderExtractionUser('unit still noisy', { earlier: [] })).toBe('unit still noisy');
  });

  test('with a thread, the latest message is labelled either way and comes LAST', () => {
    const inbound = renderExtractionUser('the latest words', { earlier });
    expect(inbound).toContain('EARLIER IN THIS CONVERSATION');
    expect(inbound.indexOf('still cold upstairs')).toBeLessThan(inbound.indexOf('the latest words'));
    expect(inbound).toContain('LATEST MESSAGE');
    expect(inbound).not.toContain("YOUR OWN FIRM'S REPLY");

    const ours = renderExtractionUser('the latest words', { earlier, fromTheFirm: true });
    expect(ours).toContain("YOUR OWN FIRM'S REPLY");
    expect(ours.indexOf('still cold upstairs')).toBeLessThan(ours.indexOf('the latest words'));
  });

  // PHASE 2 — THE CANDIDATE LIST. It goes in the USER message, which is what
  // leaves EXTRACTION_SYSTEM byte-identical and lets the eval attribute a moved
  // score to this block alone. Order matters for the same reason the thread's
  // does: the model's judgments must come from the bottom of what it is shown.
  const candidates = [
    { title: 'Boiler diagnostic', status: 'open' },
    { title: 'Kitchen tap dripping', status: 'in_progress' },
  ];

  test('an empty list changes nothing — all three existing shapes are untouched', () => {
    expect(renderExtractionUser('unit still noisy', { earlier: [], candidates: [] })).toBe(
      'unit still noisy',
    );
    expect(renderExtractionUser('unit still noisy', { earlier: [] })).toBe('unit still noisy');
    expect(renderExtractionUser('the latest words', { earlier, candidates: [] })).toBe(
      renderExtractionUser('the latest words', { earlier }),
    );
    expect(
      renderExtractionUser('ours', { earlier: [], fromTheFirm: true, candidates: [] }),
    ).toBe(renderExtractionUser('ours', { earlier: [], fromTheFirm: true }));
  });

  test('with a list: thread, then the numbered jobs, then the label, then the message', () => {
    const user = renderExtractionUser('the tap again', { earlier, candidates });
    const at = (needle: string) => user.indexOf(needle);
    expect(at('EARLIER IN THIS CONVERSATION')).toBeGreaterThanOrEqual(0);
    expect(at('EARLIER IN THIS CONVERSATION')).toBeLessThan(at('CANDIDATE JOBS'));
    expect(at('CANDIDATE JOBS')).toBeLessThan(at('LATEST MESSAGE'));
    expect(at('LATEST MESSAGE')).toBeLessThan(at('the tap again'));
    expect(user).toContain('1. Boiler diagnostic (open)');
    expect(user).toContain('2. Kitchen tap dripping (in progress)');
  });

  test('a list with no thread still labels the message — "the LATEST MESSAGE" must point somewhere', () => {
    // The bare path deliberately sends raw text alone. With a numbered list
    // above it, unlabelled text would leave the block referring to nothing.
    const user = renderExtractionUser('the tap again', { earlier: [], candidates });
    expect(user).toContain('LATEST MESSAGE');
    expect(user.indexOf('CANDIDATE JOBS')).toBeLessThan(user.indexOf('LATEST MESSAGE'));
    expect(user).not.toContain('EARLIER IN THIS CONVERSATION');
  });

  test('the block says "none" is an answer, and that the list decides nothing else', () => {
    const user = renderCandidateJobs(candidates);
    // Without this, a list of open jobs reads as "one of these is the answer" —
    // and the specimen's own message (a bathroom faucet) is about NEITHER.
    expect(user).toMatch(/none of them/i);
    expect(user).toMatch(/OMIT BOTH/);
    // And the guard against the failure this whole arc started on: a nearby
    // list of agreed work must not read as "the visit is already handled".
    expect(user).toMatch(/says nothing about whether a visit is agreed/i);
  });

  test('a null title never renders as "null", and a long one is cut', () => {
    const user = renderCandidateJobs([
      { title: null, status: 'open' },
      { title: 'x'.repeat(200), status: 'open' },
    ]);
    expect(user).toContain('1. Untitled job (open)');
    expect(user).not.toContain('null');
    expect(user).toContain(`2. ${'x'.repeat(CANDIDATE_TITLE_CHARS)} (open)`);
    expect(user).not.toContain('x'.repeat(CANDIDATE_TITLE_CHARS + 1));
  });
});
