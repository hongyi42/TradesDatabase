import { describe, expect, test } from 'vitest';
import type { CustomerContext } from '../db/index.js';
import { capture, customer, job, visit } from './fixtures.js';
import { serializeContextForPrompt, validateCitations } from './grounding.js';

// A context with two captures, one of which is blob-only (raw_text: null), to
// exercise the placeholder path.
const fixture = (): CustomerContext => ({
  customer: customer(),
  jobs: [job()],
  recentVisits: [visit()],
  recentCaptures: [
    capture(),
    capture({ id: 'cap-b', channel: 'technician_photo', raw_text: null }),
  ],
});

describe('serializeContextForPrompt', () => {
  test('includes capture ids, non-null raw_text, the null placeholder, and the visit source_capture', () => {
    const text = serializeContextForPrompt(fixture());
    expect(text).toContain('cap-a');
    expect(text).toContain('cap-b');
    expect(text).toContain('Capacitor failing, recommend full unit replacement soon.');
    expect(text).toContain('(no text — blob/photo)'); // cap-b has raw_text: null
    expect(text).toContain('source_capture=cap-a'); // visit links to its capture
    expect(text).not.toContain(': null'); // null raw_text never prints literally
  });
});

describe('validateCitations', () => {
  const context = fixture();

  test('keeps a citation with a real captureId', () => {
    const out = validateCitations([{ claim: 'capacitor failing', captureId: 'cap-a' }], context);
    expect(out).toEqual([{ claim: 'capacitor failing', captureId: 'cap-a' }]);
  });

  test('drops a citation with a fabricated captureId', () => {
    const out = validateCitations([{ claim: 'made up', captureId: 'cap-zzz' }], context);
    expect(out).toEqual([]);
  });

  test('returns [] for undefined input', () => {
    expect(validateCitations(undefined, context)).toEqual([]);
  });

  test('returns [] for a non-array input (malformed model output)', () => {
    // The model could emit citations as a non-array despite the schema; this must
    // not throw on iteration.
    expect(validateCitations('nope' as unknown as undefined, context)).toEqual([]);
  });

  test('de-dupes identical (claim, captureId) pairs', () => {
    const out = validateCitations(
      [
        { claim: 'capacitor failing', captureId: 'cap-a' },
        { claim: 'capacitor failing', captureId: 'cap-a' },
      ],
      context,
    );
    expect(out).toHaveLength(1);
  });
});
