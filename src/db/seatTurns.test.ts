import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createHost } from './hosts.js';
import { createSeat } from './seats.js';
import { insertSeatTurns, pruneSeatTurns, searchSeatTurns, type SeatTurnInsert } from './seatTurns.js';
import { createTenant, setTenantSeats } from './tenants.js';
import { insertTechnician } from './technicians.js';

// Integration against the LOCAL stack. A glue seat's uploaded conversation:
// idempotent inserts, a read scoped to ONE person in ONE firm, and the prune.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let otherTenantId: string;
let hostId: string;
let ben: { tech: string; seat: string };
let sam: { tech: string; seat: string };
let otherFirm: { tech: string; seat: string };

const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function turn(who: { tech: string; seat: string }, over: Partial<SeatTurnInsert> = {}, tenant = tenantId): SeatTurnInsert {
  return {
    id: randomUUID(),
    tenantId: tenant,
    technicianId: who.tech,
    seatId: who.seat,
    sessionId: 's5-1',
    at: new Date().toISOString(),
    role: 'person',
    text: 'the Smith freezer needed a new fan',
    tool: null,
    args: null,
    ok: null,
    ...over,
  };
}

beforeAll(async () => {
  await pg.connect();
  const { data } = await getClient().from('tenants').select('id').eq('name', 'Default Tenant').single();
  tenantId = data!.id;
  await pg.query('truncate table seat_turns, seats, technicians cascade');
  await setTenantSeats(tenantId, { managerSeats: 1, technicianSeats: 10 });
  otherTenantId = (await createTenant('seat-turns-other', { technicianSeats: 5 })).id;
  hostId = (await createHost('seat-turns-host', 'e'.repeat(64))).id;
  const mk = async (tenant: string, ref: string, seatRef: string) => {
    const t = await insertTechnician({ tenantId: tenant, ref, displayName: ref });
    const s = await createSeat({ tenantId: tenant, technicianId: t.id, hostId, seatRef, botRef: null });
    return { tech: t.id, seat: s.id };
  };
  ben = await mk(tenantId, 'turns-ben', 'g_turns001');
  sam = await mk(tenantId, 'turns-sam', 'g_turns002');
  otherFirm = await mk(otherTenantId, 'turns-other', 'g_turns003');
});

afterAll(async () => {
  await pg.query('truncate table seat_turns, seats, technicians cascade');
  await pg.query("delete from hosts where name = 'seat-turns-host'");
  await pg.query("delete from tenants where name = 'seat-turns-other'");
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

describe('seat_turns', () => {
  test('an insert is idempotent on id', async () => {
    const t = turn(ben);
    expect(await insertSeatTurns([t])).toBe(1);
    expect(await insertSeatTurns([t])).toBe(0);
    expect((await pg.query('select count(*)::int as n from seat_turns where id = $1', [t.id])).rows[0].n).toBe(1);
  });

  test("the read is ONE person's, in ONE firm, newest first, inside the window", async () => {
    await pg.query('truncate table seat_turns');
    await insertSeatTurns([
      turn(ben, { text: 'old news', at: daysAgo(10) }),
      turn(ben, { text: 'yesterday at the Smiths', at: daysAgo(1) }),
      turn(ben, { role: 'assistant', text: 'Got that recorded.', at: daysAgo(0.5) }),
      turn(sam, { text: 'Sam said something' }),
      turn(otherFirm, {}, otherTenantId),
    ]);
    const got = await searchSeatTurns({ tenantId, technicianId: ben.tech, days: 7, limit: 20 });
    expect(got.map((r) => r.text)).toEqual(['Got that recorded.', 'yesterday at the Smiths']);
    // Another firm's tenant id never reads Ben's rows, even with his person id.
    expect(await searchSeatTurns({ tenantId: otherTenantId, technicianId: ben.tech, days: 30, limit: 20 })).toEqual([]);
  });

  test('words match text or a tool name; LIKE wildcards in the words are literal', async () => {
    await pg.query('truncate table seat_turns');
    await insertSeatTurns([
      turn(ben, { text: 'parts came to 100% of the quote, (roughly)' }),
      turn(ben, { text: 'parts came to 100 dollars' }),
      turn(ben, { role: 'tool', text: null, tool: 'record_field_note', args: { jobId: 'j1' }, ok: true }),
    ]);
    const pct = await searchSeatTurns({ tenantId, technicianId: ben.tech, query: '100%', days: 7, limit: 20 });
    expect(pct.map((r) => r.text)).toEqual(['parts came to 100% of the quote, (roughly)']);
    const comma = await searchSeatTurns({ tenantId, technicianId: ben.tech, query: 'quote, (roughly', days: 7, limit: 20 });
    expect(comma).toHaveLength(1);
    const tool = await searchSeatTurns({ tenantId, technicianId: ben.tech, query: 'field_note', days: 7, limit: 20 });
    expect(tool.map((r) => r.tool)).toEqual(['record_field_note']);
    expect(tool[0].args).toEqual({ jobId: 'j1' });
  });

  test('the prune deletes only rows older than the cutoff and counts them', async () => {
    await pg.query('truncate table seat_turns');
    await insertSeatTurns([turn(ben, { at: daysAgo(100) }), turn(ben, { at: daysAgo(95) }), turn(ben, { at: daysAgo(3) })]);
    expect(await pruneSeatTurns(daysAgo(90))).toBe(2);
    expect((await pg.query('select count(*)::int as n from seat_turns')).rows[0].n).toBe(1);
  });
});
