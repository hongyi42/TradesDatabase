import { describe, expect, test } from 'vitest';
import { braveWebSearch } from './braveSearch.js';

// Live-contract check, key-gated like the other vendor-touching suites: proves
// the endpoint/header/response-shape assumptions against the real Brave API.
describe.skipIf(!process.env.BRAVE_API_KEY)('braveWebSearch (live)', () => {
  test('returns shaped results for a plain query', async () => {
    const results = await braveWebSearch('carrier furnace fault code 33', 3);
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(typeof r.title).toBe('string');
      expect(typeof r.snippet).toBe('string');
    }
    expect(results.some((r) => r.snippet.length > 0)).toBe(true);
  }, 20_000);
});
