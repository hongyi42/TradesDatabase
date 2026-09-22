---
date: 2026-09-22
task: Step 0: two-hour test of the GitHub Copilot SDK on trades-box-1 with OpenRouter BYOK, the go/no-go for the bought-harness sketch
status: complete
origin: 
files: Box_Setup_Stuff/bootstrap-box.sh, Box_Setup_Stuff/doorman.mjs, src/mcp/httpServer.ts, src/mcp/identity.ts, docs/engineering-memory.md, docs/nemoclaw-tech-agent.md, thoughts/shared/research/2026-09-21-seat-runtime-direction-openrouter-agent-sdk.md
supersedes: nothing
---

## Files

- Box_Setup_Stuff/bootstrap-box.sh
- Box_Setup_Stuff/doorman.mjs
- src/mcp/httpServer.ts
- src/mcp/identity.ts
- docs/engineering-memory.md
- docs/nemoclaw-tech-agent.md
- thoughts/shared/research/2026-09-21-seat-runtime-direction-openrouter-agent-sdk.md

## Notes

> **Result first (read before the brief below — two of its instructions were disproved):** GO,
> ruled by the operator 2026-09-22. Use `wireApi:"responses"`, NOT the `"completions"` the brief
> names (completions 400s on ~1 in 10 Gemini tool turns; responses 0/38). `mode:"immediate"` does
> NOT remove the debounce by itself — it steers only at a tool-call boundary. Read the served model
> and cost from OpenRouter's generation record, never `assistant.usage`. Numbers: engineering-memory
> §2 "Step 0 measured"; the last handoff below has the decisions.

Operator, 2026-09-21: the seats' harness is to be BOUGHT, not built ("I don't want to build the cowork harness since more people before me has done that, with a higher level of professionality"); the box stays as the agents' home, Render stays the spine, sandboxes come from a vendor on demand for managers only, technicians stay thin, Telegram stays the UI. The Render-hosted seat loop (OpenRouter Agent SDK / Mastra) was DROPPED the same evening. This task is the GATE for the sketch: nothing past it is decided until it passes.

