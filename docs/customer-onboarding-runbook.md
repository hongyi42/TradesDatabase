# Customer onboarding runbook — taking one paying trades firm live

**Who this is for:** us, the operator, onboarding a firm that has signed and paid. Not the customer —
they get [getting-started-for-firms.md](getting-started-for-firms.md), which this runbook hands them
at Phase 6.

**How long:** roughly a week of elapsed time, of which ~4–6 hours is our hands-on work. Most of the
elapsed time is other people: Google OAuth consent, a phone-number port or forward, and legal
signatures.

> **Status gate (2026-08-06).** Phone-call capture — the last MVP feature — is implemented and
> live-verified on branch `feat/phone-call-capture` (commit `7f59a54`) but **is not merged to `main`
> and not deployed**. Until it lands, Phase 5 cannot run and the firm onboards without the phone
> channel. Everything else in this runbook reflects shipped code on `main`.

---

## 1. The shape of an onboarding

Three tracks run in parallel; only the last one is blocking.

```
 TRACK A — Legal & commercial        (starts first, ends last; nothing technical depends on it
   contracts, DPAs, disclosures       EXCEPT go-live)
   seat count, retention window
                                            │
 TRACK B — Infrastructure           ────────┤  we do this; the firm is not involved
   tenant row → roster → sandbox            │
   → badge → bot → phone number             │
                                            ▼
 TRACK C — Firm setup            ──────────────►  GO-LIVE
   the manager does this IN CHAT,                 (E2E verification, then training)
   guided by us over a screen-share
```

**The one hard ordering rule:** Track C cannot start until Track B reaches "the manager can talk to
their bot", because every Track C step *is* a chat message to that bot. Everything before that is
ours.

**Not self-serve.** There is no signup page, no admin UI for creating a firm. Tenant creation and the
first manager's roster row are operator SQL. That is a deliberate pilot-stage choice, not an
oversight — but it means **every new customer costs us a scheduled block of work**, and you should
book it before taking the money.

---

## 2. Phase 0 — Before you touch anything (Track A)

| Decision | Who decides | Where it lands |
|---|---|---|
| Manager seats / technician seats | Sales + the firm | `tenants.manager_seats` / `technician_seats` |
| The firm's timezone | The firm | `tenants.timezone` — **schedule times are stored naive-local, so this is not cosmetic** |
| Call-audio retention (days; `0` = transcript-only) | The firm's counsel | `CALL_AUDIO_RETENTION_DAYS` |
| How far ahead technicians see the schedule | The manager | `tenants.technician_horizon_days` (default 4 weeks) |
| Default job length when a type has none | The manager | `tenants.default_job_minutes` |

**Signatures we must have before a single real customer record exists:**

- **DPAs** with Supabase, SignalWire, AssemblyAI, Composio, and the model provider (DeepInfra).
- **AssemblyAI no-train opt-out** enabled on the account.
- **Tenant ToS** settling the controller/processor split: the trades firm is the *controller* for its
  own callers and customers; we are the *processor*. The caller-facing privacy notice and CCPA
  "business" duties sit with them. ([phone-call-runbook.md](phone-call-runbook.md) argues this.)

**Three disclosures we owe the firm in writing, because all are irreversible by design:**

1. **"Emails sent through the assistant are permanently logged."** Outbound and agent-action captures
   are classifier-free by decision — every send is recorded, including personal ones. Managers and
   technicians must be told before they get access. (`CLAUDE.md`, recorded exception 2026-07-04.)
2. **"Nothing recorded can be deleted."** L1 is append-only at the database level. A mistake is
   *retracted* — marked recorded-in-error and hidden from reads — never removed. If the firm cannot
   live with that, stop here; it is the product's foundation, not a setting.
3. **"The assistant may proactively ask about work, and what you tell it can be recorded to the
   firm's job records."** (Ratified 2026-08-15, ships with intelligent-spine Stage 1.) When a
   scheduled visit passes with nothing recorded, the office assistant may message a technician's
   assistant with one short question ("how did the Henderson visit go?"); the answer — even
   "nothing to report" — is saved to the job's record. Bounded by mechanism, not promise: at most
   2 such questions per person per day, never a repeat for the same visit, and 48 hours of silence
   simply hands the item to the manager instead of re-asking. Technicians must be told this before
   their assistant is enabled.

---

## 3. Phase 1 — Create the tenant (operator, ~10 min)

Against the pilot database, via the `supabase-test` MCP or a one-off script:

```sql
insert into tenants (name, timezone, manager_seats, technician_seats, technician_horizon_days)
values ('Acme Heating & Air', 'America/Los_Angeles', 1, 5, 4)
returning id;
```

Record the tenant id — every later step needs it.

**Verify by read-back, not by the migration ledger** (the ledger under-reports; see
[engineering-memory.md](engineering-memory.md) §3): `select * from tenants where id = …`.

