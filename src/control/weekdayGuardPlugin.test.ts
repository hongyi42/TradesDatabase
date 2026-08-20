import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

// Locks in Box_Setup_Stuff/plugins/trades-weekday-guard/index.js — the outbound
// weekday/date consistency detector (plan:
// thoughts/shared/plans/2026-08-06-weekday-guard-plugin.md).
//
// The FAIL cases are verbatim from live s2 trajectories on 2026-08-06; the OK
// bank is the vocabulary this fleet actually emits (resolve_date phrases,
// availability summaries, schedule lists). Two properties are load-bearing:
//  1. Both live failures flag. A detector that misses the incidents that
//     justified it is decoration.
//  2. The innocent bank stays silent. Detect-only still poisons the measured
//     rate if false positives creep in — and phase 2 (cancel-and-retry) would
//     turn a false positive into a broken reply.
//
// Loaded via a runtime path (not a static import) because tsconfig pins rootDir
// to src/ — the same pattern as the old tradesCronPlugin.test.ts.
const PLUGIN = join(
  process.cwd(),
  'Box_Setup_Stuff',
  'plugins',
  'trades-weekday-guard',
  'index.js',
);

interface Flag {
  said: string;
  claimed: string;
  actually: string;
  date: string;
  context: string;
  corrected?: boolean;
}
interface LinkFlag {
  url: string;
  host: string;
  context: string;
}
interface GuardModule {
  VERSION: string;
  scanMessage: (text: unknown, ref: { y: number; m: number; d: number }) => Flag[];
  scanLinks: (text: unknown, allowed?: Set<string>) => LinkFlag[];
  allowedLinkHosts: (env?: Record<string, string | undefined>) => Set<string>;
  expandOrdinals: (text: string, ref: { y: number; m: number; d: number }) => string;
  firmLocalParts: (tz: string, now?: Date) => { y: number; m: number; d: number };
  default: (api: unknown) => void;
}

let guard: GuardModule;
beforeAll(async () => {
  guard = (await import(pathToFileURL(PLUGIN).href)) as unknown as GuardModule;
});

// Thursday 2026-08-06, the firm-local day both live failures happened on.
const REF = { y: 2026, m: 8, d: 6 };

describe('weekday guard — the live failures must flag', () => {
  test('live failure #1: "Monday the 4th through Saturday the 8th" (Aug 4 is a Tuesday)', () => {
    const flags = guard.scanMessage(
      'running from Monday the 4th through Saturday the 8th',
      REF,
    );
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0].claimed).toBe('Monday');
    expect(flags[0].actually).toBe('Tuesday');
    expect(flags[0].date).toBe('2026-08-04');
  });

  test('live failure #3: today\'s weekday fused onto the week-end date', () => {
    const flags = guard.scanMessage(
      'Joy has **22 visits** so far this week (Monday 2026-08-03 through today, Thursday 2026-08-09).',
      REF,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({
      claimed: 'Thursday',
      actually: 'Sunday',
      date: '2026-08-09',
    });
  });

  test('ordinal variant and abbreviation both flag', () => {
    expect(guard.scanMessage('I moved it to Monday the 4th.', REF)).toHaveLength(1);
    expect(guard.scanMessage('I moved it to Mon the 4th.', REF)).toHaveLength(1);
  });

  test('a wrong END of a range flags even when the start is right', () => {
    const flags = guard.scanMessage(
      'Monday 2026-08-03 through Saturday 2026-08-09',
      REF,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].claimed).toBe('Saturday');
    expect(flags[0].actually).toBe('Sunday');
  });

  test('US numeric form flags when wrong, stays silent when right', () => {
    expect(guard.scanMessage('booked for Monday 8/4', REF)).toHaveLength(1);
    expect(guard.scanMessage('booked for Tuesday 8/4', REF)).toEqual([]);
  });
});

