---
date: 2026-09-09
branch: main (researched from the feat/rung-10b2-citing-door-on-the-seat checkout, one unrelated commit ahead)
commit: 8f428bd
topic: How context travels between Claude Code sessions in this repo today — the three RPI commands and what they write, the decision index and the pre-edit hook, session memory, the two-feature workflows, worktree and session mechanics and what is and is not shared between checkouts, where deferred findings and handoffs go, where non-code threads live, and the Claude Code hook, messaging and task-list surface (verified against the live docs) that any shared work state would sit on
supersedes: nothing
---

**`supersedes:` is not optional bookkeeping.** This document overturns no decision. It records
the machinery as it stands so that a plan for a shared work graph (the "six verbs": park, spawn,
resume, handoff, board, promote) can be written against facts rather than memory.

## Summary

This is a map of every mechanism the repo and Claude Code use today to carry knowledge from one
session to another: the three slash commands that produce research, plans and implementations;
the decision index that turns those documents into per-file notes a hook injects before an edit;
the session memory Claude keeps outside the repo; the two saved workflows for two features at
once; the git worktree mechanics that isolate parallel sessions; and the Claude Code features
(hook events, cross-session messaging, agent teams) that exist but the repo does not use. The
problem this area solves today is narrow: "when a session edits a file, tell it what was decided
about that file." Everything else a team of people would remember (which session holds which
task, what was parked mid-task, what compaction dropped, which idea belongs to which thread) has
no home in the repo; it is carried by the operator. The facts below are what any change to that
would build on.

## Entry Points

| Where | Line | What starts there |
|---|---|---|
| `.claude/commands/research.md` | 1 | `/research`: read-only survey → `thoughts/shared/research/` |
| `.claude/commands/plan.md` | 1 | `/plan`: decision brief + phased plan → `thoughts/shared/plans/` |
| `.claude/commands/implement.md` | 1 | `/implement`: phase loop with three human gates (lines 18, 26, 28) |
| `.claude/settings.json` | 24–48 | the repo's two hooks: `PostToolUse` JS syntax check, `PreToolUse` decisions injector |
| `.claude/hooks/decisions-for-file.mjs` | 32 | `main(evt)`: file → `thoughts/by-file.json` → `additionalContext` |
| `scripts/decision-index.mjs` | 344 | walk `thoughts/**.md` → `INDEX.md`, `by-file.json`, the engineering-memory map |
| `.claude/workflows/plan-two.js` | 1 | research→plan per feature, footprint intersection, verdict appended to both plans |
| `.claude/workflows/integrate-two.js` | 1 | merge A → gates → merge B → gates → cross-feature review, ≤2 fix rounds |
| `scripts/second-stack.sh` | 24 | per-worktree Supabase stack (refuses to run in the main checkout, line 28) |
| `CLAUDE.md` | 118–135 | "Two concurrent features — plan both first" |
| `~/.claude/projects/-Users-hongyihe-GitHub-TradesDatabase/memory/MEMORY.md` | 1 | session memory index (131 lines, one file per memory) |
| `~/.claude/settings.json` | `hooks` | user-level hooks on 12 events, all forwarding to pixel-agents (external, §External Dependencies) |

## Key Files

**Commands (the RPI lifecycle)**
- `.claude/commands/research.md` (103 lines): frontmatter template `date / branch / commit / topic / supersedes` (39–45); required sections including `## Decision Points` and `## Open Questions` (74–80); final step `npm run decisions:index` + commit (93–103).
- `.claude/commands/plan.md` (143 lines): frontmatter `date / task / research / status: draft / supersedes` (40–46); a `## Decisions` section that must carry user choices "so the record survives the chat" (58–61); `Secrets & env preflight` (70–76); the 300-line cap (131); adversarial plan review by a fresh-context subagent (30).
- `.claude/commands/implement.md` (40 lines): env preflight STOP (18); fresh-context verification subagent (22); adversarial review loop capped at 3 rounds (23); conditional pause on human-only checks (26); "Adapt when reality diverges from the plan … stop and explain" (28); status flip `draft → complete` (32).

