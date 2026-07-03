// Operator helper: register host machines and wire roster rows to them.
// Person→host/sandbox assignment is deliberately operator-side (sandboxes are
// pre-built cold at seat purchase); everything downstream — badge minting,
// badges.json content — flows automatically from these assignments via the
// host's pull endpoint.
//
// Usage (run with `node -r dotenv/config`, after `npm run build`):
//   scripts/assign-host.mjs create-host name=<host-name>
//       → registers the host and prints its pull token ONCE. Only the sha256
//         fingerprint is stored; losing the token means re-creating the host.
//   scripts/assign-host.mjs assign ref=<ref> host=<host-name> sandbox=<sandbox_ref> [tenant=<uuid>]
//       → points the person's roster row at that host + sandbox.

import { randomBytes } from 'node:crypto';
import { createHost, getHostByName, getTechnician, updateTechnician } from '../dist/db/index.js';
import { sha256hex } from '../dist/control/badges.js';

// Safety: this script WRITES — refuse anything but the TEST project (same
// guard as seed.mjs) until prod rollout is a deliberate, separate step.
const TEST_REF = 'daqapdlkgxfrhquacprv';
const supaUrl = process.env.SUPABASE_URL ?? '';
if (!supaUrl.includes(TEST_REF)) {
  console.error(`REFUSING TO RUN: SUPABASE_URL must target the test ref (${TEST_REF}).`);
  process.exit(1);
}

// Fail-closed argument handling (same rationale as composio-reconnect.mjs):
// a typo'd key must abort, never silently fall back.
const [command, ...rest] = process.argv.slice(2);
const KNOWN_KEYS = { 'create-host': ['name'], assign: ['ref', 'host', 'sandbox', 'tenant'] };
if (!command || !(command in KNOWN_KEYS)) {
  console.error(`Usage: assign-host.mjs create-host name=<n> | assign ref=<r> host=<h> sandbox=<s> [tenant=<uuid>]`);
  process.exit(1);
}
const args = {};
for (const a of rest) {
  const eq = a.indexOf('=');
  const key = eq === -1 ? a : a.slice(0, eq);
  if (eq === -1 || !KNOWN_KEYS[command].includes(key)) {
    console.error(`Unrecognized argument '${a}' for ${command}. Aborting.`);
    process.exit(1);
  }
  args[key] = a.slice(eq + 1).trim();
}

if (command === 'create-host') {
  if (!args.name) {
    console.error('create-host requires name=<host-name>.');
    process.exit(1);
  }
  const token = randomBytes(32).toString('hex');
  const host = await createHost(args.name, sha256hex(token));
  console.log(`Host registered: ${host.name} (${host.id})`);
  console.log(`\nPull token (shown ONCE — store it in the host's root-only env file):`);
  console.log(token);
} else {
  const tenantId = args.tenant || '82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18'; // Default Tenant (test)
  if (!args.ref || !args.host || !args.sandbox) {
    console.error('assign requires ref=<ref> host=<host-name> sandbox=<sandbox_ref>.');
    process.exit(1);
  }
  const host = await getHostByName(args.host);
  if (!host) {
    console.error(`Host '${args.host}' not found — create it first with create-host.`);
    process.exit(1);
  }
  const tech = await getTechnician(tenantId, args.ref);
  if (!tech) {
    console.error(`Technician '${args.ref}' not found for tenant ${tenantId}.`);
    process.exit(1);
  }
  const updated = await updateTechnician(tech.id, { host_id: host.id, sandbox_ref: args.sandbox });
  console.log(
    `Assigned ${updated.ref} → host ${host.name}, sandbox ${updated.sandbox_ref}. ` +
      `Badge will mint on the host's next pull.`,
  );
}
