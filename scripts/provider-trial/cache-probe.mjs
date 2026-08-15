#!/usr/bin/env node
// Prompt-cache probe for any OpenAI-compatible provider. Answers two questions:
//   1. Does the ENGINE reuse a repeated prefix? (wall-time drop on repeat)
//   2. Does the BILLING see it? (cached-token fields in usage moving off zero)
//
// Five calls: A cold big-prefix, B identical to A, C same prefix + new question,
// D a never-seen prefix (controls for connection warmth), E repeat of D.
// ~120k total input tokens ≈ $0.15–0.25 at typical rates.
//
// Nebius result for reference (2026-08-15): engine cache YES (2.8s→1.1s),
// billing NO (prompt_cache_hit_tokens pinned at 0) — the disqualifying finding.
//
// Usage:
//   node scripts/provider-trial/cache-probe.mjs \
//     --base https://api.fireworks.ai/inference/v1 --key-env FIREWORKS_API_KEY \
//     --model accounts/fireworks/models/glm-5p2

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  const next = process.argv[i + 1];
  return i > -1 && next && !next.startsWith('--') ? next : dflt;
}

for (const line of readFileSync(join(REPO_ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}

const BASE = arg('base')?.replace(/\/+$/, '');
const MODEL = arg('model');
const KEY = process.env[arg('key-env') ?? ''];
if (!BASE || !MODEL || !KEY) {
  console.error('Required: --base <url> --key-env <ENV_VAR> --model <id>');
  process.exit(1);
}

const CHUNK =
  'Rule: copy values character for character. Rule: resolve dates with the tool, never in your head. ' +
  'Rule: confirm only what is irreversible or externally visible; everything reversible, just do. ';
const PREFIX_A = CHUNK.repeat(650);
const PREFIX_D =
  `Inventory note ${Date.now()}: the compressor unit ships with four mounting brackets and a torque spec sheet. Verify serials on intake. `.repeat(600);

// Cached-token count, wherever this provider's usage schema puts it.
function cachedOf(usage) {
  return (
    usage?.prompt_tokens_details?.cached_tokens ??
    usage?.prompt_cache_hit_tokens ??
    usage?.cache_read_input_tokens ??
    null
  );
}

async function call(label, prefix, question) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: prefix },
        { role: 'user', content: question },
      ],
      max_tokens: 16,
      temperature: 0,
    }),
  });
  const ms = performance.now() - t0;
  const body = await res.json();
  if (!res.ok) {
    console.log(`${label}: HTTP ${res.status} — ${JSON.stringify(body).slice(0, 200)}`);
    return;
  }
  const u = body.usage ?? {};
  console.log(
    `${label}: wall ${ms.toFixed(0)}ms  prompt=${u.prompt_tokens}  cached=${cachedOf(u)}`,
  );
  console.log(`   raw usage: ${JSON.stringify(u).slice(0, 400)}`);
}

await call('A cold prefix+Q1   ', PREFIX_A, 'Reply with the single word: alpha');
await call('B identical to A   ', PREFIX_A, 'Reply with the single word: alpha');
await call('C same prefix, Q2  ', PREFIX_A, 'Reply with the single word: bravo');
await call('D fresh prefix     ', PREFIX_D, 'Reply with the single word: one');
await call('E repeat of D      ', PREFIX_D, 'Reply with the single word: two');
console.log(
  '\nRead: engine cache = repeats materially faster than colds; billed cache = the cached\n' +
    'field moving off zero on B/C/E. Both must hold — and the console bill is the final word.',
);
