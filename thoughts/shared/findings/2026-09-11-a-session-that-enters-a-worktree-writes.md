---
date: 2026-09-11
task: a session that enters a worktree writes its transcript under the MAIN checkout's project folder
status: complete
origin: 20260911-implement-plan-2-the-code-graph-spawn-in
files: scripts/work.mjs
supersedes: nothing
---

## Files

- scripts/work.mjs

## Notes

A tool contract, found 2026-09-11 building plan 2's `prune`. Claude Code keeps a session's transcript at `~/.claude/projects/<launch directory, encoded>/<session>.jsonl`, and its subagents' under `<session>/subagents/*.jsonl`. A session LAUNCHED in the main checkout that then works inside a worktree (EnterWorktree, or a cd) keeps writing under the MAIN checkout's folder; only each entry's `"cwd"` says it is in the worktree. The worktree's own project folder stays empty — or holds only sessions launched there.

So "is anyone working in worktree X?" answered from X's own folder says NO about exactly how this repo is usually worked, and a tool acting on that answer (prune removing a "stale" worktree) would delete a live session's cwd. `sessionActivityIn` (scripts/work.mjs) therefore reads every transcript of the repo written in the last day — the main checkout's folder, every worktree folder, and subagents — and matches `"cwd":"<path>"` in the last 256 KB of each. Pinned by prune.test.ts (merged-visited, merged-subagent).

Related: hooks come from the directory a session was LAUNCHED in (CLAUDE.md), so such a session also runs the main checkout's hooks, with the worktree only in the payload's `cwd`.
