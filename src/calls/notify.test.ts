import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Stub the DB boundary BEFORE importing the notifier — this unit must never
// touch it. Only the two symbols notify.ts actually imports. The Bot API is no
// longer one of its boundaries: since one-bot phase 2 the notice is QUEUED and
// the box delivers it through the manager's own assistant, so there is no
// network call left here to stub.
vi.mock('../db/index.js', () => ({
  listManagersWithTelegram: vi.fn(),
  queuePersonPush: vi.fn(),
}));

import { notifyManagers } from './notify.js';
import { listManagersWithTelegram, queuePersonPush } from '../db/index.js';
import type { Technician } from '../db/index.js';

const sends = vi.mocked(queuePersonPush);
const listManagers = vi.mocked(listManagersWithTelegram);

// Minimal manager shapes — notifyManagers reads the binding (to skip the
// unbound) and the id (to address the queue row).
const managers = (...ids: Array<string | null>): Technician[] =>
  ids.map((id) => ({ id: `tech-${id}`, telegram_user_id: id }) as unknown as Technician);

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // silence best-effort logs
});
afterEach(() => {
  errSpy.mockRestore();
});

describe('notifyManagers', () => {
  test('pushes to each bound manager, skips the one with no telegram_user_id', async () => {
    listManagers.mockResolvedValue(managers('910000001', null));
    sends.mockResolvedValue(undefined as never);

    await notifyManagers('T1', 'a review needs you');

    expect(sends).toHaveBeenCalledTimes(1); // the null-binding manager is skipped
    expect(sends).toHaveBeenCalledWith({
      tenantId: 'T1',
      technicianId: 'tech-910000001',
      kind: 'call',
      body: 'a review needs you',
    });
  });

  test('a failing send does NOT reject notifyManagers, and other managers still get theirs', async () => {
    listManagers.mockResolvedValue(managers('910000001', '910000002'));
    sends
      .mockRejectedValueOnce(new Error('queue write failed'))
      .mockResolvedValueOnce(undefined as never);

    await expect(notifyManagers('T1', 'hi')).resolves.toBeUndefined();
    expect(sends).toHaveBeenCalledTimes(2); // one failure never suppresses the rest
  });

  test('a failing manager lookup does NOT reject notifyManagers (best-effort)', async () => {
    listManagers.mockRejectedValue(new Error('db unavailable'));

    await expect(notifyManagers('T1', 'hi')).resolves.toBeUndefined();
    expect(sends).not.toHaveBeenCalled();
  });
});
