---
date: 2026-08-23
branch: main
commit: 85a3c16
topic: ⑤ memory — every store, reader, and gap in the substrate as built (planner + seats)
supersedes: thoughts/shared/research/2026-08-22-brain-memory-foundations.md (its attribution and
  continuity findings — both BUILT since by ③; its closure-semantics findings still stand), and
  in part thoughts/shared/research/2026-08-20-planner-memory-surfaces.md (historyLine, the
  record block, and the recall surface have all changed shape since)
---

## Summary

"Memory" for this system means two different machines. The **planner** (one model call per firm
per half hour, on the spine) forgets everything between calls; its memory is whatever code
pushes into its prompt plus whatever it chooses to read back with tools. The **seat agents**
(one per person, on trades-box-1) have the opposite problem: they remember conversationally —
a persistent session transcript plus an injected window of recent chat — but nothing they learn
survives a sandbox rebuild, and nothing person-specific has a designed home.

The load-bearing finding of this survey: **the substrate ⑤ was scoped against no longer
exists — a better one does.** The Aug-20/22 research described a planner with no attribution,
no record of silence, and a bare "prior decisions: N" line. Since then ③ and ④ landed:
answers are attributed to the exact gap they close (`answered_by_capture_id`, exactly-one-gap
rule), silence is recorded (`unmentioned` rows, written by code, even for failed ticks), a
`leave` verb separates "I chose to wait" from "I never looked", the history line carries
"watched since / considered N× / last action", the prompt has a section literally headed
"YOUR MEMORY", and `spine_read` gives the planner SQL over captures, visits, nudges (all
statuses), and review items (all statuses). The corpus the CL work wants is being written
23 rows deep on the pilot already. What is MISSING is almost entirely on the **reader** side:
whole columns written and never read back, no cross-gap recall, no push of outcomes, and the
manager's corrective signal (dismissals) reaching no model at all.

## Entry Points

| Where it begins | File:line |
|---|---|
| Planner tick gate (%30, PLANNER_MODE) | src/jobs/lifecycle.ts:356-366 |
| `runPlanner` loop wiring (tools handed in) | src/jobs/lifecycle.ts:378, src/teamLead/planner.ts:1177-1184 |
| The pushed history line | src/teamLead/planner.ts:366-404 |
| Per-gap view (evidence, attribution marker, money) | src/teamLead/planner.ts:412-573 |
| The three-source decision record | src/teamLead/planner.ts:1380-1501 |
| Failed-tick trace rows | src/teamLead/planner.ts:1551-1580 |
| The prompt's "YOUR MEMORY" section | src/teamLead/plannerPrompt.ts:154-164 |
| `recall_decisions` dispatch + projection | src/mcp/server.ts:5396-5426 |
| `spine_read` view catalog | src/mcp/server.ts:636-687 |
| Attribution | src/mcp/server.ts:2012-2033, src/db/nudges.ts:376 |
| Model/provider resolution (all spine calls) | src/model/forcedTool.ts:73-93 |
| Prompt caching (planner loop + forced calls) | src/model/toolLoop.ts:231, src/model/forcedTool.ts:240 |

## Key Files

- **src/teamLead/planner.ts** (1596 lines) — the planner and its whole memory discipline:
  `PLANNER_ACTIONS` incl. `leave` (:62), `UNMENTIONED` + cap 200 (:76-86), `historyLine` (:366),
  `buildGapView` (:412), the three-source record block (:1380-1501), failed-tick rows (:1551).
- **src/teamLead/plannerPrompt.ts** — "YOUR MEMORY" (:154), spine_read context rules (:167-175),
  reading-is-not-citing.
- **src/db/nudgeDecisions.ts** — the corpus's typed layer: `recordNudgeDecisions` (:70, sole
  writer, one call site), `listDecisionsForNudges` (:120, keeps `unmentioned`),
  `listDecisionsForNudge`/`ForJob` (:163/:191, drop it).
