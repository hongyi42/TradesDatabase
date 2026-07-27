import { describe, expect, test } from 'vitest';
import { defaultClassifier } from './classify.js';
import { hasModelCredentials } from '../model/forcedTool.js';

// LIVE test: exercises the real classifier on two unambiguous fixtures, against
// whichever provider MODEL_PROVIDER selects. Gated on the ACTIVE provider's key
// (not ANTHROPIC_API_KEY) so it follows the provider switch instead of silently
// skipping after a flip. Kept to clear-cut cases to avoid model flakiness.
// 120s, not vitest's 30s default: these were written when the spine called
// Anthropic. GLM-5.2 on DeepInfra is slower — a real 30s timeout was observed
// on the answerer once a key was present — so the default made the suite flake
// intermittently. The latency itself is a separate, recorded concern.
describe.skipIf(!hasModelCredentials())('defaultClassifier (live)', () => {
  test('a clear job email is classified as work', async () => {
    const r = await defaultClassifier({
      from: 'jane@homeowner.com',
      subject: 'My AC stopped working — need a repair this week',
      body: 'Hi, my air conditioner died last night. Can a technician come out? Address is 14 Smith St.',
    });
    expect(r.isWork).toBe(true);
  }, 120_000); // live model call — GLM-5.2 is slower than the Sonnet this was written for

  test('a marketing newsletter is classified as not work', async () => {
    const r = await defaultClassifier({
      from: 'deals@retailer.com',
      subject: '🔥 50% OFF Everything This Weekend Only!',
      body: 'Shop our biggest sale of the year. Click here to save. Unsubscribe at the bottom.',
    });
    expect(r.isWork).toBe(false);
  }, 120_000);
});
