---
date: 2026-09-20
task: The onboarding questionnaire — a `set_timezone` tool, skills turned on for the seats, and a once-per-firm questionnaire skill that stages answers, reviews them per cluster, and commits them to memory and columns
research: thoughts/shared/research/2026-09-20-the-onboarding-questionnaire.md
also: thoughts/shared/research/2026-09-20-the-onboarding-flow.md
status: not started
depends: none. Phase 2 carries a PREREQUISITE that must be settled on the box before it can be
  written — see its opening note. Phases 1, 3 and 4 are unaffected by how that lands.
---

## Overview

A manager finishes provisioning, opens their bot for the first time, and the assistant runs a
questionnaire once. **The objective is not to fill a form — it is to initiate the planner's and the
seat's memory files** (operator framing, 2026-09-20). Columns are the by-product.

Almost everything the questionnaire writes to already exists: `tenants`, `tenant_settings`,
`tenant_profiles` + `set_firm_profile`, `job_type_durations` + `set_job_duration`, `technicians` +
`add_technician_seat`, and `planner_memory` + `write_memory`. **This build adds exactly one tool and
no migration.** The work is in the skill and in turning skills on at all.

## Decisions

- **Its answers seed MEMORY FILES, not columns** (user, 2026-09-20). Trade kinds and each person's
  language live in the planner's `planner_memory` and the seats' own `MEMORY.md` — **not** in a
  table. Verified: there is no `language`/`locale` column anywhere in the schema, and there should
  not be one. A firm can do several trades, so never a trade-type enum.
- **Two questions leave the questionnaire entirely** (user): *"what system do you use today"* is an
  OPERATOR question gathered before sales close, and **team size is asked before the manager is
  provisioned** — `enforce_seat_cap()` is a database trigger, so asking later means it rejects
  roster inserts mid-conversation.
