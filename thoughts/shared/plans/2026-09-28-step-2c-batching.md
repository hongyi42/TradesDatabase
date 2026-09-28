---
date: 2026-09-28
task: Step 2c — batching for a manager seat's big jobs: the model recognises a job too big for one pass and follows a checklist procedure (the Claude Code documented pattern)
research: thoughts/shared/research/2026-09-28-step-2c-batching-spike.md
status: draft
supersedes: nothing (the spike's sub-agent route is set aside for 2c, operator 2026-09-28: "Sub agent is not what I necessarily need")
---

## Overview

Asked to summarise 100 emails, a manager seat today pages through results in one long reply and
leans on the engine's compaction — nothing tells it to split the work, keep track, or finish. 2c
gives it a **batching procedure**: recognise a big job, list the items as references first, keep a
checklist, do one batch at a time with a note per batch, never declare done while batches remain,
and resume after a Stop. The pattern is Claude Code's: its to-do list (created for "three or more
distinct actions", "multiple items", "longer operations"; pending → in_progress → completed, one at
a time — https://code.claude.com/docs/en/agent-sdk/todo-tracking) and Anthropic's long-running
harness (a full item list with done flags, "get bearings" from the progress file, one item at a time,
never declare victory early — https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents),
with notes and references-not-contents from https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents.

## Decisions

Operator, 2026-09-28 ("Go with your recommendations"):
- **1A — structure, not prompt alone:** a glue tool `batch_progress` (a checklist, like Claude
  Code's to-do list) stored as a file in the manager's sandbox, so it survives Stop, /new and compaction.
- **2A — progress on the "Working…" line** ("Working… batch 2 of 10"), fed by the checklist.
- **3A — a short trigger in the rulebook + the full procedure in a `batching` skill**, loaded only when needed.
- **4A — resumable:** "carry on" continues from the next pending batch; an abandoned job is said and cleared.
- **Sub-agents are out of 2c.** The spike's must-fix findings (double dispatch, agentId filtering,
  cost ids, the permission-less `task` call) stay recorded for a later step.

Mine:
- **The checklist is data, the judgment is the model's** (memory: code decides little): the tool
  stores items/batches and their states, answers "what's next", and refuses only what is incoherent
  (a batch number that does not exist; a second batch `in_progress`). It never decides batch size or
  when to batch.
- **One file per job** at `/home/user/files/.batches/<job>.json` (job = `safeName`), so several jobs
  can coexist and "carry on" finds the open ones with `action:list`.
- **Firm-wide email = `export_query` over `v_captures`** into a CSV, read one batch at a time with
  `run_command` + `python3` `csv.reader` — `list_recent_captures` needs a job or customer id. The
  skill says so; nothing new on Render.
- **Progress reaches the Working line through a sink set after the Seat exists** (the tools are built in
  `seatDeps` before the Seat), and only while a reply is running; a failed edit is logged, never fatal.
- **A batch left `in_progress` by a Stop can be begun again** (that IS the resume); only a `done`
  batch is never redone. Calls for one job are queued in arrival order inside the glue (the engine
  makes parallel tool calls; a read-modify-write race would lose a `done`).
- **References, then full text per batch:** the export is the list (ids, date, the From/Subject
  header); each batch prints its emails' BODIES (headers stripped) with `csv.reader` (bodies contain
  line breaks — never slice by line), capped so a batch fits `run_command`'s 9,000-character tail —
  about 10 emails per batch. The source file is fixed at `start` and recorded in the checklist:
  a resume NEVER re-exports (new mail would shift the rows under the labels).
- Review (2026-09-28) folded in: file listing via `ls`; a missing job answers "no such job"; the
  progress text survives question/plan prompts; unchanged text is not re-sent; gate (b) is scored
  on tool RESULTS, not commands.

## Plain-language walkthrough

```
"summarise my last 100 emails"
   │ rulebook: >~20 items → load the batching skill
   ▼
1 list references   export_query → emails.csv (100 rows), exported ONCE
2 checklist         batch_progress start: 10 batches of 10    ── Working… batch 1 of 10
3 per batch         print rows 1–10's bodies → write batches/1.md → done 1 ── Working… batch 2 of 10
   … (a Stop here keeps the checklist; "carry on" resumes at the next batch, same file)
4 finish            read only batches/*.md → one answer → batch_progress clear
```

