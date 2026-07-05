# Research: Third-party automated scheduling software for trades (2026-07-04)

**Question:** How is scheduling done in the trades industry, and what affordable third-party
software with *automated* scheduling (1–2 week horizon, manager schedules technicians, drive-time
aware) could a NemoClaw agent connect to via Composio?

**Method:** Deep-research workflow — 5 search angles, 23 sources fetched, 113 claims extracted,
top 25 adversarially verified (3 independent votes each; all 25 confirmed 3-0 against live
primary docs on 2026-07-04). Assumed scale: US-based, ~2–10 technicians (pilot size).

---

## 1. How scheduling actually works in the trades (education)

### Scheduling vs dispatching — two different jobs

- **Scheduling** = planning ahead (days to weeks): which technician gets which appointment on
  which day. This is the 1–2 week horizon the manager cares about.
- **Dispatching** = reacting in real time (today): a job runs long, an emergency call comes in,
  someone calls in sick — the day's plan gets reshuffled.

Software that does the first well doesn't automatically do the second, and vice versa.

### The two kinds of jobs

- **Service calls** — short (1–3 h), often urgent, uncertain duration ("furnace making a noise").
  These dominate the schedule churn.
- **Installs / big jobs** — long (half-day to multi-day), planned in advance, sometimes need two
  techs or specific skills/certifications. These get placed first; service calls fill in around them.

### Time windows

Customers are promised an **arrival window** ("between 8 and 12"), not an exact time. The window
gives slack for drive time and jobs running long. Scheduling software encodes this as a
constraint: the tech must *arrive* inside the window.

### The dispatch board

The manager's main tool is a calendar grid — **columns = technicians, rows = hours of the day**.
In most low-end software, "scheduling" means a human dragging job cards onto this grid.
"Automated scheduling" means software places (or suggests) the cards itself.

```
            Mon Jul 6
Time     │ Alice (Zone N) │ Bob (Zone S)
─────────┼────────────────┼───────────────
 8–10    │ Job #41 HVAC   │ Job #38 plumb
10–12    │ Job #44 (2mi)  │ ← drive 35min ⚠
12–1     │ lunch          │ Job #52 plumb
 1–4     │ Install #12    │ Job #55 (1mi)
```

### The "distance penalty" — how drive time is handled in practice

Three levels of sophistication, from manual to automated:

1. **Geographic zoning / clustering** (the manual classic): divide the service area into zones,
   keep each tech's day inside one zone. Cheap, works, but rigid.
2. **Buffers**: pad 15–30 min between jobs to absorb drive time and overruns. Wastes capacity
   when jobs are close together.
3. **Route optimization** (the automated answer): software with a live road map computes real
   drive times between every pair of stops and picks assignments + orderings that minimize total
   drive time while honoring time windows, skills, and shift hours. This is a well-studied math
   problem (the "vehicle routing problem") and is exactly what the API products below sell.

Full pipeline of an automated day plan:

```
 job requests ──► geocode addresses ──► cluster by area ──►
 sequence each tech's stops (minimize drive time, honor windows) ──►
 dispatch board / tech's phone
```

> Note: the education section synthesizes vendor-blog sources (BuildOps, Jobber Academy,
> ServiceTitan, FieldPulse, Workiz, Smart Service guides) + general VRP knowledge; the
> product/pricing facts below are the adversarially-verified set.

---

## 2. Verified product survey

**Composio catalog result (load-bearing):** No FSM or route-optimization product (Jobber,
Housecall Pro, ServiceTitan, Workiz, ServiceM8, Zuper, FieldPulse, Service Fusion, Routific,
OptimoRoute) was found in Composio's catalog surfaces (README + composio.dev/toolkits landing;
note composio.dev/tools 404s). Treat as high-probability-absent, not proven-absent — a per-vendor
catalog search was not exhaustive. Therefore the integration path for ALL candidates is a
**Composio standalone custom tool** (runs in-process alongside remote Composio tools; we manage
the vendor API key ourselves — custom tools cannot define auth schemes) or an MCP server.
Composio's custom-tools API is labeled **Experimental**. Extension tools + `proxyExecute`
(managed auth) only work for catalog toolkits — proxy-execute enforces same-domain.
Sources: https://docs.composio.dev/docs/custom-tools ,
https://docs.composio.dev/docs/toolkits/custom-tools-and-toolkits ,
https://docs.composio.dev/docs/proxy-execute , https://github.com/ComposioHQ/composio

### OptimoRoute (route-optimization SaaS) — recommended

- **Automation:** genuinely automated. `POST /v1/start_planning` triggers optimization;
  `dateRange` supports multi-day/weekly planning (vendor: up to 5 weeks). Orders carry time
  windows (`twFrom`/`twTo`); results include per-stop `travelTime` and `distance`.
- **Distance penalty:** native — drive-time-aware optimization is the core product.
- **Pricing:** Lite **$35.10/driver/mo** annual ($39 monthly); Pro **$44.10** ($49). ~$70–490/mo
  at pilot scale. https://optimoroute.com/pricing/
- **API:** public JSON-over-HTTPS, self-serve key (Administration → Settings → WS API),
  **included on every plan** incl. trial. RPC-style (`get_orders`, `create_order`, key in query
  param) — fine to wrap. https://optimoroute.com/api/
- **Gotcha:** weekly (multi-day) planning is tier-gated — absent on Lite, "contact us to
  activate" on Pro, standard on Custom; API returns `ERR_UNSUPPORTED_BY_PRICING_PLAN` otherwise.
  https://optimoroute.com/weekly-planning/
- **Not a FSM:** no invoicing/CRM/dispatch board product — jobs/customers live in our spine.

