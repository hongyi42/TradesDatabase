// Spine-eval TIER 2 — the agent layer. THIS IS THE STEP THAT SPENDS MONEY.
//
//   npm run spine-eval:agent -- --quick --yes      # the /goal loop subset
//   npm run spine-eval:agent -- --yes              # the full corpus
//   npm run spine-eval:agent -- --only D,B --yes   # families or id prefixes
//   npm run spine-eval:agent -- --repeat 3 --yes   # flake measurement
//
// Drives the REAL model (GLM-5.2 on DeepInfra, the fleet's own route) against the
// REAL spine MCP server, with the REAL doctrine extracted from the box's own
// bootstrap script. Each scenario is a scripted conversation in a fresh context,
// and the whole trajectory — every tool call, its arguments, its result, and the
// per-leg timings — is recorded, because "wrong" is cheap to see and "wrong WHERE"
// is the only thing worth acting on.
//
// GATES:
//   1. --yes is required. It spends money, every time.
//   2. The model is named in the report. Comparing two runs on different models
//      compares nothing, so the route is recorded rather than assumed.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { requireLocalStack, modelConfig, productionLikeEnv, assertWorldPresent, argOf, hasFlag } from './lib/env.mjs';
import { startSpineServer, makeCaller } from './lib/mcp.mjs';
import { buildCorpus, BASELINE_GRADERS, calendarCoverageNote } from '../../dist/eval/corpus.js';
import { runGraders, filterExpectedRefusals, GUARD_STEERS } from '../../dist/eval/graders.js';
import { extractDoctrine, buildSystemPrompt, doctrineFingerprint } from '../../dist/eval/doctrine.js';
import { tenantOf } from '../../dist/eval/worldManifest.js';
import { ms, rate, summarise } from '../../dist/eval/metrics.js';
import { titleWeekday } from '../../dist/eval/clock.js';

console.log('\n=== SPINE EVAL — TIER 2 (agent layer) ===');
const { dbUrl } = requireLocalStack();
const model = modelConfig();
const boardEnv = productionLikeEnv();

const DIR = argOf('dir', join(process.cwd(), 'spine-eval-runs'));
const ONLY = (argOf('only', '') || '').split(',').map((x) => x.trim()).filter(Boolean);
const REPEAT = Math.max(1, Number(argOf('repeat', '1')));
// 12, raised from 8 (2026-08-14): D05 did honest detective work on genuinely
// contradictory data (the world's job timestamps are all build-time, so "jobs
// completed last month" needed the pivot to v_schedule visit dates), reached
// the right answer on call 8, and the ceiling cut it off with no step left to
// SPEAK — graded as the agent's empty reply when it was the harness's budget.
// A ceiling this tight blames legitimate long chains for the instrument.
const MAX_STEPS = Number(argOf('max-steps', '12'));
const TOOL_TIMEOUT = Number(argOf('tool-timeout', '30000'));
const MODEL_TIMEOUT = Number(argOf('model-timeout', '180000'));
// Anti-runaway ceiling, not a length budget: GLM-5.2 can disappear into its
// thinking channel and stream reasoning until the WALL budget kills it (530s
// observed on Nebius, 260s on DeepInfra, 2026-08-14 — both with an EMPTY
// visible reply). max_tokens makes such a call COMPLETE at the cap instead,
// which routes it into the empty-completion retry below. 32768 sits far above
// any legitimate turn measured to date; a legit cap-hit prints loudly.
const MAX_OUTPUT_TOKENS = Number(argOf('max-output-tokens', '32768'));

// DeepInfra GLM-5.2 rates, USD per million tokens. Overridable because vendor
// pricing moves (it dropped ~20% once already) and a stale constant would quietly
// misreport spend.
const RATE_IN = Number(argOf('rate-in', '0.75')) / 1e6;
const RATE_OUT = Number(argOf('rate-out', '2.40')) / 1e6;

if (!model.available) {
  console.error(
    `\nNo model key. Tier 2 needs EVAL_INFERENCE_API_KEY (the same variable the\n` +
      `date-reliability eval uses). Tier 1 runs without it:  npm run spine-eval:tools\n`,
  );
  process.exit(1);
}

