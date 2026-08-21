---
date: 2026-08-18
branch: docs/agent-first-front-door
commit: 6d49e3b
topic: Decoupling Telegram bot identity from sandbox count — router feasibility, reply path, and the outbound-hook question
---

## Summary

Today the product is wired so that **one person = one sandbox = one Telegram bot**. A "sandbox"
is a small isolated container on `trades-box-1` running OpenClaw (the agent runtime); each one
holds its own Telegram bot token and continuously asks Telegram "any new messages?"
(`getUpdates`, called *long polling*). That works, but it means every new seat we sell needs a
brand-new bot, and bots can only be created by hand through BotFather, capped **per Telegram
account**. That caps the whole product at roughly 20–40 seats — about 4–8 firms — before we're
juggling extra phone numbers and credential sets.

This document assesses replacing that with a **router**: one bot (or one bot per firm) owns the
Telegram identity, receives every message, and hands each turn to the right person's sandbox,
then sends the answer back out. The gating question was whether our **safety net still fires** on
that path. It does not, by default — and I proved that with a live probe rather than guessing.
The good news is that the fix is already in the codebase: `nudge-runner.sh` uses exactly the
delivery flag that keeps the safety net alive, and the openclaw Telegram channel supports
`apiRoot`, a documented setting that points a sandbox at a *self-hosted Bot API server* — which
is precisely what a router is. That turns the hardest-looking design into a mostly-solved one.

---

## Decision brief (read this first)

| Decision | Options | Recommendation |
|---|---|---|
| **Does the router capture the reply and post it itself?** | (a) Router captures text and posts → **guard goes silent**; (b) router injects with `--deliver` and lets openclaw send | **(b).** Proven by probe below. (a) silently disables the weekday guard. |
| **How does a sandbox send without owning a bot?** | (A) Bot-API shim: sandbox keeps a real telegram channel, `apiRoot` points at the router; (B) router re-runs the guard itself; (C) deliver via `qa-channel` synthetic bus; (D) shared token in every sandbox | **(A).** (D) is *actively broken* — see the `deleteWebhook` finding. |
| **Bot granularity** | shared / per-firm / per-seat (today) | **Per-firm**, with shared as the fallback. ~20 firms per account (≈100–200 seats) and a branded `@AcmePlumbingBot`. |
| **Do both models coexist during migration?** | yes / no | **Yes**, cleanly — the discriminator is per-sandbox config, and the pool already reuses tokens. |

---

## 1. The hook question — answered by probe

### Why it was the gate

