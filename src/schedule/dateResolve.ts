// Deterministic relative-date resolver — no AI, no DB (overview §5: hardcode
// what must be correct). Turns a STRUCTURED day reference (weekday + how many
// weeks out, a plain day shift, or an explicit date) into a canonical
// YYYY-MM-DD plus its weekday name — or a STRUCTURED period reference (week /
// month / quarter / year, negative for past) into its boundary dates.
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
// while still covering every realistic booking horizon. Negatives are allowed
// everywhere since 2026-08-12: the date eval proved that a mode the tool
// lacks does not stop the question being asked — it just moves the arithmetic
// into the model ("last week", "last month" were hand-computed in every
// trajectory that needed them, because week/weeksAhead refused negatives and
// no calendar-period mode existed at all).
const MAX_WEEKS = 52;
const MIN_DAY_SHIFT = -366;
const MAX_DAY_SHIFT = 366;
const MAX_MONTHS = 24;
const MAX_QUARTERS = 8;
const MAX_YEARS = 5;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

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

/**
 * The served day label for any tool result that names a date — "Friday
 * 2026-08-28". Added 2026-08-14 after a spine-eval move confirmation said
 * "Thursday 2026-08-28" (a Friday): the endemic weekday-mismatch class
 * (23/419 live texts) keeps coming from replies that COMPUTE the weekday, so
 * results serve it pre-composed and the descriptions say to repeat it
 * verbatim — the same pattern as upcomingVisits.phrase and resolve_date.
 */
export function servedDayPhrase(dateISO: string): string {
  return dayPhrase(dateISO, weekdayNameOf(dateISO));
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
  weeksAhead?: number; // weeks beyond the coming occurrence (0 = "this <day>", -1 = "last <day>")
  dayShift?: number; // today = 0, tomorrow = 1 (no weekday named)
  explicitDate?: string; // YYYY-MM-DD the manager stated outright
  week?: number; // a week RANGE: 0 = the current calendar week (Mon–Sun), 1 = next, -1 = last, …
  month?: number; // a calendar-month RANGE: 0 = this month, -1 = last month, 1 = next, …
  quarter?: number; // a calendar-quarter RANGE: 0 = this quarter, -1 = last quarter, …
  year?: number; // a calendar-year RANGE: 0 = this year, -1 = last year, …
}

