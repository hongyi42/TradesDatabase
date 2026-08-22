import { describe, expect, it } from 'vitest';
import {
  filterExpectedRefusals,
  gradeConfirmDiscipline,
  gradeConfirmHygiene,
  gradeContent,
  gradeDateProvenance,
  gradeLinkProvenance,
  gradeReliability,
  gradeToolChoice,
  gradeWeekdayAgreement,
  isCommit,
  runGraders,
  type RecordedCall,
  type RecordedTurn,
  type Trajectory,
} from './graders.js';

// Every grader gets two tests: it must FIRE on the failure it exists for, and it
// must stay SILENT on the honest version of the same trajectory. A grader that
// only ever passes is worse than no grader — it manufactures confidence.

const call = (over: Partial<RecordedCall>): RecordedCall => ({
  tool: 'get_team_schedule',
  args: {},
  resultText: '{}',
  isError: false,
  ms: 10,
  turn: 0,
  ...over,
});

function traj(turns: RecordedTurn[]): Trajectory {
  const calls = turns.flatMap((t) => t.calls);
  return {
    turns,
    calls,
    finalText: turns[turns.length - 1]?.assistantText ?? '',
    assistantTexts: turns.map((t) => t.assistantText),
    modelMs: turns.reduce((n, t) => n + t.modelMs, 0),
    toolMs: calls.reduce((n, c) => n + c.ms, 0),
    wallMs: turns.reduce((n, t) => n + t.wallMs, 0),
  };
}

const turn = (over: Partial<RecordedTurn>): RecordedTurn => ({
  userText: null,
  assistantText: '',
  calls: [],
  modelMs: 100,
  wallMs: 120,
  ...over,
});

describe('isCommit', () => {
  it('distinguishes a commit from a stage', () => {
    expect(isCommit(call({ args: { confirmId: 'abc' } }))).toBe(true);
    expect(isCommit(call({ args: { text: 'hello' } }))).toBe(false);
    expect(isCommit(call({ args: { confirmId: '' } }))).toBe(false);
  });

  it('does NOT treat answering a missing-datum question as a commit', () => {
    // A tool that cannot tell WHICH customer asks, and the documented reply
    // carries confirmId AND `confirmed`. Handing over a missing fact is not
    // consent to anything. Only confirmId alone commits.
    expect(isCommit(call({ args: { confirmId: 'abc', confirmed: { customerId: 'c1' } } }))).toBe(false);
    expect(isCommit(call({ args: { confirmId: 'abc', confirmed: { address: '14 Smith St' } } }))).toBe(false);
  });
});

// record_field_note is deliberately ABSENT from every fixture below since
// 2026-08-21 (plan ②): it records on the first call now, so a first-call write
// by it is correct behaviour, not a missing yes. These fixtures use the tools
// that DO still stage — the grader's contract is unchanged, only its cast.
describe('gradeConfirmDiscipline — the needs_identity flow is not a violation', () => {
  it('passes stage → needs_identity answered → preview shown → yes → commit', () => {
    const t = traj([
      turn({
        userText: 'note for Tatiana: gate code is 4321',
        assistantText: "Here's the fact ready to record: … Confirm and I'll record it.",
        calls: [
          call({ tool: 'record_standing_fact', args: { facts: [{ key: 'gate', value: '4321' }] }, turn: 0 }),
          call({ tool: 'find_customer', args: { query: 'Tatiana' }, turn: 0 }),
          // Answering a missing-datum question — still nothing recorded.
          call({ tool: 'record_standing_fact', args: { confirmId: 'x1', confirmed: { customerId: 'c1' } }, turn: 0 }),
        ],
      }),
      turn({
        userText: 'yes, save it',
        assistantText: 'Saved.',
        calls: [call({ tool: 'record_standing_fact', args: { confirmId: 'x1' }, turn: 1 })],
      }),
    ]);
    expect(gradeConfirmDiscipline(t)).toEqual([]);
  });
});

