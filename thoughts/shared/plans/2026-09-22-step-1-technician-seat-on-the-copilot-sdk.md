---
date: 2026-09-22
task: Step 1 — Ben's technician seat (s5) moves from its openclaw sandbox to one Copilot SDK engine plus our glue on trades-box-1
research: thoughts/shared/research/2026-09-22-step-1-technician-seat-glue-on-the-copilot-sdk.md
status: draft
supersedes: nothing
---

## Overview
Build "the glue": a small Node program on trades-box-1 that polls s5's Telegram bot, keeps Ben's
conversation in one `@github/copilot-sdk` 1.0.14 engine (`mode:"empty"`, Gemini via OpenRouter
BYOK), lets the engine call the 17 spine tools on Render with Ben's signed identity, handles photos
and voice notes, logs the real cost of every model call, and takes over from s5's openclaw sandbox.
Quick version first (operator: "build it quick, then focus on testing"); every hole is named below.

## Decisions
Operator rulings, 2026-09-22 (the work-record handoffs hold the full wording):
- **Double texts are handled Cowork-style, with no wait.** Every text goes to the engine at once. If a text arrives
  while a TOOL runs → `send({mode:"immediate"})` (folded in when the tool finishes). If it arrives while
  the model thinks or writes → `abort()` then send ONLY the new text (history keeps the first, so a
  note is never filed twice; never abort mid-tool). A persistent **Stop** button = abort, history kept.
- **Office traffic stays broken until step 3 (hole, accepted — option C).** Ben's planner questions,
  office notes and pushes fail on Render once s5's sandbox is gone.
- **Cost goes to a log file on the box.** One JSON line per model call, read from OpenRouter's generation record
  by `apiCallId`, never from `assistant.usage`. Hole: no `cost_events` rows; a later import is
  idempotent on `source_ref` = generation id.
- **Conversations live in files on the box.** The engine's own files plus a tiny state file; one ongoing
  conversation, SDK compaction, `/new` starts fresh. Hole: Render knows nothing of sessions.
- **The glue signs identity itself** with `GATEWAY_IDENTITY_SECRET`, producing the doorman's exact
  headers (`src/mcp/identity.ts:41-63`). No badge, no doorman. Data-security §2 check:
  - The secret stays in the host-side glue process, as it does for the doorman.
  - The engine holds only Ben's signed header, which is as powerful as his badge, not act-as-anyone. The model can't read it: the engine has no shell or file tools.
  - Deactivation still bites, because every call checks the roster (`src/mcp/server.ts:610-613`).
  - Step 4 replaces this.
- **Photos AND voice are stored** in the box's state dir for 7 days (future home: Supabase Storage;
  future before/after evidence on `record_field_note`). **Guard: no box path ever reaches the model
  or `raw_captures.blob_path`.** L1 is permanent, and the file dies in 7 days.
- **The firm's timezone comes from the glue's settings** (`SEAT_TZ`). Retire this when step 4 has Render send it with the seat's details.
- **The $0.02 check:** average cost per reply on scripted test conversations ≤ $0.02 (openclaw's
  figure, a residual of the OpenRouter bill). There are no organic users, so every gate is a test someone runs.
- **Other rulings:**
  - Keep `@preset/trades-seats`. Hole: its Muse fallback is sticky and silent; the cost log shows it.
  - Ben's Telegram id is the allowlist, in config.
  - Each non-empty assistant message becomes its own Telegram text.
  - The bot token comes from `/root/seats/s5.env`.

Implementation choices (mine; flip at review):
- **CHANGED DEFAULT, code lives in `src/seatGlue/` as TypeScript, not `.mjs` in `Box_Setup_Stuff/`.**
  - `tsconfig.json` and `vitest.config.ts` see only `src/`. A `.mjs` import from a `.test.ts` fails the type-check (TS7016), and the doorman's spawn-only test style can't unit-test a state machine.
  - What ships is still plain JS: the compiled `dist/seatGlue/`, which must import no other `src/` module (a test enforces this).
  - The box package (`package.json` pinning the SDK, lockfile, install script, unit file) lives in `Box_Setup_Stuff/seat-glue/`.
  - The SDK is NOT added to the root `package.json`. Render would download the engine binary on every build.
  - `engine.ts` loads the SDK with a non-literal `import(specifier)` and types it with local interfaces.
