// The spine eval's environment gate — imported FIRST by every entry point.
//
// This harness WRITES: it truncates spine tables and generates a whole world. The
// pilot database (hosted ref daqapdlkgxfrhquacprv) is the deployed pilot's LIVE
// data — Render web + cron and the trades-box-1 badge pull read it. A test run
// truncated its roster once already (2026-07-03) and locked a technician out.
//
// So the gate is FAIL-CLOSED by construction, in three layers:
//   1. .env.test is loaded with override, so the local stack is the DEFAULT
//      target rather than something the caller has to remember to select.
//   2. BOTH connection strings must independently look local. Not "neither is
//      hosted" — a typo'd or empty URL must fail, not pass by absence of evidence.
//   3. Any refusal exits non-zero before a single row is touched.
//
// requireLocalStack() has no --hosted flag and must never grow one: nothing in
// tiers 1 or 2 needs the pilot, so the strictest possible gate costs them
// nothing.
//
// TIER 3 IS DIFFERENT, AND IT GETS A DIFFERENT FUNCTION.
// ------------------------------------------------------
// Tier 3 measures the openclaw GATEWAY, which exists only on trades-box-1, whose
// sandboxes reach the spine through the doorman → Render → the PILOT database.
// There, the pilot is not a convenience — it is the subject. The user lifted the
// never-touch-the-pilot constraint for that purpose on 2026-08-12.
//
// So requirePilotStack() exists alongside requireLocalStack(), and the two are
// mirror images that cannot be talked into each other's job: one refuses
// everything that IS the pilot, the other refuses everything that is NOT. What
// this file must never become is ONE function with a flag — that is one bug away
// from letting tier 1 truncate the pilot, which is the 2026-07-03 incident.
//
// The DECISIONS live in src/eval/targetGuard.ts and src/eval/pilotGuard.ts, where
// they are typechecked and unit tested (including a test asserting the two never
// both accept the same environment). This file only does the I/O around them:
// load the env, print, exit.
import { config as dotenvConfig } from 'dotenv';
import { assessTarget } from '../../../dist/eval/targetGuard.js';
import { assessPilotTarget } from '../../../dist/eval/pilotGuard.js';

/**
 * Load the local-stack environment and prove it is local. Returns the two URLs
 * on success; exits the process on anything else.
 */
export function requireLocalStack({ quiet = false } = {}) {
  dotenvConfig({ quiet: true });
  // Override, not merge: .env.test's DB vars must WIN over .env — the same
  // retargeting the test suite does. This is also a guard in its own right: while
  // .env.test points at the local stack, no stray environment variable can aim
  // this harness anywhere else.
  dotenvConfig({ path: '.env.test', override: true, quiet: true });

  const dbUrl = process.env.DATABASE_URL ?? '';
  const supaUrl = process.env.SUPABASE_URL ?? '';
  const verdict = assessTarget(dbUrl, supaUrl);

  if (!verdict.ok) {
    console.error(`\nREFUSING TO RUN: ${verdict.reason}`);
    console.error(`  DATABASE_URL local: ${verdict.dbLocal}   SUPABASE_URL local: ${verdict.supaLocal}`);
    console.error(
      `\n  The spine eval writes — it truncates spine tables and generates a world. It runs\n` +
        `  ONLY against the local Supabase stack. Start it with:  npx supabase start\n` +
        `  (values land in .env.test — see .env.test.example.)\n`,
    );
    process.exit(1);
  }
  if (!quiet) console.log(`  target: LOCAL stack (${verdict.host})`);
  return { dbUrl, supaUrl };
}

/**
 * TIER 3 ONLY: load the PILOT environment and prove it is the pilot.
 *
 * Deliberately does NOT load .env.test. That file retargets everything at the
 * local stack, and it is loaded with `override: true` by requireLocalStack — so
 * reading it here would silently aim tier 3 at local and produce "gateway"
 * numbers from a run that never reached the gateway. That failure looks like a
 * result, which makes it worse than an error.
 *
 * Requires BOTH --pilot and --yes. Two flags rather than one because the cost of
 * a mistake is asymmetric: the downside of an extra keystroke is nothing, and the
 * downside of a stray `--yes` in some other command's history is writes to the
 * deployed pilot.
 */
export function requirePilotStack({ quiet = false } = {}) {
  dotenvConfig({ quiet: true });

  const confirmed = hasFlag('pilot') && hasFlag('yes');
  const dbUrl = process.env.DATABASE_URL ?? '';
  const supaUrl = process.env.SUPABASE_URL ?? '';
  const verdict = assessPilotTarget(dbUrl, supaUrl, { confirmed });

  if (!verdict.ok) {
    console.error(`\nREFUSING TO RUN: ${verdict.reason}`);
    if (verdict.detail) console.error(`  ${verdict.detail}`);
    console.error(
      `\n  Tier 3 drives the openclaw GATEWAY, which only exists on trades-box-1 — and the box's\n` +
        `  sandboxes read the PILOT database through the doorman. So tier 3 writes to the pilot,\n` +
        `  inside one dedicated eval tenant, and it never truncates anything.\n\n` +
        `    npm run spine-eval:world -- --pilot --yes\n`,
    );
    process.exit(1);
  }
  if (!quiet) {
    console.log(`  target: PILOT database (${verdict.host})`);
    console.log(`          writes are confined to one eval tenant; nothing is truncated or deleted tenant-wide`);
  }
  return { dbUrl, supaUrl };
}

