---
date: 2026-07-30
branch: main
commit: 27a9692
topic: Plan 4c — shared system sender + customer nudges — everything a customer-facing notification pipeline would build on today
---

## Summary

Plan 4c is the last chunk of the Plan-4 series: telling **customers** about their visits —
"your technician window is Tuesday 9–11" announcements after a freeze, and nudges (e.g. a
day-before reminder). Today **no customer-facing sender exists anywhere in the system**. The
only outbound path is email sent *as a specific person* from their own paired Gmail (either
the spine's human-confirmed two-step `send_email` tool, or a manager acting Composio-direct
through their session), and the only notification pipeline (`boardNotify`) pushes to **staff**
Telegram accounts, never to customers. What *does* exist is every foundation a sender would
stand on: an append-only `schedule_events` feed with a proven consumer pattern (cursor, digest,
freeze-run stamps), a promise ladder that records what a customer was told, hard L1
audit-capture rules for outbound messages, a per-tenant settings row, and two scheduled-work
precedents (a Render cron heartbeat and a Render background worker loop). This document maps
those foundations and the forks 4c must decide.

## Entry Points

- `src/mcp/server.ts:425` — `send_email` tool definition (two-step contract in the description).
- `src/mcp/server.ts:2127` — `send_email` handler: stage → confirm → send → L1 capture.
- `src/composio/outbound.ts:42` — `sendGmailEmail`: the one server-side send primitive.
- `src/composio/logIngest.ts:130` — `runLogIngestion`: manager Composio-direct actions → L1.
- `src/telegram/boardNotify.ts:191` — `pollOnce`: the schedule_events consumer precedent.
- `src/telegram/boardWorker.ts:13` — the Render Background Worker loop (30s poll).
- `src/jobs/lifecycle.ts:1` — the Render Cron Job heartbeat (`*/15`, isolated idempotent steps).
- `src/db/scheduleEvents.ts:54` — `listScheduleEventsSince`: the "what changed" feed.

## Key Files

- **`src/composio/outbound.ts`** — `SendEmailInput {to,subject,body}`, `SendEmailResult
  {messageId,threadId}`, `requireOutboundCapable(tech)` (active + paired gate, `:29`),
  `sendGmailEmail(tech, input)` (`:42`): executes Composio `GMAIL_SEND_EMAIL` pinned to the
  person's `composio_connected_account_id` + `compositeUserId`, records a cost-ledger row
  (billed even on failure), tolerant envelope parse. Header comment: "Manager-tier outbound
  goes Composio-direct via sessions (sessions.ts), not through here."
- **`src/mcp/server.ts:2127-2255`** — the two-step: STAGE upserts ONE open
  `pending_outbound_send` review item per person (re-stage supersedes, `:2143-2155`), echoes
  the ITEM's detail (racing-stage rule); CONFIRM looks the token up with every guard in the
  WHERE clause, enforces a **15-minute expiry** (`:2183`), **consumes first, sends second**
  (at-most-once, `:2187-2197`), annotates the consumed item if the send then fails, and
  appends an **advisory L1 capture** (`:2223-2247`) — `channel: 'outbound_email'`, verbatim
  subject/body via `formatEmailRawText`, `externalId: sent:<messageId>` (fallback
  `sent:confirm:<confirmId>`).
- **`src/composio/logIngest.ts`** — the audit sweep for manager Composio-direct actions
  (60-min overlapping window, external-id dedup, no cursor table). Sends
  (`EMAIL_SEND_SLUGS = GMAIL_SEND_EMAIL, GMAIL_REPLY_TO_THREAD`) stored **verbatim** as
  `outbound_email`; everything else stored **keys-only** as `agent_action`
  (`:255-266` — "never argument or response VALUES … L1 is undeletable"); reads skipped;
  capture-all with NO work/personal classifier (recorded user decision 2026-07-04, `:13`).
- **`src/composio/sessions.ts`** — the tier boundary. `GMAIL_SEND_EMAIL` is **never** in
  `TECHNICIAN_GMAIL_TOOLS` (`:15-25`): technician send goes only through the spine two-step;
  managers get the full catalog. Session restrictions are execution-enforced by Composio
  (error code 4310).
