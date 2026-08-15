#!/usr/bin/env node
// Side-by-side GLM-5.2 benchmark: Nebius Token Factory vs DeepInfra (current provider).
//
// Measures, per provider:
//   1. Which GLM model ids the provider actually serves (settles id-spelling up front —
//      the date-eval expectedModel gate compares exact strings).
//   2. Streaming speed over N trials: time-to-first-token and output tokens/second.
//   3. Compatibility with the spine's call shape (src/model/forcedTool.ts): forced
//      tool_choice + reasoning_effort param + tool_calls[0].function.arguments as a
//      JSON string. A provider that 400s here can't back the spine without code changes.
//
// Usage:
//   NEBIUS_API_KEY=... node scripts/provider-trial/nebius-bench.mjs [--trials 3]
//
// DeepInfra side runs only if INFERENCE_API_KEY (or DEEPINFRA_API_KEY) is available —
// it is read from the repo-root .env if not already in the environment. No DB access,
// no fleet interaction: plain HTTPS calls to the two inference APIs.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRIALS = Number(process.argv[process.argv.indexOf('--trials') + 1]) || 3;
const REQUEST_TIMEOUT_MS = 180_000;

const SPEED_PROMPT =
  'Write a plain-language explanation, roughly 400 words, of how a residential heat pump ' +
  'heats a house in winter. No headings, no lists — flowing prose only.';

function loadDotEnv() {
  let text;
  try {
    text = readFileSync(join(REPO_ROOT, '.env'), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
}

loadDotEnv();

const providers = [];
if (process.env.NEBIUS_API_KEY) {
  providers.push({
    name: 'nebius',
    base: process.env.NEBIUS_BASE_URL ?? 'https://api.tokenfactory.nebius.com/v1',
    key: process.env.NEBIUS_API_KEY,
    model: process.env.NEBIUS_MODEL ?? null, // null → auto-pick from /models below
  });
}
// Key fallback order matches how this repo names things: the spine uses INFERENCE_API_KEY,
// the eval harness uses EVAL_INFERENCE_API_KEY (only trusted here when its base URL is
// DeepInfra — a repointed eval key would otherwise be sent to the wrong host).
const evalKeyIsDeepInfra =
  !process.env.EVAL_INFERENCE_BASE_URL ||
  process.env.EVAL_INFERENCE_BASE_URL.includes('deepinfra.com');
const deepinfraKey =
  process.env.DEEPINFRA_API_KEY ??
  process.env.INFERENCE_API_KEY ??
  (evalKeyIsDeepInfra ? process.env.EVAL_INFERENCE_API_KEY : undefined);
if (deepinfraKey) {
  providers.push({
    name: 'deepinfra',
    base: 'https://api.deepinfra.com/v1/openai',
    key: deepinfraKey,
    model: 'zai-org/GLM-5.2',
  });
}
if (providers.length === 0) {
  console.error('Set NEBIUS_API_KEY (and optionally INFERENCE_API_KEY for the DeepInfra baseline).');
  process.exit(1);
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

async function api(provider, path, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${provider.base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${provider.key}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function discoverGlmModels(provider) {
  const res = await api(provider, '/models');
  if (!res.ok) return { error: `${res.status} ${await res.text().then((t) => t.slice(0, 200))}` };
  const body = await res.json();
  const ids = (body.data ?? []).map((m) => m.id).filter((id) => /glm/i.test(id));
  return { ids };
}

async function timedStreamTrial(provider) {
  const started = performance.now();
  const res = await api(provider, '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: provider.model,
      messages: [{ role: 'user', content: SPEED_PROMPT }],
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);

  let firstTokenAt = null;
  let lastTokenAt = null;
  let usage = null;
  let reportedModel = null;
  let charCount = 0;
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        continue;
      }
      reportedModel ??= event.model ?? null;
      if (event.usage) usage = event.usage;
      const delta = event.choices?.[0]?.delta ?? {};
      const text = (delta.reasoning_content ?? '') + (delta.content ?? '');
      if (text) {
        firstTokenAt ??= performance.now();
        lastTokenAt = performance.now();
        charCount += text.length;
      }
    }
  }

  const completionTokens = usage?.completion_tokens ?? Math.round(charCount / 4);
  const decodeSeconds = firstTokenAt && lastTokenAt ? (lastTokenAt - firstTokenAt) / 1000 : null;
  return {
    ttftSec: firstTokenAt ? (firstTokenAt - started) / 1000 : null,
    tokPerSec: decodeSeconds > 0 ? completionTokens / decodeSeconds : null,
    completionTokens,
    usageReported: Boolean(usage),
    reportedModel,
  };
}

// Mirrors the spine's exact call shape (src/model/forcedTool.ts): forced tool choice,
// reasoning_effort present, arguments expected back as a JSON string.
async function spineShapeCheck(provider) {
  const res = await api(provider, '/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: provider.model,
      reasoning_effort: 'none',
      messages: [
        {
          role: 'user',
          content: 'Customer says: "my AC quit and it is 95 degrees". Classify the urgency.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'record_urgency',
            description: 'Record the urgency classification.',
            parameters: {
              type: 'object',
              properties: {
                urgency: { type: 'string', enum: ['emergency', 'soon', 'routine'] },
                reason: { type: 'string' },
              },
              required: ['urgency', 'reason'],
            },
          },
        },
      ],
      tool_choice: { type: 'function', function: { name: 'record_urgency' } },
    }),
  });
  if (!res.ok) return { ok: false, detail: `${res.status} ${await res.text().then((t) => t.slice(0, 300))}` };
  const body = await res.json();
  const args = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (typeof args !== 'string') return { ok: false, detail: `tool_calls arguments not a string: ${typeof args}` };
  try {
    const parsed = JSON.parse(args);
    return { ok: true, detail: `arguments parsed, urgency=${parsed.urgency}` };
  } catch {
    return { ok: false, detail: 'arguments string is not valid JSON' };
  }
}

