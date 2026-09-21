---
date: 2026-09-15
task: the technician access request flow: tech seat asks the technician, the desk (ask_team_lead) relays to the manager, grant_access on the manager's seat, a message back to the tech seat
status: complete
origin: 20260915-customer-context-becomes-a-table-of-cont
files: src/mcp/server.ts, src/mcp/tools/shared.ts, src/teamLead/planner.ts, src/mcp/tools/surface.expected.ts, thoughts/shared/research/2026-09-19-the-technician-access-request-flow.md, thoughts/shared/plans/2026-09-19-access-plan-a-the-managers-access-tools.md, thoughts/shared/plans/2026-09-19-access-plan-b-the-request-flow-through-the-office.md, docs/engineering-memory.md, src/db/technicianView.ts, src/db/technicianView.test.ts, supabase/migrations/20260919170000_access_requests.sql, src/db/personPushes.ts, src/db/reviewItems.ts, src/db/observations.ts, src/db/accessRequests.ts, src/db/index.ts, src/teamLead/accessDeskPrompt.ts, src/teamLead/accessDesk.ts, src/mcp/tools/customers.ts, src/mcp/tools/captures.ts, src/teamLead/accessDesk.test.ts, .scratch/telegram-scenario.md, .scratch/pilot-migrate.mts, Box_Setup_Stuff/office-runner.timer
supersedes: nothing
---

## Files

- src/mcp/server.ts
- src/mcp/tools/shared.ts
- src/teamLead/planner.ts
- src/mcp/tools/surface.expected.ts
- thoughts/shared/research/2026-09-19-the-technician-access-request-flow.md
- thoughts/shared/plans/2026-09-19-access-plan-a-the-managers-access-tools.md
- thoughts/shared/plans/2026-09-19-access-plan-b-the-request-flow-through-the-office.md
- docs/engineering-memory.md
- src/db/technicianView.ts
- src/db/technicianView.test.ts
- supabase/migrations/20260919170000_access_requests.sql
- src/db/personPushes.ts
- src/db/reviewItems.ts
- src/db/observations.ts
- src/db/accessRequests.ts
- src/db/index.ts
- src/teamLead/accessDeskPrompt.ts
- src/teamLead/accessDesk.ts
- src/mcp/tools/customers.ts
- src/mcp/tools/captures.ts
- src/teamLead/accessDesk.test.ts
- .scratch/telegram-scenario.md
- .scratch/pilot-migrate.mts
- Box_Setup_Stuff/office-runner.timer

## Notes

Parked at the handoff of 20260915-customer-context-becomes-a-table-of-cont, on the operator's ruling (TECHNICIAN VIEW + GRANT ACCESS 9: "park it at this task's handoff"). WAITS FOR 20260915-retrieval-layer-2-the-technician-limited, which builds the view, the grants ledger and the grant CHECK this flow writes into.
Rulings (same task, 4-6): hop 1 the tech seat asks the technician whether to request access; hop 2 ask_team_lead relays the request to the manager IMMEDIATELY (the desk performs that one write; today it is read-only) and the planner records the request and outcome on its next tick; hop 3 the manager answers through a grant_access verb on the MANAGER'S seat (one call, the record_caller precedent); on yes a message goes to the technician's seat and the technician re-asks.
To decide in its plan: the wording of each hop, what the tech seat says while waiting, and what happens to an unanswered request (solo-operator doctrine: ask once, unanswered stays queued).

## Decisions

OPEN MISMATCH (2026-09-15, from the plan-3 session after the operator withdrew its send rail —
"just use prompt engineering, no need for the rails"): `viewShowsMoney` is now the ONLY ENFORCED
money gate, and it sits on the tool surface (plan 2). The planner's leg — its gap block, the text it
writes to a technician, and the desk answer — is TAUGHT, not checked. So a firm that sets
technician_view_rules.money = 'amounts' opens the figures on the tools while the planner's doctrine
still tells it not to name a figure to a technician. Decide when the firm-rule verb is designed:
either the doctrine reads the firm's rule (a per-firm prompt line, so the planner opens up with the
tools), or the operator accepts that the planner stays conservative while the tools do not. Worth
knowing why the rail went: plan 3's reviewer measured it end to end — 8 of 8 ordinary ways to state
an amount got through ("her total is 900", spelled-out figures), because it matched digits rather
than amounts, and it refused 5 of 5 harmless messages. The measurement is in docs/engineering-memory.md.

