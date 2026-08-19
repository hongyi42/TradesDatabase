---
date: 2026-08-19
branch: fix/cost-detector-paid-and-corrections (src/ + migrations byte-identical to origin/main)
commit: 16f0778
topic: "The team-lead planner: centralizing the ladder's judgment as an inference layer with read tools"
---

## Summary

The spine has a "team lead": an identity (`spine:team-lead`) that notices gaps in a firm's record
and asks technicians about them through their own chat agents. **Today it makes one model call,
and that call writes a sentence.** `src/teamLead/compose.ts:18-19` says so — *"the ONLY model
call in the ladder"* — 462 tokens in, 66 out, `reasoningEffort: 'none'`, ~$0.0014. Every other
decision the team lead appears to make is hard-coded: which gaps exist, who to ask, when to ask,
when a gap counts as answered, when to escalate, and what to tell the manager.

This document maps the code for a change of shape ratified in conversation 2026-08-19: replace
the per-gap sentence-writer with a **planner** — an inference layer that sees all of a firm's open
gaps at once, can read the spine for context, and decides pacing, grouping, wording, closure and
escalation. Code keeps only what must never vary.

**The headline finding: this direction is half-built already.** The team-lead identity exists, its
read-tool allowlist exists, and the deny-by-default dispatch gate enforcing it exists and is
live. What is missing is not permission or tools — it is a **multi-turn loop**. All six of the
spine's model call sites are one-shot forced-tool calls; `forcedTool.ts:7` describes the contract
as *"ONE system prompt, ONE tool schema, a forced tool_choice, one user turn."* The spine has
never made an agentic call.

## Ratified decisions (user, 2026-08-19)

- **Detectors are eyes and will multiply; the decisions they feed must not multiply in code.**
  This is the organizing constraint. Measured: detector #2 cost ~370 lines of production code.
- **The planner gets read tools.** Rationale: *"as the team lead that lives inside the spine,
  organizing communication between the team, it should be able to traverse the entire spine for
  context to make the best decisions."* Cost is acknowledged as a separate, still-open question.
- **The planner decides closure**, tuned by prompt engineering: not answered → escalate; answered
  with a proper figure → close; still unanswered after escalation → close. Escalate-then-close is
  also the planner's call, not a code rule.
- **Closure's irreversibility is accepted.** Once-ever dedup means the *nudge* cannot be re-asked,
  but the job's artifacts remain amendable — a manager can still record the fact, a later note
  can still land. A wrong close costs this ask, not the information.
- **The planner may flag low-confidence gaps** rather than deciding blindly.
- **Per-gap judgment on multi-gap jobs**: the planner decides which of a job's gaps a given reply
  answered and which still need pursuing. An immediate follow-up question is out of scope.
- **We do not encode best practices.** *"It genuinely depends on the context of the job and the
  firm… most of the judgement calls are genuinely not black and white."* Prompt engineering is
  therefore the intended tuning surface, not a workaround.
- **Direction, out of scope here:** the planner should learn how a firm operates, and read job and
  customer context to support its decisions.

## What already exists for this direction

| piece | where | state |
|---|---|---|
| the identity | `src/teamLead/identity.ts:7` — `spine:team-lead` | live; reserved namespace, cannot collide with a roster row |
| its read-tool allowlist | `identity.ts:15-19` — `query_spine`, `get_customer_context`, `resolve_date` | live |
| the enforcement gate | `src/mcp/server.ts:1920` | live, **deny-by-default** across the whole `spine:` namespace |
| the tool bodies | `server.ts:1864` `dispatch(name, args, deps)` | exists, module-private |
| structured output + billing | `src/model/forcedTool.ts:336`, `:350` | live, one billing site |

The gate's comment (`server.ts:1912-1919`) states the doctrine: there is no human behind a
`spine:` identity to confirm anything, so nothing irreversible or externally visible may dispatch
for it — *"this gate is the mechanism, the prompt is merely steering."* `tools/list` is
deliberately untouched; discovery is cosmetic, dispatch is the gate.

