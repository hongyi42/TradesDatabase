---
date: 2026-09-22
branch: work/merge-the-desk-into-the-office-one-agent
commit: 532720f
topic: Merging the desk into the office — what the Q&A desk, the access desk and the pinged office are today, where the tier gate and the 40s clock live, and where the five access judgments sit in code
supersedes: nothing (it overturns no document's decision; it re-maps the code for the merge the operator ruled on 2026-09-22. The framing of 2026-09-20-the-desk-as-the-offices-fast-path.md was already marked superseded by its own banner; its facts are re-pinned here, not contradicted)
---

## Summary

Today one "team lead" agent (it runs server-side under the identity `spine:team-lead`) is reached
through **three separate code paths**, and they share almost nothing but that identity and the
planner's notes:

1. **The desk** (`answerDeskQuestion`) — a small, read-only model call that answers a seat's
   question *inside* the seat's own tool call. It has its own prompt (`DESK_SYSTEM`), its own
   4-turn / 40-second limits, and a **tier gate**: an active manager's desk gets 4 read tools, anyone
   else's gets none.
2. **The access desk** (`answerAccessRequest`) — reached through the same `ask_team_lead` tool when
   the seat passes an `accessRequest`. Since 2026-09-20 it makes **no model call at all**: code
   resolves the target, checks the view, dedups, files a row and texts **every** active manager with a
   fixed template.
3. **The office / planner** (`runPlanner`) — the full agent: `PLANNER_SYSTEM`, 7 team-lead tools plus
   the terminal `submit_plan`, write verbs, the guarded send path. Run by the 30-minute cron (the
   "planner") and by a **focused pass** when an inbound call is pinged (the "office", rung 10). It
   **never sees access requests** — they are filtered out at its one read.

The merge the operator ordered folds (1) and (2) onto (3). The single most important finding is
**a shape mismatch, not a cost or timeout one**: the office's loop is built to *produce a plan about
gaps* (it ends on `submit_plan`, and its effects happen after the loop in `applyDecision`), while the
desk's loop is built to *return a sentence to someone waiting* (it ends on the first text-only turn,
and that text is the answer). The second finding: the "Ben asks, Sam declines by accident, Ben asks
again" case is confirmed in code — a decline dismisses the request row, the re-ask's dedup lookup
only matches unsettled rows, so a fresh request is filed and every manager is texted again; the only
trace of Sam's "no" the office ever gets is an `inform` in its inbox, read on its next tick.

## Entry Points

| Where | What begins there |
|---|---|
| `src/mcp/server.ts:109` | `ask_team_lead` tool definition, in the seat `TOOLS` array (both tiers see it) |
| `src/mcp/server.ts:747` | `case 'ask_team_lead'` — question sanitised, capped at `DESK_QUESTION_MAX` (500) |
| `src/mcp/server.ts:771-805` | the access branch — validates `accessRequest`, calls `answerAccessRequest` |
| `src/mcp/server.ts:807-833` | the question branch — calls `answerDeskQuestion` with `managerDesk: activeManager` |
| `src/teamLead/desk.ts:141` | `answerDeskQuestion` |
| `src/teamLead/accessDesk.ts:141` | `answerAccessRequest` |
| `src/jobs/plannerPass.ts:24` | `runPlannerPass` — the one wiring of tools + executor for the office/planner |
| `src/jobs/plannerPass.ts:97` | `runFocusedObservationPass` — the pinged office (one observation, 180s default) |
| `src/teamLead/planner.ts:4176` | `runPlanner` |
| `src/mcp/tools/access.ts:429,692` | `grant_access` / `decline_access` — the manager's side of an access ask |

## Key Files