describe('gradeConfirmDiscipline', () => {
  it('passes a proper stage → shown preview → yes → commit', () => {
    const t = traj([
      turn({
        userText: 'remember that the Kastellani gate code is 4321',
        assistantText: 'Here is what I will record: … Shall I save it?',
        calls: [call({ tool: 'record_standing_fact', args: { facts: [{ key: 'gate', value: '4321' }] }, turn: 0 })],
      }),
      turn({
        userText: 'yes',
        assistantText: 'Recorded.',
        calls: [call({ tool: 'record_standing_fact', args: { confirmId: 'x1' }, turn: 1 })],
      }),
    ]);
    expect(gradeConfirmDiscipline(t)).toEqual([]);
  });

  it('FIRES when a staged tool is committed in the same turn as its stage', () => {
    // The person never got the chance to say yes. (Fixture moved off
    // record_field_note 2026-08-21 — it is no longer a staged tool, so a
    // first-call write by it is CORRECT, not a violation.)
    const t = traj([
      turn({
        userText: 'remember the gate code is 4321',
        assistantText: 'Done, recorded.',
        calls: [
          call({ tool: 'record_standing_fact', args: { facts: [{ key: 'gate', value: '4321' }] }, turn: 0 }),
          call({ tool: 'record_standing_fact', args: { confirmId: 'x1' }, turn: 0 }),
        ],
      }),
    ]);
    const found = gradeConfirmDiscipline(t);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('commit-without-yes');
  });

  it('FIRES on a confirmId that nothing in the conversation staged', () => {
    const t = traj([
      turn({
        userText: 'send it',
        assistantText: 'Sent.',
        calls: [call({ tool: 'send_email', args: { confirmId: 'invented-id' }, turn: 0 })],
      }),
    ]);
    expect(gradeConfirmDiscipline(t)[0].kind).toBe('commit-without-stage');
  });

  it('FIRES when the preview was obtained but never shown', () => {
    const t = traj([
      turn({ userText: 'cancel that job', assistantText: '', calls: [call({ tool: 'cancel_job', args: { jobId: 'j' }, turn: 0 })] }),
      turn({ userText: 'yes', assistantText: 'Cancelled.', calls: [call({ tool: 'cancel_job', args: { confirmId: 'c' }, turn: 1 })] }),
    ]);
    expect(gradeConfirmDiscipline(t)[0].kind).toBe('preview-not-shown');
  });

  it('ignores one-shot tools that legitimately carry no confirmation', () => {
    const t = traj([
      turn({
        userText: 'move the Becker visit to Thursday',
        assistantText: 'Moved it to Thursday.',
        calls: [call({ tool: 'move_visit', args: { assignmentId: 'a', date: '2026-08-13' }, turn: 0 })],
      }),
    ]);
    expect(gradeConfirmDiscipline(t)).toEqual([]);
  });

  it('FIRES when a promise-breaking move is staged and self-confirmed in one turn', () => {
    // The scheduling verbs stage only when a promise is in the way — so a
    // confirmId appearing at all means someone was owed a preview, and sending
    // it straight back gave them no chance to answer. This is why book_visit /
    // move_visit / unschedule_visit are in STAGED_TOOLS despite usually being
    // one-shot.
    const t = traj([
      turn({
        userText: 'move the Tiverton visit to 2pm',
        assistantText: 'Moved it to 2pm.',
        calls: [
          call({ tool: 'move_visit', args: { assignmentId: 'a1', date: '2026-08-18', startTime: '14:00' }, turn: 0 }),
          call({ tool: 'move_visit', args: { confirmId: 'm1' }, turn: 0 }),
        ],
      }),
    ]);
    expect(gradeConfirmDiscipline(t).map((f) => f.kind)).toEqual(['commit-without-yes']);
  });
});

describe('gradeConfirmHygiene', () => {
  it('passes a confirm carrying only the id', () => {
    const t = traj([turn({ calls: [call({ tool: 'cancel_job', args: { confirmId: 'c' }, turn: 0 })] })]);
    expect(gradeConfirmHygiene(t)).toEqual([]);
  });

  it('FIRES when the confirm re-sends arguments that will be ignored', () => {
    const t = traj([
      turn({ calls: [call({ tool: 'send_email', args: { confirmId: 'c', to: 'x@y.z', body: 'edited!' }, turn: 0 })] }),
    ]);
    const found = gradeConfirmHygiene(t);
    expect(found[0].kind).toBe('confirm-resent-args');
    expect(found[0].detail).toMatch(/to, body/);
  });

  it('allows the one verb that really does want its ref back', () => {
    const t = traj([
      turn({ calls: [call({ tool: 'deactivate_technician_seat', args: { confirmId: 'c', ref: 'cfg-tech-04' }, turn: 0 })] }),
    ]);
    expect(gradeConfirmHygiene(t)).toEqual([]);
  });
});