`identity.ts:9` records that "stage" verbs were deliberately left as a future, separate decision.

## What is missing

1. **A multi-turn loop.** No spine call site loops. The six are `classifyCall.ts:103`,
   `answerQuestion.ts:56`, `briefCustomer.ts:69`, `email/classify.ts:50`, `writePath/extract.ts:85`
   and `compose.ts:204` — all one-shot, `messages: [{ role: 'user', … }]` with a forced
   `tool_choice` (`forcedTool.ts:206-207,278`).
2. **An in-process entry to the tool bodies.** `dispatch` is not exported.
3. **Per-turn cost accounting.** `recordModelUsage` fires once inside `runForcedTool`; a loop
   needs it per turn, plus a turn cap and a wall-clock budget.
4. **Deadline columns.** `nudges` has no `not_before` / `escalate_after`, and no grouping column.
5. **A consumer for a confidence flag.** Nothing reads such a field today.

## The sweep, split by facts and judgment

The sweep (`watchers.ts:488-522`) currently makes four decisions. They are not the same kind:

| decision | today | under the planner |
|---|---|---|
| did anything land on this job? | `hasActivitySince`, a map lookup | **stays code** — nominates candidates |
| does what landed *answer* what we asked? | does not exist; conflated with the above | **planner** |
| is the subject cancelled/completed? | `spec.moot`, a status check | mostly fact; per-kind status lists would multiply |
| how long before escalating? | `NUDGE_ESCALATE_HOURS = 48`, a constant | **planner**, written per row |
| never delivered in 24h? | `NUDGE_DELIVERY_DEADLINE_HOURS` | **stays code** — failure detection, not judgment |

The conflation in row two is the root of two known defects: a cost nudge closes on *any* activity
after `asked_at` (an unrelated scheduling note closes it), and the activity map is built from
`raw_captures` + `visits` only, so a money-recorded answer cannot close anything
(`2026-08-19-nudge-money-answer-blindspot.md`). Adjudicating "was this answered?" as a judgment
over evidence dissolves both rather than patching each.

### Deadlines, not constants

The proposed shape keeps the 5-minute sweep cheap and deterministic while making its thresholds
per-row:

```
 SWEEP — every 5 min ────────────────────────────────────── CODE
   evidence landed?           → candidate for adjudication
   past its own escalate_after? → hand to the manager
   past its own not_before?     → eligible to send
   24h and never delivered?     → broken pipe, give up

 PLANNER — coarser cadence ───────────────────────────────── INFERENCE
   which open asks are answered, and by what evidence
   when to ask the unasked      → writes not_before
   how long to wait on each     → writes escalate_after
   which ride together, and the wording
```

`48h` becomes the **default** a row carries when the planner has not said otherwise, so the system
degrades safely: if the planner never runs again, every open nudge still escalates on its stored
deadline instead of hanging. Note the trigger condition changes — compose fires today only when
`pending` rows exist; a planner that owns escalation must run whenever nudges are **open**.

## Failure scenarios for planner-decided closure

Ranked by likelihood, each observed on the pilot or directly implied by code read here.

1. **Stale evidence read as fresh.** A completed job almost always already has a note — usually
   the note that completed it. This is exactly why `JOB_COST_GAP_SPEC.filled` bounds on `asked_at`
   and not the visit (`nudgeKinds.ts:238-244`). Near-certain if the planner's evidence window is
   not bounded in code.
2. **Partial answers on multi-gap jobs.** The open specimen: *"The visit went well. The customer
   paid 500 on the spot."* — answers the visit gap, says nothing about what the job cost the firm.
3. **Non-committal replies.** *"Yeah, I'll check."* A model eager to be helpful reads engagement
   as an answer.
4. **Wrong gap on a multi-visit job.** A 3-visit job with nothing recorded yields 3 visit nudges +
   1 cost nudge; a note about visit 1 can close the gap for visit 3.
