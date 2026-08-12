---
date: 2026-08-12
branch: main
topic: Ops alerting — a Render collector for box-side health events
status: PLAN — awaiting review, nothing implemented
---

## Why this exists

The inference medic now tells the truth about whether the model provider is serving
(v4/v5, PR #128). It tells it to `journalctl` on trades-box-1, which nobody reads.
That is precisely how **six agent-outage windows on 2026-08-12 went unnoticed**
(05:19, 05:24, 20:58 failover; 14:04, 16:48, 18:00 both-dead) — each a ~4-minute
stretch where every user message returned `LLM request failed`.

An honest red light in an empty room is barely better than a green one. This plan
puts something in the room.

## What this builds

A `POST /control/ops` endpoint on Render that accepts health events from the box,
stores them in an `ops_events` table, and **collapses them to transitions** so a
30-minute outage is one row that opened and one that closed, not six identical ones.

The medic becomes the first producer, via a systemd `OnFailure=`/`OnSuccess=` pair.

## What this deliberately does NOT build

Stated plainly so the gap is not mistaken for an oversight:

1. **No notification channel yet.** User decision 2026-08-12: *"just have it stay on
   render… we can always pair a bot later and it's not urgent since we're testing."*
   **Consequence: this is a STORE, not an ALARM.** Nothing wakes anyone up. It makes
   outages *reconstructable after the fact*, not *noticed as they happen*. Phase 4
   below is the one-function change that closes it when a bot is paired.
2. **No AI RCA.** Explicitly deferred by the user as out of scope. The schema in
   Phase 1 is nonetheless shaped to feed it later (see *Payload* — that is the part
   worth getting right now, because RCA quality is bounded by the context captured
   at alert time, not by the model).
3. **No dead-man's switch.** If the box dies entirely it stops reporting, and silence
   currently looks identical to health. Sketched in *Deferred* below.

## Design decisions

### Transition state lives on Render, not the box

The medic deliberately keeps **no state files** — a v2 design rule so flaps stay
visible in the journal. Dedup needs state. Putting it on the box would break that
rule and duplicate it per-producer; Render already has a database.

So the box is **stateless and dumb**: every tick it reports its current status.
Render compares against the last row for that `(host, service)` and only opens or
closes an incident when the status actually changes.

```
box (every 5 min)              Render
  status=down  ──────────────▶ last=down  → no-op   (suppressed)
  status=down  ──────────────▶ last=down  → no-op
  status=ok    ──────────────▶ last=down  → CLOSE incident (resolved, 15m)
```

This also means a missed report is harmless, and the box needs no retry logic.

### Alerting must never break the thing it monitors

Non-negotiable, and the reason for the shape below:

- the POST is **fire-and-forget** with a short timeout (5s)
- a delivery failure **never** changes the medic's exit code, and never delays the tick
- it runs in a **separate systemd unit** (`OnFailure=`/`OnSuccess=`), not inline in
  the medic script, so a broken reporter cannot take the medic down with it

### Auth reuses the host-token pattern

`/control/badges` and `/control/sandboxes` already authenticate the box with
`Authorization: Bearer <host token>` → `getHostByTokenHash(sha256hex(token))`
(`src/mcp/httpServer.ts:239`), and both route **before** the IP allowlist — exactly
what a box→Render call needs. `/control/ops` slots in beside them with the same
bare-401 posture. No new secret, no new auth code path.

## Phases

### Phase 1 — schema

New migration, `ops_events`:

| column | type | note |
|---|---|---|
| `id` | uuid pk | |
| `host_id` | uuid → hosts | from the authenticated token, never the body |
| `service` | text | `inference-medic`, later `doorman`, `cron`, … |
| `status` | text | `ok` \| `down` |
| `opened_at` / `closed_at` | timestamptz | `closed_at` null = still open |
| `detail` | jsonb | the payload below |

Index on `(host_id, service, opened_at desc)` — every read is "latest for this
service".

**Payload (`detail`).** This is the part worth arguing about now, because it is what
any future RCA gets to work with. Minimum: the medic's own warn line, the route
(`provider`/`model`) at failure, the exit code, and the unit's last ~20 journal lines.
An event that says only "medic exit 1" is not diagnosable by a human *or* a model.

**Verify:** `npm test` against the local stack; a row inserts and the index is used.

### Phase 2 — `POST /control/ops`

Host-token auth, then transition logic:

- read latest row for `(host_id, service)`
- `status=down` + no open incident → INSERT open row
- `status=down` + already open → no-op, `200 {suppressed:true}`
- `status=ok` + open incident → set `closed_at`
- `status=ok` + nothing open → no-op

Body capped (this path is pre-auth-adjacent and reachable from the box; an unbounded
read lets a client balloon the shared process — same reasoning as the board path).

**Verify:** unit tests for all four transitions plus the suppression case; a replayed
duplicate must not create a second incident.

### Phase 3 — the box reporter

`Box_Setup_Stuff/ops-report.sh` + `ops-report@.service`, wired to the medic unit:

```ini
# nemoclaw-inference-medic.service
OnFailure=ops-report@%n-down.service
OnSuccess=ops-report@%n-ok.service
```

The script reads the unit's status and last journal lines, POSTs, and **always exits
0** — a reporter that fails must not mark the medic failed.

**Verify:** stop the primary route deliberately (or point the medic at a bogus
provider in a scratch unit), confirm exactly one open row appears, that four more
ticks add nothing, and that recovery closes it.

### Phase 4 — the notifier (deferred, one function)

When a bot is paired: on incident OPEN and CLOSE only, send to Telegram. Deliberately
last, and deliberately small — the transition logic in Phase 2 is what makes it safe
to turn on without creating a noise channel.

## Deferred

- **Dead-man's switch.** Cheapest version given what exists: a Render cron asking
  "has each host reported in the last 15 minutes?" and the box noticing when Render
  stops answering — each watches the other, so only a simultaneous double failure is
  silent. Needs Phase 4 to be useful (something must be able to shout).
- **More producers.** Doorman `NRestarts` climbing (the only symptom of the crash bug
  that went undeployed for a day), cron failures, gateway errors.
- **AI RCA** over `ops_events`. The diagnosis recipes already written down in
  `docs/engineering-memory.md` are the procedure it would follow.

## Open questions

1. **Retention.** `ops_events` grows forever otherwise. 90 days?
2. ~~Does the box's outbound egress allow a POST to Render?~~ **ANSWERED 2026-08-12:
   yes.** As `ubuntu` on trades-box-1, `https://tradesdatabase.onrender.com/` resolves,
   connects and completes TLS in 110ms, returning 401 (correct for an unauthenticated
   request). The medic's own user can reach the collector without going through the
   doorman, so Phase 3 needs no egress work.
3. **Is `service` free-text or an enum?** Free-text is easier now; an enum stops
   typos silently creating a second incident stream that nobody watches.
4. **Which host row does the box authenticate as?** It already holds a host token for
   the badge pull; confirm that same token is the right identity for ops events, or
   whether ops wants its own so revoking one does not blind the other.
