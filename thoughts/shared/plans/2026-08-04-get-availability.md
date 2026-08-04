---
date: 2026-08-04
task: get_availability — expose the stored weekly working pattern, the one write with no read
research: (inline; live evidence from s2 trajectory bcaee91a, 2026-08-04 12:48 PDT)
status: implemented
---

## Overview

`set_availability` writes a technician's weekly working pattern. **Nothing reads it back.** The
pattern sits in `technicians.availability` (JSONB) and the only tool that mentions it,
`list_team`, exposes exactly one bit:

```ts
availabilityConfigured: t.availability !== null   // src/mcp/server.ts, case 'list_team'
```

A manager can therefore learn *that* Joy has a pattern and never *what it is*.

This plan adds `get_availability`: a manager-tier read returning the stored pattern, plus the
time off that overrides it. It is the missing counterpart to `set_availability`, nothing more.

## Why now — live evidence

On 2026-08-04 at 12:48 PDT a manager asked s2 *"what are the availabilities of joy"*. The turn
took **106.5 seconds** and 14 tool calls (trajectory `bcaee91a`):

```
 5.7s  tool_search  "technician availability schedule"
13.5s  tool_search  "list team members availability"
20.6s  tool_describe list_team
22.7s  tool_call     list_team              -> availabilityConfigured: true   (and nothing more)
27.0s  tool_describe set_availability       -> a WRITE tool; dead end
38.2s  tool_search  "get availability pattern technician"
49.0s  tool_search  "get availability working pattern read"
56.0s  tool_describe get_team_schedule
58.0s  tool_call     get_team_schedule {}   -> empty args, wasted
68.9s  tool_call     get_team_schedule {from,to}
```

Four separate searches, then a fallback to the schedule read. The follow-up — *"no like in
general for the week, what is joy's availability"* — is the disambiguation that sets this plan's
scope: the manager wanted **the working pattern**, not a free/busy calendar.

(Tool search is reverted as of the same day and is not the subject here; it made this turn slow,
but a correctly-answered fast turn was never available — no tool could answer.)

## Decisions

### 1. Configuration, NOT free/busy — `find_slots` stays the only scheduling oracle

"Availability" has two readings:

| reading | meaning | who owns it |
|---|---|---|
| **(a) configuration** | "Joy works Mon–Fri 8–5, off Aug 12–14" | **this plan** |
| (b) bookability | "Joy has 2–4pm free Tuesday" | `find_slots`, already |

`find_slots`'s own description says it *"is the ONLY source of scheduling truth: NEVER judge fit,
availability, or drive time yourself — call it and relay its verdict."* Returning free/busy here
would create a second oracle that can disagree with the first, on the exact question where
disagreement is most expensive. So `get_availability` returns what is *configured*, states that
plainly, and points at `find_slots` for what is *bookable*.

This also matches what the manager actually asked for ("in general for the week").

### 2. Manager tier, mirroring the write

`set_availability` is in `ADMIN_TOOLS`. `get_availability` goes in the same list. A technician
self-read ("when am I working?") is a reasonable future ask, but it needs the ref to come from
the verified HMAC identity rather than the argument, and technicians already have `get_schedule`
for their actual day. Out of scope; note it and move on.

### 3. `ref` optional — omitted means the whole active roster

One query either way. "What is Joy's availability?" and "who works Saturdays?" are the same
read. Omitting `ref` returns every active team member's pattern.

### 4. Both raw and rendered

Return the raw `pattern` object (so the agent can reason about it and pass it back to
`set_availability` for an edit) **and** a `summary` string per person, pre-rendered firm-side:

```
"Mon–Fri 08:00–17:00; Sat, Sun off"
```

Rendering server-side is deliberate, and follows the `resolve_date` lesson recorded in
`src/mcp/server.ts`: description-only wording is too weak for the live model. A pre-rendered
line is what the agent will relay; a seven-key JSON object is what it will paraphrase wrongly.

### 5. Time off included; horizon not

Time off directly overrides the pattern — "she works Tuesdays, but she's off next Tuesday" is the
same question. Included for a bounded window (default: today → +30 days, firm-local).

`technician_horizon_days` lives on `tenants`, not per-technician, and is a scheduler bound rather
than a statement about when someone works. Excluded.

## Implementation

### Phase 1 — db accessor — NOT NEEDED (simplification found during implementation)

