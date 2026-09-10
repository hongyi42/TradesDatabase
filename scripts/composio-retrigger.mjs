// MAKE ONE PAIRED SEAT'S MAIL WATCHERS MATCH THE CODE (rung 10b.4).
//
// WHY THIS EXISTS. checkPairing only reaches the provisioning path for a row in
// 'invited' (a fresh pairing) or its healing branch (paired, trigger missing).
// A seat already in 'active' — every live one — is never revisited, so a change
// to WHICH watchers we run reaches nobody. Gmail's menu has two, one per
// direction of mail, and every seat paired before this rung has only the
// received one: their managers' own replies are invisible.
//
//   npm run composio:retrigger -- user=<tenantUuid>:<ref> account=<ca_...>
//   npm run composio:retrigger -- user=<tenantUuid>:<ref> account=<ca_...> --apply
//
// ONE SEAT PER RUN, AND THE ACCOUNT IS REQUIRED. `triggers.listActive` returns
// no user field at all (verified against the SDK's own response schema), so
// there is no way to filter a fleet-wide list down to one person — the
// connected account id is the only handle actually in the data, and it is what
// pins the create. Without the pin the SDK attaches to "the first connected
// account for the user", which can be a stale INITIATED request from an
// abandoned link. Both values are on the technicians row:
//   select ref, composio_connected_account_id from technicians;
//
// Dry-run by default. It only ever CREATES a missing watcher: an existing one
// is left strictly alone, because Composio's upsert keys on the CONFIGURATION
// (verified 2026-09-10 — changing a live trigger's config minted a SECOND
// instance and left the first one polling), so "fixing" a config here would
// quietly double the mailbox.
import { Composio } from '@composio/core';
// The ONE definition of what we run, imported from the built server code rather
// than retyped — a second copy is a copy that drifts, and this one would drift
// silently (the script is run by hand, months apart).
import { GMAIL_TRIGGERS } from '../dist/composio/pairing.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const arg = (n) => (process.argv.find((a) => a.startsWith(`${n}=`))?.slice(n.length + 1) ?? '').trim();
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
const onAccount = async (slug) =>
  asItems(
    await composio.triggers.listActive({ connectedAccountIds: [ACCOUNT], triggerNames: [slug] }),
  );

console.log(`account ${ACCOUNT}\n`);
const missing = [];
for (const { slug, config } of GMAIL_TRIGGERS) {
  const live = await onAccount(slug);
  if (live.length > 0) {
    console.log(`${slug}\n  PRESENT: ${live.map((t) => t.id).join(', ')}`);
    for (const t of live) console.log(`    config: ${JSON.stringify(t.triggerConfig ?? t.trigger_config)}`);
  } else {
    console.log(`${slug}\n  MISSING — would create with ${JSON.stringify(config)}`);
    missing.push({ slug, config });
  }
}

if (missing.length === 0) {
  console.log('\nBoth watchers are already on this mailbox. Nothing to do.');
  process.exit(0);
}
if (!APPLY) {
  console.log(`\n${missing.length} watcher(s) would be created. Re-run with --apply to write.`);
  process.exit(0);
}

let bad = false;
for (const { slug, config } of missing) {
  try {
    const res = await composio.triggers.create(USER_ID, slug, {
      connectedAccountId: ACCOUNT,
      triggerConfig: { ...config },
    });
    console.log(`\nCREATED ${slug} → ${res.triggerId ?? res.id}`);
  } catch (err) {
    bad = true;
    console.error(`\n${slug} FAILED — ${err?.message ?? err}`);
  }
}

// READ IT BACK. The create's own answer is not evidence that the mailbox is now
// being watched the way we think — this is the same reason the deploy is
// verified by asking /health rather than by trusting the trigger response.
console.log('\n--- after ---');
for (const { slug } of GMAIL_TRIGGERS) {
  const live = await onAccount(slug);
  console.log(`${slug}: ${live.length ? live.map((t) => t.id).join(', ') : 'STILL MISSING'}`);
  if (live.length === 0) bad = true;
  if (live.length > 1) {
    bad = true;
    console.error(
      `  ⚠  ${live.length} instances of this watcher — they will double every delivery.\n` +
        `     Delete all but one; offboarding now lists the mailbox's watchers itself, so an\n` +
        `     extra one is torn down with the seat, but until then it is billed twice.`,
    );
  }
}
if (bad) process.exit(1);
console.log(`\nBoth watchers live on ${ACCOUNT} for ${refPart}.`);
