import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_RESULT_CAP_CHARS, capToolResult, resultCapChars } from './resultCap.js';

// The size cap is pure over a string: no DB, no server. What these pin is
// the contract the hub relies on — unchanged under the cap, valid JSON over it
// that FITS the cap, the overflow announced, the decorations carried — and that
// the env override cannot silently switch it off.
describe('capToolResult', () => {
  const original = process.env.SPINE_RESULT_CAP_CHARS;
  afterEach(() => {
    if (original === undefined) delete process.env.SPINE_RESULT_CAP_CHARS;
    else process.env.SPINE_RESULT_CAP_CHARS = original;
  });

  interface Capped {
    truncated: boolean;
    chars: number;
    limit: number;
    note: string;
    partial: string;
    now?: string;
    boardLink?: string;
  }

  test('a result under or exactly at the cap passes through untouched', () => {
    const text = JSON.stringify({ ok: true, rows: ['a', 'b'] });
    expect(capToolResult(text, 100)).toBe(text);
    expect(capToolResult('x'.repeat(50), 50)).toBe('x'.repeat(50));
  });

  test('a result over the cap becomes valid JSON that fits the cap, even when escaping inflates it', () => {
    // Quote-heavy JSON: every quote doubles when the text is embedded in a string.
    const big = JSON.stringify({
      captures: Array.from({ length: 300 }, (_, i) => ({ i, text: `"quoted" \\ ${'y'.repeat(30)}` })),
    });
    const out = capToolResult(big, 2_000);
    expect(out.length).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(out) as Capped;
    expect(parsed.truncated).toBe(true);
    expect(parsed.chars).toBe(big.length);
    expect(parsed.limit).toBe(2_000);
    expect(parsed.partial.length).toBeGreaterThan(0);
    expect(big.startsWith(parsed.partial)).toBe(true); // a true head of the original
    expect(parsed.note).toContain('was cut');
    expect(parsed.note).toContain('get_capture');
  });

  test('the hub decorations ride on the cut object, and the whole still fits', () => {
    const big = JSON.stringify({ rows: 'z'.repeat(5_000), now: 'Tuesday 2026-09-15 10:00 PDT' });
    const out = capToolResult(big, 1_000, {
      now: 'Tuesday 2026-09-15 10:00 PDT',
      boardLink: 'https://t.me/board?startapp=x',
    });
    expect(out.length).toBeLessThanOrEqual(1_000);
    const parsed = JSON.parse(out) as Capped;
    expect(parsed.now).toBe('Tuesday 2026-09-15 10:00 PDT');
    expect(parsed.boardLink).toBe('https://t.me/board?startapp=x');
  });

  test('the cap is read per call from SPINE_RESULT_CAP_CHARS, and a malformed value keeps the default', () => {
    delete process.env.SPINE_RESULT_CAP_CHARS;
    expect(resultCapChars()).toBe(DEFAULT_RESULT_CAP_CHARS);
    process.env.SPINE_RESULT_CAP_CHARS = '300';
    expect(resultCapChars()).toBe(300);
    expect((JSON.parse(capToolResult('z'.repeat(301))) as Capped).truncated).toBe(true);
    process.env.SPINE_RESULT_CAP_CHARS = '300px';
    expect(resultCapChars()).toBe(DEFAULT_RESULT_CAP_CHARS);
    expect(capToolResult('z'.repeat(301))).toBe('z'.repeat(301));
  });

  test('a cap of 0 disables the backstop — an explicit choice, never the fallback', () => {
    expect(capToolResult('z'.repeat(10), 0)).toBe('z'.repeat(10));
  });
});
