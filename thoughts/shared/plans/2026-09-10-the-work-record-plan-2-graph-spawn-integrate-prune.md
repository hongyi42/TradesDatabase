---
date: 2026-09-10
task: The shared work record, plan 2 — a function-level code graph read by the TypeScript compiler (task footprints from git plus the record, per-function change detection, sized overlaps), the pre-edit hook naming the functions a sibling or main changed, `spawn` (a parked finding into its own worktree after a sized overlap check that stops for the operator), `integrate` (what landed under you, then merge, gates, focused review), `prune` (merged worktrees removed safely), and plan-two / integrate-two retired
research: thoughts/shared/research/2026-09-09-code-graph-as-source-of-truth.md
status: draft
supersedes: nothing
---

## Overview

Plan 1 (`…/plans/2026-09-09-the-work-record-park-board-and-compaction-survival.md`) left spawn, the
overlap check and `integrate` to plan 2; this adds `prune` and retires the two-feature workflows.
Inputs: the three 2026-09-09 research docs; `…/findings/2026-09-10-settings-json-says-hooks-on-one-event-sh.md` (`files:` is a floor).

## Decisions

- **Scope (user, 2026-09-10)** — five phases: graph, hook, spawn, integrate (+ retirement),
  prune. Visualization via pixel-agents is **plan 3** (user), fed by this plan's data.
- **On an overlap, spawn stops (user)** — "warn, but don't automatically proceed… the operator should
  know how big these overlaps are first." Any item, LOW included, stops it with nothing created;
  `--proceed` continues; none → it proceeds. `/spawn` never adds `--proceed` without an explicit yes.
- **Report format (user approved the sample)** — per overlap: `HIGH|MED|LOW`, kind, `file › symbol`,
  lines changed per side, call sites, repo-wide importers. HIGH = same function changed/named by
  both; MED = a called signature changed; LOW = same file only · behaviour-only change · generated.
- **Launch (user)** — `spawn` prints `cd <worktree> && claude`; it opens nothing. **Retire (user)**
  — plan-two and integrate-two deleted; CLAUDE.md's two-feature section rewritten.
- **Function-level from the start** — file-level alone flags 96 of 135 modules via
  `database.types.ts` (research §4.2). These **(assistant)** calls follow.
- **Extractor = the TypeScript compiler, parse-only** — measured 2026-09-10: 135 modules, 402
  edges, 1,047 named imports, 0 unresolved in 168 ms; `require('typescript')` ≈ 70 ms. No checker.
- **Nothing stored (assistant)** — not the research's sha-stamped cache: at ~250 ms a recompute
  beats an invalidation rule, and a stored graph is what research §3.2 measured lying.
- **Footprint = committed since `base` ∪ uncommitted ∪ `files:`**, minus `supabase/config.toml`
  (second-stack.sh leaves it modified in every stacked worktree; every pair would overlap).
- **`base` is live, refs are shas (review)** — `git -C <checkout> merge-base HEAD <default ref>`,
  claim-time `fm.base` only as fallback: after `integrate`'s own merge a frozen base would fold
  main's files into the footprint forever. `HEAD` resolves in the subject's checkout, never main's.
- **Barrels are followed (review)** — `src/db/index.ts` re-exports 32 modules and 48 modules import
  through it; each imported name is traced through `export *` / `export {…} from` to its declarer.
- **Exported declarations only; signature vs body** — only exports cross files (an *internal*
  function shared by two tasks is LOW "same file"; a class is one symbol). Printed via `ts.createPrinter({
  removeComments: true })`: signature = bodies stripped, body = whole node; comment edits change neither.
- **`src/db/database.types.ts` is generated** — always LOW, with "regenerate after merging
  (`npm run gen:types:local`), never merge it by hand" (research §6.1 fix 2).
- **Library placement** — `scripts/code-graph.mjs`, dynamically imported by `work.mjs`'s graph verbs (so a
  fault never reaches `touch`/`packet`/`snapshot`) and by the hook; TS via `createRequire(import.meta.url)`.
