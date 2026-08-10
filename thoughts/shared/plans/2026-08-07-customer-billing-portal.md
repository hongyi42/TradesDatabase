# Customer billing portal & self-serve seats (2026-08-07)

Research: [2026-08-07-customer-billing-portal.md](../research/2026-08-07-customer-billing-portal.md)

## The problem, in one sentence

We can take money and grow the roster only by hand today — there is no revenue system, no
customer login, and no way for a firm to buy a seat without an operator creating a Telegram bot
and provisioning a sandbox — and the one 16 GB Lightsail box has exactly **one** free blank left.

## Decision brief

Six decisions. My recommendation is first in each.

### D1 — Where does the bill come from?
| Option | Trade-off |
|---|---|
| **✅ Stripe invoices, via the hosted Customer Portal** | Zero UI for invoice history/PDF/payment methods, PCI stays Stripe's problem. Cannot be iframed, so it's a redirect out and back. |
| Our own invoice rendering | Prettier, on-brand. Weeks of work, and we own dunning, tax, and card storage. No. |
| Reuse `cost_rollup_monthly` | **Never.** That is our vendor COGS. Showing it to a customer discloses our margin. |

**Recommend: Stripe hosted portal for invoices + payment methods; our own page for seats.**
Forced by a documented limit — a subscription with **multiple products cannot be updated in the
hosted portal**, and manager+technician seats must be two items (the never-sum rule). So seats
have to be ours regardless.

### D2 — How do they sign in?
| Option | Trade-off |
|---|---|
| **✅ Supabase Auth email magic link** | Supabase is already in the stack; no password custody at all; email is already known. New table to map auth user → tenant. |
| Telegram Login Widget | Reuses an identity already proven on the roster (`telegram_user_id`). But billing on a phone-first identity is awkward, and the cardholder often isn't a Telegram member. |
| Shared bearer token (the `/admin` pattern) | Cheapest. Unacceptable for outsiders — no per-person revocation, no audit of who changed seats. |

**Recommend: magic link.** Explicitly **not** passwords — we never take a password into a form.

### D3 — Where does the Telegram bot token come from?
| Option | Trade-off |
|---|---|
| **✅ Managed Bots (Bot API 9.6)** — customer taps a `t.me/newbot/...` deep link, one tap, we call `getManagedBotToken` | Fully self-serve. Customer never handles a secret. Overturns the repo's recorded "BotFather is un-automatable" constraint. Risk: an unverified per-manager-bot cap. |
| Operator pre-creates and vaults tokens | What the repo does today. Works, but the inventory runs dry and a sale then blocks on a human. |
| Customer pastes their own token into our form | What the original request assumed. **Reject:** puts a live credential in a web form and in our logs, and makes the customer do BotFather by hand. |

**Recommend: Managed Bots, with the vault as the documented fallback** if Phase 0's probe finds
a cap.

### D4 — Seat increase: when is capacity granted?
**Recommend: only after money clears.** `POST /v1/subscription_items/{id}` with
`payment_behavior=pending_if_incomplete` — Stripe applies the quantity change *only if the
payment succeeds* (documented as the simplest way to guarantee exactly that). Seats increment
from the **webhook**, never from the browser's success redirect, which can be lost or forged.

### D5 — Seat decrease: what actually gets removed?
**Recommend: retire a free blank only, and refuse when there isn't one.** Never touch a live
member's sandbox. Also: `new_seats >= active_non_exempt_members` enforced in app code *and* as
a new DB constraint — the existing `technicians_seat_cap` trigger does not fire on `tenants`
updates, so this is currently unguarded (research §6.1).

### D7 — Data export: what can a manager download?
Two tiers, because they carry completely different risk:

| Tier | Contents | Risk |
|---|---|---|
| **Your records** (default) | `customers`, `jobs`, `visits`, `assignments`, `schedule_entries`, `technicians` (names/tiers, no credentials) — CSV per table, zipped | Ordinary business data. The everyday export. |
| **Everything, including conversations** | the above **plus** `raw_captures` (verbatim email bodies, call transcripts) and `call_ingest` | **Bulk PII of the customer's own customers.** Homeowner names, addresses, phone numbers, and the full text of what they said. |

**Recommend: ship both, but treat the second as a distinct, deliberate action** — separate
button, explicit confirmation naming what's inside, manager tier only, and every export written
to an audit row (who, when, which tier, row counts).

