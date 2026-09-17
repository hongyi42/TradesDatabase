import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';

// No Bot API stub is needed any more: pollOnce stopped touching the network
// when one-bot phase 2 made it QUEUE a person_push instead of sending, and
// boardBot.ts is gone entirely as of 2026-09-17. Everything here (events,
// assignments, roster) is the real local stack driven through the real
// booking verbs.
// Spy-wrap the db barrel the notifier imports from (originals still run) so a
// test can inject a TRANSIENT resolution failure mid-batch — the cursor-hold
// contract is unreachable otherwise.
vi.mock('../db/index.js', { spy: true });

import { pollOnce } from './boardNotify.js';
import { getVisitForTenant, queuePersonPush } from '../db/index.js';
import { getVisitForTenant as realGetAssignmentForTenant } from '../db/visits.js';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import { insertTechnician, updateTechnician } from '../db/technicians.js';
import { createCustomer } from '../db/customers.js';
import type { Json } from '../db/database.types.js';
import { bookVisit, unscheduleVisit, moveVisit } from '../schedule/booking.js';

const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items, schedule_events cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let customerId: string;
// The notifier QUEUES now (one-bot phase 2) rather than calling the Bot API:
// the box delivers through each person's own assistant. What these tests assert
// is unchanged — who was told what — so the queue write is read back through
// the same shape, with the technician id resolved to the Telegram id the
// assertions have always named.
const sends = vi.mocked(queuePersonPush);
// One cursor map across the whole suite — exactly how the worker holds it.
const lastSeen = new Map<string, number>();
const telegramByTechId = new Map<string, string>();

const sentTo = () =>
  sends.mock.calls.map(([args]) => ({
    userId: telegramByTechId.get(args.technicianId) ?? args.technicianId,
    text: args.body,
  }));

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
  telegramByTechId.set(n1.id, '910000001');
  const n2 = await insertTechnician({ tenantId, ref: 'notify-n2', displayName: 'Noah Two' });
  await updateTechnician(n2.id, { telegram_user_id: '910000002', state: 'active' });
  telegramByTechId.set(n2.id, '910000002');
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

const book = (args: {
  technicianRef?: string;
  technicianRefs?: string[];
  date: string;
  startTime: string;
  endTime: string;
  eventDetailExtra?: Json;
}) =>
  bookVisit({
    tenantId,
    customerId,
    title: 'Notify probe visit',
    // Every probe visit is its own job by design; the shared title would
    // otherwise trip the customerId mint guard on the second call.
    forceNewJob: true,
    actorRef: 'notify-mgr',
    ...args,
  });

