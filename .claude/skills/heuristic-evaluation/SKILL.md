---
name: heuristic-evaluation
description: How to run a professional expert review of an app or website's UI, visual design, and accessibility. Three independent review modules — A) Heuristic/usability (Nielsen's 10), B) Visual design ("looks"), C) Accessibility (a11y) — plus a shared process, the 0–4 severity scale, and a per-module report format. Run only the modules a task needs. Consult whenever asked to review, critique, audit, or "check the design/looks" of any screen, page, flow, email, or interface. Includes a solo-evaluator adaptation for when Claude is the only reviewer.
---

# Design review: heuristic, visual & accessibility

Expert-inspection review of an interface. **Three distinct methods live here** — they are *not* one
blended pass:

- **Module A — Heuristic evaluation (usability):** Nielsen's 10 heuristics. This is what "heuristic
  evaluation" technically means. Answers *"what happens when the user acts?"*
- **Module B — Visual design review ("looks"):** scale, hierarchy, balance, contrast, Gestalt,
  typography, color, spacing. Answers *"how does it look standing still?"*
- **Module C — Accessibility audit (a11y):** POUR — can *everyone* perceive and operate it.

They were kept separate on purpose: bundling them into one pass produces repetitive, blended
findings (contrast, consistency, and clutter each straddle two methods). Keeping them as modules —
each with its own rubric and its own report section — gives full coverage with no mush. **Run only
the modules the task calls for** (a "check the looks" ask = B, maybe C; a full audit = all three).

Inspection is *fast and cheap* ("discount usability engineering") but it finds *violations of known
principles* — it **cannot replace user testing**, which reveals context-specific problems no rubric
predicts. State this whenever you report.

---

## Part 1 — The process (shared by all modules)

1. **Define scope.** Exact target: which screens, which task/flow, which user group, which
   device/viewport. Narrow it — a whole product at once is unmanageable. State the *primary user
   goal*; findings are judged relative to it.
2. **Gather evidence.** Screenshot each screen/state (default, hover, focus, error, empty, loading),
   the flow in order, both viewports if responsive. In this env: `browse` / `gstack` skills or
   `claude-in-chrome` for live web; capture the webview for the Telegram board Mini App. A finding
   without a located screenshot is weak.
