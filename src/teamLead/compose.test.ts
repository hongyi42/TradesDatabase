import { describe, expect, test, vi } from 'vitest';
import type { Nudge } from '../db/index.js';
import { handToManager } from './compose.js';

// What is left of compose after the collapse (plan 2026-08-24) and the window's
// deletion (plan 2026-08-29 Phase 3): `handToManager` alone — the rung-2 fallback
// for a gap that dies without its ask ever landing.
//
// The four `insideAskWindow` boundary assertions that stood here are DELETED, not
// ported. Their subject no longer exists: there is no hour at which the planner
// declines to act (user, 2026-08-29). What replaced the window is a per-firm
// CADENCE, which is a different claim entirely — how often the planner thinks,
// never whether a message may go out — and it is tested where it lives, in
// planner.test.ts.

describe('handToManager — the rung-2 fallback for an ask that never landed', () => {
  const nudge = (over: Partial<Nudge> = {}): Nudge =>
    ({
      id: 'n1',
      tenant_id: 't1',
      kind: 'overdue_visit_gap',
      subject_ref: 'a1',
      status: 'pending',
      context: {
        customerName: 'Henderson',
        jobTitle: 'Furnace tune-up',
        technicianName: 'Ben Shelton',
        technicianRef: 'ben-shelton',
        jobId: 'job-1',
        startsAtLocal: '2026-08-15T09:00:00',
        endsAtLocal: '2026-08-15T11:00:00',
      },
      ...over,
    }) as Nudge;

  test('flags the gap with the EXPIRED copy and reports that it landed', async () => {
    const seen: Record<string, unknown>[] = [];
    const flagNudge = vi.fn(async (arg: unknown) => {
      seen.push(arg as Record<string, unknown>);
      return { id: 'item-1' } as never;
    });
    const exists = vi.fn(async () => false);
    expect(await handToManager(nudge(), flagNudge as never, exists as never)).toBe(true);
    expect(flagNudge).toHaveBeenCalledTimes(1);
    const arg = seen[0];
    expect(arg.escalatedFromNudge).toBe('n1');
    // The ask never went out, so the manager must never be told that it did.
    expect(String(arg.suggestion)).not.toMatch(/assistant asked/i);
  });

  test('a null flag means "already flagged" ONLY when the probe confirms it', async () => {
    const flagNudge = vi.fn(async () => null as never);
    expect(await handToManager(nudge(), flagNudge as never, (async () => true) as never)).toBe(true);
    expect(await handToManager(nudge(), flagNudge as never, (async () => false) as never)).toBe(
      false,
    );
  });

  test('a row too thin to build a plan is refused, never guessed around', async () => {
    const flagNudge = vi.fn(async () => ({ id: 'item-1' }) as never);
    const thin = nudge({ context: {} as never });
    expect(await handToManager(thin, flagNudge as never, (async () => false) as never)).toBe(false);
    expect(flagNudge).not.toHaveBeenCalled();
  });

  test('an unregistered kind cannot be handed over', async () => {
    const flagNudge = vi.fn(async () => ({ id: 'item-1' }) as never);
    const alien = nudge({ kind: 'not_a_kind' as never });
    expect(await handToManager(alien, flagNudge as never, (async () => false) as never)).toBe(
      false,
    );
    expect(flagNudge).not.toHaveBeenCalled();
  });
});

// The `flatten` describe that stood here went with the function itself (build 3,
// plan 2026-08-30): its last production callers were lessons.ts and reflector.ts,
// both deleted. The trust boundary it guarded still exists — it is
// `escapeForPrompt` in src/teamLead/memory.ts, tested in memory.test.ts, and it
// KEEPS newlines rather than collapsing them, because a memory file is a
// document and a delivered message is one line.