**The decision index**
- `scripts/decision-index.mjs` (579 lines, `node:fs` + `node:child_process` only). Inputs: every `.md` under `thoughts/` except `INDEX.md`; `git log --format=@%ct --name-only --no-merges origin/main -- src/` (154–175); `git merge-base --is-ancestor <commit> origin/main` per document (178–186); `CLAUDE.md` and `docs/*.md` scanned for `src/…​.ts` references (296–324); bold lead-in bullets of `docs/engineering-memory.md` (212–250). Frontmatter keys read (344–372): `date`, `topic`, `task`/`note`, `status`, `branch`, `supersedes`, `superseded_by`, `commit`. Outputs: `thoughts/INDEX.md` (488), `thoughts/by-file.json` (561), the map between `INDEX:BEGIN`/`INDEX:END` in `docs/engineering-memory.md` (190, 564). Thresholds: `MENTION_FLOOR = 2`, `MAX_FILES_PER_DOC = 8`, `DRIFT_LOUD = 15` (33–36), `MAX_PER_FILE = 4` (29), `RANK = { rule: 0, memory: 1, doc: 2, superseded: 4 }` (541). `--check` (566) prints a summary and does not exit non-zero.
- `thoughts/INDEX.md` (generated, tracked): 224 documents, 213 live, 11 superseded, newest first, with `landed` / `not landed` / `describes N deleted files` / `drift N` badges.
- `thoughts/by-file.json` (generated, tracked): 96 source files → up to four ranked entries `{date, what, where, kind, drift, dead, durable, durableFirm}`.
- `.claude/hooks/decisions-for-file.mjs` (118 lines): contract comment (8–11) says `additionalContext` is a top-level field, "verified against https://code.claude.com/docs/en/hooks, 2026-08-22"; root resolution (36); exact-path lookup (50); once-per-file-per-session marker under `os.tmpdir()/claude-decisions-<session_id>/<sha1(path)>.seen` (98–110); drift threshold hardcoded as `15` (69).

**The two-feature execution graph**
- `.claude/workflows/plan-two.js` (125 lines): `pipeline(features, research, plan)`; `PLAN_SCHEMA.files` (34–40) is the structured footprint; intersection `a.files.filter(f => b.files.includes(f))` (102); Compare node told to weigh semantic overlap and "Recommend 'parallel' only if merge-time interaction risk is genuinely low" (112–115); appends `## Parallel/stack verdict (plan-two)` to both plans (116); closing log names `claude --worktree` + `scripts/second-stack.sh` as the parallel path (121). Three verdict sections exist in `thoughts/shared/plans/` (2026-07-04 ×3 files, 2026-07-17, 2026-08-15); all recommend STACK.
- `.claude/workflows/integrate-two.js` (139 lines): integration branch `integrate/<A>--<B>` (18); merge rules refuse a dirty tree and non-trivial conflicts (72–78); gates in order typecheck, lint, test; review restricted to cross-feature interactions (109–112); fix loop capped at two rounds (114–124).

**Isolation and environment**
- `scripts/second-stack.sh` (94 lines): rewrites `supabase/config.toml` (`project_id`, ports `54(3+N)xx`, inspector port) and leaves it uncommitted (44–56); writes `.env.test` (80–85).
- `.gitignore` (15–17): `.env`, `.env.test`, `supabase/.env`. No `.claude/` entry.
- `.git/info/exclude` (local to this clone, not tracked): `**/.claude/worktrees/`, `**/.claude/mailbox/`, `**/.claude/agent-registry.json`, `**/.claude/agent-memory-local`, `**/.claude/checkpoints/`, `**/.claude/scheduled_tasks.*`, `**/.claude/routines/.state/`. Of these, only `worktrees/` exists today.
- No `.worktreeinclude` file exists.

**Records that are precedents, not mechanisms**
- `HANDOFF.md` (105 lines): a closed record for one feature (per-tenant cost dashboard, shipped 2026-07-27) with Status, What it does, Verified live, Still open, Traps, Local dev notes, Artifacts. Referenced once, from `docs/onboarding.md:363`. Nothing reads or generates it.
- `thoughts/shared/research/2026-07-17-feature-B-plan-2-mini-app-footprint-overlap.md:6-7`: ad-hoc frontmatter keys `concurrent_feature_A:` and `prior_feature_B_survey:`; the generator ignores both. `depends:` (5 documents), `research:` (98 plans), `amends:` (2 documents, both 2026-09-09) are likewise written and ignored.