OPERATOR, 2026-09-15 (during plan 2's implementation): THE PLANNER MAY GRANT OR DENY, not only the manager. Hop 3 gains a planner-side path for special cases — the planner decides, or puts it to the manager / the manager's seat agent, instead of every request waiting on a human. The ledger needs no change: access_grants.granted_by is free text and the planner has its own identity (spine:), so a planner grant is one more row. Design in this task's plan: when the planner may decide alone vs must ask, and what it records.
ALSO PARKED HERE (operator, same session): CONTRADICTION DETECTION. A technician filing a field note on a job she is not booked on is an ambiguity a detector should raise to the planner, which then asks her or the manager (and can grant). Plan 2 made a note-minted trip NOT count as serving, so that technician now sees only her own note until someone decides — this detector is what closes the loop. Watcher/detector layer work; size it in this task's plan or split it out.

FROM PLAN 2's REVIEW (operator, 2026-09-15): (3C) grant_access must carry `opens`, `record` or `record_and_notes`, picked by the manager per grant (the access_grants ledger already has the column). (4B) The manager-seat verb that sets the FIRM'S RULE (technician_view_rules: job_scope, technician_channels, hidden_tags) ships in THIS task alongside grant_access; plan 2 ships only the table + the check. Plan 2 ships revokeAccessGrant in src/db only, so a revoke verb for standing grants is this task's too.

## Handoff 2026-09-18T06:30:43.693Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/the-technician-access-request-flow-tech on work/the-technician-access-request-flow-tech, from origin/main 6a7fe09.

Overlap check: 1 overlap with active tasks — the operator read them and proceeded (--proceed):

  LOW   same file only      src/mcp/tools/surface.expected.ts
        20260916-retire-the-manager-review-queue-keep-rev lists it but has not changed it; 20260915-the-technician-access-request-flow-tech names it

## Handoff 2026-09-19T22:53:11.436Z

**What changed** — Access plan A is LIVE (PR #262, squash `d953044`): a manager's seat can open a
record to one technician, list what is open, revoke it, and set the firm's own rule; a grant may now
name no customer and no job when it opens money figures only, and the planner reads the whole
history through `v_access_grants`. Rolled out end to end on 2026-09-19: migration applied to the
pilot, web + lifecycle-heart deployed by hand, all five manager seats' gateways restarted (s2 first,
two confirmed by a real turn, probe sessions deleted), a live grant/read/revoke run with the ledger
row read back, and the operator's own seat check passed. Fixed in place along the way: the ledger
trigger's `new.opens = old.opens` (NULL once `opens` is nullable, so a person-wide grant could never
have been revoked), and the docs' claim that all five out-of-view doors answer "name + id" (get_job
returns the id alone; the capture pages return none; get_capture is deliberately indistinguishable
from "no such note"). Plan B is written and twice-reviewed, NOT built.