const worldPath = join(DIR, 'world.json');
if (!existsSync(worldPath)) {
  console.error(`\nNo world at ${worldPath}. Run:  npm run spine-eval:world\n`);
  process.exit(1);
}
const world = JSON.parse(readFileSync(worldPath, 'utf8'));

// External dependencies, same loud-skip contract as tier 1.
const enabled = new Set(
  hasFlag('with-external')
    ? ['network', 'composio', 'maps']
    : ['network', 'composio', 'maps'].filter((r) => hasFlag(`with-${r}`)),
);

const doctrine = extractDoctrine(readFileSync('Box_Setup_Stuff/bootstrap-box.sh', 'utf8'));
const doctrineId = doctrineFingerprint(doctrine);
const doctrineChars = doctrine.reduce((n, d) => n + d.heading.length + d.body.length, 0);

const all = buildCorpus();
let selected = hasFlag('quick') ? all.filter((x) => x.quick) : all;
if (ONLY.length) selected = selected.filter((x) => ONLY.some((p) => x.id.startsWith(p) || x.family === p));
const runnable = selected.filter((x) => !x.requires || enabled.has(x.requires));
const skipped = selected.filter((x) => x.requires && !enabled.has(x.requires));

const turnsTotal = runnable.reduce((n, x) => n + x.turns({ world, tenant: tenantOf(world, x.tenant), anchor: world.anchor }).length, 0) * REPEAT;
// Each scripted turn costs at least one model call, plus one per tool round trip.
const estCalls = Math.round(turnsTotal * 2.2);
const estCost = estCalls * 0.012;

console.log(`  world:    ${titleWeekday(world.anchor)} ${world.anchor} (seed ${world.seed})`);
console.log(`  model:    ${model.model} @ ${new URL(model.baseUrl).host}`);
console.log(`  doctrine: ${doctrine.length} sections, ${doctrineChars.toLocaleString()} chars, fingerprint ${doctrineId}`);
if (boardEnv.length) console.log(`  env:      supplied ${boardEnv.join(', ')} to match the deployed stack`);
console.log(`  corpus:   ${runnable.length} scenario(s)${REPEAT > 1 ? ` × ${REPEAT} repeats` : ''}, ${turnsTotal} scripted turns, ${skipped.length} skipped`);
console.log(`  ${calendarCoverageNote(world.anchor)}`);

if (!hasFlag('yes')) {
  console.log(`\n  THIS SPENDS MONEY: roughly ${estCalls} model calls, ~$${estCost.toFixed(2)}, ~${Math.ceil((turnsTotal * 8) / 60)} min.`);
  console.log(`  Nothing has run. Re-run with --yes:\n`);
  console.log(`    npm run spine-eval:agent -- ${hasFlag('quick') ? '--quick ' : ''}--yes\n`);
  process.exit(0);
}

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
const sql = async (text, params = []) => (await client.query(text, params)).rows;
await assertWorldPresent(sql, world);
const server = await startSpineServer();
const spine = makeCaller(server);

// ── the model call ────────────────────────────────────────────────────────────
let tokensIn = 0;
let tokensOut = 0;
let stallRetries = 0;
let emptyRetries = 0;
let cappedCompletions = 0; // finish_reason 'length' WITH content — cap too low, truncated reply
let cappedRunaways = 0; // finish_reason 'length' with EMPTY reply — runaway reasoning stopped by the cap
const ttftAll = []; // time-to-first-token per successful call — perceived latency

// STREAMING with a liveness watchdog (2026-08-14, user decision), replacing a
// fixed 180s timeout. The old design could not tell a STALL from a slow answer
// — silence looks identical either way in a non-streaming call, so it waited
// the full budget before retrying (D01 burned 180s on a request that produced
// nothing; the rerun answered in 10s). Streamed, a healthy call proves it is
// alive with a chunk every few hundred ms even while thinking, so death is
// detectable in seconds and NO ceiling is needed on calls that are visibly
// working — a genuinely long-horizon turn streams for minutes untouched
// (S06 legitimately ran 180.5s and nearly died to the old fixed timeout).
const FIRST_CHUNK_MS = Number(argOf('first-token-timeout', '20000'));
const IDLE_CHUNK_MS = Number(argOf('inter-token-timeout', '30000'));

