---
date: 2026-09-09
task: Merge the global board bot into each person's own assistant bot — one bot per person, opened as a Main Mini App, with launches verified by Telegram's Ed25519 signature so no bot token ever reaches Render
research: none (design worked out in conversation 2026-09-09; vendor facts fetched from core.telegram.org/bots/webapps that day)
status: phase 1 implemented (uncommitted) — verification, allowlist and operator wiring done; notifications and cutover not started
supersedes: nothing (the console plan's "reachability" phase assumed the global board bot)
---

## Overview
A person on the pilot deals with TWO bots today: their own assistant, which they chat with, and
`@DashboardMan_bot`, which exists only to hold the Mini App's launch button and push notifications.
The second bot is not a product decision. It is a consequence of how Telegram signs a Mini App
launch: the slip (`initData`) is stamped with an HMAC keyed by the **token of the bot that opened
the app**, so a server can only check launches from bots whose tokens it holds — and Render holds
exactly one.

The user's objection (2026-09-09): *"the whole bot is for opening the UI, chatting to it does
nothing, there are two bots a user needs to know — bad UX. Can we merge into one?"*

Yes, and the lever is Telegram's second stamp. Bot API 7.10 added `signature`, an Ed25519 signature
over the same fields, made with **Telegram's** private key and checkable with its **public** key
plus the bot's **numeric id**. Neither is a secret. So the console can accept launches from every
person's own assistant bot while their tokens stay on the box, where the badge design already keeps
secrets.

## Decisions

- **Verify the SIGNATURE, not the hash** *(the whole merge hangs on this)*. `verifyInitDataSigned`
  in `src/telegram/initData.ts` implements Telegram's "Validating data for Third-Party Use": the
  data-check-string is `<bot_id>:WebAppData` + line feed + the sorted fields (hash and signature
  excluded), verified with a pinned Ed25519 public key. The HMAC path (`verifyInitData`) is
  untouched and stays as the fallback for the board bot, the one token this process does hold.
  `verifySlip` in `boardApi.ts` prefers the signature and falls back, so both doors work during the
  changeover and the console inherits it (it imports `authBoard`, it does not reimplement it).

- **The bot id is the allowlist, and it must exist.** A signature alone proves only that *Telegram*
  issued the slip — anyone can point their own bot's Mini App at our URL and get a genuine one. The
  bot id is NOT carried in initData; the verifier supplies it, so verification is always "signed for
  *this* bot". `botIds.allowed()` (`src/telegram/botIds.ts`) is the set we check against: every live
  seat's `sandbox_pool.bot_id`, plus the board bot's id derived from the token we already hold.
  **The attack this closes**: a lookalike Mini App gets a real roster member to tap it once, harvests
  a Telegram-signed slip carrying that person's identity, and replays it. Covered by a test named for
  it in `boardApi.test.ts`.

- **An id list is as strong as a token list here** *(why we do not check per-person)*. Every bot in
  the allowlist was created by the operator and its token never leaves the box; no user of ours owns
  one. So "signed for one of our bots" and "signed for this person's bot" are the same statement,
  and the cheaper one needs no DB read before the signature is checked. Auth order is unchanged:
  stamp first, roster second.

- **A slip is never authorisation.** The roster lookup after verification still decides tenant, role
  and liveness. A leaver's slip verifies perfectly and is refused, which matters more after the merge
  because bots are recycled to new hires (the pool invariant). Tested.

- **`bot_id` on `sandbox_pool`, not a new table** (migration `20260909120000`). It is the twin of
  `bot_username`, captured the same way at provisioning, on the box, from `getMe`. Nullable, so a
  seat that has not been wired simply is not a door; digits-only CHECK so a pasted token cannot
  become an allowlist entry. Retired seats are excluded from the allowlist — a recycled sandbox's bot
  must not keep admitting its previous holder.

- **No bot token moves to Render, ever.** This is the point of the exercise, not a nicety: the box
  design keeps a revocable badge in each sandbox and no real secrets. Copying every assistant's token
  to Render to check HMACs would make one Render breach equal every assistant's identity. Two
  consequences: the operator command that wires a bot runs where the token is, and notifications
  (phase 2) must be sent from the box rather than from Render.

- **Wiring a bot is one operator command, and the token comes from the environment.**
  `scripts/assign-host.mjs wire-bot host=<h> sandbox=<s>` reads `SANDBOX_BOT_TOKEN`, calls `getMe`
  (which also proves the token is live), stores the numeric id, and points that bot's menu button at
  `/console`. Never from argv: argv lands in shell history and process listings. It refuses when the
  handle from `getMe` disagrees with the pool row's `bot_username`, which is the dangerous typo —
  wiring seat A with seat B's token would send A's launches to be verified against B's bot forever.

- **The public key is pinned, with a narrow override.** Constants for production and Telegram's test
  environment, read via `configuredPublicKeyHex()`; `TELEGRAM_INITDATA_PUBLIC_KEY` overrides only if
  it is 32 bytes of hex, so a truncated value falls back to production rather than to nothing. Pinned
  rather than fetched: a key that changed without us noticing must fail closed.

- **Allowlist caching fails safe.** 5-minute TTL, one refresh in flight, a 5-second backoff on error,
  and the last good list keeps serving a DB outage. With nothing ever loaded, only the board bot is
  allowed — which is exactly today's behaviour. Nothing here can return "allow everything".

- **"Open App" is a BotFather setting, not an API call.** Configuring the Main Mini App per bot is
  the one un-automatable step (the same class as creating the bots themselves). `wire-bot` prints the
  exact instruction after it finishes. The menu button it does set is the fallback for anyone who has
  not been configured yet.

## Phase 1 — the door (implemented, uncommitted)
- [x] `verifyInitDataSigned` + `TELEGRAM_PUBLIC_KEYS` + `configuredPublicKeyHex` + `botIdFromToken`,
      with `readClaims` factored out so both schemes share the staleness/user parsing —
      `src/telegram/initData.ts`.
- [x] Migration `20260909120000_sandbox_pool_bot_id.sql`: column, digits-only CHECK, partial index.
      Applied to the LOCAL stack only. The hosted pilot DB is untouched.
- [x] `registerSandbox` takes `botId`; `setSandboxBotId` (backfill/repair, refuses a token);
      `listLiveBotIds` (cross-tenant, retired excluded) — `src/db/sandboxPool.ts`.
- [x] `src/telegram/botIds.ts` — the cached allowlist, board bot always included.
- [x] `verifySlip` in `src/telegram/boardApi.ts` — signature preferred, HMAC fallback. The console
      gets it for free through `authBoard`.
- [x] `wire-bot` in `scripts/assign-host.mjs`.
- [x] Tests: 11 unit (`initData.test.ts`, including the phishing case, tampering, wrong key, junk
      allowlist, staleness) and 7 integration (`boardApi.test.ts`: own-bot accepted, stranger's bot
      refused, board bot with no pool row, old HMAC slip still works, unknown account refused,
      retired seat stops being a door, token-pasted-as-id refused).

## Phase 1b — the seat wires itself (implemented 2026-09-15)
The manual `wire-bot` step does not survive contact with a fleet: it needs an operator holding each
bot's token, once per bot, forever. Worse, it was not even reachable for the seats that already
existed — provisioning read the token from whatever path the operator passed and kept nothing, so
five of six seats had no recoverable token at all. An attempt to read one back from the running
container found a 61-character version-scoped placeholder, exactly as `bootstrap-box.sh`'s own
comments describe, and `getMe` rejected it.

Three changes, all on the seam the box already polls:

- **Provisioning keeps the token findable.** `/root/seats/<ref>.env`, `0600`, written at the end of
  `phase_provision` with the handle and numeric id parsed from the `getMe` preflight it already ran.
  The token has to be on that box to run the bridge; this only makes it findable by a root process.
  Per-box, never central — a compromise costs one box's tenants rather than the fleet.
- **The server states the button, the box applies it.** `menuButton` rides the badge pull (`text`
  and `url`, or null when `BOARD_PUBLIC_URL` is unset — say nothing rather than point the fleet at a
  guess). Only a bot's own token can set its button, so the server can only state intent. Sent every
  pull, applied only when it differs from what the box last applied, so renaming the label or moving
  the console reaches every bot on the next tick instead of one SSH session per seat.
- **The box reports the ids.** `POST /control/seat-bots`, same host-token gate as every other control
  route. It **never creates a pool row** — an auto-created row is COLD and `bind_telegram` hands cold
  rows to the next hire, which would put two people on one agent. Unknown seats come back as
  `skipped` so the operator can see where the rack and the box disagree. A handle that disagrees with
  the row is refused per seat, the same cross-check `wire-bot` makes and for the same reason. Writes
  only what differs, so a five-minute tick is not a write storm and a lost tick self-heals.

`Box_Setup_Stuff/seat-sync.sh` is the box half. Run against the live (pre-deploy) server it correctly
reported `HTTP 401 — the server has no /control/seat-bots route yet`: the pull authenticates with the
same token, so a refusal there is diagnostic rather than mysterious. Note the symptom is 401 and not
404 — an unknown path falls through to the MCP handler, which refuses it for having no gateway
identity.

Still manual after this, and unavoidably: creating the bot in BotFather, racking the seat
(`add-sandbox`, deliberately), and BotFather's "Configure Mini App" for the top-of-chat Open App
button, which has no API.

## Phase 2 — notifications (implemented 2026-09-16)
The last thing keeping `@DashboardMan_bot` alive: schedule pushes and inbound-call alerts were sent
from Render with `BOARD_BOT_TOKEN`, the one bot token it holds. Wire every seat perfectly and those
still stop the moment that bot dies.

The transport already existed. `nudge-runner.sh` texts a person verbatim through their own seat bot
with `openclaw message send` in-container — no token handling, and the weekday guard's
`message_sending` hook still fires on that path. So phase 2 is a queue and a third leg, not a new
transport.

- **A table of its own, not `office_messages`.** Its chat leg does exactly this transport and reusing
  it was the first instinct. But every row there is written by the planner or the office tool,
  carries a roster ref as its sender, and is read back by the planner as its own outbound record. A
  schedule push has no sender and is none of the planner's business; filing it there would
  contaminate what the planner reasons about. `nudgeQueue`'s own comment — the runner "never asks
  what table an id came from" — makes a separate table with its own leg the intended shape.
  Migration `20260916100000`, `person_pushes`.
- **The push leg inherits the whole delivery doctrine**: served on a host-token pull until the box
  acks so a lost tick self-heals; `serve_count` and `attempts` as two freeze ledgers, where a row
  past either cap is FROZEN rather than failed (an undeliverable message is an operator condition,
  not a decision anybody made); liveness re-checked at serve time, so someone who went inactive
  between queue and serve is SKIPPED, not failed. The ack routes by id across all three legs,
  because the box posts `{id, outcome}` and never says which table it came from.
- **The tick drops from five minutes to one.** Schedule pushes tolerate five; an inbound-call alert
  does not, and those were instant before. Affordable here and nowhere else: this is ONE
  authenticated pull that usually returns an empty list, where `seat-sync` does a Telegram `getMe`
  per seat. Cheap poll, expensive poll, different cadences.
- **Ops alerts stay where they are.** `opsNotify` goes to the operator, not a roster member, so it
  has no seat bot to send through. It should end up on a dedicated ops bot rather than the board bot,
  which is a smaller job than this one and not on its critical path.

What the person sees changes in one way worth naming: their day changing and their assistant speaking
now arrive in the same chat. That was the point of the merge, and it is also the first time the two
voices share a window — watch whether they read as one thing or two.

## Phase 3 — cutover (DONE 2026-09-17)

`@DashboardMan_bot` is retired: it sends nothing, backs nothing, holds no door, and its token is
gone from Render. What it took, in the order it had to happen:

1. **Ops alerts left it** (2026-09-16/17). They were the last Render-side send. First attempt gave
   them a bot of their own, which answered the wrong question — the goal is one bot per PERSON, not
   a bot per purpose — so that was reverted and they became `person_pushes` rows with `kind='ops'`,
   delivered by the box through the operator's own assistant. The blind spot this creates (an alert
   about a dead box cannot travel through that box) is covered by the healthchecks.io dead-man
   switch already pinging every 5 minutes from `ubuntu`'s crontab, which fires on the ABSENCE of
   pings. No transport a box controls can report its own death.
