---
date: 2026-09-23
branch: work/step-3-office-messages-and-nudges-reach
commit: 09d65f4
topic: Step 3 of the openclaw retirement — how office messages, planner questions and pushes reach a seat today, and what the seat glue has (and lacks) to take them over
supersedes: nothing
---

# Step 3: office messages and nudges reaching glue seats — research

## Summary

The spine (the Render web service holding the customer/job record) sends four kinds of traffic
*to* a seat — a seat being one person's AI assistant on Telegram. Three of them go to the
person's **phone**, word for word, with no model involved: a **nudge** (a planner question such
as "how did the visit go?"), a **chat office message** (the planner texting the person), and a
**person push** (a system notice such as "your 2pm moved to 4pm"). The fourth goes to the
**assistant only**: an **assistant office message** ("OFFICE NOTE / OFFICE QUESTION", or a
colleague's assistant passing something along) that is injected into the seat's conversation as
a silent turn, which the person never sees. Render never calls the box. Instead two bash timers
on trades-box-1 (`nudge-runner.sh` every 10 s and `office-runner.sh` every 30 s) pull these
items with the box's *host* token and deliver each one by running a command **inside the seat's
openclaw Docker container**. Step 1 moved Ben's seat (s5) off openclaw onto the **seat glue**, a
small Node program that talks to Telegram and runs the GitHub Copilot SDK engine. It stopped s5's
container, so since 2026-09-23 03:00 UTC every one of these items for s5 fails ("could not stage
message in sandbox") and, after a few tries, **freezes** on Render. The glue today has
no code that pulls either queue. It holds no host token. Every text it sends to the engine is
treated as the person talking, which means a Working line, typing, and any reply text sent to
Telegram. So nothing it has can deliver a *silent* turn. Step 3 is where those readers
get built. Step 3 also picks up a "your seat changed" signal from step 4 (deactivation, Telegram rebind or
timezone change reaching a running glue without a restart).

## Entry Points

| Where | What starts there |
|---|---|
| `src/mcp/httpServer.ts:991-1010` | Routing for `GET/POST /control/nudges` and `GET/POST /control/office` — placed before the IP allowlist, host-token gated |
| `src/mcp/httpServer.ts:392-410` | `handleNudgePull` → `buildNudgeDelivery(host.id)` |
| `src/mcp/httpServer.ts:416-466` | `handleNudgeReport` → `completeNudgeDelivery(host.id, id, outcome, detail)` |
| `src/mcp/httpServer.ts:472-490` | `handleOfficePull` → `buildOfficeDelivery(host.id)` |
| `src/mcp/httpServer.ts:494-548` | `handleOfficeReport` → `completeOfficeDelivery(...)` |
| `src/mcp/httpServer.ts:341-378` | `handleSeatWhoami` — the only route a glue seat calls today with its seat token |
| `Box_Setup_Stuff/nudge-runner.sh` | Box half of the phone leg (root, systemd timer) |
| `Box_Setup_Stuff/office-runner.sh` | Box half of the assistant leg (root, systemd timer) |
| `src/seatGlue/main.ts:92-128` | The glue's process entry: whoami → engine → `Seat.run()` |

## Key Files

**Render side (spine)**

- `src/control/nudgeQueue.ts` (452 lines) — builds the **phone-leg** pull and settles its reports.
  - `buildNudgeDelivery(hostId)` (:110-323) returns `{ nudges: NudgeDeliveryItem[] }` from THREE
    tables, appended into one array: nudges (:117-222, one item per ask-group, the lead's id),
    `office_messages` with `via='chat'` (:232-274), and `person_pushes` (:285-321).
  - `NudgeDeliveryItem` (:66-77): `{ id, sandboxRef, replyTo (telegram user id), sessionId,
    directMessageB64 }`. `sessionId` is `nudge-<id>` / `chat-<id>` / `push-<id>` and is read by
    no current runner.
  - `completeNudgeDelivery(hostId, id, 'delivered'|'failed', detail)` (:334-452): the box never
    says which table an id came from, so it tries push (:362-377), then chat (:379-400), then
    the nudge (:425-451), then a closed-lead group fallback (:412-422). A delivered nudge moves
    the whole group to `asked` (:434); a delivered chat/push row moves to `delivered`.
  - `MAX_SERVE_COUNT = 10` (:56), `MAX_DELIVERY_ATTEMPTS = 3` (:59).
- `src/control/officeQueue.ts` (193 lines) — the **assistant-leg** pull.
  - `OfficeDeliveryItem` (:29-34): `{ id, sandboxRef, kind, directMessageB64 }`.
  - `wrapOfficeMessage(row, senderName)` (:51-83) prints the frame the seat reads:
    `OFFICE QUESTION|OFFICE NOTE (from the office record system, not a person): … mention this
    id: <id>` for a team-lead row, `NOTE FROM <name>'s assistant (relayed …)` otherwise.
  - `buildOfficeDelivery(hostId)` (:88-152) reads only `via='assistant'` rows (:99).
  - `completeOfficeDelivery` (:158-193).
- `src/db/nudges.ts:190-228`, `src/db/officeMessages.ts:261-322`, `src/db/personPushes.ts:48-102`
  — the host-scoped reads. All three embed
  `technicians!inner(id,ref,state,sandbox_ref,telegram_user_id,host_id,tenant_id)` and filter
  `.eq('technicians.host_id', hostId)`. **The queue is addressed by host, not by seat.**
- `src/db/seats.ts` (261 lines) — step 4's `seats` table: a GLUE seat only (`:8-11`).
  `getSeatIdentityByTokenHash` (:45-59) is how a seat token resolves; `getSeatByHostRef` (:30-40);
  `listPoollessSeatRefs` (:196-213).
- `supabase/migrations/20260923200000_seats.sql` — `seats(technician_id, host_id, seat_ref,
  bot_ref, token_hash, retired_at)`; one live seat per technician, per host+ref, per bot.
- `src/mcp/identity.ts:69-106` — `seatTokenOf` (`Bearer st_<64 hex>`) and `resolveIdentity`, which
  returns `{ tenantId, technicianRef, seatRef }` for a seat token.
- `src/mcp/tools/roster.ts:790-903` — `bind_telegram`: a glue seat's roster row gets
  `host_id = seat.host_id` and **`sandbox_ref = seat.seat_ref`** (:808-809). New glue refs are
  `g_` + 8 hex (:883).
- Writers of the queued rows: the planner's one `send` verb (`src/teamLead/planner.ts:3823-3843`,
  `via: d.as ?? 'assistant'`, always `kind: 'inform'`); `inform_teammate`
  (`src/mcp/tools/office.ts:313`); access decisions — `tellHerSeat` writes an assistant-leg note
  (`src/mcp/tools/access.ts:397-420`) and `textTheTechnician` a push (:369-375); pushes for a
  moved visit (`src/telegram/boardNotify.ts:281`) and an inbound call (`src/calls/notify.ts:21`);
  nudges via `createNudgeFromObservation` (`src/db/nudges.ts:88-110`).

**Box side (trades-box-1)**

- `Box_Setup_Stuff/nudge-runner.sh` (164 lines) + `.service`/`.timer` (every 10 s,
  `AccuracySec=1s` load-bearing, `nudge-runner.timer:38-40`).
- `Box_Setup_Stuff/office-runner.sh` (143 lines) + `.service`/`.timer` (every 30 s,
  `office-runner.timer:32-34`).
- Both read `/etc/doorman/badge-pull.env` (`PULL_URL`, `HOST_PULL_TOKEN`) and derive their URL
  from `PULL_URL` (`nudge-runner.sh:54-60`, `office-runner.sh:48-53`).
- `Box_Setup_Stuff/seat-glue/{install.sh, cutover.sh, rollback.sh, seat-glue@.service}` — the
  glue's install path. `install.sh:128` writes exactly four keys into `/etc/seat-glue/<seat>.env`:
  `TELEGRAM_BOT_TOKEN, SEAT_TOKEN, SPINE_MCP_URL, OPENROUTER_API_KEY`. `cutover.sh:28-31` names
  this step's gap as known and accepted.

**The seat glue (`src/seatGlue/`, ships alone as `dist/seatGlue/`)**

- `main.ts` (135) — `whoAmI` (:41-47), `seatDeps` (:50-76), `main` (:92-128). Exit 3 on a
  Telegram 409.
- `seat.ts` (535) — `class Seat`: one update at a time (`handleUpdate` :138-150), `deliver`
  (:207-256), `onEvent` (:334-420), `say` (:444-449, an ordered outbox).
- `telegram.ts` (175) — `TelegramClient`: `getUpdates` (long poll, 30 s), `send` (Markdown →
  Telegram HTML via `format.ts`, 4096-char split, plain-text retry), `sendWorking`, etc.
- `turnPolicy.ts` (177) — busy / tool-pending / abort bookkeeping for double texting.
- `engine.ts` (162) — the only file that loads `@github/copilot-sdk`; `EngineSession.send({prompt,
  mode?: 'enqueue'|'immediate', attachments?})` (:23-29); MCP timeout 300 s (:124-128).
- `whoami.ts` (50) — `fetchWhoami` → `SeatWho { seatRef, tenantId, technicianRef,
  telegramUserId, tz }`.
- `state.ts` (32) — `state.json`: `{ sessionId, offset }`, temp-file-then-rename.
- `doctrine.ts` (96) — the seat's system prompt; ports verbatim the two office blocks from
  `bootstrap-box.sh` ("Questions and items from the office", "Messages to and from the office").
- `http.ts`, `identity.ts` (`seatHeaders`), `config.ts`, `inbound.ts`, `costLog.ts`, `media.ts`,
  `voice.ts`, `format.ts`.
- `selfContained.test.ts` — a seatGlue module may import only `node:*`, `./siblings` and the SDK.

## Data Flows

### Flow A — today, a seat still on openclaw (works)

```
planner send / access / board / calls
        │ insert (status 'queued')
        ▼
 nudges · office_messages(via chat|assistant) · person_pushes        (Supabase)
        │
        │  GET /control/nudges   (host token)  → nudges + chat + pushes, ALL seats on the host
        │  GET /control/office   (host token)  → assistant rows,        ALL seats on the host
        ▼
 trades-box-1, as root
   nudge-runner.sh (10 s)                         office-runner.sh (30 s)
     nemoclaw <sref> exec: cat > /tmp/nudge-ID      nemoclaw <sref> exec: cat > /tmp/office-ID
     nemoclaw <sref> exec: openclaw message send    nemoclaw <sref> exec: openclaw agent
        --channel telegram --target <replyTo>          --session-key main --message-file …
        │  (phone buzzes; openclaw's                   │  (a model turn in the seat's main
        │   channel history now holds the text)        │   session; NO --deliver: nothing
        ▼                                              ▼   reaches Telegram)
   touch /var/lib/nudge-runner/sent-ID           touch /var/lib/office-runner/sent-ID
   POST /control/nudges {id,outcome}             POST /control/office {id,outcome}
```

Per item, both runners: validate `id` (`^[A-Za-z0-9-]+$`) and `sandboxRef` (`^[A-Za-z0-9_]+$`);
if a sent-marker exists, re-ack without re-sending; base64-decode the body; stage it to a file
in the container (openshell exec refuses newlines in argv); run the CLI with a hard timeout
(120 s send, 630 s agent turn); on exit 0 write the marker **then** report `delivered`, else
report `failed` with a fixed detail string (`nudge-runner.sh:93-162`,
`office-runner.sh:86-141`). The script always exits 0.

Render's side of one pull (`buildNudgeDelivery`): for each row, re-check liveness at serve time
(`!tech || inactive || !tech.sandbox_ref || !tech.telegram_user_id` → skip, :177, :242, :290),
skip frozen rows (`serve_count >= 10` or `attempts >= 3`), then **increment `serve_count` before
returning the item** (:206, :258, :304). `buildOfficeDelivery` does the same minus the Telegram
requirement (:104).

### Flow B — today, s5 on the glue (broken)

`technicians` for Ben still has `host_id = trades-box-1` and `sandbox_ref = 's5'`, so both host
pulls keep serving his items to the bash runners. `nemoclaw s5 exec` fails on the stopped
container → `failed "could not stage message in sandbox"`, `attempts + 1`. After 3 failures the
row freezes (`nudgeQueue.ts:196-202`, `:252-256`, `:300-303`; `officeQueue.ts:117-123`). A new
glue seat `g_xxxxxxxx` fails the same way, since no container by that name exists.
(`docs/engineering-memory.md:1726-1728` records this observed live on s5.)

### Flow C — how a person's answer returns (the step's gate)

```
nudge delivered ──► completeNudgeDelivery → markNudgeAskedGroup (status 'asked', asked_at)
person replies in Telegram ──► seat model ──► spine record_field_note (L1 capture)
   └─ attributeAnswerToGap / openQuestionsFor (src/mcp/tools/shared.ts:400-420) read
      listAskedNudgesForTechnicianJob — ASKED rows only
planner tick ──► sees answered_by_capture_id (src/db/nudges.ts:654-684, planner.ts:1503) ──► closes
```

The attribution only sees a nudge once it is `asked`, which only happens on a `delivered` report.
An office QUESTION's answer returns differently: the seat calls `inform_team_lead` with
`replyToMessageId` = the id printed by `wrapOfficeMessage`.

### Flow D — the glue's own loop (what exists to build on)

```
Telegram getUpdates (30 s long poll) ─► Seat.handleUpdate (one at a time; offset saved FIRST)
  └─ classify ─► deliver(prompt)
        policy.route(): idle → send | busy+tool pending → steer (mode 'immediate')
                        | busy, no tool → abort, then send only the new text
        startWorking(): typing + "Working… ⏹ Stop" line
        session.send({prompt})
  engine events ─► onEvent
        assistant.message → text HELD; released on turn_end/idle only if the call made no tool request
        → say(text) → Telegram
        session.idle → policy.onIdle → stopWorking
```

Every `session.send` the glue makes today is a person's turn: it shows the person a Working line
and typing, and every text the model writes without a tool call is sent to Telegram
(`seat.ts:233-238`, `:432-442`). No code path sends a turn whose output is discarded.

## External Dependencies

- **Telegram Bot API** — `sendMessage`, `getUpdates` (one poller per bot; 409 on a second),
  `sendChatAction`, `deleteMessage`, `answerCallbackQuery`, `getFile` (`telegram.ts`). Sending does
  not conflict with polling. A glue-side verbatim send would go through the same bot the glue polls.
- **GitHub Copilot SDK 1.0.14** (`engine.ts`), loaded by a non-literal specifier from the box
  package. `send` accepts `mode: 'enqueue' | 'immediate'`. Whether the SDK can add a message to
  history **without** starting a model turn is not established from the repo (see Open Questions).
- **OpenRouter** — the seat's model (`@preset/trades-seats`). An injected office turn is a paid
  model call, like it was on openclaw (`office-runner.sh:122-123` "A real model turn runs").
- **Render web service** — auto-deploy is OFF (memory `deploy-does-not-migrate`), and it is on
  the FREE plan (memory `render-web-service-is-free-plan`); the box's timers are part of what keeps
  it awake. Any Render route change needs a manual deploy.
- **openclaw / nemoclaw / openshell** on the box — still serve every seat except s5, so the bash
  runners remain the delivery path for them until step 5.

## Constraints and Invariants

1. **Render never calls the box** (`nudgeQueue.ts:23-28`; operator 2026-09-23 in the retirement
   memory: "Render cannot call the box — pull only"). All delivery and all "seat changed" news must
   ride a pull the box makes.
2. **Serve is counted before shipping.** Every pull that returns an item bumps `serve_count`
   (`nudgeQueue.ts:203-207`). Two pollers seeing the same item each bump it, and a second copy of
   an unacked item is a second message. At 10 serves with no ack the row freezes.
3. **Frozen rows stay `queued` forever**, sorted first, and are re-logged on every pull
   (`nudgeQueue.ts:30-50`, `officeQueue.ts:22-25`). The planner ends them with `close`/`dismiss`.
   The s5 items that failed since the cutover are frozen and will stay frozen when a glue reader
   starts, unless their counters change.
4. **The dedupe key is the item id.** The bash runners' idempotence is a marker file per id on
   the box; a nudge group is always served under its lead's id, and the lead is never promoted
   because a new id would defeat the marker (`nudgeQueue.ts:149-174`).
5. **Report routing needs no table name.** The box posts `{id, outcome, detail}`. Render finds the
   table by trying each (`completeNudgeDelivery` :346-423). Chat and push legs must stay ahead of
   the closed-lead fallback.
6. **The host is the caller's identity** on every `/control/*` route. The host id comes from the
   token, never the body, and a host can only move rows whose technician has `host_id` = that host.
7. **A glue seat is invisible to the queues as a glue seat.** The queue reads never touch `seats`.
   A glue seat's roster row carries `sandbox_ref = seat_ref`, so its items look exactly like an
   openclaw seat's. s5 has BOTH a live `seats` row and a live pool row (`seats.ts:61-62`,
   `:192-195`); `rollback.sh` depends on the pool row surviving.
8. **The glue is self-contained** (`selfContained.test.ts`): it cannot import `NudgeDeliveryItem`
   or anything else from `src/control`. Shapes are duplicated by hand, as `whoami.ts` does.
9. **The glue's env has no host token** (`install.sh:128`); it runs as the unprivileged
   `seatglue` user with `ProtectSystem=strict` and write access only to `/var/lib/seat-glue`
   (`seat-glue@.service:16-33`). `/etc/doorman/badge-pull.env` is root's.
10. **One glue process per seat** (`seat-glue@<seat>`). A reader inside the glue is per seat.
11. **Offset-before-handling, at most once** (`seat.ts:131-150`): the glue deliberately prefers
    losing one message to repeating one, because a repeated "file a note" duplicates an
    undeletable L1 row. The same concern applies to a re-injected office turn
    (`office-runner.sh:26-28`: "a duplicate injected turn is a duplicate instruction to weigh").
12. **Never abort mid-tool** (`turnPolicy.ts:19-23`); only `ask_team_lead` is abort-safe.
13. **Verbatim means verbatim.** `nudge-runner.sh:10-13`: "what the planner approved is byte-what-
    arrives". The glue's `TelegramClient.send` converts Markdown to Telegram HTML
    (`format.ts:14-30`); openclaw's `message send` formatting behavior for the same bytes is not
    recorded in the repo.
14. **The office blocks of the doctrine assume the openclaw delivery shape.** "A message can
    appear in the conversation history that you did not write" (`doctrine.ts:59`, ported from
    bootstrap-box.sh) — true on openclaw, where the send landed in channel history
    (`nudge-runner.sh:12-13`). On the glue, a Bot-API `sendMessage` is not in the engine session.
    "Turns can appear … OFFICE QUESTION … Nobody was pinged" (`doctrine.ts:60`). This is true only if
    the injected turn produces no Telegram output.