ON trades-box-1: install `@github/copilot-sdk` (1.0.14, 2026-09-21, GA, MIT; linux-x64 engine bundled), start the engine in `mode:"empty"` (GitHub's multi-tenant guidance; never the default `copilot-cli` mode on a shared server, it exposes the host filesystem), key = OpenRouter BYOK `provider:{type:"openai", baseUrl:"https://openrouter.ai/api/v1", apiKey, wireApi:"completions"}` (the responses wire needs server-side state OpenRouter rejects), `model:"@preset/trades-seats"` (the Gemini-then-Muse fallback lives in the preset; the SDK has no fallback list).

PROVE FIVE THINGS, numbers into engineering-memory: (1) one tool call followed by a SECOND turn through OpenRouter — issue github/copilot-sdk#2061, open since 2026-07: after a tool call the replayed assistant message carries `"refusal": null`, strict OpenAI-compatible providers 400 and the CLI's retries swallow it; (2) `assistant.usage.model` is the model asked for — issue #2571 (2026-09-20): the hosted catalog silently ran Claude Sonnet 5 when Gemini 3.8 Flash was requested; (3) `session.send({prompt, mode:"immediate"})` is folded into a running turn (steering) and `mode:"enqueue"` waits for the next turn — this is what removes the 2-second debounce; (4) `session.abort()` stops a turn and keeps the history — this is the Telegram Stop button; (5) engine RAM idle and per turn (openclaw's figure was 415 MB per turn). ALSO test the wiring shortcut: register the trades-spine MCP server on the session with a per-seat header so the engine pulls the seat's own catalog and the glue registers only local tools.

OUTPUT: go/no-go. GO → the sequence in memory `openclaw-retirement-plan` (technician seat on s5 first, then the manager seat with a sandbox vendor: Google Agent Runtime Code Execution, Vercel Sandbox or E2B — the three with a plain run-this door; OpenRouter's shell is model-driven only and does not fit). NO-GO → openclaw kept, with the ts_deny change (Box_Setup_Stuff/bootstrap-box.sh), an approval plugin and a file lane. Verified facts and every citation: memory `seat-harness-on-the-box`; `thoughts/shared/research/2026-09-21-seat-runtime-direction-openrouter-agent-sdk.md` (its Render framing is superseded; its OpenRouter and Render fact sections stand). A GitHub Copilot seat is NOT needed under a key; the $19 Business seat buys tokens at the same per-token rates as OpenRouter and requires a license per end user, so the seats stay on the key.

## Handoff 2026-09-22T05:35:36.162Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/step-0-two-hour-test-of-the-github-copil on work/step-0-two-hour-test-of-the-github-copil, from origin/main d94fcbc.

Overlap check: 1 overlap with active tasks — the operator read them and proceeded (--proceed):

  LOW   same file only      docs/engineering-memory.md
        20260912-rung-10c-a-seat-s-inform-wakes-the-plann changes it; 20260922-step-0-two-hour-test-of-the-github-copil names it

## Handoff 2026-09-22T09:28:52.382Z

**What changed** — Step 0 ran and the operator ruled GO ("Ok, let's go ahead on the build", 2026-09-22). No code changed. Docs: engineering-memory §2 gained "Step 0 measured: the Copilot SDK engine under OpenRouter BYOK (2026-09-21)" with every number, and the seat-direction entry above it was corrected in place (wireApi "responses", not "completions"; steering only at tool-call boundaries, so the debounce becomes a glue policy). The research doc's "responses wire relies on server-side state OpenRouter rejects" line carries a dated correction. Branch fast-forwarded to main 0e10054 (#275) before the doc edit.

**Decisions** — (1) GO on `@github/copilot-sdk` 1.0.14, with four conditions: `wireApi:"responses"` (completions lost Gemini's reasoning_details after tool calls → 400 on 3/32 tool turns, ~10 s retry each; responses 0/38); served model + cost read from OpenRouter `GET /api/v1/generation?id=<apiCallId>` (the engine echoes the requested model and reports cost 0 under BYOK); a double-text policy in the glue (the SDK's `immediate` only steers at a tool boundary — a plain double-text gets two replies; abort+resend works: abort→idle 4–5 ms, history kept); engine TZ per firm (`env:{TZ}` — the engine stamps `<current_datetime>` in its own process TZ, UTC on the box). (2) The MCP wiring check ran LOCALLY (real `dist/mcp/httpServer.js` behind the real `doorman.mjs`, two throwaway badges, local stack) instead of pulling s5's live badge out of Ben's container — the box user is in the docker group so it was possible, but extracting a real technician's credential was not a call to make unasked. Result: per-session `mcpServers` header → technician 17 tools, manager 45, real calls round-trip.

**Assumptions** — WHY responses fixes the 400 is inferred from the SDK types (it preserves `encryptedContent` on that wire), not observed on the wire; only the counts are measured. The completions+preset run's switch to Muse at a post-tool call was PRESUMED to be the reasoning-details 400 — its generation record was not pulled (the responses+preset switch WAS pulled: Vertex 504 10.3 s → AI Studio 400 → Meta). RAM is from toy sessions (≤2.3K tokens history, no media). The OpenRouter key used (local .env OPENROUTER_API_KEY, $100/mo limit) is probably the pilot's shared key; spend was $0.39.

**Failed approaches** — first abort test mis-timed: Gemini thought 22 s (2,652 tokens) and finished before the abort, so abort now fires on a fixed timer (3 s), not on the first delta (streaming deltas arrive only after thinking). npm is absent on the box (bare node binary): used the checksum-verified node-v22.23.1 tarball's npm under `~/copilot-sdk-test/.tools`, no sudo.

**Open** — Step 1 (technician seat on s5, openclaw-retirement-plan) is next: park + spawn, then research/plan in its own worktree. Choose the double-text policy there (abort+resend vs a short debounce). Untested: Telegram glue, the real doorman→Render hop, photos (engine assumes `vision:false` for an unknown model id → needs a `modelCapabilities` override), compaction on a long session, the sandbox vendor. `~/copilot-sdk-test` on trades-box-1 (335 MB: SDK, probe.mjs, logs, throwaway sessions; key shredded) awaits the operator's word to delete. This worktree's local Supabase stack is still up.

**Downstream** — The preset's fallback is STICKY and silent: one Google 504 moved 2 of 4 sessions to Muse for good (24/64 calls, 3–10× price), invisible to the caller. Today's openclaw seats ride the same `@preset/trades-seats`, so this likely feeds the open board finding `20260920-seats-hit-all-models-are-temporarily-rat` — a separate decision, not part of the GO. Memories `seat-harness-on-the-box` and `openrouter-routing-mechanics` updated to match.
