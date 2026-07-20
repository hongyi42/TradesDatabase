---
date: 2026-07-20
branch: board-sheet-animation
commit: 46e95c2
topic: Deep research — the toolset a flexible AI scheduling agent needs, triangulated from (1) how human dispatchers work, (2) what dispatch software exposes, (3) LLM scheduling-agent design evidence; mapped onto the spine's actual data surface
---

## Summary

Three parallel research passes (15+ sources each, URL-cited) answered one question: *what tools does
the trades agent need so scheduling flexibility is never bottlenecked by its tool surface?* The
triangulated answer: (1) human dispatchers run on ~25 recurring "plays" that split cleanly into
**measuring** (does it fit, who's qualified, what's it worth), **placing** (book/move/park), and
**cascading** (reshuffle a day around a disruption); (2) commercial software has converged on a
"find me a feasible slot" read as the mid-tier table-stake, with capacity-holding and
whole-board reshuffles as the only high-end differentiators; (3) the LLM-agent evidence is
unambiguous that the model must never *compute* feasibility — it extracts intent, calls a
deterministic tool that returns **pre-scored ranked options with the next move embedded**, and
narrates. Mapped against the spine: the placing verbs and the confirmation envelope already
exist and match the researched best practice almost exactly; the measuring layer is the real
gap (`find_slots` + its input data); and the cascade layer needs one batch primitive
(reflow a technician's remaining day) rather than many tools. Four small data homes are
missing: job urgency, technician skills, partial-day blocks, and a job "waiting/resurface"
state. Customer quirks already have a home (standing facts) — the tools just need to read it.

## Sources

Three subagent reports, 2026-07-20 (each with per-claim URLs; key citations inlined below):
dispatcher-behavior sweep (ServiceTitan Academy/guides, Jobber Academy, Housecall Pro, Workiz,
FieldInsight, BuildOps, Fieldpie, ACCA, HVAC-Talk, a live dispatcher job description);
FSM-product verb survey (official help centers of ServiceTitan, Housecall Pro, Jobber, Workiz,
FieldEdge, ServiceM8, Service Fusion, Zuper); LLM-agent design sweep (LLMFP/MIT, OptimAI,
MCP-Solver, R-ConstraintBench, MAST, CoAgent, Anthropic tool-design engineering posts, MLflow
practitioner guide, Motion/Reclaim/Clockwise product docs).

## Finding 1 — the dispatcher's job decomposes into three tool families

The full verb list (26 plays) is in the dispatcher report; the structural finding is that every
play uses one of three capabilities:

```
 MEASURE                      PLACE                       CASCADE
 "does it fit? who? what      "put it on / move it /      "reflow the day around
  does it cost?"               park it / drop it"          a disruption"
 ───────────────────────      ─────────────────────       ─────────────────────
 triage the call              book_visit        ✅         shuffle the afternoon
 match tech to job            move_visit        ✅         unassign & redistribute
 price the slot               cancel_visit      ✅         bump the bumpable
 check before dispatch        park unassigned   ✅         backfill the hole
 hold capacity                                             call ahead & renegotiate*
 (✅ = shipped)                                            (*communication, not math)
```

- Sourced tier system for triage: emergency / same-day / routine / maintenance, with
  membership, medical vulnerability, and business-down as priority bumps
  (servicetitan.com/blog/dispatching-tips; contractorincharge.com). **Maintenance is the
  designated sacrificial layer** — the thing dispatchers bump to absorb emergencies
  (ServiceTitan built "Mass Reschedule" for exactly this).
- Assignment order is **qualification gate first** (never violated), then proximity, then
  workload, then strength-to-value matching, then customer history, then fairness
  (netsuite.com dispatch-tips; buildops.com/resources/hvac-dispatcher).
- Capacity: hold **15–20% of the day** (or the whole afternoon) unbooked as the emergency
  shock absorber; front-load mornings (workiz.com scheduling best practices; ServiceTitan
  dispatching-tips). Overbooking to 100% is the named anti-pattern.
- The uncaptured layer ("in the dispatcher's head"): true durations, tech quirks/strengths,
  customer quirks, geography, today's IOUs (servicetitan.com AI-automation playbook — the
  Rainforest Plumbing skills-spreadsheet failure).

## Finding 2 — what software exposes (the convergence and the differentiators)

From the 8-product survey:

- **The universal floor** (all 8): tech-lane board + drag-to-reassign + drag-to-retime +
  unscheduled tray + status colors + customer/tech notifications. *The spine already has all
  of this* (Mini App board + verbs + unassigned bookings + boardNotify pushes).
