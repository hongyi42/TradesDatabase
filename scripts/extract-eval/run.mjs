// EXTRACT EVAL — what the extractor actually returns, scored against labels.
//
//   npm run extract-eval                  # the 12 fixtures (the baseline)
//   npm run extract-eval -- --runs 5      # default 3
//
// `--with-candidates` existed until corpus v4 and is GONE with the twins it ran:
// the job-naming question left the extractor for the planner (see corpus.mjs).
// Left as a hard refusal rather than an ignored flag — a flag that silently
// measures nothing while printing a score is worse than no flag.
//
// WHY THIS IS A SCRIPT AND NOT A TEST. `vitest.config.ts:6` runs every
// `src/**/*.test.ts` and `src/test.setup.ts:8` loads `.env`, so a test file here
// would make ~30 live, billed model calls on every `npm test` in any checkout
// that has a key — including every phase gate and every pre-commit run. The
// repo's `describe.skipIf(!hasModelCredentials())` convention
// (`src/email/classify.test.ts:13`) is for one to three clear-cut assertions,
// "kept to clear-cut cases to avoid model flakiness". A scored eval is the other
// thing, and the repo already has a home for that shape: scripts/date-eval,
// scripts/spine-eval.
//
// WHAT IT MEASURES. Only the three fields the DOOR gates on (see corpus.mjs).
// A model's prose differs run to run without being wrong; its answer to "did the
// firm agree to come out" does not get to.
//
// WHAT IT CANNOT MEASURE, stated rather than faked: token counts. The extractor's
// public surface returns the tool arguments only — `runForcedTool` consumes the
// provider's `usage` into `recordModelUsage` and hands back the args. So this
// records the SIZE of what came back as a proxy, and detects truncation the way
// production does: a truncated reply throws (`forcedTool.ts:340` and `:433`),
// and that throw is reported per run.
import { config as dotenvConfig } from 'dotenv';
import { defaultExtractor } from '../../dist/writePath/extract.js';
import { activeProvider, hasModelCredentials, resolveOpenAiEndpoint } from '../../dist/model/forcedTool.js';
import { FIXTURES, CORPUS_VERSION } from './corpus.mjs';

dotenvConfig({ quiet: true });

// PINNED, not inherited. The plan's preflight settled that production runs
// z-ai/glm-5.3 — `toolLoop.ts` and `forcedTool.ts` share the one INFERENCE_MODEL,
// and the pilot's own billing shows glm-5.3 for the extractor's no-lane calls.
// Pinning here means a later change to DEFAULT_OPENAI_MODEL cannot move a
// recorded baseline without somebody editing this line.
process.env.INFERENCE_MODEL ??= 'z-ai/glm-5.3';

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const RUNS = Number(argOf('runs', '3'));
if (!Number.isInteger(RUNS) || RUNS < 1) {
  console.error(`extract-eval: --runs must be a positive integer, got ${argOf('runs', '3')}`);
  process.exit(1);
}
if (hasFlag('with-candidates')) {
  console.error(
    'extract-eval: --with-candidates was removed with corpus v4. The extractor is no longer ' +
      'shown candidate jobs \u2014 that question moved to the planner (rung 10d). Re-run without it.',
  );
  process.exit(1);
}

// THE APP'S OWN CHECK, not a hand-rolled one. `hasModelCredentials` follows the
// provider switch — its whole point is that a MODEL_PROVIDER flip does not leave
// a caller silently skipping or silently failing.
if (!hasModelCredentials()) {
  console.error('extract-eval: no model credentials for the active provider — nothing to run.');
  process.exit(1);
}

const cases = FIXTURES;

// THE HEADER MUST NOT BE ABLE TO LIE. `activeProvider()` keys on MODEL_PROVIDER,
// which this script does not pin — and `.env` here carries an ANTHROPIC_API_KEY,
// so a stray MODEL_PROVIDER=anthropic (the documented rollback lever) would send
// every call to Claude while a hard-coded line still printed glm-5.3. Print what
// actually resolved, and refuse to record a baseline against a provider whose
// model this script did not pin.
const provider = activeProvider();
const resolved = provider === 'openai' ? resolveOpenAiEndpoint() : null;
console.log(`\n=== EXTRACT EVAL — ${cases.length} fixtures x ${RUNS} runs ===`);
console.log(`corpus v${CORPUS_VERSION}   provider: ${provider}`);
if (resolved) console.log(`model: ${resolved.model}   baseUrl: ${resolved.baseUrl}`);
console.log('');
if (provider !== 'openai') {
  console.error(
    `extract-eval: MODEL_PROVIDER=${provider} — this eval pins INFERENCE_MODEL only, so the ` +
      `baseline would be recorded against an unpinned model. Unset MODEL_PROVIDER and re-run.`,
  );
  process.exit(1);
}

