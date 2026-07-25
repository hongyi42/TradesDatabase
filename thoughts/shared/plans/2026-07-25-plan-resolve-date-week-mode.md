---
date: 2026-07-25
task: resolve_date week mode — server-resolved week RANGES with Sat/Sun boundary ambiguity surfaced
research: none (trajectory-diagnosed live bite, evidence in docs/engineering-memory.md §Deferred and the 2026-07-25 session)
status: draft
---

## Overview

On Saturday 2026-07-25 the pilot manager said "Cancel Tom for next week's visit" and the agent
missed a real confirmed Monday-Jul-27 visit. The session trajectory shows the agent did
everything right: it refused to do calendar math, called `resolve_date(monday/sunday,
weeksAhead:1)`, and got Aug 3–9 — correct by the tool's occurrence-anchored semantics, but not
what a human means by "next week" on a Saturday (the week starting in 2 days). Because the tool
can only resolve single days, the agent then hand-rolled a second window (Jul 28–Aug 2 — a
Tuesday start) and both windows excluded Jul 27. Even its clarifying question offered two wrong
week-starts.

This plan gives `resolve_date` a **week mode**: "this week" / "next week" resolves server-side
to a calendar-anchored `{weekStart, weekEnd}` range, and on a Saturday or Sunday the result is
flagged ambiguous and carries BOTH candidate ranges plus an instruction to ask — so the agent's
clarifying question contains the right options. No new tool (surface stays 35), no migration,
no AGENTS.md change.

## Decisions

- **Extend `resolve_date` vs a new tool** — extend. One date authority; a second date tool
  reintroduces "which one do I call". The description change requires fleet gateway restarts at
  rollout either way.
- **Calendar-anchored weeks, Monday start** — `weekStart` = the Monday on/before today, plus
  `7 × week`. This is the colloquial reading: from Sat Jul 25, `week:1` → Mon Jul 27 – Sun
  Aug 2 (exactly what the pilot manager meant). The existing weekday+`weeksAhead` mode stays
  occurrence-anchored and untouched — the two anchorings serve different phrases, and the
  divergence is now confined inside the server where it's documented, not improvised by the
  model.
- **Ambiguity = today is Saturday or Sunday, any `week` value** — flagged, not refused: the
  result still resolves to the calendar reading (primary), with `alternate` = the same range
  +7 days. Weekend speakers split between "the imminent Mon–Sun" and "the one after"; mid-week
  speakers don't. Refusing outright would break the common unambiguous case; resolving silently
  re-creates this bug — flag-and-ask is the recorded fix shape.
- **The ask-behavior rides in the RESULT, not AGENTS.md** — the ambiguous result carries a
  `note` telling the agent to present both ranges and ask. Mechanism over prompt (the PR #59
  lesson: descriptions and standing instructions don't steer GLM reliably; result-embedded
  directives do). Deliberately NO §0f edit: that block is append-once (same drift class as the
  accuracy block found 2026-07-25), and its phrase list already names "next week" as a
  resolve_date trigger — which becomes true once this ships.
- **`week` is mutually exclusive with `weekday`/`dayShift`/`explicitDate`** — same
  exactly-one-mode contract the resolver already enforces; `weeksAhead` stays weekday-only.
- **Bound `week` to 0..52** — mirrors `MAX_WEEKS_AHEAD`; past weeks need explicit dates, same
  as the existing rule for past references.

## Plain-language walkthrough

**Phase 1 — teach the server what a week is.** Today the date tool can only answer "what date
is Friday?" — one day at a time. So when a manager says "next week", the AI has to glue two
day-answers together into a week and gets the gluing wrong (that's how the Monday visit was
missed). This phase adds a direct question: "what is next week?" — and the server answers with
the full range, start and end. On weekends, where "next week" honestly means two different
things to different people, the server says so and hands back both candidate ranges, so the AI
asks you "did you mean the week starting Mon the 27th, or Mon the 3rd?" — the right two
options, computed by the server, not the model. You'd notice it working because a weekend
"next week" question comes back as a sensible clarifying question instead of a wrong answer.

```
  "Cancel Tom for next week's visit"        (asked on a Saturday)
        │
        ▼
  agent calls resolve_date { week: 1 }
        │
        ▼
  server: primary  = Mon Jul 27 – Sun Aug 2   ← calendar reading (the common meaning)
          alternate= Mon Aug 3  – Sun Aug 9   ← the "week after the weekend" reading
          boundaryAmbiguous: true + note "ask which"
        │
        ▼
  agent asks with BOTH correct ranges → manager picks → schedule searched with a
  server-computed window → the Jul 27 visit is found
```

**Phase 2 — put it on the pilot and re-run the exact failure.** Deploy, refresh every agent's
cached tool list (gateway restarts), then replay the very message that failed — "Cancel Tom
for next week's visit" on a fresh session — and confirm the agent now surfaces the Monday
Jul 27 visit (or asks with the correct candidate weeks). The original bug becomes the
regression test, at both the unit level and the live level.

