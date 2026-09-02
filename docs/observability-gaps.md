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
