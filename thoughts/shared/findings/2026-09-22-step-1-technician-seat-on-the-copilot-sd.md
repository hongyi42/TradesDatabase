---
date: 2026-09-22
task: Step 1: technician seat on the Copilot SDK engine on trades-box-1, s5 canary — the glue (Telegram long polling, sessions, spine tools, cost rows) replacing s5's openclaw sandbox
status: complete
origin: 
files: Box_Setup_Stuff/doorman.mjs, Box_Setup_Stuff/bootstrap-box.sh, src/mcp/httpServer.ts, src/mcp/identity.ts, src/db/costs.ts, docs/nemoclaw-tech-agent.md, docs/engineering-memory.md, thoughts/shared/research/2026-09-22-step-1-technician-seat-glue-on-the-copilot-sdk.md, thoughts/shared/plans/2026-09-22-step-1-technician-seat-on-the-copilot-sdk.md, src/seatGlue/config.ts, src/seatGlue/identity.ts, src/seatGlue/http.ts, src/seatGlue/telegram.ts, src/seatGlue/inbound.ts, src/seatGlue/turnPolicy.ts, src/seatGlue/media.ts, src/seatGlue/costLog.ts, src/seatGlue/costReport.ts, src/seatGlue/voice.ts, src/seatGlue/state.ts, src/seatGlue/config.test.ts, src/seatGlue/identity.test.ts, src/seatGlue/telegram.test.ts, src/seatGlue/inbound.test.ts, src/seatGlue/turnPolicy.test.ts, src/seatGlue/media.test.ts, src/seatGlue/costLog.test.ts, src/seatGlue/costReport.test.ts, src/seatGlue/voice.test.ts, src/seatGlue/state.test.ts, src/seatGlue/selfContained.test.ts, src/seatGlue/doctrine.test.ts, src/seatGlue/engine.ts, src/seatGlue/seat.ts, src/seatGlue/main.ts, src/seatGlue/drive.ts, src/seatGlue/seat.test.ts, Box_Setup_Stuff/seat-glue/seat-glue@.service, Box_Setup_Stuff/seat-glue/install.sh, Box_Setup_Stuff/seat-glue/cutover.sh, Box_Setup_Stuff/seat-glue/rollback.sh, src/seatGlue/format.ts
supersedes: nothing
---

## Files

- Box_Setup_Stuff/doorman.mjs
- Box_Setup_Stuff/bootstrap-box.sh
- src/mcp/httpServer.ts
- src/mcp/identity.ts
- src/db/costs.ts
- docs/nemoclaw-tech-agent.md
- docs/engineering-memory.md
- thoughts/shared/research/2026-09-22-step-1-technician-seat-glue-on-the-copilot-sdk.md
- thoughts/shared/plans/2026-09-22-step-1-technician-seat-on-the-copilot-sdk.md
- src/seatGlue/config.ts
- src/seatGlue/identity.ts
- src/seatGlue/http.ts
- src/seatGlue/telegram.ts
- src/seatGlue/inbound.ts
- src/seatGlue/turnPolicy.ts
- src/seatGlue/media.ts
- src/seatGlue/costLog.ts
- src/seatGlue/costReport.ts
- src/seatGlue/voice.ts
- src/seatGlue/state.ts
- src/seatGlue/config.test.ts
- src/seatGlue/identity.test.ts
- src/seatGlue/telegram.test.ts
- src/seatGlue/inbound.test.ts
- src/seatGlue/turnPolicy.test.ts
- src/seatGlue/media.test.ts
- src/seatGlue/costLog.test.ts
- src/seatGlue/costReport.test.ts
- src/seatGlue/voice.test.ts
- src/seatGlue/state.test.ts
- src/seatGlue/selfContained.test.ts
- src/seatGlue/doctrine.test.ts
- src/seatGlue/engine.ts
- src/seatGlue/seat.ts
- src/seatGlue/main.ts
- src/seatGlue/drive.ts
- src/seatGlue/seat.test.ts
- Box_Setup_Stuff/seat-glue/seat-glue@.service
- Box_Setup_Stuff/seat-glue/install.sh
- Box_Setup_Stuff/seat-glue/cutover.sh
- Box_Setup_Stuff/seat-glue/rollback.sh
- src/seatGlue/format.ts