- **supabase/migrations/20260820120000_nudge_decisions.sql** + five amendments — 18 columns now.
- **supabase/migrations/20260823120000_planner_read_surface.sql** — v_captures, v_visits,
  v_nudges, v_review_items; `nudge_decisions` deliberately excluded (:70-74).
- **src/mcp/server.ts** — recall_decisions (:1715, projection :5411-5424), attribution (:2012),
  list_pending_reviews (:7142), the twelve-view catalog (:636).
- **src/model/forcedTool.ts / toolLoop.ts** — provider switch (`MODEL_PROVIDER`), model ids
  (`ANTHROPIC_MODEL`, default `claude-sonnet-4-6` at forcedTool.ts:56), `cache_control` on the
  system block of BOTH transports (PR #170).
- **Box_Setup_Stuff/bootstrap-box.sh** — the ten AGENTS.md doctrine blocks (§0c×4, §0d, §0e,
  §0f, §0g, §0h, §0k), the seat config writes (heartbeat 0m, tool deny, toolSearch false).
- **src/eval/doctrine.ts** — `EXPECTED_SECTIONS`, the tier-2 eval's machine copy of the doctrine.

## Data Flows

### 1. One planner tick's memory loop (push the keys, pull the content, record everything)

```
tick (:00/:30) ─▶ open nudges (pending/queued/asked ONLY — closed rows never enter)
                     │
     batched reads: evidence-since-ask │ ledger │ listDecisionsForNudges (history incl. filler)
                     ▼
   per-gap block:  keys + evidence + money + ATTRIBUTION marker ("<-- LINKED TO THIS GAP")
                   + historyLine: "watched since <clock> — considered N×, last: <action> Xh ago"
                     │
                     ▼
   ONE model call (Anthropic transport, system block cache_control: ephemeral)
        tools: spine_read (12 views) · recall_decisions (per-gap/per-job) · submit_plan
                     │
                     ▼
   validateDecisions ─▶ apply ─▶ record THREE sources:
        decisions (applied/refused)  +  rail-refused  +  `unmentioned` for every unnamed gap
   … and if the whole tick DIES: one `unmentioned/refused` row per viewed gap,
     outcomeDetail = "tick failed: <why>"  — a failed tick is never invisible (planner.ts:1551)
```

### 2. What the corpus stores vs what any model can read back

The spine-store sweep produced a per-column reader map; the compressed truth:

| written | pushed to the planner | pullable (`recall_decisions`) | read by NOBODY |
|---|---|---|---|
| action, outcome, decided_at | ✔ (count + last + marker + since) | ✔ | |
| reason, citation, basis, confidence, outcome_detail, not_before | | ✔ | |
| handoff_note, question_draft, agent_context | | ✗ (other audiences only) | (planner can never re-read its own copy) |
| mode | | ✗ | ✔ write-only |
| escalate_after (decision copy) | | ✗ | ✔ write-only |

`recall_decisions` is keyed by gapId or jobId ONLY — no tenant-wide scan, no aggregation, no
"how did my last ten escalations go". `nudge_decisions` has **no spine_read view on purpose**:
the catalog is shared with the manager's `query_spine`, so a view would expose planner
deliberations to managers (migration :70-74, server.ts:5389-5395).

### 3. What is structurally INVISIBLE to the planner

- **Standing facts and all L3 `attributes`** — v_jobs/v_customers/v_visits expose no
  `attributes` column; `get_customer_context`/`get_job`/`brief_customer` are seat-tier tools.
  The extraction model writes visit attributes; the planner can never see them.
- **How a manager resolved anything** — every `list_pending_reviews`-style reader is
  status='open'; `v_review_items` DOES expose resolution/status for closed items, but nothing
  pushes it and the prompt never mentions it. The highest-value corrective signal
  (a dismissal = "you were wrong to escalate") reaches no model.
- **Closed nudges** — pull-only via v_nudges SQL; the open-statuses filter keeps them out of
  every prompt.

### 4. Seat-agent memory (box-side, as the repo records it)

```
per-person session (never auto-reset) ──▶ live context: last ~50k verbatim, older turns COMPACT
        │                                      + channel-history window (~11 msgs / 3 days, n=1)
        │                                      + AGENTS.md (ten doctrine blocks; 12k injected-
        │                                        context budget vs ~26.6k file — tail drops)
        ▼
on-disk transcript .jsonl — verbatim, complete; "~30d prune" asserted but UNENFORCED
workspace files: MEMORY.md (auto-loads) · memory/YYYY-MM-DD.md (today+yesterday) ·
                 task-progress/<task>.md (cursor, not auto-loaded)
        ▼
WIPE EVENTS: sandbox rebuild/recreate (workspace + MEMORY.md + cron jobs), seat recycle
             ("the old agent's memory is gone")
```

Durable recall about the BUSINESS is retrieval, not retention: find_customer →
get_customer_context / list_recent_captures / brief_customer / answer_customer_question, every
result carrying the firm-local `now` rider. `memory_search` returns
`{"disabled": true, "unavailable": true}` on s2 and is burned every turn — it is NOT in the
repo's deny list; the cause (vendor config vs breakage) is recorded nowhere.

## External Dependencies

- **Supabase/PostgREST** — every store; silent 1000-row default cap (each batched read pages).
- **Anthropic API** — the spine's model calls when `MODEL_PROVIDER=anthropic`;
  `cache_control` on the system block (min 512 tokens; compose's ~350-token prompt is a
  documented silent no-op). `ANTHROPIC_MODEL` env decides the model; code default is
  `claude-sonnet-4-6`.
- **Fireworks (GLM-5.2 fast router)** — the seat agents, via the box gateway; unrelated to the
  spine's provider switch.
- **openclaw 2026.6.34** — session persistence, compaction, channel injection, workspace memory
  files; vendor-controlled, repo-observed.
- **Render cron `*/5`** — the only invoker; planner gate `getUTCMinutes() % 30 < 5`.

## Constraints and Invariants

1. **The five ratified memory rules** (engineering-memory §the-brain): push the keys, pull the
   content · only accumulate what something can later falsify · traces are not memory ·
   append-only, never model-rewritten · keep it out of the business record.
2. **`unmentioned` is code's verb, not the model's** — submittable never; invisible to
   recall_decisions; counted by historyLine; capped at 200/gap.
3. **Attribution stamps only `asked` gaps, exactly one open gap per (tech, job), first write
   wins** — an escalated-then-answered gap stays unstamped (observed live 2026-08-23); a
   retracted stamped capture folds out but the slot stays taken.
4. **A refused close stores no citation** — refused quotes never persist in an evidence column.
5. **StandingFactBundle cannot hold a lesson**: exact-keys `{value(scalar), sourceCaptureId,
   recordedAt}`; provenance must be one L1 capture; removal only via retraction of that capture;
   L3 renders to managers as business fact. All three properties conflict with decision-derived
   lessons (planner-memory-surfaces constraint 1-3 — still true).
6. **The CL findings as design constraints** (2026-08-20 doc, unchanged): raw traces = measured
   negative transfer; homogeneous stores collapse retrieval (88.5%/5.4%); model-rewritten
   context erodes (ACE: itemised bullets + deterministic merge); never put the outcome in a
   replayed context (hint leakage). The pilot corpus is already homogeneous: 17 of 23 rows are
   `leave/applied`.
7. **Corpus growth is bounded by the ladder's own deadlines** except under NUDGES_MODE
   off/shadow + PLANNER_MODE live (filler cap 200 exists for exactly that).
8. **No planner eval exists.** date-eval's trust properties (independent truth implementation,
   truth from the live DB, phase attribution, mechanical adjudication, roll-outable tasks) are
   the recorded specification of what one costs. `src/eval/` reads `nudge_decisions` nowhere.