export type ResolveDateResult =
  | {
      status: 'resolved';
      date: string;
      weekday: Weekday;
      phrase: string; // "Tuesday 2026-08-04" — say this, don't build it
      // Weekend "X of next week" steering (see the weekday branch): present
      // only when the resolved date is probably not the reading the speaker
      // meant. The note carries both candidate phrases ready to quote.
      note?: string;
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
  | {
      // month / quarter / year — the calendar periods that used to have no
      // path through this tool at all. One shape for all three: the agent
      // reads periodStart/periodEnd for its query window and says `phrase`.
      status: 'resolved_period';
      periodStart: string; // YYYY-MM-DD, first day of the period
      periodEnd: string; // YYYY-MM-DD, last day of the period
      periodStartWeekday: Weekday;
      periodEndWeekday: Weekday;
      label: string; // "August 2026" | "Q3 2026" | "2026"
      phrase: string; // "Saturday 2026-08-01 through Monday 2026-08-31 (August 2026)"
    }
  | { status: 'unresolvable'; reason: string };

function resolvedPeriod(startISO: string, endISO: string, label: string): ResolveDateResult {
  return {
    status: 'resolved_period',
    periodStart: startISO,
    periodEnd: endISO,
    periodStartWeekday: weekdayNameOf(startISO),
    periodEndWeekday: weekdayNameOf(endISO),
    label,
    phrase: `${rangePhrase(startISO, endISO)} (${label})`,
  };
}

// First day of the month `offset` months from todayLocal's month. Pure
// integer arithmetic on (year, month) — no Date rollover semantics to trust.
function monthStartISO(todayLocal: string, offset: number): string {
  const [y, m] = todayLocal.split('-').map(Number);
  const total = y * 12 + (m - 1) + offset;
  const ty = Math.floor(total / 12);
  const tm = (total % 12) + 12; // JS % is signed; normalize…
  const monthIndex = tm % 12; // …to 0..11
  return `${String(ty).padStart(4, '0')}-${String(monthIndex + 1).padStart(2, '0')}-01`;
}

// Last day of the month that ISO's first-of-month belongs to: the day before
// the NEXT month's first — leap years fall out of addDays, not a table.
function monthEndISO(firstOfMonth: string): string {
  return addDays(monthStartISO(firstOfMonth, 1), -1);
}

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
    p.month !== undefined,
    p.quarter !== undefined,
    p.year !== undefined,
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
      reason:
        'no day reference given — provide weekday, dayShift, explicitDate, week, month, quarter, or year',
    };
  }
  if (modes > 1) {
    return {
      status: 'unresolvable',
      reason: 'provide exactly one of explicitDate, weekday, dayShift, week, month, quarter, or year',
    };
  }

  // Calendar-period modes (month / quarter / year). All three are
  // calendar-anchored ranges like `week` — 0 = the period containing today,
  // negative = past periods ("last month" = month:-1, and from a January that
  // is December of the PREVIOUS year, which is exactly the wrap a model gets
  // wrong in its head). No weekend-style ambiguity exists here: which month
  // "this month" names does not depend on the day of the week.
  if (p.month !== undefined) {
    if (!Number.isInteger(p.month) || Math.abs(p.month) > MAX_MONTHS) {
      return {
        status: 'unresolvable',
        reason: `month must be a whole number between ${-MAX_MONTHS} and ${MAX_MONTHS} (0 = this month, -1 = last month)`,
      };
    }
    const start = monthStartISO(p.todayLocal, p.month);
    const [sy, sm] = start.split('-').map(Number);
    return resolvedPeriod(start, monthEndISO(start), `${MONTH_NAMES[sm - 1]} ${sy}`);
  }
  if (p.quarter !== undefined) {
    if (!Number.isInteger(p.quarter) || Math.abs(p.quarter) > MAX_QUARTERS) {
      return {
        status: 'unresolvable',
        reason: `quarter must be a whole number between ${-MAX_QUARTERS} and ${MAX_QUARTERS} (0 = this quarter, -1 = last quarter)`,
      };
    }
    const m = Number(p.todayLocal.split('-')[1]);
    const quarterFirstMonthOffset = -((m - 1) % 3) + p.quarter * 3;
    const start = monthStartISO(p.todayLocal, quarterFirstMonthOffset);
    const [sy, sm] = start.split('-').map(Number);
    const end = monthEndISO(monthStartISO(start, 2));
    return resolvedPeriod(start, end, `Q${Math.floor((sm - 1) / 3) + 1} ${sy}`);
  }
  if (p.year !== undefined) {
    if (!Number.isInteger(p.year) || Math.abs(p.year) > MAX_YEARS) {
      return {
        status: 'unresolvable',
        reason: `year must be a whole number between ${-MAX_YEARS} and ${MAX_YEARS} (0 = this year, -1 = last year)`,
      };
    }
    const y = Number(p.todayLocal.slice(0, 4)) + p.year;
    return resolvedPeriod(`${y}-01-01`, `${y}-12-31`, String(y));
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
    if (!Number.isInteger(p.week) || Math.abs(p.week) > MAX_WEEKS) {
      return {
        status: 'unresolvable',
        reason: `week must be a whole number between ${-MAX_WEEKS} and ${MAX_WEEKS} (0 = the current week, -1 = last week)`,
      };
    }
    const todayDow = new Date(`${p.todayLocal}T00:00:00.000Z`).getUTCDay();
    const daysSinceMonday = (todayDow + 6) % 7; // Mon=0 … Sun=6
    const weekStart = addDays(p.todayLocal, -daysSinceMonday + p.week * 7);
    const weekEnd = addDays(weekStart, 6);
    // Weekend ambiguity applies to FORWARD weeks only. "This week" and "last
    // week" said on a Saturday mean the containing/previous calendar week to
    // essentially everyone — the 2026-08-15 eval showed the old always-flag
    // caused the agent to answer "this week, Monday through Sunday" with a
    // clarifying question and no data (W02/W06/P20). The 2026-07-25 live bite
    // that created this flag was a "next week", and that is where it stays.
    if ((todayDow === 6 || todayDow === 0) && p.week >= 1) {
      const altStart = addDays(weekStart, 7);
      return {
        status: 'resolved_week',
        ...weekRange(weekStart, weekEnd),
        boundaryAmbiguous: true,
        alternate: weekRange(altStart, addDays(altStart, 6)),
        // Steering, not trivia: the 2026-08-15 eval proved the old wording
        // ("present both and ask before acting") reads as "reply with only a
        // clarifying question" — half the weekend replies delivered zero data.
        note:
          'On a weekend, "next week" is ambiguous — it can mean either range. For a READ-ONLY answer ' +
          '(counts, listings, dates) answer BOTH ranges, labeling each with its phrase ' +
          'verbatim — never reply with only a clarifying question. Ask which range the ' +
          'person means BEFORE you book, move, or change anything. If their own words ' +
          'already pin the window (explicit dates, "starting tomorrow"), use exactly ' +
          'that window and skip the ambiguity.',
      };
    }
    return { status: 'resolved_week', ...weekRange(weekStart, weekEnd) };
  }

  if (p.weekday !== undefined) {
    const weeksAhead = p.weeksAhead ?? 0;
    if (!Number.isInteger(weeksAhead) || Math.abs(weeksAhead) > MAX_WEEKS) {
      return {
        status: 'unresolvable',
        reason: `weeksAhead must be a whole number between ${-MAX_WEEKS} and ${MAX_WEEKS} (0 = this coming ${p.weekday}, -1 = last ${p.weekday})`,
      };
    }
    const todayDow = new Date(`${p.todayLocal}T00:00:00.000Z`).getUTCDay();
    const daysUntil = (WEEKDAY_INDEX[p.weekday] - todayDow + 7) % 7;
    // Anchor = the COMING occurrence, so negatives step back from it a whole
    // week at a time: weeksAhead -1 is the most recent PAST <weekday> — 5 days
    // ago from a Wednesday asking about Friday, 7 days ago when today IS the
    // named day. That matches what "last Friday" means in speech, including
    // said on a Friday.
    const date = addDays(p.todayLocal, daysUntil + weeksAhead * 7);
    // Weekend + weeksAhead>=1: "Friday of next week" said on a Saturday almost
    // always means the Friday INSIDE the coming Mon–Sun week — which is
    // weeksAhead 0's result, not 1's (2026-08-15 eval, P15: the agent led with
    // the week-after date and was read as wrong). The primary reading is the
    // occurrence inside the coming calendar week; when the resolved date isn't
    // that one, say so with both phrases ready to quote. (For weekdays whose
    // coming occurrence already falls in the next calendar week — e.g. asking
    // about Sunday on a Saturday — weeksAhead 1 IS that reading and no note is
    // needed.)
    if ((todayDow === 6 || todayDow === 0) && weeksAhead >= 1) {
      const daysSinceMonday = (todayDow + 6) % 7;
      const nextWeekStart = addDays(p.todayLocal, -daysSinceMonday + 7);
      const inComingWeek = addDays(nextWeekStart, (WEEKDAY_INDEX[p.weekday] + 6) % 7);
      if (date !== inComingWeek) {
        return {
          status: 'resolved',
          date,
          weekday: p.weekday,
          phrase: dayPhrase(date, p.weekday),
          note:
            `Said on a weekend, "${p.weekday} of next week" usually means ` +
            `${dayPhrase(inComingWeek, p.weekday)} — the ${p.weekday} inside the coming ` +
            `Mon–Sun week — not ${dayPhrase(date, p.weekday)}. For a read-only answer, ` +
            `name ${dayPhrase(inComingWeek, p.weekday)} first and offer ` +
            `${dayPhrase(date, p.weekday)} as the alternate; ask which they mean before ` +
            `booking or moving anything.`,
        };
      }
    }
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