2. **Every seat got its bot id** (2026-09-17), which is what the HMAC fallback was waiting on.
3. **The HMAC fallback went** from `verifySlip`. It had stopped being a fallback and become a
   liability: it swallowed EVERY signature-path refusal, staleness included, so a slip carrying a
   valid board-bot hash could reach a 24h replay window the signature path had already rejected.
4. **The worker stopped touching the menu button.** This was the real blocker and it was never the
   surface: `setBoardMenuButton()` was `startBoardWorker`'s first statement, unguarded, and the
   entry point exits 1 on a rejection — so deleting the bot would have crashed the notifier at
   startup and stopped schedule pushes entirely. Three lines.
5. `BOARD_BOT_TOKEN` removed from both services; worker verified still beating afterwards
   (`cycles: 3`, `ok`), a signed launch verified opening the console with a pool-only allowlist.

**`boardBot.ts` is deleted** — with the menu calls gone it had no production caller at all, and
`sendBoardMessage` had lost its last one to the ops-alert move. `CONSOLE_MENU_CHAT_IDS` and
`setConsoleMenuButtonFor` went with it, as this section predicted they would.

**Two corrections this phase owes the record, because both cost real time:**

- **"Technicians keep the board until the console has a technician view"** (see Open questions) was
  stale for weeks. `consoleApi` already serves a technician their own stops, clamped at the
  visibility horizon, no roster, no tray — *"a correct small thing rather than a broken big one"*.
  Phase 3 was described as blocked on building that. It was not.