- **`src/telegram/boardNotify.ts`** — the sibling-consumer blueprint: per-tenant **in-memory
  cursor** (first sight seeds at current version — pre-boot/backlog events never notify;
  documented v1 restart limitation), resolution-failure holds the cursor / send-failure
  advances past (poison-message rule), per-tick **digest** (>3 messages per recipient per tick
  → one message, `DIGEST_THRESHOLD`/`DIGEST_MAX_LINES` at `:41/:45`), freeze-stamped bursts
  detected via `detail.freezeRun`, `freeze_committed` summary goes to **managers only**
  (`:157-172`). Fixed canned copy per event kind; naive-local times printed verbatim.
- **`src/telegram/boardWorker.ts`** — separate long-lived Render Background Worker
  (`npm run board:worker`), 30s poll (`BOARD_POLL_MS` guarded against garbage), never-fatal
  loop. Kept out of the web tier so >1 web replica can't double-send.
- **`src/jobs/lifecycle.ts`** — the ONE scheduled entrypoint (Render Cron Job `*/15`; "Render
  guarantees at most one concurrent run"). Every step is a sweep over durable state — missed
  or doubled ticks are safe; steps are isolated (one failure reported, others still run);
  key-gated steps skip cleanly.
- **`src/db/scheduleEvents.ts`** — append-only feed; `latestScheduleVersion` (`:40`) = tenant
  version; `listScheduleEventsSince(tenantId, afterId, limit=100)` (`:54`) oldest-first.
- **`src/schedule/freezeCommit.ts`** — every freeze-committed row's event carries
  `detail.freezeRun` (`:51`) plus a final `freeze_committed` event with
  `horizonFrom/horizonTo/placed/skipped` (`:121-136`) — a batch identity an announcement run
  could key on.
- **`src/schedule/booking.ts`** — the promise ladder: `promise_level` enum
  `none|day|time|time_only` + `promised_day` on assignments (`database.types.ts:1191`);
  `bookVisit` defaults to `'none'` ("record only promises actually made", `:187`);
  `bookingRequiresConfirmation(promiseLevel) = promiseLevel !== 'none'` (`:210` — the
  single-sourced confirmation doctrine: confirm only what is irreversible or **externally
  visible**); `setVisitPromise` (~`:1075`, the `set_promise` one-shot editor, promisedDay
  server-derived); move previews compute `promiseBroken`; the freeze commit belt skips
  promise-breaking placements (`freezeCommit.ts:92-101`).
- **`src/db/customers.ts` / `database.types.ts:250-269`** — customer row: `name`, nullable
  `phone`, `email`, address columns, `lat/lng/geocoded_at`, `attributes` (L3), `source_capture_id`.
  **No consent, opt-in, preferred-channel, or "do not contact" field exists.**
- **`src/db/tenants.ts` / `database.types.ts:1004-1014`** — tenant row: `id`, `name`,
  `manager_seats`, `technician_seats`, `technician_horizon_days`, `default_job_minutes`,
  `timezone`, `created_at`. **No sender/announcement config columns.** Settings-write
  precedent: `setTechnicianHorizonDays` (`:110`, plain update, DB CHECK backstop). The 4b-3
  autonomy column was considered and DROPPED (plan decision) — cadence lives with the agent's
  cron, not a tenant flag.
- **`src/routes/deepLink.ts`** — `formatAddress` (`:69`, null unless `address_line1`) and
  `buildMapsDeepLink` (staff-facing route links; shows the house pattern for link building).
- **`src/db/rawCaptures.ts`** — `appendRawCapture` (`:33`); person attribution is a roster ref
  or the reserved **`connector:<toolkit>`** namespace (`:15`) — that namespace is *capture
  attribution only*; no non-person **sending** identity exists anywhere.
- **`Box_Setup_Stuff/bootstrap-box.sh`** — §0g (`:766-796`): agent scheduled work uses
  OpenClaw cron, on-demand/targeted/finite, wiped by rebuild; §0h (`:825-831`): a scheduled
  agent firing is a **proposal + reminder, never an unattended commit**.

## Data Flows

**1. The only outbound send today (technician or manager using the spine tool):**

```
agent calls send_email{to,subject,body}
  → STAGE: pending_outbound_send review item (one per person; supersede; 15-min TTL)
  → human sees exact copy, says yes
agent calls send_email{confirmId}
  → CONSUME token (at-most-once) → sendGmailEmail via Composio GMAIL_SEND_EMAIL
      (identity = THAT PERSON's paired Gmail; connectedAccountId pinned)
  → cost ledger row (billed per execute)
  → advisory L1 capture: channel outbound_email, VERBATIM body, externalId sent:<messageId>
```

**2. Manager Composio-direct sends** (their session can call `GMAIL_SEND_EMAIL` itself):
our server is not in the request path; the **lifecycle cron's logIngest sweep** (60-min
overlapping window) captures them to L1 afterward — sends verbatim, other actions keys-only.