**Non-code threads**
- `.claude/skills/growth/SKILL.md` and `.claude/agents/growth-marketer.md`: the marketing playbook and a delegable agent. `thoughts/` contains no research or plan about the landing page or marketing; six documents mention the words incidentally. The landing-page design lives in a published Artifact canvas (session memory `landing-canvases`), outside the repo.

## Data Flows

### Flow 1 — a decision reaches a session at edit time

```
thoughts/**.md ─┐                                    (commit time, manual)
CLAUDE.md, docs/*.md ├─► scripts/decision-index.mjs ─► thoughts/by-file.json ─┐
engineering-memory.md ┘        npm run decisions:index                          │
                                                                                 ▼ (edit time, automatic)
Claude calls Edit|Write ─► PreToolUse hook ─► decisions-for-file.mjs ─► { additionalContext } ─► model
                                            root = CLAUDE_PROJECT_DIR || cwd
                                            key  = path relative to root (exact)
                                            once per (session_id, path)
```

`main(evt)` reads `evt.tool_input.file_path`, computes `rel`, exits silently if `rel` starts
with `..` or has no entry, and otherwise writes up to four ranked lines with staleness notes
(`describes N files that no longer exist`, `code moved N commits since`). Probe on 2026-09-09
(recorded in `2026-09-09-graph-engineering-for-parallel-implementation.md` §5.2): with
`CLAUDE_PROJECT_DIR` at the main checkout and the file inside `.claude/worktrees/rung-9b`, output
is empty; with `CLAUDE_PROJECT_DIR` set to the worktree, output is the normal context.

### Flow 2 — the life of a task through RPI

```
/research <area> ──► thoughts/shared/research/<date>-<slug>.md   (Decision Points, Open Questions)
        │                                   ▲ frontmatter: date, branch, commit, topic, supersedes
        ▼
/plan <research> ──► decision brief in chat ──► thoughts/shared/plans/<date>-<slug>.md (status: draft)
        │                                        Decisions · walkthrough · Secrets & env preflight · Phases
        ▼
/implement <plan> ──► per phase: env preflight STOP · changes · gates · live check (subagent) ·
        │              adversarial review (≤3) · checkboxes ticked in the plan · pause if human items
        ▼
status: draft → complete (implement.md:32) ──► npm run decisions:index ──► commit with the code
```

Where a finding that is out of the current scope lands today: the research template's
`## Open Questions` (87 documents have that heading), prose inside plans ("deferred" appears in
79 documents, "out of scope" in 41, "follow-up" in 50, "parked" in 31, `### Not in scope
(deliberate)` once), session memory files, or `docs/engineering-memory.md` entries. None of
these carries a status, an owner, or a link to the file/symbol involved that the generator reads;
the generator indexes documents, not items within them.

### Flow 3 — two features at once

```
/plan-two {featureA, featureB}
   research:A ─► plan:A ─┐   files ∩ files (exact paths) + a Compare agent for semantic overlap
   research:B ─► plan:B ─┘ ─► "## Parallel/stack verdict (plan-two)" appended to BOTH plans
                                   │
      human reviews both plans ────┤
                                   ▼
   parallel: claude --worktree A / B  +  scripts/second-stack.sh N   (two sessions, two stacks)
   stack:    implement A, land it, re-check plan B
                                   │
                                   ▼
/integrate-two {branchA, branchB} ─► integrate/<A>--<B>: merge A → gates → merge B → gates →
                                     combined-diff review (cross-feature only) → ≤2 fix rounds
```

Between the verdict and the integration branch, nothing is exchanged between the two sessions
by the repo. The plans each carry the other feature's name and the shared-file list as written at
plan time.

### Flow 4 — what survives a compaction or a new session

What is re-read automatically at the start of every session or after compaction: `CLAUDE.md`
(and any `.claude/rules/*.md`, none exist), the session memory index `MEMORY.md` (loaded into
context per the memory instructions), and, per file edited, the hook's decisions. What is not:
the plan's `## Decisions`, the running task's state, anything written only in chat.

