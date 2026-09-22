---
date: 2026-09-20
branch: work/rung-10c-a-seat-s-inform-wakes-the-plann
commit: 8c4e4b6
topic: The desk as the office's fast path — what the Q&A desk is today, what the access desk already does that the proposal wants generalised, the two operator rulings from this week that point the other way, and what a caller-less, writing, escalating desk would have to satisfy
supersedes: nothing (it does not overturn a document; it re-grounds the SHAPE of rung 10c, whose premise — "a seat's inform wakes the PLANNER" — lives in the task record and docs/engineering-memory.md, not in a research doc)
---

*Line numbers re-pinned 2026-09-22 against main at the merge of `0e10054` — `accessDesk.ts` (now 509 lines) and `server.ts` both moved; every quoted ruling survived verbatim.*

> **READ WITH THE OPERATOR'S CORRECTIONS (2026-09-21/22) — this document's FRAMING is superseded,
> its facts are not.** (1) The planner and the desk/office are ONE team-lead agent split only by
> TRIGGER: pinged = the office (operations, timely L2 writes including creation, may write memory);
> the 30-minute cron = the planner (no job forgotten; developing knowledge of the firm). So the
> "three components" in the Summary are two code paths of one agent plus the cron, and the
> difference between the two paths is only whether someone is WAITING. (2) C1 and C2 below do NOT
> point against the proposal: "answering is not waking" scoped the desk's TRIGGER, and accessDesk's
> ruling is about who may SEE a record, not about L2 bookkeeping. (3) The "escalate to the planner"
> hop is gone — the office sends through the same guarded path (the double-text guard is a DB
> stamp). (4) The office gets real write tools. Rulings recorded in docs/engineering-memory.md
> (rung 10c section) and the 10c task record. D1-D5 below were resolved by those rulings.

## Summary

The **office** — the thing a technician's assistant talks to — is not one component. It is
**three**, and they differ in what wakes them and what they may do. The **planner** is the big one:
it runs on a clock, sweeps the firm's open work, decides, and is the only thing that texts people
through the guarded send path. The **desk** (`ask_team_lead`) is a small, *read-only* model call
that answers a question inside the asking seat's own tool call, in seconds. The **access desk** is
a third path, added this week, that handles one specific request — "open a record for me" — and
it is the only one of the three that both runs fast **and** reaches a human.

The proposal researched here is to make the desk the office's general fast path: any
out-of-cadence wake goes to it, it gains write capability for timely L2 (the structured
customer/job/visit record), and it escalates to a focused planner pass when a person must be told.

The single most useful finding is that **this already exists, once**. `accessDesk.ts` — shipped
three commits ago — is a bounded fast path that files a row, texts every reachable manager, and
writes its own transcript for the planner to read later. It is a working template for the shape
being proposed. The second most useful finding is that **the operator narrowed this exact surface
twice in the last two days**, and the wording of both is explicit enough that the proposal has to
be reconciled with them rather than assumed compatible (see Constraints §C1, §C2).

## Entry Points

| Where | What begins there |
|---|---|
| `src/mcp/server.ts:109` | the `ask_team_lead` tool definition handed to seats |
| `src/mcp/server.ts:747` | `case 'ask_team_lead'` — the only caller of the desk |
| `src/mcp/server.ts:791` | the access branch, routing to `answerAccessRequest` |
| `src/teamLead/desk.ts:141` | `answerDeskQuestion` — the general read-only desk |
| `src/teamLead/accessDesk.ts:141` | `answerAccessRequest` — the fast path that acts |
| `src/calls/observationPing.ts:38` | `drainOneObservationPing` — the wake that exists today |
| `src/jobs/plannerPass.ts:97` | `runFocusedObservationPass` — what a wake currently calls |

## Key Files

- **`src/teamLead/desk.ts`** (253 lines) — the Q&A desk. Exports `answerDeskQuestion`,
  `DESK_READ_TOOLS`, `DESK_FALLBACK_NOTE`, `renderAskerState`. Runs under `TEAM_LEAD_REF`
  (`:214`): the desk *is* the office, not a fourth identity.
