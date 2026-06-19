# The Three-Layer Context Spine — Engineering Overview

**Purpose:** orient an engineer who is building the data foundation for a trades-business platform
from scratch. It explains *why* we structure customer/job data this way, *how* the three layers are
separated, and *every channel* that data can flow in from. It is deliberately implementation-
agnostic — pick your own database and storage; the shape of the model is what matters.

---

## 1. The problem we are solving

Our customers are small trades firms — HVAC, plumbing, electrical, pest control, roofing (~5–50
people). A job flows through a relay of roles: customer → front desk / CSR → manager / dispatcher →
technician → back to the office → (sales). **At every handoff, information is re-typed, summarized,
or simply forgotten.**

Two costs fall out of this:

- **Wasted time** — someone (usually the manager) spends the day routing information by hand
  between phone, calendar, email, and notes.
- **Context loss** — information degrades or disappears between people, between the two visits of a
  single job, and across months for repeat customers.

The spine exists to give every role **one customer/job record they all read from and write to**, so
context is captured once and never re-typed or lost.

## 2. Goals

- Reduce wasted coordination time and context loss across the relay.
- Boost revenue by capturing what currently slips through the cracks: technician-spotted
  replacement opportunities, follow-ups on quotes a customer didn't accept immediately, and
  recurring-contract renewals.
- Make the record **AI-ready** — rich enough that a model can summarize a customer's history, brief
  a technician before a visit, or answer a question on site.

## 3. The core idea: one record, three layers

The unifying concept is a **single customer/job record** that every role reads from and writes to.
It is split into three layers by *how certain and how structured the data is*:

| Layer | Name | What it holds | Shape |
|------|------|---------------|-------|
| **L1** | **Raw** | Verbatim, append-only capture — call transcripts, technician voice notes, photos, form submissions. Lossless ground truth. | Blob/object store (audio, images) + a raw-text store |
| **L2** | **Structured** | The typed fields the business acts on — name, address, job type, parts, labor hours, price, status. | Relational tables (e.g. Postgres) |
| **L3** | **Attributes** | Everything real but not worth a dedicated column — "dog on property", "prefers afternoons", "gate code 1234". | A flexible JSON column on the L2 rows |

**The guiding principle:**

> Structure only what you must act on deterministically (L2). Preserve everything else verbatim
> (L1). Capture the in-between in flexible attributes (L3). And **link every structured field back to
> the raw evidence it came from.**

Why this split is powerful:

- **L1 is a safety net.** Because the original is preserved, an imperfect AI extraction can be
  *re-run later* with better prompts or a better model — with zero data loss. You are never locked
  into your first interpretation.
- **L1 is also queryable ground truth.** A technician on site can ask "what did the last tech
  actually say?" and get the verbatim note, not a lossy summary.
- **L2 stays clean.** Only the fields the business logic, pricing, and scheduling truly depend on
  become columns — so the schema doesn't sprawl.
- **L3 absorbs the long tail.** The hundred small facts that matter to *one* customer live in JSON
  instead of forcing a schema change each time.

### A typical record's shape

```
customers ── (1:N) ── jobs ── (1:N) ── visits
   │                    │                 │
   └── each L2 table carries an `attributes` JSON column (L3) ──┘

raw_captures (L1)  →  each row links back to the customer / job / visit it informed
                      (raw_text for transcripts/notes; a blob pointer for audio/photos)
```

- A **customer** is a person/household/site you serve over time.
- A **job** (work order) is one piece of work at an address; it can span **multiple visits** and
  carry change orders.
- A **visit** is one trip by one technician.
- A **raw capture** is one verbatim input event, linked to whichever of the above it produced.

> **Design note:** model job `status` as a **state machine** (e.g. `open → in_progress →
> completed → invoiced → paid`, plus `cancelled`/`declined`), not a binary open/closed — the
> authoritative "done" signal is a downstream business event (the invoice being paid), not a
> technician's say-so. Leave room for this even if your first version only needs `open`/`closed`.

## 4. Data input channels (the write-paths)

Anything that produces information about a customer or job is a channel into the spine. **Every
channel follows the same two-step pattern:** land the input verbatim in **L1**, then extract the
structured fields into **L2/L3** — keeping the link between them. New channels are added over time,
so design the write-path to be channel-agnostic.

**From the field — technicians**
- On-site **voice notes** (dictated after or during a visit).
- **Photos** of equipment, model/serial plates, problem areas, completed work.
- **Typed notes** entered in the technician's portal.
- A technician is also a **lead source** — a spotted "this unit needs replacing" becomes a routed
  sales opportunity, not just a job note.

**From the front door — customer intake**
- Inbound **phone calls** (recorded → transcribed). The richest and heaviest channel: needs
  telephony, speech-to-text, and recording-consent handling.
- **Web forms** ("request service" on the website).
- **SMS / text** messages.
- **Email** inquiries.
- **Chat widget** on the website.

**From the office — manager / CSR / dispatcher**
- The **AI assistant** itself: a manager types or dictates an update and it's written to the spine.
- Manual **corrections and annotations** to an existing record (also captured as L1, so the edit
  history is preserved).

**From sales (later-stage)**
- **Comfort-advisor / salesperson notes** from an in-home consultation.
- **Quote and proposal** details, and the outcome (accepted / declined / follow-up needed).

**From other systems (integrations, forward-looking)**
- Imports from an existing **CRM or scheduling calendar**.
- **Accounting / invoicing** events (e.g. "invoice paid" → drives job status to closed).
- **Equipment telemetry / IoT** signals, where the trade supports it.

Whatever the channel, the rule holds: **raw in first, structure second, evidence always linked.**

## 5. Build approach: hardcoded vs. context-engineered

A rule of thumb runs through the whole system and tells you which parts to *write as code* and which
to *hand to the AI model*:

- **Hardcode the things that must be correct and auditable:** the schema, **identity matching**
  (deciding which existing customer/job an incoming capture belongs to), permission boundaries,
  pricing math, telephony, notifications.
- **Let the AI model handle the things that interpret:** extracting structured fields from a
  transcript, summarizing history, drafting a customer-facing narrative, answering a question.

Most features are a hybrid — the useful question is *which side carries the weight*. The spine
itself is overwhelmingly the hardcoded side: it is the trustworthy, deterministic foundation that
makes the AI features above safe to build.

**Identity matching deserves special attention.** The moment a second channel exists, you must
decide whether an incoming capture is a *new* customer/job or belongs to an *existing* one (e.g. a
call about an address a technician already has an open job at). Getting this right is what turns a
pile of captures into a coherent, longitudinal record — so it is hardcoded and tested, never left to
the model's guess.

## 6. Why build the spine first

Nothing else has value until the spine exists and something writes to it. Build it in this order:

1. **The schema + write/read access** to the three layers (this document's subject).
2. **One write-path** (usually technician capture — the simplest channel) end-to-end, proving raw →
   structured extraction with linked provenance works.
3. **Read / synthesis** features on top (briefings, customer memory) — they only become possible
   once the record exists and is being populated.
4. Additional **channels** (front-door intake, sales) and **richer job flows** (multi-visit,
   quoting, change orders) layer on afterward.

Start narrow — one channel, one tenant, the schema in version control — and widen deliberately.