5. **Adjacent activity that is not a reply.** A scheduling note lands on the job. The code has this
   bug today, so the planner inherits rather than introduces it.

### Mitigations, mostly code-side

- **Bound the evidence window in code** — the planner sees only what landed after `asked_at`.
  Removes #1 structurally.
- **Pass attribution.** Each nudge delivers into a session named `nudge-<id>`
  (`nudgeQueue.ts:~105`), so a reply arriving through that session is directly attributable to the
  ask. This signal exists today and is discarded. Blunts #4 and #5.
- **Cite or don't close.** To mark a gap answered the planner must quote the evidence that answers
  it — the `assert-only-cited` doctrine already ratified for money reads. Makes #3 hard.
- **Ambiguity defaults to open.** A false-open is loud and cheap (one more ask, or an escalation a
  manager dismisses); a false-close is quiet. The `precision over recall` posture already ratified
  for money inference applies unchanged.

## Prerequisite this design forces

`job_cost_gap` review items **never auto-resolve**: the open-item sweep reads
`findOpenGaps(tenantId, 'overdue_visit_gap')` only (`watchers.ts:287`), and the any-status
backstop index is partial — `where kind = 'overdue_visit_gap'` (`nudges.sql:76-78`). Under
escalate-then-close, the manager's queue is where a gap comes to rest, so it must be able to
drain. This was previously deferred as review finding #3; the ratified design makes it a
prerequisite, not a follow-up.

## Decision Points

1. **Loop shape.** Build a general multi-turn runner beside `runForcedTool`, or a purpose-built
   planner loop. The first is reusable by the other five call sites; the second is smaller.
2. **How the loop reaches tools.** Export `dispatch` for in-process calls (no HTTP, no MCP
   framing, but couples the planner to the server module), or speak MCP to the spine's own server
   (clean boundary, more moving parts). Note `dispatch` requires an `identity` and performs a
   roster read per call — `spine:team-lead` is not a roster row, so that path's behaviour for a
   `spine:` identity needs confirming before either option is costed.
3. **Cadence and budget.** Every 5 minutes is ~144 calls/tenant/day inside the ask window; hourly
   is ~12. With read tools each call is now several turns. This is the open cost question the user
   named, and it is unmeasured.
4. **What consumes a low-confidence flag** — a manager review item, a softer question, or a hold
   for the next pass.
5. **Whether the planner writes the message or only the question sentence.** Code currently owns
   the evidence line (bare date, no weekday — the weekday-guard property, `compose.ts:23-24`), the
   served time phrase (`relativeDayPhrase`), and the footer. Per-kind guidance could become a
   short data string on each spec instead of a full prompt (~3 lines per eye instead of ~87).
6. **Whether `maxNewPerTenantTick` survives** as a hard ceiling the planner cannot exceed, or dies
   with the pacing constants.
7. **Whole-tenant failure handling.** Compose fails per row with an attempt cap and a manager
   handoff. A planner failure affects every gap in that tenant's tick; no precedent exists.

## Open Questions

- **Does `dispatch` work at all for a `spine:` identity today?** The namespace gate at `:1920` runs
  after a roster read (`server.ts:1875-1876` comment). Whether the read tolerates a non-roster ref
  was not traced.
- **Can GLM-5.2 plan reliably at `reasoningEffort: 'none'`?** Every spine call sets it. A planning
  task over N gaps with tool calls is a different class of work, and the repo has a counter-data
  point: thinking effort bought no accuracy on dates at ~8× tokens.
- **What is the token cost with read tools?** Unmeasured, and it now scales with what the planner
  chooses to read, not just the gap count.
- **Does a grouped message survive delivery?** The box runner (`/usr/local/sbin/nudge-runner.sh`)
  was not read; Stage 1's history includes a delivery bug that appeared only with a real
  multi-line payload.
- **How does a grouped message's footer work?** `assembleNudgeMessage` (`composeCopy.ts:130-146`)
  names one technician and one job and says `record_field_note` **for this job**, singular.
