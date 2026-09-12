---
date: 2026-09-11
task: four concurrent Supabase stacks do not fit in the Docker VM, and the suite stops being a signal
status: complete
origin: 20260911-a-new-promise-to-a-known-customer-is-fil
files: scripts/second-stack.sh, scripts/work.mjs, vitest.config.ts
supersedes: nothing
---

## Files

- scripts/second-stack.sh
- scripts/work.mjs
- vitest.config.ts

## Resolution — (c), shipped in PR #234 (main `2dd9a54`, 2026-09-12)

**A worktree stack now starts with `analytics`, `studio` and `realtime` off: 7 containers and
531 MiB instead of 12 and 1,527–2,096 MiB.** Nothing in `src/` or `scripts/` talks to any of the
three; `storage` stays, because `src/calls/` reads recordings from it. Two of the five containers
that vanish are couplings the Supabase config reference does not document — `analytics = false`
also drops `vector` (its log shipper), `studio = false` also drops `pg_meta` (Studio's backend).

Verified under the worst case the machine can present, three FULL stacks plus one trimmed with
swap exhausted: **3,105 passed / 0 failed on three consecutive runs** (151s, 158s, 162s), against
144s on a quiet machine.

The tension below is resolved in favour of CLAUDE.md: a stack per worktree, because a trimmed one
costs a third of a full one. The memory rule "keep the machine at ONE stack" is dead.

Two things to carry, if you are changing any of this:

- **Trimming a RUNNING stack needs a stop first** — `supabase start` will not re-read config.toml.
  In its worktree: `npx supabase stop` then `bash scripts/second-stack.sh <its N>`.
- **`STACK_TRIMMED` in `scripts/work.mjs` must move with the list in `second-stack.sh`.**
  `onlyStackRewrite` matches the trim BY SECTION so that a hand-disabled `[storage]` still reads
  as somebody's edit; if the two lists drift, prune stops recognising its own script's rewrite and
  either keeps every worktree forever or throws away a real config edit.

Options (a) raise Docker Desktop's allocation and (b) cap concurrent stacks were both left on the
table — (a) unnecessary at this size, (b) declined by the operator (2026-09-12): trimmed, the VM
has room for about six, so `second-stack.sh` only NAMES what is already running, flagging any stack
still running `analytics`, and never refuses.

## Notes

Measured 2026-09-11 while bringing up a fourth worktree stack.

Docker VM: 6,718 MiB used of 7,836 MiB (86%), 48 containers, 4 live stacks at ~1.6 GB each. Under
that pressure PostgREST's own schema-cache query hits the statement timeout — `57014 canceling
statement due to statement timeout`, then `PGRST002` x4, recovered two seconds later at 219ms — and
the vitest suite fails somewhere different on every run. Same commit, same stack, nothing changed
but load:

  run 1   17 failed   374s
  run 2   11 failed   282s   (disjoint failing set from run 1)
  run 3    0 failed   144s

Every failure re-ran green in isolation. The costumes differ enough to look like real bugs: a test
expecting a Postgres error code got `PGRST002` instead, and the four `web_search` tests got Kong's
502 "An invalid response was received from the upstream server" on an insert that succeeded by
curl a minute later. Two of those looked deterministic (29ms, idle machine) and cost real time to
clear.

There is no knob left on the test side: `vitest.config.ts` already sets `fileParallelism: false`,
so files already run one at a time.

The tension worth resolving: CLAUDE.md's park -> spawn -> integrate model gives every code-editing
session its own worktree and its own stack, while the standing memory rule says keep the machine at
ONE stack. Both cannot hold.

Options as they stood before the measurement (see Resolution above):
  a) raise Docker Desktop's memory allocation (8 GB -> 12 GB) and re-measure
  b) cap concurrent stacks, enforced in second-stack.sh — it already takes N and could refuse
  c) trim what each stack runs: analytics (Logflare) alone is ~520 MB per stack, ~2 GB across four,
     and no test reads it. `[analytics] enabled = false` is a config.toml line second-stack.sh
     already rewrites.

(c) is the only one that is free and in-repo — worth measuring before asking anyone to buy RAM back
from the rest of the machine.

## Handoff 2026-09-12T07:47:19.655Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/four-concurrent-supabase-stacks-do-not-f on work/four-concurrent-supabase-stacks-do-not-f, from origin/main d31331a.

Overlap check: none with any active task.

## Handoff 2026-09-12T08:31:42.541Z

Closed by PR #234, squash-merged to main as 2dd9a54 on 2026-09-12.

**What was decided, and what was rejected.**

- *Measure the trim before asking for RAM.* Option (c) from the original notes was the only one
  that was free and in-repo, so it was measured first. It was enough: 1,527–2,096 MiB per full
  stack → 531 MiB trimmed (687 MiB after three suite runs). Option (a), raising Docker Desktop's
  allocation, was never needed and is still available if six worktrees ever become normal.
- *No cap on concurrent stacks* (option b), by the operator's call. `second-stack.sh` NAMES the
  stacks already running and flags the ones still running `analytics`, then starts anyway.
  Rationale: trimmed, the VM has room for roughly six; a refusal would block legitimate work to
  prevent a condition that no longer occurs.
- *`storage` stays.* It was the one candidate service with a real reader — `src/calls/` fetches
  and purges recordings through it. analytics/studio/realtime have no reader anywhere in `src/`
  or `scripts/`.
- *The trim is matched by SECTION in `onlyStackRewrite`, not by the line.* The cheap version —
  accept any `enabled = false` — was written and then rejected: it makes prune treat a hand-
  disabled `[storage]` as machine-written config, delete the worktree and stop its stack. Proved
  by removing the section check and watching `config-off` flip from KEEP to REMOVE.

**What was assumed.**

- That no future test will read Studio, Logflare or realtime. Checked by grep at the time
  (nothing references ports 54323/54327/54328, `logflare`, or `.channel(`), not enforced. If a
  test ever needs one, the fix is to flip that section back in `second-stack.sh` — and then
  `STACK_TRIMMED` in `scripts/work.mjs` must move with it, or prune stops recognising the rewrite.
- That the main checkout's stack stays FULL. Its config.toml is committed and untouched, so
  Studio at :54323 still works for browsing the local DB by hand. Only worktree stacks are trimmed.

**Still open.**

- Two worktree stacks were started before this trim existed and are still full, ~2 GB each:
  `TradesDatabase-a-new-promise-to-a-71831a` and `TradesDatabase-split-src-mcp-server-ts-s`.
  Trimming one needs a STOP first (`start` will not re-read config.toml), and both belong to
  worktrees with active tasks — so it is the owning session's call, not a passer-by's.
- A process note that cost the first attempt: this branch was cut from a base five commits behind
  main, and the `project_id` 40-char fix (#232) had landed in between. `second-stack.sh` failed
  with a bare `error running container: exit 1` until main was merged in. Merge main BEFORE the
  first `second-stack.sh`, not at integrate time.
