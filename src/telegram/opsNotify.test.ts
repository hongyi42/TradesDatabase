import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { notifyOpsTransition } from './opsNotify.js';
import type { OpsOutcome } from '../db/opsEvents.js';
import type { Technician } from '../db/index.js';

// Unit test for the ops alert. Every case drives the injected deps, so nothing
// here reaches Telegram OR the database — since 2026-09-17 the alert is QUEUED
// as a person_push and the box delivers it through the operator's own
// assistant, so the boundary to fake is the queue, not the Bot API.
//
// OPS_ALERT_TELEGRAM_IDS is set EXPLICITLY rather than inherited from .env: the
// skip branches are the behaviour under test, and a test that passes only
// because the developer's .env happens to be shaped a certain way is not a test.

const OPENED: OpsOutcome = { action: 'opened', incidentId: 'inc-1' };
const CLOSED = (openMs: number): OpsOutcome => ({ action: 'closed', incidentId: 'inc-1', openMs });

const tech = (id: string, tenantId = 'T1') =>
  ({ id, tenant_id: tenantId, state: 'active' }) as unknown as Technician;

type Queue = (input: {
  tenantId: string;
  technicianId: string;
  kind: 'schedule' | 'call' | 'ops';
  body: string;
}) => Promise<unknown>;
type Find = (
  telegramUserId: string,
) => Promise<{ technician: Technician } | { ambiguous: true; tenantIds: string[] } | null>;

describe('notifyOpsTransition', () => {
  let queue: ReturnType<typeof vi.fn<Queue>>;
  let findRoster: ReturnType<typeof vi.fn<Find>>;
  const saved = process.env.OPS_ALERT_TELEGRAM_IDS;
  let errSpy: ReturnType<typeof vi.spyOn>;

  const deps = () => ({ queue, findRoster }) as never;

  beforeEach(() => {
    queue = vi.fn<Queue>(async () => ({}));
    findRoster = vi.fn<Find>(async () => ({ technician: tech('tech-op') }));
    process.env.OPS_ALERT_TELEGRAM_IDS = '8639645984';
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.OPS_ALERT_TELEGRAM_IDS;
    else process.env.OPS_ALERT_TELEGRAM_IDS = saved;
    errSpy.mockRestore();
  });

  test('opened → one ops row naming the service, the host, and the runbook', async () => {
    await notifyOpsTransition(OPENED, 'inference-medic', 'trades-box-1', undefined, deps());
    expect(queue).toHaveBeenCalledTimes(1);
    const row = queue.mock.calls[0][0];
    expect(row.kind).toBe('ops');
    expect(row.tenantId).toBe('T1');
    expect(row.technicianId).toBe('tech-op');
    expect(row.body).toContain('inference-medic');
    expect(row.body).toContain('trades-box-1');
    expect(row.body).toContain('docs/inference-recovery-runbook');
    // Not a Telegram-linkifiable ".md" — a dead link mid-incident is the worst
    // thing to hand someone (2026-08-19 drill).
    expect(row.body).not.toContain('runbook.md');
  });

  test('route from detail is rendered when present', async () => {
    await notifyOpsTransition(OPENED, 'svc', 'box', { route: 'openrouter/glm-5.3' }, deps());
    expect(queue.mock.calls[0][0].body).toContain('route: openrouter/glm-5.3');
  });

  test('closed → a recovery row with the elapsed time', async () => {
    await notifyOpsTransition(CLOSED(9 * 60_000), 'svc', 'box', undefined, deps());
    expect(queue.mock.calls[0][0].body).toContain('recovered after 9 min');
  });

  test('a sub-minute recovery reads as words, not "0 min"', async () => {
    await notifyOpsTransition(CLOSED(20_000), 'svc', 'box', undefined, deps());
    expect(queue.mock.calls[0][0].body).toContain('less than a minute');
  });

  // The anti-spam invariant: an outage notifies once, not once per 5-min tick.
  test.each(['suppressed', 'noop'] as const)('%s is not a transition → nothing queued', async (a) => {
    await notifyOpsTransition({ action: a } as unknown as OpsOutcome, 'svc', 'box', undefined, deps());
    expect(queue).not.toHaveBeenCalled();
  });

  test('no OPS_ALERT_TELEGRAM_IDS → skips cleanly, no roster read, no throw', async () => {
    delete process.env.OPS_ALERT_TELEGRAM_IDS;
    await expect(
      notifyOpsTransition(OPENED, 'svc', 'box', undefined, deps()),
    ).resolves.toBeUndefined();
    expect(findRoster).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  test('blank / comma-only value is treated as unset', async () => {
    process.env.OPS_ALERT_TELEGRAM_IDS = ' , ,  ';
    await notifyOpsTransition(OPENED, 'svc', 'box', undefined, deps());
    expect(queue).not.toHaveBeenCalled();
  });

  test('several ids → one row each', async () => {
    process.env.OPS_ALERT_TELEGRAM_IDS = '111, 222';
    findRoster
      .mockResolvedValueOnce({ technician: tech('tech-a', 'TA') })
      .mockResolvedValueOnce({ technician: tech('tech-b', 'TB') });
    await notifyOpsTransition(OPENED, 'svc', 'box', undefined, deps());
    expect(queue).toHaveBeenCalledTimes(2);
    expect(queue.mock.calls.map((c) => c[0].technicianId)).toEqual(['tech-a', 'tech-b']);
  });

  test('an id matching no live roster row is skipped, not thrown', async () => {
    findRoster.mockResolvedValue(null);
    await expect(
      notifyOpsTransition(OPENED, 'svc', 'box', undefined, deps()),
    ).resolves.toBeUndefined();
    expect(queue).not.toHaveBeenCalled();
  });

  // Two people really do share a Telegram id on this pilot, so the global
  // lookup refuses rather than guessing. An ops alert must not land in the
  // wrong person's chat.
  test('an AMBIGUOUS id is refused, not guessed', async () => {
    findRoster.mockResolvedValue({ ambiguous: true, tenantIds: ['T1', 'T2'] });
    await notifyOpsTransition(OPENED, 'svc', 'box', undefined, deps());
    expect(queue).not.toHaveBeenCalled();
  });

  // One unresolvable operator must not silence the others.
  test('a bad id does not suppress the remaining operators', async () => {
    process.env.OPS_ALERT_TELEGRAM_IDS = 'bad, good';
    findRoster
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ technician: tech('tech-good', 'TG') });
    await notifyOpsTransition(OPENED, 'svc', 'box', undefined, deps());
    expect(queue).toHaveBeenCalledTimes(1);
    expect(queue.mock.calls[0][0].technicianId).toBe('tech-good');
  });

  // It propagates; the HTTP handler is what swallows. Keeping the throw here
  // means a queue failure is visible in the server log instead of vanishing.
  test('a failing queue write REJECTS — the caller owns swallowing it', async () => {
    queue.mockRejectedValue(new Error('queuePersonPush failed: 23514'));
    await expect(
      notifyOpsTransition(OPENED, 'svc', 'box', undefined, deps()),
    ).rejects.toThrow('23514');
  });
});