Mechanics, all forced by the data rather than chosen:
- **Asynchronous.** A full spine export will not finish inside an HTTP request. Queue a job,
  build the file, email a link. Same shape as provisioning.
- **The export file is a NEW COPY of PII living outside the database.** It gets a short expiry
  (recommend 7 days), a single-use signed URL, and hard deletion on expiry. This is the one
  place in the system where customer data leaves the spine as a file.
- **Never expand a redaction.** L1 carries `manager_only` sensitivity and keys-only redaction on
  agent actions (CLAUDE.md's outbound-capture exception). The export applies the *same* filter
  the chat surfaces do; it must not become a back door around sensitivity.
- **Never include** `cost_events`, `cost_rates`, `infra_costs`, `cost_rollup_monthly`, `hosts`,
  `sandbox_pool`, or any other tenant's rows. Those are ours, and two of them are cross-tenant.
- **CSV, not JSON, as the default.** The person clicking this opens it in Excel.

Why it's worth building beyond the ask: this is **exit portability**. A customer who can leave
with their data trusts you more with it, and "your records are yours, download them any time" is
a straight answer to the objection every small firm has about putting their book of business in
someone else's software.

### D6 — What do we do about one 16 GB box?
**Recommend: measure, then gate the sale on measured headroom.** Add `hosts.max_sandboxes` and
admission control at purchase time. Multi-host is already modelled (`hosts` table,
`sandbox_pool.host_id`, `assign-host.mjs`) and needs only a placement policy — but that is
Phase 7, and until it lands **the portal must be able to say "no capacity, we'll call you"
rather than take money it cannot honour.**

## Architecture

```
        ┌─────────────── Render web service (existing) ───────────────┐
browser │  /portal        static shell (no data)                      │
  ──────┼──▶ /portal/api/*  magic-link session → ONE tenant           │
        │  /portal/api/stripe/webhook   ← Stripe (sig-verified)       │
        └──────┬──────────────────────────────┬─────────────────────┬─┘
               │                              │                     │
      Stripe hosted portal            tenants.technician_seats   provision_requests
      (invoices, cards)                    += 1                   (queued)
                                                                     │
customer taps t.me/newbot/OurMgrBot/…                                │ served in the
        │ one tap                                                    │ 5-min badge pull
        ▼                                                            ▼
  managed_bot update → getManagedBotToken → vault ──────▶  trades-box-1
                                                            bootstrap provision (~10 min)
                                                            POST /control/sandboxes
                                                                     │
                                                            sandbox_pool: new free blank
```

Invariant everything must preserve: **free blanks = purchased seats − active members.**

## Phases

Each phase ends green on `npm run typecheck && npm run lint && npm test`, against the **local**
Supabase stack only (`testEnvGuard` enforces it — the hosted "test" project is the live pilot DB).

### Phase 0 — Probe the two unverified facts (no code)
Blocking, because both can invalidate the design.
1. **Telegram managed-bot cap.** Enable Bot Management Mode on a throwaway manager bot, create
   3 managed bots via the deep link, confirm `getManagedBotToken` returns each. Document whether
   any cap is hit and where. Also test: does the token survive the creator blocking the manager bot?
2. **Box capacity.** On `trades-box-1`, read-only: `free -m`, `df -h`, per-container
   `docker stats --no-stream` for the 6 live sandboxes. Derive sandboxes-per-16 GB and the
   marginal cost of one more. **Read-only only — never hand-touch s3 (Judy, real beta).**

**Verify:** a short findings note appended to the research doc. If (1) shows a cap ≤ ~20, switch
D3 to the vault fallback before Phase 4.

### Phase 1 — Billing schema + vocabulary
New migration. No behaviour yet.
- `billing_accounts` — `tenant_id` (unique), `stripe_customer_id`, `stripe_subscription_id`,
  `manager_item_id`, `technician_item_id`, `status`, timestamps.
- `billing_contacts` — `tenant_id`, `email` (citext, unique per tenant), `auth_user_id`,
  `role`, `invited_at`, `last_seen_at`. Separate from `technicians`: the cardholder is often
  not a dispatcher (research §7.2).
- `stripe_events` — `event_id` primary key, `processed_at`. Webhook idempotency; Stripe retries.
- `seat_change_log` — append-only audit: who, when, tier, from→to, stripe invoice ref. Seats are
  money; every change must be reconstructable.
- `hosts.max_sandboxes integer` (nullable = unknown/unlimited), filled from Phase 0.
- **DB guard for D5:** trigger on `tenants` update-of `manager_seats, technician_seats` that
  raises when the new count is below the active non-exempt headcount for that tier. Mirror of
  `enforce_seat_cap`, other direction.
- **RLS:** all new tables get RLS enabled with no policy, matching the cost tables
  (`20260725140000`) — the publishable anon key must not be able to route around the handler.
- Typed accessors in `src/db/billing.ts` only; no hand-written Supabase queries elsewhere.

**Verify:** `npm run gen:types:local` regenerated; schema test asserting RLS is on and the
down-guard trigger rejects an under-cap reduction.

### Phase 2 — Portal shell + sign-in + read-only bill
- `src/portal/portalApi.ts`, mounted in `httpServer.ts` **before the IP allowlist**, exactly
  where `isAdminPath` sits and for the same reason (ordinary browsers, not the gateway).
- `web/portal/{index.html,portal.css,portal.js}` — no framework, no build step (`/admin`
  precedent). Static shell carries **zero** data.
- Magic-link sign-in via Supabase Auth; server-side session cookie (`HttpOnly`, `Secure`,
  `SameSite=Lax`).
- **Every** `/portal/api/*` handler resolves the session → exactly one `tenant_id` and scopes
  every read to it. This is the security core of the feature: unlike `/admin`, outsiders use it.
- `GET /portal/api/summary` — plan, seats purchased/used per tier, next invoice date + amount
  (from Stripe), current members. `cache-control: no-store`.
- `POST /portal/api/billing-portal-session` → Stripe portal session, redirect out.

**Verify:** tests for cross-tenant denial (session for tenant A must 404/403 on tenant B's
ids), unauthenticated 401, misconfigured-Stripe 503-not-open. Load the `data-security` skill
before writing this phase.

### Phase 3 — Seat increase (money first)
- `POST /portal/api/seats/preview` → Stripe upcoming-invoice preview so the customer sees the
  prorated charge **before** confirming. Externally visible + irreversible → confirm (the
  confirmation doctrine's actual criterion).
- `POST /portal/api/seats/purchase` → `subscription_items.update` with `quantity`,
  `proration_behavior=always_invoice`, `payment_behavior=pending_if_incomplete`.
- `POST /portal/api/stripe/webhook` — signature-verified, `stripe_events` dedup, then:
  `setTenantSeats` + `seat_change_log` + enqueue a `provision_requests` row per new seat.
- Admission control (D6): if the tenant's host has no headroom, the purchase endpoint refuses
  **before** charging and says so plainly.

**Verify:** webhook replay test (same event id twice → one seat). Stripe CLI
`stripe listen`/`trigger` against a local server for the live leg.

### Phase 4 — Managed-bot creation
- A manager bot with Bot Management Mode on; long-poll/webhook handler for the `managed_bot`
  update; `getManagedBotToken` → store **encrypted at rest**, never logged, keys-only if it ever
  touches L1 (L1 is undeletable).
- The portal renders the deep link with a suggested username and the tenant's name; polls for
  arrival; shows "bot created ✓".
- `ManagedBotUpdated` gives us the creator's Telegram user id — feed it to the existing
  `bind_telegram` path instead of asking anyone to type an id.

**Verify:** live E2E on a scratch tenant per the `verifying-behavior` skill — this cannot be
proven by unit tests alone.

### Phase 5 — Box-side provisioning
- Extend the badge-pull response with `provisions[]` (the `retirements[]` pattern).
- One-shot, consumed-on-read `GET /control/provision-secret` for the bot token — narrow rather
  than sprayed into every 5-min pull (research §5c).
- `provision-sandbox.sh`, modelled on `recycle-sandbox.sh`: journal-first, systemd-serialized,
  parks failures in `failed/` with an alarm, reports via the existing `POST /control/sandboxes`.
- Reconciliation sweep added to the existing `*/15` cron: assert free blanks = seats − active
  members per tenant; report drift.

**Verify:** the `badgePullScript.test.ts` pattern for the script's guards; scratch-sandbox live
run before any real tenant.

### Phase 6 — Seat decrease
- `POST /portal/api/seats/release` with the D5 guards: refuse when no free blank exists, refuse
  below headcount, quantity down with `proration_behavior=create_prorations` (credit on next
  invoice, no cash refund).
- Reuses the existing retirement lifecycle end-to-end.

### Phase 6.5 — Data export (D7)
- `export_jobs` table: `tenant_id`, `requested_by`, `tier`, `status`, `row_counts` jsonb,
  `file_path`, `expires_at`, `downloaded_at`. Doubles as the audit trail — no separate log.
- Builder runs in the existing `*/15` cron (not in the web request): streams each table to CSV
  through the typed `src/db/` accessors so tenant scoping and sensitivity filtering are the
  *same code* the chat surfaces use, never a bespoke query.
- Delivery: Supabase Storage private bucket + a short-lived signed URL, emailed. Expiry sweep in
  the same cron hard-deletes the object and nulls `file_path`.
- Portal UI: two buttons under **Your data**, the second behind a confirmation that names what's
  in it. Past exports listed with their expiry so a stale link is visibly dead, not mysteriously
  broken.

**Verify:** a test asserting a tenant-A export contains zero tenant-B rows (the single most
important assertion in this feature); a test that `manager_only` L1 rows are filtered for a
technician-tier requester; an expiry test that the object is really gone. Load the
`data-security` skill before writing this phase — it is bulk PII egress, the highest-risk path
in the whole plan.

### Phase 7 — Capacity & placement (unblocks growth)
- Placement policy: pick the host with free capacity; `assign-host.mjs` already creates hosts.
- Second box when `max_sandboxes` is reached. Standing hazard: **never run one bot token on two
  boxes** — both poll Telegram and the live bot goes deaf.

## Scope cut if the date matters

Phases 0–3 + 6 give a customer who can sign in, see their bill, and buy/release seats, with
provisioning still operator-completed behind the scenes. Phase 6.5 (export) is independent of
the billing chain and can land any time after Phase 2. Phases 4–5 are what make it *hands-off*.
Phase 7 is what makes it *scale*. I would not ship 3 without 0.

## Out of scope (deliberate)

Self-serve tenant signup (invite-only, owner decision 2026-08-07), tax/VAT beyond Stripe Tax
defaults, dunning UI, renaming `add_technician_seat`, and any change to the cost dashboard.

## Naming note

Shortlist, checked against the field-service software market:

| Name | Why | Status |
|---|---|---|
| **Daybook** ✅ | A daybook is the original chronological record a business keeps *before* anything is posted to the ledger. That is literally L1: `raw_captures` is append-only and every structured field derives from it. The name states the product's actual thesis — the record writes itself from what already happened. Warm, old-trade, easy to say on the phone. | No collision found |
| Rafter | Short, structural, no single-trade lock-in, easy to spell. Weaker semantic link — it's a nice noun rather than an argument. | No collision found |
| Foreman | Describes the job exactly: coordinates the crew, holds the schedule, remembers who promised what. Two drawbacks: the George Foreman association, and the "-man" ending. | Not checked in depth |
| ~~Plumbline~~ | Was the front-runner (the tool that establishes what's true, matching the evidence-linked spine). | **Rejected** — [Plumbline Answering Service](https://plumblineanswers.org/) serves this exact market |

Competitors to stay clear of: Jobber, Joist, ServiceTitan, Housecall Pro, Workiz, FieldPulse,
Service Fusion, BuildOps.

**Before committing:** the owner must run a domain check and a USPTO/trademark search. A web
search rules out the obvious collisions, not the registered ones.

## Settled by the owner (2026-08-07)

1. **Pricing: manager seat $80/mo, technician seat $50/mo.** Explicitly a **placeholder** —
   expected to change. Consequence for the build: prices must never be hardcoded in our code or
   copy. Stripe Prices are the single source of truth; the portal reads the live unit amount off
   the subscription item and renders it. Changing a price becomes a Stripe dashboard action plus
   a new Price id, not a deploy.
2. **A discounted first month**, amount TBD. Implemented as a **Stripe Coupon / promotion code
   applied to the first invoice**, *not* as `trial_period_days`. Rationale: a real Stripe trial
   sets `status=trialing`, and any customer-side subscription edit while trialing **ends the
   trial and invoices immediately** — a customer adding a seat in week two would silently lose
   their discount. A first-invoice coupon survives seat changes. The TBD amount is a coupon
   percentage/value, settable without a deploy.
3. **Invite-only.** We create the tenant; the customer signs in to an account that already
   exists. No public signup page in v1.

## Product name

Recommendation: **Daybook**. Alternates: *Rafter*, *Foreman*. See the naming note at the end of
this plan. Nothing in the code depends on the name yet — the portal copy and the manager bot's
handle are the first places it lands, so the decision is needed before Phase 2, not Phase 1.
