---
date: 2026-09-09
branch: main (researched from the feat/rung-10b2-citing-door-on-the-seat checkout, one unrelated commit ahead)
commit: 8f428bd
topic: "Graph engineering" — what the term means in September 2026 (it is three different graphs), which of the three this repo already has, exactly where two parallel implementations drift apart between plan time and merge time, a hook defect that silences the decision index in worktree sessions, and four options for closing the gap with a recommendation
supersedes: nothing
---

# Graph engineering, and the drift between two parallel sessions

## The short version

**The question.** When two Claude Code sessions build two features at once, each in its own
worktree, each session carries a private picture of the code and of the decisions that govern
it. The pictures start identical (both branch from the same commit) and then silently diverge:
session A changes a signature or records a doctrine, session B keeps building on the old
picture. Nothing errors. The mismatch surfaces at merge, or never. The 2026 literature calls
this **context drift** and treats it as distinct from a merge conflict: a conflict is loud and
blocks; drift is quiet and accumulates (CodeCtx paper, §1).

**What "graph engineering" is.** Not one thing. Between July and August 2026 the phrase was
attached to three different graphs, and the answer to "can it help" is different for each:

| The graph | Nodes / edges | What it protects against | This repo today |
|---|---|---|---|
| **Execution graph** — who does what, in what order, what hands off to what | jobs / data dependencies, run by a script | wrong sequencing, unbounded fan-out, results lost in a chat window | **Has it.** `plan-two.js` and `integrate-two.js` are saved dynamic workflows |
| **Decision (context) graph** — what was decided, about which file, when, still current? | documents / files, with `supersedes`, `landed`, `drift N` | re-deciding the settled, reviving the rejected | **Has it.** `thoughts/INDEX.md`, `by-file.json`, the `PreToolUse` hook |
| **Code graph** — which symbol depends on which, who has read what | symbols / imports, calls, type refs; agents / observations | one agent acting on a signature another agent changed | **Does not have it.** `drift N` (commit counts per file) is the only code-shaped signal |

**The finding.** The repo's two graphs are both **static and commit-time**. They are consulted
at plan time (`plan-two` intersects file footprints and writes a verdict into both plans) and at
merge time (`integrate-two` reads the combined diff). Between those two moments — the whole of
implementation — **there is no edge between the two sessions**. A decision made in worktree A at
14:00 reaches worktree B only when A commits to `main` and B rebases, which the workflow never
asks B to do. That interval is where drift lives.

**Two defects surfaced on the way** (both verified, both small):

1. The decision hook is **silent in worktree sessions** when Claude Code keeps the project dir at
   the main checkout (its documented behaviour after entering a worktree). Probe below.
2. `scripts/decision-index.mjs --check` prints "OK" and never exits non-zero, so nothing can
   enforce a fresh index.

**Recommendation.** Do not buy a code graph yet. Add the missing *live edge* using git as the
graph store — two small hooks — and fix the two defects first. Details in §6.

---

## 1. Drift, in plain words

```
                 both start here
                       │
              main @ dcd7fce
             ┌─────────┴─────────┐
             ▼                   ▼
   worktree A (session A)   worktree B (session B)
   ┌───────────────────┐    ┌───────────────────┐
   │ picture of code   │    │ picture of code   │   ← identical at t0
   │ picture of rules  │    │ picture of rules  │
   └─────────┬─────────┘    └─────────┬─────────┘
             │ A edits a db accessor  │ B reads that accessor (old shape)
             │ A records a doctrine   │ B builds on the old doctrine
             ▼                        ▼
   A's picture moved          B's picture did not      ← drift, invisible
             │                        │
             └──────────┬─────────────┘
                        ▼
              integrate-two: merge, gates, combined-diff review
                        ▲
              first moment anyone compares the two pictures
```

