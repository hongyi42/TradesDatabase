---
date: 2026-08-15
task: "Feature B — Intelligent spine Stage 1 (the voice): team-leader outreach through the person's own agent, capped identity class, server-side nudge budget/dedup/escalation"
research: thoughts/shared/research/2026-08-15-feature-B-intelligent-spine-stage-1-team-leader-voice.md
status: draft
---

## Overview

Stage 1 gives the spine a voice. A deterministic watcher on the 15-minute heartbeat notices a gap
(a confirmed visit's time passed hours ago, nothing came back), a model turn — acting as a new,
hard-capped **team-leader identity** — decides whether/how to ask and composes ONE question, and
the question is delivered through the technician's *own* agent (`openclaw agent … --deliver`, the
verified CLI gateway path). The reply flows back through the ordinary `record_field_note` capture
path. Budget, dedup, and the escalation ladder are server-side mechanism, never prompt text.
Direction doc: `thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md`, constraints 1–5.

**Size flag (plan.md's 300-line rule):** this plan runs ~390 lines — the scope spans five surfaces
(DB, identity gate, model turn, transport endpoints, box component) plus the task-mandated File
footprint and Assumptions sections. If the reviewer prefers a split, the natural cut is after
Phase 3: Phases 1–3 = "the voice, spine-side" (fully testable locally, delivers nothing), Phases
4–5 = "the transport" as a follow-on plan.

## Decisions

- **Transport (research D1) → (b) the box PULLS a nudge queue**: `/control/nudges` GET + report
  POST under the existing `HOST_PULL_TOKEN` auth; a box-side runner executes the CLI locally.
  Rejected: (a) Render→box ssh — no such credential exists and it inverts the "spine never reaches
  into the box" posture; (c) `/hooks/agent` — proven dead end on trades-box-1 (provider preflight
  false-negative, cannot be disabled). Cost accepted: ≤5 min delivery latency.
- **Identity class (D2) → (b) reserved-namespace ref + deny-by-default allowlist in `dispatch`.**
  `technicianRef = 'spine:team-lead'` — no roster row, no badge, no enum migration; `slugify`
  mints human refs over `[a-z0-9-]`, so the `:` namespace can never collide (the `connector:`
  precedent). Because a roster-less identity today gets the FULL technician surface (research
  constraint 3), the gate denies the whole `spine:` namespace by default: only
  `TEAM_LEAD_TOOL_NAMES` (read-only in v1) dispatch. Mechanism, not prompt (constraint 2).
- **Budget/dedup state (D3) → new `nudges` table**, tenant-scoped, whole lifecycle
  (pending → queued → asked → answered/escalated/cancelled/failed); plain unique index
  `(tenant_id, kind, subject_ref)` = **ask once per subject, ever**. `review_items` is used only
  for the escalation rung. Constraint-37 debt (cleanup lists) paid in the same phase.
- **Capture policy (D4) → outreach NOT L1-captured** (product-facing — confirm at review). L1 is
  undeletable and the 2026-07-04 outbound exception does not extend by analogy; the `nudges` row
  (question, evidence, timestamps, `actor_ref='spine:team-lead'`) is the durable, prunable audit.
  The reply needs no new policy: person's agent → `record_field_note` → normal L1/L2, their ref.
- **Escalation last rung (D5) → review item + ONE batched manager push** (product-facing).
  Unanswered after 2 firm days → `review_items` kind `unanswered_nudge` (pull, visible in
  `list_pending_reviews`) + one batched `notifyManagers` line per tenant per tick — the exact
  shape money-inference Phase 3 chose for `job_done_check`.
- **Session (D6) → fresh session per nudge (`nudge-<id>`), self-contained copy** (eval-proven;
  id reuse resumes stale conversations). `OPEN — needs live evidence`: whether the human's
  Telegram reply lands in a session that still holds the question is unobserved (all prior
  `--deliver` runs hit a dead chat). Phase 5 resolves it; the copy names customer + date so the
  reply is recordable even context-less.