/** Read one streamed completion; resets the watchdog on EVERY received chunk. */
async function readStream(res, controller, armWatchdog) {
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  const toolCalls = []; // index → {id, name, arguments}
  let usage = null;
  let firstChunkAt = null;
  let finishReason = null;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (firstChunkAt === null) firstChunkAt = performance.now();
    armWatchdog(IDLE_CHUNK_MS); // ANY bytes count as liveness, comments included
    buf += decoder.decode(value, { stream: true });
    // SSE events are newline-delimited `data: {...}` lines; a partial line
    // stays in the buffer until its terminator arrives.
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue; // comments/keep-alives = liveness only
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        continue; // a torn frame is not worth killing the call over
      }
      if (json.usage) usage = json.usage;
      if (json.choices?.[0]?.finish_reason) finishReason = json.choices[0].finish_reason;
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === 'string') content += delta.content;
      for (const tc of delta.tool_calls ?? []) {
        const slot = (toolCalls[tc.index] ??= { id: '', name: '', arguments: '' });
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name += tc.function.name;
        if (tc.function?.arguments) slot.arguments += tc.function.arguments;
      }
    }
  }
  return { content, toolCalls, usage, firstChunkAt, finishReason };
}

async function chat(messages, tools) {
  const body = {
    model: model.model,
    messages,
    tools,
    tool_choice: 'auto',
    // Deterministic as the provider allows: a corpus that moves under you cannot
    // be regressed against.
    temperature: 0,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
  };
  // The overall deadline is now a BACKSTOP against a stream that trickles
  // forever, not the stall detector — liveness is judged per chunk. Kept
  // generous on purpose: a call that is visibly producing tokens for three
  // minutes is a latency finding, not a hang.
  const overallDeadline = performance.now() + MODEL_TIMEOUT * 2;
  let stalledMs = 0; // time burned by stalled attempts, kept in the returned ms
  for (let attempt = 1; attempt <= 4; attempt++) {
    const remaining = overallDeadline - performance.now();
    if (remaining <= 0) return { error: `model gave up: total budget (${Math.round(MODEL_TIMEOUT * 2)}ms) exhausted across ${attempt - 1} attempt(s)`, ms: MODEL_TIMEOUT * 2 };
    const controller = new AbortController();
    let watchdog = null;
    let stalled = false;
    let budgetExceeded = false;
    // One timer, re-armed on every chunk. Firing = either the stream went
    // SILENT (never started, or died mid-flight — the only shape that means
    // dead) or the overall budget ran out under a stream that was still
    // visibly alive. The two must not be conflated: a stall retries, a
    // budget overrun is a latency finding.
    const armWatchdog = (ms) => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        if (performance.now() >= overallDeadline - 50) budgetExceeded = true;
        else stalled = true;
        controller.abort();
      }, Math.min(ms, Math.max(1, overallDeadline - performance.now())));
    };
    const started = performance.now();
    try {
      armWatchdog(FIRST_CHUNK_MS);
      const res = await fetch(`${model.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${model.key}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        // Retry the transient classes only. A 402 (balance out) or 400 is not
        // transient and must surface immediately — the fleet's balance has run
        // out silently three times, and a retry loop would hide it.
        if (attempt < 4 && performance.now() < overallDeadline) {
          clearTimeout(watchdog);
          await res.body?.cancel?.().catch(() => {});
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
          continue;
        }
      }
      if (!res.ok) {
        const text = await res.text();
        return { error: `HTTP ${res.status}: ${text.slice(0, 300)}`, ms: performance.now() - started + stalledMs };
      }
      const { content, toolCalls, usage, firstChunkAt, finishReason } = await readStream(res, controller, armWatchdog);
      const elapsed = performance.now() - started;
      if (firstChunkAt !== null) ttftAll.push(firstChunkAt - started);
      tokensIn += usage?.prompt_tokens ?? 0;
      tokensOut += usage?.completion_tokens ?? 0;
      // A cap-hit with real content is a truncated legitimate reply — never
      // silently: it means MAX_OUTPUT_TOKENS is set too low for this corpus.
      if (finishReason === 'length' && (content || toolCalls.length)) {
        cappedCompletions++;
        console.log(`      note: output cap hit (${MAX_OUTPUT_TOKENS} tokens) with content present — reply truncated`);
      }
      // A COMPLETELY empty completion — no text, no tool calls — at
      // temperature 0 on a normal prompt is a provider anomaly (observed
      // during the 2026-08-14 balance-flap degradation), not a decision.
      // finish_reason 'length' with an empty reply is its runaway-reasoning
      // cousin: the model spent the whole cap in its thinking channel (530s
      // uncapped, 2026-08-14). Both get ONE counted retry; a second empty is
      // the model's answer and the graders hear it as the empty-reply finding.
      if (!content && toolCalls.length === 0 && attempt < 2 && performance.now() < overallDeadline) {
        emptyRetries++;
        if (finishReason === 'length') cappedRunaways++;
        stalledMs += elapsed;
        continue;
      }
      const message = {
        role: 'assistant',
        content: content || null,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls
                .filter(Boolean)
                .map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })),
            }
          : {}),
      };
      return { message, ms: elapsed + stalledMs, usage };
    } catch (err) {
      const elapsed = performance.now() - started;
      if (err.name === 'AbortError' && stalled) {
        // The stream went silent — a STALL, detected in seconds instead of a
        // full timeout. One fresh attempt (DeepInfra stalls are per-request);
        // a second stall is the provider's verdict, and the call site hears it.
        if (attempt < 2 && performance.now() < overallDeadline) {
          stallRetries++;
          stalledMs += elapsed;
          continue;
        }
        return { error: `model stream went silent after ${Math.round(elapsed + stalledMs)}ms${stalledMs ? ' (incl. one stall retry)' : ''}`, ms: elapsed + stalledMs };
      }
      if (err.name === 'AbortError' && budgetExceeded) {
        return { error: `model exceeded the total budget (${Math.round(elapsed + stalledMs)}ms) while still streaming — a latency finding, not a hang`, ms: elapsed + stalledMs };
      }
      if (err.name === 'AbortError') {
        return { error: `model call aborted after ${Math.round(elapsed + stalledMs)}ms`, ms: elapsed + stalledMs };
      }
      if (attempt === 4) return { error: String(err.message ?? err), ms: elapsed + stalledMs };
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    } finally {
      clearTimeout(watchdog);
    }
  }
  return { error: 'exhausted retries', ms: 0 };
}

// ── one scenario ──────────────────────────────────────────────────────────────
async function runScenario(scenario, repeatIndex) {
  const tenant = tenantOf(world, scenario.tenant);
  const ctx = { world, tenant, anchor: world.anchor };
  const identity = { tenantId: tenant.id, badge: scenario.badge, timeoutMs: TOOL_TIMEOUT };
  const { tools } = await spine.listToolDefs(identity);

  const displayName = scenario.badge
    .split('-')
    .slice(1)
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join(' ');
  const system = buildSystemPrompt(doctrine, {
    tier: scenario.tier,
    displayName: displayName || scenario.badge,
    technicianRef: scenario.badge,
    firmName: tenant.name,
    timezone: world.timezone,
  });

  const messages = [{ role: 'system', content: system }];
  const turns = [];
  const calls = [];
  const wallStart = performance.now();
  let fatal = null;

  const scripted = scenario.turns(ctx);
  for (const [turnIndex, userText] of scripted.entries()) {
    messages.push({ role: 'user', content: userText });
    let assistantText = '';
    let modelMs = 0;
    const turnCalls = [];
    const turnStart = performance.now();

    for (let step = 0; step < MAX_STEPS; step++) {
      const reply = await chat(messages, tools);
      modelMs += reply.ms;
      if (reply.error) {
        fatal = reply.error;
        break;
      }
      const message = reply.message;
      if (!message) {
        fatal = 'model returned no message';
        break;
      }
      const toolCalls = message.tool_calls ?? [];
      // Keep the assistant turn in the transcript exactly as sent back, or the
      // provider rejects the follow-up for having orphaned tool results.
      messages.push({
        role: 'assistant',
        content: message.content ?? '',
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
      if (message.content) assistantText += (assistantText ? '\n' : '') + message.content;
      if (toolCalls.length === 0) break;

      for (const tc of toolCalls) {
        const name = tc.function?.name ?? 'unknown';
        let args = {};
        try {
          args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          // A model that emits unparseable arguments is a real failure mode, and
          // one worth recording rather than crashing on.
          args = { __unparseable: String(tc.function?.arguments ?? '').slice(0, 200) };
        }
        const out = await spine.call(name, args, identity);
        const record = { tool: name, args, resultText: out.text, isError: out.isError, ms: out.ms, turn: turnIndex };
        calls.push(record);
        turnCalls.push(record);
        messages.push({ role: 'tool', tool_call_id: tc.id, content: out.text.slice(0, 20_000) });
      }
    }

    turns.push({
      userText,
      assistantText,
      calls: turnCalls,
      modelMs,
      wallMs: performance.now() - turnStart,
    });
    if (fatal) break;
  }

  const traj = {
    turns,
    calls,
    finalText: turns[turns.length - 1]?.assistantText ?? '',
    assistantTexts: turns.map((t) => t.assistantText),
    modelMs: turns.reduce((n, t) => n + t.modelMs, 0),
    toolMs: calls.reduce((n, c) => n + c.ms, 0),
    wallMs: performance.now() - wallStart,
  };

  const findings = fatal
    ? [{ kind: 'harness-or-provider-failure', detail: fatal }]
    : filterExpectedRefusals(
        runGraders(traj, [...BASELINE_GRADERS, ...(scenario.graders?.(ctx) ?? [])]),
        scenario.expectedRefusals,
      );

  // End state last: a scenario's real verdict is what the database says, not what
  // the agent claimed.
  let endState = null;
  if (scenario.endState && !fatal) {
    const { text, params } = scenario.endState.query(ctx);
    try {
      const rows = await sql(text, params);
      const passed = scenario.endState.predicate(rows);
      endState = { describe: scenario.endState.describe, passed, rows: JSON.stringify(rows).slice(0, 300) };
      if (!passed) {
        findings.push({ kind: 'end-state', detail: `${scenario.endState.describe} — database says ${endState.rows}` });
      }
    } catch (err) {
      endState = { describe: scenario.endState.describe, passed: false, rows: `query failed: ${err.message}` };
      findings.push({ kind: 'end-state-query', detail: `end-state query failed: ${err.message}` });
    }
  }

  return {
    id: scenario.id,
    repeat: repeatIndex,
    family: scenario.family,
    title: scenario.title,
    badge: scenario.badge,
    tenant: scenario.tenant,
    status: findings.length === 0 ? 'passed' : 'failed',
    findings,
    endState,
    metrics: {
      turns: turns.length,
      calls: calls.length,
      modelMs: traj.modelMs,
      toolMs: traj.toolMs,
      wallMs: traj.wallMs,
      // Guard steers are filtered from findings (the mechanism working is not
      // an agent failure) but never invisible: each one is a full extra round
      // trip the person waits through.
      steers: calls.filter((c) => c.isError && GUARD_STEERS.some((re) => re.test(c.resultText))).length,
    },
    // Args are first-class evidence: B03's "no recorded type" error was
    // undiagnosable for two days because only tool NAMES were kept — the
    // args would have shown find_slots being called by customerId (a
    // hypothetical new job, hence no type) instead of the queued jobId.
    transcript: turns.map((t) => ({
      user: t.userText,
      assistant: t.assistantText,
      tools: t.calls.map((c) => ({
        tool: c.tool,
        args: JSON.stringify(c.args).slice(0, 400),
        ...(c.isError ? { error: true } : {}),
      })),
    })),
  };
}

// ── run ───────────────────────────────────────────────────────────────────────
console.log('');
const results = [];
const latencyByTool = new Map();
for (let repeat = 1; repeat <= REPEAT; repeat++) {
  for (const scenario of runnable) {
    let result;
    try {
      result = await runScenario(scenario, repeat);
    } catch (err) {
      result = {
        id: scenario.id,
        repeat,
        family: scenario.family,
        title: scenario.title,
        badge: scenario.badge,
        tenant: scenario.tenant,
        status: 'failed',
        findings: [{ kind: 'harness-error', detail: String(err.message ?? err) }],
        endState: null,
        metrics: { turns: 0, calls: 0, modelMs: 0, toolMs: 0, wallMs: 0 },
        transcript: [],
      };
    }
    results.push(result);
    for (const c of result.transcript.flatMap((t) => t.tools.map((x) => x.tool))) {
      if (!latencyByTool.has(c)) latencyByTool.set(c, []);
    }
    const tag = REPEAT > 1 ? `${result.id}#${repeat}` : result.id;
    console.log(
      `  ${tag.padEnd(7)} ${result.status === 'passed' ? 'ok  ' : 'FAIL'}  ` +
        `${ms(result.metrics.wallMs).padStart(7)} (model ${ms(result.metrics.modelMs)}, tools ${ms(result.metrics.toolMs)}, ` +
        `${result.metrics.calls} call${result.metrics.calls === 1 ? '' : 's'})` +
        `${result.metrics.steers ? ` [steered ${result.metrics.steers}×]` : ''}  ${result.title}`,
    );
    for (const f of result.findings) console.log(`          └─ ${f.kind}: ${f.detail.slice(0, 160)}`);
  }
}
for (const s of skipped) console.log(`  ${s.id.padEnd(7)} SKIP  ${s.title} (needs ${s.requires})`);

