// Dev helper: create the Gmail "new message" trigger for the live Composio test.
// The dashboard can't enable this trigger via clicks (SDK-only), so we do it here.
//
// Reads COMPOSIO_API_KEY from .env. Run in two passes:
//   1) `node -r dotenv/config scripts/composio-trigger.mjs`            → prints the
//      required triggerConfig schema (so we know what fields Gmail needs).
//   2) `node -r dotenv/config scripts/composio-trigger.mjs --create`   → creates it.
//
// user id defaults to the test tenant uuid (must match the user id the Gmail
// account was connected under). Override with `user=<id>` — per-person pairing
// passes the composite `user=<tenantUuid>:<technicianRef>`.

import { Composio } from '@composio/core';

// Same fail-closed shape check as composio-reconnect.mjs: a trigger minted on a
// malformed composite (e.g. trailing colon) fires webhooks that are ALL rejected
// bad_payload — the connection looks healthy while every email is lost.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USER_ID = (process.argv.find((a) => a.startsWith('user='))?.slice(5) ?? '').trim()
  || '82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18'; // trimmed: bare/blank `user=` falls back, not ''
const sepIdx = USER_ID.indexOf(':');
const tenantPart = sepIdx === -1 ? USER_ID : USER_ID.slice(0, sepIdx);
const refPart = sepIdx === -1 ? null : USER_ID.slice(sepIdx + 1);
if (!UUID_RE.test(tenantPart) || (sepIdx !== -1 && (!refPart || refPart.startsWith('connector:')))) {
  console.error(
    `Invalid user id '${USER_ID}': expected <tenantUuid> or <tenantUuid>:<technicianRef> ` +
      `(uuid tenant; ref non-empty, not 'connector:*').`,
  );
  process.exit(1);
}
console.log(`Target user id: ${USER_ID}`);
const SLUG = 'GMAIL_NEW_GMAIL_MESSAGE';

if (!process.env.COMPOSIO_API_KEY) {
  console.error('COMPOSIO_API_KEY is not set in .env — add it and re-run.');
  process.exit(1);
}

const composio = new Composio(); // picks up COMPOSIO_API_KEY from env

// 1) Show what config this trigger needs.
const type = await composio.triggers.getType(SLUG);
console.log('=== TRIGGER CONFIG SCHEMA for', SLUG, '===');
console.log(JSON.stringify(type.config ?? type, null, 2));

// 2) Create it only on --create. triggerConfig is filled in after we read the schema.
if (process.argv.includes('--create')) {
  console.log(`\nCreating trigger for user ${USER_ID}…`);
  const trigger = await composio.triggers.create(USER_ID, SLUG, {
    triggerConfig: {
      interval: 1, // poll every minute
      labelIds: 'INBOX',
      userId: 'me',
    },
  });
  console.log('Trigger created:', JSON.stringify(trigger, null, 2));
}
