// NOTES-DOCTRINE EVAL — rung 10c's blocker.
//
//   node scripts/planner-eval/notes-run.mjs --yes
//   node scripts/planner-eval/notes-run.mjs --yes --runs 10
//   node scripts/planner-eval/notes-run.mjs --yes --runs 1 --only routing-sam
//   node scripts/planner-eval/notes-run.mjs --yes --frame message
//
// --frame message (rung 10c): the same four messages, but as the OFFICE's
// message door sees them — a focused pass about ONE seat message, no gaps, on
// officeSystemFor('message') — rather than as the half-hourly tick sees them.
// The 29/30 was measured on the tick's framing and PLANNER_SYSTEM; the message
// pass is where a standing instruction now lands first, so it is re-measured
// there. Written to its own directory, so it never overwrites a tick run.
//
// THE QUESTION. A seat sends the planner a standing instruction — "route all
// future job/visit messages to Sam". It appears in the briefing ONCE, and when
// that look ends it is gone: nothing ever re-shows an office message. Does the
// planner write it into its notes before that happens?
//
// WHY IT IS NOT ALREADY ANSWERED. It was measured live twice, with opposite
// outcomes (2026-09-07: read at the 00:00 tick, wrote nothing, instruction gone
// forever; 2026-09-08: same message, same seat, wrote MEMORY.md + firm/routing.md).
// But PR #212 — the prompt line that tells the planner to write notes — reached
// the heartbeat on 2026-09-09, AFTER BOTH. So that coin flip is the baseline
// WITHOUT the fix, and the fix has never been measured at all. A single live
// look cannot settle it either: a 50% mechanism looks fixed on any good day.
// This runs the same message N times and reports a rate.
//
// WHY THIS IS NOT run.mjs, in two parts, both load-bearing:
//
//   1. THE MODEL. lifecycle-heart runs `z-ai/glm-5.3` via OpenRouter. run.mjs
//      speaks the Anthropic API and defaults to Opus, so it would answer a
//      question nobody asked. The defaults in forcedTool.ts ARE production's
//      config (MODEL_PROVIDER unset -> openai, INFERENCE_MODEL unset ->
//      z-ai/glm-5.3), so this script sets NEITHER and inherits them. `--model`
//      overrides for a comparison; the default is always what is deployed.
//
//   2. THE TOOL LOOP. run.mjs gives the model one FORCED submit_plan call and
//      no tools. `write_memory` is a tool — so under that harness the behaviour
//      being measured here is not merely unobserved, it is unreachable. This
//      drives the real runToolLoop with the real tool schemas, which is the
//      only way the model can do the thing we are asking whether it does.
//
// WHAT IS REAL, AND WHAT IS NOT. Real: PLANNER_SYSTEM, TEAM_LEAD_TOOL_SCHEMAS
// (the whole surface, in the production order the prompt caches on),
// buildGapView, buildOfficeMessagesBlock, buildPlannerUserMessage, runToolLoop.
// Not real: the EXECUTOR — reads answer "nothing found", writes answer ok. So
// this measures WHETHER THE NOTE IS WRITTEN, never what the note is worth
// against a real record. A planner that would have investigated first has
// nothing to find here, which is a plausible source of any thin note.
//
// NO DATABASE, and the rail is the ABSENCE of a variable rather than care.
// `.env` in this checkout points SUPABASE_URL at the PILOT'S LIVE DATABASE, so
// this script reads ONE key out of it by name and never loads the rest:
// getClient() throws 'SUPABASE_URL is not set' the moment anything reaches an
// accessor, instead of quietly writing to the pilot. `recordUsage` is stubbed
// for that same reason — four cost_events rows per turn is exactly such a write
// — and the stub is also where the token totals below come from.

import { mkdirSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const DIST = join(ROOT, 'dist');

const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? (args[i + 1] ?? true) : d;
};

