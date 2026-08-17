# Tool status — what in the guide has gone stale

The Demand Curve Growth Guide was written years ago. The **frameworks** hold up; some of the
**tools** it names do not. Check this file before recommending any tool the guide mentions.

Last verified: **2026-08-17** (liveness checked by HTTP request; sunset claims checked against
vendor docs).

## Dead — do not recommend

| Tool | Status | What to say instead |
|---|---|---|
| **Google Optimize** / Optimize 360 | **Shut down 2023-09-30.** Google built no direct replacement; it exposed APIs and named integration partners instead. ([Google support](https://support.google.com/optimize/answer/12979939)) | Google's own named partners: **AB Tasty, Optimizely, VWO**. Also common: PostHog, GrowthBook, Statsig. For a low-traffic startup, GrowthBook or PostHog (both have free tiers) are the usual pick. |

**This matters for ch. 7 (A/B Tests).** That chapter's *math* is still correct — the 1,000-visit /
10,000-visit thresholds, macro-vs-micro, one-test-at-a-time, run-in-parallel, new-users-only. But
"Probability to be Best ≥ 70%" is a **Google Optimize column name**. Other tools express the same
idea as "chance to beat baseline," "probability to beat control," or a frequentist p-value /
confidence interval. Translate the concept; never tell someone to open Google Optimize.

## Live as of 2026-08-17

Confirmed reachable: Ahrefs, BuzzSumo, Hotjar, FullStory, SimilarWeb, BuiltWith, Sensor Tower,
Throttle (throttlehq.com), Crunchbase, SEMrush.

**Meta Ad Library** (`facebook.com/ads/library/`) is live but blocks automated requests — it
returns 403 to scripts and works normally in a browser. Never report it as dead on the basis of a
failed fetch; it is also now branded "Meta Ad Library," not "Facebook Ads Library."

## Platform drift to assume, not assert

Ch. 5 (Running Ads) is the most time-sensitive chapter in the guide. Its **strategy** is durable —
campaign/ad set/ad hierarchy, one ad set per (audience × value prop), sample-size discipline,
CPA-over-CTR, retargeting audience construction, fatigue handling. Its **UI specifics** are not:
exact Ads Manager column names, the objective picker, the lookalike breadth slider, available CTA
button texts, and iOS-privacy-driven changes to pixel attribution have all moved since it was
written.

**Rule:** when a task depends on a current platform specific — a column name, a targeting option, a
policy limit, an attribution window — verify it against Meta's live docs and cite the URL. Do not
assert it from this guide. This is the repo's standing rule in CLAUDE.md ("External services —
verify against live docs first") applied to ad platforms.

Note also: Demand Curve's own ad agency is referred to in the guide as both **Demand Curve** and
**Bell Curve** (the older name) — same firm, not two data points.
