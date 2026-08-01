---
date: 2026-07-31
task: Phase 6 live E2E acceptance run of PR #91 (freeze / run_resolve / undo_run) against the deployed pilot
env: Default Tenant (82bbc6f8-abc6-4e89-bd99-fa82bc8d8d18), hosted daqapdlkgxfrhquacprv (LIVE pilot)
actor: Yutao (manager, carries visits); manager-sam also present
verifier: Claude Code (read-only SQL cross-channel read-back; maker≠checker — did not write PR #91)
status: Parts 0-6 complete (Part 7 cron optional). State restored to baseline 149/3.
---

# Run-resolve / freeze / undo — Phase 6 live E2E findings

Running log of defects + evidence found while executing the acceptance script on the live pilot.
Data-integrity checks are cross-channel read-backs via the `supabase-test` MCP (SELECT only).

## Baseline (captured before Part 1)
- 149 confirmed assignments (140 booked, 84 future); 99 already booked inside the freeze horizon.
- Pinned = 3: Priya Natarajan (hman, Aug-4 08:30, booked), Emily Watanabe (manager-joy, Aug-4 13:30,
  booked), Robert Osei (person-less, Aug-11, loose). Matches script's Part 0 / "1 loose pinned" / "3 pinned".
- Loose in horizon ≈ 16 (8 unscheduled jobs + 4 person-less placed + 4 unplaced/no-time).
- Seed drift vs script: script assumed a lighter board; real board is fuller, so freeze places fewer
  and skips more than the script's "~16 placed / ≥1 skipped" numbers. Not a bug.

## Finding 1 — Unaided dismiss: agent falsely reports "already gone" and does NOT dismiss (first ask)
- **Severity:** medium (correctness + false reassurance; user can recover by repeating).
- **Where:** agent tool-selection on "get rid of that proposal" (Part 1 step 5, unaided dismiss).
- **Repro (verified against DB):**
  - Token `a130da01-00e7-4de0-8817-9fe5db25617c` (pending_freeze) created 21:45:59, status `open`.
  - User: "get rid of that proposal" → agent replied *"There's no active proposal to cancel since
    nothing was committed … it's already gone."* Token remained `open` — **dismiss tool never called.**
  - User repeated "get rid of that proposal" → agent *"formally dismissed and killed"* → token flipped
    to `dismissed`. So the dismiss verb works; the agent's first-pass reasoning skipped it.
- **Root-cause hypothesis:** agent conflates "nothing was booked/committed" (true) with "nothing to
  dismiss" (false). A staged proposal is an OPEN review_items token regardless of commit state; the
  agent must dismiss it explicitly rather than reason it away.
- **Impact:** false "it's gone" while the token stays open (and commit-able) for 12h → a manager could
  believe a live proposal is closed when it is not.
- **Fix direction (unverified):** the dismiss path should check for an open pending_* token and act on
  it; "nothing committed" must not short-circuit the dismissal. Add an E2E/unit assertion that a plain
  "get rid of that proposal" closes the newest open token on the FIRST call.
- **Evidence:** review_items a130da01 open→dismissed; no freeze_committed event throughout Part 1.

## Part 1 scorecard
- Freeze wrote zero bookings (no freeze_committed event) — PASS.
- Staleness guard refused a stale "yes" — PASS.
- Terrance Hood park+restore (cancel+remint) round-tripped to Yutao 08/02 14:30–15:45; confirmed
  count held at 149, pinned held at 3 — PASS.
- Unaided dismiss on FIRST ask — FAIL (Finding 1); succeeded on retry.

## Part 2 scorecard — freeze COMMIT (all PASS)
- Committed via chat "yes" as actor `yutao`. Reply listed 11 placements + pin offer.
- Events 250–261 (before-snapshot high-water was id 249):
  - 8 `booked` (fresh rows for unscheduled jobs) + 3 `moved` (person attached to the person-less
    placed visits Maria Aug-5, Sofia Aug-10, Marisol Aug-12; `toDay==fromDay`, cancel+remint) = 11 placed.
  - confirmed count 149→157 (+8) — CORRECT: the 3 moves are net-zero (−1 cancel, +1 remint each).
  - pinned held at 3 — none auto-pinned (verified before the pin offer was answered) — PASS.
  - uniform `freezeRun` = `2026-07-31T21:58:57.769Z` on all 12 events — PASS.
  - `freeze_committed` (id 261) is the LAST event, detail `{placed:11, skipped:25}` — PASS.
- Minor: skipped 25 at commit vs 24 in the earlier proposal — board shifted between runs
  (Terrance park/restore + elapsed time). Not a defect.
- Notifications (phone, board bot DM — sent via BOARD_BOT_TOKEN, boardBot.ts; NOT the agent chat):
  - Manager push received: "Freeze ran (by yutao): placed 11, skipped 25 — see the board." — EXACT MATCH, PASS.
  - Tech push received: "New visit on your schedule: 2026-08-13, 08:00–12:00." — individual line, NO digest header.

## Finding 2 (NOT a code bug — SCRIPT expectation is wrong): freeze digest header is threshold-gated
- The script asserts every bound person gets ONE digest headed "The schedule freeze updated your
  schedule:". Reality (boardNotify.ts:44,287-288): `DIGEST_THRESHOLD = 3` — the batched digest (with
  that header) is only produced when a recipient is owed MORE THAN 3 messages in one poll tick;
  at/below 3 they get individual raw lines ("New visit on your schedule: …", "A visit landed on your
  schedule: …"). Yutao owed ≤3 → individual lines, correct by design.
- Action: correct the acceptance script — the "The schedule freeze updated your schedule:" header only
  appears for bursts of ≥4 placements to one person; to exercise it live, seed a run that gives one
  tech 4+ visits. Manager summary + per-visit copy verified correct.
- Data-quality note: hman has NULL telegram_user_id → hman's 4 freeze placements were NOT notified
  (boardNotify liveness filter). Expected behavior; worth a pilot roster fix.

## Finding 3 — RESOLVED (no gap): person-attach (move) tech push DOES fire
- Yutao received all 3 messages: "A visit landed on your schedule: 2026-08-12, 10:00–12:00." (Marisol,
  move-attach event 259), "New visit on your schedule: 2026-08-13, 08:00–12:00." (Chen, booked), and
  the manager push. Sent as 3 individual messages (3 is not > DIGEST_THRESHOLD=3) — confirms both the
  move-attach notification path AND the exact threshold boundary. PASS.

## Part 2 — FULLY VERIFIED (data + notifications).

## Part 3 scorecard — undo the freeze (all PASS)
- Preview stage non-destructive: created 1 pending_undo token, zero schedule writes (confirmed stayed
  157, no new events). Preview correctly split the 11 into 8 unbook + 3 detach.
- Undo commit (events 262–273, before-marker id 261):
  - 8 `cancelled` (fresh bookings → loose) + 3 `moved` (person detached from the person-less visits) = 11.
  - confirmed 157→149 (baseline) — CORRECT; pinned held at 3.
  - uniform `undoRun` = 2026-07-31T22:19:26.567Z on all 12 events.
  - `undo_committed` (id 273) LAST, detail {undid: freeze 21:58:57.769, restored:11, skipped:0, undidKind:freeze}.
  - pending_undo token closed (0 open).
- Double-undo: "undo it again" correctly refused ("already undone — latest committed run only"); zero
  writes (confirmed 149, max event still 273, 0 tokens) — PASS.
- State fully restored to pre-freeze baseline (149 confirmed, 3 pinned).

## Part 4 — in progress (re-solve stage + Re-plan proposal view). Before-marker: 149 conf / 3 pinned / event 273 / 0 tokens.
- Re-solve reply: 11 moves / 11 placed / 72 kept / 18 skipped / **3 pinned untouched** (Priya+Emily+Osei
  all in Skipped) — the re-solve pinned-count rule is CORRECT (freeze reported 1, resolve reports 3). PASS.
- Skips reconcile: 4 no-duration + 1 expired + 3 pinned + 10 out-of-pattern = 18.
- POSITIVE: all 11 moves are small same-day time nudges (2–24 min), zero day-hops — the displacement
  cost model (DISRUPTION_COST_PER_HOUR) is working (won't move to another day for a small win).

## Finding 4 (edge, SUSPECTED — not committed so unconfirmed): day-0 same-day placement can rot into the past
- Re-solve solved ~15:2x local and staged a placement (Priya, Tankless WH descaling) at TODAY 15:24;
  by the time it was reviewed local now was 15:28 → the staged slot is ~4 min in the PAST.
- The "same-day placement lands after now" clamp is evaluated at SOLVE time. The proposal's 12h TTL +
  version-staleness guard cover schedule CHANGES, not elapsed time — so committing a near-now same-day
  placement a few minutes after solve would book a PAST-dated visit. Commit-time re-clamp appears absent.
- Not committed here (Part 4 dismisses), so unconfirmed. Severity low-med: narrow window (same-day
  near-now), and operationally a manager rejects a "4 minutes from now" customer booking anyway.
- Suggest: add a commit-time day-0 re-check (drop/adjust same-day placements whose start is now in the
  past), or exclude "within N minutes of now" slots at solve time. Add a regression test.
- Also a route-quality note (human judgment): the solver jamming Priya into a tiny same-day gap, plus
  9 Yutao visits nudged 2–24 min, are the kind of low-value churn a manager would decline.

## Part 4 — PASSES. Dismissed cleanly; zero writes (149/3, no events >273, pending_resolve dismissed).
- Finding 1 UPDATE: unaided "get rid of that plan" worked on the FIRST try for the resolve proposal
  (clean single fresh token) — no false "already gone". So Finding 1 is INTERMITTENT/conditional, not
  universal; likely triggered in Part 1 by ambiguity (a token staled by an intervening manual edit +
  the "nothing committed" framing). Repro conditions still uncertain — keep the finding open but
  downgrade to conditional.

## Part 5 — SCOPED re-solve commit "my own visits" — PARTIAL COMMIT (Finding 5). Before-marker: 149/3/event273.
- Reply: scope echoed (Yutao), 9 moves / 11 placements / 23 kept / 21 skipped / 3 pinned untouched.
- Committed (events 274–287, resolveRun 2026-07-31T22:42:51.175Z):
  - 274–282: 9 `moved` (all Yutao's visits, same-day nudges) — SCOPE HELD, PASS.
  - 283–286: 4 `booked` (all Hman placements) — committed.
  - 287: `resolve_committed` detail {kept:23, moved:9, placed:4, skipped:21,
    error:"Joy already has a confirmed visit overlapping 2026-07-31 15:36–16:51",
    stoppedAt:"job:aa6e7cff-…"} — LAST event; honestly records the partial + stop.
  - confirmed 149→153 (+4 bookings; 9 moves net-zero); pinned 3 (none auto-pinned); token consumed.
  - Verified-correct: scope, uniform resolveRun, resolve_committed last, no auto-pin.

## Finding 5 — CONFIRMED (high): scoped re-solve proposed an OVERLAPPING placement; stop-on-failure stranded 6
- The solver placed Priya's tankless descaling at 2026-07-31 15:36–16:51 (TODAY, day-0, near-now) on
  Joy — a slot Joy already had a confirmed visit in. Commit hit DB `no_confirmed_overlap` and STOPPED.
- Result: 9 moves + 4 Hman placements committed; the 5th placement (Priya) failed; 6 further
  placements stranded (Henderson, Acme, Grace Kim, Maria-HVAC, Sofia, Marisol) — stop-on-failure.
- Root cause = Finding 4 (now CONFIRMED as real, not just suspected): day-0 near-now placement where
  the solver mis-modeled another tech's current occupancy. In a scoped solve, Joy's visits are fixed
  context; the solver should route around them but placed on top.
- Two-sided: (a) POSITIVE — the DB overlap constraint prevented an actual double-booking (defense-in-
  depth held); (b) BUGS — solver should never PROPOSE an overlap, and stop-on-failure lets one bad
  placement strand many good ones (documented posture, but costly here).
- Fix directions: (1) day-0 context must include in-progress/near-now visits of ALL techs (not just the
  movable scope) so placements route around them; (2) consider validating each placement against
  context BEFORE the batch commit (pre-flight), or continue-on-overlap (skip+report the one, keep the
  rest) instead of hard stop; (3) exclude near-now (< N min) slots at solve time (also fixes Finding 4).
  Add regression tests for: overlap-with-context placement, and partial-commit stranding.
- NOTE for Part 6: the partial run wrote real changes (9 moves + 4 placements). Undo must key on the
  resolve_committed summary (287) and reverse exactly those — a good test of undo-of-a-PARTIAL run.

## Part 6 scorecard — undo the PARTIAL re-solve (PASS; mitigates Finding 5)
- Preview correctly targeted only the committed subset (4 placements + 9 moves), not the 6 stranded.
- Undo commit (events 288–301, undoRun 2026-07-31T22:50:45.081Z): 4 `cancelled` (placements→loose) +
  9 `moved` (Yutao nudges reverted) + `undo_committed` {restored:13, undidKind:resolve, skipped:0}.
- restored 13 = exactly the 9 moves + 4 placements that committed; 6 stranded correctly ignored.
- confirmed 153→149 (baseline), pinned 3, uniform undoRun, undo_committed LAST.
- KEY POSITIVE: undo-of-a-partial-run restores cleanly by keying on the honest resolve_committed
  summary. So Finding 5's blast radius is recoverable in one step — significant mitigation.
- State fully restored to the pre-everything baseline (149 confirmed / 3 pinned).
- "Undo again" no-op confirmed (149/3, event still 301, 0 open tokens) — double-undo guard holds.

## Overall summary (Parts 0–6)
PASS: pins, freeze stage/commit/undo, staleness guard, re-solve stage, scope constraint, all stamps
(freezeRun/resolveRun/undoRun uniform), all summary events last, no-auto-pin, double-undo guards,
notifications (per-visit + manager + threshold=3 batching), undo-of-partial-run.

Findings:
1. Unaided dismiss false "already gone" (CONDITIONAL/intermittent — failed once in Part 1 with a
   staled token, worked first-try in Part 4). Medium. Re-check repro conditions.
2. Digest header is threshold-gated (DIGEST_THRESHOLD=3), so ≤3-visit recipients get individual lines,
   not the "The schedule freeze/re-plan updated your schedule:" header — SCRIPT expectation wrong, code
   correct. Fix the acceptance script; to see the header live, give one tech 4+ placements.
4+5. CONFIRMED HIGH: scoped re-solve placed a loose job (Priya tankless) at a day-0 near-now slot
   (TODAY 15:36) ON TOP OF another tech's existing visit (Joy) → commit hit no_confirmed_overlap →
   STOPPED → 6 placements stranded (stop-on-failure). DB constraint prevented an actual double-book
   (good); solver should never propose the overlap, and stop-on-failure is costly. Mitigated by
   undo-of-partial working cleanly. Fixes: day-0 context must include all techs' near-now/in-progress
   visits; pre-flight or continue-on-overlap instead of hard stop; exclude <N-min-from-now slots at
   solve. Add regression tests.

Data-quality (pilot, not feature bugs): hman has NULL telegram_user_id (freeze/resolve placements to
hman are un-notified); 4 loose visits have NULL job.duration_minutes (never auto-place); Maria Gonzalez
Pest is a past-dated orphan; 10–18 existing bookings sit outside working patterns.

## Finding 6 — Part 7 BLOCKED: cron scheduling fails with a gateway pairing error (INFRA, not feature)
- "run the freeze once in 5 minutes as a one-time job" → agent returned a gateway pairing error;
  "⚠️ ⏰ Cron: One-time freeze in 5 min failed". The failed attempt wrote nothing (149/3, event 301,
  0 tokens) — no partial cron state.
- Cron/gateway path, separate from freeze/resolve/undo. Part 7 (scheduled fire = proposal-only, never
  an unattended commit) COULD NOT BE TESTED. Did NOT accept the agent's "run it now" substitute (that
  re-tests Part 2, not the cron ritual).
- ROOT CAUSE (investigated box-side 2026-07-31, ssh tradesbox, openshell-gateway logs): the cron
  feature registers a NEW openshell "device" to run the scheduled job; that device must be approved
  before it can connect. Gateway logs show:
    - "[ws] closed ... reason=pairing required: device is not approved yet"
    - "[ws] ⇄ res ✗ device.pair.approve errorCode=INVALID_REQUEST errorMessage=missing scope: operator.admin"
  i.e. the approve call lacks the `operator.admin` scope, so the device never pairs → cron create fails
  → agent surfaces "gateway pairing error". OpenShell requires a human OPERATOR (operator.admin) to
  approve a new device; the cron device's auto-approve path doesn't have it.
- Active side effect: a retry STORM — 337 failed pair/connect attempts in 20 min (started ~22:45),
  ~17/min, ongoing, won't self-heal. CONTAINED to cron: the 6 sandbox agents are healthy and the full
  E2E worked, so normal agent↔gateway traffic is unaffected. `openshell` CLI has no device/pair
  subcommand (approval is an operator control-plane action, not box-CLI).
- FIX (operator, needs operator.admin): approve the cron device pairing (or grant the auto-approve
  path the operator.admin scope). Separately, stop the stuck device to end the retry storm. Retry
  Part 7 once cron is provisioned. NOT a run_resolve/spine bug — pure OpenShell provisioning gap.

## FINAL STATUS: Parts 0-6 verified (1 HIGH feature bug: Finding 4+5, recoverable via undo). Part 7
## blocked by cron/gateway infra (Finding 6). State restored to baseline 149 confirmed / 3 pinned.

## Finding 6 addendum — s6 restart deep-dive (box-side, ssh tradesbox, read-only)
Investigated what actually caused the gateway "storm" while chasing the cron block. It is NOT caused
by the s7 (Yutao) cron attempt — it is an independent s6 event that happened to overlap in time.

- **s6 restarted at 22:44:57** — a clean, DELIBERATE stop→start (FinishedAt 22:44:57.66 → StartedAt
  22:44:57.78, ~120ms). NOT a crash (ExitCode=0), NOT OOM (OOMKilled=false, box had 12Gi free, no
  kernel OOM), NOT docker restart-policy (RestartCount=0), NOT a roster/binding change (badge-pull
  22:40 & 22:45 both "no change"; bindings-applied.json unchanged since Jul 24). It was a programmatic
  gateway/sandbox restart — but the exact INITIATOR was not found in the logs pulled (honest gap;
  candidates: revive supervisor cycling, or an out-of-band openshell/nemoclaw restart).
- **On restart s6 came back DEGRADED on BOTH channels** (gateway startup log 22:46:29):
  - Management channel (ws :18789): an internal client (s6's own openclaw, 10.200.0.2) hit
    "pairing required: device is not approved yet" (code 1008); auto-approve failed
    "missing scope: operator.admin". Device never approved → management/config/cron channel DOWN.
  - Task channel: "[telegram] bridge did NOT start within 15s" — s6's bot (@ragisan2_bot) may be
    DEAF to its tenant. (The classic container-restart→degraded-agent trap the boot-revive service
    exists to fix; here the revive ran but did NOT fully heal s6.)
  - Config contradiction to flag: gateway.controlUi.dangerouslyDisableDeviceAuth=true is SET, yet
    device pairing is still required+rejected → the flag doesn't cover the management ws, or s6's
    device-pair state is inconsistent post-restart (v0.0.71 device-pair plugin).
- **The "storm" = 455 failed reconnect attempts** on :18789 (287 "pairing required" + 166
  "connect failed" + 32 approve-scope-fails), 22:45 → 23:10:57 (~26 min), then it GAVE UP (0 since;
  did NOT recover — s6 management channel still 1006 as of this investigation).
- **Token cost of the storm: ZERO.** Every attempt was a WebSocket handshake rejected BEFORE connect
  ("closed before connect") — never reached a model turn, no system prompt, no inference. Cost was
  CPU + network + log volume only.
- **Open live-ops item (independent of the E2E):** s6 may be a degraded/deaf agent RIGHT NOW (mgmt
  channel down + bridge failed to start). Worth checking s6's current bridge state and recovering it
  (nemoclaw s6 gateway restart is the documented residue-clear, but risks re-triggering the retry
  loop if the operator.admin approval gap persists). Not run — left for operator decision.

## E2E WRAP-UP (2026-07-31)
- Testing complete except Part 7 (cron ritual), which is infra-blocked (Finding 6) — untestable until
  cron device pairing is provisioned (needs operator.admin). Nothing in Part 7 is a run_resolve defect.
- Pilot state: clean baseline (149 confirmed / 3 pinned / 0 open tokens); nothing drifted during the
  box/cron investigation (all read-only).
- Feature verdict: run_resolve / undo_run core is SOLID. One bug blocks a clean wider rollout —
  Finding 4+5 (day-0 near-now placement overlaps an existing visit → partial-commit stranding;
  recoverable via undo). Recommend fixing via RPI (touches the solver) before rollout.
- Recommended follow-ups: (1) fix Finding 4+5; (2) provision cron operator.admin approval for Part 7;
  (3) check/recover s6 (possible deaf agent) — a live-ops item separate from this feature.
