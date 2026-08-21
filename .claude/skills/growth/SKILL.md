---
name: growth
description: Growth-marketing playbook (Demand Curve Growth Guide, full text) grounded in TradesDatabase's product and ICP — competitive analysis, landing page copy/structure, writing and running paid social ads, user onboarding and virality, content marketing/SEO, and A/B testing. Consult whenever the task is to write or critique marketing copy, design or audit a landing page, plan or write ads, audit competitors, design a signup/onboarding flow, plan content or SEO, or decide what to A/B test. Also use when asked "how do we get customers", "why aren't people converting", or to review any customer-facing marketing asset.
---

# Growth

The full Demand Curve Growth Guide, verbatim, with its figures transcribed — plus the TradesDatabase
context needed to apply it to *this* product rather than to a generic startup. The site numbers 9
chapters; ch. 9 ("What's Next") is a sales page for Demand Curve's own services, so the 8 chapters
of actual guidance are what's stored here.

**Read `product/tradesdatabase.md` first, on every task.** Generic growth advice is worthless here;
the whole point of this skill is advice specific to who actually buys this product. If that file
contradicts something you assumed, the file wins.

**Chapter numbers here match demandcurve.com/growth.** Intro is 1, Competitive Analysis is 2,
Landing Pages is 3, and so on — so a citation like "ch. 3" lands on the right page if someone opens
the site.

---

## 1. The one idea the whole guide rests on

Every chapter is downstream of a single artifact: **the list of value props and objections**.

```
        ┌─────────────────────────────────────────┐
        │  VALUE PROPS + OBJECTIONS               │
        │  (from customer interviews & surveys)   │
        │  "what bad thing do they do without us" │
        │  "what almost stopped them from buying" │
        └────────────────────┬────────────────────┘
                             │  everything below is
                             │  a re-expression of this
    ┌──────────┬─────────────┼─────────────┬──────────────┐
    ▼          ▼             ▼             ▼              ▼
 Landing    Ad copy      Ad set       Onboarding      A/B test
  page      (ch. 4)   segmentation    (what to        variants
 (ch. 3)                 (ch. 6)      entice with)    (ch. 8)
                                        (ch. 5)
```

The exercise (ch. 3): *What bad alternative do people resort to without your product? How is your
product better than that? Turn that into an action statement.* That statement is a value prop.

### The three research states — don't collapse them

Before building any asset, establish which state you're in and **say so in your output**:

| State | What to do |
|---|---|
| **A. Nothing exists** — no documented value props, no objections | Don't invent them. Produce the research questions first (ch. 3's exercise + ch. 4's three survey questions), and say the asset is premature. |
| **B. Documented but not customer-validated** — value props written down by the team, objections mostly guessed | **This is TradesDatabase's actual state.** Build the asset — the documented props are real and specific — but label which inputs are documented vs. inferred, and hand back the survey questions that would validate them. |
| **C. Customer-validated** — props and objections came from interviews, surveys, or sales calls | Build freely; cite which finding drives which line. |

Inventing value props is the single most common way this work goes wrong. Deriving them from
documented product behavior and *saying you derived them* is fine.

## 2. Order of operations

The chapter order is a dependency order, not a menu. The intro states it plainly: marketing fills
the bucket, onboarding keeps it from leaking.

**Don't pour traffic into a leaky bucket.** If onboarding/activation is broken, ads spend money to
prove it. When someone asks to "run ads" and the onboarding path hasn't been examined, flag it —
then do the requested work anyway, with the risk stated.

Rough sequence: research value props → landing page → onboarding → *then* paid ads → content/SEO in
parallel (slow-compounding) → A/B testing continuously once there's traffic to test against.

## 3. Routing — which file to read

**Read the chapter file before doing the work.** §4 below is a quick-reference for formulas you may
quote directly; it is *not* a substitute for the chapter when you're actually applying a framework.
If you use a framework you only saw in §4, say so.

| The task | Read |
|---|---|
| Audit a competitor; find their ads, landing pages, A/B tests, funnel, tech stack | `references/02-competitive-analysis.md` |
| Write/critique a landing page, homepage, hero, headline, feature section, CTA | `references/03-landing-pages.md` |
| Write ad copy or design ad creative; pick a copywriting angle | `references/04-making-ads.md` |
| Design signup/activation flow; reduce drop-off; referrals and virality | `references/05-onboarding.md` |
| Set up/optimize paid social campaigns; targeting; budgets; metrics; retargeting | `references/06-running-ads.md` |
| Plan blog/SEO/newsletter content; distribution; audience funnel | `references/07-content-marketing.md` |
| Decide what to test; design a test; read results | `references/08-ab-tests.md` |
| Any task naming a tool from the guide | `references/tool-status.md` **(always — some are dead)** |
| Context on what "growth" means here, and DC's own credentials | `references/01-intro.md` |

Several tasks span chapters. Writing a retargeting ad = ch. 6 (audience construction) + ch. 4 (the
copy). A landing page for an ad campaign = ch. 3 + ch. 6's segmentation logic. Read both.

**Ch. 3 carries transcribed examples**, not just rules — bad→good header pairs, the seven-company
value-prop table, the Webflow objection ladder, header/subheader/CTA tables. Use them; showing the
pattern beats asserting it.

## 4. Load-bearing formulas and thresholds

Quotable directly — these are the parts people actually use.

- **Purchase Rate = Desire − (Labor + Confusion)** (ch. 3). The lens for every page critique.
- **Header litmus test** (ch. 3): if the visitor reads *only* the header, do they know exactly what
  you sell? Slogans fail this. Specificity is step one.
