# TradesDatabase — product profile for growth work

Distilled from the repo's front-door docs on **2026-08-17**. Every claim here traces to a doc; the
citations are kept so you can re-check before putting a number in public copy. Re-derive this file
if the product changes materially.

> **The single most important fact on this page:** this is **not a self-serve SaaS funnel**, and
> most of the Demand Curve guide silently assumes one. See §6 before applying any chapter.

---

## 1. What it is

**Plain (their own words, better than a rewrite):**

> "This assistant builds **one record per customer and job** that everybody writes into and everybody
> reads from. Nobody re-types anything, and nothing depends on Dave."
> — `docs/getting-started-for-firms.md:28`

> "**You talk to it in Telegram.** That's it — no new app to learn, no website to log into, no
> passwords." — `docs/getting-started-for-firms.md:31`

**Technical:** the harness and context engine for a fleet of AI agents that run a trades firm's
office. Each person — manager and technician — talks to their own agent; every agent reads and
writes one shared customer/job record (**the spine**). `docs/onboarding.md:39`

Division of labor, stated repeatedly and worth borrowing for copy: *the spine supplies memory
(evidence-linked, append-only); the agents supply interpretation and conversation; the harness —
identity, guardrails, confirmation doctrine, date machinery, evals — supplies the trust that makes
an agent's output safe to act on.* `docs/onboarding.md:44`

**Maturity: pilot, not launched.** Two tenants in the pilot DB (one demo, one real beta onboarded
2026-07-07), running on one Lightsail box. `docs/onboarding.md:68`

## 2. Who it's for

**Firm:** small trades firms — HVAC, plumbing, electrical, pest control, roofing — **~5–50 people**.
`docs/Three-Layer-Context-Spine-Overview.md:12`, `docs/onboarding.md:25`
(Adjacent research uses 1–15; treat **5–50 as the canonical line**, 2–50 as the outer band.)

**The relay it targets:** customer → front desk (CSR) → manager/dispatcher → technician → back to
the office → sales. `docs/onboarding.md:28`

**Buyer:** the firm — in practice the owner-manager. Seats are sold by "Sales + the firm" and the
runbook is explicitly for a firm "that has signed and paid."
`docs/customer-onboarding-runbook.md:1,49`

**Two user tiers (enforced in the DB, not marketing labels):**

| Tier | Who | Can do | Tools |
|---|---|---|---|
| **manager** | buyer/admin; dispatcher or owner | full team + schedule authority, adds people, runs the weekly freeze, full connector catalog, self-serve pairing | 40 |
| **technician** | broad non-manager catch-all — **field techs, office staff, sales** | own day only: notes, briefings, lookups, two-step `send_email`, retract. **Cannot change the schedule.** | 14 |

`docs/engineering-memory.md:138`, `docs/nemoclaw-tech-agent.md:91,112`

Customer-facing framing: "Technicians cannot change the schedule — that is on purpose, **so the
schedule has exactly one author**." `docs/getting-started-for-firms.md:53`

**Third seat class for packaging talk:** schedule-only / `seatExempt` people (e.g. a subcontractor
you dispatch who gets no assistant) consume **no seat**. `docs/customer-onboarding-runbook.md:208`

## 3. The pain — and the "before" state

The best "bad alternative" paragraph in the repo; ch. 3's value-prop exercise is already done here:

> "You already have a system for remembering customers. It is: a whiteboard, a phone, a shared
> inbox, three group chats, and the fact that Dave has been here eleven years and just *knows* the
> Hendersons have a dog. The problem is not that this doesn't work. **It is that it only works while
> everyone stays**, and it leaks a little at every handoff."
> — `docs/getting-started-for-firms.md:14`

**Two named costs:** *wasted time* — usually the manager's whole day hand-routing information
between phone, calendar, email, sticky notes; *context loss* — facts degrade between people, between
the two visits of one job, and across months for a repeat customer. `docs/onboarding.md:34`

**Revenue angle (not just time saved):** captures what slips through cracks — technician-spotted
replacement opportunities, follow-ups on unaccepted quotes, recurring-contract renewals. A
technician becomes a lead source. `docs/Three-Layer-Context-Spine-Overview.md:37,112`

**The compounding claim — the strongest long-form line available:**

> "**The compounding is the point.** A record with three months of notes in it is a different
> product from an empty one — briefings get sharper, repeat customers stop needing to re-explain
> their history, and **the things one technician knew become things everyone knows.**"
> — `docs/getting-started-for-firms.md:446`

