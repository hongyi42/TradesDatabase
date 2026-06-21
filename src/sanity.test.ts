import { test, expect } from 'vitest';

// Trivial test so `npm test` is green before any DB-backed tests exist.
test('toolchain sanity', () => {
  expect(1 + 1).toBe(2);
});