// THE KEY, BY NAME, AND NOTHING ELSE FROM .env (see the no-database note above).
const env = readFileSync(join(ROOT, '.env'), 'utf8');
const pick = (name) => (env.match(new RegExp(`^${name}=(.*)$`, 'm')) ?? [])[1]?.trim();
const apiKey = pick('INFERENCE_API_KEY') || pick('OPENROUTER_API_KEY');
if (!apiKey) {
  console.error('Neither INFERENCE_API_KEY nor OPENROUTER_API_KEY is in .env — nothing was sent.');
  process.exit(2);
}
process.env.INFERENCE_API_KEY = apiKey;
// Set ONLY when asked. Unset means production's default, which is the point.
const modelOverride = flag('model', null);
if (modelOverride) process.env.INFERENCE_MODEL = modelOverride;

const runs = Number(flag('runs', 10));
const frame = flag('frame', 'tick');
if (frame !== 'tick' && frame !== 'message') {
  console.error(`--frame must be tick or message, not ${frame}`);
  process.exit(2);
}
const only = flag('only', null);

const NOW = '2026-09-20T17:00:00.000Z'; // Sunday, 10:00 AM firm-local
const TZ = 'America/Los_Angeles';
const HOUR = 3_600_000;
const nowMs = Date.parse(NOW);
const ago = (h) => new Date(nowMs - h * HOUR).toISOString();

// ── THE GAPS ON SCREEN ───────────────────────────────────────────────────────
// TWO ORDINARY GAPS, deliberately. The instruction was lost in production while
// the planner had its usual work in front of it, and a prompt holding nothing
// but the message would measure an easier question than the one that failed.
const visit = (over = {}) => ({
  id: 'n-visit', tenant_id: 't1', kind: 'overdue_visit_gap', subject_ref: 'a1',
  technician_id: 'tech-1', status: 'asked', asked_at: ago(30), question: null,
  attempts: 0, serve_count: 1, actor_ref: 'spine:team-lead', resolution: null,
  queued_at: null, not_before: null, escalate_after: null, resolved_at: null,
  created_at: ago(40), updated_at: ago(30),
  context: {
    customerName: 'Marisol Duarte', jobTitle: 'Tankless descaling',
    technicianRef: 'ben-shelton', technicianName: 'Ben Shelton',
    visitId: 'a1', jobId: 'j-tankless',
    startsAtLocal: '2026-09-19T12:00:00.000Z', endsAtLocal: '2026-09-19T13:30:00.000Z',
  },
  ...over,
});

const cost = (over = {}) => ({
  ...visit(), id: 'n-cost', kind: 'job_cost_gap', subject_ref: 'j-boiler',
  context: {
    customerName: 'Henderson Family', jobTitle: 'Boiler swap',
    technicianRef: 'ben-shelton', technicianName: 'Ben Shelton',
    jobId: 'j-boiler', endsAtLocal: '2026-09-19T18:00:00.000Z',
  },
  ...over,
});

// ── THE MEMORY INDEX ─────────────────────────────────────────────────────────
// A planner that already keeps notes, because that is the live firm's state —
// `planner_memory` has had rows since 2026-09-08. An empty index would measure
// "does it invent the habit", a harder and different question.
const MEMORY_INDEX = [
  '# What I know about this firm',
  '- firm/pacing.md — when this firm wants to be chased and when it does not',
  '- firm/people.md — who does what here',
].join('\n');

const officeRow = (over = {}) => ({
  id: 'm-1', tenant_id: 't1', direction: 'to_planner', kind: 'inform',
  from_ref: 'judy-alvarez', to_ref: 'spine:team-lead', technician_id: 'tech-2',
  tier: 'manager', nudge_id: null, in_reply_to: null, status: 'unread',
  read_at: null, delivered_at: null, pinged_at: null, attempts: 0, serve_count: 0,
  message_group_id: null, via: 'assistant',
  created_at: ago(0.2), updated_at: ago(0.2),
  body: '',
  ...over,
});

