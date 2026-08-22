import { describe, expect, it } from 'vitest';
import { oneShotNoteStamp } from './server.js';

// The stamp is the ONLY thing standing between a retried tool call and a second
// permanent L1 row (there is no delete). Two failure directions, both bad:
//   * too FEW inputs -> two different notes collide, and the second is answered
//     `duplicate` and silently never recorded;
//   * too MANY inputs -> one note writes twice.
// These pin the inputs directly, because reaching some of them through the tool
// requires the identity matcher to resolve a particular job, which is not
// something a test can steer reliably.
describe('oneShotNoteStamp', () => {
  const base = {
    tenantId: 't1',
    technicianRef: 'ben-shelton',
    channel: 'technician_note' as const,
    resolved: { customerId: 'c1' },
    text: 'done, all good',
    blobPath: null,
  };

  it('is stable for the same note', () => {
    expect(oneShotNoteStamp(base)).toBe(oneShotNoteStamp({ ...base }));
    expect(oneShotNoteStamp(base)).toMatch(/^note:[0-9a-f]{64}$/);
  });

  it('separates two JOBS of the same customer', () => {
    // The case a customerId-only key loses: one customer, two jobs, the same
    // words on both ("done, all good"). The second note would come back
    // `duplicate` and never reach the record.
    const a = oneShotNoteStamp({ ...base, resolved: { customerId: 'c1', jobId: 'j1' } });
    const b = oneShotNoteStamp({ ...base, resolved: { customerId: 'c1', jobId: 'j2' } });
    expect(a).not.toBe(b);
    // …and a job-less resolution is its own thing again, not either of those.
    expect(oneShotNoteStamp(base)).not.toBe(a);
  });

  it('separates two PHOTOS with no text at all', () => {
    // A note can be a blobPath with text null. Hash the text alone and every
    // photo for one customer is "the same note".
    const a = oneShotNoteStamp({ ...base, text: null, blobPath: 'blob/one.jpg' });
    const b = oneShotNoteStamp({ ...base, text: null, blobPath: 'blob/two.jpg' });
    expect(a).not.toBe(b);
  });

  it('separates every other field that identifies a note', () => {
    const keys = [
      { tenantId: 't2' },
      { technicianRef: 'other-tech' },
      { channel: 'phone_call' as const },
      { resolved: { customerId: 'c2' } },
      { text: 'done, all bad' },
    ];
    const stamps = new Set([oneShotNoteStamp(base), ...keys.map((k) => oneShotNoteStamp({ ...base, ...k }))]);
    expect(stamps.size).toBe(keys.length + 1);
  });

  it('does NOT vary with the clock — a note must not re-record at midnight', () => {
    // Deliberately no date component: it would trade a rare same-note
    // re-record for a midnight-straddle DOUBLE WRITE, which is undeletable.
    const src = oneShotNoteStamp.toString();
    expect(src).not.toMatch(/Date|now\(|toISOString/);
  });
});
