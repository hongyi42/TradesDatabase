# TradesDatabase — Competitive & Market Research

**Report type:** Market landscape + competitive positioning analysis
**Prepared for:** Founder / product owner
**Date of research:** 19 August 2026
**Version:** 1.0
**Status:** Baseline. Supersedes nothing; this is the first market-facing analysis in the repo.
**Author:** Claude (Opus 5), from live web research + a full read of the repo's product docs.

---

## Document control

| Field | Value |
|---|---|
| Research window | All web sources retrieved 19 Aug 2026 |
| Product baseline | `feat/customer-billing-portal` @ `292665c`, plus `docs/` and `thoughts/shared/` |
| Refresh cadence | Recommend every 6 months, or on any competitor funding/major-launch event |
| Confidence | See §2.3. Market sizing is **medium**; competitor pricing is **mixed** (see grading) |

### Source-quality legend

This report grades every load-bearing claim, because this category is unusually polluted by
SEO content. Competitor comparison pages are frequently written *by competitors* (e.g. the
"Housecall Pro alternatives" article published on workiz.com), and pricing "analyses" are often
lead-generation pages for a fourth vendor. The repo already learned this lesson once — a vendor-layer
audit in `Physical-Data-Exchange-Direction.md` §9.9 found that **every per-hour market price in the
training-data space traced back to unsourced SEO content**. Same discipline applies here.

| Grade | Meaning |
|---|---|
| **[P]** | **Primary** — the vendor's own live page, an earnings release/call, or government statistics |
| **[S]** | **Secondary** — reputable trade press, major business media, or a named research firm |
| **[T]** | **Tertiary** — comparison blogs, aggregators, competitor-authored pages. Directionally useful, individually unreliable |

---

## 1. Executive summary

### 1.1 The one-paragraph version

Field service management (FSM) software is a **$6–7 billion global market growing at roughly
10–16% a year**, and it is in the middle of its second platform shift in a decade. The first shift
(2015–2022) moved trades firms from paper and whiteboards onto scheduling-and-invoicing suites —
ServiceTitan, Jobber, Housecall Pro, Workiz. The second shift, happening right now, is **AI agents
absorbing the labour those suites merely organised**: answering the phone, booking the job,
generating the quote. That second shift is where all the money and all the attention currently sit.
TradesDatabase is not competing in either of those races. It is building something the whole field
has skipped: **a customer/job record where every structured fact is linked to the raw evidence it
came from**, and an AI layer that can only make claims it can cite. That is a genuine, defensible
difference — and it is also, today, attached to a product with no invoicing, no price book, no
phone-answering, and one live external customer.

### 1.2 The five findings that matter

**Finding 1 — The competitive centre of gravity moved to the phone, and we are not on it.**
The hottest, best-funded category in home services right now is the **AI voice receptionist**.
Avoca raised $125M+ at a **$1B valuation in April 2026** with 800+ customers **[S]**; Netic raised
$23M from Founders Fund **[S]**; every incumbent has shipped one (Workiz Genius Answering, Housecall
Pro CSR AI, Jobber Receptionist at $29/mo, ServiceTitan Contact Center Pro Virtual Agents) **[P]**.
TradesDatabase's phone channel *records and transcribes* calls into the spine — it does not *answer*
them. This is the single largest gap between what we have and what the market is currently buying.

**Finding 2 — Nobody is selling provenance, and enterprise buyers are starting to ask for it.**
Every competitor's AI is a black box on top of their own database. ServiceTitan's own Titan
Intelligence page discloses **no retrieval sources, no verification method, no grounding detail** **[P]**.
Meanwhile 74% of organisations name inaccuracy as a highly relevant AI risk, and "the audit trail
doesn't show which source grounded a claim" is emerging as a named enterprise objection **[S]**.
Our `validateCitations` grounding check and `source_capture_id` provenance chain are an answer to a
question the market has begun to ask but no vendor in this category is answering.

**Finding 3 — The #1 documented failure mode of FSM software is our core design bet.**
The industry's own literature says it plainly: adoption fails because *"technicians refuse to use
[the app] because the mobile app is clunky or the job completion process requires too many steps"* **[T]**,
and change management/user adoption ranks in the top 3 challenges for 37% of service organisations **[T]**.
Our answer — no app at all, just a Telegram chat and a voice note — attacks that failure mode at the
root. It is the most commercially interesting thing about the product and the hardest to prove.

**Finding 4 — Pricing transparency is a real, unclaimed differentiator.**
Verified directly against live vendor pages: **Jobber publishes every price** ($49–$499/mo, $29/extra
user, AI Receptionist $29/mo) and **Housecall Pro publishes plan prices** ($79/$189/$329) but hides
eleven add-ons behind "contact us" — including CSR AI **[P]**. **Workiz publishes no prices at all**
(three tiers, all "Request pricing") **[P]**. **ServiceTitan publishes no prices at all** (Starter /
Essentials / The Works, all "Request Pricing") **[P]**, with third-party estimates of $245–$500 per
technician per month plus $5,000–$50,000 implementation **[T]**. AI voice pricing is worse: Avoca
publishes nothing and is billed per-minute **[T]**. A firm literally cannot forecast its bill.

**Finding 5 — We are a pilot, not a product, and the gap is commercial, not technical.**
Two tenants, one real external customer (onboarded 2026-07-07), one 16GB Lightsail box with roughly
three sandbox slots left, no published price, and no revenue system until the current branch lands.
The engineering is unusually disciplined for this stage. The company is not yet a company.

### 1.3 The strategic conclusion

> **Do not compete as a field service management suite.** We would be entering a mature category
> against a $961M-revenue public incumbent and two well-funded SMB suites, needing invoicing,
> payments, price books, estimates, memberships, payroll and QuickBooks integration just to reach
> the starting line.
>
> **Compete as the context layer** — the record, the memory, and the evidence chain that the
> AI-agent era makes valuable and that no incumbent has built. Then make one explicit decision
> (§12) about whether the phone front door is something we build, partner for, or deliberately cede.

---

## 2. Scope and methodology

### 2.1 Questions this report answers

1. What is the market, how big is it, and who is in it?
2. What do the leading competitors actually do, charge, and claim?
3. Where is the category heading over the next 12–24 months?
4. What does TradesDatabase actually do, precisely, today?
5. Where are we genuinely different, where are we at parity, and where are we behind?
6. What should we do about it?

### 2.2 Method

```
  ┌─────────────────────────┐      ┌──────────────────────────┐
  │  OUTSIDE-IN             │      │  INSIDE-OUT              │
  │  live web research      │      │  full repo read          │
  │  • vendor pricing pages │      │  • docs/ (all 10 files)  │
  │  • earnings releases    │      │  • MCP tool inventory    │
  │  • trade & business     │      │  • product principles    │
  │    press, funding news  │      │  • plans + research      │
  │  • US Census / BLS      │      │    artifacts             │
  │  • analyst market sizing│      │  • live-state snapshot   │
  └───────────┬─────────────┘      └────────────┬─────────────┘
              │                                  │
              └──────────────┬───────────────────┘
                             ▼
              ┌──────────────────────────────┐
              │  Differentiation analysis    │
              │  graded: REAL / PARTIAL /    │
              │  PARITY / GAP  (§9)          │
              └──────────────────────────────┘
```

Competitor capability claims were taken **from the vendor's own page wherever one exists**, and
graded down when only third-party sources were available. Where a widely-repeated number could not
be traced to a primary source, it is marked and its unreliability stated rather than quietly dropped.

### 2.3 Limitations — read these before quoting anything

- **Pricing for ServiceTitan and Workiz is not verifiable.** Both publish tier names and no numbers.
  Every dollar figure for them in this report is a third-party estimate **[T]** and should be treated
  as a range, not a fact.
- **Two funding/valuation aggregators returned obviously corrupt data** (one lists Jobber's valuation
  as "$2.5M" alongside $100M ARR; another lists Housecall Pro's valuation as "$111.6M" against a
  documented $1.1B+). Neither is cited in this report. This is a good illustration of why the grading
  legend exists.