const results = [];
for (const provider of providers) {
  console.log(`\n=== ${provider.name} (${provider.base}) ===`);

  const models = await discoverGlmModels(provider);
  if (models.error) {
    console.log(`  /models failed: ${models.error}`);
  } else {
    console.log(`  GLM ids served: ${models.ids.join(', ') || '(none found)'}`);
    provider.model ??= models.ids.find((id) => /5\.2/.test(id)) ?? models.ids[0];
  }
  if (!provider.model) {
    console.log('  no GLM model id found — skipping');
    continue;
  }
  console.log(`  using model: ${provider.model}`);

  const trials = [];
  for (let i = 0; i < TRIALS; i++) {
    try {
      const t = await timedStreamTrial(provider);
      trials.push(t);
      console.log(
        `  trial ${i + 1}: TTFT ${t.ttftSec?.toFixed(2)}s, ` +
          `${t.tokPerSec?.toFixed(1)} tok/s over ${t.completionTokens} tokens` +
          `${t.usageReported ? '' : ' (token count estimated — no usage in stream)'}`,
      );
    } catch (err) {
      console.log(`  trial ${i + 1} failed: ${err.message}`);
    }
  }

  const shape = await spineShapeCheck(provider);
  console.log(`  spine call-shape check: ${shape.ok ? 'PASS' : 'FAIL'} — ${shape.detail}`);

  if (trials.length) {
    results.push({
      provider: provider.name,
      model: provider.model,
      reportedModel: trials[0].reportedModel,
      medianTtft: median(trials.map((t) => t.ttftSec)),
      medianTokPerSec: median(trials.map((t) => t.tokPerSec)),
      shapeOk: shape.ok,
    });
  }
}

if (results.length) {
  console.log('\n=== summary (medians) ===');
  console.table(
    results.map((r) => ({
      provider: r.provider,
      model: r.model,
      'reported model': r.reportedModel,
      'TTFT (s)': r.medianTtft?.toFixed(2),
      'tok/s': r.medianTokPerSec?.toFixed(1),
      'spine shape': r.shapeOk ? 'PASS' : 'FAIL',
    })),
  );
  console.log(
    'Note: the "reported model" string is what the date-eval expectedModel gate would need\n' +
      '(DATE_EVAL_EXPECT_MODEL) if this provider ever backs a fleet-side run.',
  );
}
