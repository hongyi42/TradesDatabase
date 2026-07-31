---
date: 2026-07-31
task: Per-stop Google Maps links in booked order — drop route optimization from get_schedule, add links to the manager's read
research: thoughts/shared/research/2026-07-31-manager-self-route-view.md
status: draft
---

## Overview

One principle for both schedule reads: **the schedule is already set, so a read renders it — it
never re-orders it.** What a person needs is each stop's address, in order, one tap from
navigation.

Today `get_schedule` (the technician route view) asks Google Routes for the "best driving order"
and returns the day re-sequenced — contradicting the times customers were promised and the order
the board shows. This plan removes that, gives every stop **its own** Maps link, and extends the
same to `get_team_schedule` so a manager who works in the field finally has one.

Deciding order means *moving* visits, which is `run_freeze`/`run_resolve`'s job: they write to the
DB, grade promises, and confirm with the manager. A read must not quietly do it.

## Decisions

- **Reads render, they don't plan** (user, 2026-07-31). Stops come back in booked (time) order.
- **`get_schedule` loses its optimization** (user, 2026-07-31). No Google Routes call;
  `driveMinutes` and `optimizeFailed` go with it. `optimizeStopOrder` itself **stays** —
  [fit.ts:556](src/schedule/fit.ts#L556) uses it for `find_slots` — but the
  `deps.optimizeStopOrder` seam ([server.ts:207](src/mcp/server.ts#L207)) is read only by
  `get_schedule` (verified: single reference) and becomes dead.
- **Per-stop links, not one link per day** (user, 2026-07-31). Each stop carries its own
  `mapsUrl`. Consequences, all simplifications: **no stop cap** (a single-destination URL has no
  waypoint limit, so `linkTruncated`/`MAX_LINK_STOPS` stop mattering here), **no mobile-browser
  3-waypoint caveat** (there are no waypoints), and it matches how field work runs — navigate to
  the next stop, not the whole day at once.
- **`get_schedule`'s `unroutableStops` array is merged back into `stops`.** The split exists only
  because splicing address-less stops into a *drive-ordered* list would misstate the sequence
  ([server.ts:2064-2068](src/mcp/server.ts#L2064-L2068)). In booked order that reason evaporates:
  one chronological list, `mapsUrl: null` where there is no usable address. **This is a visible
  response-shape change to an existing technician tool** — called out so it is a choice, not a
  side effect.
- **`get_team_schedule` gains `mapsUrl` on the caller's own stops only.** Not every team stop —
  that would add a URL per visit per day to every manager read, and token cost on this surface is
  already live concern. Additive: `days[].stops` keeps the whole team plus unassigned stops, so
  the PR #54 blind spot stays structurally impossible.
- **No new parameter.** An earlier draft gated this behind `includeMyRoute`; its only
  justification was API cost, now zero. No parameter → no model guess, no discovery backstop.
- **Rollout: technician profile only.** `get_schedule`'s description advertises the removed fields
  ([server.ts:383-384](src/mcp/server.ts#L383-L384)), so its `tools/list` payload changes and
  gateways (which cache it per process) must restart. **But `get_schedule` is filtered OUT of the
  manager surface** ([server.ts:1257](src/mcp/server.ts#L1257)) and Phase 2 changes no tool
  definition — so the **manager `tools/list` is byte-identical** and Phase 2 is deploy-only (the
  PR #83 case).
- **The agent learns about `mapsUrl` on the manager read from the result**, via a fused
  `routeNote` — the `boardNote` mechanism ([server.ts:6115-6117](src/mcp/server.ts#L6115-L6117)).
  Descriptions have failed three times here (`endTime` #53, `boardNote` #59, `resolve_date`).
- **Windowed mode only** for the manager links; `unassignedOnly` has no times. Skipped silently,
  per [server.ts:2898-2900](src/mcp/server.ts#L2898-L2900).
- **Time-TBD visits get no link** but stay in `stops` — no time, no place in a sequence.
- **Split out:** the manager tool-count doc drift → `2026-07-31-doc-tool-count-drift.md`.
- **Out of scope** — links for another person's stops on the manager read ("give me Ben's route").

## Plain-language walkthrough

**Phase 1 — technicians stop being re-sequenced.** A technician asking for their day can currently
get it back in a different order than the board shows, because the server asks Google to reshuffle
it for driving efficiency — even though customers were already promised times. This deletes that
step. The day comes back in booked order, and every stop carries a tap-to-navigate link. Drive
time disappears, since that was the only thing the Google call bought.

```
BEFORE:  stops ──► Google Routes ──► re-sequenced ──► ONE day link (max 10 stops)
                        ▲ contradicts booked times + board

AFTER:   stops (booked order, one chronological list)
            ├─ 09:00  Smith, 12 Oak St   → mapsUrl
            ├─ 11:30  Jones, 4 Elm Ave   → mapsUrl
            └─ 14:00  Patel, no address  → mapsUrl: null
         no Google call, no cap, no truncation
```

**Phase 2 — managers get the same.** The manager's schedule read already loads every visit for
those days. This adds a link to the ones belonging to the manager. Everything else is untouched —
the team's visits and the unassigned ones stay exactly where they are, so the link can never make
the answer look emptier than it is.

**Phase 3 — docs and getting it live.** Because `get_schedule`'s published description changes,
technician bots won't pick it up on deploy alone: the box wire must be re-run and those gateways
restarted. The manager side goes live on deploy. Then a check on both bot tiers, and a human
tapping a link on a phone.

## Secrets & env preflight

- **Phase 1:** none. This *removes* the only `GOOGLE_MAPS_API_KEY` consumer on this path (the key
  is still needed for `find_slots`). Local Supabase stack up (`npx supabase start`).
- **Phase 2:** none.
- **Phase 3:** `nemoclaw` access to trades-box-1 for the technician wire re-run + gateway restart.
  `BOARD_BOT_HANDLE` — `already required`. Telegram access to s2 (manager) and s5 (Ben).

---

## Phase 1: `get_schedule` returns booked order with per-stop links

### What this phase does
Removes route optimization from the technician day view, merges the unroutable split back into one
time-ordered list, and gives each stop its own Maps link.

### Changes required

**`src/mcp/server.ts`**

1. Tool description [:376-388](src/mcp/server.ts#L376-L388) — remove "in best driving order",
   `driveMinutes`, `optimizeFailed`, and the `unroutableStops` clause. Keep the horizon and
   boardNote clauses verbatim. New shape, roughly:
```
"Your schedule day by day: for each day in [from,to] (YYYY-MM-DD; both optional — default is
today in the firm's timezone; range is capped at 14 days) returns your stops IN THE ORDER THEY
ARE BOOKED. Each stop carries mapsUrl, a Google Maps link that opens directions to THAT stop —
relay it VERBATIM as a tappable link. mapsUrl null = that stop has no usable address on file;
say so rather than guessing. days:[] means no stops in the range — UNLESS the result carries
horizonNote: …"
```

2. Dispatch case [:2058-2096](src/mcp/server.ts#L2058-L2096) — replace the `optimize` lookup and
   the whole `Promise.all` block. Nothing awaits any more, so this becomes synchronous:
```ts
const dayStops = await listDayStops(tenantId, identity.technicianRef, from, to);
const days = dayStops.map((day) => ({
  date: day.date,
  // listDayStops already sorts by time. Booked order in, booked order out —
  // NEVER reordered here: deciding order means MOVING visits, which is
  // run_freeze/run_resolve's job. Address-less stops stay in the one
  // chronological list with a null link (the routable/unroutable split existed
  // only to protect a DRIVE-ordered sequence, which no longer exists).
  stops: day.stops.map((s) => ({
    ...s,
    mapsUrl: s.address === null ? null : buildMapsDeepLink([s]).url,
  })),
}));
```
Then the final return at [:2097-2105](src/mcp/server.ts#L2097-L2105) stays as-is (status/from/to/
days + the horizon spread).

3. Delete the dead seam: the `optimizeStopOrder` field on `ServerDeps`
   [:207](src/mcp/server.ts#L207) and the `liveOptimizeStopOrder` import
   [:107](src/mcp/server.ts#L107) — keep `type ComputeRoutes` on :108, `find_slots` still needs it.
   Leave `src/routes/googleRoutes.ts` and its tests untouched: the function is still live for
   `find_slots` via [fit.ts:556](src/schedule/fit.ts#L556).

**`src/mcp/server.test.ts`** — the `get_schedule` suite [:2257-2464](src/mcp/server.test.ts#L2257-L2464)
- Delete `stubOptimize` [:2264-2268](src/mcp/server.test.ts#L2264-L2268); drop the injection from
  `scheduleClient` [:2309-2314](src/mcp/server.test.ts#L2309-L2314) and
  [:2414](src/mcp/server.test.ts#L2414).
- Rewrite [:2316-2333](src/mcp/server.test.ts#L2316-L2333): assert **booked time order**
  (`G g1-a` before `G g1-b` — the reverse of today's expectation), a per-stop `mapsUrl`, and no
  `driveMinutes` key.
- Rewrite the null-address test [:2335-2350](src/mcp/server.test.ts#L2335-L2350): the address-less
  stop is now **in `stops`** with `mapsUrl: null`, and `unroutableStops` no longer exists.
- Delete the optimize-failure test at **[:2446-2463](src/mcp/server.test.ts#L2446-L2463)** — no
  optimize call is left to fail. ⚠ **Exact range matters:** `:2444` is the closing `});` of the
  *horizon* test (which stays) and `:2445` is blank; deleting 2444-2457 orphans 2458-2463 and
  breaks the file syntactically.
- Keep the defaults/empty-string, invalid-range, and horizon tests unchanged. Verified unaffected
  elsewhere: the grounding-rider test ([:246-282](src/mcp/server.test.ts#L246-L282)) and the
  boardLink test ([:4407-4450](src/mcp/server.test.ts#L4407-L4450)) call `get_schedule({})` but
  assert only `now`/`boardLink`/`boardNote`.

**Stale in-code comments** (their subject is being deleted):
- [src/routes/daySource.ts:19](src/routes/daySource.ts#L19) — "in scheduled order (not yet
  drive-optimized)": there is no later optimization now; it is simply the booked order.
- [src/schedule/fit.ts:539](src/schedule/fit.ts#L539) — cites "the `get_schedule` precedent" for
  degrading on a routing outage; that precedent is removed here. Re-point at `find_slots`' own
  behavior.

### Automated verification
- [x] `npm run typecheck` passes (catches any missed `deps.optimizeStopOrder` reader — it is a
      TS2339 at all four test sites if step 3 is done without the test edits)
- [x] `npm run lint` passes (catches the orphaned import)
- [x] `npm test` passes — 892 passed | 5 skipped (897), 56 files
- [x] New/updated tests:
  - [x] a two-stop day returns stops in **booked time order**, each with a `mapsUrl` whose
        `destination=` is that stop's own address
  - [x] an address-less stop appears **in `stops`** at its chronological position with
        `mapsUrl: null`; no `unroutableStops` key exists on the response
  - [x] no `driveMinutes`, `optimizeFailed`, or `linkTruncated` key on any day
  - [x] a 12-stop day returns **12 stops, all with links** — the old 10-stop link cap no longer
        applies (this is the test that pins the user-requested behavior change)
  - [x] `src/routes/googleRoutes.test.ts` passes untouched (14/14), and `find_slots` tests pass —
        proof the seam deletion didn't reach the drive-delta path

**Review fixes applied** (round 1, no blocking findings): fixture cleanup extended to jobs +
customers in FK order — deleting only assignments would have left 16 open jobs in the tenant's
loose bucket, which Phase 2's `unassignedOnly` test reads; stray blank line removed; and
`deepLink.ts`'s header comment (same stale-comment class as the two listed above) updated, since
no caller passes more than one stop now.

### Live verification (agent-executable)
- Deferred to Phase 3 (nothing reaches a bot until the wire re-run).

### Manual verification
- None.

---
*No manual checks — continue to Phase 2.*

## Phase 2: `mapsUrl` on the manager's own stops

### What this phase does
Adds a Maps link to the caller's own timed stops inside `get_team_schedule`. Pure in-memory work
on rows already fetched: no new query, no network call, no new imports, no new parameter.

### Changes required

**`src/mcp/server.ts`** — `get_team_schedule` dispatch case

1. Before the `for (const row of rows)` loop at [:2951](src/mcp/server.ts#L2951):
```ts
// `caller` is in scope from :1545; get_team_schedule is an ADMIN_TOOLS entry so
// the gate at :1577 guarantees an active manager row, but TS does not narrow it.
const myTechnicianId = caller?.id ?? null;
let anyRoute = false;
```

2. **Inside** the loop, in the existing `bucket.push({…})` at
   [:2975-3012](src/mcp/server.ts#L2975-L3012). The `address` value is computed inline at
   [:2981-2989](src/mcp/server.ts#L2981-L2989) — **hoist it to a `const address = …` above the
   push** and reference it in both places, then append one property:
```ts
// Own timed stops get a tap-to-navigate link. Scoped to the caller (not every
// team stop) to keep the payload small on a surface where token cost is live.
...(!unassignedOnly && myTechnicianId && row.technician_id === myTechnicianId
    && row.starts_at && address
  ? { mapsUrl: buildMapsDeepLink([{ label: customer?.name ?? 'Customer', address }]).url }
  : {}),
```
`!unassignedOnly` is explicit, not implied: recall rows *can* be timed, so `row.starts_at` alone
would leak links into the recall view. Cleanest is to compute the condition as a `const isMyStop
= …` on the line above the push and use it both for the spread and to set `anyRoute = true`.

3. On the windowed return at [:3041](src/mcp/server.ts#L3041), add the relay instruction when at
   least one stop got a link. The key is `routeNote` — **never** `note`, which the recall return
   already uses ([:3036](src/mcp/server.ts#L3036)); the collision hazard is recorded at
   [:6109-6112](src/mcp/server.ts#L6109-L6112). Deliberately *positional*, not "end your reply
   with…", so it does not fight `boardNote`'s terminal instruction:
```ts
...(anyRoute && !unassignedOnly
  ? {
      routeNote:
        'Stops carrying mapsUrl are YOUR OWN. Relay each one VERBATIM as a tappable ' +
        '[Directions](url) link beside that stop.',
    }
  : {}),
```

`buildMapsDeepLink` and `formatAddress` are already imported at
[:110](src/mcp/server.ts#L110). No new imports. The `days` construction at
[:3015-3019](src/mcp/server.ts#L3015-L3019) is **unchanged** — the link rides on the stop, not the
day, so there is no restructuring and the recall branch at
[:3020-3039](src/mcp/server.ts#L3020-L3039) is untouched.


### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass — 897 passed | 5 skipped (902)
- [x] Surface counts unchanged — 39 and 14 assertions both still green
- [x] New tests — landed as their own top-level describe (`get_team_schedule own-stop maps
      links`) rather than inside `scheduling tools`, with fixed 2027-10 fixtures instead of
      relative ones: that suite's neighbours use fixed dates, and an isolated describe keeps
      its own FK-ordered cleanup. `mgrTestId` is captured in the file-level `beforeAll`
      alongside `techMcpId` rather than by raw query — same idiom, one line.
      Scaffolding: no optimize stub needed; fixtures need `mgr-test`'s roster UUID, a `beforeAll`
      local at [:63-69](src/mcp/server.test.ts#L63-L69) — fetch it with a raw query, the file's own
      pattern ([:3510](src/mcp/server.test.ts#L3510)); use `relDay(n)`
      ([:36](src/mcp/server.test.ts#L36)) and delete fixture rows in `afterAll`
      ([:2300-2307](src/mcp/server.test.ts#L2300-L2307)).
  - [x] a manager's own timed stop carries `mapsUrl` with its own address as `destination=`
  - [x] **the trap test**: the same reply still contains other technicians' stops AND an
        `unassigned:true` stop — and those stops carry **no** `mapsUrl`. Mutation-verified in
        review: injecting a `rows.filter(own)` fails this test plus 8 pre-existing ones.
  - [x] a day WITH stops but none of the manager's own → no `mapsUrl`, no `routeNote`
  - [x] own visit whose customer has no `address_line1` → no `mapsUrl`, stop still present
  - [x] time-TBD own visit (`starts_at` null) → no `mapsUrl`, stop still present
  - [x] `unassignedOnly:true` → no `mapsUrl`, no `routeNote`, `note` still present
  - [x] `routeNote` coexists with `boardNote` and does not clobber `note`, with
        `BOARD_BOT_HANDLE` set and restored inside the test

**Review fixes applied** (round 1, mutation-tested by the reviewer): the "no own visits" test was
**vacuous** — its day held zero fixtures, so the assertion ran over an empty array and an
unconditional `anyRoute = true` left the whole 902-test suite green. A teammate-owned stop now
sits on that day; mutation re-run confirms the test fails as it should. Also: corrected a comment
that credited the wrong guard for recall-view exclusion (`listUnassignedAssignments` already
filters `technician_id IS NULL`; the `!unassignedOnly` term is defence in depth, kept), and moved
the `BOARD_BOT_HANDLE` assignment inside the `try` so a construction throw cannot leak it.

### Live verification (agent-executable)
- Deferred to Phase 3.

### Manual verification
- None.

---
*No manual checks — continue to Phase 3.*

## Phase 3: docs, rollout, live checks

### What this phase does
Documents both changes, publishes the changed `get_schedule` description to technician bots, and
verifies on both tiers.

### Changes required

**`docs/nemoclaw-tech-agent.md`** §4 (~[:90-104](docs/nemoclaw-tech-agent.md#L90-L104))
- `get_schedule`: booked order, per-stop `mapsUrl`, no drive minutes, no `unroutableStops`.
- `get_team_schedule`: `mapsUrl` on the caller's own stops + `routeNote`.
- Counts unchanged (technician 14, manager 39); no allowlist edit. **Technician gateway restart
  IS required**; the manager side is deploy-only.

**`Box_Setup_Stuff/doorman-architecture-memory.md`** [:267](Box_Setup_Stuff/doorman-architecture-memory.md#L267)
- Required by the standing Box-Setup-Stuff sync rule (same commit as `nemoclaw-tech-agent.md`).
  It claims `get_schedule` is "day-route: **best stop order** + Google Maps deep link" — a
  behavior claim this change falsifies. → booked order + per-stop links, no drive minutes.
- ⚠ Leave the manager **counts** on :258/:268 alone — they belong to
  `2026-07-31-doc-tool-count-drift.md`.

**`docs/engineering-memory.md`**
- The principle: reads render the booked order; only `run_freeze`/`run_resolve` decide order,
  because deciding order means moving visits.
- The rollout trap: a *description* change moves `tools/list` → gateway-cached per process → not
  deploy-only, unlike result-side fields (PR #83's grounding riders). And the tier asymmetry: a
  tool filtered off one surface only forces restarts on the tier that carries it.

**Rollout (operator steps, in order)**
1. Merge + deploy Render. **Phase 2 is fully live here** — the manager `tools/list` is unchanged.
2. Box wire re-run — **technician profile only** (s5, plus any other technician sandbox).
3. `nemoclaw <s> gateway restart` on those; without it the old `get_schedule` description (drive
   minutes, "best driving order") stays cached and the agent describes fields that no longer exist.
4. Read back `tools/list` on a **technician** sandbox and confirm the new wording. Not performable
   on a manager sandbox — `get_schedule` is not in a manager's list.

### Automated verification
- [ ] `npm run typecheck` / `npm run lint` / `npm test` / `npm run build` pass
- [ ] `node scripts/smoke-http.mjs` against the deployed server returns 14 tools for a technician
      badge (surface-regression check; it does not inspect descriptions)

### Live verification (agent-executable)
- Prerequisites: `nemoclaw` access to trades-box-1; Telegram access to **s2** (manager-sam) and
  **s5** (Ben, technician — the pending device-pass sandbox). A manager AND a technician each
  holding **≥3 visits on one day** on the pilot tenant, at least one with a real address (book via
  the bot first if absent — a dispatch-only manager cannot exercise this).
  ⚠ **≥3 is load-bearing.** `optimizeStopOrder` short-circuits below 3 stops and returns identity
  order with no API call ([googleRoutes.ts:71-73](src/routes/googleRoutes.ts#L71-L73)), so a 1- or
  2-stop day already returns booked order *today* — a smaller fixture would pass identically
  before and after Phase 1 and prove nothing.
- [ ] s5 (technician): ask **"what's my schedule today?"** → stops come back in booked time order,
      each with its own link. Capture the message.
- [ ] s2 (manager): ask **"what's my schedule today?"** → the manager's own stops carry links
      **and** the reply still lists the team's other visits and any unassigned stop.
- [ ] Cross-channel read-back for both: open the same date on the board and confirm the chat order
      matches the board's time order. This is the check that proves reads and board no longer
      disagree — the point of the change.
- [ ] Confirm from the s2 trajectory (`/sandbox/.openclaw/agents/main/sessions/<id>.jsonl`) that
      only `get_team_schedule` was called (no `get_schedule` attempt — PR #54's gate still holds).

### Manual verification
- [ ] On a phone, tap a relayed link from each bot — Google Maps opens with directions to that
      stop. Confirm on a day with **4+ stops** that every stop has a working link (the old 10-stop
      link cap is gone; this is the behavior the per-stop design buys).

---
*Pause after this phase — the phone check is required before calling it done.*
