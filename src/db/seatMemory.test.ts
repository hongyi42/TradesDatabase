import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { MEMORY_VERSIONS_KEPT } from './plannerMemory.js';
import {
  deleteSeatMemoryFile,
  listSeatMemoryPaths,
  readSeatMemoryFile,
  writeSeatMemoryFile,
} from './seatMemory.js';

// Writes through the app path (supabase-js); direct pg is the independent
// read-back channel and the cleanup (the plannerMemory.test.ts convention).
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

const versions = async (ref: string, path: string) =>
  Number(
    (
      await pg.query(
        'select count(*)::int n from seat_memory_versions where tenant_id = $1 and technician_ref = $2 and path = $3',
        [tenantId, ref, path],
      )
    ).rows[0].n,
  );

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').eq('name', 'Default Tenant').single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

beforeEach(async () => {
  await pg.query('truncate table seat_memory, seat_memory_versions');
});

afterAll(async () => {
  await pg.query('truncate table seat_memory, seat_memory_versions');
  await pg.end();
});

describe('seat memory — per person', () => {
  test('round trip, and each person sees only their own notes', async () => {
    await writeSeatMemoryFile(tenantId, 'mgr-a', 'prefs.md', 'Invoices due in 14 days.');
    await writeSeatMemoryFile(tenantId, 'mgr-b', 'prefs.md', 'Invoices due on receipt.');
    expect((await readSeatMemoryFile(tenantId, 'mgr-a', 'prefs.md'))?.content).toBe('Invoices due in 14 days.');
    expect((await readSeatMemoryFile(tenantId, 'mgr-b', 'prefs.md'))?.content).toBe('Invoices due on receipt.');
    expect(await listSeatMemoryPaths(tenantId, 'mgr-a')).toEqual(['prefs.md']);
    expect(await readSeatMemoryFile(tenantId, 'mgr-c', 'prefs.md')).toBeNull();
  });

  test('an overwrite keeps the previous content as a version; an unchanged rewrite keeps none', async () => {
    await writeSeatMemoryFile(tenantId, 'mgr-a', 'prefs.md', 'one');
    await writeSeatMemoryFile(tenantId, 'mgr-a', 'prefs.md', 'two');
    await writeSeatMemoryFile(tenantId, 'mgr-a', 'prefs.md', 'two');
    expect(await versions('mgr-a', 'prefs.md')).toBe(1);
    const row = await pg.query(
      'select content from seat_memory_versions where tenant_id = $1 and technician_ref = $2',
      [tenantId, 'mgr-a'],
    );
    expect(row.rows[0].content).toBe('one');
  });

  test("one person's rewrites never prune another person's versions", async () => {
    await writeSeatMemoryFile(tenantId, 'mgr-b', 'prefs.md', 'b0');
    await writeSeatMemoryFile(tenantId, 'mgr-b', 'prefs.md', 'b1'); // b keeps one version
    for (let i = 0; i <= MEMORY_VERSIONS_KEPT + 3; i++) {
      await writeSeatMemoryFile(tenantId, 'mgr-a', 'prefs.md', `a${i}`);
    }
    expect(await versions('mgr-a', 'prefs.md')).toBe(MEMORY_VERSIONS_KEPT);
    expect(await versions('mgr-b', 'prefs.md')).toBe(1);
  });

  test('delete keeps the last content as a version and answers whether there was one', async () => {
    await writeSeatMemoryFile(tenantId, 'mgr-a', 'todo.md', 'call Tom');
    expect(await deleteSeatMemoryFile(tenantId, 'mgr-a', 'todo.md')).toBe(true);
    expect(await readSeatMemoryFile(tenantId, 'mgr-a', 'todo.md')).toBeNull();
    expect(await versions('mgr-a', 'todo.md')).toBe(1);
    expect(await deleteSeatMemoryFile(tenantId, 'mgr-a', 'todo.md')).toBe(false);
  });
});