describe('weekday guard v0.3.0 — the 2026-08-12 eval findings', () => {
  // Both texts verbatim from date-eval-runs (94 adversarial questions through
  // the real agent). The eval's hand-verification found exactly one missed
  // fabrication (D17, parenthesized date) and one act-mode false-fire (T02, a
  // wrong pair quoted inside a CORRECT correction). Wednesday 2026-08-12 is
  // the day the eval ran; Aug 16, 2026 is a SUNDAY.
  const EVAL_REF = { y: 2026, m: 8, d: 12 };

  test('THE eval miss (D17): "Saturday (August 16th)" flags despite the parentheses', () => {
    const flags = guard.scanMessage(
      'This\nSaturday (August 16th) — **Joy** and **Yutao** are working:\n\n' +
        '- **Joy** — 09:00–17:00\n- **Yutao** — 08:00–16:00\n\nHman and Sam are off Saturdays.',
      EVAL_REF,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ claimed: 'Saturday', actually: 'Sunday', date: '2026-08-16' });
    expect(flags[0].corrected).toBeUndefined();
  });

  test('paren variants flag when wrong, stay silent when right', () => {
    expect(guard.scanMessage('Crew works Saturday (Aug 16).', EVAL_REF)).toHaveLength(1);
    expect(guard.scanMessage('Crew works Saturday (the 16th).', EVAL_REF)).toHaveLength(1);
    expect(guard.scanMessage('Crew works Sat (16th of August).', EVAL_REF)).toHaveLength(1);
    // The correct pair in the same shapes must not fire.
    expect(guard.scanMessage('See you Sunday (August 16th)!', EVAL_REF)).toEqual([]);
    expect(guard.scanMessage('See you Sunday (the 16th)!', EVAL_REF)).toEqual([]);
  });

  test('non-date parentheses stay untouched — no unwrap, no flag', () => {
    expect(guard.scanMessage('Monday (my birthday) works for me.', EVAL_REF)).toEqual([]);
    // Bare digits are counts far more often than dates — deliberately NOT
    // unwrapped, even though "Friday (16)" the-date is the price.
    expect(guard.scanMessage('Busiest days: Friday (2) and Monday (4).', EVAL_REF)).toEqual([]);
  });

  test('THE act-mode false-fire (T02): a quoted wrong pair inside a correction is marked corrected', () => {
    const flags = guard.scanMessage(
      'No — **August 20 is a Thursday**, not a Friday. Friday would be **August 21**.\n\n' +
        'I checked the schedule for August 20 (Thursday) and there are 12 visits booked that day. ' +
        'If we said "Friday August 20," that\'s a mistake — the 20th is Thursday. We either meant ' +
        '**Thursday the 20th** or **Friday the 21st**.',
      EVAL_REF,
    );
    // The wrong pair IS still logged (telemetry) …
    expect(flags.length).toBeGreaterThan(0);
    // … but every flag carries corrected:true, so phase-2 act-mode skips it.
    for (const f of flags) {
      expect(f.date).toBe('2026-08-20');
      expect(f.corrected).toBe(true);
    }
  });

  test('corrected only applies to the SAME date — a real fabrication beside a correct pair still acts', () => {
    // Aug 17 = Monday (correct pair); Aug 16 claimed Tuesday, actually Sunday.
    const flags = guard.scanMessage(
      'The visit is Monday, August 17 and the follow-up is Tuesday, August 16.',
      EVAL_REF,
    );
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ date: '2026-08-16', claimed: 'Tuesday' });
    expect(flags[0].corrected).toBeUndefined();
  });

  test('the original live failures still flag un-corrected (no regression from the correction rule)', () => {
    const f1 = guard.scanMessage('running from Monday the 4th through Saturday the 8th', REF);
    expect(f1.length).toBeGreaterThan(0);
    expect(f1.every((f) => f.corrected === undefined)).toBe(true);
  });
});

