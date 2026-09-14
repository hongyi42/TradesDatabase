---
date: 2026-09-14
task: Calls-worker auto-deploys on every merge to main, so code can reach it before its migration
status: complete
origin: 20260910-planner-s-manager-facing-copy-needs-a-fo
files: src/calls/runWorker.ts, src/calls/worker.ts, src/calls/observationPing.ts
supersedes: nothing
---

## Files

- src/calls/runWorker.ts
- src/calls/worker.ts
- src/calls/observationPing.ts

## Notes

MEASURED 2026-09-12, Render workspace tea-d69903h5pdvs738dm81g.

The 2026-09-04 outage (a merge auto-deployed code onto a pilot DB missing 14 migrations) turned
auto-deploy OFF on the web service (TradesDatabase) and on lifecycle-heart. It was NOT turned off on
Calls-worker (srv-d9qelh710e5c739hb8vg, background worker, `npm run calls:worker`), which still has
autoDeploy: yes, trigger: commit. Calls-purge (cron) is also still auto-deploy on commit.

What it cost, 2026-09-12: #236 merged at 20:38:53Z and Calls-worker went live on 53cb6aa at 20:39Z
with no human step. 53cb6aa carried #235, whose migration 20260912100000_customer_captures.sql was
NOT on the pilot (to_regclass null). #235's PR said to hand-apply it first. For ~12 minutes
Calls-worker ran recordFieldNote against a missing table: a redelivered call throws in
captureHasLinkedL2 and a known customer with an ambiguous job throws in insertCustomerCapture.
Found only because a deploy check listed the commits riding along. Applied by hand at 20:51Z.

WHY IT IS EASY TO MISS: "the planner" is not only lifecycle-heart. The FOCUSED pass for a new
inbound item runs inside Calls-worker (src/calls/runWorker.ts -> observationPing ->
runFocusedObservationPass), so every planner prompt change deploys to Calls-worker on merge,
while lifecycle-heart waits for a manual deploy. The two can run different planner code for
minutes to hours. A live e2e of an inbound ask exercises the CALLS-WORKER copy.

HOW TO APPLY: before merging anything with a migration, apply the migration to the pilot first
(information_schema audit, MCP apply_migration, notify pgrst) — the merge itself is the deploy for
Calls-worker. When checking "which code wrote this planner text", read Calls-worker's logs
("[calls:ping] focused pass <id>"), not lifecycle-heart's.

OPEN, the user's call: turn Calls-worker (and Calls-purge) auto-deploy off to match the other two.
Not done as of 2026-09-14.
