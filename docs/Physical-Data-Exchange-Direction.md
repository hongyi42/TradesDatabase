# Physical Data Exchange — strategic direction

**Status: exploratory direction (2026-07-26). Not a committed roadmap.** Captured from a strategy
session; every number here is a planning estimate with its source cited. **Nothing in this
document launches before a privacy lawyer reviews the consent architecture** (§5 lists exactly
what to bring them). Market figures and legal landscape were checked against live sources on
2026-07-26 and will drift — re-verify before building.

## 1. Central thesis

> **We trade enterprise-level AI software to small physical-labor businesses in exchange for
> physical-world data used to train AI.**

The trades vertical (current product) is the first instance, not the boundary. The trade works
because three scarcities line up:

- **Small trades shops can't afford enterprise software.** Our agent (scheduling, email, dispatch
  board, customer spine) is enterprise-grade tooling normally out of a two-person shop's reach.
- **AI labs are data-starved for exactly what these shops produce daily.** Data, not compute, is
  the bottleneck for embodied/physical AI: industry estimates in 2026 put total high-quality
  real-world interaction data at roughly half a million hours against a need measured in billions
  ([SCSP/ISF Voices 2026](https://scsp222.substack.com/p/isf-voices-2026-the-robotics-data)).
  The embodied-AI sector is projected to grow from $3.8B (2026) to $7.2B+ by 2030, with $55.8B
  raised by robotics companies in 2026 alone
  ([physicl.ai](https://www.physicl.ai/insights/embodied-ai)).
- **We sit in the middle with assets neither side has:** the delivery vehicle (the Telegram
  agent the shop already uses), ground truth (every video links to a spine job record — what the
  job was, how long it ran, whether it was completed, whether there was a callback), and a
  consent chain built into the product.

```
                    free/discounted seats
   US (software) ─────────────────────────►  TRADES SHOP
        ▲                                        │ techs record jobs
        │  consented, labeled,                   ▼ (with homeowner consent)
        │  ground-truthed footage            HOMEOWNER'S HOME
        │                                        │
        └────────────────────────────────────────┘
              → trains AI (ours, or licensed to physical-AI labs)
```

"Pay with data" is an old consumer-software pattern; our version is the consent-forward B2B
inversion of it — explicit, disclosed, quota'd, and refusable, because the person bearing the
privacy cost (the homeowner) is *not* the party receiving the free software. That mismatch is
the central legal fact of the whole design (§5).

## 2. The exchange: quota mechanics (converged design)

Recording is **never mandatory** — it's a quota with escape valves. A mandate would make the shop
pressure homeowners, which poisons consent quality (the first thing a regulator tests). The
currency is **minutes, gated by complete jobs**:

```
Quota:     100 minutes per seat per month (unused minutes roll over;
           banked balance capped at ~one extra month)

Counts:    minutes of ACTIVE WORK in a COMPLETE job video
           — arrival/diagnosis through function test — consent attached
Cap:       counted minutes ≤ the visit's on-site duration
           from the spine job record
Narrated:  counted minutes × 2
Fragments, incomplete jobs, missing consent: 0 minutes
```

Worked examples: one narrated 50-min job = 100 min (quota met with a single job — this is the
pitch: *"one talked-through job a month covers your seat"*); two silent 50-min jobs = 100; five
silent 10-min quick jobs = 50; a narrated 2-hour repipe = 240 (this month + a month banked).

Why this shape survived the alternatives:

- **Minutes alone** reward duration → dead-air padding, idle-camera farming, and per-video
  minute-count disputes. **Flat per-job credits** underpay a 3-hour repipe vs a 10-minute swap.
  **Complete-job-gated minutes** keep proportional fairness while fragments and padding earn 0.
- **The visit-duration cap makes padding self-defeating and cheating self-policing.** The spine
  records how long the tech was actually on site; video minutes beyond that don't count. The
  residual exploit — genuinely stretching a visit — costs the shop real billable hours (~$80/hr)
  to farm footage minutes worth ~$30/hr. Nobody selling to a data broker has this cross-check;
  it falls out of videos being linked to job records from birth.
- **The ingest gate adjudicates, not humans.** At upload, the gate: verifies the consent
  artifact, samples the video for completeness and active-work minutes, transcribes audio to
  validate a narration claim (speech present across the video's span, about the work), applies
  the visit-duration cap, and returns counted minutes with a one-line reason ("counted 42 of
  61 min — camera faced the van during material prep"). Explainable numbers, not judgment calls.
- **Graceful misses.** A shop that misses quota converts to a discounted paid rate for that
  month — the pressure lands on the shop's wallet, never on a homeowner's doorstep.

Deliberately deferred (add from real ingest data, not speculation): rarity bonuses for uncommon
job types, per-job minute maximums, repeat-type caps. Launch with the five-line rule above — a
two-person shop must be able to hold the whole deal in their head.

## 3. Valuation: why 100 minutes

**Floor — what a free seat costs us:** inference (~$30/mo, the s2 GLM-5.2 baseline before the
cache-key trial) + share of box/Render/Supabase (~$10–15) + amortized support ≈ **$45–60/seat/mo**.
Re-derive from the DeepInfra dashboard quarterly; if the cache trial lands, the floor drops.

**Market anchor — what the footage would cost to buy:** raw calibrated wearable collection runs
[$25–40/hour](https://www.dataxpower.com/blog/humanoid-robot-data-collection-cost), with
enterprise programs spanning [$20–200/hour](https://www.roboticscenter.ai/en/blog/robot-data-collection-cost)
by QA level. [Tradeye](https://tradeyecapture.com/) already pays licensed trades pros for narrated
POV footage of real home-service jobs — direct validation of demand and price. 100 min/mo ≈ 1.7 hr
× $25–40 ≈ **$40–65**, right on top of the seat-cost floor.

**The narration multiplier (×2) is grounded, not arbitrary.** Narrated footage is worth roughly
1.5–3× silent: it replaces post-hoc annotation labor
([$4–8/annotator-hr](https://labelyourdata.com/pricing), several hours per video hour, with
[skilled AI-trainer rates at $40–80/hr](https://www.opentrain.ai/jobs/video-annotation-ai-trainer--cmrg61b1600660ai2eqhpf8of/)),
and the diagnostic layer — *why* the tech checked the relief valve — exists only in the expert's
head at capture time; no annotator can reconstruct it later at any price. Language pairing is
what gives [vision-language-action models](https://en.wikipedia.org/wiki/Vision-language-action_model)
generalization ([VLA systematic review](https://arxiv.org/html/2507.10672v1)); Meta's
[Ego-Exo4D](https://link.springer.com/article/10.1007/s11263-025-02557-6) treats expert
commentary as a first-class annotation layer. Crediting narration at exactly 2× means the shop's
cheapest path to quota is also our most valuable footage — no arbitrage.

**Strategic overlay: don't tune for 100% cost recovery.** The free tier is simultaneously
customer acquisition (a shop that grows converts to paid seats) and an option on a dataset whose
market is scaling explosively (egocentric corpora went
[10K → 1M hours in about six months](https://www.labellerr.com/blog/egocentric-datasets-robotics/)).
Both arguments say: err toward a quota shops comfortably hit from willing homeowners.

## 4. What footage is valuable (capture spec)

Ranked by what physical-AI training actually pays for:

1. **Hands + workpiece visible, first-person.** [Hands convey intent, objects convey task
   state](https://objectways.com/blog/training-robots-in-real-life-with-egocentric-data/);
   first-person view avoids the perception–action mismatch that makes room-view tripod footage
   nearly worthless. Chest or head mount, framed on what the hands do.
2. **Failures and recoveries.** Humans generate [10× more valid recovery data per hour than
   robot teleoperation](https://arxiv.org/abs/2607.19745), and near-failure supervision is what
   makes policies robust. Real service calls contain the corroded fitting and the re-do that
   staged collection never has — **tell techs explicitly that mistakes and rework are the
   valuable footage; never cut them.**
3. **Complete jobs and diversity over volume.** The market is [drowning in redundant easy-task
   footage](https://flikforge.com/robot-data-glut-egocentric-video-physical-ai/); what stays
   scarce is unusual job types, varied homes/equipment, and diagnosis-to-cleanup completeness.
4. **Ground-truth labels.** Spine linkage (job type, duration, outcome, callback) is free
   annotation that generic footage lacks — it raises the value of even our *silent* footage.
5. **Narration** (see §3) — tech's voice only, at the workpiece, away from conversations.

Tech instructions in one line: *chest mount, hands in frame, record the whole job, keep rolling
when something goes wrong, talk through what you're doing and why.*

## 5. Legal architecture (the hard part)

The structural problem: consent must flow opposite to the video. The homeowner — who gets
nothing from the deal — must knowingly agree to being recorded, to the footage going to **us**
(a company they've never heard of), and to **our actual uses**. A buried line in the shop's
service agreement accomplishes none of that.

Risk map (US; checked 2026-07-26):

- **Audio is the criminal-law tripwire.** ~[12 all-party-consent states](https://www.recordinglaw.com/party-two-party-consent-states/)
  (CA, FL, IL, WA, PA, MA, …) make recording a *conversation* without everyone's consent a
  crime. Video-only is treated far more leniently. → **Video-only by default; narration is an
  explicit audio-consent tier** on the form, tech's voice only.
- **The home is the maximum-privacy location.** Invasion-of-privacy torts; video-voyeurism
  statutes if bathrooms/bedrooms are captured; unconsentable third parties (kids, family,
  visitors). → Framing rules: the work, not the room.
- **Twenty states have comprehensive privacy laws in effect in 2026**
  ([MultiState](https://www.multistate.us/insider/2026/2/4/all-of-the-comprehensive-privacy-laws-that-take-effect-in-2026)),
  and home video of identifiable people is personal data — often *sensitive* (faces, health
  equipment, minors), requiring [explicit opt-in consent](https://www.clym.io/blog/us-privacy-law-comparison-map),
  deletion rights, purpose limitation. Face analysis would additionally trigger biometric
  statutes (IL BIPA — private right of action; TX CUBI). → We don't run face analysis; consent
  names purposes; deletion path is architectural (§6).
- **Direct enforcement precedent: FTC v. Ring.** Home footage
  [used to train algorithms without adequate consent](https://www.eff.org/deeplinks/2023/06/ftc-forces-ring-take-user-privacy-seriously)
  → [$30M+ settlement](https://www.fastcompany.com/91113236/ftc-ring-refunds-customers-video-privacy-settlement)
  **plus deletion of models derived from the footage** (algorithmic disgorgement). → The consent
  form says "train automated systems" in plain words. Consent obtained for "quality assurance"
  does not cover model training.
- **The barter structure has its own consequences.** Videos-as-payment makes the free tier a
  real contract (consideration; ask an accountant about barter tax treatment) and invites the
  "was consent freely given?" question — answered by the quota-not-mandate design, costless
  refusal, and graceful misses (§2). Techs being recorded → several states require employee
  monitoring notice; program terms must obligate the shop to give it.

Design responses, in one place:

- **Per-job homeowner opt-in, signed before recording.** Heads-up at booking ("this visit may
  be recorded; you can decline" in the confirmation — no doorstep ambush), one-page plain-language
  form on arrival, Spanish version, one-sentence tech script. Refusal costs the homeowner
  nothing and the form says so; the job proceeds identically, unrecorded.
- **Form contents:** recorded by [shop], shared with [us], purposes including "improve our
  products and train automated systems," video-only unless the audio tier is signed, work areas
  only, retention period, deletion contact, no-penalty-refusal statement. Lawyer-reviewed
  template, versioned; store which version each homeowner signed.
- **Consent as a spine artifact.** Tech photographs the signed form → uploads via the agent →
  stored linked to the job record. Every video in our possession has an auditable consent trail —
  the first thing a regulator or nervous customer asks for.
- **Ingest rejection without consent.** Footage arriving with no linked consent is rejected,
  *not stored* — the same gate-before-possession principle as the L1 classify-before-insert
  rule: once we hold it, we can't un-hold it.
- **Program terms per shop:** use our consent flow, notify recorded employees, indemnify us for
  out-of-policy recordings, data-processing agreement. Contracts shift risk but don't eliminate
  it — the ingest gate is the verification.
- **Lawyer gate before launch.** Bring: draft consent form, program terms, intended uses stated
  bluntly (AI training included), launch-state list, the data-flow diagram (§6). Launch-state
  selection should account for the all-party-audio map if the narration tier ships at launch.

## 6. Data architecture

```
VIDEO STORE (separate, deletable object storage)   SPINE (existing DB)
┌──────────────────────────────┐                   ┌──────────────────────────────┐
│ vid_8f3a2c.mp4               │◄──── join ───────►│ visit row:                   │
│ opaque ID; no metadata       │                   │   video_id: vid_8f3a2c       │
│ beyond consent-form version  │                   │   description, duration,     │
└──────────────────────────────┘                   │   outcome (ground truth)     │
                                                   │   consent artifact (photo)   │
                                                   └──────────────────────────────┘
```

- **Videos live outside the spine, under opaque IDs.** The join lives in the visit row. The
  video store alone is pseudonymous: a breach, subpoena, or vendor scan of the bucket yields
  footage without names, addresses, or gate codes. Labels (job description) meet the video only
  at **export time, scrubbed** — keep the trade content ("replace 50-gal gas water heater"),
  drop the customer identity. The L2/L3 split makes this separation mostly free.
- **Hard constraint: videos and consent-revocable data NEVER enter `raw_captures` or any
  append-only store.** L1 has no delete path *by design*; deletion rights require one. Deletion
  request = spine lookup by visit → delete files → null pointers. A dangling pointer is fine;
  an undeletable video is a privacy-law violation waiting.
- **Treat the store as high-severity even though it's pseudonymous.** Home-interior footage is
  burglary-map data (valuables, layouts, occupancy). Short retention, tight access, encryption,
  lifecycle rules — designed in from day one, not bolted on. Footage is still personal data
  under the 20 state laws; separation limits blast radius, it does not anonymize.

## 7. Generalizing beyond trades

The reusable machine is: **(agent software a physical-labor SMB actually wants) + (job-record
spine = ground truth) + (consent chain as a product feature) + (automated ingest verification)**.
Any job-based physical-service vertical fits — HVAC/plumbing/electrical first, then appliance
repair, landscaping, cleaning, restoration, and eventually any vertical where skilled physical
work happens at scheduled visits with recordable outcomes.

Positioning vs. the field: paid-collection programs (Tradeye, the
[$50K–$200K/dataset program market](https://www.dataxpower.com/blog/humanoid-robot-data-collection-cost))
buy staged or semi-staged footage with cash and rebuild QA per program. Ours arrives as a
byproduct of software the shop already runs: real jobs, outcome labels, consent artifacts, and
duration cross-checks for free. [1 hour of human egocentric hand data can contribute more to
policy performance than an hour of robot teleoperation](https://www.labellerr.com/blog/egocentric-datasets-robotics/) —
and human POV footage of licensed skilled work is precisely the slice that can't be scraped or
easily staged.

## 8. Open questions / next steps

1. **Lawyer review** of the consent architecture (§5 checklist) — gate for everything else.
2. Draft the **template consent form** + tech script (+ Spanish); decide launch states.
3. **Meter real seat cost** off the DeepInfra dashboard for a quarter; re-derive the
   100-min number from actuals (§3 formula).
4. Design the **ingest gate** (consent check, completeness/active-minute estimation, narration
   scoring, visit-duration cross-check) — a future RPI feature; not started.
5. Pick the **video store** + retention policy (deletable object storage, lifecycle rules).
6. **Accounting/tax** treatment of the barter; E&O/cyber insurance for holding home footage.
7. Revisit quota refinements (rarity bonuses, per-job caps) **only after** a quarter of real
   ingest data.

## Sources

Market/pricing: [SCSP ISF Voices 2026](https://scsp222.substack.com/p/isf-voices-2026-the-robotics-data) ·
[physicl.ai embodied AI 2026](https://www.physicl.ai/insights/embodied-ai) ·
[DataX Power cost benchmarks](https://www.dataxpower.com/blog/humanoid-robot-data-collection-cost) ·
[SVRC robot data costs](https://www.roboticscenter.ai/en/blog/robot-data-collection-cost) ·
[Tradeye](https://tradeyecapture.com/) ·
[Labellerr egocentric datasets](https://www.labellerr.com/blog/egocentric-datasets-robotics/) ·
[Label Your Data annotation pricing](https://labelyourdata.com/pricing) ·
[OpenTrain AI trainer rates](https://www.opentrain.ai/jobs/video-annotation-ai-trainer--cmrg61b1600660ai2eqhpf8of/).
Training value: [Objectways egocentric data](https://objectways.com/blog/training-robots-in-real-life-with-egocentric-data/) ·
[EgoRecovery, arXiv 2607.19745](https://arxiv.org/abs/2607.19745) ·
[FlikForge data glut](https://flikforge.com/robot-data-glut-egocentric-video-physical-ai/) ·
[VLA overview](https://en.wikipedia.org/wiki/Vision-language-action_model) ·
[VLA systematic review, arXiv 2507.10672](https://arxiv.org/html/2507.10672v1) ·
[Ego-Exo4D, IJCV](https://link.springer.com/article/10.1007/s11263-025-02557-6).
Legal: [MultiState 2026 state privacy laws](https://www.multistate.us/insider/2026/2/4/all-of-the-comprehensive-privacy-laws-that-take-effect-in-2026) ·
[Clym state-law comparison](https://www.clym.io/blog/us-privacy-law-comparison-map) ·
[Recording Law all-party consent states](https://www.recordinglaw.com/party-two-party-consent-states/) ·
[EFF on FTC v. Ring](https://www.eff.org/deeplinks/2023/06/ftc-forces-ring-take-user-privacy-seriously) ·
[Ring settlement coverage](https://www.fastcompany.com/91113236/ftc-ring-refunds-customers-video-privacy-settlement) ·
[Avvo video vs. audio consent](https://www.avvo.com/legal-answers/can-i-video-and-audio-record-a-repairman-in-my-hom-4781668.html).