- **Market sizing is a range, not a number.** Four research firms give 2026 FSM market sizes between
  $5.88B and $6.7B and CAGRs between 9.5% and 16% **[S]**. Methodologies are not comparable. Use the
  range; never quote a single firm's figure as "the" market size.
- **No customer interviews were conducted.** Everything about buyer preference here is inferred from
  published material, not from talking to trades firms. §13 flags this as the highest-value gap.
- **Competitor AI capability claims are marketing copy.** "Genius Answering books the job" is what
  Workiz says it does, not something observed. Only ServiceTitan's numbers are audited (public company).

---

## 3. Market definition and sizing

### 3.1 What category are we in?

**Field Service Management (FSM) software** — the system a business uses to run work that happens at
someone else's location. In plain terms: *who is going where, when, to do what, and did we get paid.*

The category subdivides by customer type, and the divide matters because the products barely compete:

| Sub-segment | Who | Typical vendor |
|---|---|---|
| **Residential home services** | HVAC, plumbing, electrical, pest, roofing, appliance repair, garage door, locksmith | ServiceTitan, Jobber, Housecall Pro, Workiz |
| **Commercial / specialty contracting** | Service contracts, GC relationships, project + service work | BuildOps, Simpro, FieldEdge |
| **Enterprise field workforce** | Utilities, telecom, medical devices, industrial equipment | Salesforce Field Service, SAP, IFS, Skedulo |

**TradesDatabase sits in residential home services**, at the small end: firms of roughly 5–50 people.
That is stated in `docs/Three-Layer-Context-Spine-Overview.md` §1 and is the right call — it is the
segment where the manager is still personally routing information by hand, which is the exact pain
the spine addresses.

### 3.2 Market size — three nested circles

```
┌──────────────────────────────────────────────────────────────────────┐
│ TAM — Global FSM software, 2026                                      │
│ $5.88B – $6.7B, growing 9.5% – 16% CAGR                              │
│ (Grand View $6.7B/11%; Mordor $6.26B/9.54%; GMI $6.21B/16%;          │
│  Research&Markets $5.88B/14.4%; Technavio 14.8%)              [S]    │
│                                                                      │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ SAM — US residential trades, our shape of buyer                │  │
│  │ ~387,000 US establishments across the six core home-services   │  │
│  │ trades, ~3.45M employees                                [P/S]  │  │
│  │ HVAC+plumbing alone (NAICS 238220): 109,601 establishments,    │  │
│  │ 1,176,759 employees, $297.6B receipts (2022 Census)      [P]   │  │
│  │                                                                │  │
│  │  ┌──────────────────────────────────────────────────────────┐  │  │
│  │  │ SOM — firms of 5–50 people who would buy a chat-native   │  │  │
│  │  │ context product. See the assumption stack below.         │  │  │
│  │  │ Order of magnitude: tens of thousands of firms.          │  │  │
│  │  └──────────────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

**The SOM assumption stack — stated openly so it can be argued with:**

| Step | Assumption | Result |
|---|---|---|
| Start | US establishments, six core home-service trades **[P/S]** | 387,000 |
| Filter 1 | Share with 5–50 employees (most establishments are 1–4 person shops) — **assumed 25%, unverified** | ~97,000 |
| Filter 2 | Share already running *some* FSM software (rest are on paper/QuickBooks) — assumed 50% | ~48,000 |
| Filter 3 | Share willing to run their business through a consumer messenger — **assumed 20%, the single riskiest number here** | ~9,700 |
| Revenue | At an assumed $150/seat/mo × avg 8 seats = $14.4k/firm/yr | **~$140M annual revenue opportunity** |

> ⚠️ **Filters 1 and 3 are guesses, not research.** The Census does not publish a clean
> establishment-size split for these NAICS codes in the sources retrieved, and nobody has measured
> willingness to run a trades business on Telegram because nobody has offered it. Treat the $140M as
> *an order of magnitude that says "this is a real business if it works,"* not as a forecast. §13
> lists what would need to be measured to firm it up.

### 3.3 What is driving demand

**Driver 1 — The labour shortage is structural and worsening.** Over 530,000 skilled trade positions
are unfilled in the US in 2026, and an estimated 2.1 million could go unfilled by 2030 **[S]**. Nearly
30% of HVAC technicians are over 55, roughly 25,000 experienced technicians leave the workforce each
year, and more than one in five plumbers is over 55 **[S]**. Construction workers who changed employers
in June 2026 got an average 12.9% pay rise — nearly double the all-industry figure **[S]**.

*Why this matters to us specifically:* when a 30-year technician retires, their knowledge of which
customer has the dog, which gate code, which unit was patched in 2019, walks out with them. That is
**exactly** what L1 + L3 preserve. This is our strongest macro tailwind and it is not currently in
our messaging.

**Driver 2 — Private equity consolidation is creating sophisticated buyers.** PE has bought roughly
800 HVAC, plumbing and electrical companies since 2022 and now accounts for about half of all
HVAC-services deals; 66–76 active PE-backed platforms operate in 2026; Apollo agreed to put ~$2B into
Apex Service Partners at a ~$10B valuation in May 2026 **[S]**. Businesses being groomed for sale care
enormously about clean, auditable, exportable data — a buyer's diligence process is a provenance
audit. That is a second, unexploited fit for our architecture.

**Driver 3 — AI has reset what "good" looks like.** ServiceTitan reports AI adoption *more than
doubling* among commercial contractors **[P]**, and its own AI programme (Max) shows customers
reporting ~50% higher average ticket and EBITDA moving from 18% to 30% **[P, vendor-reported]**.
Contractors are now actively shopping for AI, which lowers the education cost for an AI-native entrant.

**Driver 4 — The category is proven and funded.** ServiceTitan's FY2026 revenue was **$961M, up 24%**,
with ~10,800 active customers and 80% platform gross margin; FY2027 guidance is **$1.11–1.12B** **[P]**.
Nobody has to be convinced that trades software is a real market any more.

### 3.4 Headwinds and structural risks

| Headwind | Why it bites |
|---|---|
| **Incumbent AI bundling** | Every capability we might charge for, an incumbent can bundle at near-zero marginal price to protect a $250–500/tech/mo subscription. Jobber's AI Receptionist at **$29/mo** is a bundling move, not a pricing decision. |
| **Switching costs are enormous** | Contractors report ~$22,000 exit quotes and severe difficulty exporting data from ServiceTitan **[T]**, plus 12-month minimum contracts **[T]**. Lock-in cuts both ways: it makes incumbents hard to displace, and it makes their customers angry — which is a wedge. |
| **Trades firms are conservative buyers** | They buy from peers, trade shows and trade press. Avoca's own account of reaching its first 10 customers is "network effects, trade shows, and conferences" **[S]**. There is no product-led-growth shortcut here. |
| **Consumer-messenger dependency** | Our entire UI depends on Telegram's policies, uptime, and bot API. No competitor carries this risk; we carry it alone. |
| **AI cost volatility** | Inference prices move under us — the repo already records DeepInfra moving $0.95→$0.93 mid-planning, and a ~20% fall since trial. Good for margins now; unpredictable as a basis for pricing. |

---

## 4. Competitive landscape

### 4.1 The map

Two axes actually separate this market: **how much of the business the product runs** (a single job
to be done, versus the whole operation) and **how AI-native it is** (AI bolted onto a records system,
versus AI as the product).

```
                        AI-NATIVE (AI is the product)
                                   ▲
                                   │
              Avoca ($1B)  ●       │
              Netic        ●       │        ● ServiceTitan "Max"
              Sameday      ●       │          (suite retrofitting
              ServiceAgent ●       │           itself into agents)
              Rilla        ●       │
                                   │      ◆ TRADESDATABASE
   ─────────────────────────────── ┼ ────────────────────────────────▶
   POINT SOLUTION                  │                    FULL SUITE
   (one job to be done)            │              (runs the business)
                                   │
                                   │        ● Workiz
                                   │        ● Housecall Pro
                                   │        ● Jobber
                                   │        ● Service Fusion, FieldEdge,
                                   │          ServiceM8, Zuper, BuildOps
                                   │
                        RECORDS-FIRST (AI added on)