**Why not a generic chatbot:** grounded in the firm's actual history, cites where every claim came
from, and can act. `docs/onboarding.md:49`

## 4. Delivery, activation, and the magical moment

**Telegram is the entire UI.** No web front end exists or is planned. The one deliberate extension
is a Telegram **Mini App dispatch board** (drag-and-drop day grid; manager-only editing, technicians
read-only on their own day). `docs/engineering-memory.md:102`, `docs/onboarding.md:63`

"**No mobile app to install** — which is a feature, not a gap: the firm's staff already have
Telegram." `docs/customer-onboarding-runbook.md:279`. iMessage is impossible — Apple doesn't permit
bots. `docs/nemoclaw-tech-agent.md:31`

**Activation is high-touch:** ~**a week elapsed, ~4–6 hours of our hands-on work**, across 9 phases
(legal/seats → tenant → first manager → sandbox+bot+badge → Gmail → phone → 60–90 min screen-shared
firm setup → go-live verification → day-2 handoff + 30-day check-in).
`docs/customer-onboarding-runbook.md:6,18`

**The manager's own week-1 setup (~1 hour, order-dependent)** has a known trap worth naming in
onboarding copy: set working hours — *"the step everyone forgets. Until you do this, the scheduler
will never book that person."* `docs/getting-started-for-firms.md:108`

**The first magical moment, explicitly named — use this everywhere:**

> "**Send a voice note. This is the whole point of the system, and it takes eight seconds.** … That
> one voice note becomes: the visit record, the diagnosis, the quote, and **two permanent facts
> about the property that every future technician will see before they arrive. You typed nothing.**"
> — `docs/getting-started-for-firms.md:199`

