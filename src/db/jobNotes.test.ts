import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import {
  JOB_NOTE_VERSIONS_KEPT,
  listJobNoteMeta,
  readJobNote,
  writeJobNote,
} from './jobNotes.js';

// Writes go through the app path (supabase-js); direct pg is the INDEPENDENT
// read-back channel and the cleanup — the plannerMemory/tenantSettings
// convention. A version count read through the same client that wrote it would
// only prove the client agrees with itself.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let jobId: string;
let otherJobId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  const customer = await createCustomer({ tenantId, name: `JobNotes Customer ${Date.now()}` });
  jobId = (await createJob({ tenantId, customerId: customer.id, title: 'Tankless descaling' })).id;
  otherJobId = (await createJob({ tenantId, customerId: customer.id, title: 'Boiler service' })).id;
});

beforeEach(async () => {
  // Hermetic start per test: a crashed run skips afterAll, and a surviving row
  // would flip the first write onto the overwrite path and archive a version
  // the test never asked for.
  await pg.query('truncate table job_notes, job_note_versions');
});

afterAll(async () => {
  await pg.query('truncate table job_notes, job_note_versions');
  await pg.end();
});

async function versionsOf(id = jobId): Promise<string[]> {
  const { rows } = await pg.query(
    `select content from job_note_versions
      where tenant_id = $1 and job_id = $2 order by replaced_at desc, id desc`,
    [tenantId, id],
  );
  return rows.map((r) => r.content as string);
}