Hooks defined in the repo: `PreToolUse(Edit|Write)` and `PostToolUse(Edit|Write)` only. Hooks
defined at the user level (`~/.claude/settings.json`): `Stop`, `SessionStart`, `SessionEnd`,
`PermissionRequest`, `Notification`, `PreToolUse(*)`, `PostToolUse(*)`, `PostToolUseFailure`,
`SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCompleted`, every one of them running
`node ~/.pixel-agents/hooks/claude-hook.js` (plus `afplay` sounds on `Stop`, `PermissionRequest`
and `PreToolUse(AskUserQuestion)`). That script POSTs each event to a local HTTP server found via
`~/.pixel-agents/servers/*.json` (`port`, `pid`, `token`); it writes nothing into the repo. No
hook anywhere runs on `PreCompact` or `PostCompact`, and no hook carries `additionalContext` on
`SessionStart`.

Session memory: one directory per working directory under `~/.claude/projects/<encoded cwd>/`.
The main checkout's directory has 71 transcripts and a `memory/` with 131 entries. The one
worktree directory that exists (`…--claude-worktrees-multi-tech-assignment`) has one transcript
and **no `memory/` directory**. The memory instructions ask Claude to write memories and to
mirror each write into `docs/engineering-memory.md` (session memory `repo-engineering-memory-doc`).

### Flow 5 — worktrees and sessions

```
git worktree add <path> -b <branch>   or   claude --worktree <name>   or   EnterWorktree tool
        │                                          │
        ▼                                          ▼
  no Claude marker;                    marker in .git/worktrees/<name>/ (CLAUDE_BASE seen in 2 of 9);
  never swept;                         swept only if backgrounded or created for a subagent,
  hook root = worktree when launched   and only when clean and older than cleanupPeriodDays;
  from inside it                       hook paths keep ${CLAUDE_PROJECT_DIR} at the launch root
        │                                          │
        └──────────────┬───────────────────────────┘
                       ▼
   shared with the main checkout: .git (objects, refs, all branches), project-scope plugins,
   permission approvals (saved to the main checkout's settings.local.json)
   NOT shared: working tree, .env/.env.test (no .worktreeinclude), supabase/config.toml rewrite,
   thoughts/INDEX.md + by-file.json as of that branch, the cwd-keyed memory directory
```