**Decisions** — (1) All four access tools are ADMIN and the planner holds NONE (operator,
2026-09-19: "the desk is the one picking it up… the planner doesn't need to grant access, but they
should probably be seeing the history"). The rejected alternative was the `record_caller` shared
pattern, and the reason is invisible in the diff: `TEAM_LEAD_TOOL_SCHEMAS` is handed to the
heartbeat planner, the Calls-worker's focused pass AND shadow ticks, none of which have a mode
gate, so a shared grant door writes real grants during a run whose contract is "change nothing a
person sees". (2) Money is sensitive by DEFAULT and opens three ways, all manager-only: the firm's
rule, a person-wide grant, or one job/customer; the person-wide grant is a ledger row with no scope
rather than a roster flag, because the ledger already carries who, why and a revoke. (3) A plain
"yes" = the record for 7 days; an `everywhere` money grant defaults to standing. (4) The firm-wide
rule stays a bot tool AND later gets a settings-page section — the operator's correction to the
same-day "admin moves out of chat" ruling. (5) The parked money mismatch is settled: the planner
stays cautious and never names a figure to a technician even where the firm opened them, taught not
checked (plan 3 measured a keyword rail leaking 8 of 8). (6) The parked CONTRADICTION DETECTOR is
withdrawn as a concept: contradictions are raised at points of inference, the seat is responsible,
and code never refuses a filing — plan B phase 4 replaces it. (7) "The planner may grant or deny"
(2026-09-15) is satisfied by the DESK deciding in the moment, not by the scheduled planner.

**Assumptions** — That technician seats need no gateway restart (their 17-tool surface is unchanged;
checked by name lists, not by a live technician turn). That the duplicated assistant messages in the
s2 session export are a transcript artifact rather than double-sends to Telegram — unverified, the
operator would know from their phone. That plan B's 20-second timeout on the desk's decide call is
enough, and that falling back to "ask a manager" on any failure is the right direction.

**Open** — Plan B (the request flow) is unbuilt and now also carries seven fixes to plan A's tools:
the seat printing a roster ref and a grant id into the chat (live evidence, against the 2026-09-14
rule), plus five from plan A's final code review — `revoke_access` can claim access is closed while
another grant or the firm's rule still opens it; `everywhere`'s standing default is undocumented and
`standing: false` is ignored there; a no-op reports a change from X to X; an empty channel list
renders blank though it is the most restrictive setting; and a grant naming another firm's record is
described as opening something. START PLAN B IN A FRESH WORKTREE CUT FROM MAIN: this branch diverged
when #262 was squash-merged. Plan B's anchors were re-cut on 2026-09-19 (ask_team_lead's definition
and handler moved, ReviewKind moved to :17, the manager catalog is 43 and 44 with decline_access),
and #264 rewrote the seat block plan B edits — re-read §0l before touching it.

**Downstream** — The pilot carries two permanent grant rows, both revoked (`2018e70b` from my live
check, `78d754c7` from the operator's seat test); `access_grants` has no delete path, so that is
expected residue, not dirt to clean. Trap worth knowing, caught by the sibling session and not by me:
two branches wrote migrations with the SAME version number (`20260919120000`), and the ledger keys on
that number, so whichever applied first would have made the other read as already applied and skip,
silently — they renamed theirs to `20260919160000`. Check the ledger, not the filename, when two
worktrees are in flight. Their migration also had to go AFTER the deploy while mine had to go BEFORE,
so the two could not be collapsed into one step.

## Handoff 2026-09-21T01:30:00.000Z

**Closed out by the operator** ("close out the technician access request flow container and worktree", 2026-09-21), from a sibling session — not the session that built plan B, so this records what the merged history shows, not what that session decided. Plan B (the request flow through the office) LANDED as four PRs, all on origin/main: #269 "An access change reaches the person AND her seat, so the seat stops guessing" (e4b9a4c), #270 "Only a manager widens a view — and the office injector polls every 30s" (8c4e4b6), #271 "Ask for the least that answers them, and stop promising access the office cannot give" (b567b71), #272 "The office narrows a customer ask at every width, because the seat cannot" (f7e6705). The worktree ended on `work/narrow-every-width` at f7e6705, clean (snapshot 2026-09-21T00:08Z: no changed files). Its scratch stack `TradesDatabase-the-technician-acc-ca89f0` was stopped with its data deleted; note the worktree's supabase/config.toml had been reverted to `project_id = "TradesDatabase"` (the main stack's id) while the ca89f0 containers still ran — a plain `supabase stop` from inside it would have hit the PRIMARY stack, so it was stopped by label. Plan B's own handoff was never written by its session; its seven-fix list from the 2026-09-19 handoff should be checked against #269–#272 by whoever next touches src/teamLead/accessDesk.ts. Promotion call: YES — decisions (1)–(7) of the 2026-09-19 handoff are in no engineering-memory entry (grepped 2026-09-21), and the rejected alternatives are invisible in the code.