## 4. Phase 2 — The first manager's roster row (operator, ~10 min)

A firm's first manager is a chicken-and-egg case: `add_technician_seat` is a manager tool, and there
is no manager yet. Insert the row directly.

```sql
insert into technicians (tenant_id, ref, display_name, tier, state)
values ('<tenant-id>', 'manager-<firstname>', 'Dana Reyes', 'manager', 'active')
returning id, ref;
```

Two facts that bite later if you get them wrong now:

- **`ref` is permanent and never reused across humans** — it is stamped into append-only L1 rows. Pick
  a form you can live with (`manager-dana`, not `dana2`).
- Every subsequent person is added by the *manager in chat*, not by us. This is the only row we
  hand-write.

## 5. Phase 3 — Sandbox, bot, and badge (operator, ~45 min + a restart)

This is the fiddliest phase and the one with the most recorded traps. Work on `trades-box-1`
(`ssh tradesbox`) and follow [doorman-runbook.md](doorman-runbook.md) and
`Box_Setup_Stuff/bootstrap-box.sh` — this is a summary of the order, not a replacement for them.

```
BotFather ──► bot token ──► bootstrap-box.sh provision <agent> <secrets.env> <plan.b64>
                                       │
                                       ▼
      scripts/assign-host.mjs assign ref=<ref> host=<host> sandbox=<sandbox_ref>
                                       │  (server side; badge mints on the host's first pull)
                                       ▼
      badge-pull.sh (5-min systemd timer) ──► /root/pending-badges.jsonl
                                       │
                                       ▼
      install the provider credential ──► **RESTART THE CONTAINER**  ◄── the step everyone skips
                                       │
                                       ▼
      bootstrap-box.sh wire <agent>  (AGENTS.md §0 blocks) ──► gateway restart
```

**The trap that has cost us the most:** credentials inject into a sandbox's environment **only at
container launch**. A badge written without a container restart looks fine and is not — this silently
killed a beta customer's spine access for four days. Restart, then verify by making the agent call a
spine tool.

**Enumerate live sandboxes from the box (`nemoclaw list`), never from a remembered map** — including
the one in engineering-memory §4, which is dated.

Then bind the manager's Telegram account. For the first manager, set it directly:

```sql
update technicians set telegram_user_id = '<numeric id from @userinfobot>' where ref = '…';
```

The binding reaches the box on the next badge pull (~5 min) and is applied to the sandbox allowlist
with no rebuild. **The person must open the bot and send `/start` themselves** — Telegram bots cannot
message first.

**Exit gate for this phase:** the manager sends "hello" to their bot and gets an answer that proves a
spine call worked (ask them to type *"who is on my team?"* — it should return their own row).

## 6. Phase 4 — Gmail pairing (manager in chat, ~15 min + their consent)

Now the manager's own tools do the work:

1. Manager: *"get me a connect link for myself"* → `get_connect_link`.
2. Manager forwards the link to the person and they approve Google OAuth. **Links expire in about 25
   minutes** — forward immediately, re-issue if it goes stale (5-minute per-person cooldown).
3. The 15-minute cron pairing sweep detects the consent and opens a verification review item.
4. Manager: *"what's pending?"* → `list_pending_reviews` → confirms the mailbox address →
   `resolve_review` with `resolved`. Wrong mailbox → `dismissed`, which tears the pairing down for a
   fresh link.

Mail arriving while the pairing is still `pending_verification` **is ingested**, stamped
`pendingVerification: true` — a deliberate exception so real work mail is not silently dropped in the
consent window.

## 7. Phase 5 — The phone line (operator, ~30 min) — *blocked until the branch merges*

Per [phone-call-runbook.md](phone-call-runbook.md). Per **tenant**:

1. Buy or assign a SignalWire number in the space.
2. Point its **"when a call comes in"** Voice webhook (HTTP POST) at
   `${SIGNALWIRE_WEBHOOK_BASE_URL}/inbound/phone/voice`.
3. Insert the routing row — **`forward_to` is mandatory**, not optional; without it the call cannot
   connect:
   ```sql
   insert into call_numbers (tenant_id, phone_number, forward_to)
   values ('<tenant>', '+1XXXXXXXXXX', '<the firm's real call-center line>');
   ```
4. Decide with the firm how callers reach it: publish the SignalWire number, or forward their existing
   published number to it. A **number port takes days** — start it in Phase 0 if they want it.
5. Confirm the platform-level prerequisites once (not per tenant): `SIGNALWIRE_REST_TOKEN` is the
   `PT…` REST token scoped **`Voice` + `Management`** (Management is the non-obvious one that unlocks
   protected media), `SIGNALWIRE_API_TOKEN` is the `PSK…` signing key, Media URL Protection stays
   **ON**, and both `calls:worker` (continuous) and `calls:purge` (daily) are running.
