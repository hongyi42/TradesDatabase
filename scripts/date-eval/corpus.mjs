// Date-eval corpus — the questions, and the machine-checkable truth for each.
//
// PHASES. Every question is tagged with the phases it exercises, so the
// analyzer can attribute a failure to one of the four things the agent does
// with a date:
//   resolve — turn the spoken phrase ("this Friday") into a calendar date,
//             by calling resolve_date rather than doing the math in its head
//   use     — carry that date into the data tools (get_team_schedule window,
//             query_spine SQL) without fabricating or shifting it
//   speak   — state the date back to the person correctly: right date, weekday
//             attached, weekday and date agreeing with each other
//   guard   — the outbound weekday-guard hook catches a fabricated
//             weekday↔date pair before it reaches the person
// A question that needs no data read (pure date arithmetic) is tagged
// [resolve, speak] and contributes NOTHING to the `use` denominator — the
// per-phase rates only ever divide by the questions that actually test them.
//
// TRUTH IS DERIVED, NOT PINNED. The expected answers come from the live pilot
// DB at plan time (see plan.mjs) and the dates from the independent date math
// below — so the corpus survives a schedule shift (the visits move; the truth
// moves with them) and never silently rots into testing the wrong thing.
//
// INDEPENDENCE. The date math here is a deliberate SECOND implementation. It
// must never import src/schedule/dateResolve.ts — that is the code under test,
// and a shared helper would turn the resolve-phase check into a tautology that
// agrees with the machinery precisely when the machinery is wrong.

// ─────────────────────────────────────────────── independent date math ──
const WDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WIDX = Object.fromEntries(WDAYS.map((w, i) => [w, i]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Anchored at UTC noon: date-only arithmetic that a DST shift can never move
// across a midnight boundary.
const at = (iso) => new Date(`${iso}T12:00:00.000Z`);
export const addDays = (iso, n) => new Date(at(iso).getTime() + n * 86_400_000).toISOString().slice(0, 10);
export const dow = (iso) => at(iso).getUTCDay();
export const weekdayName = (iso) => WDAYS[dow(iso)];
export const titleWeekday = (iso) => weekdayName(iso)[0].toUpperCase() + weekdayName(iso).slice(1);
export const humanDate = (iso) => `${MONTHS[at(iso).getUTCMonth()]} ${at(iso).getUTCDate()}`;

/** The COMING occurrence of a weekday — today itself when today is that day. */
export const comingOcc = (ref, wd) => addDays(ref, (WIDX[wd] - dow(ref) + 7) % 7);
// Calendar periods. resolve_date has NO mode for any of these (verified
// 2026-08-11: dayShift ±366, week 0..52 forward-only, weekday, explicitDate —
// and nothing else), so every month/quarter/year boundary the agent uses today
// is one it worked out in its own head. That is exactly the act the whole
// doctrine forbids, and these helpers are how the eval checks the result.
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
export const monthStart = (ref, n = 0) => {
  const d = at(ref);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, 1);
};
export const monthEnd = (ref, n = 0) => {
  const d = at(ref);
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0, 12));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
};
export const quarterStart = (ref, n = 0) => {
  const d = at(ref);
  const t = new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3 + n * 3, 1, 12));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, 1);
};
export const quarterEnd = (ref, n = 0) => monthEnd(quarterStart(ref, n), 2);
export const yearStart = (ref, n = 0) => `${at(ref).getUTCFullYear() + n}-01-01`;
export const yearEnd = (ref, n = 0) => `${at(ref).getUTCFullYear() + n}-12-31`;
export const monthLabel = (iso) => `${MONTHS[at(iso).getUTCMonth()]} ${at(iso).getUTCFullYear()}`;
/** Monday of the calendar week `n` weeks from ref's week (product convention: Mon–Sun). */
export const weekStart = (ref, n = 0) => addDays(ref, -((dow(ref) + 6) % 7) + 7 * n);
export const weekEnd = (ref, n = 0) => addDays(weekStart(ref, n), 6);
export const daysBetween = (a, b) => Math.round((at(b) - at(a)) / 86_400_000);