- **Process shape (D7) → extend `src/jobs/lifecycle.ts`** with two steps (deterministic sweep;
  model compose), key-gated `{skipped}` + per-row isolation so ordinary conditions never redden
  the heartbeat (constraints 24–25). A dedicated worker is unwarranted at pilot volume.
- **Watcher inventory (D8) → one archetype**: overdue *placed* confirmed visit. Stage 0 never ran;
  the `nudges` rows are themselves the calibration instrument. Unplaced (NULL-times) rows are out
  of scope v1 — they have no "time passed" moment.
- **Budgets (product-facing defaults):** 2 asks/person, 6 asks/tenant per rolling 24h; overdue
  threshold 3h; escalate at 2 days; compose/delivery attempts ≤3. Env-overridable.
- **Fabrication guard (constraint 8):** code assembles the evidence block + standing footer; the
  model writes ONLY the question sentence (or declines). Dates are printed by code from the row —
  bare date, no weekday, so the weekday guard has nothing to mismatch.

## Plain-language walkthrough

**Phase 1 — the notebook.** A new table, `nudges`, is the team leader's notebook: one row per
question it ever considers — who, about what, current state. A unique index makes "ask once, not
every 15 minutes" a database guarantee, not a promise.

**Phase 2 — the watcher.** The existing 15-minute heartbeat gets a new sweep: plain SQL (no AI)
finds confirmed visits that ended 3+ hours ago with no note and no job-status change and writes a
`pending` row — if the person's daily budget allows. The same sweep closes rows whose gap got
filled and escalates two-day silence to the manager.

**Phase 3 — the brain.** A model turn reads each pending row's evidence and writes the question
("How did the Miller St visit (Aug 14) go?") — or declines. It acts under a new identity the tool
boundary caps to read-only tools by mechanism: even a buggy prompt cannot send email or book a
visit, because `dispatch` refuses those tool names outright.

**Phase 4 — the mouth.** The spine never reaches into the agent box; the box already phones home
every 5 minutes for badges. A sibling endpoint serves queued nudges the same way, and a small
box-side runner delivers each through the person's own agent and reports back. Lost ticks
self-heal: a nudge is served until acknowledged.

```
heartbeat (15 min)                        trades-box-1 (5-min timer)
  watcher SQL ─▶ nudges: pending            GET /control/nudges ◀─ queued rows
  budget+dedup gate (server-side)             nemoclaw <sandbox> agent --deliver
  team-lead model turn ─▶ queued              ──▶ person's Telegram, from THEIR agent
  escalation sweep ─▶ manager digest        POST /control/nudges (ack) ─▶ asked
                                            human replies ─▶ agent ─▶ record_field_note
                                            ─▶ L1/L2 … next sweep ─▶ answered
```

**Phase 5 — proof and disclosure.** One end-to-end run into a developer-owned chat (never a real
technician), plus the ratified worker disclosure in the firm-facing docs.

## Secrets & env preflight

- **Phases 1–2:** none new (local stack, `.env.test` — `already required`).
- **Phase 3:** `MODEL_PROVIDER` + `INFERENCE_API_KEY` — `already required` (extractor). ⚠ Render
  currently holds the suspended Fireworks key (parked state 2026-08-15): compose reports per-row
  errors until rotated; tests inject stubs. Optional: `TEAM_LEAD_OVERDUE_HOURS`,
  `TEAM_LEAD_BUDGET_PERSON_DAY`, `TEAM_LEAD_BUDGET_TENANT_DAY`.
- **Phase 4:** `HOST_PULL_TOKEN` — `already required`; the runner reuses
  `/etc/doorman/badge-pull.env`. No new secret is minted anywhere in this plan.
- **Phase 5:** ssh to trades-box-1 + Render deploy + Supabase MCP (pilot) — operator-held already.

## Phase 1: The `nudges` table + typed layer

### What this phase does
Creates the durable nudge state and its accessors; pays the cleanup-cascade debt immediately.

### Changes required

