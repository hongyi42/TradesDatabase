---
date: 2026-07-06
branch: main
commit: 636a552
topic: Current surfaces for a Google route-optimization + Maps deep-link pipeline (technician day-route display)
---

## Summary

The feature idea: each day, compute the best driving order for a technician's assigned jobs and hand
the technician one tappable link that opens Google Maps with the whole day's route loaded. This
document maps what exists in the repo today for each stage of that pipeline: where a technician's
"day of jobs" lives, where street addresses live, what code could compute a stop order, and what
channels exist to deliver a URL to a technician. Headline state: the data foundation (the
`assignments` table and its query layer) is written but **not landed** — it sits in a git stash
(`stash@{0}`, "plan-1 scheduling work") after the 2026-07-04 schema rollback; the repo has **zero
location code** (no latitude/longitude column, no geocoder, no maps client anywhere); addresses are
free-text columns on `customers`; and the only in-repo paths that can carry a URL to a technician
are an MCP tool response relayed by the NemoClaw Telegram agent (reactive — the agent must ask) and
`send_email` (Gmail via Composio). A committed research doc from 2026-07-04 already compares
route-optimization vendors (OptimoRoute vs Google Route Optimization API) for the *scheduling*
problem — any route-display pipeline overlaps that prior work and the planned scheduling series
(Plans 2–5).

Facts below are labeled **[main]** (working tree = `origin/main` @ `636a552`) or
**[stash Plan-1]** (readable via `git show "stash@{0}:<path>"` for tracked files,
`git show "stash@{0}^3:<path>"` for untracked ones — do not apply the stash to read it).

## Entry Points

- `src/mcp/server.ts:1456` **[main]** — every MCP tool result is serialized
  `content:[{type:'text', text: JSON.stringify(result)}]` and returned to the calling agent. Any
  future "get my day route" tool output enters the world here.
- `src/mcp/httpServer.ts:139` **[main]** — central HTTP transport; identity from signed
  `x-tenant-id`/`x-technician-ref`/`x-identity-signature` headers (doorman path).
- `src/db/assignments.ts` — `listAssignmentsForTechnician(technicianId, fromISO, toISO)`
  **[stash Plan-1]** — the query that returns a technician's booked day, ordered by `starts_at`.
- `src/jobs/lifecycle.ts` **[main]** — the only scheduled entrypoint (Render cron heartbeat);
  today it does sessions/offboarding/log-ingest and writes manager review items only.

## Key Files

