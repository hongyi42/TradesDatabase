// Dev helper: reconnect the Gmail account so it grants a real mail scope.
// Deletes any existing Gmail connection under the test tenant, then starts a fresh
// OAuth flow and prints the URL to open. After approving in the browser (WATCH for a
// Gmail permission on the consent screen), run with `--wait` to confirm it went ACTIVE
// and print the granted scope.

import { Composio } from '@composio/core';

const TENANT = '82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18';
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

// 1) Remove the old basic-scope Gmail connection(s).
const list = await c.connectedAccounts.list({ userIds: [TENANT] });
const items = list.items ?? list.data ?? list;
for (const it of items) {
  if (it.toolkit?.slug === 'gmail') {
    await c.connectedAccounts.delete(it.id);
    console.log('Deleted old connection:', it.id);
  }
}

// 2) Start a fresh OAuth flow. (Managed OAuth uses link(), not the retired initiate().)
const req = await c.connectedAccounts.link(TENANT, AUTH_CONFIG);
console.log('\n=== OPEN THIS URL IN YOUR BROWSER, SIGN IN, APPROVE ===');
console.log(req.redirectUrl ?? req.redirect_url ?? '(no redirectUrl — full object below)');
console.log('\nfull:', JSON.stringify(req, null, 2));
