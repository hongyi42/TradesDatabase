import { afterEach, describe, expect, test } from 'vitest';
import { DEFAULT_RESULT_CAP_CHARS, capToolResult, resultCapChars } from './resultCap.js';

// The size cap is pure over a string: no DB, no server. What these pin is
// the contract the hub relies on — unchanged under the cap, valid JSON over it,
// the overflow announced — and that the env override cannot silently switch it off.
describe('capToolResult', () => {
  const original = process.env.SPINE_RESULT_CAP_CHARS;
  afterEach(() => {
    if (original === undefined) delete process.env.SPINE_RESULT_CAP_CHARS;
    else process.env.SPINE_RESULT_CAP_CHARS = original;
  });

  test('a result under or exactly at the cap passes through untouched', () => {
    const text = JSON.stringify({ ok: true, rows: ['a', 'b'] });
    expect(capToolResult(text, 100)).toBe(text);
    expect(capToolResult('x'.repeat(50), 50)).toBe('x'.repeat(50));
  });

  test('a result over the cap becomes a small valid JSON object that says so', () => {
    const big = JSON.stringify({ captures: Array.from({ length: 200 }, (_, i) => ({ i, text: 'y'.repeat(40) })) });
    const out = capToolResult(big, 500);
    expect(out.length).toBeLessThan(big.length);
    const parsed = JSON.parse(out) as {
      truncated: boolean;
      chars: number;
      limit: number;
      note: string;
      partial: string;
    };
    expect(parsed.truncated).toBe(true);
    expect(parsed.chars).toBe(big.length);
    expect(parsed.limit).toBe(500);
    expect(parsed.partial).toBe(big.slice(0, 500));
    expect(parsed.note).toContain('was cut');
    expect(parsed.note).toContain('get_capture');
  });

  test('the cap is read per call from SPINE_RESULT_CAP_CHARS, and a malformed value keeps the default', () => {
    delete process.env.SPINE_RESULT_CAP_CHARS;
    expect(resultCapChars()).toBe(DEFAULT_RESULT_CAP_CHARS);
    process.env.SPINE_RESULT_CAP_CHARS = '300';
    expect(resultCapChars()).toBe(300);
    expect(JSON.parse(capToolResult('z'.repeat(301))).truncated).toBe(true);
    process.env.SPINE_RESULT_CAP_CHARS = '300px';
    expect(resultCapChars()).toBe(DEFAULT_RESULT_CAP_CHARS);
    expect(capToolResult('z'.repeat(301))).toBe('z'.repeat(301));
  });

  test('a cap of 0 disables the backstop — an explicit choice, never the fallback', () => {
    expect(capToolResult('z'.repeat(10), 0)).toBe('z'.repeat(10));
  });
});
