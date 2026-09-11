import { describe, expect, test, vi } from 'vitest';
import { drainOneObservationPing } from './observationPing.js';
import type { Observation } from '../db/index.js';

// The ping loop is the whole reason a committed call reaches a manager in
// seconds rather than on the half hour, so what it must never do matters as
// much as what it does: never run two passes for one row, never die on a bad
// one, and never release a claim it has already acted on.
const obs = (over: Partial<Observation> = {}): Observation =>
  ({
    id: 'obs-1',
    tenant_id: 'tenant-1',
    kind: 'inbound_commitment',
    subject_ref: 'cap-1',
    technician_id: null,
    author: 'detector',
    context: {},
    status: 'open',
    dismiss_reason: null,
    dismissed_at: null,
    not_before: null,
    pinged_at: null,
    asked_at: null,
    noticed_at: '2026-09-07T10:00:00.000Z',
    updated_at: '2026-09-07T10:00:00.000Z',
    ...over,
  }) as unknown as Observation;

describe('drainOneObservationPing (rung 10)', () => {
  // The loop is gated on "could a focused pass run at all" BEFORE it claims
  // anything — see the gate's own comment for why. Every test here supplies
  // that answer explicitly rather than depending on the process environment.
  const canRun = { blocked: () => null };
  test('an empty queue is idle, and nothing is claimed or run', async () => {
    let claims = 0;
    let passes = 0;
    const out = await drainOneObservationPing({
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
    const row = obs();
    const claimed = obs({ pinged_at: '2026-09-07T10:00:05.000Z' });
    const seen: Observation[] = [];
    const out = await drainOneObservationPing({
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
      await drainOneObservationPing({
        ...canRun,
        list: async () => [obs()],
        claim: async () => obs({ pinged_at: '2026-09-07T10:00:05.000Z' }),
        pass: async () => summary,
      });
      expect(log).toHaveBeenCalledTimes(1);
      expect(log.mock.calls[0][0]).toBe(`[calls:ping] focused pass obs-1 ${JSON.stringify(summary)}`);
    } finally {
      log.mockRestore();
    }
  });

  test('a lost claim runs nothing — another worker already has the row', async () => {
    let passes = 0;
    const out = await drainOneObservationPing({
      ...canRun,
      list: async () => [obs()],
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
    const out = await drainOneObservationPing({
      ...canRun,
      list: async () => [obs()],
      claim: async () => {
        claims += 1;
        return obs({ pinged_at: '2026-09-07T10:00:05.000Z' });
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
    const out = await drainOneObservationPing({
      blocked: () => 'no inference credentials',
      list: async () => {
        listed += 1;
        return [obs()];
      },
      claim: async () => {
        claims += 1;
        return obs();
      },
    });
    expect(out).toBe('idle');
    expect(listed).toBe(0);
    expect(claims).toBe(0);
  });

  test('a failing READ is swallowed too', async () => {
    const out = await drainOneObservationPing({
      ...canRun,
      list: async () => {
        throw new Error('database down');
      },
    });
    expect(out).toBe('error');
  });
});
