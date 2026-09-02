import { describe, expect, it } from 'vitest';
import { cleanPlannerText } from '../teamLead/planner.js';
import { deterministicChecks } from '../../scripts/planner-eval/graders.mjs';

const LABELS = ['Tuesday, Aug 18 at 12:00 PM', '30 hours ago'];
// `cleanHandoffNote` died with `escalate` (build 6 Phase 1). The rail it
// wrapped did not — this is the same function with the same cap and label, so
// the checks below still measure exactly what production runs.
const cleanNote = (note: unknown, labels: string[]) =>
  cleanPlannerText(note, labels, { label: 'handoff note', maxLen: 400 });
const opts = (over = {}) => ({ dateLabels: LABELS, cleanNote, ...over });
const failed = (note: string, o = {}) =>
  deterministicChecks(note, opts(o)).filter((c) => !c.pass).map((c) => c.name);

describe('planner-copy deterministic checks', () => {
  it('passes a clean note', () => {
    expect(failed("'Tankless descaling' (Marisol Duarte) has no write-up yet. Tell me how it went and I'll record it.",
      { mustName: ['Tankless descaling', 'Marisol Duarte'] })).toEqual([]);
  });

  it('catches blame', () => {
    expect(failed('Ben has ignored two requests about the descaling job.')).toContain('no-blame-phrases');
    expect(failed('The technician failed to report on this visit.')).toContain('no-blame-phrases');
  });

  it('catches an invented date — the SAME rail production runs', () => {
    expect(failed('Nothing since Monday.')).toContain('dates-supplied-only');
    expect(failed('We asked Tuesday, Aug 18 at 12:00 PM.')).not.toContain('dates-supplied-only');
  });

  it('catches a dismissal invitation', () => {
    expect(failed('No write-up yet. If it is handled, just dismiss this.')).toContain('no-dismissal-invite');
  });

  it('catches over-length, links, and a missing subject', () => {
    expect(failed('x'.repeat(401))).toContain('length');
    expect(failed('See https://example.com')).toContain('no-link');
    expect(failed('Something is missing.', { mustName: ['Boiler swap'] })).toContain('names-the-subject');
  });

  it('catches a claim the scenario says is false', () => {
    // S2: a note DID land, so "nothing has been recorded" is false there.
    expect(failed('Nothing has been recorded on the job.', { mustNotClaim: ['nothing has been recorded'] }))
      .toContain('no-false-claim');
  });

  it('reports an absent note as absent rather than passing everything', () => {
    const checks = deterministicChecks('', opts());
    expect(checks).toHaveLength(1);
    expect(checks[0]).toEqual({ name: 'present', pass: false });
  });
});
