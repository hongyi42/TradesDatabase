// The operator's view of THE PLANNER'S OWN MEMORY (build 3, plan 2026-08-30).
// Read-only, always — this console must never be a way for a human to edit what
// the planner believes. That is the whole inversion the build makes: the old
// lessons console existed because a human ACTIVATED every sentence; here the
// model writes and the record corrects it, and a human hand in the middle would
// quietly restore the thing that was removed.
//
//   npm run memory:planner -- --tenant <uuid>
//
// What it is FOR: checking whether a to-do bin emerges on its own. Nothing seeds
// one and the doctrine is deliberately neutral about it (user, 2026-08-30), so
// the only way to find out what shape the planner gives its own filing system is
// to look. Two failure modes are worth watching for, and they are opposite: no
// to-dos at all, and memory that is all task chatter and no understanding.
//
// The `in index?` column is the one derived fact here. A file the index never
// mentions is unreachable to the planner — it cannot read_memory a path it does
// not know — so the render appends a `not in your index:` footer to make it
// findable again. A path showing `no` here is a path that footer is currently
// carrying.
import pg from 'pg';

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : null;
};
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}
const tenantId = arg('tenant');
// `--tenant` with nothing after it must NOT silently widen to every firm.
// `arg()` returns undefined for a trailing flag, and an undefined tenant drops
// the WHERE clause — so a typo turns a one-firm read into an all-firms dump.
// Asking for a firm and getting the fleet is the wrong direction to fail in.
if (process.argv.includes('--tenant') && !tenantId) {
  console.error('--tenant was given with no uuid after it. Omit it entirely to list every firm.');
  process.exit(1);
}
// Shape-checked here rather than let through to Postgres: an unbound `22P02
// invalid input syntax for type uuid` arrives as a raw stack trace, which is
// exactly the failure this file's header says it exists to avoid.
if (tenantId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenantId)) {
  console.error(`'${tenantId}' is not a uuid — copy the firm's id from the tenants table.`);
  process.exit(1);
}

// A database where build 3 has not been applied is the EXPECTED case for a
// while — the harness rebuild stays in testing until the whole build order is
// evaluated (user ruling 2026-08-29), so the pilot has none of these tables.
// Saying so in one line is the right answer; a Postgres stack trace reads as a
// broken console and sends the next person looking for a bug that is not there.
const MISSING_RELATION = '42P01';

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  // No --tenant is a legitimate call, not an error: "has anything been written
  // anywhere yet" is the first question an operator has, and on a database with
  // nothing deployed the answer is a clean zero rather than a usage message.
  const { rows } = await client.query(
    `select tenant_id, path, length(content) as chars, updated_at
       from planner_memory
      ${tenantId ? 'where tenant_id = $1' : ''}
      order by tenant_id, path`,
    tenantId ? [tenantId] : [],
  );
  if (rows.length === 0) {
    console.log(tenantId ? 'no memory for this firm' : 'no planner memory on this database');
  }

  const byTenant = new Map();
  for (const r of rows) {
    if (!byTenant.has(r.tenant_id)) byTenant.set(r.tenant_id, []);
    byTenant.get(r.tenant_id).push(r);
  }

  for (const [tid, files] of byTenant) {
    const { rows: idxRows } = await client.query(
      `select content from planner_memory where tenant_id = $1 and path = 'MEMORY.md'`,
      [tid],
    );
    const index = idxRows[0]?.content ?? '';
    console.log(`\nfirm ${tid}${index ? '' : '   (no MEMORY.md — every file below is an orphan)'}`);
    for (const f of files) {
      const listed = f.path === 'MEMORY.md' ? '—' : index.includes(f.path) ? 'yes' : 'NO';
      console.log(
        `  ${f.path.padEnd(40)} ${String(f.chars).padStart(6)} chars   ` +
          `${new Date(f.updated_at).toISOString()}   in index: ${listed}`,
      );
    }
    const { rows: vers } = await client.query(
      `select count(*)::int as n from planner_memory_versions where tenant_id = $1`,
      [tid],
    );
    const { rows: runs } = await client.query(
      `select last_ran_at, last_success_at from planner_runs where tenant_id = $1`,
      [tid],
    );
    console.log(`  ${vers[0].n} kept version(s) across all paths`);
    if (runs.length === 0) console.log('  the planner has never reached the model for this firm');
    else {
      console.log(
        `  last run ${new Date(runs[0].last_ran_at).toISOString()}` +
          `   last SUCCESS ${runs[0].last_success_at ? new Date(runs[0].last_success_at).toISOString() : 'never'}`,
      );
    }
    if (index) {
      console.log('\n  MEMORY.md:');
      for (const line of index.split('\n')) console.log(`    | ${line}`);
    }
  }
} catch (err) {
  if (err?.code !== MISSING_RELATION) throw err;
  console.log(
    'planner_memory is not on this database — build 3 has not been applied here. ' +
      'Nothing is wrong; there is nothing to show.',
  );
} finally {
  await client.end();
}