**`supabase/migrations/20260816090000_nudges.sql`** (new; grants + `updated_at` trigger
boilerplate mirrors `20260815160000_money_events.sql`)
- `nudges`: `id uuid pk`, `tenant_id uuid not null references tenants(id)`, `kind text not null`,
  `subject_ref text not null`, `technician_id uuid references technicians(id)`,
  `status text not null default 'pending'` + CHECK in
  (`pending|queued|asked|answered|escalated|cancelled|failed`), `question text`,
  `context jsonb not null default '{}'`, `attempts int not null default 0`,
  `serve_count int not null default 0`, `actor_ref text not null default 'spine:team-lead'`,
  `resolution text`, `created_at/updated_at/queued_at/asked_at/resolved_at timestamptz`,
  `unique (tenant_id, kind, subject_ref)` (ask-once-ever — NOT partial).

**`src/db/nudges.ts`** (new; tenant-scoped, `getClient()` only)
- `createPendingNudge(input)` — insert-catch-23505 → `null` (dedup IS the index);
  `listNudgesByStatus(tenantId, statuses)`; `markNudgeQueued(id, tenantId, question)` and
  `markNudgeOutcome(id, tenantId, status, resolution?)` — status-guarded conditional UPDATEs
  (the `resolveOpenReviewItemFor` shape); `countRecentAsks(tenantId, technicianId|null, sinceIso)`
  — budget read over `queued_at >= since`, statuses `queued|asked|answered|escalated`.

**Registrations (eng-memory §1 rule — by name, this phase):** `scripts/spine-eval/world.mjs`
`RESET_TABLES`; `scripts/seed.mjs` `truncateSpine`; `src/mcp/server.test.ts:103` truncate
statement; grep `truncate table` across `src/` and add `nudges` wherever `review_items` is cleared
(e.g. `src/mcp/httpServer.test.ts`).

**`src/db/index.ts`** — export the module. **`src/db/database.types.ts`** — regen from the local
stack after `npx supabase migration up` (pilot apply is Phase 5 rollout).

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] new `src/db/nudges.test.ts`: repeat insert → null; queued→asked legal, asked→queued refused;
  `countRecentAsks` window edges; cross-tenant id resolves nothing

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [ ] psql: columns + unique index present; `world.mjs` present-tables log lists `nudges`.

### Manual verification
- none
---
*No manual items — continue.*

## Phase 2: Watcher, budget/dedup gate, escalation (deterministic half)

### What this phase does
The heartbeat learns to notice, budget, auto-resolve, and escalate — zero model calls.

### Changes required

**`src/db/assignments.ts`** — `listOverdueConfirmedAssignments(tenantId, cutoffs)`: placed rows,
`status='confirmed'`, `technician_id not null`, `ends_at < cutoffs.naiveLocalCutoff` (times are
naive-local; derive BOTH cutoffs from one firm-local moment — money-plan review finding), embed
`jobs!inner(id,tenant_id,status,title,customer_id,customers(name,tenant_id))` filtered to
`status in ('open','in_progress')` + `technicians(id,ref,display_name,state,telegram_user_id,
sandbox_ref,host_id,tenant_id)`; caller re-checks every embedded `tenant_id` (embeds don't
inherit tenancy).

**`src/teamLead/watcher.ts`** (new) — `sweepTenant(tenantId, nowIso, deps)`:
1. *Auto-resolve*: open nudges (`pending|queued|asked`) whose gap closed — job left
   `open|in_progress`, or `listRawCapturesForJob` shows a capture with `captured_at` (true UTC)
   after the visit end → `markNudgeOutcome(…, 'answered', 'gap closed')`.
