import { describe, expect, test } from 'vitest';
import { defaultClassifier } from './classify.js';
import { hasModelCredentials } from '../model/forcedTool.js';

// LIVE test: exercises the real classifier on two unambiguous fixtures, against
// whichever provider MODEL_PROVIDER selects. Gated on the ACTIVE provider's key
// (not ANTHROPIC_API_KEY) so it follows the provider switch instead of silently
// skipping after a flip. Kept to clear-cut cases to avoid model flakiness.
describe.skipIf(!hasModelCredentials())('defaultClassifier (live)', () => {
  test('a clear job email is classified as work', async () => {
    const r = await defaultClassifier({
      from: 'jane@homeowner.com',
      subject: 'My AC stopped working — need a repair this week',
      body: 'Hi, my air conditioner died last night. Can a technician come out? Address is 14 Smith St.',
    });
    expect(r.isWork).toBe(true);
  }, 30_000); // live Sonnet call — well over vitest's default 5s

  test('a marketing newsletter is classified as not work', async () => {
    const r = await defaultClassifier({
      from: 'deals@retailer.com',
      subject: '🔥 50% OFF Everything This Weekend Only!',
      body: 'Shop our biggest sale of the year. Click here to save. Unsubscribe at the bottom.',
    });
    expect(r.isWork).toBe(false);
  }, 30_000);
});