`listTeam(tenantId)` already does `.select()` (the whole row, `availability` included) and is
already tenant-scoped. No new accessor, no new query shape, no new tenant-filter surface.

### Phase 2 — rendering helper

`src/schedule/availability.ts`: `summarizeWeeklyPattern(p: WeeklyPattern): string`.

- Collapse consecutive days sharing identical windows: `Mon–Fri 08:00–17:00`.
- Multiple windows in a day: `Mon 08:00–12:00, 13:00–17:00`.
- All-empty day list appended as `Sat, Sun off`; no pattern at all → `null` summary and
  `configured: false`.
- Pure function over the stored shape. Unit-tested directly; this is where the bugs will be.

### Phase 3 — tool

`src/mcp/server.ts`: `get_availability` in `TOOLS`-adjacent definition + `ADMIN_TOOLS` membership
+ a `case 'get_availability'` in `dispatch`.

```jsonc
{
  "status": "ok",
  "people": [
    {
      "ref": "manager-joy",
      "displayName": "Joy",
      "tier": "manager",
      "state": "active",
      "configured": true,
      "summary": "Mon–Fri 08:00–17:00; Sat, Sun off",
      "pattern": { "mon": [["08:00","17:00"]], "...": [] },
      "timeOff": [{ "startsOn": "2026-08-12", "endsOn": "2026-08-14", "reason": "vacation" }]
    }
  ],
  "note": "This is the configured working pattern, not free/busy. For what is actually bookable, use find_slots."
}
```

`now` rides along free — the dispatch seam adds it to every object result.

The `note` is fused into the result rather than left to the description, same reasoning as
decision 4.

### Phase 4 — tests

`src/mcp/server.test.ts`:
- one person by `ref`; whole roster when omitted
- `configured: false` when `availability` is null (must NOT be an error — an unconfigured person
  is the normal pre-setup state, and `set_availability`'s description calls it out as the step
  that makes someone schedulable)
- time off inside the window included, outside excluded
- **2-tenant leak test** — tenant A's manager must never see tenant B's roster (checklist Tier 2)
- unknown `ref` → a clear "no such person" rather than an empty success

`src/schedule/availability.test.ts`: `summarizeWeeklyPattern` — day collapsing, split windows,
all-off, `24:00` end, single day.

## Out of scope / noted

- **Technician self-read.** Needs identity from the verified header, not the arg.
- **`listTimeOffForTechnician` has no tenant filter** (`src/db/timeOff.ts:53`) — unlike
  `deleteTimeOff(id, tenantId)`. All 5 production callers resolve the technician tenant-scoped
  first, so it is defended by construction but not structurally. Worth a follow-up; changing the
  signature touches 5 call sites and is not this plan's job.
- Free/busy. See decision 1.

## Verification

`npm run typecheck`, `npm run lint`, `npm test`, `npm run build`. Then the live check: ask s2
*"what are the availabilities of joy"* and confirm one `get_availability` call answers it.

Rollout: deploy (tool descriptions are cached per MCP process) + `gateway restart` on each
sandbox so the new tool appears in `tools/list`.

## Implementation notes (2026-08-04)

- **Phase 1 dropped**: `listTeam(tenantId)` already returns the full row. No new DB code.
- **Manager surface 39 → 40.** Two `toHaveLength(39)` assertions in `src/mcp/server.test.ts`
  (1735, 2138) and three doc claims (`docs/onboarding.md` ×2, `docs/nemoclaw-tech-agent.md`)
  updated. The technician surface is unchanged at 14.
- **Test pollution, caught by the suite.** The first version left `avail-set` behind: seat-exempt
  rows start ACTIVE, and giving one a Mon–Fri pattern makes it a *schedulable candidate*, so it
  joined the roster every later scheduling test solves over — breaking `run_freeze`, the
  offboarding lifecycle test and `send_email`. The fixture now cleans up in a `finally` (time off
  first — FK). Worth remembering: in this suite an active technician with a pattern is not an
  inert fixture.
- Gates: typecheck / build / `npm test` pass — 906 passing, and the only 3 failures are the
  pre-existing cost-dashboard ones on `main` (`src/db/costs.test.ts`, `src/admin/adminApi.test.ts`),
  untouched by this change. `npm run lint` is blocked by the pre-existing nested-worktree
  `tsconfigRootDir` collision (272 identical parse errors, zero rule violations).
