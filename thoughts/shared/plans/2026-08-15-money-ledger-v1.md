---
date: 2026-08-15
task: Money ledger v1 (part A) — workflow-agnostic money event ledger, derived job money-state, manager tool + tier-filtered reads
research: thoughts/shared/research/2026-08-15-pricing-invoicing-payment-loop.md
status: complete
companion: thoughts/shared/plans/2026-08-15-money-inference-v1.md (part B — implement AFTER this plan lands; overlapping footprint, stacked by doctrine)
---

## Overview

Close the job lifecycle loop by adding a **money event ledger**: an append-only table of money
facts (fee, estimate, approval, change order, invoice, payment, credit, write-off) attached to
jobs, with all money state (quoted / invoiced / paid / balance due) **derived by folding events in
code**, and `job_status` kept in sync from the ledger — never by relying on people to report.
v1 scope (user decision): ledger + reads; managers write, technicians see balance. Part B adds
email inference and the "is this job done?" nudge. No invoice documents, no reminders, no
external integrations.

## Decisions

- **Representation: one append-only event ledger, state derived by folds** — chosen over widening
  `jobs.price_cents` (one number can't represent divergent chains) or per-concept tables
  (quotes/invoices/payments lock in one workflow). User-ratified workflow-agnostic principle;
  house pattern (`schedule_events`, retraction fold). Acceptance test = the five firm archetypes
  from the research representable with zero schema change.
- **Status tail auto-derives (user choice, 2026-08-15)** — ledger events move `job_status`
  through legal transitions only (multi-hop walk); illegal/ambiguous ⇒ record the event, leave
  status alone. Enum unchanged.
- **Completion is inferred, not reported (user direction)** — invoice evidence is the strongest
  done-signal; the agent asks only when inference fails (part B). Manager verbs remain fallback.
  Tuning ask-behavior via scenario evals/RL: **deferred**.
- **Progress invoices never drive status** — ALL money-derived targets (`completed`, `invoiced`,
  `paid`) require ≥1 non-voided, **non-progress** `invoice_issued` (review finding: the earlier
  spec let a paid milestone walk a mid-project commercial job to `paid`). Deposits never advance.
- **Entry is one-shot, and status sync is bidirectional** — a ledger row is reversible via
  correction/void events (accounting convention), so per the confirmation doctrine it commits
  immediately and the reply states what happened. Auto-advance must be undoable too (review
  finding: a mis-derived advance would otherwise permanently hide a job from the scheduler and
  mint-guard, which read `open|in_progress`): voids walk `invoiced→completed` back down, and a
  new `completed→in_progress` edge lets a fresh field note legally reopen a wrongly-completed
  job via the existing `statusSignal` path — no new tool. `paid` keeps no outgoing edges, so the
  derived `TERMINAL_STATUSES` set is unchanged.
- **Voids/corrections must reference their target** — `correctsEventId` REQUIRED for
  `invoice_voided`/`correction` (review finding: an unreferenced void is a silent no-op the fold
  ignores while the balance stays wrong). `payment_refunded` negates by amount (partial refunds).
- **Tiers (user choice)** — managers write and see the full ledger; technicians see summary
  numbers (balance due, invoiced total), no event list / methods / refs.
- **`jobs.price_cents` stays dormant** — not written, not dropped. Quoted price derives from
  `estimate_approved` (+ `change_order`) events.
- **`money_events.job_id` is `on delete restrict`** — a financial record blocks deleting its job,
  consistent with L1-stamped rows already being undeletable.
- **Board UI money display: deferred** — Telegram chat first (product principle).
- **Implementation deviations (2026-08-15, flagged for user sign-off in the phase report):**
  (a) reads attach `money` ONLY when the ledger has entries — a zero-summary on an untracked
  job would read as "fully paid"; (b) `get_customer_context` gives managers per-job summaries
  only (`moneyByJob`) — the entry list lives on `get_job` (context bloat; correction ids are a
  get_job lookup). Both are conservative narrowings, reversible without migration.

## Plain-language walkthrough

**Phase 1 — the ledger.** A new database table, `money_events`, where each row is one money fact
about a job ("invoice for $450 went out", "check for $200 received"). Rows are append-only:
mistakes are cancelled by a new correcting row, the way accountants do it, so history is never
lost. Code (not the AI model) folds the rows into a summary — quoted, invoiced, paid, balance due
— and moves the job's status label only when the facts justify it, in either direction:

```
money facts (append-only)          derived, in code
  estimate_approved $1,200   ──►   quoted   $1,200
  payment_received  $400     ──►   paid     $400          job status walks legal edges only:
  invoice_issued    $1,200   ──►   invoiced $1,200        open → in_progress → completed → invoiced
  payment_received  $800     ──►   balance  $0        ──► … → paid
  (invoice_voided → walks back invoiced → completed; a new tech note can reopen completed work)
```

You'd notice it working: tests showing five very different firms' payment styles (flat-rate
repair, deposit-then-final install, progress-billed commercial, bill-after-hours work, "the
books live in QuickBooks") all representable with zero schema changes.

**Phase 2 — recording and seeing money.** A new chat tool lets a manager say "record a $450
invoice on the Henderson job"; it commits immediately and replies with what it did, the new
balance, and any status move. Every job read (`get_job`, customer context, the manager's SQL
views) now carries the money summary; technicians see just the balance due on their jobs.

## Secrets & env preflight

- **Phase 1:** none new. Local Supabase stack running (`npx supabase start`, `.env.test`).
- **Phase 2:** none new.

## Phase 1: Money ledger schema + typed layer + derivation

### What this phase does
Creates the `money_events` table (append-only), the typed accessor module, the pure fold, and the
bidirectional legal-walk status sync. No tool surface yet.

### Changes required

**`supabase/migrations/<timestamp>_money_events.sql`** (new — pick the timestamp at
implementation time, sorting after the latest landed migration: `20260815120000` is already
taken by `fireworks_rates.sql`, which landed 2026-08-15)
- `create type money_event_kind as enum ('fee_charged','estimate_presented','estimate_approved',
  'estimate_declined','change_order','invoice_issued','invoice_voided','payment_received',
  'payment_refunded','credit_applied','write_off','correction');`
- `create table money_events`: `id bigint generated always as identity primary key`,
  `tenant_id uuid not null references tenants(id)`,
  `job_id uuid not null references jobs(id) on delete restrict`, `kind money_event_kind not null`,
  `amount_cents integer`, `currency text not null default 'USD'`,
  `occurred_at timestamptz not null default now()`, `actor_ref text`,
  `source_capture_id uuid references raw_captures(id)`,
  `corrects_event_id bigint references money_events(id)`, `method text`, `external_ref text`,
  `dedupe_key text`, `detail jsonb not null default '{}'::jsonb`,
  `created_at timestamptz not null default now()`.
- Append-only trigger reusing `raise_append_only()` (pattern:
  [20260714120000_schedule_core_promise_ladder.sql:46-48](supabase/migrations/20260714120000_schedule_core_promise_ladder.sql#L46-L48)).
- `check (amount_cents is null or amount_cents >= 0)` — direction comes from `kind`, never sign.
- Partial unique `uq_money_events_dedupe (tenant_id, dedupe_key) where dedupe_key is not null`
  (`cost_events` precedent). Indexes on `(tenant_id)`, `(job_id)`.
- View `v_money_events` filtered on `current_setting('spine.tenant_id')::uuid` + SELECT grant to
  `spine_reader` (pattern: [20260812110000_v_schedule_excludes_cancelled.sql:60-89](supabase/migrations/20260812110000_v_schedule_excludes_cancelled.sql#L60-L89)).
  The grant IS the query_spine allowlist — no TS-side vocabulary exists (review finding).

**`src/db/moneyEvents.ts`** (new)
- Types `MoneyEvent`, `MoneyEventKind`, `MoneySummary { quotedCents, invoicedCents, paidCents,
  balanceDueCents, writtenOffCents, lastEventAt, hasProgressInvoice }`.
- `appendMoneyEvent(input)` — validates: kind in vocabulary; `amountCents` a non-negative integer
  when the kind requires one (all kinds except `estimate_declined`); job exists and
  `job.tenant_id === input.tenantId` (via `getJob`); `correctsEventId` REQUIRED for
  `invoice_voided`/`correction`, must reference a same-job event, and voids must target an
  `invoice_issued`. Insert only; surface SQLSTATE like
  [rawCaptures.ts:66-69](src/db/rawCaptures.ts#L66-L69) so callers detect dedupe collisions.
- `listMoneyEventsForJob(tenantId, jobId)`; `listMoneyEventsForJobs(tenantId, jobIds[])`
  (batch, empty-input short-circuit like [jobs.ts:158](src/db/jobs.ts#L158)).
- `summarizeMoney(events): MoneySummary` — **pure**. `quoted` = last `estimate_approved` + later
  `change_order`s; `invoiced` = Σ `invoice_issued` − voided (via `corrects_event_id`); `paid` =
  Σ `payment_received` − Σ `payment_refunded`; `balanceDue = invoiced − paid − Σ credit_applied
  − Σ write_off` (negative = customer credit, exposed as-is); `correction` negates its target.
- `deriveStatusTarget(current: JobStatus, summary, events): JobStatus | null` — **pure**. Gate
  first: ≥1 non-voided, non-progress `invoice_issued`, else null (all-progress and deposit-only
  chains derive nothing). Past the gate: target `invoiced`; `paid` when `balanceDue <= 0`.
  Downward: gate stopped holding (all voided) and current `invoiced` ⇒ target `completed`;
  current `paid` stays `paid`. Null for `cancelled`/`declined`/already-at-target.
- `syncJobStatusForMoney(tenantId, jobId): Promise<{from, to} | null>` — computes target, walks
  `ALLOWED_TRANSITIONS` hop-by-hop (up, or the one down-edge) via `updateJobStatus`
  ([jobs.ts:168-196](src/db/jobs.ts#L168-L196)); stops silently at the first illegal hop
  (concurrent transition ⇒ retry once, then give up without error).

**`src/db/jobs.ts`** — two new edges in `ALLOWED_TRANSITIONS`
([jobs.ts:19-27](src/db/jobs.ts#L19-L27)): `completed: ['invoiced', 'in_progress']` (reopen — a
new field note's `in_progress` `statusSignal` at
[recordFieldNote.ts:262-264](src/writePath/recordFieldNote.ts#L262-L264) now legally revives a
wrongly-completed job) and `invoiced: ['paid', 'completed']` (void walk-down). Update the
machine's comment. `paid`/`cancelled`/`declined` stay empty ⇒ `TERMINAL_STATUSES`
([recordFieldNote.ts:75-79](src/writePath/recordFieldNote.ts#L75-L79)) provably unchanged.

**`src/db/index.ts`** — add `export * from './moneyEvents.js';` after line 20.

**`src/db/database.types.ts`** — regenerate: `npx supabase db reset` then
`npm run gen:types:local`.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass (1 pre-existing
  unrelated failure: `src/eval/doctrine.test.ts`, introduced by commit 8f3a6dd — flagged)
- [x] New `src/db/moneyEvents.test.ts`: **representability matrix** — the five research
  archetypes each expressed as an event list; assert summary and status-walk outcomes per chain;
  assert an all-progress chain (even fully paid) derives NO status target at any point; assert
  voiding the only real invoice walks `invoiced → completed`; assert `TERMINAL_STATUSES` still
  equals `{paid, cancelled, declined}`
- [x] Fold edge tests: void, refund, correction, write-off, negative balance; unreferenced
  void/correction rejected by `appendMoneyEvent` (+ review round 1: pre-ledger invoiced job
  derives nothing; note-signal subset `NOTE_SIGNAL_TRANSITIONS` in recordFieldNote)
- [x] DB tests (local stack): append-only trigger rejects UPDATE/DELETE; dedupe collision
  surfaces as unique violation; `on delete restrict` blocks job delete

### Live verification (agent-executable)
- Prerequisites: local Supabase stack running.
- [x] Cross-channel read-back: append events via the typed layer, read via
  `docker exec supabase_db_TradesDatabase psql` — row values match; report actual rows.
  (2026-08-15: 9/9 checks passed — walk open→invoiced→paid read back via psql; trigger, FK
  restrict, tenant-GUC view filter all held. Note: shared `raise_append_only()` message
  hardcodes "raw_captures" — pre-existing diagnostic nit, flagged.)

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 2: `record_money_event` tool + money in every read

### What this phase does
Managers record money events from chat (one-shot); every job read carries the derived summary,
tier-filtered.

### Changes required

**`src/mcp/server.ts`**
- Add `record_money_event` to `ADMIN_TOOLS` (after `update_job`, def near
  [server.ts:1212](src/mcp/server.ts#L1212)): args `jobId`, `kind`, `amountCents?`, `occurredAt?`,
  `method?`, `externalRef?`, `note?` (→ `detail.note`), `progress?`, `correctsEventId?`.
  Description: one-shot; correct mistakes with a correction/void event (which also walks status
  back); amounts in cents.
- Handler (admin dispatch region): tenant-guard job → `appendMoneyEvent` (`actor_ref` = caller
  ref, `dedupe_key` null) → `syncJobStatusForMoney` → reply with the recorded event, new
  summary, and any status move in either direction ("say what you did").
- `get_job` handler ([server.ts:2034-2050](src/mcp/server.ts#L2034-L2050)) and
  `get_customer_context` handler ([server.ts:2003-2032](src/mcp/server.ts#L2003-L2032)): attach
  `money` — managers: summary + last 10 events; technicians: `{balanceDueCents, invoicedCents}`
  only (tier known at dispatch, [server.ts:1697](src/mcp/server.ts#L1697)). Fetch via
  `listMoneyEventsForJobs` — do NOT widen `getCustomerContext` itself (synthesis prompts must not
  inherit money silently; briefings pick it up in a later cycle if wanted).
- `query_spine` tool description ([server.ts:1040](src/mcp/server.ts#L1040)): document
  `v_money_events` beside the existing views and fix the "six views" count (near
  [server.ts:1050](src/mcp/server.ts#L1050); view docs near
  [server.ts:1062](src/mcp/server.ts#L1062)). No `src/db/querySpine.ts` change (review finding:
  it holds no view vocabulary).

### Automated verification
- [x] Gates pass; new `server.test.ts` cases: manager records event → reply carries summary +
  status move; technician calling `record_money_event` refused (admin gate); technician
  `get_job` shows balance only (no events/method/external_ref); manager sees events
- [x] Illegal-kind / negative-amount / cross-tenant jobId / unreferenced-void rejected with
  instructive errors (+ review round 1: full coerced-to-absent arg guards incl. boolean
  `progress`; eval G01 + corpus counts updated; W13 eval case added)

### Live verification (agent-executable)
- Prerequisites: local stack; MCP server via stdio (maker≠checker subagent drives the tool).
- [x] Subagent calls `record_money_event` then reads `money_events` + `jobs.status` via psql —
  evidence: the row, the derived status, the tool's reply text. (2026-08-15: 12/12 through the
  real server with manager + technician identities; tier filter key-set-verified; psql agreed.)

### Manual verification
- [ ] none

---
*No manual items. Part B (email inference + probably-done nudge) is a separate plan implemented
after this one lands: [2026-08-15-money-inference-v1.md](2026-08-15-money-inference-v1.md).*
