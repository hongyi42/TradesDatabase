---
date: 2026-09-09
branch: main (researched from the feat/rung-10b2-citing-door-on-the-seat checkout, one unrelated commit ahead)
commit: 8f428bd
topic: The code graph as a source of truth for parallel implementation — the 2026 landscape of code-knowledge-graph tools (seven evaluated against one rubric), the three traps every one of them shares, a working cross-worktree drift query run on this repo's real branches with the TypeScript compiler as the extractor, why all three plan-two verdicts said "stack", why stale worktrees never close, and a revised decision brief
supersedes: nothing
amends: thoughts/shared/research/2026-09-09-graph-engineering-for-parallel-implementation.md
---

# The code graph as a source of truth

## The short version

**The user's steer (2026-09-09).** The execution graph (`plan-two`, `integrate-two`) is not
automatic and stops parallel work on the smallest overlap even though the two sessions sit in
separate worktrees; active worktree sessions are invisible and stale worktrees never close; the
**code graph** is the big gap behind context drift. Direction to explore: an extractor pulls
code entities and relationships into a graph database that becomes the source of truth for the
agents. Which popular repos do this?

**Six findings.**

1. **The category is hot, and the popular tools are not what the discourse describes.** Four
   repos created in the last twelve months sit between 42k and 116k stars. None of the big four
   is a "server graph database." They are embedded indexes (SQLite, LadybugDB, JSON files) per
   checkout, kept fresh by a watcher or a git hook, served to the agent over MCP plus a Claude
   Code hook. The Neo4j/Memgraph family exists (code-graph-rag 5.1k, Potpie 5.7k, FalkorDB
   code-graph 348) and is the smaller, older shape.
2. **None of them answers the parallel-worktree question.** The drift question is "which symbols
   did branch A change, and does branch B build on any of them?" Every tool answers "what
   depends on symbol X" and two answer "what changed between main and *my* working tree"
   (GitNexus `detect_changes`, codebase-memory `detect_changes`; code-graph-rag's `cgr check`
   adds symbol-level deltas). No tool compares two branches, and every tool keeps one index per
   checkout with no sharing across worktrees.
3. **Every index is a cache, and caches lie.** CodeGraph measured **4.3% wrong edges** in its own
   live, auto-synced index and decided not to surface a drift metric. codebase-memory has an
   open high-priority bug where a live session keeps serving the pre-change graph. Graphify's
   graph is commit-gated and blind to uncommitted edits. The one tool with no staleness problem
   (Serena) has no index: it asks the TypeScript language server.
4. **This repo's import style breaks most of them.** Every relative import here is written
   `./x.js` for a file named `x.ts` (785 such imports). CodeGraph resolves none of them until
   its next release; CodeGraphContext never resolves them; Graphify handles `.ts` but not
   `.tsx`/`.d.ts`; GitNexus, codebase-memory and code-graph-rag strip the extension; Serena and
   the compiler get it exactly right.
5. **For this repo the exact graph is a one-second computation.** 132 non-test modules, 390
   import edges, 0 unresolved, 1.2 s, using the TypeScript compiler already in `node_modules`
   (§4). I ran the cross-branch drift query on three real branch pairs. It found the drift: the
   stale `feat/the-decline-verb` worktree edits four files that were built on top of files rung
   10b changed, and shares five files outright with `rescue/route-deeplink-staged`.
6. **The plan-two record and the user's experience agree on the outcome and disagree on the
   cause.** All three verdicts ever written say "stack"; each cites a same-fact conflict, and all
   three run through the same hub files: `src/mcp/server.ts` (7,639 lines, 50 tool definitions,
   38 commits in 30 days), an absolute tool-count assertion in `src/mcp/server.test.ts`, and the
   generated `src/db/database.types.ts`, on which **96 of 132 modules** transitively depend.

**Revised recommendation (§7).** Build the code graph, but build it in the repo on the
compiler, not in a database: a `scripts/code-graph.mjs` that derives the import graph (then the
symbol graph) from `tsc`'s own resolver, stamps it with the commit sha, and answers the
cross-worktree drift query; wire it into the pre-edit hook, into `plan-two`'s verdict, and into
`integrate-two`'s review; ship a worktree board and a prune command. Fix the three hub problems
so a dependency-aware verdict can say "parallel." Adopt codebase-memory-mcp (MIT, no telemetry)
only if the agents need graph *navigation* on top; keep a graph database for cross-repo scale.