## Notes

Operator ruled GO on step 0 and "go ahead on the build" (2026-09-22); task 1 of six (memory `openclaw-retirement-plan`; the operator parks them one at a time). Our thin glue on trades-box-1 around ONE `@github/copilot-sdk` 1.0.14 engine (`mode:"empty"`) for s5 (Ben): Telegram by long polling, a session per seat with ownership in Supabase, the 17 spine tools through the doorman with s5's badge (per-session `mcpServers` header — proven locally in step 0), photos as attachments, a cost row per model call, a Stop button, one systemd unit; retires s5's openclaw sandbox. Gate: a week of Ben's traffic, cost per turn vs the ~$0.02 residual. Estimate 3–5 days (not measured).
Step 0's conditions bind (engineering-memory §2 "Step 0 measured"): `wireApi:"responses"`; served model + cost from OpenRouter `/api/v1/generation?id=<apiCallId>`, never `assistant.usage`; engine `TZ` = the firm's timezone; read the last NON-empty assistant message; `modelCapabilities` override for vision (the engine assumes none for our model id — inferred from types, untested); honor `invocation.signal` in tool calls.
For the operator in /research → /plan: the double-text rule (abort + resend vs a short debounce — steering covers tool-call turns only); where s5's bot token and badge live for the glue (Telegram allows one poller per bot, so s5's openclaw must stop polling at cut-over); whether the glue lives in `src/` (tested, typed) or `Box_Setup_Stuff/`; whether the glue does its own Gemini→Muse fallback instead of `@preset/trades-seats`, whose fallback step 0 measured as sticky and silent (likely the cause of open finding 20260920-seats-hit-all-models-are-temporarily-rat — inferred).

## Handoff 2026-09-22T09:45:19.612Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/step-1-technician-seat-on-the-copilot-sd on work/step-1-technician-seat-on-the-copilot-sd, from origin/main de8d326.

Overlap check: none with any active task.

## Handoff 2026-09-22T17:47:47.057Z

**What changed** — The research phase is DONE and committed (dabb61f, doc-only, branch only):
`thoughts/shared/research/2026-09-22-step-1-technician-seat-glue-on-the-copilot-sdk.md` +
regenerated `thoughts/INDEX.md`/`by-file.json`. It maps today's s5 openclaw seat end to end
(Telegram polling inside the container, badge/doorman path, the two runners, AGENTS.md doctrine,
media, cost) and the `@github/copilot-sdk` 1.0.14 surface read from the published tarball's own
`.d.ts` files, plus Telegram and OpenRouter facts quoted from live docs. No code changed. The
worktree's own Supabase stack (N=3, 546xx, project_id `TradesDatabase-step-1-technician-5bc44a`)
is up and `npm ci` has run; `supabase/config.toml` is modified on purpose and must stay
uncommitted. No `.env` here, so key-gated live-model tests skip.

**Decisions** — None of the build's decisions were taken; that is `/plan`'s job and the operator's.
Research-process choices only: three parallel Explore agents for the three maps, and the SDK read
from the package rather than the docs site (types are the contract; docs lag). Filed 13 decision
points, of which 4 were already in the task notes and 9 are new; 5-8 (office/nudge delivery during
cut-over, the cost-row path, session ownership, which badge the glue presents) are the ones that
decide the build's shape.

**Assumptions** — Ben's live roster row, s5's live sandbox state and the medic's probe target were
NOT read from the pilot or the box; everything about s5 is from repo files and dated
engineering-memory entries (the seat table there is 2026-08-24, and a 2026-08-25 note says his
roster id had to be corrected). That #2061-style reasoning claim and the vision override remain
step 0's inferences, unre-tested here.