`trades-weekday-guard` is an observe-only OpenClaw plugin that reads every outbound message and
flags fabricated weekday/date pairs ("Monday, August 16" when the 16th is a Sunday). Measured
rate: **23 real mismatches in 419 historical texts, 0 false positives**. It registers on two
*outbound hooks* — `message_sending` and `reply_payload_sending`
([Box_Setup_Stuff/plugins/trades-weekday-guard/index.js:318-331](Box_Setup_Stuff/plugins/trades-weekday-guard/index.js#L318-L331)).

Both hooks are documented as running *around channel delivery*:

> `message_sending` — "After model reply generation, before channel delivery" … "Rewrite outbound
> content or cancel delivery"
> `reply_payload_sending` — "After payload normalization, immediately before channel handoff"
> — <https://docs.openclaw.ai/plugins/hooks>

If a router captured the agent's text and posted to Telegram itself, there is no channel
delivery — so the hook might never run, and the guard would stop guarding **with no error, no log
line, and no alarm**. `docs/engineering-memory.md:2118` records this as explicitly unresolved,
citing upstream [openclaw#29203](https://github.com/openclaw/openclaw/issues/29203) ("internal
hooks not triggered in auto-reply path").

### The probe

Run on **s6**, the cold pool blank (`@ragisan2_bot`, allowlist `000000001`, claimed by nobody) —
chosen so no real person could be messaged. The guard writes **one line per scanned message,
flagged or not** ([index.js:368-374](Box_Setup_Stuff/plugins/trades-weekday-guard/index.js#L368-L374)),
so *absence of the log file* means the hook never ran — not "nothing to flag". That is what makes
this a clean two-arm test.

```
ARM B — the router path (capture text, we post it ourselves)
  nemoclaw s6 agent --agent main --session-id hookprobe-armB-{1,2} -m "<msg>"
  (no --deliver)

ARM A — control (openclaw does the delivery)
  nemoclaw s6 agent --agent main --session-id hookprobe-armA-1 -m "<msg>" \
      --deliver --reply-to 1        # chat id 1 = dead target, nobody is messaged
```

### Results

| Arm | Agent produced a real reply? | `weekday-guard.jsonl` |
|---|---|---|
| **B** (no `--deliver`), run 1 | yes — `"Your visit is confirmed for Monday, August 16, 2026."` | **file did not exist** |
| **B** (no `--deliver`), run 2 | yes — agent corrected the date instead | **file did not exist** |
| **A** (`--deliver --reply-to 1`) | yes — `"Hook probe alpha."` | **file created, 1 record** |

The arm-A record, verbatim:

```json
{"ts":"2026-08-18T07:16:47.565Z","v":"0.3.0","hook":"message_sending","sha":"34294c609476","chars":17,"flags":[]}
```

…followed by the expected `OutboundDeliveryError: Telegram send failed: chat not found
(chat_id=1)`. The hook fired **before** the send; the send then bounced. Nobody was messaged.

### Controls ruled out

1. **The guard was loaded.** Gateway startup line, `2026-08-12T21:46:49`:
   `http server listening (10 plugins: browser, canvas, device-pair, file-transfer, memory-core,
   nemoclaw, phone-control, talk-voice, telegram, trades-weekday-guard; 1.5s)`. Per
   `bootstrap-box.sh:1076`, that startup list is the only truth about whether a hook plugin is
   live.
2. **The turn ran on the gateway, not the embedded agent.** The reply text and
   `[agent] run 5b9ffd00-… ended with stopReason=stop` appear in
   `/sandbox/.openclaw/logs/gateway-persistent.log`, which is fed from the gateway's own stdout
   (pid 476 = `tail -n +1 -F /tmp/gateway.log`; the gateway is pid 999, uptime 5d, matching the
   08-12 restart). CLI stdout contained **no** `[agent/embedded]` line and **no** truncation
   warning — the two recorded embedded-agent tells.
3. **Not a dead turn.** Both arm-B runs produced real assistant text, and the model fetch
   returned `status=200` in the gateway log. A silent guard on a silent agent would prove
   nothing; these agents spoke.

### Verdict

> **The outbound plugin hooks are coupled to channel delivery, not to the agent run.**
> A router that captures `openclaw agent` stdout and posts to Telegram itself leaves the weekday
> guard **completely silent** — the exact silent safety regression that was feared.
>
> **A router that injects with `--deliver --reply-channel telegram --reply-to <chat_id>` keeps
> the guard alive.** This is not new machinery: `Box_Setup_Stuff/nudge-runner.sh:132-134`
> already does exactly this in production, and its header comment states the reason —
> *"`--deliver` runs on the GATEWAY and fires the outbound plugin hooks (weekday guard
> included)"*. The probe confirms that claim **and its converse**, which was the open half.

This closes the `docs/engineering-memory.md:2118` open question in the *restrictive* direction:
hooks do not fire on a non-delivering run.

### Two nuances worth carrying into the design

- **The CLI-deliver path fires a *different* hook than live Telegram traffic.** Arm A logged
  `hook: "message_sending"` (one line, no `dup`). s2's most recent real-traffic line
  (`2026-08-15T19:50:08Z`) logged `hook: "reply_payload_sending"` — because live replies are
  *streamed*, and streaming is what v0.2.0 added the second hook for. So a router on
  `--deliver` gets guard coverage, but through the non-streamed hook. Whether coverage is
  *equivalent* is an open question (§8).
- **The fleet runs guard v0.3.0, the repo has v0.4.0.** Verified on all six sandboxes
  (s2, s3, s5, s6, s7, s8) — every one reports `VERSION = '0.3.0'`. The v0.4.0 link guard is
  **not deployed**. This is pre-existing and independent of the router, but a router rollout
  touches every sandbox's config and is the natural moment to ship it.

---

## 2. A second probe finding that kills the obvious design

While confirming whether a sandbox could hold the *shared* bot token in send-only mode, I read
OpenClaw's own Telegram implementation inside the sandbox
(`/usr/local/lib/node_modules/openclaw/dist/monitor-polling.runtime-BY5lEF42.js`):

```js
async #ensureWebhookCleanup(bot) {
  if (this.#webhookCleared) return "ready";
  try {
    await withTelegramApiErrorLogging({
      operation: "deleteWebhook",
      runtime: this.opts.runtime,
      fn: () => bot.api.deleteWebhook({ drop_pending_updates: false })
    });
    this.#webhookCleared = true;
    return "ready";
  } catch (err) { … }
}
```

and, in the poll loop's error handler:

```js
const isConflict = pollState.errorCode === 409;
if (isConflict) { this.#webhookCleared = false; this.#transportState.markDirty(); }
```

**Reading:** before polling, the sandbox's Telegram channel calls `deleteWebhook` on its token.
On a `409 Conflict` it *resets the flag* so it will call `deleteWebhook` **again** next cycle.

**Consequence:** the tempting design — "router registers a webhook on the shared bot; the
sandboxes' pollers go inert because Telegram documents that `getUpdates` *'will not work if an
outgoing webhook is set up'* (<https://core.telegram.org/bots/api#getupdates>)" — is not merely
passive. Any sandbox configured with the shared token would **actively and repeatedly delete the
router's webhook**. That is an inbound-identity fight the router loses at random.

I also found **no send-only configuration**: no `sendOnly` / `ingressMode` / `pollingEnabled` key
in the bundle, and the vendor channel reference lists no receive-disabled mode
(<https://docs.openclaw.ai/gateway/config-channels>). A telegram channel is either enabled — and
therefore polling and deleting webhooks — or disabled, and then `--deliver --reply-channel
telegram` has nothing to deliver through.

**So: option (D) "just put the shared token in every sandbox" is closed.** Not by policy — by the
vendor's code.

---

## 3. How it works today

```
 Manager / technician phone
   │  Telegram DM to THEIR OWN bot (one bot per person)
   ▼
 trades-box-1 ── sandbox sN ── openclaw gateway
   │   telegram channel: botToken=<unique>, allowFrom=[<their tg user id>]
   │   polls getUpdates continuously
   │   plugins: … trades-weekday-guard  ◄── outbound hooks live HERE
   ▼
 doorman (host process) ── badge → identity ──► Render spine ──► pilot DB
```

Three loops keep this running, all of which a router must not break:

| Mechanism | File | What it does |
|---|---|---|
| **Cold pool + auto-claim** | `scripts/assign-host.mjs:88-131`, `src/mcp/server.ts:4689-4790` | `bind_telegram` claims the next free cold sandbox with **no operator step**, and returns `botUsername` so the manager can tell the hire which bot to open. |
| **Binding apply** | `Box_Setup_Stuff/badge-pull.sh` (bindings section) → `apply-binding.sh` | Every 5 min, reconciles `{sandboxRef, telegramUserId}` into **two** places: `sandboxes.json` (source of truth) and the sandbox's rendered `openclaw.json` `channels.telegram.accounts.*.allowFrom`, then restarts the gateway and verifies. |
| **Recycler** | `Box_Setup_Stuff/recycle-sandbox.sh` | Destroys a retired sandbox and rebuilds a cold blank **reusing the retired bot token**, journal-first. Confirmed live in the pilot DB: `s1→s6` both `@ragisan2_bot`; `s4→s5` both `@ragisan03_bot`. |

**Provisioning asserts the bot is real and polling.** `bootstrap-box.sh phase_provision`
(`:221-305`) has five hard gates: `getMe` valid → provider created **and** attached → token
present in the openclaw process env → **`getUpdates` seen in container logs within 180s** →
inference route re-asserted. Two of these (`getMe`, `getUpdates`) are bot-identity assertions
that change meaning under a router.

**Current scale (pilot DB, read-only query, 2026-08-18):** 4 tenants · 26 active people · 23
active seats · **6 sandboxes** · 5 Telegram bindings · 2 hosts. `sandbox_pool` holds 4 rows
(s1 retired, s4 retired, s5 claimed by `ben-shelton`, s6 free); s2/s3/s7/s8 are pre-pool legacy
sandboxes with no pool row. **So we sell 23 seats today but only 6 bots exist** — the ceiling
has not bitten yet, but it is 6/20 of the way there and every new hire consumes one.

**Precedent for a shared bot already exists.** `@DashboardMan_bot` is one global, plain-code
(non-AI) bot on Render serving the board Mini App to **all** tenants
(`src/telegram/boardBot.ts`). Tenant isolation comes from the roster lookup of the verified
Telegram user id, **not** from the bot identity. That is exactly the trust model a router needs,
already shipped and in production.

---

## 4. Router design options

All four share the same inbound half. They differ only in the **reply path**, and therefore in
**where the guard runs** — which the probe makes the deciding axis.

```
Telegram ──► ONE bot (webhook) ──► ROUTER ──► resolve telegram_user_id → sandbox_ref
                                      │
                                      └──► inject turn into that sandbox's agent
                                                   │
                                              ??? reply path ???
```

### Option A — Bot-API shim (`apiRoot`)  ★ recommended

The router presents a **Telegram-Bot-API-shaped endpoint** on the host. Each sandbox keeps a
genuine, unmodified telegram channel — but pointed at the router instead of at Telegram:

```jsonc
channels.telegram.accounts.default = {
  botToken: "<virtual per-sandbox token>",
  apiRoot:  "http://host.openshell.internal:PORT",   // the router
  allowFrom: ["<their telegram user id>"]
}
```

`apiRoot` is **first-class and schema-validated** in this exact build — present in
`dist/extensions/telegram/openclaw.plugin.json` as `{"type":"string","format":"uri"}`, at both
top level and per-account, alongside `trustedLocalFileRoots` ("Trusted local filesystem roots for
**self-hosted Telegram Bot API** absolute file_path"). It is the vendor's supported way to run
against a self-hosted Bot API server. A router *is* a self-hosted Bot API server with one extra
job: multiplexing.

```
Telegram ──webhook──► ROUTER ──► per-sandbox update queue
                        ▲                    │  getUpdates (sandbox polls the ROUTER)
                        │                    ▼
                        │            sandbox openclaw ── telegram channel (real!)
                        │                    │   message_sending / reply_payload_sending → GUARD ✔
                        └── sendMessage ─────┘
                            (router rewrites onto the ONE real token + real chat_id)
```

- **Who posts to Telegram:** the router, but only as the last hop of a normal `sendMessage` the
  sandbox itself issued.
- **Where the guard runs:** unchanged, in the sandbox, on the real channel path — including
  `reply_payload_sending` for streamed replies.
- **`deleteWebhook` problem:** gone. The sandbox deletes a webhook on the *shim*, which is a no-op
  the router simply absorbs.
- **409 problem:** gone. Each sandbox polls its own queue on the shim, not Telegram.
- **What else keeps working for free:** `apply-binding.sh` (allowFrom is still meaningful),
  `--deliver` from the nudge runner, board deep links, streaming, media.
- **Cost:** the router must implement enough of the Bot API to satisfy openclaw — realistically
  `getMe`, `getUpdates`, `deleteWebhook`, `sendMessage`, `sendChatAction`, `editMessageText`,
  `setMyCommands`, plus media passthrough. **This is the main build risk**: the surface is not
  huge but it is not one endpoint either, and openclaw's Telegram client version pins what it
  expects.

### Option B — Router captures text, and re-runs the guard itself

Router calls `openclaw agent` (no `--deliver`), takes the returned text, runs the guard's
`scanMessage` **in the router**, then posts via the shared bot.

- **Where the guard runs:** in the router, as a copy.
- **Honest problem:** two copies of a safety detector drift. The repo already has the exact
  failure mode on record — the fleet is on v0.3.0 while the repo is on v0.4.0. Adding a second
  home for the same logic doubles that surface.
- **Loses:** `reply_payload_sending` coverage entirely, plus anything else the channel path does
  (streaming chunk boundaries, payload normalization).
- **Gains:** simplest to build; no Bot API emulation at all.

### Option C — Deliver via `qa-channel`, router relays

The sandbox delivers through OpenClaw's bundled **synthetic transport**, documented as existing
"to exercise the same channel plugin boundary used by real transports while keeping state
deterministic and fully inspectable" (<https://docs.openclaw.ai/channels/qa-channel>). Router
reads the outbound transcript over its HTTP bus and posts to Telegram.

- **Where the guard runs:** in the sandbox, unmodified — the whole point of the channel-plugin
  boundary.
- **Blocker:** the vendor says plainly *"It is not a production channel."* Building the customer
  reply path on a QA transport is a support liability, and its config surface (`baseUrl`,
  `botUserId`, `allowFrom`, `pollTimeoutMs`) is small enough that a semantic change upstream
  would be silent.
- **Useful as:** a cheap way to *prototype* the router's dispatch half before committing to
  Option A's Bot API surface.

### Option D — Shared token in every sandbox — **closed**

Killed by §2: the sandbox's ingress calls `deleteWebhook` and re-arms on 409. Recording it here
so it is not re-proposed.

### Comparison

| | A — Bot-API shim | B — router runs guard | C — qa-channel | D — shared token |
|---|---|---|---|---|
| Guard fires | ✅ in-sandbox, both hooks | ⚠️ copy, one hook | ✅ in-sandbox | n/a |
| Sandbox code changes | none | none | none | none |
| Router build size | **large** (Bot API subset) | small | medium | — |
| Breaks `apply-binding.sh` | no | no | yes (no telegram channel) | — |
| Vendor-supported | yes (`apiRoot`) | yes | "not a production channel" | **no** |
| Verdict | **recommend** | fallback | prototype only | closed |

---

## 5. What changes in provisioning

A sandbox with no Telegram identity of its own changes four things.

**`phase_provision` (`bootstrap-box.sh:221`).** Its five assertions are the safety rail that keeps
a "silently deaf bot" from reaching production; they must be *replaced*, not dropped:

| Assertion today | Under a router (Option A) |
|---|---|
| `getMe` against `api.telegram.org` with the real token | `getMe` against the **router's** `apiRoot` with the virtual token |
| provider `<agent>-telegram-bridge` created + attached | unchanged (still how credentials reach the process) |
| `TELEGRAM_BOT_TOKEN` in the openclaw process env | unchanged — the value is now a virtual token |
| **`getUpdates` seen in container logs within 180s** | unchanged in *shape*, but proves the sandbox is talking to the **router** — arguably a stronger assertion, since it exercises the new hop |
| inference route re-asserted | unchanged |

Plus one new assertion worth adding: **an end-to-end `sendMessage` through the shim reaches
Telegram**, since that is the hop the old design never had.

**The messaging plan (`recycle-sandbox.sh:hydrate_plan`).** The hydrated plan's telegram inputs
are `allowedIds`, `botToken`, `groupPolicy`. `apiRoot` would need to join them — and it must be
carried by the vendor's own `hydrateDerivedSandboxMessagingPlanFields`, since a hand-written plan
fails the strict validator (recorded in that function's comment). **Open question:** whether the
plan schema accepts `apiRoot` as an input id, or whether it has to be patched into
`openclaw.json` post-build the way `apply-binding.sh` patches `allowFrom`.

**The cold pool.** This gets *simpler*, and it is the biggest operational win:

- `sandbox_pool.bot_username` stops being a per-sandbox fact. Under a shared/per-firm bot the
  handle is a **tenant** fact.
- `bind_telegram`'s "no bot handle on record — ask your operator" dead-end
  (`src/mcp/server.ts:4770-4787`) disappears: the handle is always known.
- Provisioning a blank no longer needs a human at BotFather **at all**. Today the recycler can
  only ever recycle *existing* tokens; it can never grow the pool. Under a router, growing the
  pool is pure automation.

**The recycler (`recycle-sandbox.sh`).** Most of its complexity exists to protect one thing: *the
bot token is destroyed with the sandbox, so journal it first.* Under a router that entire concern
evaporates — the token is virtual and regenerable. Concretely:
`park_entry "no bot token recoverable from sandboxes.json"` and
`park_entry "bot token is DEAD at Telegram (bot deleted at BotFather?)"` become unreachable, and
the `getMe` liveness check retargets at the shim. The journal-first discipline should stay (it
also protects `newRef`), but the scariest failure mode goes away.

---

## 6. Migration path

**Yes — both models can run side by side, cleanly.** The discriminator is per-sandbox config
(`apiRoot` set or not), and nothing in the server-side control plane needs to know which world a
sandbox lives in.

```
 Stage 0   router built + shim proven against ONE scratch sandbox (s6, the cold blank)
              │  no live person involved; s6 is claimed by nobody
              ▼
 Stage 1   NEW hires only: cold blanks provisioned with apiRoot → router
              │  existing s2/s3/s5/s7/s8 keep their own bots, untouched
              ▼
 Stage 2   migrate a willing existing seat (s5 / ben-shelton — already an internal test seat)
              │  its old bot token is freed and returns to the BotFather budget
              ▼
 Stage 3   migrate the remaining legacy sandboxes; retire the per-seat bots
```

Why coexistence is safe:

- **The pool already mixes generations.** `s2/s3/s7/s8` have no `sandbox_pool` row at all today
  and the system copes; a mixed `apiRoot`/no-`apiRoot` pool is a milder version of the same.
- **`apply-binding.sh` is agnostic.** It writes `allowFrom` into whichever telegram account
  exists, and verifies via `channels status`. Both worlds have a telegram account.
- **`bind_telegram` is agnostic.** It returns `pool.bot_username`; under a router that column just
  holds the shared/firm handle instead of a unique one.
- **The recycler is agnostic** as long as `hydrate_plan` emits the right shape per sandbox.

**The one-way door:** migrating a seat changes the handle the person opens in Telegram. They must
`/start` the new bot — bots cannot message first (`src/mcp/server.ts:703-714`). So Stage 2/3 each
need a human on the other end, and the old bot should keep answering until they have. Budget one
short conversation per migrated seat, not a silent cutover.

---

## 7. Bot granularity — recommendation

| Model | Ceiling | Branding | Blast radius |
|---|---|---|---|
| **Per-seat (today)** | 20 bots/account, 40 with Premium → **~4–8 firms** | none (`@ragisan2_bot`) | one seat |
| **Shared (one bot, all firms)** | unlimited seats | one generic handle for everybody | **all tenants** — one token, one webhook, one rate budget |
| **Per-firm** ★ | 20 firms/account, 40 with Premium → **~100–200 seats** at 5 seats/firm | `@AcmePlumbingBot` — a real asset | one firm |

**Recommend per-firm.** It buys a 20× ceiling increase over today for the same manual BotFather
step we already perform — except now that step happens **once per firm at signing**, not once per
hire. It preserves per-tenant blast radius (a token leak or a rate-limit incident is contained to
one customer), and it gives the firm's staff a branded handle, which matters for a product whose
entire UI is a Telegram chat.

Two supporting facts:

- **Display name is programmable even on a generic handle.** `setMyName`, `setMyDescription` and
  `setMyShortDescription` are callable with just the bot token and all accept `language_code`
  (given as verified; note these were **not** present in the Bot API page excerpt I retrieved, so
  re-confirm at build time — see §8). So even the shared-bot fallback can render a per-firm
  display name set programmatically at claim time.
- **Rate limits are not the constraint.** ~30 messages/sec overall and 1/sec per chat, per bot.
  At per-firm granularity each bot serves one firm's handful of seats.

**When to take the shared fallback instead:** if the Bot-API shim (Option A) proves too large to
build, Option B + a single shared bot is the cheapest thing that works — accept the guard-copy
drift risk and the cross-tenant blast radius, and revisit.

---

## 8. Cost estimate and sequencing

Rough engineering days, assuming Option A and per-firm bots. These are estimates, not measured.

| # | Work | Est. | Gate before proceeding |
|---|---|---|---|
| 1 | **Shim spike**: minimal Bot API server (`getMe`, `getUpdates`, `deleteWebhook`, `sendMessage`) pointed at s6 via `apiRoot`; prove a full turn round-trips **and `weekday-guard.jsonl` moves** | 2–3 d | guard log gets a `reply_payload_sending` line on a streamed reply |
| 2 | **Inbound half**: webhook receiver, `telegram_user_id → sandbox_ref` resolution (reuse the roster lookup `@DashboardMan_bot` already uses), per-sandbox update queue | 2–3 d | a real message from a phone reaches s6's agent |
| 3 | **Media + edits + commands**: whatever step 1 revealed openclaw actually calls | 2–4 d | photo in, photo out |
| 4 | **Provisioning changes**: `phase_provision` assertions, `hydrate_plan` `apiRoot`, new `sendMessage` gate | 2 d | a cold blank builds green, unattended |
| 5 | **Recycler simplification** + pool/handle model (`bot_username` → tenant fact) | 1–2 d | full recycle completes with no BotFather step |
| 6 | **Migration** of 5 existing seats, one at a time, each with a `/start` conversation | 1–2 d | each person answers on the new handle |
| 7 | **Ship guard v0.4.0** while every sandbox config is being touched anyway | 0.5 d | startup line + a flagged link in the log |
| | **Total** | **~11–17 days** | |

**Sequencing rule:** step 1 is a genuine go/no-go. If openclaw's Telegram client turns out to
call a wide or version-fragile slice of the Bot API, stop and fall back to Option B + shared bot
(~4–6 days total, with the guard-copy tradeoff accepted).

**What stays manual regardless:**

- **Host creation** — standing up a new `trades-box-1`-class VM and running `bootstrap-box.sh
  prep/nemoclaw/bakein/doorman/badgepull/recycler`, plus the one interactive `nemoclaw onboard`.
- **Tenant row + first manager roster row** — operator SQL. The runbook is explicit that this is
  a deliberate pilot-stage choice: *"There is no signup page, no admin UI for creating a firm."*
- **BotFather** — one bot per firm at signing. There is no API to create a bot, and the cap is
  per **account**, so scripting it does not help. Per-firm granularity makes this a
  once-per-customer step instead of once-per-hire, which is the actual win.
- **Gmail consent, phone number port/forward, contracts** — all third-party human steps.

---

## 9. Open questions

1. **Does the `--deliver` path's `message_sending`-only coverage equal live traffic's
   `reply_payload_sending` coverage?** The probe showed the CLI-deliver path fires
   `message_sending`, while s2's real streamed traffic fires `reply_payload_sending`. Under
   Option A this is moot (the sandbox streams to the shim exactly as it streams to Telegram), but
   under Option B it is a real coverage gap. *Settle by:* running the Option A spike and checking
   which hook name appears.
2. **How much of the Bot API does openclaw's Telegram client actually call?** This is the single
   biggest cost driver and it is answerable in an afternoon — point `apiRoot` at a logging
   catch-all and read what it asks for.
3. **Can `apiRoot` be carried by the vendor's messaging-plan hydration, or must it be patched
   post-build?** `hydrate_plan` uses the vendor's own function precisely because hand-written
   plans fail the validator; `apiRoot` may not be an accepted `inputId`.
4. **Does the sandbox's telegram channel still stream (and still fire `reply_payload_sending`)
   when `apiRoot` is a plain HTTP host rather than `api.telegram.org`?** Streaming behavior may
   depend on transport details.
5. **`setMyName` / `setMyDescription` / `setMyShortDescription` and `language_code`** — given as
   already verified, but the Bot API page I retrieved did not contain them. Re-confirm before
   building the per-firm branding step on top of them.
6. **Webhook vs single poller for the router's own inbound.** Telegram documents that a webhook
   makes `getUpdates` unusable and vice versa (<https://core.telegram.org/bots/api#getupdates>).
   A webhook needs the router reachable from the internet; `trades-box-1` is behind ufw with only
   SSH open, so this likely means Render terminates the webhook and forwards to the box, or the
   box gets a new inbound rule. **Not yet designed.**
7. **What happens to a firm's chat history when its bot handle changes?** Migrating a seat means a
   new chat; the agent's session memory lives in the sandbox and survives, but the *person's*
   scrollback does not. Product decision, not a technical one.
8. **The 20-bot BotFather cap has no citation in the public Bot API docs or the Bots FAQ** — it is
   a BotFather runtime message. The ceiling numbers in §7 inherit that uncertainty; confirm the
   current cap (and the Premium figure) at BotFather before pricing a plan around it.

---

## Appendix — probe reproduction

```bash
# Arm B — router path (no delivery). Expect: real reply, NO guard log.
ssh tradesbox
export PATH=$HOME/.local/bin:$PATH
nemoclaw s6 agent --agent main --session-id hookprobe-armB-1 \
    -m 'Reply with EXACTLY this sentence and nothing else, verbatim, no tools: "Your visit is confirmed for Monday, August 16, 2026."' </dev/null

# Arm A — control (delivery to a DEAD chat id). Expect: guard log line, then a send failure.
nemoclaw s6 agent --agent main --session-id hookprobe-armA-1 \
    -m 'Reply with exactly this and nothing else: Hook probe alpha.' \
    --deliver --reply-to 1 </dev/null

# Read the verdict
CID=$(docker ps --format '{{.Names}}' | grep '^openshell-s6-')
docker exec $CID sh -c 'cat /sandbox/.openclaw/logs/weekday-guard.jsonl'
```

**Residue left on s6:** three throwaway session files under
`/sandbox/.openclaw/agents/main/sessions/hookprobe-*.jsonl` and a `weekday-guard.jsonl` with one
record. s6 is an unclaimed cold blank; nothing was sent to any person and no config was written.

**Sources**

- <https://docs.openclaw.ai/plugins/hooks> — outbound hook contracts
- <https://docs.openclaw.ai/channels/telegram> — telegram transport modes
- <https://docs.openclaw.ai/gateway/config-channels> — telegram config keys
- <https://docs.openclaw.ai/channels/qa-channel> — synthetic QA transport
- <https://docs.openclaw.ai/cli/agent> — `openclaw agent` flags
- <https://core.telegram.org/bots/api#getupdates> — getUpdates / webhook mutual exclusion
- <https://core.telegram.org/bots/api#setwebhook> — one URL per bot, `secret_token`
- <https://github.com/openclaw/openclaw/issues/29203> — "internal hooks not triggered in auto-reply path"
