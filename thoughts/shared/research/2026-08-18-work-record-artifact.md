---
date: 2026-08-18
branch: docs/agent-first-front-door
commit: 6d49e3b
topic: Work-record artifact — provable evidence of work performed. What the codebase can evidence today, what it cannot, and the five design questions (time bracket, artifact format, retraction rendering, tool surface, delivery path).
---

## Summary

A homeowner says *"prove you were here for 6.5 hours."* This document asks what our database
could hand them today, and what it would take to hand them something better than a Google Maps
screenshot.

In plain terms: our system stores three layers. **L1** (`raw_captures`) is the verbatim record of
every input event — a technician's dictated note, an inbound email, a phone transcript. It is
**append-only**: a database trigger physically refuses UPDATE and DELETE
([20260620005307_context_spine.sql:117-119](supabase/migrations/20260620005307_context_spine.sql#L117-L119)),
and no code path anywhere sets its `captured_at` timestamp — that column always takes the
database's own clock at insert time
([rawCaptures.ts:33-68](src/db/rawCaptures.ts#L33-L68) names every other column and not that one).
**L2** is the business shape: `customers → jobs → visits`. **L3** is a JSONB `attributes` column on
each L2 row for the long tail.

The headline finding is a **mismatch between what we can prove and what we currently store**.
`visits.labor_hours` — the number that would appear on the disputed invoice — is a plain numeric
column, written from an AI extraction of what the technician *said*
([extract.ts:56](src/writePath/extract.ts#L56) → [recordFieldNote.ts:271](src/writePath/recordFieldNote.ts#L271)).
It is a claim, not evidence. Meanwhile `raw_captures.captured_at` — a server-clocked, undeletable
timestamp on the technician's own words — *is* evidence, and today nothing renders it as such to a
human. The second finding is that **there is no artifact machinery of any kind**: no PDF writer
(`pdf-parse` in [fetchPage.ts:2](src/web/fetchPage.ts#L2) is a *reader*), no document route, no
customer-facing surface, and the product's own sales runbook states the opposite of one —
*"No customer-facing anything. Customers never talk to the assistant."*
([customer-onboarding-runbook.md:286](docs/customer-onboarding-runbook.md#L286)). A work record
would be the spine's first customer-facing artifact, exactly as the invoice research concluded
three days ago ([2026-08-15-invoice-creation.md](thoughts/shared/research/2026-08-15-invoice-creation.md)).

---

## Answers to the five questions

### Q1 — Do we need `started_at` / `completed_at` at all?

**The premise checks out, with one correction and one gap.**

**Correction to the brief:** production code never writes `started_at`/`completed_at`, but the
local seed script does — [scripts/seed.mjs:297](scripts/seed.mjs#L297) sets `completedAt` on a demo
visit. `createVisit` accepts both ([visits.ts:11-12](src/db/visits.ts#L11-L12),
[:26-27](src/db/visits.ts#L26-L27)); the one production caller,
[recordFieldNote.ts:267-274](src/writePath/recordFieldNote.ts#L267-L274), passes only
`laborHours` and `attributes`. So the columns are live in the schema and exercised by seed data,
just never populated by a real note. That matters for any read path that assumes they are always
null.

**The two designs, side by side.**

```
DESIGN A — settable columns              DESIGN B — capture-bracket
─────────────────────────                ────────────────────────────
visits.started_at   = 08:04              raw_captures[1].captured_at = 08:04  "starting on the
visits.completed_at = 14:34              raw_captures[2].captured_at = 14:34   Miller job"
visits.labor_hours  = 6.5                                                     "wrapped up, replaced
                                         elapsed = 6h30m  (DERIVED, not stored) the condenser fan"

Who can change it?                       Who can change it?
  anyone with an UPDATE path.              NOBODY. Trigger raises on UPDATE and
  visits has no append-only trigger        DELETE (context_spine.sql:117-119).
  (context_spine.sql:75-87).               Correcting = APPENDING a retraction
                                           row (retraction_rows.sql:7-16).
Who set the clock?                       Who set the clock?
  whatever wrote it. Could be the           the DATABASE. captured_at is
  model's guess from a note.                `default now()` and appendRawCapture
                                            never names the column.
What survives a subpoena?                What survives a subpoena?
  a number in a mutable row.               two immutable rows, each carrying the
                                           technician's own words, each with a
                                           row-level guarantee nothing edited them.
```

**Which survives an adversarial customer:** Design B, decisively, on three grounds the code
supports:

1. **Immutability is structural, not procedural.** The trigger is
   `before update or delete on raw_captures` — it does not check who you are
   ([:117-119](supabase/migrations/20260620005307_context_spine.sql#L117-L119)). `visits` has no
   such trigger. A mutable column proves the value someone last wrote; an append-only row proves
   the value nobody could rewrite.
2. **The clock is ours, not the claimant's.** Nothing in the repo passes `captured_at` — verified
   by grep across `src`, `supabase`, `scripts`: every non-test hit is a *read*
   ([rawCaptures.ts:158](src/db/rawCaptures.ts#L158),
   [:190](src/db/rawCaptures.ts#L190), [context.ts:142](src/db/context.ts#L142),
   [grounding.ts:90](src/synthesis/grounding.ts#L90)). By contrast, `started_at` would be
   whatever the write path chose to put there, and the only write path we have is an AI extraction
   of a spoken sentence ([extract.ts:32-38](src/writePath/extract.ts#L32-L38)).
3. **The words come with the timestamp.** A `started_at` of 08:04 is assertion. A capture at 08:04
   whose `raw_text` reads *"just pulled up at the Miller place, starting on the condenser"* is
   corroboration — the timestamp and the content vouch for each other, and neither can be edited
   after the fact.

**The gap Design B has today, and it is real.** Technician notes reach L1 at *confirm* time, not
at *speaking* time. `record_field_note` is two-step: the stage branch writes **nothing** to L1 —
it parks the note in `review_items` and stamps `stagedAt` into its `detail` JSONB
([server.ts:1966](src/mcp/server.ts#L1966), [:1983](src/mcp/server.ts#L1983)). The L1 row is
appended only on the confirming second call
([server.ts:2130-2144](src/mcp/server.ts#L2130-L2144)), and that call passes
`sourceMeta: { stagedConfirmId: item.id }` — **not `stagedAt`**
([server.ts:2139](src/mcp/server.ts#L2139)). So:

- `captured_at` = the moment the technician said *yes, record it*, which can be minutes after they
  spoke, and is bounded only by the 15-minute staging TTL
  ([server.ts:2066](src/mcp/server.ts#L2066)).
- The moment they actually spoke lives in `review_items.detail.stagedAt` — a **fully mutable
  table** with no append-only trigger
  ([20260702194603_technicians_and_review_items.sql](supabase/migrations/20260702194603_technicians_and_review_items.sql), `create table review_items`).

For inbound channels the same shape appears differently: real-world time arrives as
`metadata.occurredAt` (Gmail's `message_timestamp`,
[gmail.ts:31](src/inbound/gmail.ts#L31); the call row's `occurred_at`,
[worker.ts:135](src/calls/worker.ts#L135)) and is folded into L1 `metadata`
([recordFieldNote.ts:296-303](src/writePath/recordFieldNote.ts#L296-L303)) — immutable once
written, but *supplied by the source*, not clocked by us. Technician notes pass no `occurredAt`
at all.

Net: the bracket is sound in principle and currently carries a several-minute confirm lag with no
record of the lag inside L1. Closing it means stamping `stagedAt` into the capture's metadata at
commit — a one-line change to an existing `sourceMeta` object, **no migration**.

---

### Q2 — What is the artifact, and what PDF machinery exists?

**PDF machinery in the repo today: none.** The only PDF dependency is `pdf-parse` ^2.4.5 in
`package.json`, used exclusively to *read* fetched PDFs into text
([fetchPage.ts:2](src/web/fetchPage.ts#L2), [:291-297](src/web/fetchPage.ts#L291-L297)). There is
no writer, no templating engine, no HTML email anywhere. `@react-pdf/renderer` was **chosen** as
the renderer in a drafted-but-unimplemented plan
([2026-08-15-invoice-creation-v1.md](thoughts/shared/plans/2026-08-15-invoice-creation-v1.md),
Phase 2) — it is not installed, `tsconfig.json` has no `"jsx"` setting, and `src/money/` does not
exist.

**What *does* exist that a work record would reuse:**

| Piece | Where | State |
|---|---|---|
| Firm letterhead (name, address, phone, licenses, disclosure footer) | `tenant_profiles` ([20260815180000_tenant_profiles.sql](supabase/migrations/20260815180000_tenant_profiles.sql)) | **LANDED.** Migration comment says it verbatim: *"read on every future document render"* (:7) |
| Manager tool to edit it | `set_firm_profile` ([server.ts:1245](src/mcp/server.ts#L1245)) | **LANDED** |
| Read view for it | `v_firm_profile` ([:39-55](supabase/migrations/20260815180000_tenant_profiles.sql#L39-L55)) | **LANDED**, exposed to `query_spine` ([server.ts:1097-1101](src/mcp/server.ts#L1097-L1101)) |
| Money ledger to price from | `money_events` ([20260815160000_money_events.sql](supabase/migrations/20260815160000_money_events.sql)) | **LANDED** |
| Private bucket + signed-URL pattern | `call-audio` ([20260804120000:91-99](supabase/migrations/20260804120000_phone_call_ingest.sql#L91-L99)); upload [fetchRecording.ts:29-33](src/calls/fetchRecording.ts#L29-L33); sign [:37-49](src/calls/fetchRecording.ts#L37-L49) | **LANDED** (machine consumers only — no human has ever received a signed link) |
| `invoices` table, PDF render, `create_invoice` tool | plan only | **NOT BUILT** — no `src/money/`, no `src/db/invoices.ts`, no migration |
| Email attachment | `SendEmailInput` is `{to, subject, body}` ([outbound.ts:16-20](src/composio/outbound.ts#L16-L20)); the Composio call passes exactly three arguments ([:52](src/composio/outbound.ts#L52)) | **NOT BUILT.** Composio's `GMAIL_SEND_EMAIL` *does* document an optional `attachment` param (invoice research §Rails, cited there; **re-verify against live docs per CLAUDE.md before building**) |

**Delivery surfaces that exist, and why none is customer-reachable:**

```
  surface            auth                                      who can reach it
  ─────────────────  ────────────────────────────────────────  ────────────────────────
  Telegram agent     doorman badge → signed gateway header      roster staff only
  Mini App board     Telegram initData HMAC (initData.ts:1-40)  roster staff only
  /admin dashboard   bearer token (httpServer.ts:577)           operators only
  /inbound/*         webhook HMAC (httpServer.ts:495-506)       vendors only
  /control/*         host token (httpServer.ts:508-536)         trades-box-1 only
  everything else    IP allowlist → 403 (httpServer.ts:580-584) nobody
```

Every route is gated on being staff, an operator, a vendor, or the box. **A customer has no
authenticated identity in this system and never has.** So the artifact's format question is
downstream of a bigger one: PDF-as-attachment needs zero new routes (it rides the existing send);
a hosted work-record page needs the repo's first public route and its first capability-URL design.
That is exactly the fork the invoice research recorded (its Decision Point 1), where the user
already chose PDF.

---

### Q3 — What goes on it, and how is a retraction rendered?

**What we can cite today, per line.** These are the fields that already carry, or can reach, an L1
capture id:

| Line on the record | Source | Evidence link |
|---|---|---|
| Arrival / departure statements | `raw_captures.raw_text` + `captured_at` | the capture **is** the evidence |
| Labor hours | `visits.labor_hours` | `visits.source_capture_id` ([context_spine.sql:85](supabase/migrations/20260620005307_context_spine.sql#L85), [:113-114](supabase/migrations/20260620005307_context_spine.sql#L113-L114)) |
| Work performed / follow-up | `visits.attributes.workPerformed` / `.followUp` | same `source_capture_id` (visit attributes are plain values, [recordFieldNote.ts:305-315](src/writePath/recordFieldNote.ts#L305-L315)) |
| Standing facts (gate code, access notes) | `customers/jobs.attributes` | the fact bundle carries its own `sourceCaptureId` + `recordedAt` ([standingFacts.ts:9-13](src/db/standingFacts.ts#L9-L13)) |
| Money position | `money_events` | `money_events.source_capture_id` ([20260815160000:40](supabase/migrations/20260815160000_money_events.sql#L40)) |
| Firm letterhead | `tenant_profiles` | *no capture link* — it is configuration, not evidence |
| Photos | — | **nothing to cite.** `blob_path` exists ([context_spine.sql:100](supabase/migrations/20260620005307_context_spine.sql#L100)) but no upload path exists; the only writer is call audio ([worker.ts:132](src/calls/worker.ts#L132)). `record_field_note`'s `blobPath` is a model-supplied string ([server.ts:264](src/mcp/server.ts#L264)) with nothing to put a file there |

**Retraction: three patterns already exist, and they behave differently.** This matters, because
"show the retraction" is not one behavior in this codebase — it is three, and a work record has to
pick.

```
                 ┌─────────────────────────────────────────────────────────────┐
  DEFAULT READ   │ foldRetractions() — retracted rows AND the retraction rows   │
  (everyone)     │ themselves vanish. rawCaptures.ts:235-240                    │
                 │ + visits whose source capture was retracted   context.ts:166 │
                 │ + standing facts citing it     standingFacts.ts:42-51        │
                 └─────────────────────────────────────────────────────────────┘
                 ┌─────────────────────────────────────────────────────────────┐
  AUDIT READ     │ includeRetracted:true — rows come back LABELED:              │
  (manager only) │   {...row, retracted:true, retraction:{id, reason, by, at}}  │
                 │ server.ts:2349-2364. Manager badge required, server.ts:2328  │
                 └─────────────────────────────────────────────────────────────┘
                 ┌─────────────────────────────────────────────────────────────┐
  BLAST-RADIUS   │ findFoldImpact() — "what disappears if I retract this":      │
  PREVIEW        │ every fact and visit citing the capture. foldImpact.ts:57    │
                 │ Shown as willAlsoRemove BEFORE the retraction commits,       │
                 │ echoed as alsoRemoved after.  server.ts:2776, :1804-1823     │
                 └─────────────────────────────────────────────────────────────┘
```

The `list_recent_captures` audit read is the exact pattern the brief is asking for, and it already
exists in production shape: it does not drop the row, it decorates it with **who retracted it, why,
and when** ([server.ts:2350-2364](src/mcp/server.ts#L2350-L2364)). A work record that renders
retracted evidence with those three fields is not new machinery — it is the manager audit view
pointed at a document template.

Two constraints on that, both load-bearing:

- **The audit view is manager-gated by explicit user decision (2026-07-06).** The dispatch throws
  `includeRetracted requires a manager badge` ([server.ts:2328-2330](src/mcp/server.ts#L2328-L2330)),
  and the comment above it records the decision: *"technicians always get the folded view."* A
  customer-facing artifact showing retractions is a **wider** disclosure than any technician
  currently gets.
- **At most one retraction per capture**, enforced structurally by a partial unique index
  ([20260706090000:15-16](supabase/migrations/20260706090000_retraction_rows.sql#L15-L16)) — so
  the render is always `capture + at most one retraction`, never a chain. And a retraction cannot
  itself be retracted ([server.ts:2722](src/mcp/server.ts#L2722)).

**The honesty problem is sharper than "don't silently drop".** Retraction does **not** revert side
effects. The tool description says so explicitly: *"Only other side effects the note caused — e.g.
a job status change — are NOT auto-reverted"* ([server.ts:523](src/mcp/server.ts#L523)).
So a retracted note can leave a job sitting in `completed` and — under the money ledger — leave an
`invoice_issued` event standing. A work record that shows the retraction but prints a total derived
from the retracted note's hours would be a subtler lie than one that dropped the row. Whatever
renders totals has to fold the same set the reads fold.

---

### Q4 — Who generates it, new tool or extension?

**The tier split, measured today (the brief's "40" is now 43):**

| Tier | Count | Composition |
|---|---|---|
| technician | **14** | the `TOOLS` array, [server.ts:250-600](src/mcp/server.ts#L250-L600) |
| manager | **43** | `MANAGER_TOOLS` = `TOOLS` minus `get_schedule` (13) + `ADMIN_TOOLS` (30), [server.ts:1577](src/mcp/server.ts#L1577); `ADMIN_TOOLS` at [:605-1540](src/mcp/server.ts#L605-L1540) |

Discovery is tier-filtered at `tools/list` ([server.ts:6803-6809](src/mcp/server.ts#L6803-L6809)),
and dispatch **re-gates independently** — the comment there is explicit that discovery is cosmetic.
`ADMIN_TOOL_NAMES` gates every admin tool before the switch statement
([server.ts:1568](src/mcp/server.ts#L1568)), so a manager-only tool cannot forget its guard.

**New tool vs extension — what the code says about each candidate:**

- **Extend `brief_customer`?** No. It returns `{briefing, citations}` synthesized by a **model**
  ([server.ts:410-424](src/mcp/server.ts#L410-L424), dispatch [:2367-2386](src/mcp/server.ts#L2367-L2386)),
  and `validateCitations` filters out hallucinated ids after the fact
  ([grounding.ts:116-140](src/synthesis/grounding.ts#L116-L140)). That is the right shape for a
  cheat-sheet and the wrong shape for a document a customer will dispute. The invoice plan drew the
  same line: *"No AI anywhere in this flow — drafting is pure code."*
- **Extend `get_job`?** It is customer-record-shaped and already folds retracted facts and attaches
  a money summary ([server.ts:2238-2288](src/mcp/server.ts#L2238-L2288)) — but it returns no visits
  and no captures, so it would have to grow both. It is also a technician-tier read.
- **New tool.** Everything about this artifact matches the `ADMIN_TOOLS` staged-verb shape already
  used by `record_field_note`, `send_email`, `retract_capture`, and the drafted `create_invoice`:
  stage → preview → explicit yes → commit, with the staged copy as the record of truth.

**The confirmation doctrine decides the gate, and it is single-sourced.** *"Confirm only what's
irreversible or externally visible; everything reversible, just do"*
([engineering-memory.md §2](docs/engineering-memory.md), ratified 2026-07-17). Generating a
document changes nothing outside the building; **sending** it does. So: generation needs no
confirmation, delivery does.

**The cost of adding any agent-facing tool — three places, one self-reapplying.** This is a
recorded trap ([engineering-memory.md:1863-1870](docs/engineering-memory.md#L1863)): (1) the MCP
tool defs, which the gateway caches per process — fleet restarts required; (2) the living docs
(`docs/nemoclaw-tech-agent.md` + the Box Setup Stuff sync rule); (3) **the heredoc template blocks
in `Box_Setup_Stuff/bootstrap-box.sh`**, which are delete-then-appended into every agent's
`AGENTS.md` on every wire run — miss it and the fleet re-acquires stale instructions forever, with
no code gate noticing.

---

### Q5 — Sent to the customer, or handed to the manager?

**The product rule as the code actually enforces it, which is narrower than the brief states.**
`send_email` is in the **technician** tool array ([server.ts:494](src/mcp/server.ts#L494)) — a
technician with a paired mailbox *can* email a customer today, subject to `requireOutboundCapable`
([outbound.ts:29-35](src/composio/outbound.ts#L29-L35)) and the two-step confirm. What technicians
structurally cannot do is send via Composio directly: `GMAIL_SEND_EMAIL` and
`GMAIL_REPLY_TO_THREAD` are excluded from the technician session config, execution-enforced by
Composio ([sessions.ts:14-24](src/composio/sessions.ts#L14-L24), [:31-42](src/composio/sessions.ts#L31-L42)).
So the enforced rule is *"technician sends go through the spine's audited two-step path"*, not
*"technicians cannot send"*. Restricting a work record to managers would be a **new** tier
decision, not an inherited one — and the `ADMIN_TOOLS` mechanism to express it already exists.

**What a send would inherit automatically** (all already built, all in
[server.ts:2578-2706](src/mcp/server.ts#L2578-L2706)):

```
STAGE ──► review_items 'pending_outbound_send' {to,subject,body}
          re-stage supersedes any open token (:2594-2600)
          the ECHOED item detail is shown, not local args (:2609-2611 — racing stages)
             │
             ▼ human says yes
CONFIRM ─► token lookup with every guard in the WHERE clause (:2623)
       ─► 15-min TTL (:2634)
       ─► CONSUME FIRST, send second — at-most-once (:2638-2646)
       ─► send fails? token stays consumed, item re-annotated
          "confirmed but send FAILED — nothing was sent" (:2657-2670)
       ─► L1 capture, channel 'outbound_email', FULL BODY, no classifier (:2674-2694)
```

That last line is the 2026-07-04 recorded exception in `CLAUDE.md`: outbound captures are
classifier-free, because *"the audit record matters most exactly when the action was personal or
inappropriate."* It carries a **disclosure obligation** — staff must be told sends are logged.

**But the newest recorded decision cuts against extending that exception by analogy.** The nudges
migration, landed 2026-08-17, states it directly: the team-lead's outreach *"is deliberately NOT
L1-captured (user-ratified 2026-08-16 — L1 is undeletable and the 2026-07-04 outbound exception
does not extend by analogy)"*
([20260817090000_nudges.sql:4-9](supabase/migrations/20260817090000_nudges.sql#L4-L9)). So whether
a work-record send lands in L1 is an open user decision, not a settled inheritance.

**The delivery fork, stated plainly:**

| Option | What the code needs | What it costs |
|---|---|---|
| (a) Manager generates, manager sends | new admin tool + attachment support in `SendEmailInput` | smallest; matches the invoice plan's chosen shape; sender is a **personal** mailbox, not the firm's — no firm-mailbox concept exists ([outbound.ts:4-9](src/composio/outbound.ts#L4-L9)) |
| (b) Technician generates, manager sends | tool split across tiers; a hand-off queue | no queue primitive exists for "tech drafted, manager sends"; `review_items` is the nearest and is a staging store, not a hand-off store |
| (c) Technician generates and sends | nothing new — `send_email` already permits it | the disputed-hours document would be sent by the person whose hours are disputed |
| (d) Hosted link the customer opens | first public route, first capability-URL design, expiry policy | the runbook's *"no customer-facing anything"* would need retiring; the invoice research priced this as the larger build |

---

## Recommendation

**Design B — the capture bracket — and do not add `started_at`/`completed_at` writers.**

The reason is not that columns are worse in the abstract; it is that a settable timestamp column
inherits none of the three properties that make this artifact worth anything. It is not
trigger-protected, its clock is whoever wrote it, and it stands alone with no corroborating text.
The bracket has all three for free. The single-sentence version for a customer is the whole
product claim: *"his own words are timestamped by our server the moment he speaks them, into a
record no one at the company can edit or delete — here they are."*

Concretely, I would recommend:

1. **Stamp `stagedAt` into the L1 capture metadata at commit.** Change
   `sourceMeta: { stagedConfirmId: item.id }` ([server.ts:2139](src/mcp/server.ts#L2139)) to carry
   `stagedAt` as well, so the note's *spoken* time is preserved somewhere immutable instead of only
   in the mutable `review_items` row. **No migration** — `metadata` is JSONB.
2. **Derive elapsed time, never store it.** The same posture the money ledger already takes: all
   money state *"is DERIVED in code by folding events — never stored"*
   ([20260815160000:6-8](supabase/migrations/20260815160000_money_events.sql#L6-L8)). Elapsed time
   is the same kind of fact. Storing it creates a second number that can disagree with the
   evidence.
3. **Render `labor_hours` as a claim, adjacent to the bracket, not as the headline.** It is a model
   extraction. Printing "6.5 hours" as fact next to two immutable timestamps that say 6h30m is
   fine; printing it *instead of* them throws away the only thing we have that Jobber does not.
4. **Show retractions using the `list_recent_captures` audit shape verbatim** — `retracted: true` +
   `{reason, by, at}` ([server.ts:2350-2364](src/mcp/server.ts#L2350-L2364)) — and fold every
   derived total against the same retracted set the reads fold, so the document cannot show a
   retraction and simultaneously bill from it.
5. **New manager-tier tool, generation unconfirmed, delivery confirmed.** Generation is reversible
   and invisible outside the building; the send is neither. This is the doctrine applied, not a new
   rule.

**Two things I would flag rather than decide**, because they are user calls:

- **Who may send it (Q5's fork).** My read of the evidence is (a) — manager generates and sends —
  because the disputed-hours case is precisely the one where the technician should not be the
  sender. But the code today permits (c), and the brief's stated rule is stricter than what
  `sessions.ts` enforces. Worth ratifying explicitly rather than assuming.
- **Whether the send lands in L1.** The 2026-07-04 outbound exception says yes; the 2026-08-16
  nudges decision says the exception does not extend by analogy. Both are recorded user decisions
  and they point opposite ways for a *new* outbound artifact.

**One caution on the demand evidence itself.** The Reddit thread is 360 comments of people
improvising with Google Maps, which is strong signal that the pain is unserved. It is not evidence
that they would buy a tool for it — §"What contradicts our current positioning" in that same
research doc notes the corpus never asks for software here, and the top-voted answer (72↑) is
*"quote flat-rate instead of hourly"*, which dissolves the problem rather than tooling it. This
artifact is worth building because it falls out of architecture we already have; I would not price
a roadmap on the thread alone.

---

## Migrations required

**For the recommended design: none.** Every input already exists — `raw_captures.captured_at`,
`visits.source_capture_id`, `visits.labor_hours`, `tenant_profiles` for letterhead, the retraction
rows. The changes are code and JSONB metadata.

**Migrations that would become necessary if scope widens:**

| If you want… | Migration needed | Note |
|---|---|---|
| PDF stored server-side | `storage.buckets` insert, `call-audio` pattern ([20260804120000:91-99](supabase/migrations/20260804120000_phone_call_ingest.sql#L91-L99)) | carries the caveat that the migration role may lack INSERT on `storage.buckets` on some stacks |
| A durable work-record row (number, path, sent id) | new table | ⚠ **read the cascade trap first**: a table referencing only `tenants` escapes every cleanup path and must be named BY NAME in `scripts/spine-eval/world.mjs` RESET_TABLES, `scripts/seed.mjs` truncateSpine, and the test truncate lists ([engineering-memory.md §1](docs/engineering-memory.md)). A table FK'd to `jobs` inherits the existing cascade and avoids this |
| `query_spine` visibility | a `v_*` view + `grant select … to spine_reader` + update the tool description **and its stated view count** ([server.ts:1074](src/mcp/server.ts#L1074) says "eight views") | the count is prose in the description; adding a view without editing it makes the agent's instructions wrong |
| Sequential record numbering | `unique (tenant_id, <seq>)` + mint-with-retry | idiom at [20260804120000:55-58](supabase/migrations/20260804120000_phone_call_ingest.sql#L55-L58) |

---

## Entry Points

- **L2/L1 schema** — [20260620005307_context_spine.sql:75-87](supabase/migrations/20260620005307_context_spine.sql#L75-L87) (visits), [:92-104](supabase/migrations/20260620005307_context_spine.sql#L92-L104) (raw_captures), [:106-114](supabase/migrations/20260620005307_context_spine.sql#L106-L114) (back-link FKs), [:117-119](supabase/migrations/20260620005307_context_spine.sql#L117-L119) (append-only trigger)
- **Retraction** — [20260706090000_retraction_rows.sql](supabase/migrations/20260706090000_retraction_rows.sql) (derived-property design, one-per-target index)
- **The only visit writer** — [recordFieldNote.ts:267-274](src/writePath/recordFieldNote.ts#L267-L274)
- **The only labor-hours source** — [extract.ts:8-24](src/writePath/extract.ts#L8-L24) (`laborHours`, :18), forced-tool schema [:56](src/writePath/extract.ts#L56)
- **Where evidence is already rendered (for the model)** — [grounding.ts:75-94](src/synthesis/grounding.ts#L75-L94)
- **Where the retraction fold happens on read** — [context.ts:148-181](src/db/context.ts#L148-L181)
- **The audit-labeled read** — [server.ts:2345-2364](src/mcp/server.ts#L2345-L2364)
- **The staged send** — [server.ts:2578-2706](src/mcp/server.ts#L2578-L2706) → [outbound.ts:42-84](src/composio/outbound.ts#L42-L84)
- **Tier surfaces** — [server.ts:250](src/mcp/server.ts#L250) (TOOLS), [:605](src/mcp/server.ts#L605) (ADMIN_TOOLS), [:1577](src/mcp/server.ts#L1577) (MANAGER_TOOLS), [:6803-6809](src/mcp/server.ts#L6803-L6809) (tier-filtered list)

## Key Files

| File | Role for this feature |
|---|---|
| [src/db/rawCaptures.ts](src/db/rawCaptures.ts) | L1 accessor. `appendRawCapture` (:33) never names `captured_at`; `findRetractionsFor` (:222) + `foldRetractions` (:235) are the retraction primitives; `listRawCapturesForJob` (:153) / `ForCustomer` (:243) are the evidence listers, both newest-first with **no limit** |
| [src/db/visits.ts](src/db/visits.ts) | `createVisit` (:18) accepts `startedAt`/`completedAt` and nothing production passes them; `listVisitsForJob` (:67), `listVisitsForCustomer` (:79) — the latter reaches visits through the jobs relation because visits carry no `customer_id` |
| [src/db/standingFacts.ts](src/db/standingFacts.ts) | The fact-bundle pattern `{value, sourceCaptureId, recordedAt}` (:9-13); `foldRetractedFacts` (:42) is the pattern the brief names; `factEntriesCiting` (:67) exists **specifically** so preview and fold cannot drift — its comment records that a private copy of the predicate "is how the preview starts lying" |
| [src/db/foldImpact.ts](src/db/foldImpact.ts) | `findFoldImpact` (:57) — server-computed blast radius. Paginates past PostgREST's silent 1000-row cap (:29-48) because an "exhaustive" list that silently truncates lies |
| [src/db/context.ts](src/db/context.ts) | `getCustomerContext` (:79) — the one aggregate. Unions captures stamped with `customer_id` **and** captures reached via L2 `source_capture_id` (:130-139), because a tech note lands in L1 before identity resolves. `includeRetracted` is the audit escape hatch (:81) |
| [src/synthesis/grounding.ts](src/synthesis/grounding.ts) | `serializeContextForPrompt` (:17) — already prints `labor=` and `source_capture=` per visit (:79-81) and tags every capture with its id "cite these ids" (:108). This is the model-facing analogue of the artifact |
| [src/mcp/server.ts](src/mcp/server.ts) | The single boundary. Tool defs :250-1540; dispatch :1900+; `dropSensitive` (:1928) drops `manager_only` L1 rows for non-managers; `AUDIT_CHANNELS` (:1648) marks outbound/agent-action captures manager-retractable only |
| [src/composio/outbound.ts](src/composio/outbound.ts) | The whole send. `SendEmailInput` (:16-20) is three fields; `requireOutboundCapable` (:29) is the one authorization gate; `dangerouslySkipVersionCheck` is **required** (:38-41) |
| [src/db/moneyEvents.ts](src/db/moneyEvents.ts) | `summarizeMoney` (:246) folds the ledger; `technicianMoneyView` (:400) is the ONE definition of the tech/manager money boundary — techs see `balanceDueCents` + `invoicedCents` only |
| [src/db/tenantProfiles.ts](src/db/tenantProfiles.ts) | Firm letterhead accessor + `profileGaps` :200 (gaps warn, never block — [migration :7-8](supabase/migrations/20260815180000_tenant_profiles.sql#L7-L8)) |
| [src/jobs/watchers.ts](src/jobs/watchers.ts) | The deterministic "visit ended, nothing recorded" detector (:24-70). Its time convention (:59-70) is the canonical statement of the naive-local vs real-UTC trap any timeline render must obey |
| [thoughts/shared/research/2026-08-15-invoice-creation.md](thoughts/shared/research/2026-08-15-invoice-creation.md) | Prior art: the same "first customer-facing artifact" problem, fully researched, with the PDF-library comparison and the Composio attachment finding |

## Data Flows

**How evidence gets into the record today (technician note):**

```
technician speaks in Telegram
        │
        ▼
record_field_note  STAGE          ← NOTHING written to L1
  extract (model)                   server.ts:1961
  matchIdentity                     server.ts:1967
  review_items 'pending_field_note' {text, extracted, stagedAt}   ← stagedAt lives HERE
        │                            server.ts:1983-1995            (mutable table)
        ▼  technician says yes  (≤15 min, server.ts:2066)
record_field_note  CONFIRM
        │
        ▼
recordFieldNote()  writePath/recordFieldNote.ts:100
  (1) appendRawCapture  ──────────────► raw_captures
      externalId 'note:<confirmId>'     captured_at = DB now()   ◄── THE EVIDENCE CLOCK
      :141-158                          IMMUTABLE (trigger)
  (2) replay staged extraction (no model call)  server.ts:2143
  (3) resolve customer → job
  (4) createVisit ────────────────────► visits
      laborHours = extracted.laborHours  labor_hours  ◄── A CLAIM, not evidence
      source_capture_id = captureId      started_at   = NULL   (nothing writes it)
      :267-274                           completed_at = NULL   (nothing writes it)
  (5) status transition if note-blessed  :283-288
```

**How a work record would read it back (all primitives exist):**

```
jobId
  ├─► listVisitsForJob(jobId)              visits.ts:67   → labor_hours, source_capture_id, attributes
  ├─► listRawCapturesForJob(jobId)         rawCaptures.ts:153  → captured_at + raw_text, newest first
  │      ⚠ job-stamped captures ONLY. A tech note usually has NULL job_id
  │        (identity resolves AFTER the immutable L1 insert) — reach those via
  │        the visit's source_capture_id, the way getCustomerContext does
  │        (context.ts:133-139). Reading one home under-counts; rawCaptures.ts:163-170
  │        documents the same two-homes rule for its activity probe.
  ├─► findRetractionsFor([ids])            rawCaptures.ts:222
  │      └─► fold (default view) OR label {retracted, reason, by, at} (audit view)
  ├─► listMoneyEventsForJob → summarizeMoney   moneyEvents.ts:246
  └─► getTenantProfile(tenantId)           → letterhead, licenses, disclosure footer
```

**How it would be delivered (the only path that exists):**

```
new tool STAGE ─► preview in Telegram ─► manager yes ─► CONFIRM
                                                          │
                                                          ▼
                                             send_email's proven contract:
                                             consume-first → send → advisory L1 capture
                                             server.ts:2638-2694
                                                          │
                                                          ▼
                                             GMAIL_SEND_EMAIL via Composio
                                             outbound.ts:49-54  ← attachment param NOT wired
```

## External Dependencies

- **Composio** — `GMAIL_SEND_EMAIL` is the only send path ([outbound.ts:49](src/composio/outbound.ts#L49)). Attachment support is documented upstream but **unverified in our SDK**; CLAUDE.md requires re-checking live docs before building on it.
- **Supabase Storage** — one private bucket (`call-audio`), service-role writes, signed URLs, no bucket RLS, `getPublicUrl` never used.
- **`pdf-parse` ^2.4.5** — read-only. Would double as the render-verification tool (parse a generated PDF back to assert its content landed), which is what the invoice plan's Phase 2 does.
- **No PDF writer, no templating engine, no HTML anywhere.** Any renderer is a new production dependency.

## Constraints and Invariants

1. **L1 is append-only, enforced by trigger** — insert only, no update, no delete, and the guard applies to retraction rows too ([20260706090000:1-6](supabase/migrations/20260706090000_retraction_rows.sql#L1-L6)).
2. **A stamped capture makes its parent permanently undeletable** — `on delete set null` on `raw_captures.customer_id` is an UPDATE, which the trigger blocks. Recorded in memory as "L1 pins L2".
3. **`captured_at` is never caller-supplied** — verified by exhaustive grep. This is the property the whole recommendation rests on; anything that starts passing it destroys the evidentiary claim.
4. **Retraction is a derived property**, not a flag — a row is retracted iff a retraction points at it, and there is at most one per target.
5. **Retraction does not revert side effects** — job status changes and money events stand ([server.ts:523](src/mcp/server.ts#L523)).
6. **`visits` is not append-only** and has no `assignment_id` — the L2 evidence row and the scheduled booking are linked only transitively through `jobs`. There is no way to say "this visit is the trip that fulfilled that booking."
7. **Naming collision worth knowing before writing any SQL**: in `query_spine` vocabulary, "visits" means **assignments**. `v_schedule` and `v_cancelled_visits` both select `from assignments` ([20260812110000:60-88](supabase/migrations/20260812110000_v_schedule_excludes_cancelled.sql#L60-L88)). The L2 `visits` table is exposed to **no view at all** — labor hours are unreachable from `query_spine`.
8. **Time convention** — assignment `starts_at`/`ends_at` are the firm's wall clock stored as if UTC (naive-local); `raw_captures.captured_at` and `visits.created_at` are real UTC. Converting the wrong direction is the trap `watchers.ts:59-70` exists to document. A timeline mixing both must convert real-UTC → wall-clock via `localDateISO`/`localTimeHHMM`, never by offset arithmetic.
9. **PostgREST silently caps reads at 1000 rows** — an "exhaustive" evidence list must paginate ([foldImpact.ts:29-48](src/db/foldImpact.ts#L29-L48), [rawCaptures.ts:182-196](src/db/rawCaptures.ts#L182-L196)).
10. **`manager_only` captures are filtered from every capture-bearing read for non-managers** ([server.ts:1928-1929](src/mcp/server.ts#L1928-L1929)) — a customer-facing document must decide what that boundary means for someone with no badge at all.
11. **Telegram is the entire UI**; the one recorded extension is the Mini App board, itself roster-gated.
12. **Test-environment rule** — tests run only against the local stack; the guard is [src/eval/targetGuard.ts](src/eval/targetGuard.ts) (**not** `src/db/targetGuard.ts` as the brief states) plus [src/testEnvGuard.ts](src/testEnvGuard.ts).

## Decision Points

1. **Time bracket: capture pair vs `started_at`/`completed_at` columns vs both.** Columns are already in the schema and already exercised by seed data, so "both" is not free — a populated column and a derived bracket can disagree, and a reader has to pick. Bracket-only needs no migration; column-only needs a writer that does not exist and a source of truth that does not exist either.
2. **Whether to preserve the spoken-vs-confirmed gap.** Stamping `stagedAt` into capture metadata makes the confirm lag visible and auditable. Not stamping it keeps the record simpler and lets the artifact imply the capture time *is* the speaking time — which is true within 15 minutes and false in a way the document would not disclose.
3. **Artifact format.** PDF attachment (rides the existing send; needs a renderer and the Composio attachment param verified) vs hosted link (the industry default for invoices; needs the repo's first public route, capability URLs, expiry) vs Telegram-rendered text (needs nothing new, is not a document a customer can forward to their card issuer).
4. **Retraction rendering.** Label-in-place, using the manager audit shape — credible, and a wider disclosure than technicians currently receive. Or a footnote/appendix. Or omit-with-a-count ("1 entry retracted"), which discloses without printing the retracted content.
5. **Tool surface.** New `ADMIN_TOOLS` verb (matches every staged-verb precedent; costs the three-place vocabulary update) vs extending `get_job` (technician-tier, would need visits + captures added) vs extending `brief_customer` (model-synthesized — wrong shape for a disputed document).
6. **Who may generate, and who may send.** Four combinations, laid out in Q5's table. The code today permits technician-sends; the brief's rule is stricter than what `sessions.ts` enforces; and the sender's identity would be a personal mailbox, since no firm-mailbox concept exists.
7. **Whether the send lands in L1.** The 2026-07-04 outbound exception says capture everything, classifier-free. The 2026-08-16 nudges decision says that exception does not extend by analogy to new outbound surfaces. Both are ratified; they point opposite ways here.
8. **What the document does about photos.** Before/after photos are the second-most-cited community workaround and we have no upload path at all — `blob_path` is a column with one writer (call audio) and `record_field_note`'s `blobPath` is a model-supplied string with nothing to put a file there. Ship without photos, or the artifact pulls in a whole media-ingest capability.
9. **Whether totals are printed.** If the record shows money, it must fold retractions the same way the reads do, and it inherits the money layer's ratified posture — *"the spine is not the books"*, precision over recall, figures attributed to their evidence.

## Open Questions

Things I could not determine by reading alone:

1. **What the confirm lag actually is in practice.** `captured_at − stagedAt` is measurable on the pilot DB and I did not query it (read-only research; the pilot is the deployed firm's live database). If the median is seconds, the gap in Q1 is academic; if it is minutes, the bracket needs the `stagedAt` stamp before it can be called an arrival time.
2. **Whether technicians actually dictate on arrival.** The whole bracket design assumes two notes per visit. Pilot behavior may be one note at the end — in which case there is no bracket, only a single end-of-job timestamp, and the artifact is much weaker. This is a data question about `raw_captures` per visit, and a UX question about whether an arrival prompt is welcome or nagging (the watcher work already treats manager/technician attention as the scarce resource).
3. **Whether the Composio `attachment` parameter works in our SDK version.** The invoice research verified it in Composio's public docs and explicitly flagged a one-shot `tools.get('GMAIL_SEND_EMAIL')` schema dump as the first implementation step. That check has not been run.
4. **Whether a customer would accept a PDF the contractor generated.** The Google Maps screenshot has third-party provenance; a PDF from the contractor's own system does not, however immutable the rows behind it are. Whether "append-only database" reads as credible to a homeowner or a card issuer's chargeback team is a question for a person, not the code — and it is the one that decides whether this artifact solves the thread's actual problem.
5. **Whether `visits.started_at`/`completed_at` are read anywhere I did not find.** I grepped `src`, `supabase`, `scripts` and found only the definition, the seed write, and the synthesis fixture. The Mini App board's client JS (`web/board/board.js`) and the deployed `dist/` were not searched line-by-line.
6. **Retention.** Call audio has a full purge lifecycle (`audio_delete_after`, `legal_hold`, `audio_deleted_at`). A work record is a business record and the invoice plan chose "kept forever" — but nobody has decided that for this artifact, and forever has privacy consequences the physical-data-exchange work already flagged for lawyer review.