- **Tests drive the CLI with `--json`** — TS tests can't import `.mjs`; e2e rule `work-cli.test.ts:3-6`.
- **Spawn layout** — `<main>/.claude/worktrees/<slug>`, branch `work/<slug>` unless `--branch`; no
  Supabase stack (four caused phantom failures, eng. memory 2026-08-19), no `.env` copy (live keys).
  **integrate merges, never rebases** — the branch may be pushed with a PR open.
- **prune safety** — dry run by default; never the main checkout, an active task, a session active
  in the last 24 h, uncommitted work (bar `supabase/config.toml`), or a branch without a merge
  proof by commit (not by name); `supabase stop` only where `project_id` differs from main's
  (engineering memory 2026-08-19: otherwise it stops the PRIMARY stack). The stop runs from a
  throwaway folder holding the worktree's config, never `--project-id`: Supabase CLI v2.107.0's
  `stop --project-id` filters on the id as typed ([stop.go#L19-L24](https://github.com/supabase/cli/blob/v2.107.0/apps/cli-go/internal/stop/stop.go#L19-L24)),
  while loading config.toml sanitises it — runs of other characters to `_`, leading `_.-`
  trimmed, cut to 40 ([config.go#L1043-L1053](https://github.com/supabase/cli/blob/v2.107.0/apps/cli-go/pkg/config/config.go#L1043-L1053),
  applied at [#L825-L829](https://github.com/supabase/cli/blob/v2.107.0/apps/cli-go/pkg/config/config.go#L825-L829));
  the npm CLI's `stop` proxies to that Go code ([stop.handler.ts](https://github.com/supabase/cli/blob/v2.107.0/apps/cli/src/legacy/commands/stop/stop.handler.ts#L5-L14)).
- **Final review (2026-09-11, assistant)** — fixed, each with a test that fails without it: a side
  git cannot read is a `?  not checked` item, never "none" (it stops spawn); a finding's `files:`
  are repo paths (`./`, absolute, directories expanded) and a path not in main stops spawn;
  re-exports are symbols, so a barrel dropping one is a removal to its importers; a subject with
  no checkout is read and resolved at its commit, not the main checkout's disk; an unannotated
  literal const's shape is its signature and its value its body (a prompt-text edit is LOW, not
  MED); mentions prefer backticked names and never `default`; prune keeps a worktree holding
  ignored files that are not regenerable, keeps one whose status git cannot read, and deletes a
  branch by the proven commit (`update-ref -d <ref> <sha>`), so a commit landing mid-run survives.
  **Kept as designed:** the hook's once-per-file marker — later news about a file already told
  of this session is not repeated (the plan's call: its fast path is what bounds an edit's cost).
- **Out of scope, parked at Phase 1 start** — `server.test.ts:197` `toHaveLength(17)` → membership
  assertion; split `src/mcp/server.ts`'s tool registry by domain (research §6.1 fixes 1, 3).

## Plain-language walkthrough

```
             git (all worktrees see every branch)          the record (.claude/work/)
                         │                                          │
                         ▼                                          ▼
   scripts/code-graph.mjs: footprint(task) = committed + uncommitted + files:
                           per changed .ts file: which EXPORTED functions changed — signature or body
                           who imports them, how many call sites
            │                     │                        │                      │
      pre-edit hook          work.mjs spawn           work.mjs integrate     work.mjs prune
  "sibling X changed      finding × every active    main since your base ×   merged + clean +
   the signature of f,    task → sized report →     your footprint; you ×    no task → remove
   which this imports"    STOP (or --proceed) →     siblings → merge, gates, (dry run first)
  "main moved: …"         worktree + claim + cmd    review the named edges
```

**Phase 1** — where two tasks overlap, how badly, how big (`npm run work -- overlap <a> <b>` names
functions, not files). **Phase 2** — the hook says "another session changed the signature of a
function this file uses" / "main changed it since you started". **Phase 3** — `spawn`: check a
parked finding against everything in flight; on any overlap stop and show sizes, else (or with
`--proceed`) worktree + claim + command. **Phase 4** — `integrate`: what changed under you, whom you
affect; old scripts retire. **Phase 5** — `prune`: remove finished worktrees safely.

## Secrets & env preflight

- **All phases:** none new. Tests need the existing `.env.test`; Phases 2–3 live checks need `claude` (installed).

## Phase 1: the graph library and `overlap`

### Changes required

**`scripts/code-graph.mjs`** (new; plain ESM; git via `execFileSync`, 3 s timeout, `null` on failure; `loadTs()`)
- Subject `{ label, checkout|null, ref, base, files, mentions, predicted }`, `ref`/`base` always shas.
  `subjectFromTask(main, fm, body)` (checkout = `fm.worktree` if it exists; ref = `git -C <checkout>
  rev-parse HEAD`, else `fm.branch`; `open` → predicted `{ ref: X, base: X }`, X = default ref,
  mentions = identifiers in title + body) and `subjectFromBranch(main, b)` live HERE, shared with the hook.
- `footprint(main, s)` → `git diff --name-only <base>...<ref>` ∪ `git -C <checkout> status --porcelain
  -uall` read **untrimmed** (`work.mjs:58-65`; `R a -> b` → `b`) ∪ `files`, minus `supabase/config.toml`.
- `exportedSymbols(ts, text, fileName)` → `Map<name, { sig, body, text }>` over exported
  `sf.statements` (`export default` → `default`): functions (body → `undefined` via
  `ts.factory.updateFunctionDeclaration`), classes (bodies/initialisers stripped, private members
  dropped), variables (annotation, else arrow params + return type, else initialiser),
  interfaces/types/enums (whole node). `.ts .tsx .mts .mjs .js`; never `*.test.ts`.
- `symbolDelta(main, ts, s, file)` → `[{ name, change: 'added'|'removed'|'signature'|'body', lines }]`;
  before = `git show <base>:<file>`, after = the checkout's file or `git show <ref>:<file>`;
  `lines` = multiset line difference of the two printed texts.
- `namedImports(ts, checkout, file, text)` → `[{ from, names, locals }]` via `ts.resolveModuleName`
  and the checkout's parsed `tsconfig.json` (default → `default`, type-only kept); each name
  followed through `export *` / `export {…} from` to its declaring file (depth ≤ 5, cycle guard);
  a namespace import matches every export. `callSites(ts, text, local)`; `importersOf(...)`.
- `overlaps(main, ts, a, b)` → items `{ severity, kind, file, symbol, detail, sizes }`, HIGH→LOW,
  per Decisions; a predicted side's "changed" names are the `mentions` found among the file's exports.

**`scripts/work.mjs`**
- `overlap <idOrBranch> <idOrBranch> [--json]` (async; `const graph = await import('./code-graph.mjs')`):
  a task id → `subjectFromTask`, anything else → `subjectFromBranch`.
- `renderOverlaps(items)` (the approved layout, shared by spawn/integrate); dispatch (986), usage (1009), header (16–23).

**`eslint.config.js:57`** — `files: ['scripts/work.mjs', 'scripts/code-graph.mjs']`.

**`src/work/code-graph.test.ts`** (new) — fixture per `work-cli.test.ts:68-93` plus `tsconfig.json`
(NodeNext), `src/lib.ts` (`f(a: number)`, `g()`, `type T`), `src/use.ts` (`import { f } from
'./lib.js'`, two calls), `src/barrel.ts` (`export * from './lib.js'`), `src/use2.ts` (`import
{ f } from './barrel.js'`), `src/db/database.types.ts`; worktrees A and B. Cases via `overlap
--json`: (a) A changes `f`'s parameters **uncommitted, via `writeFileSync`** (the Bash path), B
edits `use.ts` → MED `changed signature`, `callSites: 2`; (b) both change `g`, **committed** →
HIGH with both line counts; (c) A `g`, B `f` → LOW same file only; (d) comment-only → no item;
(e) both touch `database.types.ts` → LOW generated; (f) an `open` task naming `src/lib.ts` and
mentioning `g` vs A → HIGH; (g) B edits `use2.ts` → MED through the barrel.

### Automated verification
- [x] `npm run typecheck`, `npm run lint` (new file linted), `npm test`, `node --check scripts/code-graph.mjs`; cases (a)–(g) pass
      — 3036 passed, 12 skipped; `code-graph.test.ts` 22/22 (a–g plus 15 from review). Every fix
      mutation-checked: reverting it fails its own test (13 mutations, all caught).

### Live verification (agent-executable)
- Prerequisites: none (read-only git).
- [x] `npm run work -- overlap feat/the-decline-verb rescue/route-deeplink-staged` names symbols in research §4.2's
      five shared files in < 5 s (report the time); cross-check one item with `git diff origin/main...<branch> -- <file>`.
      — PASSED (fresh-context verifier): 1.26–1.51 s; all five files named with symbols; four items
      cross-checked by hand in git (two HIGH, two MED, incl. a 10-line count and a 5-sites-in-2-files
      count), no contradictions. It found one real gap, fixed: the rescue branch DELETES
      `watchers.ts`, which was reported "same file only" — now HIGH `deleted file`.

### Manual verification — none

## Phase 2: the pre-edit hook names changed functions

### Changes required

**`.claude/hooks/decisions-for-file.mjs`**
- Lines 34–40: `main` becomes async (`main(JSON.parse(input)).catch(quiet)`); every failure still exits 0.
- Split `alreadyTold` (218–230) into `wasTold` (read-only) and `markTold`; `main` returns early on
  `wasTold` **before** any record or graph work and marks only when it emits (review: the graph
  must not run for a file already reported).
- `recordLines` (175–204): a sibling (status `active`, `worktree` ≠ root, exists; subject via
  `subjectFromTask`) matches when `footprint(...)` has `rel` **or** `files` does; for `.ts` the SIBLING line (199–200)
  lists what it changed: `` — changed `f` (signature, 6 lines), `g` (body, 12 lines) in this file ``.
  OPEN FINDING lines unchanged.
- New `graphLines(abs, root, rel, evt)`: text = the file on disk, else `tool_input.content`; its
  `namedImports` × each active sibling's footprint → `symbolDelta` of the imported names:
  `signature`/`removed` → `` - SIBLING <wt> · <id> changed the signature of `f` (src/lib.ts), which
  this file imports — coordinate before relying on it ``; `body` → `` …changed what `f` does (N lines)… ``.
  Own active task: `{ ref: <default ref sha>, base: <live base> }`, `signature`/`removed` only →
  `` - MAIN MOVED since this task started: `f` (src/lib.ts) changed signature — merge origin/main first ``.
- Graph work only with an active sibling or an own task; lazy `await import(new URL('../../scripts/code-graph.mjs',
  import.meta.url))`. Closing sentence (116–119) explains the new lines; the once-per-file marker stays.

**`src/work/decisions-hook-graph.test.ts`** (new; harness as `decisions-hook.test.ts:23-70`, own
TS fixture). Cases: sibling's uncommitted signature change (no `touch`) → SIBLING + "changed the
signature of `f`" when B edits `use.ts`, and via the barrel from `use2.ts`; body-only → "changed
what `f` does"; `origin/main` advanced past B's base with a signature change → MAIN MOVED, gone
after B merges `origin/main`; nothing changed → no graph lines; a second edit in the same session
→ silent; the `hookSpecificOutput` shape asserted as today.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass (existing hook cases unchanged); new cases pass
      — 3049 passed, 12 skipped; `decisions-hook.test.ts` 13/13 untouched; `decisions-hook-graph.test.ts`
      13/13. Three review rounds added: a files-list floor that survives a throwing library, a 1.5 s
      graph budget + 1 s per-call git cap (one wedged sibling: 1.38 s, was 3.3 s; five: 2.4 s, was
      34 s at eleven), the marker checked before any sibling git work (sentinel-pinned), and orphaned
      worktree folders no longer blamed for main's edits. Each pinned by a mutation that fails its test.

### Live verification (agent-executable)
- Prerequisites: `claude` CLI; everything inside the implementation worktree.
- [x] In a probe worktree + probe task, change (uncommitted) the parameters of an exported function
      in a `src/db/*.ts` re-exported by `src/db/index.ts`. From the implementation worktree, `claude -p
      --allowedTools Edit` appends a comment to a file importing it **through `../db/index.js`** and quotes
      any "In flight right now" block verbatim → the signature line. Revert; drop and remove the probe.
      — PASSED (fresh-context verifier): `listManagersWithTelegram` (src/db/technicians.ts) widened in
      the probe; `src/calls/notify.ts` edited through `../db/index.js`. The session's transcript
      (cross-channel, not the model's words) carries `hook_additional_context` on `PreToolUse:Edit`:
      "SIBLING probe-hook-graph · 20260911-probe-hook-graph changed the signature of
      `listManagersWithTelegram` (src/db/technicians.ts), which this file imports — coordinate before
      relying on it". Cleanup verified. Side effect found and parked: the probe session's own `touch`
      and Stop hooks wrote its probe edit into the implementation task's record.

### Manual verification — none

## Phase 3: `spawn`

### Changes required

**`scripts/work.mjs`**
- Extract the body of `cmdClaim` (373–419) into `claimInto(main, id, here, force)`; `cmdClaim` calls it.
- `spawn <id> [--proceed] [--branch <b>]`: task must be `open` (else exit 1); `git fetch origin`
  (best effort; say so if it fails); ref = the first of `mergeBase`'s candidates (116–126) that
  exists; F = `subjectFromTask` (predicted); `overlaps(T, F)` for every active task T with a worktree.
  - Items and no `--proceed` → print `spawn <id> — STOPPED: N overlaps with active tasks. Nothing
    created.`, the report, `Re-run with --proceed to create the worktree anyway.`; **exit 2**.
  - Otherwise: refuse if the path or `refs/heads/<branch>` exists; `git worktree add --no-track
    <path> -b <branch> <ref>` (review: without it the upstream is `origin/main` and a bare `git
    push` fails); `claimInto`; append `## Handoff <ISO>` (as `cmdHandoff`, 584–602): "Spawned
    by work.mjs spawn into <path> on <branch> from <ref> <sha>. Overlap check: none." or the report
    plus "proceeded by the operator" — the new session's packet shows it as the latest handoff;
    print the path, `cd <path> && claude`, and "tests need a stack: `scripts/second-stack.sh <N>`
    inside it".

**`.claude/commands/spawn.md`** (new) — run spawn; on exit 2 show the report verbatim, name the
biggest item in one line, ask; never add `--proceed` without an explicit yes; never start a session.

**`.claude/commands/park.md`** — one line: a parked item is started in parallel with `/spawn <id>`.

**`src/work/code-graph.test.ts`** — spawn cases: a finding naming `src/lib.ts` and mentioning `g`
while A changed `g` → exit 2, HIGH, `git worktree list` unchanged, task still `open`; `--proceed`
→ worktree at `.claude/worktrees/<slug>`, branch `work/<slug>`, task `active` there with `base`,
handoff carries the report; a finding naming an untouched file → proceeds without the flag;
spawning an `active` task → exit 1.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass; spawn cases pass
      — 3058 passed, 12 skipped; 9 spawn cases (the plan's 4 plus 5 from three review rounds), each
      mutation-checked. Review fixes: the fetch can never prompt (GIT_TERMINAL_PROMPT=0, BatchMode
      ssh — verified by hand in a pty against a 401 server: plain `git fetch` printed "Username for",
      spawn returned in 0 s, no orphaned helper); every refusal (path exists, registered-but-missing,
      stale task at the path, branch exists) happens before anything is created; a failed add
      deletes only a branch it made and shows git's `fatal:` line; claim + handoff are one locked
      write, and a lock it cannot take undoes the worktree instead of reporting success; a finding
      that names no files stops as unchecked whenever another task is active.

### Live verification (agent-executable)
- Prerequisites: none beyond the repo; everything inside the implementation worktree.
- [x] With Phase 2's probe setup, park a probe finding naming the probe's file and mentioning its
      function → `spawn` stops with HIGH and creates nothing (`git worktree list` before/after);
      `--proceed` → the worktree and its board row exist (`npm run board`). Clean up both probes.
      — PASSED (fresh-context verifier, on the real repo): exit 2 in 1.45 s with one HIGH row
      (`src/calls/redact.ts › redactSensitive`); `git worktree list` byte-identical, no `work/*`
      branch, finding still open; `--proceed` → exit 0, `work/<slug>` with no upstream, task active
      there with the HIGH row in its handoff, board row present; the two real active tasks
      contributed nothing, as their footprints predict. Cleanup verified. This ran before the review
      fixes above, which leave that path unchanged and are pinned by the tests.

### Manual verification — none

## Phase 4: `integrate`, and the two workflows retired

### Changes required

**`scripts/work.mjs`** — `integrate [<id>]` (default: the active task of the cwd's worktree):
fetch; T = its subject; **landed under you** = `overlaps(M, T)` with M = `{ ref: <default ref
sha>, base: T.base (live) }`, each item with `git log --format='%h %s' <base>..<ref> -- <file>` (≤3);
**whom you affect** = `overlaps(T, S)` per other active task; then the steps: `git merge
origin/main` in the worktree · regenerate `database.types.ts` if flagged · the four gates ·
review only the listed items · re-run `integrate`. Read-only; exit 0.

**`.claude/commands/integrate.md`** (new) — run the verb; merge (never rebase); resolve only
mechanically-trivial conflicts, else `git merge --abort` and ask (the rule at
`integrate-two.js:73-78`, copied in without naming the retired file); gates; a fresh-context review subagent given only the report and the
diff of the named files; fix; gates again; never push, open or merge a PR without the user.

**Retire** — delete `.claude/workflows/plan-two.js`, `.claude/workflows/integrate-two.js`;
`CLAUDE.md:158-175` → "### Parallel work — park, spawn, integrate" (keeping second-stack.sh, the
no-subagent-`/implement` rule, stack cleanup); `CLAUDE.md:43` names `/spawn`; a dated retirement
entry in `docs/engineering-memory.md` (near 333–345) and session memory `concurrent-two-feature-rpi`.

**`src/work/code-graph.test.ts`** — integrate cases: `origin/main` advanced by a commit changing
`f`'s signature after B's `base`, B calls `f` → MED under "landed under you" with that commit's
subject; after B merges the default ref, a re-run lists nothing landed (review: the live base);
A and B both change `g` → HIGH under "whom you affect"; no branch ref moves (`git rev-parse`).

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass; integrate cases pass
      — 3065 passed, 12 skipped, build clean; 7 integrate cases (the plan's 3 plus 4 from review),
      each mutation-checked. Review fixes: commits looked up in main's CALLING files when the task
      changed the function; main's base taken from the task's guarded base (an orphaned folder
      no longer reports a false clean); no default branch fails instead of printing "none"; the
      base printed and in `--json` for `/integrate` to diff from after its merge; a side that only
      LISTS a file is described as listing it, never as changing it.
- [x] `grep -rn "plan-two\|integrate-two" CLAUDE.md .claude/commands .claude/workflows .claude/hooks` returns nothing
      — exit 1 (no matches); `.claude/workflows/` is gone. Also rewritten, found by review:
      `docs/onboarding.md` and the RPI rule in `docs/engineering-memory.md`.

### Live verification (agent-executable)
- Prerequisites: none.
- [x] `npm run work -- integrate` on the implementation task: every "landed" item's commit
      appears in `git log <base>..origin/main -- <file>` (cross-check by hand).
      — PASSED (fresh-context verifier): on this task, correctly "none" (base = origin/main
      4c2eb14, `git diff` confirms 0 files). Run also on the OTHER active task (planner copy,
      2 commits behind): 4 items — MED `plannerPrompt.ts › PLANNER_SYSTEM` + 3 LOW — each with
      commit `6793555 (#226)`, all matching `git log`, the importing line, and the +28-line size.
      Refs and working tree byte-identical before and after.
- [ ] Before opening the PR, the implementing session runs `/integrate` on its own task; evidence:
      the report, the merge commit, gate output. — runs at landing, after Phase 5.

### Manual verification — none

## Phase 5: `prune`

### Changes required

**`scripts/work.mjs`** — `prune [--apply]`, one row per `parseWorktrees` entry except the main checkout:
- `prunable` → REMOVE via `git worktree prune`.
- active task → KEEP; `lastSessionActivity` (836) under 24 h → KEEP "session active <age> ago"
  (review: never delete a live session's cwd); no **merge proof** → KEEP "unmerged". Proof =
  the tip is an ancestor of the default ref, or `gh pr list --state merged --head <b> --json
  number,headRefOid` has a PR whose `headRefOid` equals the tip (review: `mergedLabel` matches
  on the branch NAME alone, and spawn's `work/<slug>` names recur). `status --porcelain` lines
  other than ` M supabase/config.toml` → KEEP "uncommitted: N files"; else REMOVE, with "stop
  stack `<id>` from inside" when the worktree's `project_id` is readable and differs from main's.
- Default prints the table and `Nothing removed. Re-run with --apply to remove N.` With `--apply`,
  per REMOVE row: `npx supabase stop --no-backup` (cwd = worktree, only in the case above; failure
  → KEEP) → `git checkout -- supabase/config.toml` if modified → `git worktree remove <path>` (no
  `--force`) → `git branch -D` (safe only because of the proof; `-d` checks the main checkout's
  HEAD, not the default ref). Report each outcome.

**`src/work/prune.test.ts`** (new) — `PATH` gets a stub `gh` printing fixture JSON. Worktrees:
merged-clean, unmerged, merged-with-untracked-file, merged-with-active-task, merged-with-recent-
session (a fresh `.jsonl` under `HOME/.claude/projects/<encoded>`), squash-with-matching-oid,
squash-with-different-oid, merged with a `config.toml` `project_id` equal to main's. Dry run →
REMOVE only merged-clean, matching-oid and equal-id ("no own stack"), the rest KEEP with reasons,
nothing on disk changes; `--apply` → exactly those removed with their branches, the rest intact.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass; prune cases pass
      — 3069 passed, 12 skipped, build clean. Twenty-one worktree cases across two fixtures, every
      safety rule mutation-checked (all bite, bar `worktree remove` without --force — a backstop
      behind the uncommitted check, for a race no test stages). Three review rounds reshaped it:
      a session is seen through EVERY transcript of the repo, subagents included (one launched in
      the main checkout that entered the worktree writes under main's folder); the caller's own
      worktree, locked worktrees and main branches are never removed; the config.toml exemption
      is only for second-stack.sh's own rewrite (a fixture as rich as the real one caught
      `# pop3_port`); the worktree goes FIRST and its stack only after, once per stack, when every
      user of it is gone — stopped by the removed worktree's own config from a throwaway folder,
      because `stop --project-id` matches the raw id while `start` labels a sanitised, 40-char one.

### Live verification (agent-executable)
- Prerequisites: none (dry run only).
- [x] `npm run work -- prune` on the real repo: every REMOVE row is `yes`/`squash` in `npm run
      board`'s merged column; unmerged worktrees are KEEP; nothing is removed.
      — PASSED (fresh-context verifier, re-derived every row with its own git/gh/transcript
      evidence: 10/10 verdicts agree; worktrees, containers and statuses byte-identical after).
      REMOVE 6: portal-wt (registration only — its folder stays on disk), decision-index,
      nudge-cap, retraction-fold-impact, spine-voice (on origin/main), rung-9b (merged PR #214,
      head oid = tip). KEEP 4: the decline worktree and route-deeplink (uncommitted),
      multi-tech-assignment (no merge proof), work-record (prune runs from it). Re-run after the
      last review round: the same six.

### Manual verification
- [x] The operator reads the dry run and runs `npm run work -- prune --apply` on the real repo,
      then confirms with `git worktree list` and `docker ps` that only the listed worktrees and
      their stacks are gone. (Destructive on real checkouts: the operator's call, not the agent's.)
      — DONE by the operator 2026-09-11 (run as `node .claude/worktrees/work-record/scripts/work.mjs
      prune --apply` from the main checkout, the verb not being on main yet). `git worktree list`
      after: main, the decline worktree, multi-tech-assignment, route-deeplink, work-record — the
      four KEEPs exactly; the six REMOVEs gone with their branches (`git branch --list` empty for
      all five named ones); portal-wt's folder still on disk, as reported. `docker ps` by project:
      12 `TradesDatabase` (primary, untouched) + 12 `TradesDatabase-work-record`; no spine-voice or
      rung-9b containers.

*Pause after Phase 5 for the manual check. Phases 1–4 have no manual items.* — confirmed.
