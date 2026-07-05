// Operator helper: print one person's Composio session mcp.url + the gateway
// registration snippet for their sandbox (registered beside trades-spine).
// The session itself is created by the lifecycle sweep (ensurePersonSession);
// this script only READS it back for the one-time sandbox wiring.
//
// Usage (run with `node -r dotenv/config`, after `npm run build`):
//   scripts/provision-session.mjs tenant=<uuid> ref=<ref>
//
// CUSTODY: the printed mcp.url grants that person's whole session. It goes
// into the sandbox's gateway config as a secretRef — never into logs, the
// repo, or the model context. COMPOSIO_API_KEY stays control-plane-only.

import { getTechnician } from '../dist/db/index.js';
import { getSessionMcpUrl } from '../dist/composio/sessions.js';

// Safety: same TEST-project guard as assign-host.mjs / seed.mjs.
const TEST_REF = 'daqapdlkgxfrhquacprv';
const supaUrl = process.env.SUPABASE_URL ?? '';
if (!supaUrl.includes(TEST_REF)) {
  console.error(`REFUSING TO RUN: SUPABASE_URL must target the test ref (${TEST_REF}).`);
  process.exit(1);
}
if (!process.env.COMPOSIO_API_KEY) {
  console.error('COMPOSIO_API_KEY is not set (control-plane .env) — cannot read the session.');
  process.exit(1);
}

// Fail-closed argument handling (assign-host.mjs pattern): typo'd keys abort.
const KNOWN_KEYS = ['tenant', 'ref'];
const args = {};
for (const a of process.argv.slice(2)) {
  const eq = a.indexOf('=');
  const key = eq === -1 ? a : a.slice(0, eq);
  if (eq === -1 || !KNOWN_KEYS.includes(key)) {
    console.error(`Unrecognized argument '${a}'. Usage: provision-session.mjs tenant=<uuid> ref=<ref>`);
    process.exit(1);
  }
  args[key] = a.slice(eq + 1).trim();
}
const tenantId = args.tenant || '82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18'; // Default Tenant (test)
if (!args.ref) {
  console.error('ref=<ref> is required. Usage: provision-session.mjs tenant=<uuid> ref=<ref>');
  process.exit(1);
}

const tech = await getTechnician(tenantId, args.ref);
if (!tech) {
  console.error(`Technician '${args.ref}' not found for tenant ${tenantId}.`);
  process.exit(1);
}
if (!tech.composio_session_id) {
  console.error(
    `'${args.ref}' has no Composio session yet — the 15-min lifecycle sweep creates one for ` +
      `ACTIVE rows (state now: ${tech.state}). Wait a tick, or check the cron's summary.`,
  );
  process.exit(1);
}

const url = await getSessionMcpUrl(tech);
console.log(`Session for ${tech.ref} (tier=${tech.tier}, session=${tech.composio_session_id}):\n`);
console.log(`mcp.url (SENSITIVE — deliver via secretRef only):\n${url}\n`);
console.log(`Gateway registration snippet (beside trades-spine in the sandbox's mcp.servers):`);
console.log(
  JSON.stringify(
    {
      mcp: {
        servers: {
          composio: { url: { secretRef: `composio-mcp-url-${tech.ref}` } },
        },
      },
    },
    null,
    2,
  ),
);
console.log(
  `\nStore the url under the secretRef 'composio-mcp-url-${tech.ref}' on the HOST (root-only), ` +
    `never in the sandbox filesystem or this repo.`,
);