- **`src/teamLead/desk.ts`** (253 lines) — `answerDeskQuestion`, `DESK_READ_TOOLS` (`:57`, allowlist:
  `spine_read`, `recall_decisions`, `read_memory`, `read_job_note`), `DESK_FALLBACK_NOTE` (`:66`),
  `renderAskerState` (`:115`). Tier gate at `:177-186`. Writes an `ask` row first (`:155`), a `desk`
  row born read after (`:228`), marks the ask read (`:242`). On any failure the ask stays unread and
  the seat gets the fallback note (`:247-252`).
- **`src/teamLead/deskPrompt.ts`** (88 lines) — `DESK_SYSTEM` (`:12`, "You READ, you never act"),
  `DESK_MAX_TOKENS = 2048` (`:38`), `DESK_REASONING = 'low'` (`:41`), `DESK_BUDGET_MS = 40_000`
  (`:50`, derivation `:42-49`), `DESK_MAX_TURNS = 4` (`:56`), `DESK_QUESTION_MAX = 500` (`:58`),
  `DESK_NARROW_DISCLOSURE` (`:74`, the non-manager guard incl. "NEVER A MONEY AMOUNT").
- **`src/teamLead/accessDesk.ts`** (509 lines) — `answerAccessRequest` (`:141`), `askTheManagers`
  (`:354`), `recordPair` (`:458`), `whatWords`/`jobWords` (`:127-137`), `firmTz` (`:503`).
- **`src/teamLead/identity.ts`** — `TEAM_LEAD_REF = 'spine:team-lead'`; `TEAM_LEAD_TOOL_NAMES`
  (the dispatch ceiling for the whole `spine:` namespace): the 7 schema'd tools plus
  `get_customer_context` and `resolve_date`, which are on the allowlist with no schema handed to the
  loop.
- **`src/mcp/server.ts`** (1041 lines) — `TEAM_LEAD_TOOLS` (`:390`), `TEAM_LEAD_TOOL_SCHEMAS`
  (`:436`), `SEAT_SHARED_TEAM_LEAD_TOOLS` (`:460`), the `activeManager` predicate (`:618`), the
  `spine:` ceiling (`:656`), `ServerDeps.deskAnswer` / `accessDesk` seams (`:85-88`).
- **`src/jobs/plannerPass.ts`** (138 lines) — `runPlannerPass`, `focusedPassBlockedBy` (`:69`),
  `runFocusedObservationPass` (`:97`); the focused pass stubs `listOfficeMessages` and
  `listDeskTranscripts` to empty (`:126-127`).