| Path | State | Role for this pipeline |
|---|---|---|
| `supabase/migrations/20260704210155_scheduling_foundation.sql` | stash Plan-1 | `assignments` table (job↔tech↔time, status enum, GiST no-double-book), `technician_time_off`, `job_type_durations`, `technicians.availability` JSONB + `service_cities`, `tenants.timezone`/`default_job_minutes`. Applied to hosted test 2026-07-04, verified, rolled back same day. |
| `src/db/assignments.ts` | stash Plan-1 | Day query (`listAssignmentsForTechnician`), work queue (`listUnassignedOpenJobs`), status state machine, reschedule = cancel+insert. |
| `src/db/jobTypeDurations.ts` | stash Plan-1 | `getJobDurationMinutes(tenantId, jobType)` — on-site duration per stop (falls back to `tenants.default_job_minutes`, 120). |
| `src/schedule/availability.ts` | stash Plan-1 | Pure `isTechnicianAvailableOn(iso, pattern, timeOff, timezone)` — fail-closed day-level availability. |
| `supabase/migrations/20260620005307_context_spine.sql:42-57` | main | `customers` — the **only canonical address store**: `address_line1`, `address_line2`, `city`, `state`, `postal_code`, all free text. No lat/lng. Jobs and visits carry no address; chain is `assignments.job_id → jobs.customer_id → customers`. |
| `src/db/scheduleEntries.ts:61` | main | `listScheduleForTechnicianOnDate` — today's ONLY live "tech's day" surface, backed by the Google-Sheet mirror `schedule_entries` (string `technician_ref`, denormalized free-text address, no coords). Slated to retire in Plan 5. |
| `src/mcp/server.ts:830-957` | main | `send_email` tool — stage→confirm, then Composio `GMAIL_SEND_EMAIL` from the caller's own paired mailbox to an arbitrary recipient. One existing way to deliver a URL. |
| `src/composio/outbound.ts:41` | main | `sendGmailEmail(tech, {to,subject,body})` — the actual dispatch behind `send_email`. |
| `src/mcp/server.ts:1304-1349` | main | `get_connect_link` — precedent: the one tool whose purpose is "mint a URL, return it to an agent for forwarding to a person". |
| `src/writePath/recordOutboundMessage.ts` | stash Plan-1 | L1 recorder for already-sent outbound messages (dedup on provider id). Unwired; `send_email` on main does its own inline capture (`server.ts:930`) — parallel implementations of the same idea. |
| `Box_Setup_Stuff/doorman.mjs` | main | Badge→signed-identity proxy on the central-HTTP path; pipes tool responses (SSE) back to the sandbox. Transport only. |
| `thoughts/shared/research/2026-07-04-third-party-automated-scheduling-software.md` | main (committed) | Prior vendor research: OptimoRoute recommended for drive-time-aware planning; Google Route Optimization API documented at lines 111–123 as the cheaper build-everything alternative; no FSM/route product in Composio's catalog → custom-tool or MCP wrapper required. |
| `thoughts/shared/plans/2026-07-03-scheduling-foundation.md` | stash Plan-1 | Plan-series map (line 17): Plan 2 = geocoding + grid drive-time cache; Plan 3 = scheduler core; Plan 4 = autonomy tiers/approvals/Telegram alerts; Plan 5 = recurring jobs + sheet write-back. |
| `thoughts/shared/research/2026-07-03-auto-scheduling-current-surfaces.md` | stash Plan-1 | Addendum decision 4 (lines 259–273): the already-decided Plan-2 design — geocode-once cache, quadkey-style grid cells, drive time per (cell-pair × time-of-day bucket), traffic-aware routing calls, auto-splitting cells. Google pricing verified 2026-07-03. |

## Data Flows

The pipeline the feature implies, mapped onto what exists (bracketed = does not exist yet):

```
                        [stash Plan-1 — not landed]
technician's day:  listAssignmentsForTechnician(techId, dayStart, dayEnd)
                        │  Assignment[] ordered by starts_at
                        ▼
addresses:         assignment.job_id → jobs.customer_id → customers
                        │  address_line1/2, city, state, postal_code (free text)
                        ▼
                   [stop-order computation — NOTHING EXISTS: no maps client,
                    no geocode, no distance function, no optimizer]
                        │
                        ▼
                   [deep-link builder — NOTHING EXISTS: string-assembly of
                    https://www.google.com/maps/dir/?api=1&origin=…&waypoints=a|b|c]
                        │
                        ▼
delivery (exists, main):
   path A: MCP tool response ──content[].text──► stdio OR doorman/HTTP ──► OpenClaw agent
           ──► Telegram message to technician   (agent is REACTIVE — no in-repo push;
                                                 Telegram leg lives in OpenShell gateway,
                                                 not this repo)
   path B: send_email tool ──► sendGmailEmail ──► Composio GMAIL_SEND_EMAIL
           (from caller's paired mailbox, arbitrary recipient, stage→confirm)
```

Identity: on the HTTP path, `(tenantId, technicianRef)` is pinned per request from doorman-signed
headers (`server.ts:62-74`) — a route tool would inherently know *whose* day to fetch; the
technician cannot ask for someone else's.

Today's only working alternative to the top of the chain: `listScheduleForTechnicianOnDate`
(`schedule_entries` sheet mirror) — live now, but keyed by string ref, populated by the sheet sync,
and planned to retire.

## External Dependencies

Verified against live vendor docs 2026-07-06 (per CLAUDE.md external-services rule):

- **Google Routes API** (`computeRoutes`) — single-vehicle stop-order optimization.
  `optimizeWaypointOrder: true` reorders up to 25 place-ID waypoints (98 lat/lng); accepts
  **free-text addresses** (matches what `customers` stores); returns
  `optimizedIntermediateWaypointIndex` + per-leg durations/ETAs + polyline. Bills on the
  **Compute Routes Pro** SKU: 5,000 free calls/month, then ~$10/1,000.
  Docs: https://developers.google.com/maps/documentation/routes/opt-way ,
  https://developers.google.com/maps/documentation/routes/reference/rest/v2/TopLevel/computeRoutes ,
  pricing https://developers.google.com/maps/billing-and-pricing/pricing
