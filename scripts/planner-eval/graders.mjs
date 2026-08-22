// Deterministic checks on a handoff note (plan 2026-08-22).
//
// Free and exact, so they run first and the judge only sees what survives.
// The date check imports cleanHandoffNote from dist/ ON PURPOSE: the eval and
// production must share ONE rail, or the eval measures a rail we do not ship.

const BLAME = [
  'ignored', 'ignoring', 'unresponsive', 'failed to', 'has not bothered',
  "hasn't bothered", 'refused to', 'neglected', 'still has not replied',
  "still hasn't replied", 'no response from', 'dropped the ball', 'at fault',
];

// The thing the copy must never do: hand the manager an exit instead of asking
// for the datum (user, 2026-08-21).
const DISMISSAL = /\bdismiss\b/i;

export function deterministicChecks(note, { dateLabels, mustName = [], mustNotClaim = [], cleanHandoffNote }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass, ...(detail ? { detail } : {}) });

  add('present', typeof note === 'string' && note.trim().length > 0);
  if (!note) return checks;

  const { note: railed, why } = cleanHandoffNote(note, dateLabels);
  add('dates-supplied-only', railed !== null, why);

  add('length', note.length <= 400, `${note.length} chars`);
  add('two-sentences-ish', (note.match(/[.!?]\s|[.!?]$/g) ?? []).length <= 3);

  const low = note.toLowerCase();
  const blamed = BLAME.filter((b) => low.includes(b));
  add('no-blame-phrases', blamed.length === 0, blamed.join(', '));

  add('no-dismissal-invite', !DISMISSAL.test(note));
  add('no-link', !/https?:\/\//i.test(note));

  const missing = mustName.filter((m) => !low.includes(m.toLowerCase()));
  add('names-the-subject', missing.length === 0, missing.join(', '));

  const claimed = mustNotClaim.filter((c) => low.includes(c.toLowerCase()));
  add('no-false-claim', claimed.length === 0, claimed.join(', '));

  return checks;
}

export const summarise = (checks) => ({
  passed: checks.filter((c) => c.pass).length,
  total: checks.length,
  failures: checks.filter((c) => !c.pass),
});
