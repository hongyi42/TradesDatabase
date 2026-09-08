import { describe, expect, test } from 'vitest';
import { EXTRACTION_SYSTEM, EXTRACTION_TOOL, renderThreadContext } from './extract.js';
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
    // "we said yes" — never "they asked". A caller REQUESTING a visit must not
    // set it, or every enquiry would text a manager as a commitment.
    expect(desc).toMatch(/business agreed/i);
    expect(desc).toMatch(/never true because the customer asked/i);
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
});
