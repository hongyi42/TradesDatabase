---
date: 2026-09-11
task: split src/mcp/server.ts's tool registry by domain so features stop colliding in the hub
status: complete
origin: 20260911-implement-plan-2-the-code-graph-spawn-in
files: src/mcp/server.ts, src/mcp/server.test.ts, src/mcp/tools/captures.ts
supersedes: nothing
---

## Files

- src/mcp/server.ts
- src/mcp/server.test.ts
- src/mcp/tools/captures.ts

## Notes

src/mcp/server.ts is 7,847 lines with 50 tool definitions and 38 commits in 30 days; every feature adds a tool by editing the same tool table and dispatch switch, which is what forced all three plan-two verdicts to "stack". Research 2026-09-09 code-graph-as-source-of-truth §6.1 fix 3: each domain registers its tools in its own module and the hub only aggregates. Parked from plan 2 as out of scope; it is a refactor that deserves its own plan.

## ABSORBED 2026-09-12 — task 20260911-server-test-ts-tohavelength-17-makes-eve (user decision)

That finding is dropped and archived INTO this one, not lost. Its note, verbatim:

  src/mcp/server.test.ts:197 asserts `expect(names).toHaveLength(17)` on the tool roster. Every
  feature that adds a tool bumps that count, so any two parallel tasks that each add a tool both
  edit the same line and "both pass alone and are wrong together" (plan-two verdict 2026-07-04).
  Research 2026-09-09 code-graph-as-source-of-truth §6.1 fix 1: replace the count with a
  membership assertion (the names each role must and must not see). Parked from plan 2 (the code
  graph) as out of scope.

WHY IT WAS FOLDED IN (user, 2026-09-12): registering tools per domain moves that count by
construction, so the split cannot land without touching line 197 anyway. Run as two parallel
tasks they would have manufactured exactly the collision the absorbed finding describes. `files:`
now names src/mcp/server.test.ts as well, so the pre-edit hook and every `overlap`/`spawn` check
see both files.

DO BOTH IN ONE CHANGE: replace the count with a membership assertion as part of the split, rather
than re-pinning a new number that the next tool-adding task has to move again.

## Decisions