15. **Whoami is once per start** (`main.ts:95-98`). Deactivation → whoami 403 → the glue exits 1 →
    `Restart=always` + `RestartSec=10` retries forever (`seat-glue@.service:25-26`), since only
    exit 3 is in `RestartPreventExitStatus`.
16. **Doc drift (noted, not acted on):** both runner headers still say "every 5 min"
    (`nudge-runner.sh:4-5`, `office-runner.sh:5`) while the timers run every 10 s / 30 s;
    `officeQueue.ts:17-20` and `access.ts:388` still say "every 5 min" for the office leg; the
    step 4 finding (`findings/2026-09-23-…:52`) says g_ items "escalate" after ~10 serves — the
    code freezes them (`nudgeQueue.ts:30-50`).

## Decision Points

1. **Which route the glue pulls from, and with which credential.**
   - *Reuse `/control/nudges` + `/control/office` with the host token.* The glue would need the
     host token in its env, and that token can act for every seat on the box. Each response
     carries every seat on the host. The glue would filter on `sandboxRef`, but Render has
     already counted a serve on the items it drops (Constraint 2).
   - *New seat-token routes* (the `/seat/whoami` pattern): Render resolves the token to one seat
     → one `technician_id`, and serves only that person's rows. Needs new DB reads keyed by
     technician instead of host, and new report routes, or report handlers that accept a seat
     token and scope the point-read to that technician.