// Per-tool latency across every recorded call.
for (const r of results) {
  // Recorded from the raw calls, kept on the result for the report.
  void r;
}

await server.close();
await client.end();

// ── report ────────────────────────────────────────────────────────────────────
const passed = results.filter((r) => r.status === 'passed');
const failed = results.filter((r) => r.status === 'failed');
const cost = tokensIn * RATE_IN + tokensOut * RATE_OUT;

// Per family: pass rate, and the shape of the work — the workflow family
// exists to measure CHAINS, and a chain's cost is its round trips and wall
// time, so those are first-class numbers, not a per-scenario footnote.
const byFamily = {};
for (const r of results) {
  const f = (byFamily[r.family] ??= { passed: 0, total: 0, calls: [], wall: [] });
  f.total++;
  if (r.status === 'passed') f.passed++;
  f.calls.push(r.metrics.calls);
  f.wall.push(r.metrics.wallMs);
}
const byKind = {};
for (const r of failed) for (const f of r.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

const modelMsAll = results.map((r) => r.metrics.modelMs);
const toolMsAll = results.map((r) => r.metrics.toolMs);
const wallAll = results.map((r) => r.metrics.wallMs);
const callsAll = results.map((r) => r.metrics.calls);

// Flake: a scenario that both passed and failed across repeats.
const flaky = [];
if (REPEAT > 1) {
  const byId = {};
  for (const r of results) (byId[r.id] ??= []).push(r.status);
  for (const [id, statuses] of Object.entries(byId)) {
    if (new Set(statuses).size > 1) flaky.push({ id, statuses });
  }
}

console.log(`\n  ── tier 2 ──`);
console.log(`  scenarios  ${passed.length}/${results.length} passed (${rate(passed.length, results.length)}%)`);
console.log(`  latency    wall p50 ${ms(summarise(wallAll).p50)}  p95 ${ms(summarise(wallAll).p95)}`);
console.log(`             model p50 ${ms(summarise(modelMsAll).p50)}  tools p50 ${ms(summarise(toolMsAll).p50)}`);
if (ttftAll.length) {
  console.log(
    `             first token p50 ${ms(summarise(ttftAll).p50)}  p95 ${ms(summarise(ttftAll).p95)} — when a streaming user first sees the reply begin`,
  );
}
const modelShare = summarise(modelMsAll).mean / (summarise(modelMsAll).mean + summarise(toolMsAll).mean);
console.log(`             the model is ${(modelShare * 100).toFixed(1)}% of a turn's time; the spine tools are the rest`);
console.log(`  round trips p50 ${summarise(callsAll).p50} tool calls per scenario`);
const steerTotal = results.reduce((n, r) => n + (r.metrics.steers ?? 0), 0);
const steerScenarios = results.filter((r) => (r.metrics.steers ?? 0) > 0).length;
if (steerTotal) {
  console.log(`  guard steers ${steerTotal} across ${steerScenarios} scenario(s) — the mint guard redirecting customerId habits (extra round trips, not failures)`);
}
if (stallRetries) {
  console.log(`  provider stalls retried ${stallRetries} — silent streams killed by the liveness watchdog, answered on a fresh attempt`);
}
if (emptyRetries) {
  const runaway = cappedRunaways ? ` (${cappedRunaways} of them runaway reasoning stopped by the ${MAX_OUTPUT_TOKENS}-token cap)` : '';
  console.log(`  empty completions retried ${emptyRetries} — zero-token answers at temperature 0, a provider anomaly${runaway}`);
}
console.log(`  spend      $${cost.toFixed(3)} (${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out)`);
console.log(`\n  by family:`);
for (const [family, f] of Object.entries(byFamily)) {
  console.log(
    `    ${family.padEnd(12)} ${String(f.passed).padStart(2)}/${String(f.total).padEnd(3)} ` +
      `calls p50 ${String(summarise(f.calls).p50).padStart(2)}  wall p50 ${ms(summarise(f.wall).p50)}`,
  );
}
if (Object.keys(byKind).length) {
  console.log(`\n  findings by kind:`);
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${kind.padEnd(32)} ${n}`);
  }
}
if (flaky.length) console.log(`\n  FLAKY (differing verdicts across repeats): ${flaky.map((f) => f.id).join(', ')}`);

const lines = [];
lines.push('# Spine eval — tier 2 (agent layer)', '');
lines.push(`- world anchor: **${titleWeekday(world.anchor)} ${world.anchor}** (seed ${world.seed})`);
lines.push(`- model: **${model.model}** @ ${new URL(model.baseUrl).host}`);
lines.push(`- doctrine: ${doctrine.length} sections, ${doctrineChars.toLocaleString()} chars, fingerprint \`${doctrineId}\``);
lines.push(`- run at: ${new Date().toISOString()}${REPEAT > 1 ? `, ${REPEAT} repeats` : ''}`);
lines.push(`- spend: **$${cost.toFixed(3)}** (${tokensIn.toLocaleString()} in / ${tokensOut.toLocaleString()} out)`);
lines.push('');
lines.push(`> ${calendarCoverageNote(world.anchor)}`, '');
lines.push('## Verdict', '');
lines.push(`| | passed | total | rate | round trips p50 | wall p50 |`, `|---|---|---|---|---|---|`);
lines.push(
  `| scenarios | ${passed.length} | ${results.length} | ${rate(passed.length, results.length)}% | ${summarise(callsAll).p50} | ${ms(summarise(wallAll).p50)} |`,
);
for (const [family, f] of Object.entries(byFamily)) {
  lines.push(
    `| ${family} | ${f.passed} | ${f.total} | ${rate(f.passed, f.total)}% | ${summarise(f.calls).p50} | ${ms(summarise(f.wall).p50)} |`,
  );
}
lines.push('');
lines.push(
  'The `workflow` family is the multi-tool chains — one request forcing read → slot search → ' +
    'write → report. Its round-trip and wall numbers are expected to sit well above the ' +
    'single-intent families; what must NOT differ is the pass rate.',
  '',
);
lines.push('## Latency', '');
lines.push('Per scenario, split by leg. `model` is time inside the provider; `tools` is the spine.', '');
lines.push('| leg | p50 | p95 | max |', '|---|---|---|---|');
for (const [label, values] of [['wall', wallAll], ['model', modelMsAll], ['tools', toolMsAll]]) {
  const s = summarise(values);
  lines.push(`| ${label} | ${ms(s.p50)} | ${ms(s.p95)} | ${ms(s.max)} |`);
}
if (ttftAll.length) {
  const t = summarise(ttftAll);
  lines.push(`| first token | ${ms(t.p50)} | ${ms(t.p95)} | ${ms(t.max)} |`);
  lines.push(
    '',
    'First token = per MODEL CALL, the moment the stream starts — the closest measurable ' +
      'proxy for when a Telegram user sees the reply begin (openclaw streams). Calls are ' +
      'judged alive by chunk flow, not duration: a stall is detected in seconds, and a ' +
      'legitimately long call is never killed while visibly streaming.',
  );
}
lines.push('', `Round trips: p50 ${summarise(callsAll).p50}, p95 ${summarise(callsAll).p95} tool calls per scenario.`, '');
if (steerTotal) {
  lines.push(
    `Guard steers: **${steerTotal}** across ${steerScenarios} scenario(s) — the customerId mint guard ` +
      'redirecting the skip-the-context-read habit. Filtered from findings (the mechanism working), ' +
      'counted here because each one is an extra round trip the person waits through.',
    '',
  );
}
if (stallRetries) {
  lines.push(`Provider stalls retried: **${stallRetries}** — requests that produced nothing for a full model timeout, answered on a fresh attempt.`, '');
}
if (Object.keys(byKind).length) {
  lines.push('## Findings by kind', '', '| kind | count |', '|---|---|');
  for (const [kind, n] of Object.entries(byKind).sort((a, b) => b[1] - a[1])) lines.push(`| ${kind} | ${n} |`);
  lines.push('');
}
if (flaky.length) {
  lines.push('## Flaky scenarios', '', 'Differing verdicts across repeats — treat their pass/fail as noise until stabilised.', '');
  for (const f of flaky) lines.push(`- \`${f.id}\`: ${f.statuses.join(', ')}`);
  lines.push('');
}
if (skipped.length) {
  lines.push('## Skipped for absent capability', '');
  for (const s of skipped) lines.push(`- \`${s.id}\` ${s.title} — needs ${s.requires}`);
  lines.push('');
}
if (failed.length) {
  lines.push('## Failures', '');
  for (const r of failed) {
    lines.push(`### \`${r.id}\`${REPEAT > 1 ? ` (repeat ${r.repeat})` : ''} ${r.title}`);
    lines.push(`- badge \`${r.badge}\`, tenant \`${r.tenant}\`, ${r.metrics.calls} tool call(s)`);
    for (const f of r.findings) lines.push(`- **${f.kind}**: ${f.detail}`);
    lines.push('', '<details><summary>transcript</summary>', '');
    for (const t of r.transcript) {
      lines.push(`**person:** ${t.user}`, '');
      // Tool name + args: the args ARE the diagnosis (which id was passed,
      // customerId vs jobId, an invented uuid). Errors are marked.
      for (const c of t.tools) lines.push(`- \`${c.tool}\`${c.error ? ' **(error)**' : ''} \`${c.args}\``);
      if (t.tools.length) lines.push('');
      lines.push(`**agent:** ${t.assistant || '_(said nothing)_'}`, '');
    }
    lines.push('</details>', '');
  }
}
lines.push('## What this tier cannot see', '');
lines.push('- the gateway `tools/list` cache, and OpenClaw\'s own harness scaffolding around AGENTS.md');
lines.push('- the Telegram transport, and the doorman/Composio relay hop (~2.3s per manager turn in production)');
lines.push('- whether the `message_sending` weekday guard is WIRED UP — it does not fire off the Telegram path,');
lines.push('  so its logic is replayed here rather than observed. Check that from a phone, once per install.');
lines.push('');
lines.push('It runs the full doctrine, though — the box\'s embedded-CLI path truncates AGENTS.md at 12,000');
lines.push(`characters and the doctrine is ${doctrineChars.toLocaleString()}, so this is a STRONGER prompt than any CLI measurement.`);

mkdirSync(DIR, { recursive: true });
writeFileSync(
  join(DIR, 'tier2-results.json'),
  JSON.stringify(
    {
      world: { anchor: world.anchor, seed: world.seed },
      model: { model: model.model, host: new URL(model.baseUrl).host },
      doctrine: { fingerprint: doctrineId, sections: doctrine.length, chars: doctrineChars },
      ranAt: new Date().toISOString(),
      repeats: REPEAT,
      enabled: [...enabled],
      spend: { usd: cost, tokensIn, tokensOut },
      stallRetries,
      emptyRetries,
      cappedCompletions,
      cappedRunaways,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      results,
      skipped: skipped.map((x) => ({ id: x.id, title: x.title, requires: x.requires })),
    },
    null,
    2,
  ),
);
writeFileSync(join(DIR, 'tier2-report.md'), lines.join('\n'));
console.log(`\n  report → ${join(DIR, 'tier2-report.md')}`);

if (failed.length) {
  console.error(`\n  ${failed.length} scenario failure(s).\n`);
  process.exit(1);
}
console.log(`\n  tier 2 green.\n`);
