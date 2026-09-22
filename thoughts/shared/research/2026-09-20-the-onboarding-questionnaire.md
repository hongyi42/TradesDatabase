---
date: 2026-09-20
branch: main
commit: e4b9a4c
topic: The onboarding questionnaire — where each answer can physically land (the two memory substrates and the tables that already exist), who may write each destination, the cross-seat gap that has no mechanism, and the final question list
supersedes: nothing
---

**Builds on** firm profile v1 (`thoughts/shared/plans/2026-08-15-firm-profile-v1.md`, shipped) and
the firm-is-data build (`thoughts/shared/plans/2026-08-29-the-firm-is-data.md`, shipped), which
between them created every table an answer can land in. Refines nothing; overturns nothing.

**Companion:** `thoughts/shared/research/2026-09-20-the-onboarding-flow.md` covers everything around
the questionnaire — who creates the Telegram bots, the settings page, how a firm reaches a running
seat, and why the manager's first contact is the earliest moment this can fire at all.

## Summary

A manager finishes account setup and the assistant runs `/questionnaire` once. The operator's
framing (2026-09-20) is what makes this different from a settings form: **the objective is not to
fill columns, it is to initiate the planner's and the seat agents' memory files.** Columns are the
by-product.

Reading the code against that framing, three things:

1. **Almost every answer already has a home.** `tenants`, `tenant_profiles`, `tenant_settings`,
   `job_type_durations`, `technicians` and `planner_memory` cover the whole list. One build should
   add no table.
2. **Both memory substrates exist and both are runtime-writable** — the planner's
   `planner_memory` and, on each seat, OpenClaw's own workspace `MEMORY.md` plus dated daily notes.
   The seat agent maintains its own.
3. **One thing has no mechanism: cross-seat seeding.** The manager's answers are supposed to reach
   the *technician* seats' memory, and nothing can write another seat's workspace.

A fourth thing is a constraint rather than a finding: `MEMORY.md` rides in every prompt and is
capped at 3000 characters, so "send the entire conversation history to the planner" cannot land
there as written.

## Entry points

| Where | File:line | Role |
|---|---|---|
| Planner memory store | `supabase/migrations/20260830120000_planner_memory.sql:27,62` | `planner_memory` + `planner_memory_versions` |
| Planner memory rails | `src/teamLead/memory.ts:21-32` | `MEMORY_INDEX_PATH`, `MEMORY_INDEX_MAX`, `MEMORY_FILE_MAX` |
| Planner memory tools | `src/mcp/tools/office.ts:139,156` | `read_memory` / `write_memory` |
| Shadow-mode ruling | `src/teamLead/planner.ts:5665-5676` | why memory writes are deliberately ungated |
| Seat memory doctrine | `Box_Setup_Stuff/bootstrap-box.sh:925-980` | seat `MEMORY.md`, daily notes, `task-progress/` |
| Seat doctrine file | `/sandbox/.openclaw/workspace/AGENTS.md` | operator-written, delete-then-append per run |
| Firm letterhead | `src/db/tenantProfiles.ts` | `set_firm_profile` |
| Firm numbers | `src/db/tenantSettings.ts:78-88` | `resolveSettings` and its fallbacks |
| Seat cap | `supabase/migrations/20260702194603_technicians_and_review_items.sql:30-38` | `enforce_seat_cap()` trigger |

## The operator's rulings (2026-09-20)

- **A firm can do several trades.** Never a single trade-type enum.
- **Trade kinds and the manager's language belong in MEMORY, not a table.** Verified: there is no
  `language` or `locale` column anywhere in the schema, and there should not be one.
- **"What system do you use today?" is an OPERATOR question, gathered before sales close** — not a
  questionnaire item.
- **Team size is asked before the manager is provisioned**, for the same reason (below).
- **The manager's answers also seed the TECHNICIAN seat agents' memory**, not only the manager's own
  seat and the planner.
- **Conversational discovery in chat, typed fields on the settings page** — with the addition that
  if the manager gives typed-field information in chat, **the agent sets it up for them** rather
  than redirecting them to the page.
- **On who writes the typed fields:** *"Planner will write after rung 10d, but if the seat agent can
  do it, sure."*

## The two memory substrates

### Planner memory — a store, with rails

`planner_memory` is tenant-scoped and versioned (`planner_memory_versions`), reached by the office
tools `read_memory` / `write_memory`. Its shape is already "push the keys, pull the content":