2. **How the bash runners stop taking glue seats' items.**
   - *Render-side:* the host pulls exclude technicians with a live `seats` row. No box rollout.
     But s5 keeps its `seats` row after `rollback.sh`, so after a rollback its items would go
     to the (stopped) glue instead of back to openclaw.
   - *Box-side:* each runner skips refs served by a running `seat-glue@<ref>` or an existing
     `/etc/seat-glue/<ref>.env`. Follows rollback naturally (rollback disables the unit). It is a
     box script change: install + md5 against the repo (memory `bootstrap-copy-drift-trap`).
   - *Both, or a marker the box reports* (e.g. which refs the glue serves).
3. **Whether the seat's engine sees a verbatim phone message.** On openclaw it did (channel
   history). On the glue it would not, unless the glue does something extra.
   - *Send only:* the person sees the question; the model sees only their reply, with no question
     and no "(re: …)" line naming the job. The doctrine's rule 1 depends on that line.
   - *Send, then add the text to the session* as context. How depends on the SDK (Open Question
     1). An ordinary `send` would start a model turn.
   - *Hold it and prepend it to the person's next message* inside the glue ("[you sent earlier]
     …"). No extra model call, but only visible once they reply.
4. **How an assistant-leg office message becomes a silent turn.** Today every `session.send` is
   a person's turn (Working line, typing, text released to Telegram).
   - *A second kind of send in `Seat`* that suppresses the Working line, typing and Telegram output
     for that turn and still lets tool calls (`inform_team_lead`) run.
   - *Deliver it as context without a model call* (if the SDK allows it) — the seat would weigh it
     on the person's next turn instead of right away (answers to OFFICE QUESTIONs would wait).
   - *Timing rule:* what happens when an office message arrives while the person's reply is
     busy — queue until idle, `enqueue`, or steer (`immediate`). Steering would fold office text
     into a reply the person is watching.
