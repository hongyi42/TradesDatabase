---
date: 2026-08-07
topic: Customer-facing sign-in + billing + self-serve seat purchase, and how it lands on the Lightsail box
status: research (read-only) — no code changed
branch: feat/customer-billing-portal
---

# Research — customer billing portal & the seat→sandbox pipeline

## 1. What was asked vs. what the words mean here

Three vocabulary collisions have to be settled before anything is designed, because each one
already means something else in this repo:

| Word in the request | What it means in this codebase today | What the request actually means |
|---|---|---|
| "customer" | `customers` table = **homeowners** of the trades business (L2 spine: `customers ─(1:N)─ jobs`) | the **trades business** that buys our product = `tenants` row |
| "add a seat" | `add_technician_seat` MCP tool = **fill** an already-purchased seat with a person | **buy one more unit of capacity** (`tenants.technician_seats` + 1) |
| "bill" | `cost_events` / `cost_rollup_monthly` = **what WE pay vendors** (DeepInfra, Brave, SignalWire) | **what the customer owes US** — revenue, which does not exist anywhere yet |

That third row is the dangerous one. The `/admin` cost dashboard is explicitly *"the ONE
cross-tenant read surface"* and it reports our COGS. Rendering any of it into a
customer-facing page discloses our unit economics and margin. **The customer's bill must be
sourced from Stripe invoices only, never from the cost ledger.** I recommend we keep the
two words apart permanently: *cost* = what we pay, *bill/invoice* = what they pay.

Proposed vocabulary going forward: **seats** = purchased capacity, **members** = people
occupying them. `add_technician_seat` is misnamed under that scheme; renaming it is out of
scope here but worth a follow-up.

## 2. What already exists (and is reusable)

Far more than expected. Seats are already a first-class, DB-enforced concept.

### Seat accounting
- `tenants.manager_seats` / `tenants.technician_seats` (`20260702194603`), deliberately kept
  **separate and never summed** — two different products at two price points
  (`src/db/tenants.ts:48-57`).
- A DB trigger `technicians_seat_cap` (rewritten by `20260719120000`) refuses to insert or
  activate a roster row past the cap: `raise exception 'seat_cap_exceeded'`.
- `seat_exempt` rows are name-on-the-schedule only — no seat, no sandbox, no pairing.
- **`setTenantSeats()` (`src/db/tenants.ts:127`) is called from tests only.** There is no
  production path that changes purchased capacity today; seats are set by hand at tenant
  creation. The portal would be its **first real writer**.

### The sandbox pool
- `sandbox_pool` (`20260707000000`) — the "rack of blanks": pre-built, identity-empty OpenClaw
  sandboxes. `technician_id IS NULL` = free/cold. `bind_telegram` claims the FIFO head.
- Recorded invariant (`docs/engineering-memory.md` §2): **free blanks = purchased seats −
  active members.**
- Retirement/recycle lifecycle already exists (`20260712090000`): deactivation marks
  `retire_requested_at`; the box destroys + re-provisions and reports back via
  `POST /control/sandboxes`; `retired_at` stamps completion. Rows are kept forever.
- `bot_username` on the pool row (`20260711200000`) because a technician cannot open a chat
  without the bot's `@handle` (bots can't message first).

### The box-work delivery mechanism — this is the key reusable pattern
The server never pushes to the box. The box **pulls**:
`badge-pull.sh` polls `GET /control/badges` every 5 min; the response carries `badges[]`,
`bindings[]` (desired Telegram allowlist) and `retirements[]` (work queue). The box acts, then
reports completion with `POST /control/sandboxes`. Both endpoints authenticate with the host's
bearer token, stored server-side as a sha256 fingerprint only
(`src/mcp/httpServer.ts:239-337`).

`recycle-sandbox.sh` is the worked example of async box work: journal-first, systemd-serialized,
**~10 minutes per sandbox** ("the provision build dominates"), failures parked in `failed/`
with an alarm. Anything the portal triggers on the box inherits this shape.

