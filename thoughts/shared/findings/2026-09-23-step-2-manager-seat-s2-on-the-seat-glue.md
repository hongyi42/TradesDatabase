---
date: 2026-09-23
task: Step 2: manager seat (s2) on the seat glue with a sandbox vendor — Cowork-like files, export + invoice verbs, approvals as Telegram buttons
status: complete
origin: 
files: src/seatGlue/engine.ts, src/seatGlue/seat.ts, src/seatGlue/doctrine.ts, src/seatGlue/config.ts, src/seatGlue/turnPolicy.ts, src/seatGlue/telegram.ts, src/mcp/server.ts, src/mcp/tools/money.ts, Box_Setup_Stuff/seat-glue/install.sh, Box_Setup_Stuff/seat-glue/cutover.sh, thoughts/shared/research/2026-09-23-step-2-manager-seat-on-the-seat-glue.md, thoughts/shared/research/2026-09-23-sandbox-vendors-in-depth.md, docs/engineering-memory.md, scripts/seat-eval/README.md, thoughts/shared/research/2026-09-23-plan-mode-and-jev-tool-search-tests.md, thoughts/shared/plans/2026-09-24-step-2a-manager-seat-on-the-glue.md, supabase/migrations/20260924120000_seat_memory.sql, src/db/seatMemory.ts, src/db/index.ts, src/mcp/tools/memory.ts, src/eval/toolCases.ts, src/db/seatMemory.test.ts, src/mcp/tools/memory.test.ts, src/seatGlue/engine.test.ts, src/seatGlue/prompts.ts, src/seatGlue/prompts.test.ts, src/seatGlue/jev.ts, src/seatGlue/jev.test.ts
supersedes: nothing
---

## Files

- src/seatGlue/engine.ts
- src/seatGlue/seat.ts
- src/seatGlue/doctrine.ts
- src/seatGlue/config.ts
- src/seatGlue/turnPolicy.ts
- src/seatGlue/telegram.ts
- src/mcp/server.ts
- src/mcp/tools/money.ts
- Box_Setup_Stuff/seat-glue/install.sh
- Box_Setup_Stuff/seat-glue/cutover.sh
- thoughts/shared/research/2026-09-23-step-2-manager-seat-on-the-seat-glue.md
- thoughts/shared/research/2026-09-23-sandbox-vendors-in-depth.md
- docs/engineering-memory.md
- scripts/seat-eval/README.md
- thoughts/shared/research/2026-09-23-plan-mode-and-jev-tool-search-tests.md
- thoughts/shared/plans/2026-09-24-step-2a-manager-seat-on-the-glue.md
- supabase/migrations/20260924120000_seat_memory.sql
- src/db/seatMemory.ts
- src/db/index.ts
- src/mcp/tools/memory.ts
- src/eval/toolCases.ts
- src/db/seatMemory.test.ts
- src/mcp/tools/memory.test.ts
- src/seatGlue/engine.test.ts
- src/seatGlue/prompts.ts
- src/seatGlue/prompts.test.ts
- src/seatGlue/jev.ts
- src/seatGlue/jev.test.ts

## Notes

Openclaw retirement step 2 (memory openclaw-retirement-plan; operator parked it 2026-09-23). Move the owner's manager seat s2 off openclaw onto the seat glue that step 1 built (src/seatGlue, live on s5), toward the Cowork-like manager seat (memory manager-seat-is-cowork-shaped): local tools run_command / read_file / write_file / share_file executed in ONE vendor sandbox per manager (id persisted), export + invoice verbs on the spine, the SDK's onPermissionRequest turned into Telegram inline Approve/Deny buttons for sends/writes/grants, a small seat-memory table, a skills folder. Gate: the invoice job end to end, including one that outlives the sandbox's idle sleep.
Glue facts that bind it: the manager catalog is 45 tools — above the SDK's tool-search deferral threshold of 30 (types.d.ts ToolSearchConfig) — and manager prompts measured 17.8K tokens in step 0; the ~15K-token technician prompt already dominates cost ($0.0225/reply live).
Operator decisions: the sandbox vendor (field open — see Decisions); plan mode as the managers' default; tool search on or off for 45 tools.

## Decisions

