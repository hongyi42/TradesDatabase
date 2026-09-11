---
date: 2026-09-11
task: git prompts on the terminal despite stdio ignore, and worktree add -b makes its branch before checking the path
status: complete
origin: 20260911-implement-plan-2-the-code-graph-spawn-in
files: scripts/work.mjs
supersedes: nothing
---

## Files

- scripts/work.mjs

## Notes

A lesson, not a job — both verified 2026-09-11 (plan 2 phase 3 review) on git 2.39.5:
1. `execFileSync('git', ['fetch'], { stdio: 'ignore', timeout })` still PROMPTS: git opens /dev/tty itself for a username / passphrase / host key. When the timeout kills `git fetch`, its `git remote-http` helper survives as an orphan in the terminal's foreground and swallows the operator's next typed line. Fix pattern: env GIT_TERMINAL_PROMPT=0, GCM_INTERACTIVE=never, GIT_SSH_COMMAND='ssh -o BatchMode=yes' (unless core.sshCommand/GIT_SSH_COMMAND is set). Verified in a pty against a 401 server: control printed "Username for …", the fixed call returned in 0 s.
2. `git worktree add <path> -b <branch> <ref>` creates <branch> BEFORE it validates <path>, so a failure on the path (e.g. "missing but already registered worktree") leaves the new branch behind. Refuse bad paths up front, and on failure delete the branch only if the error is not "a branch named … already exists".
Both symptoms point somewhere other than their cause. Promote when plan 2 closes.
