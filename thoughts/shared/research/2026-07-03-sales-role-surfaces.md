---
date: 2026-07-03
branch: main
commit: dc587b7
topic: Sales role — every existing surface a third role (sales: per-technician transaction amounts, Excel reports, sales-email classification) would touch
---

## Summary

This documents the as-is state of everything a "sales" role would touch: the role/tier system
(a two-value database enum: `manager`, `technician`), the email classifier (a single binary
work-vs-not-work judgment shared by both email paths), where money amounts live today (a
`jobs.price_cents` column that exists but is never written; live extractions put charge amounts
into the free-form L3 `attributes` JSON instead), the spreadsheet connectors (Google Sheets is
read-only schedule import; Excel is design prose only, zero code), and reporting/aggregation
(none exists anywhere — the only aggregate in the codebase is `getCustomerContext`, which bundles
one customer's record; there is no per-technician, per-period, or revenue query surface at all).
Notably, the `capture_channel` enum already reserves two unused values (`sales_note`, `quote`)
that were designed for a future sales channel, and the roster/seat/tool-gating machinery is built
so tier is a database fact (not a badge property) — but several pieces hard-code the two-tier
assumption in ways an added tier would silently fall through (detailed under Constraints).

## Entry Points

- `src/inbound/webhook.ts:124` — `handleInboundWebhook()`: where inbound email enters; runs the
  classifier gate at `:219-250` before any L1 write.
- `src/email/ingest.ts:75` — `ingestEmail()`: the pull-path twin; classifier gate at `:87-100`.
- `src/email/classify.ts:39` — `sonnetClassifier`: the one classifier both paths share.
- `src/mcp/server.ts:232` — `dispatch()`: tool routing; tier gate at `:245-247`; tier-filtered
  `tools/list` at `:486-496`.
- `src/mcp/server.ts:227` — `isActiveManager()`: the single tier predicate.
- `src/schedule/sheetSync.ts:85` — `syncScheduleFromSheet()`: the only spreadsheet code in the repo.
- `src/writePath/recordFieldNote.ts:60` — the shared L1→L2 write-path every channel lands through.
- `src/writePath/recordOutboundMessage.ts:37` (untracked working-tree file) — a second, trimmed
  write-path precedent: dedup → L1 append only, no extract/match/visit.

## Key Files

### Role / tier system

| File | Role |
|---|---|
| `supabase/migrations/20260702194603_technicians_and_review_items.sql` | `technician_tier` enum = `('manager','technician')` (`:4`); `technicians` table (`:8-22`, tier default `'technician'`); seat columns `tenants.manager_seats`/`technician_seats` (`:30-32`); seat-cap trigger `enforce_seat_cap()` (`:38-51`) — `case when new.tier = 'manager' then manager_seats else technician_seats end`: every non-manager tier falls into the **else** branch |
| `src/db/technicians.ts` | `TechnicianTier` type from generated enum (`:5`); `getTechnician` (`:18`), `insertTechnician` (`:42`, tier defaults `'technician'`), `isInactiveState` (`:90`) — the single "no longer participates" predicate shared by webhook drop, sheet validation, deactivate guard |
| `src/mcp/server.ts` | `TIERS: TechnicianTier[] = ['manager','technician']` (`:52`) validates the `add_technician_seat` tier arg (`:351-353`); `ADMIN_TOOLS` (5 tools, `:147-206`); `ADMIN_TOOL_NAMES` set (`:220`) gates dispatch by name (`:245`); `isActiveManager` (`:227-230`) — one predicate shared by the dispatch gate and the `tools/list` filter; the list filter is **binary**: `admin ? [...TOOLS, ...ADMIN_TOOLS] : TOOLS` (`:495`) |
| `docs/nemoclaw-tech-agent.md` §4 | Manager profile prose: tier source of truth is the roster row, never the badge; server both filters `tools/list` and re-gates at dispatch |
| `Box Setup Stuff/doorman-architecture-memory.md` | "Tools by tier" — technician badge 7 tools, manager badge 12; doorman does nothing tier-specific (same badge plumbing either way) |

### Email classification

| File | Role |
|---|---|
| `src/email/classify.ts` | `Classification = { isWork: boolean; reason: string }` (`:9-12`); `WorkClassifier` fn type (`:15`); system prompt (`:17-21`) counts "a quote" and "a customer, a job … scheduling" as WORK — a sales-related email about a transaction would classify as work **today** and ingest as an undifferentiated work email; unsure → `isWork=false`; one forced tool `classify_email` (`:23-35`), `claude-sonnet-4-6`, `max_tokens:256` |
| `src/inbound/webhook.ts` | Gate at `:219-250`: runs only when `envelope.requiresWorkClassifier`; feeds the CLEAN `{from, subject, body}` from `sourceMeta` (not the header-prefixed `rawText`) so both routes judge identically; non-work → content-free `dropped_audit` receipt, `skipped_non_work`, never L1 |
| `src/email/ingest.ts` | Same gate shape at `:87-100` for the pull path |
| `src/inbound/normalize.ts` | `InboundEnvelope.requiresWorkClassifier?: boolean` (`:20`) — the per-source opt-in; `channel: CaptureChannel` constrained to the enum (`:11`); registry keyed `${toolkit}:${triggerType}` (`:27-39`) |
| `src/inbound/gmail.ts` | The only registered normalizer; sets `channel: 'email'`, `requiresWorkClassifier: true` (`:27-37`) |

### Money / transaction amounts

| File | Role |
|---|---|
| `supabase/migrations/20260620005307_context_spine.sql:67` | `jobs.price_cents integer` — exists since the first migration |
| `src/db/jobs.ts:26,40` | `CreateJobInput.priceCents?` threaded into insert — **but no production caller passes it**: `recordFieldNote`'s `createJob` call (`recordFieldNote.ts:178-184`) passes only title/jobType/sourceCaptureId |
| `src/writePath/extract.ts` | `ExtractedFields` has NO price/amount field (`:8-24`); the extraction tool schema (`:39-69`) likewise; system prompt says "never invent customers, addresses, or prices" (`:33-34`). Consequence: a stated dollar amount can only land in the free-form `attributes` L3 object — observed live in the Phase-1 verification ("charged 400" → `attributes.chargeAmount: 400`, plan 2026-06-19-technician-write-path.md:69) |
| `src/db/visits.ts` | `labor_hours numeric` is the only quantitative visit column; visit `attributes` JSONB receives `workPerformed`/`followUp` + extractor attributes (`recordFieldNote.ts:218-228`) |
| `src/db/jobs.ts:10-18` | `ALLOWED_TRANSITIONS` — `completed → invoiced → paid` exists as job states; nothing records the invoice/payment *amount* anywhere |

### Capture channels (sales values already reserved)

| File | Role |
|---|---|
| `supabase/migrations/20260620005307_context_spine.sql:16-22` | `capture_channel` enum includes `'sales_note'` and `'quote'` (plus `'manager_assistant'`, `'accounting_event'`) — **no code reads or writes any of these four**; they exist only in the generated types (`database.types.ts:558-563`) |
| `src/mcp/server.ts:50` | MCP `record_field_note` restricts channel to `TECH_CHANNELS` (`technician_voice/note/photo`) — the sales channels are unreachable from the agent tool surface |
| `supabase/migrations/20260630000000_outbound_email_channel.sql` | Precedent for adding a channel value: `alter type capture_channel add value if not exists 'outbound_email'` |

### Spreadsheets

| File | Role |
|---|---|
| `src/schedule/sheetSync.ts` | The ONLY spreadsheet code: Google Sheets **read-only** (`spreadsheets.readonly` scope, `:32`), first worksheet, header-substring column mapping, one-way Sheet→spine upsert; "write-back … deferred to a later phase" (`:78`) |
| `docs/nemoclaw-tech-agent.md` §"Both spreadsheets" | Design prose only: Google Sheets = existing GCP OAuth client; **Microsoft Excel = separate Azure app registration + Microsoft Graph delegated perms (`Files.ReadWrite`, `offline_access`), workbook must live in OneDrive/SharePoint**; "normalize behind a thin spine tool so prompts aren't app-specific". No Graph/Azure SDK in `package.json`; no Excel code exists |
| `docs/nemoclaw-tech-agent.md` §7 | Composio outbound design: per-tenant Tool Router `mcp.url` exposes connected toolkits (example allowlist action `GOOGLESHEETS_BATCH_GET`); outbound "generalizes for free" — but no outbound Composio code exists in `src/` |

### Reporting / aggregation

| File | Role |
|---|---|
| `src/db/context.ts` | `getCustomerContext(customerId)` — the repo's only aggregator: one customer's jobs + visits + captures. No per-technician, per-period, cross-customer, or sum/count query exists anywhere in `src/` |
| `src/synthesis/` | The narrative layer precedent: serialize an in-memory context → forced-tool Sonnet → citations validated deterministically in code against real capture ids (`grounding.ts` `validateCitations`) |
| `src/db/visits.ts` (via `technician_name`) + `raw_captures.technician_ref` | The person-attribution columns a per-technician rollup would join on — free-text refs, matched byte-exact |

### Precedent for a non-technician write-path (working tree, uncommitted)

| File | Role |
|---|---|
| `src/writePath/recordOutboundMessage.ts` | Trimmed write-path: dedup (externalId) → L1 append under `'outbound_email'`, caller-supplied `customerId` provenance, NO extract/identity-match/visit — documented rationale: "running it through the extractor would fabricate an L2 visit" (`:10-14`). Shows the codebase already distinguishes "evidence about a job" (full path) from "a record of our own action" (trimmed path) |

## Data Flows

### Inbound email today (both routes share one binary classifier)

```
Composio webhook                     Gmail pull (ingestEmail)
      │                                     │
      ▼                                     ▼
normalizer → envelope                fetch() → Email[]
(requiresWorkClassifier:true)               │
      │                                     │
      ▼                                     ▼
   classify({from, subject, body})  ← ONE WorkClassifier, binary {isWork, reason}
      │                    │
   isWork=false         isWork=true
      │                    │
      ▼                    ▼
dropped_audit        recordFieldNote(channel:'email')
(content-free,             │
 NO L1 row)                ▼
                L1 raw_captures (technician_ref = person)
                     → Sonnet extract (no price field)
                     → matchIdentity → L2 customer/job/visit
                       (visit.attributes gets any stated amounts;
                        jobs.price_cents stays NULL)
```

A sales-related email (quote, transaction, invoice) passes the current classifier as
`isWork=true` (the prompt names quotes and jobs as work) and lands as a generic work email —
nothing downstream distinguishes it.

### Tier gating today (binary)

```
badge → doorman → signed {tenantId, technicianRef}
                        │
                        ▼
            getTechnician(tenantId, ref)  ── roster row is the tier truth
                        │
        tier='manager' AND state='active'?
              │                    │
             yes                   no
              │                    │
   tools/list: 7+5=12     tools/list: 7
   dispatch: admin OK     dispatch: ADMIN_TOOL_NAMES → throw
```

One predicate (`isActiveManager`, `server.ts:227`) feeds both the list filter and the dispatch
gate. The filter expression is two-way (`admin ? all : TOOLS`, `:495`); there is no third bucket.

### Seat accounting today (two columns, else-branch catch-all)

`enforce_seat_cap()` (`20260702194603:38-51`): `case when new.tier = 'manager' then
manager_seats else technician_seats end`. Any tier value that is not `'manager'` — including a
hypothetical future `'sales'` — is counted against `technician_seats` by the **else** branch,
with no error.

## External Dependencies

- **Anthropic** (`@anthropic-ai/sdk`, `claude-sonnet-4-6`) — classifier + extractor + synthesis.
- **Google Sheets API** (`googleapis`, readonly scope) — schedule import only. No write scope
  requested anywhere.
- **Microsoft Graph / Azure** — NOT present (no SDK, no code); named only in design prose as the
  Excel path (workbook must live in OneDrive/SharePoint; separate Azure app registration).
- **Composio** (`@composio/core`, devDependency, dev scripts only) — inbound Gmail trigger live;
  outbound toolkits (incl. spreadsheets) are recorded design, no code.
- **Supabase Postgres** — all storage; enums (`technician_tier`, `capture_channel`) are DB types,
  so new values are migrations.

## Constraints and Invariants

1. **Tier lives in the DB enum + roster row, not the badge.** Adding a role = enum migration +
   roster rows; badges/doorman need nothing (the doorman is tier-blind, forwards identity only).
2. **Two-tier assumptions are load-bearing in three places:** the seat trigger's else-branch
   (any new tier counts against `technician_seats` silently); `TIERS` array (`server.ts:52`)
   rejects a new tier string at `add_technician_seat`; the `tools/list` filter is binary
   (`:495`). None would *error* on a third enum value — the trigger and list filter would
   silently misbehave instead.
3. **`isWork` is binary and shared.** One `Classification` shape, one `WorkClassifier` type, two
   callers (webhook `:219`, pull `:87`). Any category change to the output shape touches both
   call sites and the drop-receipt logic; per-source opt-in exists only as the boolean
   `requiresWorkClassifier` on the envelope.
4. **classify-before-L1 is non-negotiable** (CLAUDE.md; L1 has no delete path). Any
   sales-vs-work-vs-nonwork decision that affects whether/where a row lands must run before the
   insert. A category decided *after* landing could only annotate L2 or metadata written at
   insert time — L1 rows are immutable, so a category stamped at insert is permanent.
5. **`raw_captures.metadata` JSONB and `channel` are the only L1 category carriers**, both fixed
   at insert. `channel` is enum-constrained; `sales_note`/`quote` values already exist unused.
6. **No production writer sets `price_cents`.** The extractor is explicitly forbidden to invent
   prices and has no amount field; stated amounts land in free-form L3 `attributes` with
   model-chosen keys (observed: `chargeAmount`). Deterministic math over L3 keys has no schema
   contract today.
7. **The overview's hardcode-vs-AI rule names "pricing math" as code, never the model**
   (Three-Layer-Context-Spine-Overview.md §5) — any revenue summation belongs on the hardcoded
   side per the recorded design rule; narrative/insight generation is the AI side (the synthesis
   layer is that precedent, with code-validated citations).
8. **Sheets write-back does not exist.** The only Sheets code is read-only; producing a
   spreadsheet (or writing cells) is new surface regardless of provider.
9. **Per-technician attribution is join-ready:** `visits.technician_name`,
   `raw_captures.technician_ref`, `dropped_audit.technician_ref` all carry the roster ref
   byte-exact — a per-technician rollup has its keys, but `jobs` carry no technician column
   (attribution reaches jobs only through visits).
10. **`review_items.kind` is free text (TS union, no migration for new kinds)** — the
    accept-and-flag pattern (ingest, then flag to manager) is reusable for any new
    low-confidence category without schema change.
11. **The trimmed write-path precedent** (`recordOutboundMessage`, uncommitted): channels whose
    captures are not "evidence about a customer's job" bypass extract/match/visit on purpose.

## Decision Points

Factual forks the current code creates for the sales-role work; each option describes what the
existing code would require.

1. **What "sales" is in the role model.**
   (a) A third `technician_tier` enum value — needs an enum migration, a `TIERS` update
   (`server.ts:52`), a three-way `tools/list` filter (`:495`), a decision on which seat column
   the trigger's case-expression charges it to (today: silently `technician_seats`), and a
   sales-tier gate predicate (today only `isActiveManager` exists).
   (b) Not a tier at all — a technician-tier roster row whose agent gets different tools some
   other way; the current tool filter has no mechanism for that (it keys only on tier).

2. **Classifier shape for the third category.**
   (a) Widen the shared `Classification` (e.g. a category enum replacing/next to `isWork`) —
   touches `classify.ts`, both call sites, the forced-tool schema, and every stubbed test.
   (b) Chain a second classifier after the work gate (sales vs other-work) — leaves the binary
   contract intact; adds a second Sonnet call on the ack-latency-bound webhook path (the async
   open thread already counts two).
   (c) Per-source classifier selection via the envelope (today only a boolean
   `requiresWorkClassifier` exists — would become a classifier key/reference).
   Whichever shape: the verdict must exist **before** the L1 insert (constraint 4) if it changes
   channel/routing; it can be an L2/metadata annotation if sales mail otherwise routes as work.

3. **Where the transaction amount lives.**
   (a) `jobs.price_cents` — column exists, typed layer threads it, zero writers; the extractor
   would need an amount field (its prompt currently forbids inventing prices) or a non-extractor
   writer.
   (b) L3 `attributes` — where amounts land today, with no key contract for deterministic math.
   (c) New structured surface (e.g. a transactions/quotes table) — no precedent besides
   `schedule_entries` (a spine table fed by a connector, keyed by `external_row_key`).

4. **Which capture channel sales input uses.** `'email'` (current route, undifferentiated) vs
   the reserved-but-unused `'sales_note'`/`'quote'` values (channel is set by the normalizer per
   source; the MCP tool surface would also need widening past `TECH_CHANNELS` if sales agents
   record notes via chat).

5. **Excel path.** (a) Direct Microsoft Graph — the recorded design (§"Both spreadsheets"):
   Azure app registration, delegated `Files.ReadWrite`, OneDrive/SharePoint-hosted workbook; all
   new code + a new dependency. (b) Composio toolkit via the per-tenant Tool Router — the
   recorded connector-agnostic design; no outbound Composio code exists yet, and Excel-toolkit
   capability is unverified against Composio docs. Either way, spreadsheet *writing* is new
   surface (the only existing sheet code is read-only).

6. **Where report math vs report narrative runs.** The recorded design rule splits it: sums/
   groupings per technician per period = hardcoded (no such query surface exists yet — would be
   new `src/db/` functions or SQL); narrative/insight = the synthesis-layer pattern (serialize →
   forced tool → code-validated grounding). The fork is whether reports are (a) generated
   server-side as a new read tool the sales agent calls, (b) assembled agent-side from existing/
   new read tools, or (c) produced outside the spine from the Excel files themselves — which
   also raises the source-of-truth fork below.

7. **Source of truth for transaction data.** The stated workflow has sales people recording
   amounts **in their own Excel spreadsheets**. The spine's design (one record, evidence-linked)
   and the schedule-sheet precedent (sheet = manager's ground truth, one-way import into a spine
   table, loose validation + review flags) give two shapes: import the sales sheet into the
   spine as the system of record, or treat the sheet as the record and the spine as untouched.
   The repo records the invariant "our classifier + write-path stay the system of record" for
   inbound data, but has no recorded position on externally-authored business data beyond the
   schedule-sheet import precedent.

## Open Questions

1. **Do sales-related emails currently classify as work?** The prompt's work definition
   explicitly includes "a quote" — so almost certainly yes (they ingest as generic work mail
   today) — but no live spot-check has been run with sales-shaped fixtures.
2. **Composio Excel/Sheets toolkit capabilities** (write actions, trigger types) — unverified
   against Composio docs; only `GOOGLESHEETS_BATCH_GET` is named in design prose. (Per CLAUDE.md,
   verify against live vendor docs before building on this.)
3. **Seat/pricing model for a sales role** — `tenants` has exactly two seat columns; whether
   sales occupies a technician seat, a new column, or no seat is a product decision with no code
   signal.
4. **Sales reporting interval and consumer** — "end of month/quarter/whatever" is external to
   the repo; nothing schedules periodic work in-repo (the 2026-06-29 research confirmed: no
   cron/worker/queue exists).
5. **Whether the sales person is also a mailbox pairing** — per-person Composio pairing assumes
   one connected Gmail per person; whether a sales role gets its own pairing (and thus its own
   classifier traffic) or only consumes reports is undetermined.
6. **`recordOutboundMessage` status** — untracked working-tree files, no plan/research doc
   references them yet; whether that trimmed-path pattern is finalized (it writes channel
   `'outbound_email'`, whose migration file is a reconstruction of an already-applied ledger
   entry) is unconfirmed.
