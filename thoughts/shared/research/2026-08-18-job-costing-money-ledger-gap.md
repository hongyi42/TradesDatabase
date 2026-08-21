---
date: 2026-08-18
branch: docs/agent-first-front-door
commit: 6d49e3b
topic: Job costing — what exists today between the money ledger's revenue side and a revenue-minus-cost margin number
---

## Summary

The repo has a **money ledger** (`money_events`) that records what a job *earned*: estimates,
invoices, payments, credits, write-offs. It has no notion of what a job *cost*. "Cost" appears
twice in the codebase and neither instance is customer-job cost: `cost_ledger` /`cost_events`
track **our own vendor API spend** (tokens, requests), and `visits.labor_hours` records **hours**
with no rate anywhere to multiply them by. So the gap named in the Reddit corpus — an owner who
cannot see that a job cleared 8% — is, in this codebase, three separate missing pieces: (1) no
cost events, (2) no labor rate, (3) no place that shows a per-job or cross-job margin.

The good news, and the single most important structural finding: **the revenue fold is
kind-additive, not sign-additive.** Every number in `summarizeMoney` comes from a per-kind sum
([moneyEvents.ts:266-267](src/db/moneyEvents.ts#L266-L267)), so an event kind the fold has never
heard of contributes to exactly nothing — balance due, quoted, invoiced, paid and the
status-derivation gate are all structurally immune to new kinds landing in the same stream. The
"direction comes from kind, never sign" doctrine is not aspirational; it is enforced by the shape
of the code.

The breakage from adding cost kinds is therefore **not** in the fold. It is in two places the
fold does not own: the **SQL view** `v_money_events`, which hands the manager's agent raw
`amount_cents` rows and invites `sum(amount_cents)` (server.ts tells the agent to watch out for
void pairs, but nothing about direction-by-kind), and **`MoneySummary`'s shape**, which has no
cost slot and is the object both the manager and the technician tier projections are built from.

Two corrections to the premises in the brief, both verified against the tree:
- **`tenants.money_digest_last_sent_at` does not exist.** It is a Phase-3 line in part B's plan,
  which is `status: draft`. `src/money/` does not exist either — *none* of part B is built.
- The **fold-preview pattern** the brief asked me to find (`findFoldImpact`) is the *retraction*
  impact scanner, not a money-staging pattern. The staging/confirm machinery money would reuse is
  the `review_items` stage→confirm two-step, which is a different mechanism.

## Entry Points

| Where the area begins | What starts there |
|---|---|
| [supabase/migrations/20260815160000_money_events.sql:12-25](supabase/migrations/20260815160000_money_events.sql#L12-L25) | The `money_event_kind` enum — the whole vocabulary, all 11 kinds revenue/AR |
| [src/db/moneyEvents.ts:246](src/db/moneyEvents.ts#L246) | `summarizeMoney` — the one definition of "the balance" |
| [src/db/moneyEvents.ts:301](src/db/moneyEvents.ts#L301) | `deriveStatusTarget` — the ledger's opinion about `job_status` |
| [src/mcp/server.ts:1368](src/mcp/server.ts#L1368) | `record_money_event` tool definition (manager-only) |
| [src/mcp/server.ts:5226](src/mcp/server.ts#L5226) | `record_money_event` handler |
| [src/writePath/extract.ts:32-38](src/writePath/extract.ts#L32-L38) | `EXTRACTION_SYSTEM` — the prompt that currently discards stated prices |
| [src/writePath/extract.ts:8-24](src/writePath/extract.ts#L8-L24) | `ExtractedFields` — where `laborHours` already lives |
| [src/jobs/watchers.ts:93](src/jobs/watchers.ts#L93) | `NUDGE_BUDGET_PER_PERSON_DAY = 2` |

## Key Files

**Ledger core**
- [supabase/migrations/20260815160000_money_events.sql](supabase/migrations/20260815160000_money_events.sql) — table, enum, append-only trigger (:51-53), dedupe index (:57-59), `v_money_events` (:67-84) + `grant select … to spine_reader` (:86), RLS-no-policy posture (:95-97). `amount_cents` is `check (… >= 0)` (:36) — the sign is not available as a direction channel, by design.
- [src/db/moneyEvents.ts](src/db/moneyEvents.ts) — `MONEY_EVENT_KINDS` (:11-24), `AMOUNTLESS_KINDS` (:33-37), `MUST_REFERENCE`/`NEGATING_KINDS` (:45-46), `appendMoneyEvent` (:80-170), `MoneySummary` (:210-223), `negatedIds` (:231-239), `summarizeMoney` (:246-289), `deriveStatusTarget` (:301-334), `transitionPath` (:339-354), `syncJobStatusForMoney` (:369-392), `technicianMoneyView` (:400-404).
- [src/db/jobs.ts:30-38](src/db/jobs.ts#L30-L38) — `ALLOWED_TRANSITIONS` incl. the two backward edges the ledger added; [jobs.ts:178-200](src/db/jobs.ts#L178-L200) `updateJobStatus` (validate + CAS).

**Agent surfaces**
- [src/mcp/server.ts:1368-1430](src/mcp/server.ts#L1368-L1430) — tool schema; `kind` enum is spread from `MONEY_EVENT_KINDS` (:1391-1394), so a new kind appears in the manager's tool automatically.
- [src/mcp/server.ts:5226-5300](src/mcp/server.ts#L5226-L5300) — handler: strict per-arg type guards (:5231-5239), one-shot, "landed from here on" no-retry posture (:5277-5288).
- [src/mcp/server.ts:2207-2225](src/mcp/server.ts#L2207-L2225) — `get_customer_context` `moneyByJob` (summaries only, omitted when empty).
- [src/mcp/server.ts:2244-2288](src/mcp/server.ts#L2244-L2288) — `get_job` money block; tier split at :2263-2277.
- [src/mcp/server.ts:1090-1094](src/mcp/server.ts#L1090-L1094) — the `v_money_events` paragraph in `query_spine`'s description. **This is the text that would go wrong.**

**Write path / extraction**
- [src/writePath/extract.ts:41-71](src/writePath/extract.ts#L41-L71) — `EXTRACTION_TOOL` forced-tool schema; `laborHours` at :56.
- [src/writePath/recordFieldNote.ts:196](src/writePath/recordFieldNote.ts#L196) — the single extractor call; :267-274 builds the visit incl. `laborHours`; :283-288 the status-signal gate; `NOTE_SIGNAL_TRANSITIONS` at :89-95.

**Staging / questions / nudges**
- [src/db/reviewItems.ts:10-59](src/db/reviewItems.ts#L10-L59) — `ReviewKind`, 21 kinds, **no money kind**; `upsertOpenReviewItem` at :74.
- [src/db/foldImpact.ts:24-109](src/db/foldImpact.ts#L24-L109) — `FoldImpact`/`findFoldImpact`: retraction impact, *not* money.
- [supabase/migrations/20260817090000_nudges.sql:19-56](supabase/migrations/20260817090000_nudges.sql#L19-L56) — `nudges` table + `uq_nudges_subject_ever`.
- [src/db/nudges.ts:25-36](src/db/nudges.ts#L25-L36) `BUDGET_HOLDING_STATUSES`; :38-44 `CreatePendingNudgeInput` (`kind: ReviewKind`); :51-66 `createPendingNudge`; :274-291 `countRecentAsks`.
- [src/jobs/watchers.ts:85-94](src/jobs/watchers.ts#L85-L94) tuning constants; :556-620 the rung-1/rung-2 routing incl. the budget check at :594-597.
- [src/teamLead/compose.ts:28-61](src/teamLead/compose.ts#L28-L61) `COMPOSE_TOOL` + `COMPOSE_SYSTEM`; :90-91 the 7am–7pm ask window.

**Precedent for cost-shaped data**
- [supabase/migrations/20260725120000_cost_ledger.sql:3-8](supabase/migrations/20260725120000_cost_ledger.sql#L3-L8) — "stores UNITS, never dollars; prices live in `cost_rates`, versioned by effective date, joined at READ time." :18-19 and :41-46 are the new-row-per-price-change + no-overlap constraint.

**Docs**
- [docs/engineering-memory.md:41-49](docs/engineering-memory.md#L41-L49) — the tenants-only-FK cascade trap.
- [docs/engineering-memory.md:78-90](docs/engineering-memory.md#L78-L90) — "the spine is not the books" + evidence-class tiers, ratified.
- [thoughts/shared/plans/2026-08-15-money-inference-v1.md](thoughts/shared/plans/2026-08-15-money-inference-v1.md) — part B, `status: draft`, unimplemented.

## Data Flows

### What exists today: a voice note becomes hours, never dollars

```
technician speaks
   │
   ▼
recordFieldNote()  ─(1)─► L1 raw_captures  (append-only, verbatim, permanent)
   │
   ├─(2)─► defaultExtractor(rawText)      extract.ts:84-92, ONE model call
   │         forced tool → ExtractedFields{ laborHours, statusSignal, attributes, … }
   │         prompt: "never invent customers, addresses, or prices"   ← prices are DROPPED here
   │
   ├─(4)─► matchIdentity → customer + job
   │
   └─(5)─► createVisit({ laborHours })    recordFieldNote.ts:267-274
              │
              ▼
         visits.labor_hours (numeric)  ──►  read by NOTHING but a synthesis prompt
                                            (src/synthesis/grounding.ts:80)
```

`visits.labor_hours` has been captured since [20260620005307_context_spine.sql:83](supabase/migrations/20260620005307_context_spine.sql#L83). No aggregate, no rate, no rollup reads it.

### The revenue ledger and its fold

```
record_money_event (manager only)
   │  server.ts:5226 — per-arg type guards, no staging (one-shot by doctrine)
   ▼
appendMoneyEvent()                       moneyEvents.ts:80
   │  validates: kind ∈ MONEY_EVENT_KINDS · amount whole & ≥0 · job in tenant
   │             · correctsEventId required for void/correction · one-level negation
   ▼
INSERT money_events        (trigger blocks UPDATE/DELETE forever)
   │
   ├──► syncJobStatusForMoney()          moneyEvents.ts:369
   │      listMoneyEventsForJob → summarizeMoney → deriveStatusTarget
   │      → transitionPath (BFS over ALLOWED_TRANSITIONS) → updateJobStatus per hop
   │
   └──► reply: { eventId, money: MoneySummary, jobStatusChange? }
```

`summarizeMoney` in detail — this is the part that decides whether cost kinds are safe:

```
events[]
  │
  ├─ negatedIds()        :231  collect corrects_event_id from invoice_voided | correction
  │
  ├─ live = events.filter(not negated AND kind ∉ {invoice_voided, correction})    :248-250
  │
  ├─ quoted    = last estimate_approved + change_orders AFTER it                  :256-264
  ├─ sum(kind) = live.reduce(e.kind === kind ? +amount : acc)                     :266-267
  │                             ▲
  │                             └── PER-KIND. An unknown kind matches no sum.
  ├─ invoiced  = sum('invoice_issued')
  ├─ paid      = sum('payment_received') − sum('payment_refunded')
  ├─ balanceDue = invoiced − paid − credits − writtenOff                          :285
  └─ lastEventAt = max over ALL events (not `live`)                               :274-277
```

### Where a question to a human comes from today (two separate machines)

```
                          ┌─────────────────────────────────────────┐
watcher notices a gap ───►│ reachable tech + budget < 2/24h ?       │
(watchers.ts:556-620)     │   yes → createPendingNudge (rung 1)     │──► compose (7am-7pm)
                          │   no  → flagGap → review_items (rung 2) │    ──► tech's own agent
                          │   budget spent → DEFER, never overflow  │
                          └─────────────────────────────────────────┘

manager-facing question ─► upsertOpenReviewItem(kind, subjectRef)  ──► resolve_review
(review_items.ts:74)        one OPEN item per (tenant, kind, subject)
```

`nudges.kind` is typed `ReviewKind` ([nudges.ts:40](src/db/nudges.ts#L40)) — the two stores
deliberately share one vocabulary, so any new gap kind must be added to `ReviewKind` first.

## External Dependencies

None new in this area. The ledger is pure Postgres + the typed Supabase layer. The extractor
rides `src/model/forcedTool.ts` against whatever `MODEL_PROVIDER` selects (GLM-5.2 today).
Nothing accounting-adjacent is installed — no `stripe`/`quickbooks`/`xero` code or dependency
anywhere, confirmed in the part-A research and still true.

## Constraints and Invariants

1. **Kind-additive fold.** `sum()` is per-kind ([moneyEvents.ts:266-267](src/db/moneyEvents.ts#L266-L267)). New enum values are inert in every derived number until someone writes code that reads them.
2. **`amount_cents >= 0` is a DB check** ([migration:36](supabase/migrations/20260815160000_money_events.sql#L36)). Direction can only ever come from `kind`.
3. **Both L1 and the ledger are append-only, trigger-enforced.** A wrong cost is corrected by a new row; the wrong verbatim text in L1 is permanent regardless.
4. **`correction` already works on any kind.** `appendMoneyEvent` only special-cases `invoice_voided`→must-target-`invoice_issued` ([:119-123](src/db/moneyEvents.ts#L119-L123)) and forbids negating a negation ([:124-129](src/db/moneyEvents.ts#L124-L129)). A `correction` pointing at a hypothetical `material_cost` row would validate, and `negatedIds`/`live` would drop it from the fold — **corrections come free for new kinds.**
5. **`lastEventAt` scans all events, not `live`** ([:274-277](src/db/moneyEvents.ts#L274-L277)). A cost entry would move a job's "last money activity" timestamp.
6. **`deriveStatusTarget`'s gate is `invoice_issued`-only** ([:309-311](src/db/moneyEvents.ts#L309-L311)). Cost kinds cannot advance, block, or walk back a job status.
7. **`MONEY_EVENT_KINDS` is spread into the tool schema** ([server.ts:1391-1394](src/mcp/server.ts#L1391-L1394)). Adding an enum value exposes it to the manager's agent with no further wiring — and with no description, since kind descriptions live only in the prose blob at :1370-1385.
8. **`v_money_events` exposes raw `kind` + `amount_cents` to agent-written SQL** ([migration:67-84](supabase/migrations/20260815160000_money_events.sql#L67-L84)). The `query_spine` description warns about void pairs only ([server.ts:1092-1094](src/mcp/server.ts#L1092-L1094)).
9. **No labor rate exists.** Grep for `hourly|hourly_rate|labor_rate|cost_per_hour|burden` across `src/` and `supabase/` returns nothing. `technicians` has no rate column ([20260702194603:8-22](supabase/migrations/20260702194603_technicians_and_review_items.sql#L8-L22)); neither does `tenants` ([database.types.ts:1623-1633](src/db/database.types.ts#L1623-L1633)).
10. **The house pattern for rated units is `cost_ledger`**: units in events, dollars in a versioned rate table, joined at read time, *explicitly* so history re-prices ([cost_ledger.sql:3-8](supabase/migrations/20260725120000_cost_ledger.sql#L3-L8)).
11. **Evidence-class tiers are ratified doctrine, not code.** [engineering-memory.md:78-90](docs/engineering-memory.md#L78-L90) states them; nothing implements them.
12. **Nudge budget slots are claimed at CREATION** ([nudges.ts:25-36](src/db/nudges.ts#L25-L36)), and `uq_nudges_subject_ever` ([nudges.sql:51-56](supabase/migrations/20260817090000_nudges.sql#L51-L56)) means a subject is asked about **once, ever** — deliberately not partial.
13. **Escalation is at most two touches per gap** — tech's agent, then manager, never a third (ratified, [engineering-memory.md](docs/engineering-memory.md#L51)).
14. **`money_events` is not named in either cleanup list** ([world.mjs:99-126](scripts/spine-eval/world.mjs#L99-L126), [seed.mjs:136-165](scripts/seed.mjs#L136-L165)). It *is* reached today via `truncate … jobs … cascade`, so nothing is broken — but eng-mem §1's rule is "register BY NAME; incidental cascade coverage is how `tenant_profiles` got missed."
15. **Enum values cannot be removed in Postgres.** A cost-kind name chosen wrongly is effectively permanent.

## The six questions

### 1. Where do costs live? — recommendation: new kinds, with one carve-out

**Recommendation: new `money_event_kind` values, not a new table and not L3 attributes.** The
prior in the brief holds up, and for a sharper reason than the doctrine quote: the fold is
kind-additive, so cost kinds are *provably* inert in the revenue math. That is not a promise, it
is [moneyEvents.ts:266-267](src/db/moneyEvents.ts#L266-L267). Everything else the ledger gives —
append-only, `source_capture_id` evidence link, `dedupe_key` idempotency, correction semantics
that already work for arbitrary kinds, the tenant-filtered view, the RLS posture, one write-side
guard in `appendMoneyEvent` — is machinery a separate table would have to re-earn line by line.

Trade-offs, stated plainly:

| | New kinds in `money_events` | Separate `job_cost_events` table | L3 `attributes` |
|---|---|---|---|
| Fold safety | Structural (per-kind sums) | Structural (different stream) | N/A — no fold |
| Reuses append-only + evidence link + dedupe + corrections | Yes, all of it | Rebuild each | No append-only guarantee |
| `v_money_events` / agent SQL | **Gets polluted — must be fixed** | Clean separation | N/A |
| Cleanup-cascade trap | N/A | Avoided if FK'd to `jobs`; hits eng-mem §1 if FK'd only to `tenants` | N/A |
| Cost-specific columns (qty, unit, vendor, sku) | Only in `detail` JSONB | First-class columns | Free-form |
| Migration | `alter type … add value` ×N | New table + view + RLS + grants + cleanup registration | None |
| "Graduates to a real table when someone needs to query across it" (recorded bar) | Not met yet | Not met yet | Where it lives until met |

The carve-out: **a labor rate is not an event and does not belong in `money_events` in any
form.** `visits.labor_hours` × rate is exactly the shape `cost_ledger` was built for — units in
events, dollars in a versioned rate table joined at read time
([cost_ledger.sql:3-8](supabase/migrations/20260725120000_cost_ledger.sql#L3-L8)) — and for the
same reason: a tech's loaded rate changes, and every historical job must re-price when it does. A
rate stored as a `labor_cost` event amount freezes history at the rate that happened to be true
that week. If labor cost is in scope, it needs a rate table (or a rate on `technicians` with
effective dating), and that is a genuinely separate design question from the four material-ish
kinds.

If a separate table is chosen instead: **FK it to `jobs(id)`, not only to `tenants(id)`**, and
name it in `scripts/spine-eval/world.mjs` RESET_TABLES and `scripts/seed.mjs` truncateSpine
anyway (eng-mem §1). Note `money_events` itself is currently unnamed in both.

### 2. What breaks in `summarizeMoney` and `deriveStatusTarget` — precisely

**Nothing in the arithmetic.** Enumerated:

| Site | Effect of an unknown/cost kind | Verdict |
|---|---|---|
| `negatedIds` [:231-239](src/db/moneyEvents.ts#L231-L239) | Only reads `invoice_voided`/`correction` | Safe |
| `live` filter [:248-250](src/db/moneyEvents.ts#L248-L250) | Cost rows pass through into `live` | Safe (nothing sums them) |
| `quoted` [:256-264](src/db/moneyEvents.ts#L256-L264) | Indexes over `live`, matches `estimate_approved`/`change_order` only | Safe |
| `sum()` [:266-267](src/db/moneyEvents.ts#L266-L267) | Per-kind equality | **Safe — this is the load-bearing line** |
| `balanceDueCents` [:285](src/db/moneyEvents.ts#L285) | Composed of four named sums | Safe — a material cost cannot become revenue |
| `hasProgressInvoice` [:287](src/db/moneyEvents.ts#L287) | `invoice_issued` + `detail.progress` | Safe |
| `lastEventAt` [:274-277](src/db/moneyEvents.ts#L274-L277) | Scans **all** events | **Changes meaning** — becomes "last money-or-cost activity" |
| `deriveStatusTarget` gate [:309-311](src/db/moneyEvents.ts#L309-L311) | `invoice_issued`, non-negated, non-progress | Safe |
| `deriveStatusTarget` target [:332](src/db/moneyEvents.ts#L332) | `balanceDueCents <= 0` | Safe *because* balanceDue is safe |
| `hadRealInvoice` walk-down [:322-325](src/db/moneyEvents.ts#L322-L325) | `invoice_issued` only | Safe |

What actually breaks is outside the fold:

1. **`v_money_events` + `query_spine` — the real one.** The view hands the manager's agent
   `kind, amount_cents` with no direction column, and the tool description
   ([server.ts:1090-1094](src/mcp/server.ts#L1090-L1094)) currently teaches exactly one summing
   caveat (exclude both sides of a cancelled pair). The moment cost kinds share the enum, every
   agent-written `sum(amount_cents)` — "what did we bill in July" — silently nets revenue against
   cost. This is not a fold bug; it is a **prompt-and-view** bug, and it is the one thing on this
   list that produces a wrong number in front of a manager. Either the view gains a
   direction/`is_cost` column, or the description gains a mandatory kind filter, or both.
2. **`MoneySummary` has no cost slot** ([:210-223](src/db/moneyEvents.ts#L210-L223)). Any margin
   number means widening this interface — and it is the input to `technicianMoneyView`
   ([:400-404](src/db/moneyEvents.ts#L400-L404)), the single definition of the money tier
   boundary. Whether a technician sees job cost or margin is a **new tier decision** that
   `technicianMoneyView` will have to encode; today it exposes `balanceDueCents` +
   `invoicedCents` only.
3. **The "absence means untracked" convention.** `get_job` attaches money only when
   `moneyEvents.length > 0` ([server.ts:2260-2262](src/mcp/server.ts#L2260-L2262)) precisely
   because a zero-summary reads as "fully paid." A job with cost events but no revenue events
   would now attach a money block whose `balanceDueCents: 0` means "nothing invoiced yet" — the
   exact misreading that comment exists to prevent.
4. **`record_money_event`'s description** ([:1370-1385](src/mcp/server.ts#L1370-L1385)) says
   "Amounts are IN CENTS and always positive — **the kind carries the direction**" and then
   enumerates only revenue kinds. New kinds appear in the schema enum automatically
   ([:1391-1394](src/mcp/server.ts#L1391-L1394)) but described nowhere.
5. **`AMOUNTLESS_KINDS` / `MUST_REFERENCE`** ([:33-46](src/db/moneyEvents.ts#L33-L46)) — cost
   kinds must be in neither, so they inherit the "amount required, whole, ≥0" rule. That is
   correct by default; worth an explicit test rather than an assumption.

### 3. How the extractor changes

Mirroring `laborHours` exactly. `ExtractedFields`
([extract.ts:8-24](src/writePath/extract.ts#L8-L24)) gains one optional field; the forced-tool
schema ([:41-71](src/writePath/extract.ts#L41-L71)) gains the matching property; **the model call
count does not change** — this is the same single call at
[recordFieldNote.ts:196](src/writePath/recordFieldNote.ts#L196).

The shape part B already specified for money in notes is a single `moneySignal` object with
`amountDollarsText` — a *string*, deliberately, so code can verify the literal appears in the
note before parsing it to cents (part B's "grounding gate"). Costs want the same discipline plus
a plurality allowance, since one note can name several parts:

```ts
// ExtractedFields, alongside laborHours
costSignals?: Array<{
  kind: 'material_cost' | 'equipment_rental' | 'subcontractor_cost' | 'mileage';
  amountDollarsText: string;   // VERBATIM from the note — "40", "$40", "forty bucks" stays absent
  description?: string;        // "condensate pump"
}> | null;
```

`amountDollarsText` as a string is what makes the grounding check possible: parse to cents, then
require the literal substring in `rawText` (whitespace/comma-tolerant) before anything is
proposed. `laborHours` uses `type: 'number'` and relies on `coerceBySchema`
([forcedTool.test.ts:215-228](src/model/forcedTool.test.ts#L215-L228)) — fine for hours, wrong
for money, where "the model identifies, never invents" needs a verbatim anchor.

The prompt change, `EXTRACTION_SYSTEM` at [extract.ts:32-38](src/writePath/extract.ts#L32-L38).
Current text:

> …leave a field absent if the note does not support it; never invent customers, addresses, or prices.

The minimal edit that flips prices from *forbidden* to *quoted-only*:

> …leave a field absent if the note does not support it; never invent customers, addresses, or
> prices. **Never INVENT a price — but DO extract prices the note states, copying the amount
> exactly as spoken into `amountDollarsText` (write "40" for "forty dollars"; if no number is
> stated, leave the entry out entirely).**

Two facts that constrain this and are easy to miss:
- The note text is already in L1 verbatim before extraction runs
  ([recordFieldNote.ts:107-182](src/writePath/recordFieldNote.ts#L107-L182)). Extracting a price
  adds no new L1 exposure — the spoken "$40" is already permanent. The classify-before-L1 rule is
  therefore **not** engaged by this change; it would be engaged by any *new capture channel*.
- The extractor re-runs on redelivery of an unmatched capture (documented at
  [recordFieldNote.ts:118-122](src/writePath/recordFieldNote.ts#L118-L122)). Anything downstream
  of extraction must be idempotent per capture — which is what `dedupe_key` and the
  one-open-review-item-per-subject index are for.

### 4. Evidence class — confirmed, and the mechanism does not exist yet

**Confirmed, verbatim from ratified doctrine**
([engineering-memory.md:78-90](docs/engineering-memory.md#L78-L90)): spine-performed actions
record as fact; the manager's own outbound artifact auto-records with disclosure and a cap;
"everything else (notes, inbound, transcripts) only ever becomes a QUESTION — the ledger gains
the entry when the manager confirms." Part B fixes the cap at
`MONEY_AUTO_RECORD_CAP_CENTS = 1_000_000` ($10k) and names field notes **Class 3** explicitly.

So yes: a technician's spoken "$40 condensate pump" must land as a proposal, never a row. Note
the cap is irrelevant here — Class 3 never auto-records at *any* amount.

**The mechanism to carry it does not exist.** Three gaps:
- `ReviewKind` ([reviewItems.ts:10-59](src/db/reviewItems.ts#L10-L59)) has no money kind.
  `money_event_suggestion` is a part-B line item, unbuilt.
- `src/money/` does not exist — no `applyMoneyInference`, no grounding gate, no attribution.
- **The fold-preview pattern the brief points at is a different thing.** `findFoldImpact`
  ([foldImpact.ts:57-109](src/db/foldImpact.ts#L57-L109)) answers "what disappears if this
  capture is retracted" — standing facts and visits citing it — and is consumed only by the
  retraction flow ([server.ts:1774-1822](src/mcp/server.ts#L1774-L1822), :2769). It has no money
  awareness and is not a staging mechanism.

The pattern that *is* the staging path is the `review_items` **stage→confirm two-step**:
`upsertOpenReviewItem` ([reviewItems.ts:74](src/db/reviewItems.ts#L74)) with the partial unique
index giving one open item per `(tenant, kind, subject)`, resolved through the `resolve_review`
handler. Part B's design uses `subject_ref = captureId`, which gives exactly-one-question-per-note
idempotency across the redelivery re-runs noted above — and it survives the append-only
constraint, because a dismissed suggestion stays dismissed without anything being mutated in L1.

For costs specifically, one wrinkle the revenue design did not have: **one note can propose
several costs.** `subject_ref = captureId` yields one review item carrying an array in `detail`
(one question, "Ben's note lists a $40 pump and a $75 rental — record both?"), whereas
`subject_ref = captureId + ':' + index` yields one item per line. The former matches the
ask-once-batched doctrine; the latter matches the ledger's one-row-per-fact grain. This is a
genuine fork — see Decision Points.

Also unbuilt and load-bearing: nothing in `resolve_review` today *creates a ledger row on
resolve*. Part B's design has resolve mean "the manager records it via `record_money_event`" —
i.e. the confirm is a hand-off, not an automatic write. Whether cost confirmation gets a real
one-tap confirm-writes-the-row path is a design question the revenue side deferred.

### 5. What gets shown, and where

**The digest column does not exist.** `tenants` has 8 columns — `created_at`,
`default_job_minutes`, `id`, `manager_seats`, `name`, `technician_horizon_days`,
`technician_seats`, `timezone` ([database.types.ts:1623-1633](src/db/database.types.ts#L1623-L1633)).
No migration adds `money_digest_last_sent_at`; it is a Phase-3 line in part B's plan
([money-inference-v1.md](thoughts/shared/plans/2026-08-15-money-inference-v1.md), `status: draft`).
The plan's *reasoning* is what survived and is worth keeping: `ops_events` cannot host this
cadence (host-scoped FK + one-open-per-service index), so a tenant column is the shape, following
the `technician_horizon_days` precedent.

**The prior is well-supported but the framing is slightly off.** The Reddit finding is a
cross-job pattern — "these small jobs aren't as good as they look" — and nothing in the code
surfaces cross-job anything today. But note that "the digest" is not the only cross-job surface
that exists: **`query_spine` already is one.** A manager can ask "which jobs last month cost more
than they billed" the moment `v_money_events` carries cost rows and the description teaches the
direction filter — no digest, no migration, no cadence. That is the cheapest cross-job margin
surface in the repo and it is one view + one prompt paragraph away.

The challenge to the prior is therefore not "put it on the job" but "the digest is a *cadence*
decision, not a *surface* decision." Three surfaces exist independently:
- **Per-job** (`get_job` money block, [server.ts:2260-2277](src/mcp/server.ts#L2260-L2277)) —
  where a margin number is cheapest to add and least useful, and where it collides with the
  absence-means-untracked convention (finding 3 above). Also the tier question:
  `technicianMoneyView` decides whether a tech sees it.
- **Ad-hoc cross-job** (`query_spine` / `v_money_events`) — exists, needs the direction fix
  *regardless* of what else is built, because without it the agent silently nets revenue against
  cost.
- **Pushed weekly** (the digest) — needs a new `tenants` column, a `setMoneyDigestSentAt`
  writer, and a step in `src/jobs/lifecycle.ts` (which today runs 8 steps on a `*/5` pulse with a
  quarter-hour gate for the heavy ones, [lifecycle.ts:140-318](src/jobs/lifecycle.ts#L140-L318)).

### 6. Should cost-chasing ride the nudge system?

Structurally it fits, with three concrete consequences.

**The shape matches.** A completed job with no cost recorded is a deterministic, code-detectable
gap — the same class as "confirmed visit ended, nothing reported." The nudge machinery already
carries: once-ever dedup per subject
([nudges.sql:51-56](supabase/migrations/20260817090000_nudges.sql#L51-L56)), a compose turn that
sees *only* code-built `context` ([nudges.sql:33-35](supabase/migrations/20260817090000_nudges.sql#L33-L35)),
a 7am–7pm firm-local ask window ([compose.ts:90-91](src/teamLead/compose.ts#L90-L91)), delivery
through the person's own agent, and a 48h escalation to the manager
([watchers.ts:94](src/jobs/watchers.ts#L94)).

**What it does to the budget.** The budget is **2 asks per person per rolling 24 hours, no
firm-wide cap** ([watchers.ts:93](src/jobs/watchers.ts#L93),
[nudges.ts:274-291](src/db/nudges.ts#L274-L291)), a slot is claimed at *creation* not delivery
([nudges.ts:25-36](src/db/nudges.ts#L25-L36)), and an over-budget gap **defers silently — it never
overflows onto the manager** ([watchers.ts:597](src/jobs/watchers.ts#L597)). Cost questions and
work-gap questions would draw on the same two slots with **no priority ordering between them** —
the watcher processes candidates oldest-scheduled-end-first within one kind
([watchers.ts:558-560](src/jobs/watchers.ts#L558-L560)), and there is no cross-kind arbitration
anywhere. A busy technician who finished three jobs in a day generates three cost gaps and two
slots; one silently defers, and there is no code today that decides *which* two questions are
worth the day's budget.

**Three concrete blockers, all small but none zero:**
1. `nudges.kind` is typed `ReviewKind` ([nudges.ts:40](src/db/nudges.ts#L40)) — a cost kind must
   be added to `reviewItems.ts:10-59` first, shared by both stores by design.
2. `subject_ref` would be a **jobId**, where every existing nudge subject is an **assignmentId**
   ([nudges.sql:26-28](supabase/migrations/20260817090000_nudges.sql#L26-L28)). The column is
   plain text and the unique index is `(tenant, kind, subject_ref)`, so this works — but the
   uniqueness rationale changes. "An assignment's end never recurs, so re-asking is never right"
   does not transfer: a job *does* accrue costs over time, and once-ever means the second
   material purchase on the same job is never asked about.
3. `COMPOSE_SYSTEM` ([compose.ts:50-61](src/teamLead/compose.ts#L50-L61)) is written for exactly
   one question — "how did the visit go" — and explicitly forbids the model from inventing
   "any fact, name, **price**, link, or detail beyond the evidence given." A cost question needs
   its own prompt, and that prohibition is exactly right to keep.

Also worth stating: the ratified ceiling says the team-lead identity may **read/ask/stage — never
commit** ([engineering-memory.md:51](docs/engineering-memory.md#L51)). A nudge asking about costs
is asking; the technician's answer returns through `record_field_note`, hits the extractor, and —
per question 4 — lands as a Class-3 suggestion for the manager. The loop closes without the team
lead ever writing money. That is consistent end to end.

## Migration and fold-logic flags

**Needs a migration:**
- `alter type money_event_kind add value if not exists '<kind>'` per new kind. Four precedents
  exist ([20260630000000](supabase/migrations/20260630000000_outbound_email_channel.sql#L7),
  [20260706090000](supabase/migrations/20260706090000_retraction_rows.sql#L7),
  [20260704120000](supabase/migrations/20260704120000_agent_action_sensitivity_sessions.sql#L13),
  [20260723090000](supabase/migrations/20260723090000_promise_time_only_value.sql#L13)) — all of
  them add the value in a migration file that does **not** use it. That is not decoration:
  Postgres will not let a newly added enum value be *used* in the same transaction that adds it,
  and Supabase migrations run in a transaction. Any backfill or seed touching a new kind belongs
  in a later migration.
- Enum values are **not removable**. Kind names are effectively permanent.
- `v_money_events` would need `create or replace view` if it gains a direction/`is_cost` column.
- `tenants.money_digest_last_sent_at` if the weekly digest is built (does not exist today).
- A labor-rate table, if labor cost is in scope.
- Regenerate `src/db/database.types.ts` after any of these.

**Touches the fold logic PR #146 landed:**
- `MoneySummary` interface ([:210-223](src/db/moneyEvents.ts#L210-L223)) — widening it touches
  every consumer: `get_job`, `get_customer_context`, the `record_money_event` reply, and
  `technicianMoneyView`.
- `technicianMoneyView` ([:400-404](src/db/moneyEvents.ts#L400-L404)) — the single definition of
  the money tier boundary; a cost/margin field forces a tier decision here.
- `summarizeMoney` ([:246-289](src/db/moneyEvents.ts#L246-L289)) — only if cost totals are
  computed inside it. The per-kind sums themselves need no change.
- `lastEventAt` ([:274-277](src/db/moneyEvents.ts#L274-L277)) — semantics shift silently.
- The `record_money_event` description ([server.ts:1370-1385](src/mcp/server.ts#L1370-L1385)) and
  the `query_spine` `v_money_events` paragraph ([server.ts:1090-1094](src/mcp/server.ts#L1090-L1094)).
- `moneyEvents.test.ts` — the representability matrix (five firm archetypes) is the acceptance
  test for "workflow-agnostic with zero schema change"; cost kinds are a sixth axis it does not
  cover.
- **Not touched:** `deriveStatusTarget`, `syncJobStatusForMoney`, `transitionPath`,
  `ALLOWED_TRANSITIONS`, `NOTE_SIGNAL_TRANSITIONS`, `TERMINAL_STATUSES`.

## Decision Points

1. **Cost events: new kinds vs. new table.** New kinds inherit append-only, evidence links,
   dedupe, corrections and the tenant view for the price of an `alter type` — and pollute
   `v_money_events` for agent-written SQL. A separate table keeps the SQL surface clean and can
   carry qty/unit/vendor columns, at the cost of rebuilding every guarantee and registering
   itself in both cleanup lists.
2. **Labor cost: in scope or not.** `visits.labor_hours` is already captured and read by nothing.
   Turning it into money requires a rate concept that does not exist in any form. Excluding
   labor means the margin number omits the single largest cost in most trades jobs — which is
   part of what the Reddit owner was surprised by (drive time). Including it means designing an
   effective-dated rate table before any margin appears.
3. **One question per note, or one per cost line.** `subject_ref = captureId` gives one batched
   question and matches the ask-once doctrine; `captureId:index` gives one question per line and
   matches the ledger's one-row-per-fact grain. The review-items unique index enforces whichever
   is chosen.
4. **Confirming a suggestion: hand-off or one-tap write.** Part B's revenue design has resolve
   mean "the manager then calls `record_money_event`." A confirm that writes the row directly
   does not exist for any money kind today.
5. **Whether technicians see cost or margin.** `technicianMoneyView` is the one place this is
   decided. Today techs see balance due + invoiced only; payment detail is manager-only by
   standing policy. Cost is arguably different from payment detail — the tech is the one who
   spent it.
6. **Nudge subject uniqueness for a recurring gap.** `uq_nudges_subject_ever` is deliberately not
   partial, on the reasoning that a visit's end never recurs. A job accrues costs repeatedly. Ask
   once ever per job, once per completion, or introduce a re-askable kind — each changes what the
   index means.
7. **Cross-kind budget arbitration.** Two slots per person per day, no ordering between a
   work-gap question and a cost question, and over-budget gaps defer silently. Either a priority
   rule exists, or which question gets asked is an accident of tick ordering.
8. **Where margin first appears.** `query_spine` + a fixed view is the cheapest cross-job surface
   and needs the direction fix anyway; the weekly digest needs a new column, a writer and a
   lifecycle step; per-job is cheapest to render and collides with the
   absence-means-untracked convention.

## Open Questions — what I could not determine from reading alone

1. **Whether the pilot firm's technicians would state amounts at all.** The Reddit corpus is
   unvalidated market signal (its own header says so), and no capture in this repo has been
   tested for cost mentions. The extractor change is cheap; whether the data arrives is not
   answerable from code.
2. **What a "cost" means to a firm that buys from a supply house on account.** Parts picked up on
   a running account have no per-job price at pickup. Whether the spoken number is a real cost, a
   guess, or a markup-inclusive charge is a domain question, not a code question.
3. **Whether `sum(amount_cents)` over `v_money_events` is something the pilot agent actually
   does.** The risk in finding 2.1 is real but its frequency is unknown; `query_audit` logs every
   query ([querySpine.ts:46](src/db/querySpine.ts#L46)) and would answer it
   empirically. I did not query it (read-only research; the pilot DB is live).
4. **Whether adding an enum value invalidates the gateway's cached tool schemas.** MCP tool
   descriptions are cached per process (recorded in the feature-A memory), and
   `MONEY_EVENT_KINDS` is spread into the live tool schema. A deploy is presumably required for
   agents to see a new kind, but I could not confirm the cache-invalidation path by reading.
5. **Whether `money_events` missing from the two cleanup lists has ever bitten.** It is
   cascade-reachable via `jobs` today, so probably not — but a future change to the eval world's
   reset order could expose it, and eng-mem §1 says register by name regardless.
6. **The margin formula itself.** Revenue is unambiguous (`invoicedCents`, or `paidCents`, or
   `quotedCents` — three different numbers). Which one margin divides into is a product decision
   with no code precedent.
