---
date: 2026-09-09
task: The shared work record — one place every session reads and writes (tasks and parked findings), a board of worktrees and sessions, the pre-edit hook made worktree-aware and finding-aware, and the task packet re-injected at session start and after compaction. First of two builds; spawn, the code-graph overlap check and the integrate verb are the second.
research: thoughts/shared/research/2026-09-09-how-context-travels-between-sessions.md
status: draft
supersedes: nothing
---

## Overview

Today the operator is the only shared memory between Claude sessions (research §Summary). This
plan gives the team a record the machine keeps: a folder beside the shared git directory that
every worktree reads the instant it is written, one file per task or parked finding, a board of
every worktree with its branch, age and active task, a pre-edit hook that works inside worktrees
and names open findings on the file being edited, and hooks that snapshot the task before
compaction and hand the packet back at session start. `/park` and `/handoff` are the model-side
verbs. Spawn and symbol overlap are the second plan.

## Decisions

- **Build order (user, 2026-09-09)** — reading half (record, park, board) plus compaction survival
  here; spawn, the code graph and the integrate verb next. The user also requires parked findings
  to be spawnable in parallel after a conflict check: second plan; this plan's hook flags
  exact-file overlap between open tasks as the first approximation.
- **Record location (user: recommendation)** — `<main checkout>/.claude/work/`, found from any
  worktree via `git rev-parse --path-format=absolute --git-common-dir` (relative output from the
  main checkout was a reviewer catch); tracked `.gitignore` entry. Rejected: inside a worktree
  (invisible until commit); `~/.claude/projects/…` (per working directory); agent-team task lists.
- **Findings become a document kind (user: yes)** — live task file now; `promote` writes
  `thoughts/shared/findings/…`; the generator learns kind `finding`. The hook reads the live
  form, so siblings see a finding before it is committed.
- **One active task per worktree (user: every code-editing session has its own)** — resolved from
  the canonical `git rev-parse --show-toplevel` path (a realpath; reviewer catch), never a session id.
- **Compaction is never blocked (user), and `PreCompact` cannot inject context (docs; reviewer
  catch)** — survival is `SessionStart` with matchers `startup|resume|compact`; `PreCompact` only
  snapshots. The research table said otherwise and is corrected with this plan.
- **The main checkout's script is the one that runs** — hooks and commands resolve
  `scripts/work.mjs` through the common git dir; older-branch worktrees have no copy (reviewer catch).
- **Board is a terminal table first (user)**; a pixel-agents feed is deferred.
- **plan-two / integrate-two (user: retire if covered; assistant: partly)** — the verbs cover
  plan-two; integrate-two becomes the `integrate` verb in the second plan. Nothing retired here.
- **No lanes (user)** — free-form `tags`.
- **Self-contained `scripts/work.mjs`** — plain Node ESM, no `dist/` imports (hooks must run in
  unbuilt worktrees); a new eslint block; Vitest end-to-end tests under `src/work/`. Precedent:
  `scripts/decision-index.mjs`.
- **Hook root = the edited file's git top level** (replaces `CLAUDE_PROJECT_DIR || cwd`); output
  moves to the documented `hookSpecificOutput` shape. `Stop` and `PreCompact` snapshots print
  nothing (any `additionalContext` on `Stop` continues the turn).
- **Worktree sessions get a memory pointer, not the file** — `MEMORY.md` is 17,550 chars and hook
  output caps at 10,000 (docs; reviewer catch): packet + path + titles-only trim under 9,000 chars.
- **Task id** — `YYYYMMDD-<slug>` (collision appends `-2`).

## Plain-language walkthrough

```
 any worktree ─► git rev-parse --path-format=absolute --git-common-dir ─► <main>/.claude/work/
                                                    tasks/<id>.md  tasks/<id>.snapshot.json  archive/
 /park ─► work.mjs park ──────────────────────────► tasks/<id>.md (status: open)
 work.mjs claim <id> ─────────────────────────────► status: active, worktree: <this checkout>
 Edit|Write ─► PreToolUse ─► decisions (by-file.json of THIS worktree) + open findings / siblings on the file
            ─► PostToolUse ─► work.mjs touch (adds the file to this worktree's active task)
 Stop, PreCompact ─► snapshot (silent)       SessionStart startup|resume|compact ─► packet (+ memory pointer)
 /handoff ─► "## Handoff" appended;   done ─► promote ─► thoughts/shared/findings/… (indexed)
 npm run board ─► worktrees × branch × behind/ahead × merged? × age × active task × last session; then tasks
```

**Phase 1** builds the record and the command-line tool. You park a finding with a sentence and
a list of files, claim a task for the worktree you are in, and `npm run board` prints every
worktree with its distance behind main, merge state, last session activity and active task.