3. **Pick modules, then run each as its own pass.** For each chosen module: first walk the flow once
   just to learn it (don't grade), then walk it again grading against *that module's rubric only*.
   Keeping passes separate is what stops findings blending.
4. **Log each finding as a row** in that module's table (Part 5): problem, location (+screenshot),
   rule violated, severity, recommendation.
5. **Consolidate within each module.** Cluster related findings, dedupe. **One issue = one row**,
   keyed to its rule; dedupe by **location + problem**, never by rule.
6. **Rate severity** (Part 4), sort each module's table worst-first.
7. **Report** — one section per module + a combined prioritized fix list (Part 6).

**Boundary rule (the only place modules touch):** *contrast* and *consistency* appear in two
modules — route by the question, don't double-log. Contrast **ratio** (measurable, 4.5:1) → Module
C; contrast as **emphasis** (is the CTA distinct) → Module B. **Behavioral** consistency (same word
= same result) → Module A; **visual** consistency (button styling) → Module B.

**Evaluators.** One reviewer finds only a fraction of problems. Nielsen: **3–5 independent
evaluators is the sweet spot; ~5 find ~75% of issues.** Work independently, then merge. ~1–2 hrs per
evaluator per scope.

> **Solo-evaluator adaptation (Claude as the only reviewer).** One reviewer = low coverage, so use
> the **modules themselves as your independent passes** — each has a different mental model, which is
> what makes multiple human evaluators find more. Run A, then B, then C as fully separate passes;
> don't let a later pass anchor on the earlier. Then consolidate. Always state this is one AI
> reviewer and does not replace 3–5 humans or user testing.

---

## Part 2 — Module A: Heuristic evaluation (Nielsen's 10 usability heuristics)

The canonical set (Nielsen & Molich 1990, refined 1994, wording updated 2020; unchanged since 1994).
Principle + what to look for.

1. **Visibility of system status.** Timely feedback on what's happening. *Look for:* missing
   loading/progress, silent state changes, unclear current step/location, actions with no
   confirmation.
2. **Match between system and the real world.** Users' language, real-world conventions/order.
   *Look for:* jargon, DB/dev terms leaking to UI, unfamiliar icons, unnatural sequences (this repo:
   trades/HVAC language, not schema names).
3. **User control and freedom.** Clear "emergency exits" — undo/redo, cancel, back. *Look for:* no
   undo, no exit from modal/flow, destructive actions with no reversal, trapped states.
4. **Consistency and standards** (behavioral). Same word/action means the same thing; follow
   platform conventions. *Look for:* one term for two things, off-platform patterns, inconsistent
   action results. *(Visual consistency → Module B.)*
5. **Error prevention.** Stop problems before they happen. *Look for:* no confirm on destructive
   actions, missing input constraints/good defaults, easy slips, ambiguous choices.
6. **Recognition rather than recall.** Make options/info visible; don't force memory across screens.
   *Look for:* data to memorize + re-enter, hidden required options, context not carried forward.
7. **Flexibility and efficiency of use.** Accelerators for experts, defaults for novices. *Look
   for:* no shortcuts/bulk actions/keyboard, no personalization, everyone forced down the slow path.
8. **Aesthetic and minimalist design.** Every extra element competes with essentials. *Look for:*
   clutter, low signal-to-noise, redundant content, too many CTAs, walls of text. (Means *focused*,
   not "flat.")
9. **Help users recognize, diagnose, recover from errors.** Plain language (no codes), name the
   problem, suggest a fix. *Look for:* raw error codes, vague "something went wrong," blame tone, no
   recovery path.
10. **Help and documentation.** Ideally none needed; if needed, searchable, contextual, concise.
    *Look for:* no help where users get stuck, buried/generic docs.

---

## Part 3 — Module B: Visual design review ("looks")

For "how does it look" — the module Nielsen's 10 barely covers. Drives whether an interface reads as
organized, credible, and polished.

- **Scale.** Relative size signals rank. *Look for:* everything same size (no priority), or too many
  sizes. Rule of thumb: **~3 sizes**.
- **Visual hierarchy.** Eye moves in order of importance via size, weight, color, spacing, position.
  *Look for:* no focal point, primary action not dominant, competing elements.
- **Balance.** Visual weight distributed sensibly (symmetric = calm; asymmetric = dynamic; radial =
  centered). *Look for:* lopsided layouts, cramped vs. empty zones.
- **Contrast (emphasis).** Dissimilar things look dissimilar; creates emphasis. *Look for:* CTAs
  that don't stand out, everything shouting (no contrast = no emphasis). *(Contrast ratio for
  legibility → Module C.)*
- **Gestalt principles** (how the eye groups): **proximity** (near = related — group by spacing, not
  just lines), **similarity** (like-styled = same kind), **common region** (shared container =
  group), **continuity** (aligned = connected), **closure**, **figure/ground** (clear subject vs.
  background). *Look for:* related items far apart / unrelated crammed together, misalignment, weak
  figure/ground on modals.
- **Typography.** Structure + style. Consistent type scale, line length ~50–75 chars, adequate
  line-height, few font families. *Look for:* too many fonts/sizes, tiny body text, tight leading,
  inconsistent heading levels.
- **Color.** Purposeful palette; color carries meaning without overwhelming; never meaning by color
  *alone* (→ C). *Look for:* too many accents, inconsistent semantic colors, brand palette not
  applied.
- **Spacing / whitespace & alignment.** Consistent spacing scale + grid; whitespace groups and gives
  breathing room. *Look for:* inconsistent margins/padding, off-grid elements, ragged alignment.
- **Design-system consistency** (visual). Reused components/tokens/radii/shadows behave the same.
  *Look for:* one-off button/card variants, mismatched radii/shadows, screen-to-screen drift, AI
  "slop" (generic gradients, centered-everything, emoji-as-icons, filler copy).

---

## Part 4 — Module C: Accessibility audit (a11y)

Full WCAG = 78+ criteria — too much for a quick pass. Use **POUR** as heuristics for the common,
high-impact barriers:

- **Perceivable.** Alt text on images/icons; captions/transcripts for media; **contrast ≥ 4.5:1
  normal text, ≥ 3:1 large text**; meaning never by color alone; content reflows at zoom.
- **Operable.** Fully keyboard-operable; **visible focus indicator** (≥ 3:1 if overriding defaults);
  logical focus/tab order; no keyboard traps; **touch targets ~44×44px**; no dangerous flashing.
- **Understandable.** Labels on all fields; clear instructions/error text; predictable behavior;
  consistent navigation; plain language.
