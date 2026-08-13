import { describe, expect, it } from 'vitest';
import { ms, percentile, rate, seal, summarise } from './metrics.js';

describe('percentile', () => {
  it('reports a value that was actually observed', () => {
    const v = [10, 20, 30, 40];
    // Nearest-rank: never the interpolated 25 between 20 and 30.
    expect(v).toContain(percentile(v, 50));
    expect(v).toContain(percentile(v, 95));
  });

  it('handles the ends and a single sample', () => {
    expect(percentile([5], 50)).toBe(5);
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 100)).toBe(3);
    expect(percentile([], 50)).toBeNaN();
  });

  it('does not care about input order', () => {
    expect(percentile([30, 10, 40, 20], 50)).toBe(percentile([10, 20, 30, 40], 50));
  });

  it('picks the top value for p95 on a small sample', () => {
    // 20 samples, p95 -> rank 19 (0-indexed 18) — the second-slowest. The point of
    // pinning this: a p95 that silently became "the max" would hide a tail.
    const v = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(v, 95)).toBe(19);
    expect(percentile(v, 100)).toBe(20);
  });
});

describe('summarise', () => {
  it('summarises a sample', () => {
    const s = summarise([100, 200, 300, 400]);
    expect(s.n).toBe(4);
    expect(s.max).toBe(400);
    expect(s.mean).toBe(250);
  });

  it('degrades to NaN rather than 0 on an empty sample', () => {
    // 0ms would read as "instant" in a report; NaN renders as "—".
    const s = summarise([]);
    expect(s.n).toBe(0);
    expect(s.p50).toBeNaN();
    expect(s.mean).toBeNaN();
  });
});

describe('seal', () => {
  it('is stable for the same content', () => {
    expect(seal(['a', 'b'])).toBe(seal(['a', 'b']));
  });

  it('ignores ordering of the inputs', () => {
    expect(seal(['a', 'b'])).toBe(seal(['b', 'a']));
  });

  it('CHANGES when any part changes — the whole point', () => {
    const base = seal(['corpus-v1', 'graders-v1', 'thresholds-v1']);
    expect(seal(['corpus-v2', 'graders-v1', 'thresholds-v1'])).not.toBe(base);
    expect(seal(['corpus-v1', 'graders-v2', 'thresholds-v1'])).not.toBe(base);
    expect(seal(['corpus-v1', 'graders-v1', 'thresholds-v2'])).not.toBe(base);
    // Dropping a scenario must move it too — that is the tamper this detects.
    expect(seal(['corpus-v1', 'graders-v1'])).not.toBe(base);
  });

  it('is short enough to paste into a goal condition', () => {
    expect(seal(['x'])).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is not fooled by concatenation across parts', () => {
    // A separator is written between parts, so ['ab','c'] and ['a','bc'] differ.
    expect(seal(['ab', 'c'])).not.toBe(seal(['a', 'bc']));
  });
});

describe('rate', () => {
  it('is a one-decimal percentage', () => {
    expect(rate(1, 3)).toBe(33.3);
    expect(rate(3, 3)).toBe(100);
    expect(rate(0, 3)).toBe(0);
  });

  it('is NaN, not 0 or 100, on an empty denominator', () => {
    // "0% passed" and "nothing ran" must not look the same in a gate.
    expect(rate(0, 0)).toBeNaN();
  });
});

describe('ms', () => {
  it('scales the unit to the magnitude', () => {
    expect(ms(842)).toBe('842ms');
    expect(ms(1420)).toBe('1.42s');
    expect(ms(23_140)).toBe('23.1s');
    expect(ms(NaN)).toBe('—');
  });
});
