import { describe, expect, test } from 'vitest';
import { sampleContext } from './fixtures.js';
import { sonnetBriefer } from './briefCustomer.js';

// Live test: hits claude-sonnet-4-6, so it is gated on a key (skips in CI without
// one), mirroring src/email/classify.test.ts. Synthesis is pure over an in-memory
// context, so no DB is needed.
describe.skipIf(!process.env.ANTHROPIC_API_KEY)('sonnetBriefer (live)', () => {
  test('returns a non-empty briefing whose citations all reference real captures', async () => {
    const ctx = sampleContext();
    const result = await sonnetBriefer(ctx, 'next_visit');
    console.log('sonnetBriefer result:', JSON.stringify(result, null, 2));

    expect(result.briefing.trim().length).toBeGreaterThan(0);
    const realIds = new Set(ctx.recentCaptures.map((c) => c.id));
    for (const citation of result.citations) {
      expect(realIds.has(citation.captureId)).toBe(true);
    }
  }, 30_000); // live Sonnet call — well over vitest's default 5s
});