- **`src/teamLead/deskPrompt.ts`** (88 lines) — `DESK_SYSTEM`, `DESK_NARROW_DISCLOSURE`, and the
  bounds: `DESK_MAX_TOKENS = 2048` (`:38`), `DESK_REASONING = 'low'` (`:41`),
  `DESK_BUDGET_MS = 40_000` (`:50`), `DESK_MAX_TURNS = 4` (`:56`), `DESK_QUESTION_MAX = 500`
  (`:58`).
- **`src/teamLead/accessDesk.ts`** (509 lines) — the access path. `answerAccessRequest`,
  `askTheManagers` (`:354`), `recordPair` (`:458`). The template for a fast path that acts.
- **`src/db/personPushes.ts`** — `queuePersonPush`, kinds `schedule | call | ops | access`
  (`:13`). A direct-to-person text queue that does **not** pass through the planner.
- **`src/calls/observationPing.ts` / `src/calls/runWorker.ts`** — the existing wake and its loop.
- **`src/jobs/plannerPass.ts`** — `focusedPassBlockedBy` (`:69`), `runFocusedObservationPass`
  (`:97`).
- **`src/db/officeMessages.ts`** — the bucket both desks write into.

## Data Flows

### 1. The general desk today — synchronous, read-only, caller-bound

```
seat calls ask_team_lead (inside the technician's own chat turn)
   │  server.ts:747 — identity from the VERIFIED header; caller decides `managerDesk`
   ▼
answerDeskQuestion (desk.ts:141)
   │
   ├─ 1. ask row written FIRST, born UNREAD          (:155-163)
   │       "a crash anywhere below leaves the question in the bucket"
   ├─ 2. planner's memory index read (degrades to '') (:170-175)
   ├─ 3. TIER DECIDES THE TOOLSET                     (:179-186)
   │       manager  → team-lead READ surface ∩ DESK_READ_TOOLS (4 tools)
   │       everyone → NO dispatched tools; own open questions pre-read + inlined
   ├─ 4. runToolLoop, no terminal tool — first text-only turn IS the answer (:199-217)
   ├─ 5. desk row written, born READ (the transcript)  (:228-237)
   ├─ 6. the ask marked READ — leaves the unread queue (:241-245)
   ▼
returns { answer, askId } to the waiting seat
   on ANY failure (:247-252): answer null + DESK_FALLBACK_NOTE, ask STAYS UNREAD
   → the planner sees it next tick
```

### 2. The access desk — the fast path that already acts

```
ask_team_lead + accessRequest  →  answerAccessRequest (accessDesk.ts:141)
   │
   ├─ refuses a manager (already sees all) / a roster-less badge      (:157-172)
   ├─ resolves ONE target, tenant-checked on every read               (:193-263)
   ├─ "already open?" against the technician's view                   (:265-295)
   ├─ "already asked?" — one open request per person/thing/width      (:297-320)
   └─ askTheManagers (:354)
         ├─ openAccessRequest — files the row                        (:371-385)
         ├─ queuePersonPush per reachable manager, kind 'access'      (:412-425)
         └─ recordPair — ask + desk transcript for the planner        (:438, :458-501)
```

Note what this flow does **not** touch: none of the planner's send rails. It reaches a human
through `person_pushes`, a different queue entirely.

### 3. The three existing out-of-cadence wakes — all keyed on inbound captures

All three key on `PINGED_KINDS` = `inbound_new_job | inbound_commitment | inbound_unmatched`,
written by `src/writePath/recordFieldNote.ts:395,:502`. **None of them can be triggered by a
seat's message.**

| # | Where | Mechanism |
|---|---|---|
| 1 | `src/calls/observationPing.ts` via `runWorker.ts` | the real wake — polls ~10s, gate *before* claim (`:51`), claims `pinged_at`, runs a focused pass |
| 2 | `src/jobs/lifecycle.ts:81-94` | `lifecycle-heart` fires `*/5`; the planner self-gates to the cadence, but an unclaimed observation inside a 35-minute window (`:79`) overrides that |
| 3 | `src/teamLead/planner.ts:4477-4490` | inside a running tick, a firm not due by cadence still runs if it has an unpinged, unasked observation noticed since its last run |