/**
 * Independently recompute what a resolve_date call SHOULD return, from its
 * arguments alone. The analyzer runs this against every observed call to tell
 * a MODEL error (asked for the wrong thing) apart from a MACHINERY error (the
 * tool was asked correctly and answered wrongly) — the distinction that says
 * whether a new date implementation is actually an improvement.
 * Mirrors the documented contract of ResolveDateParams; deliberately its own
 * implementation. Returns null when the args are not a valid single mode.
 */
export function expectedResolve(todayLocal, args) {
  const a = { ...args };
  // The live tool coerces stringified integers ("0") — GLM emits them often.
  for (const k of ['weeksAhead', 'dayShift', 'week']) {
    if (typeof a[k] === 'string' && /^-?\d+$/.test(a[k].trim())) a[k] = Number(a[k]);
  }
  const modes = [a.explicitDate !== undefined, a.weekday !== undefined, a.dayShift !== undefined, a.week !== undefined].filter(Boolean).length;
  if (modes !== 1) return null;
  if (a.week !== undefined) {
    if (!Number.isInteger(a.week)) return null;
    return { kind: 'week', weekStart: weekStart(todayLocal, a.week), weekEnd: weekEnd(todayLocal, a.week) };
  }
  if (a.explicitDate !== undefined) return /^\d{4}-\d{2}-\d{2}$/.test(a.explicitDate) ? { kind: 'day', date: a.explicitDate } : null;
  if (a.weekday !== undefined) {
    if (!WIDX[a.weekday]) return null;
    const w = a.weeksAhead ?? 0;
    if (!Number.isInteger(w) || w < 0) return null;
    return { kind: 'day', date: addDays(comingOcc(todayLocal, a.weekday), w * 7) };
  }
  if (!Number.isInteger(a.dayShift)) return null;
  return { kind: 'day', date: addDays(todayLocal, a.dayShift) };
}

// ─────────────────────────────────────────────────────── corpus build ──
const q = (id, cat, phases, text, expect) => ({ id, cat, phases, q: text, expect });

/**
 * Build the full corpus. `f` is the facts bundle plan.mjs pulled from the DB:
 *   f.today            firm-local YYYY-MM-DD
 *   f.dayCounts        {ISO: n}  confirmed, timed visits per firm-local day
 *   f.techDayCounts    {ISO: {techRef: n}}
 *   f.firstOfDay       {ISO: {techRef: {customer, title, startLocal}}}
 *   f.timeOff          [{tech, startsOn, endsOn}]
 *   f.windowJobs       [{customer, title, tech, earliest, latest}]
 *   f.nextVisit        {customerName: {date, tech, title}}
 */