A merge conflict is git noticing two edits to the same lines. Drift is the case git cannot see:
different lines, different files, one belief stale. The literature's shortest statement of the
limit: *"Physical isolation prevents simultaneous filesystem edits, not logical conflict. Two
worktrees can independently change an API and its caller in incompatible ways."* (Graphify,
2026-07-17.) This repo has paid for physical isolation in full (§4.4) and has nothing for the
logical layer during implementation.

---

## 2. What "graph engineering" means right now (three senses, dated)

**Provenance check first.** One widely shared piece (doronkatz.com, 2026-08-13) says
"Anthropic popularized the labels" loop / graph / context engineering. I checked the two
Anthropic posts it cites. *Harnessing Claude's intelligence* (2026-04-02) and *Introducing
dynamic workflows in Claude Code* (2026-05-28) **do not use the phrase "graph engineering"** at
all; the first mentions "context engineering" once, as a hyperlink. The term is community
vocabulary. Treat any "Anthropic says graph engineering…" claim as unsourced.

### 2.1 Sense 1 — the execution graph (July 2026, Claude Code workflows)

Origin: a viral X thread by "Codez" (July 2026), written up as a "14-step roadmap" on
jigarjoshi.in (2026-07-22), mer.vin (2026-07-25) and movez.substack.com (2026-07-25). The
definition is explicit and narrow:

> "Not Neo4j. Not knowledge graphs for RAG (different job). Graph engineering here means: model
> the agentic workflow as nodes (jobs) and edges (data dependencies), then execute that topology
> with a script Claude writes and you can rerun." — jigarjoshi.in

The product surface is Claude Code **dynamic workflows** (announced 2026-05-28): a JavaScript
script holds the loop, branching and intermediate results; only the final answer lands in the
session's context. The canonical shape is the diamond (split → work in parallel → merge), with
maker ≠ verifier and deterministic routing at the edges. FrankX (2026-08-24) generalises it:

> "moving orchestration out of an improvised conversation and into inspectable workflow code,
> bounded workers, external artifacts, deterministic controls, and verified handoffs."

and adds the caveat that matters here: *"Workflow variables improve context efficiency; they are
not a general durable business database"* — cross-session state needs checkpoint artifacts
(`runId`, `completedNodes`, `sourceCommit`) written outside the run.

### 2.2 Sense 2 — the context graph (August 2026, SurrealDB)

*Graph engineering is missing a graph* (surrealdb.com, 2026-08-13) argues sense 1 is half an
idea: the agents are drawn as a graph while what they *know* stays a pile of flat chunks.

> "Graph engineering is how you design the execution graph of agent work and the context graph
> of durable knowledge, then keep them consistent across every turn."