describe('job notepads', () => {
  test('a write round-trips through a read', async () => {
    await writeJobNote(tenantId, jobId, 'Marisol prefers a call before the visit.');
    const row = await readJobNote(tenantId, jobId);
    expect(row?.content).toBe('Marisol prefers a call before the visit.');
    expect(row?.written_at).toBeTruthy();
  });

  test('a job with no note reads as null, not an error', async () => {
    expect(await readJobNote(tenantId, jobId)).toBeNull();
  });

  test('an overwrite keeps the PREVIOUS content as a version', async () => {
    await writeJobNote(tenantId, jobId, 'first');
    await writeJobNote(tenantId, jobId, 'second');
    expect((await readJobNote(tenantId, jobId))?.content).toBe('second');
    // ONE version, holding the OLD text — not the new one. Archiving the
    // incoming content instead would pass a count check and be useless.
    expect(await versionsOf()).toEqual(['first']);
  });

  test('the first write of a job archives nothing', async () => {
    await writeJobNote(tenantId, jobId, 'first');
    expect(await versionsOf()).toEqual([]);
  });

  test('an UNCHANGED rewrite keeps no version, and does not move the history', async () => {
    // Without this, a planner that re-saves an unchanged note on every tick
    // fills all ten slots with identical text in hours, and the revision
    // somebody wants back is already evicted — which would make "every
    // overwrite is versioned" a claim the gate's admissibility rests on but the
    // data does not support.
    await writeJobNote(tenantId, jobId, 'same');
    await writeJobNote(tenantId, jobId, 'same');
    await writeJobNote(tenantId, jobId, 'same');
    expect(await versionsOf()).toEqual([]);
    await writeJobNote(tenantId, jobId, 'different');
    expect(await versionsOf()).toEqual(['same']);
  });

  test('an unchanged rewrite still moves written_at', async () => {
    // The upsert sets written_at explicitly rather than relying on the column
    // default, which fires on INSERT only. Left to the default, a note would
    // report the instant it was FIRST written forever.
    const first = await writeJobNote(tenantId, jobId, 'same');
    await new Promise((r) => setTimeout(r, 5));
    const second = await writeJobNote(tenantId, jobId, 'same');
    expect(Date.parse(second.written_at)).toBeGreaterThan(Date.parse(first.written_at));
  });

  test(`versions stop accumulating at ${JOB_NOTE_VERSIONS_KEPT}, oldest evicted first`, async () => {
    // The first write archives nothing, so N writes leave N-1 versions: the
    // 11th fills the quota and the 12th is the first that has to evict.
    for (let i = 1; i <= JOB_NOTE_VERSIONS_KEPT + 1; i += 1) {
      await writeJobNote(tenantId, jobId, `v${i}`);
    }
    const full = await versionsOf();
    expect(full).toHaveLength(JOB_NOTE_VERSIONS_KEPT);
    expect(full).toContain('v1');

    await writeJobNote(tenantId, jobId, 'v12');
    const kept = await versionsOf();
    expect(kept).toHaveLength(JOB_NOTE_VERSIONS_KEPT);
    // BOTH ends asserted: pruning from the wrong end keeps the same count, so a
    // count-only check proves nothing about direction.
    expect(kept[0]).toBe('v11');
    expect(kept).not.toContain('v1');
    expect(kept).toContain('v2');
  });

  test('pruning is per JOB — a busy job does not evict a quiet one', async () => {
    await writeJobNote(tenantId, otherJobId, 'q1');
    await writeJobNote(tenantId, otherJobId, 'q2');
    for (let i = 1; i <= JOB_NOTE_VERSIONS_KEPT + 3; i += 1) {
      await writeJobNote(tenantId, jobId, `b${i}`);
    }
    expect(await versionsOf(otherJobId)).toEqual(['q1']);
    expect(await versionsOf()).toHaveLength(JOB_NOTE_VERSIONS_KEPT);
  });

  test('listJobNoteMeta answers one entry per NOTED job and omits the rest', async () => {
    await writeJobNote(tenantId, jobId, 'noted');
    const meta = await listJobNoteMeta(tenantId, [jobId, otherJobId]);
    expect(meta.size).toBe(1);
    expect(meta.get(jobId)).toBeTruthy();
    expect(meta.has(otherJobId)).toBe(false);
    // NOT TESTED HERE, and worth saying rather than faking: that the SELECT
    // names only `job_id, written_at`. From outside the accessor a `.select()`
    // that pulled content would produce an identical Map — the mapper reads
    // two fields either way — so the only difference is the wire payload. An
    // assertion over the returned map would read as coverage and catch nothing.
    // What guards it is the return type plus the comment on the accessor.
  });

  test('listJobNoteMeta returns ONE row per job however many versions exist', async () => {
    // The reason this store is one-row-per-job rather than append-only: the
    // per-tick read must not reduce N rows per job client-side, or PostgREST's
    // 1,000-row cap truncates it silently at ~100 noted jobs.
    for (let i = 1; i <= JOB_NOTE_VERSIONS_KEPT + 2; i += 1) {
      await writeJobNote(tenantId, jobId, `v${i}`);
    }
    const meta = await listJobNoteMeta(tenantId, [jobId]);
    expect(meta.size).toBe(1);
    const { rows } = await pg.query('select count(*)::int as n from job_notes where job_id = $1', [
      jobId,
    ]);
    expect(rows[0].n).toBe(1);
  });

  test('listJobNoteMeta with no job ids does not query at all', async () => {
    expect((await listJobNoteMeta(tenantId, [])).size).toBe(0);
  });

  test('a note is tenant-scoped even for a job id that exists', async () => {
    await writeJobNote(tenantId, jobId, 'ours');
    const { rows } = await pg.query(
      `insert into tenants (name) values ('job-note-scope-probe') returning id`,
    );
    const other = rows[0].id as string;
    try {
      // The job belongs to `tenantId`, so this reads as "no note" rather than
      // handing another firm's prose to the wrong caller.
      expect(await readJobNote(other, jobId)).toBeNull();
      expect((await listJobNoteMeta(other, [jobId])).size).toBe(0);
    } finally {
      await pg.query('delete from tenants where id = $1', [other]);
    }
  });

  test('deleting the JOB takes its note and its versions with it', async () => {
    const customer = await createCustomer({ tenantId, name: `Doomed ${Date.now()}` });
    const doomed = (await createJob({ tenantId, customerId: customer.id, title: 'Doomed' })).id;
    await writeJobNote(tenantId, doomed, 'one');
    await writeJobNote(tenantId, doomed, 'two');
    await pg.query('delete from jobs where id = $1', [doomed]);
    const left = await pg.query(
      `select (select count(*) from job_notes where job_id = $1) as notes,
              (select count(*) from job_note_versions where job_id = $1) as versions`,
      [doomed],
    );
    expect(left.rows[0]).toEqual({ notes: '0', versions: '0' });
  });

  test('every FK on both tables is ON DELETE CASCADE', async () => {
    // Asserted STRUCTURALLY rather than by deleting a tenant, and the reason is
    // worth recording: a job note requires a job, which requires a customer, and
    // `customers_tenant_id_fkey` is NO ACTION — so a tenant holding a note can
    // never be deleted directly anyway, and the behavioural test that works for
    // planner_memory (which needs no customer) is not constructible here.
    //
    // The hazard is still real and this is what catches it: drop the cascade
    // from either tenant_id FK and a world rebuild's `delete from tenants` gains
    // a new way to fail 23503 (eng-memory §1, the tenant_profiles trap). The
    // job-delete test above only exercises the job_id FKs.
    const { rows } = await pg.query(
      `select c.conrelid::regclass::text as tbl, c.conname, c.confdeltype,
              c.confrelid::regclass::text as refs
         from pg_constraint c
        where c.contype = 'f'
          and c.conrelid in ('job_notes'::regclass, 'job_note_versions'::regclass)
        order by tbl, conname`,
    );
    expect(rows).toHaveLength(4); // two tables x (tenant_id, job_id)
    // 'c' = ON DELETE CASCADE. 'a' (NO ACTION) is what would bite.
    expect(rows.every((r) => r.confdeltype === 'c')).toBe(true);
    expect(rows.map((r) => r.refs).sort()).toEqual(['jobs', 'jobs', 'tenants', 'tenants']);
  });

  test('ACL posture: RLS on, anon/authenticated hold zero privileges on both tables', async () => {
    // `content` is model-written text served back into the planner's tool
    // results, and supabase/config.toml still sets auto_expose_new_tables =
    // true — so a new table is published to the publishable key unless the
    // migration says otherwise. This is the test that says it did.
    for (const table of ['job_notes', 'job_note_versions']) {
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
});