```
src/teamLead/memory.ts:21   MEMORY_INDEX_PATH = 'MEMORY.md'   -- structurally reserved, DB CHECK
                      :25   MEMORY_INDEX_MAX  = 3000          -- rides in EVERY prompt
                      :32   MEMORY_FILE_MAX   = 4000          -- fetched on demand
```

Both ceilings carry their reasoning in the file and neither is about storage:

- The index cap is *"about attention, not money… an index that grows without limit crowds out the
  gaps it exists to serve."*
- The file cap is sized against `PLANNER_MAX_TOKENS = 8192`, which the model shares with its
  reasoning at `reasoningEffort: 'medium'`. **A write big enough to hit `finish_reason=length`
  throws out of `runToolLoop` and kills the whole firm's tick — not just the write.**

Paths are shape-checked (`PATH_SHAPE`, mirrored by a database CHECK): lowercase, `.md`, e.g.
`firm/pacing.md`.

### Seat memory — OpenClaw's own, and it already exists

Each seat's workspace carries **`MEMORY.md`**, **dated daily notes** and **`task-progress/<task>.md`**.
The doctrine that governs them is written into `AGENTS.md` by `bootstrap-box.sh` §0d
(`:925-980`), and it draws two lines this build must respect:

- *"Write a few short lines of what you learned into MEMORY.md — **keep it terse, it loads into
  every future session**."*
- *"Lasting facts about a customer or job do NOT belong in MEMORY.md — record them into the company
  record"* (`record_standing_fact`, `record_field_note`). The firm-level analogue follows directly:
  **timezone, hours and job durations belong in their tables, not in `MEMORY.md`.**
- `task-progress/` is *"verbose working scratch, not durable memory"* — the questionnaire transcript
  is that shape, not memory's.

**Bootstrap does not seed these files; the agent maintains them.** That distinction is worth stating
because `bootstrap-box.sh` writes no workspace file *but* `AGENTS.md`, which reads at a glance as
"seats have no memory". They do — it is simply agent-written rather than operator-written.

## Who may write what

### The memory half: no gate, by design

`planner.ts:5665-5676` settles this explicitly, and it is a deliberate design statement rather than
an oversight:

> `write_memory` has no mode gate, so a shadow tick really does write `planner_memory` and really
> does stamp `planner_runs`. Shadow means "change nothing a person will see" — no message goes out,
> no gap moves — and it has always written the planner's own records. Gating memory would make
> shadow useless for the one question it exists to answer here: what does this planner's memory look
> like after a week of ticks?

So **the planner may write firm memory today**, and the usual shadow-mode objection does not reach
it.

### The typed-field half: the shadow trap is live

`set_firm_profile`, `tenant_settings`, `job_type_durations` and `technicians.availability` are state
a person sees. `TEAM_LEAD_TOOL_SCHEMAS` reaches the heartbeat planner, the Calls-worker's focused
pass **and shadow ticks**, none of which have a mode gate — the reason the `record_caller` pattern
was rejected for the access tools (engineering-memory, 2026-09-19). **The manager's own seat agent**
holds `ADMIN_TOOLS` behind the manager badge and is the right actor for this half today.

### What rung 10d does and does not carry

10d is the **L2** ruling (user doctrine 2026-09-09): the door gives up five L2 writes from
technician notes, the planner gains them, `labor_hours` is deleted. `record_caller` shipped as its
first slice (PR #214). Firm profile and firm settings are **ADMIN** tools, not L2, so they sit
outside 10d's stated scope. If the planner is to hold them after 10d, that is a separate widening
and should be recorded as one rather than assumed.

## The gap: cross-seat seeding has no mechanism

The manager's answers must reach the technician seats' memory. Each seat is its own container with
its own workspace; nothing writes another seat's files. `seat-sync.sh` is bot wiring (getMe,
`setChatMenuButton`) and touches no memory. No path was found.

**The visibility flag is the load-bearing part of whatever closes it.** A single shared blob leaks:
the manager's answers contain things technicians must never see (money amounts — standing doctrine,
technicians see money STATUS only). Firm memory needs per-audience marking from the first write, not
retrofitted.

**Shape worth considering, not yet a decision:** do not push files into sandboxes. Seats already
reach the spine over MCP, so firm context can be a tenant-scoped read the seats pull,
audience-filtered server-side — which keeps the money-visibility rule enforced in one place instead
of trusting each seat's `MEMORY.md` not to contain what it should not.

