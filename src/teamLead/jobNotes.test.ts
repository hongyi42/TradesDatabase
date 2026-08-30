import { describe, expect, test } from 'vitest';
import { JOB_NOTE_MAX, noteLine, validateJobNoteContent } from './jobNotes.js';

// Pure unit tests — the rails take no database.
const NOW = Date.parse('2026-08-30T12:00:00.000Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe('validateJobNoteContent', () => {
  test('accepts ordinary prose', () => {
    expect(validateJobNoteContent('Marisol prefers a call first.')).toEqual({
      content: 'Marisol prefers a call first.',
    });
  });

  test('refuses a non-string rather than throwing on it', () => {
    for (const bad of [undefined, null, 42, ['a', 'b'], { a: 1 }]) {
      const out = validateJobNoteContent(bad);
      expect(out, String(bad)).toHaveProperty('refused');
    }
    const out = validateJobNoteContent(42);
    expect('refused' in out && out.refused).toContain('must be text');
  });

  test('refuses empty and whitespace-only, and says a note cannot be deleted', () => {
    // The deliberate divergence from write_memory, where empty content deletes.
    // Refusing is what keeps this write strictly non-destructive, which is the
    // whole answer to the dispatch gate's "nothing irreversible" rule.
    for (const blank of ['', '   ', '\n', '\t \n ']) {
      const out = validateJobNoteContent(blank);
      expect(out, JSON.stringify(blank)).toHaveProperty('refused');
      expect('refused' in out && out.refused).toContain('cannot be deleted');
    }
  });

  test('refuses over-budget with BOTH the size and the budget in the message', () => {
    const out = validateJobNoteContent('x'.repeat(JOB_NOTE_MAX + 1));
    expect(out).toHaveProperty('refused');
    const why = 'refused' in out ? out.refused : '';
    // Both numbers, so the model can act on the refusal instead of guessing.
    expect(why).toContain(String(JOB_NOTE_MAX + 1));
    expect(why).toContain(String(JOB_NOTE_MAX));
  });

  test('exactly at the budget is accepted — the boundary is inclusive', () => {
    expect(validateJobNoteContent('x'.repeat(JOB_NOTE_MAX))).toHaveProperty('content');
  });
});

describe('noteLine', () => {
  test('returns null when the job has no note', () => {
    // The historyLine contract: announce existence, never absence. A line on
    // every gap saying "no note yet" would be a standing nudge to write one.
    expect(noteLine(null, NOW)).toBeNull();
    expect(noteLine(undefined, NOW)).toBeNull();
    expect(noteLine('', NOW)).toBeNull();
  });

  test('announces the note and names the tool to open it', () => {
    const line = noteLine(hoursAgo(3), NOW);
    expect(line).toBe('  you have a note on this job, last written 3h ago. Use read_job_note for it.');
    // Indented like every other gap-block line, so it cannot be mistaken for a
    // section heading — and so escapeForPrompt's column-zero rules never apply.
    expect(line?.startsWith('  ')).toBe(true);
  });

  test('a note written moments ago reads as 1h, never 0h', () => {
    expect(noteLine(hoursAgo(0), NOW)).toContain('1h ago');
  });

  test('a FUTURE stamp prints no elapsed time rather than a negative one', () => {
    // The eval drives a simulated clock backwards between scenarios, so a note
    // stamped by a later scenario would otherwise render as "-6h ago".
    const line = noteLine(new Date(NOW + 6 * 3_600_000).toISOString(), NOW);
    expect(line).toBe('  you have a note on this job. Use read_job_note for it.');
    expect(line).not.toContain('-');
  });

  test('an unparseable stamp degrades to the bare announcement', () => {
    expect(noteLine('not-a-date', NOW)).toBe('  you have a note on this job. Use read_job_note for it.');
  });
});
