---
date: 2026-09-28
task: Step 2b — the manager seat gets files: an E2B sandbox per manager, the glue's own file tools, export_query, a spreadsheet skill
research: thoughts/shared/research/2026-09-23-sandbox-vendors-in-depth.md (+ 2026-09-23-step-2-manager-seat-on-the-seat-glue.md)
status: draft
supersedes: nothing (carries out 2a's split; changes #287's "until 2b" to "kept", operator 2026-09-28)
---

## Overview

s2 cannot make a file: asked for a CSV on 2026-09-27 it used Composio's workbench, which put customer
data behind an open link (blocked, #287). 2b gives each manager an E2B sandbox (a small isolated
computer that sleeps when idle, wakes in ~0.5 s), tools the glue defines, and file delivery into
the chat. Invoices are 2c.

## Decisions

Operator, 2026-09-27/28:
- **Vendor: E2B** (`lifecycle:{onTimeout:'pause', autoResume:true}`). Gate test
  `scripts/sandbox-gate/e2b-gate.mjs`: paused mid-job; 5 min later woke in 0.53 s, files identical,
  the frozen job finished (2-hour result: Phase 2 evidence). Vercel dropped for now (account stuck
  on `account/no-team`, a known Vercel sign-up fault).
- **1A — a file reaches the phone as a Telegram document** (`sendDocument`, ≤ 50 MB), never a link.
- **2A — no internet inside the sandbox; libraries pre-built** into our own E2B template
  (`allowInternetAccess:false`), so model-written code has no path out for the firm's data.
- **3A — `export_query` now**: the glue asks Render for a query's full rows and writes them into a
  sandbox file itself, so the model never retypes data (the lossy path seen on 2026-09-27).
- **4A — the skills mechanism plus one "spreadsheet" skill** (SDK `skillDirectories`); the PDF
  invoice skill is 2c.
- **5A — #287's Composio workbench/bash block STAYS**: the workbench still copies firm data onto
  Composio's storage, and our own sandbox now does the job.
- Standing: managers only (technician seats get no file tools); permissions stay loose.

Mine:
- **Custom tools, not the engine's built-ins.** The built-in shell/file tools act on the box; ours
  (SDK `Tool` objects with handlers) call E2B from the glue. The permission handler approves
  `kind:'custom-tool'` for our names only and marks each call pending first (`turnPolicy` rule 2).
  The four short tools wait out a Stop; `run_command` can run for minutes, so it joins
  `ABORT_SAFE_TOOLS` (`turnPolicy.ts:40`) and its handler KILLS the sandbox process when
  `invocation.signal` aborts — a Stop ends it cleanly instead of waiting 90 s (`seat.ts:1047`) and
  then cutting it off. A half-written file stays inside the sandbox only.
- **The E2B SDK loads the way the Copilot SDK does**: a dynamic import behind a local interface, a
  dependency of `Box_Setup_Stuff/seat-glue/package.json` only — `src/seatGlue` stays
  self-contained and the repo does not depend on `e2b`.
- **The sandbox id lives in `<stateDir>/sandbox.json`**, not `state.json` (the Seat owns that file
  and its write chain). The sandbox carries `metadata {seat, tenant, person}` so a lost one can be
  found with `Sandbox.list`. Idle timeout = the tool's own time limit + 5 min (never under 10 min),
  re-armed on every tool call, so a long command never pauses mid-run. Paused = unbilled
  and kept indefinitely (E2B docs), so nothing deletes it in 2b; removal belongs to offboarding.
- **The E2B key is passed explicitly** on every create/connect/setTimeout (the SDK otherwise falls
  back to `process.env`); the engine's env allowlist (`engine.ts:121`) already keeps it out of the engine.
- **Paths are normalised**: every tool resolves with `path.posix.resolve(FILES_DIR, p)` and refuses
  anything outside `/home/user/`; `export_query`'s `filename` is reduced to `[A-Za-z0-9._-]`.
- **A vanished sandbox is said, never hidden**: `connect` failing with not-found creates a new one
  and the tool result tells the model the earlier files are gone.
