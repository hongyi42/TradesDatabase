# Segment B — what people starting their own trades business actually say

**Date:** 2026-08-18
**Method:** `agent-reach` → `rdt-cli`. 10 targeted searches for year-one operators → filtered to
trades/small-business subs → full comment threads on the 7 most relevant discussions
(r/skilledtrades, r/HVAC, r/Plumbing, r/smallbusiness, r/selfemployed).
**Companion to:** [2026-08-18-reddit-trades-pain-points.md](2026-08-18-reddit-trades-pain-points.md)

**Status: unvalidated market signal.** Public self-selected complaints, not interviews. Nobody was
asked about our product or our price.

---

## 1. The pain, in their own words: two full-time jobs

This is the most consistent statement in the corpus and it is remarkably uniform.

r/skilledtrades, top comment (62↑) on "Is it just as easy as 'just start a business' in the trades?":

> "Learn a trade → start a business → **do everything but that trade**; is the cycle I've seen. I've
> also seen the start a business, burn yourself out working 80 hours a week, and completely fail
> because you didn't realize running a business is actually a full time job."

Same thread (16↑):

> "The one-man shop situation is difficult. **Running the business is a full-time job and I'm on the
> tools doing a full-time job.** I feel near a breaking point with the stress of it. I'd hang it all
> up tomorrow if I could find the right job. Sometimes trading freedom for security sounds like a
> good deal."

A solo handyman, r/smallbusiness, "Is this normal? Or am I just bad?":

> "3-4 jobs a day... on the go 5-6 days a week, money's ok. **But the other half of the job is
> brutal.** Replying to every request, driving all over town to quote, calling tenants who don't
> show, re-quoting, then losing a quote because I got stuck on another job and couldn't get there.
> Some weeks it's barely any actual work and just constant [admin]."

**Implication for positioning.** This is our value proposition stated by the market in the market's
own vocabulary. Not "memory," not "context spine," not "an AI manager" — *you are working two
full-time jobs and I will take one of them.* Demand Curve's rule (ch. 4: write like people talk)
argues for using this language nearly verbatim.

## 2. THE FINDING: their current system is already a chat app, and it is failing them

From the r/selfemployed UK thread with 20+ sole traders interviewed by the poster:

> "**All of the 20 solo businesses I spoke to use WhatsApp**, but lots complained about **losing
> things in there**, and **mixing in with their personal contacts and messages** too must blur the
> lines between business and personal."

This is the strongest single signal in either scrape, and it reframes a decision we already made.
"Telegram is the entire UI" has been treated internally as a constraint we accepted. It is actually
a **match to existing behaviour**: solo operators already run their business out of a chat thread.

And the two named failures of that workflow are exactly what a spine fixes:
- *"losing things in there"* → an unstructured thread has no record; L1→L2 extraction is precisely
  the fix
- *"mixing with personal"* → a separate business bot IS the separation

The competitor for segment B is not Jobber. It is **WhatsApp with no memory.**

## 3. Text is the preferred channel — including inbound

Tradespeople actively route customers away from voice:

> "I advertise text or call by my plumbing company name. **I wish every call came in as text.** And
> if they call I'll act like I'm on the road and ask if they can text. Pictures, contacts, billing
> info and location of work. **So much easier than trying to understand them on the phone.**"

> "I rarely take phone calls anymore because they eat so much of my personal time." — 12-year solo
> practitioner, r/selfemployed

**Relevance:** our phone-call capture (`call_ingest`, live) converts calls into text with structure
attached. That is not a workaround for people who don't answer phones — it is the thing they say
they want.

## 4. Quoting is the biggest uncompensated time sink

> "Driving all over town to quote... then losing a quote because I got stuck on another job and
> couldn't get there."

Corroborated in the other scrape: *"you spend an hour driving out, another 30–40 minutes looking at
it and writing a quote, and then the customer never calls back, that time just disappears."*