- **The five seat tokens were never only in BotFather.** See the correction under "Where a seat's
  token lives" — the gateway holds them because it must poll Telegram with them.

Both were beliefs carried forward without re-checking whether they were still true, and both made
this work look far larger than it was.

## Phase 4 — what one-bot-per-person still owes (CLOSED 2026-09-18)

Everything below was written before anyone looked. Looking changed two of the three findings from
defects into expected states, and changed the fix for the third into its opposite. Kept verbatim
underneath, because the wrong reading is the useful part.

**Settled:**

- **Judy Chen is real**, and was unreachable for two months while the box knew exactly who she was.
  Her bot's dispatch ledger holds 16 messages from Telegram id `8991633730` (newest 2026-07-11);
  her roster row held `NULL`. Receiving a message and RECORDING who sent it are separate steps here,
  and only the first is automatic — so a bot can answer someone all summer and still be unable to
  start a conversation with them. Bound; she stays in her own tenant by the owner's decision (which
  has 0 jobs, so she is reachable without yet having anything to receive).
- **s6 is the spine-eval tier-3 rig**, not an eval fixture squatting on real capacity.
  `run-gateway.mjs` defaults to `sandbox=s6`, driving it as `manager-sam @ spine-eval-main`. The
  roster row was correct; the POOL row said "free" about a seat in daily use, so `bind_telegram`
  would have given s6 and `@ragisan2_bot` to the next hire. Claimed for the rig, not cleared — the
  fix named below would have broken the harness.
