import { describe, expect, it } from 'vitest';
import { ScriptedTelegram } from './drive.js';

describe('ScriptedTelegram', () => {
  it('numbers updates from the seat offset, so a restarted driver is not skipped', async () => {
    const tg = new ScriptedTelegram(900000001, 9);
    tg.push({ text: 'what did I tell you about the fan?' });
    const got = await tg.getUpdates(9);
    expect(got).toHaveLength(1);
    expect(got[0].update_id).toBe(9);
  });

  it('starts at 1 on a fresh state dir', async () => {
    const tg = new ScriptedTelegram(900000001, 0);
    tg.push({ text: 'hi' });
    expect((await tg.getUpdates(0))[0].update_id).toBe(1);
  });
});
