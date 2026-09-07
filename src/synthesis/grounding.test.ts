import { describe, expect, test } from 'vitest';
import type { CustomerContext } from '../db/index.js';
import { capture, customer, job, visit } from './fixtures.js';
import { serializeContextForPrompt, validateCitations } from './grounding.js';

// A context with two captures, one of which is blob-only (raw_text: null), to
// exercise the placeholder path.
const fixture = (): CustomerContext => ({
  customer: customer(),
  jobs: [job()],
  upcomingVisits: [],
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

  test('wrapped standing facts render as plain value + citeable capture id; plain values pass through', () => {
    const ctx = fixture();
    ctx.customer = customer({
      attributes: {
        gateCode: '1234', // plain value — untouched
        prefers_contact: {
          value: 'email',
          sourceCaptureId: 'cap-fact',
          recordedAt: '2026-07-14T00:00:00.000Z',
        },
      },
    });
    ctx.jobs = [
      job({
        attributes: {
          crane_needed: {
            value: true,
            sourceCaptureId: 'cap-jobfact',
            recordedAt: '2026-07-14T00:00:00.000Z',
          },
        },
      }),
    ];
    const text = serializeContextForPrompt(ctx);
    // The model sees the plain value, with the evidence id alongside to cite.
    expect(text).toContain('prefers_contact="email" (capture cap-fact)');
    expect(text).toContain('crane_needed=true (capture cap-jobfact)');
    // The raw wrapper never leaks into the prompt.
    expect(text).not.toContain('sourceCaptureId');
    // Plain values print as before.
    expect(text).toContain('gateCode="1234"');
    // Visit attributes (plain by construction) stay on the JSON form.
    expect(text).toContain('attributes={"workPerformed":"inspected unit"}');
  });
});

// ---- Rung 10: what the caller said, on the job ----------------------------
const withCorrespondence = (n: number): CustomerContext => {
  const ctx = fixture();
  ctx.jobs = [
    job({
      attributes: {
        gateCode: '1234',
        correspondence: Array.from({ length: n }, (_, i) => ({
          captureId: `cap-corr-${i}`,
          channel: 'email',
          at: `2026-09-0${i + 1}T10:00:00.000Z`,
          followUp: `follow up ${i}`,
        })),
      },
    }),
  ];
  return ctx;
};

describe('correspondence in the brief (rung 10)', () => {
  test('is LABELLED as the customer’s own words, not the firm’s facts', () => {
    const text = serializeContextForPrompt(withCorrespondence(1));
    expect(text).toContain('correspondence (what the customer said on their calls and emails)=');
    // The neighbouring plain key is untouched.
    expect(text).toContain('gateCode="1234"');
  });

  test('is BOUNDED to the newest three, and says how many are older', () => {
    const text = serializeContextForPrompt(withCorrespondence(7));
    // Newest three, in order.
    expect(text).toContain('cap-corr-4');
    expect(text).toContain('cap-corr-5');
    expect(text).toContain('cap-corr-6');
    // The four older ones are counted, never printed — a long-running job must
    // not crowd every other fact out of the brief.
    expect(text).not.toContain('cap-corr-0');
    expect(text).not.toContain('cap-corr-3');
    expect(text).toContain('(4 earlier)');
  });

  test('a single entry prints with no "(N earlier)" tail', () => {
    expect(serializeContextForPrompt(withCorrespondence(1))).not.toContain('earlier)');
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

  test('accepts a CORRESPONDENCE capture id — an inbound capture is in no other list', () => {
    // An inbound capture on an existing job is never stamped with a
    // customer_id (identity resolves after L1, which is immutable), so it is in
    // neither recentCaptures nor the standing-fact ids. The job line shows the
    // model that id; dropping a citation of it would be the silent
    // ungrounded-brief failure this function exists to prevent.
    const ctx = withCorrespondence(1);
    expect(serializeContextForPrompt(ctx)).toContain('cap-corr-0');
    expect(validateCitations([{ claim: 'they asked for a washer', captureId: 'cap-corr-0' }], ctx))
      .toEqual([{ claim: 'they asked for a washer', captureId: 'cap-corr-0' }]);
  });

  test('returns [] for undefined input', () => {
    expect(validateCitations(undefined, context)).toEqual([]);
  });

  test('returns [] for a non-array input (malformed model output)', () => {
    // The model could emit citations as a non-array despite the schema; this must
    // not throw on iteration.
    expect(validateCitations('nope' as unknown as undefined, context)).toEqual([]);
  });

  test('accepts a standing-fact evidence id even when its capture row is not in recentCaptures', () => {
    const ctx = fixture();
    ctx.customer = customer({
      attributes: {
        prefers_contact: {
          value: 'email',
          sourceCaptureId: 'cap-fact-outside',
          recordedAt: '2026-07-14T00:00:00.000Z',
        },
      },
    });
    // The serialized prompt offers '(capture cap-fact-outside)' as citeable,
    // so the validator must not drop a citation of it as hallucinated.
    const out = validateCitations(
      [{ claim: 'customer prefers email', captureId: 'cap-fact-outside' }],
      ctx,
    );
    expect(out).toHaveLength(1);
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
