// Roster health for the person-push path — a READ-ONLY diagnostic.
//
// WHY THIS EXISTS. The push leg (src/control/nudgeQueue.ts) serves a row only
// when its addressee is active AND has `sandbox_ref` AND has
// `telegram_user_id`. A miss is skipped "frozen, not failed": the row stays
// queued forever, nothing is logged, and nobody is told. That is the right
// delivery doctrine — a rebind may heal it — but it means a person can have a
// seat, a working bot and a Schedule button, and still never receive a single
// schedule change, with no symptom anywhere. s7 sat broken for six weeks for a
// neighbouring reason and surfaced only because someone went looking.
//
// This does the looking. It reports the roster defects that cause silent
// non-delivery, plus any push rows that have gone stale in the queue.
//
// Usage:  node -r dotenv/config scripts/roster-health.mjs
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// The one definition of "not live", matching isInactiveState's intent. Kept
// local because scripts/ must not import from src/ (build-order independence)
// — so it must be kept in step with src/db/technicians.ts by hand. THESE ARE
// THE REAL STATES: the first version listed four that no roster row has ever
// had ('inactive', 'retired', 'archived', 'disabled'), which made every
// departed person "live". Harmless while the sections only listed things, but
// the pool check below turns it into a hard exit-1 on a healthy fleet — a
// deactivation leaves the roster's sandbox_ref in place while the pool row is
// retired and freed, which then reads as a roster/pool split for every leaver.
const INACTIVE = new Set(['offboarding', 'offboarded']);
const isLive = (t) => !INACTIVE.has(String(t.state ?? '').toLowerCase());

const { data: techs, error } = await db
  .from('technicians')
  .select('id,ref,display_name,tier,state,sandbox_ref,telegram_user_id,tenant_id,host_id');
if (error) throw new Error(`roster read failed: ${error.message}`);
const { data: tenants } = await db.from('tenants').select('id,name');
const tname = Object.fromEntries((tenants ?? []).map((t) => [t.id, t.name]));

// Telegram accounts KNOWN to sit on several rows on purpose. A developer
// driving a fleet of test bots from one phone is the normal shape of this
// pilot, not a defect -- flagging it every run trains the reader to skip the
// section. Confirmed 2026-09-18: 5801703167 is a teammate's account behind the
// bots they stood up for feature work.
// Printed even when expected, because it still costs something:
// findRosterByTelegramUserIdGlobal REFUSES an ambiguous id rather than guess,
// so an ops alert can never be addressed to one of these.
const EXPECTED_SHARED_TG = new Set(['5801703167']);

// Seats with no person behind them BY DESIGN. s6 is the spine-eval tier-3 rig:
// scripts/spine-eval/run-gateway.mjs drives it over ssh as manager-sam @
// spine-eval-main, and its badge is minted for that one (tenant, ref) pair.
// Nobody is ever going to open Telegram as that identity, so "no binding" is
// the correct state and reporting it forever would leave this script exiting
// non-zero on a healthy fleet -- which is how a check stops being read.
const EXPECTED_UNBOUND = new Map([['s6', 'spine-eval tier-3 rig, driven over ssh']]);

const live = (techs ?? []).filter(isLive);
const problems = [];
const say = (s) => console.log(s);

say('=== seats whose occupant has NO Telegram binding');
say('    (they have a bot and a button; they will never be notified, silently)');
const unbound = live.filter((t) => t.sandbox_ref && !t.telegram_user_id);
for (const t of unbound) {
  const why = EXPECTED_UNBOUND.get(t.sandbox_ref);
  say(
    `  ${t.sandbox_ref.padEnd(4)} ${t.ref} (${t.display_name}) — tenant ${tname[t.tenant_id]}` +
      (why ? `   [expected: ${why}]` : ''),
  );
  if (!why) problems.push(`${t.sandbox_ref}: occupant ${t.ref} has no telegram_user_id`);
}
if (!unbound.length) say('  none');

say('\n=== one Telegram id on several live rows');
say('    (a change touching both sends that ONE phone two messages, from two bots)');
const byTg = new Map();
for (const t of live.filter((x) => x.telegram_user_id)) {
  byTg.set(t.telegram_user_id, [...(byTg.get(t.telegram_user_id) ?? []), t]);
}
let shared = 0;
for (const [tg, rows] of byTg) {
  if (rows.length < 2) continue;
  shared++;
  const who = rows.map((r) => `${r.ref}/${r.sandbox_ref ?? 'no-seat'}`).join(', ');
  const expected = EXPECTED_SHARED_TG.has(tg);
  say(`  ${tg}: ${who}${expected ? '   [expected: one developer\'s test bots]' : ''}`);
  if (!expected) {
    problems.push(`telegram id ${tg} is live on ${rows.length} rows (${who})`);
  }
}
if (!shared) say('  none');

