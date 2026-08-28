// OpenRouter probe (plan 2026-08-28, Phases 1 and 3).
//
// TWO jobs, because they need the same machinery:
//   1. ONE instrumented forced-tool call through the PRODUCTION transport, so
//      the cost ledger is exercised end to end rather than asserted about.
//   2. The SAME prompt sent twice, ~5s apart, to measure whether the doctrine
//      prefix is actually being cached. ~90% of the planner's input is that
//      stable prefix, billed at $0.26/M against $1.40/M fresh — so this is the
//      number that decides what the planner costs to run.
//
// Runs against the LOCAL stack (.env.test). Usage:
//   node scripts/probe-cache.mjs <tenantId>
import 'dotenv/config';
import { config } from 'dotenv';
config({ path: '.env.test', override: true });
// The migration's own key resolution: INFERENCE_API_KEY is THE variable, with
// OPENROUTER_API_KEY as a vendor-named second source.
process.env.INFERENCE_API_KEY ||= process.env.OPENROUTER_API_KEY;
delete process.env.MODEL_PROVIDER;

const tenantId = process.argv[2];
if (!tenantId) {
  console.error('usage: node scripts/probe-cache.mjs <tenantId>');
  process.exit(2);
}

const { runForcedTool, resolveOpenAiEndpoint, ledgerVendor } = await import(
  '../dist/model/forcedTool.js'
);
const ep = resolveOpenAiEndpoint();
console.log(`endpoint : ${ep.baseUrl}`);
console.log(`model    : ${ep.model}`);
console.log(`vendor   : ${ledgerVendor()}\n`);

const TOOL = {
  name: 'report',
  description: 'Report one short verdict about the text you were given.',
  inputSchema: {
    type: 'object',
    properties: { verdict: { type: 'string', description: 'one word' } },
    required: ['verdict'],
  },
};

// Long enough to clear any provider's cache minimum (Anthropic's is 1024
// tokens; a short prompt would report 0 cached and look like a failure).
const PREFIX = (
  'You are the team lead inside a trades firm record system. ' +
  'A gap is a hole in the record, not an unanswered message. '
).repeat(220);

async function once(label) {
  const t0 = Date.now();
  const args = await runForcedTool(
    TOOL,
    { system: PREFIX, user: 'Say ok.', maxTokens: 400, label },
    { tenantId, technicianRef: 'spine:team-lead', lane: 'probe' },
  );
  console.log(`${label}: ${JSON.stringify(args)}  (${Date.now() - t0}ms)`);
}

await once('call-1');
await new Promise((r) => setTimeout(r, 5000));
await once('call-2');
console.log('\nRead the cached split back from cost_events — the usage block is not printed here');
console.log('on purpose: the LEDGER is the thing under test, not the response.');