Operator, 2026-09-23:
- **Sandbox vendor field is OPEN.** Google/Vercel/E2B (Notes above) was a Claude aside in the 2026-09-21 research, never the operator's shortlist. Full field: thoughts/shared/research/2026-09-23-sandbox-vendors-in-depth.md. Front-runners after that research: E2B (with `onTimeout:'pause'`), Vercel, Daytona VM class; proposed gate test = E2B vs Vercel. Vendor NOT yet chosen.
- **No sandboxes on the Lightsail box.** "don't bother with running the sandboxes in the lightsail host" — settles the 2026-09-21 "fine hosting sandboxes for managers in the box" vs "vendor on demand" ambiguity: a VENDOR it is.
- **File tools live in the glue** (option A, "keep in house"): run_command / read_file / write_file / share_file are the glue's own custom tools (SDK `defineTool`), each passed to the manager's vendor sandbox and through onPermissionRequest (kind `custom-tool`, args visible). NOT the engine's built-in shell/file tools.
- **Invoice drawing:** the spine hands over DATA (ledger summary, letterhead, line items); the sandbox renders the PDF/XLSX.
- **Invoice recording = option C: recorded when it is SENT OUT.** A drawn draft is only a file (no ledger row). The `invoice_issued` money_events row is written when the invoice leaves: sent through us (the manager taps Approve on the send), or the manager says it went out another way (row with `externalRef`, e.g. the QuickBooks number). Mistakes are fixed with `invoice_voided` (one-level negation; a mistaken void is fixed by re-issuing). The Approve button guards the SEND, not the ledger row.
- **When the manager taps Approve on the send, the bot's reply says it sent the invoice AND recorded it** (plain words, no ids).
- **`ask_user` is IN step 2** (operator yes, 2026-09-23). Supply `onUserInputRequest` and add `ask_user` to the glue's `availableTools` (it is in `BuiltInTools.Isolated`, but mode "empty" allows nothing by default). The glue posts the question with `choices` as Telegram inline buttons; a tap or (if `allowFreeform`) the next typed text returns as the answer, and the turn stays open. Shares the inline-button code with the Approve/Deny buttons. Turn policy: while a question is pending, the manager's next text is the ANSWER, not a double text (no abort, no steer).
- Proposed, NOT yet ruled: permission handler in layers — (1) fixed allow rules in code (reads, sandbox file work), (2) fixed asks in code (sends, share out, Composio writes, grants → Telegram Approve/Deny), (3) an optional cheap model for the grey zone later (e.g. TypeSafe Jev), only if buttons annoy. Claude Code's auto mode is a Sonnet 4.6 classifier; Cowork's "Automatically approve" reviews each action (model unnamed); the Copilot SDK has no model — our handler decides.
- **Vendor: the gate test decides between E2B (created with `lifecycle:{onTimeout:'pause', autoResume:true}`) and Vercel Sandbox** (operator took the proposal, 2026-09-23). File tools sit behind one small sandbox interface (create, run, read, write, pause/resume) so the loser costs one file; jobs write progress to disk as they go. The gate script includes a repeated pause/resume check (5 cycles; E2B community #884/#1587).
- **Permission layers stay LOOSE for now** (operator): no ruling on the layered design; build the fixed asks the other rulings already need (the invoice send's Approve) and leave the rest open.
- **Invoice numbering — delegated to Claude, decided:** a per-firm sequence, assigned AT SEND (when the `invoice_issued` row is written), so drafts never burn a number; a draft PDF says DRAFT, no number. Gaps come only from voids (normal; never reused). Numbers unique per firm, enforced in the DB. Default format INV-1001 upward; a firm moving over from other software can set its starting number later (tenant_profiles). An invoice sent from ANOTHER system mints no number of ours — its number goes in `externalRef`.
- **Plan mode MEASURED 2026-09-23 — it does NOT enforce for our tools.** Operator's condition was "if it enforces, use Jev as the separate classifier". Local rig (scratchpad `planmode/`), SDK 1.0.14, mode "empty", `@preset/trades-seats`, responses wire, a stdio MCP probe (lookup_job read / record_note / send_invoice) + custom write_file/share_file, 27 runs:
  - per-message `send({agentMode:'plan'})`: no effect — and by design: the SDK documents `agentMode` as a LABEL ("The UI mode the agent was in when this message was sent … Defaults to the session's current mode", types.d.ts:2792-2796), not a switch. 12 runs: mode stayed "interactive", 0 exit_plan_mode calls. The switch is session-level `rpc.mode.set`, which the glue can call before each message.
  - session `rpc.mode.set({mode:'plan'})`: exit_plan_mode called in 7 of 9; approve → mode "autopilot" and the writes ran after; reject → nothing ran (3/3).
  - **pressure run ("just do it now"): the session stayed in PLAN mode and write_file, send_invoice, record_note all EXECUTED with no exit_plan_mode call** — our onPermissionRequest was asked for each (kind custom-tool / mcp) and approved them. The engine's only plan-mode block (its bundled text) covers shell/file changes outside the session folder, not MCP or custom tools.
  - So: native plan mode = a prompt, not a gate. The only enforcement point for our tools is OUR permission handler.
  - Operator's correction: "just do it now" SKIPPING the plan is the RIGHT behaviour, so that run is not a failure. Re-read: session plan mode never acted before approval unless told to; the send's Approve button guards the irreversible step regardless. Plan mode is ACCEPTABLE as the planning habit; open items = per-message switching via rpc.mode.set, 1-in-9 stall, reset from "autopilot", experimental API.
- **Jev + per-message plan switching MEASURED 2026-09-23 — it works** (operator asked for the test; scratchpad `planmode/test2.mjs`). One continuing conversation, 12 manager messages (7 quick incl. one single note, "Thanks!" and "just send it now, no plan"; 5 multi-step invoice/export jobs), labels by Claude, run twice. Jev (`typesafe/jev-1.13`, one `noul` question, threshold 0.5): **48/48 right, stable across 4 runs**; closest calls "Thanks!" p≈0.34 and the invoice-correction job p≈0.70; ~$0.00002/call; p50 370 ms warm (2.1 s on the first, cold run). Glue calls `session.rpc.mode.set` before EACH message: **switch took effect 24/24**, including back to interactive from "autopilot". Plan turns: **asked for approval 10/10, writes before approval 0/10**; quick turns asked for a plan 0/14. One plan turn (run 1, b1) did nothing after approval (1/10; run 1 left mode "interactive" after approval, run 2 "autopilot" — the engine's recommendedAction varied). Caveats: stand-in tools, synthetic messages, Jev saw only the single message (a follow-up like "yes, do that" needs recent context), approvals were instant.
- **Plan mode ON, chosen by Jev** (operator, 2026-09-23): before each manager message the glue asks Jev (`typesafe/jev-1.13`, one `noul` "plan first?", threshold 0.5, given the message PLUS the previous exchange so follow-ups classify) and calls `session.rpc.mode.set` to plan or interactive before sending; after an approved plan the next message resets the mode. Approval = the manager's Go/Change buttons (onExitPlanModeRequest); the invoice send's Approve still guards the send. The glue detects "approved but nothing followed" (1/10 measured) and nudges or tells the manager.
- **Tool search: OFF — all tools loaded for step 2** (operator, 2026-09-23, after the measurement). Jev as the seat's tool search was MEASURED (100-message reference run + 3 arms on 31; write-up thoughts/shared/research/2026-09-23-plan-mode-and-jev-tool-search-tests.md, harness scripts/seat-eval/): Jev picks ≈ a strong LLM's picks at ~1/10 the search cost; per message Jev-search $0.112 vs all-tools $0.121, both 84.7% of labelled tools — a wash at ~49 tools. The engine's own tool search NEVER defers our tools (0/45); the working route is glue-run `find_tools` + `session.rpc.tools.set`. **Operator: "remember the jev tool-search test"** — it is the tested option to switch on when the catalog grows (Composio). The cost lever is the rulebook + ~19K tokens of tool descriptions, not search.
- **Composio: INCLUDED on the manager seat** (operator, 2026-09-23) — a second MCP server (the Render `/composio` relay with the seat's identity) admitted by the permission handler.
- **Seat memory: a table on Render** (operator) — reached through spine tools, like the planner's memory.
- **Skills: through the SDK's skill folders** (`skillDirectories` + `enableSkills`, off by default in mode "empty") (operator).
- **The s2 office/nudge gap until step 3 lands: ACCEPTED** (operator) — same as s5's decision 5 = C; s7/s8 still receive their own pushes.
- Nothing left open before /plan (operator: "Write the plan now").
- **A typed/spoken reply while a question or plan waits goes through Jev first** (operator, 2026-09-24, after the final review: "just put jev in then"): does it answer the waiting question, or is it a new request? New request → the old prompt closes unanswered and the text starts its own turn WITH its own plan check (a prompt answer otherwise rides the old turn and skips the plan check). Taps skip Jev; "What should change?" skips it; Jev failure/timeout → treated as the answer (the old behaviour). Operator's view on record: the model would handle an unrelated answer anyway ("even if they do a smart model would be able to distinguish it") — the gap this closes is the skipped plan check.

## Handoff 2026-09-23T16:11:42.149Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/step-2-manager-seat-s2-on-the-seat-glue on work/step-2-manager-seat-s2-on-the-seat-glue, from origin/main c655f91.

Overlap check: 3 overlaps with active tasks — the operator read them and proceeded (--proceed):

  LOW   same file only      Box_Setup_Stuff/seat-glue/install.sh
        20260923-step-4-per-seat-tokens-replace-the-doorm lists it but has not changed it; 20260923-step-2-manager-seat-s2-on-the-seat-glue names it
  LOW   same file only      src/seatGlue/config.ts
        20260923-step-4-per-seat-tokens-replace-the-doorm lists it but has not changed it; 20260923-step-2-manager-seat-s2-on-the-seat-glue names it
  LOW   same file only      src/seatGlue/engine.ts
        20260923-step-4-per-seat-tokens-replace-the-doorm lists it but has not changed it; 20260923-step-2-manager-seat-s2-on-the-seat-glue names it

## Handoff 2026-09-27T15:35:11.296Z

**What changed** — Step 2a is live (2026-09-27 14:15 UTC). The owner's manager seat s2 (@ragisan_bot) runs on the seat glue: the manager rulebook, Composio as a second server, `ask_user` and plan buttons, Jev choosing plan mode per message and telling an answer from a new request, and seat memory on Render (`seat_memory`, migration `20260924140000`). Openclaw's s2 is stopped. Phone tests passed: schedule, list, buttons, memory, Composio link, plan. Two fixes from those tests are live: #287 (the relay refuses Composio's hosted workbench/bash) and #288 (a real choice goes to `ask_user` first; a plan is one course of action). Fixes made in place during the merge with step 3:
- the migration was renamed off step 3's `20260924120000` timestamp;
- a manager's glue never polled its inbox (#285 gated the whole inbox, not just the notice). Fixed, and the test now starts the seat for real.

**Decisions** — Operator:
- E2B vs Vercel gate test for 2b; no sandboxes on Lightsail;
- file tools stay in-house;
- an invoice is recorded when it is sent (INV-1001 onward);
- `ask_user` in; plan mode on, chosen by Jev;
- a typed reply while a prompt waits goes through Jev (new request → its own turn);
- tool search off, all tools loaded;
- Composio in;
- the workbench is blocked until 2b;
- choices are asked before the plan (prompt only, not code);
- the s2 message gap until step 3 was accepted (now moot).

Mine:
- a missing whoami `tier` falls back to technician with a warning; an unknown one throws;
- `SPINE_NAMES` (transcript) is kept separate from `TOOL_SERVERS` (permission);
- the extra `restart seat-glue@s5` was skipped (same package).

**Assumptions** — The Cowork comparison for plans rests on Claude Code's documented plan mode, not Cowork's current docs. Jev's answersPrompt wording is unmeasured on real traffic; its tests are code-level plus the live phone path.

**Open** — 2b is next: files, a sandbox (E2B vs Vercel gate test) and skills. Lift the workbench block when it lands. 2c: invoices and exports; the pilot firm has NO firm profile yet (name, address, license, footer). No export tool exists, so a list or CSV is the model copying rows. A plan on s2 was left waiting for a Go tap (harmless). The nit left from review: the memory accessor duplicates the planner's. Stale stage copies sit on the box under `/tmp/seat-glue-stage.*`.

**Downstream** — Step 5 (remove openclaw) now has two glue seats (s2, s5). The pre-edit hook will show the manager-privacy and workbench findings. My worktree's `supabase/config.toml` stays uncommitted (second stack).
