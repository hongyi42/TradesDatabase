// Dev helper: reconnect the Gmail account so it grants a real mail scope.
// Deletes any existing Gmail connection under the given user id, then starts a fresh
// OAuth flow and prints the URL to open. After approving in the browser (WATCH for a
// Gmail permission on the consent screen), run with `--wait` to confirm it went ACTIVE
// and print the granted scope.
//
// user id: pass `user=<id>` — a bare tenant uuid (whole-business pairing) or
// `<tenantUuid>:<technicianRef>` (per-person pairing). Defaults to the test tenant.
// If the user id already has a Gmail connection, pass `--replace` to confirm the
// swap (see the same-ref guard below). Run with `node -r dotenv/config` so
// COMPOSIO_API_KEY loads from .env.

import { Composio } from '@composio/core';

// This script DELETES connections for the resolved user id, so argument handling
// fails closed: unrecognized args abort (a typo'd `User=`/bare positional must not
// silently fall back to the default tenant), the value is trimmed (`user=` / blanks
// fall back), and the id must be a tenant uuid or a well-formed composite — a
// malformed id (e.g. trailing colon) would mint a pairing the webhook rejects on
// every delivery (bad_payload 400, no drop receipt: mail silently lost).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const unrecognized = process.argv
  .slice(2)
  .filter((a) => a !== '--wait' && a !== '--replace' && !a.startsWith('user='));
if (unrecognized.length) {
  console.error(`Unrecognized argument(s): ${unrecognized.join(' ')} — did you mean user=<id>? Aborting.`);
  process.exit(1);
}
const TENANT = (process.argv.find((a) => a.startsWith('user='))?.slice(5) ?? '').trim()
  || '82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18';
const sepIdx = TENANT.indexOf(':');
const tenantPart = sepIdx === -1 ? TENANT : TENANT.slice(0, sepIdx);
const refPart = sepIdx === -1 ? null : TENANT.slice(sepIdx + 1);
if (!UUID_RE.test(tenantPart) || (sepIdx !== -1 && (!refPart || refPart.startsWith('connector:')))) {
  console.error(
    `Invalid user id '${TENANT}': expected <tenantUuid>:<technicianRef> ` +
      `(uuid tenant; ref non-empty, not 'connector:*' — the webhook rejects those).`,
  );
  process.exit(1);
}
// Bare-uuid (whole-business) pairing was RETIRED 2026-07-02: the webhook rejects
// its deliveries 400 bad_payload with no drop receipt — mail silently lost. A
// bare uuid may still be used with --wait (read-only listing), never to pair.
if (sepIdx === -1 && !process.argv.includes('--wait')) {
  console.error(
    `Bare-uuid pairing is retired (2026-07-02). Pair per person: user=${TENANT}:<technicianRef>. ` +
      `(Bare uuid is still accepted with --wait to LIST legacy connections.)`,
  );
  process.exit(1);
}
console.log(`Target user id: ${TENANT}`);
const AUTH_CONFIG = 'ac_5CdPk4l3GV2V'; // the Gmail auth config created in the dashboard
const c = new Composio();

if (process.argv.includes('--wait')) {
  // After you approve in the browser, confirm + show the scope actually granted.
  const list = await c.connectedAccounts.list({ userIds: [TENANT] });
  const items = list.items ?? list.data ?? list;
  for (const it of items) {
    if (it.toolkit?.slug === 'gmail') {
      console.log(it.id, 'status=', it.status, '\n  scope=', it.data?.scope);
    }
  }
  process.exit(0);
}

// Same-ref guard: reconnect REPLACES the pairing for this exact user id. An
// existing connection means either the same person re-consenting (fine — pass
// --replace to confirm) or a SECOND person minted onto an already-taken ref
// (e.g. two Janes both as "…:jane"): abort, so one person's pairing is never
// silently swapped for another's mailbox. Refs must be unique per tenant.
const list = await c.connectedAccounts.list({ userIds: [TENANT] });
const items = list.items ?? list.data ?? list;
const existing = items.filter((it) => it.toolkit?.slug === 'gmail');
if (existing.length && !process.argv.includes('--replace')) {
  console.error(
    `User id '${TENANT}' already has ${existing.length} Gmail connection(s) ` +
      `(${existing.map((it) => it.id).join(', ')}).\n` +
      `Same person reconnecting? Re-run with --replace.\n` +
      `Different person? Pick a different technicianRef — this ref is taken.`,
  );
  process.exit(1);
}

// 1) Remove the old Gmail connection(s) for this user id (confirmed via --replace).
for (const it of existing) {
  await c.connectedAccounts.delete(it.id);
  console.log('Deleted old connection:', it.id);
}

// 2) Start a fresh OAuth flow. (Managed OAuth uses link(), not the retired initiate().)
const req = await c.connectedAccounts.link(TENANT, AUTH_CONFIG);
console.log('\n=== OPEN THIS URL IN YOUR BROWSER, SIGN IN, APPROVE ===');
console.log(req.redirectUrl ?? req.redirect_url ?? '(no redirectUrl — full object below)');
console.log('\nfull:', JSON.stringify(req, null, 2));