### Google Route Optimization API (raw solver)

- **Automation:** it's the engine itself — optimized route plans + task assignments for multiple
  vehicles. Google explicitly lists "field service providers assigning personnel to appointments"
  as a use case. Constraint model is the strongest surveyed: `VisitRequest.timeWindows`,
  `Vehicle.breakRule`, `Vehicle.loadLimits`, `precedenceRules`, type incompatibilities.
  https://developers.google.com/maps/documentation/route-optimization/overview
- **Distance penalty:** native (travel-time + distance objectives).
- **Pricing:** per **shipment** (job), not per call. 2+ vehicles in a request → **Enterprise
  "Fleet Routing" SKU ~$30/1,000 shipments** (single-vehicle ~$10/1,000). $200/mo credit expired
  Feb 2025 → free-usage threshold (~1,000 free Fleet Routing shipments/mo) likely covers a pilot's
  weekly runs. Re-optimizing multiplies cost by run count.
  https://developers.google.com/maps/documentation/route-optimization/usage-and-billing
- **Caveat:** a solver, not a product — all scheduling state, order management, and UI is ours to
  build.

### Routific Engine API

- **API:** clean public REST — `POST https://api.routific.com/v1/vrp` (bearer token, self-serve
  key, 30-day trial). Supports time windows, capacity, priority stops, driver breaks (verified at
  field level). https://docs.routific.com/reference/planning-your-first-route-with-routifics-engine-api
- **Limits:** sync `/v1/vrp` caps ~60 visits (async `/vrp-long` beyond); **planning horizon
  limited to 96 hours** — under our 1–2 week target; would need rolling per-few-day calls.
- **Pricing (medium confidence — possibly stale bundle):** $150/mo for 1,000 stops, 15¢/stop
  overage per dev.routific.com; third parties say API pricing is now sales-quoted. Re-verify with
  sales before committing.

### Housecall Pro (full FSM suite) — fallback

- **API:** the one surveyed FSM with a verified public REST API + hosted docs
  (docs.housecallpro.com, API key + OAuth 2.0). An open-source MCP wrapper exists
  (github.com/buildwithbeacon/housecallpro-mcp).
- **Webhooks:** rich schedule observability — `job.scheduled`, `job.on_my_way`,
  `job.appointment.rescheduled`, `.appointment_pros_assigned` / `_unassigned`, etc. (14 events) —
  could push-feed L1 capture.
  https://docs.housecallpro.com/docs/housecall-public-api/46e9e1be07621-webhooks
- **Gate:** API **and** webhooks require the top **MAX plan (~$299/mo annual)** (Basic $59 /
  Essentials $149 have neither). https://www.housecallpro.com/pricing/ ,
  https://help.housecallpro.com/en/articles/8505035-api-overview
- **Unknown:** whether its native scheduler auto-assigns / route-optimizes or is manual
  drag-and-drop — no claim survived verification.

### Coverage gap (important)

Only 4 of ~13 requested products survived verification. **Jobber, ServiceTitan, Workiz,
FieldPulse, Service Fusion, ServiceM8, Zuper, Motion, Skedulo have zero verified claims** — their
absence from the brief reflects verification attrition, not evaluated inferiority. Unverified
signals from fetched sources: ServiceTitan's Dispatch Pro is a true AI auto-assign add-on (but
ServiceTitan is enterprise-priced); Jobber's core interaction is manual drag-and-drop with route
optimization on higher tiers (Grow ~$349/mo for 10 users); Workiz Standard ~$200–230/mo for 5
users. Treat all of these as unverified leads.

---

## 3. Decision brief

| Option | Cost at pilot scale | Automation | Integration effort | Risk |
|---|---|---|---|---|
| **OptimoRoute Pro** wrapped as Composio custom tool | ~$44–49/driver/mo | True multi-day auto-planning, drive-time aware | Low — simple keyed JSON API | Weekly planning needs vendor activation on Pro; not a full FSM |
| **Google ROI** as raw engine | Near-free at pilot volume (free threshold), then ~$30/1k jobs | Strongest constraint model | High — we build all scheduling state/flow | Multi-tech = Enterprise SKU; it's a solver, not a product |
| **Housecall Pro MAX** | ~$299/mo flat | Suite + webhooks; scheduler automation depth UNVERIFIED | Medium — real REST API, existing MCP wrapper to crib | Top-tier gate; may buy observability, not automation |

**Recommendation:** OptimoRoute, wrapped as a Composio standalone custom tool (or thin MCP tool on
our gateway). Cheapest verified path to genuinely automated, drive-time-aware 1–2-week scheduling;
jobs/customers stay in our spine (which fits the Telegram-only, spine-as-record architecture);
lowest engineering lift. Before committing: confirm weekly-planning activation on Pro with
OptimoRoute, and sanity-check one mid-tier FSM (Jobber/Workiz) to close the coverage gap.

**Architecture note:** custom tools bypass Composio-managed auth *and* per-person session configs
— tier enforcement (manager vs technician) for a scheduling tool must be enforced by our own
gateway/tool layer, not by Composio sessions.

## Open questions

1. Does a mid-priced FSM (Jobber, Workiz, Zuper, ServiceM8…) offer auto-assign + accessible API
   that beats OptimoRoute-plus-spine? (No verified claims survived for any of them.)
2. Exhaustive Composio catalog check per vendor name — never completed.
3. Is Housecall Pro's native scheduler automated or drag-and-drop only?
4. Routific's current sales-quoted API pricing; can rolling calls work around the 96-h horizon?

*All pricing verified 2026-07-04; vendors change pricing without notice.*
