# Reddit gap research — what trades owners actually complain about

**Date:** 2026-08-18
**Method:** `agent-reach` → `rdt-cli` (Reddit is otherwise blocked to our crawler; ContractorTalk and
HVAC-Talk sit behind Tollbit, HTTP 402). 24 searches + 8 subreddit browses → 514 unique posts →
184 in trades/small-business subs → full comment threads pulled on 10 highest-engagement discussions.
**Raw corpus:** session scratchpad `reddit/` (ALL.json, OPS2.json, c_<postid>.json).

**Status: unvalidated market signal, not customer research.** These are self-selected public
complaints, not interviews with prospects. Treat as hypothesis generation. Nobody in this corpus
was asked about our product, and nobody was asked about price.

---

## 1. Job costing is the #1 owner pain — and we don't model it

The most consistent operator complaint across every sub, and it is an *owner* pain, not a tech pain.

> "Running an HVAC company, 18 techs... when I sit down and actually look at job profitability after
> everything's done I keep getting surprised by how thin the margins are." — r/sweatystartup, 38↑ 41c

Top reply (40↑): the misses were rental, drive time, refrigerant, and warranty callbacks — "you ate
both costs and still cleared 8%."

Independently, from a plumbing-software thread:

> "The biggest pain point I hear about isn't really dispatching, it's tracking what jobs actually
> made money after materials and time."

> "You spend an hour driving out, another 30–40 minutes looking at it and writing a quote, and then
> the customer never calls back, that time just disappears."

**The reason nobody solves it is data capture, not analysis** — stated explicitly in the same thread:

> "Most guys wouldn't enter every fitting. That would get old real quick on a busy day... For a solo
> plumber on service calls it's usually too much typing."

> "A few of the guys I know don't even bother tracking it, just because it's a hassle."

### Why this matters to us

This is the strongest product-market signal in the corpus and **it maps onto our architecture better
than the value props currently in the profile.** Every FSM tool has a job-costing screen; they fail
because typing every fitting is unrealistic in the field. Our thesis is *capture verbatim by voice,
structure it afterwards* — "picked up a condensate pump, forty bucks, drove back out Tuesday" is
eight seconds of speech and it is exactly the data that goes missing.

**Gap:** L2 is `customers → jobs → visits`. There is no materials cost, no labor hours, no margin.
`cost_ledger` tracks *our* API spend, not the customer's job profitability. Closing this is a schema
question, not a prompt question.

**Caveat:** Jobber already partially covers this and users praise it for exactly this —
*"helps me track expenses, labor, profit for every job."* We would be competing on capture quality,
not on the existence of the feature.

## 2. Proof-of-work disputes — an unsolved pain that fits our evidence model

r/electricians, 316↑ **360 comments**:

> "Billed them 6.5 hours... Customer's response: 'Okay but how do I know you actually spent that
> much time, I need proof.' Then they threatened to dispute the charge with their credit card
> company. And here's my problem, I don't actually HAVE proof."

The community's workarounds are revealing — nobody names a software feature:
- Quote flat-rate instead of hourly (most common answer, 72↑)
- **Use the Google Maps location timeline as evidence** (90↑ and 28↑ — two separate commenters)
- Before/after photos, "but not always helpful if they're looking at time stamps"

**Why it fits us:** timestamped, append-only, undeletable capture linked to a job *is* the artifact
they're improvising with Google Maps. This is a value prop we already have architecturally and are
not currently claiming.

## 3. Speed-to-lead — confirmed, with a real price anchor

> "What's your system for responding to leads fast enough that they don't ghost you?" — r/sweatystartup

What operators actually pay today, from the thread:
- **"We hired a virtual assistant to answer calls and get customer information to schedule the
  estimate. $1,100 a month plus bonus when sales get closed."**
- "You can hire a sales assistant in the Philippines to do that for like $5 an hour."
- DIY: web form + Zapier + virtual phone, off-hours only

**$1,100/month is a better pricing anchor than any of the desk-research figures** — it's what one
operator actually pays for roughly the narrowest slice of what we do.

**Dissent worth recording:** a well-upvoted reply rejects the premise entirely — *"Check your phone
more frequently and respond... You can't possibly tell me that it takes you 2+ hours to find a free
moment to respond to a text. Make the time."* Not everyone reads this as a tooling problem.

## 4. The real low-end competitor is paper, and it is winning on price

r/landscaping, "is Jobber overkill?" — a 2-man crew "doing everything on paper/text messages and
losing track of invoices." Top answer, 9↑:

> "My landscaper has an invoice book. They're like $10 at Staples... he simply texts me a picture of
> my invoice slip... I zelle him the money. Then he marks PAID on his invoice. The system is simple
> and easy for everyone."

The original ask sets the ceiling explicitly: *"What are you guys using that isn't $200/month?"*

And from a competing founder in another thread: *"tradies paying stupid money for bloated apps they
barely use."*

**This directly pressures our pricing hypothesis.** Segment B's alternative is not Jobber at $25–249
— it is a $10 paper book plus Zelle, and it works. Our $199/manager-seat starting hypothesis sits
well above what this segment says out loud it will pay. Either segment B is a later market, or the
entry price has to be much lower than the AI-manager anchor suggests.

## 5. What people dislike about Housecall Pro and Jobber

Complaints are about **complexity, cost at scale, and sales behavior** — not missing capability:

- HCP: *"Somewhat complicated."* / *"Great but expensive once we got to a few techs."*
- HCP: *"Doesn't track your leads with two-way text. You'll miss a lot of the data."*
- HCP sales: *"the guy I was dealing with was a real jerk"*; on a demo call, *"the guy got really
  sarcastic with me... I used to be a software engineer and that UI is terrible."*
- Jobber, positive: *"Easy to use... tracks expenses, labor, profit for every job. Shows when
  clients look at quotes and automatically asks for a review. For someone who was tracking half-ass
  with pen and paper, it is a 100% game changer."*
- Jobber, negative: *"documentation got messed up from time to time and quoting was a bit strange."*

**Supports** the "nothing to learn" thesis (complexity and bad UI are named repeatedly).
**Undercuts** any claim that incumbents can't do the core jobs — Jobber's happy users are happy.

## 6. The low end is crowded with near-identical entrants

Named by founders self-promoting inside single threads: FieldPulse, BluePro, WorkBird, PolarPath,
Simple Time, Bella FSM, Field Promax, QuoteIQ, ampleexpress, planloop. Positioning is uniformly
"cheaper than Housecall" / "only pay for the modules you use."

We are not entering an empty market at the bottom. Differentiation has to be architectural, not
price or feature-list.

## 7. Segment B is real and unusually software-tolerant

Career-changers moving *into* the trades show up repeatedly: *"Software guy, 52, looking at buying
an HVAC company"* (r/sweatystartup), *"Another (former) software engineer thinking about starting a
service business,"* and r/cscareerquestions *"Anyone else feel the constant urge to leave the field
and become a plumber."*

Also relevant to who is buying: PE went from 8% of HVAC deals in 2023 to 23% in 2024, add-on
acquisitions up 88% through mid-2025, ~3,000 investors active; small shops trade at 6–9× EBITDA vs
17–20× for scaled platforms (figures quoted by an operator, unverified). The independents resent it
loudly — a 542↑ r/HVAC post is a sustained rant against PE-driven sales tactics. There may be a
positioning angle for shops that don't want to become roll-up inventory.

## 8. Adjacent: no-shows

Junk-removal operator reports **20% same-day cancellation/no-show despite email + text two days out,
text the night before, and a call the morning of.** Convergent answer is deposits or a cancellation
fee; some resort to overbooking "as the airlines do." Not our problem today, but it is a recurring
margin killer and it is a scheduling-adjacent feature.

---

## What contradicts our current positioning

1. **Nobody asks for AI.** Across 184 trades posts the demand is for *cheaper, simpler, less
   bloated*. "An AI manager that knows your company" is not language anyone in this corpus reaches
   for. This does not make the positioning wrong — it does mean it is unvalidated, and the profile's
   research-state B label is correct and should stay.
2. **Price expectations at the bottom are far below our hypothesis** (§4).
3. **The pain we model best (context/memory across a job) is not what owners name.** They name money
   leakage and proof. Both are downstream of context — but we'd be selling the cure by naming a
   symptom they don't articulate.

## Recommended next moves

- **Add job costing to the L2 model.** Best-evidenced gap in the corpus, and the one where our
  capture architecture is a genuine unfair advantage rather than parity.
- **Claim the evidence/proof-of-work value prop.** It exists in the architecture, it's absent from
  the profile's value props, and it has a 360-comment thread behind it.
- **Re-test the segment B price** against the $10-invoice-book alternative before committing to
  $199. The Van Westendorp range should be run on solo operators specifically.
- **Use $1,100/mo (VA) and $5/hr (offshore assistant) as the live labor anchors** — sourced from
  operators, not vendor marketing.
- **Recruiting constraint:** r/HVAC bans vendor promotion outright — *"No ads (includes promotion of
  your company), or trying to get people to use products or software you created."* Recruit there
  by participating, never by posting an ask.