- **Ladder of Product Awareness** (ch. 4), 1 = most aware, 5 = least:
  1. They're motivated plus they believe your type of solution/product is best.
  2. They're motivated to solve the problem but aren't sure which solution is best.
  3. They're aware solutions exist but aren't sufficiently motivated to solve the problem.
  4. They're experiencing the problem but are unaware solutions exist.
  5. They're not experiencing the problem your product solves.

  Search targeting reveals LPA position (keyword niche-ness); profile targeting does not, so social
  copy must carry more context. Don't try to drag people up from rung 5.
- **Ad sample size** (ch. 6): ~3,000–5,000 impressions before judging an ad; kill ads with CTR
  30–40% below their siblings; ~3,000 Reach before a demographic breakdown means anything.
- **Ad budget split** (ch. 6): ~20% retargeting, ~15% set aside for bi-weekly experiments.
- **Lookalike seed** (ch. 6): most down-funnel audience available, ≥1,000 people, and be suspicious
  above ~5,000 (you're probably not segmenting to highest-LTV users). Default 1% breadth.
- **≥5 ads per ad set** (ch. 6). Fewer means you didn't think hard enough.
- **A/B significance** (ch. 8): 1,000+ visits validates a ≥6.3% lift; 10,000+ validates ≥2%. Macros
  move 50–300%; micros cap out around 1–2%. **Low traffic ⇒ don't run micros at all.**
- **Viral coefficient** (ch. 5) = referrals per user × invite acceptance rate. Above 1 = viral
  potential. Also reduce signup→referral lag.

## 5. How to apply this well

**Match on audience + business model, not on "competitor."** (ch. 2) The most useful company to
study may be in a completely different industry that sells to the same kind of person the same way.
Conversely, a direct competitor with a different business model teaches little.

**Never copy blindly.** The guide is emphatic. Competitor tactics are *hypotheses to test*, not
things to implement. Their success may come from network effects or factors you can't see —
especially for early-stage companies, which are usually not methodical at growth. The pipeline is:
source → prioritize → A/B test → measure → *only then* implement.

**Learn the norms in order to break them.** (ch. 2) The third reason to audit competitors is to find
what everyone in the category does, so you can deliberately not do it and rise above the noise.

**Site metrics beat ad metrics.** (ch. 6) High CTR with bad CPA means the ad wrote a check the
landing page didn't cash. Use CTR only to rank ads *within* an ad set; judge everything else on CPA.

**Be specific, always.** The single most repeated correction across ch. 3 and ch. 4 is vague →
specific. "Improve your workflow" → "Groceries delivered in 1 hour." Every claim gets a number, a
noun, or an outcome.

**Write like people talk.** (ch. 4) Use the words customers use, not the category's formal term —
"used cars," not "pre-owned vehicles." For this product that means the vocabulary of trades firms,
not SaaS vocabulary. Check the product profile for the real words.

**Don't ask before you excite.** (ch. 5) Never request effort from a user before showing them why
it's worth it. Tooltips after engagement, not before. Referral prompts after a dopamine moment,
not at signup.

**Reward with your own value prop, not cash.** (ch. 5) Dropbox gave storage. Cash incentives mostly
don't work — users are jaded.

## 6. Anti-patterns specific to this repo

- **Don't assume a website funnel.** Much of the guide presumes visitor → landing page → self-serve
  signup. This product has no signup page. See §11 of the product profile for the full list of
  broken assumptions before prescribing anything.
- **Don't invent proof.** Social proof (ch. 3, ch. 4) is powerful and is the easiest thing to
  fabricate by accident. Use only customer counts, logos, quotes, and results recorded in the
  product profile or given by the user. If there aren't any, say so and propose how to get them —
  ch. 3's tactic is giving the product free to recognizable firms in exchange for logo rights.
- **Internal doc claims: describable, not measurable.** The product's own docs contain two different
  kinds of statement, and only one is safe in public copy.
  - ✅ **Descriptions of what the product does** — "send a voice note and it takes eight seconds,"
    "every claim cites the note it came from," "technicians can't change the schedule." These
    describe behavior a demo would show. Usable.
  - ❌ **Numbers that read as measured outcomes but aren't** — "80% of the value," "15% of people
    who finish onboarding…". These sound like research findings and aren't. Not usable, even though
    they appear in our docs.

    Test: *would a reader assume someone measured this?* If yes and nobody did, don't ship it.
- **Respect the disclosure and privacy constraints** in §13 of the product profile. Permanent
  logging, no deletion, and proactive questioning are product foundations that must be disclosed;
  copy may not contradict or soften them.
- **Category stance is decided; price and proof are not.** The stance (2026-08-17): *"works
  alongside what you already have" in the sale, "the AI manager" in the story* — profile §10. Price
  **structure** is now decided (profile §15) but the **number is an untested hypothesis**, and there
  are still **zero recorded active external customers** — so any option whose strength depends on
  proof, or on a price holding, cannot be ranked honestly. Say so rather than projecting certainty.
- **Use the market's own words — they're sourced now.** Profile §16 carries a word-swap table,
  worked action statements, and header candidates lifted from ~500 trades-owner posts. Prefer those
  to anything you'd phrase yourself. The vocabulary is sourced; the value props it expresses are
  still research-state B.
- **Verify a competitor is real before treating it as one.** Chapter 2 warns against over-analyzing
  early-stage companies but assumes they *are* companies. Before citing anything as a peer, check
  funding and legal entity — a landing page is not a competitor. Tier findings by evidence strength
  (profile §10 shows the format) and never cite a vendor's own "alternatives" pages as market data.
  *Ex:* FieldServe read as the closest architectural analog in this market until a check showed a
  four-month-old domain belonging to a Croatian dev shop with no funding, team, or customers.
- **Verify platform specifics live.** Per CLAUDE.md, never answer a third-party-service question
  from memory or from these files. `references/tool-status.md` records what's already been checked
  and when.