/**
 * The model arm, from the EVAL_* variables the date-reliability eval already uses.
 *
 * Two jobs, and the second is easy to miss: the key drives the AGENT loop, but it
 * also has to be visible to the app under the names the app itself reads
 * (INFERENCE_API_KEY / _BASE_URL / _MODEL), because some TOOLS are
 * model-backed — record_field_note extracts structured fields through a forced
 * tool call (the two synthesis tools, brief_customer / answer_customer_question,
 * were retired 2026-09-15). Without the mapping those tools refuse with
 * "INFERENCE_API_KEY is not set" and part of the surface is untestable.
 *
 * Same provider, same key, so this is a rename rather than a substitution. Never
 * prints the key.
 */
export function modelConfig({ mapIntoApp = true } = {}) {
  const key = process.env.EVAL_INFERENCE_API_KEY ?? '';
  const baseUrl = process.env.EVAL_INFERENCE_BASE_URL ?? 'https://openrouter.ai/api/v1';
  const model = process.env.EVAL_MODEL ?? 'z-ai/glm-5.3';
  if (key && mapIntoApp) {
    process.env.INFERENCE_API_KEY ??= key;
    process.env.INFERENCE_BASE_URL ??= baseUrl;
    process.env.INFERENCE_MODEL ??= model;
  }
  return { available: Boolean(key), key, baseUrl, model };
}

/**
 * Config the DEPLOYED stack has and a bare local checkout does not.
 *
 * Only where its absence changes agent behaviour rather than merely disabling a
 * feature. BOARD_BOT_HANDLE is the case in point: without it no tool attaches a
 * `boardNote`, and the first tier-2 run showed the agent INVENTING a board URL
 * (`https://board.evalmain.com/schedule?date=…`) even though the tool description
 * says "no boardNote → say nothing about the board".
 *
 * That is worth writing down twice, because it is an operational finding as much
 * as an eval detail: if BOARD_BOT_HANDLE is ever missing on Render, every
 * schedule answer gets a fabricated link. Setting it here makes the eval test the
 * production condition — relay the REAL link verbatim — while the
 * fabricated-link grader still catches any link the tools did not return.
 */
export function productionLikeEnv() {
  const applied = [];
  if (!process.env.BOARD_BOT_HANDLE) {
    process.env.BOARD_BOT_HANDLE = 'DashboardMan_bot';
    applied.push('BOARD_BOT_HANDLE');
  }
  if (!process.env.BOARD_PUBLIC_URL) {
    process.env.BOARD_PUBLIC_URL = 'https://tradesdatabase.onrender.com';
    applied.push('BOARD_PUBLIC_URL');
  }
  return applied;
}

/**
 * Refuse to grade against a world that is no longer there.
 *
 * `npm test` TRUNCATES this database — that is src/test.setup.ts's documented
 * contract with the local stack. Run the suite after building the world and the
 * tenant rows survive (they live in `tenants`, which the suite leaves alone) while
 * every customer, job and visit is gone. Every read then returns `[]` and the
 * report shows dozens of confident, meaningless failures.
 *
 * One clear line beats 34 phantom ones, so this checks first and says exactly what
 * happened.
 */
export async function assertWorldPresent(sql, world) {
  const main = world.tenants?.find((t) => t.key === 'main');
  if (!main) {
    console.error('\nREFUSING TO RUN: world.json has no `main` tenant. Rebuild:  npm run spine-eval:world\n');
    process.exit(1);
  }
  const rows = await sql('select count(*)::int as n from customers where tenant_id = $1', [main.id]);
  const found = Number(rows[0]?.n ?? 0);
  if (found === 0) {
    console.error(
      `\nREFUSING TO RUN: the world in world.json is EMPTY in the database.\n` +
        `  tenant ${main.id} (${main.name}) has 0 customers, but the manifest expects ${main.counts.customers}.\n\n` +
        `  Almost always this: \`npm test\` truncates the local stack (src/test.setup.ts), which\n` +
        `  wipes the eval world while leaving its tenant rows behind. Rebuild it:\n\n` +
        `    npm run spine-eval:world\n`,
    );
    process.exit(1);
  }
  if (found !== main.counts.customers) {
    // Not fatal — a previous eval run legitimately adds rows — but a shrink means
    // something else has been writing here.
    console.log(`  note:   ${found} customers present, manifest built with ${main.counts.customers}`);
  }
}

/** `--name value` / `--name` argv helpers, shared by every entry point. */
export function argOf(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  return i > -1 && next && !next.startsWith('--') ? next : dflt;
}

export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}
