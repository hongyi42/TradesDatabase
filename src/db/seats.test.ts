import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createTenant, setTenantSeats } from './tenants.js';
import { createHost } from './hosts.js';
import { insertTechnician } from './technicians.js';
import { registerSandbox } from './sandboxPool.js';
import {
  createSeat,
  getSeatByHostRef,
  getSeatByTechnician,
  getSeatIdentityByTokenHash,
  listFreeSeatBots,
  listLiveGlueTechnicianIds,
  listLiveSeatBotIds,
  listPoollessSeatRefs,
  listSeatBotHandles,
  mintSeatToken,
  registerSeatBot,
  retireSeatByHostRef,
  touchSeatPull,
} from './seats.js';

// Integration against the LOCAL stack (pattern: sandboxPool.test.ts). The seat
// record behind step 4's per-seat tokens: live-only reads, the named unique
// indexes that tell a bot race from a person race, token → identity with the
// tenant check an embed does not give for free, and the badge file's
// "no pool sandbox behind this seat" set.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let otherTenantId: string;
let hostId: string;
let otherHostId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query('truncate table seats, seat_bots, sandbox_pool, technicians cascade');
  await setTenantSeats(tenantId, { managerSeats: 1, technicianSeats: 20 });
  otherTenantId = (await createTenant('seats-other', { technicianSeats: 5 })).id;
  hostId = (await createHost('seats-host', 'b'.repeat(64))).id;
  otherHostId = (await createHost('seats-other-host', 'c'.repeat(64))).id;
});