**Open** — Next step is `/plan` on that document. Operator input wanted first on decisions 5-8 and
on one question research could not answer: the gate's "$0.02 residual" appears NOWHERE in the repo
or its git history (nearest measured: $0.0207/turn at engineering-memory.md:3416, $0.021/call at
:7953) — what is cost/turn being compared against? Untested and named in the doc: the real
doorman -> Render hop under the engine's MCP client (step 0 tested locally), whether `mcpServers`
headers survive `resumeSession`, how soon an OpenRouter generation record is readable, and whether
the engine can carry a per-seat `user`/session id to OpenRouter.

**Downstream** — The trap for step 3 and anyone retiring a sandbox: `nudge-runner.sh:135-150` and
`office-runner.sh:115-131` deliver by `nemoclaw <seat> exec` INSIDE the seat's container, and
`nudgeQueue.ts` addresses items by `technicians.sandbox_ref`. Retire s5's container in step 1 and
every planner question, office note and push for Ben reports `failed` on Render until step 3
builds the readers — a symptom that surfaces far from its cause. Also: the box has no Supabase
credential and there is no `/control` route for cost rows or session state, so step 1 must add a
path (or Render must resolve ids later); `MODEL_SKUS.openrouter` (costs.ts:185-194) prices GLM-5.3
only, while the Gemini/Muse rate rows seeded in 20260906130000 have never been stamped. Doc drift
noticed, not fixed: both runners' headers say "every 5 min" (timers are 10 s / 30 s),
`box-report.sh:86` omits `office-runner.*`, `doorman-architecture-memory.md:372` says 14
technician tools (code has 17) and its :118-124 says a badge swap needs no restart (badge-pull
restarts the container).

## Handoff 2026-09-22T20:03:23.503Z

