---
date: 2026-09-24
task: Step 2a — the owner's manager seat (s2) runs on the seat glue: manager rulebook, Composio, answer buttons, Jev-chosen plan mode, seat memory
research: thoughts/shared/research/2026-09-23-step-2-manager-seat-on-the-seat-glue.md (+ 2026-09-23-plan-mode-and-jev-tool-search-tests.md, 2026-09-23-sandbox-vendors-in-depth.md)
status: draft
supersedes: nothing
---

## Overview

Step 2 moves the manager seat s2 onto the seat glue that runs Ben's technician seat (s5). It is
split into three plans built in order in this worktree (one would exceed 300 lines): **2a (this)**
the seat runs on the glue as a manager; **2b** files (sandbox interface, E2B vs Vercel gate test,
file tools, skills, sending a file); **2c** invoices and exports (spine data verbs, numbering, the
send with its Approve tap). 2a ends with s2 live on the glue, answering everything the openclaw s2
did except in-sandbox file work (back in 2b).

## Decisions

Operator rulings (task record `20260923-step-2-manager-seat-s2-on-the-seat-glue`, 2026-09-23):
- **All tools loaded, tool search OFF.** It measured as a wash at ~49 tools; Jev search is the tested option for later.
- **Plan mode ON, chosen per message by Jev** (`typesafe/jev-1.13`, one `noul`, threshold 0.5,
  message + previous exchange); the glue calls `session.rpc.mode.set` before each send; Go/Change
  buttons approve; the glue notices "approved but nothing followed".
- **`ask_user` IN**, with the choices as buttons and the turn staying open; while a question or plan
  waits, the manager's next text or voice note is the ANSWER.
- **Composio INCLUDED** (second MCP server: the Render `/composio` relay, same seat token).
- **Seat memory: a table on Render**, through spine tools. **Skills: SDK skill folders**, in 2b.
  **The s2 office/nudge gap until step 3: accepted.**
