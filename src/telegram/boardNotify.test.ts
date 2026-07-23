import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';

// Stub the Bot API boundary BEFORE importing the notifier — pollOnce must
// never touch the network; everything else (events, assignments, roster) is
// the real local stack driven through the real booking verbs.
vi.mock('./boardBot.js', () => ({
  sendBoardMessage: vi.fn().mockResolvedValue(undefined),
  setBoardMenuButton: vi.fn().mockResolvedValue(undefined),
}));

import { sendBoardMessage } from './boardBot.js';
import { pollOnce } from './boardNotify.js';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician, updateTechnician } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import { bookVisit, cancelVisit, moveVisit } from '../schedule/booking.js';

const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items, schedule_events cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let customerId: string;
const sends = vi.mocked(sendBoardMessage);
// One cursor map across the whole suite — exactly how the worker holds it.
const lastSeen = new Map<string, number>();

const sentTo = () => sends.mock.calls.map(([userId, text]) => ({ userId, text }));

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });

  const n1 = await insertTechnician({ tenantId, ref: 'notify-n1', displayName: 'Nina One' });
  await updateTechnician(n1.id, { telegram_user_id: '910000001', state: 'active' });
  const n2 = await insertTechnician({ tenantId, ref: 'notify-n2', displayName: 'Noah Two' });
  await updateTechnician(n2.id, { telegram_user_id: '910000002', state: 'active' });
  await insertTechnician({ tenantId, ref: 'notify-n3', displayName: 'Unbound Uma' });

  customerId = (await createCustomer({ tenantId, name: 'Notify Casa' })).id;
});

