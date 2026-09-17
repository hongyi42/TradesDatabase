import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { notifyOpsTransition } from './opsNotify.js';
import type { OpsOutcome } from '../db/opsEvents.js';

// Unit test for the ops alert. Every case drives the injected sender, so nothing
// here can reach Telegram — see the deps seam in opsNotify.ts for why that
// matters (`.env` carries a real bot token).
//
// Both env vars are set EXPLICITLY rather than inherited from .env: the skip
// branches are the behaviour under test, and a test that passes only because the
// developer's .env happens to be shaped a certain way is not a test.

const OPENED: OpsOutcome = { action: 'opened', incidentId: 'inc-1' };
const CLOSED = (openMs: number): OpsOutcome => ({ action: 'closed', incidentId: 'inc-1', openMs });

// Typed to sendOpsMessage's signature so the deps seam is checked, not just
// satisfied — an untyped vi.fn() would accept a wrong-shaped sender silently.
type Sender = (chatId: string, text: string) => Promise<void>;

describe('notifyOpsTransition', () => {
  let send: ReturnType<typeof vi.fn<Sender>>;
  const saved = {
    chat: process.env.OPS_ALERT_CHAT_ID,
    ops: process.env.OPS_BOT_TOKEN,
    board: process.env.BOARD_BOT_TOKEN,
  };

  beforeEach(() => {
    send = vi.fn<Sender>(async () => {});
    process.env.OPS_ALERT_CHAT_ID = '5801703167';
    process.env.OPS_BOT_TOKEN = 'test-ops-token';
    // Explicitly ABSENT: the point of the ops bot is that it no longer needs
    // this. The fallback gets its own test below.
    delete process.env.BOARD_BOT_TOKEN;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries({
      OPS_ALERT_CHAT_ID: saved.chat,
      OPS_BOT_TOKEN: saved.ops,
      BOARD_BOT_TOKEN: saved.board,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test('opened → one message naming the service, the host, and the runbook', async () => {
    await notifyOpsTransition(OPENED, 'inference-medic', 'trades-box-1', undefined, { send });
    expect(send).toHaveBeenCalledTimes(1);
    const [to, text] = send.mock.calls[0];
    expect(to).toBe('5801703167');
    expect(text).toContain('inference-medic');
    expect(text).toContain('trades-box-1');
    expect(text).toContain('docs/inference-recovery-runbook');
    // No '.md' — Telegram would linkify it into a dead link (2026-08-19 drill).
    expect(text).not.toContain('runbook.md');
  });

  // The route is what makes the alert diagnosable without ssh-ing to the box.
  test('opened → renders the route when the reporter collected one', async () => {
    await notifyOpsTransition(
      OPENED,
      'inference-medic',
      'trades-box-1',
      { route: 'fireworks-prod / accounts/fireworks/routers/glm-5p2-fast' },
      { send },
    );
    expect((send.mock.calls[0])[1]).toContain('route: fireworks-prod');
  });

  // ops-report.sh omits `route` when it ran without the gateway owner's env
  // (its documented HOME trap). A blank "route:" line would look like a bug.
  test('opened → omits the route line entirely when absent or blank', async () => {
    await notifyOpsTransition(OPENED, 'inference-medic', 'box', { route: '   ' }, { send });
    expect((send.mock.calls[0])[1]).not.toContain('route:');
  });

  test('closed → one message with the elapsed minutes', async () => {
    await notifyOpsTransition(CLOSED(12 * 60_000), 'inference-medic', 'box', undefined, { send });
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0])[1]).toContain('12 min');
  });

  // A sub-minute recovery is real — the medic's in-tick retry absorbs one slow
  // probe — and "recovered after 0 min" reads like a broken clock.
  test('closed → says "less than a minute" rather than "0 min"', async () => {
    await notifyOpsTransition(CLOSED(8_000), 'inference-medic', 'box', undefined, { send });
    const text = (send.mock.calls[0])[1];
    expect(text).toContain('less than a minute');
    expect(text).not.toContain('0 min');
  });

  // THE ANTI-SPAM INVARIANT. recordOpsEvent returns `suppressed` for every
  // 5-minute tick during an outage; if those notified, a 30-minute outage would
  // fire six times and the alert would be muted — which is how the alerting gap
  // gets recreated in a new form.
  test('suppressed and noop send NOTHING', async () => {
    await notifyOpsTransition({ action: 'suppressed', incidentId: 'inc-1' }, 's', 'h', undefined, { send });
    await notifyOpsTransition({ action: 'noop' }, 's', 'h', undefined, { send });
    expect(send).not.toHaveBeenCalled();
  });

  test('no OPS_ALERT_CHAT_ID → skips cleanly, no throw', async () => {
    delete process.env.OPS_ALERT_CHAT_ID;
    await expect(
      notifyOpsTransition(OPENED, 'inference-medic', 'box', undefined, { send }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  test('blank OPS_ALERT_CHAT_ID is treated as unset, not sent to ""', async () => {
    process.env.OPS_ALERT_CHAT_ID = '   ';
    await notifyOpsTransition(OPENED, 'inference-medic', 'box', undefined, { send });
    expect(send).not.toHaveBeenCalled();
  });

  test('NEITHER token set → skips cleanly, no throw', async () => {
    delete process.env.OPS_BOT_TOKEN;
    delete process.env.BOARD_BOT_TOKEN;
    await expect(
      notifyOpsTransition(OPENED, 'inference-medic', 'box', undefined, { send }),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  // The transition state: the ops bot does not exist yet in this deploy, so
  // alerting must NOT go dark just because the new env var is unset. Deleting
  // this test is part of retiring the board bot.
  test('no OPS_BOT_TOKEN but BOARD_BOT_TOKEN set → still alerts (fallback)', async () => {
    delete process.env.OPS_BOT_TOKEN;
    process.env.BOARD_BOT_TOKEN = 'legacy-board-token';
    await notifyOpsTransition(OPENED, 'inference-medic', 'box', undefined, { send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  // The whole point: once OPS_BOT_TOKEN exists, the board bot is irrelevant to
  // this path, so retiring it is a config change rather than a deploy.
  test('OPS_BOT_TOKEN alone is enough — no BOARD_BOT_TOKEN needed', async () => {
    expect(process.env.BOARD_BOT_TOKEN).toBeUndefined();
    await notifyOpsTransition(OPENED, 'inference-medic', 'box', undefined, { send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  // It propagates; the HTTP handler is what swallows. Keeping the throw here
  // means a send failure is visible in the server log instead of vanishing.
  test('a failing send REJECTS — the caller owns swallowing it', async () => {
    const boom = vi.fn<Sender>(async () => {
      throw new Error('telegram sendMessage failed: chat not found');
    });
    await expect(
      notifyOpsTransition(OPENED, 'inference-medic', 'box', undefined, { send: boom }),
    ).rejects.toThrow('chat not found');
  });
});