- **`src/teamLead/planner.ts`** (5767 lines) — `runPlanner` (`:4176`), `PlannerDeps` (`:707`, incl.
  `focus` `:738`), `buildOfficeMessagesBlock` (`:3391`, renders unread informs and the "desk answered
  for you" appendix, `DESK_PAIRS_SHOWN = 5` `:3373`), desk-transcript read (`:4958-4990`), the
  `access_request` filter (`:4387-4398`), the loop call (`:5099-5121`: `PLANNER_SYSTEM`,
  `PLANNER_MAX_TOKENS = 8192`, `PLANNER_REASONING = 'medium'`, `terminalTool: submit_plan`,
  `maxTurns: null`, `budgetMs` only when focused).
- **`src/teamLead/plannerPrompt.ts`** (663 lines) — `PLANNER_SYSTEM` (`:20`, opens "decide, for each
  open gap in the record, what should happen next"), `SUBMIT_PLAN_TOOL` (`:501`).
- **`src/db/accessRequests.ts`** (246 lines) — an access request IS an observation, kind
  `access_request`. `requestKeyOf` (`:87`), `openAccessRequest` (`:113`), `findOpenAccessRequest`
  (`:130`, unsettled statuses only), `lapseAccessRequest` (`:151`), `closeAccessRequest` (`:210`),
  `REQUEST_LAPSE_MS = 24h` (`:52`), `hasLapsed` (`:56`).
- **`src/mcp/tools/access.ts`** (1063 lines) — manager tools `grant_access`, `list_access`,
  `revoke_access`, `decline_access`, `set_technician_view`. Every answer fans out three ways:
  `tellThePlanner` (`:348`, an `inform` to the office), `textTheTechnician` (`:367`, a person push),
  `tellHerSeat` (`:394`, a `to_agent` inform into her seat).
- **`src/db/technicians.ts`** — `listManagersWithTelegram` (`:135`): active manager-tier rows with a
  Telegram binding. No manager→technician relation exists anywhere in `supabase/migrations`
  (no `manager_id`, `reports_to`, `managed_by`, `team_id`).
- **`Box_Setup_Stuff/apply-bakein.py:150-164`** — writes the `trades-spine` MCP server block into the
  OpenClaw config with `transport`, `url`, `headers` and no timeout key.
- **`scripts/planner-eval/notes-run.mjs`** (500 lines) — drives the real `runToolLoop` with
  `PLANNER_SYSTEM` + `TEAM_LEAD_TOOL_SCHEMAS`, stubbed executor, no DB, `budgetMs: 180_000` (`:397`).
  Listed on the task; the operator ruled the latency measurement out, so it has no role in this task
  unless a plan gives it one.

## Data Flows

### 1. A seat asks a question and waits (the desk)

```
seat (Telegram turn) ── MCP tools/call ask_team_lead ──► server.ts:747
   │  identity from verified header; ONE roster read → caller, activeManager (:618)
   ▼
answerDeskQuestion(desk.ts:141)
   ├─ createOfficeMessage(kind 'ask', to_planner, unread)          ← durable first
   ├─ renderMemoryIndex(tenant)                                    ← notes ride EVERY desk
   ├─ managerDesk ? tools = TEAM_LEAD_TOOL_SCHEMAS ∩ DESK_READ_TOOLS
   │              : tools = [] + renderAskerState(own open nudges) ← the tier gate
   ├─ runToolLoop(DESK_SYSTEM, 2048 tok, 'low', 40s, 4 turns, no terminal tool)
   │     dispatch → dispatchForIdentity(name, args, {tenant, spine:team-lead})
   ├─ createOfficeMessage(kind 'desk', born read, in_reply_to ask)
   └─ markOfficeMessagesRead([ask])
   ▼
{status:'answered', answer} | {status:'kept_for_the_office', note}
   ▼  … next planner tick
buildOfficeMessagesBlock → "the desk answered for you since your last run — said in YOUR name"
```

The tier gate is three things together: the `managerDesk` boolean decided by the caller from the
repo's one active-manager predicate (`server.ts:618`, `:817`); the tool filter (`desk.ts:179-186`);
and `DESK_NARROW_DISCLOSURE` restated in the user message for non-managers (`desk.ts:194`). The
dispatch executor runs every tool as `spine:team-lead` (`desk.ts:214`) — **the tools are not
permission-scoped to the asker**; only the filter keeps a technician's desk from reading the firm.
The notes are bounded by prompt only (`desk.ts:44-51`: "read-bounded, deliberately not
disclosure-proof").

### 2. A seat asks for access (the access desk)

```
seat ── ask_team_lead {question: why, accessRequest:{jobId|customerId, wants}} ──► server.ts:771
   ▼
answerAccessRequest(accessDesk.ts:141)                         NO MODEL CALL
 1 who: activeManager → refused; no roster row → refused      (:157-172)
 2 what: exactly one target, uuid-shaped, this tenant's        (:176-220)
   customer ask with exactly 1 unfinished job she can't open → narrowed to that job (:247-262)
 3 already open? record / money checks against her view        (:270-295)
 4 already asked? findOpenAccessRequest(requestKey)            (:305-320)
   a day-old row → lapseAccessRequest, then fall through       (:327-333)
 5 askTheManagers(:354)
     listManagersWithTelegram → filter has sandbox_ref        ← EVERY active manager
     openAccessRequest (observation kind access_request)
     queuePersonPush(kind 'access', templated body) per manager
     recordPair: 'ask' + 'desk' rows, ask marked read         ← planner sees it only as a desk pair
   ▼
{status: asked_manager | already_open | already_asked | refused, answer: templated words}
```

Then, on the manager's side (`access.ts`): `grant_access` / `decline_access` close the row
(`closeAccessRequest` → `dismissed`, reason `"declined by <name>: <reason>"`), send an `inform` to the
office, a push to the technician, and (for a non-manager) a `to_agent` inform into her seat.

**The re-ask trace (Ben / Sam):** Sam's decline dismisses the row (`access.ts:718`). Ben's second ask
computes the same `requestKey`; `findOpenAccessRequest` filters `status in ('open','asked')`
(`accessRequests.ts:139`), so it finds nothing; `askTheManagers` files a new row and texts every
manager again with the same template. Nothing on that path reads the dismissed row or its reason.
Sam's decline exists for the office only as the `inform` "Said no to opening … Why: …"
(`access.ts:727`), shown once in a tick's office-messages block.

### 3. The office / planner

```
cron (lifecycle heartbeat)      ─┐
Calls-worker ping (focused pass) ─┴► runPlannerPass(plannerPass.ts:24)
        tools = TEAM_LEAD_TOOL_SCHEMAS, execute = dispatchForIdentity(spine:team-lead)
   ▼
runPlanner(planner.ts:4176) per tenant
   reads: nudges, observations (MINUS access_request :4398), unread office messages,
          desk transcripts, memory index, roster, evidence …
   buildPlannerUserMessage → runToolLoop(PLANNER_SYSTEM, 8192 tok, 'medium',
          terminalTool submit_plan, maxTurns null, budget 15 min | focus.budgetMs)
   validateDecisions inside the executor → applyDecision after the loop
          (send / hold / close / dismiss / recover / observe)
```

The focused pass scopes every reader to one observation and stubs the office inbox and desk
transcripts to empty (`plannerPass.ts:126-127`). No seat-triggered wake of the office exists today;
rung 10c (paused behind this task) is the one that would add it.

## External Dependencies

- **The model provider** via `runToolLoop` (`src/model/toolLoop.ts`) — OpenRouter, production model
  per memory `planner-model-is-glm-53`. Loop ceilings: `MAX_TOOL_LOOP_TURNS = 8` (`:46`, ignored when
  `maxTurns: null`), `MAX_TOOL_LOOP_BUDGET_MS = 900_000` (`:70`), `MIN_TURN_BUDGET_MS = 15_000`
  (`:100`, no turn after the first may start with less left), `MAX_TOOL_CALL_MS = 90_000` (`:105`).
- **The seat runtime's MCP client timeout** — the ceiling a waiting seat actually enforces. Under
  OpenClaw it is `DEFAULT_REQUEST_TIMEOUT_MS = 60_000`, probed 2026-08-31 (`deskPrompt.ts:42-47`;
  `docs/engineering-memory.md:5734`), applying because the config block at `apply-bakein.py:157-164`
  sets no timeout key. The replacement runtime (the Copilot SDK engine, active task
  `20260922-step-1-technician-seat-on-the-copilot-sd`) has **no recorded MCP tool-call timeout** in
  this repo's docs or task records (searched `thoughts/`, `docs/engineering-memory.md`).
- **Telegram delivery** via `queuePersonPush` (`src/db/personPushes.ts`) — the access desk's manager
  texts do not go through the planner's send path or its rails.

## Constraints and Invariants

- **C1 — Every tool in the desk runs as `spine:team-lead`.** The tier gate is entirely the
  pre-loop tool filter + the pre-read; the dispatch gate (`server.ts:656`) caps the namespace to
  `TEAM_LEAD_TOOL_NAMES`, which includes the write verbs. `desk.ts:27-31` states the filter is the
  mechanism, not a redundancy.
- **C2 — The desk and the office end differently.** Desk: no terminal tool; first text-only turn
  = the answer (`desk.ts:208-209`). Office: `terminalTool: submit_plan`; text is not an output; the
  effects are decisions applied after the loop.
- **C3 — The office's input is a gap list.** `PLANNER_SYSTEM` opens on deciding "for each open gap"
  and `buildPlannerUserMessage` is built around gaps; a desk question is not a gap, observation or
  nudge.
- **C4 — `access_request` is filtered out of the planner's read** (`planner.ts:4398`) and not
  recoverable (`:4078`). The filter's comment (`:4387-4389`) still says the office is "a middleman
  for ONE inference — open this narrow ask, or put it to a manager"; the "open" half was removed
  2026-09-20.
- **C5 — Stale comments in the access path** (findings, not acted on): `accessDesk.ts:26-51` still
  describes the NARROW outcome decided "with one bounded model call" and opened for a day;
  `AccessDeskDeps.memoryIndex` (`accessDesk.ts:86`) is declared and never used;
  `accessRequests.ts:13-16` says the planner "reads its open set every tick … can chase the manager"
  while `:29-35` of the same file, and `planner.ts:4398`, say it does not; `AccessWants`'s doc
  (`accessRequests.ts:40`) says "'record' is the only width the desk will open by itself".
- **C6 — The access path's rule set the doctrine keeps in code** (the task record's three):
  tenant checks on every row (`accessDesk.ts:199-219`, and every accessor in `accessRequests.ts`),
  refusing a roster-less badge (`:165-172`), one-target validation (`:176-187`, plus the uuid shape
  `:63`). The active-manager refusal (`:157-164`) is a fourth code-side refusal the task record does
  not list.
- **C7 — The five judgments the doctrine moves to the office**, located: narrowing a customer ask
  to one job (`accessDesk.ts:221-262`); "already asked?" (`:297-320`); lapse-and-refile
  (`:321-333`); who to ask — every reachable manager (`:366-368`); the words — `whatWords`/`jobWords`
  (`:127-137`), the menu and manager body (`:405-411`), the technician answers (`:432-437`, and every
  `answer:` string in `:157-319`).
- **C8 — No model output reaches a grant field today, and no office path writes a grant.** Grants
  are written only by `grant_access` / `set_technician_view` under a manager badge. The doctrine
  "only a manager widens a view" is currently held by the office having no such tool — `grant_access`
  is an admin tool, not in `TEAM_LEAD_TOOL_NAMES`.
- **C9 — The dedup unique index** (`uq_open_access_request`, migration `20260919170000`) keys on
  `requestKey` over unsettled statuses; `openAccessRequest` returns null on collision. It is the
  structural guard against double-filing regardless of who decides to file.
- **C10 — Transcript contract.** Both desks write an `ask` + a `desk` row (born read) so the next
  tick's appendix shows "what was said in your name"; `DESK_PAIRS_SHOWN = 5` newest; answer capped at
  `OFFICE_MESSAGE_BODY_MAX`.
- **C11 — `ServerDeps.deskAnswer` / `accessDesk` are test seams** used by dispatch tests;
  `desk.test.ts` (349 lines) and `accessDesk.test.ts` (445 lines) pin today's behaviour.
- **C12 — Measured cost (task record, 2026-09-22):** office fixed prompt ≈ 14,777 tokens/turn
  (`PLANNER_SYSTEM` 8,880 + 8 tool schemas 5,897) vs manager desk ≈ 3,525 and technician desk ≈ 621.

## Decision Points

**D1 — How the office answers someone who is waiting.** The office's loop ends on `submit_plan`;
the desk's ends on text.
- *(a)* Run the office loop with no terminal tool when a seat waits (the desk's shape), same
  `PLANNER_SYSTEM`: the prompt's gap framing (C3) then describes a job the call isn't doing.
- *(b)* Keep `submit_plan` and add an answer field/verb to it: the answer passes through
  `validateDecisions`/`applyDecision`, whose rails are gap-shaped today.
- *(c)* One shared doctrine core with a door-specific section per trigger (question / access /
  inform / tick): `PLANNER_SYSTEM` is one 8,880-token array today, so this means splitting it.

**D2 — The waiting door's clock.** Today's 40s/4 turns is derived from OpenClaw's 60s. The new
runtime's MCP tool-call timeout is unrecorded. Options: set the new runtime's timeout deliberately
and derive the office's waiting budget from it; or choose the budget first (human patience) and
configure the runtime to match. Either way the office loop's `MIN_TURN_BUDGET_MS = 15s` floor limits
how many turns fit.

**D3 — Where the tier gate lives once there is one agent.** Today: a tool filter over
`spine:team-lead`-identity tools (C1). Options: keep that filter, keyed on the caller, in the merged
entry point (the smallest move); or make the tools themselves execute under the asker's
permissions (dispatch as the caller, so the technician's limited view applies at the row level) —
a larger change that touches how `dispatchForIdentity` is called.

**D4 — What a technician-waiting office may do beyond reading.** The rulings let the office write L2
and memory; the desk today writes nothing but its transcript. For the waiting doors: read-only (as
today), or the full office verbs with the caller's tier gating only what is *disclosed*.

**D5 — Who to ask for access** (C7, "who to ask"). No manager→technician relation exists in the
schema. Options: the office decides from its notes (memory `.md` files; nothing records "manages"
today, so a firm's notes would need it); add a relation to the schema (a migration + settings
surface, overlapping the parked settings-page task); or keep "every reachable manager" as the code
fallback when the office names nobody.

**D6 — How the office sends to the manager.** Today `queuePersonPush` directly, outside the
planner's send rails. Options: the office drafts the words and code still queues the push through
`queuePersonPush`; or the office sends through its own `send` verb (the guarded path with the
`asked_at` double-text stamp) — which today requires a gap/observation, and `access_request`
observations are filtered out of the planner's read (C4).

**D7 — What the office sees when judging a re-ask.** Today nothing on the ask path reads a
dismissed request. Options: hand the office the recent settled requests for this person+target
(dismiss_reason carries "declined by Sam: …"); or rely on its notes and the `inform` it got at the
tick — which the focused pass stubs out (`plannerPass.ts:126`) and which a waiting door would not
have read yet if the tick hasn't run.

**D8 — The fate of `desk.ts` / `deskPrompt.ts` / `accessDesk.ts`.** Delete and fold into
`planner.ts`'s runner, or keep them as thin entry points that build a door-specific user message and
call one shared runner. `planner.ts` is already 5,767 lines; `runPlanner` is per-tenant
tick-shaped (lists tenants, reads the whole firm).

**D9 — The `accessRequest` wire contract.** Seats call `ask_team_lead` with `accessRequest`, and
seat prompts reference it (`shared.ts:79`, `customers.ts:506`, `captures.ts:745`). Keeping the tool
name and argument shape lets seats stay unchanged; changing it touches every seat prompt and the
new-runtime seat task's tool surface.

## Open Questions

- What MCP tool-call timeout does the Copilot SDK engine apply, and is it configurable per server?
  (Needs its docs — CLAUDE.md requires a cited vendor page.)
- Does the operator want `dismiss_reason` of a *declined* request to block, or only inform, a re-ask
  of the same thing — i.e. is "go back to Sam" the office's to judge, or should Sam be asked with
  "you said no an hour ago — still no?"
- Should the merged office write the transcript pair (`ask` + `desk`) for every waiting door as
  both desks do now, given the office can now write memory itself?
- Is `get_customer_context` / `resolve_date` being on `TEAM_LEAD_TOOL_NAMES` without a schema
  (dispatchable, never offered) intended to stay, or does the merged surface offer them?
- Which of the doctrine's "words" should stay templated for safety (e.g. the width-aware reply menu,
  `accessDesk.ts:398-410`, which exists because a plain "yes" on a money ask opens the figures and the
  ledger has no delete path)?