afterAll(async () => {
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

beforeEach(async () => {
  // Drain anything a previous test left pending, so every test starts with a
  // seeded, current cursor — no order dependency, safe under .only/-t filters
  // (the first drain doubles as the boot-time seeding).
  await pollOnce(lastSeen);
  sends.mockClear();
});

const book = (args: { technicianRef?: string; date: string; startTime: string; endTime: string }) =>
  bookVisit({
    tenantId,
    customerId,
    title: 'Notify probe visit',
    actorRef: 'notify-mgr',
    ...args,
  });

describe('pollOnce', () => {
  test('first sight seeds at the current version — pre-boot events never notify', async () => {
    // A FRESH map models a worker boot: the event exists before first sight,
    // so the poll seeds the cursor and sends nothing. Self-contained — the
    // suite's shared cursor is not involved.
    await book({ technicianRef: 'notify-n1', date: '2026-10-01', startTime: '09:00', endTime: '10:00' });
    const bootMap = new Map<string, number>();
    expect(await pollOnce(bootMap)).toBe(0);
    expect(sends).not.toHaveBeenCalled();
    expect(bootMap.get(tenantId)).toBeGreaterThan(0); // seeded, not skipped
  });

  test('a booking notifies exactly the booked technician once; the next poll is silent', async () => {
    await book({ technicianRef: 'notify-n1', date: '2026-10-02', startTime: '09:00', endTime: '10:00' });
    expect(await pollOnce(lastSeen)).toBe(1);
    expect(sentTo()).toEqual([
      { userId: '910000001', text: 'New visit on your schedule: 2026-10-02, 09:00–10:00.' },
    ]);
    sends.mockClear();
    expect(await pollOnce(lastSeen)).toBe(0); // cursor advanced
    expect(sends).not.toHaveBeenCalled();
  });

  test('an UNASSIGNED booking notifies nobody and does not throw; an unbound technician stays silent', async () => {
    await book({ date: '2026-10-03', startTime: '09:00', endTime: '10:00' }); // no technicianRef
    await book({ technicianRef: 'notify-n3', date: '2026-10-03', startTime: '11:00', endTime: '12:00' });
    expect(await pollOnce(lastSeen)).toBe(0);
    expect(sends).not.toHaveBeenCalled();
  });

  test('a same-person move sends ONE moved message, not an add + a remove', async () => {
    const { assignment } = await book({
      technicianRef: 'notify-n1',
      date: '2026-10-06',
      startTime: '09:00',
      endTime: '10:00',
    });
    await pollOnce(lastSeen); // drain the booked event
    sends.mockClear();
    await moveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-10-07',
      startTime: '10:00',
      reason: 'shifted a day',
      actorRef: 'notify-mgr',
    });
    expect(await pollOnce(lastSeen)).toBe(1);
    expect(sentTo()).toEqual([
      { userId: '910000001', text: 'Your visit moved: 2026-10-06 → 2026-10-07, now 10:00–11:00.' },
    ]);
  });

  test('a reassignment notifies BOTH: the new person (landed) and the displaced one (taken off)', async () => {
    const { assignment } = await book({
      technicianRef: 'notify-n1',
      date: '2026-10-08',
      startTime: '09:00',
      endTime: '10:00',
    });
    await pollOnce(lastSeen);
    sends.mockClear();
    await moveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-10-08',
      startTime: '09:00',
      technicianRef: 'notify-n2',
      reason: 'coverage swap',
      actorRef: 'notify-mgr',
    });
    expect(await pollOnce(lastSeen)).toBe(2);
    const pushes = sentTo();
    expect(pushes).toHaveLength(2);
    expect(pushes).toContainEqual({
      userId: '910000002',
      text: 'A visit landed on your schedule: 2026-10-08, 09:00–10:00.',
    });
    expect(pushes).toContainEqual({
      userId: '910000001',
      text: 'Your 2026-10-08 visit was moved off your schedule.',
    });
  });

  test('a DETACH (unassign) notifies exactly the displaced person — nobody on the person-less new row', async () => {
    const { assignment } = await book({
      technicianRef: 'notify-n1',
      date: '2026-10-12',
      startTime: '09:00',
      endTime: '10:00',
    });
    await pollOnce(lastSeen); // drain the booked event
    sends.mockClear();
    await moveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-10-12',
      startTime: '09:00',
      unassign: true,
      reason: 'pulled to an emergency',
      actorRef: 'notify-mgr',
    });
    expect(await pollOnce(lastSeen)).toBe(1);
    expect(sentTo()).toEqual([
      { userId: '910000001', text: 'Your 2026-10-12 visit was moved off your schedule.' },
    ]);
  });

  test('a send failure never blocks LATER sends in the same poll, and the cursor still advances', async () => {
    const a = await book({
      technicianRef: 'notify-n1',
      date: '2026-10-09',
      startTime: '09:00',
      endTime: '10:00',
    });
    const b = await book({
      technicianRef: 'notify-n2',
      date: '2026-10-09',
      startTime: '11:00',
      endTime: '12:00',
    });
    await pollOnce(lastSeen);
    sends.mockClear();
    await cancelVisit({
      tenantId,
      assignmentId: a.assignment.id,
      reason: 'customer away',
      actorRef: 'notify-mgr',
    });
    await cancelVisit({
      tenantId,
      assignmentId: b.assignment.id,
      reason: 'customer away too',
      actorRef: 'notify-mgr',
    });
    // The FIRST delivery blows up (blocked bot) — best-effort means the second
    // event's message still goes out AND the failed one is never resent.
    sends.mockRejectedValueOnce(new Error('Forbidden: bot was blocked by the user'));
    expect(await pollOnce(lastSeen)).toBe(1);
    expect(sends).toHaveBeenCalledTimes(2);
    expect(sentTo()[1]).toEqual({
      userId: '910000002',
      text: 'Your 2026-10-09 visit was cancelled.',
    });
    sends.mockClear();
    expect(await pollOnce(lastSeen)).toBe(0); // no wedged cursor, no resend
    expect(sends).not.toHaveBeenCalled();
  });

  test('a deactivated (offboarding) technician receives NOTHING even while still Telegram-bound', async () => {
    const { assignment } = await book({
      technicianRef: 'notify-n2',
      date: '2026-10-10',
      startTime: '09:00',
      endTime: '10:00',
    });
    await pollOnce(lastSeen);
    sends.mockClear();
    // Deactivation revokes access but does NOT clear telegram_user_id — the
    // standard next step (reassigning their visits) must not message them.
    await pg.query("update technicians set state = 'offboarding' where ref = 'notify-n2'");
    await moveVisit({
      tenantId,
      assignmentId: assignment.id,
      date: '2026-10-10',
      startTime: '09:00',
      technicianRef: 'notify-n1',
      reason: 'offboarding coverage',
      actorRef: 'notify-mgr',
    });
    expect(await pollOnce(lastSeen)).toBe(1);
    // Only the NEW person hears about it; the revoked ex-employee is silent.
    expect(sentTo()).toEqual([
      { userId: '910000001', text: 'A visit landed on your schedule: 2026-10-10, 09:00–10:00.' },
    ]);
    await pg.query("update technicians set state = 'active' where ref = 'notify-n2'");
  });
});
