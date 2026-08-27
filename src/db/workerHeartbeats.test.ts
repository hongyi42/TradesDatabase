import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { recordHeartbeat } from './workerHeartbeats.js';

// Integration against the local stack (pattern: opsEvents.test.ts). Heartbeats
// are infrastructure rows, so this suite deletes exactly what it creates.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const SERVICE = 'test-worker';

// node-postgres decodes timestamptz to a Date, NOT to a string — so these must
// be compared by getTime(), never by identity. `toBe` on two equal Dates fails
// with the memorably useless "expected <iso> to be <iso>".
interface Row {
  service: string;
  beat_at: Date;
  last_ok_at: Date | null;
  work_at: Date | null;
  detail: Record<string, unknown>;
}

const ms = (d: Date | null): number | null => (d === null ? null : d.getTime());

async function read(): Promise<Row | null> {
  const { rows } = await pg.query<Row>('select * from worker_heartbeats where service = $1', [
    SERVICE,
  ]);
  return rows[0] ?? null;
}

async function wipe() {
  await pg.query('delete from worker_heartbeats where service like $1', ['test-%']);
}

beforeAll(async () => {
  await pg.connect();
  await wipe();
});
afterAll(async () => {
  await wipe();
  await pg.end();
});
beforeEach(wipe);

describe('recordHeartbeat', () => {
  test('a first healthy beat writes all three timestamps', async () => {
    await recordHeartbeat({ service: SERVICE, ok: true, didWork: true, detail: { sent: 2 } });
    const row = await read();
    expect(row).not.toBeNull();
    expect(row!.beat_at).not.toBeNull();
    expect(row!.last_ok_at).not.toBeNull();
    expect(row!.work_at).not.toBeNull();
    expect(row!.detail).toEqual({ sent: 2 });
  });

  test('an idle-but-healthy beat leaves work_at alone', async () => {
    await recordHeartbeat({ service: SERVICE, ok: true, didWork: true });
    const first = await read();
    await recordHeartbeat({ service: SERVICE, ok: true, didWork: false });
    const second = await read();
    // The loop ran again and succeeded, but sent nothing — which is the normal
    // state most of the day. work_at must still point at the last REAL work.
    expect(ms(second!.work_at)).toBe(ms(first!.work_at));
    expect(ms(second!.last_ok_at)!).toBeGreaterThanOrEqual(ms(first!.last_ok_at)!);
  });

  test('a FAILING beat advances beat_at but never last_ok_at', async () => {
    // The whole reason this table has three columns. A worker whose poll throws
    // every tick keeps cycling, so beat_at keeps moving; if a failure also
    // refreshed last_ok_at, that outage would read as perfectly healthy and the
    // monitor would never fire.
    await recordHeartbeat({ service: SERVICE, ok: true, didWork: false });
    const healthy = await read();
    await new Promise((r) => setTimeout(r, 15));
    await recordHeartbeat({ service: SERVICE, ok: false, didWork: false, detail: { sent: 0 } });
    const failing = await read();

    expect(ms(failing!.beat_at)!).toBeGreaterThan(ms(healthy!.beat_at)!);
    expect(ms(failing!.last_ok_at)).toBe(ms(healthy!.last_ok_at));
  });

  test('a failure before any success leaves last_ok_at NULL, not now()', async () => {
    // "Never succeeded" and "succeeded a while ago" are different states. Writing
    // a timestamp here would invent a success that never happened.
    await recordHeartbeat({ service: SERVICE, ok: false });
    const row = await read();
    expect(row!.last_ok_at).toBeNull();
    expect(row!.work_at).toBeNull();
  });

  test('an illegal service name is refused before it reaches the database', async () => {
    // Same rule as ops_events' SERVICE_RE, and the reason it exists: when this
    // lived only server-side, box-report.sh sent 17 reports that were all
    // rejected 400 and silently discarded while the script logged success.
    for (const bad of ['board:worker', 'Board_Worker', 'box.disk', '', 'a'.repeat(65)]) {
      await expect(recordHeartbeat({ service: bad, ok: true })).rejects.toThrow(/invalid service/);
    }
    expect(await read()).toBeNull();
  });
});
