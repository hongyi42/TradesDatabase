# TradesDatabase — product profile for growth work

**Rewritten 2026-08-17** from the founder's own positioning statements plus verification against
code, the pilot database, and live competitor research. Doc citations are kept so claims can be
re-checked.

> **Verify before you trust this file.** Where a claim decides whether something can be marketed,
> check it against the repo or the database — not against another doc. A stale runbook line in this
> file previously caused two wrong recommendations. See `docs/engineering-memory.md` §5, "Reading
> our own docs."

---

## 1. The position

> **An AI manager for your trades business. It knows your customers, your jobs, and your team — and
> you run the whole thing by talking to it. No software to learn, in any language you speak.**

**"Memory" is supporting evidence, not the headline.** The word isn't banned — the product genuinely
does keep every historical customer and build a profile on each one, and that's worth saying. But
it's the *reason the claim is credible*, not the claim itself. Nobody buys memory; they buy a manager
who already knows their business. So:

- ❌ **Don't lead with:** "a shared memory layer for your firm" — abstract, and the category now
  says this too (§10)
- ✅ **Do lead with:** "an AI manager that knows your customers" — then *prove* it with the memory:
  it remembers every customer, builds a profile on each, and can show you which note each fact
  came from

Everything else in this file serves that sentence.

## 2. What it is

**Plain:** one record per customer and job that everybody writes into and everybody reads from —
run by an AI that answers the phone, reads the email, schedules the work, briefs the technician, and
drafts the invoice. You talk to it in Telegram.

**Technical:** the harness and context engine for a fleet of AI agents that run a trades firm's
office. Each person talks to their own agent; every agent reads and writes one shared customer/job
record (the spine). `docs/onboarding.md:39`

**Maturity: pilot, not launched.** Two tenants in the pilot DB, one Lightsail box.
`docs/onboarding.md:68`

## 3. Who it's for — two segments, lead with the second

| | **A. The small firm** | **B. The newly-solo technician** ⭐ |
|---|---|---|
| Who | 5–50 people, HVAC / plumbing / electrical / pest control / roofing | A tech who was great at the trade, quit, and now runs a business |
| Has | A manager or dispatcher already | Nobody. Themselves, a phone, a truck |
| Pain | The manager's whole day is hand-routing information | Doesn't know how to *run a business* and is drowning in the admin half |
| Wants | To stop losing context between people | To not have to become a manager |

`docs/Three-Layer-Context-Spine-Overview.md:12`, `docs/onboarding.md:25`

**Lead with B.** It's where the pain is sharpest, where the category leader structurally cannot
follow, and where the product's real promise lands: *you shouldn't have to learn management to run
your own shop.* The AI manager both **does** the management and **teaches** it — an experienced
operator working alongside someone learning. **Nobody in this market sells apprenticeship.** That
claim is unclaimed and it is the emotional core of the pitch.

Segment A is the bigger contract and the easier sale once you have references. Don't lead with it.

**Two user tiers (enforced in the DB, not marketing labels):**

| Tier | Who | Can do | Tools |
|---|---|---|---|
| **manager** | buyer/admin; owner or dispatcher | full team + schedule authority, the weekly freeze, full connector catalog | 40 |
| **technician** | field techs, office staff, sales | own day only: notes, briefings, lookups, two-step `send_email`, retract. **Cannot change the schedule** | 14 |

`docs/engineering-memory.md:138`, `docs/nemoclaw-tech-agent.md:91,112`. Schedule-only
(`seatExempt`) people consume **no seat**. `docs/customer-onboarding-runbook.md:208`

## 4. The pain — and the "before" state

Still the best paragraph in the repo, and it does chapter 3's bad-alternative exercise for you:

> "You already have a system for remembering customers. It is: a whiteboard, a phone, a shared
> inbox, three group chats, and the fact that Dave has been here eleven years and just *knows* the
> Hendersons have a dog. The problem is not that this doesn't work. **It is that it only works while
> everyone stays**, and it leaks a little at every handoff."
> — `docs/getting-started-for-firms.md:14`

For segment B there is no Dave. The bad alternative is **the owner's own head, at 9pm, after a full
day of actual work.**