- **The shared Telegram id is a teammate's phone** driving the bots they stood up for feature work.
  Expected, and now reported as such. The one real cost stands:
  `findRosterByTelegramUserIdGlobal` refuses an ambiguous id, so ops alerts cannot reach it.

**Two operator gaps this exposed, both closed** (`scripts/assign-host.mjs`): no operator-side way to
write `telegram_user_id` existed at all, and `add-sandbox`'s `tech=` backfill fires only when a pool
row is CREATED — re-running it on an existing row reports "nothing to do" and leaves the seat
claimable. `bind-telegram` and `claim-sandbox` fill both. `roster-health` now compares the roster
against `sandbox_pool.technician_id` instead of matching tenant NAMES against /eval|test/, a
heuristic whose only two hits were both wrong.

`scripts/roster-health.mjs`: **No problems found**, exit 0.

### The original (wrong) reading, kept on purpose


The merge is structurally complete; what remains is roster DATA, not code.

- **Coverage is 4 of 31 roster rows.** The push leg serves a row only when the addressee is active
  AND has `sandbox_ref` AND has `telegram_user_id` (`nudgeQueue`, push leg). Misses are skipped
  silently — "frozen, not failed" — so a person with a seat and no binding simply never hears
  anything, with nothing logged.
- **s3 (`judy-testing`) has a seat and no Telegram binding**; **s6 is claimed by nobody**.
- **Sam and Ben share Telegram id `5801703167`** on two live rows. A schedule change touching both
  sends that phone two messages from two different bots. `findRosterByTelegramUserIdGlobal` already
  refuses this ambiguity — which is why ops alerts cannot be addressed to that id — but the push
  path addresses by `technician_id` and so does not notice.