Measured on 2026-09-09: nine worktrees (`git worktree list`); four on branches already merged;
three unmerged and 121–288 commits behind `origin/main`; one squash-merged branch (#214) still
present; one prunable scratch worktree. `.git/worktrees/<name>/` holds `HEAD`, `index`, `logs`,
`commondir`, `gitdir`, `COMMIT_EDITMSG`, and for two of them `CLAUDE_BASE` (a full sha).

How a session can be found: `ListAgents` (this session, subagents, peer sessions by name and
age; working directory withheld while Remote Control is connected — five TradesDatabase peers
were listed on 2026-09-09 with no directory shown); `~/.claude/projects/<encoded cwd>/` (two
directories for this repo); process inspection (`lsof -a -p <pid> -d cwd` showed one shell live
in `.claude/worktrees/rung-9b`); the pixel-agents server, which receives every hook event with
`session_id` and `cwd`.

## External Dependencies

All verified against https://code.claude.com/docs on 2026-09-09.

**Hooks** (`/docs/en/hooks`). Common input fields: `session_id`, `prompt_id`, `transcript_path`,
`cwd`, `scratchpad_dir`, `permission_mode`, `hook_event_name`. Event facts that bear on this
area:

| Event | Fires | Matcher | Can block | `additionalContext` |
|---|---|---|---|---|
| `SessionStart` | session begins or resumes | `startup` / `resume` / `clear` / `compact` / `fork` | no | yes, under `hookSpecificOutput` |
| `UserPromptSubmit` | before Claude processes a prompt | none | yes | yes; plain stdout is also added as context |
| `PreCompact` | before compaction | `manual` / `auto` | yes (prevents compaction; `decision: "block"` or exit 2) | **no** — corrected 2026-09-09 after plan review: the docs give `PreCompact` only `decision`/`reason`; `systemMessage` is discarded |
| `PostCompact` | after compaction | `manual` / `auto` | no | output and exit code discarded |
| `Stop` | Claude finishes responding | none | yes (keeps going) | yes; input carries `last_assistant_message`, `turn_count` |
| `SessionEnd` | session terminates | `clear` / `resume` / `logout` / `prompt_input_exit` / `other` | no | output ignored; 1.5 s shared budget |
| `PreToolUse` | before a tool call | tool name | yes | yes; also `permissionDecision`, `updatedInput` |
| `PostToolUse` | after a tool call succeeds | tool name | no | yes; stdout goes to the debug log |
| `SubagentStart` / `SubagentStop` | subagent lifecycle | agent type | Stop: yes | yes; input carries `agent_id`, `agent_type` |
| `WorktreeCreate` / `WorktreeRemove` | worktree lifecycle for `--worktree`, subagent isolation, background sessions | none | yes (non-zero aborts) | no; `worktree_path`, `base_branch`, `create_branch` / `remove_branch` |
| `TaskCreated` / `TaskCompleted` | agent-team task list | none | yes | yes; `task_id`, `task_input` / `task_result` |
| `InstructionsLoaded` | a `CLAUDE.md` or `.claude/rules/*.md` loads | `session_start` / `nested_traversal` / `path_glob_match` / `include` / `compact` | yes | yes |

Quoted: "`${CLAUDE_PROJECT_DIR}`: the project root where the session started." "Hooks from
settings files, managed policy settings, and plugins also run inside subagents." "If you define
the same handler in more than one settings file, it runs once." The `once` option is honored only
in skill frontmatter. The transcript file "may lag the in-memory conversation" when a hook fires.

**Worktrees** (`/docs/en/worktrees`). "`${CLAUDE_PROJECT_DIR}` stays put: it still points at the
project root where the session started"; "`cwd` follows Claude". Sweep: removes worktrees created
for subagents and background sessions once older than `cleanupPeriodDays`; leaves any that hold
work, any belonging to a `--worktree` session "you haven't backgrounded, whatever its age", any
without the marker, any you created with `git worktree add`. "Claude Code writes a marker into
the git metadata of every worktree it creates with git." `.worktreeinclude` copies gitignored
files into every worktree Claude Code creates. Shared: the `.git` directory, project-scope
plugins, permission approvals. `worktree.baseRef` is `"fresh"` (default branch on the remote) or
`"head"`.

**Cross-session messaging** (`/docs/en/cross-session-messaging`, v2.1.224+). `ListAgents` and
`SendMessage`; "A message is a piece of text one Claude writes to another, never the sender's
conversation history or files." Same-machine delivery over a per-session Unix socket; "Each
session registers itself in files on disk." Claude Code exports `CLAUDE_CODE_MESSAGING_SOCKET`
and `CLAUDE_CODE_MESSAGING_TOKEN` to hooks and Bash, "before any hook runs, including
`SessionStart`", so "a script or hook [can] post into a session" (own-child messages are delivered
when verified). Idle notice: one-shot, `notify_when_idle`, v2.1.236+, 12-hour expiry. Limits:
about one million characters, burst refusal, loop throttling, 50 queued.

