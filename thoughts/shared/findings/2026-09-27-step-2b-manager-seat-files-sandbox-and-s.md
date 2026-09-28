---
date: 2026-09-27
task: Step 2b: manager seat files, sandbox and skills (E2B vs Vercel gate test; lift the Composio workbench block)
status: complete
origin: 
files: src/seatGlue/engine.ts, src/seatGlue/seat.ts, src/seatGlue/doctrine.ts, src/composio/relayHandler.ts, scripts/sandbox-gate/e2b-gate.mjs, thoughts/shared/plans/2026-09-28-step-2b-manager-files-sandbox-skills.md, src/mcp/csv.ts, src/mcp/csv.test.ts, src/seatGlue/sandbox.ts, src/seatGlue/sandbox.test.ts, Box_Setup_Stuff/seat-glue/e2b-template.mjs, src/seatGlue/fileTools.ts, src/seatGlue/fileTools.test.ts, thoughts/shared/plans/2026-09-28-step-2c-batching.md, src/seatGlue/batchProgress.ts, scripts/seat-eval/batching/seed-emails.mjs, scripts/seat-eval/batching/gate.mjs, src/mcp/server.test.ts
supersedes: nothing
---

## Files

- src/seatGlue/engine.ts
- src/seatGlue/seat.ts
- src/seatGlue/doctrine.ts
- src/composio/relayHandler.ts
- scripts/sandbox-gate/e2b-gate.mjs
- thoughts/shared/plans/2026-09-28-step-2b-manager-files-sandbox-skills.md
- src/mcp/csv.ts
- src/mcp/csv.test.ts
- src/seatGlue/sandbox.ts
- src/seatGlue/sandbox.test.ts
- Box_Setup_Stuff/seat-glue/e2b-template.mjs
- src/seatGlue/fileTools.ts
- src/seatGlue/fileTools.test.ts
- thoughts/shared/plans/2026-09-28-step-2c-batching.md
- src/seatGlue/batchProgress.ts
- scripts/seat-eval/batching/seed-emails.mjs
- scripts/seat-eval/batching/gate.mjs
- src/mcp/server.test.ts

## Notes

Openclaw retirement step 2b, done in the step-2 session (operator 2026-09-27: "We'll be doing it in this session", not parked for later).
Scope from the 2a plan's split: the glue's own file tools (run_command, read_file, write_file, share_file) passed to a vendor sandbox per manager, the vendor chosen by a gate test between E2B (lifecycle onTimeout:'pause', autoResume) and Vercel; skills via the SDK's skill folders; lift the Composio workbench/bash block (#287) when the file tools land. No sandboxes on Lightsail.
Research: thoughts/shared/research/2026-09-23-sandbox-vendors-in-depth.md, 2026-09-23-step-2-manager-seat-on-the-seat-glue.md.

## Decisions

Operator, 2026-09-27/28:
- **Vendor: E2B only** (Vercel's sign-up is stuck on account/no-team). Gate passed: 2.5 h paused, woke in 0.54 s, files identical, frozen job finished.
- 1A files reach the phone as Telegram documents; 2A no internet in the sandbox, libraries baked into our template; 3A export_query now; 4A the skills mechanism + a spreadsheet skill; 5A the Composio workbench/bash block STAYS.
- **Batching belongs to step 2 (2026-09-28): it is 2c, the NEXT sub-step after 2b**, built on the Claude Code documented pattern — main agent lists ids (references, not contents) → sub-agents with clean contexts take chunks (Copilot SDK customAgents; parallel = Fleet Mode) → each writes its summary to a sandbox file, returns ~1–2K tokens → main agent combines; plus notes per batch (write_file) and the engine's compaction. Sources: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents, https://code.claude.com/docs/en/agents, https://claude.com/blog/subagents-in-claude-code, https://github.com/github/copilot-sdk/blob/main/docs/features/custom-agents.md. Unverified until tested: customAgents under mode 'empty', subagent.* events vs the turn policy / Stop / held text, cost, Fleet parallelism. Gate: a driven 100-email test. **Invoices + exports move to 2d.** Not parked as a separate board item (operator: "this belongs in step 2").

## Handoff 2026-09-28T18:12:43.299Z

**What changed** — Step 2b and 2c are live on s2. 2b (#290): the manager seat has an E2B sandbox, file tools, export_query and a spreadsheet skill. 2c (#292): big jobs (more than ~20 items) are worked in batches through a `batch_progress` checklist file in the sandbox, with "Working… batch N of T" on the phone and resume after Stop. Small jobs stay in one pass. Follow-ups: #287 (Composio workbench blocked), #288 (choices via ask_user before a plan), #289 (a cancelled plan is said, not asked), #291 (plans in plain language). The same session also shipped plan mode only at Jev p ≥ 0.8 (in #292) and standing facts recording on the first call for every tier (#293, spine + glue; s2 and s5 reinstalled).
**Decisions** — Operator: E2B only (Vercel sign-up stuck); batching by STRUCTURE (a checklist tool) + PROMPT (a rulebook trigger + skill), NOT sub-agents (the spike worked but has double dispatch, see the sub-agent memory); answer quality vs a keyword scan is not the point of batching (it exists so long repetitive jobs don't live in memory); small jobs must not batch; plan only when Jev ≥ 0.8, otherwise ask_user; standing facts no longer confirm (overrules 2026-08-21), and send_email/retract_capture still do.
**Assumptions** — 0.8 is unmeasured beyond one phone message (p=0.05). The 100-email gate's fixtures reuse 4 emergency sentences, so it proves the procedure, not that batching reads better than a scan.
**Open** — The 2c phone check (50 emails, Stop, carry on) was NOT run; the operator closed out without it. The cost of a 100-email batched run was not captured. Next: 2d (invoices + exports), then step 5.
**Downstream** — Lessons worth keeping: (1) Copilot SDK 1.0.14: `invocation.signal` never fires on session.abort(), so the glue kills commands itself through onAbort plus a process-group kill; (2) `setsid --wait` reports a signal death as the raw wait status (9, not 137), fixed with a .code file; (3) systemMessage mode "replace" drops the engine's skill catalogue, so the glue must list the skills itself or they are never used; (4) OpenRouter provider failover: "Google" (Vertex) can hang 58 s with a 504 before OpenRouter tries Google AI Studio, and there is no per-provider timeout; a Vertex 400 is one source of "400 Provider returned error" (seen 2 in 80 calls on s2, 2026-09-28; read `provider_responses` from /api/v1/generation).