- **The mid-tier convergence** (6 of 8): a *feasible-slot finder* combining shifts + duration
  + drive time (Jobber "Find a Time", ServiceM8 "Booking Suggestions", Workiz "Genius",
  ServiceTitan "Get Availability", Housecall Pro "Find a time", Zuper). Universal input trio:
  **duration + shifts + geo**; second-order inputs: skills, zones. This is `find_slots`, and
  it is now table stakes, not a differentiator.
- **High-end differentiators** (essentially ServiceTitan only): booking-time **capacity
  accounting with deliberate reserve/overbook verbs** (Adjustable Capacity Planning) and
  **continuous whole-board re-optimization** (Dispatch Pro Auto — reshuffles every 10 min).
  Two smaller unique gems: ServiceM8's **fit-preview before committing** and
  **queue-a-job-with-expiry** (parked "awaiting parts", auto-resurfaces).
- Config inputs every suggestion feature depends on: job duration, tech shifts, geo — then
  skills/tags, zones, arrival windows, priority field, time off.

## Finding 3 — the agent-design evidence (what keeps it reliable on a mid-tier model)

The 12 evidence-backed rules are in the agent-design report; the ones that bind Plan 3's design:

1. **The LLM never computes feasibility** — accuracy collapses when constraints interact
   (R-ConstraintBench, arxiv.org/pdf/2508.15204); solver-backed pipelines double LLM-only
   success (LLMFP, MIT 2025). Feasibility is a tool verdict.
2. **Task-level tools beat CRUD chains** — "instead of `list_users`/`list_events`/
   `create_event`, consider a `schedule_event` tool which finds availability and schedules"
   (anthropic.com/engineering/writing-tools-for-agents). But narrow typed inputs, ≤~8 tools
   in play (MLflow practitioner guide).
3. **Results must be decision-ready**: pre-scored ranked options, stable IDs, human-readable
   relay-ready text — never raw data the model must rank or add up
   (dev.to/nicholasemccormick "Why AI agents fail at scheduling").
