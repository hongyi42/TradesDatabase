/**
 * trades-weekday-guard — flags fabricated weekdays in outbound messages.
 *
 * WHY THIS EXISTS
 * The agent keeps pairing a weekday with a date that isn't that weekday:
 * "Monday the 4th" for a Tuesday (live, 2026-08-06), "today, Thursday
 * 2026-08-09" for a Sunday (live, same day, AFTER the resolve_date phrase fix).
 * Five upstream fixes in three days all took the same shape — help the model
 * get it right — and each one moved the failure instead of stopping it. This
 * plugin is the other direction: let it be wrong, and CATCH it. Design:
 * thoughts/shared/plans/2026-08-06-weekday-guard-plugin.md.
 *
 * DETECT-ONLY, BY DECISION. The handler never rewrites and never cancels —
 * given "today, Thursday 2026-08-09" the wrong half is ambiguous (the agent
 * meant TODAY, so "fixing" the weekday to Sunday would assert today is
 * Sunday). Phase 1 logs; the measured rate decides whether a phase 2
 * (cancel-and-retry) is worth a round-trip. Cost: 0 tokens, ~0.04 ms/message.
 *
 * FAIL-OPEN, ALWAYS. A detector must never break delivery: every path is
 * wrapped, every error swallowed to stderr, and the handler always returns
 * undefined (= "no changes" per the message_sending contract).
 *
 * WHAT COUNTS AS A CLAIM. chrono marks each date component as stated-in-text
 * (`isCertain`) or inferred. We flag ONLY when the text states BOTH a weekday
 * and a day-of-month and they disagree. A bare "Friday" or a bare date states
 * no pair — nothing to contradict, no flag. This is what keeps false
 * positives at zero on real traffic (corpus replay in the PR).
 */
import fs from 'node:fs';
import { parse } from './chrono.bundle.mjs';

export const VERSION = '0.1.0';

const NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// "Monday the 4th" — chrono deliberately ignores month-less ordinals, and that
// is verbatim live failure #1. Expand to "Monday August 4, 2026" (nearest
// month; year explicit so the check is strict) before parsing. The lookahead
// leaves "the 4th of August" alone — chrono parses those itself.
const ORDINAL =
  /\b(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sun|Mon|Tues|Tue|Weds|Wed|Thurs|Thur|Thu|Fri|Sat)\.?,?\s+the\s+(\d{1,2})(?:st|nd|rd|th)\b(?!\s+of\s+[A-Z])/g;

const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12));
const isRealDay = (y, m, d) => utc(y, m, d).getUTCDate() === d;

/** Expand month-less ordinals against a {y, m, d} reference (firm-local today). */
export function expandOrdinals(text, ref) {
  return text.replace(ORDINAL, (whole, dayWord, dayNum) => {
    const d = Number(dayNum);
    let best = null;
    // The month the speaker meant is the one that puts the day nearest today —
    // "the 2nd" said on Aug 30 means September. Date.UTC rolls over year
    // boundaries for us (month 12 = next January).
    for (const delta of [-1, 0, 1]) {
      const probe = utc(ref.y, ref.m + delta, d);
      if (probe.getUTCDate() !== d) continue; // the 31st of a 30-day month
      const dist = Math.abs(probe - utc(ref.y, ref.m, ref.d));
      if (!best || dist < best.dist) best = { dist, probe };
    }
    if (!best) return whole;
    return `${dayWord} ${MONTHS[best.probe.getUTCMonth()]} ${d}, ${best.probe.getUTCFullYear()}`;
  });
}

// When the text stated the day but not the year (or month), the speaker meant
// the occurrence nearest today — "Monday January 4" said in December means
// NEXT January, and flagging it against THIS January's weekday would be a
// false positive. Resolve implied parts to the nearest real date first;
// stated parts are never widened, so same-month errors still flag strictly.
function resolveNearest(c, ref) {
  const d = c.get('day');
  const years = c.isCertain('year') ? [c.get('year')] : [c.get('year') - 1, c.get('year'), c.get('year') + 1];
  const months = c.isCertain('month') ? [c.get('month')] : [c.get('month') - 1, c.get('month'), c.get('month') + 1];
  let best = null;
  for (const y of years) {
    for (const m of months) {
      if (!isRealDay(y, m, d)) continue;
      const dist = Math.abs(utc(y, m, d) - utc(ref.y, ref.m, ref.d));
      if (!best || dist < best.dist) best = { dist, y, m, d };
    }
  }
  return best;
}