The converged workarounds are behavioural, not software:
- **Charge a service-call fee**, credited against the job — repeated by multiple commenters
- **Qualify by text first:** *"Vet the customer over the phone and get pictures, rough measurements,
  scope expectations, sent over text and quote it from there. If they are serious then schedule an
  onsite. I rarely waste a trip anymore. Most of the lame tire-kicking customers wash out on their own."*

## 5. Follow-up wins jobs, and nobody does it — this is a revenue feature

> "Communication is huge, but **follow-up is key.** Had a client who ghosted me after a quote. I
> shot them a message a week later just checking in. Turned out they were still deciding but
> appreciated the nudge. **Landed the job because I reached out.**"

This maps directly onto the `nudges` system (PR #148), which currently watches for work gaps. A
watcher for *"this quote is 7 days old and unanswered — want me to follow up?"* is the same
machinery pointed at revenue instead of admin hygiene. For a solo operator, one recovered job pays
for the product for a year.

## 6. What they actually use today

Named in-thread by operators, not vendors:
- **WhatsApp** (universal), paper diary, Google Calendar
- **ServiceM8 + Xero** — the $200k/yr solo plumber systematising before his first hire
- **Square** for payments, **QuickBooks Online** for invoicing by text
- Spreadsheets

## 7. Two findings that cut against us

**Many solo operators deliberately never grow.** A whole thread ("Anyone else happy staying a one
man band?") is people choosing to stay at one or two people, permanently:

> "You can be the guy who works 20-30 hours a week and makes very good money, starts his day when he
> wants and ends his day when he wants."

> "I work the field 25-35 hours a week, almost never do an overtime call, take a day off when I feel
> like it, get my kid on/off the bus almost every day. **I fire customers for being too demanding.**"

**Implication for pricing:** a deliberate one-man band is a permanent one-manager-seat customer with
no expansion path. Our seat model's growth story does not apply to a meaningful share of segment B.
That caps LTV and argues that segment B must be acquired cheaply — self-serve, no touch — or not
targeted first.

**Ownership is actively resented by many technicians.** A 282↑ r/HVAC post is a rant against being
told to start a business, and the top replies agree:

> "I have 0 desire to ever be an owner. I love going home for the day and not having to worry about a
> fucking thing related to work."

The addressable slice of "technicians who could go solo" is smaller than the population of
technicians. Sizing segment B off headcount would overstate it.

## 8. Cost context for pricing

One owner reports **insurance over $100k/yr with zero claims** ("the first 4-5 months of work all go
toward paying the insurance company"), another cites *"96% of construction businesses fail in less
than ten years"* (both operator claims, unverified).

Cuts both ways: a $199/mo tool is rounding error against those numbers, **and** these operators are
genuinely cash-squeezed and failure-prone, which is a churn risk independent of product quality.

## 9. The buying trigger to design for

The clearest purchase moment in the corpus is **"systemising before the first hire"** —
r/Plumbing, a solo plumber at $200k/yr, 10-15 jobs a week, average ticket $800-900, already on
ServiceM8 + Xero, writing out intake checklists and rules like *"admin does not diagnose or quote
fixed prices over the phone."*

That is a person actively buying process. Worth noting the top reply pushed back hard — *"why do you
want to? You could hire an admin, make your life easier and just be a good plumber"* — and the whole
thread warns that hiring is where solo operators get destroyed. **An AI that absorbs the admin load
is precisely the third option that thread could not name.**

## Recommendations

1. **Rewrite the segment B headline around "two full-time jobs."** It is their sentence, not ours.
2. **Reframe Telegram-only as a match to behaviour, not a constraint** — profile §8 and §11 should
   both change. The WhatsApp finding is the evidence.
3. **Position against WhatsApp, not against Jobber,** for segment B.
4. **Add a quote-follow-up watcher** to the nudge system. Revenue feature, small build, uses landed
   machinery.
5. **Re-examine segment B's LTV** given the deliberate-one-man-band population, before committing
   acquisition spend there.
6. **Target the "systemising before first hire" moment** — highest-intent buying signal observed.
