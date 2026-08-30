// The TS twin of the SQL `working_hours_between` function (⑤ Phase 1): overlap
// of [fromIso, toIso) with a 7am-7pm firm-local day, in hours. The two
// implementations are asserted equal on fixtures in plannerMetrics.test.ts —
// the pinned-one-way rule exists because an unpinned pair would silently
// disagree and the corpus (Phase 2) would contradict the baseline (Phase 1).
//
// THESE ARE A MEASUREMENT CONVENTION, NOT A FIRM SETTING, and they used to be
// the ask window's constants — this file was that window's only external
// importer. The window is deleted (plan 2026-08-29 Phase 3); the yardstick is
// not, and it deliberately did NOT become per-firm data with it.
//
// Why it must stay fixed. It is a unit, like "business days": a metric whose
// definition moves per firm cannot compare two firms, and one that moves over
// time cannot compare a firm with its own past.
//
// It USED to be stored as well — gap_summaries.working_hours_open held numbers
// computed under this convention, so moving 7 or 19 would silently restate
// every historical row. That table was dropped 2026-08-30 and the argument goes
// with it: nothing persists a figure in these units any more. Two consequences
// worth knowing before touching this file. The TS function now has NO
// production caller (the deleted summarize sweep was its last one) and survives
// as the pinned twin of the SQL `working_hours_between`, which the metrics views
// DO use — src/db/plannerMetrics.test.ts is what holds the two identical. And
// the "it is stored" half of the case above is now history, not a live reason. And the SQL twin `working_hours_between` hardcodes
// `interval '7/19 hours'`: moving these without moving the migration breaks the
// equality plannerMetrics.test.ts pins.
//
// Minute-stepping on purpose: obviously correct across DST edges beats clever
// interval math, and the ranges are days (a 30-day gap is ~43k steps — fine
// for a per-closed-gap sweep). Formatter cached per zone.

const METRIC_DAY_START = 7; // inclusive, firm-local
const METRIC_DAY_END = 19; // exclusive, firm-local

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function localHour(tz: string, ms: number): number {
  let fmt = fmtCache.get(tz);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', hourCycle: 'h23' });
    fmtCache.set(tz, fmt);
  }
  return Number(fmt.format(new Date(ms)));
}

/** Working hours between two real-UTC instants, or null when unbounded. */
export function workingHoursBetween(
  fromIso: string | null,
  toIso: string | null,
  tz: string,
): number | null {
  if (!fromIso || !toIso) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) return null;
  const MINUTE = 60_000;
  let minutes = 0;
  // Grid ALIGNED TO WALL-CLOCK MINUTES, not to `from` (review find 6): the
  // window's edges fall on local minute boundaries, and modern zone offsets
  // are whole minutes, so aligned slices never straddle 07:00/19:00 — a
  // from-anchored grid mis-attributed up to a minute per boundary crossing.
  let t = from;
  while (t < to) {
    const next = Math.min(Math.floor(t / MINUTE) * MINUTE + MINUTE, to);
    const h = localHour(tz, t);
    if (h >= METRIC_DAY_START && h < METRIC_DAY_END) {
      minutes += (next - t) / MINUTE;
    }
    t = next;
  }
  return Math.round((minutes / 60) * 100) / 100;
}
