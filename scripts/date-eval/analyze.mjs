// Date-eval STEP 3 of 3 — report. Costs nothing; re-runnable on a finished run.
//
// Turns the trajectories into a per-phase verdict, so a failure lands on the
// thing that actually broke:
//
//   RESOLVE  did it get the right date, and did it get it from resolve_date?
//            Split two ways, because they need opposite fixes:
//              model     — asked the tool for the wrong thing (or asked nobody)
//              machinery — asked correctly, tool answered wrongly  ← new-code signal
//   USE      did that date reach the data tools intact — right window, no
//            invented literals?
//   SPEAK    does the reply state the right date, with a weekday, and do the
//            weekday and date agree?
//   GUARD    for every weekday↔date contradiction that DID reach the text,
//            would the outbound guard have flagged it?
//
// Attribution is EARLIEST-FAILING-PHASE: a bad date resolved at step one makes
// every later step wrong too, and counting those as three failures would say
// "speak is broken" when speak faithfully repeated a number it was handed.
// Later phases are marked `inherited` and excluded from their own denominators.
//
// GUARD IS REPLAYED OFFLINE UNLESS THE RUN USED --deliver. Replaying the
// plugin's own scanMessage over the collected replies measures the DETECTOR's
// logic exactly, but it cannot tell you the hook is wired up — it is our code
// calling our function. A run started with `--deliver` fires the REAL
// message_sending hook inside the sandbox and records its verdict per question
// as `guardLive`; this report then prefers that, and reports any REPLAY vs LIVE
// disagreement as a finding of its own. A disagreement means one of two things,
// both worth knowing: the deployed plugin is not the version in this repo, or
// the text the hook sees is not the text we graded.
//
//   node scripts/date-eval/analyze.mjs --dir <run-dir>
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { scanMessage, firmLocalParts } from '../../Box_Setup_Stuff/plugins/trades-weekday-guard/index.js';
import { expectedResolve, weekdayName, titleWeekday, addDays } from './corpus.mjs';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const DIR = argOf('dir', join(process.cwd(), 'date-eval-runs', 'pending'));
const manifest = JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8'));
const TODAY = manifest.today;
const TZ = manifest.timezone || 'America/Los_Angeles';

