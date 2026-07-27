import { describe, expect, test } from 'vitest';
import { sampleContext } from './fixtures.js';
import { defaultBriefer } from './briefCustomer.js';
import { hasModelCredentials } from '../model/forcedTool.js';

// Live test: hits the active provider (MODEL_PROVIDER), so it is gated on that
// provider's key (skips in CI without one), mirroring src/email/classify.test.ts.
// Synthesis is pure over an in-memory context, so no DB is needed.
// 120s, not vitest's 30s default: these were written when the spine called
// Anthropic. GLM-5.2 on DeepInfra is slower — a real 30s timeout was observed
// on the answerer once a key was present — so the default made the suite flake
// intermittently. The latency itself is a separate, recorded concern.
describe.skipIf(!hasModelCredentials())('defaultBriefer (live)', () => {
  test('returns a non-empty briefing whose citations all reference real captures', async () => {
    const ctx = sampleContext();
    const result = await defaultBriefer(ctx, 'next_visit');
    console.log('defaultBriefer result:', JSON.stringify(result, null, 2));

    expect(result.briefing.trim().length).toBeGreaterThan(0);
    const realIds = new Set(ctx.recentCaptures.map((c) => c.id));
    for (const citation of result.citations) {
      expect(realIds.has(citation.captureId)).toBe(true);
    }
  }, 120_000); // live model call — GLM-5.2 is slower than the Sonnet this was written for
});