**What changed** — Merged origin/main into the branch (c4576cf; conflicts were only the generated index/map, resolved by regenerating). Main brought docs + rung 10c's draft plan only, no code on step 1's seams. Three operator rulings recorded as process rules in engineering-memory §1 and as memories: never size work in days (ef801fd); no seat has organic users so no gate waits on traffic — "There's no canary week. Ben is just a name" (d22c861, also answers the research doc's open question); while there are no real users, build the quick version then test, naming each hole, never for irreversible acts (1e6fd0e).

**Decisions** — Operator, 2026-09-22, on the research doc's decision points:
- **5 = C: accept the gap.** Step 1 does NOT take over Ben's office/nudge traffic; once s5's container is retired, his planner questions, office notes and pushes fail on Render until step 3 builds the readers. Rejected: A (glue drains s5's queues now — my recommendation) and B (keep the container alive for delivery; office notes would land in a conversation the new engine never sees). Operator: "We can always fix it in step 3… build it quick, then focus on testing." Then 2, 3, 4 in overlap.
- **6 = cost to a log file on the box.** The glue reads each call's served model + price from OpenRouter's generation record and appends a line keyed by generation id. No Render route, no ledger rows in step 1. Hole: /admin shows no seat cost; a later import is idempotent via source_ref = generation id.
- **7 = session state in files on the box.** Engine's own session files under baseDirectory + one small chat→session-id file in the glue; one ongoing conversation per seat, SDK compaction, a `/new` command. Hole: Render knows nothing of sessions (backup is step 5).
- **8 = the glue signs identity itself** with GATEWAY_IDENTITY_SECRET (already on the host for the doorman), stamping s5's tenantId + technicianRef on the MCP headers — no badge, no doorman in step 1's path, no badge-pull change. Rejected: rotate a fresh badge to the glue (changes a script step 4 deletes), copy the live badge out of s5's container (hand-handling a live credential). Deactivation still bites via the roster check in dispatch (server.ts:610-613). The plan must run this past the data-security skill.

**Assumptions** — That the engine keeps MCP headers in its own process, out of the model's reach (mode "empty": no shell/file tools) — true by the SDK's design, not tested for header leakage.

**Open** — Decisions 1-4 and 9-13 not yet walked; the "$0.02 residual" comparison still unanswered. Next: /plan.

**Downstream** — Step 3 inherits Ben's broken office path as a known hole. Step 4 replaces 8's signing with per-seat tokens.

## Handoff 2026-09-22T20:12:06.961Z

**Decisions** — Operator, 2026-09-22 (continued):
- **1 = Cowork-like double-texting, NO debounce** ("I don't want the 2 second wait. I want the claude cowork like handling of double texting"). Every text goes to the engine immediately. A text arriving mid-turn: if a TOOL is running → `send({mode:"immediate"})` (folded at the tool boundary); if the model is thinking/writing → `session.abort()` then send ONLY the new text (history keeps text 1, so nothing is re-filed — never abort mid-tool). Plus a Telegram Stop button = abort, history kept. Cowork reference: support.claude.com/en/articles/13345190 ("jump in to course-correct … mid-task"), claude.com/docs/cowork/guide/dispatch.
- **11 = STORE photos and voice.** Voice notes go to Gemini 3.8 Flash as audio (operator: it is multimodal, and technicians "often do voice notes anyways"). The box keeps media TEMPORARILY for 7 days; the future home is Supabase Storage (like phone-call audio). Future: record_field_note records before/after photos as evidence work was done.

**Assumptions / to verify first in /plan** — That the engine forwards AUDIO blobs to the model (types show an `audio` content kind at generated/session-events.d.ts:6313; `modelCapabilities` covers vision only) and that OpenRouter's responses wire accepts Gemini audio input — BOTH UNTESTED. Guard to carry into the plan: a box-local path must NEVER be written into `raw_captures.blob_path` — L1 is permanent and the file dies in 7 days, leaving a dangling pointer forever; `blobPath` stays empty until Storage exists.

## Handoff 2026-09-22T22:44:37.645Z

**Decisions** — Operator, 2026-09-22: **13 = the firm's timezone lives in the glue's settings for step 1**, marked to be retired in step 4, where Render sends the timezone with each seat's details ("Let's have Render send the timezone with each seat's detail built in step 4"). **The $0.02 check = my reading, taken as the default**: the new seat's cost per reply ≤ openclaw's ~$0.02 (openclaw's figure is a residual — the OpenRouter bill minus the spine's itemized calls), measured on SCRIPTED test conversations (no organic users), from decision 6's cost log; the log also exposes silent Muse fallbacks. Remaining defaults accepted for /plan ("Let's plan with these defaults"): 2 read /root/seats/s5.env · 3 plain .mjs in Box_Setup_Stuff tested from src like the doorman · 4 keep @preset/trades-seats · 9 Ben's Telegram id in the glue config · 10 port AGENTS.md blocks, rename tools spine-*, drop openclaw-only blocks · 12 each non-empty assistant message = its own Telegram text.

## Handoff 2026-09-23T00:19:03.316Z

**What changed** — Phases 1 and 2 of thoughts/shared/plans/2026-09-22-step-1-technician-seat-on-the-copilot-sdk.md are built and committed (7f277e5, ce1161a): src/seatGlue/ (config, identity, telegram, inbound, turnPolicy, media, costLog, costReport, voice, state, doctrine, engine, seat, main, drive) + Box_Setup_Stuff/seat-glue/ (package.json pinning @github/copilot-sdk 1.0.14, lock with linux-x64, stage.sh). 3518 tests pass. Phase 3 (box install, cut-over, phone test) NOT started. The worktree .env was copied from main (git-ignored) for the key-gated/live runs. A local spine server may still be running from this session (port 8765, local DB, throwaway secret local-e2e-secret) — kill it if found.

**Decisions** — (mine, recorded in the plan/code) code lives in src/seatGlue as TypeScript, compiled and staged (tsconfig/vitest only see src; the SDK stays out of the root package.json so Render builds do not fetch the engine); voice is transcribed by Gemini on /chat/completions before the seat sees it (OpenRouter documents audio only there); the doctrine is GENERATED verbatim from bootstrap-box.sh heredocs with a drift test, plus DOCTRINE_UPDATES for the desk→office merge wording; a model call's text is sent only if that call asked for no tool (narration fix); Stop and /new wait for an in-flight tool INSIDE the update loop, except ask_team_lead (ABORT_SAFE_TOOLS); MCP timeout 300 s (office merge). Six review rounds shaped the turn policy (busy from our send; tool pending from our permission handler; an abort's idle belongs to the abort; stale-idle count; cancelAbort on timeout/failure).

**Assumptions** — that the SDK's abort closes the MCP HTTP request and Render passes the close through (needed for Stop to hang up the office) — untested, joint live check with the office-merge task after both land. That session.error can end a loop with no idle (the SDK's sendAndWait treats it as terminal) — a 5 s timer covers it.

