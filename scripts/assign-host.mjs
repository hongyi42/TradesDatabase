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
//   scripts/assign-host.mjs add-sandbox host=<host-name> sandbox=<sandbox_ref> bot=@<handle> [tenant=<uuid>]
//       → registers a pre-built COLD sandbox into the host's pool (the "rack of
//         blanks"). bind_telegram claims the next free one automatically for a
//         new hire — no per-hire operator step. bot= is the sandbox's Telegram
//         bot handle (the provision phase's getMe prints it) — bind_telegram
//         returns it so the manager can tell the hire which bot to open;
//         without it the claim is unusable chat-side ("ask your operator").
//         tech=<ref> BACKFILLS a seat somebody already occupies: the row is
//         registered AND claimed for that person in one go, so the pool never
//         offers an in-use sandbox to the next hire. Omit it only for a spare.
//   SANDBOX_BOT_TOKEN=<token> scripts/assign-host.mjs wire-bot host=<h> sandbox=<s> [tenant=<uuid>]
//       → THE ONE-BOT-PER-PERSON STEP. Asks Telegram who this bot is (getMe),
//         stores its NUMERIC ID on the pool row, and points its menu button at
//         the console. The id is what lets a launch from this bot be verified
//         without its token ever reaching Render (src/telegram/initData.ts);
//         the token is read from the environment, never from argv, and is not
//         stored anywhere. Re-runnable: it re-reads getMe and re-points.
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
  claimSandbox,
  createHost,
  getHostByName,
  getTechnician,
  listPoolRows,
  registerSandbox,
  setSandboxBotId,
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
  'add-sandbox': ['host', 'sandbox', 'bot', 'tenant', 'tech'],
  'wire-bot': ['host', 'sandbox', 'tenant', 'url'],
  'set-badge': ['ref', 'hash', 'tenant'],
  'rotate-badge': ['ref', 'tenant'],
};
if (!command || !(command in KNOWN_KEYS)) {
  console.error(
    `Usage: assign-host.mjs create-host name=<n> | assign ref=<r> host=<h> sandbox=<s> ` +
      `| add-sandbox host=<h> sandbox=<s> | wire-bot host=<h> sandbox=<s> ` +
      `| set-badge ref=<r> hash=<sha256> ` +
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
  // Normalize + validate the bot handle: Telegram bot usernames are 5-32 chars
  // of [A-Za-z0-9_] and end in "bot". Omission is a loud warning, not an error —
  // the pool row then registers handle-less and the bind surfaces "ask your
  // operator" chat-side.
  let botUsername;
  if (args.bot) {
    botUsername = args.bot.startsWith('@') ? args.bot : `@${args.bot}`;
    if (!/^@[A-Za-z0-9_]{5,32}$/.test(botUsername) || !/bot$/i.test(botUsername)) {
      console.error(
        `bot='${args.bot}' does not look like a Telegram bot handle (@name ending in "bot"). Aborting.`,
      );
      process.exit(1);
    }
  } else {
    console.error(
      `WARN: no bot=@<handle> given — bind_telegram will have no handle to relay ` +
        `and the manager must ask the operator. Pass it (provision's getMe prints it).`,
    );
  }
  // 23505 = this host already has that sandbox_ref. Re-running the command is
  // the normal way an operator recovers from a half-finished wiring, so say what
  // is already there instead of dumping a constraint name.
  let row;
  try {
    row = await registerSandbox({
      tenantId,
      hostId: host.id,
      sandboxRef: args.sandbox,
      botUsername,
    });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    const existing = (await listPoolRows(tenantId)).find(
      (r) => r.sandbox_ref === args.sandbox && r.host_id === host.id,
    );
    console.error(
      `Sandbox '${args.sandbox}' is already registered on host ${host.name}` +
        `${existing?.technician_id ? ` and claimed (technician ${existing.technician_id})` : ' and COLD'}` +
        `${existing?.bot_id ? `, bot id ${existing.bot_id}` : ', no bot id yet'}. ` +
        `Nothing to do here — wire-bot is the next step.`,
    );
    process.exit(existing ? 0 : 1);
  }
  // A seat somebody already occupies must NOT be registered cold: the pool
  // would hand an in-use sandbox to the next hire and two people would share one
  // agent. tech=<ref> claims it in the same breath as registering it.
  if (args.tech) {
    const tech = await getTechnician(tenantId, args.tech);
    if (!tech) {
      console.error(
        `Registered '${row.sandbox_ref}' but no technician ref='${args.tech}' in this tenant — ` +
          `the row is COLD and claimable. Claim it or delete it.`,
      );
      process.exit(1);
    }
    if (tech.sandbox_ref && tech.sandbox_ref !== args.sandbox) {
      console.error(
        `Registered '${row.sandbox_ref}' but ${args.tech} is on sandbox '${tech.sandbox_ref}'. ` +
          `Refusing to claim — the row is COLD and claimable. Check which seat is which.`,
      );
      process.exit(1);
    }
    const claimed = await claimSandbox(row.id, tech.id);
    if (!claimed) {
      console.error(`Registered '${row.sandbox_ref}' but the claim lost a race. Re-run.`);
      process.exit(1);
    }
    console.log(
      `Registered sandbox '${row.sandbox_ref}' on host ${host.name} and claimed it for ` +
        `${tech.display_name ?? args.tech} (tenant ${tenantId}` +
        `${row.bot_username ? `, bot ${row.bot_username}` : ', NO bot handle'}).`,
    );
  } else {
    console.log(
      `Registered cold sandbox '${row.sandbox_ref}' on host ${host.name} (tenant ${tenantId}` +
        `${row.bot_username ? `, bot ${row.bot_username}` : ', NO bot handle'}). ` +
        `bind_telegram claims it for the next hire who has no sandbox.`,
    );
  }
} else if (command === 'wire-bot') {
  const tenantId = args.tenant || '82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18'; // Default Tenant (test)
  const token = process.env.SANDBOX_BOT_TOKEN;
  if (!token || !/^[0-9]{1,20}:/.test(token)) {
    console.error(
      `wire-bot needs the seat's bot token in SANDBOX_BOT_TOKEN (never as an argument — ` +
        `argv lands in shell history and process listings).`,
    );
    process.exit(1);
  }
  if (!args.host || !args.sandbox) {
    console.error('wire-bot requires host=<host-name> sandbox=<sandbox_ref>.');
    process.exit(1);
  }
  const host = await getHostByName(args.host);
  if (!host) {
    console.error(`No host named '${args.host}'. Run create-host first.`);
    process.exit(1);
  }
  const row = (await listPoolRows(tenantId)).find(
    (r) => r.sandbox_ref === args.sandbox && r.host_id === host.id,
  );
  if (!row) {
    console.error(
      `No sandbox '${args.sandbox}' on host ${host.name} for tenant ${tenantId}. ` +
        `Run add-sandbox first.`,
    );
    process.exit(1);
  }
  if (row.retired_at) {
    console.error(
      `Sandbox '${args.sandbox}' is retired — wiring its bot would hand a recycled seat ` +
        `a working door. Re-register it first.`,
    );
    process.exit(1);
  }
  // Ask Telegram who this token belongs to, rather than trusting the id in it:
  // getMe also proves the token is live and gives the handle to cross-check.
  const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const me = await meResp.json().catch(() => null);
  if (!me?.ok) {
    console.error(`getMe failed: ${me?.description ?? `HTTP ${meResp.status}`}. Wrong token?`);
    process.exit(1);
  }
  const botId = String(me.result.id);
  const handle = `@${me.result.username}`;
  // The dangerous mistake this catches: the operator pastes seat B's token
  // while wiring seat A, and A's launches would then be verified against B's
  // bot forever.
  if (row.bot_username && row.bot_username.toLowerCase() !== handle.toLowerCase()) {
    console.error(
      `Token belongs to ${handle} but sandbox '${args.sandbox}' is registered as ` +
        `${row.bot_username}. Refusing — check which seat this token is for.`,
    );
    process.exit(1);
  }
  if (!row.bot_username) {
    // Nothing to cross-check against, which is the case where the wrong token
    // binds silently (review finding 2026-09-09). Store the handle getMe just
    // gave us so a re-run CAN be checked, and say out loud that this one was not.
    console.error(
      `WARN: sandbox '${args.sandbox}' had no registered handle, so the token could not be ` +
        `cross-checked. Recording ${handle} from getMe — confirm that is the right bot for ` +
        `this seat before anyone opens it.`,
    );
  }
  await setSandboxBotId({
    tenantId,
    hostId: host.id,
    sandboxRef: args.sandbox,
    botId,
    ...(row.bot_username ? {} : { botUsername: handle }),
  });
  const base = args.url || process.env.BOARD_PUBLIC_URL;
  if (!base) {
    console.error(
      `Stored bot id ${botId} for ${handle}, but BOARD_PUBLIC_URL is unset so the menu ` +
        `button was NOT set. Re-run with url=<https://host> to finish.`,
    );
    process.exit(1);
  }
  const url = `${base.replace(/\/+$/, '')}/console`;
  const btnResp = await fetch(`https://api.telegram.org/bot${token}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      menu_button: { type: 'web_app', text: 'Schedule', web_app: { url } },
    }),
  });
  const btn = await btnResp.json().catch(() => null);
  if (!btn?.ok) {
    console.error(
      `Stored bot id ${botId} for ${handle}, but setChatMenuButton failed: ` +
        `${btn?.description ?? `HTTP ${btnResp.status}`}.`,
    );
    process.exit(1);
  }
  console.log(
    `Wired ${handle} (id ${botId}) to sandbox '${args.sandbox}': launches from it now verify, ` +
      `and its menu button opens ${url}.`,
  );
  console.log(
    `Still manual, once per bot: BotFather → /mybots → ${handle} → Bot Settings → ` +
      `Configure Mini App → ${url}, which is what puts "Open App" at the top of the chat.`,
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