Cadence for reference: `PLANNER_TICK_MINUTES = 30` (`planner.ts:558`) in the firm's approximate
hours, `PLANNER_TICK_MINUTES_OFF_HOURS = 120` (`:575`) outside them.

## External Dependencies

- The inference provider, via `runToolLoop` — the desk and the planner share the transport and
  therefore the one `INFERENCE_MODEL` knob.
- Telegram, reached indirectly: `person_pushes` → the nudge pull → the box.
- Supabase/PostgREST for every read and write.

## Constraints and Invariants

**C1. "Answering is not waking" is a recorded operator ruling, and it is the one this proposal
reverses.** `deskPrompt.ts:7-10`, verbatim: *"'Answering is not waking' (user ruling, the explicit
carve-out from wake-on-event): waking to ACT stays ruled out — the desk never acts, and everything
it says lands in the bucket so the DECIDING planner sees what was said in its name on the next
tick."* Restated at `server.ts:749-751`. The proposal's premise is that the desk *is* woken and
*does* act.

**C2. The operator removed the desk's only write TODAY (2026-09-20, commit `8c4e4b6`).**
`accessDesk.ts:101-107`: *"'opened' is GONE (operator, 2026-09-20): only a manager or the firm's
own rule widens a view, so the desk can no longer answer by opening anything."* And `:346-348`:
*"there is now **NO path anywhere in this flow where a model's decision causes a write**. The desk
reads, it files, it texts. Every widening of a view is a person's choice."* The stated reason is
scoped to a promise about *views*: *"The firm tells its customers that a technician sees the work
they are on and nothing else… It is the manager's consent that the promise is about"* (`:339-344`).
Whether that reasoning extends to L2 operational writes (a job's status, a visit's completion) is
not settled by the text — it argues about access, not about record-keeping.

**C3. Read-only is enforced by the TOOLSET, not by the dispatch gate.** `desk.ts:27-31`: the write
tools are excluded from the schemas handed to the loop, *"and the loop refuses any name outside the
schemas it was given before the executor runs (the dispatch gate's spine ceiling would NOT stop
`write_memory` — it is on the team-lead allowlist — so the filter here is the mechanism, not a
redundancy)."* Removing the allowlist removes the only mechanism.

**C4. The allowlist is deliberately an allowlist.** `desk.ts:53-56`: a denylist *"would hand each
new one to the desk automatically — failing OPEN, against the repo's deny-by-default doctrine."*

**C5. Identity comes from the verified header, never from data.** The `data-security` gate's rule
2, and it is the sharpest constraint on a caller-less desk: today `managerDesk` is decided by
`server.ts` from the HMAC-signed identity of a live request. **A woken desk has no request and no
header.** The obvious substitute is not available either — `office_messages.tier` is explicitly
*"The SENDER's tier at write time — metadata, never authority"* (`officeMessages.ts:35`).

**C6. Every read and write must be tenant-scoped by hand.** RLS is off, the app uses
`service_role`. `accessDesk.ts` re-checks `tenant_id` on every resolved row (`:199`, `:203`,
`:217`) rather than trusting an id it was handed.

**C7. The model must not fail open.** `accessDesk.ts:50-51`: *"THE FALLBACK ALWAYS MOVES TOWARDS A
HUMAN. A timeout, a model error, a malformed decision — all of them ask a manager. Nothing here
fails open."*

**C8. The desk's bounds are sized to a waiting human, not to the work.** `DESK_BUDGET_MS = 40_000`
is derived from the gateway's 60s MCP request timeout (`deskPrompt.ts:42-50`) — a measured
constraint on a *synchronous* call. A woken desk has nobody waiting, so that derivation does not
apply to it, in either direction.

**C9. The claim column is required no matter who is woken.** `office_messages` carries only
`status` (unread/read) and `read_at`; claiming by flipping to `read` destroys the message on a
crash mid-pass, and nothing ever re-shows one. `observations` keeps `pinged_at` separate from
`status` for exactly this reason — precedent migration
`supabase/migrations/20260908100000_inbound_asks_and_job_captures.sql:19-36`, whose partial index
repeats the reader's `WHERE` verbatim.