9. **Seat doctrine is delete-then-append refreshed** (7 of 10 blocks; 3 remain append-once:
   accuracy-rules, batching, web-content) — the fleet's procedural memory updates only via
   `wire`, and copy drift is its recorded failure mode.
10. **The eng-memory doc contradicts itself** on block counts (8 vs 9 vs 10 — 10 is correct)
    and on permanent-record's install mode (delete-then-append is correct); the setup guide
    defines only §0c/§0e and defers to the script as source of truth.

## Decision Points

1. **The unit of stored experience.** Per-decision rows exist (23 on the pilot; 74% one verb).
   The forks: keep per-decision only; derive per-gap-life summaries at close time (the gap's
   whole arc as one record); or per-firm distilled lessons. The homogeneity finding argues
   against similarity retrieval over per-decision rows; the corpus is scoped per-gap today.
2. **Which written-but-unreadable columns get a reader.** The planner cannot re-read its own
   handoff_note / question_draft / agent_context (audience-scoped projections), and mode /
   escalate_after are write-only. Options per column: add to recall's projection; expose via a
   planner-only mechanism; or leave write-only and accept the corpus is for OFFLINE learning
   only.
3. **Cross-gap recall.** Today: per-gap/per-job lookups only, and `nudge_decisions` is excluded
   from the shared view catalog to keep deliberations from managers. Forks: a planner-only view
   mechanism (splitting the catalog); recall_decisions gaining aggregate modes; or a distilled
   per-firm lesson store the planner reads instead of raw history.