- **Robust.** Correct semantic HTML / ARIA so assistive tech can parse it; works across
  browsers/AT.

*Also run automated tools (axe, Lighthouse)* — they catch programmatic issues (missing alt, bad
ARIA, contrast); this pass catches the judgment issues (focus order, tiny targets, color-only
meaning) they can't.

---

## Part 5 — Severity rating (0–4, all modules)

Rate every finding. Nielsen's scale, verbatim:

| Rating | Meaning |
|:--:|---|
| **0** | Not a problem at all |
| **1** | **Cosmetic** — fix only if spare time |
| **2** | **Minor** — low priority |
| **3** | **Major** — important, high priority |
| **4** | **Catastrophe** — imperative to fix before release |

Severity blends: **frequency** (how often hit), **impact** (how hard to get past), **persistence**
(hit once vs. repeatedly), plus **market impact** (effect on adoption, even if trivial to fix).
Collect ratings *after* the pass, not mid-inspection. With multiple evaluators, use the **mean**.

---

## Part 6 — The deliverable (report format)

1. **Executive summary** — scope, which modules ran, # evaluators/passes, counts by severity, top
   3–5 issues one line each, solo-evaluator caveat if applicable.
2. **Methodology** — target, device/viewport, modules used.
3. **One findings section per module** (A / B / C), each its own table, sorted worst-first:

   | # | Problem | Location (+screenshot) | Rule violated | Severity (0–4) | Recommendation |
   |---|---------|------------------------|---------------|:--------------:|----------------|

4. **Combined fix list** — all findings across modules, prioritized by severity (4→1). Augment
   severity-3/4 items with an example fix (corrected mockup, reference screenshot, or "do this
   instead").
5. **Limitations** — expert inspection, not user testing; gaps needing real users/follow-up.

**Each finding must have all five:** specific problem (not "improve UX"), located anchor
(screen + screenshot region), the exact rule it violates, a severity, and a fix.

---

## Pitfalls & rules

- **Rubrics are guidelines, not laws.** A violation is a *candidate* problem; context can justify
  breaking one. Flag intentional-looking violations as "may need user research," don't just condemn.
- **Inspection ≠ testing.** Never claim the design "works" from this alone.
- **Anchor to evidence.** Every finding points at a screenshot/element.
- **Finding vs. preference.** "CTA contrast 2.9:1 < 4.5:1" is a finding; "I'd prefer blue" is a
  preference — label preferences as such.
- **Coverage over cleverness.** Walk every screen/state against the chosen module's whole rubric;
  don't just report the first flashy thing.
- **Run the right modules.** "Looks" ask → B (+C for contrast/legibility). Don't force a usability
  audit when the ask was visual, or vice versa.
- **Sibling skills:** gstack `design-review` / `qa` *do and fix*; this skill is the *rubric* they and
  any ad-hoc review score against. Use `browse` / `claude-in-chrome` to capture evidence.
- *Optional cross-check:* Shneiderman's 8 Golden Rules (consistency, shortcuts, feedback, closure,
  error handling, reversal, control, memory-load) overlap ~90% with Module A — use only as a final
  completeness sweep, never as a separate pass.

---

## Sources (verified live, 2026-07-31)

- Nielsen, *10 Usability Heuristics for User Interface Design* — https://www.nngroup.com/articles/ten-usability-heuristics/
- Nielsen Norman Group, *How to Conduct a Heuristic Evaluation* — https://www.nngroup.com/articles/how-to-conduct-a-heuristic-evaluation/
- Nielsen, *Severity Ratings for Usability Problems* — https://www.nngroup.com/articles/how-to-rate-the-severity-of-usability-problems/
- Nielsen, *The Theory Behind Heuristic Evaluations* (evaluator counts, ~75% at 5) — https://www.nngroup.com/articles/how-to-conduct-a-heuristic-evaluation/theory-heuristic-evaluations/
- Nielsen Norman Group, *5 Principles of Visual Design in UX* — https://www.nngroup.com/articles/principles-visual-design/
- Shneiderman, *Eight Golden Rules of Interface Design* — https://public-media.interaction-design.org/pdf/Shneiderman.s.Eight.Golden.Rules.Worksheet.pdf
- W3C WAI, *WCAG 2.2 Quick Reference* (POUR, contrast, focus, targets) — https://www.w3.org/WAI/WCAG22/quickref/
- WebAIM, *Contrast and Color Accessibility* — https://webaim.org/articles/contrast/