```

**Read the diamond carefully.** TradesDatabase is plotted AI-native and mid-scope — and that
position is *aspirational, not achieved*. We are AI-native in truth. We are **not** a full suite:
we have no invoicing, payments, price book, or estimates. The honest plot today is further left than
drawn. §9.4 lists exactly what is missing.

### 4.2 The three tiers, and who should worry about whom

| Tier | Who | Serves | Threat level to us |
|---|---|---|---|
| **1 — Enterprise incumbent** | ServiceTitan | $15M+ revenue, multi-branch | **Low direct / high indirect.** They will never chase a 10-person shop, but they define what "AI for the trades" means and they set buyer expectations. |
| **2 — SMB suites** | Jobber, Housecall Pro, Workiz, Service Fusion, ServiceM8, FieldEdge, Zuper | 1–50 people — **our exact buyer** | **Highest.** These own the account, the billing relationship, and the data. Displacing one is the actual sales motion. |
| **3 — AI-native point solutions** | Avoca, Netic, Sameday, ServiceAgent, Rilla, Hatch | Any size, one job to be done | **Medium and rising.** They don't replace us and we don't replace them — but they are eating the budget and the attention we would need, and they are far better funded. |

---

## 5. Competitor profiles

Each profile uses the same template so they can be compared line by line.

### 5.1 ServiceTitan — the incumbent that defines the category

| | |
|---|---|
| **Positioning** | The operating system for the trades; increasingly, "an Agentic Operating System" **[S]** |
| **Serves** | Large residential and commercial HVAC/plumbing/electrical; sophistication above ~$15M revenue **[T]** |
| **Scale** | FY2026 revenue **$961M (+24% YoY)**, ~**10,800 active customers**, 80% platform gross margin, 10.7% operating margin. FY2027 guidance **$1.11–1.12B** **[P]** |
| **Pricing** | **Not published.** Three tiers — Starter, Essentials, The Works — all "Request Pricing"; the page states per-technician pricing with no rate **[P]**. Third-party estimates: $245–$500/tech/mo, $5,000–$50,000 implementation, 12-month minimum **[T]** |

**AI stack (all [P] from vendor pages):**
- **Titan Intelligence** — the AI umbrella. Named products: **Atlas** ("AI sidekick… able to handle
  tasks, surface insights, and even take action"), Ads Optimizer, Job Value Predictor, Second Chance
  Leads, Price Insights, Benchmark Report, Review Response Generator, Invoice/Email Generators,
  Risky Driver Detection.
- **Max** — the flagship AI programme, launched as a pilot at Pantheon 2025. Voice agents answer
  inbound calls and book; AI auto-generates field quotes; agents detect available capacity and
  throttle demand generation to fill it **[S]**. Priced **per-technician**, while Virtual Agents are
  usage-based consumption **[S]**.
- **Field Pro** — auto-records the job on arrival with built-in consent, instant AI transcripts,
  full job context **[P]**.
- **Contact Center Pro Virtual Agents** — launched April 2026 **[P]**.

**Strengths:** deepest scheduling/dispatch engine in the segment; a genuine data moat from
10,800 customers' aggregate data; public-company credibility; the industry's benchmark reports.

**Weaknesses:** cost; complexity ("overcomplicated interface", slow support, long onboarding **[T]**);
brutal exit economics (~$22k exit quotes, difficult data export, 30-day cancellation windows **[T]**);
API access gated behind a request form and a paid tier **[T]**.

**What this means for us:** they are not our competitor, they are our **weather**. Two specific
implications: (1) Their Field Pro auto-transcription proves the "capture the job verbatim" thesis is
correct — a public company is investing in it. (2) Their exit-cost reputation is the strongest
argument we have for a portable, provenance-linked, exportable record.

---

### 5.2 Workiz — the phone-centric SMB suite, and our closest philosophical rival

| | |
|---|---|
| **Positioning** | "AI growth engine" for home services — AI and communication integrated at every step **[P]** |
| **Serves** | SMB trades with high inbound call volume: appliance repair, locksmiths, garage door, HVAC **[T]** |
| **Pricing** | **Not published.** Three tiers — Standard, Pro, Ultimate — all "Request pricing" **[P]**. Third-party estimates: $187–$270/mo (older labels Kickstart/Standard/Pro at $225/$275/$325 elsewhere), plus ~$40–$65 per extra user, plus phone system ~$100/mo and Genius Answering ~$200/mo as separate add-ons **[T — figures conflict across sources; treat as a range]** |

**AI stack ([P] from vendor pages):** **Genius AI Answering** (answers calls so "no lead slips
through"; also handles email and text, acts as a dispatcher across channels; schedules and reschedules
within policies you set; English and Spanish; customisable name, voice, data collected, policies) —
launched Dec 2024 **[T]**. Plus **Genius Scheduling** ("converts inquiries into scheduled jobs,
instantly"), **Genius Marketing**, **Genius Phone**. Notably, Genius Leads and Genius Scheduling
require the Pro tier; Answering, Phone and Marketing are all **separately-sold add-ons** **[P]**.

**Strengths:** the most coherent story in the SMB tier — the phone is the front door, so own the
phone. Call tracking with lead attribution back to the ad or number that generated the call **[T]**.
First-mover among suites on AI answering.

**Weaknesses:** total opacity on price, with three separate add-on meters (users, phone, answering)
stacking on an unpublished base — the buyer cannot forecast the bill. Depth thins out beyond
call-driven trades.

**What this means for us:** Workiz is the sharpest competitive threat in the SMB tier because it is
*also* organised around a single strong idea rather than a feature list. Their idea is "own the
inbound call." Ours is "own the record." Theirs monetises faster; ours compounds longer. Worth
studying their go-to-market closely.

---

### 5.3 Jobber — the transparency benchmark

| | |
|---|---|
| **Positioning** | Approachable, fast-to-learn software for small home-service businesses |
| **Serves** | Solo operators through small residential teams; ~100,000 customers, ~600 employees **[T]** |
| **Funding** | $100M Series D, Feb 2023, led by General Atlantic; ~$184M total **[S]** |
| **Pricing** | **Fully published [P]** — see table below. This is the most transparent vendor in the category and a useful reference point. |

| Plan | Monthly | Annual (prepaid) | Users included |
|---|---|---|---|
| Core | $49/mo | $21/mo | 1 |
| Connect | $139/mo | $70/mo | 1 |
| Grow | $199/mo | $105/mo | 5 |
| Plus | $499/mo | $280/mo | 15 |

Extra users **$29/mo** each on every plan. Add-ons: **Receptionist $29/mo** ("24/7 customer service
over call or text"), Pipeline $49/mo, Marketing Suite $99/mo **[P]**. Card processing 2.9% + 30¢,
ACH 1% **[T]**.

**AI stack:** **Jobber Copilot** — an advisory assistant answering questions from your Jobber data,
handling marketing content, business analysis and product coaching. Important nuance: **Copilot
answers questions; it does not answer your phone** **[T]**, and it is currently free in beta **[T]**.
The phone-answering product is the separate $29/mo Receptionist add-on **[P]**.

**Strengths:** price transparency builds trust; low entry price ($21/mo annual); huge installed base;
genuinely easy onboarding.

**Weaknesses:** shallow relative to ServiceTitan on dispatch and reporting; Copilot is an analytics
chatbot, not an operator; the $29 Receptionist is a defensive bundle rather than a serious voice product.

**What this means for us:** Jobber sets the **price anchor** our buyer carries in their head. A 8-person
shop on Jobber Grow pays $105/mo annual + 3 extra users ($87) ≈ **$192/mo**. Any price we name will be
compared to that number, not to ServiceTitan's.

---

### 5.4 Housecall Pro — the mid-market SMB suite

| | |
|---|---|
| **Positioning** | All-in-one home services platform; recently launched trade-specific versions for HVAC, plumbing, electrical **[S]** |
| **Serves** | ~20,000 customers, ~1,500 employees **[T]** |
| **Funding** | Unicorn — **$1.1B valuation**, $125M Series D (June 2022), ~$175M total **[S]** |
| **Pricing** | Plans published, add-ons hidden **[P]** |

| Plan | Monthly | Annual | Users | Extra user |
|---|---|---|---|---|
| Basic | $79 | $59 | 1 | — |
| Essentials | $189 | $149 | 5 | $100/mo |
| Max | $329 | $299 | 8 | $75/mo |

**AI stack:** **CSR AI** (AI call handling and appointment booking), **HCP Assist** (24/7 *human*
live answering), **Voice** (phone system: routing, recording, tracking), **Marketing AI** (email
writing, included on all plans) **[T]**.

**The finding worth flagging:** verified live, **eleven add-ons carry no published price** on Housecall
Pro's own pricing page — CSR AI, Sales Proposal Tool, Pipeline, Payroll, Accounting, Business Coaching,
Voice, Campaigns, VGPS/Dashcams, Tap to Pay, Websites **[P]**. The published plan price is a floor,
not a bill. Note also the extra-user cost: **$100/mo** on Essentials is more than three times Jobber's $29.

**What this means for us:** Housecall Pro's per-user economics are punitive at exactly the size we
target. An 8-person shop that outgrows Essentials pays $149 + 3×$100 = **$449/mo** before a single
add-on. That is a live, quantified wedge.

---

### 5.5 The rest of the SMB suite tier (brief)

| Vendor | Serves | Pricing **[T]** | Note |
|---|---|---|---|
| **Service Fusion** | HVAC, plumbing, electrical, appliance repair | From **$195/mo flat** — unlimited users | The flat-rate model is the direct answer to Housecall Pro's per-user pain. Relevant pricing precedent for us. |
| **ServiceM8** | Small shops up to ~30 staff | From **$29/mo** | The cheap floor of the market. |
| **Zuper** | Mid-size to larger; asset tracking, SLA compliance | From **$55/user/mo** | Feature-rich, customisation-heavy. |
| **FieldEdge** | Commercial electrical, fire/life safety | Not published | Project + service work. |
| **BuildOps** | Commercial specialty contractors, service agreements, GC relationships | Not published | Different buyer to ours. |

### 5.6 The AI-native tier — where the money is going

**Avoca — the category's breakout.** AI voice agents for HVAC, plumbing, roofing, electrical.
Answers calls instantly based on technician availability, schedules jobs **in the customer's existing
CRM**, reschedules, and transfers to humans. **$125M+ raised at a $1B valuation, announced 27 April
2026** (Series A Kleiner Perkins, Series B Meritech + General Catalyst); **800+ customers**; targeting
a market it describes as $50B **[S]**. Pricing not published; per-minute billing, third-party estimate
$1,000–$3,500/mo **[T]**.

**Netic** — "autonomous AI revenue engine" for plumbing and roofing: AI agents independently handle
calls, texts and web chat, integrating with existing CRM/FSM. "Netic Brain" trained on service-industry
workflows. **$23M Series B led by Founders Fund**, following a $20M launch **[S]**.

**Rilla** — speech analytics for in-home sales conversations; records and analyses the rep's pitch.
Estimated **$70M ARR in April 2026**, up from $51M in 2025; Home Depot partnership announced Jan 2026 **[S]**.

**Sameday** — AI answering with, unusually, **published pricing**: from **$449/mo for 500 minutes**,
**$789/mo for 1,000** (≈$0.79–$0.90/minute) **[T]**.

**ServiceAgent** — usage-based: from $39/mo plus credits, ≈$0.30–$0.60 per talk minute **[T]**.

**Hatch** — automates outbound texting/follow-up **[S]**.

**The pattern to notice:** every one of these companies **integrates with the incumbent FSM rather
than replacing it.** Avoca books into your existing CRM. Netic integrates with your CRM/FSM. They
have chosen to be a layer, not a system of record — because the system of record is expensive to
displace and boring to sell. This is directly relevant to our own strategy (§12).

---

## 6. Comparison matrices

### 6.1 Pricing — what an 8-person shop actually pays per month

Calculated on published rates where they exist; ranges where they do not. This is the number our
buyer compares us against.

| Vendor | Base | Extra users | Est. monthly, 8 people | Transparency |
|---|---|---|---|---|
| **ServiceM8** | $29 | included to 30 | **~$29** | Published **[T]** |
| **Jobber Grow** (annual) | $105 (5 users) | $29 × 3 | **~$192** | **Fully published [P]** |
| **Service Fusion** | $195 flat | unlimited | **~$195** | Published **[T]** |
| **Workiz** | ~$229 (est.) | ~$46 × 3 | **~$367 + phone ~$100 + answering ~$200** | **None published [P]** |
| **Housecall Pro Essentials** (annual) | $149 (5 users) | $100 × 3 | **~$449** + hidden add-ons | Plans only **[P]** |
| **Housecall Pro Max** (annual) | $299 (8 users) | — | **~$299** + hidden add-ons | Plans only **[P]** |
| **ServiceTitan** | per-tech | — | **~$1,960–$4,000** + $5k–$50k implementation | **None published [P]** |
| **Avoca** (add-on only) | — | — | **~$1,000–$3,500** | **None published [T]** |
| **TradesDatabase** | *not yet priced* | *seat-based* | **—** | **— (opportunity)** |

> **The insight:** the SMB band an 8-person shop lives in is **roughly $200–$450/month**, and the
> AI-answering products cost *more than the entire FSM suite they attach to*. Any price we set should
> be anchored to that band, and our willingness to publish it is free differentiation against Workiz
> and ServiceTitan.

### 6.2 AI capability — who does what

Legend: ✅ shipped · 🟡 partial/limited · ❌ absent · ❓ claimed, unverifiable

| Capability | ServiceTitan | Workiz | Jobber | Housecall Pro | Avoca/Netic | **TradesDatabase** |
|---|---|---|---|---|---|---|
| AI answers inbound phone & books | ✅ (Max/Contact Center) | ✅ (Genius Answering) | 🟡 ($29 Receptionist) | ✅ (CSR AI) | ✅ (their whole product) | **❌ — capture only** |
| Records & transcribes the job | ✅ (Field Pro) | ❓ | ❌ | ❌ | 🟡 (calls only) | **✅ (SignalWire + AssemblyAI)** |
| Technician voice note → structured record | 🟡 | ❌ | ❌ | ❌ | ❌ | **✅ (`record_field_note`)** |
| Conversational assistant over your own data | ✅ (Atlas) | 🟡 | ✅ (Copilot) | 🟡 | ❌ | **✅ (`answer_customer_question`)** |
| **Every claim carries a verified citation** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ (`validateCitations`)** |
| **Raw source preserved & re-processable** | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ (append-only L1)** |
| AI scheduling / route optimisation | ✅ (most mature) | ✅ | 🟡 | 🟡 | ❌ | **✅ (freeze / resolve)** |
| Constraint vocabulary for customer promises | ❌ | ❌ | ❌ | ❌ | ❌ | **✅ (promise ladder)** |
| Quote / estimate generation | ✅ (Max) | ✅ (Ultimate) | ✅ | ✅ | ❌ | **❌** |
| Invoicing & payments | ✅ | ✅ | ✅ | ✅ | ❌ | **❌** |
| Price book | ✅ | ✅ | 🟡 | ✅ | ❌ | **❌** |
| Marketing automation | ✅ | ✅ (Genius Marketing) | ✅ ($99) | ✅ | 🟡 (Hatch) | **❌** |
| QuickBooks / accounting integration | ✅ | ✅ | ✅ | ✅ | ❌ | **❌** |
| Mobile app for technicians | ✅ | ✅ | ✅ | ✅ | n/a | **❌ by design (Telegram)** |

Read the two bold rows in the middle. **Those two rows are the entire strategic argument of this
report**, and the four rows at the bottom are the entire commercial objection.

---

## 7. Where the market is going

**Trend 1 — From "software that records work" to "agents that do work."** ServiceTitan is explicitly
repositioning as an "Agentic Operating System" where AI agents and humans co-orchestrate workflows **[S]**.
Workiz calls itself an "AI growth engine" **[P]**. The record-keeping suite is becoming table stakes;
the labour replacement is the product. **We are already on the correct side of this trend** — our agent
*is* the interface — which is a bigger deal than it may feel from inside the repo.

**Trend 2 — The phone is the beachhead, and it is being taken now.** Every serious player entered
voice within 18 months of each other. The logic is obvious: a missed call is a lost job with a
directly attributable dollar value, which makes ROI trivially provable and the sale easy. Nothing
else in this category sells that cleanly.

**Trend 3 — Pricing is fragmenting into three incompatible models.** Per-seat (Jobber, Housecall Pro,
ServiceTitan), per-minute (Avoca, Sameday, ServiceAgent), and per-outcome (emerging). ServiceTitan is
running two at once — Max per-technician, Virtual Agents usage-based **[S]**. Buyers are confused and
increasingly cannot forecast spend. **Predictable, published pricing is becoming a differentiator in
its own right.**

**Trend 4 — Grounding and auditability are moving from engineering concern to purchase criterion.**
74% of organisations rate inaccuracy a highly relevant AI risk **[S]**; buyers are beginning to ask
which source grounded a claim and which checks ran, and to treat undocumented controls as a compliance
problem **[S]**. Home services is behind regulated industries here — but PE-owned platforms doing
diligence will drag it forward.

**Trend 5 — Integration, not replacement, is the winning AI-native play so far.** Avoca, Netic, Rilla
and Hatch all sit *on top of* the incumbent system of record. That is why they can grow fast: no
migration, no data conversion, no retraining. It is also why their long-term position is weaker —
they don't own the record.

---

## 8. What TradesDatabase actually is

Grounded entirely in the repo, so the comparison in §9 rests on facts rather than aspiration.

### 8.1 The core idea in one diagram

The product's foundation is the **three-layer context spine**: one customer/job record, split by how
certain and how structured each piece of information is.

```
        ┌─────────────────────────────────────────────────────────┐
        │  L1 — RAW  (raw_captures)                               │
        │  Verbatim, APPEND-ONLY. Voice notes, emails, call       │
        │  transcripts, photos. Lossless ground truth.            │
        │  Cannot be updated. Cannot be deleted. Ever.            │
        └───────────────┬─────────────────────────────────────────┘
                        │  model extraction  +  deterministic identity match
                        ▼
        ┌─────────────────────────────────────────────────────────┐
        │  L2 — STRUCTURED                                        │
        │  customers ──(1:N)── jobs ──(1:N)── visits              │
        │  Only fields the business acts on deterministically.    │
        │  Every row carries `source_capture_id` → its evidence.  │
        └───────────────┬─────────────────────────────────────────┘
                        │
                        ▼
        ┌─────────────────────────────────────────────────────────┐
        │  L3 — ATTRIBUTES  (JSONB on each L2 row)                │
        │  "dog on property", "prefers afternoons", "gate 1234"   │
        │  Each standing fact stored WITH the capture proving it. │
        │  Retract the evidence → the fact leaves default reads.  │
        └─────────────────────────────────────────────────────────┘
