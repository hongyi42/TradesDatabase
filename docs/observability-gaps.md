# Observability gaps — a running list

Things the system KNOWS are wrong and does not tell anybody. One entry per gap,
newest first. This is a backlog, not a design doc: each entry says what goes
undetected, how it is detected today (if at all), and what "told somebody" would
have to mean — so a future build can pick one up without re-deriving it.

**The distinction that puts something on this list:** a condition with an
OPERATOR fix — a broken pipe, an unset key, a dead process — that currently
reaches only a log line or a counter nobody is watching. Conditions that are
somebody's *judgment* to make (an unattended gap, a stale observation) are not
malfunctions and do not belong here.

**Standing constraint on every fix below:** whatever channel is chosen must be
verified live before it is trusted. `BOARD_BOT_TOKEN` was found unset on the
lifecycle-heart cron in August 2026, so **zero** manager pushes fired in thirty
days while the code read as working (docs/engineering-memory.md). A push path
nobody has watched fire is a push path that does not exist.

---

## 2. The planner can drain the broken-pipe counter (noticed 2026-09-02, build 6 review)

**What goes wrong.** `alarms.deliveryStuck` is the only signal that a box has stopped pulling.
Build 6 Phase 3 made `dismiss` legal on a `queued` gap and Phase 5's doctrine steers the planner
toward ending stuck questions — and `'dismissed'` is deliberately absent from
`OPEN_NUDGE_STATUSES`, so a dismissed row leaves every open reader at once, the alarm pass
included. Row by row, a planner doing exactly what it is told drains the counter to zero **while
the pipe is still down**, and `npm run ticks` reads all-clear.

```
box stops pulling  ─►  questions age past 18h  ─►  alarms.deliveryStuck counts them
                                                          │
                       doctrine: "FROZEN … close it or DISMISS it"
                                                          ▼
                                            each dismiss  −1  ─►  0, pipe still down
```

**Why it is not simply a bug.** Ending an undeliverable question IS the right call for the RECORD
— the gap cannot be answered and should not sit open forever. The defect is that one action
carries two meanings: "this question is over" and "stop counting this broken pipe". Nothing
separates them today.

**What a fix would have to be.** Count the pipe, not the question — a deliveryStuck signal derived
from rows that FAILED TO SERVE this pull (`buildNudgeDelivery` already knows, and logs it), rather
than from open rows ageing. That survives any planner decision, because it is a fact about the
pull and not about the backlog. Note this is the same place entry 1 wants its transition hook.

**Related and now fixed:** the doctrine told the planner *"a broken pipe is an operator problem
too, and they are told separately"* — false, and the exact reassurance that would make dismissing
comfortable. Corrected on the build-6 branch to say no alarm reaches anybody automatically.

---

## 1. A FROZEN delivery tells nobody (noticed 2026-09-02, build 6 Phase 5)

**What goes wrong.** A queued question stops being deliverable. Two causes reach
the caps — served `MAX_SERVE_COUNT` (10) times with no acknowledgement from the
box, or the box explicitly reported failure `MAX_DELIVERY_ATTEMPTS` (3) times —
and two more freeze without ever touching a counter: an ask-group whose lead row
has ended (the serve loop refuses to promote a sibling, `src/control/nudgeQueue.ts`),
and a technician who is inactive or has lost their sandbox / Telegram binding.

This is a MALFUNCTION, not a judgment: the pipe between the office and a
technician's phone is broken and there is an operator fix.

**How it is detected today.**

```
every 5 min   nudgeQueue      console.error "… served 10x with no delivery ack — frozen"
every 5 min   sweep alarm     alarms.deliveryStuck += 1   +  console.error "ALARMS for tenant …"
                                    ↓
                              lifecycle_runs.summary        (stored)
                                    ↓
                              npm run ticks                 (only if a human runs it)
```

Counted, stored, and loud in the logs on every pull — and it reaches nobody. No
push, no mail, no page.

**Why it is not red.** The alarm pass never sets `ok = false`, deliberately: a
permanently stuck row would redden the heartbeat every five minutes forever, and
an alarm that is always on is one nobody reads (`src/jobs/watchers.ts`, the
alarm-fatigue note). The cost of that choice is this entry — the one signal that
would actively reach somebody was switched off and nothing replaced it.

**Why build 6 made it sharper.** Deleting `escalate` (Phase 1) removed the only
path by which a stuck gap could reach a human at all. Phase 5 gave the PLANNER
the DELIVERY line so it can see FROZEN and end the gap — which is right, and is
not the same thing as telling an operator the pipe is down.

**What a fix would have to be.** A notification on the TRANSITION into frozen —
once per row, never per pull — or the fatigue trap this list exists to respect
is simply moved. Note that three of the four freeze causes are decided at serve
time in `buildNudgeDelivery` and are not derivable from the row afterwards, so
the transition is most cheaply detected where the freeze is decided, not by a
later sweep over the table. `notifyOpsTransition` (`src/telegram/opsNotify.ts`)
is the existing ops channel; today only `src/mcp/httpServer.ts` calls it, for
service up/down.

**Scope note.** Raised while closing build 6 and deliberately NOT folded into it
— the user's call (2026-09-02): "Notice it. We'll write it in a list of
observability items to keep track of in the future."
