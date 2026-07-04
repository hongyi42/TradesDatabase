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

Goal: prove or refute a reversible late sender re-bind on the running s1 sandbox without rebuild.
Result: **PENDING — record the host Claude report here before starting the RPI cycle.**
