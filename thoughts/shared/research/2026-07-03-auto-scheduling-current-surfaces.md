---
date: 2026-07-03
branch: main
commit: dc587b7
topic: Auto-scheduling technicians — every surface the codebase has today that a scheduler would build on (schedule storage, roster, jobs/visits time fields, geography, incoming-job flow, manager notification)
---

## Summary

The requested feature — automatically assigning technicians to jobs based on availability,
customer preference days, drive time/traffic, area affinity, gap minimization, load balancing,
and a last-minute-call escape hatch — has **no scheduling engine in the codebase today, and
none of its required inputs exist as data**. What does exist is a thin "schedule" surface built
for a different purpose: a `schedule_entries` table that one-way mirrors the manager's Google
Sheet (the manager schedules by hand in the sheet; the code only *reads* the result), consumed
by exactly one function — deterministic identity matching, which uses "what is technician X
scheduled for today" to attach a field note to the right customer. There is no technician
availability data (working days/hours), no geographic data beyond free-text street addresses
(no coordinates, no service areas, no drive-time source), no job duration estimates, no
recurring-job model, no background worker to run a scheduler on, and no push channel to notify
a manager. The building blocks that DO exist and would be load-bearing: the `technicians`
roster (per-person lifecycle + tier), the `review_items` manager queue (pull-based
notification precedent), `visits.scheduled_at` (a never-populated column), the incoming-job
write-path (email → customer/job/visit created automatically), and the MCP tool surface with
manager-tier gating (the precedent for exposing scheduling actions to agents).

## Entry Points

- `src/schedule/sheetSync.ts:85` — `syncScheduleFromSheet(tenantId, spreadsheetId, deps)`: the
  only way schedule data enters the system. Invoked externally (no cron/worker in the repo).
- `src/db/scheduleEntries.ts:61` — `listScheduleForTechnicianOnDate(tenantId, technicianRef,
  isoDate)`: the only schedule read anywhere.
- `src/writePath/identityMatch.ts:67` — the only *consumer* of that read (schedule-assisted
  note attribution, not scheduling).
- `src/inbound/webhook.ts:124` — `handleInboundWebhook`: where an incoming job arrives today
  (work email → customer/job/visit auto-created).
- `src/mcp/server.ts:56` (`TOOLS`) and `:147` (`ADMIN_TOOLS`) — the agent-facing tool surface.
  **No schedule tool exists**; agents cannot read or write `schedule_entries` at all.
- `src/writePath/recordOutboundMessage.ts:37` — `recordOutboundMessage` (untracked, not yet
  committed): records an outbound email (e.g. a scheduling confirmation) as L1 evidence. The
  only outbound-communication surface; it records only — the send itself is expected to happen
  via Composio, which has no repo code.

## Key Files