BUILT 2026-09-12, gates green (typecheck/lint/build clean; 3,105 tests pass, 12 skipped —
the pre-refactor baseline was 3,104, the extra one is main's). Three commits on
`work/split-src-mcp-server-ts-s-tool-registry`, main merged in at 2dd9a54.

1. **server.ts 7,847 -> 919 lines.** 47 of 50 tool definitions and all 48 dispatch cases moved
   into `src/mcp/tools/<domain>.ts` (captures, customers, schedule, roster, comms, office, money,
   reviews). Each module declares its tools AND the handler behind each name; the hub concatenates
   the three tier arrays and looks up a handler. Case bodies moved BYTE-IDENTICAL — the diff is a
   pure move, which is why no test had to be rewritten to fit it.
2. **The six tier gates stay in the hub**, applied by tool NAME before any handler runs. A domain
   module declares which tier a tool is in and never checks one. Deny-by-default only holds if
   adding a tool cannot forget its guard, so moving the gates into the domains would have traded
   the collision for a weaker boundary.
3. **Three tools stay in the hub** — `query_spine` and `spine_read` (their descriptions are built
   from the prompt catalog, which stays in the hub by the 2026-09-12 user decision below) and
   `ask_team_lead` (it hands the desk `TEAM_LEAD_TOOL_SCHEMAS`, which only the aggregate knows;
   moving it would be an import cycle). If a later pass wants ask_team_lead in its domain,
   `ToolContext` is the seam — but that makes ctx carry static config, which is why it wasn't done.
4. **Prompt text NOT moved (user decision 2026-09-12).** `SPINE_VIEW_CATALOG` and the other prompt
   constants stay in server.ts. Measured reason, not taste: a simulated merge of this refactor
   against the sibling's real uncommitted diff produced 2 conflict hunks / 273 lines, both shaped
   `<<<<<<< HEAD` / nothing / their 130 lines — because this side DELETES the region the other side
   EDITS. For the `retract_capture` hunk a gate catches a careless "take HEAD" (their import
   auto-merges and goes unused -> lint fails). For the prompt-text hunk NOTHING catches it: it is
   prose in a string, so typecheck and lint are silent, and the only test naming the new view
   asserts the DB grant, not the prompt. Leaving prompt text in the hub removes that hunk entirely.
   **Standing rule while this branch is open: an empty-HEAD conflict hunk means CARRY THEIRS into
   the new module, never "take HEAD".**
5. **TEAM_LEAD_TOOLS order preserved exactly**, by the order of its spreads, because that array is
   handed to the planner model and tool order is part of the prompt it caches on
   ([[openrouter-caching-vs-cadence]]). `TOOLS`/`ADMIN_TOOLS` are now domain-grouped: a one-time
   reorder of `tools/list` that no test or gate pins.
6. **Five count assertions replaced by names** (the absorbed finding). `toHaveLength(17)`/`(43)` at
   four sites in server.test.ts plus `toBe(43)` in eval/toolCases.test.ts -> one shared expectation
   in `src/mcp/tools/surface.expected.ts` and an `expectSurface(actual, sees, blind)` helper. The
   `blind` half is new and is what the counts were really guarding: verified by mutation, leaking
   `open_job` into the technician tier now fails with "tools this badge must not see: open_job"
   where the count could only say "expected 18 to be 17". Blind is checked FIRST so the named
   message wins over the array diff.
7. **`src/eval/toolCases.test.ts` scraped tool names out of server.ts SOURCE with a regex** and so
   read an almost empty file after the move. It now imports the real arrays (new export
   `SPINE_TOOL_NAMES`). Worth knowing because the scrape's intent was right — a self-maintaining
   coverage gate — and a regex over source could never have seen a tool added through a spread.

### What the sibling needs to know

`20260911-a-new-promise-to-a-known-customer-is-fil` has uncommitted edits in `src/mcp/server.ts`
at three places that this branch restructured: the import block (auto-merges), `SPINE_VIEW_CATALOG`
(still in the hub, so it merges), and the `retract_capture` case body (now
`src/mcp/tools/captures.ts`). Only the third needs hand-carrying, and decision 4's standing rule
covers it. `npm run work -- overlap` rates all three LOW because it compares symbol-level changes
and reads their side as "internal code only" — that rating is the blind spot, not the answer.

## Handoff 2026-09-14T18:30:17.623Z

**What changed** — Landed as #239 (squash 72e4af7, 2026-09-14): the tool server's schemas and handlers live per domain in `src/mcp/tools/`; the hub keeps the tier gates, three tools and the prompt text. Before landing, main's #235 was merged in (635321a): its `retract_capture` customer_captures loop, comment and two imports were carried into `tools/captures.ts`, byte-identical to main's block. Gates on the merge: typecheck/lint/build exit 0, 3,123 tests pass / 12 skipped.

**Decisions** — The predicted conflict happened exactly as recorded: two hunks in server.ts, HEAD side empty, main's side 49 and 2,753 lines. Resolved by the standing rule (carry theirs into the module, never take HEAD), NOT by hand-reading 2,800 lines: each incoming hunk was proven to be a contiguous span of origin/main's server.ts, then diffed against the same span in the base — the difference was exactly #235's edits (2 imports, 1 comment rewrite, 1 loop), so everything else in the hunk was already in the modules. That recipe is the reusable part. #236–238 landed after the merge and were NOT merged in again: they touch only `src/teamLead/`, `git merge-tree` was clean, and GitHub reported MERGEABLE/CLEAN.

**Assumptions** — The merge's gates are the last test evidence; no CI checks ran on #239, and the squash on main (with #236–238 underneath) was not re-tested. The combination review (fresh subagent) verified the moved `getCustomerContext`/`recordFieldNote` call sites by text comparison, not by running anything.

**Open** — (1) No test drives `retract_capture` through the tool server and checks that the retraction lands on the customer_captures link; the green suite said nothing about whether the carry survived — only the byte comparison did. It is #235's gap, not this refactor's; worth parking as its own small task. (2) `work.mjs integrate --base <sha>` is silently ignored after a merge — the report rebases to main — so the pre-merge report must be saved by hand before merging if a reviewer is to get it (the /integrate skill warns about BASE but not about the report itself).

**Downstream** — Any branch cut before 72e4af7 that edits a tool's case body or schema will now meet the same empty-HEAD conflict; the fix is always to carry its edit into `src/mcp/tools/<domain>.ts`. Live at handoff: `20260912-the-model-names-the-job` (worktree a-new-promise-…) has only a plan doc so far and its plan names no `src/mcp` file, but it branched before #239 — merge main before it touches a tool. `overlap`/`integrate` rated this real collision LOW ("internal code only"); that rating is blind to one side deleting a region the other edits, so do not read LOW as safe for a pre-#239 branch.
