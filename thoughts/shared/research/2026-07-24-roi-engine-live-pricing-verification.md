---
date: 2026-07-24
branch: research-4b-freeze
commit: 4facb6c
topic: Plan 4b's first planning step — live verification of the Google Route Optimization API ("ROI") pricing, tiering, and input model, against the vendor's current docs
---

## Summary

Plan 4b is the **freeze**: a weekly, whole-plan solve that takes the loose bucket (unassigned
visits + jobs with no visit) and places it. The series shorthand has always said "ROI API" —
Google's **Route Optimization API**, a vehicle-routing solver that assigns and orders many
visits across many technicians. Every pricing/capability claim in this repo about it dates
from a **2026-07-04** survey, and CLAUDE.md requires re-verifying an external service against
live docs before building on it. This document is that re-verification, done 2026-07-24.

Two findings change the shape of 4b:

1. **At pilot scale the solver is free.** Fleet Routing bills *per shipment* with 1,000 free
   shipments a month. A weekly whole-plan solve over this pilot's loose bucket is single-digit
   shipments per run — roughly 25 a month against a 1,000 free allowance. Cost is not the
   deciding factor at our stage; it becomes one only at hundreds of firms.
2. **The API cannot take our addresses.** It accepts latitude/longitude or a Google place ID —
   **never a free-text street address**. This repo stores addresses as text and has **no
   geocoder**. So "adopt ROI" silently means "also build address→coordinates, and store the
   result." That is a real, bounded piece of work that no prior artifact costed.

The 2026-07-04 survey formally recommended **OptimoRoute** (~$35–49/driver/month) *over* ROI,
and no artifact ever recorded overturning that. The economics above cut the other way at pilot
scale: ROI is ~$0/month for us, while a per-driver subscription is a recurring bill from day
one. That is a fork 4b's plan must settle deliberately, not inherit by shorthand.

## Verified facts (all fetched 2026-07-24)

### Pricing and tiering

Google replaced the old $200 monthly credit with **free monthly calls per SKU per tier**:
Essentials 10,000 · Pro 5,000 · Enterprise 1,000
([pricing page](https://mapsplatform.google.com/pricing/)).

| SKU | Tier | Free cap / mo | 0–100k | 100k–500k | 500k–1M | 1M–5M | 5M+ |
|---|---|---|---|---|---|---|---|
| `RouteOptimization - SingleVehicleRouting` (`2020-AA6E-7D49`) | Pro | 5,000 | **$10.00**/1k | $4.00 | $2.00 | $0.80 | $0.70 |
| `RouteOptimization - FleetRouting` (`08E0-0D24-6C8E`) | **Enterprise** | **1,000** | **$30.00**/1k | $14.00 | $6.00 | $2.40 | $2.10 |
| `Geocoding` (`BAC8-4E68-E261`) — address→lat/lng | Essentials | 10,000 | **$5.00**/1k | $4.00 | $3.00 | $1.50 | $0.38 |

Source: [Google Maps Platform pricing list](https://developers.google.com/maps/billing-and-pricing/pricing).

**Which SKU applies:** a request containing **one** vehicle bills to Single Vehicle Routing;
**two or more** vehicles bills to Fleet Routing
([usage and billing](https://developers.google.com/maps/documentation/route-optimization/usage-and-billing)).
A freeze solving across a team is therefore always **Fleet Routing / Enterprise / 1,000 free**.

**The billed unit is the shipment, not the request** — "the per-request charge is based on the
number of shipments in the optimization request, times the shipment unit price per SKU"
(ibid.). Requests that fail validation, run in `VALIDATE_ONLY` mode, or whose shipments are
infeasible/ignored are **not billed** — so a dry-run/preview solve is free, which suits the
staged-proposal design already chosen for the freeze.

### The input model — the finding that costs build time

The Route Optimization API does **not accept free-text street addresses**. A visit's location
is given as either:
- `arrivalLocation` / `departureLocation` — **geographic coordinates only**; or
- `arrivalWaypoint` / `departureWaypoint` — a `Waypoint`, which is *either* a `Location`
  (lat/lng, optional heading) *or* a **place ID** ("use a place ID that is specific enough to
  determine a LatLng location for navigation to the place").

Source: [ShipmentModel REST reference](https://developers.google.com/maps/documentation/route-optimization/reference/rest/v1/ShipmentModel).

Additional constraint recorded for the implementer: if the model carries duration/distance
matrices, `arrivalLocation` must not be specified (ibid.).

**Consequence for this repo.** `customers` stores `address_line1/2, city, state, postal_code`
as text; `formatAddress` composes a display string; the only Google integration today is
Routes `computeRoutes`, which *does* take address strings. Nothing stores coordinates. Adopting
ROI therefore requires: a geocoding step (Essentials SKU, 10k free/month — a pilot geocodes
each customer once, so effectively free), somewhere to persist lat/lng (an L3 attribute on the
customer, or new columns), a staleness/`re-geocode` rule when an address is edited, and a
fail path for addresses that do not geocode (which must not silently drop a visit from a
solve).

## What this does NOT settle

- **Engine choice.** ROI vs OptimoRoute vs a heuristic-only v1 remains open. This document
  gives ROI's true numbers and its hidden geocoding cost; the competing option's pricing
  (OptimoRoute ~$35–49/driver/month, weekly-planning tier-gated, per the 2026-07-04 survey)
  is itself now 20 days old and must be re-verified before the comparison is trusted.
- **Whether the freeze needs a real solver at all in v1.** The pilot's loose bucket is single
  digits. A drive-aware heuristic over ≤10 shipments may be indistinguishable in output from
  an optimizer, at zero integration cost — worth pricing as the honest baseline before buying
  a VRP solver.
- **Enterprise-tier access.** The docs label Fleet Routing "Enterprise" but do not state
  whether a sales agreement or contract is required to enable the SKU on a project. This is a
  hard prerequisite to confirm on the actual billing account before the plan commits to it —
  if it needs a contract, "free at pilot scale" is moot.

## Corrections to existing artifacts

- `thoughts/shared/research/2026-07-22-plan-4-freeze-ritual-surfaces.md:184-194` cites
  "~$30/1k shipments, ~1k free/mo likely covering weekly pilot runs" as of 2026-07-04, hedged
  as unverified. **Both numbers are confirmed exactly** ($30.00 per 1,000 in the 0–100k tier;
  1,000 free events/month) — the hedge can be dropped, with this document as the citation.
- The same passage flags the address-vs-lat/lng question as unresolved and
  "materially changes the build". **Resolved: lat/lng or place ID only.** The build change is
  real and must appear as its own phase in 4b's plan.