**Phase 1 — the checklist tool.** A sixth file tool, `batch_progress`, keeps a job's batches and their
state in the sandbox. Tests prove it tracks, refuses nonsense and survives a restart.
**Phase 2 — progress you can see.** The "Working…" line gains the checklist's "batch 2 of 10".
**Phase 3 — knowing when and how.** One rulebook line says when; a `batching` skill says how.
**Phase 4 — the gate.** A hundred realistic emails seeded locally; the seat must cover every batch,
find the urgent ones, and resume after a Stop without redoing work.
**Phase 5 — live on s2**, then your phone.

## Secrets & env preflight

- **All phases:** none new. `E2B_API_KEY`, `OPENROUTER_API_KEY` (already required); the local rig's `.env.test`.

## Phase 1: the `batch_progress` tool

### Changes required

**`src/seatGlue/batchProgress.ts`** (new) — pure state + the tool:
```ts
export interface BatchJob { job: string; title: string; batches: Array<{ n: number; label: string;
  status: 'pending' | 'in_progress' | 'done'; note?: string }>; createdAt: string; updatedAt: string }
export function applyBatchAction(job: BatchJob | null, a: BatchAction, now: string): { job: BatchJob | null; say: string }
```
Actions: `start {job, title, source, batches: string[] (labels, e.g. "rows 1–10 of emails.csv")}`
(refuses if an open job of that name exists — "carry on with it or clear it"; `source` = the file the
batches index, recorded so a resume reuses it); `begin {job, n}` (refused while ANOTHER batch is
`in_progress`; begin on the batch already `in_progress` is allowed — the resume after a Stop; a `done`
batch is refused); `done {job, n, note?}`; `read {job}`; `list {}`; `clear {job}`. A job that does
not exist answers "no such job" (the file read's error caught inside the tool, never `withBox`'s
generic "Error:"). Every answer ends with the
checklist in one line and the NEXT pending batch, or "all N batches done — now combine the notes".
`batchProgressTool(deps: { sandbox; onProgress?(p: {done, total} | null) })` reads/writes
`/home/user/files/.batches/<safeName(job)>.json` through the sandbox (`files.read`/`write`; `list` via
`commands.run('ls -1 /home/user/files/.batches 2>/dev/null')` — `files` has no listing), serialises
calls per job on a promise chain (arrival order), and calls `onProgress` after every change (`null`
after `clear`).

**`src/seatGlue/fileTools.ts`** — `fileTools()` includes `batchProgressTool`; `FILE_TOOL_NAMES`
(`:11`) + `'batch_progress'` (the permission handler's check at `engine.ts:233` then approves it and
marks it pending); `FileToolDeps.onProgress?` passed through.
**`src/seatGlue/doctrine.ts`** — `FILES_SECTION` (`:165`) names `batch_progress` with the other tools.

### Automated verification
- [x] typecheck, lint, `npm test` pass
- [x] `batchProgress.test.ts`: start → begin 1 → done 1 → next is 2; `begin 3` while 2 is
      `in_progress` is refused; `begin 2` again (the resume) is allowed; `begin` on a done batch is
      refused; an unknown batch or job answers in words; `start` on an open job is refused; `list`
      shows open jobs; `clear` removes; all done → "combine the notes"
- [x] `fileTools.test.ts` (the fake gains an `ls -1` branch): the tool persists to
      `.batches/<job>.json` and a NEW tool set (a restart) reads it back; `done 1` and `begin 2` fired
      together both land (the per-job queue); `onProgress` fires with done/total, `null` after clear
- [x] `engine.test.ts`: `batch_progress` is approved and marked pending like the other file tools

---

**Evidence (2026-09-28):** `batchProgress.ts` + tests; full suite green. Two review rounds: a corrupt
or unreadable checklist is never read as "no job" (null only for E2B's `FileNotFoundError` — its name
verified against a live sandbox), so a `start` can never overwrite a half-done job; failed saves and
failed clears are said in words; `list` reads through each job's queue (a test proves it waits for an
in-flight write); labels/title capped, notes cut surrogate-safe. For Phase 2: `onProgress` also fires
on a resumed `begin` with the same counts — the Working line must skip unchanged text.