- **Permission layers loose:** no Approve buttons in 2a (the invoice send's Approve is 2c);
  Composio calls are approved like spine calls, as openclaw does today.
- **Invoice numbering / recording on send / drawing in the sandbox:** decided, land in 2c.

Implementation choices (mine, not product-facing):
- **The tier comes from Render:** `/seat/whoami` adds `tier`; nothing is hand-set on the box.
- **Seat memory mirrors `planner_memory`,** with `technician_ref` in BOTH tables and in pruning so one
  person's writes never prune another's history; 3 manager-tier tools `list/read/write_my_memory`.
- **Change** holds the plan open: "What should change?" → the next text or voice becomes
  `{approved:false, feedback}`. A **typed reply** instead of a tap goes to Jev ("is the manager
  approving the plan as it stands?", ≥0.6 → Go); anything else is sent back as feedback.
- **One prompt at a time;** a second `ask_user` queues behind the first. Stop, /new, an aborting
  photo, and any `session.idle` cancel open prompts, so nothing is left orphaned.
- **Jev or `mode.set` failing never blocks a reply:** 3 s timeout, errors → interactive, logged.
- **Cut over at the end of 2a** (build fast, then test): s2 loses in-container file work until 2b.

## Plain-language walkthrough

```
Sam's Telegram ─► @ragisan_bot ─► seat-glue@s2 ─► whoami: tier=manager → manager rulebook
                                     │  Jev: "plan first?" → mode plan | interactive
                                     ▼
                         Copilot engine (all ~52 tools)
                          ├─ spine MCP (seat token) ─► Render: 48 manager tools incl. my-memory
                          ├─ composio MCP (seat token) ─► Render /composio relay ─► Gmail/Sheets…
                          ├─ ask_user ─────► glue: question + buttons ─► Sam taps / replies
                          └─ exit_plan_mode ─► glue: plan + [Go][Change] ─► Sam taps
```

**Phase 1 (Render):** Render says whether a seat is a manager's, and gains a per-person memory (a
table + three tools). You'd notice: the seat remembers "invoices due in 14 days" across conversations.
**Phase 2 (glue):** a manager seat gets the manager rulebook, Composio, and the two built-in tools.
**Phase 3 (glue):** questions and plans reach Telegram with buttons; the seat waits for the tap or
reply instead of treating it as a new message. **Phase 4 (glue):** Jev decides per message whether
to plan. "Make invoices for last month" shows a plan with Go/Change, while "what's on tomorrow?" just
answers. **Phase 5 (box):** install, cut s2 over, and test from the phone.

## Secrets & env preflight

- **Phase 1:** none. The operator applies the migration to the pilot (deploys never migrate).
- **Phases 2–4:** none new (`OPENROUTER_API_KEY` is already required). Local driver runs need
  `OPENROUTER_API_KEY` in the worktree `.env` and a local seat (setup below). Composio checks need
  `COMPOSIO_API_KEY` on the local spine, or they are recorded SKIPPED.
- **Phase 5:** existing box files only. `add-glue-seat` runs from the main checkout against the pilot.
- **Budget:** the shared key had $15.25 left for September on 2026-09-23. Check `GET /api/v1/key` before live runs.

**Local seat setup (Phases 2–4, once),** as in the step 4 plan (`2026-09-23-step-4-per-seat-tokens.md:251`):
a local `hosts` row; manager-sam's `host_id` + `sandbox_ref=s2` + a bound `telegram_user_id`; a
`seats` row; a token minted through the local `/control/seat-token`; `SEAT_REF=s2`, `SEAT_TOKEN`,
`SPINE_MCP_URL=http://127.0.0.1:<port>/mcp` for `drive.ts`, and the local HTTP spine running.

## Phase 1: Render: the tier in whoami, and seat memory

**`src/mcp/httpServer.ts`** `handleSeatWhoami` (line 341, 200 body ~375): add `tier: person.tier`.
**`supabase/migrations/20260924120000_seat_memory.sql`** (new): `seat_memory(tenant_id → tenants
on delete cascade, technician_ref text, path text check (planner_memory's regex), content text,
created_at, updated_at, primary key (tenant_id, technician_ref, path))` + `set_updated_at` trigger;
`seat_memory_versions(... technician_ref text not null ..., replaced_at)` indexed on `(tenant_id,
technician_ref, path, replaced_at desc)`; RLS on, privileges revoked from `anon, authenticated`.
**`src/db/seatMemory.ts`** (new): like `plannerMemory.ts`, keyed `(tenantId, technicianRef)`,
including archive + prune filters on `technician_ref`.
**`src/mcp/tools/memory.ts`** (new, `admin` tier): `list_my_memory`, `read_my_memory({path})`,
`write_my_memory({path, content})`; `validateMemoryPath` / `validateMemoryContent`; always the caller's
own identity, with no ref argument.
**`src/mcp/server.ts`**: `...memoryTools.admin` in `ADMIN_TOOLS` (330), handlers at 576.
**`src/mcp/tools/surface.expected.ts`**: 3 names in the manager-only list (45 → 48).
**`src/eval/toolCases.ts`**: a tier-1 case per new tool and a `gating` case where a technician is
refused (`toolCases.test.ts:63-71` requires every `SPINE_TOOL_NAMES` entry).
**Cleanup lists:** `scripts/seed.mjs`, `scripts/spine-eval/world.mjs`, `scripts/agentic-eval/run.mjs`
(`:147` and `:264-265`) add both tables. Then **`npm run gen:types:local`**, never plain `gen:types`.

### Automated verification
- [x] worktree `npx supabase db reset` applies it; `npm run typecheck`, `npm run lint`, `npm test`
- [x] `seatMemory.test.ts`: round trip; an overwrite keeps a version; A's rewrites never prune B's versions
- [x] `memory.test.ts` through `dispatchForIdentity`: a technician is refused (the hub's gate, `server.ts:705`); a bad path is refused
- [x] whoami test asserts `tier`; `toolCases.test.ts` + surface tests pass

## Phase 2: the manager's engine (rulebook, Composio, built-ins)

**`src/seatGlue/whoami.ts`**: `SeatWho.tier: 'manager' | 'technician'`; anything else throws.
**`src/seatGlue/doctrine.ts`**: `MANAGER_PREAMBLE` (a MANAGER's assistant; prefixes `spine-` and
`composio-`, e.g. `composio-COMPOSIO_MANAGE_CONNECTIONS`; use `spine-list_my_memory` at the start
of a task that could use preferences, `spine-write_my_memory` to keep them; `ask_user` for choices;
photos/voice and the blobPath guard as for technicians) and `MANAGER_DOCTRINE = [MANAGER_PREAMBLE,
...PORTED_BLOCKS.map(applyUpdates)]`. The ported blocks are unchanged, so the drift test holds.
**`src/seatGlue/engine.ts`**:
- `EngineConfig.tier`, set in `main.ts engineConfig` from `who.tier`.
- Managers get: the manager doctrine; `mcpServers.composio = {type:'http', url: new URL('/composio',
  cfg.spineUrl).toString(), tools:['*'], timeout:300_000, headers: seatHeaders(cfg.seatToken)}`; and
  `availableTools: ['mcp:*','builtin:ask_user','builtin:exit_plan_mode']`. Technicians: unchanged.
- `SPINE_NAMES` → `TOOL_SERVERS` (+`'composio'`): approve + `onToolPending`. Log the `kind` of the
  first non-mcp permission request: if built-ins raise one, approve `ask_user` / `exit_plan_mode` by
  `toolName` (unmeasured, reviewer finding).
- `sessionConfig(cfg, policy, hooks?)`, where `hooks = {onUserInput, onExitPlan}` wire to
  `onUserInputRequest` / `onExitPlanModeRequest` for managers. `openSession(client, cfg, policy, id, hooks?)`.
- `EngineSession.rpc?: { mode: { set(p:{mode:'plan'|'interactive'}): Promise<unknown>; get(): Promise<string> } }`
  is OPTIONAL, so existing fakes still compile (`rpc.d.ts:24776-24791`).
**`src/seatGlue/seat.ts` / `main.ts` / `drive.ts`**: `SeatDeps.openSession(sessionId, hooks?)`; the Seat
passes its hooks at `start()`, the reopen in `deliver()`, and `startFresh()` (`seat.ts:98, 212, 317`);
`seatDeps` threads `hooks` to `openSession` (`main.ts:68`); `seat.test.ts` `setup()` updated.

### Automated verification
- [x] `engine.test.ts` (new, pure): manager config has two servers + built-ins + manager doctrine;
  technician config is deep-equal to today's; `composio` is approved and other servers rejected
- [x] `doctrine.test.ts`: every ported block appears in the manager doctrine; `whoami.test.ts` tier cases
- [x] typecheck, lint, `npm test`

## Phase 3: buttons and waiting prompts

**`src/seatGlue/telegram.ts`**: `sendButtons(chatId, text, rows: {text,data}[][]) → message_id`,
which splits like `send()` and puts the keyboard on the last chunk; `clearButtons(chatId, messageId)`
(`editMessageReplyMarkup`). Callback data `p:<promptId>:<n>` (≤64 bytes). Implement both in
`FakeTelegram` (`seat.test.ts:47`) and `ScriptedTelegram` (`drive.ts:40`, which records the open prompt id).
**`src/seatGlue/inbound.ts`**: a `p:<id>:<n>` callback from the allowed user → `{kind:'tap', promptId, index, callbackQueryId}`.
**`src/seatGlue/prompts.ts`** (new): `PendingPrompts` with one open prompt and a FIFO queue behind it;
`ask(...) → Promise<{answer, freeform}>`; `resolveTap`, `resolveText`, `cancelAll(reason)`.
**`src/seatGlue/seat.ts`**:
- `onUserInput(req)`: the question + `choices` as buttons ("Or type an answer" when
  `allowFreeform`) → `{answer, wasFreeform}`.
- `onExitPlan(req)`: `summary` + `planContent` (3,500 chars total) with [Go][Change]. Go →
  `{approved:true, selectedAction: req.recommendedAction}`. Change → "What should change?", then
  the next text/voice → `{approved:false, feedback}`. A typed reply without a tap → Jev (Phase 4)
  decides Go vs feedback; until Phase 4, it is feedback.
- `handle()`: a `tap` → `resolveTap` + `clearButtons` + `answerCallback`. With a prompt open, a
  `text` or a voice TRANSCRIPT → `resolveText`, never `deliver`. A photo → `cancelAll` then
  `deliver`. `stop` / `new` → `cancelAll` first.
- `onEvent('session.idle')` → `prompts.cancelAll('turn ended')` (a finished turn has no waiter).
  While a prompt waits, typing and "Working…" pause; they resume when it resolves (Stop stays reachable).
**`src/seatGlue/turnPolicy.ts`**: a comment only. An open prompt short-circuits in `seat.ts`
before `route()`; only the manager's own text/voice/tap answers it (step 3's office items queue behind).
**`src/seatGlue/drive.ts`**: steps `{waitPrompt:true}` (resolves when `sendButtons` fires; 120 s
timeout) and `{tap:n}` (a `callback_query` update with the open prompt's `p:` data).

### Automated verification
- [ ] `prompts.test.ts`: one open, FIFO queue, tap/text resolve, cancelAll
- [ ] `seat.test.ts` (fake engine): ask_user → buttons → tap resolves; a text or a voice while
  waiting resolves it and is never delivered; a photo cancels then delivers; idle cancels; Stop
  cancels; plan Go; Change + feedback; `inbound.test.ts`: `p:` callbacks from others are ignored
- [ ] typecheck, lint, `npm test`
- [ ] Local driver (local seat): `{"text":"cancel the beckers"}`, `{"waitPrompt":true}`, `{"tap":0}`,
  `{"waitIdle":true}` → the same turn ends in a reply; the transcript is the evidence

## Phase 4: Jev chooses plan mode per message

**`src/seatGlue/jev.ts`** (new, self-contained, `FetchLike` injected): `needsPlan(message,
previous?) → {plan, p}` and `approvesPlan(reply, planSummary) → {approve, p}` via `POST
https://openrouter.ai/api/alpha/decisions`, `typesafe/jev-1.13`, `noul`. The wording is
`scripts/seat-eval/plan-mode/test2.mjs` `PLAN_Q`/`PLAN_CRITERIA`; `approvesPlan` asks "is the
manager approving the plan as it stands?". 3 s timeout; any failure → `{plan:false}` / `{approve:false}`.
**`src/seatGlue/seat.ts`**, manager seats only:
- On a FRESH turn (not a steer, not a prompt answer, not the nudge): `needsPlan(prompt,
  lastExchange)` → `try rpc.mode.set({mode})` (on failure, log and send anyway) → send. Keep
  `lastExchange` (last manager text + last reply). Log `plan p=0.87`.
- Typed reply to an open plan prompt → `approvesPlan` → Go, or feedback.
- The nudge: after Go, if `session.idle` arrives with no `tool.execution_start` other than
  `exit_plan_mode` and no released reply text since the approval, send once "Go ahead with the
  plan." as a plain send: no Jev, no `mode.set`, never twice per plan.
**`src/seatGlue/main.ts`**: pass `tier` and a Jev client into `seatDeps` (technicians get none).

### Automated verification
- [ ] `jev.test.ts` (fake fetch): p ≥ 0.5 → plan, 0.49 → interactive; HTTP 500/timeout → safe default
- [ ] `seat.test.ts`: a manager's fresh turn calls `mode.set` before `send` (FakeSession records it);
  `mode.set` throwing still sends; a technician never calls Jev; a steer does not re-classify; the
  nudge fires once, only when nothing but `exit_plan_mode` ran; a typed "yes go" → Go
- [ ] typecheck, lint, `npm test`

### Live verification (agent-executable)
- Prerequisites: the local seat set up; `OPENROUTER_API_KEY`; key allowance checked.
- [ ] Driver, 6 messages from `test2.mjs` (3 quick, 3 multi-step), each followed by `waitPrompt`/`tap`
  where a plan appears: quick → no plan; multi-step → [Go][Change] and no local-DB write
  (money_events / visits) until the tap. Evidence: transcript + row timestamps.
- [ ] A prompt left 10 minutes, then tapped, still completes. The engine's timeout on a pending
  request is unmeasured (research Open Question 1); record the result either way.

## Phase 5: install and cut over s2

No code. Steps, in order:
1. Operator: apply `20260924120000_seat_memory.sql` to the pilot (never `db push`), then deploy the
   web service (it does not auto-deploy).
1b. **Gate:** confirm the live deploy serves `tier`, via an s5 token whoami (or the Render dashboard
   commit containing Phase 1). Stop if not: `tier` is fail-closed, and both seats would refuse to start.
2. Operator, from the main checkout after `npm run build`: `node scripts/assign-host.mjs add-glue-seat
   ref=manager-sam host=<host NAME of trades-box-1> seat=s2` (pilot only, by design).
3. `stage.sh` → box → `sudo bash install.sh s2`; then `sudo systemctl restart seat-glue@s5` (install
   restarts only s2; s5 would keep old code until an unplanned restart).
4. `sudo bash cutover.sh s2`; rollback = `rollback.sh s2`.

### Live verification (agent-executable)
- Prerequisites: box ssh via the operator; the Render deploy visible in the dashboard.
- [ ] `journalctl -u seat-glue@s2`: whoami tier=manager, "polling Telegram", no 409
- [ ] `journalctl -u seat-glue@s5` after its restart: whoami ok; a technician message still answered

### Manual verification
- [ ] From Sam's phone to @ragisan_bot: a schedule question (no plan); "make a list of every open job
  with its balance" (plan → Go → answer); a question that makes it ask (buttons); "remember I want
  invoices due in 14 days" → /new → "what are my invoice terms?" (memory); "connect my Google
  Sheets" (Composio link). Judge the tone and whether the buttons feel right.

---
*Pause after Phase 5 (manual checks on the phone).*
