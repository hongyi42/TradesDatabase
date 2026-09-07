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

  test('the fields inbound depends on are all still declared', () => {
    for (const key of ['jobTitle', 'jobType', 'address', 'followUp', 'attributes']) {
      expect(props[key], `${key} feeds the observation and the correspondence entry`).toBeDefined();
    }
  });
});
