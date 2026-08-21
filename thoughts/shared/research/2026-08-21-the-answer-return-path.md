---
date: 2026-08-21
branch: feat/planner-phase-4-closeout
commit: 8be0d91
topic: The answer return path — seat-agent channel, capture-time funnel, and escalation copy
---

## Summary

The system can *ask* a technician a question, but it cannot *hear* the answer. A question is
written by the spine (the shared record system on Render), handed to a small shell script on the
remote box (`nudge-runner.sh`), and injected into the technician's own AI assistant — the "seat
agent" — which then asks the technician over Telegram. Everything after that is one-way. The
runner throws away whatever the agent says (`>/dev/null 2>&1`), and the only thing it is allowed
to send home is one of two words, `delivered` or `failed`, plus a fixed English string chosen from
a short list in the script itself. The spine runs no Telegram listener at all, so a technician's
reply exists in exactly one place: a `.jsonl` transcript file inside the sandbox on the box, which
nothing reads and which is expected to age out in about thirty days. For the reply to become part
of the company record, the seat agent must *voluntarily* decide to call a spine tool — and the two
tools it would reach for behave completely differently. `record_money_event` is one shot: call it
and a money row exists immediately, with no confirmation and no link back to any evidence.
`record_field_note` is two-step: the first call stages a preview and writes **nothing**, and only a
second call carrying the preview's `confirmId` — after the technician says yes — writes the L1 raw
capture. That asymmetry is the whole explanation of the 2026-08-19 specimen: one Telegram message
answered two gaps, the money half committed in one call, and the note half stopped at the offer.
Downstream, the "team-lead planner" (a model call that runs once per firm per 30 minutes and
decides pacing, closure and escalation) infers what happened purely from rows appearing in the
database — and the 5-minute sweep that runs before it uses a *looser* definition of "answered"
than the planner's own instructions do, so the sweep almost always closes the gap first. When
nothing lands and a gap escalates, the manager gets a sentence assembled from a hardcoded
template: it asserts the technician "hasn't heard back" and that "nothing is on the job's record
yet" without checking either claim, even though the code that calls it is holding the facts that
would settle them.

---

## Entry Points

| Entry point | File:line | Cadence / trigger |
|---|---|---|
| Lifecycle heartbeat (the ONE scheduled entrypoint, Render Cron) | `src/jobs/lifecycle.ts:117` (`runLifecycle`), `main()` at `:437` | `*/5 * * * *` |
| Step 8 — watcher + sweep (detect, auto-resolve, escalate, expire) | `src/jobs/lifecycle.ts:297-334` → `src/jobs/watchers.ts:237` (`runWatchers`) | EVERY tick (5 min) |
| Step 9 — team-lead planner (the pacing/closure model call) | `src/jobs/lifecycle.ts:335-385` → `src/teamLead/planner.ts:600` (`runPlanner`) | `getUTCMinutes() % 30 < 5` (`lifecycle.ts:352`) — :00 and :30 |
| Step 10 — compose (writes the one question) | `src/jobs/lifecycle.ts:386-402` → `src/teamLead/compose.ts:147` (`runTeamLeadCompose`) | EVERY tick, gated on `NUDGES_MODE='live'` |
| Box pulls queued questions | `GET /control/nudges` → `src/mcp/httpServer.ts:530-533` → `:265` (`handleNudgePull`) → `src/control/nudgeQueue.ts:63` (`buildNudgeDelivery`) | box timer, 5 min |
| Box reports delivery | `POST /control/nudges` → `src/mcp/httpServer.ts:534-537` → `:289` (`handleNudgeReport`) → `src/control/nudgeQueue.ts:122` (`completeNudgeDelivery`) | per item, after each delivery attempt |
| Box-side runner (the actual delivery) | `Box_Setup_Stuff/nudge-runner.sh` (systemd timer, every 5 min, runs as root) | 5 min |
| Technician's agent writes to the record | MCP dispatch `src/mcp/server.ts:2105` (`switch (name)`), `record_field_note` at `:2106`, `record_money_event` at `:5443` | only when the agent chooses to call |
| Manager reads the escalation | `list_pending_reviews` → `src/mcp/server.ts:6815`; plus one count-only Telegram push `src/jobs/watchers.ts:907-930` → `src/calls/notify.ts:11` | on demand / per tick |

---

## Key Files

**The ladder**
- `src/jobs/watchers.ts` — the deterministic detector + the whole in-flight sweep (auto-resolve,
  escalate, expire). 939 lines.
- `src/jobs/nudgeKinds.ts` — the kind registry. Holds `filled` / `moot` / `itemResolved` /
  `handoff` per gap kind. **The escalation copy lives here** (`:258-262`, `:346-348`).
- `src/teamLead/compose.ts` + `src/teamLead/composeCopy.ts` — the one model call that writes the
  question, and the code-owned frame around it (evidence line + the "Note for the assistant"
  footer).
- `src/teamLead/planner.ts` + `src/teamLead/plannerPrompt.ts` — the 30-minute pacing/closure call
  and its rails.
- `src/control/nudgeQueue.ts` — the spine half of the transport.
- `src/mcp/httpServer.ts:262-340` — the two HTTP endpoints the box talks to.
- `Box_Setup_Stuff/nudge-runner.sh` — the box half of the transport.