- **Duplicate roster refs across tenants** (`manager-sam`, `judy-testing`, `tech-jane` each appear
  twice) make `tech=<ref>` ambiguous for `add-sandbox` without an explicit `tenant=`.

### Findings recorded while phase 3 was open

**Found on first contact (2026-09-09): the seats people actually use have no pool rows.**
`sandbox_pool` on the pilot holds four rows, all cold spares (s1/s4 retired, s5/s6 live) — while the
occupied seats s2 (Sam), s3 (Judy), s7 (Yutao) and s8 (Joy) are recorded only on the roster row.
They were assigned before the pool existed, so `wire-bot` refuses them: there is no row to hang
`bot_id` on. Backfilling them cold would be worse than the gap — `bind_telegram` would then hand an
occupied sandbox to the next hire and two people would share one agent. So `add-sandbox` grew
`tech=<ref>`, which registers and claims in one step and refuses when the roster row names a
different sandbox. Every occupied seat needs that backfill before it can be wired.

**Retiring the board bot is gated on more than the doors.** `opsNotify` sends through
`BOARD_BOT_TOKEN`, so deleting `@DashboardMan_bot` silences operator alerts as well as the Mini App
button. Phase 2 has to land first, or the alerts move somewhere else first.

**Where a seat's token lives, decided 2026-09-15.** Wiring an already-provisioned seat needs its
token, and there was no way back to one: provisioning leaves the token in the openclaw credential
store, the container's process env holds only a version-scoped placeholder (an attempt to read it
from `/proc` got a 61-character non-token and a rejected `getMe`), and `/root` kept secrets files for
two seats out of six. BotFather was the only route, once per bot, forever.

**CORRECTION (2026-09-17): BotFather was never the only route.** The gateway has to hold each
seat's token to poll Telegram for that bot, and it keeps them in its own object store --
`~/.local/state/nemoclaw/openshell-docker-gateway/openshell.db`, table `objects`, `provider` rows
named `<seat>-telegram-bridge`. The placeholder in the container's env is what the gateway resolves
AT LAUNCH from that store; reading `/proc` was looking in the one place the secret is deliberately
absent. All five unwired seats were seeded from the store on 2026-09-17, their bot ids recorded, and
their menu buttons set -- with no BotFather step. The cost of the wrong belief was five days of
"blocked on the owner fetching tokens" when nothing was blocked.

So the tokens get an operator-only home: `ops_secrets.bot_tokens`, migration `20260915100000`. The
control is **schema exposure, not RLS** — every application path is PostgREST with the service-role
key, and service_role bypasses RLS by design, so a policy would protect nothing. PostgREST only
routes to exposed schemas, so an unexposed one has no URL at all. Verified against the hosted project
with the real service-role key and an explicit `Accept-Profile`: `PGRST106, Invalid schema`. Verified
too that neither Render service carries a `DATABASE_URL`/`PG*` connection string or a secret file — a
direct connection would ignore schema exposure entirely. RLS is enabled on the table as a second
lock, for the day somebody adds the schema to the exposed list; it does not cover service_role.

