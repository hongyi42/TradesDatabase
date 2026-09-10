---
date: 2026-09-10
task: hooks on one event do NOT share stdin (measured); touch cannot see edits made through Bash
status: complete
origin: 20260910-harden-the-work-record-the-small-finding
files: .claude/settings.json, scripts/work.mjs, src/work/work-cli.test.ts
supersedes: nothing
---

## Files

- .claude/settings.json
- scripts/work.mjs
- src/work/work-cli.test.ts

## Notes

Observed: the PostToolUse(Edit|Write) _comment in .claude/settings.json (added in 1e2cd42, PR #225) states "Several hooks on one event share a single stdin" as the reason touch never recorded a file. The evidence was a simulation (stdin drained by hand ahead of touch), not a check of how Claude Code actually feeds hooks, and no Claude Code hooks doc is cited.
Why it matters: that fix changed two things at once (two hook entries merged into one command, AND the path/cwd now passed as --file/--cwd), so the live pass on 2026-09-10 proves the fix, not the cause. Inference, not observed: if Claude Code gives each matching hook its own copy of the payload, the stated cause is wrong and the comment will mislead whoever next adds a hook to that event.
A lesson, not a job: close it by reading the current Claude Code hooks docs and citing the URL. If the claim holds, add the citation to the comment. If not, correct the comment and find the real cause (e.g. restore the old two-entry wiring in a scratch worktree with touch logging what it received).
Out of scope for the task it came from, which was only to prove touch works. It does now.

## Handoff 2026-09-10T22:53:37.959Z

**What changed** — The explanation, not the wiring. The claim in .claude/settings.json, in cmdTouch in scripts/work.mjs, and in the regression test in src/work/work-cli.test.ts, that "hooks on one event share a single stdin", is FALSE, and all three now say so and name the record's real blind spots instead. Measured three ways on 2026-09-10: (1) a scratch Claude Code CLI 2.1.268 session with three hooks on one PostToolUse matcher (jq; `sleep 0.5; wc -c`; a node reader copied from work.mjs's isatty + readFileSync(0)) had all three receive the full 1227-byte payload in 3 of 3 runs, including the one that read half a second after jq finished; (2) this VS Code session, still running the OLD two-entry wiring, edited src/work/work-cli.test.ts at 22:49Z and the second hook's `touch`, reading stdin, recorded it within a second; (3) the hooks docs (https://code.claude.com/docs/en/hooks) say only "For command hooks, input arrives on stdin" and "All matching hooks run in parallel", which already contradicts the idea of a syntax check running "ahead of" touch.

**Decisions** — The three failures #225 was built on each had a different cause, found in the session transcripts: the builder session (c2962f3a) started 2026-09-09 before the hooks existed and never ran a SessionStart hook at all; its test sub-session (22b51db4, 20:28Z) had its Edit refused for lack of permission, so the tool never ran; and the planner session (7599eed9, 21:32Z, which DID have the hook) made every edit by running node scripts through Bash (writeFileSync), which a PostToolUse(Edit|Write) hook never sees. #225's single-command wiring is KEPT, not reverted: the old form was never broken, but one parse and a fixed record-then-check order are still better, and reverting would change every session's hook set for no gain.

**Assumptions** — That this session really ran the old two-entry hooks. It is inferred, not observed: it launched at 22:14:31Z, before the main checkout fast-forwarded to #225 at 22:17:54Z, and settings are read once at launch (the promoted finding on settings.json). Hooks with no output leave no record in the transcript, so which command ran cannot be read back. The scratch-CLI result does not depend on this.

**Open** — The Bash blind spot is documented, not fixed: files: undercounts any session that edits through Bash, and nothing warns when it happens. `snapshot` sees those edits via git status, but only while they are uncommitted.

**Downstream** — (1) Plan 2's overlap check must treat files: as a floor, not the whole footprint. (2) Commit 1e2cd42's message states the wrong cause and cannot be edited (PR #225's body says it too); this finding is the correction, attached to the three files so the pre-edit hook shows it before anyone rebuilds on the old story. (3) No restart needed anywhere: only a _comment changed in settings.json, and no hook command did.