describe('weekday guard — the innocent bank stays silent', () => {
  // Everything this fleet actually says when it is RIGHT. A flag on any of
  // these poisons the measured rate.
  const INNOCENT = [
    // the resolve_date phrase — the exact string agents are told to quote
    'Monday 2026-08-03 through Sunday 2026-08-09',
    // live reply #2, correct
    'Joy has 22 visits this week (Mon Aug 3 – Sun Aug 9, counting through today).',
    // availability summaries (get_availability output shape)
    'Ben works Mon–Fri 08:00–17:00; Sat, Sun off.',
    // bare weekday: states no date, nothing to contradict
    'I can book her in on Friday.',
    'Would next Tuesday or Wednesday suit?',
    // relative windows
    'Joy has 22 visits this week.',
    'The schedule for next week is clear.',
    // bare dates, ISO timestamps
    'Joy has 22 visits between 2026-08-03 and 2026-08-09.',
    'Captured at 2026-08-06T20:35:52Z.',
    // schedule-list lines (correct pairs)
    'Tue Aug 4 — Tom Nguyen, 8:00–10:00, Renton',
    'Saturday the 8th works for the crew.',
    // "the Nth of Month" — chrono's own territory, correct here
    'We close for the 4th of July.',
    // correct pair with full date
    'Confirmed for Thursday, August 6, 2026.',
    // time-only
    "Tom's slot is 2pm tomorrow.",
    // next-month reference, correct
    'Her next check-up is Wednesday September 2.',
  ];
  for (const text of INNOCENT) {
    test(JSON.stringify(text.slice(0, 60)), () => {
      expect(guard.scanMessage(text, REF)).toEqual([]);
    });
  }

  test('year inference resolves NEAREST, not ref year: December naming next January', () => {
    // Jan 4 2027 IS a Monday; Jan 4 2026 was a Sunday. Said in mid-December,
    // "Monday January 4" means 2027 — flagging it against 2026 would be a
    // false positive on a correct sentence.
    const decRef = { y: 2026, m: 12, d: 15 };
    expect(guard.scanMessage('Booked for Monday January 4.', decRef)).toEqual([]);
  });

  test('ordinal expansion picks the nearest month across a boundary', () => {
    // Said on Aug 30, "the 2nd" means September 2 (Wednesday), not August 2.
    const lateAug = { y: 2026, m: 8, d: 30 };
    expect(guard.expandOrdinals('Wednesday the 2nd', lateAug)).toContain('September 2, 2026');
    expect(guard.scanMessage('Booked for Wednesday the 2nd.', lateAug)).toEqual([]);
  });
});

