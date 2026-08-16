# Gemini Interactions dialect for spine-eval run-agent.mjs — port spec

Goal (user, 2026-08-16): trial gemini-3.7-flash on the spine eval (and date eval — transport
decision pending: Vertex creds vs re-probed compat shim). Caching PRE-VERIFIED (gate the user
set): implicit, default-on, 4,096-token min prefix, billed $0.075/M vs $0.75/M fresh (90% off,
automatic), reported via `usage.total_cached_tokens`; live probe 2026-08-16: cold 0 → repeat
12,265/17,313 cached (71%), ~2s latency. Output (incl. thinking) $3.75/M through 2026.
Docs: ai.google.dev/api/interactions-api, /gemini-api/docs/caching, /gemini-api/docs/pricing.

## Endpoint + auth
POST https://generativelanguage.googleapis.com/v1/interactions
Header `x-goog-api-key: $GEMINI_API_KEY` (NOT Bearer). Stability: 10/10 clean probes;
the OpenAI-compat shim (`/v1beta/openai/`) is the 503-flaky path — never use it.

## Mirror the --openai-responses port (run-agent.mjs:68-, 209-248, 314-400)
New flag `--interactions` (mutually exclusive with --openai-params/--openai-responses):
- Request: `{ model, input, tools, tool_choice: 'auto', stream: false (start non-streaming;
  probes ~2s; the stall watchdog only matters if we later stream) }`.
- Tools: `{type:'function', name, description, parameters}` — near-identical to chat
  completions; strip any unsupported JSON-schema keywords on first 400.
- Transcript strategy: STATEFUL chaining — keep `previous_interaction_id` from each response;
  after tool execution send ONLY `input: [{type:'function_result', call_id, result:<string>}]`.
  (Stateless full-history resend is the fallback if chaining fights the harness's
  transcript-replay assumptions; note interactions store server-side state per id.)
- Response parsing: `status: 'completed' | 'requires_action'`; steps[] with
  `{type:'function_call', name, id, arguments}` (arguments = OBJECT already, not JSON string)
  and text steps for the final reply. Map: requires_action → execute tools → follow-up;
  completed → extract text.
- Usage mapping: `usage.total_input_tokens → inputTokens`, `total_output_tokens → outputTokens`
  (thinking INCLUDED), `total_cached_tokens → cachedInputTokens`.
- Output cap: find interactions' max-output field (generation config?) — check docs at
  implementation; the 32k cap + empty-completion retry semantics must carry over.
- tool_choice 'validated'/'any' exist; keep 'auto' to match other dialects.

## Run protocol
1. Rebuild the eval world first (npm test ran repeatedly on 2026-08-15/16 → world consumed;
   memory: world single-use).
2. Smoke 2-3 scenarios, then full 59; cache-key flag N/A (implicit).
3. Compare vs Fireworks 57/59 (anchor-adjusted 59/59), wall p50 7.8s, and record per-run
   billed cache share from usage.

## Date-eval transport (user decision pending)
Gateway lacks an AI-Studio-key Gemini type; options: google-vertex-ai provider type (user GCP
creds) or re-probe the compat shim. Do NOT run the date eval through the shim without a fresh
stability probe (2/10 503s on 2026-08-15).

## Full field vocabulary (from ai.google.dev/api/interactions.md.txt, fetched 2026-08-16)
- System prompt: top-level `system_instruction` (string) — put the doctrine prompt here.
- History items (STATELESS full-history resend IS supported via `input` array — prefer it,
  matches the harness's stateless chat(messages) contract exactly):
  - user text:  {type:'user_input',  content:[{type:'text', text}]}
  - model text: {type:'model_output', content:[{type:'text', text}]}
  - model tool call: {type:'function_call', name, arguments:<object>, id}
  - tool result: {type:'function_result', call_id:<id>, result:<string>} (from tool-use doc)
- Output cap: generation_config.max_output_tokens (int) — carry MAX_OUTPUT_TOKENS here.
- No temperature; `seed` exists for reproducibility (set seed: 7 for determinism-ish).
- tool_choice: 'auto'; tools: [{type:'function', name, description, parameters}].
- Response: status 'completed'|'requires_action'; steps[] mirror the input vocab;
  arguments arrive as OBJECTS (stringify before storing in the chat-format transcript,
  parse back when translating — the transcript stays chat-shaped like toResponsesInput).
- Non-streaming first (stream:false): single JSON body, ~2s probes; reuse the retry/backoff
  scaffold, skip the SSE watchdog path.