/** The door's own reading of an extraction — the three gates, nothing else. */
const asDoorReads = (x) => ({
  committed: x.visitCommitted === true,
  skips: x.touchesOperations === false,
  status: x.statusSignal ?? null,
});

const tally = { committed: [0, 0], skips: [0, 0], status: [0, 0] };
// Per fixture too, and it is the half that reads: an aggregate cannot say WHICH
// message moved, and every finding this eval has produced came from one fixture
// behaving differently from the rest.
const perFixture = new Map();
const truncations = [];
const errors = [];
const rows = [];

for (const f of cases) {
  for (let run = 1; run <= RUNS; run++) {
    const context =
      f.earlier || f.fromTheFirm
        ? { earlier: f.earlier ?? [], ...(f.fromTheFirm ? { fromTheFirm: true } : {}) }
        : undefined;
    let got;
    let error = null;
    const started = Date.now();
    try {
      got = await defaultExtractor(f.text, undefined, context);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      if (/truncated at maxTokens/.test(error)) truncations.push(`${f.id} run ${run}`);
      else errors.push(`${f.id} run ${run}`);
    }
    const ms = Date.now() - started;

    if (error) {
      rows.push({ id: f.id, run, ms, error });
      continue;
    }
    const read = asDoorReads(got);
    if (!perFixture.has(f.id)) perFixture.set(f.id, { committed: 0, skips: 0, status: 0, runs: 0 });
    const mine = perFixture.get(f.id);
    mine.runs += 1;
    for (const field of ['committed', 'skips', 'status']) {
      const ok = read[field] === f.expect[field];
      tally[field][ok ? 0 : 1] += 1;
      if (ok) mine[field] += 1;
    }
    rows.push({
      id: f.id,
      run,
      ms,
      ...read,
      bytes: JSON.stringify(got).length,
    });
  }
}

for (const r of rows) {
  if (r.error) {
    console.log(`${r.id.padEnd(34)} run ${r.run}  ${String(r.ms).padStart(6)}ms  ERROR ${r.error.slice(0, 80)}`);
    continue;
  }
  console.log(
    `${r.id.padEnd(34)} run ${r.run}  ${String(r.ms).padStart(6)}ms  ` +
      `committed=${String(r.committed).padEnd(5)} skips=${String(r.skips).padEnd(5)} ` +
      `status=${String(r.status).padEnd(11)} ${String(r.bytes).padStart(4)}B`,
  );
}

const line = (name, [ok, bad]) =>
  `${name.padEnd(10)} ${String(ok).padStart(3)}/${ok + bad}` +
  (ok + bad ? `  ${((ok / (ok + bad)) * 100).toFixed(0)}%` : '  —');

console.log('\n--- per fixture (correct runs of ' + RUNS + ') ---');
for (const [id, m] of perFixture) {
  console.log(
    `${id.padEnd(34)} committed ${m.committed}/${m.runs}  skips ${m.skips}/${m.runs}  status ${m.status}/${m.runs}`,
  );
}

console.log('\n--- agreement with the labels, by the door\'s reading ---');
for (const f of ['committed', 'skips', 'status']) console.log(line(f, tally[f]));

const times = rows.filter((r) => !r.error).map((r) => r.ms).sort((a, b) => a - b);
const pct = (q) => (times.length ? times[Math.min(times.length - 1, Math.floor(times.length * q))] : 0);
console.log(
  `\ntruncated: ${truncations.length ? truncations.join(', ') : 'none'}` +
    `   other errors: ${errors.length ? errors.join(', ') : 'none'}` +
    `   p50 ${pct(0.5)}ms  p95 ${pct(0.95)}ms\n`,
);

// A RUN THAT COULD NOT MEASURE IS NOT A PASS. Label disagreement is the eval's
// SUBJECT and never sets the exit code — the baseline is whatever the model
// scores. But a truncation or a failed call means no number was taken, and a
// silent 0 there would let a phase gate read "green" off 24 dead calls.
process.exitCode = truncations.length + errors.length > 0 ? 1 : 0;