Its requirements list reads like a spec for a decision index with a clock: provenance on every
fact and edge; **temporal validity** ("what did we believe on the day the decision was made, not
what do we believe now"); a job that retires superseded beliefs; entity resolution so one thing
does not become five nodes; write-back after every turn; and "shared context, not per-agent
context — twenty agents with twenty vector stores are twenty inconsistent opinions with an org
chart." The vendor pitch (SurrealDB / Spectron) is separable from the requirements.

### 2.3 Sense 3 — the code graph with invalidation (the one that names "context drift")

*Context Synchronization for Multi-Agent Workflows* (CodeCtx; rybkr.com, code at
github.com/rybkr/codectx) is the direct hit for this question. It defines drift, then builds
the mechanism:

- a symbol-level graph (modules, classes, functions; edges IMPORTS / CALLS / REFERENCES_TYPE /
  CONTAINS), each symbol carrying an **interface hash** (public shape) and a **body hash**;
- every agent read is recorded as an **observation** (symbol id + hashes) — an explicit edge
  from agent to fact;
- when an edit lands, changed symbols are found by hash comparison, impact propagates along
  reverse edges, and the system reports **which agents hold stale beliefs**, without refreshing
  anyone's whole context.

Evidence: on one Python repo (pallets/click), in overlapping-edit scenarios, "baseline agents
without CodeCtx produced test failures or compilation errors in every trial, while agents
operating with CodeCtx passed all tests across all trials." The authors call the benchmark
"small and synthetic." The implementation is Python-only, 2 GitHub stars, last push 2026-04-23.

Related tools (all early):

| Tool | Language / target | State (2026-09-09) | Has invalidation to agents? |
|---|---|---|---|
| CodeCtx (rybkr) | Python repos only | research prototype, 2★ | **yes** — the whole point |
| GraphCode (ericnerwala) | TypeScript tool; indexes TS/TSX/JS/Py/Go/Java/Rust | 1★, created 2026-07-06, last push 2026-07-07 | no; re-indexes after the agent's own edit, serves a "turn-0 context pack" over MCP |
| code-context-graph (tae2089) | Go tool; 12 languages incl. TS | 17★, active (push 2026-08-21), 18 MCP tools | no; impact analysis and change detection on request |

Graphify's swarm guide (2026-07-17) supplies the vocabulary for what a graph does and does not
buy: attach a *commit* to every graph, report and handoff; "a graph aligned to the base commit
but not the current branches is historical evidence, not current context"; and its drift
taxonomy — **evidence drift** (stale graph/report), **decision drift** (decisions living in a
worker's transcript instead of a reviewed record), **permission drift**.

---

## 3. The Claude Code mechanics that constrain the options (doc-cited)

| Mechanism | What it gives | The limit that matters here | Source |
|---|---|---|---|
| Dynamic workflows | script holds state; `agent()` nodes with `schema`; `isolation: 'worktree'` per node; resumable in-session | **No mid-run user input** — "only agent permission prompts can pause a run. For sign-off between stages, run each stage as its own workflow." Resume only in the same session | code.claude.com/docs/en/workflows |
| Subagents | fresh isolated context; `isolation: worktree` | `AskUserQuestion` is stripped from every subagent | …/sub-agents |
| Agent teams | lead + peers, **shared task list**, named messaging, plan-approval to the lead | experimental; teammates cannot ask the human directly | …/agent-teams |
| Cross-session messaging | `ListAgents` / `SendMessage` between local sessions on one machine; idle notification (v2.1.236) | plain text, authored by the model — nothing automatic | …/cross-session-messaging |
| Hooks | ~30 events incl. `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `SessionStart`, `FileChanged`, `WorktreeCreate`, `PreCompact`; can inject `additionalContext` | per-event, not persistent | …/hooks |
| `.claude/rules/*.md` with `paths:` | path-scoped rules loaded when matching files are touched | static text | …/memory |
| Worktrees | `--worktree`, `EnterWorktree`; share `.git`, plugins, permission approvals; `.worktreeinclude` copies `.env` | **"Hook paths don't follow the worktree… `${CLAUDE_PROJECT_DIR}` stays put; `cwd` follows Claude"** | …/worktrees |

The first row rules out the tempting move (one workflow that implements both features): the
repo's `/implement` has three human gates (env preflight stop, manual-verification pause,
"reality diverges from the plan" stop — `.claude/commands/implement.md:18,26,28`) and
`CLAUDE.md` already forbids wrapping it in subagents for exactly that reason. The last row is
the defect in §5.2.

---

## 4. What this repo already has, graph by graph

### 4.1 Execution graph — present

`.claude/workflows/plan-two.js` (research → plan per feature via `pipeline()`, then a Compare
node) and `.claude/workflows/integrate-two.js` (merge A → gates → merge B → gates → combined
review with a 2-round fix loop). Both are textbook sense-1 artifacts: schema-typed node outputs,
deterministic routing in code, model tiering (`opus` for mechanics, session model for
judgment), local-only side effects.

```
plan-two                                      integrate-two
────────                                      ─────────────
research:A ─► plan:A ─┐                       merge A ─► gates ─► merge B ─► gates ─► review ⟲ fix (≤2)
                      ├─► compare ─► verdict
research:B ─► plan:B ─┘   (∩ of files +       "feature A alone passed everything — so any
                           semantic check)     gate failure now means THE COMBINATION broke"
```

### 4.2 Decision graph — present, static

`scripts/decision-index.mjs` (579 lines, no deps) reads every `thoughts/**.md` frontmatter and
`git log` on `src/`, and writes three artifacts: `thoughts/INDEX.md` (222 docs: 211 live, 11
superseded; badges `landed` / `not landed` / `describes N deleted files` / `drift N` at
`DRIFT_LOUD = 15`), `thoughts/by-file.json` (96 source files → up to 4 ranked decisions each),
and the 238-entry map at the top of `docs/engineering-memory.md`. The `PreToolUse` hook
`.claude/hooks/decisions-for-file.mjs` does one exact-path lookup in `by-file.json` and injects
the hits once per file per session (marker files keyed by `session_id`).

Edges the generator reads: `supersedes:` (wired both directions). Edges it **does not** read,
although documents already carry them: `depends:` (5 docs), `research:` (98 plans),
`concurrent_feature_A:` / `prior_feature_B_survey:` (one 2026-07-17 doc — an ad-hoc attempt at
exactly the cross-feature edge this research is about). A plan's "File footprint" section is
prose the generator cannot see; `plan-two` returns the same list as structured `files` and then
drops it.

### 4.3 Code graph — absent

Nothing indexes symbols. `drift N` counts commits per *file* since a *document's* date; it says
"this description may be stale," never "this signature changed and you read the old one."

### 4.4 Isolation — bought and paid for, at the physical layer only

Every recorded parallel-session incident in `docs/engineering-memory.md` is a **physical**
collision, and each has a fix:

| Date | Incident | Layer | Fix in place |
|---|---|---|---|
| 2026-08-15 | `git commit -a` in one session swept the other session's half-edited `server.ts` into an unrelated commit | filesystem | worktree rule; `git add <paths>` |
| — | worktrees under `.claude/worktrees/` gave typescript-eslint multiple `tsconfigRootDir`s → 289 phantom errors | tooling | ignore `.claude/`, pin `tsconfigRootDir` |
| 2026-08-19 (×2) | `npx supabase stop` in a worktree stopped the **primary** stack | infra | `scripts/second-stack.sh`; grep `project_id` first |
| — | four local stacks = 46 containers → phantom test failures that move between runs | infra | stop stacks of merged worktrees |

No **logical** drift incident is recorded. Read that carefully: drift is the failure that does
not announce itself, and `integrate-two` is the only place it would be caught — so "none
recorded" is consistent with both "it has not happened" and "it was absorbed silently in a
review round."

---

## 5. Where the drift enters — three concrete findings

### 5.1 The timeline has a hole in the middle

```
   PLAN TIME                 IMPLEMENTATION TIME                  MERGE TIME
   plan-two.js               session A ║ session B                integrate-two.js
   ─────────────             ──────────╫──────────                ────────────────
   files ∩ files             edits     ║ edits                    merge, gates,
   semantic compare          decisions ║ decisions                combined-diff review
   verdict → both plans      doctrine  ║ doctrine
        ▲                         ▲    ║    ▲                          ▲
   graph consulted          NOTHING CROSSES THIS LINE            graph consulted
                            (B learns of A only via main)
```

The only thing that travels from plan time into implementation is the verdict section appended
to both plan files — frozen before either session starts. `/implement` step 5 ("if the actual
codebase differs from what the plan describes… stop and explain") is the sole drift handler, and
it fires only when the *model notices*.

### 5.2 The decision hook is silent in worktree sessions (verified)

The hook computes `rel = relative(CLAUDE_PROJECT_DIR || cwd, file_path)` and looks `rel` up in
`<root>/thoughts/by-file.json`. Claude Code's worktree doc states that after a session enters a
worktree, `${CLAUDE_PROJECT_DIR}` "stays put" at the launch root while `cwd` follows. Probe
(2026-09-09, `src/db/rawCaptures.ts`, which has decisions on record):

| Case | `CLAUDE_PROJECT_DIR` | file path | Hook output |
|---|---|---|---|
| main checkout | main root | main root | decisions injected ✔ |
| `.claude/worktrees/rung-9b` | main root | worktree | **empty** — `rel` becomes `.claude/worktrees/rung-9b/src/db/…`, no key |
| `../TradesDatabase-decline` | main root | worktree | **empty** — `rel` starts with `..`, early `quiet()` |
| `.claude/worktrees/rung-9b` | worktree | worktree | decisions injected ✔ |

So the hook works for a session started by `cd <worktree> && claude` and goes dark for
`claude --worktree <name>` — which is the route `plan-two`'s closing message recommends. The
sessions most exposed to drift are the ones the decision graph does not reach. Fix: derive the
root from the file's own worktree (`git -C $(dirname file) rev-parse --show-toplevel`) and read
*that* worktree's `by-file.json`. Verify live on the next `--worktree` session (the
`Checking decisions on record` status line should be followed by injected context).

### 5.3 The worktrees themselves are drifted contexts

`git worktree list` shows nine. Measured against `origin/main` (2026-09-09):

| Worktree branch | behind / ahead | merged? | last commit | Reading |
|---|---|---|---|---|
| feat/rung-10b2-citing-door-on-the-seat (main checkout) | 0 / 1 | no | 2026-09-09 | current |
| feat/rung-10b-new-caller | 4 / 7 | squash-merged (#214) | 2026-09-08 | done; remove |
| feat/the-decline-verb | **121** / 2 | no | 2026-08-27 | stale picture |
| worktree-multi-tech-assignment | **211** / 1 | no | 2026-08-23 | stale picture |
| rescue/route-deeplink-staged | **288** / 1 | no | 2026-08-23 | stale picture |
| feat/decision-index | 228 / 0 | yes | 2026-08-22 | dead; remove |
| docs/nudge-money-blindspot | 312 / 0 | yes | 2026-08-19 | dead; remove |
| chore/retire-nudge-cap | 329 / 0 | yes | 2026-08-18 | dead; remove |
| plan-fold-impact-complete | 783 / 0 | yes | 2026-07-15 | dead; remove |
| (scratchpad `portal-wt`) | detached | — | — | prunable |

Any session resumed in the three "stale picture" worktrees believes a codebase 121–288 commits
old, with `by-file.json` and `INDEX.md` from that era. That is context drift in its most
literal form, and it is the same mechanism as §5.1 stretched over weeks. Each also holds one or
two commits of real work; whether to rebase or abandon is the user's call, not this document's.

Two smaller gaps: `.worktreeinclude` does not exist, so every fresh worktree lacks `.env`
(`CLAUDE.md` notes key-gated tests are skipped there — the file is the documented fix); and the
hook hardcodes `15` where the generator has `DRIFT_LOUD`.

---

## 6. Options — decision brief

The decision is **which graph gets the missing edge**. Four candidates, in rising cost.

### Option A — the footprint edge (extend the decision graph; ~half a day)

Make the plan's file list a real edge and check it against the sibling worktree at edit time.

- `plan.md` template: the "File footprint" list also goes into frontmatter as `files:`;
  `plan-two` already has the structured list — write it there.
- `decision-index.mjs` reads `files:` and `depends:` → `by-file.json` gains "plan in flight
  (draft / in progress) that claims this file" entries.
- Hook: fix §5.2, then on every `Edit|Write` ask git about the *other* worktrees —
  `git worktree list --porcelain`, then per sibling `git -C <wt> diff --name-only
  <merge-base>..HEAD -- <rel>` plus `git -C <wt> status --porcelain -- <rel>`. A hit injects:
  "sibling branch `<b>` has changed this file (N lines, last commit <sha> <date>)". Git is the
  graph store; nothing to index or keep fresh.

Catches: every same-file collision the moment it forms, and the sibling's uncommitted work.
Misses: different files, same behaviour (the semantic overlap `plan-two`'s compare node reasons
about once).

### Option B — the live edge (a bulletin between sessions; ~a day)

Give the two sessions a channel that does not depend on the model choosing to talk.

- `PostToolUse` on `Edit|Write`: if the path matches the repo's **contract surfaces**
  (`src/db/**`, `supabase/migrations/**`, `src/mcp/**` tool schemas, `thoughts/**`), append one
  JSON line `{ts, branch, worktree, file, diffstat}` to `<main-root>/.claude/parallel/bulletin.jsonl`
  (gitignored; main root via `git rev-parse --git-common-dir`, shared by all worktrees).
- `UserPromptSubmit` in every session: inject lines newer than this session's watermark from
  *other* branches, once each. Thirty lines of Node in the existing hook file.
- Optional, model-dependent: `/implement` sends a one-line `SendMessage` to the sibling session
  when it records a doctrine. Keep this as guidance, not as the mechanism.

This is the SurrealDB requirement list at toy scale — provenance (branch, sha), time (ts),
shared not per-agent — and it is the execution-graph edge `plan-two` → `integrate-two` never
had. Catches: contract changes on the named surfaces regardless of file overlap. Misses: a
behavioural change outside those globs.

### Option C — a code graph with invalidation (CodeCtx for TypeScript; a week or more)

Symbol graph from the TypeScript compiler API (exports, imports, call sites), interface and
body hashes per export, an observation log from `PostToolUse` on `Read`, invalidation when a
sibling commits. Nothing off the shelf does the invalidation half for TypeScript (CodeCtx is
Python-only; GraphCode is dormant; code-context-graph answers "what would this impact" on
request but keeps no per-agent beliefs). This is the only option that mechanically catches
semantic drift. Its evidence base is one small synthetic benchmark. Revisit only if A + B leave
`integrate-two` still finding "important" cross-feature interactions.

### Option D — one workflow implements both (`implement-two.js`)

Two `agent()` implementers with `isolation: 'worktree'` fed the same task packet (base commit,
plan, contract list), then `integrate-two` as a child `workflow()`. Rejected: workflows cannot
take mid-run input, subagents cannot ask the user, and `/implement`'s three human gates are the
repo's review discipline. Splitting into per-phase workflows with human review between them
reproduces the two-session model with less visibility.

### Trade-offs at a glance

| | Catches same-file drift | Catches contract drift | Catches semantic drift | Needs new infra | Mechanical (no model cooperation) | Cost |
|---|---|---|---|---|---|---|
| A footprint edge | ✔ live | partly (if the file overlaps) | ✘ | none (git) | ✔ | ~½ day |
| B live edge | ✔ on contract paths | ✔ | ✘ | one jsonl file | ✔ | ~1 day |
| C code graph | ✔ | ✔ | ✔ symbol-level | index + observation log | ✔ | ≥1 week + upkeep |
| D one workflow | at merge only | at merge only | at merge only | none | ✔ but loses human gates | ~1 day, wrong shape |

### Recommendation

1. **Fix §5.2 first** — until the hook reads the worktree's own index, the decision graph is
   absent from precisely the sessions that run in parallel. One-line root change plus a live
   check.
2. **Build A and B together** as one small change to `decision-index.mjs` and the hook file.
   Both use git as the graph, both fire without the model's cooperation, both are reversible.
3. **Hygiene the graph exposed:** remove the four merged worktrees and their stacks, decide the
   three stale ones, add `.worktreeinclude` with `.env`, make `--check` exit 1 when stale.
4. **Measure before C:** track, per parallel pair, the count of "important" findings from
   `integrate-two`'s review and the number of "reality diverges" stops in `/implement`. If both
   stay non-zero after A + B, the residue is semantic and C is the next graph.

---

## 7. What graph engineering will not do

- It does not make two features that change the same behaviour safe to build at once. The
  plan-time "stack" verdict remains the right answer for those; a graph only makes the overlap
  visible sooner.
- A graph aligned to the base commit is history, not context (Graphify). Every artifact in A and
  B carries a sha for that reason.
- Sense-1 graphs move orchestration into code; they do not move *judgment* into code. The
  human gates in `/implement` are judgment, which is why Option D is the wrong shape.
- None of this replaces `integrate-two`. It moves the first comparison of the two pictures from
  merge time to edit time.

---

## Sources

Community definitions
- jigarjoshi.in — *Claude Code Graph Engineering: 14-Step Roadmap* (2026-07-22): https://jigarjoshi.in/blog/claude-code-graph-engineering-14-step-roadmap/
- mer.vin — *Claude Graph Engineering: 14-Step Roadmap* (2026-07-25): https://mer.vin/2026/07/claude-graph-engineering-14-step-roadmap-for-dynamic-workflows-and-subagent-fleets/
- movez.substack.com — *Graph Engineering with Claude* (2026-07-25): https://movez.substack.com/p/graph-engineering-with-claude-14
- doronkatz.com — *Loop, Graph, and Context Engineering* (2026-08-13): https://doronkatz.com/2026-08-13-loop-graph-context-engineering-article/
- SurrealDB — *Graph engineering is missing a graph* (2026-08-13): https://surrealdb.com/blog/graph-engineering-is-missing-a-graph
- FrankX — *Claude Agent Engineering: Loops, Workflows and Graphs* (2026-08-24): https://www.frankx.ai/blog/graph-engineering-claude-code
- Graphify — *Agent Swarm Codebase Context* (2026-07-17): https://graphify.net/ai-coding/agents/agent-swarm-codebase-context/

Context drift and code graphs
- CodeCtx paper — *Context Synchronization for Multi-Agent Workflows*: https://rybkr.com/papers/context-synchronization-for-multi-agent-workflows.pdf ; code: https://github.com/rybkr/codectx
- GraphCode: https://github.com/ericnerwala/GraphCode
- code-context-graph: https://github.com/tae2089/code-context-graph

Anthropic (checked for the term; it is absent)
- *Harnessing Claude's intelligence* (2026-04-02): https://claude.com/blog/harnessing-claudes-intelligence
- *Introducing dynamic workflows in Claude Code* (2026-05-28): https://claude.com/blog/introducing-dynamic-workflows-in-claude-code

Claude Code documentation (mechanics in §3)
- Workflows: https://code.claude.com/docs/en/workflows
- Worktrees: https://code.claude.com/docs/en/worktrees
- Subagents: https://code.claude.com/docs/en/sub-agents
- Agent teams: https://code.claude.com/docs/en/agent-teams
- Cross-session messaging: https://code.claude.com/docs/en/cross-session-messaging
- Hooks: https://code.claude.com/docs/en/hooks
- Memory and `.claude/rules/`: https://code.claude.com/docs/en/memory

Repo evidence
- `.claude/workflows/plan-two.js`, `.claude/workflows/integrate-two.js`
- `scripts/decision-index.mjs`, `.claude/hooks/decisions-for-file.mjs`, `.claude/settings.json`
- `.claude/commands/implement.md:18,26,28`
- `docs/engineering-memory.md:315-320, 1327-1329, 3018-3038`
- `git worktree list`; `git rev-list --left-right --count origin/main...<branch>` per worktree (2026-09-09)

---

## Addendum (2026-09-09, same day): the user overruled §6's recommendation

The user's response to this document: the code graph is the big gap, `plan-two` stops parallel
work on the smallest overlap, and worktree sessions are invisible. The follow-up research —
the code-graph landscape survey, a working drift query run on this repo's real branches, and the
revised recommendation — is in
[2026-09-09-code-graph-as-source-of-truth.md](2026-09-09-code-graph-as-source-of-truth.md).
Read that one; §6 above stands only as the record of what was recommended first and why.