**The record**
- `src/db/rawCaptures.ts` — `appendRawCapture` (`:33`, the ONLY L1 insert),
  `listJobStampedCaptureTimes` (`:171`, the sweep's activity probe),
  `listJobEvidenceSince` (`:259`, the planner's evidence read).
- `src/writePath/recordFieldNote.ts` — L1 → extract → match → L2 (`:100-291`).
- `src/mcp/server.ts:2106-2346` — the two-step staged confirm for `record_field_note`.
- `src/mcp/server.ts:5443-5524` — the one-shot `record_money_event`.
- `src/db/nudges.ts`, `supabase/migrations/20260817090000_nudges.sql` — the nudge row and its
  lifecycle.
- `src/db/nudgeDecisions.ts`, `supabase/migrations/20260820120000_nudge_decisions.sql` — the
  planner's memory.
- `src/db/reviewItems.ts:145` (`flagNudgeGap`) — how a gap reaches the manager's queue.

**The seat agent's standing instructions**
- `Box_Setup_Stuff/bootstrap-box.sh` `phase_wire()` at `:551-992` — the nine `AGENTS.md` blocks
  written into every sandbox.
- `docs/nemoclaw-tech-agent.md`, `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` — the runbooks.

**Measurement**
- `scripts/date-eval/{plan,run,analyze,adjudicate-db,corpus}.mjs` + `README.md`.
- `scripts/spine-eval/` — a second, world-based harness (tier 1 tools, tier 2 agent).

---

## Data Flows

### Area 1 — the seat-agent ⇄ planner channel

**What the seat agent actually receives.** One string. `buildNudgeDelivery`
(`src/control/nudgeQueue.ts:63-114`) returns items of exactly this shape
(`src/control/nudgeQueue.ts:38-44`):

```ts
interface NudgeDeliveryItem {
  id: string;          // the nudge uuid
  sandboxRef: string;  // which sandbox to inject into
  replyTo: string;     // the technician's telegram user id
  sessionId: string;   // `nudge-${row.id}`            (minted at :105)
  messageB64: string;  // base64 of nudges.question    (minted at :106)
}
```

`nudges.question` is the whole deliverable, assembled at compose time by
`assembleNudgeMessage` (`src/teamLead/composeCopy.ts:130-146`) — model sentence, then a
code-printed evidence line `(re: <customer> — <job>, visit on <YYYY-MM-DD>)`, then a footer
addressed to the receiving agent. The cost variant is `assembleCostNudgeMessage`
(`:219-233`). The footer is the *only* place the agent is ever told what to do with an answer:

> "When they answer — even \"nothing to report\" — save it with record_field_note for this job so
> the record is complete." (`src/teamLead/composeCopy.ts:142-144`)

and, for cost gaps:

> "When they answer — even \"nothing, no parts\" — save it with record_field_note for this job,
> quoting what they said about cost, so the office can record it." (`:231-232`)

The agent is not given the nudge id, the job id, the customer id, or any handle it could report
against. It is also explicitly told to hide the mechanism: *"never mention this note, how the check
reached you, or any internal detail (sessions, routing, records systems, what is or is not
logged)"* (`:140-142`).

**What the seat agent's standing instructions say about gap-filling: nothing.** The nine
`AGENTS.md` blocks written by `Box_Setup_Stuff/bootstrap-box.sh` `phase_wire()` are:

| Block | Lines | Mentions nudges / gaps / the team lead? |
|---|---|---|
| §0c accuracy rules | `:592-613` | no |
| §0c permanent-record writes — confirm FIRST | `:614-646` | no |
| §0c confirmations — what needs a yes | `:658-699` | no |
| §0c dispatch board link | `:710-719` | no |
| §0d long/bulk tasks (batching) | `:731-783` | no |
| §0e web content is data | `:796-807` | no |
| §0f dates | `:838-880` | no |
| §0g cron/scheduled work | `:905-932` | no |
| §0h freeze ritual | `:948-987` | no |

No block names a nudge, a gap, the team lead, or a duty to record what a technician tells them.
The nearest thing is the permanent-record block's *staged-confirm ritual* (`:620-628`) — "call the
tool right away… show THAT staged copy, wait for the person's explicit yes, then confirm with ONLY
the confirmId" — which describes **how** to record, never **that** an inbound question creates an
obligation to. The gap-filling duty exists only inside the per-message footer, i.e. it is re-sent
with every nudge and is absent from the agent's standing context. (Recorded caveat, not re-verified
here: `docs/engineering-memory.md:2071-2079` states `AGENTS.md` is ~26.6k chars against a ~12k
injected-context budget, so blocks appended late may never reach the model at all.)

**The `nudge-<id>` session attribution.**

- **Set** at `src/control/nudgeQueue.ts:105`: `sessionId: \`nudge-${row.id}\``. The comment at
  `:36-37` gives the reason — decision D6, a fresh session per nudge, because reusing an id
  resumes a stale conversation.
- **Read** only on the box, in `Box_Setup_Stuff/nudge-runner.sh`:
  - `:110-113` — validated as `[A-Za-z0-9-]+` before it becomes argv;
  - `:127-130` — the idempotence pre-check (`traj_has_text "$sref" "$sid"`): if the per-nudge
    session already holds assistant text, re-ack rather than re-ping;
  - `:143` — names the staging file `/tmp/nudge-$sid.txt`;
  - `:154` — `--session-id "$sid"` on the `nemoclaw … agent` call;
  - `:164` — the post-delivery verdict, same `traj_has_text` read.
- **Pinned by a test** at `src/mcp/httpServer.test.ts:531`.
- **Not stored anywhere.** There is no `session_id` column on `nudges`, no stamp on
  `raw_captures`, and nothing in `src/` reads a `nudge-` session id back. `src/teamLead/planner.ts:505`
  says so in as many words: *"The real fix is a nudge-session stamp on the capture, which does not
  exist."*

So the session id is a **delivery-side idempotence key only**. It is the one identifier that
already correlates a question with the conversation that answered it, and no spine-side code
consumes it.

**Every mechanism by which information flows FROM the seat agent BACK toward the spine.**

1. **The delivery report — two words and a fixed string.**
   `Box_Setup_Stuff/nudge-runner.sh:64-70` defines `report()`, whose own comment reads
   `# $1 id, $2 outcome, $3 fixed detail string (NEVER interpolated output)`. Every call site uses
   a literal: `"invalid sandboxRef"` (`:103`), `"invalid replyTo"` (`:107`), `"invalid sessionId"`
   (`:111`), `"message decode failed"` (`:115`), `"empty message"` (`:118`),
   `"could not stage message in sandbox"` (`:147`), `"agent CLI exited non-zero or timed out"`
   (`:157`), `""` on success (`:128`, `:165`), `"no assistant text in trajectory"` (`:167`).
   The spine side enforces the vocabulary: `src/mcp/httpServer.ts:327-330` rejects anything that is
   not `'delivered' | 'failed'`; `detail` is read at `:331` and, on the `delivered` path, is
   **never used** — `completeNudgeDelivery` (`src/control/nudgeQueue.ts:139-142`) calls
   `markNudgeAsked` and returns. `detail` only survives on the *failure* path, truncated to 300
   chars into `nudges.resolution` (`src/control/nudgeQueue.ts:153-158`).

2. **The delivery call's output is discarded.** `Box_Setup_Stuff/nudge-runner.sh:153-159`:

   ```bash
   if ! timeout 240 sudo -u "$NEMOCLAW_USER" -H "$NEMOCLAW_BIN" "$sref" agent \
       --agent main --session-id "$sid" --message-file "$msgfile" \
       --deliver --reply-channel telegram --reply-to "$reply_to" \
       </dev/null >/dev/null 2>&1; then
   ```

   `>/dev/null 2>&1` — the agent's stdout and stderr go nowhere. Only the exit status is read.

3. **The trajectory is read, but only for a boolean.** `traj_has_text()`
   (`Box_Setup_Stuff/nudge-runner.sh:79-90`) `cat`s
   `/sandbox/.openclaw/agents/main/sessions/<sid>.jsonl` inside the sandbox, pipes it through `jq`,
   and counts assistant messages with non-empty `type:"text"` content. The return value is
   `[ "${n:-0}" -gt 0 ]` — a shell exit code. **The text itself is never sent home.** This is the
   single richest signal in the whole loop and it is reduced to one bit.

4. **There is no inbound Telegram path into the spine.** `src/telegram/boardBot.ts:1-5`:
   *"Thin Bot API wrappers for the BOARD bot — one global, plain-code (non-AI) bot owned by Render.
   No update listener exists on purpose."* A grep for `getUpdates` / `setWebhook` /
   `update.message` across `src/telegram/` returns nothing. The technician talks to a *different*
   bot, on the box, whose messages the spine never sees.

5. **The only other box→spine routes carry no reply content.** `GET /control/badges`
   (`src/mcp/httpServer.ts:519`), `POST /control/sandboxes` (`:524`, recycle completion),
   `POST /control/ops` (`:542`, service health → `ops_events`). None of them can carry conversation.

6. **The spine's MCP surface is a *pull*, not a push.** The agent reaches the spine through the
   doorman → Render MCP relay when it decides to call a tool. That is a request the agent
   initiates; there is no callback, and a tool call writes no L1 capture of itself
   (`docs/engineering-memory.md:431-434` records this: "Spine reads write no L1 capture").
   Only a `cost_events` row with `sku='tool_call'` and `metadata.tool` is written, at
   `src/mcp/server.ts:2037-2047` — name, tenant, caller, timestamp; no arguments, no results, no
   link to a gap.

**Conclusion, stated as the absence it is:** the planner learns about an answer only by observing
rows appear. There is no back-channel of any kind carrying content, and the design says so
deliberately — `supabase/migrations/20260817090000_nudges.sql:5-9`:

> "the outreach itself is deliberately NOT L1-captured (user-ratified 2026-08-16 — L1 is
> undeletable and the 2026-07-04 outbound exception does not extend by analogy), so this table must
> carry the whole story. **The technician's REPLY takes the normal record_field_note path and needs
> nothing here.**"