// ── THE VARIANTS ─────────────────────────────────────────────────────────────
// Three standing instructions and ONE CONTROL. The control is not decoration:
// without it a planner that writes a note about everything scores 100% here and
// reads as fixed, when what it would actually be is a planner whose notes fill
// with traffic. The doctrine says a standing instruction goes in the notes AND
// that a gap-answering message is a quote, not a note — so both halves are the
// measurement.
const VARIANTS = [
  {
    id: 'routing-sam',
    kind: 'standing',
    why: 'The literal 2026-09-07 specimen — the message that was lost.',
    body:
      'Quick one — from now on route all job and visit messages to Sam, not me. ' +
      'He is picking up the scheduling side from this week.',
    // What the note has to carry to be worth writing. NAME plus SUBJECT: a
    // note saying only "Sam" does not say what Sam now gets.
    marker: /sam/i,
    subject: /rout|messag|schedul|job|visit/i,
  },
  {
    id: 'away-until',
    kind: 'standing',
    why: 'The other shape of standing fact: who is away, and until when.',
    body:
      'I am out from Thursday until the 3rd. Anything on my jobs goes to Dani ' +
      'while I am gone.',
    marker: /dani/i,
    subject: /out|away|until|3rd|cover/i,
  },
  {
    id: 'no-early-texts',
    kind: 'standing',
    why: 'A preference, not a person — the shape with no obvious subject line.',
    body:
      'Please stop texting me before 7am. I do not see them and it wakes the ' +
      'house. After 7 is fine.',
    marker: /7\s*?am|seven|before 7/i,
    subject: /text|messag|morning|early|contact/i,
  },
  {
    id: 'CONTROL-gap-answer',
    kind: 'control',
    why:
      'NOT a standing instruction — an ordinary note answering a gap. The ' +
      'doctrine wants this QUOTED, not filed. A memory write here is a false ' +
      'positive, and a planner that files everything is as broken as one that ' +
      'files nothing.',
    body:
      'Descaling at Duarte is done, unit is running clean. Took about two hours.',
    marker: null,
    subject: null,
  },
];

if (!args.includes('--yes')) {
  const n = (only ? VARIANTS.filter((v) => v.id === only) : VARIANTS).length * runs;
  console.error(
    'This step CALLS THE MODEL AND SPENDS MONEY. Re-run with --yes.\n' +
      `  variants: ${only ?? VARIANTS.map((v) => v.id).join(', ')}\n` +
      `  runs each: ${runs}   total tool-loop runs: ${n}   frame: ${frame}\n` +
      `  model: ${modelOverride ?? 'production default (z-ai/glm-5.3 via OpenRouter)'}`,
  );
  process.exit(2);
}

const { PLANNER_SYSTEM, SUBMIT_PLAN_TOOL } = await import(`${DIST}/teamLead/plannerPrompt.js`);
const { officeSystemFor } = await import(`${DIST}/teamLead/officePrompt.js`);
// The prompt this frame runs on: the tick is the planner; a message pass is the
// office's fourth door (planner.ts picks the same way).
const SYSTEM = frame === 'message' ? officeSystemFor('message') : PLANNER_SYSTEM;
const {
  buildGapView,
  buildPlannerUserMessage,
  buildOfficeMessagesBlock,
  // THE PLANNER'S OWN BUDGET AND EFFORT, imported rather than copied. A local
  // 8000 next to production's 8192 would be a measurement of a budget nothing
  // runs under — and `reasoningEffort` matters more than the tokens do: GLM
  // thinks by default, and 'medium' is what lifecycle-heart sends.
  PLANNER_MAX_TOKENS,
  PLANNER_REASONING,
} = await import(`${DIST}/teamLead/planner.js`);
const { TEAM_LEAD_TOOL_SCHEMAS } = await import(`${DIST}/mcp/server.js`);
const { runToolLoop } = await import(`${DIST}/model/toolLoop.js`);
const { resolveOpenAiEndpoint } = await import(`${DIST}/model/forcedTool.js`);

const { model: MODEL, baseUrl: BASE_URL } = resolveOpenAiEndpoint();