- **Google Route Optimization API** (`optimizeTours`) — fleet-level: assigns jobs to vehicles AND
  orders each day; consumes time windows, on-site durations, shift hours. Inputs take **lat/lng or
  place ID only — not free-text addresses**, so it has a geocoding prerequisite (= Plan 2's cache).
  ~$10/1k visits single-vehicle, $30/1k multi. **Display restriction (policy, quoted):** "Route
  Optimization API results can be displayed on Google Maps only; using them on other maps is
  forbidden."
  Docs: https://developers.google.com/maps/documentation/route-optimization/overview ,
  https://developers.google.com/maps/documentation/route-optimization/construct-request ,
  policies https://developers.google.com/maps/documentation/route-optimization/policies
- **Google Maps URLs (deep link)** — `https://www.google.com/maps/dir/?api=1&origin=…&destination=…&waypoints=a|b|c`.
  **No API key, no cost.** Universal: opens the native Maps app on Android/iOS, web on desktop.
  Carries ordered locations only (no ETAs/polylines/metadata). Limit: **9 waypoints** + origin +
  destination = 11 stops per link (3 waypoints on mobile *browser* fallback).
  Docs: https://developers.google.com/maps/documentation/urls/get-started
- **Composio** — existing dependency; carries `send_email` (Gmail) and inbound triggers. The
  2026-07-04 vendor research found **no route-optimization product in Composio's catalog**; any
  vendor (OptimoRoute or Google) would be wrapped as a Composio standalone custom tool
  (Experimental API) or called directly / via an MCP server.
- **OptimoRoute** — the committed 2026-07-04 research doc's recommendation for drive-time-aware
  *planning* (~$44–49/driver/mo); returns `travelTime`/`distance` per stop. Not yet integrated.

## Constraints and Invariants

1. **Plan-1 schema is not live anywhere.** Rolled back from the hosted pilot DB 2026-07-04; code +
   migration kept in `stash@{0}`. `database.types.ts` on main has no scheduling tables — the
   stashed query layer does not compile against main. Any pipeline stage that reads `assignments`
   has Plan-1 re-land as a hard prerequisite (local-Docker test path now available: Docker Desktop
   29.6.1 installed 2026-07-06; WinNAT port-reservation fix may be needed after reboots —
   `net stop winnat & net start winnat` elevated).
2. **Addresses are free text, quality unguarded.** `customers.address_line1/…` accepted verbatim
   from extraction. No lat/lng column exists. The scheduling-series edge register already assigns
   "geocode confidence" to Plan 2 — a deep link built from a bad address fails at the technician's
   phone, silently.
3. **No push channel exists in this repo.** The agent↔technician Telegram leg is OpenShell-gateway
   territory; every in-repo delivery is either a *reactive* tool response (agent must call the
   tool) or a person-initiated `send_email` (stage→confirm, `requireOutboundCapable`). The cron
   (`src/jobs/lifecycle.ts`) writes manager review items only; "Telegram alerts" are slated for
   Plan 4.
4. **L1 rules bind outbound sends.** Outbound/agent-action captures are classifier-free by recorded
   CLAUDE.md exception (2026-07-04); `send_email` already writes its own `outbound_email` L1
   capture inline (`server.ts:930-946`). A stashed parallel implementation
   (`recordOutboundMessage.ts`) exists — two implementations of the same idea, one wired, one not.
5. **Google display policy.** Route Optimization API results may be displayed on Google Maps
   surfaces only (policy quote above). A Google-Maps deep link *is* a Google surface; non-Google
   renderers (Leaflet/Mapbox/Apple Maps) are forbidden for those results. Routes API content
   likewise must not be combined with non-Google maps (Service Specific Terms).
6. **Deep link carries order only.** Planned ETAs, on-site durations, job metadata do not survive
   into the Maps app — they exist only in the API response and would need a separate carrier
   (message text, tool response body).
7. **Waypoint caps.** Maps URL: 9 waypoints. Routes API optimization: 25 place-ID waypoints. Fleet
   day sizes beyond that need chunking — no code position exists on this yet.
8. **Test discipline.** Tests run only against the local Supabase stack (`testEnvGuard`); the
   hosted project is the pilot's live DB. Any new pipeline tests inherit this. A Google-API client
   would also need a key-gated skip pattern (precedent: key-gated live-model tests noted in
   CLAUDE.md two-feature section).
9. **Identity pinning.** Tool identity comes from the request (doorman-signed headers / env), never
   tool args — a day-route tool automatically scopes to the calling technician.

## Decision Points

Factual forks the current code creates for a plan (no recommendations here):

1. **Which optimizer computes stop order.** Three documented candidates: (a) **Routes API** —
   takes free-text addresses as stored today, orders one tech's existing assignments, no geocoding
   prerequisite, 5k free calls/mo; does *not* assign jobs to techs. (b) **Route Optimization API**
   — also does assignment (overlaps Plan 3's planned scheduler core and Plan 4's approval flow) and
   consumes durations/time-windows/shift-hours (all Plan-1 data), but requires lat/lng or place IDs
   (= Plan 2 geocoding first) and carries the Google-Maps-only display restriction. (c)
   **OptimoRoute** — the committed vendor-research recommendation, per-driver monthly cost, its own
   display/API shape. The repo currently holds *both* a build-it recommendation trail (Plans 2–3
   grid cache + scheduler) and a buy-it recommendation (OptimoRoute doc) — a route-display pipeline
   must pick a lane or explicitly defer.
2. **Where the day's schedule is read from.** `assignments` (stash Plan-1, the intended model,
   needs re-land) vs `schedule_entries` (live today, sheet-mirror, string refs, retiring in
   Plan 5). Building on the former sequences behind Plan-1 re-land; building on the latter builds
   on a surface already marked for retirement.
