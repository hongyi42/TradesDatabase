# Technician agent runbook (NemoClaw + Telegram)

How to wire a per-technician agent to the spine. The agent is the **channel + collector**;
our MCP server ([src/mcp/server.ts](../src/mcp/server.ts)) is the **only thing that touches the
spine** and the only thing that holds the Supabase / Anthropic keys. The agent never sees those
secrets — it calls our tools, we do the rest (L1 → extract → identity match → L2/L3 + provenance).

> Status: this is the deployment guide for the still-to-be-provisioned agent stack. The MCP server
> and its tools are built and tested (in-memory + stdio smoke). The live Telegram E2E below is the
> remaining setup milestone.

## Architecture

```
Telegram (per-tech bot)  ──voice/text──▶  NemoClaw sandbox (OpenClaw runtime)
   voice auto-transcribed (cloud STT)         │  calls our MCP tools over stdio
                                              ▼
                              trades-spine MCP server  ──▶  Supabase (the spine)
                              (holds SUPABASE_* + the model key: INFERENCE_API_KEY for
                               the GLM default, ANTHROPIC_API_KEY when flipped; tenant pinned)
```

- **Per technician:** one named NemoClaw sandbox (`nemoclaw tech-<name>`), lighter policy than the
  manager tier — for v1 it only needs our spine tool (email/SMS connectors come later).
- **Manager agent (full sandbox + broad connectors) is a separate plan**, not covered here.

## 1. Telegram bridge
- Create a bot via **BotFather**; the bot token is registered with the **OpenShell gateway**, not
  placed in this repo or the sandbox (NemoClaw keeps the token out of the model context).
- Restrict the bot to the technician's sender id (per-user allowlist).
- **iMessage is not supported** (Apple does not permit bots) — Telegram only for v1.

## 2. Voice → text (STT)
- Enable cloud STT (Whisper / Deepgram) in the bridge so a Telegram **voice message is transcribed
  before the agent sees it**. The agent then passes the transcript as `text` to `record_field_note`
  with `channel: "technician_voice"`.

## 3. Register the spine MCP server
Add our server under the gateway's `mcp.servers` (stdio `command`/`args`). The gateway injects the
secrets via env/SecretRef so they never enter the model context:

```jsonc
{
  "mcp": {
    "servers": {
      "trades-spine": {
        "command": "node",
        "args": ["/abs/path/to/TradesDatabase/dist/mcp/server.js"],
        "env": {
          "SUPABASE_URL":              { "secretRef": "supabase-url" },
          "SUPABASE_SERVICE_ROLE_KEY": { "secretRef": "supabase-service-role-key" },
          // Model provider for the spine's forced-tool calls (classify/extract/brief/answer).
          // Default 'openai' → GLM-5.2 via DeepInfra (INFERENCE_API_KEY). Set 'anthropic'
          // + ANTHROPIC_API_KEY to run Claude instead — no code change.
          "MODEL_PROVIDER":            "openai",
          "INFERENCE_API_KEY":         { "secretRef": "inference-api-key" },
          "DEFAULT_TENANT_ID":         "<this firm's tenant uuid>"
        }
      }
    }
  }
}
```

Build first (`npm run build`); the entrypoint is `npm run mcp:serve` → `node dist/mcp/server.js`.

## 3b. Centralized deployment (Architecture A)
The stdio registration above is **one server per sandbox** (the server runs inside each box, pinned to
one identity via `DEFAULT_TENANT_ID`/`DEFAULT_TECHNICIAN_REF`). The central alternative is **one shared
HTTP server every bot calls**, with identity asserted per request by the gateway:

- One host runs `npm run mcp:serve:http` → `node dist/mcp/httpServer.js` (Streamable HTTP, **stateless**).
  Secrets (`SUPABASE_*`, the model key `INFERENCE_API_KEY`/`ANTHROPIC_API_KEY`, `GATEWAY_IDENTITY_SECRET`) live **only on this host** —
  no sandbox holds them, which closes the per-box key-exfiltration risk.
- The gateway reaches it over **mTLS on a private network** + an optional IP allowlist (`ALLOWED_CLIENT_IPS`).
  This restricts *who may connect*; it is **deploy-time infra, not in this repo**.
- On every request the gateway sets identity headers and signs them with the shared secret:
  - `x-tenant-id`, `x-technician-ref`
  - `x-identity-signature` = `HMAC-SHA256(GATEWAY_IDENTITY_SECRET, "<tenantId>.<technicianRef>")` (hex)
  - **and** `Accept: application/json, text/event-stream` + `Content-Type: application/json` — the
    stateless transport returns `406`/`415` without both. (The MCP SDK client sets these automatically.)
- The server rejects a missing/forged signature with `401`, then resolves `(tenant, technician)` from the
  verified header — never from tool args. `record_field_note` no longer accepts a `technicianRef` arg.
- **Stateless ⇒ horizontally scalable:** the `record_field_note` identity/create-customer flow keys off a
  DB-persisted review-item token (`confirmId`, same store as `send_email`'s staged sends), so any
  replica can serve any request — no session affinity behind a load balancer.

The future **Option B** (per-bot JWT / OAuth Resource Server) swaps only the header-verification step
(`resolveIdentityFromHeaders`); the tools and tenant guards are unchanged.

## 4. Restrict the tool surface
Allowlist only the spine tools for the technician profile (`tools.profile` / allowlist) — the
technician surface is pinned by name in `src/mcp/tools/surface.expected.ts` (`TECHNICIAN_TOOLS`,
the authority when this list drifts): `record_field_note`, `find_customer`, `get_customer_context`,
`get_job`, `get_capture`, `search_captures`, `resolve_date`, `list_recent_captures`,
`web_search`, `read_webpage`, `send_email`, `retract_capture`, `record_standing_fact`,
`get_schedule`, `inform_team_lead`, `ask_team_lead`, `inform_teammate`. Outbound network policy
should allow only the gateway + our server's host.

**Route links: booked order, one per stop (2026-07-31).** `get_schedule` no longer asks Google
Routes for a "best driving order" and no longer returns `driveMinutes`, `optimizeFailed`,
`linkTruncated`, or a day-level `mapsUrl`/`unroutableStops`. The schedule is already set, so the
read RENDERS it: stops come back in booked (time) order — the same order the board shows — and
**each stop carries its own `mapsUrl`**, a destination-only Google Maps link. Consequences: no
10-stop link cap (a single-destination URL has no waypoints to truncate), and a stop with no
usable address simply has `mapsUrl: null` while staying in the one chronological list. Deciding
order means MOVING visits — that is the manager's call through `move_visit`, never a read.
⚠ **This changed `get_schedule`'s DESCRIPTION, so the technician `tools/list` payload moved.**
Gateways cache `tools/list` per process, so technician sandboxes need `nemoclaw <s> gateway
restart` or the agent keeps describing drive minutes that no longer exist. A full box wire re-run
is NOT required: nothing bakes this tool's wording into AGENTS.md (verified against
`bootstrap-box.sh`), and the tool COUNT is unchanged (14 then; 17 today), so no allowlist edit either.