## Phase 2: progress on the "Working…" line

### Changes required

**`src/seatGlue/telegram.ts`** — `sendWorking(chatId, text?)` (`:138`) takes an optional progress text,
and a new `editWorking(chatId, messageId, text)` (`editMessageText` + `STOP_BUTTON`, `Working… <text>`);
three implementers: `TelegramClient`, `ScriptedTelegram` (`drive.ts:105`, records each progress text in
a `progress` array and prints it) and `FakeTelegram` (`seat.test.ts:81`).
**`src/seatGlue/seat.ts`** — `showProgress(text: string | null)`: remembers `this.progressText`;
edits the live line only if the text CHANGED (Telegram 400s an unchanged edit) and a reply runs
(`this.workingLine`, `:1004-1028`), chained on `this.outbox`; errors logged. `startWorking` passes
`this.progressText` to `sendWorking`, so the text survives a question/plan prompt, which deletes and
re-posts the line (`postPrompt` → `stopWorking`, `:912`; `resumeWorking`, `:926`). A fresh turn
(`:436-439`) and `null` reset it.
**`src/seatGlue/main.ts`** — `seatDeps` (return type `:144`) returns `progress: { attach(fn) }`;
`managerTools` (`:100-118`) passes `onProgress` into `fileTools`; `main()` (before `seat.run()`, `:225`)
and `drive.ts` (before `:192`) attach `(t) => seat.showProgress(t)`. Text: `batch ${done + 1} of
${total}`, `combining the notes` when all done, `null` after clear.

### Automated verification
- [x] typecheck, lint, `npm test` pass
- [x] `telegram.test.ts`: `editWorking` posts `editMessageText` with the Stop button
- [x] `seat.test.ts`: progress edits the Working line in order and skips an unchanged text; after a
      question prompt the re-posted line carries the progress; a new turn starts plain; none after the
      reply ended; a failed edit is logged and the reply carries on

---

**Evidence (2026-09-28):** `sendWorking(chatId, progress?)` + `editWorking` (three implementers),
`Seat.showProgress`, `ProgressSink` wired in `seatDeps` and attached before `run()`. Review: no
correctness bugs; fixed a stale line after a failed edit (the seat now tracks what the line SHOWS and
decides at send time), the fake refuses edits to a deleted line, and tests prove edit-before-delete, a
retry after a failed edit, and a steer keeping the progress. The end-to-end wiring is checked live in
Phase 4 (the driver records every progress text).

## Phase 3: when and how — the rulebook trigger and the `batching` skill

### Changes required

**`src/seatGlue/doctrine.ts`** — `FILES_SECTION` gains one paragraph (no "technician"): *A job over about
20 items, or that needs more than a few pages of results, is done in batches: load the `batching`
skill first and follow it. Smaller jobs stay in one pass.* (`doctrine.test.ts` pins it.)
**`Box_Setup_Stuff/seat-glue/skills/batching/SKILL.md`** (new; `name`, `description`) — the procedure:
1. **Get bearings:** `batch_progress list` — if an open job matches, carry on from its next batch.
2. **List references, then read per batch:** export the items ONCE (`export_query`, e.g. `select id,
   captured_at, raw_text from v_captures where channel = 'email' order by captured_at desc limit 100`
   → `emails.csv`; `v_captures` is `20260917130000_the_sql_views_fold.sql:30`). Never re-export on a
   resume: the checklist's `source` is the file.
3. **Checklist:** `batch_progress start` with `source` and batches sized to fit one read (emails:
   about 10), labelled "rows 1–10 of emails.csv".
4. **Each batch, one at a time:** `begin` → print ONLY that batch's bodies with `python3` and
   `csv.reader` (bodies hold line breaks; strip the From/Subject header lines; cap each body so the
   batch stays under 9,000 characters; `get_capture` when a cut body matters) → write its findings to
   `/home/user/files/batches/<job>/<n>.md` → `done` with a one-line note. Never read the next batch
   before this one is `done`.
