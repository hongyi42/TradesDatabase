// One-time: retire the manager review queue's leftover open items (plan
// thoughts/shared/plans/2026-09-19-retire-the-manager-review-queue.md, Phase 3).
//
// The sweep itself is src/jobs/retireReviewQueue.ts (tested there against the
// local stack); this is only its wrapper. Across EVERY tenant it:
//   - closes open items of the kinds the retired queue carried (sheet_ref_mismatch,
//     unknown_ref_capture, offboarding_reminder, unlinked_call, call_action,
//     overdue_visit_gap, job_cost_gap), after CARRYING the two that still mean
//     something to the planner as observations (a removal still in its grace
//     period; mail from a ref still off the roster);
//   - leaves OPEN any item the planner escalated (it reads how those ended),
//     every live staged token, pairing_verification and availability_setup;
//   - closes a pending_deactivation staged before deactivations expired.
// Re-runnable: a second run finds nothing left to do.
//
// APPLY ORDER. Run it after the web service is running this plan's code — the
// old service still lists these items to managers.
//
// Targets & flags (seed.mjs idiom). BUILD FIRST — this imports from dist/:
//   npm run build && node -r dotenv/config scripts/retire-review-queue.mjs --local [--dry-run]
//   npm run build && node -r dotenv/config scripts/retire-review-queue.mjs --hosted [--dry-run]
//     --hosted is REQUIRED to touch the pilot; --dry-run reports without writing.
//     Run the dry run first and read it.
import { config as dotenvConfig } from 'dotenv';
import { isLocalDbUrl } from '../dist/testEnvGuard.js';
import { retireReviewQueue } from '../dist/jobs/retireReviewQueue.js';

const flag = (name) =>
  process.argv.includes(`--${name}`) ||
  process.env[`npm_config_${name.replaceAll('-', '_')}`] === 'true';
const LOCAL_FLAG = flag('local');
const HOSTED_FLAG = flag('hosted');
const DRY_RUN = flag('dry-run');

if (LOCAL_FLAG) dotenvConfig({ path: '.env.test', override: true });

// Same two-URL agreement + explicit-hosted safety as seed.mjs.
const TEST_REF = 'daqapdlkgxfrhquacprv';
const dbUrl = process.env.DATABASE_URL ?? '';
const supaUrl = process.env.SUPABASE_URL ?? '';
const dbHosted = dbUrl.includes(TEST_REF);
const supaHosted = supaUrl.includes(TEST_REF);
const TARGET =
  dbHosted && supaHosted
    ? 'hosted-test'
    : isLocalDbUrl(dbUrl) && isLocalDbUrl(supaUrl)
      ? 'local'
      : null;
if (!TARGET) {
  console.error(
    'REFUSING TO RUN: DATABASE_URL and SUPABASE_URL must BOTH target the hosted test ' +
      'ref or the local stack. Nothing was written.',
  );
  process.exit(1);
}
if (TARGET === 'hosted-test' && !HOSTED_FLAG) {
  console.error(
    'REFUSING TO RUN: target is the HOSTED pilot database — pass --hosted explicitly. ' +
      'For the local playground: --local. Nothing was written.',
  );
  process.exit(1);
}

const report = await retireReviewQueue({ dryRun: DRY_RUN });
console.log(JSON.stringify({ target: TARGET, ...report }, null, 2));
console.error(
  DRY_RUN
    ? 'DRY RUN — nothing was written. Read the counts, then run again without --dry-run. ' +
        '`carried` here counts what WOULD be raised; a real run counts only what was new, so it ' +
        'can be lower (the live writers may have raised the same subject already).'
    : 'Done. A second run should report nothing left to dismiss.',
);