6. **Fire one live test call before telling the firm the number works.** A signature mismatch fails
   closed with a 403, so a wrong `SIGNALWIRE_WEBHOOK_BASE_URL` blocks every call — check it first.

The consent announcement is automatic: the voice webhook returns cXML that plays a non-skippable
"this call is recorded" line **before** the `<Dial record>`. Do not build a path that skips it.

## 8. Phase 6 — Firm setup, in chat (the manager, guided; ~60–90 min)

Hand over [getting-started-for-firms.md](getting-started-for-firms.md) and do this on a screen-share.
Everything here is the manager typing plain English to their bot. Our job is to watch and correct.

Order matters — later steps depend on earlier ones:

1. **Add the team** — one `add_technician_seat` per person (two-step: nothing exists until the
   confirming call). Schedule-only people (a subcontractor you dispatch but who gets no assistant) go
   in `seatExempt` and consume no seat.
2. **Set each person's working pattern** — `set_availability`. **This is the step that makes a person
   schedulable**; with no pattern the solver will never place them. It is the single most common
   missed step.
3. **Set job-type durations** — `set_job_duration` per type ("maintenance takes 60 minutes"). The
   scheduler *never* assumes a length: a job with no length and no configured type cannot be placed.
4. **Skills** (optional) — `set_technician_skills`. An empty list means "unknown" and never excludes
   anyone; only a *non-empty* list missing a required skill does.
5. **Bind each person's Telegram** — `bind_telegram` with their numeric id from `@userinfobot`. A
   sandbox is claimed automatically from the cold pool. Relay the returned `botUsername` — they must
   `/start` it themselves.
6. **Gmail pairing per person** — repeat Phase 4 for each.
7. **Time off** already known — `add_time_off`.

**Seat-pool prerequisite:** every purchased seat needs a pre-built cold sandbox on the box. If the
pool is empty, `bind_telegram` has nothing to claim. Check the pool *before* the screen-share.

## 9. Phase 7 — Go-live verification (operator + firm, ~45 min)

Do not declare go-live on a green test suite. Verify the paths a human will actually use, on the real
tenant, per the `verifying-behavior` skill.

| # | Check | Passes when |
|---|---|---|
| 1 | Technician sends a voice note about a real customer | An L1 capture exists, and the L2 customer/job it matched is correct |
| 2 | Manager asks for a briefing on that customer | The briefing cites the capture — and the citation resolves |
| 3 | Manager books a visit in chat | It appears on the board; the board and chat agree |
| 4 | Manager moves a promised visit | The agent asks for confirmation *because* a promise is at stake |
| 5 | Manager runs the freeze | A proposal is staged and **nothing books** until an explicit yes |
| 6 | Technician opens the board | Read-only day view; their own stops only |
| 7 | An inbound work email arrives | It lands in L1; a personal email does **not** |
| 8 | A test call to the phone line | Consent plays, call forwards, transcript lands as `channel:'phone_call'` |
| 9 | Retract a wrong note | It disappears from briefings; the fold-impact preview listed what else went |

Check 4 and 5 are the ones that matter most: they prove the confirmation doctrine is intact. Check 9
proves the firm has a real correction path, which is what makes append-only tolerable.

## 10. Phase 8 — Day-2 ops handoff

Before you close the onboarding, make sure someone owns these — all four have bitten us, and all four
fail *silently*:

- **DeepInfra balance runs out monthly.** Nothing alerts; failover to NVIDIA masks it. Check the
  balance first when the agent gets slow or dumb.
- **A sandbox can hold a badge the doorman no longer knows** ("badge not authorized" on every spine
  call while the roster looks fine). Fix: rotate-badge → pull → provider credential → **container**
  restart.
- **The 15-minute cron heartbeat** drives pairing, offboarding, cost rollup. A red cron is a silent
  outage of all four.
- **Tool-description changes need a gateway restart on the affected tier**; AGENTS.md or tool-name
  changes need a full wire pass. Deploying alone leaves the fleet stale.

Then schedule a **30-day check-in**. Every problem we have found in the pilot surfaced through use,
not through tests.

---

## 11. What we are *not* promising

Say this out loud during the sale, because the gap between "AI for trades" and this product is where
disappointment lives:

- **No invoicing, payments, pricing, or accounting.** Job status includes `quote` and `invoiced` as
  *labels*; no money moves through this system.
- **No customer-facing anything.** Customers never talk to the assistant. It is a staff tool.
- **No outbound calling, no AI receptionist, no phone-tree routing.** Inbound recording and capture
  only.
- **No web app.** Telegram is the entire interface, plus the dispatch board Mini App inside it.
- **No mobile app to install** — which is a feature, not a gap: the firm's staff already have
  Telegram.