2. *Detect*: overdue rows → skip inactive / Telegram-less / sandbox-less technicians (constraints
   19–20: liveness filtered here, bots can't message first) → budget via `countRecentAsks`
   (person 2, tenant 6, rolling 24h) → `createPendingNudge` with code-built `context`
   `{customerName, jobTitle, visitDay, visitEnd, technicianRef, assignmentId}`.
3. *Escalate*: `asked` older than 2 firm days → `upsertOpenReviewItem` kind `'unanswered_nudge'`
   (`subject_ref` = nudge id) → mark `escalated`; ONE batched `notifyManagers` per tenant.
   Constants module-level, env-overridable via `safeEnvInt` (exported by `src/mcp/server.ts`).

**`src/db/reviewItems.ts`** — add `'unanswered_nudge'` to `ReviewKind` (free-text column, no
migration; non-token: resolve = handled, dismiss = let it go).

**`src/jobs/lifecycle.ts`** — step 8 `teamLeadSweep`: iterate `listTenantSeats()`; per-tenant
try/catch with the pairing sweep's systemic-failure detector; firm tz via `getTenant` for the two
cutoffs; summary `teamLead: {tenants, resolved, created, escalated, rowErrors} | {stepError}`;
deps seam (`sweep?: typeof sweepTenant`).

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] `src/teamLead/watcher.test.ts` (local DB): 3.1h overdue → one row; 2.9h → none; re-run →
  still one; capture-after-end → answered; job completed → answered; inactive/unbound skipped;
  budget-exhausted skipped; unplaced never matches; naive-local and UTC legs each pinned near the
  boundary
- [ ] lifecycle: throwing sweep → `stepError`, other steps still run; summary shape pinned
- [ ] escalation: 2.1-day `asked` → ONE review item + ONE batched notify; dismissed item never
  re-opens

### Live verification (agent-executable)
- Prerequisites: local stack, `npm run seed:local` data.
- [ ] `npm run job:lifecycle` locally (keyless steps skip): `teamLead` counts in summary JSON;
  nudge rows read back via psql.

### Manual verification
- none
---
*No manual items — continue.*

## Phase 3: Team-lead identity ceiling + the compose turn

### What this phase does
The hard-capped identity class (mechanism, in `dispatch`) and the model turn that writes questions.

### Changes required

**`src/mcp/server.ts`**
- `export const TEAM_LEAD_REF = 'spine:team-lead'`; `export const TEAM_LEAD_TOOL_NAMES = new
  Set(['query_spine', 'get_customer_context', 'resolve_date'])` (read-only v1; "stage" verbs are
  a future, separate decision).
- In `dispatch`, after the cost event (~line 1894 — refused calls still count, the admin-gate
  precedent): `if (identity.technicianRef.startsWith('spine:') && !TEAM_LEAD_TOOL_NAMES.has(name))
  throw new Error('the team-lead identity is capped to read/ask/stage — tool not allowed')`.
  Deny-by-default for the whole namespace: a forgotten entry fails closed (targetGuard doctrine).
  `tools/list` untouched — discovery is cosmetic, dispatch is the gate.

**`src/teamLead/compose.ts`** (new) — `composeNudge(nudge, deps)`:
- `runForcedTool` (`src/model/forcedTool.ts`) with forced schema
  `{ask: boolean, question: string, reason: string}` — structured output, no parsing.
- Prompt carries ONLY the code-built `context`; instruction: one colleague-tone question or
  decline — never invent facts, links, or dates.
- Code assembles the delivered message: model question + code-printed evidence line
  ("re: <customer>, <jobTitle>, <bare date>") + fixed footer directing the receiving agent: check
  your own conversation context first; if the technician answers, record via `record_field_note`
  (result-embedded directive — prompt rules are steering, not enforcement).
- `ask:false` → `markNudgeOutcome(…, 'cancelled', reason)`.

**`src/jobs/lifecycle.ts`** — step 9 `teamLeadCompose` (after step 8, same tick): `{skipped}`
when the inference key is unset (step-3/4 idiom); per-row try/catch, `attempts` ≥3 → `failed`;
success → `markNudgeQueued`.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] dispatch tests: with `spine:team-lead` identity, `query_spine` dispatches;
  `record_field_note`, `send_email`, `book_visit`, an admin tool all throw the cap error; ordinary
  refs unaffected; roster read tolerates the roster-less ref
- [ ] compose (stubbed model): ask:true → queued with evidence line; ask:false → cancelled;
  model throw ×3 → failed
- [ ] lifecycle: key unset → `{skipped}`; summary shape pinned

