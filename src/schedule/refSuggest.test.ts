import { describe, expect, test } from 'vitest';
import { closestRef, levenshtein } from './refSuggest.js';

describe('levenshtein', () => {
  test('distances', () => {
    expect(levenshtein('tech-jane', 'tech-jane')).toBe(0);
    expect(levenshtein('tehc-jane', 'tech-jane')).toBe(2); // transposition = 2 edits
    expect(levenshtein('tech-jan', 'tech-jane')).toBe(1);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('jane', 'jane-doe')).toBe(4);
  });
});

describe('closestRef', () => {
  const refs = ['tech-jane', 'tech-bob', 'office-dispatch'];

  test('exact / 1-edit / 2-edit matches suggest', () => {
    expect(closestRef('tech-jane', refs)).toBe('tech-jane');
    expect(closestRef('tech-jan', refs)).toBe('tech-jane'); // 1 edit
    expect(closestRef('tehc-jane', refs)).toBe('tech-jane'); // 2 edits
    expect(closestRef('Tech-Jane', refs)).toBe('tech-jane'); // case-insensitive
  });

  test('no suggestion beyond distance 2 — ambiguous short names stay unsuggested', () => {
    expect(closestRef('completely-different', refs)).toBeNull();
    // 'jane' is 4+ edits from every roster ref: no guess between Janes.
    expect(closestRef('jane', ['jane-doe', 'jane-smith'])).toBeNull();
    expect(closestRef('anything', [])).toBeNull();
  });

  test('a TIE within the threshold is ambiguous → no suggestion (never picks by list order)', () => {
    // 'tech-cob' is distance 1 from both — suggesting either would one-tap the
    // manager into a coin-flip.
    expect(closestRef('tech-cob', ['tech-bob', 'tech-rob'])).toBeNull();
    // A strictly-closer ref still wins even when others tie further out.
    expect(closestRef('tech-bob', ['tech-bob', 'tech-rob'])).toBe('tech-bob');
  });
});