The last sentence is the assumption the return path rests on. Area 2 is what happens when it does
not hold.

---

### Area 2 — the capture-time funnel

**Every path by which a technician's Telegram reply can become a durable row.**

| # | Target row | Trigger | What the agent must actively DO | Where it silently produces nothing |
|---|---|---|---|---|
| 1 | `raw_captures` (L1) + `visits` + possibly `jobs.status` | `record_field_note` | **TWO calls.** Call 1 with `text` → stages a `pending_field_note` review item and returns `needs_confirmation` (or `needs_identity`) with a preview; **writes nothing.** Show the preview, get an explicit yes, call 2 with `confirmId` ALONE. | Agent stops after call 1 (or after merely *offering*, never calling). Staged item expires after 15 min (`src/mcp/server.ts:2240-2249`) and is dismissed. |
| 2 | `raw_captures` + `customers.attributes` or `jobs.attributes` | `record_standing_fact` | Same two-step staged confirm; L1 append at `src/mcp/server.ts:3388-3397`, channel `technician_note`. | Same — no confirm, no rows. |
| 3 | `money_events` | `record_money_event` | **ONE call.** No staging, no confirmation (`src/mcp/server.ts:5473-5490`). Manager tier only. | Technician-tier badge: refused at `src/mcp/server.ts:2083-2085`. |
| 4 | `raw_captures` (channel `outbound_email`) | `send_email` (two-step staged) | Confirm the send; the L1 capture is a *side effect* of a successful send (`src/mcp/server.ts:2848-2870`), classifier-free by the 2026-07-04 recorded exception. | Not a reply-capture path at all — it records what the agent *sent*, not what the technician *said*. |
| 5 | `raw_captures` (channel `retraction`) | `retract_capture` (two-step staged) | Confirm; append at `src/mcp/server.ts:2995-3008`. | n/a |
| 6 | `raw_captures` (channel `agent_action`) | Composio execution-log ingestion, `src/composio/logIngest.ts:137` | **Nothing** — automatic, on the 15-minute lifecycle tick (step 4). | Only covers **Composio** tool executions (Gmail sends etc.), never spine tools and never chat. Non-send captures store argument KEY NAMES only. |
| 7 | `raw_captures` | Inbound email — Composio webhook (`src/inbound/webhook.ts:257`) or Gmail pull (`src/email/ingest.ts:106`) | **Nothing** — automatic. Gated by the work/personal classifier BEFORE the insert (`src/email/classify.ts`, imported at `src/inbound/webhook.ts:11-12` and `src/email/ingest.ts:5`). | Not a Telegram path. |
| 8 | `raw_captures` + `review_items` | Inbound phone call (`src/calls/worker.ts:127`) | **Nothing** — automatic. | Not a Telegram path. |
| 9 | `review_items` | Watcher escalation / expiry / fallback (`src/jobs/watchers.ts:613`, `:661`, `:791`) | **Nothing** — automatic. This is a row *about* the gap, never a row carrying the answer. | n/a |

**There is no automatic path at all for a Telegram reply.** Paths 6-8 are the automatic ones and
none of them touches chat. Paths 1-3 all require the agent to decide, unprompted by its standing
instructions, to make a tool call.

**Why the 2026-08-19 specimen produced a money row and no capture.** Reading the two dispatch
bodies side by side:

- `record_money_event` (`src/mcp/server.ts:5443-5524`). Validates args, then at `:5479` calls
  `appendMoneyEvent(...)` **immediately**. The comment at `:5473-5474` states the rule:
  *"One-shot by doctrine: a ledger row is reversible via correction/void, so no staging."* The row
  is committed on the first call. Note also that `AppendMoneyEventInput` has a `sourceCaptureId`
  field (`src/db/moneyEvents.ts:64`) and the dispatch **does not pass it** — so a money row created
  this way carries no evidence link to any capture, by construction.
- `record_field_note` (`src/mcp/server.ts:2106-2346`). With no `confirmId`, the branch at `:2128`
  runs an extraction and an identity match, upserts a `pending_field_note` review item, and returns
  either `{status:'needs_identity', …, note:'Nothing was recorded. …'}` (`:2179-2185`) or
  `{status:'needs_confirmation', confirmId, preview, note:'Nothing was recorded yet. Show the
  technician exactly this preview; on their explicit yes call again with ONLY confirmId.'}`
  (`:2187-2192`). The L1 append only happens on the FINAL CONFIRM branch (`:2291-2318` →
  `recordFieldNote` → `appendRawCapture` at `src/writePath/recordFieldNote.ts:141`).