**Phase 2** fixes the pre-edit hook so it works inside worktrees (it is silent there today) and
teaches it two new lines: "open finding X touches this file" and "the session in worktree Y is
active on task Z and has touched this file". The edit hook also records every file you touch on
your active task, so the packet's file list writes itself.

**Phase 3** is compaction survival. When a session starts, resumes or returns from compaction, the
hook injects the task packet (task, files, decisions, latest handoff); a worktree session also gets
a pointer to the memory index it lacks. Before compaction and at every stop a silent snapshot
records branch, head and changed files. `/handoff` writes what only the model knows.

**Phase 4** closes the loop: `done` then `promote` turns a task into a committed finding document
the decision index and the hook pick up like any research or plan, and CLAUDE.md tells every
future session the record exists.

## Secrets & env preflight

- **Phases 1–4:** none. Tests need the existing `.env.test` (every Vitest file loads
  `src/test.setup.ts`, which asserts the local stack); no new keys.

## Phase 1: the record, the CLI, the board

### What this phase does
Creates `scripts/work.mjs` with `park`, `claim`, `done`, `drop`, `packet`, `board`; the record layout; npm scripts; lint; end-to-end tests.

### Changes required

**`scripts/work.mjs`** (new)
- `mainCheckout(cwd)`: `git -C <cwd> rev-parse --path-format=absolute --git-common-dir`, parent
  directory; record dir `<main>/.claude/work/` with `tasks/` and `archive/`, created on first
  write. `worktreeOf(path)`: `git -C <path> rev-parse --show-toplevel` (canonical); every stored
  or compared `worktree` value goes through it.
- Task file = markdown with `key: value` frontmatter parsed by a copy of the tolerant parser at
  `scripts/decision-index.mjs:54-75`; list values are comma-separated. Fields: `id`, `kind`
  (`task|finding`), `title`, `status` (`open|active|done|dropped`), `tags`, `origin`, `files`,
  `worktree`, `branch`, `base`, `created`, `updated`. Body sections: `## Notes`, `## Decisions`,
  `## Handoff …` (repeats).
- `park --title <t> [--kind finding|task] [--files a,b] [--tags x,y] [--origin <id>] [--body -]`:
  writes `tasks/<id>.md`, status `open`; `origin` defaults to the active task of `cwd`'s
  worktree; prints the id.
- `claim <id> [--force]`: status `active`, `worktree` = `worktreeOf(cwd)`, `branch`, `base` =
  `git merge-base HEAD origin/main`; refuses if another task is active there unless `--force`.
- `done <id>`, `drop <id>`: set status, clear `worktree`.
- `packet [--cwd <path>] [--json]`: the active task for `worktreeOf(path)`; nothing (exit 0) if none.
- `board`: table 1, one row per `git worktree list --porcelain` entry; a `prunable` entry is
  rendered as such and no git command runs inside it. Columns: path, branch, `behind/ahead` vs
  `origin/main` (`git rev-list --left-right --count`), merged (`git merge-base --is-ancestor`,
  plus `gh pr list --state merged --head <branch> --json number` inside try/catch, `?` on any
  failure), last commit age, Claude marker (`.git/worktrees/<name>/CLAUDE_BASE`), active task id,
  last session activity = newest `*.jsonl` mtime under `~/.claude/projects/<encoded>/` where
  `encoded = abs.replace(/[^A-Za-z0-9]/g, '-')` (verified against the existing
  `…--claude-worktrees-multi-tech-assignment` directory). Table 2: tasks by `updated`: id, kind,
  status, title (60 chars), worktree basename, file count, origin.
- Stdin is read only by `touch`, `snapshot`, `packet` without `--cwd` (hook JSON, `cwd` field),
  and by `--body -`; every other verb never touches stdin. Every failure path exits 0 silently.

**`package.json`** — add `"work": "node scripts/work.mjs"` and `"board": "node scripts/work.mjs board"`.

**`.gitignore`** — append `.claude/work/` with a comment (live work record, per clone).

**`eslint.config.js`** — add a block `files: ['scripts/work.mjs']` copying the
`scripts/spine-eval/**/*.mjs` block's `languageOptions` (lines 27–51).

**`src/work/work-cli.test.ts`** (new) — temp dir with `git init`, `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
set in the spawn env (no `user.name` under an overridden `HOME`), one commit, a
`refs/remotes/origin/main` ref, a linked worktree via `git worktree add`; runs the CLI with
`execFileSync('node', [<repo>/scripts/work.mjs, …], { cwd, env: { …process.env, HOME: <tmp>, GIT_* } })`.
Cases: park writes a parseable file with the expected fields and id; claim from the worktree sets
canonical `worktree`, `branch`, `base`, and a second claim refuses; `packet --cwd <worktree>` returns
that task and nothing for the main checkout; `board` shows both with `behind/ahead` and the active task; `done` clears `worktree`.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint` (new block matches `scripts/work.mjs`), `npm test` pass
- [ ] `npm run board` in this repo prints one row per `git worktree list` entry, the prunable one marked, three rows with `behind ≥ 100`

