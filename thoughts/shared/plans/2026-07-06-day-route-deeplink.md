---
date: 2026-07-06
task: Technician day/week route tool — ordered stops via Google Routes API + Maps deep link, delivered through a new MCP tool
research: thoughts/shared/research/2026-07-06-route-optimization-deeplink-surfaces.md
status: complete # all phases verified 2026-07-06; final 8-angle review: 8 findings, all fixed (see git history)
---

## Overview

Give a technician one ask — "what's my week" — and get back, per day: their stops in the best
driving order, total drive time, and a tappable Google Maps link that opens the whole day's route
for navigation. Built as a new technician-facing MCP tool (`get_schedule`) on the spine server;
the NemoClaw Telegram agent relays the reply. No schema changes, no fleet optimization (Route
Optimization API / build-vs-buy stays parked with Plan 3), no push channel (Plan 4).

## Decisions

- **Day-data source: config flag** (user pick) — `ROUTE_DAY_SOURCE` env: `schedule_entries`
  (default; the Google-Sheet mirror — real pilot data today) or `assignments` (the proper booking
  table — flip when Plan 3/manual booking fills it). One reader function, two implementations.
- **Delivery: range MCP tool, agent relays** (user pick) — `get_schedule(from, to?)`; a week is
  one call, fixing the ask-per-day round-trip problem. Email/push/mini-app deferred.
- **Optimizer: Routes API `computeRoutes` only** — takes free-text addresses (what we store);
  ROI needs geocoding we don't have. Verified docs: 25-waypoint cap, Pro SKU (5k free
  calls/month) — https://developers.google.com/maps/documentation/routes/opt-way
- **Skip optimization under 3 stops** — 0–2 stops have no middle to reorder; saves quota, avoids
  degenerate API calls (computeRoutes with `optimizeWaypointOrder` needs ≥1 intermediate). Such
  days report `driveMinutes: null` (unknown), never a fake `0` — a 2-stop day has a real drive we
  didn't measure. (Reviewer finding.)
- **Stops without a usable address stay visible but unroutable** — `RouteStop.address` is
  `string | null`; optimization and the link run over the *routable* subset only, and each day's
  reply lists unroutable stops last with `unroutable: true` so the tech still sees the job.
  (Reviewer finding: the index mapping between full list and routable list is spelled out in
  Phase 4.)
