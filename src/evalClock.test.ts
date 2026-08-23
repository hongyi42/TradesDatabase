import { afterEach, describe, expect, test } from 'vitest';
import { spineNowIso } from './evalClock.js';

const TENANT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER = '11111111-2222-3333-4444-555555555555';
const ANCHOR = '2027-03-04T02:30:00.000Z';

describe('spineNowIso — the anchored eval clock', () => {
  afterEach(() => {
    delete process.env.EVAL_FAKE_NOW;
  });

  test('unset: real clock', () => {
    const t = Date.parse(spineNowIso(TENANT));
    expect(Math.abs(t - Date.now())).toBeLessThan(5_000);
  });

  test('anchored tenant gets the anchor, any other tenant gets the real clock', () => {
    process.env.EVAL_FAKE_NOW = `${TENANT}:${ANCHOR}`;
    expect(spineNowIso(TENANT)).toBe(ANCHOR);
    const other = Date.parse(spineNowIso(OTHER));
    expect(Math.abs(other - Date.now())).toBeLessThan(5_000);
  });

  test('malformed values fail closed to the real clock', () => {
    for (const bad of [
      `${TENANT}:not-a-date`,
      ':2027-03-04T02:30:00Z', // empty tenant
      'no-colon-at-all',
      `${TENANT}`, // tenant, no instant
    ]) {
      process.env.EVAL_FAKE_NOW = bad;
      const t = Date.parse(spineNowIso(TENANT));
      expect(Math.abs(t - Date.now())).toBeLessThan(5_000);
    }
  });
});