5. **Finish:** read only the batch notes, write the answer (a file + `share_file` if it is long),
   then `batch_progress clear`. Never say it is finished while any batch is pending.
6. **Stopped or interrupted:** leave the checklist; tell the manager where it stopped. If they drop
   the job, `clear` it.

### Automated verification
- [x] typecheck, lint, `npm test` pass; `readSkills` lists `batching` and `spreadsheet`
- [x] `doctrine.test.ts` pins the trigger; `engine.test.ts` shows it only with file tools

### Live verification (agent-executable)
- Prerequisites: local rig (seed, `setup-local-seat.mjs`, spine on 8791, seat token),
  `E2B_API_KEY`, `SEAT_SKILLS_DIR` pointing at `Box_Setup_Stuff/seat-glue/skills`.
- [x] Driver: "summarise the last 30 emails" on the seeded rig → the session shows `skill batching`,
      `batch_progress start`, one `begin/done` per batch in order, `clear` at the end

---

**Evidence (2026-09-28, real model + sandbox, 100 seeded emails with no tells):** "Summarise my last 30
emails" → `skill batching` → `batch_progress list` → ONE `export_query` → `start` (3 × 10) → begin →
csv.reader script → note → done, ×3 in order → read only the notes → `clear`. The Working line went
batch 1 of 3 → 2 of 3 → 3 of 3 → combining the notes (the Phase 2 wiring, end to end). The answer named
exactly the 3 urgent emails among the newest 30 (Novak E-074, Xu E-084, Gallagher E-097). The first
`start` hit an E2B stream drop on save; the tool said so in words and the model retried.

## Phase 4: the gate — 100 realistic emails, a Stop and a resume

### Changes required

**`scripts/seat-eval/batching/seed-emails.mjs`** (new, LOCAL ONLY — refuses a non-127.0.0.1
`SUPABASE_URL`, the `setup-local-seat.mjs` guard; imports the built `dist/db/rawCaptures.js`
`appendRawCapture` (`src/db/rawCaptures.ts:63`) and `dist/email/format.js` `formatEmailRawText`
(`src/email/format.ts:13`), channel `email`) — 100 realistic emails with NO tells (surnames and
subjects drawn from one shared pool; no "urgent" subjects); 12 need someone sent, only in the body;
every body carries a unique token (`ref E-042`) so a read can be traced. Prints the 12 names.
**`src/seatGlue/drive.ts`** — a `{ waitProgress: string }` step: wait until `ScriptedTelegram.progress`
holds that text (e.g. "batch 3 of 10"), 10 min cap.
**`scripts/seat-eval/batching/gate.mjs`** (new) — drives the rig and scores from the session file +
the sandbox's `.batches/<job>.json`: (a) every batch `done`, the answer names ≥ 11 of the 12, no `done`
batch begun again; (b) Stop at "batch 3 of 10", then "carry on": in the TOOL RESULTS after the "carry
on" message, no token from batches 1–2 appears, the job finishes, the source was not re-exported.

### Live verification (agent-executable)
- Prerequisites: as Phase 3; a fresh seed each run (`npm run seed:local` + `seed-emails.mjs`).
- [ ] (a) twice: all batches done, ≥ 11/12, no done batch redone; record time and the model calls' cost
      from their OpenRouter generation ids (the glue's cost log)
- [ ] (b) once: Stop mid-job, "carry on" resumes at the next pending batch; checklist state read back
      from `.batches/<job>.json` in the sandbox (cross-channel)
- [ ] Baseline for the record: the same (a) on `origin/main` (no batching) — coverage and context size

---

## Phase 5: live on s2

1. PR → merge (glue only; no web deploy, no migration).
2. Stage → rsync → swap → `install.sh s2` (as for #291).

### Live verification
- [ ] `journalctl -u seat-glue@s2`: polling; the skills folder has `batching`

### Manual verification
- [ ] From Sam's phone: "summarise my last 50 emails — what needs me today?" → the Working line counts
      batches; the answer arrives; a Stop mid-way then "carry on" picks up where it stopped

---
*Pause after Phase 5 (phone check).*