3. **How the link reaches the technician.** (a) New MCP tool returning the URL in its response —
   works today, but reactive: the technician (or their agent's morning routine, which lives in the
   NemoClaw sandbox, not this repo) must ask. (b) `send_email` — works today, person-initiated
   stage→confirm from a paired mailbox. (c) A real push (morning cron → Telegram) — no in-repo
   channel exists; Plan 4 lists "Telegram alerts" as its territory.
4. **Where the pipeline code lives.** Precedents cut two ways: URL-minting inside a spine tool
   (`get_connect_link` pattern, server.ts:1304) vs external-service calls isolated in their own
   module (`src/composio/*` pattern). A Google client would be the repo's first `src/maps/`-style
   dependency; secret handling precedent is env-based (`.env` / Render env).
5. **Outbound capture path.** If links are delivered by message, which L1 recorder applies:
   the wired inline capture in `send_email`, or landing the stashed `recordOutboundMessage.ts` —
   currently duplicated logic awaiting a pick.

## Open Questions

1. Morning-delivery trigger: is a reactive tool acceptable for v1 (agent's own routine asks), or
   does the feature require the Plan-4 push channel to exist first? (Product question — code has no
   answer.)
2. Address quality: what fraction of pilot `customers` rows have link-usable addresses? Ties into
   the Plan-2 "geocode confidence" edge already registered. Needs a data look, not a code read.
3. `jobs.job_type` coverage in real data (drives duration estimates for Route Optimization input) —
   unknown without querying the pilot DB (read-only).
4. Does the OpenShell/NemoClaw agent render bare URLs in Telegram as tappable links (and does the
   Maps deep link survive Telegram's URL preview/wrapping)? Outside this repo; needs a live check
   on the box.
5. Day sizes: does any pilot technician exceed 9 stops/day (Maps-URL cap) or realistically approach
   25 (Routes API cap)? Determines whether chunking logic is real work or theoretical.
6. Stash lifecycle: `stash@{0}` is the only copy of Plan-1 code plus the two scheduling research
   docs and the plan doc — none of it is on any branch. (`stash@{1}` additionally holds older
   "reverted-PR7 outbound WIP".) Fragility noted as a finding, not acted on.