### Live verification (agent-executable)
- Prerequisites: none beyond the repo. Use the main checkout's script by absolute path.
- [ ] A fresh-context subagent runs `node /Users/hongyihe/GitHub/TradesDatabase/scripts/work.mjs park --title "probe" --files src/db/jobs.ts`
      from inside `.claude/worktrees/rung-9b`, then `npm run board` from the main checkout, and
      reports the `rung-9b` board row and the task row verbatim; then `drop`s the task.

### Manual verification — none

## Phase 2: the pre-edit hook, worktree-aware and finding-aware

### What this phase does
Fixes the silent-in-worktrees defect, adds the live record and the documented output shape to the hook, and records touched files on the active task.

### Changes required

**`.claude/hooks/decisions-for-file.mjs`**
- Line 36: replace `const root = …` with `resolveRoot(filePath, evt)`: `spawnSync('git', ['-C',
  dirname(filePath), 'rev-parse', '--show-toplevel'], { timeout: 2000 })`, falling back to the
  old expression on any failure.
- Line 41: make the `by-file.json` read best-effort (`byFile = {}` when absent) instead of
  exiting, so a worktree without an index still gets record lines.
- After line 50: second source — read `<main>/.claude/work/tasks/*.md` (main via
  `--path-format=absolute --git-common-dir`); for every task whose `files` contains `rel`, status
  `open` or `active`, and canonical `worktree` ≠ `root`, add
  `- OPEN FINDING <id> · <title> (parked from <origin>)` (status `open`) or
  `- SIBLING <basename(worktree)> on <branch> · active on <id> "<title>" — has touched this file`
  (status `active`). Emit when the combined line count is non-zero (replaces the line-51 exit);
  keep the once-per-file marker keyed on `rel`.
- Line 93: emit `{ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }`
  and rewrite the contract comment at lines 8–11 (docs: `additionalContext` lives under
  `hookSpecificOutput`; the top-level form is undocumented).
- Line 69: hoist `15` to a `DRIFT_LOUD` constant with a comment pointing at `scripts/decision-index.mjs:36`.

**`.claude/settings.json`** — in the `PostToolUse` `Edit|Write` group (lines 25–36), add a second
hook: `node "$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs" touch`,
`statusMessage: "Recording touched file"`. `touch` (new verb) reads the hook JSON, resolves the
file's top level, finds that worktree's active task, appends the repo-relative path to `files` if
absent, prints nothing; no active task → exit 0.

**`src/work/decisions-hook.test.ts`** (new) — temp repo where `thoughts/by-file.json` (one entry)
is committed *before* `git worktree add`; `TMPDIR` in the spawn env points at the fixture dir;
each case uses `randomUUID()` as `session_id`. Cases: (a) main-checkout edit → context contains
the decision; (b) worktree edit with `CLAUDE_PROJECT_DIR` = main checkout → context still
contains it (today: empty); (c) an open finding listing the file → `OPEN FINDING` line;
(d) another worktree active on a task that touched the file → `SIBLING` line; (e) second call
reusing (a)'s `session_id` → empty (marker). All assert the `hookSpecificOutput` shape.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass; the five hook cases pass
- [ ] `node --check .claude/hooks/decisions-for-file.mjs` passes

### Live verification (agent-executable)
- Prerequisites: none.
- [ ] A fresh-context subagent, working in `.claude/worktrees/rung-9b`, appends a comment to
      `src/db/rawCaptures.ts` and reports verbatim whether it received a "Decisions on record"
      context block (hooks run inside subagents, docs §Hooks). Expected: yes. Then reverts.

### Manual verification — none

## Phase 3: compaction survival and the two commands

### What this phase does
Adds the `SessionStart`, `PreCompact` and `Stop` hooks, `snapshot` and `handoff`, `/park` and `/handoff`, and two lines in `implement.md`.

### Changes required

**`scripts/work.mjs`**
- `packet --for-session`: prints `{"hookSpecificOutput":{"hookEventName":"SessionStart",
  "additionalContext":"<text>"}}`; text = the active packet (frontmatter, Decisions, latest
  Handoff, files) if any, the open-finding count, and, when `worktreeOf(cwd)` ≠ main checkout, a
  "Session memory (main checkout)" block: the absolute path of
  `~/.claude/projects/<encoded main>/memory/MEMORY.md`, "Read it before starting", and its bullet
  titles trimmed so the whole output stays under 9,000 characters. Nothing to say → empty stdout.
