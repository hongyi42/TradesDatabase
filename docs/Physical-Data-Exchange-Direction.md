# Physical Data Exchange — strategic direction

**Status: exploratory direction (2026-07-26). Not a committed roadmap.** Captured from a strategy
session; every number here is a planning estimate with its source cited. **Nothing in this
document launches before a privacy lawyer reviews the consent architecture** (§5 lists exactly
what to bring them). Market figures and legal landscape were checked against live sources on
2026-07-26 and will drift — re-verify before building.

> **⚠️ READ §9 FIRST. A deep supply/demand study (2026-07-26, same day) materially challenged
> the "sell footage to robotics labs" half of this thesis.** Raw video without action labels is
> the weakest training modality in the published literature, no robotics lab has publicly
> licensed a third-party corpus at a disclosed price, and 100k+ hours of egocentric video are
> free under Apache 2.0. §§2–3 quota and valuation numbers were derived BEFORE that study and
> are now **provisional**. The consent architecture (§5) and data architecture (§6) survive
> unchanged and are still the defensible assets.

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

### Competitive landscape (checked 2026-07-26)

A landscape sweep found **no company running this exact barter** — enterprise software to
physical-labor SMBs with footage as the payment. Every *adjacent* seat is occupied, which
validates the model while leaving this specific position open:

- **Cash-for-footage collectors** (compete for the same footage, pay money instead of
  software): ⚠️ **[Tradeye](https://tradeyecapture.com/) was cited in the first draft as
  validating trades-footage demand — a later vendor audit found it is a placeholder** (logo,
  tagline, contact form; no products, team, or funding). **Do not cite it as market
  validation.** Real operators: [Egolab.AI (founded Jan 2026) and Objectways strap head cams
  on factory and household workers](https://www.eweek.com/news/factory-workers-cameras-ai-robot-training/);
  [gig platforms recruit trades workers for recording
  tasks](https://www.micro1.ai/experts-guide/how-skilled-trade-based-workers-can-earn-from-ai-training);
  [Mecka AI](https://fortune.com/2026/06/01/mecka-ai-series-a-60-million-robotics-data-training/)
  ($60M raised, ~$100M ARR run-rate on signed contracts) is the substantive one.
  All pay per hour, rebuild QA and consent per program, and own no ongoing software
  relationship with the business. Ours arrives as a byproduct of software the shop already
  runs — real jobs, outcome labels, consent artifacts, duration cross-checks for free.
- **Vertical-SaaS data moats, internal use only:** [ServiceTitan markets itself as "born in
  the trades, trained on the trades"](https://www.servicetitan.com/features/ai) — customer
  operational data powers its own AI features; CompanyCam holds huge contractor photo/video
  archives. Both are paid products; neither collects footage as *consideration* nor
  (publicly) licenses it as training data. **Watch item: an incumbent is one "record jobs for
  seat credits" program away from this model** — the durable defense is the consent +
  verification machinery and the ground-truth linkage, not the idea itself.
- **Product-plus-data-rights precedents** (proof the bundle sells):
  [Nexar](https://venturebeat.com/uncategorized/nexar-which-sells-analytics-services-on-top-of-dash-cam-footage-raises-53m)
  sells dashcams and monetizes the anonymized road data on top; in agriculture, Climate
  FieldView's [free basic tier](https://www.precisionfarmingdealer.com/articles/7198-helping-farmers-use-precision-tools-in-common-software-platforms)
  plus the [~$1B Climate Corp acquisition](https://www.globalagtechinitiative.com/digital-farming/data-management/climate-corp-connecting-the-fieldview-dots/)
  showed aggregated physical-world data carrying company-scale value behind free software.
- **Robot-deployment data flywheels** (the capital-heavy version of the same thesis):
  [Physical Intelligence raised $1.4B in Jan 2026](https://opendatascience.com/recent-2026-robotics-projects-you-should-know-about/)
  to learn from real-world deployments including construction;
  [Universal Robots × Scale AI](https://www.universal-robots.com/news-and-media/news-center/universal-robots-scale-ai-launch-imitation-learning-system-accelerate-ai-training-lab-to-factory/)
  ship an integrated customer-data flywheel. They deploy *robots* to earn data; we deploy
  *software* — radically cheaper per hour of footage.
- **Price trend to respect:** teleoperation data fell from
  [~$340/hr in early 2024 to ~$136/hr by Q4 2025](https://www.roboticscenter.ai/state-of-robotics-2026).
  Generic footage is commoditizing. The slices that hold value are the ones that can't be
  staged or scraped — [human egocentric footage of skilled work outperforms teleoperation
  hour-for-hour](https://www.labellerr.com/blog/egocentric-datasets-robotics/), and licensed
  trades work in real homes with outcome ground truth and a clean consent chain is exactly
  that slice. This argues for quality/rarity weighting over raw volume as the program matures.

## 8. Open questions / next steps

**Reordered after §9.** The strategic question now outranks the operational ones:

0. **Decide the buyer before scaling collection** (§9.6). "Diagnostics/repair-copilot corpus"
   and "robotics manipulation corpus" imply different capture specs, different pricing, and
   different verticals. Cheapest next step: 3–5 discovery calls with the diagnostics-copilot
   tier (Bosch, Snap-on, ALLDATA/Mitchell/Identifix) before building any ingest pipeline.
1. **Lawyer review** of the consent architecture (§5 checklist) — gate for everything else.
2. Draft the **template consent form** + tech script (+ Spanish); decide launch states.
3. **Meter real seat cost** off the DeepInfra dashboard for a quarter; re-derive the
   100-min number from actuals (§3 formula) — noting §9 moved the value estimate down.
4. Design the **ingest gate** (consent check, completeness/active-minute estimation, narration
   scoring, visit-duration cross-check) — a future RPI feature; not started.
5. Pick the **video store** + retention policy (deletable object storage, lifecycle rules).
6. **Accounting/tax** treatment of the barter; E&O/cyber insurance for holding home footage.
7. Revisit quota refinements (rarity bonuses, per-job caps) **only after** a quarter of real
   ingest data.
8. **Verify the auto-repair consent assumption** (§9.5) — it was reasoned, not researched
   (search budget exhausted). Specifically: employee-monitoring notice duties, customer
   personal effects/VIN/plate exposure, and shop-floor conversation audio.

## 9. Supply & demand reality check (deep study, 2026-07-26)

Five parallel research tracks (~25 primary papers, lab technical reports, vendor pages, and
market sources). **This section supersedes the more optimistic framing in §§1–4 wherever they
conflict.** Confidence is flagged throughout; several widely-circulated market numbers turned
out to trace to unsourced vendor marketing.

### 9.1 The modality ladder — value tracks ACTION LABELS, not pixels

```
  ACTION-LABEL DENSITY ──────────────────────────────────────►
LOW                                                        HIGH

Internet    Passive ego     Sensorized ego      Handheld     Teleop on
3rd-person  video           human demo          gripper      target robot
video       (Ego4D)         (Aria/Vision Pro)   (UMI)        (ALOHA)
   │             │                 │                │             │
semantics   semantics +      6-DoF hand pose    6-DoF EE +    joint angles
  only      narration        + SLAM + MANO      grip width    @50Hz, encoder-true

        ◄── OUR PRODUCT SITS HERE          value increases ──►
```

The user's intuition was right: **a person in a sensor suit is worth far more than a person
with a camera.** Mechanically, what the expensive modalities capture that video cannot:
6-DoF hand/end-effector pose, per-joint angles from encoders, gripper aperture, and (rarely)
contact force. Apple's [EgoDex](https://arxiv.org/abs/2505.11709) captures **25 joints per
hand as SE(3) poses at 30Hz** from Vision Pro; [ALOHA](https://arxiv.org/abs/2304.13705) logs
14-dim absolute joint positions at 50Hz on a $20k rig;
[UMI](https://umi-gripper.github.io/) reconstructs 6-DoF pose via SLAM at 6.1mm/3.5° accuracy
on a **$371** handheld rig. **Force is the systematic hole in nearly every pipeline** — ALOHA,
UMI, Aria, Vision Pro and mocap suits all record zero force information, and
[Sparsh-X](https://arxiv.org/abs/2506.14754) measured **+63% policy success** from adding
multimodal touch. For fastener work (torque, seized bolts), the decisive variable is invisible
to video by construction.

### 9.2 Passive video: the evidence is worse than the marketing

Our product is **raw RGB with no action labels** — the weakest rung. The strongest evidence:

- **Toyota Research Institute** (89 policies, 2,835 real rollouts, 2,271 hours of passive
  egocentric video — 4.3× their robot data): *"Single-phase co-training with latent actions
  yields no improvement over the baseline"*
  ([arXiv 2602.01067](https://arxiv.org/abs/2602.01067)). Benefits appeared only in the
  low-robot-data regime and **diminished as robot data grew**. Crucially, the same video **did**
  help when routed through **VLM-generated language annotations** — value via the *semantic*
  channel, not the action channel.
- **HumanEgo's own ablation** ([arXiv 2605.24934](https://arxiv.org/abs/2605.24934)): raw human
  **RGB only → 7.5%** success; **+ 3D spatial tokens from stereo hand tracking → 85%**;
  monocular hand-tracking substitute → **0%**. Their headline "human video beats teleop" holds
  only *with* Aria's calibrated sensors. Anyone citing the headline without the ablation is
  overselling.
- **[Dasari et al., CoRL 2023](https://arxiv.org/abs/2310.09289)** — pretraining on **ImageNet
  (41%) beat Ego4D (28%)** for real-world robot success. Egocentric video was not special.
- **[LARY benchmark](https://arxiv.org/abs/2604.11689)** (Apr 2026): specialized latent-action
  models trained on video encode *less* action information (LAPA 20.2%) than generic
  self-supervised video encoders (V-JEPA 2 76.6%).
- **[VC-1/CortexBench](https://arxiv.org/abs/2303.18240)**: *"scaling dataset size and
  diversity does not improve performance universally"*; no pretrained representation dominated.
- **Rodney Brooks'** critique of the Figure/Tesla video bet: video omits force, touch and
  proprioception; each human hand has ~17,000 mechanoreceptors
  ([essay](https://rodneybrooks.com/why-todays-humanoids-wont-learn-dexterity/)).

Honest counterweight: [ATM](https://arxiv.org/abs/2401.00025) showed **0% → 63%** on real tasks
from adding passive human video via point tracks; [EgoScale](https://arxiv.org/abs/2602.16710)
(NVIDIA, 20,854 hrs) fits a log-linear scaling law at **R²=0.9983** with **+54%** success — but
EgoScale explicitly runs *"off-the-shelf SLAM and hand-pose estimation"* then retargets 21
keypoints into robot joint space, i.e. it converts video into action labels first. **Every
large win adds an extraction step or routes through language.**

### 9.3 What frontier labs actually train on

| Lab | Human video? | Evidence quality |
|---|---|---|
| **Physical Intelligence** (π0/π0.5/π0.7) | Added egocentric human video only in Dec 2025; π0.5's 400 hrs across ~100 homes is robot data | arXiv reports, but π0.7 publishes **no** data table |
| **Google DeepMind** (Gemini Robotics 1.5) | **No** — named as *future work*: *"An important next step is to leverage… real-world human videos"* | 62-page report, **zero** occurrences of "hours" |
| **NVIDIA** (GR00T) | **Yes — 20,854 hrs (EgoScale)**, action-labeled; N1 used 88 hrs real teleop vs 6,500 sim-equivalent hours | Best-documented; open weights |
| **1X** | **Yes — 900 hrs** egocentric human video (1X World Model) | Blog, but quantified |
| **Figure** | Claims **"100% egocentric human video, no robot demonstrations"** — but for a *navigation* policy, no metrics, no paper | Blog only |
| **Skild AI** | Claims YouTube + headcam video | Marketing only, **zero numbers** |
| **Tesla** | Executive statements + in-house helmet-cam collectors ($25–48/hr) | **No technical artifact of any kind** |
| **Generalist AI** | GEN-1: 500k+ hrs from *"low-cost wearable devices on humans"* | Blog; sensorized wearables, not wild video |

**The pattern that matters: the labs with peer-reviewable artifacts have modest, quantified, or
explicitly deferred human-video claims. The labs with the boldest human-video marketing publish
no papers and no hours.** And where labs *do* consume human video at scale, it is
**purpose-collected sensorized capture** (Figure↔Brookfield homes, NVIDIA EgoScale, Tesla
helmet rigs), not licensed third-party archives.

### 9.4 Demand: no archive-licensing market (the crux)

**No robotics lab has publicly licensed a pre-existing third-party corpus at a disclosed
price.** What exists instead:

- **Commissioned collection to spec.** [Scale AI](https://scale.com/physical-ai) (1,000+ hrs/day,
  "robotless egocentric platform"), [XDOF](https://techcrunch.com/2026/06/17/collecting-robot-training-data-is-dirty-unglamorous-work-some-ai-labs-are-already-paying-xdof-to-do-it/)
  ($70M raised, *"20 customers including several frontier AI labs"*),
  [Config](https://techcrunch.com/2026/05/11/koreas-biggest-manufacturers-back-config-the-tsmc-of-robot-data/)
  (100k+ hrs). Industry-wide, [MIT Tech Review reports robotics companies spend *"more than
  $100 million each year"*](https://www.technologyreview.com/2026/04/01/1134863/humanoid-data-training-gig-economy-2026-breakthrough-technology/)
  buying real-world data — **as services, not archives**.
- **Access-for-equity.** [Figure↔Brookfield](https://www.figure.ai/news/figure-announces-strategic-partnership-with-brookfield):
  Brookfield gave access to 100k+ residential units *and invested in Figure's Series C*. No cash
  for data disclosed. **This is the closest structural analogue to our model — and it was paid
  in equity, not licensing fees.**
- **Free supply sets the floor.** [Egocentric-100K](https://huggingface.co/datasets/builddotai/Egocentric-100K):
  **100,405 hours, Apache 2.0, free.** Open X-Embodiment: 1M+ trajectories, CC-BY. NVIDIA
  publishes sim data CC-BY-4.0.
- **Collector wages are the real price signal.** micro1 pays **$15/hr**; Chinese collection
  centers **~¥20 (~$3)/hr** ([Rest of World](https://restofworld.org/2026/china-ai-robotics-training-data/));
  Tesla's in-house operators $25.25–48/hr. Vendor rate cards ($25–60/hr egocentric) are
  **client-side** prices for managed programs, not what raw footage fetches.
- **Prices are collapsing.** All-in teleop data **$340/hr (2024) → ~$118/hr (2026)**; commodity
  bulk egocentric reportedly trades **below production cost**. ⚠️ These $/hr figures trace to
  **unsourced vendor marketing** — treat as directional only.
- **The one proven video-licensing market is generative media, not robotics:**
  [$1–4/minute for unpublished creator footage](https://the-decoder.com/openai-and-google-are-buying-youtubers-unpublished-videos-for-up-to-4-per-minute/).
  Note Shutterstock's data-licensing revenue **fell 47% to $21.0M in Q1 2026** — lumpy and
  deal-driven, not an annuity.

**What buyers do require:** per-person releases naming AI training, all-party audio consent,
BIPA notice, chain of custody, de-identification, and **indemnity**. This is where we're
genuinely differentiated: [Ego4D's own license is "AS-IS" with "NO FINANCIAL LIABILITY
WHATSOEVER"](https://ego4d-data.org/pdfs/Ego4D-Licenses-Draft.pdf) — free corpora offer zero
indemnity. Post-[*Bartz v. Anthropic*](https://www.jurist.org/news/2026/07/judge-approves-record-1-5-billion-settlement-involving-anthropic/)
($1.5B, where training was fair use but **acquisition was not**) and under EU AI Act Art. 53
(**licensed data carries lighter disclosure than scraped data**), a clean provenance file has
independent value. **Our product may be a defensible provenance file with footage attached.**

### 9.5 Auto repair specifically

**The robotics angle is weak — and the market already voted.**
[RoboTire filed Chapter 7](https://www.moderntiredealer.com/home/article/33019234/robotire-files-for-bankruptcy)
despite a $7.5M Series A from Discount Tire's parent. **The single most constrained, most
repeatable task in the entire shop — a wheel at fixed height with a standard lug pattern — was
not economically viable.** The one survivor,
[Automated Tire's SmartBay](https://www.therobotreport.com/automated-tire-decloaks-smartbay-autonomous-tire-changing/)
(~$4,900/mo), is semi-automated: humans still remove old tires, position new ones, connect air
lines, mount weights. [UVeye](https://www.prnewswire.com/news-releases/uveye-secures-191m-in-funding-to-meet-soaring-demand-for-ai-powered-vehicle-inspection-systems-302363100.html)
($191M raised, 125+ dealers) is pure **sensing** — no hands. EV battery service robotics is
research-stage and explicitly human–robot *collaborative*. Humanoids in automotive are in
**manufacturing** (Figure↔BMW, ~$25/robot-hour), where it's the same car at the same station —
the opposite of service work.

Why service is structurally hostile: unconstrained inputs (every make/year/trim, plus rust and
prior repairs); **occlusion** (work happens under hoods and under cars — hands hidden by the
workpiece); tool diversity; **force invisibility**; the billable difficulty is *diagnosis*, not
wrenching; and safety-critical liability (brakes, steering, airbags).

**Occlusion deserves emphasis because it compounds:** hand-pose label quality is the measured
transfer bottleneck (triangulated 3D labels transfer far better than monocular; injected noise
degrades performance monotonically), and a head-cam under a car is the worst case for exactly
that signal. Even Apple concedes EgoDex's *"dexterous annotations can be imperfect, especially
during heavy occlusion."*

**Genuine points in auto repair's favor:**
- **Procedure ground truth is rare and we'd have it.** ALLDATA/Mitchell carry unedited OEM
  repair procedures and labor-time guides — footage can be aligned to a canonical procedure
  taxonomy. Most egocentric datasets have **no** ground-truth procedure spec.
- **Scene diversity beats hours.** A 2026 co-training study found *"scene diversity matters more
  than scale"* ([arXiv 2606.06627](https://arxiv.org/html/2606.06627v1)), and π0.5 saturated at
  ~100 environments. An auto bay is a distinctive, underrepresented scene.
- **Underrepresented verbs:** torquing, prying, seating, threading — robot datasets are
  dominated by pick-and-place.
- **No public egocentric corpus covers skilled trades in service settings.** Ego-Exo4D's only
  repair task is **bike repair (82 hrs)**; EgoDex is tabletop; EPIC-KITCHENS is cooking;
  Build AI is factory floors. ⚠️ But note this cuts both ways: it may be unserved because
  **no buyer has asked** — no lab or vendor was found expressing demand for trades footage.

**⚠️ Consent assumption — reasoned, NOT verified** (search budget exhausted before this pass).
The intuition that a car in a bay is lighter than a customer's living room is directionally
right — no home interior, no family members, no bystanders. But three items need real research
before it becomes a strategic premise: (a) **the technician is the primary recorded subject**,
so employee-monitoring notice duties apply and are the *shop's* obligation to discharge;
(b) the customer's **vehicle interior** can expose personal effects, documents, garage codes,
plates and VINs; (c) **shop-floor conversation audio** re-triggers the all-party-consent map if
narration ships. Lighter than in-home, not free.

### 9.6 Oversupply: yes, from three directions

1. **Free corpora already exceed any plausible output.** 100,405 hours, Apache 2.0. Our
   100 min/seat/month × even 1,000 seats ≈ 1,667 hrs/yr — **1.7% of one free dataset.**
2. **YouTube is the unpriced competitor.** ChrisFix alone has 11M+ subscribers and the format
   is *explicitly first-person, narrated auto repair*. Thousands of hours of well-lit narrated
   POV repair are already public and scrapeable. Any VLM or benchmark buyer takes that first,
   for free.
3. **The user's own hypothesis is correct — chains can flood this cheaply.** A multi-state chain
   with 500 techs can generate more footage in a month than our whole pilot in a year, at
   marginal cost near zero. Combined with the **$340 → $118/hr** price collapse, **undifferentiated
   auto-repair footage is a commodity headed toward zero.**

Also note the **DVI incumbency**: video-documented inspection is *already standard practice*
(Tekmetric shops average **$741/RO with DVI vs $612 without**), and Shopmonkey's terms let it
*"use the Inputs and Outputs… to develop, improve, and evaluate the Services"* unless the shop
opts out; Tekmetric claims a *"transferable, sub-licensable"* license over user content. **But
DVI footage is the wrong footage** — a 30–90 second phone clip of a worn pad *to justify a
sale*: condition evidence, not procedure record, no hands working, no continuous action. That
gap is real. It also means incumbents are positioned to become AI *builders*, not data *brokers*.

### 9.7 Where the value actually is

**The strongest under-explored buyer is not robotics — it's the diagnostics/repair-copilot
tier.** Bosch's ESI[tronic] AI assistant, Snap-on APOLLO GEN 4, ALLDATA (400k techs / 115k
shops), Mitchell 1, Identifix. They are shipping AI **now**, they have budget, and the asset
they lack is exactly what both DVI footage and YouTube lack: **narrated expert diagnostic
reasoning tied to a confirmed outcome.** Our spine supplies the outcome half automatically
(what was done, whether it worked, whether there was a callback). ⚠️ Caveat: these buyers are
architected around OEM procedures and DTC text, not video — this requires evangelism, and no
procurement precedent was found.

**Ranked realism of buyers:** (1) diagnostics copilots — narration + outcomes; (2) robotics
foundation labs — real buyers, commodity prices, want annotation quality a head-cam can't give;
(3) technician training/workforce (they buy *content*, low ceiling); (4) AR/smart-glasses
assistance; (5) warranty-fraud/repair verification (they want verified *capture infrastructure*,
C2PA-style, not a corpus — possibly a product idea rather than a data sale); (6) video-
understanding benchmarks (high signal, ~zero revenue — but note
[ExAct](https://arxiv.org/html/2506.06277) shows Gemini 2.5 Pro at **55.35% vs 82.02% human
experts** on expert procedural video, a real capability gap); (7) insurance/claims — **closed**,
Solera alone claims **1.5B+ damaged-vehicle images**.

### 9.8 What this changes

**Survives intact:** the consent architecture (§5), the data architecture (§6), spine-linked
outcome ground truth, and the software-for-data exchange as *customer acquisition*.

**Now provisional:** the §3 valuation. The $25–40/hr market anchor is a **managed-program client
rate**, not what raw footage fetches; collector wages ($3–15/hr) and free 100k-hour corpora are
the truer comparables. Value per footage-hour should be re-derived downward, which pushes the
quota up — and a higher quota is exactly what §2 warns creates homeowner pressure. **This
tension is unresolved and is the strongest argument for treating footage as a strategic option
(and an acquisition lever) rather than as cost recovery.**

### 9.9 Vendor-layer economics (late audit — corrects §3 and §7)

A follow-up audit of the collection-vendor layer produced the sharpest pricing evidence in
this document, and **two corrections to earlier drafts**.

**Correction 1 — every $/hr client price in this doc is unsourced vendor marketing.** The audit
searched SEC filings (EDGAR full-text: "egocentric video" in 10-Ks = **zero hits**), federal
procurement records, and journalism. **No vendor in this market publishes a client-facing price
for egocentric or robotics data — not one.** Scale, Mecka, micro1, Turing, Objectways,
Innodata, Appen, Telus: all demo-gated. The `$25–60/hr egocentric` and `$340 → $118/hr` figures
that anchor §3 trace to [DataX Power](https://www.dataxpower.com/blog/humanoid-robot-data-collection-cost)
and [roboticscenter.ai](https://www.roboticscenter.ai/research/robot-data-collection-cost-breakdown)
— both **SEO content sites with no methodology, no named team, no citations, and a "Request a
Quote" CTA.** They rank top-3 on Google, which is why they propagate. **Treat every per-hour
market price in §3 as unverified.**

**Correction 2 — Tradeye is a placeholder**, not the trades-footage competitor cited in §7.

**What IS verified — the collector-pay side, from actual job postings:**

| Role | Pay | Note |
|---|---|---|
| [OpenTrain — egocentric video capture](https://www.opentrain.ai/jobs) | **$6.00/hr** | **Same rate for US, Canada, Brazil, Indonesia, Mexico** |
| OpenTrain — robot teleoperator | $30–55/hr | US, **on-site** |
| Objectways — egocentric (US) | $160 per 8-hr shift → 4 usable hrs | ≈$20/hr effort, ≈**$40/usable video-hour** |
| Objectways — international | $3–10/hr | approved hours only |
| [micro1 — chore filming](https://www.technologyreview.com/2026/04/01/1134863/humanoid-data-training-gig-economy-2026-breakthrough-technology/) | $15/hr | global |
| [Human Archive (YC W26)](https://techcrunch.com/2026/05/26/human-archive-taps-into-indias-services-startups-to-collect-data-for-physical-ai/) | **$1.00/hr** | India |

Two structural facts worth internalizing: **geographic arbitrage has been replaced by
task-category arbitrage** (OpenTrain pays a Californian and an Indonesian the *same* $6/hr for
egocentric capture, while paying $30–55/hr for US on-site teleoperation — the discriminator is
whether you must physically show up); and **"approved hours only" is the load-bearing clause**
in every posting, with rejection criteria (hands not in frame, poor lighting, "staged") that
push all quality risk onto the collector. **No posting discloses its rejection rate.**

**Two operational numbers that map straight onto our design:**
- **3–4 usable hours per operator per working day** (Unidata's disclosed metric). An 8-hour
  shift yields 3–4 billable hours — cost per *delivered* hour is roughly 2× the wage. Our
  complete-job-gated minutes are the same idea, and this is the industry's own yield benchmark
  to calibrate the ingest gate against.
- **This is a 35–45% gross-margin services business, not software** — audited: Appen **40.3%**,
  Innodata **40%** (compressing: AI-data segment fell 44% → 37% YoY), TaskUs ~37.8%,
  TELUS Digital 23.5% GAAP. Take rates across the layer cluster at 30–60%. Anyone modeling
  data collection at software margins is wrong.

**⚠️ The most strategically important finding in the whole study: the free supply that
undercuts us may be legally radioactive.** Build AI's `Egocentric-100K` — the 100,405-hour
Apache 2.0 corpus that sets the price floor — came from Egolab.AI's capture at Indian garment
factories. A [Scroll.in investigation](https://scroll.in/article/1092960/how-big-tech-is-harnessing-the-data-of-indian-factory-workers-to-train-robots)
found workers at the named factory (Pearl Global, Gurugram) received **no separate payment**
and said **their consent was never obtained**; an Egolab executive: *"We took consent to use
the device and we did it in our own way."* The Hugging Face dataset card carries **no consent,
privacy, or provenance statement** for 14,228 recorded workers.

That changes the competitive read. The free corpora aren't just un-indemnified — several
carry unresolved consent exposure, in a market where [*Bartz v. Anthropic*](https://www.jurist.org/news/2026/07/judge-approves-record-1-5-billion-settlement-involving-anthropic/)
established that **acquisition, not training, is where liability lives** ($1.5B), and where the
FTC has already ordered algorithmic disgorgement over improperly obtained home video. **A buyer
who cares about that cannot use the free 100k hours — and there is currently no consented,
documented, indemnified alternative at any price.** That is the actual product.

**Three sharpened strategic reads:**
1. **Don't sell "we have footage." Sell "we have consented, outcome-labeled, procedure-aligned
   footage with indemnity."** Raw volume is commoditized from two directions; provenance is
   not — and §9.9 shows the cheapest competing supply has documented consent problems, which
   makes clean provenance the scarce good rather than the compliance overhead.
2. **If the robotics buyer matters, capture must move up the modality ladder** — at minimum
   stereo or multi-view for triangulated hand pose, ideally instrumented tools for torque.
   That's a hardware program, not a software program, and it changes the unit economics
   completely.
3. **Auto repair's consent advantage is real but its data advantage is weaker than trades
   in-home**, which is the genuinely unserved corpus. The consent-lightness that makes auto
   repair attractive is the same property that makes its footage easy for everyone else to
   collect. **Consent-hard, data-scarce may be the better moat than consent-easy, data-abundant.**

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
Landscape (§7): [eWeek worker head-cam programs](https://www.eweek.com/news/factory-workers-cameras-ai-robot-training/) ·
[micro1 trades AI gigs](https://www.micro1.ai/experts-guide/how-skilled-trade-based-workers-can-earn-from-ai-training) ·
[ServiceTitan AI](https://www.servicetitan.com/features/ai) ·
[Nexar data model](https://venturebeat.com/uncategorized/nexar-which-sells-analytics-services-on-top-of-dash-cam-footage-raises-53m) ·
[FieldView free tier](https://www.precisionfarmingdealer.com/articles/7198-helping-farmers-use-precision-tools-in-common-software-platforms) ·
[Climate Corp acquisition](https://www.globalagtechinitiative.com/digital-farming/data-management/climate-corp-connecting-the-fieldview-dots/) ·
[Physical Intelligence $1.4B](https://opendatascience.com/recent-2026-robotics-projects-you-should-know-about/) ·
[UR × Scale AI flywheel](https://www.universal-robots.com/news-and-media/news-center/universal-robots-scale-ai-launch-imitation-learning-system-accelerate-ai-training-lab-to-factory/) ·
[State of Robotics 2026 (teleop price trend)](https://www.roboticscenter.ai/state-of-robotics-2026).