const results = readFileSync(join(DIR, 'results.jsonl'), 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const byId = Object.fromEntries(manifest.questions.map((q) => [q.id, q]));
const abort = results.find((r) => r.id === 'ABORT-FAILOVER');

const ISO_RE = /\b(\d{4}-\d{2}-\d{2})\b/g;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const NUMWORD = { zero: 0, no: 0, none: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };

/** Every date the text names, in ISO form — "2026-08-14", "August 14",
 * "August 21st" (ordinals: the P15 miss on the 2026-08-15 run — the reply's
 * correct "August 21st" was invisible to the grader), and "Aug 14"
 * (abbreviations; 'may' is deliberately NOT an accepted abbreviation — it is
 * a modal verb and "may 3 visits" would mint a phantom date). */
const MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
function datesNamed(text, year) {
  const out = new Set();
  for (const m of text.matchAll(ISO_RE)) out.add(m[1]);
  const add = (moNum, day) => out.add(`${year}-${String(moNum).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`);
  const re = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
  for (const m of text.matchAll(re)) add(MONTHS.indexOf(m[1].toLowerCase()) + 1, m[2]);
  const ab = new RegExp(`\\b(${Object.keys(MONTH_ABBR).join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'gi');
  for (const m of text.matchAll(ab)) add(MONTH_ABBR[m[1].toLowerCase()], m[2]);
  // Numeric M/D ("8/19", "08/19") — the v2 run's W10 wrote its (correct)
  // busiest-day table as "Wed 8/19" and the grader read it as no date at all.
  // Bounded to real month/day pairs and no adjacent digits, so "24/7" coverage
  // talk or "3/4 of the day" can still slip through only when they parse as a
  // real date — acceptable: minted dates only ever ADD to `named`, and the
  // invented-date check screens them against tool-produced dates anyway.
  for (const m of text.matchAll(/(?<!\d|\/)(\d{1,2})\/(\d{1,2})(?!\d|\/)/g)) {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) add(mo, d);
  }
  return [...out];
}

/** Every count the text plausibly states: digits plus the number words. */
function numsIn(text) {
  const nums = new Set([...text.matchAll(/\b(\d{1,4})\b/g)].map((m) => Number(m[1])));
  for (const [w, v] of Object.entries(NUMWORD)) if (new RegExp(`\\b${w}\\b`, 'i').test(text)) nums.add(v);
  return nums;
}

/** Bucket-label lexicon for CURRENT-period counts (the M09 adjudication rule,
 * 2026-08-13: through-today totals are accepted only when the reply says which
 * bucket it used; full-period totals name themselves). */
// "through" alone qualifies: the marker only gates ACCEPTING the through-today
// number, which must also be exactly right — v6's M09 wrote the perfect label
// "(through Sat 2026-08-15)" and the narrow lexicon refused it.
const PERIOD_MARKER_RE = /\b(so far|through\b|to date|as of|booked|on the books|full month|full quarter|full year|including upcoming|halfway)/i;
/** Weekday↔date contradictions the TEXT itself contains (our own check, independent of the guard). */
function ownMismatches(text, year) {
  const found = [];
  const re = new RegExp(`\\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\\b[,\\s]+(?:the\\s+)?(?:(${MONTHS.join('|')})\\s+(\\d{1,2})|(\\d{4}-\\d{2}-\\d{2}))`, 'gi');
  for (const m of text.matchAll(re)) {
    const iso = m[4] ?? `${year}-${String(MONTHS.indexOf(m[2].toLowerCase()) + 1).padStart(2, '0')}-${String(Number(m[3])).padStart(2, '0')}`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
    const actual = weekdayName(iso);
    if (actual !== m[1].toLowerCase()) found.push({ said: m[1].toLowerCase(), date: iso, actual });
  }
  return found;
}
const deepDates = (v, acc = new Set()) => {
  if (typeof v === 'string') for (const m of v.matchAll(ISO_RE)) acc.add(m[1]);
  else if (Array.isArray(v)) v.forEach((x) => deepDates(x, acc));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => deepDates(x, acc));
  return acc;
};

/** Flatten a trajectory into ordered steps with timings. */
function parseTrajectory(path) {
  if (!existsSync(path)) return null;
  const evs = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const steps = [];
  let models = new Set();
  let firstUserTs = null, lastTs = null;
  let tokens = { input: 0, output: 0, cacheRead: 0 };
  for (const e of evs) {
    if (e.type === 'model_change' && e.modelId) models.add(e.modelId);
    if (e.type !== 'message') continue;
    const ts = Date.parse(e.timestamp);
    lastTs = ts;
    const m = e.message;
    if (m.role === 'user' && firstUserTs === null) firstUserTs = ts;
    if (m.role === 'assistant') {
      if (m.model) models.add(m.model);
      if (m.usage) { tokens.input += m.usage.input ?? 0; tokens.output += m.usage.output ?? 0; tokens.cacheRead += m.usage.cacheRead ?? 0; }
      const calls = (m.content ?? []).filter((c) => c.type === 'toolCall');
      const text = (m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      steps.push({ kind: 'assistant', ts, calls, text });
    } else if (m.role === 'toolResult') {
      const body = (m.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('');
      let parsed = null; try { parsed = JSON.parse(body); } catch {}
      steps.push({ kind: 'toolResult', ts, toolName: m.toolName ?? m.details?.mcpTool, body, parsed, isError: !!m.isError, callId: m.toolCallId });
    }
  }
  return { steps, models: [...models], firstUserTs, lastTs, tokens };
}

const isResolve = (name = '') => /resolve_date/.test(name);
const isWrite = (name = '') => /(book|move|cancel|create|update|set_|delete|commit|send_email|unschedule|attach)/i.test(name) && !/get_|list_|query_/.test(name);

const rows = [];
for (const r of results) {
  if (r.id === 'ABORT-FAILOVER') continue;
  const spec = byId[r.id];
  if (!spec) continue;
  const e = spec.expect ?? {};
  const year = TODAY.slice(0, 4);
  const traj = parseTrajectory(join(DIR, 'trajectories', `${r.id}.jsonl`));
  const text = r.reply ?? '';

  // ── gather what happened ──
  const resolveCalls = [];   // {args, returned, expected, ok}
  const dataCalls = [];      // {name, args, dates}
  const writeCalls = [];
  let resolvedDates = new Set();
  const lat = { resolve: 0, use: 0, speak: 0, other: 0 };

  if (traj) {
    const pending = new Map();
    let prevTs = traj.firstUserTs;
    for (const s of traj.steps) {
      if (s.kind === 'assistant') {
        const genMs = Math.max(0, s.ts - prevTs);
        const hasResolve = s.calls.some((c) => isResolve(c.name));
        const hasData = s.calls.some((c) => !isResolve(c.name));
        if (hasResolve) lat.resolve += genMs;
        else if (hasData) lat.use += genMs;
        else if (s.text.trim()) lat.speak += genMs;   // the final prose turn
        else lat.other += genMs;
        for (const c of s.calls) {
          pending.set(c.id, { name: c.name, args: c.arguments ?? {}, ts: s.ts });
          if (isWrite(c.name)) writeCalls.push({ name: c.name, args: c.arguments });
        }
        prevTs = s.ts;
      } else {
        const call = pending.get(s.callId);
        const execMs = call ? Math.max(0, s.ts - call.ts) : 0;
        if (call && isResolve(call.name)) {
          lat.resolve += execMs;
          const got = s.parsed ?? {};
          const exp = expectedResolve(TODAY, call.args);
          let ok = null, returned = null;
          if (got.status === 'resolved') { returned = got.date; ok = exp?.kind === 'day' ? exp.date === got.date : null; if (got.date) resolvedDates.add(got.date); }
          else if (got.status === 'resolved_week') {
            returned = `${got.weekStart}..${got.weekEnd}`;
            ok = exp?.kind === 'week' ? exp.weekStart === got.weekStart && exp.weekEnd === got.weekEnd : null;
            if (got.weekStart) { resolvedDates.add(got.weekStart); resolvedDates.add(got.weekEnd); }
          } else if (got.status === 'resolved_period') {
            // month/quarter/year modes (tool since 2026-08-12) — same
            // machinery-vs-model split as weeks, via the independent recompute.
            returned = `${got.periodStart}..${got.periodEnd}`;
            ok = exp?.kind === 'period' ? exp.periodStart === got.periodStart && exp.periodEnd === got.periodEnd : null;
            if (got.periodStart) { resolvedDates.add(got.periodStart); resolvedDates.add(got.periodEnd); }
          } else { returned = got.status ?? 'unparsed'; ok = exp === null ? true : false; }
          resolveCalls.push({ args: call.args, returned, expected: exp, ok });
        } else if (call) {
          lat.use += execMs;
          dataCalls.push({ name: call.name, args: call.args, dates: [...deepDates(call.args)] });
        }
        prevTs = s.ts;
      }
    }
  }

  // ── PHASE 1: RESOLVE ──
  const required = e.dates ?? [];
  const machineryBad = resolveCalls.filter((c) => c.ok === false);
  let resolve = { verdict: 'n/a', flags: [] };
  if (spec.phases.includes('resolve')) {
    const landed = new Set([...resolvedDates]);
    const missing = required.filter((d) => !landed.has(d));
    if (machineryBad.length) {
      resolve = { verdict: 'fail', reason: 'machinery', flags: ['tool returned a date its own arguments do not imply'], detail: machineryBad.map((c) => `${JSON.stringify(c.args)} → ${c.returned}, expected ${JSON.stringify(c.expected)}`) };
    } else if (resolveCalls.length === 0) {
      // No tool call. Not automatically an outcome failure — but the date was
      // computed in the model's head, which is the thing the doctrine forbids.
      const spokenOk = required.every((d) => datesNamed(text, year).includes(d));
      resolve = { verdict: spokenOk ? 'pass' : 'fail', reason: spokenOk ? undefined : 'model', flags: ['BYPASSED resolve_date — date computed in-model'] };
    } else if (missing.length) {
      resolve = { verdict: 'fail', reason: 'model', flags: [`asked for the wrong day: never resolved ${missing.join(', ')}`], detail: resolveCalls.map((c) => `${JSON.stringify(c.args)} → ${c.returned}`) };
    } else {
      resolve = { verdict: 'pass', flags: [] };
    }
  }

  // ── PHASE 2: USE ──
  let use = { verdict: 'n/a', flags: [] };
  if (spec.phases.includes('use')) {
    if (resolve.verdict === 'fail') use = { verdict: 'inherited', flags: [] };
    else if (dataCalls.length === 0) use = { verdict: 'fail', reason: 'no-data-read', flags: ['answered a data question without reading the schedule'] };
    else {
      const flags = [];
      const allDates = new Set(dataCalls.flatMap((c) => c.dates));
      const justified = new Set([...resolvedDates, ...required, ...(e.window ? [e.window.from, e.window.to] : [])]);
      const fabricated = [...allDates].filter((d) => !justified.has(d));
      if (e.window) {
        const covers = dataCalls.some((c) => {
          const ds = c.dates.filter(Boolean).sort();
          return ds.length && ds[0] <= e.window.from && ds[ds.length - 1] >= e.window.to;
        });
        const exact = dataCalls.some((c) => c.dates.includes(e.window.from) && c.dates.includes(e.window.to));
        if (!covers) flags.push(`window never covered ${e.window.from}..${e.window.to} (queried ${[...allDates].join(', ') || 'no dates'})`);
        else if (!exact) flags.push(`window covered but not exact (queried ${[...allDates].join(', ')})`);
      }
      // A hand-written date is normally a model failure. On month/quarter/year
      // questions it is FORCED — resolve_date has no mode for those periods —
      // so it is counted as a machinery GAP instead of blamed on the model.
      // Same observable, opposite fix: one needs better prompting, the other
      // needs a tool that can express the period.
      if (fabricated.length) {
        flags.push(e.periodBoundary
          ? `period boundary written by hand: ${fabricated.join(', ')} — no resolve_date mode exists for this period`
          : `date in tool args that no resolve produced: ${fabricated.join(', ')}`);
      }
      const boundaryGap = !!(fabricated.length && e.periodBoundary);
      const hard = flags.some((f) => f.startsWith('window never')) || (fabricated.length > 0 && !e.periodBoundary);
      use = { verdict: hard ? 'fail' : 'pass', reason: hard ? 'model' : undefined, flags, boundaryGap, handWritten: fabricated };
    }
  }

  // ── PHASE 3: SPEAK ──
  const named = datesNamed(text, year);
  const mism = ownMismatches(text, year);
  let speak = { verdict: 'n/a', flags: [] };
  if (spec.phases.includes('speak')) {
    if (resolve.verdict === 'fail' || use.verdict === 'fail') speak = { verdict: 'inherited', flags: [] };
    else {
      const flags = [];
      if (mism.length) flags.push(...mism.map((m) => `says ${m.said} for ${m.date}, which is a ${m.actual}`));
      const justified = new Set([...resolvedDates, ...required, ...dataCalls.flatMap((c) => c.dates)]);
      const invented = named.filter((d) => !justified.has(d));
      if (invented.length) flags.push(`names a date nothing produced: ${invented.join(', ')}`);
      const missingNamed = required.filter((d) => !named.includes(d));
      if (e.requireWeekday && named.length && !/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i.test(text)) flags.push('names a date with no weekday (doctrine rule 4)');
      if (missingNamed.length && e.answer?.kind === 'date') flags.push(`never states the answer date ${missingNamed.join(', ')}`);
      const hard = mism.length > 0 || invented.length > 0 || (missingNamed.length > 0 && e.answer?.kind === 'date');
      speak = { verdict: hard ? 'fail' : 'pass', reason: hard ? 'model' : undefined, flags };
    }
  }

  // ── PHASE 4: GUARD ──
  // Replay is always computed (it is the detector's logic under our control).
  // When the run delivered, the REAL hook's flags are authoritative and any
  // disagreement between the two is itself reported.
  const replayFlags = (() => { try { return scanMessage(text, firmLocalParts(TZ, new Date(`${TODAY}T12:00:00Z`))); } catch { return []; } })();
  const liveRecords = Array.isArray(r.guardLive) ? r.guardLive : null;
  const liveFlags = liveRecords ? liveRecords.flatMap((g) => g.flags ?? []) : null;
  // The hook not firing at all is NOT "no flags" — it means phase 4 was never
  // observed for this question, and must never be scored as a clean pass.
  const liveObserved = liveRecords !== null && liveRecords.length > 0;
  const guardFlags = liveObserved ? liveFlags : replayFlags;

  const guard = mism.length === 0
    ? (guardFlags.length ? { verdict: 'false-positive', flags: guardFlags } : { verdict: 'n/a', flags: [] })
    : (guardFlags.length ? { verdict: 'caught', flags: guardFlags } : { verdict: 'missed', flags: [], detail: mism });
  guard.source = liveObserved ? 'live-hook' : liveRecords ? 'live-hook-SILENT' : 'replay';
  if (liveRecords && !liveObserved) {
    // Delivered, but no hook record came back: the wiring, not the detector.
    guard.verdict = 'not-observed';
    guard.detail = 'run delivered but the guard hook wrote nothing for this question';
  }
  if (liveObserved) {
    const norm = (fs) => JSON.stringify([...fs].sort());
    if (norm(liveFlags) !== norm(replayFlags)) {
      guard.disagreement = { live: liveFlags, replay: replayFlags };
    }
  }

  // ── outcome: is the ANSWER right? ──
  let outcome = { verdict: 'needs-adjudication', why: '' };
  const kind = e.answer?.kind;
  if (kind === 'count') {
    const want = e.answer.value;
    const nums = numsIn(text);
    const alt = (e.altAnswers ?? []).some((a) => nums.has(a));
    outcome = nums.has(want) ? { verdict: 'correct', why: `${want} present` }
      : alt ? { verdict: 'needs-adjudication', why: `expected ${want}; an accepted alternative reading is present instead` }
        : { verdict: 'wrong', why: `expected ${want}; text has ${[...nums].slice(0, 8).join(', ') || 'no number'}` };
  } else if (kind === 'date') {
    const ok = required.every((d) => named.includes(d));
    outcome = ok ? { verdict: 'correct', why: 'date stated' } : { verdict: 'wrong', why: `expected ${required.join(', ')}; named ${named.join(', ') || 'none'}` };
  } else if (kind === 'first-job') {
    // Correct = names the right customer AND the right wall-clock time.
    // Accept 08:00 / 8:00 / 8 AM shapes; a different customer or a different
    // time is wrong (naming the second job of the day is the failure mode).
    const cust = (e.answer.customer ?? '').toLowerCase();
    const [hh, mm] = String(e.answer.time ?? '').split(':');
    const h12 = String(((Number(hh) + 11) % 12) + 1);
    const timeRe = new RegExp(`\\b(?:0?${Number(hh)}|${h12}):${mm}\\b|\\b${h12}\\s*(?:am|pm)\\b`, 'i');
    const custOk = cust && text.toLowerCase().includes(cust);
    const timeOk = timeRe.test(text);
    outcome = custOk && timeOk
      ? { verdict: 'correct', why: 'customer + time stated' }
      : custOk || timeOk
        ? { verdict: 'needs-adjudication', why: `half-match: customer=${custOk} time=${timeOk} (want ${e.answer.customer} at ${e.answer.time})` }
        : { verdict: 'wrong', why: `expected ${e.answer.customer} at ${e.answer.time}` };
  } else if (kind === 'empty-day') {
    // A day with zero TIMED visits (corpus D21). Two honest answers — say
    // nothing is scheduled, or name an overlapping window/time-TBD visit —
    // and one failure: inventing a timed visit. The old count-0 grading
    // marked honesty wrong on the digits inside an address (08-13 run).
    const saysEmpty = /\b(nothing|no visits?|none|clear|free|empty|wide open)\b/i.test(text);
    const namesWindow = /\b(tbd|time not set|not set yet|window|may (?:land|shift|move)|flexible)\b/i.test(text);
    const claimsTime = /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i.test(text);
    outcome = saysEmpty || (namesWindow && !claimsTime)
      ? { verdict: 'correct', why: saysEmpty ? 'empty day stated' : 'window visit relayed, no invented time' }
      : claimsTime
        ? { verdict: 'wrong', why: 'named a clock time on a day with zero timed visits' }
        : { verdict: 'needs-adjudication', why: `empty day: neither an empty statement nor a window mention detected${e.note ? ` — ${e.note}` : ''}` };
  } else if (kind === 'ambiguity') {
    const both = required.every((d) => named.includes(d));
    const asks = /\?|which one|which of|did you mean|do you mean/i.test(text);
    outcome = both && asks ? { verdict: 'correct', why: 'both readings offered and asked' }
      : { verdict: 'needs-adjudication', why: `must offer both ${required.join(' / ')} and ask; named ${named.join(', ') || 'none'}, asks=${asks}` };
  } else if (kind === 'flag') {
    const corrected = required.some((d) => named.includes(d) && new RegExp(titleWeekday(d), 'i').test(text));
    // "Nope — August 20th is a Thursday, not a Sunday" objects without any of
    // the original verb forms; the 2026-08-15 run sent it to adjudication.
    const objects = /isn'?t|is not|actually|correction|mismatch|doesn'?t match|to confirm|did you mean|\bnot an? \b|\bnope\b|\bno[,—-]/i.test(text);
    outcome = corrected && objects ? { verdict: 'correct', why: 'mismatch flagged and corrected' }
      : { verdict: 'needs-adjudication', why: `must flag the bad weekday↔date pair. ${e.note ?? ''}` };
  } else if (kind === 'weekday') {
    // P18/P19: the answer is a weekday word. ownMismatches separately guards a
    // wrong weekday-date pairing, so presence of the expected word is the test.
    const want = String(e.answer.value);
    outcome = new RegExp(`\\b${want}\\b`, 'i').test(text)
      ? { verdict: 'correct', why: `${want} stated` }
      : { verdict: 'wrong', why: `expected ${want}; not stated` };
  } else if (kind === 'confirm') {
    // T10: a yes/no sanity check — affirm AND restate the date.
    const yes = /\b(yes|yep|yeah|correct|right|exactly|indeed|it is|you(?:'re| are) (?:right|all there))\b/i.test(text);
    const dateOk = required.every((d) => named.includes(d));
    outcome = yes && dateOk
      ? { verdict: 'correct', why: 'affirmed with the date restated' }
      : { verdict: 'wrong', why: `expected an affirmation naming ${required.join(', ')}; affirmed=${yes} dateNamed=${dateOk}` };
  } else if (kind === 'day-count') {
    // W11-class: one specific day plus its visit count.
    const dateOk = named.includes(e.answer.date);
    const countOk = numsIn(text).has(e.answer.count);
    outcome = dateOk && countOk
      ? { verdict: 'correct', why: `${e.answer.date} with ${e.answer.count} present` }
      : { verdict: 'wrong', why: `expected ${e.answer.date} (${e.answer.count}); dateNamed=${dateOk} countPresent=${countOk}` };
  } else if (kind === 'pair-count') {
    // W13/T08-class comparisons: every listed count must appear (zero accepts
    // its word forms via numsIn). Winner wording is the model's own judgment
    // once both numbers are right; a wrong pairing shows up in the numbers.
    const nums = numsIn(text);
    const missing = e.answer.counts.filter((c) => !nums.has(c));
    outcome = missing.length === 0
      ? { verdict: 'correct', why: `counts ${e.answer.counts.join(' & ')} all present` }
      : { verdict: 'wrong', why: `missing count(s) ${missing.join(', ')} of ${e.answer.counts.join(' & ')}` };
  } else if (kind === 'period-compare') {
    // M06: both month words, the other month's count, and the current-month
    // bucket — full total outright, or through-today total with a bucket label
    // (the recorded 2026-08-13 adjudication rule).
    const nums = numsIn(text);
    const monthsOk = e.answer.months.every((w) => new RegExp(`\\b${w}\\b`, 'i').test(text));
    const bucketOk = nums.has(e.answer.full) || (nums.has(e.answer.through) && PERIOD_MARKER_RE.test(text));
    const otherOk = nums.has(e.answer.otherCount);
    outcome = monthsOk && bucketOk && otherOk
      ? { verdict: 'correct', why: 'both months with acceptable buckets' }
      : { verdict: 'wrong', why: `months=${monthsOk} currentBucket=${bucketOk} otherCount(${e.answer.otherCount})=${otherOk}` };
  } else if (kind === 'month-breakdown') {
    // M09: each prior month's count on a line naming that month; the current
    // month by either bucket (labeled if through-today — same recorded rule).
    const lines = text.split('\n');
    const badRows = e.answer.priorMonths.filter(
      (pm) => !lines.some((ln) => new RegExp(`\\b(${pm.word}|${pm.abbr})\\b`, 'i').test(ln) && new RegExp(`\\b${pm.n}\\b`).test(ln)),
    );
    const nums = numsIn(text);
    const bucketOk = nums.has(e.answer.current.full) || (nums.has(e.answer.current.through) && PERIOD_MARKER_RE.test(text));
    outcome = badRows.length === 0 && bucketOk
      ? { verdict: 'correct', why: 'every month bucket accounted for' }
      : { verdict: 'wrong', why: `${badRows.length ? `missing month rows: ${badRows.map((b) => b.word).join(', ')}. ` : ''}currentBucket=${bucketOk}` };
  } else if (kind === 'month-label') {
    // M10: the right month named, with either bucket's total.
    const nums = numsIn(text);
    const monthOk = new RegExp(`\\b${e.answer.monthWord}\\b`, 'i').test(text);
    const bucketOk = nums.has(e.answer.full) || nums.has(e.answer.through);
    outcome = monthOk && bucketOk
      ? { verdict: 'correct', why: `${e.answer.monthWord} with a real bucket total` }
      : { verdict: 'wrong', why: `month=${monthOk} bucket(${e.answer.full}|${e.answer.through})=${bucketOk}` };
  } else if (kind === 'earliest') {
    // M11: the earliest-visit date must be named; richer per-record-type
    // breakdowns are welcome as long as that date appears.
    outcome = named.includes(e.answer.date)
      ? { verdict: 'correct', why: `earliest ${e.answer.date} named` }
      : { verdict: 'wrong', why: `expected earliest visit ${e.answer.date}; named ${named.join(', ') || 'none'}` };
  } else if (kind === 'set') {
    // D17/D18/W10: a set answer. Elements carrying an ISO date need that date
    // named (plus its count when present); name elements match on any word
    // part of the ref, so "manager-joy (5)" accepts "Joy". A TIE note relaxes
    // day-phrase sets to any-one-member plus a stated tie.
    const nums = numsIn(text);
    const memberOk = (el) => {
      const iso = el.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      if (iso) {
        const cnt = Number(el.match(/\((\d+)\)/)?.[1]);
        if (named.includes(iso) && (!Number.isFinite(cnt) || nums.has(cnt))) return true;
        // Day-list shorthand: "Wed — 16 visits" under an ISO week header
        // (v3's W10 — correct content, no per-day date). Accept the weekday
        // word on one line with the count, ANCHORED by some named date within
        // 6 days of the expected one — the week header supplies that anchor,
        // and a right-count-wrong-week reply would still need a date that
        // close to slip through.
        if (!Number.isFinite(cnt)) return false;
        const wd = el.match(/^([A-Za-z]+)/)?.[1]?.toLowerCase();
        if (!wd) return false;
        const wdRe = new RegExp(`\\b${wd.slice(0, 3)}(?:${wd.slice(3)})?\\b`, 'i');
        const lineOk = text.split('\n').some((ln) => wdRe.test(ln) && new RegExp(`\\b${cnt}\\b`).test(ln));
        const t0 = Date.parse(`${iso}T00:00:00Z`);
        const anchored = named.some((d) => Math.abs(Date.parse(`${d}T00:00:00Z`) - t0) <= 6 * 86_400_000);
        return lineOk && anchored;
      }
      const parts = el.replace(/\s*\(\d+\)\s*$/, '').toLowerCase().split(/[-_\s]+/).filter(Boolean);
      return parts.some((pt) => new RegExp(`\\b${pt}\\b`, 'i').test(text));
    };
    const els = e.answer.value;
    if (/TIE/.test(e.note ?? '') && els.length > 1) {
      outcome = els.some(memberOk) && /\b(tie|tied|both|equal)\b/i.test(text)
        ? { verdict: 'correct', why: 'tie stated with a tied member' }
        : { verdict: 'needs-adjudication', why: `tie case: ${e.note}` };
    } else {
      const misses = els.filter((el) => !memberOk(el));
      outcome = misses.length === 0
        ? { verdict: 'correct', why: 'every set member present' }
        : { verdict: 'wrong', why: `missing: ${misses.join('; ')}` };
    }
  } else {
    outcome = { verdict: 'needs-adjudication', why: `expected: ${JSON.stringify(e.answer?.value ?? e.answer)}${e.note ? ` — ${e.note}` : ''}` };
  }

  const failingPhase = resolve.verdict === 'fail' ? 'resolve' : use.verdict === 'fail' ? 'use' : speak.verdict === 'fail' ? 'speak' : null;
  rows.push({
    id: r.id, cat: r.cat, q: r.q, reply: text, wallMs: r.wallMs, phases: spec.phases,
    resolve, use, speak, guard, outcome, failingPhase,
    resolveCalls, dataCalls, writeCalls, mismatches: mism,
    lat, trajMs: traj ? traj.lastTs - traj.firstUserTs : null, models: traj?.models ?? [], tokens: traj?.tokens ?? null,
    truncated: r.agentsMdTruncated,
  });
}

// ─────────────────────────────────────────────────────────── report ──
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(0)}%` : '—');
const L = [];
L.push(`# Date-machinery eval — ${manifest.today} (${titleWeekday(manifest.today)})\n`);
if (abort) L.push(`> **RUN ABORTED — fleet failed over** from \`${abort.was.model}\` to \`${abort.now.model}\` after ${abort.afterQuestion}. Only questions before that point are reported.\n`);
const models = [...new Set(rows.flatMap((r) => r.models))];
L.push(`**Model:** ${models.join(', ') || 'unknown'} · **Questions:** ${rows.length} · **Tenant:** ${manifest.tenant}`);
if (rows.some((r) => r.truncated)) L.push(`\n> ⚠ The embedded agent reported truncating AGENTS.md — the date doctrine may not have been in context. This measures a weaker prompt than production Telegram.`);

const correct = rows.filter((r) => r.outcome.verdict === 'correct').length;
const wrong = rows.filter((r) => r.outcome.verdict === 'wrong').length;
const adj = rows.filter((r) => r.outcome.verdict === 'needs-adjudication').length;
L.push(`\n## End result\n`);
L.push(`| | n | share |`);
L.push(`|---|---|---|`);
L.push(`| Correct (auto-verified) | ${correct} | ${pct(correct, rows.length)} |`);
L.push(`| Wrong (auto-verified) | ${wrong} | ${pct(wrong, rows.length)} |`);
L.push(`| Needs adjudication | ${adj} | ${pct(adj, rows.length)} |`);

L.push(`\n## Where it fails, by phase\n`);
L.push(`Earliest failing phase only — a wrong date at RESOLVE is not also counted as a SPEAK failure.\n`);
L.push(`| Phase | Exercised | Passed | Failed | Rate |`);
L.push(`|---|---|---|---|---|`);
for (const p of ['resolve', 'use', 'speak']) {
  const ex = rows.filter((r) => r.phases.includes(p) && r[p].verdict !== 'inherited' && r[p].verdict !== 'n/a');
  const f = ex.filter((r) => r[p].verdict === 'fail');
  L.push(`| ${p} | ${ex.length} | ${ex.length - f.length} | ${f.length} | ${pct(ex.length - f.length, ex.length)} |`);
}
const mach = rows.filter((r) => r.resolve.reason === 'machinery');
const modelR = rows.filter((r) => r.failingPhase === 'resolve' && r.resolve.reason === 'model');
const bypass = rows.filter((r) => r.resolve.flags?.some((f) => f.includes('BYPASSED')));
L.push(`\n- **resolve → machinery** (tool asked correctly, answered wrongly): **${mach.length}** ${mach.length ? '← the date code itself is wrong' : ''}`);
L.push(`- **resolve → model** (asked the tool for the wrong day, or nobody): **${modelR.length}**`);
L.push(`- **bypassed resolve_date entirely** (date computed in-model, right or wrong): **${bypass.length}** of ${rows.filter((r) => r.phases.includes('resolve')).length}`);

// Period boundaries — the coverage gap, reported on its own because it is not
// the model's fault and is not fixed by prompting.
const periodRows = rows.filter((r) => byId[r.id]?.expect?.periodBoundary);
if (periodRows.length) {
  const handMade = periodRows.filter((r) => r.use.boundaryGap);
  const noResolve = periodRows.filter((r) => r.resolveCalls.length === 0);
  L.push(`\n## Period boundaries (month / quarter / year)\n`);
  L.push(`\`resolve_date\` has no mode for these periods, so every boundary below was worked out by the model itself — the one act the doctrine forbids. Right answers here are luck, not safety.\n`);
  L.push(`- questions needing a calendar-period boundary: **${periodRows.length}**`);
  L.push(`- boundaries written by hand into tool args: **${handMade.length}**`);
  L.push(`- of those, asked with NO resolve_date call at all: **${noResolve.length}**`);
  if (handMade.length) {
    L.push(`\n| Question | hand-written dates | answer |`);
    L.push(`|---|---|---|`);
    for (const r of handMade) L.push(`| ${r.id} — ${r.q.slice(0, 46)} | \`${(r.use.handWritten ?? []).join('`, `')}\` | ${r.outcome.verdict} |`);
  }
}

const gCaught = rows.filter((r) => r.guard.verdict === 'caught').length;
const gMissed = rows.filter((r) => r.guard.verdict === 'missed').length;
const gFP = rows.filter((r) => r.guard.verdict === 'false-positive').length;
const gLive = rows.filter((r) => r.guard.source === 'live-hook').length;
const gSilent = rows.filter((r) => r.guard.source === 'live-hook-SILENT').length;
const gDisagree = rows.filter((r) => r.guard.disagreement);
L.push(`\n## Guard\n`);
if (gLive || gSilent) {
  L.push(`**OBSERVED, not replayed** — the run used \`--deliver\`, so the real \`message_sending\` hook ran inside the sandbox. ${gLive}/${rows.length} questions produced a hook record.\n`);
  if (gSilent) {
    L.push(`> ⚠ **${gSilent} question(s) delivered but the hook wrote NOTHING** — phase 4 was not observed for those, and they are scored \`not-observed\`, never as a pass. That is a WIRING symptom (plugin not loaded, delivery failing before the hook, log not writable), not a detector one.\n`);
  }
} else {
  L.push(`Replayed offline over every reply — this measures the detector's logic, not that the hook is wired up. Re-run with \`--deliver\` to observe the real hook.\n`);
}
L.push(`- weekday↔date contradictions that reached the text: **${gCaught + gMissed}**`);
L.push(`- guard caught: **${gCaught}** · missed: **${gMissed}** · false positives: **${gFP}**`);
if (gDisagree.length) {
  L.push(`\n> ⚠ **REPLAY vs LIVE DISAGREEMENT on ${gDisagree.length} question(s).** The deployed plugin and this repo's copy do not agree on the same text. Either the box is running a different build, or the hook sees different text than we graded. Resolve before trusting either number.\n`);
  L.push(`| id | live flags | replay flags |`);
  L.push(`|---|---|---|`);
  for (const r of gDisagree.slice(0, 10)) {
    L.push(`| ${r.id} | \`${(r.guard.disagreement.live ?? []).join('`, `') || '—'}\` | \`${(r.guard.disagreement.replay ?? []).join('`, `') || '—'}\` |`);
  }
}

L.push(`\n## Latency, by phase\n`);
const med = (xs) => (xs.length ? xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);
const medTraj = med(rows.map((r) => r.trajMs).filter(Boolean));
// Each phase is timed only over the questions that actually run it, and its
// share is taken per-question before the median. Averaging a phase's absolute
// time against a whole-corpus median would compare a segment measured on one
// subset with a total measured on another, and the columns would not add up.
L.push(`| Segment | questions timed | median | median share of its own turn |`);
L.push(`|---|---|---|---|`);
for (const k of ['resolve', 'use', 'speak', 'other']) {
  const ran = rows.filter((r) => r.lat[k] > 0 && r.trajMs);
  const share = med(ran.map((r) => (r.lat[k] / r.trajMs) * 100));
  L.push(`| ${k} | ${ran.length} | ${(med(ran.map((r) => r.lat[k])) / 1000).toFixed(1)}s | ${ran.length ? `${share.toFixed(0)}%` : '—'} |`);
}
L.push(`| **agent turn (total)** | ${rows.filter((r) => r.trajMs).length} | **${(medTraj / 1000).toFixed(1)}s** | 100% |`);
L.push(`| CLI boot + ssh overhead | ${rows.length} | ${((med(rows.map((r) => r.wallMs)) - medTraj) / 1000).toFixed(1)}s | — |`);
// The only apples-to-apples split: questions that run every phase.
const full = rows.filter((r) => r.lat.resolve > 0 && r.lat.use > 0 && r.lat.speak > 0 && r.trajMs);
if (full.length) {
  const s = (k) => `${(med(full.map((r) => r.lat[k])) / 1000).toFixed(1)}s (${((med(full.map((r) => r.lat[k])) / med(full.map((r) => r.trajMs))) * 100).toFixed(0)}%)`;
  L.push(`\n**Full-pipeline questions only** (${full.length} that resolve, query, and answer): resolve ${s('resolve')} · use ${s('use')} · speak ${s('speak')} · turn ${(med(full.map((r) => r.trajMs)) / 1000).toFixed(1)}s`);
}
L.push(`\nResolve = model deciding to call resolve_date + the call itself. Use = composing and running the data query. Speak = generating the final prose after the last tool result. Shares are per-question medians, so the column does not sum to 100% — not every question runs every phase.`);

const fails = rows.filter((r) => r.failingPhase || r.outcome.verdict === 'wrong');
if (fails.length) {
  L.push(`\n## Failures\n`);
  for (const r of fails) {
    L.push(`### ${r.id} — ${r.failingPhase ? `${r.failingPhase.toUpperCase()} (${r[r.failingPhase].reason ?? ''})` : 'answer wrong'}`);
    L.push(`> ${r.q}\n`);
    L.push(`- **why:** ${r.outcome.why}`);
    for (const p of ['resolve', 'use', 'speak']) for (const f of r[p].flags ?? []) L.push(`- ${p}: ${f}`);
    if (r.resolveCalls.length) L.push(`- resolve_date calls: ${r.resolveCalls.map((c) => `\`${JSON.stringify(c.args)}\` → ${c.returned}`).join('; ')}`);
    if (r.dataCalls.length) L.push(`- data calls: ${r.dataCalls.map((c) => `\`${c.name}(${c.dates.join(',') || '—'})\``).join('; ')}`);
    L.push(`- reply: ${r.reply.slice(0, 300).replaceAll('\n', ' ')}\n`);
  }
}

const needing = rows.filter((r) => r.outcome.verdict === 'needs-adjudication');
if (needing.length) {
  L.push(`\n## Needs adjudication (${needing.length})\n`);
  L.push(`Deterministic checks can't settle these — judge the reply against the expectation.\n`);
  for (const r of needing) {
    L.push(`- **${r.id}** — ${r.q}`);
    L.push(`  - expected: ${r.outcome.why}`);
    L.push(`  - got: ${r.reply.slice(0, 240).replaceAll('\n', ' ')}`);
  }
}
if (rows.some((r) => r.writeCalls.length)) {
  L.push(`\n## ⚠ Write tools called during a read-only eval\n`);
  for (const r of rows.filter((x) => x.writeCalls.length)) L.push(`- ${r.id}: ${r.writeCalls.map((w) => w.name).join(', ')}`);
}

const out = join(DIR, 'report.md');
writeFileSync(out, L.join('\n'));
writeFileSync(join(DIR, 'rows.json'), JSON.stringify(rows, null, 2));
console.log(L.join('\n'));
console.log(`\n\nreport → ${out}\nrows   → ${join(DIR, 'rows.json')}`);