### The web surface pattern
`/admin` is the template for the portal, almost exactly:
- static shell served **unauthenticated** (it carries zero data), figures arrive via an authed
  JSON call (`src/admin/adminApi.ts:311-321`);
- mounted **before** the IP allowlist in `httpServer.ts` because it loads in an ordinary
  browser, not through the gateway;
- bearer token, constant-time compare, **length check first** (`timingSafeEqual` throws on
  unequal lengths, which would leak the length through a 500);
- unset token → **503, never open** — fail closed;
- `cache-control: no-store` on financial JSON;
- no framework, no build step; `web/admin/*` + a whitelist static server with traversal
  rejection.

## 3. What does not exist at all

- **Any payment infrastructure.** No Stripe dependency, no billing tables, no revenue concept.
  The only Stripe reference in the repo is a *test fixture string* for a Composio action
  (`src/mcp/server.test.ts:2215`) and a note that DeepInfra's billing API returns Stripe
  invoice objects (`src/model/deepinfraUsage.ts`). Greenfield.
- **Any end-user auth.** Three auth mechanisms exist, none usable for a customer login:
  HMAC gateway identity (machine), host bearer token (machine), shared operator token
  (`/admin`), Telegram `initData` (the board — closest analogue, `src/telegram/initData.ts`).
- **Any net-new sandbox provisioning path driven by the server.** The recycler only
  *re-provisions*, and it **reuses the retired sandbox's bot token** read from the box's own
  `sandboxes.json`. A net-new sandbox needs a token that does not yet exist on the box.
- **Capacity accounting.** `hosts` has `id, name, token_hash` and nothing else — no capacity,
  no placement policy.

## 4. External-service facts (verified against live docs today, not memory)

### 4.1 The BotFather bottleneck is GONE — this is the headline finding

`docs/engineering-memory.md` §2 records: *"The only un-automatable step is creating Telegram
bots at BotFather (no API) — pre-create and vault tokens."*

**That is now out of date.** Bot API 9.6 (2026-04-03) added **Managed Bots**:

1. One of our bots enables **"Bot Management Mode"** in BotFather's MiniApp; `getMe` then
   returns `can_manage_bots: true`.
2. The customer opens a deep link:
   `https://t.me/newbot/{manager_bot_username}/{new_username}?name={new_name}`
3. Telegram shows a "Create bot?" confirmation — **one tap by the customer**.
4. Our manager bot receives a `managed_bot` update carrying a `ManagedBotUpdated` object with
   the new bot and its creator.
5. We call **`getManagedBotToken`** to fetch the token programmatically.
   `replaceManagedBotToken` rotates it if compromised.