## What "terse" means here, concretely

Not a style note — a ceiling with a failure mode behind it. An answer dumped raw:

> Sam explained the company does both HVAC and plumbing, has been in business about twelve years,
> and that he prefers to handle dispatch himself in the mornings because he likes knowing where
> everyone is before the day starts…

What should land in the planner's index:

```
- firm/operate.md — Sam dispatches mornings; 2-man installs, solo service
- firm/people.md  — 6 techs; Marco runs installs
- firm/pacing.md  — escalate to Sam at 4h silence, not 24
```

And in a seat's `MEMORY.md` (tech-safe subset only):

```
HVAC + plumbing. Manager Sam speaks Spanish — reply in Spanish.
Installs 2-man, service solo.
Never quote dollar amounts.
```

Two filters decide membership:

- **If a line cannot change a decision, it does not go in.** "Twelve years in business" changes
  nothing the planner or a seat does. This is the existing rule *only accumulate what something can
  later falsify* applied at write time.
- **If a table already holds it, memory does not.** Timezone, work hours and job durations are
  columns; duplicating them into memory buys nothing and creates two copies to drift apart.

## Shipping it as a skill (operator direction, 2026-09-20)

**"Skill" means two different things in this project — do not confuse them.** This section is
about an **OpenClaw plugin-skill on a seat**, loaded into a manager's or technician's assistant at
runtime. It is NOT a `.claude/skills/<name>/SKILL.md` file, which is a rubric Claude Code consults
when a *developer* works on this repo (see `thoughts/shared/research/2026-07-31-skills-for-prod-scaling.md`
and `2026-07-30-system-design-principles-for-skill.md`). Different system, different audience,
different file, different machinery.

The shape fits: a questionnaire is a **long procedure run once**, which is exactly what progressive
disclosure is for. The alternative — putting the flow in `AGENTS.md` — would tax every turn on that
seat forever, and four of the nine `AGENTS.md` blocks are append-once besides. A skill's body loads
only when invoked; only its description rides in the prompt.

**But skills are switched off on every seat today, on purpose.** The wire block in
`bootstrap-box.sh:1561` sets:

```jq
| (.skills) = ((.skills // {}) | .limits = ((.limits // {}) | .maxSkillsInPrompt = 0))
```

Its stated reason (`bootstrap-box.sh:1475-1478`, and engineering-memory §3219): openclaw ships **15
stock plugin-skills** — meme-maker, notion, python-debugpy, tmux, weather — *"none of which relate
to a trades business. Worth ~1,225 tokens per call."* Recorded as **"a free cut"** when
`## Skills` was measured as the **largest section of the system prompt**.