```

**The governing principle, verbatim from the design doc:** *structure only what you must act on
deterministically (L2); preserve everything else verbatim (L1); capture the in-between in flexible
attributes (L3); and link every structured field back to the raw evidence it came from.*

**Why a non-engineer should care.** Three consequences fall out of this, and each is a sales argument:

1. **A bad AI extraction is never permanent.** The original is preserved, so extraction can be re-run
   later with a better model — with zero data loss. Every competitor's AI writes into fields and the
   original is gone.
2. **A technician can ask what the last technician *actually said*** — and get the verbatim words,
   not a summary of a summary.
3. **Every answer can be traced.** "Why does the system think this customer has a dog?" has an answer,
   with a date and a source.

### 8.2 How a message travels through the system

```
 Technician's phone
   │  Telegram voice note                     Telegram Mini App ("the board")
   ▼                                                    ▼
 trades-box-1 (AWS Lightsail, static IP)
   per-person sandboxes — each holds ONE revocable badge, never a real secret
   │
   ▼
 doorman (runs on the host, OUTSIDE the sandbox)
   translates: static badge ──▶ signed identity (HMAC headers)
   │
   ▼
 Render — the spine MCP server
   verifies the signature, resolves identity FROM THE HEADER (never a tool argument)
   │
   ├─▶ L1 append (verbatim, deduped)
   ├─▶ model extraction (structured fields)
   ├─▶ deterministic identity match  ← hardcoded, never a model guess
   └─▶ L2 / L3 write, with provenance