- **Voice is transcribed before the engine sees it.** OpenRouter documents audio input only on `/chat/completions` with `input_audio` (openrouter.ai/docs/guides/overview/multimodal/audio.md; formats include `ogg`, `wav`). Step 0 requires the engine on the *responses* wire, where audio is undocumented.
  - So the glue sends the voice note to `google/gemini-3.8-flash` directly, then gives the seat `[voice note] <transcript>`.
  - That call is logged in the cost log too.
- **Photos go to the engine** as `{type:"blob", data, mimeType}` attachments with `modelCapabilities.supports.vision = true`. If the live check shows the image is dropped, use the same pattern as voice: a direct describe-the-photo call.
- **`systemMessage: {mode:"replace"}` with our doctrine.**
  - The SDK's default prompt is a coding agent's.
  - Its "guardrails" cover file and shell actions this session doesn't have.
  - The permission handler approves only `kind:"mcp"` on server `spine`, and rejects everything else.
- **The doctrine is ported from `Box_Setup_Stuff/bootstrap-box.sh` heredoc bodies.**
  - Keep: 675-694, 710-753, 766-894, 907-914, 993-1002, 1035-1074, 1162-1207, 1225-1305.
  - Drop the openclaw-only blocks: bulk tasks (928-978) and cron (1101-1126).
  - Rule 5 at 1057-1060 (the UTC conversation-info trap) is replaced by: "the date stamp on each message is the firm's local time; still resolve every date with resolve_date".
  - Add two lines: tools appear as `spine-<name>`; never set `blobPath`.
  - Hole: two copies of the doctrine while other seats stay on openclaw.
- **Cut-over removes s5's bot token instead of just stopping the container.** Two box jobs restart stopped containers by themselves: `gateway-heal.sh:52-60` starts every exited `openshell-` container, and `sandbox-token-medic.mjs:91-96` runs `docker restart` on renewal. A revived openclaw would poll Ben's bot alongside the glue, and Telegram allows one poller per bot. The glue exits loudly on a 409 so this shows in the journal.
- **Stop waits for an in-flight tool** (Phase 1 review, round 3): a Stop while a spine tool is pending aborts only once that tool completes, so a note is never filed while the model believes it was interrupted — the same rule double texts follow.
- **Known hole: stale-idle accounting is a count, not a match.** The SDK's `session.idle` carries only `aborted?`, nothing tying it to the loop it ended, so a dying loop's idle arriving later than a whole new reply, or an engine-initiated abort while one of ours is owed, can misroute one double text. Worst case is a second reply, never a duplicate note (tools still gate aborts).
- **What code decides:**
  - Guards: the allowlist, the permission handler, the path guard.
  - Plumbing: the turn policy, Stop/`/new`, transcription, retention, cost fetch.
  - Everything the seat says or files is the model's.

## Plain-language walkthrough
**Phase 1** builds and tests the parts that don't need AI (reading Telegram and letting only Ben through, the "fold it in or stop and resend" rule, storing media and deleting it after a week, the cost log, signing Ben's identity, voice transcription), all checked with fast automated tests using fakes.

**Phase 2** plugs in the real engine and runs a whole seat on the laptop against the local database and real Gemini, with a script playing Ben:
- the conversations: schedule and customer questions, filing a note, double texts, Stop, a photo, a voice note, a restart;
- the $0.02 cost check.

**Phase 3** installs it on the box, swaps s5's old bot token inside its container for a dead one, starts the glue, and you test from Ben's phone.

```
Ben's phone ──Telegram──► glue (box) ──JSON-RPC──► Copilot engine ──► OpenRouter (Gemini)
                            │  ▲                        │ spine-* tools, signed headers
   photos/voice ─► /var/lib/seat-glue/media (7 days)    ▼
   cost lines   ─► /var/lib/seat-glue/costs/*.jsonl   Render MCP ──► pilot DB
```

