// Copy every seat bot token on a host into ops_secrets.bot_tokens.
//
// WHY THIS IS A LAPTOP SCRIPT AND NOT PART OF PROVISIONING. Neither end of the
// box<->server pipe can write this table, and that is the design working, not a
// gap somebody forgot to close:
//
//   * THE BOX holds no database credential at all. /etc/doorman/badge-pull.env
//     carries PULL_URL and HOST_PULL_TOKEN and nothing else, there is no psql
//     on the machine, and everything it does with the server goes over HTTP to
//     /control/*. Giving it one would put a standing database login on the one
//     machine that already holds every bot token -- the worst place to add a
//     second credential.
//   * RENDER, the only component with database access, is deliberately walled
//     out of ops_secrets: PostgREST routes only to `public, graphql_public`, so
//     the service-role key answers PGRST106 there. That wall is the entire
//     point of the schema. A /control/ endpoint that wrote these tokens would
//     have to tear it down.
//
// So the write belongs where both halves already exist and neither is standing:
// an operator laptop, which has SSH to the box and DATABASE_URL, and holds
// both only while a human is running a command.
//
// Usage:
//   node -r dotenv/config scripts/sync-ops-secrets.mjs [ssh=<host-alias>] [host=<host-name>] [--dry-run]
//     ssh=   SSH alias for the machine (default: tradesbox)
//     host=  the `host` column value, matching hosts.name (default: trades-box-1)
//
// No token touches disk or argv: the extractor runs over SSH on stdin, its
// JSONL comes back on a pipe, and each token goes straight into a parameterised
// INSERT. getMe is called for each one BEFORE writing -- a token that Telegram
// rejects is reported and skipped rather than stored, so this can never fill
// the table with credentials that no longer work.
import { spawn } from 'node:child_process';
import pg from 'pg';

const args = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.includes('=')).map((a) => {
    const i = a.indexOf('=');
    return [a.slice(0, i), a.slice(i + 1)];
  }),
);
const DRY = process.argv.includes('--dry-run');
const SSH_HOST = args.ssh || 'tradesbox';
const HOST_NAME = args.host || 'trades-box-1';

// Same guard as assign-host.mjs: this WRITES, so refuse anything but the known
// project until a prod rollout is a deliberate, separate step.
const TEST_REF = 'daqapdlkgxfrhquacprv';
const dburl = process.env.DATABASE_URL ?? '';
if (!dburl.includes(TEST_REF)) {
  console.error(`REFUSING TO RUN: DATABASE_URL must target the test ref (${TEST_REF}).`);
  process.exit(1);
}

// Runs as the LOGIN user, not root: the gateway store is `ubuntu`-owned 0600
// and we log in as ubuntu, so no sudo is needed and none is asked for. The
// handle and id are NOT read here -- getMe below is authoritative for both,
// which is what stops a stale .menu stamp nulling a good bot_username (that
// happened on 2026-09-17).
const EXTRACTOR = [
  'import json, os, re, sqlite3, sys',
  'DB = os.path.expanduser("~/.local/state/nemoclaw/openshell-docker-gateway/openshell.db")',
  'TOKEN = re.compile(rb"[0-9]{8,12}:[A-Za-z0-9_-]{30,45}")',
  'NAME = re.compile(r"^(s[0-9]+)-telegram-bridge$")',
  'con = sqlite3.connect("file:" + DB + "?mode=ro", uri=True)',
  'for name, payload in con.execute("select name, payload from objects where object_type = ?", ("provider",)):',
  '    m = NAME.match(name or "")',
  '    if not m or not payload: continue',
  '    toks = {t.group(0).decode() for t in TOKEN.finditer(payload)}',
  '    if len(toks) != 1:',
  '        print(m.group(1) + ": skipped (" + str(len(toks)) + " token-shaped strings)", file=sys.stderr)',
  '        continue',
  '    print(json.dumps({"ref": m.group(1), "token": toks.pop()}))',
  'con.close()',
].join(String.fromCharCode(10));

function extract() {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', ['-o', 'BatchMode=yes', SSH_HOST, 'python3', '-'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`extractor exited ${code}`)),
    );
    p.stdin.end(EXTRACTOR);
  });
}

const raw = await extract();
const seats = raw
  .split(String.fromCharCode(10))
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l));
if (!seats.length) {
  console.error('no seats found in the gateway store -- nothing to sync');
  process.exit(1);
}

const db = new pg.Client({ connectionString: dburl, ssl: { rejectUnauthorized: false } });
await db.connect();

let added = 0, updated = 0, same = 0, skipped = 0;
for (const seat of seats.sort((a, b) => a.ref.localeCompare(b.ref))) {
  // Verify BEFORE storing. A revoked token in this table is worse than an
  // absent one: it looks like a working way back in.
  let me;
  try {
    const r = await fetch(`https://api.telegram.org/bot${seat.token}/getMe`);
    me = await r.json();
  } catch (err) {
    console.error(`  ${seat.ref}: getMe failed (${err.message}) -- skipped`);
    skipped++;
    continue;
  }
  if (!me?.ok) {
    console.error(`  ${seat.ref}: Telegram rejected this token (${me?.description ?? 'no reason'}) -- skipped`);
    skipped++;
    continue;
  }
  const botId = String(me.result.id);
  const handle = `@${me.result.username}`;
  const cur = await db.query(
    'select bot_id, bot_username, token from ops_secrets.bot_tokens where host = $1 and sandbox_ref = $2',
    [HOST_NAME, seat.ref],
  );
  const row = cur.rows[0];
  const unchanged = row && row.token === seat.token && row.bot_id === botId && row.bot_username === handle;
  if (unchanged) {
    console.log(`  ${seat.ref}  ${handle}  unchanged`);
    same++;
    continue;
  }
  if (DRY) {
    console.log(`  ${seat.ref}  ${handle}  would ${row ? 'UPDATE' : 'INSERT'} (dry run)`);
    row ? updated++ : added++;
    continue;
  }
  await db.query(
    `insert into ops_secrets.bot_tokens (host, sandbox_ref, bot_username, bot_id, token, note, updated_at)
     values ($1, $2, $3, $4, $5, $6, now())
     on conflict (host, sandbox_ref) do update
       set bot_username = excluded.bot_username,
           bot_id       = excluded.bot_id,
           token        = excluded.token,
           note         = excluded.note,
           updated_at   = now()`,
    [HOST_NAME, seat.ref, handle, botId, seat.token, 'synced from the gateway store by scripts/sync-ops-secrets.mjs'],
  );
  console.log(`  ${seat.ref}  ${handle}  ${row ? 'updated' : 'added'}`);
  row ? updated++ : added++;
}
await db.end();
console.log(`${seats.length} seat(s): ${added} added, ${updated} updated, ${same} unchanged, ${skipped} skipped${DRY ? '  (DRY RUN -- nothing written)' : ''}`);
process.exit(skipped ? 1 : 0);