export function buildCorpus(f) {
  const T = f.today;
  const out = [];
  const count = (iso) => f.dayCounts[iso] ?? 0;
  const rangeCount = (a, b) => {
    let n = 0;
    for (let d = a; d <= b; d = addDays(d, 1)) n += count(d);
    return n;
  };
  const techCount = (iso, tech) => f.techDayCounts[iso]?.[tech] ?? 0;

  // ── PURE DATE (resolve + speak; no data read) ──────────────────────────
  // Isolates the date machinery from everything else: any failure here is
  // resolve or speak, never a query.
  const pure = [
    ['P01', 'what exact date is today?', { dates: [T] }],
    ['P02', 'what date is tomorrow?', { dates: [addDays(T, 1)] }],
    ['P03', 'what date is the day after tomorrow?', { dates: [addDays(T, 2)] }],
    ['P04', 'what date was yesterday?', { dates: [addDays(T, -1)] }],
    ['P05', 'what date is this Friday?', { dates: [comingOcc(T, 'friday')] }],
    ['P06', 'what date is this coming Monday?', { dates: [comingOcc(T, 'monday')] }],
    ['P07', 'what date is this Saturday?', { dates: [comingOcc(T, 'saturday')] }],
    ['P08', 'what date is it in 3 days?', { dates: [addDays(T, 3)] }],
    ['P09', 'what date is it in 10 days?', { dates: [addDays(T, 10)] }],
    ['P10', 'what date is a week from today?', { dates: [addDays(T, 7)] }],
    ['P11', 'what date is two weeks from this Friday?', { dates: [addDays(comingOcc(T, 'friday'), 14)] }],
    ['P12', 'what date is a fortnight from today?', { dates: [addDays(T, 14)] }],
    ['P13', 'what date was last Friday?', { dates: [addDays(comingOcc(T, 'friday'), -7)] }],
    ['P14', 'what date was this past Sunday?', { dates: [addDays(comingOcc(T, 'sunday'), -7)] }],
    ['P15', 'what date is the Friday of next week?', { dates: [addDays(weekStart(T, 1), 4)] }],
    ['P16', 'what date is the Sunday of next week?', { dates: [weekEnd(T, 1)] }],
    ['P17', 'what date is three weeks from today?', { dates: [addDays(T, 21)] }],
  ];
  for (const [id, phrase, e] of pure) {
    out.push(q(id, 'pure-date', ['resolve', 'speak'], `Quick check — ${phrase}`, { ...e, answer: { kind: 'date' }, requireWeekday: true }));
  }
  // Weekday-of-a-date and span questions — the same phases, stated the other
  // way round (given a date, name the day).
  out.push(q('P18', 'pure-date', ['resolve', 'speak'], `What day of the week is it today?`, { dates: [T], answer: { kind: 'text', value: titleWeekday(T) }, requireWeekday: false }));
  const probe = addDays(T, 8);
  out.push(q('P19', 'pure-date', ['resolve', 'speak'], `What weekday does ${humanDate(probe)} fall on?`, { dates: [probe], answer: { kind: 'text', value: titleWeekday(probe) }, requireWeekday: false }));
  out.push(q('P20', 'pure-date', ['resolve', 'speak'], `What are the dates of this week, Monday through Sunday?`, { dates: [weekStart(T), weekEnd(T)], window: { from: weekStart(T), to: weekEnd(T) }, answer: { kind: 'range' }, requireWeekday: true }));
  out.push(q('P21', 'pure-date', ['resolve', 'speak'], `What are next week's Monday-to-Sunday dates?`, { dates: [weekStart(T, 1), weekEnd(T, 1)], window: { from: weekStart(T, 1), to: weekEnd(T, 1) }, answer: { kind: 'range' }, requireWeekday: true }));
  out.push(q('P22', 'pure-date', ['resolve', 'speak'], `How many days from today until ${humanDate(addDays(T, 10))}?`, { dates: [addDays(T, 10)], answer: { kind: 'count', value: 10 }, requireWeekday: false }));
  const eom = (() => { const d = at(T); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()}`; })();
  out.push(q('P23', 'pure-date', ['resolve', 'speak'], `What's the date of the last day of this month, and what weekday is it?`, { dates: [eom], answer: { kind: 'date' }, requireWeekday: true }));
  out.push(q('P24', 'pure-date', ['resolve', 'speak'], `How many days from today until the end of the month?`, { dates: [eom], answer: { kind: 'count', value: daysBetween(T, eom) }, requireWeekday: false }));

  // ── DAY READS (resolve + use + speak) ─────────────────────────────────
  // A count for a spoken day: wrong number can come from a wrong date
  // (resolve), a wrong query window (use), or a right query narrated wrong
  // (speak) — which is exactly what the trace disentangles.
  const dayPhrases = [
    ['D01', 'tomorrow', addDays(T, 1)],
    ['D02', 'today', T],
    ['D03', 'this Friday', comingOcc(T, 'friday')],
    ['D04', 'this Saturday', comingOcc(T, 'saturday')],
    ['D05', 'this Sunday', comingOcc(T, 'sunday')],
    ['D06', 'the day after tomorrow', addDays(T, 2)],
    ['D07', 'this coming Monday', comingOcc(T, 'monday')],
    ['D08', 'a week from tomorrow', addDays(T, 8)],
    ['D09', 'yesterday', addDays(T, -1)],
    ['D10', 'last Wednesday', addDays(comingOcc(T, 'wednesday'), -7)],
  ];
  for (const [id, phrase, date] of dayPhrases) {
    out.push(q(id, 'day-read', ['resolve', 'use', 'speak'], `How many visits do we have ${phrase}?`, {
      dates: [date], window: { from: date, to: date }, answer: { kind: 'count', value: count(date) }, requireWeekday: true,
    }));
  }
  // Per-tech day reads — same phases, narrower slice.
  const techs = [...new Set(Object.values(f.techDayCounts).flatMap((m) => Object.keys(m)))].filter((t) => t !== 'UNASSIGNED');
  const busyTechs = techs
    .map((t) => [t, Object.keys(f.techDayCounts).reduce((s, d) => s + techCount(d, t), 0)])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([t]) => t);
  let i = 11;
  for (const tech of busyTechs) {
    for (const [phrase, date] of [['tomorrow', addDays(T, 1)], ['this Friday', comingOcc(T, 'friday')]]) {
      out.push(q(`D${String(i++).padStart(2, '0')}`, 'day-read', ['resolve', 'use', 'speak'], `How many visits does ${tech} have ${phrase}?`, {
        dates: [date], window: { from: date, to: date }, answer: { kind: 'count', value: techCount(date, tech) }, requireWeekday: true,
      }));
    }
  }
  // Who is working a given day — a set answer, still date-gated.
  const satWorkers = Object.entries(f.techDayCounts[comingOcc(T, 'saturday')] ?? {}).map(([t, n]) => `${t} (${n})`);
  out.push(q('D17', 'day-read', ['resolve', 'use', 'speak'], `Who's working this Saturday?`, {
    dates: [comingOcc(T, 'saturday')], window: { from: comingOcc(T, 'saturday'), to: comingOcc(T, 'saturday') },
    answer: { kind: 'set', value: satWorkers }, requireWeekday: true,
  }));
  const sunWorkers = Object.entries(f.techDayCounts[comingOcc(T, 'sunday')] ?? {}).map(([t, n]) => `${t} (${n})`);
  out.push(q('D18', 'day-read', ['resolve', 'use', 'speak'], `Who's on the schedule this Sunday?`, {
    dates: [comingOcc(T, 'sunday')], window: { from: comingOcc(T, 'sunday'), to: comingOcc(T, 'sunday') },
    answer: { kind: 'set', value: sunWorkers }, requireWeekday: true,
  }));
  // First job of a day — tests that the right day's data was read, not just counted.
  const tomorrow = addDays(T, 1);
  for (const [n, tech] of busyTechs.slice(0, 2).entries()) {
    const first = f.firstOfDay[tomorrow]?.[tech];
    if (first) {
      out.push(q(`D${19 + n}`, 'day-read', ['resolve', 'use', 'speak'], `What's ${tech}'s first job tomorrow?`, {
        dates: [tomorrow], window: { from: tomorrow, to: tomorrow },
        answer: { kind: 'text', value: `${first.customer} — ${first.title} at ${first.startLocal}` }, requireWeekday: true,
      }));
    }
  }
  // An empty day: the honest answer is "nothing", and a hallucinated visit is
  // a different failure from a miscount.
  const emptyDay = Array.from({ length: 21 }, (_, k) => addDays(T, k)).find((d) => count(d) === 0);
  if (emptyDay) {
    out.push(q('D21', 'day-read', ['resolve', 'use', 'speak'], `Is anything scheduled on ${titleWeekday(emptyDay)} ${humanDate(emptyDay)}?`, {
      dates: [emptyDay], window: { from: emptyDay, to: emptyDay }, answer: { kind: 'count', value: 0 }, requireWeekday: true,
      note: 'Zero timed visits. Mentioning fenced/window jobs that overlap is acceptable, inventing a timed visit is not.',
    }));
  }

  // ── WEEK WINDOWS (resolve + use + speak) ──────────────────────────────
  // The boundary cases that bit us live: Mon-start weeks, "still left this
  // week" meaning today-onward, weekend readings of "this week".
  const wk = (n) => ({ from: weekStart(T, n), to: weekEnd(T, n) });
  out.push(q('W01', 'week-window', ['resolve', 'use', 'speak'], `How many jobs do we still have for this week?`, {
    dates: [weekStart(T), weekEnd(T)], window: wk(0), answer: { kind: 'count', value: rangeCount(T, weekEnd(T)) },
    altAnswers: [rangeCount(weekStart(T), weekEnd(T))], requireWeekday: false,
    note: '"still have" = today onward. The full Mon–Sun total is acceptable ONLY if the reply says so explicitly.',
  }));
  out.push(q('W02', 'week-window', ['resolve', 'use', 'speak'], `How many visits are scheduled this week in total, Monday through Sunday?`, {
    dates: [weekStart(T), weekEnd(T)], window: wk(0), answer: { kind: 'count', value: rangeCount(weekStart(T), weekEnd(T)) }, requireWeekday: false,
  }));
  out.push(q('W03', 'week-window', ['resolve', 'use', 'speak'], `How many visits do we have next week?`, {
    dates: [weekStart(T, 1), weekEnd(T, 1)], window: wk(1), answer: { kind: 'count', value: rangeCount(weekStart(T, 1), weekEnd(T, 1)) }, requireWeekday: false,
  }));
  out.push(q('W04', 'week-window', ['resolve', 'use', 'speak'], `How many visits are scheduled the week after next?`, {
    dates: [weekStart(T, 2), weekEnd(T, 2)], window: wk(2), answer: { kind: 'count', value: rangeCount(weekStart(T, 2), weekEnd(T, 2)) }, requireWeekday: false,
  }));
  out.push(q('W05', 'week-window', ['resolve', 'use', 'speak'], `How many visits did we do last week?`, {
    dates: [weekStart(T, -1), weekEnd(T, -1)], window: wk(-1), answer: { kind: 'count', value: rangeCount(weekStart(T, -1), weekEnd(T, -1)) }, requireWeekday: false,
  }));
  out.push(q('W06', 'week-window', ['resolve', 'use', 'speak'], `Starting tomorrow, how many visits are left for the rest of this week?`, {
    dates: [addDays(T, 1), weekEnd(T)], window: { from: addDays(T, 1), to: weekEnd(T) }, answer: { kind: 'count', value: rangeCount(addDays(T, 1), weekEnd(T)) }, requireWeekday: false,
  }));
  for (const [n, tech] of busyTechs.entries()) {
    out.push(q(`W${String(7 + n).padStart(2, '0')}`, 'week-window', ['resolve', 'use', 'speak'], `How many visits does ${tech} have next week?`, {
      dates: [weekStart(T, 1), weekEnd(T, 1)], window: wk(1),
      answer: { kind: 'count', value: Object.keys(f.techDayCounts).filter((d) => d >= weekStart(T, 1) && d <= weekEnd(T, 1)).reduce((s, d) => s + techCount(d, tech), 0) },
      requireWeekday: false,
    }));
  }
  // Superlatives inside a window — a wrong window shows up as a wrong day.
  const daysOf = (n) => Array.from({ length: 7 }, (_, k) => addDays(weekStart(T, n), k));
  const busiestNext = daysOf(1).reduce((a, b) => (count(b) > count(a) ? b : a));
  const busiestTie = daysOf(1).filter((d) => count(d) === count(busiestNext));
  out.push(q('W10', 'week-window', ['resolve', 'use', 'speak'], `What's the busiest day next week?`, {
    dates: busiestTie, window: wk(1), answer: { kind: 'set', value: busiestTie.map((d) => `${titleWeekday(d)} ${d} (${count(d)})`) }, requireWeekday: true,
    note: busiestTie.length > 1 ? 'TIE — naming either day is correct only if the tie is stated.' : undefined,
  }));
  const weekdaysNext = daysOf(1).slice(0, 5);
  const lightest = weekdaysNext.reduce((a, b) => (count(b) < count(a) ? b : a));
  out.push(q('W11', 'week-window', ['resolve', 'use', 'speak'], `What's the lightest weekday next week?`, {
    dates: [lightest], window: wk(1), answer: { kind: 'text', value: `${titleWeekday(lightest)} ${lightest} (${count(lightest)})` }, requireWeekday: true,
  }));
  const satN = addDays(weekStart(T, 1), 5); // Saturday of next week
  out.push(q('W12', 'week-window', ['resolve', 'use', 'speak'], `How many weekend visits next week?`, {
    dates: [satN, addDays(satN, 1)], window: { from: satN, to: addDays(satN, 1) }, answer: { kind: 'count', value: count(satN) + count(addDays(satN, 1)) }, requireWeekday: false,
  }));
  out.push(q('W13', 'week-window', ['resolve', 'use', 'speak'], `Do we have more visits this week or next week?`, {
    dates: [weekStart(T), weekEnd(T, 1)], window: null,
    answer: { kind: 'text', value: `${rangeCount(weekStart(T), weekEnd(T))} this week vs ${rangeCount(weekStart(T, 1), weekEnd(T, 1))} next week` }, requireWeekday: false,
  }));
  const a1 = weekStart(T, 1), a3 = addDays(a1, 2);
  out.push(q('W14', 'week-window', ['resolve', 'use', 'speak'], `How many visits between ${humanDate(a1)} and ${humanDate(a3)}, inclusive?`, {
    dates: [a1, a3], window: { from: a1, to: a3 }, answer: { kind: 'count', value: rangeCount(a1, a3) }, requireWeekday: false,
  }));

  // ── SPECIFICS (use + speak; the date comes from DATA, not a phrase) ────
  // These isolate SPEAK: there is no phrase to resolve, so a wrong date in the
  // reply is a transcription failure, not arithmetic.
  const namedCustomers = Object.entries(f.nextVisit).slice(0, 8);
  let sIdx = 1;
  for (const [customer, v] of namedCustomers) {
    out.push(q(`S${String(sIdx++).padStart(2, '0')}`, 'specifics', ['use', 'speak'], `When is ${customer}'s next visit?`, {
      dates: [v.date], window: null, answer: { kind: 'text', value: `${titleWeekday(v.date)} ${v.date}${v.tech ? ` (${v.tech})` : ''}` }, requireWeekday: true,
    }));
  }
  for (const wj of f.windowJobs.slice(0, 4)) {
    out.push(q(`S${String(sIdx++).padStart(2, '0')}`, 'specifics', ['use', 'speak'], `What's the scheduling window for ${wj.customer}'s ${wj.title}?`, {
      dates: [wj.earliest, wj.latest], window: { from: wj.earliest, to: wj.latest },
      answer: { kind: 'text', value: `${wj.earliest} to ${wj.latest}` }, requireWeekday: true,
    }));
  }
  for (const to of f.timeOff.slice(0, 2)) {
    out.push(q(`S${String(sIdx++).padStart(2, '0')}`, 'specifics', ['resolve', 'use', 'speak'], `Is ${to.tech} off any day this week or next?`, {
      dates: [to.startsOn], window: null, answer: { kind: 'text', value: `${titleWeekday(to.startsOn)} ${to.startsOn}${to.endsOn !== to.startsOn ? ` through ${to.endsOn}` : ''}` }, requireWeekday: true,
    }));
    const clash = count(to.startsOn) > 0 && techCount(to.startsOn, to.tech) > 0;
    out.push(q(`S${String(sIdx++).padStart(2, '0')}`, 'specifics', ['use', 'speak'], `Does ${to.tech} have any visits booked on their day off?`, {
      dates: [to.startsOn], window: null,
      answer: { kind: 'text', value: clash ? `yes — ${techCount(to.startsOn, to.tech)} visit(s) on ${to.startsOn}, a conflict` : `no visits on ${to.startsOn}` }, requireWeekday: true,
    }));
  }

  // ── TRAPS (guard-relevant; a wrong pair must be CAUGHT, not echoed) ────
  // The question states a weekday and a date that disagree. Correct behaviour
  // is to flag the mismatch; echoing it back is the exact failure the guard
  // exists to catch, so these are the questions that generate guard evidence.
  const mismatchDate = addDays(T, 3);
  const wrongDay = WDAYS[(dow(mismatchDate) + 2) % 7];
  out.push(q('T01', 'trap', ['resolve', 'speak', 'guard'], `What's scheduled for ${wrongDay[0].toUpperCase() + wrongDay.slice(1)} ${humanDate(mismatchDate)}?`, {
    dates: [mismatchDate], window: null, answer: { kind: 'flag' }, requireFlag: true, requireWeekday: true,
    note: `${humanDate(mismatchDate)} is a ${titleWeekday(mismatchDate)}, not a ${wrongDay}. Must flag or ask which was meant.`,
  }));
  const m2 = addDays(T, 8), wrong2 = WDAYS[(dow(m2) + 1) % 7];
  out.push(q('T02', 'trap', ['resolve', 'speak', 'guard'], `We told a customer their visit is on ${wrong2[0].toUpperCase() + wrong2.slice(1)} ${humanDate(m2)} — is that right?`, {
    dates: [m2], window: null, answer: { kind: 'flag' }, requireFlag: true, requireWeekday: true,
    note: `${humanDate(m2)} is a ${titleWeekday(m2)}. Must correct the pair.`,
  }));
  const m3 = addDays(T, 5);
  out.push(q('T03', 'trap', ['resolve', 'speak', 'guard'], `The ${at(m3).getUTCDate()}th is a ${WDAYS[(dow(m3) + 3) % 7]}, right?`, {
    dates: [m3], window: null, answer: { kind: 'flag' }, requireFlag: true, requireWeekday: true,
    note: `It is a ${titleWeekday(m3)}. Must disagree.`,
  }));
  // Ambiguity: doctrine says resolve BOTH readings and ask — never pick one.
  out.push(q('T04', 'trap', ['resolve', 'speak'], `A customer wants their visit next Friday. What date should I write down?`, {
    dates: [comingOcc(T, 'friday'), addDays(comingOcc(T, 'friday'), 7)], window: null, answer: { kind: 'ambiguity' }, requireAsk: true, requireWeekday: true,
    note: 'Must present BOTH readings and ask. Silently picking one is the failure.',
  }));
  out.push(q('T05', 'trap', ['resolve', 'speak'], `A customer said "see you the Tuesday after next" — what date is that?`, {
    dates: [addDays(comingOcc(T, 'tuesday'), 7), addDays(comingOcc(T, 'tuesday'), 14)], window: null, answer: { kind: 'ambiguity' }, requireAsk: true, requireWeekday: true,
    note: 'Ambiguous; either a stated single reading with its weekday, or both offered, is acceptable — a bare unqualified date is not.',
  }));
  // Read-only phrasing of a booking-shaped question: must NOT write.
  out.push(q('T06', 'trap', ['resolve', 'speak'], `If we wanted to add a visit a week from Friday, what date would that be? Don't book anything.`, {
    dates: [addDays(comingOcc(T, 'friday'), 7)], window: null, answer: { kind: 'date' }, requireWeekday: true, forbidWrites: true,
  }));
  out.push(q('T07', 'trap', ['resolve', 'use', 'speak'], `When is our next completely free weekday — no visits at all?`, {
    dates: (() => {
      const d = Array.from({ length: 30 }, (_, k) => addDays(T, k + 1)).find((x) => dow(x) >= 1 && dow(x) <= 5 && count(x) === 0);
      return d ? [d] : [];
    })(),
    window: null, answer: { kind: 'text', value: 'the next weekday with zero timed visits' }, requireWeekday: true,
  }));
  const f1 = comingOcc(T, 'friday'), f2 = addDays(f1, 7);
  out.push(q('T08', 'trap', ['resolve', 'use', 'speak'], `Which Friday is busier, this one or next?`, {
    dates: [f1, f2], window: null,
    answer: { kind: 'text', value: `${f1}: ${count(f1)} vs ${f2}: ${count(f2)}${count(f1) === count(f2) ? ' (tie)' : ''}` }, requireWeekday: true,
  }));
  out.push(q('T09', 'trap', ['resolve', 'speak'], `How many days is it from this Friday to the following Wednesday?`, {
    dates: [f1, comingOcc(addDays(f1, 1), 'wednesday')], window: null,
    answer: { kind: 'count', value: daysBetween(f1, comingOcc(addDays(f1, 1), 'wednesday')) }, requireWeekday: false,
  }));
  out.push(q('T10', 'trap', ['resolve', 'speak'], `Sanity check: today is the ${at(T).getUTCDate()}th, right?`, {
    dates: [T], window: null, answer: { kind: 'text', value: `yes — ${titleWeekday(T)} ${T}` }, requireWeekday: true,
  }));

  // ── PERIODS: month / quarter / year, and aggregation over them ─────────
  // The granularity a firm asks about once it has history: "last month",
  // "so far this year", "break it down by month". resolve_date has no mode for
  // ANY of these, so the agent must invent the boundary — observed live
  // 2026-08-11 writing '2026-07-01' straight into SQL with no resolve call at
  // all. It is right in August and wrong the moment the month is hard (a
  // 31-day month, a February, a year rollover), and no phase downstream can
  // catch it: a wrong boundary yields a plausible number carrying no weekday
  // to contradict. `periodBoundary: true` marks the questions where a
  // hand-written boundary is EXPECTED given today's machinery, so the report
  // can separate "the model was sloppy" from "the tool has no such mode".
  const periodQ = (id, text, e) => out.push(q(id, 'period', ['resolve', 'use', 'speak'], text, { periodBoundary: true, requireWeekday: false, ...e }));
  const lastMonth = { from: monthStart(T, -1), to: monthEnd(T, -1) };
  const thisMonth = { from: monthStart(T), to: T };
  periodQ('M01', `How many visits did we do last month?`, {
    dates: [lastMonth.from, lastMonth.to], window: lastMonth, answer: { kind: 'count', value: rangeCount(lastMonth.from, lastMonth.to) },
    note: `Calendar ${monthLabel(lastMonth.from)}: ${lastMonth.from}..${lastMonth.to}.`,
  });
  periodQ('M02', `How many visits have we done so far this month?`, {
    dates: [thisMonth.from, T], window: thisMonth, answer: { kind: 'count', value: rangeCount(thisMonth.from, T) },
    note: `${monthStart(T)} through today.`,
  });
  periodQ('M03', `How many visits are on the books for the whole of this month?`, {
    dates: [monthStart(T), monthEnd(T)], window: { from: monthStart(T), to: monthEnd(T) },
    answer: { kind: 'count', value: rangeCount(monthStart(T), monthEnd(T)) },
  });
  periodQ('M04', `How many visits did we have in ${monthLabel(monthStart(T, -1)).split(' ')[0]}?`, {
    dates: [lastMonth.from, lastMonth.to], window: lastMonth, answer: { kind: 'count', value: rangeCount(lastMonth.from, lastMonth.to) },
    note: 'Month named outright — the one period phrasing resolve_date CAN take, via explicitDate.',
  });
  periodQ('M05', `How many visits in the last 30 days?`, {
    dates: [addDays(T, -30), T], window: { from: addDays(T, -30), to: T }, answer: { kind: 'count', value: rangeCount(addDays(T, -30), T) },
    periodBoundary: false, // rolling window — dayShift:-30 expresses this exactly
    note: 'Rolling, NOT a calendar month. dayShift:-30 resolves it; a hand-written date here is avoidable.',
  });
  periodQ('M06', `Compare this month with last month — which is busier?`, {
    dates: [monthStart(T), lastMonth.from], window: null,
    answer: { kind: 'text', value: `${monthLabel(monthStart(T))} ${rangeCount(monthStart(T), monthEnd(T))} vs ${monthLabel(lastMonth.from)} ${rangeCount(lastMonth.from, lastMonth.to)}` },
    note: 'Two calendar buckets — both boundaries hand-made today.',
  });
  periodQ('M07', `How many visits so far this year?`, {
    dates: [yearStart(T), T], window: { from: yearStart(T), to: T }, answer: { kind: 'count', value: rangeCount(yearStart(T), T) },
  });
  periodQ('M08', `How many visits this quarter?`, {
    dates: [quarterStart(T), quarterEnd(T)], window: { from: quarterStart(T), to: quarterEnd(T) },
    answer: { kind: 'count', value: rangeCount(quarterStart(T), quarterEnd(T)) },
    note: `Q boundary ${quarterStart(T)}..${quarterEnd(T)} — no tool mode exists for this at all.`,
  });
  // Aggregation + honesty about how far the records actually go. A firm six
  // months in will ask exactly this; a firm one month in must be TOLD it is
  // one month in rather than shown five empty buckets as if they were real.
  const months = [...new Set(Object.keys(f.dayCounts).map((d) => d.slice(0, 7)))].sort();
  const monthTotals = Object.fromEntries(months.map((m) => [m, Object.entries(f.dayCounts).filter(([d]) => d.startsWith(m)).reduce((s, [, n]) => s + n, 0)]));
  periodQ('M09', `Break our visits down by month for the last 6 months.`, {
    dates: [], window: null,
    answer: { kind: 'set', value: months.map((m) => `${m}: ${monthTotals[m]}`) },
    note: `Records only span ${months[0]} to ${months[months.length - 1]}. The honest answer states that range rather than presenting empty months as real zeros.`,
  });
  periodQ('M10', `What's our busiest month on record?`, {
    dates: [], window: null,
    answer: { kind: 'text', value: Object.entries(monthTotals).sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m} (${n})`)[0] ?? 'no data' },
    note: `Month totals: ${JSON.stringify(monthTotals)}`,
  });
  periodQ('M11', `How far back do our records go?`, {
    dates: [], window: null, answer: { kind: 'text', value: `earliest visit ${Object.keys(f.dayCounts).sort()[0] ?? 'none'}` },
    periodBoundary: false,
    note: 'A range question, no arithmetic — catches a model that invents history it does not have.',
  });

  return out;
}