Sources: [Bot Management Mode, core.telegram.org/bots/features](https://core.telegram.org/bots/features) ·
[Bot API reference](https://core.telegram.org/bots/api)

Consequences for the design:
- Seat purchase can be **genuinely self-serve** — no operator, no copy-pasted token, no
  pre-created inventory to run dry.
- The customer never handles a secret, so we never take a bot token through a web form. That
  removes the whole custody problem the user's framing implied.
- **The `user id` half of the user's question is also solved differently:** the
  `ManagedBotUpdated` object identifies the creator, so the Telegram user id arrives with the
  bot rather than being typed in. `bind_telegram` already sets `technicians.telegram_user_id`.
- Two things I could **not** confirm from the docs and must be treated as unverified:
  **(a) any cap on managed bots per manager bot** (Telegram's long-standing global limit was
  20 bots per *user* — if that applies to managed bots it is a hard ceiling on this design);
  **(b)** whether a managed bot's token survives the creator blocking/removing our manager bot.
  Both need a live probe before we commit — see the plan's Phase 0.

### 4.2 Stripe per-seat billing
- Per-seat is a **licensed (not usage-based) flat-rate price where `quantity` = seats**.
  ([per-seat pricing](https://docs.stripe.com/subscriptions/pricing-models/per-seat-pricing))
- Change seats: `POST /v1/subscription_items/{id}` with `quantity`.
  ([API ref](https://docs.stripe.com/api/subscription_items/update))
  - `proration_behavior`: `create_prorations` (default) · `always_invoice` (bill the proration
    immediately) · `none`.
  - `payment_behavior`: **`pending_if_incomplete`** creates a *pending update* that applies
    **only if payment succeeds** — documented as "the simplest way to ensure the customer
    completes payment before Stripe applies the update". That is exactly the semantics we want
    for a seat *increase*: no capacity is granted until money clears.
- **Manager seats and technician seats must be two separate subscription items** (two prices),
  which matches the repo's never-sum rule.
- Stripe's **hosted Customer Portal** covers invoice view/download, payment-method updates, and
  subscription changes with zero UI work from us.
  ([customer management](https://docs.stripe.com/customer-management)) Limits that matter:
  - **cannot be iframed**;
  - portal sessions expire after 5 minutes unused;
  - a subscription with **multiple products cannot be *updated* in the portal** (only
    cancelled) — and we need two items (manager + technician), so **seat changes cannot go
    through the hosted portal**. We must build the seat UI ourselves and use the portal only
    for invoices + payment methods.

## 5. How this lands on the Lightsail box — the real constraint

Current topology (`docs/engineering-memory.md` §3): **one** box, `trades-box-1`, AWS Lightsail,
static IP 34.211.61.184, the **$84/mo bundle — 4 vCPU / 16 GB / 320 GB**, where *"16 GB is a
hard floor — the sandbox image push OOMs below it"*.

Live sandbox map: s2 (owner), s3 (Judy — real beta, hands off), s5 (ben-shelton), s6 (the
pool's **one** free blank), s7 (Yutao, the box default), s8 (manager-joy). So **6 live
sandboxes and exactly one spare** on a 16 GB box, plus the doorman, plus the badge-pull and
medic timers.

```
   Stripe                Render (web)                    trades-box-1 (16 GB, ONE box)
     │                        │                                 │
  seat paid ──webhook──▶ seats += 1                             │
                          queue provision ──┐                   │
                                            │  badge-pull 5min  │
                                            └──▶ provisions[] ──▶ bootstrap provision (~10 min)
                                                                 │  ├─ needs a BOT TOKEN
   customer taps t.me/newbot/... ──▶ managed_bot update          │  └─ needs RAM + disk
        (one tap)                    getManagedBotToken ─────────┘        ▲
                                                                     THE CEILING
```

Three hard problems, in order of severity:

**(a) Capacity is unmeasured and probably small.** Nobody knows how many sandboxes fit in
16 GB. If we sell a seat we cannot provision, the customer has paid for nothing and the
failure surfaces ~10 minutes later on a box, asynchronously — the worst possible place. This
is the single biggest risk in the whole feature. It needs **measurement first** and then
**admission control at the point of sale**: the purchase must be refused (or explicitly
queued with a stated wait) when the target host lacks headroom. Selling first and discovering
capacity later is not an option.

**(b) Horizontal scaling is already modelled but never exercised.** `hosts` is a table,
`sandbox_pool.host_id` is an FK, and `scripts/assign-host.mjs create-host` exists — so N boxes
are structurally supported. What is missing is a **placement policy** (which host gets the new
blank) and a per-host capacity number. Adding `hosts.max_sandboxes` + "pick the host with
free capacity" is a small change that converts a hard ceiling into a purchasing decision.
Note the standing hazard from the runbook: **never run one bot token on two boxes** — both
poll Telegram and the live bot goes deaf.

**(c) A net-new provision needs a secret delivered to the box.** The recycler sidesteps this
by reusing the old token off the box's disk. For a net-new sandbox the token exists only
server-side (we just fetched it from `getManagedBotToken`). Is serving it over the badge pull
a custody violation? **No — and this is worth stating explicitly:** the pull *already* mints
and serves badge secrets ("mint-on-first-pull"), over TLS, gated on a host bearer token whose
plaintext we never store. A bot token is the same category of secret on the same channel. But
it is not *nothing* either: it should go on a **narrow, one-shot, consumed-on-read endpoint**
rather than being sprayed into every 5-minute pull response, and it must never be logged.
This needs the `data-security` skill applied at implementation time.

## 6. Landmines found

1. **Reducing seats is completely unguarded.** `technicians_seat_cap` fires
   `before insert or update of state, tier, seat_exempt on technicians` — it does **not** fire
   on `tenants` updates. So `setTenantSeats()` can drop `technician_seats` below the current
   active headcount with no error, silently leaving the tenant over the cap. Any "remove seat"
   button must enforce `new_seats >= active_non_exempt_members` in application code **and** get
   a DB-level guard.
2. **Which sandbox does "remove a seat" retire?** It must retire a **free blank**, never a
   person's live sandbox. If there is no free blank, refuse and tell the customer to deactivate
   a member first. Getting this backwards destroys a working technician's agent.
3. **Refs are never reused; offboarding is permanent.** L1 is append-only, so
   `technicians` refs are permanent and "reactivating an offboarded person is impossible by
   design". A billing UI that implies seats and people are freely interchangeable will mislead.
4. **The pool invariant is the thing that can silently break.** free blanks = seats − active
   members. Every path that touches either side (Stripe webhook, provision completion,
   deactivation, recycle) must be checked against it. A reconciliation sweep in the existing
   cron is the natural home.
5. **Deploy topology:** Render deploys a **separate repo** (`Yu-C1/TradesDatabase`), not the
   dev repo — merging to `main` here does not ship. Someone must sync that repo, then
   "deploy latest commit" (and never the "Redeploy" button, which re-runs the old commit).
6. **`npm test` must never point at the pilot DB** — it truncates the roster the badge pull
   reads (real outage 2026-07-03). Standard rule, but this feature adds tables that the
   portal reads live.
7. **Stripe webhooks are a new unauthenticated public endpoint.** They need signature
   verification, and idempotency: Stripe retries, and a double-processed
   `customer.subscription.updated` must not add two seats. Event-id dedup table.

## 7. Open questions for the owner

1. **Price points** for a manager seat and a technician seat per month. Nothing in the repo
   records intended pricing. Needed before Stripe products can be created.
2. **Who may sign in?** Manager-tier members only, or a separate billing contact who may not
   be on the roster at all? (Recommendation: a separate `billing_contacts` concept — the person
   holding the credit card is often not a dispatcher.)
3. **Self-serve signup, or invite-only?** A public "create your account" page implies tenant
   auto-provisioning, terms acceptance, and abuse exposure. Given exactly two tenants exist
   today (one is the owner's test account), I'd start invite-only: we create the tenant, the
   customer signs in to an account that already exists.
4. **Does the 20-bots-per-user Telegram limit apply to managed bots?** Blocks the whole
   self-serve premise if it does. Probe needed.
5. **Trial or no trial?** Affects Stripe config materially (portal modifications to a
   `trialing` subscription end the trial and invoice immediately).

---

# Phase 0 findings — box capacity (measured 2026-08-12)

Read-only probe of `trades-box-1` (34.211.61.184, Lightsail, 4 vCPU / 15.4 GiB / 310 GB disk,
up 36 days) plus SELECTs against the pilot DB. Nothing was written or restarted.

## Headline: the box holds ~3 more sandboxes, not ~25

`docker stats` reports each sandbox at **~450–580 MiB**, which suggests room for roughly 25 more.
**That number is wrong and dangerous.** The cgroup peak counter tells the real story:

| sandbox | current MiB | **peak MiB** | container up since |
|---|---|---|---|
| s2 | 1011 | **1565** | 2026-08-12 |
| s3 | 990 | **1374** | 2026-08-12 |
| s5 | 923 | **1351** | 2026-08-12 |
| s6 | 535 | **1404** | 2026-08-12 |
| s7 | 964 | **1447** | 2026-07-21 |
| s8 | 943 | **1514** | 2026-07-24 |

Peak is **~1.5 GiB per sandbox — 3× the `docker stats` figure.** Six sandboxes peaking together
would want ~9.2 GiB. With the gateway (153 MiB) and the OS, worst-case simultaneous demand is
already ~10 GiB of 15.4 GiB.

Usable ≈ 15.4 GiB − ~1.5 GiB (OS + gateway + headroom) ≈ 13.9 GiB. At the 1.565 GiB observed
peak that is **~9 sandboxes total, i.e. about 3 more than the 6 running now.**

You can beat that by oversubscribing, since peaks across different customers are probably
uncorrelated. Two facts make that a bad bet today:

1. **There is no swap** (`swapon --show` is empty). Memory pressure does not degrade, it OOM-kills,
   and the kernel picks the victim — plausibly a live customer's sandbox.
2. **Five of six containers have NO memory limit.** Only s3 (Judy, the real beta) is capped, at
   3947 MiB. One runaway sandbox can therefore consume the box and take the others with it.

**Recommendation before selling any seat:** set a per-container memory limit on every sandbox
(s3 already proves the mechanism works), and add swap as a shock absorber. Until both exist, treat
**9 total** as the cap and note it is a worst-case-simultaneity figure, not a measured ceiling.

Disk and CPU are not the constraint and are not close: 16 GB of 310 GB used, load average 0.05
with six sandboxes idling at ~0.8% CPU each.

## The pool table is not an inventory of the box

Six containers run (`s2 s3 s5 s6 s7 s8`). `sandbox_pool` has **two** live rows (`s5` claimed,
`s6` free). **`s2`, `s3`, `s7` and `s8` are running but have no live pool row at all.**

Any capacity or admission-control logic reading `sandbox_pool` therefore undercounts reality by
four, and the plan's invariant — *free blanks = purchased seats − active members* — cannot hold
against this data.

## s6 is double-booked, and it is the only "free" blank

| Source | What it says about s6 |
|---|---|
| `sandbox_pool` | live, **unclaimed — a FREE BLANK**, tenant `Default Tenant` |
| `technicians` | `sandbox_ref = s6` for `manager-sam` (Sam Rivera), state `active`, tenant **`spine-eval-main`** |
| the box | `openshell-s6` up and healthy since 2026-08-12, 535 MiB current / 1404 MiB peak |

The single blank the allocator would hand to the next paying customer is **already running a live
sandbox belonging to a different tenant**. This is worse than the plan's "selling a seat we cannot
provision": it is handing a new customer a container that is serving someone else.

Note also that `manager-sam` exists in two tenants (`Default Tenant` → s2, `spine-eval-main` → s6),
so a lookup by ref alone is ambiguous across tenants.

**This needs reconciling before Phase 4/5, and it is a data fix, not a code change.**

## `hosts` has no `max_sandboxes` column

Actual columns: `id, name, token_hash, created_at`. The 2026-08-07 plan's Phase 1 specified
`hosts.max_sandboxes integer` to be filled from this probe; it was never added, so there is
nowhere to record the cap above and nothing for admission control to read.

## Still unrun: the Telegram managed-bot cap

The other half of Phase 0 is untouched. It needs a throwaway manager bot with Bot Management Mode
on, three managed bots created via the deep link, and `getManagedBotToken` confirmed for each —
real bots created from a real Telegram account, so it is the owner's to run. If the historic
20-per-user limit applies to managed bots, D3 must switch to the vault fallback before Phase 4.
