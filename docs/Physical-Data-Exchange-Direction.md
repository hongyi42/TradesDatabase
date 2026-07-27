# Physical Data Exchange — strategic direction

**Status: exploratory direction. Not a committed roadmap. Nothing is built.**
Captured from strategy sessions on 2026-07-26 and consolidated the same day after a deep
supply/demand research pass. **Nothing here launches before a privacy lawyer reviews the
consent architecture** (§10 lists exactly what to bring them).

**How to read the confidence markers.** This document mixes solid evidence with market
folklore, and the difference matters more than usual here:

- **Cited claims** link to a primary source (paper, filing, technical report, job posting).
- **⚠️ flags** mark claims that are unverified, contested, or traced to unsourced marketing.
  Several widely-circulated market numbers turned out to be exactly that — see §4.
- Order of sections is deliberate: **market reality first (§§2–6), then the design that
  follows from it (§§7–12).** An earlier draft led with the design; the research pass
  undercut enough of its premises that leading with it would mislead.

---

## 1. Central thesis

> **We trade enterprise-level AI software to small physical-labor businesses in exchange for
> physical-world data used to train AI.**

The trades vertical (current product) is the first instance, not the boundary.

```
                    free/discounted seats
   US (software) ─────────────────────────►  TRADES SHOP
        ▲                                        │ techs record jobs
        │  consented, labeled,                   ▼ (with customer consent)
        │  ground-truthed footage            JOB SITE
        │                                        │
        └────────────────────────────────────────┘
              → trains AI (ours, or licensed onward)
```

Three things line up to make the trade plausible:

- **Small shops can't afford enterprise software.** Our agent (scheduling, email, dispatch
  board, customer spine) is tooling normally out of a two-person shop's reach.