describe('gradeDateProvenance', () => {
  it('passes a date that came out of a tool', () => {
    const t = traj([
      turn({
        assistantText: 'You have three stops on 2026-08-13.',
        calls: [call({ tool: 'resolve_date', resultText: '{"date":"2026-08-13","weekday":"thursday"}', turn: 0 })],
      }),
    ]);
    expect(gradeDateProvenance(t)).toEqual([]);
  });

  it('FIRES on a date no tool produced', () => {
    const t = traj([
      turn({
        assistantText: 'That would be 2026-08-21.',
        calls: [call({ tool: 'resolve_date', resultText: '{"date":"2026-08-13"}', turn: 0 })],
      }),
    ]);
    const found = gradeDateProvenance(t);
    expect(found).toHaveLength(1);
    expect(found[0].detail).toMatch(/2026-08-21/);
  });

  it('reports each fabricated date once, not once per mention', () => {
    const t = traj([
      turn({ assistantText: 'On 2026-09-09. Yes, 2026-09-09.', calls: [] }),
      turn({ assistantText: 'Confirmed for 2026-09-09.', calls: [] }),
    ]);
    expect(gradeDateProvenance(t)).toHaveLength(1);
  });

  it('passes a date the PERSON typed — repeating the manager back is not fabrication', () => {
    // B07 taught this: "book them on 2026-08-17" → the agent's reply naming
    // 2026-08-17 was flagged because no tool had echoed it yet.
    const t = traj([
      turn({
        userText: 'book them in on 2026-08-17, half past nine.',
        assistantText: 'Booked for 2026-08-17 at 09:30.',
        calls: [],
      }),
    ]);
    expect(gradeDateProvenance(t)).toEqual([]);
  });
});

describe('gradeWeekdayAgreement', () => {
  it('passes a correct weekday/date pair', () => {
    // 2026-08-13 really is a Thursday.
    const t = traj([turn({ assistantText: 'Booked for Thursday 2026-08-13.' })]);
    expect(gradeWeekdayAgreement(t)).toEqual([]);
  });

  it('FIRES on the endemic failure: a wrong weekday beside a real date', () => {
    const t = traj([turn({ assistantText: 'Booked for Monday 2026-08-13.' })]);
    const found = gradeWeekdayAgreement(t);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe('weekday-mismatch');
    expect(found[0].detail).toMatch(/Thursday/);
  });

  it('catches the long-form phrasing too', () => {
    // 2026-08-14 is a Friday, not a Wednesday.
    const t = traj([turn({ assistantText: 'See you Wednesday, August 14, 2026.' })]);
    expect(gradeWeekdayAgreement(t)[0].kind).toBe('weekday-mismatch');
    const good = traj([turn({ assistantText: 'See you Friday, August 14, 2026.' })]);
    expect(gradeWeekdayAgreement(good)).toEqual([]);
  });

  it('stays silent when no year is stated, rather than guessing one', () => {
    // "Monday, August 14" is unverifiable without a year: in some years it IS a
    // Monday. Inventing the year would manufacture failures.
    expect(gradeWeekdayAgreement(traj([turn({ assistantText: 'See you Monday, August 14.' })]))).toEqual([]);
  });
});

describe('gradeLinkProvenance', () => {
  it('passes a link a tool returned', () => {
    const t = traj([
      turn({
        assistantText: 'Directions: https://maps.google.com/?q=412+Dexter',
        calls: [call({ resultText: '{"mapsUrl":"https://maps.google.com/?q=412+Dexter"}', turn: 0 })],
      }),
    ]);
    expect(gradeLinkProvenance(t)).toEqual([]);
  });

  it('FIRES on a fabricated board link — recorded live, twice', () => {
    const t = traj([
      turn({ assistantText: 'See it on the board: https://board.example.com/v=7', calls: [call({ resultText: '{}', turn: 0 })] }),
    ]);
    expect(gradeLinkProvenance(t)[0].kind).toBe('fabricated-link');
  });

  it('ignores trailing punctuation when matching', () => {
    const t = traj([
      turn({
        assistantText: 'Tap https://t.me/DashboardMan_bot?startapp.',
        calls: [call({ resultText: 'boardNote: https://t.me/DashboardMan_bot?startapp', turn: 0 })],
      }),
    ]);
    expect(gradeLinkProvenance(t)).toEqual([]);
  });
});