So a single Telegram message answering both gaps hits two tools with opposite commit semantics.
The money half is durable after one call. The note half is a *proposal* the agent must then carry
through a show-preview → explicit-yes → second-call ritual. An agent that "offered to record a
field note" was doing exactly what the tool told it to do and then stopped — or never called the
tool at all, which the AGENTS.md permanent-record block explicitly forbids ("Do NOT ask your own
'shall I?' … BEFORE calling the tool — stage FIRST, always", `bootstrap-box.sh:624-626`) but which
nothing enforces.

**Where a reply silently produces nothing — the complete list.**
1. Agent never calls any tool (the reply is conversational only). No row, no log, no signal.
2. Agent calls `record_field_note` once and stops at the preview. A `pending_field_note` review
   item exists for 15 minutes and is then superseded or expires — it is **not** a nudge answer and
   the sweep does not read it.
3. Agent gets `needs_identity` and never resolves the customer. Same outcome.
4. The 15-minute staging TTL elapses between preview and confirm (`src/mcp/server.ts:2240`).
5. The badge is technician tier and the answer is a money fact — `record_money_event` is refused
   at `src/mcp/server.ts:2083-2085` and the only fallback is a prose note (this is stated as an
   accepted limitation at `src/jobs/nudgeKinds.ts:280-283`).
6. The capture lands but on the wrong job. `hasActivitySince` is keyed on the job id, so an answer
   attached elsewhere is invisible to the gap.
7. The reply lands as `sensitivity: 'manager_only'` — dropped from the planner's evidence read at
   `src/db/rawCaptures.ts:331`.

**How the append-only / classify-before-insert rule interacts with capturing a reply.**
`CLAUDE.md` requires any work/personal classification to gate the L1 insert, because L1 has no
delete path. Today:

- The classifier (`src/email/classify.ts`) is wired into **inbound email only** — `webhook.ts` and
  `email/ingest.ts`. There is no classifier on the technician-note path, because the technician-note
  path is already gated by a *human*: the two-step confirm is the gate. The technician sees the
  preview and says yes; that consent is what stands in for the classifier.
- `raw_captures` is insert-only in code (`src/db/rawCaptures.ts:31-32`, "This module exposes insert
  only — no update or delete") and by DB trigger.
- Consequence for any future auto-capture of a Telegram reply: it would be a *new inbound category*
  and would therefore need a hard work-relevance gate before the insert. That is exactly what the
  ratified transcript-harvest decision says (below), and it is why no such path exists yet.

**Transcript harvest — status: PLANNED, with its constraints ratified; NOTHING BUILT.**
A grep for `harvest` across `src/`, `scripts/`, `Box_Setup_Stuff/` returns **zero hits in code**.
The only mentions are in prose:

- `docs/engineering-memory.md:68-72` — *"Transcript-harvest disclosure ratified (2026-08-15):
  workers must be told up front that chats with their company-provided agent can be recorded to the
  firm's record (extends the 2026-07-04 outbound-send disclosure); the work-relevance classifier
  gates HARD before anything harvested reaches L1 — no contamination of the spine with non-work
  context, no new exception to classify-before-insert."*
- `docs/engineering-memory.md:1010-1011` — *"harvest by reading transcripts, never by asking the
  agent to remember … anything un-harvested has a ~30-day shelf life."*
- `thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md:68-69, 110, 154-156` — the
  direction and the open questions (disclaimer wording, delivery moment, where harvested facts
  land).
- `thoughts/shared/research/2026-08-15-feature-B-intelligent-spine-stage-1-team-leader-voice.md:595-597`
  — notes that a harvest route would bypass `record_field_note`'s preview→confirm ritual.

---

### Area 3 — escalation copy that asserts unchecked claims

**Where the text is produced.** It is a **pure template string**, not a model call. There is no
model anywhere on the escalation path.

`src/jobs/nudgeKinds.ts:230-264`, `OVERDUE_VISIT_GAP_SPEC.handoff`, `mode === 'escalated'`:

```
`${techName}'s assistant asked about the '${title}' visit (${customer}) on ` +
`${wallClockLabel(naiveLocal(n.asked_at))} and hasn't heard back — ` +
`nothing is on the job's record yet. Worth a direct word so it gets closed out. ` +
`If it's already handled, just dismiss this.`
```
(`:258-262`)

The cost twin, `JOB_COST_GAP_SPEC.handoff`, `:346-348`:

```
`${techName}'s assistant asked what the '${title}' job (${customer}) cost in parts ` +
`and materials and hasn't heard back — the job's costs are still incomplete. Worth ` +
`a direct word so it can be recorded. If it's already handled, just dismiss this.`
```

Called from `src/jobs/watchers.ts:656` (`spec.handoff(x.n, 'escalated', naiveLocal)`), written to
`review_items.suggestion` via `flagNudgeGap` (`src/jobs/watchers.ts:661-671` →
`src/db/reviewItems.ts:170-184`), and returned verbatim to the manager's agent by
`list_pending_reviews` (`src/mcp/server.ts:6815-6820` — items of kinds other than the staged-plan
tokens are returned unmodified). The `'expired'` mode uses different copy (`stage0Suggestion`,
`src/jobs/nudgeKinds.ts:151-159`) which deliberately does **not** claim anyone was asked.

**Claim-by-claim: code-computed vs template assumption.**

| Claim in the copy | Source | Verified against data? |
|---|---|---|
| `${techName}` | `n.context.technicianName`, watcher-written at `src/jobs/watchers.ts:777` | yes (data, from the roster at detection time) |
| `'${title}' … (${customer})` | `n.context.jobTitle` (`src/jobs/watchers.ts:775`) / `customerName` (`:774`) | yes (data, snapshotted at detection time — could be stale) |
| "asked … on `<wallClockLabel(naiveLocal(n.asked_at))>`" | `nudges.asked_at`, set by `markNudgeAsked` (`src/db/nudges.ts:197-208`) only on a `delivered` report | yes — this is the one fully code-computed claim. Note it means "the box reported delivery", i.e. assistant text existed in the session; it does not mean the technician read it. |
| "**and hasn't heard back**" | **HARDCODED.** Nothing is read. | **NO.** There is no reply-side datum in the system (Area 1). The nearest proxy is that `spec.filled()` returned null, which tests *the job's record*, not whether a person answered. |
| "**nothing is on the job's record yet**" (visit kind) | **HARDCODED.** | **NO.** The nearest code-computed fact is `hasActivitySince(jobId, startsAtLocal) === false` — but that only means "no job-stamped `raw_captures` row and no new `visits` row since the visit start". |
| "the job's costs are still incomplete" (cost kind) | **HARDCODED.** | **NO.** The escalation path never consults the ledger, even though `facts.jobsWithCostEvents` is built two dozen lines earlier. |

**What "nothing is on the job's record" actually excludes.** `hasActivitySince`
(`src/jobs/watchers.ts:441-442`) is a lookup into `latestByJob`, built at `:402-436` from exactly
two readers:

- `listJobStampedCaptureTimes` (`src/db/rawCaptures.ts:171-197`) — `raw_captures` rows whose
  `job_id` is set;
- `listVisitTimesForJobs` (`src/db/visits.ts:42-65`) — `visits.created_at`.

Everything else is invisible to it, including:

- `money_events` — a payment or a material cost recorded against the job. This is the money
  blindness the 2026-08-20 specimen demonstrated: a $500 `payment_received` on the job is
  unambiguously "on the job's record" and the sweep cannot see it.
- `jobs.attributes` / `customers.attributes` (L3 standing facts) — although the standing-fact write
  path *does* append an L1 capture with a `jobId` stamp when the target is a job
  (`src/mcp/server.ts:3388-3397`), so that particular case is covered incidentally.
- `review_items` — including the manager's own resolutions.
- `nudge_decisions` — the planner's own history, including a prior `escalate` with a reason.
- `raw_captures` rows with `job_id` NULL and no minted visit.

**What was in hand and unused at the moment the copy is generated.** In `runWatchers`, the
escalation loop (`src/jobs/watchers.ts:654-694`) has the following in lexical scope:

- `facts: SweepFacts` (`:513-519`) — `hasActivitySince`, `visitStatusById`, `jobStatusById`,
  `naiveLocal`, and `jobsWithCostEvents`;
- `latestByJob` (`:402`) — the actual *timestamp* of the latest activity per job, not just a
  boolean;
- `jobStatusById` (`:494-500`) and `statusById` (`:480-482`) — real current statuses;
- the nudge row itself: `asked_at`, `serve_count`, `attempts`, `question`, `context`, `created_at`,
  `escalate_after`.

None of it reaches the copy. `NudgeKindSpec.handoff`'s signature
(`src/jobs/nudgeKinds.ts:138-142`) is `handoff(n, mode, naiveLocal?)` — **it takes the nudge and a
timezone formatter, and no facts at all.** That is the structural reason the template cannot check
its own claims: the function that writes the sentence is not given the data.

**Two ways to reach this same copy.** (1) The sweep's own 24h/`escalate_after` deadline
(`src/jobs/watchers.ts:576-585`). (2) The planner deciding `escalate`, which does *not* write the
item itself — `applyDecision` (`src/teamLead/planner.ts:585-586`) sets `escalate_after = now` and
lets the sweep perform the handoff on a later tick. The planner's own `reason` (its actual
judgment, e.g. "End of business — a manager should follow up directly") is written to
`nudge_decisions` (`src/teamLead/planner.ts:825`) and **never reaches the manager**. The manager
always sees the template.

---

### The ask → reply → record → planner loop, and where it breaks

```
 ── ASK ──────────────────────────────────────────────────────────────────────────►

  watcher, step 8              compose, step 10            box runner (systemd, 5m)
  every 5 min                  every 5 min, 7am-7pm        Box_Setup_Stuff/nudge-runner.sh
  watchers.ts:237              compose.ts:147
        │                            │                              │
   nudges row                   ONE model call                  GET /control/nudges
   status='pending'    ──────►  writes 1 sentence   ──────►     {id,sandboxRef,replyTo,
   context={job,cust,           + code frame                     sessionId:"nudge-<id>",
   tech,startsAt,ends}          status='queued'                  messageB64}
                                                                      │
                                                                      ▼
                                                     nemoclaw <sandbox> agent --deliver
                                                       --session-id nudge-<id>
                                                       --message-file /tmp/nudge-<sid>.txt
                                                                      │
                                                     POST {id, outcome:"delivered", detail:""}
                                                                      │
                                                              nudges.status='asked'
                                                              nudges.asked_at=now

  ┌──────────────────────── the seat agent, inside the sandbox ────────────────────────┐
  │  SEES: the message body only — question + "(re: …)" + "Note for the assistant: …"  │
  │  ITS AGENTS.md: nine blocks, none of which mentions a nudge, a gap, or a duty      │
  │                 to record an answer  (bootstrap-box.sh:551-992)                    │
  │  DOES: asks the technician on Telegram, through its OWN bot                        │
  └────────────────────────────────────────────────────────────────────────────────────┘
                                       │
                    technician replies — to the box's bot, in Telegram
                                       │
  ══════════════════════════════ ✂ THE BREAK ✂ ══════════════════════════════════════
   • the spine runs NO Telegram listener            boardBot.ts:1-5
   • the runner discards the agent's output         nudge-runner.sh:153-159  >/dev/null 2>&1
   • the trajectory IS read — reduced to one bit    nudge-runner.sh:79-90    traj_has_text
   • the only channel home is a 2-value enum        httpServer.ts:327-330
     + a FIXED string chosen from 9 literals        nudge-runner.sh:64-70
   • nothing stamps the reply with nudge-<id>       planner.ts:505 "does not exist"
  ═══════════════════════════════════════════════════════════════════════════════════
                                       │
                the agent must VOLUNTARILY call a spine tool. Two shapes:
                                       │
        ┌──────────────────────────────┴───────────────────────────┬─────────────────┐
        ▼                                                          ▼                 ▼
  record_field_note(text)                             record_money_event(...)   nothing
  server.ts:2128-2192                                 server.ts:5443-5524       happens
  ── STAGES ONLY. writes NOTHING. ──                  ── ONE SHOT. commits. ──       │
  returns needs_confirmation + confirmId                money_events row             │
        │  agent shows preview                         NO raw_capture                │
        │  technician says "yes"                       NO sourceCaptureId link       │
        ▼  second call, confirmId alone                manager tier only             │
  server.ts:2291-2345 → recordFieldNote                                              │
  raw_captures INSERT  (recordFieldNote.ts:141)                                      │
  visits INSERT        (recordFieldNote.ts:267)                                      │
  jobs.status maybe    (recordFieldNote.ts:284-288)                                  │
        │                                                     │                      │
        ▼                                                     ▼                      ▼
  sweep sees it: hasActivitySince(job, visitStart)      sweep does NOT see it   reply dies in
  watchers.ts:441 → nudgeKinds.ts:186                   (money ≠ "activity")    the .jsonl,
  → status='answered' within ~5 min                      gap stays open         ~30d shelf life
        │
        ▼
  planner, step 9, every 30 min  (planner.ts:600)
    reads listJobEvidenceSince (rawCaptures.ts:259) — job-stamped captures
      + captures reachable via visits.source_capture_id, filtered after asked_at
    reads jobsWithCostEvents for cost gaps → the "THE RECORD:" line
    → but the sweep, six ticks earlier, has usually already closed the gap
```

---

## External Dependencies

- **OpenClaw / NemoClaw gateway on trades-box-1** — `nemoclaw <sandbox> agent --deliver
  --reply-channel telegram --reply-to <id>`. `--deliver` runs on the gateway and fires the outbound
  plugin hooks (weekday guard included), so the agent's reply reaches the technician's Telegram
  (`Box_Setup_Stuff/nudge-runner.sh:17-20`). `openshell sandbox exec` **rejects any argv containing
  a newline**, which is why the message body is staged to a file inside the sandbox and passed with
  `--message-file` (`:132-149`, live-proven 2026-08-18).
- **Session trajectories** at `/sandbox/.openclaw/agents/main/sessions/<sid>.jsonl` inside each
  sandbox — the only durable home of a technician's actual words. Read over
  `ssh → nemoclaw exec` (never `docker exec`; the gateway port lives in a nested netns,
  `Box_Setup_Stuff/nudge-runner.sh:22-23`).
- **Telegram Bot API** — two distinct bots: the technician's per-person agent bot on the box
  (inbound + outbound, invisible to the spine), and the spine's global BOARD bot
  (`src/telegram/boardBot.ts`, outbound push + Mini App menu button only, no update listener).
- **Render** — the web service (`src/mcp/httpServer.ts`) and the `*/5` cron
  (`src/jobs/lifecycle.ts`). Render guarantees at most one concurrent cron run.
- **Supabase / PostgREST** — every DB read/write. The silent 1000-row cap is why the listers page.
- **Inference provider (GLM-5.2 via Fireworks router as of 2026-08-15)** — compose
  (`maxTokens: 300`, `reasoningEffort: 'none'`, `src/teamLead/compose.ts:227-237`) and the planner
  (`PLANNER_MAX_TOKENS = 8192`, `PLANNER_REASONING = 'low'`, `src/teamLead/planner.ts:138-139`).
- **Composio** — the connector layer; `src/composio/logIngest.ts` is the only automatic L1 writer
  for agent actions, and it covers Composio executions only.

---

## Constraints and Invariants

1. **L1 is append-only, insert-only.** `src/db/rawCaptures.ts:31-32` plus a DB trigger. Any
   filtering must gate the insert, never follow it (`CLAUDE.md`). Consequence for this topic: you
   cannot capture-then-filter a technician's chat.
2. **The nudge's outreach is deliberately NOT L1-captured.**
   `supabase/migrations/20260817090000_nudges.sql:5-9` — the `nudges` table is the whole audit, and
   the reply "takes the normal record_field_note path".
3. **Ask once per subject, EVER.** `uq_nudges_subject_ever` (migration `:55-56`), non-partial on
   purpose. A gap that closes wrongly can never be re-asked.
4. **The team-lead identity may only read/ask.** `src/mcp/server.ts:2062-2064` caps the entire
   `spine:` namespace to `TEAM_LEAD_TOOL_NAMES` (`src/teamLead/identity.ts:22-30`), deny-by-default.
   The planner therefore *cannot* record an answer even if it could see one.
5. **The planner never acts directly.** It writes only `not_before` / `escalate_after` via
   `setNudgeSchedule`, or closes via `markNudgeOutcome`; escalation is delegated to the sweep
   (`src/teamLead/planner.ts:565-598`, `src/db/nudges.ts:236-282`).
6. **Assert-only-cited.** A `close` on `basis: 'evidence'` is refused unless the quote appears,
   normalised, in the exact truncated text the model was shown
   (`src/teamLead/planner.ts:490-511`; `MIN_CITATION_CHARS = 12`, `MIN_CITATION_WORDS = 2` at
   `:347-348`). One quote may close one gap (`:506-509`).
7. **`basis: 'record'` is authorised only by a code-computed fact.** `view.recordFilled`
   (`src/teamLead/planner.ts:277-280`) is set only for `job_cost_gap` when the ledger says so; the
   model chooses the basis, code decides whether it holds (`:467-483`).
8. **Evidence is bounded by code, not the model.** Only captures on that gap's job with
   `captured_at > asked_at`, last 6, truncated to 600 chars
   (`src/teamLead/planner.ts:256-272`; `EVIDENCE_TEXT_CHARS = 600` at `:121`,
   `EVIDENCE_PER_GAP = 6` at `:124`).
9. **`manager_only` captures and retracted captures are never citable.**
   `src/db/rawCaptures.ts:330-340`.
10. **Ask window 7am-7pm firm-local, gated at COMPOSE not the outbox**
    (`src/teamLead/compose.ts:51-66`, `:203-208`), because the day phrase is baked in at compose
    time. The planner skips out-of-window tenants entirely (`src/teamLead/planner.ts:656-659`).
11. **Delivery deadline 18h; escalation default 24h.** `NUDGE_DELIVERY_DEADLINE_HOURS = 18`
    (`src/jobs/watchers.ts:149`), `NUDGE_ESCALATE_HOURS = 24` (`:119`). A hold may not reach past
    the delivery deadline (`src/teamLead/planner.ts:355-357`, `:525-533`).
12. **Two-touch ceiling.** Technician's agent first, manager second, never a third
    (`docs/engineering-memory.md:75-76`).
13. **Host tokens scope the transport.** `hostId` comes from the bearer token, never the body
    (`src/mcp/httpServer.ts:298-304`, `src/control/nudgeQueue.ts:118-121`).
14. **The box never receives a push.** Everything is a pull the box initiates
    (`src/control/nudgeQueue.ts:14-19`).

---

### The sweep/planner asymmetry (verified)

**The sweep's definition of "answered":**

- `src/jobs/watchers.ts:441-442`
  ```ts
  const hasActivitySince = (jobId: string, startsAtIso: string): boolean =>
    (latestByJob.get(jobId) ?? -Infinity) >= minuteFloor(startsAtIso);
  ```
  where `latestByJob` (`:402-436`) is the max of job-stamped `raw_captures.captured_at` and
  `visits.created_at`. **Any** such row counts.
- Consumed by `OVERDUE_VISIT_GAP_SPEC.filled` (`src/jobs/nudgeKinds.ts:181-189`), which returns
  `'a field report arrived — the gap filled itself'`, and by the sweep at
  `src/jobs/watchers.ts:553-557` which then calls `markNudgeOutcome(… 'answered' …)`.
- This runs at **lifecycle step 8**, `src/jobs/lifecycle.ts:297` — *"The Stage-0 watcher — EVERY
  tick (SQL-only; the reason the schedule is `*/5` at all)"*.

**The planner's instructed definition:**

- `src/teamLead/plannerPrompt.ts:60-65`
  > "HOW TO JUDGE AN ANSWER. Evidence closes a gap only when it answers THE QUESTION THAT WAS ASKED.
  > **Activity on the job is not an answer**: a note about something else, a status change, a visit
  > being logged, or somebody promising to write it up later — none of those fill the hole. A
  > promise is not a figure. If you are not sure, leave it open."
- This runs at **lifecycle step 9**, `src/jobs/lifecycle.ts:335`, self-gated to
  `getUTCMinutes() % 30 < 5` (`:352`).

**Consequence, stated factually.** The sweep sees the world six times more often than the planner
and, within a single lifecycle run, executes *before* it (step 8 → step 9). Its predicate is
strictly weaker. Therefore any evidence the planner could cite has, in the ordinary case, already
closed the gap on a prior tick — and the *stricter* judgment the prompt asks for can never be
applied, because the looser path always arrives first. `assert-only-cited`
(`src/teamLead/planner.ts:453-511`) guards a path that in practice rarely executes; gaps close on
activity that may not answer the question, which is exactly the failure the prompt warns against.
`send` and `hold` are similarly rare: both write `not_before`, which gates compose only
(`src/teamLead/compose.ts:192-200`), and compose drains pending rows every 5 minutes, so a
`pending` row is visible to the planner mainly on a same-tick birth or on the first in-window tick
of the morning. The planner's practical live vocabulary is `{escalate, leave alone}`.

This finding is already recorded in the repo at `docs/engineering-memory.md:302-330`
("The sweep is more permissive than the planner is instructed to be (2026-08-21)"), and the first
live escalation is recorded at `:332-358`.

---

## Decision Points

Stated as forks, not recommendations. Each option is described in terms of what the code as it
stands today would require.

**D1. Whether the seat agent gets a reporting channel at all.**
- *Option A — no channel; keep inferring from rows.* Nothing to build. Cost: everything in Area 1
  stands, and every "did they answer" question stays a guess about database side-effects.
- *Option B — widen the existing delivery report.* `POST /control/nudges` already exists with host
  auth, a 16 KiB body cap (`src/mcp/httpServer.ts:307`), and a 2-value `outcome` enum
  (`:327-330`). Widening it means adding a third outcome or a structured field, changing
  `completeNudgeDelivery`'s signature (`src/control/nudgeQueue.ts:122-127`), and — the harder
  half — teaching `nudge-runner.sh` to send something other than a fixed literal, which today is
  an explicit rule (`:64`, "NEVER interpolated output"). Anything the agent writes is then
  untrusted text arriving over a host token.
- *Option C — harvest the trajectory.* The runner already reads
  `/sandbox/.openclaw/agents/main/sessions/nudge-<id>.jsonl` (`:79-90`). Sending its *content*
  home rather than a boolean is a small script change and a large policy change: it makes an
  inbound content path, which per `CLAUDE.md` and `docs/engineering-memory.md:68-72` needs a hard
  work-relevance gate before any L1 insert, plus the ratified worker disclosure.

**D2. Whether a nudge answer should be a distinct thing from "job activity".**
- *Option A — leave it fused.* `hasActivitySince` stays the single test; the sweep keeps closing on
  any job activity; the planner's stricter instruction keeps not applying.
- *Option B — stamp the answer.* `planner.ts:505` names the missing piece: a nudge-session stamp on
  the capture. Today the nudge id is only in the box's session name; nothing carries it into
  `record_field_note`, and `raw_captures` has no column for it. Doing this touches: the delivered
  message (the agent would have to pass a token), the `record_field_note` schema and dispatch, an
  L1 column or a metadata key, and the sweep's predicate.
- *Option C — change the ordering instead of the data.* Steps 8/9/10 are a fixed sequence in
  `runLifecycle`; running the planner before the sweep, or gating the sweep's auto-close on the
  planner having seen the row, is a change local to `src/jobs/lifecycle.ts` but changes which
  component owns closure.

**D3. Whether the escalation copy checks its own claims.**
- *Option A — keep the template.* Two claims stay unverified for every escalation forever, and are
  true only by luck (the 2026-08-21 specimen was true; the 2026-08-20 one was false on both counts).
- *Option B — pass `facts` into `handoff`.* The signature is
  `handoff(n, mode, naiveLocal?)` (`src/jobs/nudgeKinds.ts:138-142`); the caller already holds
  `facts` (`src/jobs/watchers.ts:513-519`) and `latestByJob` (`:402`). Widening the signature makes
  the specs impure with respect to sweep state and means every spec's copy has to decide what to
  say when a fact contradicts it. The two remaining call sites (`src/teamLead/compose.ts:98`,
  `src/control/nudgeQueue.ts:88` and `:152`) have no `facts` to pass and only ever use `'expired'`.
- *Option C — widen what counts as "on the record" first.* `facts.jobsWithCostEvents` already
  exists (`src/jobs/watchers.ts:506-508`) and is deliberately excluded from every `filled`
  predicate (`src/jobs/nudgeKinds.ts:52-58`: "one of three 'the ladder cannot see the money ledger'
  defects the user ruled should be designed once, together, in a later plan"). Consuming it here
  would be exactly the piecemeal fix that decision deferred.

**D4. Whether `record_field_note` keeps its two-step confirm for agent-initiated answers.**
- *Option A — keep it.* The technician's explicit yes is what stands in for the classifier on an
  append-only table. Cost: every answer needs two tool calls and a human turn, and the specimen
  shows the second call is skippable in practice.
- *Option B — a one-shot variant for nudge answers.* The precedent exists in the same codebase:
  `record_money_event` is one-shot by doctrine because a ledger row is reversible
  (`src/mcp/server.ts:5473-5474`). An L1 capture is not reversible — only retractable
  (`retract_capture`, folded at read time by `foldRetractions`, `src/db/rawCaptures.ts:346-351`).
  Choosing this means deciding whether "retractable" is close enough to "reversible" for a note
  the technician did not preview.

**D5. Where the gap-filling duty lives in the seat agent's instructions.**
- *Option A — the per-message footer only (today).* Re-sent with every nudge; costs nothing
  standing; invisible when the agent is not currently holding a nudge.
- *Option B — a new `AGENTS.md` block.* `phase_wire()` (`Box_Setup_Stuff/bootstrap-box.sh:551-992`)
  has the refresh idiom (delete-then-append) and a documented append-once trap. Cost: it must be
  wired to every seat, `Box_Setup_Stuff/` must stay self-contained (`docs/engineering-memory.md:29`),
  and the recorded `AGENTS.md` size problem (~26.6k chars vs ~12k injected budget,
  `docs/engineering-memory.md:2071-2079`) means a block appended late may never reach the model.

**D6. Whether the planner's `reason` reaches the manager.**
- *Option A — no (today).* The manager always sees the template; the planner's actual judgment
  (e.g. "End of business — a manager should follow up directly") lives only in `nudge_decisions`
  (`src/teamLead/planner.ts:825`).
- *Option B — carry it.* The planner does not write the review item; it sets `escalate_after` and
  the sweep flags on a later tick (`src/teamLead/planner.ts:585-586` → `src/jobs/watchers.ts:654-694`).
  Carrying the reason means either a new column on `nudges` or the sweep reading `nudge_decisions`
  at handoff time. Note the reason is model-authored free text going onto a manager surface.

**D7. Whether the planner's tool surface matches what it is handed.**
- Factual observation, not a recommendation: `TEAM_LEAD_TOOL_NAMES` (`src/teamLead/identity.ts:22-30`)
  allows four tools — `spine_read`, `recall_decisions`, `get_customer_context`, `resolve_date` —
  but `TEAM_LEAD_TOOL_SCHEMAS` (`src/mcp/server.ts:1687-1695`, built from `TEAM_LEAD_TOOLS` at
  `:1624-1683`) contains only the first two, and that is what `src/jobs/lifecycle.ts:374`
  (`tools: [...TEAM_LEAD_TOOL_SCHEMAS]`) hands the loop.
  `get_customer_context` and `resolve_date` are dispatch-allowed but never described to the model,
  so it cannot call them. The fork is: trim the allowlist to match, or add the schemas to match.

---

## Measurement Machinery

### What `scripts/date-eval/` is and how it works

The repo's proven agent-behaviour harness. Three commands, plus an optional fourth:

```
npm run date-eval:plan                      # free   → plan.mjs
npm run date-eval:run -- --dir <d> --yes    # SPENDS → run.mjs
npm run date-eval:report -- --dir <d>       # free   → analyze.mjs
node … adjudicate-db.mjs --dir <d>          # free   → mechanical adjudication
```

**`plan.mjs` (179 lines) — build the corpus and freeze the truth.** Connects to the pilot DB with
`pg`, refuses to run unless `DATABASE_URL` is the known hosted pilot ref or the local stack
(`:31-38`). SELECT only. Reads the firm's `today` in its own timezone (`:46`), then five schedule
queries (timed visits, time-off, unplaced window jobs, next-visit-per-customer) at `:60-119`, folds
them into a `facts` object (`:122`), and calls `buildCorpus(facts)`. Writes `manifest.json`
(`:126-148`) carrying `today`, `timezone`, `expectedModel`, `sandbox`, the facts, and the questions
with their expected answers. Prints a confirmation brief with an estimated wall clock and a *range*
for spend (`:172` — the range is cache-hit luck). **Truth is derived at plan time from the live DB,
never pinned in the file** (`README.md:66-68`), so a shifted test schedule moves the corpus with it.

**`corpus.mjs` (507 lines) — the questions and an independent second implementation of the date
math.** Every question is tagged with the phases it exercises (`:3-16`). The date helpers
(`addDays`, `weekStart`, `monthStart`, `quarterStart`, …, `:28-74`) and `expectedResolve(todayLocal,
args)` (`:85-…`) recompute what a `resolve_date` call *should* have returned from its arguments
alone. The file must never import `src/schedule/dateResolve.ts` (`:23-26`) — sharing a helper would
make the check agree with the machinery precisely when the machinery is wrong.

**`run.mjs` (320 lines) — one real agent turn per question, over ssh.** For each question: base64
the text so no shell layer can mangle it (`:217-218`), then
`nemoclaw <sandbox> agent --agent main --session-id dateval-<today>-<runid>-<qid> -m "$MSG"` with
`</dev/null` (`:231`). The session id carries a per-run nonce persisted in `.runid` (`:79-89`) —
without it a same-day re-run resumed the morning's session and every answer came back as a
continuation. After the turn it pulls the trajectory back with
`docker exec … cat …/sessions/<sid>.jsonl` (`:236`) and extracts the last assistant text with
`replyFromTrajectory` (`:107-125`). **stdout is never graded** (`:265-271`) — it is kept as
`stdoutReply` for diagnosis only, because CLI chrome rots and a failed `--deliver` prints the
delivery error where the reply used to be. A turn with no assistant text is retried ONCE with a
fresh session (`:229-243`) and, failing that, recorded as an empty reply, which grades as a loud
fail. Gates: `--yes` required (`:182-187`); the fleet's inference route must equal
`manifest.expectedModel` before the first question (`:190-196`) and is re-read after **every**
question, aborting the run the instant it moves (`:294-314`); a manifest planned more than 1.5 days
ago is refused (`:197-206`). `--deliver` fires the real outbound hook against a dead Telegram target
(chat id 1) so the weekday-guard's verdict is *observed* rather than replayed (`:12-27`, `:272`).
Results append to `results.jsonl`, so the run is resumable (`:94-99`).

**`analyze.mjs` (628 lines) — phase attribution.** `parseTrajectory` (`:118-145`) walks the
`.jsonl` and pulls out tool calls, tool results, per-message timestamps and token usage. It then
grades four phases per question — resolve (`:217-234`), use (`:236-271`), speak (`:273-290`),
guard (`:292-310`) — with **earliest-failing-phase attribution**: a downstream phase whose input was
already wrong is marked `inherited` and dropped from its own denominator (`README.md:52-55`). The
resolve phase splits *machinery* (the tool was asked correctly and answered wrongly, checked against
`expectedResolve`) from *model* (the arguments were wrong) — that split is the number to watch after
a machinery change. Separately it computes an `outcome` verdict per question
(`correct` / `wrong` / `needs-adjudication`, `:319-391`) and flags any write tool appearing in a
trajectory (`isWrite`, `:148`), because the corpus is read-only by construction. Writes `rows.json`
and `report.md`.

**`adjudicate-db.mjs` (133 lines) — mechanical settlement of the leftovers.** For the question
shapes whose ground truth is a DB read (next visit, scheduling window), it re-derives truth from the
pilot at adjudication time and prints verdict + evidence (`:48-120`). It only touches rows
`analyze.mjs` explicitly refused to guess at (`:83`), and only those whose truth is mechanical;
everything else stays human. Its reason for existing: on the 2026-08-13 run 34 of 94 rows were
judged by hand-run SQL in a conversation, so a "100%" claim was not reproducible (`:6-13`).

**The shape, in one line:** *real traffic → the real harness → trajectories, not stdout → phase
attribution with earliest-failing attribution → mechanical adjudication → a reproducible report.*

### What it would structurally take to evaluate the return path the same way

Described factually, as differences from what the harness does today — not as a design.

1. **A corpus unit.** `date-eval` grades a *question and an answer within one turn*. The return path
   spans four processes and at least two lifecycle ticks (deliver → reply → record → sweep →
   planner). The unit would be a gap and its outcome, not a message.
2. **Two-sided truth.** `plan.mjs`'s truth is a SELECT over the schedule. Return-path truth is
   "did the right row appear, linked to the right gap" — which is precisely the linkage that does
   not exist (D2). Today the closest available truth is `nudges.status` + `nudges.resolution` +
   `raw_captures` timestamps, and none of them can say *which question* a capture answered.
3. **A reply source.** `run.mjs` asks a question and reads the trajectory. Evaluating the return
   path needs a *technician's reply* to exist — either scripted into the session as a second turn,
   or the whole thing driven from the box side. The harness already knows how to inject a turn into
   a named session (`nemoclaw … --session-id`), which is the same mechanism `nudge-runner.sh` uses.
4. **A writable world.** `date-eval` is read-only by construction and flags any write tool as a
   finding (`analyze.mjs:148`). The return path is entirely about writes. `scripts/spine-eval/`
   already solves the write-safety problem the other way — a generated, non-expiring world anchored
   on today, per-tier fixture pools, and truth graded from the database afterwards — and it runs
   against the **local** stack.
5. **A cross-tick driver.** Nothing in either harness advances the lifecycle. Grading a sweep
   decision or a planner decision means invoking `runLifecycle` (or `runWatchers` / `runPlanner`
   directly) between agent turns, with a controlled `nowIso`.
6. **A corpus that already exists, partially.** `nudge_decisions`
   (`supabase/migrations/20260820120000_nudge_decisions.sql`) records every planner decision with
   its `outcome` (`applied` / `refused` / `shadow`) and `outcome_detail`
   (`src/db/nudgeDecisions.ts:53-76`). It is append-only and is read back by `recall_decisions`.
   `docs/engineering-memory.md:392-398` records that there is currently **no planner eval**, and
   that `scripts/date-eval/` is the proven shape for one.
7. **The hint-leakage trap.** `docs/engineering-memory.md:382-383` names it explicitly: never put
   the outcome into a replayed context. Any replay-based return-path eval hits this first.

---

## Open Questions

1. **Does the seat agent ever call `record_field_note` at all in response to a nudge?** Reading
   alone cannot say. The evidence available in the DB is indirect (a capture appearing on the job).
   Answering it properly needs either the box trajectories for `nudge-<id>` sessions, or the
   `cost_events` rows with `sku='tool_call'` and `metadata.tool='record_field_note'` correlated by
   time and tenant (`src/mcp/server.ts:2037-2047` — the proof-of-deploy technique recorded at
   `docs/engineering-memory.md:350-355`).
2. **Which tier is the pilot's answering seat?** The specimen produced a `money_events` row, and
   `record_money_event` is admin-gated (`src/mcp/server.ts:2083-2085`). That implies the badge was
   manager tier. Worth confirming, because a technician-tier seat physically cannot produce that row
   and the funnel looks different for the two tiers.
3. **What is the actual retention of `/sandbox/.openclaw/agents/main/sessions/*.jsonl`?**
   `docs/engineering-memory.md:1010-1011` says "~30-day shelf life"; nothing in this repo enforces
   or verifies it. It bounds how long a harvest-based fix could reach back.
4. **Does `--deliver` return a non-zero exit when the agent produces no reply?** The runner treats
   exit status and trajectory text as independent signals (`nudge-runner.sh:153-168`), implying they
   can disagree. The failure modes of the CLI on that path are not documented here.
5. **Is `AGENTS.md` currently truncated on the delivery path?** The recorded truncation is for the
   *embedded* CLI path (`docs/engineering-memory.md:2375-2385`, `scripts/date-eval/README.md:120-126`).
   `--deliver` runs on the gateway (memory: "CLI drives the gateway"). Whether the nudge delivery
   path sees the full file is a live check, not a reading question. It decides whether D5 Option B
   would even work.
6. **How often does the sweep close a gap that the planner would have left open?** Answering it
   needs a `nudge_decisions` corpus wide enough to compare, plus the `nudges.resolution` text for
   the same rows. `docs/engineering-memory.md:327-330` flags this as worth confirming before
   treating the "{escalate, leave alone}" vocabulary as settled.
7. **Is the 15-minute staging TTL the binding constraint on abandoned notes?** i.e. of the field
   notes that stage and never confirm, how many expire versus how many are superseded by a re-stage
   (`src/mcp/server.ts:2150-2156`)? Both close the `pending_field_note` item, and only a query
   against `review_items` resolutions can separate them.