/**
 * Scan one outbound message. Returns [] for anything that states no
 * (weekday, date) pair — including non-string input, which is not an error.
 */
export function scanMessage(text, ref) {
  if (typeof text !== 'string' || text.length === 0) return [];
  const flags = [];
  const expanded = expandOrdinals(text, ref);
  for (const r of parse(expanded, utc(ref.y, ref.m, ref.d))) {
    for (const c of [r.start, r.end]) {
      if (!c) continue;
      if (!c.isCertain('weekday') || !c.isCertain('day')) continue;
      const resolved = resolveNearest(c, ref);
      if (!resolved) continue;
      const claimedIdx = c.get('weekday');
      const actualIdx = utc(resolved.y, resolved.m, resolved.d).getUTCDay();
      if (claimedIdx === actualIdx) continue;
      const date = `${resolved.y}-${String(resolved.m).padStart(2, '0')}-${String(resolved.d).padStart(2, '0')}`;
      flags.push({
        said: r.text,
        claimed: NAMES[claimedIdx],
        actually: NAMES[actualIdx],
        date,
        // ±40 chars of the EXPANDED text — enough to find the sentence in the
        // transcript without logging the whole message twice.
        context: expanded.slice(Math.max(0, r.index - 40), r.index + r.text.length + 40),
      });
    }
  }
  return flags;
}

/** Firm-local {y, m, d}. The container clock is UTC, which names TOMORROW from
 *  5pm Pacific onward — the exact trap this fleet has already been bitten by. */
export function firmLocalParts(tz, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now); // en-CA renders YYYY-MM-DD
  const [y, m, d] = parts.split('-').map(Number);
  return { y, m, d };
}

const MAX_LOG_BYTES = 5 * 1024 * 1024;

function appendLog(logPath, record) {
  try {
    try {
      if (fs.statSync(logPath).size > MAX_LOG_BYTES) fs.renameSync(logPath, `${logPath}.1`);
    } catch { /* no log yet */ }
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch (err) {
    // A missing log line is acceptable; a broken reply is not.
    console.error(`[weekday-guard] log write failed: ${err?.message ?? err}`);
  }
}

/**
 * OpenClaw plugin entry. Same plain `register(api)` shape as the (removed)
 * trades-cron plugin, which ran on this exact stack version. Env overrides
 * exist for the tests, not for operators:
 *   TRADES_WEEKDAY_GUARD_TZ   firm timezone (default America/Los_Angeles)
 *   TRADES_WEEKDAY_GUARD_LOG  log path (default /sandbox/.openclaw/logs/…)
 */
export default function register(api) {
  if (typeof api?.on !== 'function') {
    // Older/newer plugin API without hooks: refuse loudly but harmlessly.
    console.error('[weekday-guard] api.on unavailable — hook not registered, bot unaffected');
    return;
  }
  api.on('message_sending', (event) => {
    try {
      const text = typeof event?.content === 'string' ? event.content : null;
      if (text === null) return undefined; // media-only or structured payload
      const tz = process.env.TRADES_WEEKDAY_GUARD_TZ || 'America/Los_Angeles';
      const logPath =
        process.env.TRADES_WEEKDAY_GUARD_LOG || '/sandbox/.openclaw/logs/weekday-guard.jsonl';
      const flags = scanMessage(text, firmLocalParts(tz));
      // One line per scanned message, flagged or not — the CLEAN lines are the
      // denominator that turns "I found three by hand" into a rate.
      appendLog(logPath, {
        ts: new Date().toISOString(),
        v: VERSION,
        channel: event?.channel,
        chars: text.length,
        flags,
      });
    } catch (err) {
      console.error(`[weekday-guard] scan failed: ${err?.message ?? err}`);
    }
    return undefined; // observe only — never rewrite, never cancel
  });
}
