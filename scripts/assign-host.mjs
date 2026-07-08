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
//   scripts/assign-host.mjs add-sandbox host=<host-name> sandbox=<sandbox_ref> [tenant=<uuid>]
//       → registers a pre-built COLD sandbox into the host's pool (the "rack of
//         blanks"). bind_telegram claims the next free one automatically for a
//         new hire — no per-hire operator step.
//   scripts/assign-host.mjs set-badge ref=<ref> hash=<sha256-of-badge> [tenant=<uuid>]
//       → registers a HAND-MINTED badge's fingerprint so the pull loop ships
//         it instead of erasing it and minting a competitor (do this for any
//         badge that predates the pull loop, e.g. the bootstrap tech-jane one).
//   scripts/assign-host.mjs rotate-badge ref=<ref> [tenant=<uuid>]
//       → THE leaked-badge procedure: clears the fingerprint, so the next pull
//         drops the old badge (403 within one poll) and mints a replacement.
//         Hand-editing revoked:true on the host does NOT stick — the pull
//         regenerates the file from the roster.

import { randomBytes } from 'node:crypto';
import {
  createHost,
  getHostByName,
  getTechnician,
  registerSandbox,
  updateTechnician,
} from '../dist/db/index.js';
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
const KNOWN_KEYS = {
  'create-host': ['name'],
  assign: ['ref', 'host', 'sandbox', 'tenant'],
  'add-sandbox': ['host', 'sandbox', 'tenant'],
  'set-badge': ['ref', 'hash', 'tenant'],
  'rotate-badge': ['ref', 'tenant'],
};
if (!command || !(command in KNOWN_KEYS)) {
  console.error(
    `Usage: assign-host.mjs create-host name=<n> | assign ref=<r> host=<h> sandbox=<s> ` +
      `| add-sandbox host=<h> sandbox=<s> | set-badge ref=<r> hash=<sha256> ` +
      `| rotate-badge ref=<r>   (each: [tenant=<uuid>])`,
  );
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
} else if (command === 'add-sandbox') {
  // No ref: a pool sandbox is cold (unassigned) until bind_telegram claims it,
  // so this branch runs BEFORE the ref-requiring block below.
  const tenantId = args.tenant || '82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18'; // Default Tenant (test)
  if (!args.host || !args.sandbox) {
    console.error('add-sandbox requires host=<host-name> sandbox=<sandbox_ref>.');
    process.exit(1);
  }
  const host = await getHostByName(args.host);
  if (!host) {
    console.error(`Host '${args.host}' not found — create it first with create-host.`);
    process.exit(1);
  }
  const row = await registerSandbox({ tenantId, hostId: host.id, sandboxRef: args.sandbox });
  console.log(
    `Registered cold sandbox '${row.sandbox_ref}' on host ${host.name} (tenant ${tenantId}). ` +
      `bind_telegram claims it for the next hire who has no sandbox.`,
  );
} else {
  const tenantId = args.tenant || '82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18'; // Default Tenant (test)
  if (!args.ref) {
    console.error(`${command} requires ref=<ref>.`);
    process.exit(1);
  }
  const tech = await getTechnician(tenantId, args.ref);
  if (!tech) {
    console.error(`Technician '${args.ref}' not found for tenant ${tenantId}.`);
    process.exit(1);
  }

  if (command === 'assign') {
    if (!args.host || !args.sandbox) {
      console.error('assign requires ref=<ref> host=<host-name> sandbox=<sandbox_ref>.');
      process.exit(1);
    }
    const host = await getHostByName(args.host);
    if (!host) {
      console.error(`Host '${args.host}' not found — create it first with create-host.`);
      process.exit(1);
    }
    const updated = await updateTechnician(tech.id, { host_id: host.id, sandbox_ref: args.sandbox });
    console.log(
      `Assigned ${updated.ref} → host ${host.name}, sandbox ${updated.sandbox_ref}. ` +
        `Badge will mint on the host's next pull.`,
    );
  } else if (command === 'set-badge') {
    if (!/^[0-9a-f]{64}$/i.test(args.hash ?? '')) {
      console.error('set-badge requires hash=<64-hex sha256 of the badge> — never the badge itself.');
      process.exit(1);
    }
    if (tech.badge_hash) {
      console.error(
        `'${args.ref}' already has a registered badge. If you mean to replace it, run ` +
          `rotate-badge first (the old badge dies on the next pull), or re-check the ref.`,
      );
      process.exit(1);
    }
    await updateTechnician(tech.id, { badge_hash: args.hash.toLowerCase() });
    console.log(`Registered ${args.ref}'s badge fingerprint — the pull loop will now ship it.`);
  } else {
    // rotate-badge
    if (!tech.badge_hash) {
      console.error(`'${args.ref}' has no registered badge — nothing to rotate.`);
      process.exit(1);
    }
    await updateTechnician(tech.id, { badge_hash: null });
    console.log(
      `Rotated: '${args.ref}''s old badge disappears from badges.json on the next pull (≤5 min) ` +
        `and a replacement mints in that same pull — install it from the host's pending file.`,
    );
  }
}