say('\n=== sandboxes the roster and the pool disagree about');
say('    (bind_telegram hands out whatever the POOL calls free, so a roster row');
say('     still pointing at it means two people can end up on one bot)');
// This replaced a heuristic that flagged any seat whose TENANT NAME matched
// /eval|test/. That was nominal, not factual, and both its hits were wrong:
// "Judy Testing" is a real person's own tenant (confirmed 2026-09-18 - her
// Telegram account has 16 messages to @Hmanyt_bot), and the genuine defect on
// s6 was never the tenant's name. sandbox_pool.technician_id is the only
// authority on whether a sandbox is free, so compare against THAT.
const { data: pool, error: poolErr } = await db
  .from('sandbox_pool')
  .select('sandbox_ref,technician_id,retired_at,tenant_id,bot_username,host_id');
if (poolErr) throw new Error(`pool read failed: ${poolErr.message}`);
// KEYED BY (host, sandbox_ref), because that is the table's own uniqueness
// (migration 20260707000000) — two hosts can each have an s3, and keying on the
// name alone would compare a person on one host against the other host's row.
// A roster row with no host_id falls back to the name, which is unambiguous
// only while one pool row carries it; when more do, say so instead of guessing.
const poolByHostRef = new Map((pool ?? []).map((p) => [`${p.host_id}|${p.sandbox_ref}`, p]));
const poolByRef = new Map();
for (const p of pool ?? []) poolByRef.set(p.sandbox_ref, [...(poolByRef.get(p.sandbox_ref) ?? []), p]);
let split = 0;
for (const t of live.filter((x) => x.sandbox_ref)) {
  const sameRef = poolByRef.get(t.sandbox_ref) ?? [];
  if (!t.host_id && sameRef.length > 1) {
    split++;
    say(`  ${t.sandbox_ref.padEnd(4)} ${t.ref} names no host, and ${sameRef.length} hosts have this sandbox`);
    problems.push(`${t.sandbox_ref}: roster occupant ${t.ref} names no host_id - cannot tell which pool row is theirs`);
    continue;
  }
  const p = t.host_id ? poolByHostRef.get(`${t.host_id}|${t.sandbox_ref}`) : sameRef[0];
  if (!p) {
    split++;
    say(`  ${t.sandbox_ref.padEnd(4)} ${t.ref} holds a sandbox with NO pool row`);
    problems.push(`${t.sandbox_ref}: roster occupant ${t.ref} but no sandbox_pool row`);
    continue;
  }
  if (p.retired_at) {
    // Being recycled while somebody still points at it: the box destroys and
    // re-pools it on its next pull, and they lose their assistant with it.
    split++;
    say(`  ${t.sandbox_ref.padEnd(4)} roster: ${t.ref} (tenant ${tname[t.tenant_id]}) pool row is RETIRED (being recycled)`);
    problems.push(`${t.sandbox_ref}: roster occupant ${t.ref} still points at a pool row marked retired`);
    continue;
  }
  if (p.technician_id === t.id) continue; // roster and pool agree
  split++;
  const what =
    p.technician_id === null
      ? `pool says FREE (bot ${p.bot_username ?? '?'} goes to the next hire)`
      : `pool says it belongs to technician ${p.technician_id.slice(0, 8)}`;
  say(`  ${t.sandbox_ref.padEnd(4)} roster: ${t.ref} (tenant ${tname[t.tenant_id]}) ${what}`);
  problems.push(`${t.sandbox_ref}: roster occupant ${t.ref} disagrees with the pool - ${what}`);
}
if (!split) say('  none');

say('\n=== push rows going stale in the queue');
const { data: queued } = await db
  .from('person_pushes')
  .select('id,kind,serve_count,attempts,created_at,technician_id')
  .eq('status', 'queued')
  .order('created_at', { ascending: true });
const now = Date.now();
let stale = 0;
for (const r of queued ?? []) {
  const mins = Math.round((now - new Date(r.created_at).getTime()) / 60000);
  // Ten minutes is ~60 ticks at the 10s cadence: past that it is not a race.
  if (mins < 10) continue;
  stale++;
  const why =
    r.attempts >= 3
      ? 'FROZEN at the attempts cap'
      : r.serve_count >= 10
        ? 'FROZEN at the serve cap'
        : r.serve_count === 0
          ? 'never served — addressee fails the liveness gate'
          : 'served but never acked';
  say(`  ${r.id.slice(0, 8)} ${r.kind.padEnd(8)} ${String(mins).padStart(5)}m  ${why}`);
  problems.push(`push ${r.id.slice(0, 8)} stale ${mins}m: ${why}`);
}
if (!stale) say('  none');

const eligible = live.filter((t) => t.sandbox_ref && t.telegram_user_id);
say(`\nlive roster rows: ${live.length}   push-eligible: ${eligible.length}`);
say(problems.length ? `${problems.length} problem(s) found.` : 'No problems found.');
process.exit(problems.length ? 1 : 0);