// ── THE STUB EXECUTOR ────────────────────────────────────────────────────────
// Honest about absence: a read returns "nothing found" rather than invented
// records, so a planner that goes looking is told the truth for this world and
// can get on with deciding. Every call is RECORDED — the measurement is which
// tools were reached for, not just whether write_memory was among them.
function makeExecutor(record) {
  return async (name, argsIn) => {
    record.push({ name, args: argsIn });
    switch (name) {
      case 'write_memory':
        return { status: 'ok', action: argsIn?.content ? 'saved' : 'deleted', path: argsIn?.path };
      case 'read_memory':
        // The index's files exist and say something ordinary. A read that
        // 404'd would teach the model its notes are unreliable mid-measurement.
        return {
          path: argsIn?.path,
          content:
            argsIn?.path === 'MEMORY.md'
              ? MEMORY_INDEX
              : '(this firm, as I understood it at the last look)',
        };
      case 'submit_plan':
        // The terminal tool: the loop returns the moment this executes. Accept
        // whatever it submits — copy quality is run.mjs's question, not this one.
        return { status: 'ok', accepted: (argsIn?.decisions ?? []).length, refused: 0 };
      case 'recall_decisions':
        // A planner with a history, because the live one has one.
        return {
          decisions: [
            { gap: 'n-visit', action: 'extend', when: ago(26),
              reason: 'asked late in the day, gave it overnight' },
          ],
        };
      case 'get_customer_context':
      case 'spine_read':
        // NOT EMPTY, and that is deliberate (see the world note above). Thin
        // and plausible: enough that a planner which goes looking finds the
        // shape of a real firm, never so much that it can quote a detail this
        // harness invented into a manager-facing note.
        return {
          rows: [
            { job: 'j-tankless', customer: 'Marisol Duarte', status: 'in progress' },
            { job: 'j-boiler', customer: 'Henderson Family', status: 'work reported done' },
          ],
        };
      default:
        // Any other read, and any write that is not write_memory. Never an
        // error: a tool that throws repeatedly stalls the loop and would end
        // the run for a reason that has nothing to do with what is measured.
        return { status: 'ok', results: [], note: 'nothing further for this eval world' };
    }
  };
}

const stamp = NOW.replace(/[:.]/g, '-');
const dir = join(
  ROOT,
  'thoughts/shared/evals',
  frame === 'message' ? `planner-notes-message-frame-${stamp}` : `planner-notes-${stamp}`,
);
mkdirSync(dir, { recursive: true });
const out = join(dir, 'run.jsonl');
writeFileSync(out, '');