**Open (operator)** — (1) WRONG ARRIVAL TIME: get_schedule sends visit times as fake-UTC ("2026-09-23T16:00:00+00:00", src/routes/daySource.ts:92; storage is naive-local per src/schedule/booking.ts:10); with the engine now stamping firm-local time the model converted a 4:00 PM visit to 9:00 AM. Options: fix the tool's output (robust; Render deploy; all seats) or a doctrine line (quick; model-dependent). (2) The $0.02 check is MIXED: 16 replies avg $0.013 pass; 3-reply cold-cache run avg $0.028 fail; aborted calls are unlogged (~30% gap on an abort-heavy run). Also measured: multi-tool turns take ~40 s (5 model calls × ~8 s); prompt ~16K tokens/call. Next: operator rulings, then Phase 3.

**Downstream** — Worth promoting at close: (a) Gemini 3.8 Flash via OpenRouter + the SDK ignores reasoningSummary:'none' and writes thought summaries ("**Title** I am …") as assistant.message text before every tool call — the per-call hold in seat.ts is the only defence; (b) the permission request's serverName is the mcpServers config key ("spine"); (c) the fake-UTC schedule times mislead any engine that knows the local time. The office-merge task (20260922-merge-the-desk-into-the-office-one-agent) coordinated 5 items with this one; both touch docs/engineering-memory.md and the generated thoughts index (regenerate after merging).

## Handoff 2026-09-23T00:44:59.218Z

**Decisions** — Operator, 2026-09-22: (1) wrong arrival time → OPTION A: fix the schedule tool's output so visit times carry no misleading UTC label (robust, all seats, needs a Render deploy), NOT a doctrine line. (2) The $0.02 check → PASS for step 1 (16 replies avg $0.013; the cold-cache $0.028 short run is a known figure); trimming the ~30K-char doctrine is separate work.

## Handoff 2026-09-23T02:51:49.228Z

**What changed** — All three phases' code is committed and PR #276 is OPEN (branch pushed; main had not moved, nothing to integrate). Beyond the plan: the wall-clock time fix (e89fcfb: get_schedule startTime, retract_capture scheduledAt via naiveWallClock), Telegram HTML formatting with a plain fallback, offset saved before handling (at-most-once), and the box-script review fixes (no token on sudo's command line; cut-over disables the revive unit first; rollback validates before letting go; install builds in /opt/seat-glue.next and swaps after the selfcheck). 3530 tests pass.

**Open** — The operator merges #276 and deploys the web service; then box install (`stage.sh` → copy → `install.sh s5` with SEAT_TENANT_ID=82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18 SEAT_TECHNICIAN_REF=ben-shelton SEAT_TELEGRAM_USER_ID=5801703167 SEAT_TZ=America/Los_Angeles, read from the pilot 2026-09-22; ben-shelton is now ACTIVE and bound to Telegram 5801703167, which the dated seat table lists as the owner's id) → `cutover.sh s5` → phone test. Phase 3 live + manual checks unticked until then. Then promote (worth it: the narration trap, the container-revival trap, the '+00' wall-clock trap, serverName = config key). Left as known: three copies of the wall-clock helper (tidy later); a late non-aborted idle after the session.error timer can free a later reply (rare; the fix would risk a stuck-busy seat).