**The documented adoption ramp doubles as an activation funnel** (ch. 5's "path to value" is already
mapped — use it, don't invent one):

| Week | Behavior | Note |
|---|---|---|
| 1 | everyone records voice notes after every job | "**That single habit is 80% of the value**", and the only real behavior change |
| 2 | move scheduling onto the board | |
| 3 | morning briefing on first two customers | "**This is where technicians usually get convinced.**" |
| 4 | run the weekly freeze for real | manager's payoff: "where the system starts saving you your Sunday evening" |

`docs/getting-started-for-firms.md:436,286`

## 5. Differentiation — claims defensible because they're enforced in mechanism

1. **Agent-first, not app-first** — agents are the interface, spine is shared memory, harness makes
   output trustworthy. `docs/engineering-memory.md:53`
2. **Telegram-only. No app, no login, no password.** `docs/engineering-memory.md:102`
3. **Nothing can be deleted; everything is retractable.** Wrong things get retracted, the original
   stays underneath, "so the record can always be re-checked against what was actually said."
   `docs/getting-started-for-firms.md:63`
4. **Every claim cited to its evidence; says "I don't know" rather than guessing.** Hallucinated
   citations are dropped mechanically. `docs/getting-started-for-firms.md:88`, `docs/onboarding.md:216`
5. **The confirmation doctrine — genuinely contrarian and ownable.** *Confirm only what's
   irreversible or externally visible; everything reversible, just do — and say what you did.*
   Because "if it asked about everything, you would start saying 'yes' without reading, and then the
   one that mattered would slip through." **Over-confirming is a safety problem.**
   `docs/engineering-memory.md:171`, `docs/getting-started-for-firms.md:76`
6. **The promise ladder** — records *what the customer was told* (`none`/`day`/`time_only`/`time`)
   separately from the calendar. "It will freely shuffle unpromised work and **will never break a
   promise you made. That is the difference between an optimizer you can trust with real customers
   and one you can't.**" `docs/getting-started-for-firms.md:254`
7. **A human always commits.** The freeze "booked nothing until you said yes"; only a human ever
   pins. `docs/getting-started-for-firms.md:302,274`
8. **Hardcoded where it must be correct** — identity matching, permissions, scheduling guards are
   deterministic code, never a model guess. `docs/onboarding.md:118`
9. **Looks dates up instead of doing calendar math**, and asks when "next Tuesday" is ambiguous.
   `docs/getting-started-for-firms.md:97`

## 6. ⚠️ How this product breaks the guide's assumptions

The Growth Guide's ch. 2 rule is *match on audience **and business model***. On business model this
product is **not** the self-serve freemium SaaS the guide's examples assume. Adjust accordingly:

| Guide assumes | Reality here | Consequence |
|---|---|---|
| Self-serve signup | **No signup page exists.** Tenant creation is operator SQL; ~4–6 hrs internal work per firm. `docs/customer-onboarding-runbook.md:40` | **Never write a "Start free trial" CTA.** The conversion event is a booked call/demo, not a signup. CPA math is lead→sale, not visit→signup. |
| Product-led onboarding inside an app | Onboarding is a **screen-shared 60–90 min session** plus a 4-week habit ramp | Ch. 5 still applies, but to a *human-assisted* flow — reduce the manager's friction, not a signup form's |
| A/B testable traffic volume | Pilot-stage; traffic is nowhere near 1,000–10,000 visits | **Ch. 8: micros are off the table.** Only macro variants are worth running, and even those may not reach significance — say so rather than pretending |
| Anyone can be a lookalike seed | Seed needs ≥1,000 people; there are **37 pilot customers** | Lookalikes are not available yet. Interest/job-title targeting only. `docs/engineering-memory.md:1246` |
| Bots can start conversations | **Telegram bots cannot message first** — each person must press Start. `docs/customer-onboarding-runbook.md:155` | That's a real, mandatory activation step to design around |
| Growth is unconstrained by ops | Every purchased seat needs a **pre-built cold sandbox**; empty pool blocks onboarding. `docs/customer-onboarding-runbook.md:224` | Demand gen has a hard supply ceiling — don't build a campaign that outruns it |
| Sell anywhere | **Single timezone per tenant** by design. `docs/onboarding.md:602` | Don't target multi-timezone firms |

**Consequence for ch. 2 (competitive analysis):** the right companies to study are **high-touch,
sales-assisted B2B tools sold to small non-technical businesses** — not self-serve SaaS. Study how
they run demo-booking funnels, not signup funnels.

**LPA position (ch. 4):** trades firms mostly sit at **rung 4** — experiencing the problem (Dave
leaves, facts get lost) but unaware software addresses it — or **rung 3**, aware FSM tools exist but
unmotivated. Copy must carry the problem *and* the category, not just differentiation. Expect to do
more educating than a rung-1/2 product would.

## 7. Proof points — what's real, and what you may not claim

**Usable (internal, reproducible, verifiable):**
- **Date reliability 100%** — 94/94 on the v3 date eval, zero stalls, zero weekday-date
  contradictions; "every point of it came from mechanism, not prompting." `docs/engineering-memory.md:578`
- **Tool layer 100%** — 45/45 cases; 366/366 date matrix. `spine-eval-runs/tier1-report.md:9`
- **0 machinery failures / 0 fabrications** on the 2026-08-15 fleet run; agent-turn median 6.3s.
  `docs/engineering-memory.md:602`
- **Cross-tenant leak probe never fired** — the eval plants a canary customer in another tenant.
  `docs/engineering-memory.md:227`
- Engineering maturity: 82 merged PRs, 59 test files / ~870 test declarations. `docs/onboarding.md:73`

**Handle with care:** the 55/59 tier-2 report ran on `gemini-3.7-flash`, **not** the production
model — don't cite it as the shipped product's score. `spine-eval-runs/tier2-report.md:5`
Published latency medians are `trajMs`; wall time adds ~14s of ssh overhead — never cross-compare.

**❌ You may NOT claim (nothing exists to support it):**
- Any customer outcome — hours saved, revenue lift, jobs/day, quote conversion, NPS. **None recorded.**
- Any testimonial, case study, or logo.
- "Trusted by N firms." The one named external beta **exited beta 2026-08-14**, so as recorded there
  are **zero active external customers**. `docs/engineering-memory.md:985`

Per ch. 3, the standard move when you lack social proof is to give the product free to recognizable
firms in exchange for logo rights. That's a proposal to make, not a claim to write.

## 8. Competitors

No positioning doc exists; these are named only as research citations. Adjacent category is **Field
Service Management (FSM)**, though the product never claims that category for itself.

**ServiceTitan** (most-cited; markets itself as "born in the trades, trained on the trades"),
**Jobber**, **Housecall Pro**, **Service Fusion**, **BuildOps**, **Smart Service**, **Pricebookr**,
**CompanyCam** (job-documentation adjacent), **QuickBooks** (the accounting system firms actually
invoice with). `thoughts/shared/research/2026-08-15-pricing-invoicing-payment-loop.md:46,90-107`,
`docs/Physical-Data-Exchange-Direction.md:836`

Their shape: FSM tools are **invoice-first** — in ServiceTitan the invoice object exists from the
moment the job is booked; Jobber's API is literally `Quote → Job → Invoice → PaymentRecord`. This
product is **memory-first and deliberately has no money layer**, which is the sharpest available
contrast — and also the sharpest objection.

## 9. Hard constraints on what marketing may say

**The explicit "what we are NOT" list — say it in the sale** ("the gap between 'AI for trades' and
this product is where disappointment lives"): `docs/customer-onboarding-runbook.md:267`
- **No invoicing, payments, pricing, or accounting.** `quote`/`invoiced` are labels only; no money
  moves through the system.
- **No customer-facing anything.** Customers never talk to the assistant. It is a staff tool.
- **No outbound calling, no AI receptionist, no phone-tree routing.**
- **No web app.** Telegram + the board Mini App, full stop.
- **It doesn't replace your dispatcher.** It removes the typing and remembers everything; a human
  still decides. `docs/getting-started-for-firms.md:420`

**Three disclosures owed in writing before access** — these are product foundations, not settings,
and copy must never contradict them: `docs/customer-onboarding-runbook.md:65`
1. Emails sent through the assistant are **permanently logged** — including personal ones.
2. **Nothing recorded can be deleted.** "If the firm cannot live with that, stop here."
3. The assistant **may proactively ask about work**, and answers can be recorded to job records.

Proactive nudges are bounded **by mechanism**: ≤2 questions per person per day, never a repeat for
the same visit, 48h silence hands it to the manager, and it writes only 7 AM–7 PM local. It will
never message customers on its own, change the schedule, or send anything anywhere.
`docs/getting-started-for-firms.md:348`

**Call recording:** the recorded-call announcement is what makes recording lawful — "never ask us to
remove it." Treat every call as all-party consent. No voiceprints/biometrics. Card/CVV/SSN/routing
numbers redacted before the transcript is written. The **firm is the controller, we are the
processor** — caller-facing privacy notice and CCPA duties sit with them.
`docs/phone-call-runbook.md:46,50,52,57`, `docs/customer-onboarding-runbook.md:61`
✅ **The phone channel is live and marketable** (verified 2026-08-17 against code + pilot DB, not
docs): merged to `main` as `7f59a54` plus two follow-ups, migration applied, **7 calls ingested
across 1 number, most recent 2026-08-11**. Inbound calls are answered, transcribed, intent-classified,
and card/SSN-redacted before the transcript is written — landing on the same customer record as the
technician's voice note and the manager's email.

Say "it works," not "proven at volume" — 7 calls is live-verified, not load-tested.

*An earlier version of this file said the phone channel was unmerged and undeployed, copied from a
runbook status gate that had been stale for eleven days. It caused two wrong recommendations before
anyone checked the code. When a claim here decides whether something can be marketed, verify it
against the repo or the database, not against another doc.*

**Tone constraint that should shape every nudge/proactivity message:**

> "A thing that notices you're behind schedule and asks about it is an ops manager **or a
> surveillance system depending entirely on tone, disclosure, and defaults.** The nudge arrives as a
> colleague's question, not an audit."
> — `thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md:104`

**Off-limits sources:** `docs/Physical-Data-Exchange-Direction.md` is exploratory, lawyer-gated,
nothing built — **nothing from it goes in external copy**, and its market valuations are
self-flagged as unsourced. The "intelligent spine / team-leader agent" is **direction only**; if
used, mark it roadmap. `thoughts/shared/plans/2026-08-15-intelligent-spine-direction.md:130`

## 10. Open gaps — ask the user, never invent

1. **Price.** No dollar amount exists anywhere — per-seat price, billing period, minimum, setup fee
   all unrecorded. (Model is seat-based; manager seats price higher than technician seats.)
2. **Current customers.** Zero active external as recorded. Are there paying firms now? Nameable?
3. **Outcome proof.** Nothing. Any pilot anecdote or quote we can use?
4. **Category & competitive stance.** Alternative to FSM, layer on top of it, or new category? The
   repo never picks.
5. **Geography.** US implied by CCPA/BIPA framing; no stated target market.
6. **Phone channel** — live yet? Strong story if so.
7. **Roadmap marketability** — may the intelligent-spine direction appear in public copy?

When a task needs one of these, **ask** — don't fill the hole with a plausible number. Per this
repo's standing rule, an uncited claim is an unverified claim.