// THE BUDGET GUARD. This key is NOT the eval's — it is the pilot's
// INFERENCE_API_KEY, the one lifecycle-heart's planner and the extractor run
// on, and it carries a monthly cap that was already 96% spent when this eval
// was written. A measurement that throttles the live pilot to finish itself is
// not a measurement worth having, so the loop asks the key what is left and
// stops while there is still a reserve, rather than discovering the cap as a
// 429 partway through a matrix. `--reserve 0` opts out.
const RESERVE = Number(flag('reserve', 0.5));
async function remainingUsd() {
  try {
    const res = await fetch('https://openrouter.ai/api/v1/key', {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) return null; // unknown is not "stop" — a flaky check must not halt a paid run
    const body = await res.json();
    const left = body?.data?.limit_remaining;
    return typeof left === 'number' ? left : null;
  } catch {
    return null;
  }
}

const chosen = only ? VARIANTS.filter((v) => v.id === only) : VARIANTS;
if (chosen.length === 0) {
  console.error(`--only ${only} matched no variant`);
  process.exit(2);
}

console.log(`model: ${MODEL}   via: ${BASE_URL}   runs each: ${runs}   frame: ${frame}\n`);

let totalIn = 0;
let totalOut = 0;
let totalCached = 0;
const tally = {};
let errored = 0;
let stoppedEarly = false;

for (const v of chosen) {
  if (stoppedEarly) break;
  // The SAME rendered prompt every run — the question is variance in the model,
  // so nothing else may vary between runs.
  // A WORLD WITH WORK IN IT. The first draft ran this against an empty record,
  // and the planner filed the note without ever submitting a plan — which
  // measures an easier question than the one that failed live. The instruction
  // was lost while the planner had its ordinary job in front of it, so the gaps
  // carry real evidence and real money and the look has something to decide.
  // A pass in an empty world would not have been worth much.
  const nudges = [visit(), cost()];
  const evidence = [
    { jobId: 'j-tankless',
      capture: { raw_text: 'Dropped the spare filters at the shop on the way back.',
                 captured_at: ago(4) } },
    { jobId: 'j-boiler',
      capture: { raw_text: 'Henderson boiler is in and firing. Long day.',
                 captured_at: ago(6) } },
  ];
  const money = [
    { kind: 'payment_received', amount_cents: 50000,
      occurred_at: ago(20), created_at: ago(20), note: null },
  ];
  const views = nudges.map((n) =>
    buildGapView(
      n,
      nowMs,
      evidence.filter((e) => e.jobId === n.context.jobId),
      false,
      new Set(),
      [],
      n.context.jobId === 'j-boiler' ? money : [],
      TZ,
    ),
  );
  if (views.some((x) => !x.block)) throw new Error(`${v.id}: rendered no block`);
  const office = buildOfficeMessagesBlock([officeRow({ body: v.body })], nowMs, [], 0);
  if (!office) throw new Error(`${v.id}: rendered no office block`);
  // THE MESSAGE FRAME shows NO gaps — runFocusedMessagePass empties every gap
  // reader — and says the pass is about one message ('message', planner.ts).
  const user =
    frame === 'message'
      ? buildPlannerUserMessage(
          NOW,
          TZ,
          [],
          MEMORY_INDEX,
          { lastSuccessAt: ago(0.5), everyMinutes: 30 },
          office,
          '',
          '',
          'message',
        )
      : buildPlannerUserMessage(
          NOW,
          TZ,
          views,
          MEMORY_INDEX,
          { lastSuccessAt: ago(0.5), everyMinutes: 30 },
          office,
        );

  for (let i = 1; i <= runs; i += 1) {
    if (RESERVE > 0) {
      const left = await remainingUsd();
      if (left !== null && left < RESERVE) {
        console.log(
          `\nSTOPPED at ${v.id} ${i}/${runs}: $${left.toFixed(2)} left on the key, ` +
            `reserve is $${RESERVE.toFixed(2)}. The runs already made still count.`,
        );
        stoppedEarly = true;
        break;
      }
    }
    let calls = [];
    const started = Date.now();
    let result = null;
    let error = null;
    // TRANSIENT FAILURES ARE RETRIED, REAL ONES ARE NOT. A 429 or a dropped
    // socket is the shared key having a bad moment and says nothing about the
    // doctrine; a schema or prompt error is a broken harness and must surface
    // immediately rather than be tried three times and averaged away.
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      calls = [];
      error = null;
      try {
        result = await runToolLoop(
          {
            system: SYSTEM,
            user,
            maxTokens: PLANNER_MAX_TOKENS,
            label: 'teamLeadPlanner',
            reasoningEffort: PLANNER_REASONING,
            terminalTool: SUBMIT_PLAN_TOOL.name,
            maxTurns: null,
            budgetMs: 180_000,
          },
            // SUBMIT_PLAN_TOOL IS PART OF THE SURFACE, and leaving it out voided a
          // whole 26-run matrix before this line existed. planner.ts:5152 passes
          // `[...tools, SUBMIT_PLAN_TOOL]`; a harness passing only the schemas
          // never OFFERS the terminal tool, so the model cannot submit a plan —
          // it is not that it chose not to. Every run then ended with the
          // planner's actual job undone, which is precisely the too-easy world
          // that would flatter a doctrine measurement.
          [...TEAM_LEAD_TOOL_SCHEMAS, SUBMIT_PLAN_TOOL],
          makeExecutor(calls),
          { tenantId: 't1', technicianRef: 'spine:team-lead', lane: 'planner' },
          {
            // THE COST SEAM AS THE METER (and as the no-DB rail).
            recordUsage: async (_vendor, usage) => {
              totalIn += usage?.inputTokens ?? 0;
              totalOut += usage?.outputTokens ?? 0;
              totalCached += usage?.cachedInputTokens ?? 0;
            },
          },
        );
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      if (!error) break;
      const transient = /429|rate.?limit|fetch failed|ECONNRESET|502|503|504|timeout/i.test(error);
      if (!transient || attempt === 3) break;
      await new Promise((r) => setTimeout(r, attempt * 20_000));
    }

    const memoryWrites = calls.filter((c) => c.name === 'write_memory');
    const wrote = memoryWrites.length > 0;
    const text = memoryWrites
      .map((c) => `${c.args?.path ?? ''}\n${c.args?.content ?? ''}`)
      .join('\n');
    // CARRIED IT: the instruction is actually IN the note, not merely that a
    // note was written. A write of an unrelated file is not a pass.
    const carried = v.kind === 'standing' ? !!(v.marker?.test(text) && v.subject?.test(text)) : false;
    // NULL ON ERROR, never false and never true. The control's test is "wrote
    // nothing", and a run that never reached the model writes nothing — so
    // scoring an error would have counted a 429 as the planner correctly
    // declining to file a note. An errored run is NOT A MEASUREMENT: it is
    // excluded from the rates below and reported on its own line.
    const pass = error ? null : v.kind === 'standing' ? carried : !wrote;

    const row = {
      variant: v.id, kind: v.kind, run: i, model: MODEL,
      wroteMemory: wrote, carried, pass,
      // DID IT FINISH ITS ORDINARY JOB? Reported, never graded: a look that
      // filed the note and submitted no plan is a different animal from one
      // that did both, and a pass rate that hid the difference would flatter
      // the result.
      submitted: calls.some((c) => c.name === 'submit_plan'),
      paths: memoryWrites.map((c) => c.args?.path ?? null),
      memoryContent: memoryWrites.map((c) => c.args?.content ?? null),
      tools: calls.map((c) => c.name),
      // The last assistant turn, trimmed. When a look ends without submitting a
      // plan, this is the only place that says why.
      finalText: (result?.text ?? '').slice(0, 600),
      turns: result?.turns ?? null,
      stalledWarnings: result?.stalledWarnings ?? null,
      ms: Date.now() - started,
      error,
    };
    appendFileSync(out, `${JSON.stringify(row)}\n`);
    const mark = error ? 'ERR' : pass ? ' ok' : 'FAIL';
    if (pass !== null) {
      const t = (tally[v.id] ??= { pass: 0, of: 0 });
      t.of += 1;
      if (pass) t.pass += 1;
    } else {
      errored += 1;
    }
    console.log(
      `${mark}  ${v.id} ${i}/${runs}  ` +
        `${wrote ? `wrote ${row.paths.join(', ')}` : 'no memory write'}  ` +
        `· ${row.submitted ? 'planned' : 'NO PLAN'}` +
        ` · ${row.turns ?? '-'} turns · ${(row.ms / 1000).toFixed(1)}s` +
        `${error ? ` · ${error.slice(0, 120)}` : ''}`,
    );
  }
}

writeFileSync(
  join(dir, 'meta.json'),
  JSON.stringify(
    { model: MODEL, baseUrl: BASE_URL, now: NOW, tz: TZ, runs, frame, totalIn, totalOut, totalCached },
    null,
    2,
  ),
);
console.log('\n── the rate ──────────────────────────────────────────────');
for (const v of chosen) {
  const t = tally[v.id];
  if (!t || t.of === 0) { console.log(`  ${v.id}: no measured runs`); continue; }
  const pct = ((t.pass / t.of) * 100).toFixed(0);
  const what = v.kind === 'standing' ? 'filed the instruction' : 'correctly filed NOTHING';
  console.log(`  ${v.id.padEnd(20)} ${String(t.pass).padStart(2)}/${t.of}  ${pct}%  ${what}`);
}
if (errored > 0) console.log(`  (${errored} run(s) errored and are excluded — not measurements)`);
const est =
  (totalIn - totalCached) * 0.00000091 + totalCached * 0.000000169 + totalOut * 0.00000286;
console.log(`\ntokens: ${totalIn} in (${totalCached} cached) / ${totalOut} out  ≈ $${est.toFixed(3)}`);
console.log(`${dir}\n  → node scripts/planner-eval/notes-analyze.mjs --dir ${dir}`);