Two things to keep true: **Exposed schemas must stay `public, graphql_public`** (breaking it is
silent), and **no `SECURITY DEFINER` function in `public` may read that table** — RPC is exposed, so
such a function is a bridge across the line. The token sits in the clear in backups and PITR
snapshots; at fleet scale that wants Supabase Vault rather than a `text` column.

This is a lookup, not a delivery channel. The box still holds its own copy because it has to run the
bots.

**The menu button is not free.** `setChatMenuButton` with a `web_app` replaces that bot's commands
menu — on an assistant people actually chat with, that costs the `/` list. The Main Mini App setting
in BotFather adds an "Open App" button at the top of the chat and leaves the menu alone, which is the
better shape for a seat bot; the menu button stays the fallback for anyone not yet configured.
Whether the box's gateway re-sets a seat bot's menu button on restart is unverified — watch it.

## Review pass (2026-09-09, before the branch was pushed)

An adversarial read of the commit found the cryptography correct — the
data-check-string, the base64url decode, the 64-byte guard and both pinned keys
all match Telegram's spec byte for byte — and no path that reaches a trusted
state without a verified stamp. Four findings in the plumbing around it, all
fixed here:

- **The pinned key was env-overridable.** `TELEGRAM_INITDATA_PUBLIC_KEY` fed
  straight into the live check, so one environment variable could replace the
  trust anchor for every identity on the service: generate a keypair, set the
  public half, sign a slip for any user id, and be that manager. Worse than the
  bot token this scheme exists to avoid holding, because a swapped key is silent
  and revokes nothing. The override is gone; a suite swaps the key through
  `setPublicKeyForTests()`, which the environment cannot reach. `TELEGRAM_ENV`
  still selects between Telegram's own two keys, which forges nothing — a slip
  must still be signed for a bot id on our allowlist.
- **`wire-bot` skipped its own cross-check for handle-less seats.** A seat
  registered without `bot=` had nothing to compare `getMe` against, so the wrong
  token bound silently: that seat's real bot would never be allowlisted, and the
  wrongly-recorded bot would outlive its own retirement through the other seat's
  live row. It now records the handle `getMe` returns, so a re-run can be
  checked, and says out loud that this one could not be.
- **`setSandboxBotId` wrote by `(tenant, sandbox_ref)` while the table is unique
  on `(host_id, sandbox_ref)`.** Two hosts on one tenant can both own an `s1`, so
  the row validated and the row written were not necessarily the same. It takes
  `hostId` now, and `wire-bot` passes it.
- **The allowlist had no staleness ceiling.** A bot revoked during a database
  outage stayed a door for the whole outage. Past 30 minutes without a good read
  the list falls back to the board bot alone — the pre-merge posture.

Two findings recorded rather than fixed: the Ed25519 fan-out is linear in the
number of seats on an unrated public route (negligible at pilot scale, and
inherent, since Telegram does not carry the bot id in initData), and
`verifySlip`'s catch swallows every signature-path refusal including staleness,
so the two schemes' replay windows must move together — noted at the call site.

## Open questions
- **Offboarding hygiene.** Clearing `bot_id` (or retiring the seat) is now the thing that closes a
  door. The recycle path already nulls `technician_id`; confirm it also retires the row in every
  path, or `bot_id` outlives the person.
- **The 24-hour slip window.** A verified slip is a bearer credential until it ages out. Generous.
  The console can always ask Telegram for a fresh one, so shortening it is cheap and worth doing
  with this work rather than after it.
- ~~**Technicians.** They keep the board for now; the same button on their own bot can point at
  `/board` until the console has a technician view.~~ **CLOSED — it was already built.** `consoleApi`
  serves a technician their own stops, clamped at the horizon, no roster, no tray. This line stayed
  open long after the thing it asked for existed, and phase 3 was described as blocked on it.

## Verification (2026-09-09)
`npx tsc --noEmit` clean, `npx eslint .` clean, `npx vitest run src/telegram/ src/console/
src/db/sandboxPool.test.ts src/control/` → 251 passed, 48 skipped, 0 failed. Nothing committed;
nothing deployed; the hosted pilot database was not touched.