### Live verification (agent-executable)
- Prerequisites: local stack + working inference key in `.env` (key-gated test, skip cleanly).
- [ ] one real `composeNudge` on a seeded overdue nudge — evidence: composed text + `queued` row.

### Manual verification
- [ ] Read 2–3 composed questions: colleague tone, not audit tone (direction constraint 5)?
---
*Pause after this phase — the manual tone check is non-empty.*

## Phase 4: Transport — pull queue + box runner

### What this phase does
Queued nudges reach the box the way retirements do: served on a host-token pull until acknowledged.

### Changes required

**`src/control/nudgeQueue.ts`** (new; `badgeFile.ts` dep-injection pattern)
- `buildNudgeDelivery(hostId, deps)`: `queued` nudges whose technician's `host_id` = hostId AND
  state active AND `sandbox_ref`/`telegram_user_id` present (liveness re-filtered at serve time)
  → `[{id, sandboxRef, replyTo, sessionId: 'nudge-'+id, messageB64}]`; increments `serve_count`;
  `serve_count > 10` → `failed` ('undeliverable') instead of serving — the PARKED analog, a
  poison item must not re-alarm forever.
- `completeNudgeDelivery(id, outcome, detail)`: `delivered` → `asked` (+`asked_at`); `failed` →
  attempts++, ≥3 → `failed`.

