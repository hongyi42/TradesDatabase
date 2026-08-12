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
}
interface GuardModule {
  VERSION: string;
  scanMessage: (text: unknown, ref: { y: number; m: number; d: number }) => Flag[];
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
    expect(
      handlers.message_sending({ content: 'See you Monday the 4th.', channel: 'telegram' }),
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
    expect(
      handlers.reply_payload_sending({ payload: { text: 'Booked for Monday the 4th, Amy.' } }),
    ).toBeUndefined();
    expect(
      handlers.reply_payload_sending({ text: 'Rescheduled to Tuesday the 4th ok?' }),
    ).toBeUndefined();
    const lines = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].hook).toBe('reply_payload_sending');
    expect(lines[0].flags).toHaveLength(1); // Aug 4 is a Tuesday
    expect(lines[1].flags).toEqual([]); // Tuesday the 4th is correct
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