describe('weekday guard — never throws, never slow', () => {
  test('garbage inputs return [] without throwing', () => {
    for (const bad of [null, undefined, 42, {}, [], '', '   ', '🔧🔧🔧', '\u0000\uFFFD']) {
      expect(guard.scanMessage(bad as never, REF)).toEqual([]);
    }
  });

  test('a 200KB message scans without throwing and under a second', () => {
    const big = 'Visit notes: pipe replaced. '.repeat(8000);
    const t0 = Date.now();
    expect(guard.scanMessage(big, REF)).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  test('1000 typical messages scan in well under 2s', () => {
    const msg = 'Joy has 22 visits this week (Monday 2026-08-03 through Sunday 2026-08-09).';
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) guard.scanMessage(msg, REF);
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  test('firmLocalParts is firm-local, not UTC — the 5pm-PDT trap', () => {
    // 2026-08-07T02:00Z is still Thursday Aug 6 in Los Angeles.
    const parts = guard.firmLocalParts('America/Los_Angeles', new Date('2026-08-07T02:00:00Z'));
    expect(parts).toEqual({ y: 2026, m: 8, d: 6 });
  });
});

describe('weekday guard — the hook contract', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'weekday-guard-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TRADES_WEEKDAY_GUARD_LOG;
  });

  type Handler = (event: unknown) => unknown;
  // v0.2.0 registers BOTH outbound hooks — on 2026-08-11 four real Telegram
  // turns bypassed message_sending entirely (delivery path changed after
  // 2026-08-06), so reply_payload_sending rides along and the log's `hook`
  // field says which one production actually uses.
  function registerAndGetHandlers(): Record<string, Handler> {
    const handlers: Record<string, Handler> = {};
    const api = {
      on: (name: string, fn: Handler) => {
        handlers[name] = fn;
      },
    };
    guard.default(api);
    expect(Object.keys(handlers).sort()).toEqual([
      'message_sending',
      'reply_payload_sending',
    ]);
    return handlers;
  }

  test('observe-only: returns undefined for clean AND flagged content, logs both with hook tag', () => {
    const logPath = join(dir, 'guard.jsonl');
    process.env.TRADES_WEEKDAY_GUARD_LOG = logPath;
    const handlers = registerAndGetHandlers();

    // Flagged content: STILL undefined — never rewrite, never cancel.
    // The date is EXPLICIT (month + year) on purpose. A bare "the 4th" is
    // resolved by expandOrdinals to whichever month's 4th is NEAREST TODAY, so
    // the weekday it lands on changes as the month goes on — every hook test
    // asserting a bare ordinal is a time bomb, and the one below detonated on
    // 2026-08-20. Handler tests cannot pass a reference date (the handler reads
    // the real clock), so they must state the date in full instead.
    // Aug 4 2026 is a Tuesday, permanently.
    expect(
      handlers.message_sending({ content: 'See you Monday August 4, 2026.', channel: 'telegram' }),
    ).toBeUndefined();
    // Clean content: logged as the denominator.
    expect(handlers.message_sending({ content: 'On my way.', channel: 'telegram' })).toBeUndefined();

    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].flags).toHaveLength(1);
    expect(lines[0].flags[0].claimed).toBe('Monday');
    expect(lines[0].channel).toBe('telegram');
    expect(lines[0].hook).toBe('message_sending');
    expect(lines[0].sha).toMatch(/^[0-9a-f]{12}$/);
    expect(lines[1].flags).toEqual([]);
    expect(lines[1].v).toBe(guard.VERSION);
  });

  test('reply_payload_sending: extracts text from payload-shaped events', () => {
    const logPath = join(dir, 'guard-payload.jsonl');
    process.env.TRADES_WEEKDAY_GUARD_LOG = logPath;
    const handlers = registerAndGetHandlers();
    // The vendor docs do not pin ReplyPayload's fields; the extractor accepts
    // the plausible shapes. Each unique text avoids the dedupe window.
    // Dates stated in FULL — see the note above; this test failed on 2026-08-20
    // because "the 4th" had started resolving to September.
    expect(
      handlers.reply_payload_sending({ payload: { text: 'Booked for Monday August 4, 2026, Amy.' } }),
    ).toBeUndefined();
    expect(
      handlers.reply_payload_sending({ text: 'Rescheduled to Tuesday August 4, 2026 ok?' }),
    ).toBeUndefined();
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].hook).toBe('reply_payload_sending');
    expect(lines[0].flags).toHaveLength(1); // Aug 4 2026 is a Tuesday, not a Monday
    expect(lines[1].flags).toEqual([]); // Tuesday Aug 4 2026 is correct
  });

  test('the same reply through BOTH hooks: second line is marked dup', () => {
    const logPath = join(dir, 'guard-dup.jsonl');
    process.env.TRADES_WEEKDAY_GUARD_LOG = logPath;
    const handlers = registerAndGetHandlers();
    const text = 'Crew arrives Wednesday, no date attached.';
    handlers.message_sending({ content: text });
    handlers.reply_payload_sending({ payload: { text } });
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].dup).toBeUndefined();
    expect(lines[1].dup).toBe(true);
    expect(lines[0].sha).toBe(lines[1].sha); // rate analysis dedupes on this
  });

  test('a text-less ReplyPayload logs its KEY NAMES only — never values', () => {
    const logPath = join(dir, 'guard-miss.jsonl');
    process.env.TRADES_WEEKDAY_GUARD_LOG = logPath;
    const handlers = registerAndGetHandlers();
    handlers.reply_payload_sending({
      payload: { blocks: [{ secret: 'do-not-log-me' }], delivery: 'x' },
      runId: 'r-1',
    });
    const raw = readFileSync(logPath, 'utf8');
    const line = JSON.parse(raw.trim());
    expect(line.miss).toBe(true);
    expect(line.keys).toContain('payload.blocks');
    expect(line.keys).toContain('runId');
    // Keys-only discipline: the VALUE must never reach the log.
    expect(raw).not.toContain('do-not-log-me');
  });

  test('non-string content on message_sending is skipped silently (no log line, no throw)', () => {
    const logPath = join(dir, 'guard-nonstring.jsonl');
    process.env.TRADES_WEEKDAY_GUARD_LOG = logPath;
    const handlers = registerAndGetHandlers();
    for (const event of [
      {},
      { content: null },
      { content: 42 },
      { content: { parts: [] } },
      null,
      undefined,
    ]) {
      expect(handlers.message_sending(event)).toBeUndefined();
    }
    expect(() => readFileSync(logPath, 'utf8')).toThrow(); // nothing was written
  });

  test('an unwritable log path breaks nothing', () => {
    process.env.TRADES_WEEKDAY_GUARD_LOG = '/nonexistent-dir/guard.jsonl';
    const handlers = registerAndGetHandlers();
    expect(handlers.message_sending({ content: 'See you Monday the 4th, then.' })).toBeUndefined();
  });

  test('an api without .on registers nothing and does not throw', () => {
    expect(() => guard.default({})).not.toThrow();
    expect(() => guard.default(undefined)).not.toThrow();
  });

  test('an api that rejects one hook name still registers the other', () => {
    const handlers: Record<string, Handler> = {};
    const api = {
      on: (name: string, fn: Handler) => {
        if (name === 'reply_payload_sending') throw new Error('unknown event');
        handlers[name] = fn;
      },
    };
    expect(() => guard.default(api)).not.toThrow();
    expect(Object.keys(handlers)).toEqual(['message_sending']);
  });
});

