// Deterministic relative-date resolver — no AI, no DB (overview §5: hardcode
// what must be correct). Turns a STRUCTURED day reference (weekday + how many
// weeks out, or a plain day shift, or an explicit date) into a canonical
// YYYY-MM-DD plus its weekday name.
//
// Division of labour (the whole point): the model reads the manager's messy
// phrase and picks the fields ("this Friday" → {weekday:'friday'}); this code
// does the calendar arithmetic the model cannot do reliably. The reference
// "today" is supplied by the SERVER (its own clock, in the firm's timezone) —
// never by the model — so a wrong "today" is impossible.
//
// Calendar math runs on UTC-anchored midnights: `todayLocal` already has the
// timezone applied (via localDateISO), and adding whole days in UTC has no DST
// discontinuities, so the result is a pure calendar date.

export type Weekday =
  | 'monday'
  | 'tuesday'
  | 'wednesday'
  | 'thursday'
  | 'friday'
  | 'saturday'
  | 'sunday';

const WEEKDAYS: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];
const WEEKDAY_INDEX: Record<Weekday, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Bounds keep a fat-fingered field from resolving to a nonsense century away
// while still covering every realistic booking horizon.
const MAX_WEEKS_AHEAD = 52;
const MIN_DAY_SHIFT = -366;
const MAX_DAY_SHIFT = 366;

export function isWeekday(v: unknown): v is Weekday {
  return typeof v === 'string' && v in WEEKDAY_INDEX;
}