**`maxSkillsInPrompt` is the wrong lever — it is a count, not a selector.** It is applied as
`skills.slice(0, max(0, n))`, so `1` yields whichever skill openclaw enumerates first. **The
truncation order is not documented** ([skills-config](https://docs.openclaw.ai/tools/skills-config)
states no ordering or precedence rule), so position must not be depended on.

**There IS an allowlist, and it is the right lever** (vendor docs, fetched 2026-09-20):

| Key | Behaviour |
|---|---|
| `agents.defaults.skills` / `agents.entries.*.skills` | the explicit final skill set for an agent; **does not merge with defaults** |
| `skills.allowBundled` | allowlist for **bundled** skills only — managed and workspace skills are unaffected |
| `skills.entries.<key>.enabled: false` | per-skill off switch, effective even on a bundled/installed skill |

So the shape is: ship the questionnaire as a **managed/plugin** skill (the `trades-weekday-guard`
path), gate the stock 15 off with `skills.allowBundled`, and only then raise `maxSkillsInPrompt` off
0 — where it is a ceiling, not a chooser.

**Verify the key spelling against the INSTALLED schema before writing any jq.** The doc says
`agents.entries.*.skills`; a secondary source says `agents.list[].skills`; `bootstrap-box.sh`
currently writes `.agents.list`. The fleet runs openclaw **2026.6.34**, whose config schema is
**strict** for at least `compat` (engineering-memory §3) — under a strict object a wrong key is a
hard failure, not a silent ignore.

**Packaging is precedented.** `Box_Setup_Stuff/plugins/trades-weekday-guard/` already ships a custom
openclaw plugin with `openclaw.plugin.json` and `activation.onStartup`, delivered by the wire phase.

**Three recorded traps on that path**, all in engineering-memory §5:

- `openclaw plugins install` — the vendor's own CLI — **trips the config-hash trap** (L1704).
- **NEVER change a sandbox's `openclaw.json` with `openclaw config patch`** (L3952).
- **A plugin is not installed until the GATEWAY's startup line says so** (L1693) — a restart is not
  proof.

**And one standing rule that governs the decision**: *"Do not re-enable without measuring whole
turns (seconds + total tokens), never a single call."* That rule exists because tool search was
enabled and reverted the same day on a first-call measurement that inverted at turn level.

Order of work this implies: confirm the allowlist key against the installed 2026.6.34 schema, gate
the bundled 15 off, ship the trades skill as our own plugin, then raise the cap to what remains —
measured at the turn level, not the call.

**Sources:** [skills-config](https://docs.openclaw.ai/tools/skills-config) ·
[skills](https://docs.openclaw.ai/tools/skills) ·
[config-extensions](https://docs.openclaw.ai/gateway/config-extensions)

## The question list

### Stage 0 — operator, before the manager is provisioned

| # | Question | Why it is here |
|---|---|---|
| 0.1 | What system do you use today, and where does the schedule actually live? | Operator ruling. Feeds the coexist-with-the-incumbent-FSM doctrine (2026-09-06) — the spine is our record, fed from theirs |
| 0.2 | How many people, and how many need a seat? | Sets `manager_seats` / `technician_seats`. `enforce_seat_cap()` is a database trigger, so asked later it **rejects technician inserts mid-questionnaire** |

### Stage 1 — `/questionnaire`, conversational → memory

Distilled into the manager seat's `MEMORY.md` and `planner_memory`; the tech-safe subset reaches the
technician seats (pending the gap above).

**Firm shape**

1. Which trades do you do? *(plural — never one value)*
2. How do you guys operate? *(day shape, crews vs solo, who dispatches, how jobs get assigned)*
3. What does a typical week look like, and what changes in busy season?

**People**

4. Who is on the team — name, what each actually does, who they answer to
5. What language does each person speak? *(per person, manager included — each seat is its own bot)*
6. Who may commit a time to a customer?
7. Who talks to customers at all?

**Boundaries and pace**

8. What must technicians not see? → also sets `set_technician_view` + hidden tags
9. If a technician goes quiet, how long before I come to you?
10. Do you take after-hours or emergency calls, and what counts as an emergency?
11. How does work come in? phone / email / text / walk-in

### Stage 2 — typed fields, filled by the agent from the same conversation

The manager never sees a form; the manager's seat agent calls the tools.

| # | Question | Lands in | Cost of skipping |
|---|---|---|---|
| 2.1 | What timezone are you in? | `tenants.timezone` | defaults `America/Los_Angeles` — every date silently wrong for a Texas firm |
| 2.2 | Roughly what hours do you work? | `tenant_settings.approx_work_start_hour` / `_end_hour` | planner thinks at full rate 24/7 ≈ double model spend per firm |
| 2.3 | Your most common jobs, and how long each takes? | `job_type_durations` | everything falls back to `tenants.default_job_minutes` (120) |
| 2.4 | Each technician's weekly availability and cities covered | `technicians.availability`, `service_cities` | NULL availability means the scheduler treats that person as **unschedulable** |
| 2.5 | Legal name, address, phone, email, license numbers, disclosure footer | `tenant_profiles` via `set_firm_profile` | no customer-facing document can print |
| 2.6 | Do you have a customer list to import? | L2 seeding | starts empty |

## Where every answer lands

| Question | Destination |
|---|---|
| Which trades (plural) | seat `MEMORY.md` + `planner_memory` |
| How you operate | `planner_memory` → `firm/operate.md` |
| Typical week / busy season | `planner_memory` |
| Who is on the team | `technicians` rows via `add_technician_seat` |
| What each person does | `set_technician_skills` + `planner_memory` |
| Each person's language | that person's seat `MEMORY.md` + `planner_memory` |
| Who may commit a time to a customer | `planner_memory` |
| Who talks to customers | `planner_memory` |
| What technicians must not see | `set_technician_view` + hidden tags |
| Escalation timing | `planner_memory` — **no per-firm column yet**; `NUDGE_ESCALATE_HOURS` is still global and moves in build 6 with its planner mirror |
| After-hours / emergency policy | `planner_memory` |
| How work comes in | `planner_memory` |
| Timezone | `tenants.timezone` |
| Working hours | `tenant_settings.approx_work_start_hour` / `_end_hour` |
| Common jobs + durations | `job_type_durations` |
| Availability + cities covered | `technicians.availability`, `service_cities` |
| Legal name, address, licenses | `tenant_profiles` via `set_firm_profile` |
| Customer list | L2 `customers` |

Destinations are not exclusive — "we do HVAC and plumbing" belongs in the planner's memory **and**
in each seat's `MEMORY.md`, because both agents need it and neither can read the other's. The rule
for choosing: **a column exists for it → the column** (code reads columns, nothing reads prose);
**no column, and an agent needs it to behave correctly → that agent's memory.**

## Making sure it is actually gathered

The failure mode is not a manager refusing to answer — it is the model deciding it is finished.
Completion has to be mechanical.

**1. Completion means every question reaches a TERMINAL STATE, not that every field is filled:**
`answered | unknown | deferred | refused`. The standing rule *"the person we ask may not know, or
may not have been there"* (2026-08-21) applies directly — a manager may genuinely not know their
license number. Without `unknown` as a legal outcome the skill either loops or silently drops the
question.

**2. Keep the checklist in `planner_memory`, one home.** The obvious alternative is
`task-progress/questionnaire.md` in the seat workspace, which is what the batching doctrine
(`bootstrap-box.sh` §0d) prescribes for this shape — but the workspace is wiped by a sandbox
rebuild, and onboarding is exactly when a seat is newest and most likely to be rebuilt. The cost of
`planner_memory` is one MCP call per answer instead of a free local file write, roughly fifteen
extra tool calls across the conversation. Worth it to avoid a two-home copy step and the "did the
non-answers get migrated before the file was deleted" bug.

**Why the non-answers are the part that must be durable:** `answered` is reconstructible —
`set_firm_profile {}` plus `profileGaps()` and `list_team` re-derive most of it from the
destinations. What cannot be reconstructed is the difference between **"never asked"** and
**"asked, they did not know"**: both are an empty column. **A table can store a value; it cannot
store the reason there is not one** — and that reason is what stops the seat asking the same
question every week.

**3. Write after each answer — to the STAGING record, not to the destinations** (user,
2026-09-20). Same doctrine: *"Assume interruption: your run can end at any moment, and anything not
written to the progress file is lost."* Nothing is lost on interruption, because every answer is
recorded the moment it is given; what is deferred is the **commit**, which is the part that is
dangerous. See "Stage, review, then commit" below.

**4. Verify by READ-BACK, not by the model's claim.** At the end, re-read the real destinations —
`set_firm_profile {}` is already a no-write read that echoes the profile plus `profileGaps()`,
`list_team` gives the roster — and compare against the checklist. **This is the load-bearing one.**
Everything else here degrades gracefully; without the read-back a run can report success while
`tenant_settings` is empty and nobody finds out until the planner is thinking 24 hours a day.

**5. End with a gaps report that names consequences**, not a count:

```
Still open:
  Ben's availability — he cannot be scheduled until this is set
  License numbers    — invoices cannot print
  Job durations      — everything defaults to 2 hours
```

`profileGaps()` is this idea already; generalise it. An incomplete run becomes a manager's to-do
list instead of a silent hole.

**6. Order the questions so the load-bearing ones are banked first.** Not two meetings — the
questionnaire is still a once thing. But a manager who just pressed Start can be called away at
question six, and if the first six were letterhead nothing useful was saved. Ask **timezone,
approximate hours, and who is on the team** first; everything else after. It also gives the run a
natural stopping point ("that is the essentials — keep going, or pick this up later?") instead of
the model deciding on its own when it is done.

**7. Pace it explicitly — one or two questions per message.** Left alone a model emits all fifteen
as a numbered list, which reads as a form and gets abandoned.

**8. Give it a no-progress breaker**, per `thoughts/shared/plans/2026-09-11-the-planner-stops-when-it-stops-learning.md`
(written after one tick repeated the same call ~600× and spent $8.67). Progress = a checklist item
reaching a terminal state. The stall it prevents:

> **Q:** What hours do you usually work? **A:** Depends.
> **Q:** Roughly when does the crew start? **A:** It varies.
> **Q:** Is there a typical window? **A:** Not really.

Two or three of those and the breaker marks the item `unknown`, says so, and moves on — the
per-question version. A global one sits on top: several questions in a row going nowhere ends the
run, reports what is open, and offers to resume. A manager giving one-word answers is busy, and
grinding on is how they stop using it.

## Stage, review, then commit (user, 2026-09-20)

**Nothing reaches a destination while the questionnaire is incomplete.** Answers accumulate in the
staging record; on completion they are written out to `planner_memory`, the seat's `MEMORY.md` and
the database columns. The reason is that **the questionnaire is the highest-typo-risk moment in the
system — fast conversational entry, a brand-new user, names spoken rather than typed — and it
writes to the least reversible surfaces we have.**

### What is actually irreversible today (measured 2026-09-20)

| Mistake | Reversible? |
|---|---|
| Typo in timezone | **No writer exists at all.** `src/db/tenants.ts` has `getTenant`, `createTenant`, `setTenantSeats` — no timezone setter, and no MCP tool touches it. Set once at tenant creation; unset means `America/Los_Angeles` |
| Misspelled name | No rename tool. The ref is minted from the name and never reused |
| Wrong tier | No tool — set only at `add_technician_seat` time |
| Wrong person added | `deactivate_technician_seat` frees the seat, but *"permanently destroys [the sandbox] including its chat memory and recycles the slot into the pool as a fresh blank"*. The ref stays burned |
| `tenant_profiles` fields | Yes — partial patch, explicit null clears |
| `tenant_settings` | Yes — same shape |
| `job_type_durations` | Yes — upsert on `(tenant_id, job_type)` |
| Memory files | Yes — `write_memory` replaces a path, versions retained |

`add_technician_seat`'s two-step confirm exists for this, but it only helps if the manager notices —
"Ben Shelton" read back as "Ben Sheldon" gets a yes.

### The review step is the real win — and its unit is the CLUSTER

Staging makes it possible to show the manager things **written down** before they are real. The
question is how often. Three options, and only the third works:

- **Per answer** — a confirmation treadmill, and the pattern already moved away from (one-shot for
  reversible things; confirm only what cannot be undone).
- **Once at the end** — a dozen-plus items in front of a manager who said the first one twenty
  minutes ago. Unreadable, so it gets a reflexive yes.
- **Per topic cluster** (user, 2026-09-20) — three or four related questions, confirmed straight
  after them while still fresh.

```
Bot:  Where are you based?
Sam:  Austin, Texas
Bot:  Texas spans two zones — what time is it there now?
Sam:  quarter to four
Bot:  And roughly what hours does the crew work?
Sam:  7 to 4 usually

Bot:  So: Austin, Central time, roughly 7am–4pm. Right?
Sam:  yep
      [cluster committed]

Bot:  Who's on the team?
Sam:  me, Ben, Marco, and Judy does the books

Bot:  Ben Shelton and Marco Diaz as technicians, Judy Chen as manager —
      spelling right?
Sam:  Marco's Diaz with one z
      [corrected, then committed]
```

Three lines to check, seconds after they were said. That is what catches "Sheldon, not Shelton";
twelve lines twenty minutes later does not.

| Cluster | Items |
|---|---|
| Where and when | city, timezone, hours |
| Team | names, tiers |
| What you do | trades, how you operate |
| Boundaries | who commits times, what technicians must not see, escalation, after-hours |
| Jobs | common types, durations |
| Letterhead | legal name, address, licenses |

Six checkpoints across the whole run. **Review frequency and commit frequency are the same event** —
do not design them separately.

**After onboarding there is NO scheduled re-review.** That is the pattern just retired (*"I don't
expect our managers to ask for pending reviews"* — managers do not go looking for admin chores in
chat). Per the 2026-09-19 doctrine, contradictions are raised at points of inference: the recorded
hours get questioned when a technician is scheduled at 6am for the third time, not on a timer. What
is still open re-surfaces when the manager next runs `/questionnaire`.

### Three conditions

1. **A CLUSTER is complete when each of its questions reached a terminal state** — not when every
   field is filled. Otherwise the fatal version: the manager defers license numbers, never returns,
   and nothing ever commits — timezone sits in staging while the system runs on
   `America/Los_Angeles`. Cluster-level commit also means an abandoned run has everything up to the
   last checkpoint, rather than nothing.
2. **The commit must be resumable per destination.** It is six or seven writes across Postgres,
   planner memory and a seat file, with no transaction spanning them. If write four fails there is
   nothing to roll back to, so the staging record marks each destination written and a retry does
   only what is left.
3. **Check the seat cap before staging a roster, not at commit.** Staging eight technicians against
   three purchased seats otherwise fails after the whole conversation. The headcount is known from
   stage 0.

### What this changes about the tools

- **`set_timezone` is still required** — staging does not create a writer that does not exist, and
  without it the questionnaire cannot do the highest-value thing on its list.
- **Rename and set-tier drop from blocking to later.** First-run typos are caught at review. They
  are still wanted eventually (technicians get promoted, names get corrected months on) but they no
  longer gate shipping.

## Asking for the timezone without saying "timezone"

No manager types `America/Chicago`. They say "central", or the name of their town, and the model
converts — so the failure mode is not a misspelling, it is a **valid but wrong** zone that
validation cannot catch: Phoenix says "mountain" and `America/Denver` validates fine while being an
hour off for half the year. Indiana and Texas span two zones each.

**Ask where they are based** — needed for the letterhead anyway — and only fall back to the clock
when the state is ambiguous (AZ, IN, TX, FL, KY, TN, ND, SD, NE, KS, ID, OR, MI):

```
Bot:  Where are you based?
Sam:  Austin, Texas
Bot:  Texas spans two zones — what time is it there right now?
Sam:  quarter to four
Bot:  Central, then. It's 3:45pm for you, and I'll read every date that way.
```

One question for most firms, two for the split states, and the manager never sees the word
"timezone".

**Confirm the consequence, not the identifier.** Nobody can verify `America/Chicago`; everybody can
verify what time it is. Same principle as `last heard from` in the team table.

**Also validate at the tool boundary** — `Intl.DateTimeFormat(undefined, {timeZone: x})` throws
`RangeError` on a non-IANA name, so a garbled string is refused before storage. Precedent:
`tenant_profiles.state` refuses `'Texas'` and names the fix rather than accepting it silently.

**This is not a violation of "the manager is NEVER a verification layer for dates"** (2026-08-11).
That rule is about the model guessing a date and asking a human to check it; the fix was making the
system authoritative. The timezone is an input only the manager can supply, there is no other
source in chat, and it is confirmed once at setup rather than per date. Recorded here so a later
session does not delete the confirmation as a rule violation.

**If it cannot be resolved it must NOT fall through to the default.** A missing license number is a
visible gap; a wrong timezone is silent and corrupts every date. It goes at the top of the gaps
report in plain language: *"I don't know your timezone yet, so dates may be wrong until you tell
me."*

**One exact source for later:** the Mini App can read
`Intl.DateTimeFormat().resolvedOptions().timeZone` from the browser. Not available during the
questionnaire (that is chat), but the settings page could capture it silently the first time the
manager opens the board. Telegram's Bot API exposes no equivalent.

## Open questions for the plan

1. **How does the tech-safe subset reach a technician seat?** The one thing with no mechanism.
   Pull-over-MCP with server-side audience filtering is the shape that respects the money doctrine;
   it is not yet a decision.
2. **Where does the raw transcript live?** It is `task-progress`-shaped, not memory-shaped. L1
   captures are the obvious home (stamped, ours, for eval and debugging), but nothing in this
   research verified that path for a questionnaire's transcript.
3. ~~**Does `/questionnaire` resume?**~~ Answered above — the checklist lives in `planner_memory`,
   written after every answer, and the skill resumes from it. What remains open is whether the
   breaker's thresholds (two or three stalled exchanges per question; how many in a row ends the
   run) are right, which only a live run will tell you.
4. **What happens on the second run?** "Once" is the intent; a manager who re-runs it, or a firm
   whose answers change, needs a defined behaviour (append, reconcile, or refuse).
5. **Who writes the typed fields after 10d** — the seat agent keeps them, or the widening above is
   taken deliberately.
6. **Which allowlist key this openclaw build actually accepts** — `agents.entries.*.skills`,
   `agents.list[].skills` or `skills.allowBundled`. The mechanism exists; only the spelling for
   2026.6.34 is unconfirmed, and a strict schema turns a wrong guess into a hard failure.