- **Origin/destination = first/last scheduled stop; only middles get reordered** — no "shop/home
  base" column exists anywhere in the schema. Deep link omits `origin`: per the Maps URLs doc,
  origin then "defaults to the most relevant location, such as user location, **if available**;
  if none, the resulting map may provide a blank form"
  (https://developers.google.com/maps/documentation/urls/get-started) — i.e. current-location
  start is likely but platform-dependent. `buildMapsDeepLink` therefore takes an optional
  `origin` and the final manual phone check decides: blank-origin form observed → flip one call
  site to pass the first stop as origin. A future tenant `home_base` column upgrades this.
- **No traffic-aware routing in v1** — `TRAFFIC_AWARE` requires a *future* `departureTime` and
  bills the same SKU tier either way, but past-dated departures error; static durations are
  fine for "roughly how long is my day". Revisit with real usage.
- **Deep-link stop cap: 9 waypoints** (Maps URL limit). >10 stops in a day → link carries the
  first 10 in order + response flags `linkTruncated: true`; the text list still shows all stops.
- **No L1 capture** — the tool returns data; nothing is sent to anyone by this feature. The
  outbound-capture question (recordOutboundMessage vs inline) stays parked (research Decision 5).
- **KNOWN LIMITATION (user decision 2026-07-06, phone-test finding):** pinning destination =
  scheduled-last stop can cost real minutes — the user manually beat the tool's order by ~7%
  (Ingram case) because the optimum needed the pinned endpoint moved, which computeRoutes
  forbids. Fix ladder: farthest-stop heuristic (SKIPPED by user decision — not worth interim
  code), tenant `home_base` column (endpoints become real), ROI/Plan-3 (endpoints optional).
  Plan 3 inherits this explicitly.
- **Module home: `src/routes/`** — first Google-Maps dependency; isolated like `src/composio/*`.
  Secret `GOOGLE_MAPS_API_KEY` via env (Render env in prod), never in client-visible content.
- **Identity** — tenant + technicianRef from `deps.identity` per existing pattern
  (`src/mcp/server.ts:62-74`); never from tool args. A tech can only fetch their own schedule.

## Plain-language walkthrough

**Phase 1 — the link maker.** Pure text machine: list of addresses in, one Google Maps URL out.
Handles URL encoding (spaces/commas → `%20`/`%2C`) and the 9-waypoint cap. No internet, no key —
so it's finished the moment its tests pass. You'd notice it working by pasting a generated URL
into a browser: Maps opens with the stops loaded.

**Phase 2 — the order asker.** One function that mails a day's stops to Google's Routes service
and gets back "drive them in this order" plus minutes per leg. Tests run against a fake Google
(recorded responses); one extra test makes a single real call when the API key is present and
skips politely when it isn't.

**Phase 3 — the schedule reader.** One function answering "Jane's stops for July 7–13", reading
whichever table the `ROUTE_DAY_SOURCE` flag names — the spreadsheet-mirror today, the proper
bookings table later. Both implementations tested against the local Docker database.

**Phase 4 — plugging into the agent.** Registers `get_schedule` in the spine server's toolbox and
wires phases 3→2→1 per day. After this, a tech asking their Telegram agent "what's my week" gets
the per-day summary with tappable links.

```
[3] read stops ──► [2] best order (Google) ──► [1] build link ──► [4] tool reply → agent → Telegram
```

## Secrets & env preflight

- **Phase 1:** none.
- **Phase 2:** `GOOGLE_MAPS_API_KEY` in `.env` — Google Cloud console → project → Credentials →
  API key restricted to Routes API. Live test skips without it; mocked tests need nothing.
- **Phase 3:** local stack vars (`.env.test`) — `already required`.
- **Phase 4:** none beyond the above. `ROUTE_DAY_SOURCE` is optional (defaults to
  `schedule_entries`).

## Phase 1: Deep-link builder (`src/routes/deepLink.ts`)

### What this phase does
Pure functions turning ordered stops into a Google Maps directions URL, with encoding and the
9-waypoint cap. Zero I/O.

### Changes required

**`src/routes/deepLink.ts`** (new)
```ts
export interface RouteStop {
  label: string;                  // customer name for display
  address: string | null;        // free-text single-line address, null = unroutable stop
  scheduledStart?: string | null; // ISO, passthrough for display
}
export interface DeepLinkResult { url: string | null; includedStops: number; linkTruncated: boolean; }
export function buildMapsDeepLink(stops: RouteStop[], origin?: string): DeepLinkResult
```
- `https://www.google.com/maps/dir/?api=1&destination=<last>&waypoints=<w1|w2|…>&travelmode=driving`
- Null-address stops are skipped internally (callers pass the routable list anyway; belt+braces).
- `origin` optional: omitted by default (see Decisions — Maps picks user location if available);
  the parameter exists so the manual-check fallback is a one-line call-site change.
- 0 routable stops → `url: null`. 1 stop → `destination` only, no `waypoints`. ≥2 → all but last
  as waypoints, capped at 9 (`linkTruncated` true when routable stops > 10; link then covers the
  first 10 in order).
- Encode with `encodeURIComponent`; join waypoints with `%7C` (`|`).
- Also export `formatAddress(parts: {addressLine1|null, city|null, state|null, postalCode|null}): string | null`
  (joins non-empty parts with ", "; null when addressLine1 missing — such stops are listed in
  text but excluded from the link).

**`src/routes/deepLink.test.ts`** (new) — pure vitest, no env:
0/1/2/9/10/11/15-stop cases; encoding (spaces, commas, `#`, `&`); missing-address exclusion;
cap flag; URL parses back to the same stop list (round-trip via `URL` + `searchParams`).

### Automated verification
- [x] `npm run typecheck` · `npm run lint` · `npm test` pass (5 pre-existing stale-ANTHROPIC_API_KEY synthesis failures only; 259 passed incl. 16 new)
- [x] new deepLink tests pass (16/16, all cases above)

### Live verification (agent-executable)
- Prerequisites: none.
- [ ] none (no live surface in this phase).

### Manual verification
- [ ] none.

---
*No manual list → continue directly to Phase 2.*

## Phase 2: Routes API client (`src/routes/googleRoutes.ts`)

### What this phase does
One function that calls Google `computeRoutes` with a day's stops (free-text addresses) and
returns the optimized middle-stop order plus per-leg durations.

### Changes required

**`src/routes/googleRoutes.ts`** (new)
```ts
export interface OrderedDay { order: number[]; legMinutes: number[]; totalMinutes: number | null; }
export type ComputeRoutes = (body: unknown) => Promise<unknown>; // injectable fetch seam
export async function optimizeStopOrder(
  stops: RouteStop[], deps: { computeRoutes?: ComputeRoutes } = {},
): Promise<OrderedDay>
```
- Callers pass only routable (non-null-address) stops; `order` indexes THAT list.
- <3 stops: return identity order without calling Google — `legMinutes: []`,
  `totalMinutes: null` (unknown ≠ zero; reviewer finding).
- ≥3: POST `https://routes.googleapis.com/directions/v2:computeRoutes`, headers
  `X-Goog-Api-Key: process.env.GOOGLE_MAPS_API_KEY`,
  `X-Goog-FieldMask: routes.optimizedIntermediateWaypointIndex,routes.legs.duration,routes.duration`.
  Body: `origin`/`destination` = first/last stop `{address}`, `intermediates` = middles,
  `travelMode: 'DRIVE'`, `optimizeWaypointOrder: true`.
- Map `optimizedIntermediateWaypointIndex` back to a full stop order (origin fixed at 0, last
  fixed at n−1); parse leg `duration` strings ("1234s") to minutes.
- Missing key → throw `new Error('GOOGLE_MAPS_API_KEY is not set')` (mirrors briefCustomer.ts:59
  idiom). Non-200 → throw with Google's error message (no retry in v1).
- Cap guard: >25 total stops → throw a descriptive error (research constraint 7; no pilot day
  approaches this).

**`src/routes/googleRoutes.test.ts`** (new)
- Mocked `computeRoutes` seam: order mapping (Google returns `[1,0]` → full order `[0,2,1,3]`),
  duration parsing, <3-stop short-circuit (seam must NOT be called), error paths.
- One live test `describe.skipIf(!process.env.GOOGLE_MAPS_API_KEY)`: 4 real Fresno-area
  addresses, assert a permutation of the middles + positive totalMinutes. (Same key-gating
  pattern as the synthesis live tests.)

### Automated verification
- [x] gates pass; mocked tests pass (11/11); live test key-gated (skips without key)

### Live verification (agent-executable)
- Prerequisites: `GOOGLE_MAPS_API_KEY` in `.env`.
- [x] live test passed (12/12 with key). Evidence 2026-07-06: 4 real addresses
  (Sacramento + 3 Fresno) → order [0,2,1,3], legMinutes [164,10,16], totalMinutes 191;
  reviewer independently replayed the request (HTTP 200, optimizedIntermediateWaypointIndex
  [1,0], total 11431s — consistent).

### Manual verification
- [ ] none.

---
*No manual list → continue to Phase 3.*

## Phase 3: Day-stops reader (`src/routes/daySource.ts`)

### What this phase does
`listDayStops` — technician's stops per date across a range, read from the flag-selected table.

### Changes required

**`src/routes/daySource.ts`** (new)
```ts
export interface DayStops { date: string; stops: RouteStop[]; }  // date = YYYY-MM-DD (UTC day)
export async function listDayStops(
  tenantId: string, technicianRef: string, fromDate: string, toDate: string,
): Promise<DayStops[]>
```
- Source = `process.env.ROUTE_DAY_SOURCE === 'assignments' ? 'assignments' : 'schedule_entries'`.
- DB queries live in the typed `src/db/` layer per CLAUDE.md — `daySource.ts` only composes
  (reviewer finding). Two new db-layer functions:
  - **`src/db/scheduleEntries.ts`**: `listScheduleForTechnicianInRange(tenantId, technicianRef,
    fromDate, toDate): Promise<ScheduleEntry[]>` — same shape as the on-date query
    (scheduleEntries.ts:61) with `gte(from) / lte(to)` bounds.
  - **`src/db/jobs.ts`**: `listJobsWithCustomerByIds(jobIds: string[]):
    Promise<(Job & { customers: Pick<Customer,'name'|'address_line1'|'address_line2'|'city'|'state'|'postal_code'> | null })[]>`
    — one select with embedded customer, not per-row lookups.
- `schedule_entries` mode: range query → group rows by UTC day of `scheduled_start`, map to
  `RouteStop` via `formatAddress` (`customer_name` as label). Rows with null `scheduled_start`
  are ignored (mirror rows without times aren't routable days at all).
- `assignments` mode: `getTechnician(tenantId, ref)` — **null row → return `[]`** (a valid badge
  with no roster row gets an empty schedule, not a crash; reviewer finding, matches
  server.ts:464-467 semantics) — then `listAssignmentsForTechnician(id, fromISO, toISO,
  ['confirmed'])`, then `listJobsWithCustomerByIds` for addresses.
- UTC day grouping in both modes — matches the mirror's existing v1 simplification (documented
  at scheduleEntries.ts:58-60); per-tenant timezone day-bucketing is future work alongside it.
- New file `src/routes/daySource.test.ts`: integration against the local stack (pattern of
  scheduling.test.ts — self-cleaning truncate), both modes: multi-day grouping, range edges
  inclusive, cancelled assignments excluded, null-start mirror rows skipped, flag default.

### Automated verification
- [x] gates pass; daySource integration tests pass on the local stack (8 tests, both flag
  values, incl. the overlap-clamp regression the phase reviewer prompted)

### Live verification (agent-executable)
- Prerequisites: local stack running (`npx supabase start`), `npm run seed:local`.
- [x] verified 2026-07-06 (both by implementer and independently by the phase reviewer):
  mirror mode → Tom Becker, "99 Ranch Rd, Clovis, CA, 93611", 2026-07-07T17:00Z;
  assignments mode → same customer, confirmed booking 2026-07-08T16:00Z. Side fix: `.env.test`
  had a UTF-8 BOM (PowerShell) breaking Node `--env-file` parsing — rewritten BOM-less.

### Manual verification
- [ ] none.

---
*No manual list → continue to Phase 4.*

## Phase 4: `get_schedule` MCP tool

### What this phase does
Registers the technician-facing tool and composes phases 3→2→1 per day.

### Changes required

**`src/mcp/server.ts`**
- Add to `TOOLS` (array starting src/mcp/server.ts:91), after `answer_customer_question`:
  name `get_schedule`; description tells the agent: dates optional (default today), `to` caps at
  14 days after `from`, reply contains per-day ordered stops + a Maps link to relay verbatim.
  `inputSchema.properties`: `from` (YYYY-MM-DD, optional, default today UTC), `to` (optional,
  default = `from`).
- Add dispatch case in the CallTool switch: resolve identity (existing helper), validate dates
  (`/^\d{4}-\d{2}-\d{2}$/`, `from <= to`, span ≤ 14 days → else `{status:'invalid_range'}`),
  `listDayStops` → per day with ≥1 stop:
  `routable = stops.filter(s => s.address !== null)` → `optimizeStopOrder(routable)` →
  day's stop list = `order.map(i => routable[i])` followed by the unroutable stops each marked
  `unroutable: true` → `buildMapsDeepLink(orderedRoutable)`. (Explicit index rule: `order`
  indexes `routable` only — never the full list; reviewer finding.)
  Return `{ status:'ok', from, to, days: [{ date, stops: [{label, address, scheduledStart,
  unroutable?}], driveMinutes, mapsUrl, linkTruncated }] }` (days with zero stops omitted;
  explicit `days: []` = free week; `driveMinutes` null when unknown).
- Routes-API failure for a day → that day degrades: scheduled order, `driveMinutes: null`,
  link built from unoptimized order, `optimizeFailed: true`. Schedule still delivered.
- Add `optimizeStopOrder` to `ServerDeps` (src/mcp/server.ts:70-83) as injectable seam so server
  tests never need the key.
- Fix stale surface-count comments while touching: server.ts:89-90 and :1445 say "8 tools" —
  correct to the real count including `get_schedule`.

**`src/mcp/server.test.ts`**
- **Update four existing count assertions** (reviewer finding — phase is red without this):
  `:131` and `:1198` technician surface 9 → 10; `:1047` and `:1321` manager surface 16 → 17.
- New cases via the existing harness (`clientFor(identity, extraSeams)`): default dates = today;
  invalid/oversized range; multi-day response shape; per-day degrade on seam throw; zero-stop
  week → `days: []`; null-address stop listed with `unroutable: true` and excluded from link;
  assignments-mode roster-less badge → `days: []`.

**Docs — every tool-count site** (reviewer finding; the box docs are operational verification
gates, a stale "9" fails a future box migration):
- `docs/nemoclaw-tech-agent.md:88, :95` — count + tool list.
- `docs/doorman-runbook.md:242, :308, :321-323, :367` — counts ("9"→"10", "16"→"17").
- `Box_Setup_Stuff/bootstrap-box.sh:496`, `migration-runbook-lightsail.md:114` (Gate A),
  `doorman-nemoclaw-setup-guide.md:20, :380, :560, :877`,
  `doorman-architecture-memory.md:97, :233` — same count updates.

**Agent-side allowlist (deploy-time, box-side — NOT in this repo's code):**
The sandbox technician profile allowlists tools *by name* (docs/nemoclaw-tech-agent.md:86-90);
without adding `get_schedule` there, the Telegram agent can never call it even though the spine
serves it (reviewer finding). This plan updates the Box_Setup_Stuff docs (above) so the
box-side Claude adds it; the live agent-path check below is deferred to deployment and recorded
as such in the implement notes.

### Automated verification
- [x] gates pass (`typecheck`, `lint`, `build` clean; `npm test` 286 passed / 5 pre-existing
  stale-ANTHROPIC_API_KEY failures only)
- [x] new server.test.ts cases pass (7 get_schedule cases, 33/33 in the file; incl. the
  assignments-mode roster-less case + NaN-date hardening the phase reviewer prompted)

### Live verification (agent-executable)
- Prerequisites: local stack + seed, `GOOGLE_MAPS_API_KEY` in `.env`.
- [x] scripted stdio MCP call as `tech-jane` (real `dist/mcp/server.js` over stdio transport),
  2026-07-06: tools/list = 10 incl. get_schedule; `get_schedule(2026-07-07..14)` →
  `{status:'ok', days:[{date:'2026-07-07', stops:[Tom Becker, "99 Ranch Rd, Clovis, CA,
  93611"], driveMinutes:null, mapsUrl:'https://www.google.com/maps/dir/?api=1&destination=…',
  linkTruncated:false}]}`.
- [ ] DEFERRED TO DEPLOYMENT (prerequisite: live box + sandbox allowlist updated — see the
  docs updates in this phase): ask the real Telegram agent "what's my week" and confirm it
  calls `get_schedule` and relays the link. The stdio check does NOT cover the agent path.

### Manual verification
- [x] User phone-tested a real 4-stop optimized link 2026-07-06: Maps opened with all stops
  in the returned order and was navigable (user compared drive times interactively — surfaced
  the pinned-endpoint limitation recorded in Decisions). No blank-origin form reported.

---
*Manual list non-empty → pause after Phase 4 for the user's phone check before closing out.*