**Agent teams** (`/docs/en/agent-teams`). "Agent teams are experimental and disabled by default"
(`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Task list: `~/.claude/tasks/{team-name}/`, team name
`session-` + first eight characters of the session id; "The task list directory persists locally
and is never uploaded, so resumed sessions keep their tasks." Mailboxes:
`~/.claude/teams/{team-name}/inboxes/{agent-name}.json`, removed when the session ends. Tasks
have states pending / in progress / completed and dependencies; claiming uses file locking; tools
`TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate` exist in sessions that have the Task tools.
"One team per session"; "No session resumption with in-process teammates"; "There is no
project-level equivalent of the team config."

**pixel-agents** (user-level, `~/.pixel-agents/`): `hooks/claude-hook.js` (a bundle whose header names a TypeScript source under the project's `server/` tree), `server.json`, `servers/<pid>-<port>.json`
(`port`, `pid`, `token`, `startedAt`, `servesSpa`, `protocol`), `config.json`. The hook reads the
registry and POSTs `/api/hooks` events to the running server. What the server renders was not
read for this document.

**Git**: `git rev-parse --git-common-dir` from any worktree returns the main checkout's `.git`
(verified: `.claude/worktrees/rung-9b` → `/Users/hongyihe/GitHub/TradesDatabase/.git`); all
branches and objects are visible from every worktree, which is what lets
`git diff --name-only origin/main...<branch>` run from any of them.

## Constraints and Invariants

- **The hook's key is an exact repo-relative path** (`decisions-for-file.mjs:37,50`); no globs,
  no prefixes; a path outside `root` is silently ignored (38). Combined with `${CLAUDE_PROJECT_DIR}`
  staying at the launch root, a session in a worktree created under `.claude/worktrees/` or
  outside the repo gets no decisions unless it was launched from inside that worktree.
- **Once per file per session** is a marker directory under `os.tmpdir()` keyed by `session_id`
  (98–110); a new session, a resumed session with a new id, or a cleared temp dir repeats the
  injection; two sessions never share markers.
- **The index is regenerated by hand at commit time** (`CLAUDE.md:26-27`); `--check` cannot
  fail (`decision-index.mjs:566`); `by-file.json` and `INDEX.md` are tracked, so each worktree
  sees the index as of its own branch.
- **Frontmatter keys the generator reads**: `date`, `topic`, `task`/`note`, `status`, `branch`,
  `supersedes`, `superseded_by`, `commit`. Keys present in the corpus and ignored: `research`,
  `depends`, `amends`, `concurrent_feature_A`, `prior_feature_B_survey`, `related`, `rebased`.
  Only research documents carry `commit:`, so `landed`/`not landed` badges appear almost only on
  research rows. A document naming more than `MAX_FILES_PER_DOC = 8` source files is attached to
  its eight most-mentioned; a file keeps at most `MAX_PER_FILE = 4` entries ranked rule → memory →
  doc → superseded.
- **Deferred findings have no structured form.** They live in `## Open Questions` (research),
  prose in plans, session memory, or engineering memory. The generator indexes documents, not
  items; nothing tracks whether an open question was later closed.
- **A plan's `## Decisions` and `## Parallel/stack verdict` sections are the only in-repo record
  of user rulings and cross-feature analysis**; both are prose inside a document whose
  `status` flips once (`draft` → `complete`) at the end of implementation.
- **Two sessions on one checkout can corrupt each other's commits** (engineering-memory
  2026-08-15: `git commit -a` swept another session's edits); the worktree rule exists for that,
  and `git add <paths>` is the recorded practice.
- **Per-worktree environment is partly manual**: no `.worktreeinclude`, so `.env` is absent and
  key-gated live-model tests skip (`CLAUDE.md:128-129`); `second-stack.sh` leaves
  `supabase/config.toml` uncommitted, and `npx supabase stop` in a worktree without that rewrite
  stops the primary stack (engineering-memory 2026-08-19).
- **Session memory is keyed by working directory**, so a session whose cwd is a worktree reads a
  different (here, nonexistent) memory directory from the main checkout's.
- **Worktree cleanup never happens by itself for this repo's worktrees**: seven of nine carry no
  Claude marker; interactive `--worktree` sessions are excluded from the sweep unless
  backgrounded; squash merges leave every branch commit "not on the remote" in git's view.
- **`.claude/worktrees/` is ignored only by this clone's `.git/info/exclude`**, not by the tracked
  `.gitignore`; a fresh clone that creates a worktree there would see it as untracked.
- **The repo hook's output contract and the current docs differ in wording**: the hook emits
  top-level `additionalContext` (comment: verified 2026-08-22) and works today (probe §Flow 1);
  the docs' event table lists `additionalContext` under `hookSpecificOutput` for the other events.
- **Cross-session messages are model-authored plain text**; nothing in the repo sends one; a hook
  could post to its own session's socket via the exported variables, per the docs.
- **Agent-team task lists are per session** (`session-<id8>`), experimental, and not shareable
  across sessions; the mailbox directory is deleted at session end.
- **Compaction has no hook in the repo or at user level**; `PreCompact` can inject and block,
  `SessionStart` with matcher `compact` can inject, `PostCompact` output is discarded.
- **Non-code work has no record in `thoughts/`**; the growth skill and agent exist, the landing
  canvas is an external Artifact.

## Decision Points

1. **Where a shared, live record would live, given what each checkout can see.** Inside a
   worktree's working tree (`thoughts/`, `.claude/`): visible to siblings only after a commit
   reaches their branch, and indexed per branch. Beside the shared git directory (found from any
   worktree with `git rev-parse --git-common-dir`, or the main checkout's `.claude/` under a
   local exclude): visible to every worktree at once, untracked, and lost with the clone. Under
   `~/.claude/projects/<encoded cwd>/`: per user and per working directory, so per worktree.
   Under `~/.claude/tasks/session-…/`: the agent-teams substrate, one team per session,
   experimental.
2. **How the pre-edit hook resolves its root.** Today: `${CLAUDE_PROJECT_DIR}`, else `cwd`
   (`decisions-for-file.mjs:36`), which stays at the launch root in worktrees. The alternatives the
   inputs allow: the hook's `cwd` field (follows Claude), or the edited file's own
   `git rev-parse --show-toplevel`. Each changes which `by-file.json` is read and how `rel` is
   computed.
3. **Which frontmatter keys become edges in the index.** The generator reads `supersedes` (both
   directions) and `commit`; `depends`, `research`, `amends` and the two `concurrent_*` keys are
   written by authors and dropped. Reading them changes `by-file.json` and `INDEX.md` shape;
   leaving them changes nothing.
4. **Where a finding surfaced mid-task is recorded.** Today one of four prose homes (Open
   Questions, plan prose, session memory, engineering memory), none with status or file links
   the generator reads. The fork is whether such items become a new document kind the generator
   walks, a section it learns to parse, or stay prose.
5. **Which event carries state across compaction.** `PreCompact` (can block only; it cannot
   inject context — corrected 2026-09-09), `SessionStart` with matcher `compact` (can inject,
   cannot block), `PostCompact` (output discarded), or none, as today. Any of them would be the repo's first hook on those
   events; the user-level hooks already occupy `SessionStart` for pixel-agents and run in
   parallel with repo hooks.
6. **How a worktree session gets memory.** cwd-keyed memory means a worktree session starts
   without the main checkout's 131 entries. The paths the mechanics allow: launch pattern (which
   directory the session starts in), copying or symlinking the directory, or reading the main
   checkout's memory explicitly from a hook.
