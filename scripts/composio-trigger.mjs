// Dev helper: create the Gmail "new message" trigger for the live Composio test.
// The dashboard can't enable this trigger via clicks (SDK-only), so we do it here.
//
// Reads COMPOSIO_API_KEY from .env. Run in two passes:
//   1) `node -r dotenv/config scripts/composio-trigger.mjs`            → prints the
//      required triggerConfig schema (so we know what fields Gmail needs).
//   2) `node -r dotenv/config scripts/composio-trigger.mjs --create`   → creates it.
//
// user id defaults to the test tenant uuid (must match the user id the Gmail
// account was connected under). Override with a 2nd arg if Composio assigned its own.

import { Composio } from '@composio/core';

const USER_ID = process.argv.find((a) => a.startsWith('user='))?.slice(5)
  ?? '82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18';
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