afterAll(async () => {
  await pg.query('truncate table seats, seat_bots, sandbox_pool, technicians cascade');
  await pg.query("delete from hosts where name in ('seats-host', 'seats-other-host')");
  await pg.query("delete from tenants where name = 'seats-other'");
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

describe('seats', () => {
  test('create, live reads, token mint and resolve, rotation', async () => {
    const tech = await insertTechnician({ tenantId, ref: 'seat-a', displayName: 'Seat A' });
    const seat = await createSeat({
      tenantId,
      technicianId: tech.id,
      hostId,
      seatRef: 'g_aaaa0001',
      botRef: null,
    });
    expect((await getSeatByTechnician(tech.id))?.id).toBe(seat.id);
    expect((await getSeatByHostRef(hostId, 'g_aaaa0001'))?.id).toBe(seat.id);
    // Host-scoped: another box never finds this seat by its ref.
    expect(await getSeatByHostRef(otherHostId, 'g_aaaa0001')).toBeNull();

    expect(await getSeatIdentityByTokenHash('1'.repeat(64))).toBeNull();
    const minted = await mintSeatToken(seat.id, '1'.repeat(64));
    expect(minted.token_minted_at).not.toBeNull();
    const who = await getSeatIdentityByTokenHash('1'.repeat(64));
    expect(who).toMatchObject({ technicianRef: 'seat-a', seat: { tenant_id: tenantId } });

    // Rotation: a second mint overwrites — the first fingerprint is dead.
    await mintSeatToken(seat.id, '2'.repeat(64));
    expect(await getSeatIdentityByTokenHash('1'.repeat(64))).toBeNull();
    expect(await getSeatIdentityByTokenHash('2'.repeat(64))).not.toBeNull();

    // A retired seat resolves nothing and frees the person for a new one.
    await pg.query('update seats set retired_at = now() where id = $1', [seat.id]);
    expect(await getSeatIdentityByTokenHash('2'.repeat(64))).toBeNull();
    expect(await getSeatByTechnician(tech.id)).toBeNull();
    await expect(mintSeatToken(seat.id, '3'.repeat(64))).rejects.toThrow(/no live seat/);
  });

  test('named unique indexes: a bot race vs a person who already has a seat', async () => {
    const bot = await registerSeatBot({ hostId, tenantId, botId: '700001', botUsername: '@seat_race_bot' });
    const a = await insertTechnician({ tenantId, ref: 'seat-race-a', displayName: 'A' });
    const b = await insertTechnician({ tenantId, ref: 'seat-race-b', displayName: 'B' });
    await createSeat({ tenantId, technicianId: a.id, hostId, seatRef: 'g_race0001', botRef: bot.id });

    await expect(
      createSeat({ tenantId, technicianId: b.id, hostId, seatRef: 'g_race0002', botRef: bot.id }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'seats_live_bot_key' });
    await expect(
      createSeat({ tenantId, technicianId: a.id, hostId, seatRef: 'g_race0003', botRef: null }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'seats_live_technician_key' });
  });

  test('two tenants: a seat whose person sits in another firm resolves to null', async () => {
    const outsider = await insertTechnician({ tenantId: otherTenantId, ref: 'seat-x', displayName: 'X' });
    // Written raw: no accessor would build this row. The embed does not inherit
    // tenancy, so only getSeatIdentityByTokenHash's own check stops it.
    await pg.query(
      `insert into seats (tenant_id, technician_id, host_id, seat_ref, token_hash)
       values ($1, $2, $3, 'g_xten0001', $4)`,
      [tenantId, outsider.id, hostId, '9'.repeat(64)],
    );
    expect(await getSeatIdentityByTokenHash('9'.repeat(64))).toBeNull();
  });

  test('free bots are firm-or-any, live, unclaimed, oldest first; handles and ids', async () => {
    await pg.query('truncate table seats, seat_bots');
    const own = await registerSeatBot({ hostId, tenantId, botId: '700010', botUsername: '@own_bot' });
    const any = await registerSeatBot({ hostId, tenantId: null, botId: '700011', botUsername: '@any_bot' });
    await registerSeatBot({ hostId, tenantId: otherTenantId, botId: '700012', botUsername: '@theirs_bot' });
    const dead = await registerSeatBot({ hostId, tenantId, botId: '700013', botUsername: '@dead_bot' });
    await pg.query('update seat_bots set retired_at = now() where id = $1', [dead.id]);

    expect((await listFreeSeatBots(tenantId)).map((b) => b.id)).toEqual([own.id, any.id]);

    const tech = await insertTechnician({ tenantId, ref: 'seat-bots-a', displayName: 'A' });
    await createSeat({ tenantId, technicianId: tech.id, hostId, seatRef: 'g_bots0001', botRef: own.id });
    expect((await listFreeSeatBots(tenantId)).map((b) => b.id)).toEqual([any.id]);
    expect((await listSeatBotHandles(tenantId)).get(tech.id)).toBe('@own_bot');
    expect((await listSeatBotHandles(otherTenantId)).size).toBe(0);
    expect((await listLiveSeatBotIds()).sort()).toEqual(['700010', '700011', '700012']);

    await expect(
      registerSeatBot({ hostId, tenantId, botId: '123:ABC', botUsername: '@pasted_token_bot' }),
    ).rejects.toThrow(/numeric id/);

    // A bot a live pool sandbox answers is refused, by id or by handle.
    await registerSandbox({ tenantId, hostId, sandboxRef: 'pool-owned', botUsername: '@pooled_bot', botId: '700099' });
    await expect(
      registerSeatBot({ hostId, tenantId, botId: '700099', botUsername: '@renamed_bot' }),
    ).rejects.toThrow(/pool sandbox pool-owned/);
    await expect(
      registerSeatBot({ hostId, tenantId, botId: null, botUsername: '@POOLED_bot' }),
    ).rejects.toThrow(/pool sandbox pool-owned/); // handles are case-insensitive
  });

  test('retireSeatByHostRef retires only that live seat, and is idempotent', async () => {
    await pg.query('truncate table seats, seat_bots');
    const t = await insertTechnician({ tenantId, ref: 'seat-recycled', displayName: 'Recycled' });
    const seat = await createSeat({ tenantId, technicianId: t.id, hostId, seatRef: 's9', botRef: null });
    await retireSeatByHostRef(otherHostId, 's9'); // another box's s9: untouched
    expect((await getSeatByTechnician(t.id))?.id).toBe(seat.id);
    await retireSeatByHostRef(hostId, 's9');
    await retireSeatByHostRef(hostId, 's9');
    expect(await getSeatByTechnician(t.id)).toBeNull();
  });

  test('pool-less seat refs exclude a seat backed by a live pool sandbox', async () => {
    await pg.query('truncate table seats, seat_bots');
    const backed = await insertTechnician({ tenantId, ref: 'seat-backed', displayName: 'Backed' });
    const bare = await insertTechnician({ tenantId, ref: 'seat-bare', displayName: 'Bare' });
    await registerSandbox({ tenantId, hostId, sandboxRef: 's5' });
    await createSeat({ tenantId, technicianId: backed.id, hostId, seatRef: 's5', botRef: null });
    await createSeat({ tenantId, technicianId: bare.id, hostId, seatRef: 'g_bare0001', botRef: null });
    expect(await listPoollessSeatRefs(hostId)).toEqual(['g_bare0001']);
    expect(await listPoollessSeatRefs(otherHostId)).toEqual([]);
  });
});

// STEP 3: a glue seat's inbox pull stamps it live, and the box's runners skip
// its person while the stamp is fresh.
describe('live glue seats (step 3)', () => {
  test('fresh stamps count; stale, retired and other-host seats do not', async () => {
    const mk = async (ref: string, host: string, seatRef: string) => {
      const t = await insertTechnician({ tenantId, ref, displayName: ref });
      const seat = await createSeat({ tenantId, technicianId: t.id, hostId: host, seatRef, botRef: null });
      return { t, seat };
    };
    const fresh = await mk('live-fresh', hostId, 'g_live0001');
    const stale = await mk('live-stale', hostId, 'g_live0002');
    const retired = await mk('live-retired', hostId, 'g_live0003');
    const elsewhere = await mk('live-elsewhere', otherHostId, 'g_live0004');
    const never = await mk('live-never', hostId, 'g_live0005');

    await touchSeatPull(fresh.seat.id);
    await touchSeatPull(elsewhere.seat.id);
    await touchSeatPull(retired.seat.id);
    await pg.query("update seats set last_pulled_at = now() - interval '5 minutes' where id = $1", [
      stale.seat.id,
    ]);
    await retireSeatByHostRef(hostId, 'g_live0003');

    const since = new Date(Date.now() - 120_000).toISOString();
    const live = await listLiveGlueTechnicianIds(hostId, since);
    expect(live).toContain(fresh.t.id);
    expect(live).not.toContain(stale.t.id);
    expect(live).not.toContain(retired.t.id);
    expect(live).not.toContain(never.t.id);
    expect(live).not.toContain(elsewhere.t.id);
    expect(await listLiveGlueTechnicianIds(otherHostId, since)).toEqual([elsewhere.t.id]);
  });

  test('touching a retired seat stamps nothing', async () => {
    const t = await insertTechnician({ tenantId, ref: 'live-gone', displayName: 'Gone' });
    const seat = await createSeat({ tenantId, technicianId: t.id, hostId, seatRef: 'g_live0006', botRef: null });
    await retireSeatByHostRef(hostId, 'g_live0006');
    await touchSeatPull(seat.id);
    const row = await pg.query('select last_pulled_at from seats where id = $1', [seat.id]);
    expect(row.rows[0].last_pulled_at).toBeNull();
  });
});

describe('listLiveGlueTechnicianIds before the column is migrated', () => {
  test.each(['42703', '42P01'])('%s → [] so the runners keep every item', async (code) => {
    vi.resetModules();
    vi.doMock('./client.js', () => ({
      getClient: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              is: () => ({ gte: async () => ({ data: null, error: { code, message: 'missing' } }) }),
            }),
          }),
        }),
      }),
    }));
    const { listLiveGlueTechnicianIds: fresh } = await import('./seats.js');
    expect(await fresh('h', new Date().toISOString())).toEqual([]);
    vi.doUnmock('./client.js');
  });
});

describe('listLiveSeatBotIds when the table is not migrated yet', () => {
  test.each(['42P01', 'PGRST205'])('%s → [] (schema behind code), never a throw', async (code) => {
    vi.resetModules();
    vi.doMock('./client.js', () => ({
      getClient: () => ({
        from: () => ({
          select: () => ({
            not: () => ({ is: async () => ({ data: null, error: { code, message: 'missing' } }) }),
          }),
        }),
      }),
    }));
    const { listLiveSeatBotIds: fresh } = await import('./seats.js');
    expect(await fresh()).toEqual([]);
    vi.doUnmock('./client.js');
  });
});