## Handoff 2026-09-23T03:47:26.397Z

**What changed** — Step 1 is DONE and live on the pilot. seat-glue@s5 has answered Ben's bot (@ragisan03_bot, bound to the operator's Telegram 5801703167) since 2026-09-23 03:00 UTC on trades-box-1; the openclaw s5 container is stopped with a dead token and its revive unit disabled. Shipped in PR #276 (the glue, the box scripts, the wall-clock time fix — web service deployed at d143176) and PR #277 (the Stop control became a "Working… ⏹ Stop" line that exists only while the seat works; install.sh selfcheck from /). Live on the phone: schedule, voice (transcribed word for word), photo (label read), a photo-then-question double text (one reply), no narration reaching the phone, four Stop taps → four "Stopped.", /new → a fresh conversation. Render stamped every spine call as ben-shelton — the glue's own identity signing works on the real network.

**Decisions** — Operator rulings this task: decisions 1–13 (earlier handoffs); gap C for office traffic; cost to a box file; sessions on the box; the glue signs identity; photos AND voice stored 7 days; timezone in the glue's env until step 4; the $0.02 check a PASS; wall-clock fix in the tool output (option A); a Stop button only while working (option A). Mine: code in src/seatGlue as compiled TS with the SDK outside the root package; voice transcribed before the engine; doctrine generated from bootstrap blocks with a drift test and DOCTRINE_UPDATES; hold every model call's text that ends in a tool request; offset saved before handling (at-most-once, for L1's sake).

**Assumptions** — Not seen live yet: a reply AFTER a Stop, and the first reply in the fresh conversation (s5-1790135009829 has no messages). Steer mid-tool and Stop mid-tool are unit-tested only (local and live tools finish in ~1 s).

**Open** — (1) Trimming the ~15K-token prompt (doctrine ~30K chars + 17 tool schemas) is the real cost lever: live $0.0225/reply, ~$0.012 per cold-cache call vs ~$0.005 warm; the operator ruled it separate work. (2) Three copies of the wall-clock helper (naiveWallClock / context.ts / booking.ts wallClock) — tidy. (3) A late non-aborted idle after the session.error timer can free a later reply (rare; left on purpose). (4) The joint live check with the office merge: does the SDK's abort actually close the ask_team_lead HTTP request through Render? (5) The box's `/tmp/seat-glue-stage` holds s5.args + install-s5.sh (no secrets) — harmless, removable. Next build task: 2, 3, 4 in overlap (memory openclaw-retirement-plan).

**Downstream** — Step 3 inherits Ben's broken office path (runners exec into the stopped container; items fail on Render). Step 4 replaces the glue's identity signing with per-seat tokens and must carry each seat's timezone. openclaw seats still get the old get_schedule tool description until their gateways restart. The office-merge task coordinated five items (300 s MCP timeout, three doctrine updates incl. its later ask_team_lead sentence, the ask_team_lead Stop exception; toolName arrives as "spine-<tool>").

**Promotion call: YES.** Four lessons a future session would otherwise relearn the hard way: (a) Gemini via OpenRouter + the Copilot SDK narrates every tool call as message text and reasoningSummary:'none' does not stop it — the per-call hold is the only defence; (b) stopping a sandbox is not retiring it (gateway-heal + the token medic revive containers; the agent returns only via its revive unit); (c) naive-local times must reach a model as wall clock — the '+00' told a technician 9 AM for a 4 PM visit; (d) box install traps: the selfcheck's cwd (operator's 0750 home) and Telegram reply keyboards persisting until remove_keyboard.