## Secrets & env preflight

- **Phase 1:** none (pure function + handler; tests run on the local stack, `already required`).
- **Phase 2:** none new (ssh `tradesbox` + `supabase-test` MCP read-backs, both already in use).

## Phase 1: week mode in the resolver + tool surface

### What this phase does

Adds the `week` parameter end to end: pure arithmetic in `dateResolve.ts`, argument plumbing
and description in `server.ts`, and tests that pin the live-bite fixture.

### Changes required

**`src/schedule/dateResolve.ts`**
- `ResolveDateParams`: add `week?: number` (`0 = the current calendar week, 1 = next, …`).
- `ResolveDateResult`: add a variant —
  ```ts
  | {
      status: 'resolved_week';
      weekStart: string; // Monday, YYYY-MM-DD
      weekEnd: string;   // Sunday, YYYY-MM-DD
      boundaryAmbiguous?: true;              // present only when today is Sat/Sun
      alternate?: { weekStart: string; weekEnd: string }; // ditto
      note?: string;                          // ditto — the ask instruction
    }
  ```
- Mode counting: `week` joins the exactly-one-of set (`modes` array gains a fourth entry);
  `weeksAhead` alongside `week` → unresolvable (`'weeksAhead only applies with a weekday —
  for week ranges use week alone'`).
