---
date: 2026-08-21
task: Hold every manager-facing template to "assert nothing you were not given", and let a field note record in one call
research: thoughts/shared/research/2026-08-21-the-answer-return-path.md
status: draft
---

## Overview

Plan ② of three (see `memory: ladder-build-schedule`). Plan ① widened the **planner's** eye so it can
see money. This plan fixes the **mouth**: the fixed strings the system speaks to a manager, and the
two-call ceremony it makes a technician perform.

Rebased onto `e36b601` (PR #162 merged). Line references below are re-verified against that commit.

**What the rebase changed, and what it did not:**

- ① touched `planner.ts`, `plannerPrompt.ts`, `moneyEvents.ts`, `nudgeDecisions.ts` and **8 lines of
  `watchers.ts`** (one exported constant). It did **not** touch `nudgeKinds.ts` at all. The overlap
  the schedule warned about never materialised — but the line numbers in `watchers.ts` (+8) and
  `server.ts` (+6 in the note path) moved, and every anchor below is re-checked.
- The comment at `nudgeKinds.ts:311-314` — *"the nudge's `filled` deliberately still ignores the
  ledger"* — is **still true after ①**. So Phase 1's original call to **delete** the cost claim
  rather than back it stands. What changed is that we now know the *detector* does read the ledger
  (`watchers.ts:835`, `listCostEvents`), so one claim is backable that we had assumed was not.
- ① added the `extend` action to `nudge_decisions`, so the decision history this plan reads back is
  no longer escalate-only. The reader must select on `action === 'escalate'`, not "the last row".

**Out of scope:** the gap-id stamp and the sweep's answer/activity split (plan ③); anything that
widens a `filled` predicate (①'s ratified decision).

## Decisions

- **One rule governs every template on the manager path** (user, 2026-08-21): *a template may render
  data it was given and may carry instructions, but must never assert a fact it did not receive as
  an argument.* Checkable from a signature — `handoff(n, mode, naiveLocal?)` takes a nudge and a
  clock, so every factual claim in its output was unbacked by construction. A signature bug, not a
  copy bug.
- **A clause is argument-fed only where a predicate genuinely backs it; otherwise it is deleted.**
  Flags are named after the **predicate**, never the conclusion, so a later caller cannot use one to
  justify a wider claim.
- **`noCostOnLedger` is passed, and the cost claim survives in backed form** (implementation call,
  NEW on rebase — the original plan deleted it outright). Re-verification showed the cost detector
  filters candidates through `listCostEvents` (`watchers.ts:830-840`) and the sweep already builds
  `jobsWithCostEvents` over every open nudge's job (`:514`). So *"nothing is recorded about what
  this job cost"* is a fact in hand at every cost handoff site — it just was never passed. Feeding
  it is not the thing ①'s decision forbade: ① refused to let the ledger **close a gap**; this only
  stops the copy from asserting a costs claim blind. The unbacked **conclusion** — *"so the job's
  costs are incomplete"* — is still deleted everywhere: a job with no parts has complete costs.
- **The planner's reason reaches the manager** (user, D6) — read at handoff from `nudge_decisions`,
  not carried in a new column. Newest row with `action === 'escalate' && outcome === 'applied'`.
  A gap the planner **extended** and the sweep later escalated on the clock has no such row, so no
  note appears — correct, and not to be "fixed" by falling back to the extend's reason. That would
  attribute a decision to a planner that never made it.
- **Field notes record one-shot; standing facts keep their confirm** (user, ratified 2026-08-21).
- **The identity resume commits too** (implementation call, settled here). `needs_identity` stays —
  a missing datum is not a confirmation — but once the technician names the customer there is
  nothing left to confirm, so `confirmId + confirmed` records instead of returning a preview. The
  `confirmId`-alone path is kept solely so tokens staged before the deploy still commit.
- **SETTLED (was OPEN): the one-shot idempotency stamp** is
  `note:<sha256(tenantId|technicianRef|channel|identityKey|text ?? ''|blobPath ?? '')>`, where
  `identityKey` is `resolved.customerId`, else `job:<resolved.jobId>`, else `new:` + the JSON of the
  whole `createFrom` draft. `blobPath` and `channel` are in the key because a note may be a PHOTO
  with no text at all (`server.ts:2140`) — without them two different photos for the same customer
  hash identically and the second is silently swallowed. The whole draft, not just its address,
  because `resolutionFrom` (`:1848`) can leave `addressLine1` null and every addressless draft would
  collapse to one key. **No date component** —
  the original sketch's `:<yyyy-mm-dd>` buys a rare re-record at the cost of a midnight-straddle
  double write, and identity in the key already separates "done" for two customers. Consequence,
  accepted: a genuinely repeated identical note about the same customer returns `duplicate` rather
  than recording twice. It must be **reported honestly**, never as `recorded` — L1 is undeletable
  and a double-written note plus a double-written visit cannot be undone.
- **OPEN — does a one-shot call get to CREATE a customer?** `resolutionFrom` (`server.ts:1839`)
  returns a `createFrom` resolution whenever `confirmed` is present, and `confirmed` is legal on the
  first call (`server.test.ts:428` does exactly that). So under a plain one-shot rule, a first call
  carrying `confirmed:{address}` that matches nothing **mints a new customer row the technician was
  never shown** — today the preview says *"…for NEW customer Jane, 12 Oak St"* and they get to catch
  it. The ratified decision rests on notes being revertable; a customer created by a stamped capture
  is **not** (`memory: l1-pins-l2-undeletable`). **Recommend: one-shot when the note attaches to an
  EXISTING customer or job; keep the preview when the resolution is `createFrom`.** The alternative
  is full one-shot, accepting silently-minted customers. Needs the user's call before Phase 2 is
  implemented — it changes which branch commits.
- **A stranded `needs_identity` item is LEFT OPEN** (implementation call, REVERSES the original
  plan's "add a TTL sweep"). Once staging happens only on ambiguity, the item's `detail.text` is the
  **only** copy of that note — nothing is in L1. Expiring it destroys the note. It belongs in
  `list_pending_reviews` as exactly what it is: a note nobody could attribute.

## Plain-language walkthrough

**Phase 1 — stop telling the manager things we haven't checked.** When a question goes unanswered
the manager gets a fixed sentence claiming the technician "hasn't heard back" and that "nothing is
on the job's record". Neither is looked up. On 2026-08-20 both were false, on a job where the
customer had already paid. Each claim is either deleted or handed the fact that backs it. In their
place the manager gets something we *do* know and today throw away: the planner's own reason.

```
 today                                   after phase 1
 ─────                                   ─────────────
 handoff(nudge, 'escalated', clock)      handoff(nudge, 'escalated', clock, {
   │                                         plannerReason,        ← from nudge_decisions
   │  "…hasn't heard back —                  noNoteOrStatusChange, ← the predicate just run
   │   nothing is on the job's                noCostOnLedger })    ← the Set already built
   │   record yet."                        │
   └── nobody checked either claim         └── every clause traces to an argument
```

**Phase 2 — one call, not two.** Recording a field note takes two tool calls: the first stages a
preview and writes nothing, the second commits. On 2026-08-19 a technician answered two questions in
one message; the money half committed instantly, the note half stopped at "shall I?", and the reply
opened with "Recorded!" — telling them they were done when they were not. A wrong note can be
retracted by its own author, so the confirm buys ceremony, not safety. Standing facts keep theirs:
those land in every future briefing.

## Secrets & env preflight

- **Phase 1:** none. **Phase 2:** none.

Both phases need the local Supabase stack (`npm run seed:local`, already required). Live checks need
the `supabase-test` MCP (pilot read-back, already connected).

## Phase 1: The manager copy asserts nothing it wasn't given

### What this phase does
Applies the rule to all four offending templates, and carries the planner's reason to the manager.

### Changes required

**`src/jobs/nudgeKinds.ts`** (untouched by ①, so every line below is exact)
- Add above `NudgeKindSpec` (which opens at `:103`):
  ```ts
  export interface HandoffContext {
    // Newest applied ESCALATE reason for this gap, or null. Model-authored.
    plannerReason?: string | null;
    // TRUE only when the caller has just evaluated hasActivitySince and it was
    // false. Backs ONE clause with ONE wording: "no field note and no status
    // change". It does NOT back "nothing is on the record" — that predicate
    // reads two tables and is blind to money_events (the 2026-08-20 specimen).
    // NOT passed on the EXPIRED path: JOB_COST_GAP_SPEC.filled short-circuits on
    // `!n.asked_at` (`:298`) and an expired row was never asked, so the
    // predicate is never evaluated there for that kind.
    noNoteOrStatusChange?: boolean;
    // TRUE only when the caller has checked the money ledger for this job and
    // found no live material_cost. Backs "nothing is recorded about what this
    // job cost". It does NOT back "the costs are incomplete" — a job with no
    // parts has complete costs.
    noCostOnLedger?: boolean;
  }
  ```
- Widen `handoff` (`:138-142`) to `handoff(n, mode, naiveLocal?, ctx?: HandoffContext)`. Optional for
  the same reason `naiveLocal` is: `compose.ts:98` has no sweep state — and that is exactly the call
  site that must stop asserting.
- Add a module-local helper (do **not** export `flat` from `planner.ts:220` or `flatten` from
  `composeCopy.ts` — both are private):
  ```ts
  const plannerNote = (ctx?: HandoffContext): string => {
    const r = ctx?.plannerReason?.replace(/\s+/g, ' ').trim();
    if (!r) return '';
    return `\n\nThe assistant's note: "${r.length > 200 ? r.slice(0, 199) + '…' : r}"`;
  };
  ```
  Attributed because it is model-authored text on a surface where every other word is code-owned.
- **(#4) `stage0Suggestion` (`:151-159`)** — 4th arg `noNoteOrStatusChange?: boolean`. Delete the
  general claim `nothing has been recorded about it yet`; keep the specific one, gated:
  ```ts
  `The visit for '${title}' (${customer}) was scheduled to wrap up by ${wallClockLabel(endsAtLocal)}.` +
  (noNoteOrStatusChange ? ` No field note and no status change has been recorded for it.` : '') +
  ` Worth checking how it went so the job's record stays complete. If nothing needed recording, just dismiss this.`
  ```
- **(#5) `OVERDUE_VISIT_GAP_SPEC.handoff` escalated (`:255-262`)** — delete `and hasn't heard back`
  (no reply-side datum exists anywhere in the system) and `nothing is on the job's record yet`
  (replaced by the gated clause). Expired branch (`:247`) passes the flag through to
  `stage0Suggestion`. Append `plannerNote(ctx)` to the escalated suggestion.
- **(#6) `JOB_COST_GAP_SPEC.handoff` (`:325`)** — signature is `(n, mode)` today; widen to the
  interface. **Expired (`:343-345`)** — the lead-in is the ONLY place this copy names the job, the
  customer and the topic, and `handToManager` reaches it with no ctx, so gating the whole sentence
  would ship a subject-less item (and break `nudgeQueue.test.ts:262`). Split it: the subject is
  rendered data and stays unconditional; only the ledger CLAIM is gated, and
  `so the job's costs are incomplete` is deleted.
  ```ts
  `The '${title}' job (${customer}) has an open question about what it cost in parts or materials.` +
  (ctx?.noCostOnLedger ? ` Nothing is recorded for it yet.` : '') +
  ` Worth asking ${techName} what they picked up for it. If there were no parts, just dismiss this.`
  ```
  "has an open question" is true by construction — we are handing off an open gap.
  **Escalated (`:346-348`)**: delete `and hasn't heard back` and `the job's costs are still
  incomplete`. The surviving opener already names everything and is backed (the nudge WAS asked);
  add ` Nothing is recorded for it yet.` gated on `noCostOnLedger`, then append `plannerNote(ctx)`.

**`src/jobs/watchers.ts`**
- `WatcherDeps` (`:190-218`) gains `listDecisions?: typeof listDecisionsForNudges`. **Required** —
  `watchers.test.ts:17` states every collaborator is injected; an un-injected read would make the
  existing escalation tests hit the database. Default it beside the others at `:272`.
- Before the escalation loop (`:664`), one batched read over every escalating id.
  `listDecisionsForNudges` returns **oldest-first** per nudge, so:
  ```ts
  const reasonFor = (id: string): string | null => {
    const rows = decisions.get(id) ?? [];
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].action === 'escalate' && rows[i].outcome === 'applied') return rows[i].reason;
    }
    return null;
  };
  ```
  One query, not N. Wrap it so a read failure logs and yields no reasons rather than blocking the
  escalation — the handoff matters more than the note.
- `:664` — pass `{ plannerReason: reasonFor(x.n.id), noNoteOrStatusChange: true,
  noCostOnLedger: !jobsWithCostEvents.has(x.jobId ?? '') }`. Both flags are honest here: the loop at
  `:555` `continue`s on `filled()`, and both specs' `filled` **is** `hasActivitySince`;
  `jobsWithCostEvents` (`:514`) is built over every open nudge's job, so `has()` is meaningful.
- `:613` (`'expired'`) — pass `noCostOnLedger` ONLY. **No** `plannerReason` (nobody planned it — an
  expired nudge never went out) and **no** `noNoteOrStatusChange`: the expired list holds
  `pending`/`queued` rows (`:599-604`), which were never asked, so the cost spec's `filled` returns
  at `nudgeKinds.ts:298` without ever calling `hasActivitySince`. The flag would be honest for the
  visit kind and vacuous for the cost kind — exactly what the naming rule exists to prevent. Its
  clause therefore appears only at `:812`, where `!hasActivitySince` was literally the filter.
- `:812` — `stage0Suggestion(title, customer, g.ends_at, true)`; the detector filtered on
  `!hasActivitySince` at `:452`.
- **(#7) `:896-899`** — delete `so the job's costs are incomplete`. The surviving lead-in needs no
  flag: this is the detector's own fallback and `freshCost` (`:840`) already excludes every job in
  `withCost`.

**`src/teamLead/compose.ts:98`** — unchanged, and that is the point: passing no `ctx` means every
factual clause is omitted. This path asserts nothing because it has checked nothing.

### Existing tests this phase MUST rewrite
- `src/jobs/watchers.test.ts:1234` — `'escalation copy is byte-identical to the pre-registry
  wording'` asserts the whole old string with `toBe`, including both deleted clauses. Re-pin it to
  the new text; it is the lock that keeps this copy deliberate, so update it, never loosen it.
- `src/control/nudgeQueue.test.ts:262` and `src/jobs/watchers.test.ts:1397` assert
  `toContain('cost in parts')` and must still PASS unchanged — they are the regression guard for
  the subject-less-copy failure above. Do not touch them.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] escalated visit copy contains neither `hasn't heard back` nor `on the job's record`
- [ ] escalated cost copy contains no `incomplete`, and says nothing about cost when
      `noCostOnLedger` is absent
- [ ] `stage0Suggestion` WITHOUT the flag omits the note/status clause; WITH it says
      `no field note and no status change` and never `nothing has been recorded`
- [ ] `handoff` called with no `ctx` (the `compose.ts:98` shape) emits no factual clause and still
      returns a valid plan
- [ ] an `applied` escalate reason appears, attributed, whitespace-collapsed, truncated at 200
- [ ] a `refused` or `shadow` decision's reason is NOT carried; nor is an `extend`'s reason on a gap
      the sweep escalated
- [ ] reasons are read in ONE batched call for N escalations, and a throwing `listDecisions` still
      escalates
- [ ] mutation: restore any deleted claim → its test fails; invert either flag → its test fails

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP
- [ ] Read the `suggestion` on the 3 open false review items and confirm it is the OLD copy, so any
      new item is distinguishable from the pre-change corpus. Report their ids.

### Manual verification
- [ ] Read one regenerated escalation and one regenerated expiry side by side and judge they read as
      a colleague's note, not a machine hedging

---
*Pause after this phase — Manual verification is non-empty.*

## Phase 2: Field notes record in one call

### What this phase does
Removes `record_field_note`'s staged confirm so a note whose customer is known commits on the first
call, and so the answer to a `needs_identity` question commits on the second.

### Changes required

**`src/mcp/server.ts`**
- `:255-262` — rewrite the description: no longer two-step; the note is recorded on this call; a
  mistake is fixed with `retract_capture`. `:264-277` schema comments say "First call only" — correct
  them.
- `:556` — `record_standing_fact`'s description says *"Unlike record_field_note … two-step"*; fix.
- `:2124-2131` — the cross-tenant `confirmed.customerId` guard runs before either branch; unchanged.
- `:2135` (`if (!confirmId)`) — after `resolutionFrom` yields a resolution, **commit** with the
  content-hash `externalId` and return the recorded result. When it does not, stage exactly as today
  and return `needs_identity` (`:2185-2192`).
  **Leave the supersede at `:2157` exactly where it is — before the branch, on EVERY no-confirmId
  call.** Moving it into the ambiguous branch opens an undeletable double-write: an ambiguous note
  stages as item `I`, the same note is re-sent and now resolves, commits under
  `note:<sha256(…)>` while `I` stays open, and a later `record_field_note({confirmId: I,
  confirmed})` commits it again under `note:<I>`. Different `externalId`, so `recordFieldNote`'s
  dedup (`src/writePath/recordFieldNote.ts:125-137`) cannot see it — two L1 rows and two visits.
  **Replay the extraction both times**: pass `{ extract: async () => extracted }` as
  `recordFieldNote`'s second argument, the way the confirm path does at `:2324`. Without it the
  write path calls the model a second time and can extract differently than the identity match that
  chose the customer. `sourceMeta` is omitted on this path — there is no `stagedConfirmId`.
- `:2258-2296` (`confirmId + confirmed`) — on a resolution, commit with `externalId: note:<item.id>` and
  resolve the item; drop the `needs_confirmation` return. Still ambiguous → `needs_identity` as today.
- Keep the `confirmId`-alone commit (`:2298-2352`) and its 15-min TTL untouched: tokens staged before
  the deploy must still land.
- Delete `stagedNotePreview` (`:1860`) — its only two callers (`:2197`, `:2293`) are removed, and
  lint fails on the unused function.
- Every commit path must return `duplicate` honestly when `recordFieldNote` says so — never
  `recorded`.

**Existing tests this phase MUST rewrite** (they stage-then-confirm and will go red):
`src/mcp/server.test.ts:345` (asserts `needs_confirmation` on the identity resume — now `recorded`),
`:425` (both cases expect `needs_confirmation` from a resolvable `confirmed.customerId`), `:458`
(backdated `stagedAt`; re-point at a `needs_identity` token), `:485` (crash-heal on
`note:<confirmId>`; re-point), `:511` (resolve_review refuses a live staged token; re-point), `:1085`
(retraction fixture — one call fewer). `:1014` (cross-tenant guard) and `:592` survive unchanged.
The supersede / expiry / crash-heal coverage must be **re-pointed at the paths that still have those
behaviours**, never deleted.

**Box_Setup_Stuff sync** (standing rule — an agent-stack change updates these in the same commit):
- `Box_Setup_Stuff/bootstrap-box.sh` — the doctrine lives in the `## Permanent-record writes —
  confirm FIRST` section (`:614-647`), which is appended by the **same heredoc** as `## Trades
  assistant — accuracy rules` and guarded by a **presence grep at `:589`**. Editing its text is a
  **no-op on every already-wired seat** (the documented template-drift trap, fourth occurrence).
  **Split it into its own heredoc with its own delete-then-append refresh, placed AFTER the `fi` at
  `:649`** — inside the `if/else` it would inherit the very presence grep it exists to escape —
  copying the idiom at `:655-657` verbatim (`awk '/^## Permanent-record writes/{skip=1;next} skip && /^## /{skip=0} !skip'`).
  Leave the accuracy-rules presence grep alone. Rule 2's "staged tools (record_field_note, …)" list
  loses `record_field_note`; rule 4's retract guidance stays and becomes the *only* safety net.
- `Box_Setup_Stuff/nemoclaw-inference-medic.sh:149` — embeds the tool's schema for its real-tool-call
  probe; a stale copy breaks the health probe.
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:24`, `:132-140`, `:164`
- `Box_Setup_Stuff/doorman-architecture-memory.md:314`
- `docs/nemoclaw-tech-agent.md:84`, `:213`; `docs/onboarding.md:196`

**The eval harness encodes the two-step and `npm test` will NOT catch it:**
- `src/eval/toolCases.ts:481-527` (W01) — step 1 asserts the first call returned
  `needs_confirmation|needs_identity` and errors with *"first call neither staged nor asked who"*.
  A resolvable one-shot returns `recorded`, so W01 fails on the next spine-tool eval run.
- `src/eval/graders.ts:62-83` keeps `record_field_note` in `STAGED_TOOLS`, and `isCommit`'s doc
  comment (`:89-100`) states the two-step as the contract. Removing it from `STAGED_TOOLS` is what
  stops confirm-discipline flagging a correct one-shot call.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] one call with resolvable identity writes the L1 capture + visit and returns the recorded id
- [ ] one call with ambiguous identity returns `needs_identity` and writes NOTHING
- [ ] the identity resume (`confirmId + confirmed`) returns `recorded`, not `needs_confirmation`
- [ ] **a repeated identical call does not write a second capture or a second visit** and reports
      `duplicate` (the idempotency decision, locked in)
- [ ] the same text for a DIFFERENT customer on the same day records separately (identity is in the key)
- [ ] regression: an already-staged `pending_field_note` still commits via `confirmId` alone
- [ ] `record_standing_fact` still returns `needs_confirmation` on its first call
- [ ] the §0c refresh actually replaces the block: run the awk against a fixture AGENTS.md that
      already carries the old text and assert the new text is present exactly once
- [ ] mutation: make the one-shot path stage instead → test 1 fails; drop `identityKey` from the
      hash → the different-customer test fails

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP
- [ ] Compare `raw_captures` of channel `technician_note` against `review_items` of kind
      `pending_field_note` in the 24h after deploy. Expect captures to continue and stages to fall —
      **not to zero**, because `needs_identity` still stages. Report both counts rather than
      asserting a direction.

### Manual verification
- [ ] none