- `snapshot`: writes `tasks/<id>.snapshot.json` `{ts, branch, head, changedFiles, diffStat}` for
  the active task of `cwd`'s worktree; prints nothing.
- `handoff --body -`: appends `## Handoff <ISO time>` + stdin to the active task; bumps `updated`.

**`.claude/settings.json`** — with `W="$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs"`
inline in each command: `SessionStart` matcher `startup|resume|compact` → `node "$W" packet
--for-session`; `PreCompact` (no matcher) → `node "$W" snapshot`; `Stop` → `node "$W" snapshot`.
User-level pixel-agents hooks on the same events keep running (dedupe is for identical handlers).

**`.claude/commands/park.md`** (new) — `/park <what you found>`: gather title, files (repo paths),
finding or task, a 2–5 line body; run `node "$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs" park … --body -`;
report the id; return to the original work. Never implement the parked item.

**`.claude/commands/handoff.md`** (new) — `/handoff`: what changed, decisions made, assumptions,
open items, downstream effects → the same path with `handoff --body -`; if the task is finished,
`done` then `promote` (Phase 4).

**`.claude/commands/implement.md`** — after line 19 add the bullet "An issue outside this phase's
scope: `/park` it and continue"; line 32 gains ", then `/handoff`".

**`src/work/work-cli.test.ts`** — add: `packet --for-session` from the worktree names the
MEMORY.md path and at least one title from a fixture `HOME`, and its total length is under
10,000; from the main checkout it has no memory block; `snapshot` writes the sidecar and prints
nothing; `handoff` appends a section and bumps `updated`.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass; new cases pass
- [ ] `echo '{"cwd":"'$PWD'","hook_event_name":"SessionStart"}' | node scripts/work.mjs packet --for-session`
      prints valid JSON or nothing

### Live verification (agent-executable)
- Prerequisites: none.
- [ ] A fresh-context subagent claims a probe task in `.claude/worktrees/rung-9b` (absolute script
      path), writes a handoff via `handoff --body -`, runs `packet --for-session --cwd <that worktree>`,
      and reports that the output contains the handoff text and the memory path; then drops it.

### Manual verification
- [ ] In an interactive session with an active task: run `/compact`, then ask "what is my task
      and which files have I touched?"; the answer must match the packet without re-reading it.

## Phase 4: promote, the `finding` kind, and the CLAUDE.md section

### What this phase does
Turns a closed task into a committed finding document, teaches the index generator the new kind, and documents the record in CLAUDE.md.

### Changes required

**`scripts/work.mjs`** — `promote <id>`: requires status `done|dropped`; writes
`thoughts/shared/findings/<created-date>-<slug>.md` with frontmatter `date`, `task` (= title),
`status` (`done` → `complete`, `dropped` → `dropped`), `origin`, `files` (comma-separated),
`supersedes: nothing`, then `## Files` (one path per line), Notes, Decisions, every Handoff;
moves the task file and its snapshot to `archive/`.

**`scripts/decision-index.mjs`** — line 354: add `path.includes('/findings/') ? 'finding'` before
`'note'`; line 81: add `dropped` to the superseded regex; line 425: "Every research, plan and
finding document"; in the record at lines 366–367, for kind `finding` seed `files`/`staleness`
from the frontmatter `files:` list (each existing `src/**/*.ts` path counted as `MENTION_FLOOR`
mentions) before the text scan, so a promoted finding attaches to its files (reviewer catch:
the text scan needs two mentions).

**`CLAUDE.md`** — after line 25, a paragraph "The work record" naming `.claude/work/`, `/park`,
`/handoff`, `npm run board`, `promote`, and the rule "one active task per worktree; every
code-editing session in its own worktree; hooks and commands run the main checkout's script".

**`src/work/work-cli.test.ts`** — add: `promote` writes the findings file with the expected
frontmatter and `## Files`, and moves the task to `archive/`; a `dropped` task promotes with
`status: dropped`.

### Automated verification
- [ ] `npm run typecheck`, `npm run lint`, `npm test` pass
- [ ] `npm run decisions:index` lists a promoted probe finding as `` `finding` `` in
      `thoughts/INDEX.md` and attaches it to its file in `by-file.json`; then the probe is removed
      and the index regenerated

### Live verification (agent-executable)
- Prerequisites: none.
- [ ] A fresh-context subagent runs `park --files src/db/jobs.ts` → `done` → `promote` on a probe,
      runs `npm run decisions:index`, reports the INDEX row and the `by-file.json` entry for
      `src/db/jobs.ts`; then deletes the probe finding and regenerates.

### Manual verification — none