**Named costs:** wasted time (the manager's whole day routing information) and context loss (facts
degrade between people, between a job's two visits, across months). `docs/onboarding.md:34`

**Revenue angle:** captures what slips through the cracks — technician-spotted replacements,
unaccepted quotes never chased, contract renewals. `docs/Three-Layer-Context-Spine-Overview.md:37`

**The compounding claim** — the strongest long-form line available:

> "**The compounding is the point.** A record with three months of notes in it is a different
> product from an empty one … **the things one technician knew become things everyone knows.**"
> — `docs/getting-started-for-firms.md:446`

## 5. The core differentiation: one manager, no seams

**This is the primary competitive frame. Use it.**

Housecall Pro **cannot answer a phone call.** It pulls call logs from third-party VoIP into customer
records, so *"most shops pair Housecall Pro with a dedicated AI voice answering service"* — Goodcall,
Kickcall, AgentVoice, Avoca. That means a real customer's stack looks like:

```
  Housecall Pro          $59–189/mo    scheduling, dispatch, invoicing, payments
  + AI voice agent       separate      phone intake
  + email/inbox tool     separate      email intake
  + QuickBooks           Essentials+   accounting
  + the integrations     glue          ...that somebody maintains

      ▲ every boundary is a login, a bill, and a place context dies
```

**The seams are the argument, not the feature count.** When a voice agent books a job into HCP's
calendar, a time slot and an address survive. What the customer *said* — the tone, the dog, the fact
that this unit has failed three times — dies at the API boundary. The voice vendor has the
conversation; the FSM has the appointment; **neither has the record.**

> Everyone else sells you a tool and a list of other tools to connect to it. We're one manager who
> does the whole job — and because it's one, nothing gets lost between the phone call and the invoice.

Housecall Pro cannot make that claim without rebuilding its intake layer in-house.

### What you automate across the job lifecycle

| Stage | Status | Notes |
|---|---|---|
| **Phone intake** | ✅ **live** | Answered, transcribed, intent-classified, card/SSN redacted pre-transcript. Verified 2026-08-17: `7f59a54` on main + 2 follow-ups; 7 calls / 1 number, latest 2026-08-11. Say "it works," **not** "proven at volume" |
| **Email intake** | ✅ live | Work/personal classification gates the L1 write |
| **Scheduling** | ✅ live | Weekly freeze; promise ladder; human commits |
| **Invoice drafting** | 🔜 planned | **Draft only, sent on manager review** — see §6 |
| **Payments** | ❌ never | Not in scope. You are not a payments product |

### The customer profile — verified 2026-08-17, and sharper than the category's

You do build a profile per customer, and it works in a way competitors' don't.

**`record_standing_fact`** (live MCP tool, two-step confirmation) records durable facts onto a
customer or job — the tool's own examples are *"prefers email"* and *"gate code 4321"* — and
*"this sets facts every future briefing sees."* `src/mcp/server.ts:544`

**`get_customer_context`** returns the brief: their jobs, upcoming scheduled visits, recent past
visits, and recent raw captures. `src/mcp/server.ts:286`

**The differentiated part:** every standing fact is stored *wrapped with the L1 capture that
evidences it* — value + `sourceCaptureId` + `recordedAt` (`src/db/standingFacts.ts:9`). Two
consequences worth selling:

1. **Every fact can show you the note it came from.** Not "the system says the gate code is 4321"
   but "Miguel said it on the 14th, here's the recording."
2. **Retract the evidence and the fact disappears automatically** (`foldRetractedFacts`). Correcting
   the record corrects everything downstream of it — no orphaned facts outliving the note that
   created them.

A CRM stores a field somebody typed. You store a fact *and its provenance*, and the two stay
consistent by construction. That's the concrete, demonstrable version of "it knows your business."

**Pilot usage: 5 of 115 customers carry attributes** — the capability is live, the corpus is
demo-scale. Fine to demo, not evidence of adoption.

## 6. Invoicing — draft-only, and why that's a feature

Scope: the AI drafts an invoice from what actually happened on the job; **a manager reviews and
sends.** No payment processing, no reconciliation, no chargebacks.

**It's the freeze pattern applied to money** — the manager does the work, stages it, nothing leaves
the building without a human yes. That's what makes "AI manager" sellable rather than alarming.

**QuickBooks is the destination and it's verified available**: Composio's QuickBooks toolkit
(OAuth2, ~105–114 tools) exposes `QUICKBOOKS_CREATE_INVOICE`, plus `CREATE_CUSTOMER`,
`CREATE_ESTIMATE`, `CREATE_PAYMENT`. Manager-catalog only — nobody but a manager touches the books.

**Two gates, not one.** Writing to QuickBooks puts a real record in the firm's books; sending mails
the customer. Both are externally-visible, so both belong behind confirmation per the doctrine. A
manager finding unapproved invoices in their accounting is a trust-ending event.

**The sales answer:**

> It writes the invoice from what actually happened on the job — the technician's own words, with
> each line traced to the note it came from — drops it in your QuickBooks as a draft, and you review
> and send. You keep your accountant, your books, and your process.

That answers "do you do invoicing?" without claiming to be an invoicing product, and turns the
compounding record into money. A draft built from cited evidence is something Jobber cannot produce —
theirs is assembled from line items a human typed.

## 7. The language wedge — underused, and possibly your best one

**The numbers:**
- **~30% of US construction trades workers are Hispanic** — much higher in TX, CA, FL, and in
  roofing, painting, landscaping, concrete
- **42% of Hispanic business owners "only or mostly" speak Spanish on the job**; another **37%**
  speak roughly equal amounts
- 42% of consumers won't buy in a language that isn't their preferred one

**Why it's structural, not a feature.** For an app-based competitor, another language is a
localization project — every screen, every string, every release, forever. For a conversational
product it's the same conversation in a different language, and you get *every* language, not just
Spanish. A Polish plumber in Chicago and a Vietnamese electrician in Houston are the same build.

**It compounds with segment B:** the person least served by a complex English-language SaaS UI is
exactly the immigrant technician who just went solo.

**One competitor in the lane:** [FieldSub](https://www.einpresswire.com/article/920575035/hispanic-contractor-launches-1st-fully-bilingual-app-built-for-subcontractors),
billed as the first fully bilingual app for subcontractors, with an "AI-powered business companion."
Bilingual and app-based — it has the localization ceiling you don't. Worth studying.

⚠️ **Survey before this goes in a headline.** The market data is strong; there is no evidence yet
about whether these owners *want* to run their business in Spanish or consider English part of the
job. That's chapter 3's "ask, don't guess."

## 8. "Nothing to learn" — not "easy to learn"

**Do not compete on ease of use. You would lose.** Housecall Pro reviewers say *"most techs able to
learn it in a day"*; Jobber teams *"reach operational competency within days."* Arguing days-vs-hours
against incumbents with real onboarding teams is a bad fight.

**Your claim is that there is no software** — no screens to navigate, no fields, no second app. A
category difference, not a degree difference.

Contrast that with the documented cost of the category leader: ServiceTitan needs **2–4 weeks of
training and 4–6 weeks of onboarding minimum, plus a dedicated admin**, and reviewers say
*"smaller teams without admin support often find the complexity more burden than benefit"* and
*"many 5–10 technician companies report paying for features they never use."* At $8–15k/year.

### The UI rule (as more UI ships)

More UI is coming — job status views, a map of customer properties, options in the Telegram menu.
This does **not** erode "nothing to learn," provided you hold one line:

> **The agent is how you act. The UI is how you see.**

| UI you **operate** (costs learning) | UI you **read** (free) |
|---|---|
| create job → pick customer → fill 12 fields → save | a map with pins; today's jobs colour-coded; a customer's history |

The test for any new surface: **could a new user use this without being taught?** A map passes; a
job-creation form doesn't. The architecture already enforces the write side — every board gesture
calls the same `booking.ts` verbs as chat. Keep that invariant.

Telegram Mini Apps support this fine: full web rendering, interactive maps, a `LocationManager` API,
launchable from the menu button. Keep it a **thin view over the API** — cloud storage caps at 1,024
items/user, device storage at 5MB, `sendData()` at 4,096 bytes.

**A map is table stakes, not a differentiator** — HCP has GPS tracking, ServiceTitan and Jobber have
route maps. Building it closes an objection. But build the version only you can: **tap a house and
see what you know about that property** — the gate code, the dog, the unit installed in 2019, each
line traced to the note it came from. Build views that display your moat, not views that match theirs.

## 9. Mechanisms that make the claims defensible

Enforced in code, so a competitor would have to change architecture to copy them:

1. **Promise ladder** — what the customer was *told* (`none`/`day`/`time_only`/`time`), stored
   separately from the calendar. *"Will never break a promise you made. That is the difference
   between an optimizer you can trust with real customers and one you can't."*
   `docs/getting-started-for-firms.md:254`. **Nobody else has this. Strongest single differentiator.**
2. **Append-only L1, nothing deletable** — a liability-shaped choice most vendors avoid.
   `docs/getting-started-for-firms.md:63`
3. **Every claim cited to its evidence**, hallucinated citations dropped mechanically, says "I don't
   know" rather than guessing. `docs/onboarding.md:216`. Extends to the customer profile: standing
   facts carry their source capture, and retracting the evidence removes the fact
   (`src/db/standingFacts.ts:42`) — see §5.
4. **Confirmation doctrine** — confirm only the irreversible or externally-visible; over-confirming
   is a *safety* problem because it trains rubber-stamping. `docs/engineering-memory.md:171`
5. **A human always commits.** The freeze "booked nothing until you said yes."
6. **Hardcoded where it must be correct** — identity, permissions, scheduling guards are
   deterministic code, never a model guess. `docs/onboarding.md:118`
7. **Looks dates up instead of doing calendar math**; asks when "next Tuesday" is ambiguous.

**Lead autonomy with the guardrail.** An AI that touches invoices is alarming; an AI that never
breaks a promise and never commits without you is a manager you'd hire.

## 10. Competitors — tiered by evidence strength

**Never cite a vendor's own comparison pages as market data.** Verify funding and legal entity
before treating anything as a competitor.

| Tier | Who | What they are |
|---|---|---|
| **Verified, major** | **Avoca** — $125M+, $1B valuation, 800+ customers, YC 2024, Kleiner Perkins/Meritech/General Catalyst | AI front office (phone intake) that writes into ServiceTitan. Defines the market's default: **agents on top, FSM as system of record.** Your counter-thesis |
| **Verified, major** | **ServiceTitan** (Atlas / Titan Intelligence), public | Chat over a record they already own. 2–4wk training, $8–15k/yr |
| **Verified, funded** | **Mura** — $6M seed, Level One Fund + Lerer Hippeau | Order-to-cash / AR / AP. Calls itself "dark software" operating **inside existing systems rather than replacing** — a funded validation of the layer-alongside play |
| **Established** | Housecall Pro ($59–79 Basic — no QuickBooks sync, no GPS; $149–189 Essentials — both; $329+ MAX), Jobber ($25–249/mo), Simpro (Lightning), FieldPulse, BuildOps | Invoice-first FSM, AI features bolted on. **Your QuickBooks story competes with HCP's $149 tier, not their $59 one** |
| **Bilingual lane** | FieldSub | First fully bilingual subcontractor app + "AI business companion" |
| ⚠️ **Unfunded / SEO-heavy** | FieldCamp (founder "Jeel," Brampton ON, **no funding**), Fieldproxy, Quantra | Marketing sites. Their performance stats are vendor claims. Not threats today |
| ⚠️ **Not a company** | **FieldServe** | Croatian dev shop (Netpoint Systems d.o.o., Zagreb), domain created 2026-04-29, no funding/team/customers. **Do not cite as a peer** |

**Category framing:** the repo never claims a category. Recommended stance — **"works alongside what
you already have" in the sale** (kills the invoicing objection on call one, and Mura proves it funds),
**"the AI manager" in the story.** Don't try to win a category argument before you have one reference
customer.

## 11. Where the guide's assumptions break

| Guide assumes | Reality | Consequence |
|---|---|---|
| Self-serve signup | No signup page; ~4–6 hrs operator work per firm. `docs/customer-onboarding-runbook.md:40` | **Never a "start free trial" CTA.** Conversion event is a booked demo |
| A/B-testable traffic | Pilot-stage, nowhere near 1,000 visits | **Micros are off the table.** Macro variants only, and say when significance isn't reachable |
| Lookalike seeds ≥1,000 | 37 pilot customers | Lookalikes unavailable. Interest/job-title targeting only |
| Bots can start conversations | **Telegram bots cannot message first** — each person presses Start | A mandatory activation step to design around |
| Growth unconstrained by ops | Every seat needs a pre-built cold sandbox | Demand gen has a hard supply ceiling |
| Sell anywhere | Single timezone per tenant by design | Don't target multi-timezone firms |

**Companies worth studying** (chapter 2 matches on audience **and** business model): high-touch,
sales-assisted B2B tools sold to small non-technical businesses. Study demo-booking funnels, not
signup funnels.

**LPA position:** mostly **rung 4** (experiencing the problem, unaware software addresses it) or
**rung 3** (aware FSM exists, unmotivated). Copy must carry the problem *and* the category. For
segment B specifically, many don't know "field service software" is a category at all.

## 12. Proof — and what you may not claim

**Usable:** date reliability 100% (94/94, "every point of it came from mechanism, not prompting")
`docs/engineering-memory.md:578`; tool layer 100% (45/45 cases, 366/366 date matrix); 0 machinery
failures / 0 fabrications on the 2026-08-15 fleet run; cross-tenant leak probe never fired; 82
merged PRs, 59 test files / ~870 test declarations.

**Careful:** the 55/59 tier-2 report ran on `gemini-3.7-flash`, **not** the production model. Latency
medians are `trajMs`; wall adds ~14s ssh overhead — never cross-compare.

**❌ May not claim:** any customer outcome (hours saved, revenue lift, jobs/day, NPS), any
testimonial, logo, or case study, or "trusted by N firms." The one named external beta exited beta
2026-08-14, so **zero active external customers** as recorded. `docs/engineering-memory.md:985`

**Internal doc claims:** descriptions of behavior are usable ("eight seconds," "cites the note it
came from"); numbers that read as measured but aren't ("80% of the value") are not.

## 13. Hard constraints on what marketing may say

**What you are NOT** — say it in the sale, *"the gap between 'AI for trades' and this product is
where disappointment lives"*: no payments or accounting (draft invoices only); **no customer-facing
anything** — customers never talk to the assistant, it's a staff tool; no outbound calling or AI
receptionist *persona*; no web app; **it doesn't replace your dispatcher** — it removes the typing
and remembers everything, a human still decides. `docs/customer-onboarding-runbook.md:267`

**Three disclosures owed in writing before access** — product foundations, not settings:
1. Emails sent through the assistant are **permanently logged**, including personal ones
2. **Nothing recorded can be deleted** — "if the firm cannot live with that, stop here"
3. The assistant **may proactively ask about work**, and answers can be recorded to job records

Nudges are bounded by mechanism: ≤2 questions/person/day, never a repeat for the same visit, 48h
silence hands it to the manager, writes only 7am–7pm local. Never messages customers, changes the
schedule, or sends anything on its own. `docs/getting-started-for-firms.md:348`

**Call recording:** the announcement is what makes it lawful — *"never ask us to remove it."* All-party
consent assumed. No voiceprints. Card/CVV/SSN redacted pre-transcript. **Firm is controller, we are
processor.** `docs/phone-call-runbook.md:46,50,52,57`

**Tone — this shapes every proactivity message:**

> "A thing that notices you're behind schedule and asks about it is an ops manager **or a
> surveillance system depending entirely on tone, disclosure, and defaults.** The nudge arrives as a
> colleague's question, not an audit."

**Off-limits:** nothing from `docs/Physical-Data-Exchange-Direction.md` (exploratory, lawyer-gated).
The intelligent-spine "team leader" is **direction only** — mark as roadmap if used.

## 14. Known vulnerabilities

- **Offline.** Technicians work in basements, crawl spaces, rural areas. Telegram Mini Apps have no
  documented offline mode and the product depends on connectivity, while HCP's native app queues
  offline. No field users have hit this yet — they will.
- **Four fronts at once.** Phone, email, scheduling, invoicing each have a funded specialist. The
  bundle wins on coherence and total cost, never on any single axis — "good enough and connected,"
  never "better at phones" (Avoca has $125M pointed at that one).
- **Feature-parity framing.** "Housecall Pro but AI" invites a checklist comparison you lose. The
  framing that survives: **what a solo tech hires instead of learning Housecall Pro.**

## 15. Open gaps — ask, never invent

1. **Price.** No dollar figure exists anywhere. Model is seat-based, manager seats higher.
   Benchmarks to price against: HCP $59–189/mo, Jobber $25–249/mo, ServiceTitan $8–15k/yr.
2. **Current customers.** Zero active external as recorded. Any paying firms now? Nameable?
3. **Outcome proof.** Nothing. Any pilot anecdote or quote at all?
4. **Language validation.** Do Spanish-speaking owners *want* to operate in Spanish? Unvalidated.
5. **Geography.** US implied by CCPA/BIPA framing; no stated target market.
6. **Invoice draft destination.** QuickBooks confirmed possible — is it the shipped path?
7. **Segment priority.** This file recommends leading with the newly-solo technician. Confirm.