## Secrets & env preflight
- **Phase 1:** none (fakes only).
- **Phase 2:**
  - `OPENROUTER_API_KEY` in the worktree's `.env`. Already required; copy it from the main checkout's `.env`. The worktree has none today.
  - The local stack from `.env.test`: `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. Already present.
  - `GATEWAY_IDENTITY_SECRET`: any local test value, set for both the local server and the driver.
- **Phase 3:**
  - On the box, no new secret is minted. `install.sh` builds `/etc/seat-glue/s5.env` (root, 0600) from files already there, never printing a value: `TELEGRAM_BOT_TOKEN` ← `/root/seats/s5.env`; `GATEWAY_IDENTITY_SECRET` and `SPINE_MCP_URL` (= `MCP_UPSTREAM_URL`) ← `/etc/doorman/doorman.env`; `OPENROUTER_API_KEY` ← `/etc/nemoclaw/openrouter.env`.
  - Non-secret arguments: `SEAT_TENANT_ID`, `SEAT_TECHNICIAN_REF`, `SEAT_TELEGRAM_USER_ID` and `SEAT_TZ`. Read them read-only from the pilot with a supabase-test MCP SELECT: `technicians` where `sandbox_ref='s5'`, joined to `tenants.timezone`.
  - Running `sudo` on the box is the operator's job (memory: check sessions before sudo). The implementer prepares the commands for the operator to run with `!`.

## Phase 1: the glue's parts, tested with fakes

### What this phase does
Pure modules in `src/seatGlue/` with unit tests. No SDK, no network; `fetch` is injected.

### Changes required
**`src/seatGlue/config.ts`**
- `loadConfig(env): SeatConfig` takes: `TELEGRAM_BOT_TOKEN`, `SEAT_REF`, `SEAT_TENANT_ID`, `SEAT_TECHNICIAN_REF`, `SEAT_TELEGRAM_USER_ID`, `SEAT_TZ`, `GATEWAY_IDENTITY_SECRET`, `SPINE_MCP_URL`, `OPENROUTER_API_KEY`, `SEAT_MODEL` (default `@preset/trades-seats`), `SEAT_STATE_DIR` (default `/var/lib/seat-glue`), `MEDIA_RETENTION_DAYS` (default 7), `COST_CHECK_USD` (default 0.02).
- It throws on any missing value, so a missing key fails closed.
- `SEAT_TZ` must be a valid IANA zone (`Intl.DateTimeFormat` round-trip).

**`src/seatGlue/identity.ts`**
- `signedHeaders(secret, tenantId, ref)` returns `{'x-tenant-id','x-technician-ref','x-identity-signature'}`, the same HMAC as `doorman.mjs:33`.

**`src/seatGlue/telegram.ts`**
- `TelegramClient(token, fetchImpl)`: `getUpdates(offset)` (`timeout:30`, `allowed_updates:["message"]`; HTTP 409 throws `TelegramConflictError`); `typing(chatId)`; `download(fileId)` (`getFile` then fetch; rejects over 20 MB).
- `send(chatId, text)`: plain text (no `parse_mode`), split at 4096 characters, carrying a persistent reply keyboard `{keyboard:[[{text:"Stop"}]], is_persistent:true, resize_keyboard:true}` (core.telegram.org/bots/api).

**`src/seatGlue/inbound.ts`**
- `classify(update, allowedUserId)` → `{kind:"text"|"photo"|"voice"|"stop"|"new"|"unsupported"}`, or `{kind:"ignored"}` for anyone but Ben or any non-private chat.
- Photo: the largest size plus its caption. Voice: `file_id` and `mime_type` (default `audio/ogg`). `stop` = the text `Stop` (trimmed, any case); `new` = `/new`.

**`src/seatGlue/turnPolicy.ts`**
- A state machine with `route(): "send"|"steer"|"abort-then-send"`: idle → send; busy with a tool pending → steer; busy with no tool pending → abort-then-send.
- **Busy starts when the glue calls `send`** (`onSend`, synchronous), NOT at `assistant.turn_start`, which fires once per loop iteration (`session-events.d.ts:4099-4125`). A text arriving between `send` and the first model call is a double text too. Busy ends only on `session.idle`.
- **A tool is pending from the glue's own `onPermissionRequest`** (`onToolPending(toolCallId)`, runs before every MCP call) until `tool.execution_complete`. So an abort can never land between the model's tool decision and the call going out, which would file a note twice.
- Abort-then-send awaits the `session.idle` whose `data.aborted === true` before sending, so the aborted loop's late idle can't mark the new turn idle.
- It keeps the `replyId` of the reply in progress: new at idle→busy, kept across steer and abort.

**`src/seatGlue/media.ts`**
- `saveMedia(stateDir, buf, ext)` writes to `<stateDir>/media/<YYYY-MM-DD>/<uuid>.<ext>`, with the file 0600 and the directory 0700.
- `sweepMedia(stateDir, days, now)` deletes files whose mtime is older than `days`.

**`src/seatGlue/costLog.ts`**
- `recordCall({generationId, replyId, sessionId, kind:"seat"|"transcribe"}, deps)` fetches `GET https://openrouter.ai/api/v1/generation?id=` with `Bearer OPENROUTER_API_KEY`.
- It retries on 404 or network errors with delays 2, 5, 10, 30, 60 s, then appends one line to `<stateDir>/costs/<YYYY-MM>.jsonl`: `{ts, seat, tenantId, technicianRef, sessionId, replyId, kind, generationId, model, provider, totalCost, tokensPrompt, tokensCompletion, cached, reasoning}`.
- If every retry fails, the line is written with `status:"unresolved"` and the id, so it can be imported later.
- Deduplicated by generation id (the same id is never logged twice). Fed from BOTH `assistant.usage.apiCallId` and `model.call_failure.apiCallId`: aborted and failed calls are billed too, and whether an aborted call emits `assistant.usage` is undocumented.