- **It ships as an OpenClaw plugin-skill on the seat** (user), not as `AGENTS.md` prose. A
  questionnaire is a long procedure run once, which is what progressive disclosure is for; in
  `AGENTS.md` it would tax every turn on that seat forever. **Not** a `.claude/skills/` file —
  different system, different audience (see the research's note on the collision).
- **Nothing reaches a destination while a cluster is incomplete** (user). Answers accumulate in a
  staging record and commit per cluster. The questionnaire is the highest-typo-risk moment in the
  system and it writes to the least reversible surfaces: **there is no timezone writer at all, no
  rename tool, and no set-tier tool**, and `deactivate_technician_seat` destroys the sandbox and its
  chat memory while burning the ref forever.
- **Review happens per CLUSTER, not per answer and not once at the end** (user). Per answer is a
  confirmation treadmill and contradicts the one-shot rule for reversible writes; once at the end
  puts a dozen items in front of someone who said the first twenty minutes ago and earns a reflexive
  yes. **Review frequency and commit frequency are the same event.**
- **`set_timezone` is required and cannot be worked around.** Staging does not create a writer that
  does not exist, and timezone is the single highest-value field on the list — unset means
  `America/Los_Angeles`, which is silently wrong for every firm that is not in it.
- **Rename and set-tier are NOT in this build.** First-run typos are caught at cluster review. They
  are still wanted (technicians get promoted, names get corrected months later) but they no longer
  gate shipping. Recorded so the omission reads as deliberate.
- **The planner may write memory; it may NOT write the typed fields.** `write_memory` has no
  mode gate *by design* (`planner.ts:5665-5676`: gating memory would make shadow mode useless for
  the one question it exists to answer). Person-visible state is different — `TEAM_LEAD_TOOL_SCHEMAS`
  reaches shadow ticks and the Calls-worker's focused pass ungated, so `set_firm_profile`,
  `set_timezone` and the roster tools stay the **manager seat's** `ADMIN_TOOLS`. Rung 10d does not
  change this: 10d is the L2 ruling, and these are ADMIN tools.
- **The checklist lives in `planner_memory`, one home** — not `task-progress/` in the seat
  workspace, which the batching doctrine would otherwise prescribe. The workspace is wiped by a
  sandbox rebuild and onboarding is exactly when a seat is newest. Cost is ~15 extra tool calls
  across the conversation; the gain is no copy step and no "did the non-answers migrate before the
  file was deleted" bug.
- **Technician-seat seeding is explicitly OUT of this build** (phase 5, deferred). Each seat is its
  own container and nothing writes another seat's files. The questionnaire is useful without it.

## Plain-language walkthrough

Today a new manager presses Start and gets an assistant that knows nothing about their firm — not
their timezone, not their hours, not who works there. Everything defaults: Pacific time, full-rate
planner ticks around the clock, two-hour jobs.

After this build, that first Start runs a short conversation instead. It asks where they are, what
hours the crew works, and who is on the team; reads it back; saves it. Then it keeps going through
trades, boundaries, job durations and letterhead for as long as the manager wants, confirming a few
lines at a time and saving each chunk as it goes. What it could not get is reported as a list with
consequences attached, and `/questionnaire` picks up where it stopped.

## Secrets & env preflight

- **Phase 1:** none. Local Supabase stack (`npx supabase start`, `.env.test`).
- **Phases 2-4:** box access to `trades-box-1`. No new secret, no new env var.

---

## Phase 1: `set_timezone`

### What this phase does
Adds the only missing writer. Independent of everything else — it is useful the day it lands, with
or without a questionnaire.

### Changes required

**`src/db/tenants.ts`** — `setTenantTimezone(tenantId, timezone): Promise<Tenant>`, following
`setTenantSeats` (`:127-149`) exactly: `.update(...).eq('id', tenantId).select().single()`, throw on
`error || !data`. No migration — `tenants.timezone` exists (`20260704210155_scheduling_foundation.sql:10`),
`not null default 'America/Los_Angeles'`.

**`src/mcp/tools/…`** — `set_timezone` as a one-shot ADMIN tool. **Validate with
`Intl.DateTimeFormat(undefined, { timeZone: value })` inside a try/catch** — it throws `RangeError`
on anything that is not a real IANA name. Refuse with the fix named, the way
`tenant_profiles.state` refuses `'Texas'`, rather than storing a string nothing can interpret.

The reply **echoes the local time, not the identifier**: `"America/Chicago — that's Central, and
it's 3:42pm for you right now."` Nobody can verify a zone name; everybody can verify a clock. This
is what catches the valid-but-wrong case (`America/Denver` for a Phoenix firm validates fine and is
an hour off for half the year).

**`src/mcp/tools/surface.expected.ts`** — add `'set_timezone'` to `MANAGER_ONLY_TOOLS` (28 → 29),
alphabetically between `set_technician_view` and `unschedule_visit`. The file's header names
`src/mcp/server.test.ts` as the other half of the closure; both move together.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build`
- [ ] `tenants.test.ts`: round-trip a valid zone; tenant isolation; error shape on a bad id.
- [ ] `server.test.ts`: technician refused (admin gate); manager set → echo; **`'America/Chicgo'`,
      `'Central'`, `'CST'` and `''` are each refused** and the message names what a valid value looks
      like.
- [ ] Closure counts updated — the surface assertions fail loudly if they are not.

### Live verification (agent-executable)
- Prerequisites: local Supabase stack.
- [ ] Tool write → psql read-back of `tenants.timezone`; evidence: the row value, and a
      `resolve_date` call afterwards returning the new zone.

### Manual verification
- [ ] None.

---
*No manual items — continue.*

## Phase 2: Turn skills on for the seats

> **PREREQUISITE, and it must be settled on the box before this phase can be written.** Skills are
> disabled fleet-wide: `bootstrap-box.sh:1561` sets `skills.limits.maxSkillsInPrompt = 0`,
> deliberately — openclaw ships 15 stock plugin-skills (meme-maker, notion, python-debugpy, tmux,
> weather) worth ~1,225 tokens per call, none trades-related, and `## Skills` measured as the
> **largest section of the system prompt**. Zeroing it was recorded as "a free cut".
>
> The vendor documents allowlists — `skills.allowBundled`, `skills.entries.<key>.enabled`,
> `agents.defaults.skills` / `agents.entries.*.skills`
> ([skills-config](https://docs.openclaw.ai/tools/skills-config)) — **but which spelling openclaw
> 2026.6.34 accepts is unverified.** The doc says `agents.entries.*.skills`, a secondary source says
> `agents.list[].skills`, and `bootstrap-box.sh` currently writes `.agents.list`. That schema is
> **strict** for at least `compat`, so a wrong key is a hard failure inside the wire phase under
> `set -euo pipefail` — the same shape as the `.primary` string/object trap already recorded there.
>
> **Settle it on s2 first** (the canary, and the seat that must stay most current): read the
> installed schema, or apply a candidate key and check what `<available_skills>` renders. If no
> allowlist key works on this version, STOP — the questionnaire is not a skill on this build, and
> phases 3-4 need rewriting against `AGENTS.md` or a version upgrade.

### What this phase does
Makes exactly one skill visible to a seat, and no others.

### Changes required

**`Box_Setup_Stuff/bootstrap-box.sh`, the jq wire block (~`:1561`)** — replace the bare cap with the
allowlist form confirmed above, then raise `maxSkillsInPrompt` off 0 to a ceiling that clears the
allowed set. **The cap is a count applied as `skills.slice(0, max(0, n))` and the truncation ORDER
is undocumented** — so it must never be the thing selecting which skill loads. Allowlist selects;
the cap only bounds.

Keep the existing comment block and extend it: it carries the measurement and the reasoning, and
deleting it deletes the record of why this was ever 0.

### Automated verification
- [ ] `bash -n Box_Setup_Stuff/bootstrap-box.sh`, and the jq program parses against a copy of a real
      `openclaw.json` **before** it is run against a live seat.

### Live verification (agent-executable)
- Prerequisites: box access, s2.
- [ ] `<available_skills>` renders **exactly** the trades skill and nothing else. Evidence: the
      rendered block.
- [ ] Re-running the wire phase is idempotent — a second run changes nothing.
- [ ] **Measured at the TURN level, not the call**: seconds and total tokens for one identical
      question, before and after, on s2. This is the repo's standing rule (*"Do not re-enable
      without measuring whole turns… never a single call"*), written after tool search was enabled
      and reverted the same day on a first-call number that inverted at turn level. Expect roughly
      +80 tokens of description; anything near the ~1,225 of the full stock set means the allowlist
      is not doing what it should.

### Manual verification
- [ ] Confirm the measured turn cost is acceptable before wiring the rest of the fleet.

---
*Manual item present — STOP and wait for the user.*

## Phase 3: The skill package and its trigger

### What this phase does
Ships the skill and makes it fire at the only moment it can.

### Changes required

**`Box_Setup_Stuff/plugins/trades-questionnaire/`** — manifest + skill body, copying the shape of
`trades-weekday-guard/` (`openclaw.plugin.json` with `id`, `name`, `version`, `description`,
`activation`). The **description** is what rides in every prompt, so it is one line; the body loads
on invocation.

**`bootstrap-box.sh` — a new `AGENTS.md` block carrying the TRIGGER CONDITION ONLY**, not the
procedure. A few lines: *if this firm has no profile yet, run the questionnaire.* The procedure
lives in the skill, which is the entire reason for making it one.

- **The block must NOT name a tool.** Standing rule from 2026-09-19: *"a rule must not name a tool
  it does not own"* — a manager was told *"I cannot connect Ben's email because `get_connect_link`
  is not in my tool list"*, which is the failure mode of doctrine outliving a tool. Name the
  destination, say one sentence, stop.
- **Refreshed per run (delete-then-append), not append-once** — append-once pins the first wording
  forever and the file's own comments record that trap.

**The trigger point is forced and cannot be moved earlier.** `roster.ts:141` states it: *"the person
must open that bot in Telegram and send /start themselves (bots cannot message first)."* Nothing can
precede the manager's first message.

**What signals "not yet onboarded":** `set_firm_profile {}` is already a no-write read that echoes
the profile plus `profileGaps()`. Use it, or an explicit marker if "the manager filled the profile by
hand" must not read as onboarded — decide at implementation and record which.

### Automated verification
- [ ] `bash -n`; plugin manifest validates.

### Live verification (agent-executable)
- Prerequisites: s2.
- [ ] Gateway startup line names the plugin. **A restart is not proof** — the standing rule is that
      a plugin is not installed until the gateway says so.
- [ ] A fresh seat with no firm profile invokes the skill unprompted on first contact; a seat with a
      profile does not.
- [ ] `docker exec <seat> grep -n -A6 <heading> /sandbox/.openclaw/workspace/AGENTS.md` matches the
      repo. If it differs, the seats are running older words than the repo says.

### Manual verification
- [ ] Read the trigger block as a manager would. It must not name a tool.

---
*Manual item present — STOP and wait for the user.*

## Phase 4: The questionnaire itself

### What this phase does
The conversation: what it asks, in what order, how it confirms, and what it does with the answers.
All of it lives in the skill body — **no TypeScript, no migration.**

### Changes required

**Six clusters, each confirmed and committed as a block:**

| Cluster | Items | Commits to |
|---|---|---|
| Where and when | city, timezone, hours | `tenants.timezone`, `tenant_settings.approx_work_*_hour`, `tenant_profiles` |
| Team | names, tiers | `add_technician_seat` |
| What you do | trades, how you operate | `planner_memory`, seat `MEMORY.md` |
| Boundaries | who commits times, what technicians must not see, escalation, after-hours | `planner_memory`, `set_technician_view` |
| Jobs | common types, durations | `set_job_duration` |
| Letterhead | legal name, address, licenses | `set_firm_profile` |

**Order matters: "where and when" and "team" go first.** A manager who just pressed Start can be
called away at question six; if the first six were letterhead, nothing useful was banked. Timezone
unset corrupts every date silently and hours unset roughly doubles planner spend.

**Asking for the timezone without saying "timezone":** ask where they are based (needed for the
letterhead anyway), and fall back to the clock only for the split states (AZ, IN, TX, FL, KY, TN,
ND, SD, NE, KS, ID, OR, MI). One question for most firms, two for the rest, and the manager never
sees the word. *This is NOT a breach of "the manager is NEVER a verification layer for dates"
(2026-08-11)* — that rule is about the model guessing a date and asking a human to check it; this is
an input only the manager can supply, confirmed once at setup. Recorded so a later session does not
delete the confirmation as a rule violation.

**Per-question terminal states — `answered | unknown | deferred | refused`.** The standing rule
*"the person we ask may not know, or may not have been there"* applies directly: without `unknown`
as a legal outcome the skill loops or silently drops the question. **The non-answers are the part
that must be durable** — `answered` is reconstructible from the destinations, but a null column
cannot say whether it was never asked or asked and unknown, and that difference is what stops the
seat asking the same thing every week.

**A no-progress breaker**, per `thoughts/shared/plans/2026-09-11-the-planner-stops-when-it-stops-learning.md`
(written after one tick repeated the same call ~600× and spent $8.67). Two or three exchanges that
resolve nothing → mark the item `unknown`, say so, move on. Several in a row → end the run, report
what is open, offer to resume.

**Pacing: one or two questions per message.** Left alone a model emits the whole list as a numbered
form, which gets abandoned.

**Verify by READ-BACK at the end of each cluster, not by the model's claim** — `set_firm_profile {}`
plus `profileGaps()`, `list_team`. **This is the load-bearing check.** Everything else degrades
gracefully; without it a run reports success while `tenant_settings` is empty and nobody finds out
until the planner is thinking 24 hours a day.

**Close with a gaps report naming consequences**, not a count:

```
Still open:
  Ben's availability — he can't be scheduled until this is set
  License numbers    — invoices can't print
  Job durations      — everything defaults to 2 hours
```

**What lands in memory is distilled, never the transcript.** `MEMORY.md` is capped at 3000
characters and rides in every prompt; individual files cap at 4000, sized against
`PLANNER_MAX_TOKENS = 8192` — **a write large enough to hit `finish_reason=length` throws out of
`runToolLoop` and kills the whole firm's tick.** Two filters decide membership: *if a line cannot
change a decision it does not go in* ("twelve years in business" changes nothing), and *if a table
holds it, memory does not*.

### Automated verification
- [ ] None possible — the skill body is prose. The checks are live.

### Live verification (agent-executable)
- Prerequisites: s2, a scratch tenant with no profile.
- [ ] A full run against a scripted manager populates every destination; psql read-back matches what
      was confirmed on screen.
- [ ] **A run abandoned mid-cluster commits everything up to the last checkpoint and nothing of the
      incomplete one**, and `/questionnaire` resumes at the right question.
- [ ] A manager who answers "depends" three times gets the item marked `unknown` and the
      conversation moves on.
- [ ] A deliberate misspelling is caught at cluster review and corrected **before** any ref is
      minted.
- [ ] Seat `MEMORY.md` after the run is a handful of lines, not a transcript.

### Manual verification
- [ ] Read a full transcript end to end as the manager. This is the deliverable — everything else
      serves it.

---
*Manual item present — STOP and wait for the user.*

## Phase 5 — DEFERRED: seeding the technician seats

Out of scope, recorded so the omission is deliberate. The manager's answers are supposed to reach
the *technician* seats' memory, and **nothing can write another seat's workspace** — each is its own
container, and `seat-sync.sh` is bot wiring, not memory. The shape worth considering (not a
decision): do not push files into sandboxes; seats already reach the spine over MCP, so firm context
can be a tenant-scoped read they pull, **audience-filtered server-side** — which keeps the
money-visibility rule (technicians see money STATUS, never amounts) enforced in one place rather
than trusting each seat's `MEMORY.md` not to contain what it should not.

## Also deliberately not in this build

- **Rename and set-tier tools** — see the Decisions.
- **The team settings page** — its own build; the questionnaire does not depend on it. Team entry
  stays in chat until it exists.
- **`bind_telegram`'s copy**, which still tells a manager to *"ask their operator"* for a handle they
  supplied under the customer-creates-own-bots flow. A one-line fix, but it belongs with the
  onboarding-flow work, not here.
- **Per-firm escalation timing** — the questionnaire records "escalate at 4h" as prose the code does
  not read. `NUDGE_ESCALATE_HOURS` is global and moves in build 6 **together with its planner
  mirror**, because moving one side alone manufactures the exact disagreement `planner.ts:762-766`
  warns about.