**C10. A gapless firm already reaches the planner.** `planner.ts:4423` skips only on
`open.length === 0 && unreadMessages.length === 0` — "zero gaps + unread messages" proceeds with an
empty gap list plus the office block. So a message-scoped pass is not blocked by the skip.

**C11. Cost asymmetry is the efficiency argument.** The planner passes `maxTurns: null`
(`planner.ts:5116`) — no turn ceiling, the clock is the only rail — against the desk's 4 turns and
2048 tokens. Measured this session on the deployed model, a planner tool loop is ~$0.02–0.04 and
5–18 turns.

**C12. `ask` rows are the desk's own, and only reach the planner on failure.** The desk writes the
ask unread, answers, then marks it read (`desk.ts:241-245`). It stays unread *only* when the desk
failed (`:247-252`), which is the designed degrade. `desk` rows are born `read` (`:236`).

## Decision Points

**D1. Where the woken desk's authority comes from (C5).** Today the desk's capability is decided
per-request from a verified header. A woken desk has none. The forks visible in the code: run it
with no asker at all, as the office acting on its own record (tier gating becomes irrelevant to
reads, and the write question is answered by *what the code allows*, not by *who asked*); or carry
an authority derived from the message's `technician_id` FK (a verified-at-write-time roster link,
unlike the `tier` column, which is explicitly not authority).

**D2. Whether a model decision may cause an L2 write, given C2.** `accessDesk.ts` currently
resolves this by having the model decide *nothing* that reaches a field: "CODE DOES THE WRITE, BY
CONSTRUCTION… every field of the grant is fixed here… and the grant's `reason` is the technician's
own words quoted by code, never the model's" (`:44-48`, describing the now-removed narrow path).
The same construction is available for L2 writes — the model classifies, code writes fixed fields —
or the desk could be given genuine write tools, which is the thing C2's wording most directly
resists.

**D3. Which of the three wakes re-point.** They are not equivalent: #1 is the wake, #2 and #3 are
fallbacks for #1 failing, at different layers. Re-pointing #1 to the desk leaves #2/#3 waking the
*planner* for the same observation, which is either the correct belt-and-braces or a duplicate,
depending on whether the desk marks the row claimed.

**D4. How the desk reaches a human.** Two mechanisms already exist and they are not the same
thing: escalate to a focused planner pass (`runFocusedObservationPass`, which carries the ask
marker, the once-ever rail, the date rail and the citation rail), or push directly
(`queuePersonPush`, as `accessDesk.ts:412-425` does, which carries none of them and is not subject
to them).

**D5. Whether a widened desk stays one component.** `server.ts:765-767` records the precedent for
the opposite: the access branch is *"a different call, not a wider desk: the general desk loop
stays read-only, and the request path never reaches it."*

## Open Questions

1. **Does C2's reasoning extend from views to L2?** The ruling's stated basis is a promise to
   customers about who can *see* a record. Writing "this visit completed" is not a disclosure.
   Only the operator can say whether the ruling was about access specifically or about model-caused
   writes generally.
2. **What does a woken desk return, and to whom?** Every current path returns an answer to a
   waiting seat. Reading alone cannot tell whether a woken desk should write a `desk` transcript
   row (its current habit), nothing, or something new.
3. **What is the timeliness requirement in numbers?** "Timely" is not quantified anywhere in the
   code or the ladder. The existing wake promises seconds; the cadence gives 30 or 120 minutes.
4. **Does `INFERENCE_MODEL` being one knob matter here?** The desk and the planner share the
   transport and the model variable ([[planner-model-is-glm-53]] records that no per-caller
   override exists), so a desk doing more work cannot be routed to a cheaper model without moving
   the planner too.
5. **Rung 10d's interaction is unresolved by reading.** 10d moves five L2 writes off
   `recordFieldNote` *to the planner* (`docs/engineering-memory.md:4470`). If the desk becomes the
   timely L2 writer, 10d's destination changes, and the two rungs must be sequenced deliberately.