5. **When the glue acks, and how it dedupes.** For the phone leg, after Telegram's `sendMessage`
   returns ok. For the assistant leg, after the injected turn's idle, or after the send was
   accepted. For dedupe, either a sent-marker in `/var/lib/seat-glue/<seat>/` (the runners'
   rule), in-memory only (lost on restart → re-sent), or reliance on Render's serve cap.
6. **Cadence and shape of the pull.** Match today's 10 s / 30 s timers with a poll loop in the
   glue, one pull for both legs, or a long poll held open on Render (the nudge timer's own
   comment names long-polling as "the way past the floor", `nudge-runner.timer:11-16`). A long
   poll holds a request on the free-plan web service.
7. **The "your seat changed" signal.** It would ride the same pull.
   - *What it carries:* the current whoami fields (`telegramUserId`, `tz`, active) or a version
     stamp the glue compares.
   - *What the glue does:* exit and let systemd restart (whoami runs again). A deactivated seat
     then restart-loops every 10 s (Constraint 15). The alternative is applying changes live:
     `allowedUserId`/`chatId` are fixed in the `Seat` constructor (`seat.ts:74-81`) and `tz` is
     the engine process's `TZ` (`engine.ts:72`), so a live tz change means restarting the engine.
8. **What happens to s5's frozen backlog.** Leave the frozen rows for the planner to end (the
   broken-pipe doctrine), or reset their counters so the new reader delivers them. Items days
   old would then arrive late.
