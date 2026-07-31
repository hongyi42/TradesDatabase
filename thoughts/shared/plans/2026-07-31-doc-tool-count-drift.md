---
date: 2026-07-31
task: Correct the stale manager tool-surface counts (and short enumerations) across four operator docs
research: thoughts/shared/research/2026-07-31-manager-self-route-view.md
status: draft
---

## Overview

Docs-only. Four operator-facing files state the manager tool surface as 34, 35, or 25. The real
number is **39** — `TOOLS` (14) minus `get_schedule` plus `ADMIN_TOOLS` (26) — asserted twice in
the suite ([server.test.ts:1734](src/mcp/server.test.ts#L1734),
[:2137](src/mcp/server.test.ts#L2137)). Pre-existing drift, unrelated to any feature; split out of
the route-deeplink plan so that change stays focused.

The counts are stale **because their adjacent enumerations are short**. Fixing the digit alone
leaves a list that visibly sums to the old number, so each fix adds the missing tool names.

## Decisions

- **Fix enumerations, not just digits** — otherwise the doc contradicts itself on the same line.
- **Authoritative count is the code**, not any doc: `MANAGER_TOOLS` at
  [server.ts:1257](src/mcp/server.ts#L1257). Technician surface is 14 and is correct everywhere.
- **Docs-only diff** — commits to main and pushes directly, per the standing doc-only rule. No PR.

## Plain-language walkthrough

Nothing in the product changes. Four documents that tell an operator "a manager's assistant has
N tools" are out of date because tools kept being added without the docs following. This corrects
the number to 39 in each, and adds the five tools missing from the written-out lists
(`cancel_job`, `set_visit_locks`, `run_freeze`, `run_resolve`, `undo_run`) so the lists and the
numbers agree.

## Secrets & env preflight
- **Phase 1:** none.

---

## Phase 1: correct the counts and enumerations

### What this phase does
Four edits. No source changes.

### Changes required

**`docs/doorman-runbook.md`** [:325-326](docs/doorman-runbook.md#L325-L326)
- **34 → 39**; add the 5 missing to the enumeration: `cancel_job`, `set_visit_locks`,
  `run_freeze`, `run_resolve`, `undo_run`.
- The same line names `cancel_visit`, which is not a tool — renamed `unschedule_visit`
  (2026-07-25). Correct it.

**`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`** [:24](Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md#L24)
- **35 → 39**; add the 4 it lacks: `set_visit_locks`, `run_freeze`, `run_resolve`, `undo_run`
  (it already carries `cancel_job`).
- ⚠ Leave the historical trail ("*Was 26 with resolve_date; 25 from 2026-07-15*") untouched — that
  is deliberate history, not drift.

**`Box_Setup_Stuff/doorman-architecture-memory.md`**
- [:258](Box_Setup_Stuff/doorman-architecture-memory.md#L258) — "**34** for a badge whose ref maps
  to an active manager roster row" → 39.
- [:268](Box_Setup_Stuff/doorman-architecture-memory.md#L268) — "**Manager badge — 35**" → 39, with
  the same 4 additions as the setup guide.
- ⚠ Do **not** touch the `get_schedule` "best stop order" claim on
  [:267](Box_Setup_Stuff/doorman-architecture-memory.md#L267) — that belongs to the route-deeplink
  plan, which is what makes it false.

**`scripts/smoke-http.mjs`** [:90](scripts/smoke-http.mjs#L90)
- Comment "an active-manager ref would list 25" → 39. The assertion (technician = 14) is correct —
  do not change it.

### Automated verification
- [ ] `npm run lint` passes (smoke-http.mjs is linted)
- [ ] `npm test` passes — unchanged; the 39 assertions at
      [server.test.ts:1734](src/mcp/server.test.ts#L1734) / [:2137](src/mcp/server.test.ts#L2137)
      are the source of truth this plan copies from
- [ ] Grep check: no remaining "manager" count other than 39 —
      `grep -rn "manager" docs/ Box_Setup_Stuff/ scripts/ | grep -E "\b(21|25|26|34|35)\b"` returns
      only historical-trail lines

### Live verification (agent-executable)
- None — docs only, no deployed behavior changes.

### Manual verification
- None.

---
*No manual checks — docs-only change, safe to land on main directly.*