| File | Role for scheduling |
|---|---|
| `supabase/migrations/20260620013000_schedule_entries.sql` | The schedule table: `technician_ref`, denormalized customer fields (`customer_name`, `address_line1`, `city`, `state`, `postal_code`, `phone`), nullable `scheduled_start`/`scheduled_end` (timestamptz), nullable `customer_id`/`job_id` links, `external_row_key` (sheet row number), `source` default `'google_sheet'`, L3 `attributes` jsonb |
| `src/db/scheduleEntries.ts` | `upsertScheduleEntry` (idempotent on `(tenant_id, external_row_key)`), `listScheduleForTechnicianOnDate` (UTC calendar day, exact `technician_ref` eq, ordered by `scheduled_start`) |
| `src/schedule/sheetSync.ts` | One-way Sheet → `schedule_entries` mirror. Header-substring column mapping (technician/customer/address/city/state/postal/phone/start/end); row key = 1-based sheet row number; cell values pass through as **raw trimmed strings** (no date/format validation); loose roster validation flags unknown refs via `review_items` with a Levenshtein did-you-mean (`refSuggest.ts`) |
| `supabase/migrations/20260702194603_technicians_and_review_items.sql` | `technicians` roster: `ref`, `display_name`, `tier` (manager/technician), 5-state lifecycle, Composio pairing ids, seat-cap trigger. **No availability, working-days, home-base, or service-area fields.** `review_items`: tenant-scoped queue, one open item per `(tenant, kind, subject_ref)`, `kind` is free text (new kinds need no migration) |
| `src/db/technicians.ts` | `getTechnician`, `listTeam`, `insertTechnician`, `setTechnicianState`, `isInactiveState` (offboarding/offboarded = not schedulable per sheet-sync's validation) |
| `src/db/reviewItems.ts` | `upsertOpenReviewItem`, `listOpenReviewItems`, `resolveReviewItem`, `getOpenReviewItem` — the manager-notification mechanism (pull-only; surfaced when the manager's agent calls `list_pending_reviews`) |
| `supabase/migrations/20260620005307_context_spine.sql` | `jobs` (`:60-72`): title/type/status/price — **no duration, no preferred-day, no time window, no recurrence**. `visits` (`:75-87`): `scheduled_at`/`started_at`/`completed_at` timestamptz + `labor_hours` numeric. `customers` (`:42-57`): free-text `address_line1/2`, `city`, `state`, `postal_code` — **no lat/lng** |
| `src/db/jobs.ts` | `ALLOWED_TRANSITIONS` state machine (`open → in_progress → completed → invoiced → paid`, plus cancelled/declined) — **no 'scheduled' state**; `updateJobStatus` with concurrent-write guard |
| `src/db/visits.ts` | `createVisit` accepts `scheduledAt` — but see Constraints: nothing ever passes it |
| `src/writePath/recordFieldNote.ts` | The write-path that auto-creates customer/job/visit from any inbound capture; `createVisit` call at `:188-195` passes technicianName/laborHours/attributes only — `scheduled_at` stays NULL |
| `src/writePath/identityMatch.ts` | The only schedule consumer: exactly-one-entry-today → propose its address (`:96-102`) |
| `src/writePath/extract.ts` | `ExtractedFields` (`:8-24`): no date/preference/urgency fields — an email saying "please come Tuesday" has no extraction target today |
| `src/inbound/webhook.ts` | Incoming-job channel: verify → roster check → classify → `recordFieldNote`. Synchronous; ack waits on both Sonnet calls (known open thread, 2026-06-29 research) |
| `src/mcp/server.ts` | 7 technician tools + 5 manager tools; manager gating via `isActiveManager` (`:227-230`, roster-tier lookup per call) — the precedent for any scheduling tool surface |
| `src/writePath/recordOutboundMessage.ts` | (Untracked) trimmed L1 write-path for messages the firm *sent* (channel `outbound_email`, idempotent on externalId); no extract/match/visit |

## Data Flows

### Flow 1 — schedule data today (manual, one-way, read-for-attribution)

```
Manager hand-schedules in Google Sheet
        │  (no code invokes this on a timer — sync is run externally)
        ▼
syncScheduleFromSheet (sheetSync.ts:85)
        │  header-substring column mapping; raw strings; rowKey = sheet row #
        ▼
schedule_entries  (upsert on (tenant_id, external_row_key))
        │
        ▼  the ONLY read: listScheduleForTechnicianOnDate (UTC day, exact ref)
matchIdentity (identityMatch.ts:67)
        │  exactly 1 entry today → "Is this the address: <X>?"
        ▼
field-note attribution (NOT scheduling)
```

The direction of authority is sheet → database. Write-back of resolved customer/job ids to the
sheet is explicitly "deferred to a later phase" (`sheetSync.ts:78`). Nothing in the repo ever
*creates* a schedule; the code observes one made by a human.

### Flow 2 — an incoming job today (no scheduling step anywhere)

```
customer email → Composio trigger → POST /inbound/* (httpServer.ts:114)
  → handleInboundWebhook: HMAC → roster check → classify (work?)
  → recordFieldNote: L1 capture → extract → matchIdentity
  → createCustomer? → createJob (status 'open') → createVisit (scheduled_at = NULL)
```

The result of a new work email is an *unscheduled* open job with a visit row recording the
capture — `visits.scheduled_at` is accepted by `createVisit` (`visits.ts:11`) but no caller in
the codebase ever passes it. There is no "needs scheduling" queue, flag, or state; open jobs
are only discoverable per customer (`listJobsForCustomer`), not tenant-wide (no
`listOpenJobsForTenant`-style read exists in `src/db/`).

### Flow 3 — manager notification today (pull, not push)

`review_items` is written by the webhook (unknown ref), sheet sync (ref typo), and the
deactivation flow (confirm token). The manager sees items only when their agent calls
`list_pending_reviews` (`server.ts:448`). There is no push path — no code sends a Telegram
message, SMS, or email *to* the manager proactively. The nearest outbound surface is the
uncommitted `recordOutboundMessage`, which only *records* a send that happened elsewhere.

## External Dependencies

- **googleapis ^173** — Sheets read-only (schedule sync, service-account ADC) + Gmail (legacy
  pull path). Nothing else Google: **no Maps/Directions/Distance-Matrix/geocoding client**.
- **@anthropic-ai/sdk** — extractor/classifier/synthesis (`claude-sonnet-4-6`). No scheduling use.
- **@supabase/supabase-js** — all storage. No PostGIS extension in any migration.
- **@modelcontextprotocol/sdk** — agent boundary.
- **@composio/core** (devDependency) — pairing scripts only; outbound send not implemented.
- **Absent:** any routing/traffic/geocoding provider, any job-queue/cron/scheduler library,
  any constraint-solver/optimization library.

## Constraints and Invariants

1. **`schedule_entries` is a mirror, not a source of truth the code owns.** Sync is one-way
   (sheet wins), idempotent on `(tenant_id, external_row_key)` where the key is the sheet row
   number. Rows written by anything other than the sync would need a different
   `external_row_key` scheme (the `source` column, default `'google_sheet'`, anticipates other
   sources) and would be invisible in the sheet the manager looks at.
2. **Schedule times are unvalidated pass-through strings.** `googleSheetReader` returns
   whatever the start/end cells contain (`sheetSync.ts:56-58`); `upsertScheduleEntry` inserts
   them into timestamptz columns — Postgres coerces or errors depending on the format. No code
   parses, normalizes, or checks them.
3. **The one schedule read is UTC-calendar-day and exact-ref.** `listScheduleForTechnicianOnDate`
   filters `scheduled_start` within `[00:00Z, 23:59Z]` of the date and `technician_ref` by
   case-sensitive equality (`scheduleEntries.ts:66-74`). Per-tenant timezones are explicitly
   deferred (comment `:59-60`). Pacific-time firms' evening jobs land on the "wrong" UTC day.
4. **No availability model.** `technicians` carries lifecycle/tier/pairing columns only. The
   scenario's "6 technicians each with available days" has no storage anywhere. The only
   proxy: an inactive roster state means "not a valid schedule target" (`sheetSync.ts:104`).
5. **No geography beyond free-text address strings.** Customer and schedule addresses are
   unstructured text; matching is trimmed/lowercased string equality (`identityMatch.ts:41-42`,
   `customers.ts:62-73`). No coordinates, no geocoding step at any write, no distance function,
   no area/zone/territory concept (Auburn/Kent/Federal Way exist only as whatever the `city`
   column happens to say).
6. **No duration model.** Jobs carry no estimated duration; `visits.labor_hours` is recorded
   after the fact from a technician note. Gap computation ("finished in 30 min, next job 6pm")
   has no inputs.
7. **No recurrence model.** Nothing represents "recurring job" — no rrule, no interval column,
   no next-due date. Every job is a one-off row.
8. **`visits.scheduled_at` exists but is dead.** Accepted by `createVisit`, populated by no
   caller (grep: only the type/insert plumbing references it). The job status machine has no
   `scheduled` state — scheduling state has no L2 home today.
9. **No tenant-wide job inventory read.** `src/db/jobs.ts` exposes `getJob` and
   `listJobsForCustomer` only. A scheduler's first question — "which jobs need assignment?" —
   has no existing query.
10. **No background execution surface.** No worker, cron, `setInterval`, or queue anywhere in
    `src/` (confirmed again this read; matches the 2026-06-29 research). The HTTP server is
    stateless request/response; the webhook path is synchronous and already latency-stressed
    (ack waits on two Sonnet calls; Composio retries ~5s cadence race the orphan-heal path —
    duplicate-visit evidence in the 2026-07-01 plan's Phase 4 run notes).
11. **Manager notification is pull-only.** `review_items` + `list_pending_reviews`. A
    "no technician possible — call around" alert would land in that queue but reach the
    manager only when they next talk to their agent. No push channel exists in-repo (the
    Telegram bridge belongs to the NemoClaw/OpenShell host stack, outside `src/`).
12. **Agent surface precedents.** Identity is gateway-pinned per request (never model-chosen);
    admin tools are gated by an ACTIVE manager roster row checked at dispatch
    (`server.ts:245-247`); two-step confirmations persist their token in `review_items` so any
    stateless replica can serve the resume (`server.ts:397-414`). Any scheduling tool would
    inherit these patterns.
13. **Extraction has no scheduling vocabulary.** `ExtractedFields` has no date, time-window,
    preferred-day, or urgency field — "customer wants Tuesday afternoon" is currently lost
    unless it lands in freeform L3 `attributes`.
14. **L1 append-only shapes any scheduling audit trail.** A scheduling *decision* recorded as a
    capture would be permanent; mutable scheduling state must live in L2/L3 or a new table
    (same constraint that shaped `review_items`).

## Decision Points

Forks the current code creates for the scheduling feature — stated factually:

1. **Where assignments live.** Three candidates exist in the schema today: (a)
   `schedule_entries` — but it is a sheet mirror whose row key is the sheet row number, so a
   scheduler writing it must either take over as source of truth (breaking the one-way-sync
   contract) or mint a parallel `source`/key scheme; (b) `visits.scheduled_at` — a dead column
   on the L2 visit row, one visit per capture today, created by the write-path rather than by
   assignment; (c) a new table. The sheet's role — stays ground truth vs becomes a view —
   decides this.
2. **Where availability lives.** `technicians` is the natural per-person row and has no
   availability fields; options are new columns/JSONB there, a new table (recurring weekly
   pattern vs explicit calendar), or continuing to treat the manager's sheet as the only
   calendar. Nothing exists yet either way.
3. **Geography source.** Everything is free-text addresses. Drive-time/traffic awareness
   requires either geocoding + a routing provider (new external dependency, per-tenant API
   cost) or a coarser proxy (city/area adjacency table — also absent). "Ferry between
   addresses" is undetectable with current data.
4. **Duration source.** Gap-minimization needs per-job duration estimates; candidates are a
   new `jobs` column, per-job-type defaults, or inference from historical `labor_hours`
   (sparse today).
5. **Trigger seam for incoming jobs.** The webhook path is synchronous and latency-stressed
   already; a scheduling step could run inline (worsens the ack problem), after-ack (needs the
   detach work already researched 2026-06-29), or in a separate worker/cron (no infra exists).
   Related: there is no "unscheduled jobs" query to drive any of these.
6. **Last-minute-call escalation channel.** `review_items` (pull) is the only built
   notification path; a proactive "call the technicians yourself" alert needs a push channel —
   outbound email via Composio (send not implemented; `recordOutboundMessage` records only) or
   the Telegram bridge (host-stack, outside this repo).
7. **Recurring jobs.** No model exists; recurring work would need a generator (a recurrence
   definition producing future jobs) or an external source (e.g. the sheet) feeding them in.
8. **Agent exposure.** No schedule tool exists for either tier. Whether scheduling is
   manager-only (mirroring `ADMIN_TOOLS`), technician-visible read-only, or fully automatic
   with review-queue overrides is open; the tier-gating and confirm-token patterns are ready.
9. **Solver ownership.** The repo's hardcode-vs-AI rule (overview §5) puts "permission
   boundaries, pricing math" in code and interpretation in models; where
   assignment-optimization (soft constraints: area affinity, diversity, gap pain) falls on
   that line is a design choice the current code doesn't answer.

## Open Questions

1. **What do live `scheduled_start` cells actually contain?** The reader passes raw strings;
   whether the real firm sheet uses ISO timestamps, `7/3 2pm`, or bare dates determines
   whether existing rows are even queryable by time. Needs a look at the real sheet.
2. **Does the sheet stay the manager's editing surface?** Write-back is deferred; if a
   scheduler assigns jobs, the manager can't see assignments in the sheet without building it.
   Product question, not answerable from code.
3. **Timezone.** The UTC-day simplification is documented as deliberate; the firm operates in
   Pacific time (Auburn/Kent/Federal Way). Where tenant timezone would live is unresolved.
4. **How technician service areas are represented in the real firm's operation today** (a
   sheet column? tribal knowledge?) — the repo has no trace of them.
5. **Job duration reality** — are duration estimates per job type stable enough to hardcode,
   or does the firm quote per job? No data in-repo.
6. **Routing provider constraints** — cost/quota of Google Routes/Distance Matrix (or
   alternatives) per tenant; unverifiable from the repo and needs live-docs research per
   CLAUDE.md's external-services rule.
7. **Whether `recordOutboundMessage` (untracked) is the intended confirmation-record path for
   scheduling notifications** — it exists on disk with tests but is uncommitted and no design
   doc in `thoughts/` references it yet; its header comment says "e.g. a scheduling
   confirmation", implying adjacent intent. (A second untracked file,
   `thoughts/shared/research/2026-07-03-sales-role-surfaces.md`, is unrelated to scheduling.)
8. **Composio outbound send** — the send action itself (GMAIL_SEND_EMAIL etc.) has no repo
   code; the send-not-idempotent finding (memory, 2026-07-01) constrains any
   confirmation-email design but the actual send mechanism is unbuilt.

---

## Addendum (2026-07-03): user decisions from the post-research Q&A

Settled with the user in conversation, one by one — these resolve the Decision Points above
and are input to `/plan`:

1. **Schedule ownership: DB is single source of truth; one-way push to the Google Sheet**
   as a read-only view for the manager. Manager edits via agent chat. Two-way sheet sync
   deliberately skipped (conflict complexity); addable later. Every schedule change records
   its cause as L1 evidence (who/when/why — reschedules and cancellations must be auditable;
   user requirement).
2. **Availability: fixed weekly pattern per technician + exception calendar** (vacation,
   sick, emergency day-offs as date-ranged overrides).
3. **Service areas: city list per technician, soft scoring bonus only** — never a hard
   filter. Per-tenant (every firm's geography differs). Proximity between actual jobs comes
   from drive-time data, not area adjacency maps.
4. **Drive time: lazy grid ("answer sheet") cache + real routing API.** Geocode each address
   once, cached against the address text (mutable — re-geocode on address change; user
   requirement). Addresses snap to ~2–5 km grid cells named hierarchically (quadkey-style,
   so splitting a cell renumbers nothing). Drive times stored per (cell-pair, time-of-day
   bucket ×4), each learned from one real traffic/ferry-aware routing call; cells auto-split
   where cached vs live results disagree (handles shoreline/bridge cells without water
   polygons). Never snap an address to a "nearest" cell — its own coordinates decide.
   Candidate generation: cheapest-insertion (detour cost per within-day gap); **no
   technician is ever pruned before a real drive-time evaluation** (user requirement: far
   tech can be time-optimal); at larger team sizes the guarantee relaxes to area + adjacent +
   least-busy shortlist. Winner verified with one fresh traffic-aware call at the exact
   departure time. The grid-cache idea is the user's. Pricing verified 2026-07-03 (Google
   pricing list, updated 2026-06): traffic-aware route matrix $10/1k elements (5k/mo free),
   geocoding $5/1k (10k/mo free) — ~$0 at one-tenant scale, ≤ ~$47/mo/tenant ceiling
   uncached. Cache size trivial (~5k rows/firm warm; self-trimming ~90-day expiry).
5. **Scheduler trigger: never inline in the webhook ack path** (already latency-stressed;
   see 2026-06-29 async research — sequencing with the detach-after-ack fix belongs in the
   plan). Job ingested first via the existing pipeline, scheduling runs as its own step
   immediately after; proposal ready seconds after ingest.
6. **Autonomy: tiered.** Known customer (matched by sender email OR phone OR address in
   body, with history) → auto-book. Unmatched/first-timer → manager one-tap approval via
   Telegram, with a did-you-mean merge suggestion; on approval the system learns the new
   email into the customer's `attributes.altEmails` (AI suggests, human confirms, code
   writes — no silent merges). Bad signals (geocode-fails address, sender flooding,
   borderline classifier, denylist) → quarantined in the existing `review_items` queue:
   nothing external happens. Threshold is a per-tenant dial.