// Books `count` back-to-back one-hour visits for one person on one day — the
// shape of a burst. Sequential, so event order is fixed. (It took an
// `eventDetailExtra` to stamp a batch-run identity onto the rows; run
// attribution died with the solver, rung 8, and nothing read it after that.)
const burst = async (technicianRef: string, date: string, count: number): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await book({
      technicianRef,
      date,
      startTime: `${String(5 + i).padStart(2, '0')}:00`,
      endTime: `${String(6 + i).padStart(2, '0')}:00`,
    });
  }
};

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

  test('an UNPLACED booking push renders the day and "time not set", never undefined (plan 4b-2)', async () => {
    await bookVisit({
      tenantId,
      customerId,
      title: 'Notify tbd visit',
      technicianRef: 'notify-n1',
      actorRef: 'notify-mgr',
    });
    expect(await pollOnce(lastSeen)).toBe(1);
    expect(sentTo()).toEqual([
      { userId: '910000001', text: 'New visit on your schedule: no time set yet.' },
    ]);
    expect(sentTo()[0].text).not.toContain('undefined');
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
      visitId: assignment.id,
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
      visitId: assignment.id,
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
      visitId: assignment.id,
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
    await unscheduleVisit({
      tenantId,
      visitId: a.assignment.id,
      reason: 'customer away',
      actorRef: 'notify-mgr',
    });
    await unscheduleVisit({
      tenantId,
      visitId: b.assignment.id,
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
      visitId: assignment.id,
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

  test('a burst to one person collapses into ONE digest; a bystander single stays a single', async () => {
    await burst('notify-n1', '2026-11-02', 4);
    await book({ technicianRef: 'notify-n2', date: '2026-11-02', startTime: '09:30', endTime: '10:30' });
    expect(await pollOnce(lastSeen)).toBe(2); // one digest + one single, not 5
    const pushes = sentTo();
    expect(pushes).toHaveLength(2);
    const toN1 = pushes.find((p) => p.userId === '910000001');
    const toN2 = pushes.find((p) => p.userId === '910000002');
    expect(toN1?.text).toContain('Your schedule changed — 4 updates:');
    expect(toN1?.text).toContain('• New visit on your schedule: 2026-11-02, 05:00–06:00.');
    expect(toN1?.text).toContain('• New visit on your schedule: 2026-11-02, 08:00–09:00.');
    // The bystander's lone message is untouched by a colleague's burst.
    expect(toN2?.text).toBe('New visit on your schedule: 2026-11-02, 09:30–10:30.');
  });

  test('exactly the threshold count (3) still sends as singles — the boundary is MORE than 3', async () => {
    await burst('notify-n1', '2026-11-03', 3);
    expect(await pollOnce(lastSeen)).toBe(3);
    for (const p of sentTo()) {
      expect(p.userId).toBe('910000001');
      expect(p.text).toMatch(/^New visit on your schedule: 2026-11-03/);
      expect(p.text).not.toContain('•');
    }
  });

  test('a huge digest caps its bullet list and counts the remainder (Telegram length guard)', async () => {
    await burst('notify-n1', '2026-11-06', 14);
    expect(await pollOnce(lastSeen)).toBe(1);
    const [push] = sentTo();
    expect(push.text).toContain('Your schedule changed — 14 updates:');
    expect(push.text.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(12);
    expect(push.text).toContain('…and 2 more — open the board for the full list.');
  });

  test('a mid-batch resolution failure sends what resolved, holds the cursor, and resends nothing', async () => {
    await book({ technicianRef: 'notify-n1', date: '2026-11-09', startTime: '08:00', endTime: '09:00' });
    await book({ technicianRef: 'notify-n2', date: '2026-11-09', startTime: '10:00', endTime: '11:00' });
    await book({ technicianRef: 'notify-n1', date: '2026-11-09', startTime: '12:00', endTime: '13:00' });
    // The first event resolves for real; the SECOND event's row lookup dies (a
    // transient DB blip); the third is never reached this tick.
    vi.mocked(getVisitForTenant)
      .mockImplementationOnce(realGetAssignmentForTenant)
      .mockImplementationOnce(async () => {
        throw new Error('transient db blip');
      });
    expect(await pollOnce(lastSeen)).toBe(1); // only the first event's push went out
    expect(sentTo()).toEqual([
      { userId: '910000001', text: 'New visit on your schedule: 2026-11-09, 08:00–09:00.' },
    ]);
    sends.mockClear();
    // Next tick the blip is gone: the two held events deliver, and the
    // already-sent first one does NOT repeat.
    expect(await pollOnce(lastSeen)).toBe(2);
    const texts = sentTo().map((p) => p.text);
    expect(texts).toContain('New visit on your schedule: 2026-11-09, 10:00–11:00.');
    expect(texts).toContain('New visit on your schedule: 2026-11-09, 12:00–13:00.');
    expect(texts).not.toContain('New visit on your schedule: 2026-11-09, 08:00–09:00.');
  });

});

// ── Rung 9c: a crew visit tells everyone on it ──────────────────────────────
describe('pollOnce with a crew', () => {
  test('a booked crew gets ONE push each — the same trip, told to both', async () => {
    await book({
      technicianRefs: ['notify-n1', 'notify-n2'],
      date: '2026-12-10',
      startTime: '09:00',
      endTime: '10:00',
    });
    expect(await pollOnce(lastSeen)).toBe(2);
    expect(sentTo().sort((a, b) => a.userId.localeCompare(b.userId))).toEqual([
      { userId: '910000001', text: 'New visit on your schedule: 2026-12-10, 09:00–10:00.' },
      { userId: '910000002', text: 'New visit on your schedule: 2026-12-10, 09:00–10:00.' },
    ]);
  });

  test('a reassignment tells the leaver and the joiner, and the stayer hears it ONCE', async () => {
    const booked = await book({
      technicianRefs: ['notify-n1', 'notify-n2'],
      date: '2026-12-11',
      startTime: '09:00',
      endTime: '10:00',
    });
    await pollOnce(lastSeen); // drain the booking pushes
    sends.mockClear();
    // Nina stays and the trip moves; Noah comes off.
    await moveVisit({
      tenantId,
      visitId: booked.assignment.id,
      date: '2026-12-11',
      startTime: '14:00',
      technicianRefs: ['notify-n1'],
      reason: 'noah is out',
      actorRef: 'notify-mgr',
    });
    expect(await pollOnce(lastSeen)).toBe(2);
    const sent = sentTo().sort((a, b) => a.userId.localeCompare(b.userId));
    // The stayer gets ONE "moved", not an add plus a remove.
    expect(sent).toEqual([
      { userId: '910000001', text: 'Your visit moved: 2026-12-11 → 2026-12-11, now 14:00–15:00.' },
      { userId: '910000002', text: 'Your 2026-12-11 visit was moved off your schedule.' },
    ]);
  });

  test('a joiner is told the visit landed on their schedule', async () => {
    const booked = await book({
      technicianRef: 'notify-n1',
      date: '2026-12-12',
      startTime: '09:00',
      endTime: '10:00',
    });
    await pollOnce(lastSeen);
    sends.mockClear();
    await moveVisit({
      tenantId,
      visitId: booked.assignment.id,
      date: '2026-12-12',
      startTime: '09:00',
      technicianRefs: ['notify-n1', 'notify-n2'],
      reason: 'send noah too',
      actorRef: 'notify-mgr',
    });
    expect(await pollOnce(lastSeen)).toBe(2);
    const sent = sentTo().sort((a, b) => a.userId.localeCompare(b.userId));
    expect(sent[0].text).toBe('Your visit moved: 2026-12-12 → 2026-12-12, now 09:00–10:00.');
    expect(sent[1]).toEqual({
      userId: '910000002',
      text: 'A visit landed on your schedule: 2026-12-12, 09:00–10:00.',
    });
  });

  test('a cancelled crew visit is told to everyone on it', async () => {
    const booked = await book({
      technicianRefs: ['notify-n1', 'notify-n2'],
      date: '2026-12-13',
      startTime: '09:00',
      endTime: '10:00',
    });
    await pollOnce(lastSeen);
    sends.mockClear();
    await unscheduleVisit({
      tenantId,
      visitId: booked.assignment.id,
      reason: 'customer called it off',
      actorRef: 'notify-mgr',
    });
    expect(await pollOnce(lastSeen)).toBe(2);
    expect(sentTo().map((s) => s.userId).sort()).toEqual(['910000001', '910000002']);
    expect(sentTo()[0].text).toBe('Your 2026-12-13 visit was cancelled.');
  });

  test('HISTORICAL events still resolve: the rung-9b singular previousTechnicianId', async () => {
    // schedule_events is append-only, so every `moved` event written before
    // rung 9c is permanent and names its predecessor the OLD way. Losing either
    // fallback means the person who lost a visit silently stops being told.
    const booked = await book({
      technicianRef: 'notify-n1',
      date: '2026-12-14',
      startTime: '09:00',
      endTime: '10:00',
    });
    await pollOnce(lastSeen);
    sends.mockClear();
    // A hand-written event in the rung-9b shape: singular previousTechnicianId.
    const n1 = await pg.query<{ id: string }>(
      `select id from technicians where tenant_id = $1 and ref = 'notify-n1'`,
      [tenantId],
    );
    await pg.query(
      `insert into schedule_events (tenant_id, assignment_id, kind, actor_ref, detail)
       values ($1, $2, 'moved', 'notify-mgr', $3::jsonb)`,
      [
        tenantId,
        booked.assignment.id,
        JSON.stringify({
          fromDay: '2026-12-14',
          toDay: '2026-12-14',
          previousTechnicianId: n1.rows[0].id,
        }),
      ],
    );
    expect(await pollOnce(lastSeen)).toBe(1);
    // Nina is on it before AND after → one "moved", from the SINGULAR key.
    expect(sentTo()).toEqual([
      { userId: '910000001', text: 'Your visit moved: 2026-12-14 → 2026-12-14, now 09:00–10:00.' },
    ]);
  });

  test('HISTORICAL events still resolve: the PRE-9b predecessor row id', async () => {
    // The oldest vintage: before rung 9b a move cancelled one row and minted
    // another, so the event named the PREDECESSOR ROW and the person had to be
    // read off it. Those rows are permanent (schedule_events is append-only),
    // and this is the one fallback nothing else exercises — without it the
    // person who lost such a visit silently stops being told.
    const moved = await book({
      technicianRef: 'notify-n1',
      date: '2026-12-15',
      startTime: '09:00',
      endTime: '10:00',
    });
    const predecessor = await book({
      technicianRef: 'notify-n2',
      date: '2026-12-15',
      startTime: '11:00',
      endTime: '12:00',
    });
    await pollOnce(lastSeen);
    sends.mockClear();
    await pg.query(
      `insert into schedule_events (tenant_id, assignment_id, kind, actor_ref, detail)
       values ($1, $2, 'moved', 'notify-mgr', $3::jsonb)`,
      [
        tenantId,
        moved.assignment.id,
        JSON.stringify({
          fromDay: '2026-12-15',
          toDay: '2026-12-15',
          previousAssignmentId: predecessor.assignment.id,
        }),
      ],
    );
    expect(await pollOnce(lastSeen)).toBe(2);
    const sent = sentTo().sort((a, b) => a.userId.localeCompare(b.userId));
    // Nina holds the moved visit; Noah is read off the PREDECESSOR row and told
    // it left his schedule.
    expect(sent).toEqual([
      { userId: '910000001', text: 'A visit landed on your schedule: 2026-12-15, 09:00–10:00.' },
      { userId: '910000002', text: 'Your 2026-12-15 visit was moved off your schedule.' },
    ]);
  });
});