9. **Which of the four item kinds the glue takes on in step 3.** Nudges, chat and pushes share
   one item shape and one report route. Assistant office messages need the silent-turn work
   (DP 4). They could land together or separately.

## Open Questions

1. **Can the Copilot SDK add a message to a session's history without running a model turn?**
   `engine.ts` types only `send` (`enqueue`/`immediate`); the 1.0.14 `.d.ts` files would answer
   it. This decides DP 3 and DP 4. Check the vendor docs/types before planning.
2. **Did openclaw's `message send` format Markdown, or send raw?** Decides whether the glue's
   HTML conversion changes a "verbatim" nudge (Constraint 13). A driven send on a non-glue
   seat would show it.
3. **How many s5 items are frozen right now, and of which kinds?** Needs a read on the pilot DB
   (read-only). It sizes DP 8. Do not derive volumes from it (memory `never-size-from-the-pilot-box`).
4. **Does an `enqueue` send, made while a reply is running, produce a second
   `session.idle`?** If so, the turn policy would read it as the person's reply ending.
5. **Does any seat other than s5 run on the glue on the pilot right now** (a `g_` seat from
   step 4's phase 4)? That decides whether the gate test has one seat or more.
6. **Should `box-report.sh`'s watched-unit list include `office-runner.*`** (its omission was
   noted in the step 1 research, :623)? That matters if the runners keep running for openclaw seats.