```

**The one piece worth explaining in plain language:** the **doorman**. Each technician's AI agent runs
in its own sandbox and carries only a *badge* — a random token that means nothing to anyone except the
doorman. The doorman, running outside the sandbox, exchanges that badge for a cryptographically signed
identity. If a badge is stolen it is useless and individually revocable, and the agent itself can never
claim to be someone else, because identity comes from the signed header and never from anything the
agent says. Most SMB software in this category has nothing comparable.

### 8.3 Feature inventory — what exists today

Roughly **40 MCP tools** (a manager tier sees all; a technician tier sees 14), grouped:

| Group | Tools | Status |
|---|---|---|
| **Write path** | `record_field_note`, `record_standing_fact`, `retract_capture` | Live |
| **Read / synthesis** | `brief_customer`, `answer_customer_question`, `get_customer_context`, `find_customer`, `get_job`, `list_recent_captures`, `query_spine` | Live, citation-grounded |
| **Scheduling — single visit** | `book_visit`, `move_visit`, `unschedule_visit`, `cancel_job`, `set_visit_locks`, `set_promise`, `find_slots`, `get_schedule`, `get_team_schedule` | Live |
| **Scheduling — batch optimisation** | `run_freeze` (weekly plan via Google Route Optimization), `run_resolve` (horizon re-optimiser), `undo_run` | Live |
| **Capacity & config** | `set_availability`, `get_availability`, `add_time_off`, `remove_time_off`, `set_job_duration`, `set_technician_skills`, `set_technician_horizon` | Live |
| **People / control plane** | `add_technician_seat`, `deactivate_technician_seat`, `reactivate_technician_seat`, `list_team`, `bind_telegram`, `get_connect_link` | Live |
| **Outbound & web** | `send_email` (two-step), `web_search`, `read_webpage` | Live |
| **Channels in** | Email (Composio webhook, classified before L1 insert), Phone (SignalWire + AssemblyAI, consent-gated) | Live |
| **Surfaces** | Telegram chat, Telegram Mini App dispatch board, `/admin` operator cost dashboard | Live |
| **Customer billing portal** | Magic-link sign-in, tenant-scoped portal API, Stripe invoices, self-serve seats | **In flight** (current branch) |

### 8.4 The load-bearing design decisions

These are not implementation details; they are the product's actual character.

| Decision | What it means | Why it is a differentiator |
|---|---|---|
| **Telegram is the entire UI** | No web app for the firm. Managers and technicians work in a chat. One exception: the Mini App board. | Attacks the #1 documented cause of FSM adoption failure. |
| **Hardcode what must be auditable; let the model interpret** | Schema, identity matching, permissions, pricing math, scheduling guards are code. Extraction, summary, drafting are model. | Explicit, enforced boundary. Competitors do not state theirs. |
| **Feasibility is a tool verdict, never the model's opinion** | Every slot `find_slots` emits must be bookable verbatim. | A structural guarantee against the classic agent failure of confidently offering an impossible time. |
| **The promise ladder** (`none` / `day` / `time_only` / `time`) | Records *what the customer was told*, and that governs what the optimiser may move. | No competitor has a named concept for this. It is the vocabulary the whole scheduling UX rests on. |
| **Confirmation doctrine** | Confirm only what is irreversible or externally visible; do everything reversible and say what you did. Over-confirming is treated as a *safety* problem because it trains rubber-stamping. | Directly addresses the "AI agent that asks permission for everything" failure mode. |
| **One write path** | Chat, board and solver all call the same booking verbs. Never a parallel editing path. | Structural guarantee that surfaces cannot drift apart. |
| **Costs stored in units, never dollars** | Prices live in a versioned rate table joined at read time. | Vendor price moves re-price history correctly. Enables honest usage-based pricing. |

### 8.5 Where we actually are — the unvarnished state

- **2 tenants** on the pilot database: one shared demo tenant, and **one real external beta customer**
  (onboarded 2026-07-07 — a friend of the owner; 1 manager + 3 technician seats).
- **One 16GB Lightsail box**, with roughly **three sandbox slots left**, and the last commit on this
  branch notes the only free blank is double-booked.
- **No revenue system yet.** Money and roster growth are manual until the billing portal lands.
- **No published price.**
- First commit **2026-06-19** — the entire product is about **two months old**.
- ~59 test files, ~870 test declarations; last recorded full-suite run 891 passing (2026-07-30).

---

## 9. Differentiation analysis

Graded honestly in four buckets. A differentiator that a competitor could copy in a quarter is not
a differentiator; it is a feature.

### 9.1 REAL differentiators — defensible, and nobody else has them

**D1 — Provenance: every structured fact links to the raw evidence that produced it.**
`source_capture_id` on every L2 row; standing L3 facts stored as `{value, sourceCaptureId, recordedAt}`.
No competitor markets, documents or appears to implement anything equivalent. ServiceTitan's own AI
page discloses no grounding method at all **[P]**.
*Durability:* **high.** This is a schema decision made at the foundation. Retrofitting it into an
existing FSM database means rewriting how every field was ever written. You cannot bolt provenance on.

**D2 — Verified citations: a hallucinated citation cannot reach the reader.**
`validateCitations` drops any citation whose capture id is not actually present in the context given
to the model. This is a *mechanism*, not a prompt instruction.
*Durability:* **high**, and rising as trend 4 (§7) matures. Copyable only if D1 exists first.

**D3 — Append-only raw capture makes extraction re-runnable.**
L1 cannot be updated or deleted — enforced by a database trigger, not convention. A better model next
year re-reads the same originals and produces a better record retroactively.
*Durability:* **high.** This is the compounding asset. Every month of captures makes the archive more
valuable, and a competitor cannot retroactively acquire history they never stored.

**D4 — Zero-app interface aimed squarely at the sector's #1 adoption failure.**
No app to install, no login, no forms — a voice note in a chat the technician already has open.
*Durability:* **medium.** The insight is copyable; the commitment is not. An incumbent with a mobile
app, an app-store presence and a mobile team cannot credibly say "delete our app." But a new entrant can.

**D5 — The promise ladder as a human-facing constraint vocabulary.**
Scheduling constraints expressed as *what the customer was told* rather than as solver internals.
The repo even records removing a "locked" badge because it described a solver flag rather than a real
constraint — vocabulary must track what actually gates.
*Durability:* **medium.** Conceptually copyable, but it requires the discipline to design the
vocabulary before the feature, which is rare.

**D6 — Identity architecture (badge → doorman → signed header) far above SMB norms.**
Identity is resolved from a signed header and never from a tool argument; badges are individually
revocable and useless if stolen; tenant isolation comes from the roster, not from which bot you talked to.
*Durability:* **medium-high** as a trust asset, though invisible to buyers until something goes wrong
somewhere in the industry — at which point it becomes worth a great deal.

### 9.2 PARTIAL differentiators — better than most, not unique

- **AI scheduling with genuine optimisation.** `run_freeze` and `run_resolve` use Google Route
  Optimization with priced displacement, so cheap same-day shuffles are preferred over day hops, and
  `undo_run` restores from a run-stamped event ledger rather than a solver re-run. Strong work — but
  ServiceTitan's dispatch engine is described as the most mature in the segment **[T]**, and route
  optimisation is broadly available. **We differentiate on the *promise-aware* constraint model, not
  on optimisation itself.**
- **Voice capture from the field.** Real and working — but ServiceTitan Field Pro auto-records with
  consent and transcribes **[P]**, and AssemblyAI sells hands-free technician voice agents that
  integrate with ServiceTitan, FieldEdge and Jobber **[T]**. **We differentiate on where the
  transcript *goes* (append-only, linked, re-processable), not on capturing it.**
- **Human-in-the-loop discipline.** The confirmation doctrine and the "solver stages a proposal and
  stops" pattern are more rigorous than the industry norm, but "escalate to a human" is standard
  marketing copy for every voice vendor.

### 9.3 PARITY — no advantage, do not claim one

Conversational assistant over your own business data (Atlas, Copilot, Genius all exist); email
integration; multi-channel capture; route/mapping links; team roster management.

### 9.4 GAPS — where we are behind, in priority order

| # | Gap | Severity | Why it matters |
|---|---|---|---|
| **G1** | **No AI receptionist — we capture calls, we do not answer them** | 🔴 Critical | This is the category's proven ROI story and the thing buyers are actively shopping for. A $1B company exists solely to do this. Our phone channel records and transcribes; it never picks up. |
| **G2** | **No invoicing, payments, estimates, or price book** | 🔴 Critical | This is the commercial core of every FSM suite. Without it we cannot be the system of record for a trades firm — we are a companion product, whether or not we say so. |
| **G3** | **No QuickBooks/accounting integration** | 🟠 High | Universal table stakes. Its absence ends many evaluations before they start. |
| **G4** | **No memberships / service agreements** | 🟠 High | Recurring revenue is how these firms are valued, especially by PE buyers. Every serious suite supports it. |
| **G5** | **No marketing, reviews, or lead attribution** | 🟡 Medium | Where Workiz and ServiceTitan create measurable revenue lift. |
| **G6** | **Telegram dependency and the "consumer messenger" objection** | 🟠 High | A design strength that is simultaneously a sales objection: platform risk, professionalism perception, and no offline/native fallback. Nobody has tested how a trades owner reacts. |
| **G7** | **Pilot-scale infrastructure** | 🟠 High | One box, ~3 free sandbox slots, a manual Telegram-bot creation step, DeepInfra balance with no alerting, and a documented medic blind spot where completions hang while probes report healthy. This caps growth at roughly the next three customers. |
| **G8** | **No published price and no proven willingness to pay** | 🟠 High | One customer, who is a friend of the owner. There is no pricing evidence at all yet. |
| **G9** | **No brand, no channel, no trade-show presence** | 🟡 Medium | This industry buys from peers and conferences. Avoca's first ten customers came from trade shows. |

---

## 10. Positioning

### 10.1 Recommended positioning statement

> **For** small trades firms of 5–50 people whose technicians will not use the field-service app they
> already pay for,
> **TradesDatabase** is a chat-native operations assistant
> **that** captures every job in the technician's own words and builds one customer record where every
> fact can be traced back to who said it and when,
> **unlike** ServiceTitan, Jobber, Housecall Pro and Workiz, which require an app your crew avoids and
> whose AI cannot show you where its answers came from,
> **because** we preserve every original capture permanently, link every structured field to its
> evidence, and drop any AI claim that cannot cite a real source.

### 10.2 The three messages, in the order they should be said

**Message 1 — "Your crew already knows how to use it."**
No app, no login, no forms. A voice note in a chat. This is the door-opener, because it names a pain
the buyer has personally lived through.

**Message 2 — "The knowledge stays when the technician leaves."**
With 25,000 experienced technicians leaving the trades every year and nearly 30% of HVAC techs over
55 **[S]**, the argument writes itself: everything your best technician knows about a customer is
captured in their own words and stays with the business.

**Message 3 — "Every answer shows its work."**
The AI cannot make a claim it cannot cite. For a buyer who has been burned by a confidently wrong
chatbot — or who is being groomed for a PE sale and will face a diligence process — this is the one
that closes.

### 10.3 Who to sell to first

**Primary ICP:** 8–25 person residential HVAC, plumbing or electrical firm; owner-operator or a single
office manager doing dispatch by hand; already paying for an FSM suite that the field crew ignores;
crew comfortable with messaging apps.

**The sharpest qualifying question:** *"When your technician finishes a job, where does what they
learned actually go?"* If the honest answer is "into their head, and maybe a text to the boss," we
have a customer. If it's "into the app, properly, every time," we do not — and that firm should stay
where it is.

**Secondary ICP worth testing:** a PE-backed platform rolling up small shops. They need a consistent,
auditable, exportable record across acquisitions, and the acquired shops all use different software
(or none). Our provenance chain is a diligence asset. Higher deal value, longer sales cycle.

### 10.4 Battlecards

**vs Jobber / Housecall Pro** — *"You're paying for software your crew doesn't use."* Lead with
adoption, not features; we lose a feature comparison and win an outcome comparison. On price, note
Housecall Pro's $100/mo extra user at exactly the size the buyer is growing through. **Do not** engage
on invoicing or QuickBooks — concede immediately and reframe.

**vs Workiz** — hardest fight, closest philosophy. They own the call that comes in; we own everything
that happens after. Their pricing opacity (three stacked meters, none published) is the attack surface.
Expect to lose deals where the buyer's pain is genuinely missed calls — that is a real pain and they
solve it and we do not.

**vs ServiceTitan** — rarely head-to-head; we are ten times cheaper and one-tenth the product. If it
happens, the ground is exit cost and data portability (~$22k exit quotes, difficult export **[T]**)
versus a record designed from the first commit to be traceable and exportable.

**vs Avoca / Netic** — not a competitor. They answer the phone, we hold the record. The correct posture
is **partnership or coexistence**, and a customer running both is better served than a customer running
either. Saying so out loud is more credible than pretending to compete.

---

## 11. SWOT

| **Strengths** | **Weaknesses** |
|---|---|
| Provenance architecture that cannot be retrofitted by incumbents | No invoicing, payments, estimates, price book, or accounting integration |
| Verified-citation grounding — a real mechanism, not a prompt | No AI phone answering, the category's hottest capability |
| Append-only capture: a compounding, re-processable data asset | One real external customer; zero pricing evidence |
| Zero-app UI aimed at the sector's #1 adoption failure | Infrastructure capped at ~3 more customers |
| Genuinely rigorous engineering discipline for a 2-month-old product | Telegram platform dependency, unproven with real buyers |
| Explicit, enforced hardcode-vs-model boundary | No brand, channel, or industry presence |

| **Opportunities** | **Threats** |
|---|---|
| Grounding/auditability becoming a purchase criterion (§7 trend 4) | Incumbents bundling AI at near-zero price (Jobber Receptionist at $29) |
| PE roll-ups needing consistent, auditable records across acquisitions | ServiceTitan's "Agentic OS" repositioning with a 10,800-customer data moat |
| Retiring-technician knowledge loss — a macro tailwind nobody is selling to | Avoca-class funding ($125M) buying the market's attention |
| Published, predictable pricing against a category that hides its bills | Telegram policy or API change breaking the entire interface |
| Coexistence with AI-native voice players rather than competing | An AI-native entrant with money copying the provenance idea from scratch |

---

## 12. Strategic recommendations

Per this repo's convention, presented as decision briefs — options, trade-offs in practical terms,
and a recommendation.

### Decision 1 — What are we, commercially?

| Option | Trade-off |
|---|---|
| **✅ The context layer that coexists with an FSM suite** | Sell alongside Jobber/Housecall Pro rather than against them. No invoicing needed. Shorter sales cycle, no migration, and it is the play Avoca and Netic used to grow fast. Cost: we are an add-on, so we compete for a smaller budget line and we do not own the account. |
| A full FSM suite replacement | Owns the account and the billing relationship. Requires invoicing, payments, price book, estimates, memberships, QuickBooks — realistically 12+ months before we can even be evaluated. |
| Pure AI-agent layer with no record of our own | Fastest to sell. Throws away D1–D3, which are the only things we have that nobody else does. Reject. |

**Recommend: the context layer, explicitly and publicly.** Being "the record and the memory" is a
coherent story that our architecture already delivers, and it converts G2/G3/G4 from damning gaps
into deliberate scope. It also matches how every fast-growing AI-native company in this market
actually got started.

### Decision 2 — What do we do about the phone (G1)?

| Option | Trade-off |
|---|---|
| **✅ Partner / integrate first, build later** | An Avoca or Sameday call already produces a transcript. Ingesting it into L1 makes their product better and ours differentiated, with weeks of work rather than quarters. Cost: dependency on their roadmap, and no share of the revenue. |
| Build our own voice receptionist | Full ownership of the hottest category. Competes directly with a $1B company and four incumbents, needs telephony, low-latency voice, and 24/7 reliability we do not have infrastructure for. |
| Ignore it | We already have SignalWire capture. Cost: we lose every deal where the buyer's pain is missed calls, and that is a lot of deals. |

**Recommend: partner/ingest.** Our phone channel is already consent-gated and transcribing; extending
it to ingest a third-party voice agent's transcripts is a natural fit and turns a competitor into a
feeder. Revisit building in 12 months if the market has not consolidated.

### Decision 3 — What do we charge, and do we publish it?

**Recommend: publish a simple per-seat price, anchored in the $150–$250/month band for an 8-person
shop.** Reasoning: that is the SMB band (§6.1); publishing is free differentiation against Workiz and
ServiceTitan, both of which publish nothing; and it matches the repo's existing culture of stating
things plainly. The `cost_events`-in-units architecture already means we know our true per-tenant COGS,
so a published price can be set on evidence rather than on a guess.

### Decision 4 — What is the next thing to build?

Ranked by *competitive value per unit of effort*, not by engineering interest:

1. **Ingest third-party voice-agent transcripts into L1** — closes the sharpest edge of G1 cheaply.
2. **A "show your work" surface** — make provenance *visible* to the buyer. D1 and D2 are our best
   assets and they are currently invisible in a chat window. A one-tap "where did this come from?"
   in the Mini App turns an architecture into a demo.
3. **Data export / portability as a marketed feature** — directly attacks the incumbents' worst
   reputational weakness, and the billing-portal work already has an export tier scoped.
4. **Infrastructure headroom (G7)** — three free slots is a hard ceiling on everything above.

**Explicitly do NOT build next:** invoicing, payments, price book, marketing. Under Decision 1 those
are out of scope, and each is a large, low-differentiation build against products that have done it
for a decade.

---

## 13. Open questions and research gaps

Ranked by how much the answer would change the strategy.

| # | Question | How to answer it | Why it matters |
|---|---|---|---|
| **Q1** | Will a trades owner actually run their business through Telegram? | 10 customer interviews with non-customer firms in the ICP. Ask about messaging habits before mentioning the product. | This is the product's foundational bet and it has been tested on exactly one friendly customer. If the answer is no, everything above changes. |
| **Q2** | Does provenance/citation matter to a *buyer*, or only to us? | Same interviews: show two AI answers, one cited, one not. Watch which they trust and whether they will pay more. | D1–D3 are our whole moat. If buyers do not value them, they are engineering elegance, not strategy. |
| **Q3** | What is the real establishment-size distribution in our ICP? | US Census County Business Patterns by employment-size class for NAICS 238210/238220. | Filter 1 in §3.2 is a guess that swings the SOM by 3–4×. |
| **Q4** | What does a firm actually pay in total today? | Ask 10 firms for their full stack and monthly spend. | §6.1 is built from published rates and estimates, not from real invoices. |
| **Q5** | Would an AI voice vendor let us ingest their transcripts? | Direct conversation with Sameday or ServiceAgent (both publish pricing, so both are more approachable than Avoca). | Determines whether Decision 2's recommendation is viable. |
| **Q6** | What are Workiz's real prices? | A sales call, or a customer who will share an invoice. | Our closest competitor's economics are currently unknown to us. |

---

## 14. Sources

Grouped by what they support. Retrieved 19 August 2026.

**Vendor primary sources [P]**
- [Jobber pricing](https://www.getjobber.com/pricing/) — plans, extra-user cost, AI add-on prices
- [Housecall Pro pricing](https://www.housecallpro.com/pricing/) — plans, extra-user cost, unpriced add-ons
- [ServiceTitan pricing](https://www.servicetitan.com/pricing) — tier names, no published rates
- [Workiz pricing plans](https://www.workiz.com/pricing-plans/) — tier names and features, no published rates
- [Workiz home](https://www.workiz.com/) — Genius AI product line
- [ServiceTitan — Titan Intelligence](https://www.servicetitan.com/features/titan-intelligence) — named AI products
- [ServiceTitan — Field Pro](https://www.servicetitan.com/features/pro/field) — auto-recording and transcripts
- [ServiceTitan — Contact Center voice agents](https://www.servicetitan.com/features/pro/contact-center/voice-agents)
- [Workiz — Genius Answering](https://www.workiz.com/ai-genius-answering/) and [Genius AI overview](https://help.workiz.com/hc/en-us/articles/22777577796241-Genius-AI-overview)
- [ServiceTitan — AI adoption among commercial contractors](https://www.servicetitan.com/press/servicetitan-report-finds-ai-adoption-more-than-doubles-among-commercial)
- [ServiceTitan — Max programme](https://www.servicetitan.com/press/servicetitans-max-drives-ai-powered-growth-for-contractors)

**Financial and funding [P/S]**
- [ServiceTitan Q4 FY2026 earnings call transcript](https://www.fool.com/earnings/call-transcripts/2026/03/12/servicetitan-ttan-q4-2026-earnings-transcript/)
- [ServiceTitan FY2027 guidance](https://seekingalpha.com/news/4564113-servicetitan-outlines-1_11b-1_12b-fy-2027-revenue-target-as-max-ai-platform-ramps)
- [Avoca — $125M+ at $1B valuation (PR Newswire)](https://www.prnewswire.com/news-releases/avoca-raises-125m-at-1b-valuation-to-power-americas-services-economy-with-ai-302753962.html)
- [Avoca — Fortune profile](https://fortune.com/2026/04/27/avoca-ai-agents-missed-calls-hvac-plumbing-roofing-kleiner-perkins-chen-shrivastava-braswell/)
- [Netic — $23M Series B, Founders Fund](https://techfundingnews.com/netic-ai-raises-23m-for-plumbers-roofers-home-services/)
- [Netic — launch coverage, Plumbing & Mechanical](https://www.pmmag.com/articles/106572-netic-launches-with-20m-to-fix-the-500b-industries-that-keep-america-running)
- [Rilla — revenue and funding, Sacra](https://sacra.com/c/rilla/)
- [Jobber — $100M Series D, BetaKit](https://betakit.com/jobber-closes-100-million-usd-series-d-amid-strong-demand-for-home-services/)
- [Housecall Pro — $125M raise](https://www.housecallpro.com/resources/news-press/press/housecall-pro-secures-new-funding/)

**Market sizing [S]**
- [Grand View Research — FSM market](https://www.grandviewresearch.com/industry-analysis/field-service-management-market)
- [Mordor Intelligence — FSM market](https://www.mordorintelligence.com/industry-reports/field-service-management-market)
- [Global Market Insights — FSM market](https://www.gminsights.com/industry-analysis/field-service-management-market)
- [Technavio — FSM software market](https://www.technavio.com/report/field-service-management-fsm-software-market-market-industry-analysis)
- [US home services establishment counts](https://ctacquisitions.com/guides/home-services-market-size-statistics-2026/)
- [HVAC & plumbing contractor industry statistics](https://www.anythingresearch.com/industry/HVAC-Plumbing-Contractors.htm)

**Market drivers [S]**
- [JLL — skilled trades shortage](https://www.jll.com/en-us/newsroom/critical-skilled-trades-shortage-threatens-economic-losses)
- [HVAC technician shortage statistics](https://hirealigned.com/learn/hvac-technician-shortage-statistics)
- [Plumber shortage and demand outlook](https://hirealigned.com/learn/plumber-shortage-demand-outlook)
- [Why skilled technicians are harder to keep — Plumbing & Mechanical](https://www.pmmag.com/articles/107656-why-skilled-technicians-are-harder-than-ever-to-keep)
- [PE in home services statistics 2026](https://ctacquisitions.com/guides/private-equity-home-services-statistics-2026/)
- [HVAC PE roll-up tracker 2026](https://dealseam.com/hvac-pe-rollup-tracker-2026)

**Adoption failure and buyer behaviour [T]**
- [What contractors get wrong choosing field service software — Contractor Magazine](https://www.contractormag.com/management/best-practices/article/55382583/what-contractors-get-wrong-when-choosing-field-service-software)
- [Why field service CRM adoption fails](https://www2.dataforma.com/why-field-service-crm-adoption-fails-how-fix/)
- [BuildOps — what clean FSM/ERP adoption takes](https://buildops.com/resources/field-service-erp-software-adoption/)

**AI trust and grounding [S]**
- [Decagon — what is AI grounding](https://decagon.ai/glossary/what-is-ai-grounding)
- [Lorikeet — hallucination prevention and audit trails](https://www.lorikeetcx.ai/articles/best-ai-support-hallucination-prevention-2026)

**Competitor pricing estimates — low confidence [T]**
- [ServiceTitan pricing analysis](https://projul.com/blog/servicetitan-pricing-analysis-2026/) · [ServiceTitan reviews and criticisms](https://www.getonecrew.com/post/servicetitan-reviews) · [ServiceTitan API report card](https://supergood.ai/api-report-card/servicetitan)
- [Workiz pricing estimates](https://serviceagent.ai/blogs/workiz-pricing/) · [Workiz pricing, ITQlick](https://www.itqlick.com/workiz/pricing)
- [Avoca pricing estimates](https://serviceagent.ai/blogs/avoca-ai-pricing/) · [AI answering services comparison](https://golmtech.solutions/blog/best-ai-answering-services-home-services/)
- [Service Fusion / ServiceM8 / Zuper comparisons, SelectHub](https://www.selecthub.com/field-service-software/service-fusion-vs-servicem8/)
- [FSM roundup 2026](https://resources.rework.com/tools/field-service/best-field-service-management-software-2026)
- [AI dispatch and scheduling platforms 2026](https://www.educba.com/fsm-platforms-for-ai-dispatch-and-scheduling-in-2026/)
- [AssemblyAI — voice agents for field service](https://www.assemblyai.com/solutions/voice-agents-field-service)

**Internal sources**
`docs/Three-Layer-Context-Spine-Overview.md` · `docs/onboarding.md` · `docs/engineering-memory.md` §2 ·
`docs/control-plane.md` · `docs/doorman-runbook.md` · `docs/phone-call-runbook.md` ·
`docs/Physical-Data-Exchange-Direction.md` · `src/mcp/server.ts` (tool inventory) ·
`thoughts/shared/plans/2026-08-07-customer-billing-portal.md`

---

*Prepared 19 August 2026. Every dollar figure attributed to ServiceTitan, Workiz or Avoca is a
third-party estimate, not a published rate — those four vendors publish tier names only. Re-verify
before quoting externally.*