---

## 1. What "graph database as source of truth" means once you look at the tools

```
The 2025 shape (what the discourse still describes)      The 2026 shape (what the popular tools do)
──────────────────────────────────────────────────       ─────────────────────────────────────────
 extractor script                                          extractor (tree-sitter, native)
      │  Cypher writes                                          │  per checkout
      ▼                                                         ▼
 Neo4j / Memgraph / FalkorDB  (docker daemon)              .codegraph/*.db  .gitnexus/  graphify-out/
      │  Cypher reads                                           │  MCP tools (1–17)  +  Claude Code hook
      ▼                                                         ▼
 agent asks the DB                                         agent asks the index; hook nudges it to
                                                           ("use the graph, not grep")
 code-graph-rag (5.1k) · Potpie (5.7k) · FalkorDB (348)    Graphify 116k · CodeGraph 70k · GitNexus 47k
                                                           codebase-memory 43k · Serena 29k (no index)
```

The move to embedded stores happened for the reason that matters here: one process per
checkout, no daemon to babysit, nothing shared to lock. It also means none of them was designed
for two checkouts of one repo asking about each other.

## 2. The landscape, verified 2026-09-09

Stars, dates and licenses from the GitHub API; everything else from each project's README,
docs, source and issue tracker (per-repo citations in §9). Seven tools evaluated on one rubric.