**`src/seatGlue/costReport.ts`**
- `summarize(lines, thresholdUsd)` returns `{replies, avgPerReply, maxPerReply, fallbackCalls, pass}`. A fallback is any served `model` not starting with `google/gemini`.
- A CLI prints the summary.

**`src/seatGlue/voice.ts`**
- `transcribe(buf, mime, deps)` POSTs `/api/v1/chat/completions` (model `google/gemini-3.8-flash`, `input_audio` with format `ogg` or `wav` from the mime type, instruction "Transcribe exactly; no commentary") and returns `{text, generationId: body.id}`.

**`src/seatGlue/state.ts`**
- `readState` / `writeState` on `<stateDir>/state.json` = `{sessionId, offset}`, written atomically (temp file plus rename).

**Tests**
- One `src/seatGlue/*.test.ts` per module. Identity: headers verify through `resolveIdentityFromHeaders` (tests may import `../mcp/identity.js`). Turn policy: no abort while any tool is pending (from permission to completion); a second text before the first model call is not a plain send; a late `aborted` idle doesn't free the new turn; replyId kept across steer and abort.
- Media retention via `utimes`. Cost: retry then success; retries exhausted → unresolved. Telegram: 409 → conflict error; a 9,000-character message splits into three; the keyboard on every send.
- `selfContained.test.ts` reads every non-test `src/seatGlue/*.ts` and allows only `node:*`, `./*` and the SDK specifier (the box's `package.json` holds nothing else).

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, and `npm test` all pass; all new `src/seatGlue` tests pass.

### Live verification (agent-executable)
None; phase 2 covers it. **Manual verification:** none.

---
*No pause: continue to phase 2.*

## Phase 2: the engine, the seat loop, and a full local run

### What this phase does
Wires the real engine, adds the doctrine and the seat loop, and proves a whole seat end to end on the laptop.

### Changes required
**`src/seatGlue/doctrine.ts`**
- `export const TECHNICIAN_DOCTRINE` holds the ported blocks listed in Decisions, with the two added lines.

**`src/seatGlue/engine.ts`** (the only file that loads the SDK)
- `startEngine(cfg)` creates the client:
  ```ts
  const sdk = await import(SDK_SPECIFIER /* '@github/copilot-sdk', non-literal */) as SdkModule;
  const client = new sdk.CopilotClient({ mode: 'empty', baseDirectory: `${cfg.stateDir}/engine`,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', TZ: cfg.tz },
    logLevel: 'warning' });  // explicit allowlist: no secret reaches the engine's env
  ```
- `sessionConfig(cfg, policy)` is used for BOTH `createSession` and `resumeSession` (resume must re-supply everything):
  ```ts
  { model: cfg.model, provider: { type: 'openai', baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: cfg.openrouterKey, wireApi: 'responses', maxPromptTokens: 100_000 },
    modelCapabilities: { supports: { vision: true }, limits: { vision: {
      supported_media_types: ['image/jpeg', 'image/png'] } } },
    largeOutput: { enabled: false },  // spine results are capped at 20k chars; no file tool to read a spill
    systemMessage: { mode: 'replace', content: TECHNICIAN_DOCTRINE },
    availableTools: ['mcp:*'], toolSearch: { enabled: false },
    mcpServers: { spine: { type: 'http', url: cfg.spineUrl, tools: ['*'], timeout: 60_000,
      headers: signedHeaders(cfg.secret, cfg.tenantId, cfg.technicianRef) } },
    onPermissionRequest: (r) => r.kind === 'mcp' && SPINE_NAMES.has(r.serverName)
      ? (policy.onToolPending(r.toolCallId), { kind: 'approve-once' }) : { kind: 'reject' } }
  // SPINE_NAMES = {'spine','trades-spine'}: the types don't say whether serverName is the config
  // key or the server's own name (src/mcp/server.ts:916-919). Log it on the first live call.
  ```
- `maxPromptTokens` gives compaction a trigger; the engine doesn't know `@preset/…` and may guess its window, as it guessed `vision:false`.
- `openSession(cfg, state)`:
  - calls `resumeSession(state.sessionId, …)` when a session id exists, otherwise `createSession({sessionId: `${seat}-${Date.now()}`, …})`;
  - if resume throws, it creates a new session, logs it and saves the state.

**`src/seatGlue/seat.ts`**
- `runSeat(deps)`: the loop. `deps` is `{telegram, engine session, policy, costLog, voice, media, now}`, all injectable.
- Engine events: `assistant.turn_start`, `tool.execution_start`/`tool.execution_complete` and `session.idle` feed the policy; an `assistant.message` with non-empty trimmed `content` goes to `telegram.send`; `assistant.usage` passes its `apiCallId` to `costLog.recordCall` (not awaited); `session.error` is logged and, during a reply, answered with "I couldn't answer that just now. Try again in a minute." (an OpenRouter 429 or the key's monthly cap otherwise leaves Ben with silence).
- Inbound, routed through `policy.route()`: text → the prompt. Photo → download, `saveMedia`, then an attachment blob plus prompt `caption ?? "(photo)"`, with no path in either. Voice → download, `saveMedia`, `transcribe`, prompt `[voice note] …`; on failure reply "I couldn't make out that voice note. Could you type it?".
- Stop → `abort()`, reply "Stopped.". `/new` → disconnect, open a new session, save state, reply "Starting fresh.". Unsupported → "I can read texts, photos and voice notes.". Ignored → drop.
- While busy, a typing action every 4 s. `offset` saved after each update. `TelegramConflictError` → log `ANOTHER POLLER IS USING THIS BOT`, exit 3. `sweepMedia` at start and hourly.

**`src/seatGlue/main.ts`** (entry point): `loadConfig(process.env)` → `startEngine` → `openSession` → `runSeat`. `--selfcheck` skips `loadConfig`: it starts the engine on a temporary `baseDirectory`, pings it, stops it and exits 0 (no seat env needed).

**`src/seatGlue/drive.ts`** (local driver)
- Same `runSeat`, but with a `FakeTelegram` that plays a script file (JSON: `[{text}|{photo:path}|{voice:path}|{waitMs}|{stop}|{new}]`, with the next message's delay controlled; a voice step's `mime_type` comes from the fixture's extension, `.wav` → `audio/wav`) and prints replies. `--state` points at a scratch dir.

**`Box_Setup_Stuff/seat-glue/package.json` + `package-lock.json`**
- `{"type":"module","dependencies":{"@github/copilot-sdk":"1.0.14"}}`, exact pin. Generate the lock with `npm install --package-lock-only`, then confirm it lists `@github/copilot-sdk-linux-x64`.

**`Box_Setup_Stuff/seat-glue/stage.sh <outdir>`**: `npm run build`, then copy the package files, `install.sh`, `cutover.sh`, `rollback.sh` and `seat-glue@.service` to `<outdir>/`, and `dist/seatGlue/*.js` minus `*.test.js` → `<outdir>/app/`.

**`src/seatGlue/seat.test.ts`** (a fake session emits scripted events): a steer during a tool; abort-then-send while generating, sending only the new text; empty trailing messages dropped; two non-empty messages sent as two texts; Stop; `/new` persisting a new id; a photo prompt and attachment containing no `stateDir` path; the voice-failure reply; `session.error` mid-reply → the fallback text; a failed call's id reaches the cost log once; `replyId` carried into cost calls.

### Automated verification
- [x] typecheck, lint and test pass; `seat.test.ts` passes (3518 tests, 2026-09-22).
- [x] `stage.sh /tmp/sg && (cd /tmp/sg && npm ci && node app/main.js --selfcheck)` exits 0 on the laptop (darwin engine).

### Live verification (agent-executable, LOCAL stack only)
Run by a fresh subagent that did not write the code.
- Prerequisites: the local stack is up and `npm run seed:local` has run; `OPENROUTER_API_KEY` is set; `GATEWAY_IDENTITY_SECRET=<test> MCP_HTTP_PORT=<port> node --env-file=.env.test dist/mcp/httpServer.js` (it loads no dotenv itself); the driver runs from the STAGED copy, because the SDK is not in the root `node_modules`: `stage.sh <scratch>/sg && cd <scratch>/sg && npm ci && node app/drive.js …`, as `tech-jane` in the seed tenant with `SPINE_MCP_URL=http://127.0.0.1:<port>/`; record OpenRouter's `GET /api/v1/key` usage before the run; a voice fixture from `say -o /tmp/note.wav --file-format=WAVE --data-format=LEI16@16000 "…"`, and any JPEG.
- Checks:
  - [x] "What's on my schedule tomorrow?" → a reply quoting a `resolve_date`-style weekday date; the cost log gains ≥1 line with `model` starting `google/gemini`.
  - [x] A note ("Finished the Jane Doe fan swap, parts $180") is filed. Read back independently: `psql` on the local stack shows one new `raw_captures` row with `technician_ref='tech-jane'` and `blob_path IS NULL`.
  - [~] A double text during a tool call gives ONE reply (NOT TRIGGERED live: local spine tools finish in ms, so no timed script landed inside one; unit-tested). The mid-answer case PASSED with the abort logged, and no second capture. A double text 1 s into a plain answer gives ONE reply and the log shows an abort. Neither creates a second capture (psql count).
  - [x] Stop mid-answer → "Stopped.", and the next question still sees the history.
  - [x] The photo is described correctly (serial 7Q4-88213 read back; no fallback needed). If not, switch to the describe-call fallback from Decisions and re-run.
  - [x] The voice note is answered from its transcript; the log has a `kind:"transcribe"` line.
  - [x] Kill and restart the driver on the same state dir → "what did I tell you about the fan?" is recalled.
  - [~] **The $0.02 check (MIXED — operator to rule):** 16 replies avg $0.013 PASS; a 3-reply cold-cache run avg $0.028 FAIL; aborted calls are not logged (key usage rose ~30% more than the log on the abort-heavy run). `node app/costReport.js <log>` → `avgPerReply ≤ 0.02`. Report the numbers either way, plus `fallbackCalls`. **Cross-check:** the log's total is within a few cents of the rise in `GET /api/v1/key` usage across the run (the key is shared, so run when nothing else is busy); a bigger gap means calls are being missed.
  - [x] The journal shows the first permission request's `serverName` (= "spine", the config key); record the value in engineering-memory (it decides `SPINE_NAMES`).

**Manual verification:** none.

---
*No pause: continue to phase 3.*

## Phase 3: install on the box, cut s5 over, test from the phone

### What this phase does
Ships the staged package to trades-box-1, installs a systemd unit, moves s5's bot to the glue, and records the change.

### Changes required
**`Box_Setup_Stuff/seat-glue/install.sh`** (run as root; always idempotent)
1. `useradd --system seatglue` if absent; `install -d -o seatglue -m 0700 /var/lib/seat-glue`.
2. Get npm from `node-$(node -v)-linux-x64.tar.xz` (`node -v` already prints the `v`), SHA256-checked against nodejs.org `SHASUMS256.txt`, into `/opt/seat-glue/.tools`. This is step 0's proven path; the box has no npm.
3. Copy `app/` and the package files to `/opt/seat-glue`, then `npm ci --omit=dev`.
4. Write `/etc/seat-glue/s5.env`, root 0600, from the files listed in the preflight plus the four arguments. Values are passed by environment variable, never on the command line.
5. Install `seat-glue@.service` and run `node app/main.js --selfcheck` as `seatglue` (it needs no env file, which is root-only).

**`Box_Setup_Stuff/seat-glue/seat-glue@.service`**
- `User=seatglue`, `EnvironmentFile=/etc/seat-glue/%i.env`, `Environment=SEAT_REF=%i HOME=/var/lib/seat-glue`
- `StateDirectory=seat-glue` (mode 0700), `ExecStart=/usr/local/bin/node /opt/seat-glue/app/main.js`
- `WorkingDirectory=/var/lib/seat-glue`, `PrivateTmp=true` (`ProtectSystem=strict` otherwise leaves no writable `/tmp` for the engine)
- `Restart=always`, `RestartSec=10`, `RestartPreventExitStatus=3` (a second poller must stop the glue, not start a 10 s fight), `ProtectSystem=strict`, `ProtectHome=true`, `ReadWritePaths=/var/lib/seat-glue`, `NoNewPrivileges=true`

**`Box_Setup_Stuff/seat-glue/cutover.sh s5` / `rollback.sh s5`** (run by the operator with `!`)
- **Cut-over:**
  1. Check the provider's credential key names without values (expected `TELEGRAM_BOT_TOKEN`).
  2. `systemctl disable --now nemoclaw-agent-s5.service` (a restarted container only relaunches its agent through this unit).
  3. A dead token via the bare-KEY form (`--credential TELEGRAM_BOT_TOKEN`, value in the environment, per docs/inference-recovery-runbook.md) so no value reaches sudo's log or `ps`.
  4. `docker stop` the container, then `systemctl enable --now seat-glue@s5`. (Phase 3 review: a sandbox never exposes a credential's value, so the old "check the token by hash" step could only ever pass — removed; the glue polling without a 409 is the proof.)
- **Rollback:** stop the glue, put the real token back from `/root/seats/s5.env` the same way, restart the container, re-enable the revive unit.

**Docs**
- `docs/engineering-memory.md` §2 gains an entry, "Step 1 built: s5 on seat-glue": the cut-over and rollback; the trap (stopping a container is not retiring it — heal and the token medic revive it, so remove the token); the holes listed in Decisions; the $0.02 result.
- `docs/nemoclaw-tech-agent.md` gets a short banner at the top: s5 no longer runs here; see `Box_Setup_Stuff/seat-glue/` (memory: agent-stack changes update both).

### Automated verification
- [ ] typecheck, lint and test pass; `bash -n` passes on all three scripts.

### Live verification (agent-executable)
- Prerequisites: `ssh tradesbox`; the operator runs `install.sh` and `cutover.sh` with `!`; a supabase-test MCP SELECT for the arguments.
- [ ] `journalctl -u seat-glue@s5` shows polling started and no 409. `docker ps` shows s5's container stopped.
- [ ] After the operator's first phone turn, the journal shows a spine call. Read back independently: a pilot `cost_events` SELECT shows a new `spine/tool_call` row for Ben's `technician_ref` in the last 10 minutes.
- [ ] A cost line exists in `/var/lib/seat-glue/s5/costs/` (the unit's per-seat state dir).

### Manual verification (operator, on Ben's Telegram)
- [ ] A text, a double text, a photo, a voice note, Stop, and `/new` all behave as in phase 2.
- [ ] The reply voice is readable, and the reply keyboard shows "Stop".
- [ ] One field note is filed, and you're comfortable that it's permanent in the pilot's L1.