- **Physical-world data is the bottleneck for embodied AI.** Data, not compute: industry
  estimates put total high-quality real-world interaction data at roughly half a million hours
  against a need measured in billions
  ([SCSP/ISF Voices 2026](https://scsp222.substack.com/p/isf-voices-2026-the-robotics-data)).
  The sector is projected to grow from $3.8B (2026) to $7.2B+ by 2030, with $55.8B raised by
  robotics companies in 2026 alone ([physicl.ai](https://www.physicl.ai/insights/embodied-ai)).
- **We sit in the middle with assets neither side has:** the delivery vehicle (the Telegram
  agent the shop already uses), ground truth (every video links to a spine job record — what
  the job was, how long it ran, whether it completed, whether there was a callback), and a
  consent chain built into the product.

"Pay with data" is an old consumer-software pattern; ours is the consent-forward B2B inversion
— explicit, disclosed, quota'd, refusable — because the party bearing the privacy cost (the
customer) is *not* the party receiving the free software. **That mismatch is the central legal
fact of the whole design (§10), and — per §6 — it turns out to be the central commercial fact
too.**

---

## 2. What physical-world data is actually worth, and why

**Value tracks how much of the ACTION SIGNAL survives capture — not how many pixels you have.**

```
  ACTION-LABEL DENSITY ──────────────────────────────────────►
LOW                                                        HIGH

Internet    Passive ego     Sensorized ego      Handheld     Teleop on
3rd-person  video           human demo          gripper      the robot
video       (Ego4D)         (Aria/Vision Pro)   (UMI)        (ALOHA)
   │             │                 │                │             │
semantics   semantics +      6-DoF hand pose    6-DoF pose +  joint angles
  only      narration        + SLAM + 3D hands  grip width    @50Hz, exact

        ◄── OUR PRODUCT SITS HERE          value increases ──►
```

What the expensive modalities capture that video cannot: 6-DoF hand/end-effector pose,
per-joint angles read straight off encoders, gripper aperture, and (rarely) contact force.
Concretely — a $20k [ALOHA rig](https://arxiv.org/abs/2304.13705) logs 14 absolute joint
positions at 50Hz with no estimation error; Apple's
[EgoDex](https://arxiv.org/abs/2505.11709) captures **25 joints per hand as SE(3) poses at
30Hz** from Vision Pro's calibrated stereo cameras;
[UMI](https://umi-gripper.github.io/) reconstructs 6-DoF pose to **6.1mm / 3.5°** on a **$371**
handheld rig. A head-mounted camera captures pixels and nothing else.

**Force is the systematic hole in nearly every pipeline.** ALOHA, UMI, Aria, Vision Pro and
mocap suits all record zero force information, and
[Sparsh-X](https://arxiv.org/abs/2506.14754) measured **+63% policy success** from adding
multimodal touch. For fastener work — torque spec, seized bolt — the decisive variable has no
visual signature at all.

### 2.1 Passive video: the evidence is weaker than the marketing

Our product is raw RGB with no action labels — the lowest rung. The strongest evidence:

- **Toyota Research Institute**, the largest controlled study (89 policies, 2,835 real robot
  rollouts, **2,271 hours** of passive egocentric video — 4.3× their robot data):
  *"Single-phase co-training with latent actions yields no improvement over the baseline"*
  ([arXiv 2602.01067](https://arxiv.org/abs/2602.01067)). Benefits appeared only in the
  low-robot-data regime and **diminished as robot data grew**. Crucially, the same video **did**
  help when routed through **VLM-generated language annotations** — value flows through the
  *semantic* channel, not the action channel.
- **The HumanEgo ablation is the single clearest number**
  ([arXiv 2605.24934](https://arxiv.org/abs/2605.24934)): raw human **RGB only → 7.5%** success;
  **+ 3D spatial tokens from stereo hand tracking → 85%**; monocular hand-tracking substitute →
  **0%**. Their headline "human video beats teleop" holds only *with* Aria's calibrated sensors.
  Anyone citing the headline without the ablation is overselling.
- Pretraining on plain **ImageNet (41%) beat Ego4D (28%)** for real-world robot success
  ([Dasari et al., CoRL 2023](https://arxiv.org/abs/2310.09289)). Egocentric video was not
  special.
- **[LARY benchmark](https://arxiv.org/abs/2604.11689)** (2026): specialized latent-action
  models trained on video encode *less* action information (LAPA 20.2%) than generic
  self-supervised video encoders (V-JEPA 2 76.6%).
- **[VC-1/CortexBench](https://arxiv.org/abs/2303.18240)**: *"scaling dataset size and diversity
  does not improve performance universally"*; no pretrained representation dominated.
- **Rodney Brooks** on the Figure/Tesla video bet: video omits force, touch and proprioception;
  each human hand has ~17,000 mechanoreceptors
  ([essay](https://rodneybrooks.com/why-todays-humanoids-wont-learn-dexterity/)).

**Honest counterweight.** [ATM](https://arxiv.org/abs/2401.00025) showed **0% → 63%** on real
tasks from adding passive human video via point tracks; GR-1's clean ablation shows Ego4D
pretraining adding **+0.39 to +0.48 average task length**, with the largest gain in the
low-data regime (1.04 → 2.00, a **92% improvement**)
([arXiv 2312.13139](https://arxiv.org/abs/2312.13139)); VPP collapses from **4.33 → 1.63**
without video pretraining ([arXiv 2412.14803](https://arxiv.org/abs/2412.14803)); and NVIDIA's
[EgoScale](https://arxiv.org/abs/2602.16710) (20,854 hrs) fits a log-linear scaling law at
**R²=0.9983** with **+54%** success.

**But read EgoScale's method:** they run *"off-the-shelf SLAM and hand-pose estimation"* over
the video and retarget 21 hand keypoints into robot joint space first. **Every large win adds
an extraction step or routes through language.** Pixels are the raw material, not the product.

Also worth knowing, because it kills a tempting shortcut: **visual realism is a bad proxy for
physical understanding.** Physics-IQ measured a Pearson **r = −0.46** between the two — Sora
scored best on realism and *worst* on physics (8.7 vs a 100 ceiling)
([arXiv 2501.09038](https://arxiv.org/abs/2501.09038)).

### 2.2 What frontier labs actually train on

| Lab | Human video? | Evidence quality |
|---|---|---|
| **Physical Intelligence** (π0/π0.5/π0.7) | Added egocentric human video only in Dec 2025; π0.5's 400 hrs across ~100 homes is *robot* data | arXiv reports — but π0.7 publishes **no** data table |
| **Google DeepMind** (Gemini Robotics 1.5) | **No** — named as *future work*: *"An important next step is to leverage… real-world human videos"* | 62-page report, **zero** occurrences of "hours" |
| **NVIDIA** (GR00T) | **Yes — 20,854 hrs (EgoScale)**, action-labeled; N1 used 88 hrs real teleop vs 6,500 sim-equivalent hours | Best-documented; open weights |
| **1X** | **Yes — 900 hrs** egocentric human video (1X World Model) | Blog, but quantified |
| **Figure** | Claims **"100% egocentric human video, no robot demonstrations"** — but for a *navigation* policy, no metrics | Blog only, no paper |
| **Skild AI** | Claims YouTube + headcam video | Marketing only, **zero numbers** |
| **Tesla** | Executive statements + in-house helmet-cam collectors ($25–48/hr) | **No technical artifact of any kind** |
| **Generalist AI** | GEN-1: 500k+ hrs from *"low-cost wearable devices on humans"* | Blog; sensorized wearables, not wild video |

**The pattern that matters: labs with peer-reviewable artifacts have modest, quantified, or
explicitly deferred human-video claims. Labs with the boldest human-video marketing publish no
papers and no hours.** And where labs *do* consume human video at scale, it is
**purpose-collected sensorized capture** (Figure↔Brookfield homes, NVIDIA EgoScale, Tesla
helmet rigs), never licensed third-party archives.

---

## 3. Demand: there is no archive-licensing market

**No robotics lab has publicly licensed a pre-existing third-party corpus at a disclosed
price.** What exists instead:

- **Commissioned collection to spec.** [Scale AI](https://scale.com/physical-ai) (1,000+
  hrs/day, "robotless egocentric platform"),
  [XDOF](https://techcrunch.com/2026/06/17/collecting-robot-training-data-is-dirty-unglamorous-work-some-ai-labs-are-already-paying-xdof-to-do-it/)
  ($70M raised, *"20 customers including several frontier AI labs"*),
  [Config](https://techcrunch.com/2026/05/11/koreas-biggest-manufacturers-back-config-the-tsmc-of-robot-data/)
  (100k+ hrs), [Mecka AI](https://fortune.com/2026/06/01/mecka-ai-series-a-60-million-robotics-data-training/)
  ($60M raised, ~$100M ARR run-rate on signed contracts). Industry-wide,
  [MIT Tech Review reports robotics companies spend *"more than $100 million each year"*](https://www.technologyreview.com/2026/04/01/1134863/humanoid-data-training-gig-economy-2026-breakthrough-technology/)
  buying real-world data — **as services, not archives**.
- **Access-for-equity.** [Figure↔Brookfield](https://www.figure.ai/news/figure-announces-strategic-partnership-with-brookfield):
  Brookfield gave access to 100k+ residential units *and invested in Figure's Series C*. No cash
  for data disclosed. **This is the closest structural analogue to our model — and it was paid
  in equity, not licensing fees.**
- **The one proven video-licensing market is generative media, not robotics:**
  [$1–4/minute for unpublished creator footage](https://the-decoder.com/openai-and-google-are-buying-youtubers-unpublished-videos-for-up-to-4-per-minute/).
  And it's lumpy: Shutterstock's data-licensing revenue **fell 47% to $21.0M in Q1 2026**.

**What buyers do require:** per-person releases naming AI training, all-party audio consent,
BIPA notice, chain of custody, de-identification, and **indemnity**. See §6 — this is where the
actual opportunity turns out to be.

---

## 4. What this data actually costs (and why most published prices are fiction)

**⚠️ Every per-hour client price circulating in this market is unsourced vendor marketing.**
An audit of SEC filings, federal procurement records, and journalism found that **no vendor
publishes a client-facing price for egocentric or robotics data — not one.** Scale, Mecka,
micro1, Turing, Objectways, Innodata, Appen, Telus: all demo-gated. EDGAR full-text search for
"egocentric video" in 10-Ks returns **zero hits**.

The widely-cited figures — `$25–60/hr egocentric`, `$340/hr (2024) → $118/hr (2026)` — trace to
[DataX Power](https://www.dataxpower.com/blog/humanoid-robot-data-collection-cost) and
roboticscenter.ai, both **SEO content sites with no methodology, no named team, no citations,
and a "Request a Quote" CTA.** They rank top-3 on Google, which is why they propagate. Do not
build a model on them.

**What IS verified — collector pay, from actual job postings:**

| Role | Pay | Note |
|---|---|---|
| [OpenTrain — egocentric video capture](https://www.opentrain.ai/jobs) | **$6.00/hr** | **Same rate for US, Canada, Brazil, Indonesia, Mexico** |
| OpenTrain — robot teleoperator | $30–55/hr | US, **on-site** |
| Objectways — egocentric (US) | $160 per 8-hr shift → 4 usable hrs | ≈$20/hr effort, ≈**$40/usable video-hour** |
| Objectways — international | $3–10/hr | approved hours only |
| [micro1 — chore filming](https://www.technologyreview.com/2026/04/01/1134863/humanoid-data-training-gig-economy-2026-breakthrough-technology/) | $15/hr | global |
| [Human Archive (YC W26)](https://techcrunch.com/2026/05/26/human-archive-taps-into-indias-services-startups-to-collect-data-for-physical-ai/) | **$1.00/hr** | India |

Two structural facts worth internalizing:

- **Geographic arbitrage has been replaced by task-category arbitrage.** OpenTrain pays a
  Californian and an Indonesian the *same* $6/hr for egocentric capture, while paying $30–55/hr
  for US on-site teleoperation. The discriminator is no longer country — it's whether you must
  physically show up somewhere the client controls. **Passive video capture is the commodity
  end of this market.**
- **"Approved hours only" is the load-bearing clause** in every posting, with rejection criteria
  (hands not in frame, poor lighting, "staged") pushing all quality risk onto the collector.
  **No posting discloses its rejection rate.**

**Two operational numbers that map onto our design:**

- **3–4 usable hours per operator per working day** (Unidata's disclosed metric). An 8-hour
  shift yields 3–4 billable hours, so cost per *delivered* hour is roughly 2× the wage. Our
  complete-job-gated minutes (§7) are the same idea; this is the industry's own yield benchmark
  to calibrate the ingest gate against.
- **This is a 35–45% gross-margin services business, not software** — audited: Appen **40.3%**,
  Innodata **40%** (AI-data segment compressing, 44% → 37% YoY), TaskUs ~37.8%, TELUS Digital
  23.5% GAAP. Take rates across the layer cluster at 30–60%. Anyone modeling data collection at
  software margins is wrong.

---

## 5. Supply: oversupply from three directions

1. **Free corpora already exceed any plausible output.**
   [Egocentric-100K](https://huggingface.co/datasets/builddotai/Egocentric-100K) is **100,405
   hours under Apache 2.0 — free, commercial use permitted.** Open X-Embodiment: 1M+
   trajectories, CC-BY. NVIDIA publishes sim data CC-BY-4.0. Our quota at 1,000 seats produces
   ≈1,667 hrs/yr — **1.7% of one free dataset.**
2. **YouTube is the unpriced competitor.** ChrisFix alone has 11M+ subscribers and the format is
   *explicitly first-person, narrated auto repair*. Thousands of hours are already public and
   scrapeable. Any VLM or benchmark buyer takes that first, for free.
3. **Chains can flood this cheaply.** A multi-state operator with 500 techs can generate more
   footage in a month than our whole pilot in a year, at marginal cost near zero.

**Plus DVI incumbency.** Video-documented inspection is *already standard practice* (Tekmetric
shops average **$741/RO with DVI vs $612 without**), and Shopmonkey's terms let it *"use the
Inputs and Outputs… to develop, improve, and evaluate the Services"* unless the shop opts out;
Tekmetric claims a *"transferable, sub-licensable"* license over user content. **But DVI footage
is the wrong footage** — a 30–90 second phone clip of a worn pad *to justify a sale*: condition
evidence, not a procedure record, no hands working, no continuous action. That gap is real. It
also means incumbents are positioned to become AI *builders*, not data *brokers*.

### 5.1 ⚠️ The cheap supply is legally exposed — and this is the strategic opening

Build AI's `Egocentric-100K` — the corpus that sets the free price floor — came from Egolab.AI's
capture at Indian garment factories. A
[Scroll.in investigation](https://scroll.in/article/1092960/how-big-tech-is-harnessing-the-data-of-indian-factory-workers-to-train-robots)
found workers at the named factory (Pearl Global, Gurugram) received **no separate payment** and
said **their consent was never obtained**. An Egolab executive: *"We took consent to use the
device and we did it in our own way."* The Hugging Face dataset card carries **no consent,
privacy, or provenance statement** for 14,228 recorded workers.

That inverts the competitive picture. In a market where
[*Bartz v. Anthropic*](https://www.jurist.org/news/2026/07/judge-approves-record-1-5-billion-settlement-involving-anthropic/)
established that **acquisition, not training, is where the $1.5B liability lives**, where the FTC
ordered algorithmic disgorgement over improperly obtained home video, and where EU AI Act Art. 53
imposes **lighter disclosure on licensed data than scraped data** — a serious buyer cannot safely
touch that corpus. Note also that
[Ego4D's own license is "AS-IS" with "NO FINANCIAL LIABILITY WHATSOEVER"](https://ego4d-data.org/pdfs/Ego4D-Licenses-Draft.pdf):
free corpora offer zero indemnity.

**There is currently no consented, documented, indemnified alternative at any price.**

---

## 6. Where the value actually is

**Not raw footage. The provenance file, with footage attached.**

Everything in §§2–5 says the pixels are a commodity headed toward zero. What is scarce is a
chain of custody a buyer's counsel can sign off on — and that is exactly what the consent
architecture (§10) and the spine linkage (§11) produce as a byproduct. Retrofitting consent onto
already-captured footage is impossible, which is precisely why the $1/hour competitors cannot
enter this position.

**The strongest under-explored buyer is not robotics — it's the diagnostics/repair-copilot
tier.** Bosch's ESI[tronic] AI assistant, Snap-on APOLLO GEN 4, ALLDATA (400k techs / 115k
shops), Mitchell 1, Identifix. They ship AI **now**, they have budget, and the asset they lack is
what both DVI footage and YouTube lack: **narrated expert diagnostic reasoning tied to a
confirmed outcome.** Our spine supplies the outcome half automatically. ⚠️ Caveat: these buyers
are architected around OEM procedures and DTC text, not video — this needs evangelism, and no
procurement precedent was found.

**Buyers ranked by realism:**

| # | Buyer | Wants | Blocker |
|---|---|---|---|
| 1 | Diagnostics copilots (Bosch, Snap-on, ALLDATA, Mitchell, Identifix) | Narrated reasoning + confirmed outcomes | Not architected for video; needs evangelism |
| 2 | Robotics foundation labs | Manipulation data | Real buyers, commodity prices, need annotation quality a head-cam can't give |
| 3 | Technician training / workforce | Curriculum content | They buy *content*, not training data; low ceiling |
| 4 | AR / smart-glasses assistance | Task recognition models | Perennially "about to be big" |
| 5 | Warranty fraud / repair verification | Verified capture *infrastructure* (C2PA-style), not a corpus | **Possibly a product idea rather than a data sale** |
| 6 | Video-understanding benchmarks | Expert procedural video | Academic budgets, ~zero revenue — but [ExAct](https://arxiv.org/html/2506.06277) shows Gemini 2.5 Pro at **55.35% vs 82.02% human experts**, a real capability gap |
| 7 | Insurance / claims | Damage condition evidence | **Closed** — Solera alone claims **1.5B+ damaged-vehicle images** |

---

## 7. The exchange: quota mechanics

Recording is **never mandatory** — it's a quota with escape valves. A mandate would make the shop
pressure customers, which poisons consent quality (the first thing a regulator tests). The
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

Worked examples: one narrated 50-min job = 100 min (**quota met with a single job** — this is the
pitch: *"one talked-through job a month covers your seat"*); two silent 50-min jobs = 100; five
silent 10-min quick jobs = 50; a narrated 2-hour repipe = 240 (this month + a month banked).

Why this shape survived the alternatives:

- **Minutes alone** reward duration → dead-air padding, idle-camera farming, per-video disputes.
  **Flat per-job credits** underpay a 3-hour repipe vs a 10-minute swap.
  **Complete-job-gated minutes** keep proportional fairness while fragments and padding earn 0.
- **The visit-duration cap makes padding self-defeating and cheating self-policing.** The spine
  records how long the tech was actually on site; video minutes beyond that don't count. The
  residual exploit — genuinely stretching a visit — costs the shop real billable hours (~$80/hr)
  to farm footage worth far less. Nobody selling to a data broker has this cross-check; it falls
  out of videos being linked to job records from birth.
- **The ingest gate adjudicates, not humans.** At upload it verifies the consent artifact,
  samples for completeness and active-work minutes, transcribes audio to validate a narration
  claim, applies the visit-duration cap, and returns counted minutes with a one-line reason
  ("counted 42 of 61 min — camera faced the van during material prep"). Explainable numbers, not
  judgment calls. Calibrate against the industry's **3–4 usable hours per 8-hour shift** (§4).
- **Graceful misses.** A shop that misses quota converts to a discounted paid rate for that
  month — pressure lands on the shop's wallet, never on a customer's doorstep.

Deliberately deferred (add from real ingest data, not speculation): rarity bonuses for uncommon
job types, per-job minute maximums, repeat-type caps. Launch with the five-line rule above — a
two-person shop must hold the whole deal in their head.

---

## 8. Valuation: why 100 minutes, and what's shaky about it

**Floor — what a free seat costs us:** inference (~$30/mo, the s2 GLM-5.2 baseline before the
cache-key trial) + share of box/Render/Supabase (~$10–15) + amortized support ≈
**$45–60/seat/mo**. Re-derive from the DeepInfra dashboard quarterly; if the cache trial lands,
the floor drops. **This half is solid** — it's our own bill.

**⚠️ Market anchor — this half is not solid.** The original derivation used $25–40/hr as the
replacement cost of footage, which put 100 min/mo at ≈$40–65 and neatly matched the seat cost.
Per §4, **that number is unsourced vendor marketing.** The truer comparables are collector wages
($1–15/hr) and free 100k-hour corpora. **Value per footage-hour should be revised downward**,
which pushes the quota up — and a higher quota is exactly what §7 warns creates customer
pressure. **This tension is unresolved and is the strongest argument for treating footage as a
strategic option and acquisition lever rather than as cost recovery.**

**The narration multiplier (×2) is still defensible on its own terms.** Narrated footage
replaces post-hoc annotation labor ([$4–8/annotator-hr](https://labelyourdata.com/pricing),
several hours per video hour, with
[skilled AI-trainer rates at $40–80/hr](https://www.opentrain.ai/jobs/video-annotation-ai-trainer--cmrg61b1600660ai2eqhpf8of/)),
and the diagnostic layer — *why* the tech checked the relief valve — exists only in the expert's
head at capture time; no annotator can reconstruct it later at any price. TRI's finding (§2.1)
that passive video paid off **through the language channel** is independent support. Crediting
narration at exactly 2× means the shop's cheapest path to quota is also our most valuable
footage — no arbitrage.

**Strategic overlay: don't tune for 100% cost recovery.** The free tier is simultaneously
customer acquisition (a shop that grows converts to paid seats) and an option on a dataset whose
defensibility rests on provenance (§6), not volume.

---

## 9. Capture spec: what footage is worth having

Ranked by what the evidence in §2 says actually matters:

1. **Hands + workpiece visible, first-person.** [Hands convey intent, objects convey task
   state](https://objectways.com/blog/training-robots-in-real-life-with-egocentric-data/);
   first-person avoids the perception–action mismatch that makes room-view tripod footage
   nearly worthless. Chest or head mount, framed on what the hands do.
2. **Failures and recoveries.** Humans generate [10× more valid recovery data per hour than
   robot teleoperation](https://arxiv.org/abs/2607.19745), and near-failure supervision is what
   makes policies robust. Real service calls contain the corroded fitting and the re-do that
   staged collection never has — **tell techs explicitly that mistakes and rework are the
   valuable footage; never cut them.**
3. **Complete jobs and diversity over volume.** The market is drowning in redundant easy-task
   footage; what stays scarce is unusual job types, varied sites/equipment, and
   diagnosis-to-cleanup completeness. A 2026 study found *"scene diversity matters more than
   scale"* ([arXiv 2606.06627](https://arxiv.org/html/2606.06627v1)), and π0.5 saturated at ~100
   environments.
4. **Ground-truth labels.** Spine linkage (job type, duration, outcome, callback) is free
   annotation that generic footage lacks — it raises the value of even our *silent* footage.
5. **Narration** — tech's voice only, at the workpiece, away from conversations.

Tech instructions in one line: *chest mount, hands in frame, record the whole job, keep rolling
when something goes wrong, talk through what you're doing and why.*

**If the robotics buyer ever becomes the target, capture must move up the ladder** — at minimum
stereo or multi-view for triangulated hand pose, ideally instrumented tools for torque. That's a
hardware program, not a software program, and it changes the unit economics completely.

---

## 10. Legal architecture (the hard part — and the moat)

The structural problem: consent must flow opposite to the video. The customer — who gets nothing
from the deal — must knowingly agree to being recorded, to footage going to **us** (a company
they've never heard of), and to **our actual uses**. A buried line in the shop's service
agreement accomplishes none of that.

**Risk map (US; checked 2026-07-26):**

- **Audio is the criminal-law tripwire.** ~[12 all-party-consent states](https://www.recordinglaw.com/party-two-party-consent-states/)
  (CA, FL, IL, WA, PA, MA, …) make recording a *conversation* without everyone's consent a
  crime. Video-only is treated far more leniently. → **Video-only by default; narration is an
  explicit audio-consent tier**, tech's voice only.
- **The home is the maximum-privacy location.** Invasion-of-privacy torts; video-voyeurism
  statutes if bathrooms/bedrooms are captured; unconsentable third parties (kids, family,
  visitors). → Framing rules: the work, not the room.
- **Twenty states have comprehensive privacy laws in effect in 2026**
  ([MultiState](https://www.multistate.us/insider/2026/2/4/all-of-the-comprehensive-privacy-laws-that-take-effect-in-2026)),
  and video of identifiable people is personal data — often *sensitive* (faces, health
  equipment, minors), requiring [explicit opt-in consent](https://www.clym.io/blog/us-privacy-law-comparison-map),
  deletion rights, purpose limitation. Face analysis would additionally trigger biometric
  statutes (IL BIPA — private right of action; TX CUBI). → We don't run face analysis; consent
  names purposes; deletion is architectural (§11).
- **Direct enforcement precedent: FTC v. Ring.** Home footage
  [used to train algorithms without adequate consent](https://www.eff.org/deeplinks/2023/06/ftc-forces-ring-take-user-privacy-seriously)
  → [$30M+ settlement](https://www.fastcompany.com/91113236/ftc-ring-refunds-customers-video-privacy-settlement)
  **plus deletion of models derived from the footage** (algorithmic disgorgement). → The consent
  form says "train automated systems" in plain words. Consent for "quality assurance" does not
  cover model training.
- **The barter structure has its own consequences.** Videos-as-payment makes the free tier a real
  contract (consideration; ask an accountant about barter tax treatment) and invites the "was
  consent freely given?" question — answered by quota-not-mandate, costless refusal, and
  graceful misses (§7). Techs being recorded → several states require employee-monitoring
  notice; program terms must obligate the shop to give it.

**Design responses:**

- **Per-job customer opt-in, signed before recording.** Heads-up at booking ("this visit may be
  recorded; you can decline" in the confirmation — no doorstep ambush), one-page plain-language
  form on arrival, Spanish version, one-sentence tech script. Refusal costs the customer nothing
  and the form says so; the job proceeds identically, unrecorded.
- **Form contents:** recorded by [shop], shared with [us], purposes including "improve our
  products and train automated systems," video-only unless the audio tier is signed, work areas
  only, retention period, deletion contact, no-penalty-refusal statement. Lawyer-reviewed
  template, versioned; store which version each customer signed.
- **Consent as a spine artifact.** Tech photographs the signed form → uploads via the agent →
  stored linked to the job record. Every video in our possession has an auditable consent trail.
  **Per §6 this is not compliance overhead — it is the product.**
- **Ingest rejection without consent.** Footage arriving with no linked consent is rejected,
  *not stored* — the same gate-before-possession principle as the L1 classify-before-insert
  rule: once we hold it, we can't un-hold it.
- **Program terms per shop:** use our consent flow, notify recorded employees, indemnify us for
  out-of-policy recordings, data-processing agreement. Contracts shift risk but don't eliminate
  it — the ingest gate is the verification.
- **Lawyer gate before launch.** Bring: draft consent form, program terms, intended uses stated
  bluntly (AI training included), launch-state list, the §11 data-flow diagram. Launch-state
  selection should account for the all-party-audio map if the narration tier ships at launch.

---

## 11. Data architecture

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

- **Videos live outside the spine, under opaque IDs.** The join lives in the visit row. The video
  store alone is pseudonymous: a breach, subpoena, or vendor scan of the bucket yields footage
  without names, addresses, or gate codes. Labels (job description) meet the video only at
  **export time, scrubbed** — keep the trade content ("replace 50-gal gas water heater"), drop
  the customer identity. The L2/L3 split makes this separation mostly free.
- **Hard constraint: videos and consent-revocable data NEVER enter `raw_captures` or any
  append-only store.** L1 has no delete path *by design*; deletion rights require one. Deletion
  request = spine lookup by visit → delete files → null pointers. A dangling pointer is fine; an
  undeletable video is a privacy-law violation waiting.
- **Treat the store as high-severity even though it's pseudonymous.** Site-interior footage is
  burglary-map data (valuables, layouts, occupancy). Short retention, tight access, encryption,
  lifecycle rules — designed in from day one, not bolted on. Footage is still personal data under
  the 20 state laws; separation limits blast radius, it does not anonymize.

---

## 12. The auto-repair question

Auto repair was proposed as the beachhead vertical on the theory that consent is lightest there.
The research pass produced a split verdict.

**The robotics angle is dead, and the market already voted.**
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

**Occlusion compounds and deserves emphasis:** hand-pose label quality is the measured transfer
bottleneck (triangulated 3D labels transfer far better than monocular; injected noise degrades
performance monotonically), and a head-cam under a car is the worst case for exactly that
signal. Even Apple concedes EgoDex's *"dexterous annotations can be imperfect, especially during
heavy occlusion."*

**Genuine points in auto repair's favor:**

- **Procedure ground truth is rare and we'd have it.** ALLDATA/Mitchell carry unedited OEM repair
  procedures and labor-time guides — footage can be aligned to a canonical procedure taxonomy.
  Most egocentric datasets have **no** ground-truth procedure spec.
- **Underrepresented verbs:** torquing, prying, seating, threading — robot datasets are dominated
  by pick-and-place.
- **No public egocentric corpus covers skilled trades in service settings.** Ego-Exo4D's only
  repair task is **bike repair (82 hrs)**; EgoDex is tabletop; EPIC-KITCHENS is cooking; Build AI
  is factory floors. ⚠️ But this cuts both ways: it may be unserved because **no buyer has
  asked** — no lab or vendor was found expressing demand for trades footage.

**⚠️ The consent assumption is reasoned, NOT researched** (the research session's search budget
ran out before this pass). The intuition that a car in a bay is lighter than a customer's living
room is directionally right — no home interior, no family members, no bystanders. But three items
need a real pass before it becomes a strategic premise: (a) **the technician is the primary
recorded subject**, so employee-monitoring notice duties apply and are the *shop's* obligation;
(b) the customer's **vehicle interior** can expose personal effects, documents, garage codes,
plates and VINs; (c) **shop-floor conversation audio** re-triggers the all-party-consent map if
narration ships. Lighter than in-home, not free.

**The strategic tension to resolve:** auto repair's consent-lightness is real, but it is the same
property that makes its footage easy for *everyone else* to collect (§5: YouTube, chains, DVI
incumbents). Trades work in homes is the genuinely unserved corpus. **Consent-hard and
data-scarce may be a better moat than consent-easy and data-abundant.**

---

## 13. Generalizing beyond trades

The reusable machine is: **(agent software a physical-labor SMB actually wants) + (job-record
spine = ground truth) + (consent chain as a product feature) + (automated ingest verification)**.
Any job-based physical-service vertical fits — HVAC/plumbing/electrical first, then appliance
repair, landscaping, cleaning, restoration.

### Competitive landscape (checked 2026-07-26)

**No company runs this exact barter** — enterprise software to physical-labor SMBs with footage
as the payment. Every *adjacent* seat is occupied, which validates the model while leaving this
specific position open:

- **Cash-for-footage collectors** (compete for the same footage, pay money instead of software):
  [Egolab.AI and Objectways strap head cams on factory and household workers](https://www.eweek.com/news/factory-workers-cameras-ai-robot-training/);
  [gig platforms recruit trades workers for recording tasks](https://www.micro1.ai/experts-guide/how-skilled-trade-based-workers-can-earn-from-ai-training);
  Mecka AI is the substantive one. All pay per hour, rebuild QA and consent per program, and own
  no ongoing software relationship with the business.
  ⚠️ **Tradeye — cited in an early draft as validating trades-footage demand — is a placeholder
  site** (logo, tagline, contact form; no products, team, or funding). Do not cite it.
- **Vertical-SaaS data moats, internal use only:** [ServiceTitan markets itself as "born in the
  trades, trained on the trades"](https://www.servicetitan.com/features/ai); CompanyCam holds
  huge contractor archives. Both are paid products; neither collects footage as *consideration*
  nor publicly licenses it as training data. **Watch item: an incumbent is one "record jobs for
  seat credits" program away from this model** — the durable defense is the consent + verification
  machinery and the ground-truth linkage, not the idea.
- **Product-plus-data-rights precedents:**
  [Nexar](https://venturebeat.com/uncategorized/nexar-which-sells-analytics-services-on-top-of-dash-cam-footage-raises-53m)
  sells dashcams and monetizes anonymized road data; Climate FieldView's
  [free basic tier](https://www.precisionfarmingdealer.com/articles/7198-helping-farmers-use-precision-tools-in-common-software-platforms)
  plus the [~$1B Climate Corp acquisition](https://www.globalagtechinitiative.com/digital-farming/data-management/climate-corp-connecting-the-fieldview-dots/)
  showed aggregated physical-world data carrying company-scale value behind free software.
- **Robot-deployment data flywheels** (the capital-heavy version of this thesis):
  [Physical Intelligence raised $1.4B](https://opendatascience.com/recent-2026-robotics-projects-you-should-know-about/);
  [Universal Robots × Scale AI](https://www.universal-robots.com/news-and-media/news-center/universal-robots-scale-ai-launch-imitation-learning-system-accelerate-ai-training-lab-to-factory/)
  ship an integrated customer-data flywheel. They deploy *robots* to earn data; we deploy
  *software* — radically cheaper per hour of footage.

---

## 14. Open questions / next steps

0. **Decide the buyer before scaling collection.** "Diagnostics-copilot corpus" and "robotics
   manipulation corpus" imply different capture specs, pricing, and verticals. Cheapest next
   step: 3–5 discovery calls with the diagnostics-copilot tier (Bosch, Snap-on,
   ALLDATA/Mitchell/Identifix). **Ask one question: *"what provenance documentation would you
   need before you could use footage like this?"*** Their answer prices the product better than
   anything findable on the open web (§4).
1. **Lawyer review** of the consent architecture (§10 checklist) — gate for everything else.
2. Draft the **template consent form** + tech script (+ Spanish); decide launch states.
3. **Meter real seat cost** off the DeepInfra dashboard for a quarter; re-derive the 100-min
   number from actuals (§8) — noting the market anchor is unverified and likely too high.
4. Design the **ingest gate** (consent check, completeness/active-minute estimation, narration
   scoring, visit-duration cross-check), calibrated against the 3–4 usable-hours-per-shift
   industry yield. A future RPI feature; not started.
5. Pick the **video store** + retention policy (deletable object storage, lifecycle rules).
6. **Accounting/tax** treatment of the barter; E&O/cyber insurance for holding site footage.
7. **Verify the auto-repair consent assumption** (§12) — employee-monitoring notice, customer
   personal effects/VIN/plate exposure, shop-floor conversation audio.
8. Revisit quota refinements (rarity bonuses, per-job caps) **only after** a quarter of real
   ingest data.

---

## 15. Three things to carry away

1. **Don't sell "we have footage." Sell "we have consented, outcome-labeled, procedure-aligned
   footage with indemnity."** Raw volume is commoditized from two directions, and the cheapest
   competing supply has documented consent problems (§5.1) — which makes clean provenance the
   scarce good, not the compliance overhead.
2. **If the robotics buyer matters, capture must move up the modality ladder** (§2) — stereo or
   multi-view for triangulated hand pose, instrumented tools for torque. That is a hardware
   program with completely different unit economics. Decide deliberately; don't drift into it.
3. **Consent-hard, data-scarce beats consent-easy, data-abundant.** The property that makes a
   vertical easy to collect in is the same property that makes its footage worthless. Trades
   in-home is unserved precisely because it is hard.

---

## Sources

**Training value / modalities:** [ALOHA](https://arxiv.org/abs/2304.13705) ·
[EgoDex (Apple)](https://arxiv.org/abs/2505.11709) · [UMI](https://umi-gripper.github.io/) ·
[Sparsh-X tactile](https://arxiv.org/abs/2506.14754) ·
[TRI co-training study](https://arxiv.org/abs/2602.01067) ·
[HumanEgo](https://arxiv.org/abs/2605.24934) ·
[Dasari et al., CoRL 2023](https://arxiv.org/abs/2310.09289) ·
[LARY benchmark](https://arxiv.org/abs/2604.11689) ·
[VC-1/CortexBench](https://arxiv.org/abs/2303.18240) ·
[ATM](https://arxiv.org/abs/2401.00025) · [GR-1](https://arxiv.org/abs/2312.13139) ·
[VPP](https://arxiv.org/abs/2412.14803) · [EgoScale](https://arxiv.org/abs/2602.16710) ·
[Physics-IQ](https://arxiv.org/abs/2501.09038) ·
[scene-diversity study](https://arxiv.org/html/2606.06627v1) ·
[EgoRecovery](https://arxiv.org/abs/2607.19745) ·
[ExAct](https://arxiv.org/html/2506.06277) ·
[Brooks on dexterity](https://rodneybrooks.com/why-todays-humanoids-wont-learn-dexterity/) ·
[Objectways on egocentric data](https://objectways.com/blog/training-robots-in-real-life-with-egocentric-data/).

**Market / demand / supply:** [Scale physical AI](https://scale.com/physical-ai) ·
[XDOF (TechCrunch)](https://techcrunch.com/2026/06/17/collecting-robot-training-data-is-dirty-unglamorous-work-some-ai-labs-are-already-paying-xdof-to-do-it/) ·
[Config (TechCrunch)](https://techcrunch.com/2026/05/11/koreas-biggest-manufacturers-back-config-the-tsmc-of-robot-data/) ·
[Mecka AI (Fortune)](https://fortune.com/2026/06/01/mecka-ai-series-a-60-million-robotics-data-training/) ·
[MIT Tech Review on collection gig work](https://www.technologyreview.com/2026/04/01/1134863/humanoid-data-training-gig-economy-2026-breakthrough-technology/) ·
[Figure↔Brookfield](https://www.figure.ai/news/figure-announces-strategic-partnership-with-brookfield) ·
[Egocentric-100K](https://huggingface.co/datasets/builddotai/Egocentric-100K) ·
[OpenTrain job board](https://www.opentrain.ai/jobs) ·
[Human Archive (TechCrunch)](https://techcrunch.com/2026/05/26/human-archive-taps-into-indias-services-startups-to-collect-data-for-physical-ai/) ·
[Rest of World: China data work](https://restofworld.org/2026/china-ai-robotics-training-data/) ·
[creator-footage licensing $1–4/min](https://the-decoder.com/openai-and-google-are-buying-youtubers-unpublished-videos-for-up-to-4-per-minute/) ·
[SCSP/ISF robotics data gap](https://scsp222.substack.com/p/isf-voices-2026-the-robotics-data) ·
[physicl.ai embodied AI](https://www.physicl.ai/insights/embodied-ai) ·
[Labellerr egocentric datasets](https://www.labellerr.com/blog/egocentric-datasets-robotics/) ·
[Label Your Data annotation pricing](https://labelyourdata.com/pricing) ·
[OpenTrain trainer rates](https://www.opentrain.ai/jobs/video-annotation-ai-trainer--cmrg61b1600660ai2eqhpf8of/).
⚠️ *Unsourced vendor content, cited only as industry claims:*
[DataX Power](https://www.dataxpower.com/blog/humanoid-robot-data-collection-cost) ·
[roboticscenter.ai](https://www.roboticscenter.ai/en/blog/robot-data-collection-cost) ·
[FlikForge data glut](https://flikforge.com/robot-data-glut-egocentric-video-physical-ai/).

**Auto repair:** [RoboTire Chapter 7](https://www.moderntiredealer.com/home/article/33019234/robotire-files-for-bankruptcy) ·
[Automated Tire SmartBay](https://www.therobotreport.com/automated-tire-decloaks-smartbay-autonomous-tire-changing/) ·
[UVeye funding](https://www.prnewswire.com/news-releases/uveye-secures-191m-in-funding-to-meet-soaring-demand-for-ai-powered-vehicle-inspection-systems-302363100.html) ·
[ServiceTitan AI](https://www.servicetitan.com/features/ai).

**Legal:** [MultiState 2026 state privacy laws](https://www.multistate.us/insider/2026/2/4/all-of-the-comprehensive-privacy-laws-that-take-effect-in-2026) ·
[Clym state-law comparison](https://www.clym.io/blog/us-privacy-law-comparison-map) ·
[Recording Law all-party consent states](https://www.recordinglaw.com/party-two-party-consent-states/) ·
[EFF on FTC v. Ring](https://www.eff.org/deeplinks/2023/06/ftc-forces-ring-take-user-privacy-seriously) ·
[Ring settlement coverage](https://www.fastcompany.com/91113236/ftc-ring-refunds-customers-video-privacy-settlement) ·
[Avvo video vs. audio consent](https://www.avvo.com/legal-answers/can-i-video-and-audio-record-a-repairman-in-my-hom-4781668.html) ·
[Bartz v. Anthropic settlement](https://www.jurist.org/news/2026/07/judge-approves-record-1-5-billion-settlement-involving-anthropic/) ·
[Ego4D license (AS-IS, no liability)](https://ego4d-data.org/pdfs/Ego4D-Licenses-Draft.pdf) ·
[Scroll.in on Indian factory-worker capture](https://scroll.in/article/1092960/how-big-tech-is-harnessing-the-data-of-indian-factory-workers-to-train-robots).

**Precedents:** [Nexar data model](https://venturebeat.com/uncategorized/nexar-which-sells-analytics-services-on-top-of-dash-cam-footage-raises-53m) ·
[FieldView free tier](https://www.precisionfarmingdealer.com/articles/7198-helping-farmers-use-precision-tools-in-common-software-platforms) ·
[Climate Corp acquisition](https://www.globalagtechinitiative.com/digital-farming/data-management/climate-corp-connecting-the-fieldview-dots/) ·
[Physical Intelligence $1.4B](https://opendatascience.com/recent-2026-robotics-projects-you-should-know-about/) ·
[UR × Scale AI flywheel](https://www.universal-robots.com/news-and-media/news-center/universal-robots-scale-ai-launch-imitation-learning-system-accelerate-ai-training-lab-to-factory/).