7. **Which source a session board reads.** `ListAgents` (names, kinds, ages; directories
   withheld under Remote Control), `~/.claude/projects/` (partial), process inspection (`lsof`),
   the pixel-agents server (already receives every event with `session_id` and `cwd`), or
   `git worktree list` joined with any of these.
8. **Which worktree creation path parallel sessions use.** `git worktree add` by hand: no marker,
   never swept, hook root correct when launched from inside, `second-stack.sh` designed for it.
   `claude --worktree`: marker, sweep-eligible only when backgrounded, `.worktreeinclude`
   honored, hook root stays at the launch root under the documented behavior.
9. **Whether the two-feature workflows stay the shape for parallel work.** `plan-two` fixes the
   unit (two features, planned first, one verdict) and `integrate-two` fixes the join (two
   branches, one integration branch). Work that starts mid-task, or touches more than two
   threads, has no script; the pieces those scripts use (`git worktree`, the footprint list, the
   verdict section, the gates, the review prompt) are all reusable outside them.

## Open Questions

- Does a session started with `claude --worktree <name>` (as `plan-two.js:121` recommends) set
  `${CLAUDE_PROJECT_DIR}` to the worktree or to the launch root? The docs describe the
  `EnterWorktree` case; the launch case needs a live check (edit a file with decisions on record
  and see whether context is injected after `Checking decisions on record`).
- Which memory directory does a `--worktree` session read: the launch root's, the worktree's
  (nonexistent), or none? The one worktree project directory found has a transcript and no
  memory; how that session was launched is not recorded.
- Does the top-level `additionalContext` the repo hook emits still work on every event, or only on
  `PreToolUse`? The 2026-08-22 verification covers `PreToolUse`; the current docs word the field
  under `hookSpecificOutput`.
- What does the pixel-agents server keep and expose (session → cwd, status), and does it survive
  the sessions it observes? Only the hook script and the registry file shape were read.
- Are `.claude/mailbox/`, `.claude/agent-registry.json`, `.claude/checkpoints/` (in this clone's
  `.git/info/exclude`) paths a current Claude Code version writes in the project directory? None
  exists today.
- How many of the 87 `## Open Questions` sections contain items that were later closed by a
  landed change, and how many are still open? Reading alone cannot tell; nothing records
  closure.