describe('link guard v0.4.0 — the S04 fabricated link and the legitimate bank', () => {
  test('the live failure: an invented board URL flags', () => {
    // Verbatim from the 2026-08-14 Nebius tier-2 run (S04, fabricated-link).
    const flags = guard.scanLinks(
      'Here is the whole week: https://dispatch.evalmain.com/board?from=2026-08-17&to=2026-08-23 — 14 visits across the team.',
    );
    expect(flags).toHaveLength(1);
    expect(flags[0].host).toBe('dispatch.evalmain.com');
    expect(flags[0].url).toBe('https://dispatch.evalmain.com/board?from=2026-08-17&to=2026-08-23');
  });

  test('every host the tools actually emit stays silent', () => {
    // Board (BOARD_PUBLIC_URL default), Telegram bot link, Maps deep link
    // (src/routes/deepLink.ts builds www.google.com/maps/dir/ URLs).
    expect(
      guard.scanLinks(
        'On the board: https://tradesdatabase.onrender.com/schedule?date=2026-08-17 or ' +
          '[open it](https://t.me/DashboardMan_bot?startapp) — directions: ' +
          'https://www.google.com/maps/dir/?api=1&destination=123+Main+St+Seattle',
      ),
    ).toEqual([]);
  });

  test('google.com outside /maps is NOT a free pass', () => {
    const flags = guard.scanLinks('see https://www.google.com/search?q=trades');
    expect(flags).toHaveLength(1);
    expect(flags[0].host).toBe('www.google.com');
  });

  test('bare domains in prose are not URLs and never flag', () => {
    expect(guard.scanLinks('the board lives at tradesdatabase.onrender.com, ask me for the link')).toEqual([]);
  });

  test('trailing punctuation is stripped from the flagged URL', () => {
    const flags = guard.scanLinks('try https://evil.example.com/x.');
    expect(flags).toHaveLength(1);
    expect(flags[0].url).toBe('https://evil.example.com/x');
  });

  test('non-string and empty input return []', () => {
    expect(guard.scanLinks(undefined)).toEqual([]);
    expect(guard.scanLinks('')).toEqual([]);
    expect(guard.scanLinks(42)).toEqual([]);
  });

  test('BOARD_PUBLIC_URL and TRADES_LINK_GUARD_ALLOW widen the allowlist', () => {
    const hosts = guard.allowedLinkHosts({
      BOARD_PUBLIC_URL: 'https://boards.example.com/x',
      TRADES_LINK_GUARD_ALLOW: 'docs.example.com, Wiki.Example.COM',
    });
    expect(hosts.has('boards.example.com')).toBe(true);
    expect(hosts.has('docs.example.com')).toBe(true);
    expect(hosts.has('wiki.example.com')).toBe(true);
    // A malformed BOARD_PUBLIC_URL is ignored, never fatal.
    expect(() => guard.allowedLinkHosts({ BOARD_PUBLIC_URL: '::not a url::' })).not.toThrow();
  });

  test('the outbound hook record carries linkFlags', () => {
    const handlers: Record<string, (event: unknown) => unknown> = {};
    const api = { on: (name: string, fn: (event: unknown) => unknown) => (handlers[name] = fn) };
    const dir = mkdtempSync(join(tmpdir(), 'linkguard-'));
    const log = join(dir, 'guard.jsonl');
    process.env.TRADES_WEEKDAY_GUARD_LOG = log;
    try {
      guard.default(api);
      handlers.reply_payload_sending({ payload: { text: 'week view: https://dispatch.evalmain.com/board' } });
      const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      const rec = lines.at(-1);
      expect(rec.v).toBe('0.4.0');
      expect(rec.linkFlags).toHaveLength(1);
      expect(rec.linkFlags[0].host).toBe('dispatch.evalmain.com');
      expect(rec.flags).toEqual([]);
    } finally {
      delete process.env.TRADES_WEEKDAY_GUARD_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
