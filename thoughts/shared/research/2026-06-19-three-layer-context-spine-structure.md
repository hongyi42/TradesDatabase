---
date: 2026-06-19
branch: main
commit: cb236a9
topic: Three-layer context spine — current repo structure and the design it prescribes
---

## Summary
This repo (`TradesDatabase`) is, as of today, a **design-and-scaffolding repo with no application
code**. It contains exactly two things: (1) a design document,
[Three-Layer-Context-Spine-Overview.md](Three-Layer-Context-Spine-Overview.md), that specifies a
data model for a trades-business platform — a single customer/job record split into three layers
(L1 raw / L2 structured / L3 attributes) — and (2) a portable copy of the Research → Plan →
Implement (RPI) workflow plus a `verifying-behavior` skill, sitting in `.claude/`. There is no
schema, no `package.json`, no source files, no tests, and no database. The "three-layer context
spine basic structure" the task refers to currently exists only as prose in the overview document;
this research maps what that document prescribes and what scaffolding is already in place to build
it.

## Entry Points
- [Three-Layer-Context-Spine-Overview.md](Three-Layer-Context-Spine-Overview.md) — the design spec.
  The three-layer model is defined at [lines 41–45](Three-Layer-Context-Spine-Overview.md#L41-L45)
  (the L1/L2/L3 table) and the record shape at
  [lines 67–80](Three-Layer-Context-Spine-Overview.md#L67-L80).
- [.claude/commands/research.md](.claude/commands/research.md) — the `/research` workflow that
  produced this document.
- [.claude/commands/plan.md](.claude/commands/plan.md) — `/plan`, the next step the overview's
  build order points to.
- [.claude/commands/implement.md](.claude/commands/implement.md) — `/implement`.
- [CLAUDE-md-sections.md](CLAUDE-md-sections.md) — the two CLAUDE.md sections meant to be pasted
  into a target repo's `CLAUDE.md` (this repo has **no `CLAUDE.md` yet**).

## Key Files
Every non-`.git` file in the repo, annotated:

- [Three-Layer-Context-Spine-Overview.md](Three-Layer-Context-Spine-Overview.md) (159 lines) — the
  authoritative design doc. Sections: (1) the problem — context loss across the trades relay
  customer → CSR → manager → technician → office → sales
  ([lines 10–25](Three-Layer-Context-Spine-Overview.md#L10-L25)); (2) goals
  ([27–34](Three-Layer-Context-Spine-Overview.md#L27-L34)); (3) the three-layer model
  ([36–85](Three-Layer-Context-Spine-Overview.md#L36-L85)); (4) input channels
  ([87–123](Three-Layer-Context-Spine-Overview.md#L87-L123)); (5) hardcoded-vs-AI build rule
  ([125–144](Three-Layer-Context-Spine-Overview.md#L125-L144)); (6) build order
  ([146–158](Three-Layer-Context-Spine-Overview.md#L146-L158)). Implementation-agnostic by design
  ([lines 5–6](Three-Layer-Context-Spine-Overview.md#L5-L6)).
- [README.md](README.md) (61 lines) — describes the repo *as a portable RPI workflow export* ("de-
  projectified copy … ready to drop into a different Node/JS or TS repository",
  [lines 1–6](README.md#L1-L6)). Its "What's here" tree
  ([9–21](README.md#L9-L21)) still describes a `workflow-export/`-style layout. Install steps at
  [24–45](README.md#L24-L45); deliberate TODOs (no live verification wired) at
  [47–53](README.md#L47-L53).
- [CLAUDE-md-sections.md](CLAUDE-md-sections.md) (48 lines) — two ready-to-paste CLAUDE.md sections:
  a **Verification** gate block ([lines 11–28](CLAUDE-md-sections.md#L11-L28), commands
  `npx tsc --noEmit` / `npm run lint` / `npm test` / `npm run build`) and a **Development workflow
  (RPI)** section ([30–48](CLAUDE-md-sections.md#L30-L48)). These are templates — gate commands are
  flagged as needing adjustment to the target repo ([lines 6–7](CLAUDE-md-sections.md#L6-L7)).
- [.claude/commands/research.md](.claude/commands/research.md) (77 lines) — `/research`: read-only
  documentation agent; writes to `thoughts/shared/research/`; output template at
  [lines 38–66](.claude/commands/research.md#L38-L66).
- [.claude/commands/plan.md](.claude/commands/plan.md) (102 lines) — `/plan`: produces a phased plan
  (2–5 phases, each ~1h and independently verifiable, [lines 21–25](.claude/commands/plan.md#L21-L25));
  writes to `thoughts/shared/plans/`; includes an adversarial fresh-context review step
  ([line 28](.claude/commands/plan.md#L28)) and a 250-line cap ([line 101](.claude/commands/plan.md#L101)).
- [.claude/commands/implement.md](.claude/commands/implement.md) (40 lines) — `/implement`: executes
  an approved plan phase-by-phase with per-phase automated + live + adversarial-review loops
  ([lines 17–25](.claude/commands/implement.md#L17-L25)) and a final `/code-review` gate
  ([line 29](.claude/commands/implement.md#L29)).
- [.claude/skills/verifying-behavior/SKILL.md](.claude/skills/verifying-behavior/SKILL.md) (90 lines)
  — the behavior-verification doctrine: test-env safety (§1), maker≠checker subagent recipe (§2),
  three-bucket triage (§3), missing-capability rule (§4). Explicitly states **no live test
  environment is wired** ([lines 15–17](.claude/skills/verifying-behavior/SKILL.md#L15-L17),
  §5 [66–73](.claude/skills/verifying-behavior/SKILL.md#L66-L73)).
- [.claude/settings.json](.claude/settings.json) (38 lines) — Claude Code permissions allow-list
  ([lines 3–22](.claude/settings.json#L3-L22), read-only git / ls / find / grep / npm / tsc /
  localhost curl) and a single `PostToolUse` hook ([24–37](.claude/settings.json#L24-L37)) that runs
  `node --check` on edited `.js/.mjs/.cjs` files.
- `thoughts/shared/research/.gitkeep`, `thoughts/shared/plans/.gitkeep` — empty placeholder
  directories where `/research` and `/plan` write their artifacts. This document is the first real
  file written into `thoughts/shared/research/`.

## Data Flows
There is **no runtime data flow in the repo** — no code executes, nothing reads or writes a
database. Two flows are relevant instead:

1. **The prescribed data model (design-time, from the overview).** The write-path the overview
   mandates is a uniform two-step pattern for *every* input channel
   ([lines 87–123](Three-Layer-Context-Spine-Overview.md#L87-L123)):
   - **Step 1 — land verbatim in L1.** Each input event becomes one append-only `raw_captures` row:
     `raw_text` for transcripts/notes, or a blob pointer for audio/photos
     ([lines 43](Three-Layer-Context-Spine-Overview.md#L43),
     [72–74](Three-Layer-Context-Spine-Overview.md#L72-L74)).
   - **Step 2 — extract structured fields into L2/L3**, keeping a link back to the L1 row
     ("evidence always linked", [line 123](Three-Layer-Context-Spine-Overview.md#L123)).
   - **Entity shape:** `customers ──(1:N)── jobs ──(1:N)── visits`
     ([line 68](Three-Layer-Context-Spine-Overview.md#L68)); each L2 table carries an `attributes`
     JSON column = L3 ([lines 45](Three-Layer-Context-Spine-Overview.md#L45),
     [70](Three-Layer-Context-Spine-Overview.md#L70)); each `raw_captures` row links back to the
     customer/job/visit it informed ([lines 72–74](Three-Layer-Context-Spine-Overview.md#L72-L74)).
   - **Job `status` is a state machine**, not a boolean: `open → in_progress → completed →
     invoiced → paid` plus `cancelled`/`declined`; the authoritative "done" is a downstream business
     event (invoice paid), not the technician
     ([lines 82–85](Three-Layer-Context-Spine-Overview.md#L82-L85)).
   - **Channels** that feed Step 1: technician voice notes / photos / typed notes (and technician-
     as-lead-source); front-door intake (calls→transcribed, web forms, SMS, email, chat); office
     (AI assistant, manual corrections — themselves captured as L1 to preserve edit history); sales
     notes and quote outcomes; integrations (CRM import, accounting "invoice paid", IoT)
     ([lines 94–122](Three-Layer-Context-Spine-Overview.md#L94-L122)).
   - **Read/synthesis** (briefings, customer memory) is explicitly *downstream* — only possible once
     the spine exists and is populated ([lines 150–154](Three-Layer-Context-Spine-Overview.md#L150-L154)).

2. **The workflow artifact flow (the meta-process for building the above).**
   `/research` → writes `thoughts/shared/research/*.md` → `/plan` reads that → writes
   `thoughts/shared/plans/*.md` → human approves → `/implement` executes the plan phase-by-phase.
   The plan, not the code diff, is the human-review gate
   ([CLAUDE-md-sections.md lines 41–42](CLAUDE-md-sections.md#L41-L42)).

## External Dependencies
- **None are installed or referenced in code** — no `package.json`, no lockfile, no imports.
- The scaffolding *assumes* a Node/TS target: the README suggests Vitest
  ([README.md lines 31–40](README.md#L31-L40)); the verification gates assume `tsc`/`npm`
  ([CLAUDE-md-sections.md lines 16–21](CLAUDE-md-sections.md#L16-L21)); the `PostToolUse` hook
  shells out to `node --check` and `jq` ([.claude/settings.json line 31](.claude/settings.json#L31)).
- The overview names *categories* of future external systems but binds to none (explicitly
  implementation-agnostic, [lines 5–6](Three-Layer-Context-Spine-Overview.md#L5-L6)): a
  blob/object store for L1 audio/images; a relational DB (Postgres given as an example,
  [line 44](Three-Layer-Context-Spine-Overview.md#L44)) for L2; telephony + speech-to-text for the
  call channel ([lines 104–105](Three-Layer-Context-Spine-Overview.md#L104-L105)); an LLM for
  extraction/summarization ([lines 132–134](Three-Layer-Context-Spine-Overview.md#L132-L134)); and
  CRM / accounting / IoT integrations ([lines 118–122](Three-Layer-Context-Spine-Overview.md#L118-L122)).
- `verifying-behavior` §5 confirms **no MCP servers, browser, or test DB are wired**
  ([SKILL.md lines 66–73](.claude/skills/verifying-behavior/SKILL.md#L66-L73)).

## Constraints and Invariants
Stated by the design (these are the rules a future implementation is expected to hold):
- **L1 is append-only and lossless** — the verbatim original is preserved so extraction can be
  re-run later with a better model, zero data loss
  ([lines 43](Three-Layer-Context-Spine-Overview.md#L43),
  [55–59](Three-Layer-Context-Spine-Overview.md#L55-L59)).
- **Provenance is mandatory** — every structured (L2) field links back to the raw (L1) evidence it
  came from ([lines 50–52](Three-Layer-Context-Spine-Overview.md#L50-L52),
  [123](Three-Layer-Context-Spine-Overview.md#L123)).
- **Layer-assignment rule** — structure in L2 *only* what must be acted on deterministically;
  everything else stays verbatim in L1; the in-between long tail goes in the L3 `attributes` JSON,
  so neither the schema sprawls nor facts get dropped
  ([lines 47–52](Three-Layer-Context-Spine-Overview.md#L47-L52),
  [60–63](Three-Layer-Context-Spine-Overview.md#L60-L63)).
- **Hardcode vs. AI split** — schema, identity matching, permission boundaries, pricing math,
  telephony, notifications are *code*; extraction, summarization, narrative drafting, Q&A are *AI*
  ([lines 130–138](Three-Layer-Context-Spine-Overview.md#L130-L138)). **Identity matching** (does an
  incoming capture belong to an existing customer/job or a new one?) is singled out as hardcoded-and-
  tested, never the model's guess ([lines 140–144](Three-Layer-Context-Spine-Overview.md#L140-L144)).
- **Build order is fixed** — schema + read/write access first; then one write-path (technician
  capture, the simplest) end-to-end; then read/synthesis; then more channels and richer job flows.
  "Start narrow — one channel, one tenant, the schema in version control — and widen deliberately."
  ([lines 146–158](Three-Layer-Context-Spine-Overview.md#L146-L158)).
- **Multi-tenancy is implied** — "one tenant" first ([line 158](Three-Layer-Context-Spine-Overview.md#L158))
  and per-customer-firm scoping, but no tenant model is specified.

Repo-state constraints (facts about the repo today):
- **No `CLAUDE.md` exists**, yet `implement.md` and the plan's review prompt point at "CLAUDE.md's
  Conventions section" ([implement.md line 38](.claude/commands/implement.md#L38)) and the
  Verification gates ([plan.md line 63](.claude/commands/plan.md#L63)). Those references are
  currently dangling.
- **The verification gates can't run** — there is no `package.json`, so `npx tsc`, `npm run lint`,
  `npm test`, `npm run build` ([CLAUDE-md-sections.md lines 16–21](CLAUDE-md-sections.md#L16-L21))
  all have nothing to execute against yet.
- **Live/behavior verification is blocked by design until tooling is wired** — `verifying-behavior`
  §4 missing-capability rule applies; bucket-2 live E2E checks are off the table for now
  ([SKILL.md lines 15–17](.claude/skills/verifying-behavior/SKILL.md#L15-L17)).
- **Working tree is mid-reorganization** (git status): the tracked `workflow-export/` subtree is
  staged as deleted and an untracked copy of the same files now sits at the repo root (`.claude/`,
  `README.md`, `CLAUDE-md-sections.md`, `thoughts/`). The export was "promoted" from a subfolder to
  the repo root but not yet committed.

## Open Questions
- **Database / storage choice is unmade.** The overview is deliberately agnostic
  ([lines 5–6](Three-Layer-Context-Spine-Overview.md#L5-L6)); Postgres + an object store are only
  examples. The "basic structure" can't be scaffolded as a concrete schema until L2's relational
  store and L1's blob store are chosen.
- **Language/runtime for the spine itself.** All scaffolding assumes Node/TS, but the overview never
  commits to one for the application — only the workflow tooling does. Unverifiable from files alone.
- **`raw_captures` linkage shape.** The overview says each raw row "links back to the customer / job
  / visit it informed" ([lines 72–74](Three-Layer-Context-Spine-Overview.md#L72-L74)) but does not
  specify whether that's one nullable FK per entity, a polymorphic (entity_type, entity_id) pair, or
  a join table. Open until the schema is designed.
- **Tenant model.** "One tenant" first ([line 158](Three-Layer-Context-Spine-Overview.md#L158)) but
  no tenant table, tenant-scoping column, or isolation strategy is described.
- **Identity-matching algorithm.** Called out as critical and hardcoded
  ([lines 140–144](Three-Layer-Context-Spine-Overview.md#L140-L144)) but the matching keys (phone?
  address? name fuzzy-match?) and tie-break rules are unspecified.
- **Is `workflow-export/` deletion intended?** The git status shows it staged for deletion with an
  untracked root-level copy; whether this reorganization is final, and whether a real `CLAUDE.md` /
  `package.json` are meant to be added next, cannot be determined from the files alone.
