import { describe, expect, test } from 'vitest';
import { sonnetClassifier } from './classify.js';

// LIVE test: exercises the real Sonnet classifier on two unambiguous fixtures.
// Gated on ANTHROPIC_API_KEY so it skips in environments without a key (e.g. CI)
// rather than hard-failing. Kept to clear-cut cases to avoid model flakiness.
describe.skipIf(!process.env.ANTHROPIC_API_KEY)('sonnetClassifier (live)', () => {
  test('a clear job email is classified as work', async () => {
    const r = await sonnetClassifier({
      from: 'jane@homeowner.com',
      subject: 'My AC stopped working — need a repair this week',
      body: 'Hi, my air conditioner died last night. Can a technician come out? Address is 14 Smith St.',
    });
    expect(r.isWork).toBe(true);
  });

  test('a marketing newsletter is classified as not work', async () => {
    const r = await sonnetClassifier({
      from: 'deals@retailer.com',
      subject: '🔥 50% OFF Everything This Weekend Only!',
      body: 'Shop our biggest sale of the year. Click here to save. Unsubscribe at the bottom.',
    });
    expect(r.isWork).toBe(false);
  });
});
