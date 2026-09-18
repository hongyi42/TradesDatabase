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
// local because scripts/ must not import from src/ (build-order independence).
const INACTIVE = new Set(['inactive', 'retired', 'archived', 'disabled']);
const isLive = (t) => !INACTIVE.has(String(t.state ?? '').toLowerCase());

const { data: techs, error } = await db
  .from('technicians')
  .select('id,ref,display_name,tier,state,sandbox_ref,telegram_user_id,tenant_id');
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

const live = (techs ?? []).filter(isLive);
const problems = [];
const say = (s) => console.log(s);

say('=== seats whose occupant has NO Telegram binding');
say('    (they have a bot and a button; they will never be notified, silently)');
const unbound = live.filter((t) => t.sandbox_ref && !t.telegram_user_id);
for (const t of unbound) {
  say(`  ${t.sandbox_ref.padEnd(4)} ${t.ref} (${t.display_name}) — tenant ${tname[t.tenant_id]}`);
  problems.push(`${t.sandbox_ref}: occupant ${t.ref} has no telegram_user_id`);
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
  .select('sandbox_ref,technician_id,retired_at,tenant_id,bot_username');
if (poolErr) throw new Error(`pool read failed: ${poolErr.message}`);
const poolBy = new Map((pool ?? []).map((p) => [p.sandbox_ref, p]));
let split = 0;
for (const t of live.filter((x) => x.sandbox_ref)) {
  const p = poolBy.get(t.sandbox_ref);
  if (!p) {
    split++;
    say(`  ${t.sandbox_ref.padEnd(4)} ${t.ref} holds a sandbox with NO pool row`);
    problems.push(`${t.sandbox_ref}: roster occupant ${t.ref} but no sandbox_pool row`);
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