4. **No dead ends**: a no-fit result carries the nearest alternatives and *which constraint
   bound* (Motion's explicit "Can't Fit" state is the product precedent).
5. **Autonomy boundary lives in data, not prompts**: flexible/locked flags with a hard floor
   for externally-owned items (Reclaim never overbooks non-Reclaim events; Clockwise moves
   only opt-in-flexible items). *The spine's `locked` + promise ladder is already exactly
   this pattern.*
6. **Preview and execute as separate tools, execute requiring a preview-minted token** — a
   lone `dry_run` flag is model-bypassable. *The spine's confirmId machinery is already
   exactly this pattern.*
7. **Version-token the writes**; mismatch → typed conflict → re-read and repair only what
   depended on the stale value (CoAgent, arxiv.org/html/2606.15376). *`scheduleVersion`
   exists; nothing pins it to a write yet.*
8. **Verify after writing** (MAST: weak verification is a top agent-failure cluster).
9. **Commitment hardens as the horizon shrinks** (Reclaim free→busy→locked) — the
   independent confirmation of the day-level-far / time-level-near design.

## The spine scorecard

| Researched capability | Status in the spine |
|---|---|
| Board read + drag verbs + unassigned tray + pushes | ✅ shipped (Plans 1–2) |
| Reversible-vs-promise confirmation envelope | ✅ shipped; matches Reclaim/Clockwise pattern |
| Preview-token two-step for consequential writes | ✅ shipped (confirmId machinery) |
| Schedule version read | ✅ shipped; ⬜ not yet pinned to any write |
| Feasible-slot finder (the mid-tier table stake) | ⬜ missing — Plan 3b core |
| Its input data: shifts / durations / time off | ⬜ setters exist, no tools, zero pilot rows — Plan 3a |
| Drive-time measuring tape | ✅ client exists (`optimizeStopOrder`); ⬜ no marginal-insertion use |
| Customer quirks ("only mornings", gate codes) | ✅ home exists (standing facts) — tools must read it |
| Job urgency/priority field | ⬜ no home (jobs have no priority) |
| Technician skills (the assignment GATE) | ⬜ no home (no attributes column on technicians) |
| Partial-day blocks (breaks/meetings/holds) | ⬜ no home (time off is whole-day; assignments need a job) |
| Queue-with-resurface ("awaiting parts") | ⬜ no home (job statuses: open/in_progress/completed/cancelled) |
| Cascade reshuffle (sick day, overrun) | ⬜ single moves only; no batch primitive |
| Capacity hold (15–20% slack) | ⬜ nothing models reserved time |
| Whole-board re-optimization | ⏸ deliberately Plan 4 (freeze ritual, ROI API) |
| Actual-duration learning (books vs reality) | ⬜ far future: nothing records completion times ('completed' has no writer) |

## The proposed tool inventory (tiered)

**Tier 0 — data verbs (Plan 3a).** `set_availability`, time-off add/remove,
`set_job_duration`. Plus the small schema homes the research surfaced: `jobs.priority`
(triage tier — an intake fact, cheap now, expensive to retrofit), technician skills
(qualification gate; needs a decision: column vs attributes), and optionally customer
scheduling preferences formalized as a named standing-fact convention (mechanism exists).

**Tier 1 — the measuring core (Plan 3b).** `find_slots`: deterministic, read-only, returns
**ranked, pre-scored candidates** (fit verdict, drive delta via one computeRoutes call per
candidate day, availability/priority/preference annotations, human-ready one-line summaries,
stable assignment/job IDs) and — critically — **when nothing fits, returns displacement
candidates** ("bumpable: Patel Tue 10:00, promise none, locked false") so no result is a dead
end. Horizon-aware: near days scored to concrete gaps, far days scored at day level.
Optionally `schedule_job` as the one-call convenience (find best + book via the existing
verbs, inheriting the promise/confirm doctrine unchanged).

**Tier 2 — the cascade verb (Plan 3c candidate).** One batch primitive, not many tools:
`reflow_day(technicianRef, date, fromTime?)` — computes a proposed set of moves (peel
remaining visits to other trucks / later slots, triage-ordered: promises kept today,
maintenance bumped first), returns it as a **preview with a minted token pinned to
scheduleVersion**, executes on confirm via repeated `moveVisit` (each guard still fires).
Covers the two biggest chaos plays (sick day, overrun) with the same machinery. Cancellation
backfill ("the hole") falls out of `find_slots` pointed at the vacated window + a
`moveUpCandidate` flag (job attribute) it can search for.

**Tier 3 — capacity shaping (cheap heuristic first).** The 15–20% hold and front-loading
enter as *scoring biases* in `find_slots` (prefer mornings for routine work; leave
configured slack unscored) rather than as schema. True reserved blocks (ServiceTitan ACP
style) and partial-day blocks are a later schema decision if the pilot asks for them.

**Tier 4 — Plan 4 as already envisioned.** Freeze ritual: ROI-API whole-day/week solve of
the loose far-out bucket, customer window announcements, confirm-the-night-before
automation. The continuous Dispatch-Pro-style auto mode stays out of scope — the research
shows even its vendor pairs it with "never overrides a human decision."

## Constraints and Invariants (carried into any plan)

- Feasibility, ranking, and arithmetic live in tools; the agent extracts intent, relays
  scored options, and narrates outcomes (mechanism-over-instruction — already this
  codebase's learned lesson, now externally corroborated).
- Every new read returns `scheduleVersion`; every batch write pins it; mismatch = typed
  conflict telling the agent to re-read (CoAgent pattern; the machinery half-exists).
- The confirmation envelope is unchanged: promises gate, everything else one-shots and
  reports. `find_slots` writes nothing, so it never confirms.
- No-fit results always name the binding constraint and the nearest alternatives.
- Tool budget: the agent already sees ~25 manager tools; Tier 0–2 adds ~6. Consolidation
  (one `find_slots`, one `reflow_day`) is deliberate — the research warns against verb
  sprawl more than it warns against wide tools.

## Open Questions

- Skills home: `technicians.skills text[]` (validated like service_cities) vs an attributes
  JSONB on technicians (no such column today). Gate semantics need exactness — a typo'd
  skill silently unmatches a tech.
- Priority home: enum column on jobs vs attribute. An intake-time fact; the extractor and
  booking verbs would both want to set it.
- How displacement candidates in `find_slots` compose with the version-pinned question when
  the bumpable visit carries a promise (likely: the one question, existing machinery).
- Whether the pilot (2–5 techs, one manager) wants `reflow_day` in v1 or whether chained
  single moves through the agent suffice at that scale — cost/benefit is thin at 3 trucks
  and grows with fleet size.
- Actual-duration capture (completion events) — valuable (dispatcher head-knowledge #1) but
  needs a technician-side "done" signal that doesn't exist; candidate for the field-notes
  pathway later.
