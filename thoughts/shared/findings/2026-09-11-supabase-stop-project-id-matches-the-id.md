---
date: 2026-09-11
task: supabase stop --project-id matches the id as typed; start labels a sanitised, 40-byte one
status: complete
origin: 20260911-implement-plan-2-the-code-graph-spawn-in
files: scripts/work.mjs, scripts/second-stack.sh
supersedes: nothing
---

## Files

- scripts/work.mjs
- scripts/second-stack.sh

## Notes

A vendor contract, read in the Supabase CLI v2.107.0 source (the repo's pin) on 2026-09-11. The npm CLI is a TypeScript wrapper whose `stop` proxies to the Go implementation (https://github.com/supabase/cli/blob/v2.107.0/apps/cli/src/legacy/commands/stop/stop.handler.ts#L5-L14).

- `stop --project-id X` uses X verbatim as the container/volume label filter (https://github.com/supabase/cli/blob/v2.107.0/apps/cli-go/internal/stop/stop.go#L19-L24).
- Loading `supabase/config.toml` — what `start`, and a `stop` without the flag, do — sanitises `project_id`: every run of characters outside `[a-zA-Z0-9_.-]` becomes `_`, leading `_.-` are trimmed, and it is cut to 40 bytes (https://github.com/supabase/cli/blob/v2.107.0/apps/cli-go/pkg/config/config.go#L1036-L1053, applied at #L825-L829). Containers are labelled with THAT.

Symptom: `npx supabase stop --no-backup --project-id <a long or odd id>` exits 0 and stops nothing — measured: `stop` on an id with no running containers exits 0 — so a stack keeps running, holding its ports and data, and nothing says so. Two neighbouring traps: `supabase stop` inside a checkout WITHOUT its own config stops the PRIMARY stack (engineering memory, 2026-08-19); and an id that sanitises to nothing would filter on the bare label and match every stack.

What prune does instead: stops a removed worktree's stack by running the pinned CLI in a throwaway folder holding only a copy of that worktree's config.toml, so the id resolves exactly as `start` resolved it (stopStack, scripts/work.mjs), and never stops an id that sanitises to empty.

One more piece of the CLI's local state, found by plan 2's final review: `supabase start` writes `supabase/.branches/` (and `.temp/`) in the checkout it runs in, both ignored by `supabase/.gitignore`. Any rule of the form "ignored files are somebody's work, keep the worktree" has to allow them, or it keeps every worktree that ever ran a stack — prune's first version of that rule did exactly that (caught before it ran on the real repo).
