import { beforeEach, describe, expect, test, vi } from 'vitest';

// The Mini App allowlist unions the pool's bots with the glue seats' bots
// (step 4). Both reads are stubbed: this is about the union, not the queries
// (src/db/seats.test.ts and sandboxPool.test.ts cover those).
vi.mock('../db/index.js', () => ({
  listLiveBotIds: vi.fn(async () => ['111', '222']),
  listLiveSeatBotIds: vi.fn(async () => ['222', '333']),
}));

import { allowed, clear } from './botIds.js';

describe('botIds.allowed', () => {
  beforeEach(() => {
    clear();
    delete process.env.BOARD_BOT_TOKEN;
  });

  test('admits pool bots and seat bots, once each', async () => {
    expect((await allowed()).sort()).toEqual(['111', '222', '333']);
  });
});
