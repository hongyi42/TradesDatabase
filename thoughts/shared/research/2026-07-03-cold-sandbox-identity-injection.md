---
date: 2026-07-03
branch: main
commit: dfc899d
topic: Cold-sandbox identity injection — badge, Telegram sender binding, unbind at offboarding (pre-research for the Plan 3 RPI cycle)
---

## Summary

The seat-based licensing model says: **every purchased seat's sandbox is pre-built at setup time,
then sits cold and identity-empty; hiring injects an identity into an existing sandbox, never
builds one** (seats reusable, refs never). Identity injection has three ingredients. As of
2026-07-03 one is fully automated and live-proven, one has a documented mechanism only at
build time (the late re-bind experiment below closes that question), and one is entirely manual.
This note records the current state so the upcoming RPI cycle (queued after the test-suite
cleanup fix) starts from facts, not recollection.

## Ingredient 1 — Badge (SOLVED, live-proven 2026-07-03)

- Server side: roster row + `assign-host.mjs assign ref=… host=… sandbox=…` → the host's next
  5-minute `badge-pull.sh` tick mints the badge (`newBadges` in the pull response →
  `/root/pending-badges.jsonl`, the only plaintext copy).
- Host side: install as the sandbox's provider credential
  (`openshell provider update <AGENT>-telegram-bridge --credential TRADES_SPINE_BADGE=…`),
  delete the pending line. A credential **value swap needs no openclaw restart** (egress resolves
  per-request); only the first-ever registration does. The boot-time placeholder self-heal
  (bake-in edit 3b) removed the versioning trap that used to make these writes dangerous.
- Deactivation → `revoked:true` on the next pull; offboarding expiry keeps the entry revoked.
- Live proof: the s1 badge rotation (2026-07-03) repurposed a running sandbox's spine identity
  with zero rebuild and zero downtime beyond the swap itself.

## Ingredient 2 — Telegram sender binding (mechanism at build time only; late re-bind = the open question)

- The bot is per-sandbox; the sender allowlist restricts it to one person's Telegram user ID
  (docs/nemoclaw-tech-agent.md:29).
- **Only documented binding point:** the `nemoclaw onboard` messaging-channel prompt (bot token +
  user ID), i.e. image/sandbox BUILD time (Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md §4).
  That fits build-per-hire, not the cold-pool model.
- **Open question (host experiment issued 2026-07-03, result to be recorded here):** can the
  sender allowlist be changed on an already-built, running sandbox — where does the binding
  actually live (openclaw.json channel config / provider store / gateway config), is the change
  a config edit + hash recompute, a provider write, or a channel re-onboard, and is it reversible
  without a rebuild? Until answered, cold-pool hiring is unverified for this ingredient.
- The user's Telegram user ID itself is not a secret (obtainable via e.g. @userinfobot); the
  binding is the access-control act.

## Ingredient 3 — Unbind + freeze at offboarding (entirely manual today)

- Deactivation today: badge revoked within one pull (automated); mail flow stops instantly
  (webhook roster gate). The Telegram binding and the sandbox itself are untouched — the agent
  keeps answering its bound sender until someone manually intervenes (it just can't reach the
  spine, so it fails closed on tool calls).
- Target: deactivation propagates sender-unbind + sandbox freeze; the seat returns to the cold
  pool for the next hire. This was explicitly scoped OUT of Plan 2 (recorded in the Plan 1
  design decisions: sandbox provisioning stays operator-side for now).

## Existing control-plane hooks the RPI can build on

- The per-host pull channel (`GET /control/badges`, per-host token, 5-min timer) — the natural
  carrier for binding/unbinding directives alongside badge state.