// A YYYY-MM-DD that is also a REAL date (round-trip rejects 2026-02-30, month
// 13, etc. — the regex alone would pass them).
export function isRealDateISO(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(dateISO: string, days: number): string {
  const base = Date.parse(`${dateISO}T00:00:00.000Z`);
  return new Date(base + days * 86_400_000).toISOString().slice(0, 10);
}

function weekdayNameOf(dateISO: string): Weekday {
  return WEEKDAYS[new Date(`${dateISO}T00:00:00.000Z`).getUTCDay()];
}

// "monday" → "Monday". The model is told to state the weekday whenever it names
// a date, so what it copies has to be already in the form a person reads.
function titleCase(w: Weekday): string {
  return w[0].toUpperCase() + w.slice(1);
}

// A ready-to-say phrase for every resolution.
//
// WHY THIS EXISTS. Every date this resolver hands back used to leave as a bare
// YYYY-MM-DD (week ranges) or a lowercase weekday sitting beside one, and §0f
// requires the agent to state the weekday whenever it names a date to a person.
// Given nothing quotable, it composed the sentence itself — i.e. did calendar
// arithmetic, which is the one thing this file exists to take away from it.
// Caught live twice: "Monday the 4th through Saturday the 8th" for the Aug 3–9
// week (2026-08-06, both boundaries wrong), and again on 2026-08-06 after the
// v_schedule.local_weekday fix, where the reply said "Mon Aug 3 – Sun Aug 9"
// — correct, but still DERIVED, because the query counted rows and never
// selected a weekday column. local_weekday can only help when the agent names a
// date it SELECTED; the boundaries of a window come from here instead.
//
// So the phrase is the fix at the right layer: the agent restates rather than
// composes. Same remedy as v_schedule.local_weekday and, before it, local_day —
// put the derived value in the data, not in a rule telling the model not to
// derive it.
function dayPhrase(dateISO: string, weekday: Weekday): string {
  return `${titleCase(weekday)} ${dateISO}`;
}

function rangePhrase(startISO: string, endISO: string): string {
  // weekStart is a Monday and weekEnd a Sunday BY CONSTRUCTION, so these labels
  // are not a lookup — they are what the arithmetic above already guarantees.
  return `${dayPhrase(startISO, weekdayNameOf(startISO))} through ${dayPhrase(endISO, weekdayNameOf(endISO))}`;
}

// Built in ONE place so a future return site cannot ship a date without its
// weekday — the omission that caused this in the first place.
function resolvedDay(date: string, weekday: Weekday): ResolveDateResult {
  return { status: 'resolved', date, weekday, phrase: dayPhrase(date, weekday) };
}

function weekRange(weekStart: string, weekEnd: string) {
  return {
    weekStart,
    weekEnd,
    weekStartWeekday: weekdayNameOf(weekStart),
    weekEndWeekday: weekdayNameOf(weekEnd),
    phrase: rangePhrase(weekStart, weekEnd),
  };
}

export interface ResolveDateParams {
  todayLocal: string; // YYYY-MM-DD in the firm's timezone — SERVER-supplied
  weekday?: Weekday; // a named day
  weeksAhead?: number; // weeks beyond the coming occurrence (0 = "this <day>")
  dayShift?: number; // today = 0, tomorrow = 1 (no weekday named)
  explicitDate?: string; // YYYY-MM-DD the manager stated outright
  week?: number; // a week RANGE: 0 = the current calendar week (Mon–Sun), 1 = next, …
}

export type ResolveDateResult =
  | {
      status: 'resolved';
      date: string;
      weekday: Weekday;
      phrase: string; // "Tuesday 2026-08-04" — say this, don't build it
    }
  | {
      status: 'resolved_week';
      weekStart: string; // Monday, YYYY-MM-DD
      weekEnd: string; // Sunday, YYYY-MM-DD
      // Named so the agent never has to work out which day a boundary falls on.
      // Constants by construction, and that is the point: the value it would
      // otherwise derive is handed over instead.
      weekStartWeekday: Weekday;
      weekEndWeekday: Weekday;
      phrase: string; // "Monday 2026-08-03 through Sunday 2026-08-09"
      // Present only when today is Saturday or Sunday: "this/next week" said on
      // a weekend honestly means different weeks to different people, so the
      // caller gets BOTH readings and an instruction to ask — never a silent pick.
      boundaryAmbiguous?: true;
      // The alternate carries its own phrase for the same reason the primary
      // does — and more urgently, since this is the branch that asks the agent
      // to read BOTH ranges out to a person.
      alternate?: {
        weekStart: string;
        weekEnd: string;
        weekStartWeekday: Weekday;
        weekEndWeekday: Weekday;
        phrase: string;
      };
      note?: string;
    }
  | { status: 'unresolvable'; reason: string };

// The "this vs next" convention, pinned here (not in the model):
//   weeksAhead 0 = the COMING occurrence of the weekday (today, if today is
//   that weekday); 1 = "next <weekday>"; 2 = the week after that; …
// If today IS the named weekday, "this <weekday>" (weeksAhead 0) resolves to
// today. Returning the weekday name lets a wrong week-count surface visibly.
export function resolveDate(p: ResolveDateParams): ResolveDateResult {
  if (!isRealDateISO(p.todayLocal)) {
    return { status: 'unresolvable', reason: `reference date '${p.todayLocal}' is not a real date` };
  }

  const modes = [
    p.explicitDate !== undefined,
    p.weekday !== undefined,
    p.dayShift !== undefined,
    p.week !== undefined,
  ].filter(Boolean).length;

  // weeksAhead only means anything alongside a weekday. These refusal strings
  // are agent-facing steering (the result text is what the model acts on), so
  // every valid mode must be named in them — an omitted mode reads as "that
  // mode does not exist" and sends the model back to hand-rolled math.
  if (p.weeksAhead !== undefined && p.weekday === undefined) {
    return {
      status: 'unresolvable',
      reason: 'weeksAhead only applies with a weekday — for week ranges use week alone',
    };
  }
  if (modes === 0) {
    return {
      status: 'unresolvable',
      reason: 'no day reference given — provide weekday, dayShift, explicitDate, or week',
    };
  }
  if (modes > 1) {
    return {
      status: 'unresolvable',
      reason: 'provide exactly one of explicitDate, weekday, dayShift, or week',
    };
  }

  if (p.explicitDate !== undefined) {
    if (!isRealDateISO(p.explicitDate)) {
      return { status: 'unresolvable', reason: `'${p.explicitDate}' is not a real calendar date (use YYYY-MM-DD)` };
    }
    return resolvedDay(p.explicitDate, weekdayNameOf(p.explicitDate));
  }

  // Week-RANGE mode: CALENDAR-anchored (the Monday on/before today, plus
  // 7×week), unlike the weekday mode below, which is OCCURRENCE-anchored (the
  // coming <day>, plus 7×weeksAhead). The two anchorings agree mid-week and
  // diverge on weekends — from a Saturday, calendar "next week" starts in two
  // days, while occurrence-anchored "next monday" lands a week later. That
  // divergence is exactly how a real Monday visit went unfound (2026-07-25),
  // so weekend resolutions carry both readings instead of picking one.
  if (p.week !== undefined) {
    if (!Number.isInteger(p.week) || p.week < 0 || p.week > MAX_WEEKS_AHEAD) {
      return {
        status: 'unresolvable',
        reason: `week must be a whole number between 0 and ${MAX_WEEKS_AHEAD} (0 = the current week); past references need an explicit date`,
      };
    }
    const todayDow = new Date(`${p.todayLocal}T00:00:00.000Z`).getUTCDay();
    const daysSinceMonday = (todayDow + 6) % 7; // Mon=0 … Sun=6
    const weekStart = addDays(p.todayLocal, -daysSinceMonday + p.week * 7);
    const weekEnd = addDays(weekStart, 6);
    if (todayDow === 6 || todayDow === 0) {
      const altStart = addDays(weekStart, 7);
      return {
        status: 'resolved_week',
        ...weekRange(weekStart, weekEnd),
        boundaryAmbiguous: true,
        alternate: weekRange(altStart, addDays(altStart, 6)),
        note:
          'On a weekend, "this/next week" is ambiguous. Present BOTH ranges (using each ' +
          'phrase verbatim) and ask which the person means before acting.',
      };
    }
    return { status: 'resolved_week', ...weekRange(weekStart, weekEnd) };
  }

  if (p.weekday !== undefined) {
    const weeksAhead = p.weeksAhead ?? 0;
    if (!Number.isInteger(weeksAhead) || weeksAhead < 0 || weeksAhead > MAX_WEEKS_AHEAD) {
      return {
        status: 'unresolvable',
        reason: `weeksAhead must be a whole number between 0 and ${MAX_WEEKS_AHEAD} (0 = this coming ${p.weekday}); past references need an explicit date`,
      };
    }
    const todayDow = new Date(`${p.todayLocal}T00:00:00.000Z`).getUTCDay();
    const daysUntil = (WEEKDAY_INDEX[p.weekday] - todayDow + 7) % 7;
    const date = addDays(p.todayLocal, daysUntil + weeksAhead * 7);
    return resolvedDay(date, p.weekday);
  }

  // dayShift mode.
  const shift = p.dayShift as number;
  if (!Number.isInteger(shift) || shift < MIN_DAY_SHIFT || shift > MAX_DAY_SHIFT) {
    return {
      status: 'unresolvable',
      reason: `dayShift must be a whole number between ${MIN_DAY_SHIFT} and ${MAX_DAY_SHIFT} (0 = today, 1 = tomorrow)`,
    };
  }
  const date = addDays(p.todayLocal, shift);
  return resolvedDay(date, weekdayNameOf(date));
}