- **Both mode-refusal strings must name `week`** (review finding 3 — under our own
  result-embedded-text doctrine, a refusal that omits `week` teaches the agent the mode
  doesn't exist, reviving the hand-rolled-window failure): `modes === 0` reason becomes
  `'no day reference given — provide weekday, dayShift, explicitDate, or week'`; `modes > 1`
  becomes `'provide exactly one of explicitDate, weekday, dayShift, or week'`. Safe: the only
  wording pin is `/no day reference/` (dateResolve.test.ts:122), which still matches.
- Arithmetic (new branch before the weekday branch):
  ```ts
  if (p.week !== undefined) {
    if (!Number.isInteger(p.week) || p.week < 0 || p.week > MAX_WEEKS_AHEAD) {
      return { status: 'unresolvable', reason: `week must be a whole number between 0 and ${MAX_WEEKS_AHEAD} (0 = the current week); past references need an explicit date` };
    }
    const todayDow = new Date(`${p.todayLocal}T00:00:00.000Z`).getUTCDay();
    const daysSinceMonday = (todayDow + 6) % 7;         // Mon=0 … Sun=6
    const weekStart = addDays(p.todayLocal, -daysSinceMonday + p.week * 7);
    const weekEnd = addDays(weekStart, 6);
    if (todayDow === 6 || todayDow === 0) {             // Saturday or Sunday
      const altStart = addDays(weekStart, 7);
      return {
        status: 'resolved_week', weekStart, weekEnd,
        boundaryAmbiguous: true,
        alternate: { weekStart: altStart, weekEnd: addDays(altStart, 6) },
        note: 'On a weekend, "this/next week" is ambiguous. Present BOTH ranges (with dates) and ask which the person means before acting.',
      };
    }
    return { status: 'resolved_week', weekStart, weekEnd };
  }
  ```

**`src/mcp/server.ts`**
- Handler (`case 'resolve_date'`, :1680): pass `week` through via the existing `intArg`
  helper — `...(intArg('week') !== undefined ? { week: intArg('week') } : {})`.
- Tool `inputSchema` (:268): add
  `week: { type: 'integer', description: '"this week" = 0, "next week" = 1, "the week after next" = 2. A week RANGE (Mon–Sun); use ALONE, without weekday/dayShift/explicitDate.' }`.
- Tool `description` (:257): append one sentence: `'For week RANGES ("this week", "next
  week") pass week alone — you get back {weekStart, weekEnd}; on weekends the result is
  flagged ambiguous with an alternate range — relay both and ask, never pick.'` Keep the
  existing text intact (the "next <weekday>" both-and-ask rule still governs weekday phrases).

**`src/schedule/dateResolve.test.ts`**
- **Amend the `resolved()` helper first (review finding 1 — without this, Phase 1 fails
  `typecheck` in this very file):** at :13 it throws with `r.reason` after narrowing on
  `status !== 'resolved'`; once the union gains `resolved_week` (no `reason` field) that's a
  TS2339. Change the throw to `JSON.stringify(r)` (or narrow on `status === 'unresolvable'`),
  and add a sibling `resolvedWeek()` helper for the new tests.
- Mid-week anchor: today Wed 2026-07-22 → `week:0` = Jul 20–26, `week:1` = Jul 27–Aug 2, no
  `boundaryAmbiguous` key.
- **The live-bite regression**: today Sat 2026-07-25, `week:1` → weekStart 2026-07-27 /
  weekEnd 2026-08-02, `boundaryAmbiguous: true`, alternate Aug 3–9, note present. (This
  fixture IS the Tom Nguyen miss — the primary range contains Jul 27.)
- Sunday case: today Sun 2026-07-26, `week:1` → Jul 27–Aug 2 + ambiguous.
- Saturday `week:0` → Jul 20–26 + ambiguous with alternate Jul 27–Aug 2.
- Validation: `week` + `weekday` → unresolvable (exactly-one rule); `week:-1` and `week:53`
  → unresolvable; `weeksAhead` without weekday still unresolvable (existing pin, untouched).
- weekEnd is always weekStart+6 and a Sunday — assert via
  `new Date(\`${weekEnd}T00:00:00.000Z\`).getUTCDay() === 0` (review finding 4:
  `weekdayNameOf` is module-private; do NOT export it for a test — server.test.ts:184 already
  uses the getUTCDay pattern).

**`src/mcp/server.test.ts`**
- Tool-level: `call('resolve_date', { week: '1' })` (quoted — pins intArg coercion) returns
  `status:'resolved_week'` with `today` and `timezone` riding along, same as the day modes.
- Description pin: a NEW check (review finding 2 — no existing test reads tool descriptions,
  so there is no pattern to mirror; write it fresh): from the tools list, `find(t => t.name
  === 'resolve_date')` and assert its `description` contains `week` and `weekStart` — the
  contract that the fleet's cached tools/list teaches the mode after the rollout restart.

### Automated verification

- [x] `npm run typecheck` passes (2026-07-25, clean)
- [x] `npm run lint` passes (clean)
- [x] `npm test` passes — **656 passed | 5 skipped** (baseline 646 + 10 new; both
      35-tool pins untouched)
- [x] the new dateResolve week tests + the server-level week test pass (the live-bite
      regression fixture asserts weekStart 2026-07-27 from Sat 2026-07-25)
- [x] `npm run build` passes (clean)
- Adversarial review (fresh context, commit 95401eb): **NO FINDINGS** — all four folded
      plan-review findings verified in; arithmetic machine-re-verified incl. a 7-day sweep
      showing the ambiguity branch fires on exactly getUTCDay 0 and 6; new server test
      shown flake-free on any run day.

### Live verification (agent-executable)

None in this phase — the branch isn't deployed; behavior checks are Phase 2's.

### Manual verification

None.

---
*No Manual items — continue straight to Phase 2 once the user merges + deploys.*

## Phase 2: rollout + replay the original failure

### What this phase does

Ships the changed tool description to the fleet and closes the loop on the exact live failure
that motivated the plan.

### Changes required

None in-repo (rollout + evidence only; check the boxes below into this plan file).

- Deploy the merged main to Render (user action — Manual Deploy → "Deploy latest commit",
  never "Redeploy").
- Fleet gateway restarts, enumerated FROM the box (`nemoclaw list`, then per-sandbox
  `channels status` for bindings) — the gateway caches `tools/list`, so the new `week`
  parameter is invisible to live chat until restart. No wire run needed (no AGENTS.md change
  — a deliberate Decision above).

### Automated verification

- [x] deploy freshness: served `/board/static/board.js` byte-identical to main (`cmp` exit 0,
      2026-07-25 post-#82-deploy). Fleet: enumerated from the box (s2/s3/s5/s7/s8 live-bound,
      s6 parked), all five gateways restarted "✓ health passed".

### Live verification (agent-executable)

- Prerequisites: ssh `tradesbox`; `supabase-test` MCP for read-backs; s2 reachable via
  `nemoclaw s2 agent --session-id <fresh>` (CLI probes exercise deployed code + real tool
  choice; AGENTS.md-dependent judgments stay with the Telegram device pass).
- [x] Direct tool check — satisfied inside the replay with stronger evidence: the trajectory
      shows `resolve_date {week: 1}` called on a Saturday and BOTH windows the agent then
      searched are the resolved_week result's ranges (primary Jul 27–Aug 2, alternate
      Aug 3–9) — i.e. the ambiguous result was returned and consumed.
- [x] **The replay** (2026-07-25, s2 session `probe-weekmode-replay-1`, verbatim message):
      **PASS — better than the minimum bar.** Reply: "I found a visit for **Tom Nguyen** on
      **Monday, July 27th** (9:00–12:00), assigned to Judy Testing. That's the only Tom visit
      coming up in either possible 'next week'" + the which-kind-of-cancel question. The
      previously-invisible visit is FOUND outright. Trajectory (tool-call list): find_customer
      → `resolve_date {week: 1}` → get_team_schedule 2026-07-27..2026-08-02 →
      get_team_schedule 2026-08-03..2026-08-09. Zero hand-rolled dates; both windows
      Monday-anchored, server-computed. (Old trajectory for contrast: weeksAhead:1 pair +
      hand-rolled Tue-start window, visit missed.)

### Manual verification

- [ ] (weekend-timing permitting) the same phrase from the manager's real Telegram chat gets a
      clarifying question with two correct Monday-anchored ranges — the Telegram path is the
      doctrine authority, and this is the user-visible shape of the fix.

---
*Pause after Phase 2's checks for the user's Telegram spot-check if the timing lands on a
weekend; otherwise the CLI replay + trajectory evidence close the plan.*