- **Limits**: `run_command` 120 s default, 600 s max, output cut to the last 20,000 chars;
  `read_file` text only, 20,000 chars; `share_file` ≤ 50 MB and only under `/home/user`;
  `export_query` ≤ 1,000 rows (the spine's own `QUERY_SPINE_MAX_ROWS`), `truncated` reported.
- **No L1 capture of a shared file** (it goes to the manager's own chat, not outside the firm).

## Plain-language walkthrough

```
Manager ─Telegram─► seat glue (box) ─► model
                      │ run_command · read_file · write_file · share_file · export_query
                      ▼
            E2B sandbox "trades-manager" template (Python + openpyxl/reportlab/pandas, no internet)
              /home/user/files   the manager's files, kept while it sleeps
              /home/user/skills  our skill scripts, copied in by the glue
                      │
   export_query ◄── Render POST /seat/export (full rows as CSV, seat token, managers only)
   share_file   ──► glue reads the bytes ─► Telegram sendDocument ─► the manager's phone
```

**Phase 1 — Render hands over full query results**: every row (≤ 1,000) as CSV to a manager's
seat, instead of the 20,000-character slice the model sees. Nothing visible yet.

**Phase 2 — the sandbox and the phone**: open or wake a manager's sandbox from our template, internet
off; Telegram learns to send a file; a one-off script builds the template.

**Phase 3 — the tools**: five tools and a rulebook paragraph; on the local rig "make a spreadsheet of
every open job" goes `export_query` → Python → `share_file`, and a real .xlsx arrives.

**Phase 4 — the spreadsheet skill**: our house style, plus a helper script copied into the sandbox.

**Phase 5 — live on s2.** Web deploy, the E2B key onto the box, reinstall s2, then your phone.

## Secrets & env preflight

- **Phase 1:** none. **Phases 2–4:** `E2B_API_KEY` in the main `.env` — present (checked
  2026-09-27, name only); the rig's `.env.test` + `OPENROUTER_API_KEY` (already required).
- **Phase 5:** `E2B_API_KEY` on the box in a new root-only `/etc/seat-glue/e2b.env` (operator writes
  it; `install.sh` copies it into every seat's env). Optional `E2B_TEMPLATE` (default `trades-manager`).

## Phase 1: `POST /seat/export` on Render

### Changes required

**`src/mcp/httpServer.ts`** — `handleSeatExport(req, res)`, routed next to `/seat/whoami`
(`:1308`): seat token via `seatTokenOf` + `resolveIdentity` exactly as `handleSeatWhoami`
(`:350-398`; `seatOfRequest` at `:419` already does token + person); **403 unless
`isActiveManager(identity)`** — the same predicate `query_spine` uses (`server.ts:633`, `:954`), so an
invited, not-yet-active manager is refused too;
body `{ sql: string }` (≤ 20,000 chars, else 400); `runSpineQuery(identity.tenantId, sql,
{ technicianRef: identity.technicianRef, maxRows: QUERY_SPINE_MAX_ROWS })` (`src/db/querySpine.ts:26`
— audited in `query_audit`, read-only by construction); a query error → 400 `{error}` (the model reads
it and fixes its SQL). 200 `{ csv, columns, rowCount, truncated }`; `csv` built by a new pure
`toCsv(rows)` (header from the first row's keys ∪ later keys, RFC 4180 quoting, JSON for objects,
empty for null).

**`src/mcp/csv.ts`** (new) — `toCsv(rows: unknown[]): { csv: string; columns: string[] }`.
### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass
- [x] `src/mcp/csv.test.ts`: quoting of commas/quotes/newlines, null, nested objects, column union
- [x] `src/mcp/httpServer.test.ts` (seat-token describe): manager → 200 with every row and
      `truncated:false`; technician → 403; an invited (not active) manager → 403; unknown token → 401; bad SQL → 400 with the DB's message;
      a `query_audit` row is written with the manager's ref

---

## Phase 2: the sandbox client, `sendDocument`, the template

### Changes required

**`src/seatGlue/sandbox.ts`** (new) — `class ManagerSandbox`:
- `constructor({ apiKey, template, stateDir, meta: {seat, tenantId, technicianRef}, sdk?, log? })`;
  `sdk` defaults to `import('e2b')` via a string specifier (as `engine.ts:12`); a local
  `E2bModule` interface covers `Sandbox.create/connect`, `commands.run/kill`, `files.read/write/list`,
  `setTimeout`, and `CommandExitError` (`commands.run` THROWS on a non-zero exit, with
  `exitCode/stdout/stderr` — `e2b/dist/index.d.ts:5607`); `SandboxNotFoundError` for not-found.
- `get(): Promise<{ sbx; fresh: boolean }>` — one in-flight open at a time (a shared promise).
  `get(holdMs = IDLE_MS)` reads `sandbox.json`; `connect(id, {apiKey})` then `setTimeout(max(IDLE_MS, holdMs))`; a `NotFoundError` (or
  any "not found" 404) → create; create = `Sandbox.create(template, { timeoutMs: IDLE_MS,
  lifecycle:{onTimeout:'pause', autoResume:true}, allowInternetAccess:false, metadata })`, `mkdir -p
  /home/user/files`, write `sandbox.json` (tmp + rename). `fresh` tells the caller the files are new.
- Exported constants `IDLE_MS`, `FILES_DIR='/home/user/files'`, `SKILLS_DIR='/home/user/skills'`.

**`src/seatGlue/http.ts`** — `HttpInit.body` (`:13`) widens to `string | FormData`.
**`src/seatGlue/telegram.ts`** — `sendDocument(chatId, filename, bytes: Uint8Array, caption?)`
on `TelegramApi` (`:63`) and `TelegramClient`: its OWN request (not `call`, which forces
`content-type: application/json`, `:91-96`) posting multipart `FormData` (`document` as a `Blob`),
no content-type header (fetch sets the boundary), 120 s timeout, the same error mapping. Three
implementers: `TelegramClient`, `ScriptedTelegram` (`drive.ts:39`, records `{filename, bytes}` in
`documents` AND writes each to `--state <dir>/documents/` so a run's files survive the process),
`FakeTelegram` (`seat.test.ts:61`).

**`src/seatGlue/config.ts`** — optional `e2bApiKey` (`E2B_API_KEY`) and `e2bTemplate`
(`E2B_TEMPLATE`, default `'trades-manager'`); absent key = no file tools (a warning at start for a
manager seat, never a crash).

**`Box_Setup_Stuff/seat-glue/package.json`** — add `"e2b": "2.51.0"`; regenerate the lock file.
**`src/seatGlue/turnPolicy.ts`** — `ABORT_SAFE_TOOLS` (`:40`) gains `run_command`.
**`Box_Setup_Stuff/seat-glue/install.sh`** — read `/etc/seat-glue/e2b.env` when present (`val`
helper, `:81-86`) and add `E2B_API_KEY` / `E2B_TEMPLATE` to the env file it writes (`:128-129`).

**`Box_Setup_Stuff/seat-glue/e2b-template.mjs`** (new, run from a laptop with `E2B_API_KEY`) —
`Template().fromPythonImage('3.12').pipInstall(['openpyxl','reportlab','pandas','xlsxwriter'])`,
`Template.build(t, 'trades-manager')`. Re-run to change libraries.

### Automated verification
- [x] typecheck, lint, `npx vitest run src/seatGlue` pass
- [x] `sandbox.test.ts` (fake SDK): first `get` creates with pause/autoResume, internet off, the
      template, metadata, the explicit `apiKey`, and writes `sandbox.json`; `holdMs` above 10 min
      re-arms to it; the second process connects by id and re-arms
      10 min; not-found → a new one with `fresh:true`; two concurrent `get`s open once
- [x] `telegram.test.ts`: `sendDocument` posts multipart with the file name and bytes

### Live verification (agent-executable)
- Prerequisites: `E2B_API_KEY` in `.env`; `npm i --no-save e2b@2.51.0 @github/copilot-sdk@1.0.14`.
- [x] Build the template; a scratch script opens a `ManagerSandbox` and checks, as the default user:
      `python3 -c "import openpyxl, reportlab, pandas"` exits 0; `/home/user/files` is writable;
      `python3 -c "import urllib.request; urllib.request.urlopen('https://pypi.org', timeout=5)"`
      fails with a NETWORK error (URLError/timeout — not "command not found"); `sandbox.json` holds
      the id; a second `ManagerSandbox` in a new process connects to the same id; kill it after.
- [ ] Record the gate test's 2-hour check (state, resume ms, files identical, job finished).

---

**Evidence (2026-09-28):** phase 1 `dafbe23` (review: an outage was a 400 → only a SQLSTATE is; audit
rows cleaned; the export test first proved nothing on an empty firm → it makes its own customers).
Phase 2: template `trades-manager` built in 53 s (templateId f8uluqhamu0bk35be1ge); a real sandbox
from it ran as `user`, imported openpyxl/reportlab/pandas/xlsxwriter, wrote /home/user/files, and
`urlopen('https://pypi.org')` failed with URLError "name resolution" (no internet); a second process
reconnected the same id in 287 ms with the file intact; killed. Review: a quick call's `setTimeout`
would SHORTEN a long command's hold (E2B can reduce it) → the longest hold is remembered.

## Phase 3: the five tools

### Changes required

**`src/seatGlue/fileTools.ts`** (new) — `fileTools(deps: { sandbox: ManagerSandbox; exportRows:
(sql) => Promise<{csv, columns, rowCount, truncated}>; sendDocument: (name, bytes) => Promise<void> })`
returns SDK `Tool` objects (plain objects `{name, description, parameters (JSON schema),
handler}`), all `skipPermission:false`:
- `run_command {command, timeoutSeconds?}` → `sandbox.get(timeout + 5 min)`, then
  `commands.run(cmd, {cwd: FILES_DIR, timeoutMs, background:true})` and wait; `CommandExitError` is
  caught and returned as a RESULT (`exitCode`, stdout, stderr); `invocation.signal` abort →
  `commands.kill(pid)` and "stopped by the manager"; output tail-capped 20,000.
- `read_file {path}` — text only, 20,000 chars; binary → "use share_file to send it".
- `write_file {path, content}` — relative paths resolve under `FILES_DIR`.
- `share_file {path, caption?}` — only under `/home/user`, ≤ 50 MB; reads bytes, `sendDocument`;
  result "Sent <name> (<size>) to the chat."
- `export_query {sql, filename}` — `exportRows(sql)` → `files.write(FILES_DIR/<filename>.csv)`;
  result: path, rowCount, truncated, columns, the first 5 rows — never the whole CSV.
- Every handler: `sandbox.get()`; when `fresh` after a stored id, prefix "Your earlier files are
  gone (the sandbox was replaced)."; errors become a result string, never a crash.

**`src/seatGlue/engine.ts`** — `EngineConfig.tools?: unknown[]`; `sessionConfig` passes `tools`
and, when present, adds `'custom:*'` to the manager `availableTools` (`:167`);
`FILE_TOOL_NAMES`; `onPermissionRequest` (`:177-194`): `kind==='custom-tool' &&
FILE_TOOL_NAMES.has(r.toolName)` → `policy.onToolPending(r.toolCallId, r.toolName)`, approve-once.
`largeOutput` comment (`:159`) updated; stays off.

**`src/seatGlue/main.ts`** — the wiring lives in `seatDeps()`/`engineConfig()` (`:60-79`), NOT in
`main()`, because the local driver builds its seat through `seatDeps` (`drive.ts:175`): for a
manager with `e2bApiKey`, build `ManagerSandbox`, `exportRows` = `POST new URL('/seat/export',
spineUrl)` with `seatHeaders`, `sendDocument` = `telegram.sendDocument(who.telegramUserId, …)`, and
pass `tools` into `engineConfig`. `drive.ts` needs no change beyond `ScriptedTelegram`.

**`src/seatGlue/doctrine.ts`** — `MANAGER_PREAMBLE` gains FILES: you have a computer of your own for
this manager; files live in `/home/user/files` and stay between conversations; get firm data into a
file with `export_query`, never by copying rows; send what they asked for with `share_file`; the
sandbox has no internet. The paragraph must not contain the word "technician"
(`doctrine.test.ts:66`); the test pins the paragraph.

**`src/composio/relayHandler.ts`** — the block's comment: kept after 2b (operator 2026-09-28, 5A);
`BLOCKED_TOOL_TEXT` (`:63-66`) changes from "say that file exports are coming soon" to "make the
file in your own computer with your file tools and send it with share_file"; its test updated.

### Automated verification
- [ ] typecheck, lint, `npm test` pass
- [ ] `fileTools.test.ts` (fake sandbox): each tool's happy path; non-zero exit returned; output
      caps; a `CommandExitError` becomes a result; an aborted `run_command` kills the pid;
      `share_file` refuses `/home/user/../etc/x` and over 50 MB; `export_query` with filename
      `../skills/x` writes `files/skillsx.csv`; it writes the full CSV but returns 5 rows; the
      "earlier files are gone" prefix
- [ ] `engine.test.ts`: a manager with tools → `custom:*` + tools passed; a custom-tool permission
      for a file tool is approved AND marked pending; an unknown custom tool is rejected;
      `seat.test.ts`: a Stop during a pending `run_command` aborts at once (abort-safe), during a
      pending `write_file` it waits; technician
      config unchanged (deep-equal)

### Live verification (agent-executable)
- Prerequisites: local rig (seed, `setup-local-seat.mjs`, local spine on 8791, minted seat token),
  `E2B_API_KEY`, the Phase 2 template, both SDKs `--no-save`.
- [ ] Driver: "make me a spreadsheet of every open job with its customer" → the scripted chat's
      `documents` holds an .xlsx; opened locally with a reader, its row count equals
      `select count(*) from v_jobs where status open` on the local DB (cross-channel); the tool
      sequence in the session file includes `export_query` and no row-by-row `write_file`
- [ ] The custom-tool permission request's `toolCallId` equals `tool.execution_complete`'s (logged
      once, like the MCP serverName) — if not, the pending entry only clears at idle; record which

---

## Phase 4: the spreadsheet skill

### Changes required

**`Box_Setup_Stuff/seat-glue/skills/spreadsheet/SKILL.md`** (new; `name`, `description`
frontmatter) — house style (header row bold + frozen, money as numbers with a currency format,
dates as dates, one table per sheet, a short "Source" note), and "run
`python3 /home/user/skills/spreadsheet/csv_to_xlsx.py <in.csv> <out.xlsx>`".
**`…/skills/spreadsheet/csv_to_xlsx.py`** (new) — openpyxl, the house style.

**`Box_Setup_Stuff/seat-glue/stage.sh`** — copy `skills/` into the package (`$out/skills`).
**`Box_Setup_Stuff/seat-glue/install.sh`** — copy `$here/skills` into `$NEXT/` beside `app/`
(`:66-67` copies only `app/*.js` and the package files; the swap at `:141-144` would drop it).

**`src/seatGlue/engine.ts`** — manager `sessionConfig`: `enableSkills:true`,
`skillDirectories:[cfg.skillsDir]` and `'builtin:skill'` added to `availableTools` (the runtime
reaches a skill through its built-in `skill` tool). `EngineConfig.skillsDir` comes from config:
`SEAT_SKILLS_DIR`, default `<dir of main.js>/../skills` (the box package); the local driver sets
it to `Box_Setup_Stuff/seat-glue/skills`, since `dist/skills` does not exist.

**`src/seatGlue/sandbox.ts`** — after open, sync the skills folder into `SKILLS_DIR` when the
sandbox's `/home/user/skills/.hash` differs from the package's hash (once per process per sandbox).

### Automated verification
- [ ] typecheck, lint, `npm test` pass; `sandbox.test.ts`: sync on hash change only;
      `engine.test.ts`: manager config carries the skill directory, technician does not
- [ ] `python3 csv_to_xlsx.py` on a fixture CSV (laptop, openpyxl) produces a readable file

### Live verification (agent-executable)
- [ ] Driver, same request: the session file shows the `skill` tool loading `spreadsheet` and a
      `run_command` of `csv_to_xlsx.py` (the styling alone is not proof: the model can bold a header
      on its own); the .xlsx has a bold frozen header and numeric money cells (read with openpyxl)

---

## Phase 5: live on s2

1. PR → merge; the operator deploys the web service (it does not auto-deploy).
2. Template built once from the laptop (`e2b-template.mjs`) if Phase 2 did not.
3. Operator writes `/etc/seat-glue/e2b.env` (root, 0600) on the box; `install.sh` (Phase 2) copies it.
4. Stage → rsync → `install.sh s2`. s5 needs no restart (technicians are unaffected).

### Live verification
- [ ] `journalctl -u seat-glue@s2`: no E2B warning; polling; a `sandbox.json` appears after the
      first file request
- [ ] Render `/seat/export` 200 for s2's first export (logs)

### Manual verification
- [ ] From Sam's phone: "make me a spreadsheet of every open job with its balance" → an .xlsx
      document in the chat that opens on the phone and matches the list; the next day, "add a
      column for the phone number" reuses the same file (the sandbox slept and kept it)
---
*Pause after Phase 5 (phone checks).*
