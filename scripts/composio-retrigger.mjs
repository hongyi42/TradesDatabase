// RECONCILE ONE PAIRED SEAT'S MAIL TRIGGER TO THE CURRENT CONFIG (rung 10b.3).
//
// WHY THIS EXISTS. checkPairing only reaches ensureTrigger for a row in
// 'invited' (a fresh pairing) or its healing branch (paired, trigger missing).
// A seat already in 'active' — every live one — is never revisited, so a change
// to the trigger's CONFIG reaches nobody. Without this the rung ships inert:
// the code is right and no live mailbox ever delivers the firm's own half.
//
// It is an UPSERT, not a delete-and-recreate. POST /trigger_instances/{slug}/upsert
// "creates a new trigger instance or updates an existing one" — the instance
// keeps its id and its polling watermark. Recreating would drop that watermark
// and Composio would redeliver the mailbox's backlog, every one of those
// deliveries paying for a work/personal classification.
//
//   npm run composio:retrigger -- user=<tenantUuid>:<ref> account=<ca_...>
//   npm run composio:retrigger -- user=<tenantUuid>:<ref> account=<ca_...> --apply
//
// ONE SEAT PER RUN, AND THE ACCOUNT IS REQUIRED. `triggers.listActive` returns
// no user field at all (verified against the SDK's own response schema), so
// there is no way to filter a fleet-wide list down to one person — the
// connected account id is the only handle that is actually in the data, and it
// is what pins the upsert. Without the pin the SDK attaches to "the first
// connected account for the user", which can be a stale INITIATED request from
// an abandoned link. Both values are on the technicians row:
//   select ref, composio_connected_account_id, composio_trigger_id from technicians;
//
// Dry-run by default: it prints the live config and the diff and writes nothing
// until --apply. Idempotent — a trigger already carrying the config is left
// alone.
import { Composio } from '@composio/core';
// The ONE definition of the config, imported from the built server code rather
// than retyped here — a second copy is a copy that drifts, and this one would
// drift silently (the script is run by hand, months apart).
import { GMAIL_TRIGGER_CONFIG, GMAIL_TRIGGER_SLUG } from '../dist/composio/pairing.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const arg = (name) => (process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1) ?? '').trim();
const USER_ID = arg('user');
const ACCOUNT = arg('account');
const APPLY = process.argv.includes('--apply');

if (!process.env.COMPOSIO_API_KEY) {
  console.error('COMPOSIO_API_KEY is not set in .env — add it and re-run.');
  process.exit(1);
}
// Same fail-closed shape check as composio-trigger.mjs: a trigger minted on a
// malformed composite fires webhooks that are ALL rejected bad_payload — the
// connection looks healthy while every email is lost.
const sep = USER_ID.indexOf(':');
const tenantPart = sep === -1 ? USER_ID : USER_ID.slice(0, sep);
const refPart = sep === -1 ? null : USER_ID.slice(sep + 1);
if (sep === -1 || !UUID_RE.test(tenantPart) || !refPart || refPart.startsWith('connector:')) {
  console.error(`Invalid or missing user id '${USER_ID}': expected user=<tenantUuid>:<technicianRef>.`);
  process.exit(1);
}
if (!ACCOUNT.startsWith('ca_')) {
  console.error(
    `Missing or malformed account='${ACCOUNT}': expected account=<ca_...>, the ` +
      `composio_connected_account_id from this person's technicians row.`,
  );
  process.exit(1);
}

const composio = new Composio();
const asItems = (r) => (Array.isArray(r) ? r : (r?.items ?? r?.data ?? []));
const listMine = async () =>
  asItems(
    await composio.triggers.listActive({
      connectedAccountIds: [ACCOUNT],
      triggerNames: [GMAIL_TRIGGER_SLUG],
    }),
  );