4. **The manager's corrective signal.** Dismissals/resolutions are stored with full text and
   read by nothing. Forks: push recent resolutions into the planner's prompt (bounded); make
   the planner query v_review_items for its own escalations' fates (prompt change only —
   the plumbing exists TODAY); or fold resolutions into whatever lesson store #1 chooses.
5. **Where distilled lessons live** (unchanged fork from Aug 20, sharpened): widen
   StandingFactBundle (breaks exact-keys + retraction fold); a new table beside nudge_decisions;
   or no store — lessons derived on read. The five ratified rules constrain all three (append-
   only, falsifiable, out of the record).
6. **Seat-side memory.** Per-seat person-specific local memory is aspiration only (the
   sensitivity ruling depends on it; zero mechanism exists; §0d doctrine currently FORBIDS
   person-facts in MEMORY.md; rebuilds wipe everything). Forks: build it on the workspace-file
   substrate (MEMORY.md / daily notes) accepting wipe-on-rebuild; give seats a spine-backed
   store (survives rebuilds, but crosses the "keep it out of the record" rule); or defer
   seat-side entirely — the planner is the ratified first host.
7. **What the planner eval grades** (prerequisite question for "then the agentic eval at
   scale"): a replayed prompt (needs snapshotting evidence/ledger state — nothing snapshots
   today), a whole tick, or a gap's full life (subjects are `uq_nudges_subject_ever`-consumed,
   so re-running a gap needs fresh synthetic subjects). Hint-leakage rules out any replay that
   contains the outcome.

## Open Questions

- **Is the planner actually running Opus?** Code default is `claude-sonnet-4-6`
  (forcedTool.ts:56); the model is whatever `ANTHROPIC_MODEL` says in the CRON service's env,
  which no repo file records and this session cannot read. The user has stated Opus 5; the env
  should be confirmed before any memory design assumes Opus-class attention.
- **Does the planner keep calling recall_decisions as history grows?** Confirmed once on an
  empty history (2026-08-21); unobserved against a rich one. Related: no `unmentioned` filler
  row exists yet on the pilot (every tick so far named every gap — 1-2 open gaps at a time).
- **memory_search on seats**: disabled by what, and is the burned call worth a deny-list entry?
  (It is advertised to the model while returning disabled at call time.)
- **Transcript retention**: "~30d prune" is asserted, unenforced, unverified — it bounds any
  harvest-based seat memory design.
- **Channel-history selection logic**: "selected for current message" — n=1 observation;
  recency-vs-relevance unknown; a late reply may arrive with its question outside the window.
- **Compaction's effect on doctrine**: whether a compacted session retains AGENTS.md-derived
  behavior or only its summary — unmeasured (the 12k injected-context budget already drops the
  file's tail on every turn).