**`src/mcp/httpServer.ts`** — two routes beside `/control/badges` (~line 427), same host-token
gate and pre-allowlist placement: `GET /control/nudges`; `POST /control/nudges` (body capped, the
board's idiom).

**`Box_Setup_Stuff/nudge-runner.sh` + `.service` + `.timer`** (new; 5-min timer; ops-report.sh
discipline: separate unit, ALWAYS exits 0, hard `--max-time`/`timeout`): curl GET with
`HOST_PULL_TOKEN` from `/etc/doorman/badge-pull.env`; per item: validate `sandboxRef` against
`^[A-Za-z0-9_]+$` (badge-pull.sh:320 rule), `MSG=$(base64 -d)`, `timeout 180 nemoclaw $sref agent
--agent main --session-id $sid -m "$MSG" --deliver --reply-channel telegram --reply-to $replyTo
</dev/null`. Success judged by assistant text in the session TRAJECTORY
(`nemoclaw $sref exec --no-tty -- cat /sandbox/.openclaw/agents/main/sessions/$sid.jsonl`) —
never stdout (constraint 30), never `docker exec` (nested netns). One item's failure never aborts
the loop; then POST the outcome.

**Docs sync (standing rule):** `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` install section +
`docs/nemoclaw-tech-agent.md` (the agent stack gained a component).

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` pass
- [ ] `src/control/nudgeQueue.test.ts`: host isolation; inactive recipient filtered at serve time;
  serve cap → failed; ack → asked; failure ×3 → failed
- [ ] `src/mcp/httpServer.test.ts`: bad/missing host token → 401 both routes; GET shape; POST ack
- [ ] `bash -n Box_Setup_Stuff/nudge-runner.sh`

### Live verification (agent-executable)
- Prerequisites: local stack; curl.
- [ ] run the HTTP server locally, GET/POST with the test host token — shapes + row transitions
  read back via psql.

### Manual verification
- none
---
*No manual items — continue.*

## Phase 5: Rollout, live E2E, disclosure docs

### What this phase does
Migrate-then-deploy, install the runner, prove one full loop into a developer-owned chat, resolve
the D6 open question, ship the ratified disclosure.

### Changes required
- **Rollout order (design artifact):** (1) pilot migration via Supabase MCP + `NOTIFY pgrst,
  'reload schema'`; (2) Render Manual-Deploy the LATEST commit, verify the live hash; (3) install
  runner + units on trades-box-1, `daemon-reload`, enable timer, verify a no-op pull. Escape
  hatch: `systemctl disable --now nudge-runner.timer` stops all delivery instantly; the lifecycle
  steps alone only write DB rows.
- **Docs:** `docs/customer-onboarding-runbook.md` + `docs/getting-started-for-firms.md` — extend
  the recorded disclosures with the ratified 2026-08-15 one: the firm's assistant may proactively
  ask about work, and what you tell it can be recorded to the firm's record.
  `docs/engineering-memory.md` — live-state entry (new table, identity namespace, box component,
  D4/D5 decisions). ⚠ both firm-facing docs are also in money-inference Phase 3's footprint —
  whichever lands second rebases the wording.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` / `npm run build` pass (pre-PR gate)

### Live verification (agent-executable)
- Prerequisites: ssh trades-box-1; Supabase MCP (pilot); a synthetic overdue visit under the demo
  tenant with a DEV seat as technician — target an operator-owned chat (e.g. s2/manager-sam),
  NEVER a real technician's.
- [ ] full loop: nudge row pending→queued→asked; gateway log shows `[ws] ⇄ res ✓ agent` (gateway,
  not embedded); message in the operator's Telegram; weekday-guard log checked
- [ ] operator replies ("went fine, replaced the capacitor") → agent records via
  `record_field_note` → capture read back; next tick marks the nudge `answered`
- [ ] **resolve D6:** which session the reply landed in, was the question in context — record in
  engineering-memory; if context was absent and the flow failed, revisit session targeting before
  enabling any real recipient
- [ ] budget regression: second same-person overdue visit → row only if under budget; third →
  skipped

### Manual verification
- [ ] The delivered message reads as a colleague's question on a real phone (constraint 5 tone)
- [ ] Disclosure wording honest and plain (user review)
---
*Pause: manual items + the D6 resolution are user-facing.*

## File footprint

Create: `supabase/migrations/20260816090000_nudges.sql`, `src/db/nudges.ts`,
`src/db/nudges.test.ts`, `src/teamLead/watcher.ts`, `src/teamLead/watcher.test.ts`,
`src/teamLead/compose.ts`, `src/teamLead/compose.test.ts`, `src/control/nudgeQueue.ts`,
`src/control/nudgeQueue.test.ts`, `Box_Setup_Stuff/nudge-runner.sh`,
`Box_Setup_Stuff/nudge-runner.service`, `Box_Setup_Stuff/nudge-runner.timer`.

Modify: `src/db/index.ts`, `src/db/database.types.ts` (regen), `src/db/reviewItems.ts`,
`src/db/assignments.ts`, `src/jobs/lifecycle.ts`, `src/jobs/lifecycle.test.ts`,
`src/mcp/server.ts`, `src/mcp/server.test.ts`, `src/mcp/httpServer.ts`,
`src/mcp/httpServer.test.ts`, `scripts/spine-eval/world.mjs`, `scripts/seed.mjs`,
`docs/engineering-memory.md`, `docs/customer-onboarding-runbook.md`,
`docs/getting-started-for-firms.md`, `docs/nemoclaw-tech-agent.md`,
`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`.

**Cross-feature overlap:** `src/jobs/lifecycle.ts(+test)`, `src/db/reviewItems.ts`,
`src/db/assignments.ts`, `scripts/seed.mjs`, and both firm-facing docs are ALSO in
`2026-08-15-money-inference-v1.md` Phase 3; `src/mcp/server.ts`/`src/db/index.ts` carry the
uncommitted money-ledger/firm-profile work. **Recommendation: stack, don't parallelize** — land
ledger + firm-profile first (implemented, uncommitted), then this plan rebased. The one-budget
question (these asks vs `job_done_check`) is deferred: both use the same batched-notify shape;
merging budgets is a small follow-up once both exist.

## Assumptions

Recorded because this was a non-interactive run (plan.md's decision-brief and adversarial-review
steps need interaction/subagents this run lacks):
- Product-facing choices (D4 no-L1 outreach, D5 escalation surface, budget defaults, read-only v1
  allowlist) are chosen with reasoning, not user-confirmed — the draft status + plan-review gate
  are the confirmation point; each is flagged in Decisions.
- The adversarial subagent review was not run (no Task tool here); instead, every file this plan
  modifies was read this session and anchors verified against the working tree (~5425500). A
  reviewer should still spot-check the `dispatch` gate placement and `/control` auth-helper reuse.
- Transport per the task brief overrides the direction doc's stale `/hooks/agent` Stage-1 line
  (the research doc records the contradiction).
- `runForcedTool` is assumed usable by a second consumer (it is the extractor's seam); if it
  proves extract-specific, compose adds a sibling helper in `src/model/` instead of widening it.
- Migration timestamp `20260816090000` assumes no earlier-numbered migration lands first;
  renumber on rebase.

## Parallel/stack verdict (plan-two)

**Recommendation: STACK — land Feature A (Stage 0 watchers) first, then re-check/rebase THIS plan
on the result.** This matches this plan's own footprint-section instinct ("stack, don't
parallelize") and extends it to Feature A specifically. Do not open two worktrees for these.

**Shared files (exact-path intersection):** `src/db/assignments.ts`, `src/db/reviewItems.ts`,
`src/jobs/lifecycle.ts`, `src/jobs/lifecycle.test.ts`, `docs/engineering-memory.md`.

**Reasoning.** Beyond the shared paths, the two plans collide semantically:

1. **Same function name, incompatible contracts.** Both plans introduce
   `listOverdueConfirmedAssignments` in `src/db/assignments.ts` (verified absent from the current
   tree). Plan A: `(tenantId, endedFromNaive, endedToNaive)` bounded window, plain
   `PlacedAssignment[]`. This plan: `(tenantId, cutoffs)` single cutoff with `technician_id not
   null` and `jobs!inner`/`technicians` embeds. Parallel implementation guarantees a merge-time
   contract fight; one merged shape would silently break the other feature's callers.
2. **Both claim lifecycle step 8.** A: `runWatchers` behind `WATCHERS_MODE`. B: `teamLeadSweep`
   (step 8) + `teamLeadCompose` (step 9). Summary shape, step numbering, gating idiom, and the
   test file's env-clear list all conflict.
3. **Same archetype detected twice, two dedup stores.** Both features detect the identical gap
   (confirmed visit ended 3+ hours ago, nothing came back). A writes `review_items`
   (`overdue_visit_gap`, once per assignment); B writes `nudges` rows. Merged as written, one gap
   simultaneously flags the manager AND nudges the technician, with two divergent auto-resolve
   sweeps (A checks captures + visits — the two-homes rule; B's checks captures only, which A's
   research says under-counts). D8's premise here ("Stage 0 never ran; one archetype") is false
   once A lands — this plan's watcher (Phase 2) should become a consumer of A's detector
   framework, not a parallel copy of it.
4. **Two batched `notifyManagers` pushes per tenant per tick** in combination — each plan keeps
   the one-line principle alone but not together.
5. **Background WIP hazard.** `scripts/seed.mjs`, `scripts/spine-eval/world.mjs`,
   `src/mcp/server.ts`, `src/db/index.ts` already carry uncommitted money-ledger/firm-profile
   work, and the repo has a recorded `commit -a`-swept-WIP incident. This plan additionally
   depends on landing that uncommitted work first (its own cross-feature note), reinforcing a
   sequential order: ledger/firm-profile → Feature A → this plan rebased.

**Rebase checklist for this plan after A lands:**
- Reuse/widen A's `listOverdueConfirmedAssignments` instead of redefining it (one time-convention,
  one function; add the embeds A's callers ignore).
- Renumber lifecycle steps (9/10) or, better, register the team-lead sweep as the second detector
  inside A's watcher framework; reconcile `WATCHERS_MODE` vs key-gating and the summary shape.
- Decide ONE surfacing policy per gap: nudge-the-tech first with manager escalation (this plan's
  ladder), with A's `overdue_visit_gap` manager item becoming the escalation rung or the fallback
  for un-nudgeable technicians — never both surfaces firing independently on the same assignment.
- Unify auto-resolve "activity after end" logic on A's two-homes version (captures AND visits).
- Merge the per-tenant `notifyManagers` line so a tick sends at most one batched push.
- Re-anchor `src/mcp/server.ts` dispatch-gate line numbers and renumber the migration if any
  earlier-numbered migration landed (this plan's own assumption note).