const before = await listMine();
if (before.length === 0) {
  console.error(`No ${GMAIL_TRIGGER_SLUG} trigger on account ${ACCOUNT}. Nothing to reconcile.`);
  process.exit(1);
}

console.log(`WANT: ${JSON.stringify(GMAIL_TRIGGER_CONFIG)}\n`);
const stale = [];
for (const t of before) {
  const cfg = t.triggerConfig ?? t.trigger_config ?? {};
  const current = Object.entries(GMAIL_TRIGGER_CONFIG).every(
    ([k, v]) => String(cfg[k]) === String(v),
  );
  console.log(`${t.id}\n  HAVE: ${JSON.stringify(cfg)}\n  ${current ? 'CURRENT — leaving alone' : 'STALE'}`);
  if (!current) stale.push(t.id);
}
if (stale.length === 0) {
  console.log('\nAlready carries the current config. Nothing to do.');
  process.exit(0);
}
if (!APPLY) {
  console.log(`\n${stale.length} trigger(s) would change. Re-run with --apply to write.`);
  process.exit(0);
}

let upserted;
try {
  const res = await composio.triggers.create(USER_ID, GMAIL_TRIGGER_SLUG, {
    connectedAccountId: ACCOUNT,
    triggerConfig: { ...GMAIL_TRIGGER_CONFIG },
  });
  upserted = res.triggerId ?? res.id;
  console.log(`\nUPSERTED → ${upserted}`);
} catch (err) {
  console.error(`\nUpsert FAILED — the old trigger is untouched and still delivering INBOX.`);
  console.error(`  ${err?.message ?? err}`);
  process.exit(1);
}

// DID IT UPDATE IN PLACE, OR MINT A SECOND ONE? The doc sentence says an upsert
// "updates an existing one WITH THE SAME CONFIGURATION", which could mean the
// configuration is part of the key — in which case changing it creates a NEW
// instance and the old INBOX one keeps polling forever: double deliveries,
// double classifier spend, and an orphan that unpair/offboarding will never
// delete (they tear down only technicians.composio_trigger_id). Rather than
// trust either reading, ask the live system, here, where the answer exists.
const after = await listMine();
console.log(`\nActive ${GMAIL_TRIGGER_SLUG} triggers on ${ACCOUNT}: ${after.map((t) => t.id).join(', ')}`);
// THE COMPARISON AGAIN, over what is live NOW — not a length check. One upsert
// can only fix one instance, so an account carrying two stale triggers would
// pass a count test while a stale one kept polling. Ask the same question of
// every row that exists after the write.
const stillStale = after.filter((t) => {
  const cfg = t.triggerConfig ?? t.trigger_config ?? {};
  return !Object.entries(GMAIL_TRIGGER_CONFIG).every(([k, v]) => String(cfg[k]) === String(v));
});
let bad = false;
if (stillStale.length > 0) {
  bad = true;
  console.error(
    `\n⚠  STILL ON THE OLD CONFIG: ${stillStale.map((t) => t.id).join(', ')}\n` +
      `   Each one keeps polling INBOX-only and will double nothing but will also deliver\n` +
      `   nothing new. If a SECOND instance was created rather than the first being updated,\n` +
      `   the old one must be deleted — offboarding only ever deletes the single id on the\n` +
      `   roster row, so anything else here is an orphan nothing will clean up.\n`,
  );
}
if (!upserted) {
  bad = true;
  console.error('\n⚠  The upsert returned no trigger id — check the dashboard before trusting this.');
} else if (!before.some((t) => t.id === upserted)) {
  bad = true;
  console.error(
    `\n⚠  The trigger id CHANGED (${before.map((t) => t.id).join(', ')} → ${upserted}).\n` +
      `   Update technicians.composio_trigger_id for ${refPart}, or offboarding will try to\n` +
      `   delete a trigger that no longer exists and leave the live one running.\n`,
  );
}
if (bad) process.exit(1);
console.log('\nUpdated in place. The roster row already holds the right trigger id.');