**Manager profile (2026-07-02):** an ACTIVE `tier='manager'` roster row (the `technicians`
table, not the badge, is the tier source of truth) gets the technician surface MINUS
`get_schedule` (removed for managers 2026-07-19 — it is the technician route view; a manager's
only schedule read is `get_team_schedule`, which includes visits the manager holds; do NOT pin
get_schedule in the MANAGER profile — and because it is filtered off this surface, the
2026-07-31 description change above does NOT move the manager `tools/list` at all: the manager
side needs no deploy step and no restart. **⚠ That last sentence is about the 2026-07-31 change
ONLY — rung 10b.2 (2026-09-09) DOES move the manager surface, 42 → 43 tools, by sharing
`record_caller` from the team lead's array. Same cache rule as the technician side above: every
manager sandbox needs `nemoclaw <s> gateway restart` after the deploy or it keeps serving its
cached 42-tool list and cannot see the door at all. And unlike 2026-07-31 this one DOES bake into
AGENTS.md (rule 7 names the tool), so a box `wire` re-run is required too.** **`get_team_schedule` carries NO navigation links**
(user decision 2026-08-03, from live evidence): it is a TEAM view by construction, and a manager
asking "what's on the schedule this week" is dispatching, not driving — a directions link on
their own couple of stops answered a question nobody asked and was the only noise in an otherwise
clean report. Per-stop links live on `get_schedule`, which IS a personal route view; a manager's
own driving day is the board's job. A briefly-shipped `mapsUrl`/`routeNote` on this tool was
removed before merge) plus the 27 seat/lifecycle+scheduling tools, for a 40-tool
manager surface (send_email since 2026-07-04, retract_capture since 2026-07-06, web_search and
read_webpage since 2026-07-13, record_standing_fact since 2026-07-14, resolve_date since
2026-07-17; get_availability since 2026-08-04, the read half of set_availability — the
pattern had been write-only, so "what is X's availability?" had no answer; the 4 scheduling tools
`get_team_schedule`/`book_visit`/`move_visit`/`unschedule_visit` since 2026-07-14; the 5
schedule-input tools `set_availability`/`add_time_off`/`remove_time_off`/`set_job_duration`/
`set_technician_skills` since 2026-07-20 — all one-shot, no confirm; `set_availability` is the
step that makes a person schedulable, tracked by an `availability_setup` review item opened at
seat confirm; `find_slots` since 2026-07-20 — the read-only ranked slot finder: feasibility is
its verdict, it books nothing; like every schedule answer it carries the board link (originally excluded — the agent FABRICATED a URL to satisfy the every-answer doctrine, live 2026-07-21); `update_job` since 2026-07-21 — one-shot job-identity editor, title/jobType/priority with old→new echo; `set_technician_horizon` since 2026-07-22 — one-shot visibility dial: how far ahead TECHNICIANS see the schedule, whole weeks 1-12 stored per-tenant (default 4 weeks); technician-tier reads and board views beyond it answer "not published yet", managers never clamp; since 2026-07-23 (plan 4a.5, count unchanged): `move_visit` gained `unassign:true` — PARKS a visit (pulls the person off, keeps day/time; find it under `get_team_schedule unassignedOnly:true` or the board's loose bucket; mutually exclusive with `technicianRef`); since 2026-07-25 (cancel-vocabulary change): `cancel_visit` RENAMED `unschedule_visit` — same behavior, and the name now says it: the visit comes OFF the calendar while the WORK survives, job back in the loose bucket — and +`cancel_job`, the TERMINAL verb: the job closes for good (no un-cancel), leaves the loose bucket, and its live visits are cancelled with it; ALWAYS two-step with every live visit disclosed in the preview; ambiguous manager wording ("cancel the Hendersons") means ASK which; the four autonomous-solver tools added 2026-07-26 (`set_visit_locks`, `run_freeze`) and 2026-07-30 (`run_resolve`, `undo_run`) were REMOVED 2026-09-03, rung 8, and `set_promise` was REMOVED 2026-09-05, rung 9a, with the promise ladder itself — see the retirement notes below: `add_technician_seat`
(two-step confirm since 2026-07-17 — mints a permanent ref + burns a seat, not reversible;
`seatExempt:true` since 2026-07-19 adds a SCHEDULE-ONLY person instead — no seat occupied,
bookable on visits and visible on the board, but `bind_telegram`/`get_connect_link` refuse them:
no assistant, no Telegram, no email, ever),
`deactivate_technician_seat` (two-step confirm; starts the disable-first grace period),
`reactivate_technician_seat` (the grace-period undo), `get_connect_link` (mint a Gmail
Connect Link; 5-min per-person cooldown), `bind_telegram` (connect a person to their numeric
Telegram user id — auto-claims a cold-pool sandbox if they have none; reaches the box in ~5 min),
`list_team`, `list_pending_reviews`,
`resolve_review` (also carries pairing-verification verdicts: resolved = mailbox confirmed →
active; dismissed = wrong mailbox → pairing torn down). The server both filters `tools/list`
by tier and re-gates every admin call at dispatch — a technician badge structurally has no
admin surface. Seat caps (`tenants.manager_seats`/`technician_seats`) are DB-enforced; the
agent cannot talk past them.

## 4c. Outbound weekday guard (sandbox plugin, 2026-08-06)

Every sandbox carries `trades-weekday-guard`, an observe-only OpenClaw plugin on the
`message_sending` hook: before a reply leaves for Telegram, it verifies every
(weekday, date) pair the text **states** — chrono-node's `isCertain` distinguishes stated
from inferred, so a bare "Friday" or a bare date is never flagged — and appends one JSONL
line per message (flagged or clean, so a *rate* is computable) to
`/sandbox/.openclaw/logs/weekday-guard.jsonl`. It never rewrites and never cancels; every
error path fails open (a detector must not break delivery).

Why it exists: the agent fabricates weekdays when composing sentences — five upstream fixes
in three days (resolve_date, §0f, `local_weekday`, the phrase fields) each moved the failure
instead of stopping it, and a corpus replay over 419 historical assistant texts found **23
real mismatches (0 false positives)**, including a customer-facing date change
("Friday August 17" — a Monday) and a freeze proposal ("Sat Aug 9" — a Sunday). Detect-only
by decision: in "today, Thursday 2026-08-09" the wrong half is ambiguous, so auto-correcting
can entrench the error; the measured rate decides whether a phase 2 (cancel-and-retry) is
worth a round-trip.

Source of truth `Box_Setup_Stuff/plugins/trades-weekday-guard/` (chrono bundled beside it —
sandboxes fetch nothing); behaviour locked by `src/control/weekdayGuardPlugin.test.ts`;
installed by the bootstrap wire step. **Install shape (corrected 2026-08-06 after the s6
canary):** upload to a temp dir → `openclaw plugins install --force` → `nemoclaw <s> doctor
--fix` → `gateway restart` → verify the id appears in the gateway's own
`http server listening (N plugins: …)` line. Two traps, both hit on the canary: a bare
file-copy + registry refresh makes `plugins list` say "enabled" while the gateway never loads
the hook (tools flow through the cold registry; hooks need in-process load, which trust-gates
unprovenanced local code) — and `plugins install` itself edits `openclaw.json` without
updating `.config-hash`, so skipping `doctor --fix` leaves the next restart failing
`GATEWAY_UNSAFE_CONFIG_PATH`. Plan:
`thoughts/shared/plans/2026-08-06-weekday-guard-plugin.md`.

## 5. Conversation contract (stage→confirm since 2026-07-06)

**Confirmation doctrine (2026-07-17, RE-CUT 2026-09-05 by rung 9a):** confirm only what is
**irreversible or externally visible**; everything reversible happens in ONE call and the agent
reports what it did. The test used to be the promise ladder — one-shot when
`promiseLevel:'none'`, stage→confirm when a promise was at stake. That ladder is DELETED, and
the test is now PLACEMENT:

- `book_visit` and `move_visit` are **always one-shot**. Nothing in the schema records what a
  customer was told, so the agent must READ THE JOB'S RECORD (its calls, emails and notes) for
  a promise BEFORE moving a visit or suggesting a time — and must never claim none was made,
  because it cannot know that without looking.
- **A trip can carry a CREW** (rung 9c, 2026-09-06). Both verbs take `technicianRefs` — every
  person going — while `technicianRef` stays as shorthand for one. Two technicians on one job at
  one time is ONE visit, never two bookings: booked twice they become two trips, each chased and
  reported separately. On `move_visit` the list REPLACES the crew, so adding a second person means
  passing BOTH refs. The result carries `crewNote` when more than one person is on it, and
  `crewNotAdded` when the visit moved but somebody could not come along.
- `unschedule_visit` is the one scheduling verb that still stages, and only when the visit is
  **PLACED** — it has a real time, so a customer is expecting it. A visit with no time set is
  nobody's appointment yet and drops in one call.
- `cancel_job` never one-shots — terminal, always stage→confirm.
- `add_technician_seat` is two-step (permanent ref + a seat — still two-step with
  `seatExempt:true`, where no seat burns but the ref mint stays permanent).
- **Answering the office about a call or an email (rung 10, AGENTS.md rule 7).** When the office
  texts that a customer got in touch and asks whether to open the job — or to open one and send
  somebody because the firm agreed to come out — the agent takes the customer and the work from
  that message, `find_customer`s the id, and asks the manager. On a yes: `book_visit` when
  somebody is being sent (jobId if the office named one, else customerId + the work as the title,
  with the day and both times if the manager gave them, else `untimed: true` — it mints the job in the same call), or the new `open_job`
  when only the job is wanted (a quote, an estimate, work to schedule later). Both refuse when the
  customer already has THAT work on file (a title naming an open job), with the list — for a
  visit, re-call `book_visit` with the matching jobId; `open_job` takes no jobId, so act on the
  existing work directly. `forceNewJob:true` only for genuinely different work. On a no: `inform_team_lead` in one
  sentence. **Never create it before they answer** — nothing is on the record yet, deliberately.
  **Rung 10b.2 (2026-09-09, replaces the 10b relay): the caller nobody matches — the agent
  records it.** The office's message may instead say it does not know who got in touch. A MANAGER
  seat now holds `record_caller` itself (shared from the team lead's surface; technicians do NOT
  get it — dispatch refuses them). **AGENTS.md is written once per sandbox with no tier
  branching** (`bootstrap-box.sh` writes every doctrine block unconditionally), so rule 7 is
  phrased around what the agent can SEE in its own tool list: hold it → record; do not hold it →
  relay with `inform_team_lead`, which is in the technician catalog. Without that branch a
  technician seat would be told to call a tool it will be refused, with its old fallback deleted.
  A manager seat puts the question to the manager and, on the answer, calls `record_caller` with
  the item id from the office's quiet note — **once, carrying `openJob` and `bookVisit` if the
  manager asked for them.** Splitting it (create the customer, then `open_job`/`book_visit`) looks
  equivalent and is not: those two cite the capture only through `inboundAskFor`, which matches on
  `context.customerId`, and an `inbound_unmatched` context has none — so the job and the trip
  would be filed against nothing while the item still retired on the customer's citation, hiding
  the loss. A named day still books untimed; the seat then places it with `move_visit`. **Why the tool matters and a relay does not:** everything
  `record_caller` writes cites the caller's own message, and an item retires only when something
  cites its capture — so `record_field_note` here files a copy of the agent's words, leaves the
  original message cited by nothing, and the office goes on asking forever. That is the live
  2026-09-08 failure this replaces (a customer whose address was her own name, a `completed` trip
  nobody took, the item still open). With no id yet, it waits for the quiet note rather than
  reaching for another tool. It names only what the manager said — no invented address, and no
  email address the manager did not give — and reports what it recorded, never that the item is
  closed.
- **Outside accounts go through Composio, first move (AGENTS.md rule 8, added 2026-09-07).**
  Gmail: the agent calls `get_connect_link` (Gmail-only, manager-tier) and hands over the URL.
  Other accounts (Sheets, Excel, Drive): a manager's seat connects them through Composio's own
  connection tool (the manager session has `manageConnections: true`), never Gmail that way (only
  `get_connect_link` starts the mailbox check); a technician's seat connects no account, Gmail
  included, and says so (corrected 2026-09-15 — the first wording routed all four
  to `get_connect_link`). No web search, no alternative integration, no self-authentication.
  Everything after the browser approval is already automatic and is NOT the agent's to do —
  `checkPairing` (`src/composio/pairing.ts`) adopts the ACTIVE account, opens the
  `pairing_verification` review for a manager, and calls `ensureTrigger`, which creates
  `GMAIL_NEW_GMAIL_MESSAGE` **pinned to that connected account** and stores
  `composio_trigger_id`; a run that dies mid-way is finished by the healing branch on the next
  sweep. So the agent must not report the connection as finished at approval time, only as being
  verified. If `get_connect_link` is absent from its list it says so and stops.
  *Why the rule exists:* on 2026-09-07 an agent asked to connect a mailbox had NO doctrine
  naming Composio (the string appeared zero times in `bootstrap-box.sh`), improvised with raw
  toolkit calls, and produced a half-connected account — OAuth ACTIVE, but no trigger, no
  `composio_trigger_id`, no verification item. It looked connected to everyone and delivered no
  mail. The recovery took a manual `composio-reconnect.mjs` + `composio-trigger.mjs` pass. Note
  that the dev script `composio-trigger.mjs` does NOT pin `connectedAccountId` and warns
  "using the first one" — `ensureTrigger` does pin it, so the automatic path is the correct one
  and the scripts are recovery tools only.

`book_visit` has NO default times (2026-07-18, user decision — the 2h job-length default was
removed after it overrode a stated "12–1pm" in the pilot): `date`, `startTime` and `endTime`
arrive TOGETHER, the agent passes exactly what the manager stated, and asks when one is
missing. **One recorded exception (2026-07-25, plan 4b-2, re-cut by rung 9a):** when the timing
genuinely is not settled, the agent passes **`untimed: true` and none of the three** and the visit books UNTIMED (rung 10b.2: an omission alone is refused — untimed must be SAID) —
no day, no range, nothing stored about when it should happen. It waits in the unscheduled queue
until a normal `move_visit` places it. There is no way to record "sometime next week": that is
a conversation with the manager (and, through the office channel, with the planner that knows
how this firm schedules), not a field.

**Board link (2026-07-18):** scheduling results carry `boardLink` — the Telegram Mini App
dispatch board (`t.me/<board-bot>?startapp`, decorated server-side from `BOARD_BOT_HANDLE`,
absent when unset). The agent ends every schedule-change report with it ("See it on the
board: …"), relayed exactly — never an invented or remembered URL.

**Temporal grounding rider (2026-07-25):** every successful object-shaped tool result also
carries `now` — `"Right now it is Saturday, July 25, 2026, in the America/Los_Angeles
timezone."` (firm-local, tenant timezone). The agent runtime injects no date into context, so
this line is how the model knows what today is between `resolve_date` calls; it self-refreshes
every call, so sessions crossing midnight stay grounded. It states what today IS —
`resolve_date` remains the only sanctioned way to compute any OTHER date (eval:
date-knowledge alone scores 66–81% on scheduling phrases; the tool 99%). Array-shaped results
(e.g. `find_customer`) keep their shape and carry no rider.
- The agent calls `record_field_note({ text, channel })`. **If identity resolves to a customer or
  job that already exists, this call RECORDS** — L1 + L2 in one step, `status: 'recorded'`
  (plan ②, 2026-08-21). Idempotency comes from a content stamp
  (`note:<sha256(tenant|tech|channel|identity|text|blobPath)>`), so a retried tool call returns
  `duplicate` instead of writing a second permanent row and a second visit.
- If the result `status` is `needs_identity`, the agent asks the technician which customer
  (a `suggestion` carries the scheduled address when there is one), then calls again with
  `confirmId` + `confirmed: { customerId }` (or `{ address }`). **That answer records too** — a
  missing datum was never a confirmation, so there is no third call.
- `needs_confirmation` now happens in exactly ONE case: the answer would **create a new
  customer**. The response carries a `preview` (customer name, new-customer flag, note text); the
  agent shows it verbatim, waits for an explicit yes, then calls again with **ONLY `confirmId`**.
  The STAGED copy is what commits; fresh args are ignored. The confirm survives here and nowhere
  else because the retractability argument that removed it does not cover creation: a note can be
  retracted by its author, but a customer pinned by a stamped capture cannot be removed at all.
- Staged notes expire after 15 minutes; one staged note per person (a re-stage supersedes). A
  `needs_identity` item is deliberately left open if nobody answers — its `detail.text` is the
  ONLY copy of that note, so expiring it would destroy it.
- **Fixing a mistake:** the record is append-only — nothing is ever deleted. The agent records
  the corrected note first, then calls `retract_capture({ captureId, reason })` on the wrong
  capture (also two-step: stage → show → confirm with only `confirmId`). Retracted captures,
  their visits, AND any standing fact citing the capture as evidence disappear from
  briefings/context/lists; managers can pass
  `includeRetracted: true` to `list_recent_captures` for the full labeled trail. Only the
  capture's author or a manager may retract; agent-action audit rows (`outbound_email`,
  `agent_action`) are manager-only, even for their author. Facts a note already wrote onto the
  job/customer record (e.g. a status change) are not auto-reverted by a retraction.
- **Retraction blast radius (2026-07-14):** the retraction stage response carries
  `willAlsoRemove` — the server-computed list of standing facts, visits AND caller correspondence
  (what a customer said on a call or email, kept on the job — rung 10) that fold with the
  capture. The agent must show that list as part of the confirmation. The confirm response
  echoes the final list as `alsoRemoved` plus a `restoreHint` when facts folded; the agent then
  offers to restore still-true facts by **staging** `record_standing_fact` (the preview is the
  offer — no "want me to?" pre-ask; AGENTS.md rule 3 "propose by staging"), one target at a
  time. If `alsoRemoved` is absent, the post-commit scan failed — fall back to the staged
  `willAlsoRemove`.
- For questions ("what did the last tech do here?"), the agent uses `find_customer` →
  `get_customer_context` (the contents page: counts and the newest note's opening per job) →
  `list_recent_captures` (a page of one job's notes) / `get_capture` (one note in full) /
  `search_captures` (keyword, technicians). Never the whole history in one result.
- **Technicians read a limited view (2026-09-15, retrieval layer plan 2).** A technician seat
  sees the jobs its person has a BOOKED trip on (a trip its own field note minted does not count),
  the other UNFINISHED jobs of a customer it has unfinished work with, the profile of every customer
  it has a trip with at all, and every technician note the person wrote. Consequence worth saying
  out loud: recording a WALK-IN — a note that mints its own trip — leaves the seat unable to read
  the record it just created, beyond that note. The planner is meant to notice and put it to a
  manager (a later task); until then it is a grant. Anything else comes back as
  name + id with `inView:false` and an "outside your view" note: `find_customer`,
  `get_customer_context`, `get_job`, `list_recent_captures`, `search_captures`;
  `get_capture` answers `found:false`; `record_standing_fact` refuses. MONEY is words for a
  technician — "invoiced, not yet paid", never an amount or a balance (and the retraction preview
  names a money entry without its amount). A manager widens it per
  item with a grant (`access_grants`: `record` or `record_and_notes`) or per firm with
  `technician_view_rules`. The seat verbs for both (and the ask that leads to them) are the
  request-flow task; until then, set a firm's rule by hand (docs/engineering-memory.md §2).
  Managers' and the planner's reads are unchanged.
- **Web tools (2026-07-13, all tiers):** `web_search` (Brave snippets via Render — the key never
  reaches a sandbox) and `read_webpage` (hardened reader: URLs from the person or from search
  results only per the §0e rules; server enforces SSRF guard, a length cap on non-search URLs,
  per-person daily caps, and logs every request to `web_requests`). Content comes back labeled
  untrusted; the §0e AGENTS.md block (Box_Setup_Stuff setup guide) carries the behavior rules.
- **The autonomous solver — RETIRED 2026-09-03 (rung 8).** `run_freeze` (propose a whole
  placement plan via Google's Route Optimization API), `run_resolve` (re-optimize placed
  visits), `undo_run` (restore the latest run from its ledger trail) and `set_visit_locks`
  (pin a visit against them) are DELETED, along with the board's proposal view, the
  `?startapp=freeze` deep link and the §0h AGENTS.md block. The manager makes the schedule;
  route optimization returns in rung 11 as an ADVISORY tool the manager's agent may choose
  to call. Reasoning and the full deletion footprint: `docs/engineering-memory.md` §6a/§8.
- **The promise ladder and the stored window — RETIRED 2026-09-05 (rung 9a).** `set_promise`
  is DELETED, along with the `promise_level` / `promised_day` columns, `book_visit`'s
  `timeTbd` / `earliestDate` / `latestDate` arguments and the `earliest_date` /
  `latest_date` columns behind them. **A visit has a time or it does not.**
  - *Why:* a job's lifecycle stretches and shrinks as humans act, so a commitment frozen in a
    column is stale the moment the customer calls back. Neither the promise level nor a
    stored window should restrict the agent (user ruling 2026-09-05).
  - *What replaces it is doctrine, not schema:* the agent looks for promises **in the
    record** — the calls, emails and notes in L1 — before it edits the schedule or suggests a
    time. It is REACTIVE: it edits the schedule only when asked.
  - *Consequences:* `book_visit` / `move_visit` are unconditionally one-shot;
    `unschedule_visit` stages only for a PLACED visit; an untimed visit sits on no day, so it
    appears in the unscheduled queue and in `get_team_schedule`'s `untimed` list, never in a
    day group. `find_slots(earliestDate, latestDate)` is UNAFFECTED — same words, different
    thing: a search range, never a commitment.
  - Reasoning and the full footprint: `docs/engineering-memory.md` §6a, and
    `thoughts/shared/plans/2026-09-05-the-rails-come-out.md`.

## 6. Email ingestion — a WEBHOOK, not a pull (rewritten 2026-09-07, rung 10)
A second input channel feeds **only work-related** mail through the same write-path
(`channel: 'email'`). It arrives as a **Composio Gmail trigger**, delivered to
[src/inbound/webhook.ts](../src/inbound/webhook.ts) — push, not poll, and the only email path
that has ever run in the pilot.

The direct-`googleapis` puller (`src/email/ingest.ts`) was **deleted in rung 10**. It had no
production caller: nothing scheduled it, nothing imported it outside its own test, and its
overlapping `newer_than:7d` window had no idempotency at all. Its env (`GMAIL_CLIENT_ID`,
`GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`) and the `googleapis` dependency went with it.
- A classifier ([src/email/classify.ts](../src/email/classify.ts)) — GLM-5.2 by default,
  `MODEL_PROVIDER`-switchable — drops personal/marketing mail **before the L1 insert**, never
  after: L1 is append-only, so a misrouted row is retained permanently (CLAUDE.md's standing rule).
- The webhook dedups on the provider's message id (`external_id`), so a redelivery heals a
  partial write rather than duplicating one.
- What happens after L1 is rung 10's business: a matched customer's mail is pinned to their open
  job and kept on it, or it raises an observation and a manager is asked. It never creates a job
  by itself.

## 6b. Inbound phone calls (intent router — separate from the chat channel)
A third input channel captures inbound phone calls. The line forwards to a **receptionist** (a human,
via `call_numbers.forward_to`) who has **no scheduling tools**, so the async call worker
([src/calls/worker.ts](../src/calls/worker.ts)) is the **only systematic intake** for the phone
channel: recording → STT → redact → **GLM-5.2 intent router** ([src/calls/classifyCall.ts](../src/calls/classifyCall.ts)).
The router is **multi-label** — one call can be `[new_job, cancel]` and each is handled:

- **`new_job`** → runs the extractor. ⚠ **What that means changed in rung 10 (2026-09-07):** it no
  longer mints a job. For a caller we know, the words are pinned to their open job and kept on it;
  with no open job — or when the firm agreed to come out and no trip carries it — an OBSERVATION is
  raised and a manager is asked. **Nothing reaches the board's unscheduled bucket until somebody
  says yes.** **Amended by rung 10b (2026-09-08):** a caller who matches NOBODY no longer opens an
  `unlinked_call` review — that item was a dead end, since no tool could ever act on it. It raises an
  `inbound_unmatched` observation instead, which reaches the planner on the same ping loop within
  seconds; the planner links a known customer at a new number, dismisses a supplier, or asks a
  manager. Nothing is pushed from the call worker for it. The existing `unlinked_call` rows stay for
  hand resolution.
  - **KNOWN GAP:** only `new_job` runs the extractor at all, so a committed call about work already
    on file ("we'll come out Tuesday to finish it") is classified `reschedule`/`other`, stops at L1,
    and raises no `inbound_commitment`. Widening which intents structure was deliberately NOT part
    of rung 10 — the 2026-08-06 router plan keeps the extractor off cancel/complaint calls. Email
    has no such gate: every work email runs it.
- **`reschedule` / `cancel` / `question` / `complaint`** → **L1 only** (the transcript is always kept as
  the call log), plus a `call_action` review that is **pushed to the tenant's managers** — these are
  **NEVER auto-executed** (a receptionist can't act, the worker's read is unverified, and move/cancel are
  irreversible + need stage→confirm). `complaint` and an unclassifiable call are **high-priority**.
- **`other`** → L1 only.
- **classifier failure** (throws after its retries / empty / all-invalid labels) → `unclassified` → a
  pushed high-priority review — the fail-safe never lets an important call fall to silence.

**No new MCP tool** — the router is entirely worker-side (the agent's tool counts are unchanged). Managers
act on the pushed reviews through the existing review verbs. Preflight: `BOARD_BOT_TOKEN` must be set on
the `calls:worker` service for the push to send.

## 7. Third-party app connectors (Composio — Option B, decided 2026-06-25)
The agent reaches third-party apps (Gmail, Google Sheets, Microsoft Excel, calendar, …) through
**Composio** as a per-tenant connector layer. **Decision: Option B — Composio manages *all* OAuth tokens
(inbound + outbound).** Composio delivers raw data; **our classifier + write-path stay the system of
record**. Guiding rule: **let Composio carry the credential, never the judgment** — it never decides
what's "work mail" and never writes to the spine (see §5 of
[the overview](Three-Layer-Context-Spine-Overview.md): hardcode identity matching / permission
boundaries; outsource only the plumbing).

**Composio is complementary to `trades-spine`, not a replacement.** The spine MCP stays the only writer
to the canonical record (holds Supabase keys; does identity-match + provenance + tenant guards). Both
register side-by-side in the gateway's `mcp.servers`.

### Outbound architecture of record (amended 2026-07-04 — implemented)
**Per-PERSON Composio sessions (Tool Router GA) carry outbound**, superseding the per-tenant
`mcp.url` sketch below (kept for history). User decisions 2026-07-04:
- **One session per person**, keyed by the composite `"<tenantUuid>:<technicianRef>"` user id and
  created by the lifecycle cron for every ACTIVE roster row (`src/composio/sessions.ts` —
  `ensurePersonSession`; id persisted as `technicians.composio_session_id`, deleted at offboarding
  expiry, kept as a column for audit). Session restrictions are **execution-enforced** (verified —
  see the "Verified 2026-07-04" block in *Secret custody* below; match error code `4310`, not HTTP
  status).
- **Manager tier = the ENTIRE catalog + self-serve pairing** (`manageConnections: true`): managers
  pair new connectors themselves via OAuth links from their agent. NO structural block on
  destructive tools — safety = the "AI can make errors" disclosure + confirmation behavior
  context-engineered into the manager agent's instructions (Box_Setup_Stuff setup guide §0b).
  Deliberate, accepted risk (user decision).
- **Every sandbox (both tiers) also carries the accuracy-rules block** (setup guide §0c, since
  2026-07-05): copy user-given values (email addresses, amounts, dates…) character-for-character
  into tool arguments and self-check the staged copy against the user's message BEFORE showing
  the confirmation. Origin: the first live send E2E staged a mistyped recipient address — caught
  by the user at the confirm step, which is one step later than it should be. NOTE: the block
  lives in the sandbox's workspace `AGENTS.md`, which a container rebuild resets — re-append
  after any rebuild (bootstrap-box.sh `wire` phase does this).
- **Every sandbox also carries the batching block** (setup guide §0d, since 2026-07-09): for any
  large/long task the agent works in bounded, resumable batches — read a `task-progress/<task>.md`
  cursor first, process ~300–500 items, commit the outcome to the cursor, stop cleanly before the
  per-run timeout, resume in a fresh small-context turn, and on completion distill terse learnings
  into `MEMORY.md` while routing lasting customer/job facts to `record_field_note`. Origin: a
  ~38k-email cleanup ran the full 600s timeout and overflowed context by keeping every touched
  email in-context (research: `thoughts/shared/research/2026-07-08-long-running-agent-tasks.md`).
  Same workspace-`AGENTS.md` lifecycle as §0c — reset by rebuild, re-appended by the `wire` phase.
  Caveat: prompting steers but does not ENFORCE — verify on a real large-inbox run.
- **Credential lifecycle (verified 2026-07-11, recurring-outage class):** each sandbox's
  secrets (Telegram bot token, spine badge) live in an attached OpenShell provider. At **process
  launch** the env gets only a version-scoped placeholder REGISTRATION per credential; the real
  value resolves **in-process at component init** (bridge start / MCP connect) against the
  provider store — the egress proxy does NOT substitute per-request, and an unregistered
  credential means the component dies silently. Two standing consequences: (a) seat provisioning must have
  `TELEGRAM_BOT_TOKEN` in the onboard process env (`bootstrap-box.sh provision` handles it —
  a bare non-interactive onboard silently builds a deaf bot; bit s2 2026-07-05 and s4
  2026-07-10); (b) **any provider-credential write (badge install/rotation, token change)
  needs a container restart to take effect** — bit s3/Judy 2026-07-07→11 (spine MCP dead 4
  days: badge in store, absent from env). Drift probe: `bootstrap-box.sh verify` credential-
  freshness check. Details: setup guide §4b + §5b credential-lifecycle box.
- **Technician tier = pinned `direct_tools` list** (`TECHNICIAN_GMAIL_TOOLS`: fetch/draft/profile;
  product-configurable), `manageConnections: false`, **send structurally impossible** (4310).
  Technician send goes through the spine's `send_email` tool: persisted two-step confirm
  (stage → confirmId → consume-token-then-send, at-most-once) + synchronous L1 capture
  (`outbound_email`).
- **Manager actions are audited asynchronously**: the lifecycle cron pulls the v3.1 execution logs
  (`src/composio/logIngest.ts`, 60-min overlapping window) into L1 — email sends as
  `outbound_email` (verbatim, business correspondence), other state-changing calls as
  `agent_action` with **keys-only redaction** (argument key names, never values — L1 is
  undeletable) and `sensitivity='manager_only'` (filtered out of technician-tier spine reads).
  Reads are skipped; when unsure, capture. **Capture-all, no work/personal classifier** — recorded
  exception in CLAUDE.md.
- **mcp.url delivery: via the composio-doorman RELAY, no operator step (since 2026-07-06).** The
  session `mcp.url` is NOT distributed to sandboxes; the sandbox's `composio` MCP entry points at
  the doorman `/composio/` path (same badge) and Render pins each request to the person's session
  (see *Secret custody + gateway wiring* below). `scripts/provision-session.mjs` is diagnostics-only.
  Consequence for Feature A: a chat-only hire's auto-claimed sandbox gets Composio access with NO
  operator wiring — the relay reads `composio_session_id` per request.
- **Sandbox recycling (2026-07-12, zero-operator member replacement):** a manager's CONFIRMED
  `deactivate_technician_seat` (the one confirmation now warns that the person's assistant and
  its chat memory are destroyed) marks the sandbox for retirement; the box's 5-min badge pull
  carries it (`retirements[]`), badge-pull queues it, and `sandbox-recycler.service` runs
  destroy → re-provision a fresh cold blank under the NEXT ref **reusing the same Telegram bot**
  → `POST /control/sandboxes` (host pull-token) so the server retires the old pool row, racks
  the new blank, and clears the roster residue. Pool refills ~15 min after a swap; badge install
  for the NEXT hire is also automatic now (badge-pull installs + restarts the container, pending
  file = failure fallback only). **Reactivation during the grace period cancels a still-pending
  retirement (assistant intact); after destruction the person reactivates to a note routing the
  manager to `bind_telegram`, which claims a fresh blank — the agent's memory does not survive a
  recycle.** Failure surfaces: `/var/lib/sandbox-recycler/failed/` = parked entries needing an
  operator (dead bot token, server 409) — `bootstrap-box.sh verify` flags them. Details: setup
  guide §10.
- **Nudge delivery (2026-08-16 Stage 1 — the voice; v2 direct-send 2026-08-23, plan ④b):**
  the spine's watcher can queue ONE short work question for a technician (an unreported visit,
  a missing job cost). Since the one-call collapse (2026-08-24) the team-lead PLANNER writes
  that question itself and queues it in the same call — the separate compose turn is retired,
  and code appends only the `(re: customer — job)` anchor the seat agent files replies
  against. The box's
  `nudge-runner.timer` (5-min, root, reuses `/etc/doorman/badge-pull.env`) pulls
  `GET /control/nudges` and sends the served footer-less payload (`directMessageB64`) VERBATIM
  to the person's Telegram with `openclaw message send` (run inside the seat's container;
  multi-line body staged to an in-sandbox file first — exec argv rejects newlines). ZERO model
  calls on the delivery leg: the seat's model runs only on the person's REPLY, which lands in
  their NORMAL session with the sent question visible in channel history. Success is the
  send's own deterministic exit (no trajectory scraping); a sent-marker under
  `/var/lib/nudge-runner/` makes a re-served item re-ack instead of re-ping when only the ack
  was lost; outcome reported via `POST /control/nudges` (host pull token; the server serves an
  item until acked — lost ticks self-heal, ~10 unacked serves and the server hands the gap to
  the manager instead). The technician's reply takes the ordinary `record_field_note` path —
  the seats' AGENTS.md "Questions and items from the office" block (bootstrap-box.sh §0k)
  carries that record-duty, and that capture is what auto-closes the nudge. **The follow-up leg
  (2026-08-25, the ask-shape plan):** a `recorded` result may now carry `openQuestions` — the
  office's still-open questions on that job for that person, deduped by text (an ask-group's
  members all hold the same grouped message, so a batched ask reads back as ONE entry) and
  deliberately UNFILTERED, since attribution declines to stamp when two or more gaps are asked,
  so the spine has no signal for which one was just answered. §0k clauses 1a/1b are what use it: the
  agent compares the list against what the person actually said, asks ONE genuinely uncovered
  thing in its own words (never naming the office or the queue, never repeating the `(re: …)`
  line an entry may end with — production `question` values are `questionDraft + anchorLine`,
  so they carry it), and then **records that reply with `record_field_note` on the same job**.
  1b is not decoration: a follow-up asked and not recorded leaves the gap `asked`, and the
  planner re-asks the person the very thing they just said (adversarial review, 2026-08-25).
  **Two traps 1b has to name explicitly**, both found in review: (a) the reply to a follow-up is a
  bare fragment ("about two hundred"), which `matchIdentity` cannot resolve, so 1b tells the agent
  to pass `confirmed:{customerId}` with NO `confirmId` — the one-shot branch (`server.ts:2431`)
  reads `confirmed` before the `confirmId` branch, and the schema now says so, because otherwise
  the agent asks WHICH customer seconds after recording one for them; (b) `setNudgeAnsweredBy`
  does not change `status`, and the watcher's activity auto-close needs `soleGapOnJob`, so with 2+
  gaps — exactly the batched case — the list does NOT shrink as they answer. 1a therefore judges
  against the whole conversation, not the last message, or it re-asks what it already covered. ZERO extra model calls
  on the ASK leg — this is the seat agent's own reply turn, and the office is never woken by the
  answer (ruled out 2026-08-25: a planner sentence landing mid-conversation is two voices in one
  chat, and the planner holds no technician write tools). Pacing: NO
  per-person cap (2026-08-18 ruling — pace by urgency, earn the ask, batch the unimportant;
  the old ≤2-asks/day server cap was removed in PR #153); prolonged silence escalates to the
  manager's review queue via the planner. Kill switch on the box: `systemctl disable --now
  nudge-runner.timer`. Details: setup guide §3c + `Box_Setup_Stuff/nudge-runner.sh` header.

**Phase-5 live verification (2026-07-04, fresh-context probe against the live project):**
- **Enforcement re-confirmed with the production configs**: technician session rejects
  `GMAIL_SEND_EMAIL` with HTTP **400** `code 4310 / ToolRouterV2_ToolNotInEnabledList` (docs say
  403 — match code/slug); pinned tools pass the gate (4302 downstream); the restriction is stored
  server-side (`tool_router_tools` = exactly the three pinned slugs, `manage_connections.enabled
  = false`).
- **DIRECT_TOOLS surface**: the technician MCP endpoint exposes EXACTLY the three pinned tools —
  no meta-tools at all. Adversarial connection-minting attempts (`COMPOSIO_MANAGE_CONNECTIONS`,
  `COMPOSIO_INITIATE_CONNECTION`, search, multi-execute, direct `tools/call GMAIL_SEND_EMAIL`)
  all `-32602 not found` — **no connection-minting route exists**; the
  `manageConnections:{enable:false}` contingency is not needed. All three
  `TECHNICIAN_GMAIL_TOOLS` slugs exist in the current catalog, `is_deprecated:false`.
- **Manager session**: full meta-tool set incl. `COMPOSIO_MANAGE_CONNECTIONS`; catalog breadth
  proven (search plans cite `GOOGLESHEETS_*`/`GOOGLEDRIVE_*`); self-serve pairing mints a real
  `connect.composio.dev/link/...` redirect (10-min expiry).
- **Logs API v3.1 (the ingestion contract)**: envelope rows under **`logs`** (not items/data);
  `next_cursor` epoch-ms string, `null` when exhausted, request field `cursor`; `time_range`
  MUST be epoch-ms numbers (ISO strings → 400). Item: `{id, timestamp, type, status, level,
  metadata, metrics, parent}` — `status` top-level; `metadata.user_id` (string, composite);
  **`metadata.tool` is an object `{slug, version, is_deprecated}`**; `metadata.toolkit` an object
  `{slug, icon}`. Detail `GET …/{id}` adds `data = {success, request:{payload:{…}},
  response:{status_code, body:{…}}, logs}`. **Permission-gate rejections (4310) are NOT logged**
  — the audit sweep sees only executions that ran. Retention: windows back to 400 days accepted
  (no upper bound observed; sparse data today, so depth is unproven — the 60-min sweep window is
  safely inside any plausible retention). `src/composio/logIngest.ts` parses these verified
  shapes with the older assumed spellings kept as fallbacks.

### Multi-tenant model
- **One business = one tenant UUID; Composio `user_id` is per PERSON (revised 2026-07-01):**
  `user_id = "<tenantUuid>:<technicianRef>"` — one connected account + one trigger per person, so ten
  employees' personal inboxes pair to ten isolated connected accounts under one shared spine tenant.
  The inbound webhook splits on the FIRST colon (`src/inbound/webhook.ts`) → tenant scopes the spine
  rows, ref becomes the capture/visit attribution. The webhook also consults the `technicians`
  roster: an offboarding/offboarded person's mail is dropped with a receipt (never ingested); an
  unknown ref is ingested AND flagged for manager review (`review_items`) — mail is never lost to
  a provisioning slip. **Bare-uuid `user_id`s were retired 2026-07-02**
  (the webhook rejects them `bad_payload`; the last legacy pairing was deleted the same day —
  every pairing is per-person now). A person's handle can only reach their
  own connected account → A's agent structurally cannot touch B's mail or another tenant's spine
  (Composio scopes credentials and data per `user_id`: "User A's agent never touches user B's data" —
  [Authentication](https://docs.composio.dev/docs/authentication)). Never use Composio `user_id="default"`.
- **Pairing rules (consequences of per-tenant dedup + append-only L1):** (1) **One pairing per
  mailbox** — when migrating a mailbox from bare-uuid to composite, delete the legacy connected
  account + trigger first; if both fire, both deliveries share one Gmail `message_id`, whichever
  lands first permanently stamps the capture's `technician_ref` (L1 has no update path) and the
  other is discarded as a duplicate. (2) An email CC'd to N paired people yields N captures (Gmail
  message ids are mailbox-local) — accepted: each person really received it; identity-match reuses
  the customer/job. (3) **Vocabulary contract:** the `technicianRef` minted into the `user_id` must
  byte-equal the doorman badge ref and the schedule sheet's technician column
  (`schedule_entries.technician_ref`, exact case-sensitive match) — otherwise schedule-assisted
  matching is dead for that person and L1↔badge joins fail. *(The schedule sheet retired
  2026-07-15 with the Telegram-schedule series Plan 1 — the DB owns the schedule
  (the `visits` table — named `assignments` until rung 9b, 2026-09-05 — keyed to the roster
  row by UUID), so the vocabulary contract is now just
  badge ref ⇔ roster ref ⇔ Composio user_id; there is no sheet column to keep in sync.)*
  The `connector:` prefix is reserved (webhook rejects composite refs that use it). (4) **Refs are unique per tenant — mint
  from full-name slugs or employee ids, never bare first names** (two Janes as `…:jane` would merge
  both inboxes into one identity, permanently — L1 is append-only). **DB-enforced since 2026-07-02:**
  the `technicians` roster's `unique (tenant_id, ref)` spans ALL rows (offboarded included), so a
  ref is never reused across humans. The reconnect script's `--replace` guard remains as the
  Composio-side complement (it checks live connections, not the roster).
- **One Auth Config per platform, not per company — Composio-managed (decided 2026-07-01, supersedes
  the earlier custom-Auth-Config plan).** We ride Composio's own pre-verified OAuth app: no Google OAuth
  client of ours, no Google CASA verification, no creds in our env. Verified in the dashboard: auth config
  `gmail-test` (`ac_5CdPk4l3GV2V`) is **Composio Managed** with 11 scopes including
  `https://mail.google.com/` (full read + compose + send), so inbound full-mailbox read and outbound
  draft/send are all covered by the managed defaults. Each company authorizes *their* account against
  this shared config via a **Connect Link** → a per-company **connected account** keyed by `user_id`.
  Onboarding company #N = send a Connect Link.
  Accepted tradeoffs (per [Managed vs custom auth](https://docs.composio.dev/docs/custom-app-vs-managed-app)
  and the [Gmail toolkit FAQ](https://docs.composio.dev/toolkits/gmail)): Google's consent screen says
  "Composio" (not our brand), quota is shared ("managed apps share quota across all Composio users"),
  and scopes are pinned to Composio's verified defaults (adding scopes beyond them breaks — "scopes
  that Google hasn't verified for that client"). If branding/quota/scopes ever bite, the switch path
  is a custom **Auth Config** (our own Google OAuth client + CASA verification) — a dashboard-level
  change; no repo code assumes either mode.
- Use **Connect Link / hosted auth** (`composio.connectedAccounts.link()` / `session.authorize()`). Only the
  `initiate()` **method** (`POST /connected_accounts`) for **Composio-managed** OAuth is being retired — it
  returns `400 BadRequest` starting **2026-05-08** (new orgs) / **2026-07-03** (all orgs). `link()` is
  unaffected and works with managed OAuth; custom Auth Configs and non-OAuth schemes (API key/bearer/basic)
  are exempt. Managed OAuth as a *strategy* is not going away — only the `initiate()` call is; migrate any
  `initiate()` usage to `link()`. Source: [Composio changelog](https://docs.composio.dev/docs/changelog) and
  [Connected Accounts](https://docs.composio.dev/docs/auth-configuration/connected-accounts).

### Secret custody + gateway wiring
- **Outbound custody of record (relay, since 2026-07-06):** the Composio session **`mcp.url` is
  NOT distributed to sandboxes at all** — neither the url nor any Composio key ever leaves the
  control plane. A sandbox reaches Composio through a `composio` MCP entry pointing at the
  doorman's `/composio/` path, authenticated by the **same badge** it already holds. The doorman
  forwards to the Render relay (`src/composio/relayHandler.ts`), which verifies the signed
  identity, looks up `composio_session_id`, and forwards ONLY to that session with the Composio
  key (`COMPOSIO_RELAY_API_KEY`, scoped; master fallback) attached **server-side**. Per-person
  pinning is the boundary; the caller controls request content, never the destination or credential.
  ```jsonc
  { "mcp": { "servers": {
      "trades-spine": { /* HTTP server + signed x-tenant-id headers (§3b) */ },
      "composio":     { "transport": "streamable-http",
                        "url": "http://host.openshell.internal:3001/composio/",
                        "headers": { "Authorization": "Bearer openshell:resolve:env:TRADES_SPINE_BADGE" } }
  }}}
  ```
  *Why not the direct session url (the retired secretRef wiring):* the url alone 401s
  (`require_mcp_api_key`) and the SDK's session auth header IS the master key — putting it in a
  sandbox would grant any-user access. **Live-probed 2026-07-06:** Composio pins the connected
  account to the session (a forged `connectedAccountId` in tool args is ignored — the relay's
  arg guard is defense-in-depth, not load-bearing), the scoped key is accepted, and the session
  MCP responds SSE. `scripts/provision-session.mjs` is now diagnostics-only.
- Allowlist only the actions each tier needs (e.g. `GMAIL_SEND_EMAIL`, `GOOGLESHEETS_BATCH_GET`) — mirror §4.
- **Per-person capability control lives at the gateway, not in Composio (decided 2026-07-01):** the
  doorman badge already resolves `{tenantId, technicianRef}` per bot, and a future per-tier tool
  allowlist attaches there. Composio's **Execution Allowlist** is configured per auth config
  (dashboard-observed 2026-07-01: "Restrict which tools agents can execute. Leave empty to allow
  all"), and our shared-config model means one config serves every tenant and person — so it is only
  the **global ceiling** (e.g. "no send anywhere"), never per-person policy.
- **Verified 2026-07-04 (docs research + live probe) — this changes the premise above; decision under
  review with the user:**
  - **Auth-config Execution Allowlist: still UNVERIFIED as an enforcement boundary.** The API field is
    `tool_access_config.tools_available_for_execution` (live OpenAPI,
    https://backend.composio.dev/api/v3/openapi.json); the prose docs never state that executing a
    non-allowlisted tool fails — the only blocking claim is marketing
    (https://composio.dev/protection). Treat as defense-in-depth only, never the boundary. Note: before
    the Jan 14, 2026 "True PATCH Semantics" fix, omitting `tool_access_config` on an auth-config update
    silently reset it to `{}` (https://docs.composio.dev/reference/changelog).
  - **Composio SESSIONS (Tool Router GA, Dec 2025) ARE an execution-time enforcement boundary —
    live-verified 2026-07-04 against our project.** A session is created per user
    (`composio.sessions.create(userId, { toolkits, tools:{gmail:[...]}, mcp: true })`,
    SDK ≥0.13.1) and its restriction is enforced at execution on BOTH paths: session execute returns
    HTTP 400 `code 4310 / slug "ToolRouterV2_ToolNotInEnabledList"` ("[Session Restriction] Tool
    'GMAIL_GET_PROFILE' is not enabled for this session"), and the session's MCP endpoint (meta-tool
    `COMPOSIO_MULTI_EXECUTE_TOOL` route) rejects identically, while a control session with the tool
    enabled passes the gate (fails later at connection resolution, `4302 /
    ToolRouterV2_NoActiveConnection` — proving the layers). Docs:
    https://docs.composio.dev/docs/configuring-sessions, https://docs.composio.dev/docs/sessions-via-mcp.
    ⚠ Doc discrepancy: docs say 403; live API returns 400 with code `4310` — match on the code/slug,
    not HTTP status. ⚠ Default session preset exposes only six meta-tools over MCP `tools/list`
    (app tools run via `COMPOSIO_MULTI_EXECUTE_TOOL`); a fixed direct list needs the `DIRECT_TOOLS`
    preset. Consequence: per-person AND per-tier policy CAN live in Composio session config (one
    session per person, keyed by our composite `"<tenant>:<ref>"` user id) — the 2026-07-01 "only the
    gateway can do per-person" premise no longer holds. Caveats before relying on it as the ONLY
    boundary: over MCP our code is not in the request path ("you can't intercept, reshape, log, or
    gate calls" — sessions-via-mcp docs), and Composio had a tool-execution-sandbox breach May 21–25,
    2026 (https://composio.dev/blog/composio-may-2026-security-incident). If tool slugs are pinned in
    session configs, re-check them after Composio catalog releases (May 2026 consolidation renamed
    tools; a stale slug silently enables nothing).

### Scopes (least privilege)
- **Managed OAuth means one broad token per connected account** — the managed app grants
  `https://mail.google.com/` (read + compose + send together; dashboard-observed 2026-07-01), so a
  send-only-token split is not available. Least privilege moves to the **action layer**: per-person
  Composio **session** tool configs (execution-enforced — verified 2026-07-04, see gateway bullet
  above) with the per-auth-config Execution Allowlist as unverified defense-in-depth, plus the
  per-tier gateway allowlist (§4). ⚠ **Interim gap, accepted:** the per-tier
  gateway allowlist is not built yet, so until it ships, any agent holding a tenant's Tool Router
  `mcp.url` can both read the full mailbox and (if the ceiling permits) send — a capability the old
  send-only-token design made structurally impossible. Set the dashboard ceiling to draft-only until
  the gateway tier allowlist exists.
- **Inbound needs full-mailbox read** (Gmail read scope is all-or-nothing; no "work-only" scope exists),
  and that read-capable token lives in **Composio's** storage — a trust boundary to note in any customer
  data-handling review. The managed defaults also include profile/contacts read scopes — list them in any
  customer-facing privacy summary.
- *(Only if we switch to a custom Auth Config:)* outbound could then use send-only scopes (`gmail.send`)
  so the stored token literally cannot read the inbox; restricted read scopes would need one-time Google
  app verification (per client, not per company).

### "Both" spreadsheets
- **Google Sheets** — existing GCP OAuth client + Sheets API.
- **Microsoft Excel** — separate **Azure app registration** + Microsoft Graph delegated perms
  (`Files.ReadWrite`, `offline_access`); the workbook must live in **OneDrive/SharePoint** (a work/Entra
  account is the smooth path). One client each — not per company.
- The agent sees `googlesheets` *or* `excel` tools via `session.toolkits()` based on what the tenant
  connected; normalize behind a thin spine tool so prompts aren't app-specific (cell/range vs Graph-object
  shapes differ).

### Inbound email filtering (work vs personal)
Filtering is downstream of the token (read scope can't restrict to "work only"), so it's the same
classifier path we already have — now fed by Composio's Gmail trigger. Defense-in-depth, cheapest first:
1. **Trigger-side** (`GMAIL_NEW_GMAIL_MESSAGE` `query`/`labelIds`) — only fire for matching mail; also
   minimizes personal mail transiting our infra.
2. **Cheap deterministic drop** in the webhook handler (list/marketing headers, sender denylist).
3. **Model classifier** ([src/email/classify.ts](../src/email/classify.ts)) — the real work/personal
   call (GLM-5.2 by default; `MODEL_PROVIDER` selects the provider).
- **Classify _before_ the L1 insert.** `raw_captures` is append-only (no delete path), so personal mail
  written to L1 is retained forever — the classifier must gate the insert, never run after it.
- Bias low-confidence to a **review bucket**, not a silent drop (dropping a real work email is costlier).
- **Dedup by Gmail message id** before insert — Composio's trigger doesn't dedup, and managed-auth polling
  is **≥15 min** (not real-time).

### Stay connector-agnostic (don't overfit to Gmail)
Gmail + spreadsheets are the first connectors, **not** the design center. **Outbound** generalizes for
free — the per-tenant Tool Router `mcp.url` exposes whatever toolkits the tenant connected (allowlist is
per-tenant policy; keep agent prompts provider-neutral). **Inbound** is just more channels into the
already channel-agnostic write-path (overview §4): a generic webhook routes by `toolkit`+`triggerType` →
a per-source **normalizer** (`payload → { channel, rawText|blobRef, externalId, occurredAt }`) → the
**shared** dedup-by-externalId / classify-before-L1 / extract pipeline. The "work vs personal" classifier
is a Gmail-specific, *optional* per-source filter — other sources (e.g. a dispatch Slack channel) may need
none. Prove the seam by shipping **two differently-shaped connectors** (Gmail inbound+outbound;
Sheets/Excel outbound); don't build a speculative framework for connectors you don't have yet (YAGNI).
Adding connector #N should then be: a Composio Auth Config + a config entry + (inbound) one normalizer —
no pipeline change.

### Build note
The code-touching pieces — control-plane onboarding endpoint, per-tenant `mcp.url` injection, the inbound
trigger webhook handler (verify Composio's HMAC `webhook-signature`) — are non-trivial: run them through
**/research → /plan → /implement** (CLAUDE.md).

## Live verification (run once provisioned)
- **Chat channel:** send a Telegram voice note → confirm the address in chat → read back over `pg`
  that an L1 `raw_captures` row (`channel='technician_voice'`) exists **and** an L2 job/visit links
  to it via `source_capture_id`. Then ask the bot a question and confirm it answers from
  `get_customer_context` (the contents page) and opens the note with `get_capture` when asked
  for the exact words.
- **Email channel:** send a real **work** email → it appears in the spine (L1 `channel='email'` + L2
  when it matches a customer); send a **non-work** email → it is filtered out (no rows). Spot-check
  the classifier's precision on a sample of real inbox mail.
- **Connector isolation (Option B):** create a second test tenant with a *different* connected Google
  account and confirm tenant A's `mcp.url` cannot see tenant B's mail/sheets — the one test that proves
  the `user_id`=tenant invariant holds.
