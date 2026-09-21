---
date: 2026-09-20
branch: main
commit: e4b9a4c
topic: The onboarding flow end to end — who creates the Telegram bots and why the cap decides it, the structural bootstrap asymmetry (the first seat of every firm cannot be self-serve), the team settings page and its token lifecycle, and what of all this is not built
supersedes: nothing
---

**Companion to** `thoughts/shared/research/2026-09-20-the-onboarding-questionnaire.md`, which covers
what the questionnaire asks and where its answers land. This document covers everything around it:
how a firm gets from nothing to a running seat. Overturns nothing.

## Summary

Three questions were open and are now settled:

1. **Who creates the Telegram bots.** The customer does. Decided by Telegram's cap of 20 bots per
   account (40 with Premium) — if we create them, the cap binds at roughly three to six firms and we
   inherit a fleet of phone numbers that grows linearly with customers. Customer-created moves the
   cap to 20 bots per firm, where a small trades firm never reaches it.
2. **Where the token travels.** Into the team settings page in the schedule UI, not email. The box
   collects it on its own timer, the same direction of trust `nudge-runner` already uses.
3. **The first seat of every firm cannot be self-serve.** This is structural, not a gap — see below.

## Entry points

| Where | File | Role |
|---|---|---|
| Seat provisioning | `scripts/assign-host.mjs` | `add-sandbox`, `wire-bot`, `claim-sandbox`, `bind-telegram` |
| Bot wiring | `Box_Setup_Stuff/seat-sync.sh` | `getMe` (handle + numeric id), `setChatMenuButton` |
| Box pulls from spine | `Box_Setup_Stuff/nudge-runner.sh` | systemd timer against `GET/POST /control/nudges` — the pattern the token runner should copy |
| Roster tools | `src/mcp/tools/roster.ts` | `add_technician_seat`, `bind_telegram`, `list_team`, `set_technician_skills` |
| Seat cap | `supabase/migrations/20260702194603_…sql:30-38` | `enforce_seat_cap()` |
| Schedule UI | `web/board` | the Mini App the settings page belongs to |
| Technician view | `web/console` | the precedent for serving a clamped view rather than the full board |

## Who creates the bots, and why

**Decided: the customer creates their own bots** (user, 2026-09-20).

