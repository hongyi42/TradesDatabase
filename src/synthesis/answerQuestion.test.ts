import { describe, expect, test } from 'vitest';
import { sampleContext } from './fixtures.js';
import { defaultAnswerer } from './answerQuestion.js';
import { hasModelCredentials } from '../model/forcedTool.js';

// Live test: hits the active provider (MODEL_PROVIDER), gated on that provider's
// key (skips in CI), mirroring src/email/classify.test.ts. Pure over an in-memory
// context — no DB.
describe.skipIf(!hasModelCredentials())('defaultAnswerer (live)', () => {
  test('answers a question the record supports, with valid citations', async () => {
    const ctx = sampleContext();
    const result = await defaultAnswerer(ctx, 'What did the last tech find?');
    console.log('defaultAnswerer (answerable):', JSON.stringify(result, null, 2));

    expect(result.answer.toLowerCase()).toContain('capacitor');
    const realIds = new Set(ctx.recentCaptures.map((c) => c.id));
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    for (const citation of result.citations) {
      expect(realIds.has(citation.captureId)).toBe(true);
    }
  }, 30_000);

  test('does not fabricate when the record lacks the answer', async () => {
    const ctx = sampleContext();
    const result = await defaultAnswerer(ctx, "What is the customer's birthday?");
    console.log('defaultAnswerer (unanswerable):', JSON.stringify(result, null, 2));

    expect(result.answer.trim().length).toBeGreaterThan(0);
    // No birthday is in the record, so any returned citations must still be real
    // (validateCitations drops fabricated ids); the answer should not invent one.
    const realIds = new Set(ctx.recentCaptures.map((c) => c.id));
    for (const citation of result.citations) {
      expect(realIds.has(citation.captureId)).toBe(true);
    }
  }, 30_000);
});