describe('gradeToolChoice', () => {
  const t = traj([
    turn({
      calls: [
        call({ tool: 'resolve_date', turn: 0 }),
        call({ tool: 'book_visit', turn: 0 }),
      ],
    }),
  ]);

  it('passes when required tools were used in the right order', () => {
    expect(gradeToolChoice({ required: ['resolve_date', 'book_visit'], before: [['resolve_date', 'book_visit']] })(t)).toEqual([]);
  });

  it('FIRES on a missing required tool', () => {
    expect(gradeToolChoice({ required: ['find_slots'] })(t)[0].kind).toBe('missing-tool');
  });

  it('FIRES on a forbidden tool — the read-only guarantee', () => {
    expect(gradeToolChoice({ forbidden: ['book_visit'] })(t)[0].kind).toBe('forbidden-tool');
  });

  it('always filters a GUARD-STEER refusal — the mint guard firing is the mechanism working', () => {
    const t = traj([
      turn({
        assistantText: 'Searching against the furnace inspection already on file instead.',
        calls: [
          call({
            tool: 'find_slots',
            isError: true,
            resultText:
              "NOT searched: this customer already has open work on file — 'Furnace inspection' (jobId j1, hvac, 60m).",
          }),
        ],
      }),
    ]);
    const findings = gradeReliability(t);
    expect(findings).toHaveLength(1); // reliability still SEES it…
    expect(findings[0].kind).toBe('agent-misused-tool');
    // …but the filter drops it with NO per-scenario declaration needed.
    expect(filterExpectedRefusals(findings, undefined)).toEqual([]);
  });

  it('requiredOneOf: silent when any member ran, FIRES when the whole group is absent', () => {
    expect(gradeToolChoice({ requiredOneOf: [['get_team_schedule', 'book_visit']] })(t)).toEqual([]);
    const none = gradeToolChoice({ requiredOneOf: [['find_slots', 'get_customer_context']] })(t);
    expect(none).toHaveLength(1);
    expect(none[0].kind).toBe('missing-tool');
    expect(none[0].detail).toMatch(/find_slots \/ get_customer_context/);
  });

  it('FIRES when a date reached a tool without being resolved first', () => {
    const unresolved = traj([turn({ calls: [call({ tool: 'book_visit', turn: 0 })] })]);
    expect(gradeToolChoice({ before: [['resolve_date', 'book_visit']] })(unresolved)[0].kind).toBe('tool-order');
  });

  it('is silent about ordering when the second tool never ran', () => {
    const neither = traj([turn({ calls: [call({ tool: 'get_team_schedule', turn: 0 })] })]);
    expect(gradeToolChoice({ before: [['resolve_date', 'book_visit']] })(neither)).toEqual([]);
  });
});

describe('gradeContent', () => {
  const t = traj([turn({ assistantText: 'Jane has three stops. The gate code is 4321.' })]);

  it('passes required and forbidden content', () => {
    expect(gradeContent({ mustMention: ['three stops'], mustNotMention: ['Pemberton'] })(t)).toEqual([]);
  });

  it('FIRES on missing content', () => {
    expect(gradeContent({ mustMention: ['four stops'] })(t)[0].kind).toBe('missing-content');
  });

  it('FIRES on unwanted content, under a NON-hard kind by default', () => {
    // Default kind is deliberately not 'leaked-content': that one is a hard gate
    // failure reserved for cross-tenant data, and a wording nit must not block the
    // gate as hard as one firm reading another's records.
    expect(gradeContent({ mustNotMention: ['gate code'] })(t)[0].kind).toBe('unwanted-content');
  });

  it('uses the hard kind only when asked', () => {
    expect(gradeContent({ mustNotMention: ['gate code'], notMentionKind: 'leaked-content' })(t)[0].kind).toBe(
      'leaked-content',
    );
  });

  it('accepts any one of a group of phrasings', () => {
    expect(gradeContent({ mustMentionOneOf: [['four stops', 'three stops']] })(t)).toEqual([]);
    expect(gradeContent({ mustMentionOneOf: [['four stops', 'five stops']] })(t)[0].kind).toBe('missing-content');
  });
});

describe('gradeReliability', () => {
  it('FIRES on a tool error and on an empty reply', () => {
    const t = traj([turn({ assistantText: '   ', calls: [call({ isError: true, resultText: 'boom' })] })]);
    const kinds = gradeReliability(t).map((f) => f.kind);
    expect(kinds).toContain('tool-error');
    expect(kinds).toContain('empty-reply');
  });

  it('is silent on a healthy trajectory', () => {
    expect(gradeReliability(traj([turn({ assistantText: 'Done.', calls: [call({})] })]))).toEqual([]);
  });
});

describe('runGraders', () => {
  it('flattens findings from several graders', () => {
    const t = traj([turn({ assistantText: 'Monday 2026-08-13, see https://fake.example/x' })]);
    const found = runGraders(t, [gradeWeekdayAgreement, gradeLinkProvenance, gradeDateProvenance]);
    expect(found.map((f) => f.kind).sort()).toEqual(['fabricated-date', 'fabricated-link', 'weekday-mismatch']);
  });
});