| Tool | Stars · created · license | Extractor | Store · freshness | Worktrees | "What changed" query | `./x.js` → `x.ts` | Telemetry |
|---|---|---|---|---|---|---|---|
| **Graphify** (Graphify-Labs) | 116k · 2026-04 · Apache-2.0 | tree-sitter; LLM only for docs/PDF | JSON in `graphify-out/`, **committed**; `post-commit` hook rebuild (lags seconds); optional `watch` (3 s) | hooks **skip linked worktrees by design**; read commands fail without a local `graphify-out/` (#2008, fix PR unmerged) | none by ref; `affected <symbol>`; PR impact via `gh` | `.ts` yes; `.tsx`/`.d.ts` no (#2849) | none |
| **CodeGraph** (colbymchenry) | 70k · 2026-01 · MIT | Rust kernel + tree-sitter | SQLite per checkout + **daemon**; watcher 2 s debounce; staleness banner; connect-time catch-up | one db + one daemon per worktree, no sharing (#1236); "borrowed index" warning for nested worktrees | `affected` = tests reachable from `git diff --name-only`; `impact <symbol>`; no ref-to-ref | **broken in every release** (0 callers with full confidence); fix merged 2026-09-08, unreleased | **on by default** (`DO_NOT_TRACK=1`) |
| **GitNexus** (abhigyanpatwari) | 47k · 2025-08 · **PolyForm Noncommercial** | tree-sitter; 3-tier confidence | LadybugDB per checkout; manual `analyze`; `--watch` 300 ms; hook nudges after commit/merge/pull only | one index per checkout; an un-analyzed worktree **silently answers from the main checkout's index** | `detect_changes({scope:"compare", base_ref})` = base → this working tree; `impact` with depth/confidence | explicit strip; dogfoods its own NodeNext repo | `@scarf/scarf` install analytics + npm update check, undisclosed |
| **codebase-memory-mcp** (DeusData) | 43k · 2026-02 · MIT | tree-sitter + C "hybrid LSP" | SQLite per checkout path in `~/.cache`; **shared per-account daemon** polls git every 5–60 s | worktrees recognised (branch roots, canonical root) but **each is a separate full graph**; `auto_index` off by default; overlay indexing is an open design issue (#573) | `detect_changes(base_branch\|since)` = merge-base → HEAD; snapshot compare landed as a building block (#525 open) | by construction (extension-blind), untested; `.mjs` needs mapping | none (strace-verified in CI) |
| **Serena** (oraios) | 29k · 2025-03 · MIT | **tsserver over LSP**, no extractor | no index; live | one server per session, rooted at the worktree (`--project-from-cwd`) | none; `find_referencing_symbols` one hop; compose with `git diff` | exact (the compiler resolves) | startup ping (`SERENA_USAGE_REPORTING=false`) |
| **code-graph-rag** (vitali87) | 5.1k · 2025-06 · MIT | tree-sitter + 2,526 lines of hand-written TS resolvers (maintainer: "a standing source of drift", #1180) | **Memgraph + Qdrant in Docker**, one shared graph; hash-incremental; stale-edge bugs open (#1649, #1794) | two worktrees = two projects in one DB; no git awareness (#1489) | **yes**: `cgr check --base origin/main` → `symbols.added/removed/changed`, `dangling_callers`, `signature_changes`, `tests_reaching` (arity checks Python-only) | strips `.js` | none |
| **CodeGraphContext** | 4.2k · 2025-08 · MIT | tree-sitter, **name-keyed** import map | FalkorDB Lite / Kuzu embedded (single-process) or Neo4j | per-repo mode isolates; embedded DB locks across processes | none | never resolved | none |

Not evaluated in depth: code-review-graph (31k, review-focused), Potpie (5.7k, Neo4j agents),
cognee and Graphiti (30k each, agent *memory* graphs, not code-specific), claude-context (12.5k,
vector + BM25). Adjacent and worth knowing: **dependency-cruiser** (7.2k, MIT) already ships
`--affected <git revision>` and `--reaches <regex>` over a TypeScript-resolved module graph;
`madge` (10k) and `knip` (12k) sit on the same compiler-derived graph.

## 3. Three traps every tool shares

### 3.1 One index per checkout; no tool knows about the sibling

Graphify's hooks refuse to run in a linked worktree. CodeGraph wants `codegraph init` in each
worktree and runs a daemon per worktree. GitNexus falls back to the main checkout's graph when a
worktree was never analyzed, which is worse than an error. codebase-memory recognises worktrees
in metadata and still builds a separate full graph per path. The question "does B build on
something A changed" is outside every tool's model: they have at most one working tree and one
base ref.

### 3.2 Freshness is a cache-invalidation problem, and the caches are measured to lie

| Tool | The freshness story | What the project itself reports |
|---|---|---|
| CodeGraph | "The index is never stale, and there is nothing to re-run." | `docs/benchmarks/index-drift-cg33.md`: "A live, auto-sync-maintained index **does not converge** to a clean full rebuild ... 4.3% of distinct edges were wrong ... nothing warns." Decision to surface a drift metric: "no." |
| codebase-memory | git-polling watcher, incremental by content hash | #1296 (open, priority high): "the live MCP session that registered the watcher keeps serving the pre-change graph indefinitely." #1429: false freshness on branch switch. |
| Graphify | rebuild on `post-commit` | uncommitted edits invisible unless `watch` runs; #2841 "No detection of a stale or partially-built graphify-out/." |
| code-graph-rag | hash-incremental reingest | #1649: "The staleness warning's rebuild remedy leaves stale edges behind: 12 of 82 survive." |
| Serena | none: asks tsserver | #1937: partial results for ~2 s while the project loads. |

This is the SurrealDB requirement ("what was true when, and who said so") in practice: a graph
without a commit stamp and a rebuild rule is *historical evidence, not current context*
(Graphify's swarm guide). It is also the answer to "graph database as source of truth": the
source of truth is the code as the compiler sees it; anything stored is derived, and must say
from which commit.

### 3.3 The ESM `.js` specifier

785 relative imports in `src/` name a `.js` file that exists only as `.ts`. The compiler maps
them under `NodeNext`. Tools that re-implement resolution each handle it differently (table in
§2), and CodeGraph's failure mode is the dangerous kind: it does not error, it name-matches, and
"a default import or an aliased import silently reports 0 callers with full confidence" (its own
PR #1484). A graph that is wrong with full confidence is the drift it was meant to catch.

## 4. The drift query, run on this repo

### 4.1 What the extractor is

The TypeScript compiler. It is already installed (6.0.3), it resolves `NodeNext` exactly, and it
is what `npm run typecheck` trusts. The script below builds the module graph of `src/` with
`ts.resolveModuleName`, then answers the cross-branch question using git, which all worktrees
share.

```js
// code-graph trial, 2026-09-09 — run from the repo root with NODE_PATH=$PWD/node_modules
const ts = require('typescript'); const path = require('path'); const { execSync } = require('child_process');
const root = process.cwd();
const cfg = ts.readConfigFile(ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json'), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
const rel = f => path.relative(root, f).split(path.sep).join('/');
const rev = new Map(); const mods = [];
for (const sf of program.getSourceFiles()) {
  const src = rel(sf.fileName); if (!src.startsWith('src/') || src.endsWith('.test.ts')) continue; mods.push(src);
  const visit = node => {
    let spec = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) spec = node.moduleSpecifier.text;
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) spec = node.arguments[0].text;
    if (spec && spec.startsWith('.')) {
      const r = ts.resolveModuleName(spec, sf.fileName, parsed.options, ts.sys);
      if (r.resolvedModule) { const tgt = rel(r.resolvedModule.resolvedFileName); if (!rev.has(tgt)) rev.set(tgt, new Set()); rev.get(tgt).add(src); }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
const dependents = seeds => { const seen = new Set(seeds), q = [...seeds]; while (q.length) { const f = q.shift(); for (const p of rev.get(f) || []) if (!seen.has(p)) { seen.add(p); q.push(p); } } seeds.forEach(s => seen.delete(s)); return seen; };
const changed = b => execSync(`git diff --name-only origin/main...${b} -- src`).toString().split('\n').filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'));
const [A, B] = process.argv.slice(2); const a = changed(A), b = changed(B), da = dependents(a), db = dependents(b);
console.log({ sameFile: b.filter(f => a.includes(f)), bBuildsOnA: b.filter(f => da.has(f)), aBuildsOnB: a.filter(f => db.has(f)) });
```

### 4.2 Results

Graph: **132 modules, 390 relative-import edges, 0 unresolved, 1.2 s** wall clock.
(dependency-cruiser with the project's compiler on `NODE_PATH` agrees: 132 modules, 375 edges,
0 unresolved; its `--affected origin/main` on the current one-commit branch returns 70 affected
modules. Without `NODE_PATH` it silently falls back to its JavaScript parser and resolves
nothing, which is the same trap as §3.3 wearing a different hat.)

Fan-in, the modules with the most transitive dependents:

| dependents | module |
|---|---|
| 96 | `src/db/database.types.ts` (generated) |
| 94 | `src/db/client.ts` |
| 75 | `src/db/technicians.ts` |
| 73 | `src/db/customers.ts` |
| 72 | `src/db/jobs.ts` |
| 72 | `src/db/visits.ts` |
| 69 | `src/email/format.ts` |
| 68 | `src/db/reviewItems.ts` |

The cross-branch query, A = `feat/the-decline-verb` (8 changed source files, 5 dependents):

| B | B changed | same file as A | B edits something built on A | A edits something built on B |
|---|---|---|---|---|
| `worktree-multi-tech-assignment` | 0 src files | 0 | 0 | 0 |
| `rescue/route-deeplink-staged` | 37 | **5** (`nudgeKinds`, `watchers`, `compose`, `planner`, `plannerPrompt`) | **1** (`src/jobs/lifecycle.ts`) | **2** (`plannerCorpus`, `plannerEvalGraders2`) |
| `feat/rung-10b-new-caller` (merged #214) | 17 | **2** (`planner`, `plannerPrompt`) | 0 | **4** (`plannerCorpus`, `plannerEvalGraders2`, `nudgeKinds`, `watchers`) |

The last row is context drift in its literal form: the decline-verb worktree, 121 commits behind,
edits four modules that import from files rung 10b has since changed. Nothing in the repo would
have said so until a merge. The query says so in one second, from any worktree, without an
index, a daemon, or a database.

### 4.3 What this is and is not

It is file-level: "B edits a module that imports from something A changed." It is not yet
symbol-level: "A changed the signature of `recordCaller` and B calls it." The compiler gives
that too. Phase 2 of the build in §7 hashes each exported declaration's *signature* (the
declaration text without its body, or the checker's type string) and *body* separately, exactly
the CodeCtx interface-hash / body-hash split, and narrows the import edges to the named
bindings each file actually imports. Then "B builds on A" means "B imports a name whose
signature hash changed on A," which is the belief-invalidation edge the paper describes, with
the compiler as the extractor instead of tree-sitter.

## 5. "Source of truth": what it can mean here

- **The code as the compiler sees it is the truth.** A stored graph is a projection of one
  commit. Stamp every stored graph with `git rev-parse HEAD` and treat a graph whose sha is not
  the checkout's HEAD as stale by definition; recompute (1 s) rather than patch.
- **Git is already the shared store across worktrees.** Every worktree reads every branch's
  objects; `git diff --name-only origin/main...<branch>` works from any of them. The drift
  query needs no shared database because the *changes* are already shared; only the *graph*
  is derived per checkout.
- **A database earns its place at cross-repo scale, or when non-code entities join the graph.**
  Decisions (`thoughts/`), engineering-memory entries and code symbols in one store, queried
  together, is a real idea; `thoughts/by-file.json` is a 96-key prototype of it. If that day
  comes, Node 22's built-in `node:sqlite` is what the 70k-star tool chose, and it needs no
  daemon. Not Neo4j, not Memgraph, and never the pilot's Postgres.

## 6. The two process complaints, with the record

### 6.1 "Even the smallest overlap gets flagged"

The three `plan-two` verdicts ever written (2026-07-04, 2026-07-17, 2026-08-15) all say STACK.
None stacked on a trivial overlap: each names a *same-fact* conflict. But every one of those
conflicts lives in the same three places:

| Hub | Measured | How it forces "stack" |
|---|---|---|
| `src/mcp/server.ts` | 7,639 lines; imports 36 modules; 50 tool definitions; 129 commits, 38 in the last 30 days | every feature adds a tool → edits the tool table and the dispatch switch → same symbol |
| `src/mcp/server.test.ts` | 9,009 lines; `expect(names).toHaveLength(17)` at line 192 | two branches each bump the count; "both pass alone and both are wrong together" (2026-07-04 verdict). Still there. |
| `src/db/database.types.ts` | generated; 3,853 lines; 36 commits in 30 days; **96 of 132 modules depend on it** | two migrations → two regenerations → the second one silently lacks the first one's column |

So the user's experience (parallel never happens) and the record (three reasoned stacks) are the
same fact seen from two sides. A finer overlap oracle alone would not have said "parallel" for
those pairs; the hubs would. Three fixes make the hubs stop forcing stacks, and then a
dependency-aware verdict can say "parallel" honestly:

1. Replace `toHaveLength(N)` on the tool roster with a membership assertion (the names each
   role must and must not see). No count, no collision.
2. Treat `database.types.ts` as *regenerate at integration, never merge*: add it to
   `integrate-two`'s merge rules (run `gen:types --local` after each merge) and to the hook as a
   standing note.
3. Split the tool registry in `server.ts` by domain, so a feature registers its tools in its own
   module and the hub only aggregates. The fan-in table above is the before/after measurement.

Then change `plan-two`'s Compare node: exact-path intersection becomes informational; the
verdict is "parallel" unless the two footprints touch the *same exported symbol*, a generated
file, or a count assertion; and the dependency query (§4) adds "A's list contains a dependent of
B's list" as a named risk rather than a blocker.

### 6.2 "I have little idea of the active worktree sessions, and stale ones don't close"

Measured 2026-09-09: nine worktrees; four on branches already merged; three unmerged and
121–288 commits behind; one squash-merged and still present.

Why they never close: Claude Code's periodic sweep removes only worktrees it created for
*subagents and backgrounded sessions*, keeps any worktree "you haven't backgrounded, whatever
its age," keeps any worktree without its marker, and keeps any with commits not on the remote.
Seven of the nine here carry no marker (`CLAUDE_BASE` exists in two), and squash merges leave
every branch's commits "unpushed" in git's eyes forever. Nothing in the repo prunes.

Why sessions are invisible: `ListAgents` shows five TradesDatabase sessions with names and ages
and **no working directory**. `~/.claude/projects/` encodes the cwd in the directory name but
holds only two directories for this repo. `lsof` on the running Claude processes does show the
cwd (one shell was live in `.claude/worktrees/rung-9b` during this research). A board is a
join of things that already exist:

```
npm run worktrees
  path · branch · behind/ahead origin/main · merged? (incl. squash, via `gh pr list --state merged --head`)
  · last commit age · Claude marker · live session? (lsof cwd + projects-dir mtime)
  · local Supabase project_id + container up? · drift vs each other worktree (§4 query)
npm run worktrees:prune [--dry-run]
  removes merged worktrees: stop that worktree's Supabase stack from INSIDE it first
  (engineering-memory 2026-08-19: `supabase stop` acts on the cwd's project_id), then
  `git worktree remove`, then `git branch -d`
```

## 7. Decision brief

The decision is **where the code graph lives and who computes it**.

### Option 1 — the compiler graph, in the repo (recommended)

`scripts/code-graph.mjs`, no dependency beyond `typescript`.

- **Phase 1, file-level (a day):** the §4 script productised: module graph from
  `ts.resolveModuleName`, sha-stamped JSON cache under `.claude/graph/` (gitignored),
  commands `drift <branchA> <branchB>`, `dependents <file>`, `fan-in`. The pre-edit hook adds
  "sibling branch X changed something this file imports (N hops)". `plan-two`'s Compare node
  gets the dependency check and the new verdict rule (§6.1). `integrate-two`'s review agent
  receives the cross-feature edge list instead of hunting the whole diff.
- **Phase 2, symbol-level (two to three days):** per exported declaration, signature hash and
  body hash; import edges narrowed to named bindings; `drift` reports changed *symbols* and the
  sibling's importers of each. This is CodeCtx for TypeScript with an exact resolver.
- **Phase 3, the board (half a day):** `npm run worktrees` and `worktrees:prune` (§6.2).

Catches: same-file, dependency and (phase 2) signature drift between two live worktrees, at
edit time. Misses: behaviour change without a signature change, which stays `integrate-two`'s
job. Cost of being wrong: none; it is a query over git and the compiler.

### Option 2 — codebase-memory-mcp for navigation (optional, additive)

MIT, single binary, no telemetry, 15 MCP tools, Claude Code hooks, `detect_changes` from a base
ref. Use it if the agents keep grepping and reading whole files; it is the token-saver its
paper measures (10x fewer tokens per question, at 90% of the answer quality). Conditions: run
`install --dry-run` first (it edits `~/.claude.json` and installs hooks for 45 clients); it
starts a per-account daemon; each worktree is a separate graph you must index; the stale-session
bug (#1296) means "reindex before trusting a negative answer." It does not do Option 1's job.

### Option 3 — Serena for symbol operations (optional, additive)

No index to drift, per-worktree by construction, exact resolution. Its cost is adoption: Claude
Code's built-in tools crowd it out unless the system prompt is overridden, and answers are
partial for ~2 s after start. Set `SERENA_USAGE_REPORTING=false`.

### Option 4 — CodeGraph after its next release

The best freshness machinery on paper and a `UserPromptSubmit` hook that front-loads context.
Wait for the release that includes the `.js`-specifier fix, turn telemetry off, accept one
daemon per worktree, and schedule full rebuilds because of the measured 4.3% drift.

### Not recommended

- **GitNexus:** PolyForm Noncommercial forbids use in building a commercial product without a
  licence from Akon Labs; also ships undisclosed install analytics. Technically the best
  TypeScript fit and the best change query short of code-graph-rag.
- **code-graph-rag:** the only tool with a symbol-level base-vs-tree delta, behind a Docker
  Memgraph daemon and a resolver its maintainer wants to replace.
- **CodeGraphContext:** name-keyed imports, no resolution of this repo's imports at all.
- **A server graph database as the source of truth:** for 132 modules it is a daemon in front
  of a one-second computation, and it inherits §3.2. Revisit at cross-repo scale.

### Trade-offs at a glance

| | Cross-worktree drift | Symbol-level | Fresh by construction | New infra | Licence / privacy | Cost |
|---|---|---|---|---|---|---|
| 1 compiler graph in repo | ✔ | phase 2 | ✔ (sha-stamped, 1 s recompute) | none | n/a | ~4 days across 3 phases |
| 2 codebase-memory | ✘ | ✔ within one tree | ✘ (#1296) | daemon + hooks | MIT, none | hours + operating rule |
| 3 Serena | ✘ | ✔ | ✔ (no index) | one process per session | MIT, opt-out ping | hours + prompt override |
| 4 CodeGraph | ✘ | ✔ within one tree | measured 4.3% drift | daemon per worktree | MIT, telemetry default on | wait for release |
| graph DB (Neo4j/Memgraph) | ✘ | ✔ | ✘ | Docker daemon | varies | days + upkeep |

### What changed since the first document

The first document (§6 there) recommended two small hooks and deferred the code graph on cost.
The user overruled the deferral. The evidence gathered since supports the override on one point
and refines it on another: the drift query *does* find real drift in this repo's worktrees
today (§4.2), so the graph is worth building now; and the cheapest correct extractor is the
compiler already installed, so "graph database" is not the shape it should take.

## 8. What to measure

- `plan-two` verdicts: fraction "parallel" after the hub fixes and the new rule (today: 0 of 3).
- `integrate-two`: important cross-feature findings per pair (the graph should move them to
  edit time).
- `drift` hits surfaced by the hook per parallel pair, and how many were real.
- Worktree count and median age from the board; target: nothing merged stays.

## 9. Sources

Tools (README, docs, source and issues read 2026-09-09; stars and licences via the GitHub API)
- Graphify: https://github.com/Graphify-Labs/graphify — issues #2008, #2841, #2654, #3258, #2849, #3346, #3436, #146; PR #2064; `graphify/extractors/engine.py`, `graphify/hooks.py`, `graphify/serve.py`
- CodeGraph: https://github.com/colbymchenry/codegraph and https://colbymchenry.github.io/codegraph/ — `docs/benchmarks/index-drift-cg33.md`, `TELEMETRY.md`; issues #1236, #155, #391, #1705, #1279, #1553, #1227, #1816; PRs #1484, #1767
- GitNexus: https://github.com/abhigyanpatwari/GitNexus — `LICENSE` (PolyForm Noncommercial 1.0.0, https://polyformproject.org/licenses/noncommercial/1.0.0/), `ARCHITECTURE.md`, `AGENTS.md`, `standard.ts` under `gitnexus/src/core/ingestion/import-resolvers/`, `index-content-drift.ts` under `gitnexus/src/core/`, `tools.ts` under `gitnexus/src/mcp/`, `gitnexus-claude-plugin/hooks/`; issues #76, #510, #1841, #1903 (PR #2067), #2974, #3127; `@scarf/scarf` in `gitnexus/package.json` (https://github.com/scarf-sh/scarf-js)
- codebase-memory-mcp: https://github.com/DeusData/codebase-memory-mcp and https://deusdata.github.io/codebase-memory-mcp/ — paper https://arxiv.org/html/2603.27277v1; `src/watcher/watcher.c`, `src/git/git_context.c`, `src/pipeline/fqn.c`; issues #1296, #1429, #1339, #573, #525, #1917, #1997; PR #401
- Serena: https://github.com/oraios/serena — `docs/02-usage/999_additional-usage.md`, `src/solidlsp/language_servers/typescript_language_server.py`; issues #1937, #1939, #1496, #1491
- code-graph-rag: https://github.com/vitali87/code-graph-rag — `docs/architecture/structural-delta.md`, `codebase_rag/parsers/js_ts/module_paths.py`; issues #1180, #1649, #1794, #1489
- CodeGraphContext: https://github.com/CodeGraphContext/CodeGraphContext — `src/codegraphcontext/tools/indexing/pre_scan.py`; issues #736, #412
- dependency-cruiser: https://github.com/sverweij/dependency-cruiser — `doc/cli.md` (`--affected`, `--reaches`), `doc/faq.md` (TypeScript compiler must be resolvable)

Comparisons and background
- Ry Walker, *Code Intelligence Tools for AI Agents Compared* (2026-06): https://rywalker.com/research/code-intelligence-tools
- *Code Knowledge Graphs: How to Evaluate Graphify, GitNexus, and CodeGraph* (2026-07-24): https://dev.to/sayed_ali_alkamel/code-knowledge-graphs-how-to-evaluate-graphify-gitnexus-and-codegraph-409i
- CodeCtx, *Context Synchronization for Multi-Agent Workflows*: https://rybkr.com/papers/context-synchronization-for-multi-agent-workflows.pdf
- Graphify swarm guide (2026-07-17): https://graphify.net/ai-coding/agents/agent-swarm-codebase-context/
- SurrealDB, *Graph engineering is missing a graph* (2026-08-13): https://surrealdb.com/blog/graph-engineering-is-missing-a-graph
- Claude Code worktrees (sweep rules, markers, hook paths): https://code.claude.com/docs/en/worktrees

Repo evidence (2026-09-09)
- `thoughts/shared/plans/2026-07-04-feature-A-manager-telegram-binding.md`, `…/2026-07-04-feature-B-outbound-composio-sessions.md`, `…/2026-07-17-feature-A-technician-optional-bookings-and-confirmation-policy.md` (the three `## Parallel/stack verdict (plan-two)` sections)
- `src/mcp/server.test.ts:192`; `wc -l`, `git log --since=30.days --name-only` on `src/mcp/server.ts`, `src/db/database.types.ts`
- `git worktree list`; `.git/worktrees/*/CLAUDE_BASE`; `ListAgents`; `lsof -a -p <pid> -d cwd`; `~/.claude/projects/`
- The §4 script run against `feat/the-decline-verb`, `rescue/route-deeplink-staged`, `feat/rung-10b-new-caller`