**3. The staff notification pipeline (the consumer precedent a 4c sender would sit beside):**

```
booking verbs / freeze commit ──► schedule_events (append-only, id = version)
                                      │
                      ┌───────────────┴────────────────────┐
                      ▼                                    ▼
        boardNotify.pollOnce (EXISTS)          [4c customer sender — DOES NOT EXIST]
        staff Telegram via board bot            would need: contact data, channel,
        in-memory cursor, 30s worker loop       sending identity, copy, its own cursor
        >3/tick → digest; freezeRun header      posture, and an L1 capture policy
```

**4. What a window announcement would draw on:** a placed visit row carries
`starts_at/ends_at` (naive-local wall-clock stored as-if-UTC — readers slice `HH:MM` and must
render via `tenants.timezone` convention), the technician (nullable!), the job title, and the
promise columns. Unplaced (timeTbd) rows carry **NULL times** and a date fence — there is no
time to announce, by construction (the recorded 4b-2 motivation: a sender must never announce
placeholder times). Person-less rows have no technician name to announce. `moved`/`cancelled`
events carry `fromDay/toDay`/`day` detail a customer-facing "your window changed" message
would need.

**5. Nudge/cadence machinery available:** plain-code homes are the lifecycle cron (`*/15`,
sweep-style idempotent steps) and the board worker loop (30s, cursor-driven); the agent-side
home is OpenClaw cron under the §0g/§0h doctrine, where a scheduled firing may only *propose*.
`pending_outbound_send` + `run_freeze`'s plan-level confirm are the two staging shapes on
record (per-item vs whole-plan yes).

## External Dependencies

- **Composio** — `GMAIL_SEND_EMAIL` / `GMAIL_REPLY_TO_THREAD` executes (billed per call,
  cost-ledger rows), Tool Router sessions (tier enforcement), logs API v3.1 (audit sweep).
- **Gmail via Composio managed OAuth** — per-person paired mailboxes (`mail.google.com` scope).
- **Telegram Bot API** — board bot (staff pushes only).
- **Google Maps URLs / Geocoding / Route Optimization** — staff-facing; no customer contact.

