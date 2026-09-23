import { describe, expect, test, vi } from 'vitest';
import { drainOneMessagePing } from './messagePing.js';
import { PINGED_MESSAGE_KINDS, type OfficeMessage } from '../db/index.js';

// Rung 10c: the observation ping loop's mirror, for a seat's message. Same
// rules: never run two passes for one row, never die on a bad one, never claim
// when it cannot run, never release a claim it has acted on.
const msg = (over: Partial<OfficeMessage> = {}): OfficeMessage =>
  ({
    id: 'msg-1',
    tenant_id: 'tenant-1',
    direction: 'to_planner',
    kind: 'inform',
    from_ref: 'ben-shelton',
    to_ref: 'spine:team-lead',
    body: 'route all job messages to Sam',
    status: 'unread',
    pinged_at: null,
    created_at: '2026-09-07T10:00:00.000Z',
    ...over,
  }) as unknown as OfficeMessage;

describe('drainOneMessagePing (rung 10c)', () => {
  // The loop is gated on "could a focused pass run at all" BEFORE it claims
  // anything — see the gate's own comment for why. Every test here supplies
  // that answer explicitly rather than depending on the process environment.
  const canRun = { blocked: () => null };
  test('an empty queue is idle, and nothing is claimed or run', async () => {
    let claims = 0;
    let passes = 0;
    const out = await drainOneMessagePing({
      ...canRun,
      list: async () => [],
      claim: async () => {
        claims += 1;
        return null;
      },
      pass: async () => {
        passes += 1;
      },
    });
    expect(out).toBe('idle');
    expect(claims).toBe(0);
    expect(passes).toBe(0);
  });

  test('one row: claimed, then the focused pass runs for the CLAIMED row', async () => {
    const row = msg();
    const claimed = msg({ pinged_at: '2026-09-07T10:00:05.000Z' });
    const seen: OfficeMessage[] = [];
    const out = await drainOneMessagePing({
      ...canRun,
      list: async () => [row],
      claim: async () => claimed,
      pass: async (o) => {
        seen.push(o);
      },
    });
    expect(out).toBe('pinged');
    // The CLAIMED row, not the one the read returned: the claim is the write
    // that decides which process owns it, and its return is the current row.
    expect(seen).toEqual([claimed]);
  });

  test("the pass's summary is printed — turns and refusals were thrown away before", async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const summary = { plans: [{ turns: 4, refusals: [{ tool: 'submit_plan', text: 'error: no', count: 3, firstTurn: 1 }] }] };
      await drainOneMessagePing({
        ...canRun,
        list: async () => [msg()],
        claim: async () => msg({ pinged_at: '2026-09-07T10:00:05.000Z' }),
        pass: async () => summary,
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toBe(`[calls:message-ping] focused pass msg-1 ${JSON.stringify(summary)}`);
    } finally {
      log.mockRestore();
    }
  });

  test('a lost claim runs nothing — another worker already has the row', async () => {
    let passes = 0;
    const out = await drainOneMessagePing({
      ...canRun,
      list: async () => [msg()],
      // Guarded on `pinged_at is null`: null means somebody else won.
      claim: async () => null,
      pass: async () => {
        passes += 1;
      },
    });
    expect(out).toBe('idle');
    expect(passes).toBe(0);
  });

  test('a throwing pass is swallowed, and the row is claimed exactly once', async () => {
    let claims = 0;
    const out = await drainOneMessagePing({
      ...canRun,
      list: async () => [msg()],
      claim: async () => {
        claims += 1;
        return msg({ pinged_at: '2026-09-07T10:00:05.000Z' });
      },
      pass: async () => {
        throw new Error('the model provider is down');
      },
    });
    // Never rethrown: one firm's bad row must not kill the worker's loop.
    expect(out).toBe('error');
    // Claimed once, and NOT released — this module has no release path at all,
    // deliberately: re-running a pass that may already have texted a manager is
    // worse than not running it. The half-hourly heartbeat shows the row again,
    // and the ASK marker (not the ping marker) is what stops a second text.
    expect(claims).toBe(1);
  });

  test('a blocked worker claims NOTHING — an un-releasable claim must never be made', async () => {
    // The severe failure this gate exists for: a worker deployed before its
    // env lands would otherwise drain the queue stamping every call "the
    // planner was called about it" while calling nobody, and nothing releases a
    // claim — so those calls fall back to the half-hourly cadence PERMANENTLY,
    // and setting the variable later does not recover them.
    let listed = 0;
    let claims = 0;
    const out = await drainOneMessagePing({
      blocked: () => 'no inference credentials',
      list: async () => {
        listed += 1;
        return [msg()];
      },
      claim: async () => {
        claims += 1;
        return msg();
      },
    });
    expect(out).toBe('idle');
    expect(listed).toBe(0);
    expect(claims).toBe(0);
  });

  test('a failing READ is swallowed too', async () => {
    const out = await drainOneMessagePing({
      ...canRun,
      list: async () => {
        throw new Error('database down');
      },
    });
    expect(out).toBe('error');
  });

  test('the reader is asked for ONE row of the kinds that wake — informs only', async () => {
    const args: unknown[][] = [];
    await drainOneMessagePing({
      ...canRun,
      list: async (...a) => {
        args.push(a);
        return [];
      },
    });
    expect(args).toEqual([[PINGED_MESSAGE_KINDS, 1]]);
    expect(PINGED_MESSAGE_KINDS).toEqual(['inform']);
  });
});