- The roster (`technicians`): would gain a `telegram_user_id` column (nullable; collected during
  the manager's "add" flow or hiring paperwork); `sandbox_ref` already exists.
- The lifecycle heartbeat (Render cron, */15) for anything sweep-shaped.
- The review-items queue if any binding step needs manager confirmation.

## Decision points for the RPI (not decided here)

1. Where the manager supplies the new hire's Telegram user ID (at "add" vs a later step) and how
   it is validated.
2. Pull-channel payload extension (bindings ride the badge pull) vs a separate control endpoint.
3. What "frozen/cold" means operationally: container stopped vs channel unbound vs both; and what
   re-issue to the next hire requires.
4. Per-seat bot tokens: each sandbox needs its own bot token at pre-build time — where these are
   minted/stored at purchase time (currently: manually, at onboard).
5. Whether unbind rides deactivation (instant) or expiry (end of grace) — deactivation is
   reversible, so unbinding at deactivate requires re-bind on reactivate.
6. **The cold-pool auto-allocator (required for full self-serve).** Person→host/sandbox
   assignment is today a deliberately operator-side CLI (`scripts/assign-host.mjs assign`).
   Since pool sandboxes are identical and identity-empty, the server can claim the next free
   sandbox on the tenant's host when a seat is added — no human judgment involved. Without this
   in scope, an operator stays in every hire. Product principle (user, 2026-07-03): the Telegram
   chat is the ONLY user-facing surface — onboarding/offboarding must run end to end from the
   manager's chat, with operators involved only at initial setup and breakage.

## Host experiment (issued 2026-07-03)

Goal: prove or refute a reversible late sender re-bind on a **scratch/cold sandbox** (NOT the live
s1 — this supersedes the original "on the running s1" wording; a bad allowlist edit must never
touch the live manager agent) without rebuild.
Result: **PENDING — record the host Claude report here before starting the RPI cycle.**

### Part A — vendor-docs findings (2026-07-07, read-only research; cited)

Answers the *documented* half of the experiment. Docs consulted (live):
NemoClaw messaging-channels (`docs.nvidia.com/nemoclaw/user-guide/openclaw/manage-sandboxes/messaging-channels`)
and CLI reference (`…/reference/commands`); OpenClaw Telegram channel (`docs.openclaw.ai/channels/telegram`)
and sandbox CLI (`docs.openclaw.ai/cli/sandbox`).

- **Where the allowlist lives:** `openclaw.json` → `channels.telegram.dmPolicy: "allowlist"` +
  `channels.telegram.allowFrom: [<numeric telegram user ids>]` (prefixes `telegram:`/`tg:`
  normalized). Build-time input = env `TELEGRAM_ALLOWED_IDS`; baked into the image via
  `NEMOCLAW_MESSAGING_CHANNELS_B64`; bot token stored as the `<sandbox>-telegram-bridge` provider.
  This confirms Ingredient-2's "build-time only" hypothesis and the §4 onboard binding point.
- **Docs lean toward OUTCOME B (rebuild-required).** The only documented mutation path is host-side
  `nemoclaw <name> channels add telegram` (re-enter token + allowed ids) **followed by a rebuild**;
  the wizard even "asks whether to rebuild immediately." In-sandbox edits are *explicitly warned
  against*: "changes inside the running container do not persist across rebuilds," and OpenClaw's
  own CLI says "updating sandbox config does not affect running containers; existing runtimes keep
  their old settings … recreated when the agent is next used." No gateway-restart-only rung is
  documented. **Key asymmetry vs Ingredient 1:** the badge is a *provider credential* (value swap,
  no restart); the allowlist is *baked channel config* — the Ingredient-1 precedent does NOT carry
  over.
- **Inspect (read-back) candidates:** `nemoclaw <name> config get --key channels.telegram.allowFrom`
  (reads "sanitized" config — may redact) and `nemoclaw <name> channels status` (health/state —
  not confirmed to print the numeric ids). Neither is documented to dump the live-served allowlist
  verbatim.

### Part B — empirical host test (DONE 2026-07-07, on scratch sandbox **s2**; s2 fully restored + verified)

Ran the ladder on s2 (nemoclaw v0.0.73, gateway healthy 6h, telegram channel registered). Snapshot
`pre-allowlist-exp` + a saved copy of the original config taken first; s2 restored afterward
(`channels status` → `ok / 5801703167`, gateway `active`, file reverted, perms fixed).

**Headline: NEITHER clean Outcome A NOR clean Outcome B — it's a two-layer model.** The allowlist
exists in TWO places, and the fix is real but must touch both:

1. **Rendered (in-sandbox):** `/sandbox/.openclaw/openclaw.json` → `channels.telegram.dmPolicy:
   "allowlist"`, `allowFrom: [...]`, integrity-guarded by `/sandbox/.openclaw/.config-hash`
   (sha256 of openclaw.json — confirmed byte-exact match). This is what the running gateway loads.
2. **Expected (host source of truth):** `~/.nemoclaw/sandboxes.json` → per-sandbox `allowedIds`
   (one block per sandbox; s2's held the id). This is what `channels add`/onboard write and what a
   rebuild RE-RENDERS openclaw.json from.

**Answers to the four gaps:**
1. **Gateway restart without rebuild picks up an edited allowlist — YES.** Edited openclaw.json
   `allowFrom` 5801703167→1111111111, recomputed `.config-hash`, `nemoclaw s2 gateway restart`:
   the edit **survived the restart** (not re-rendered from source), gateway came back **healthy**,
   and — critically — **NO rebuild, so NO device-key strip.** So the operator-in-the-loop / rebuild
   fear is AVOIDABLE for making a bind take effect.
2. Per-message vs boot: not tested behaviorally (needs a 2nd Telegram account — the Phase-4 human
   check). Strong inference the gateway enforces the rendered openclaw.json it loads.
3. **`channels status --json` returns the id in clear AND does a rendered-vs-expected DRIFT check** —
   after the raw edit it reported `warn: "expected 5801703167; rendered 1111111111"`. This drift
   signal is a gift: it's an objective, no-messaging probe of whether the two layers agree.
4. **Rebuild is NOT mandatory for immediate effect** (edit + hash + restart works), BUT a
   rendered-only edit **drifts from the source and would be silently reverted by the next rebuild /
   `channels add`.** The only *supported* mutation (`channels add`) still rebuilds. So a durable,
   rebuild-safe bind must write BOTH layers.

**Gotchas found (matter for the Phase-4 script):**
- `nemoclaw upload` writes files as mode 640/644; the gateway expects **660** (group-writable) and
  a restart REFUSES with `GATEWAY_UNSAFE_CONFIG_PATH` until fixed (`nemoclaw s2 doctor --fix`, or
  write with 660). The pull script must set perms.
- `nemoclaw <name> exec` reads stdin — in a scripted/heredoc context it swallows following commands;
  use `</dev/null` or `--no-tty`.
- Device-pairing ws errors ("device is not approved yet") in s2's logs are pre-existing (its
  dashboard device isn't paired) — unrelated to the allowlist.

**Implication for Phase 4 (revised outcome):** the host pull script CAN apply a binding with **no
operator, no rebuild, no device-key strip** by: (a) writing the sandbox's `allowedIds` in
`~/.nemoclaw/sandboxes.json` (durable/source), AND (b) writing `openclaw.json` `allowFrom` +
recomputing `.config-hash` + `chmod 660` + `nemoclaw <name> gateway restart` (immediate effect).
Both are host-file operations. `nemoclaw rebuild` device-key-strip hazard is now *avoided by
design* (we never rebuild to bind).

**Source-file check DONE 2026-07-07 (read-only) — confirmed complete.** The authoritative
allowlist is `~/.nemoclaw/sandboxes.json` →
`sandboxes.<name>.messaging.plan.channels[channelId=telegram].inputs[inputId=allowedIds].value`
— a plain string (comma-separated for multiple ids; the render step turns it into openclaw.json's
`allowFrom` array). **There is NO separate base64 messaging blob in sandboxes.json** — the
`messaging.plan` is structured JSON, so editing that one `value` is the whole source update (a
rebuild re-renders openclaw.json from it). So Phase 4's durable two-write recipe is confirmed
feasible with no hidden third representation. ⚠️ The same `inputs` block stores the Telegram
**botToken in plaintext** (`inputId=botToken`) — pre-existing security item, rotate/scrub
separately (independent of binding).
