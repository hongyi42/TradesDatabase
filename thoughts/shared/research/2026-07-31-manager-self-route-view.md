---
date: 2026-07-31
branch: fix-agent-tool-latency
commit: 3bff655
topic: Manager self-route view as a mode on get_team_schedule (rather than restoring get_schedule for managers)
---

## Summary

A "route view" answers a different question from a "schedule view". The schedule view says
*which visits exist, for whom, when*. The route view says *in what order should I drive these,
how many minutes of driving is that, and give me one tappable Google Maps link for the whole
day*. Today the spine has both, but they are welded to different audiences: technicians get the
route view (`get_schedule`), managers get the schedule view (`get_team_schedule`) and nothing
else. That split was made deliberately on 2026-07-19 (PR #54, commit `821f205`) after a live
failure — the self-only route view told a manager "your week is completely clear" while an
unassigned visit sat in the tenant — and it is enforced twice over: the tool is filtered out of
the manager's `tools/list`, and a dispatch gate refuses the call even if a stale cache tries it
anyway. The work now under consideration is to give managers the *route* capability back without
giving back the *self-only blind spot*, by making it a mode of the one schedule read they
already have. This document records how both handlers work today, what route machinery is
reusable, where the horizon policy already draws a manager/technician line, and what the
existing code says about the one genuinely open design question: what stops a self-scoped
payload from reading as "you're free" when the tenant has unassigned work.

## Entry Points

| Location | What begins here |
|---|---|
| [src/mcp/server.ts:375-397](src/mcp/server.ts#L375-L397) | `get_schedule` tool definition (description + inputSchema) |
| [src/mcp/server.ts:1996-2106](src/mcp/server.ts#L1996-L2106) | `get_schedule` dispatch case — the route-building body |
| [src/mcp/server.ts:664-698](src/mcp/server.ts#L664-L698) | `get_team_schedule` tool definition |
| [src/mcp/server.ts:2867-3042](src/mcp/server.ts#L2867-L3042) | `get_team_schedule` dispatch case |
| [src/mcp/server.ts:1257](src/mcp/server.ts#L1257) | `MANAGER_TOOLS` — the PR #54 `tools/list` filter |
| [src/mcp/server.ts:1584-1589](src/mcp/server.ts#L1584-L1589) | The inverse dispatch gate (managers calling `get_schedule` get a pointer error) |
| [src/mcp/server.ts:6081-6091](src/mcp/server.ts#L6081-L6091) | `ListToolsRequestSchema` handler — tier-filtered surface |
| [src/mcp/server.ts:6093-6170](src/mcp/server.ts#L6093-L6170) | `CallToolRequestSchema` handler — boardLink + `now` rider decoration seam |
| [src/schedule/boardRead.ts:108](src/schedule/boardRead.ts#L108) | `readBoardDays` — the board's equivalent read, with the closest prior art for a self-scoped manager view |

## Key Files

**[src/mcp/server.ts](src/mcp/server.ts)** (~6180 lines) — the whole MCP tool surface.
Relevant exports/structures:
- `TOOLS` — 14 base (technician) tool definitions, `get_schedule` among them.
- `ADMIN_TOOLS` — 26 manager-only definitions, `get_team_schedule` among them.
- `MANAGER_TOOLS` = `[...TOOLS.filter(t => t.name !== 'get_schedule'), ...ADMIN_TOOLS]` → **39**.
- `ADMIN_TOOL_NAMES` — the `Set` the dispatch tier-gate keys on ([:1248](src/mcp/server.ts#L1248)).
- `BOARD_LINK_TOOL_NAMES` ([:1266-1290](src/mcp/server.ts#L1266-L1290)) — the set whose results get `boardLink`/`boardNote`; contains **both** `get_schedule` and `get_team_schedule`.
- `isActiveManager(identity)` ([:1523](src/mcp/server.ts#L1523)) — one predicate shared by the `tools/list` filter and the dispatch gate, deliberately, "so the two can never disagree about who counts as a manager".
- `dispatch(name, args, deps)` ([:1528](src/mcp/server.ts#L1528)) — one roster read gates every call; `activeManager` computed once at [:1552](src/mcp/server.ts#L1552).

**[src/routes/daySource.ts](src/routes/daySource.ts)** (93 lines) — `listDayStops(tenantId, technicianRef, fromDate, toDate): Promise<DayStops[]>`. Reads confirmed `assignments` for ONE technician, groups by UTC calendar day, sorts stops by time. Returns `[]` (never throws) when the ref has no roster row. Composes typed `src/db/` queries only.

**[src/routes/googleRoutes.ts](src/routes/googleRoutes.ts)** (133 lines) — `optimizeStopOrder(stops, deps)`. Calls Google Routes `computeRoutes` with `optimizeWaypointOrder`. Injectable `ComputeRoutes` transport seam so tests need no key/network. Short-circuits `<3` stops to identity order with `totalMinutes: null`. Throws on non-routable input, `>25` stops, or a non-permutation response.

**[src/routes/deepLink.ts](src/routes/deepLink.ts)** (82 lines) — `buildMapsDeepLink(stops, origin?)` (pure string assembly, caps at 10 link stops, escapes `|`), `formatAddress(parts)`, and the `RouteStop` interface (`label`, `address: string | null`, `scheduledStart?`).

**[src/schedule/policy.ts](src/schedule/policy.ts)** (49 lines) — `DEFAULT_TECHNICIAN_HORIZON_DAYS = 28`, `horizonDaysFor(tenant)`, `clampToTechnicianHorizon(today, from, to, horizonDays)`. Header comment line 6: **"Managers are never clamped."** Line 8-13 records that this module exists because the clamp was once encoded twice (boardRead + the `get_schedule` handler) and could silently diverge.

**[src/schedule/boardRead.ts](src/schedule/boardRead.ts)** — `readBoardDays(input)`. `ReadBoardDaysInput` carries `viewerTechnicianId?: string | null` (the self-filter) and `clampToHorizon?: boolean` (the tier flag) as **two separate inputs**, with an explicit comment at [:100-103](src/schedule/boardRead.ts#L100-L103) that the clamp is "Keyed on TIER by the caller, never on the self-filter — the manager's 'Mine' tab uses viewerTechnicianId too and must keep far weeks."

**[src/telegram/boardApi.ts:206-228](src/telegram/boardApi.ts#L206-L228)** — the board's `GET` day-view route, and the **working precedent for a manager self-scoped schedule view**. It resolves the two concerns independently and in one place:

```ts
const isManager = auth.technician.tier === 'manager';
const mine = url.searchParams.get('view') === 'mine';
const days = await readBoardDays({
  viewerTechnicianId: isManager && !mine ? null : auth.technician.id,  // SELF-SCOPE
  clampToHorizon: !isManager,                                          // TIER
});
json(res, 200, { tier, self: auth.technician.ref, view: isManager && !mine ? 'team' : 'mine', ...days });
```

Three details worth noting: the self-scope and the horizon clamp are **separate inputs** driven by different signals; for a technician the `view` param is a deliberate no-op (they are always self-filtered); and the response **echoes the resolved `view`** "so the page renders what the server actually filtered, not what it asked for".

**[src/mcp/server.test.ts](src/mcp/server.test.ts)** — surface-count assertions and both schedule suites (see Test Coverage below).

## Data Flows

### `get_schedule` (technician route view) — [:1996-2106](src/mcp/server.ts#L1996-L2106)

```
args {from?, to?}
  │
  ├─ type guard: non-string from/to → {status:'invalid_range'}   (:2002)
  │    (the SDK does NOT validate args against inputSchema — str() would
  │     coerce {from:123} to undefined and silently answer about TODAY)
  ├─ getTenant(tenantId) → today = localDateISO(now, tz ?? 'UTC')  (:2013)
  ├─ falsy-default: !from → today ; !to → from   ("" means today)  (:2024)
  ├─ regex YYYY-MM-DD, from <= to, NaN check, span > 14 → invalid_range
  ├─ clampToTechnicianHorizon(today, from, to, horizonDaysFor(tenant))  (:2046)
  │    └─ clamp.beyond → early return {status:'ok', days:[], horizonNote, horizonEnd}
  ├─ listDayStops(tenantId, identity.technicianRef, from, to)      (:2059)
  └─ Promise.all over days (concurrent — a 14-day ask is ONE round-trip's latency):
       ├─ partition: routable (address !== null) vs unroutableStops
       ├─ optimize(routable)  ← deps.optimizeStopOrder ?? liveOptimizeStopOrder
       │     catch → optimizeFailed:true, scheduled order kept, driveMinutes null
       ├─ buildMapsDeepLink(ordered)
       └─ {date, stops, unroutableStops?, driveMinutes, mapsUrl, linkTruncated, optimizeFailed?}
```

Whose schedule is the **badge identity, never an arg** ([:1997-1998](src/mcp/server.ts#L1997-L1998)).

### `get_team_schedule` (manager schedule view) — [:2867-3042](src/mcp/server.ts#L2867-L3042)

```
args {from?, to?, unassignedOnly?}
  │
  ├─ type guards: non-string from/to, non-boolean unassignedOnly → invalid_range
  ├─ unscheduledJobsPromise = unassignedOnly ? readUnscheduledJobs(tenantId) : null  (:2883)
  │     (kicked off FIRST — a recorded final-review efficiency finding)
  ├─ getTenant → technicianHorizonDays = horizonDaysFor(teamTenant)   (:2888)
  │     ⚠ REPORTED ONLY (discovery: "what is the horizon now?") — NO clamp applied
  ├─ !from → firm-local today ; DATE regex on from
  ├─ windowed mode only: toDay = to ?? from, from<=toDay, NaN, span>14
  │     (recall mode has NO upper bound by design — a stray `to` must not error it)
  ├─ scheduleVersion = latestScheduleVersion(tenantId)   BEFORE the snapshot (:2920)
  ├─ rows =
  │    unassignedOnly ? listUnassignedAssignments(tenantId, from)
  │                   : [listAssignmentsForTenant(...'confirmed'),
  │                      listUnplacedAssignedForRange(from, toDay)].flat()   (:2932-2944)
  ├─ listJobsWithCustomerByIds + listTeam → jobById / techById maps
  ├─ per row → bucket by day (start-day clamp; unplaced rows land on earliestDate clamped to from)
  │    stop = {assignmentId, technicianRef, technicianName, unassigned, customer, address,
  │            startTime, endTime, timeTbd?/earliestDate/latestDate, promiseLevel,
  │            promisedDay, locked, status, jobId}
  ├─ days = sorted, each {date, weekday: weekdayLabel(date), stops}
  └─ return unassignedOnly
       ? {status, from, unassignedOnly:true, scheduleVersion, technicianHorizonDays, days,
          unscheduledJobs, note}
       : {status, from, to: toDay, scheduleVersion, technicianHorizonDays, days}
```

Note the per-stop shape carries **`address`** already, but no drive order, no `driveMinutes`,
no `mapsUrl`, and stops are time-ordered within a day, not drive-ordered.

### Result decoration (applies to every tool, after dispatch) — [:6093-6163](src/mcp/server.ts#L6093-L6163)

```
dispatch() result
  │
  ├─ BOARD_LINK_TOOL_NAMES.has(name) → boardMiniAppLink()
  │    ├─ status === 'needs_confirmation' → NOT decorated
  │    │    (exception: run_freeze/run_resolve get proposalLink)
  │    └─ else → + boardLink + boardNote:
  │         "ALWAYS end this reply with the exact line: [See it on the board](url)"
  │       ← the instruction is FUSED INTO THE RESULT, explicitly because
  │         "description-only wording is too weak for the live model" (:6115-6117)
  ├─ object result (not array) → + now: await groundingNow(tenantId)
  │    BEST-EFFORT: a grounding failure must never convert a committed success
  │    into an error (the agent would retry and double-book) — omit instead
  └─ JSON.stringify → {content:[{type:'text', text}]}
```

### Manager identity → a routable `technicianRef`

```
badge → deps.identity {tenantId, technicianRef}
          │
          ├─ getTechnician(tenantId, identity.technicianRef)  (:1545)
          │     ├─ inactive state → throw "deactivated team member"
          │     └─ activeManager = row && tier==='manager' && state==='active'  (:1552)
          └─ listDayStops(tenantId, identity.technicianRef, …) works on the SAME ref
```

An **active manager always has a roster row** — that is what `activeManager` tests. So
`listDayStops` will always find the row for a manager (its `if (!tech) return []` guard is for
badges with no roster row, i.e. the plain-technician surface). Managers are also guaranteed
**not** seat-exempt: `supabase/migrations/20260719120000_seat_exempt_roster.sql:18-19` adds
`constraint no_seat_exempt_managers check (not (seat_exempt and tier = 'manager'))`. A manager
therefore reliably resolves to a routable identity; whether they have any *stops* is a separate
question (a dispatch-only manager has zero assignments and would get `days: []`).

## External Dependencies

- **Google Routes API** — `https://routes.googleapis.com/directions/v2:computeRoutes`, key from `GOOGLE_MAPS_API_KEY`. Billing note in the header: `optimizeWaypointOrder` bills the Compute Routes Pro SKU (5k free calls/month), which is why degenerate days are skipped. Docs: https://developers.google.com/maps/documentation/routes/opt-way
- **Google Maps URLs** — the deep link format, https://developers.google.com/maps/documentation/urls/get-started. Hard cap of 9 waypoints + 1 destination.
- **Supabase/PostgREST** — via the typed `src/db/` layer only.
- **Telegram Mini App** — `boardMiniAppLink()` builds `t.me/<bot>?startapp`, gated on `BOARD_BOT_HANDLE`; unset means links are simply absent (dev/local).
- **`@modelcontextprotocol/sdk`** — `ListToolsRequestSchema` / `CallToolRequestSchema`. Notably: **the SDK does not validate args against `inputSchema`**, which is why every handler hand-guards its arg types (comment at [:1999-2001](src/mcp/server.ts#L1999-L2001)).

## Constraints and Invariants

1. **Managers are never horizon-clamped.** [policy.ts:6](src/schedule/policy.ts#L6). `get_team_schedule` reports `technicianHorizonDays` purely for discovery and never calls `clampToTechnicianHorizon`. Verified by call-site grep: the only non-test clamp callers are `boardRead.ts:138` and the `get_schedule` handler at `server.ts:2046`.
2. **The clamp is keyed on TIER, never on the self-filter.** [boardRead.ts:100-103](src/schedule/boardRead.ts#L100-L103) and [:150-155](src/schedule/boardRead.ts#L150-L155) both record this, the second with the consequence of getting it wrong: "Final-review finding: keyed on the self-filter, the two manager tabs contradicted each other." The board already has a manager self-view (the "Mine" tab) that passes `viewerTechnicianId` while keeping far weeks and keeping the unplaced strip.
3. **Whose schedule = the badge, never an arg.** `get_schedule` takes no technician parameter ([:1997](src/mcp/server.ts#L1997)); a technician can only fetch their own days.
4. **Type-guard every arg by hand.** The SDK does not enforce `inputSchema`. Both handlers reject non-string `from`/`to` before coercion; `get_team_schedule` additionally rejects non-boolean `unassignedOnly`.
5. **`""` means "today".** Truthiness, not `??=` — agents routinely emit empty strings for optional params. A final-review near-regression once turned `""` into `invalid_range`; there is a pinned test for it ([server.test.ts:2365-2370](src/mcp/server.test.ts#L2365-L2370)).
6. **Instructions in tool descriptions do not hold with the live model.** Recorded at [:6115-6117](src/mcp/server.ts#L6115-L6117): the boardNote instruction is fused into the *result* because "description-only wording is too weak for the live model — it skipped the link on plain schedule reads, 2026-07-19". Same lesson recorded for `find_slots` (excluded from board links → the agent *fabricated* a URL to satisfy the doctrine, live 2026-07-21, [:1275-1281](src/mcp/server.ts#L1275-L1281)).
7. **`optimizeStopOrder` must receive routable stops only** and ≤25 of them; it throws otherwise. The `get_schedule` handler partitions first and wraps the call in `try/catch` so "a routing outage must never eat the scheduling answer".
8. **`<3` stops → no API call, `totalMinutes: null`.** Unknown ≠ zero. A single intermediate is also not sent for optimization (the live API returns an undocumented `[-1]` sentinel; observed 2026-07-20).
9. **The `now` rider is best-effort and applies to object results only.** Arrays keep their shape.
10. **Staged (`needs_confirmation`) results are not board-decorated** — staging writes nothing, so the board would show the OLD schedule at the moment precision matters.
11. **Tenant re-check on embedded rows.** `boardRead` re-checks `tenant_id` on every nested job/customer/technician (security review 2026-07-22). `get_team_schedule` gets this for free by building maps from tenant-scoped reads.

## Decision Points

### 1. What scopes the route data — a filtering mode, or a fused field?

The request is "the manager's own stops, drive-ordered, with a maps link". Two shapes exist in
the codebase's own vocabulary:

- **A mode/filter** (`view:'mine'`-style): the payload contains only the manager's stops. This is
  what `get_schedule` does and what `viewerTechnicianId` does in `boardRead`. It is the shape
  that produced the PR #54 failure when the caller was a manager, because the payload no longer
  contains the tenant's unassigned work.
- **A fused per-day field**: the normal team payload, unchanged in scope, plus route information
  attached to the manager's own lane (e.g. a `myRoute` object per day holding `stops` in drive
  order, `driveMinutes`, `mapsUrl`). Nothing is filtered out, so the unassigned stops the team
  view already carries stay in the same payload.

What the code makes cheap either way: `listDayStops` takes a ref and a range and is already
called with `identity.technicianRef`; `optimizeStopOrder` and `buildMapsDeepLink` are pure
functions over a stop list. What differs is whether the *rest* of the team payload survives in
the same response.

### 2. If a filtering mode is chosen, what makes the blind spot structurally impossible?

The repo's recorded position is that tool-description text does not hold (constraint 6 above,
three independent incidents: `endTime` PR #53, `boardNote` PR #59, `resolve_date` "next X").
Mechanisms visible in the current code that carry information the agent cannot skip:

- **A fused instruction string in the result** — the `boardNote` pattern ([:6136](src/mcp/server.ts#L6136)): the payload contains a literal sentence the agent is told to emit verbatim. Already proven on this exact surface.
- **A structured counter/field always present** — e.g. the way `horizonEnd` rides alongside `horizonNote` so "clients branch on data, never by parsing the sentence" ([boardRead.ts:86-88](src/schedule/boardRead.ts#L86-L88)).
- **Keeping the data in the payload at all** — the fused-field option in Decision 1, where there is nothing to omit because nothing was filtered.

### 3. Does the manager route mode clamp to the technician horizon?

Today `get_schedule` clamps unconditionally, and its comment at [:2040-2042](src/mcp/server.ts#L2040-L2042) states the reason: "this tool is technician-only (managers are blocked at dispatch), so no tier test." If route data becomes reachable by a manager, that unconditional clamp is no longer self-justifying.

The board has already crossed this exact bridge and its answer is one line: `clampToHorizon: !isManager` ([boardApi.ts:221](src/telegram/boardApi.ts#L221)), passed **independently** of `viewerTechnicianId`. The consequence of coupling them instead is recorded rather than hypothetical — [boardRead.ts:154-155](src/schedule/boardRead.ts#L154-L155): "keyed on the self-filter, the two manager tabs contradicted each other."

### 4. Rollout: does this change `tools/list`, and therefore need a fleet restart?

Facts:
- `MANAGER_TOOLS` is computed from `TOOLS`/`ADMIN_TOOLS`. Adding a **parameter** to the existing `get_team_schedule` definition does **not** change the tool count (39) and does not add a name to any sandbox tool allowlist (the name `get_team_schedule` is already pinned).
- But `tools/list` returns the full tool definitions, so a new `inputSchema` property and any description change **do** alter the `tools/list` payload. `tools/list` is cached per gateway process (recorded in `MANAGER_TOOLS`' neighbouring comments and in the PR #54 gate rationale at [:1580-1583](src/mcp/server.ts#L1580-L1583): "a stale gateway cache (tools/list is cached per process)").
- This differs from PR #83's grounding riders, which were deploy-only precisely because `tools/list` was unchanged — riders are added at the *result* seam, not the definition.

So the fork is: a **result-only** change (route data always present, no new param) would be deploy-only; a **new-parameter** change would require the box wire re-run + gateway restarts before the agent can pass it.

### 5. Doc counts are currently inconsistent — which is authoritative?

The true count today is **39** (`TOOLS` 14 − `get_schedule` + `ADMIN_TOOLS` 26), asserted twice in tests ([server.test.ts:1734](src/mcp/server.test.ts#L1734), [:2137](src/mcp/server.test.ts#L2137)). The docs disagree with each other:

| Source | Manager count stated | Status |
|---|---|---|
| [src/mcp/server.test.ts:1734](src/mcp/server.test.ts#L1734), [:2137](src/mcp/server.test.ts#L2137) | 39 | matches code |
| [docs/nemoclaw-tech-agent.md:102](docs/nemoclaw-tech-agent.md#L102) | 39 | matches code |
| [Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:24](Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md#L24) | 35 | stale |
| [docs/doorman-runbook.md:322](docs/doorman-runbook.md#L322) | 34 | stale |
| [scripts/smoke-http.mjs:89](scripts/smoke-http.mjs#L89) (comment only) | 25 | stale comment; the assertion itself checks the technician 14 and is correct |

The technician count (14) is consistent everywhere and matches `TOOLS`.

## Test Coverage That Exists to Extend

- **`describe('get_schedule')`** — [server.test.ts:2257-2465](src/mcp/server.test.ts#L2257-L2465). Uses **relative** fixtures `relDay(7)`/`relDay(8)` deliberately, because the technician horizon (default 28) would rot fixed dates; `afterAll` deletes the rows because later suites use fixed 2026-12/2027 dates that today+7 will eventually sweep across (recorded final-review finding).
- **The optimize seam is faked by injection**, not mocking: `stubOptimize` at [:2264-2268](src/mcp/server.test.ts#L2264-L2268) returns a **reversed** order so reordering is observable, with `totalMinutes: 15`. It is passed via `clientFor(identity, { optimizeStopOrder: stubOptimize })` ([:2309-2314](src/mcp/server.test.ts#L2309-L2314)). The seam is declared on `ServerDeps` at [server.ts:207](src/mcp/server.ts#L207) and read at [:2058](src/mcp/server.ts#L2058).
- **`describe('scheduling tools (book/move/unschedule_visit + get_team_schedule)')`** — [server.test.ts:3410](src/mcp/server.test.ts#L3410) onward; covers recall mode, straddling ranges, the 14-day cap, `unassignedOnly` boolean rejection, `technicianHorizonDays` discovery ([:6863-6864](src/mcp/server.test.ts#L6863-L6864)), and the pinned marker reaching the payload ([:5690-5691](src/mcp/server.test.ts#L5690-L5691)).
- **Surface counts** — technician 14 at [:145-167](src/mcp/server.test.ts#L145-L167); manager 39 at [:1734](src/mcp/server.test.ts#L1734) and [:2137](src/mcp/server.test.ts#L2137).
- **The PR #54 gate itself** — [:612-620](src/mcp/server.test.ts#L612-L620): asserts `mgrTools` does not contain `get_schedule`, and that calling it anyway returns `isError` with text containing "technician route view" and "get_team_schedule".
- **`describe('boardLink decoration (chat → board bridge)')`** — [:4407](src/mcp/server.test.ts#L4407).

## Open Questions

1. **Do managers on the pilot actually hold visits?** The whole capability is only exercised by a manager who is also assigned field work. `listDayStops` would return `days: []` for a pure dispatcher. Not answerable by reading code — it needs a look at the pilot tenant's `assignments` for manager-tier rows (read-only query against the hosted pilot DB, which per CLAUDE.md is read-backs only).
2. **Does `optimizeStopOrder` get called more often under a manager mode, and does that matter for the Compute Routes Pro free tier?** The header notes 5k free calls/month. Whether adding a manager caller materially changes call volume depends on (1), and on whether route computation happens on every team read or only when explicitly requested.
3. **Latency.** A recorded live observation (2026-07-19) put one manager schedule question at 84s end-to-end. `get_schedule` optimizes days concurrently via `Promise.all`, but each day is a Google round-trip. Whether attaching route computation to the manager's default read changes perceived latency is a measurement question, not a reading question.
4. **Does the live gateway cache `tools/list` in a way that a description-only edit survives?** Decision Point 4 states the mechanism, but the practical question — whether a given sandbox picks up a changed `inputSchema` without a restart — has a recorded answer of "no" for tool *additions*; it is untested here for a param addition to an existing tool.
5. **Whether the board's "Mine" tab already satisfies the underlying need.** The server side is confirmed (`view=mine`, [boardApi.ts:212](src/telegram/boardApi.ts#L212)) and it returns `BoardStop`s — which carry `address` but **no** drive order, `driveMinutes`, or `mapsUrl` ([boardRead.ts:43-59](src/schedule/boardRead.ts#L43-L59)). So the board's Mine tab shows the manager their own visits but not a route. Whether the *client* renders anything route-like from those stops was not inspected (browser-side code was outside this scope).
