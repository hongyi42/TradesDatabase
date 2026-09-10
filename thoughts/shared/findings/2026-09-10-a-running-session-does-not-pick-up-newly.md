---
date: 2026-09-10
task: a running session does not pick up newly added hook EVENTS from settings
status: complete
origin: 20260910-build-the-shared-work-record-plan-2026-0
files: .claude/settings.json
supersedes: nothing
---

## Files

- .claude/settings.json

## Notes

Measured 2026-09-10. The work record's design assumed Claude Code file-watches .claude/settings.json, so a session would pick up hook changes live. That is not true for hook events the session did not already have. Evidence: the main checkout pulled the merged branch at 11:18, giving its settings.json SessionStart, PreCompact and Stop for the first time. This session reads that checkout's settings. At 11:30, after several turn boundaries, the task snapshot was still from Sep 9 17:17 -- the Stop hook never fired, and the touch hook never recorded a single one of Phase 4's edits. Consequence for the design: landing the hooks on main is necessary but NOT sufficient; every already-running session keeps its old hook set until it is restarted. Worth confirming whether this holds for changes to an EXISTING hook's command too, which is the case the Phase 2 note actually verified.
