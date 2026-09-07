import { describe, expect, test } from 'vitest';
import { EXTRACTION_TOOL } from './extract.js';

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