Telegram caps bot creation at **20 per account, 40 with Premium**
([Bots FAQ](https://core.telegram.org/bots/faq),
[Telegram-Limits #288](https://github.com/tginfo/Telegram-Limits/issues/288)). At roughly six people
per firm that is three firms per free account, six per Premium. A hundred firms is ~600 bots —
seventeen Premium accounts, each a phone number, SIM, 2FA secret and session to keep alive, growing
with every customer. Customer-created puts the cap where it never binds: twenty bots is twenty
staff.

**Two arguments considered and rejected along the way, recorded so they are not re-run:**

- **"The bots should belong to a firm account rather than the manager's personal one."** Rejected
  (user): it is a rename, not a fix. Whoever can log into the firm account has exactly the powers
  they had before, and the credentials would have to be rotated on offboarding anyway — at which
  point ownership could simply have been transferred from the personal account.
- **"A departing employee can break their seat."** True but **nuisance-grade, and it should not
  drive the decision.** BotFather's `/token` replaces a token immediately and `/deletebot` is
  irreversible ([features](https://core.telegram.org/bots/features)), so an owner really can kill a
  bot. But recovery is new bots paired into the **same sandboxes** and everyone pressing Start
  again. Nothing moves: spine, roster, memory files and sandboxes are all ours. **The bot is the
  front door, not the building.**

**Ownership is transferable** — `/mybots` hands full control to another account, permanently, and
the recipient must have interacted with the bot at least once. That is the migration path if a
specific firm's bots ever need to move.

**Open, and deliberately small:** whether the *manager* creates every bot for the firm or each
person creates their own. Twenty-per-firm either way, so it is a UX question, not an architectural
one. The argument for the manager is that they have already learned BotFather and a technician would
then need only a user id.

**No migration for the pilot.** At two tenants the cap does not bite; existing pool seats stay as
they are, and new firms arrive customer-created.

## The bootstrap asymmetry — the first seat cannot be self-serve

The team settings page lives in the schedule UI, which is a Telegram **Mini App opened from the
manager's own bot** and authenticated by Telegram's initData signature. So:

```
no working bot  →  no board  →  no settings page  →  nowhere to paste a token
```

**The first token of every firm therefore arrives out of band and is wired by an operator.** Every
seat after it is self-serve through the page. This is a property of the auth model, not a missing
feature — closing it would mean a non-Telegram login for the board.

Worth making that one step a one-time upload link rather than email, but it stays operator-mediated.

## The flow

### 0 — Operator, pre-sales

What system do you use today; where the schedule actually lives; headcount. Sets
`tenants.manager_seats` / `technician_seats`, which `enforce_seat_cap()` enforces on every later
roster insert.

### 1 — Manager makes their bot

Install Telegram → BotFather `/newbot` → handle + token → @userinfobot → numeric user id.

### 2 — Token reaches the operator (out of band — see the asymmetry above)

### 3 — Operator provisions seat one

`add-sandbox host= sandbox= bot=@handle` → `wire-bot` → `seat-sync.sh` → `bind-telegram ref=
telegramUserId=` (operator-side; the manager has no assistant yet to call the MCP tool).

### 4 — First contact fires the questionnaire

The manager opens their bot and presses Start. **Bots cannot message first**
(`src/mcp/tools/roster.ts:141`), so this is the earliest possible trigger point — nothing can precede
it.

An `AGENTS.md` condition sees no firm profile and invokes the questionnaire skill. The roster is
necessarily empty at this moment, because the only way to add people is through the manager's
assistant, which requires the bot to be running. **So the questionnaire asks who is on the team and
mints the seats itself** with `add_technician_seat` — whose two-step confirm must survive, since the
ref it mints is permanent and never reused.

### 5 — Team, self-serve from the board

A **Settings** button on the schedule UI's top bar opens the team table (user, 2026-09-20).
Admin-only: technicians do not see the button, **and the server refuses them rather than trusting the
client to not ask** — the `consoleApi` clamped-view precedent, and the standing lesson that a new
surface bypasses whatever doctrine rule did not name it.

| Name | Bot Token | User ID | Email | Status |
|---|---|---|---|---|
| Ben Shelton | write-only | write-only | ben@… | `@ben_bot` ✓ · last heard from 2026-09-18 |
| Marco Diaz | write-only | write-only | marco@… | `@marco_bot` ✓ · **never heard from** ⚠ |

- **Neither secret is ever displayed** (user, 2026-09-20). Managers paste rather than type, so the
  transposition typo the display would have caught barely exists — and the digits of a user id are
  meaningless to a human, so showing them would not catch a swap either.
- **`last heard from` is what actually catches the failure**, and it catches all three cases: typo,
  swap, and never-pressed-Start. It is the one thing in this table doing safety work. The box already
  holds the data in each seat's session ledger — that is how Judy Chen's id was recovered after she
  sat unreachable for two months with nothing logged.
- **Validate the token with `getMe` on paste.** Rejects a bad token before storage and returns the
  handle, so nobody types one. (The Feature A intake requirement already says this.)
- **Two columns beyond the four proposed:** `tier` (the seat cap is enforced per tier, so a row
  cannot be minted without it) and `seatExempt` for a schedule-only helper who gets no seat and no
  bot.
- **Availability is the silent one.** `technicians.availability` NULL means the scheduler treats that
  person as unschedulable. Whether or not it lives on this screen, it is the field most likely to be
  skipped and then surface weeks later as a scheduling bug.

### 6 — The box collects the token

```
paste → spine stores pending → box runner pulls on its timer → wire into the gateway
store → seat-sync → CLEAR the DB copy, leaving handle + wired_at
```

Direction of trust is unchanged: **Render never reaches the box; the box pulls.** `nudge-runner.sh`
already does exactly this against `/control/nudges`.

**The DB is a mailbox, not a safe.** The gateway's own sqlite store is where seat tokens actually
live and must live — it cannot poll Telegram otherwise. The database copy exists only long enough to
be collected, and clearing it is what stops that table becoming a permanent list of live bot tokens
for every seat of every tenant. Steady state the column is null; only three things ever fill it: a
new seat, a replaced token, a re-wire.

**A pending token needs an expiry**, for the same reason staged confirmations have one: if the box is
down or the seat is never provisioned, an un-collected row parks a live credential indefinitely.
Expire it and tell the manager it did not take.

### 7 — Technician starts

The manager relays the handle; the technician opens it and presses Start. That inbound message is
what flips **never heard from → last heard from**.

## What does not exist yet

| Piece | Status |
|---|---|
| Settings page + team table | not built — parked `20260919-manager-settings-page-in-the-schedule-bo` |
| Pending-token table + intake endpoint | not built |
| Box-side token runner | not built; the pattern exists in `nudge-runner.sh` |
| `last heard from` indicator | not built; the box holds the data in its session ledger |
| Questionnaire skill | not built |
| **Skills enabled at all** | `maxSkillsInPrompt = 0` on every seat — see the questionnaire research |
| `bind_telegram` copy | still tells a manager to "ask their operator" for a handle they supplied |

## Open questions

1. **Manager creates every bot, or each person their own?** UX only; the cap is per firm either way.
2. **What carries the first token**, given it cannot go through the board — a one-time upload link,
   or email with a documented rotation step.
3. **Does the pending-token table hold the token encrypted**, or is RLS plus
   `revoke anon, authenticated` plus prompt clearing sufficient? Every new table since the
   `money_events` review has taken the second posture; this one holds a live credential, which none
   of the others did.
4. **Where availability is captured** — the settings page, the questionnaire, or the manager's chat.
   It is the field whose absence fails silently.
5. **Confirm the 20/40 cap against a real account** before writing customer-facing tutorials around
   it. Sources mostly agree; one claims no limit.

**Sources:** [Telegram Bots FAQ](https://core.telegram.org/bots/faq) ·
[BotFather features](https://core.telegram.org/bots/features) ·
[Telegram-Limits #288](https://github.com/tginfo/Telegram-Limits/issues/288)