7. **Booking lifecycle is first-class scope:** cancel and reschedule arrive through the same
   inbound pipeline (recognize "refers to existing booking" = update, not new job);
   assignment history + L1 receipts; same-day changes ping the tech on Telegram. Lifecycle
   event family noted for the plan: not-home, tech-sick bulk reproposal, overrun alerts,
   proposal superseded by customer reply, atomic slot assignment under race.
8. **Durations: per-job-type defaults, manager-editable** (set once, override per job at
   approval; later auto-tune from recorded visit times).
9. **Last-minute no-fit: instant informed Telegram alert; NO auto-shuffle.** Confirmed
   bookings are stable by rule (tech churn + broken customer promises outweigh optimization;
   user decision). Alert carries each tech's day, gaps, distance, earliest clean slot +
   one-tap options; any bump is the manager's explicit choice, system then executes and
   re-confirms.
10. **Recurring jobs: system-generated from contract rules** stored on the customer
    ("tune-up every 6 months"); auto-created N ahead of due date and flowed through the
    normal pipeline. Lead time N = per-firm setting, default ~3 weeks, manager-changeable
    via chat (per-contract override later).
11. **Load balancing (from the original feature ask, unchanged):** spread jobs evenly across
    technicians as a soft objective unless the firm specifies otherwise; never starve/dump
    on one tech.
12. **Customer preference days:** extraction gains scheduling vocabulary (preferred
    day/time-window); stored on the customer's L3 `attributes`; missing preference → propose
    earliest sensible slots with alternatives, optionally draft a reply asking.
