import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  MEMORY_VERSIONS_KEPT,
  deleteMemoryFile,
  listMemoryPaths,
  readMemoryFile,
  writeMemoryFile,
} from './plannerMemory.js';

// Writes go through the app path (supabase-js); direct pg is the INDEPENDENT
// read-back channel and the cleanup — the tenantProfiles/tenantSettings
// convention. A version count read through the same client that wrote it would
// only prove the client agrees with itself.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

beforeEach(async () => {
  // Hermetic start per test: a crashed run skips afterAll, and a surviving row
  // would flip the first write onto the overwrite path and archive a version
  // the test never asked for.
  await pg.query('truncate table planner_memory, planner_memory_versions');
});

afterAll(async () => {
  await pg.query('truncate table planner_memory, planner_memory_versions');
  await pg.end();
});

async function versionsOf(path: string): Promise<string[]> {
  const { rows } = await pg.query(
    `select content from planner_memory_versions
      where tenant_id = $1 and path = $2 order by replaced_at desc`,
    [tenantId, path],
  );
  return rows.map((r) => r.content as string);
}

describe('planner memory', () => {
  test('a write round-trips through a read', async () => {
    await writeMemoryFile(tenantId, 'MEMORY.md', '# index\n- firm/pacing.md');
    const row = await readMemoryFile(tenantId, 'MEMORY.md');
    expect(row?.content).toBe('# index\n- firm/pacing.md');
    // The row, not just the text: the operator console prints updated_at, and
    // returning it here is why no second accessor exists for it.
    expect(row?.updated_at).toBeTruthy();
  });

  test('reading a path that was never written is null, not an error', async () => {
    expect(await readMemoryFile(tenantId, 'nothing/here.md')).toBeNull();
  });

  test('an overwrite keeps the PREVIOUS content as a version', async () => {
    await writeMemoryFile(tenantId, 'firm/pacing.md', 'first');
    await writeMemoryFile(tenantId, 'firm/pacing.md', 'second');
    expect((await readMemoryFile(tenantId, 'firm/pacing.md'))?.content).toBe('second');
    // ONE version, holding the OLD text — not the new one. Archiving the
    // incoming content instead would make the history useless and the test pass
    // on the count alone.
    expect(await versionsOf('firm/pacing.md')).toEqual(['first']);
  });

  test('the first write of a path archives nothing', async () => {
    await writeMemoryFile(tenantId, 'firm/pacing.md', 'first');
    expect(await versionsOf('firm/pacing.md')).toEqual([]);
  });

  test(`versions stop accumulating at ${MEMORY_VERSIONS_KEPT}, oldest first`, async () => {
    // The first write archives nothing, so N writes leave N-1 versions: the 11th
    // is exactly the write that FILLS the quota, and the 12th is the first one
    // that has to evict.
    for (let i = 1; i <= MEMORY_VERSIONS_KEPT + 1; i += 1) {
      await writeMemoryFile(tenantId, 'firm/pacing.md', `v${i}`);
    }
    const full = await versionsOf('firm/pacing.md');
    expect(full).toHaveLength(MEMORY_VERSIONS_KEPT);
    expect(full).toContain('v1');

    await writeMemoryFile(tenantId, 'firm/pacing.md', 'v12');
    const kept = await versionsOf('firm/pacing.md');
    expect(kept).toHaveLength(MEMORY_VERSIONS_KEPT);
    // v1 is the one that falls off; v11 (the content v12 replaced) is now the
    // newest version. Pruning from the wrong end would keep the same COUNT, so
    // the count alone proves nothing.
    expect(kept[0]).toBe('v11');
    expect(kept).not.toContain('v1');
    expect(kept).toContain('v2');
  });

  test('pruning is per path — a busy file does not evict a quiet one', async () => {
    await writeMemoryFile(tenantId, 'quiet.md', 'q1');
    await writeMemoryFile(tenantId, 'quiet.md', 'q2');
    for (let i = 1; i <= MEMORY_VERSIONS_KEPT + 3; i += 1) {
      await writeMemoryFile(tenantId, 'busy.md', `b${i}`);
    }
    expect(await versionsOf('quiet.md')).toEqual(['q1']);
    expect(await versionsOf('busy.md')).toHaveLength(MEMORY_VERSIONS_KEPT);
  });

  test('rewriting a file with IDENTICAL content keeps no version', async () => {
    // Reconcile-first tells the planner to revisit its notes every tick and
    // nothing brakes how often it rewrites (user, 2026-08-30). Archiving an
    // unchanged save would fill all ten slots with identical text in a few
    // hours, so the day-old revision somebody wants back is already evicted —
    // and "every overwrite is versioned" is the reason the dispatch gate admits
    // this write verb at all.
    await writeMemoryFile(tenantId, 'firm/pacing.md', 'same');
    await writeMemoryFile(tenantId, 'firm/pacing.md', 'same');
    await writeMemoryFile(tenantId, 'firm/pacing.md', 'same');
    expect(await versionsOf('firm/pacing.md')).toEqual([]);
    // …and a REAL change still versions.
    await writeMemoryFile(tenantId, 'firm/pacing.md', 'different');
    expect(await versionsOf('firm/pacing.md')).toEqual(['same']);
  });

  test('a delete versions the content, then removes the file', async () => {
    await writeMemoryFile(tenantId, 'firm/pacing.md', 'last words');
    expect(await deleteMemoryFile(tenantId, 'firm/pacing.md')).toBe(true);
    expect(await readMemoryFile(tenantId, 'firm/pacing.md')).toBeNull();
    expect(await versionsOf('firm/pacing.md')).toEqual(['last words']);
  });

  test('deleting a path that does not exist answers false, and is not an error', async () => {
    expect(await deleteMemoryFile(tenantId, 'never/written.md')).toBe(false);
  });

  test('listMemoryPaths is path-ordered, not insertion-ordered', async () => {
    // All-lowercase paths on purpose: MEMORY.md's position depends on the
    // database's collation (en_US sorts it AFTER 'alpha/…', a C locale before),
    // and pinning that here would be testing the container's locale rather than
    // this query's ORDER BY.
    await writeMemoryFile(tenantId, 'zeta.md', 'z');
    await writeMemoryFile(tenantId, 'mid.md', 'm');
    await writeMemoryFile(tenantId, 'alpha/one.md', 'a');
    expect(await listMemoryPaths(tenantId)).toEqual(['alpha/one.md', 'mid.md', 'zeta.md']);
  });

  test('listMemoryPaths is tenant-scoped', async () => {
    await writeMemoryFile(tenantId, 'mine.md', 'x');
    const { rows } = await pg.query(
      `insert into tenants (name) values ('memory-scope-probe') returning id`,
    );
    const other = rows[0].id as string;
    try {
      await writeMemoryFile(other, 'theirs.md', 'y');
      expect(await listMemoryPaths(tenantId)).toEqual(['mine.md']);
      expect(await listMemoryPaths(other)).toEqual(['theirs.md']);
    } finally {
      await pg.query('delete from tenants where id = $1', [other]);
    }
  });

  test('the DATABASE refuses a path the shape rule forbids', async () => {
    // The last line, not the only one: validateMemoryPath in src/teamLead/
    // mirrors this for an instructive error. This asserts the backstop holds
    // even when a caller skips that.
    for (const bad of ['Memory.md', '../escape.md', 'notes.txt', 'x.md\nMEMORY.md']) {
      await expect(writeMemoryFile(tenantId, bad, 'x')).rejects.toThrow();
    }
    expect(await listMemoryPaths(tenantId)).toEqual([]);
  });

  test('ACL posture: RLS on, anon/authenticated hold zero privileges on all three tables', async () => {
    // The planner_lessons test this replaces (lessons.test.ts, deleted in Phase
    // 3) is the precedent, and the reason is the same but sharper here:
    // planner_memory.content is rendered into the planner's prompt, so a write
    // reachable with the publishable key is direct prompt injection into the
    // thing that decides what gets sent to a firm's technicians.
    // supabase/config.toml still sets auto_expose_new_tables = true, so this is
    // a live hazard for every new table, not a hypothetical.
    for (const table of ['planner_memory', 'planner_memory_versions', 'planner_runs']) {
      const rls = await pg.query(`select relrowsecurity from pg_class where relname = $1`, [table]);
      expect(rls.rows[0]?.relrowsecurity, `${table} RLS`).toBe(true);
      const priv = await pg.query(
        `select has_table_privilege('anon', $1, 'SELECT') as a_sel,
                has_table_privilege('anon', $1, 'INSERT') as a_ins,
                has_table_privilege('anon', $1, 'UPDATE') as a_upd,
                has_table_privilege('anon', $1, 'DELETE') as a_del,
                has_table_privilege('authenticated', $1, 'SELECT') as u_sel,
                has_table_privilege('authenticated', $1, 'INSERT') as u_ins,
                has_table_privilege('authenticated', $1, 'UPDATE') as u_upd,
                has_table_privilege('authenticated', $1, 'DELETE') as u_del`,
        [`public.${table}`],
      );
      expect(Object.values(priv.rows[0]).some(Boolean), `${table} grants`).toBe(false);
    }
  });

  test('deleting the tenant takes its memory AND its versions with it', async () => {
    const { rows } = await pg.query(
      `insert into tenants (name) values ('memory-cascade-probe') returning id`,
    );
    const doomed = rows[0].id as string;
    await writeMemoryFile(doomed, 'a.md', 'one');
    await writeMemoryFile(doomed, 'a.md', 'two');
    await pg.query('delete from tenants where id = $1', [doomed]);
    // The versions FK is the point: without it these rows would outlive the firm
    // forever, holding its text.
    const left = await pg.query(
      `select (select count(*) from planner_memory where tenant_id = $1) as files,
              (select count(*) from planner_memory_versions where tenant_id = $1) as versions`,
      [doomed],
    );
    expect(left.rows[0]).toEqual({ files: '0', versions: '0' });
  });
});
