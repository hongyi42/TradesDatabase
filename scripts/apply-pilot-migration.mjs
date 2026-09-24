// Apply ONE repo migration file to the pilot ("test" project), recording it in
// the ledger under the FILE's own version — for when the Supabase MCP's
// apply_migration is unavailable (it also records its own timestamp rather than
// the file's, the ledger drift engineering memory §2 describes).
//
//   node scripts/apply-pilot-migration.mjs <supabase/migrations/…sql>          # dry run: checks only
//   node scripts/apply-pilot-migration.mjs <supabase/migrations/…sql> --apply  # one transaction
//
// DATABASE_URL comes from the environment, or from the main checkout's .env when
// run inside a worktree (a worktree has no .env). Refuses anything that is not
// the pilot's ref, and refuses a version the ledger already has.
import { readFileSync, existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import pg from 'pg';

const TEST_REF = 'daqapdlkgxfrhquacprv';
const [file, flag] = process.argv.slice(2);
const m = /^(\d{14})_([a-z0-9_]+)\.sql$/.exec(basename(file ?? ''));
if (!m || !existsSync(file)) {
  console.error('usage: apply-pilot-migration.mjs supabase/migrations/<version>_<name>.sql [--apply]');
  process.exit(1);
}
const [, version, name] = m;

function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim();
  const envFile = resolve(common, '..', '.env');
  const line = existsSync(envFile)
    ? readFileSync(envFile, 'utf8').split('\n').find((l) => l.startsWith('DATABASE_URL='))
    : undefined;
  return line?.slice('DATABASE_URL='.length).replace(/^["']|["']$/g, '');
}
const url = databaseUrl();
if (!url?.includes(TEST_REF)) {
  console.error(`REFUSING: DATABASE_URL must target the pilot ref (${TEST_REF}).`);
  process.exit(1);
}

const sql = readFileSync(file, 'utf8');
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const seen = await client.query(
    'select version, name from supabase_migrations.schema_migrations where version = $1 or name = $2',
    [version, name],
  );
  if (seen.rowCount) {
    console.error(`REFUSING: the ledger already has ${JSON.stringify(seen.rows)}.`);
    process.exit(1);
  }
  console.log(`pilot ${TEST_REF}: ${basename(file)} is not in the ledger (${sql.length} bytes).`);
  if (flag !== '--apply') {
    console.log('dry run — nothing changed. Re-run with --apply.');
    process.exit(0);
  }
  await client.query('begin');
  await client.query(sql);
  await client.query(
    'insert into supabase_migrations.schema_migrations (version, name, statements) values ($1, $2, $3)',
    [version, name, [sql]],
  );
  await client.query('commit');
  await client.query("notify pgrst, 'reload schema'");
  console.log(`applied ${version}_${name}, recorded in the ledger, PostgREST reloaded.`);
} catch (err) {
  await client.query('rollback').catch(() => {});
  console.error(`FAILED, rolled back: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
} finally {
  await client.end();
}