**Flagged for plan-time live-doc verification (NOT verified in this pass, per CLAUDE.md
external-services rule):** (a) Composio's options for a *non-person / tenant-level* Gmail
connected account (today's pairing model is person-keyed `compositeUserId`); (b) Gmail
send-as/alias possibilities through `GMAIL_SEND_EMAIL`; (c) Twilio (or any SMS provider)
A2P 10DLC registration requirements, timelines, and cost for US application-to-person SMS;
(d) transactional-email alternatives if a shared system identity is chosen. CLAUDE.md
name-drops Twilio only as an example vendor — **no Twilio/SMS sending code exists in src**
(`sms` appears solely as a `capture_channel` enum value, i.e. L1 vocabulary for *inbound*
capture attribution, `database.types.ts:1169`).

## Constraints and Invariants

- **No customer-facing sender exists.** Customers hear nothing today: `boardNotify` pushes to
  staff; `freeze_committed` goes to managers only.
- **Every existing send is as a person.** `requireOutboundCapable` demands an active roster row
  with a paired mailbox; there is no system identity, and the reserved `connector:` namespace
  is capture-attribution only.
- **Contact-data scarcity is binding.** Pilot read-back today: **37 customers — 2 with phone,
  1 with email** (the 2026-07-24 research's "who can even be told?" bound is still true; the
  WA seed added addresses, not contacts). No consent/opt-in/channel-preference fields exist.
- **L1 rules for outbound are settled policy:** outbound captures are classifier-free
  (recorded exception 2026-07-04, with a disclosure obligation to staff); send bodies stored
  verbatim; non-send actions keys-only; L1 is append-only and undeletable, so capture-policy
  changes are reviewed policy changes; capture failures are advisory (never un-report a send);
  external-id dedup is the idempotency spine.
- **The confirmation doctrine is single-sourced and reaches sends:** confirm what is
  irreversible or externally visible. A customer email is externally visible; today's gate is
  per-send two-step (`send_email`), and the only batch-level yes on record is `run_freeze`'s
  plan-level confirm.
- **The consumer precedent's cursor is in-memory:** restarts silently skip the backlog —
  documented as acceptable for staff pushes. `listScheduleEventsSince` pages at 100/tick.
  The lifecycle cron shows the durable alternative pattern (overlapping window + dedup, no
  cursor table).
- **What is structurally unannouncable:** timeTbd rows (NULL times), person-less rows (no
  technician name). No "announced" or "suppress announcement" flag exists on any row.
- **Promises are the record of what a customer was told** (`promise_level`/`promised_day`,
  default `none`, edited via `set_promise`, server-derived day) — but nothing links an actual
  sent message to a promise today.
- **Times are naive-local**; any copy rendering times must follow the HH:MM-slice convention
  and `tenants.timezone`.
- **Cost:** every Composio execute is billed and ledgered (PR #87); an N-customer announcement
  run is N billed executes on any Composio-backed path.

## Decision Points

1. **Channel** — email only (a send primitive exists, but only person-identified), SMS
  (no code, A2P registration reality unverified), or both. Contact scarcity (2 phones/1 email
  across 37 pilot customers) bounds every option and implies a contact-collection story.
2. **Sender identity** — (a) a person's existing paired mailbox (announcements arrive "from
  Sam"); (b) a shared system identity per tenant or global (no precedent in the repo; needs
  the flagged Composio/Gmail/transactional-email verification); (c) agent-driven sends through
  the existing per-send two-step gate. This is the fork recorded OPEN since the Plan-4 brief
  ("notification-sender fork — decide in Plan 4's brief").
3. **Trigger** — freeze-commit-only (batch keyed on `freezeRun`, matching the digest
  precedent), every booked/moved/cancelled event, or manager-invoked ("announce next week").
4. **Promise interplay** — should an announcement auto-set `promise_level`/`promised_day` on
  the announced visit? Today promises are set only by manager words via `set_promise`/booking;
  if announcements don't write promises, the move/cancel gates don't know the customer was told.
5. **Confirmation shape** — per-send two-step × N customers vs one plan-level yes for a whole
  announcement run (the `run_freeze` staging shape). Current doctrine (externally visible ⇒
  confirm) reaches every customer message.
6. **Consent/opt-in** — no fields, no legal posture recorded; SMS especially raises this.
7. **Nudge home and cadence** — plain-code (a lifecycle-cron step or a worker loop with its
  own cursor) vs agent cron (§0h says a scheduled agent firing only proposes). Day-before
  reminders imply time-based sweeps, not event-driven pushes.
8. **Copy ownership** — canned plain-code templates (the boardNotify precedent) vs
  agent-written text (inference cost + reliability; three inference incidents on record).
9. **Cursor durability** — staff pushes tolerate restart-drops; missed customer announcements
  may not. Durable options visible in-repo: the lifecycle sweep pattern (window + external-id
  dedup) or a new durable cursor/queue (no precedent).
10. **Adjacency: the open board-bot → agent-bot transport swap** (staff notifications moving
  into the NemoClaw chat) — a 4c sender would be a *third* schedule_events consumer. They
  share the feed and possibly the digest idea but nothing else structurally; whichever lands
  first sets the pattern for durable cursors and per-recipient routing.

## Open Questions

- Can Composio hold a **tenant-level (non-person) Gmail connected account**, and can
  `GMAIL_SEND_EMAIL` send-as an alias? (Both flagged above; decide-blocking for identity
  option b.)
- What does A2P 10DLC actually require (time, cost, sole-proprietor vs EIN) at pilot scale?
- Where does customer contact data come from — is there an intake flow worth building first,
  given 3 of 37 customers are reachable at all?
- What cadence does the pilot manager actually want for announcements (open since the
  2026-07-24 research; never asked)?
- Does the disclosure obligation attached to the outbound-capture exception extend to
  customer-facing system sends (i.e., must announcement copy disclose logging)?
