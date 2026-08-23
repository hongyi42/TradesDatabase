---
target: the landing page
total_score: 22
max_score: 36
na_heuristics: 10
p0_count: 1
p1_count: 3
timestamp: 2026-08-22
slug: web-portal-src-screens-landing-tsx
supersedes: 2026-08-21-landing-critique.md
---
# Critique — TradesDatabase landing page (post-Carbon)

Method: solo evaluator (Claude), modules run as three separate passes per the skill's
solo-evaluator adaptation. **One AI reviewer is not 3–5 humans and is not user testing** —
Nielsen puts a single evaluator well under half of findable issues.

## Design Health Score — 22/36 (heuristic 10 n/a)

Identical total to 2026-08-21, **different composition.** The Carbon rebuild fixed two real
defects and introduced none visually, but the two lowest scores were never design problems and
so the redesign could not move them.

| # | Heuristic | 08-21 | 08-22 | Movement |
|---|---|:--:|:--:|---|
| 1 | Visibility of System Status | 2 | 2 | Play button fixed (+1); form confirms a send that never happens (−1) |
| 2 | Match System / Real World | 3 | 3 | "Sandbox ready" still our word, not the trade's |
| 3 | User Control and Freedom | 3 | 3 | Still no way to review or correct a submission |
| 4 | Consistency and Standards | 3 | 3 | Play ring + scrub bar still promise a video; it scrolls instead |
| 5 | Error Prevention | 2 | 2 | Still zero validation design — no `:invalid`, no `aria-invalid`, no error rule |
| 6 | Recognition Rather Than Recall | 3 | 3 | Calculator total still not carried into the form |
| 7 | Flexibility and Efficiency | 2 | 2 | Nav still `display:none` at 375px — now on a 6,213px page |
| 8 | Aesthetic and Minimalist Design | 3 | 3 | 880px of unshot plate = 14.2% of the mobile page |
| 9 | Error Recovery | 1 | 1 | No error state exists anywhere |
| 10 | Help and Documentation | n/a | n/a | No docs site; onboarding is by hand, by design |

**Fixed since 08-21:** hero play button now receives `onSeeHow` (was a dead control);
`Status/Terms/Privacy` dead anchors removed; pricing rebuilt from SaaS cards into ledger rows.

---

## MODULE A — Heuristic (Nielsen's 10)

| # | Problem | Location | Rule | Sev | Fix |
|---|---|---|---|:--:|---|
| A1 | Contact form submits nothing and tells the user "we'll come back to you today". `onSubmit` is `preventDefault()` → `setSent(true)`. Verified live: filled and submitted, **zero POST requests** in the network log, success state rendered. Every lead on the page's only conversion surface is silently lost. | [ContactForm.tsx:49-53](../../../web/portal/src/components/ContactForm.tsx#L49-L53), success copy at :37 | #1 Visibility of system status | **4** | Either wire it, or replace the promise with a mailto/Calendly that actually reaches someone. Do not ship a confirmation for an action that did not occur. |
| A2 | No nav at mobile width. All three anchors are `display:none` below 520px with no replacement — no hamburger, no in-page menu. At 375px the page is 6,213px / 7.7 screens with only "Sign in" reachable from the header. | `.ld-nav-link`, landing.css | #7 Flexibility and efficiency | **3** | Anything: a sticky bottom CTA, a disclosure menu, or anchor chips under the hero. |
| A3 | Video affordance never becomes a video. Play ring, scrub bar and 00:00/01:30 timecodes read unambiguously as a player; clicking scrolls to `#product`. Better than the dead control it replaced, but it still promises playback. | [Landing.tsx:174-180](../../../web/portal/src/screens/Landing.tsx#L174), VideoPlaceholder.tsx | #4 Consistency and standards | **3** | Drop the scrub bar and timecodes, or relabel the control as what it does. |
| A4 | Zero validation design. No `:invalid`, `:user-invalid`, `aria-invalid` or error rule anywhere in 1,293 lines of CSS. Four `required` fields fall back to the browser's native bubble, which is unstyled, transient, and vanishes on scroll. | landing.css (absence), ContactForm.tsx | #5 Error prevention | **3** | Inline messages under each field, `aria-describedby`, persistent until fixed. |
| A5 | No error state exists on the page at all. There is no failure path to design against today because nothing submits — but A1's fix creates one immediately. | page-wide | #9 Error recovery | **3** | Design it in the same change as A1, not after. |
| A6 | The calculator total ($280 at defaults) sits ~3,000px above the form and is never carried into it. The reader decides on a number, then has to remember it. | `.ld-total` → `#contact` | #6 Recognition not recall | **2** | Pass the configured seat counts into the form as a prefilled line. |
| A7 | "Sandbox ready" is our vocabulary, not a contractor's. "Everything opposite" (manager seat items) describes a *desktop layout position* and is meaningless once the cards stack on mobile. | STEPS at [Landing.tsx:82](../../../web/portal/src/screens/Landing.tsx#L82); manager items at :429 | #2 Match real world | **2** | "Their bot is live." / "Everything a technician gets, plus:" |
| A8 | Calculator clamps at 60 seats for a product sold to 5–50 person firms, and technicians can be stepped to 0 — a configuration with no product in it. | `clamp()` at [Landing.tsx:110](../../../web/portal/src/screens/Landing.tsx#L110) | #5 Error prevention | **1** | Clamp technicians at 1; cap near 50. |

## MODULE B — Visual design ("looks")

| # | Problem | Location | Rule | Sev | Fix |
|---|---|---|---|:--:|---|
| B1 | **The page runs two type systems at once — the exact failure `DESIGN.md` §3 warns about.** Every role ≥26px is weight **300** at `-0.01em` (Carbon). Every role 19–23px is weight **600** at `-0.02em` (the retired system). Measured: h1 38/300, h2 26/300, price 46/300, seat-name 28/300 — then quote 22/**600**, step-title 23/**600**, claim-title 21/**600**, wordmark 21/**600**, film-title 19/**600**. The break is at ~24px and it runs through five of eight bands. **This is the single strongest reason the page still reads as generated**: Carbon's signature is thin display type, and half the page's headings are stock-semibold. | landing.css :228, :280, :607, :911, :945 + [ContactForm.tsx:32](../../../web/portal/src/components/ContactForm.tsx#L32) (700 / `-0.02em`) | Typography; design-system consistency | **3** | Move all six to weight 300 / `-0.01em`. This is the highest looks-per-line-changed fix on the page. |
| B2 | 23 distinct type steps where `DESIGN.md` §3 documents 8 roles. The body range alone runs 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 17, 18 — ten steps where the system specifies three. Near-twin sizes (12 vs 12.5, 14 vs 14.5) are the signature of values typed inline rather than pulled from a scale. | 34 inline `style={{}}` objects in Landing.tsx; `fontSize: 12.5` ×4, `13`, `13.5` | Typography; scale | **3** | Collapse to the documented roles; promote the survivors to CSS classes. |
| B3 | The skeleton is unchanged from both previous designs: 8 bands, each 281–702px, each announced by one centred heading, backgrounds alternating on a metronome. Regularity reads as generated; irregularity reads as authored. Neither redesign touched it — they repainted it. | page structure, [Landing.tsx:154-540](../../../web/portal/src/screens/Landing.tsx#L154) | Balance; rhythm; AI slop | **3** | Break the cadence: lead with the proof, merge two bands, let one band be a different shape. |
| B4 | The hero is 50/50 text-left / media-right — the most transplantable layout in SaaS — and the media half is a hatch plate. The page's most valuable space holds an IOU while its one genuinely unique asset (chat → job sheet with the SOURCE block) is buried in band four. | `.ld-hero-inner`, `.ld-proof` | Hierarchy; figure/ground | **3** | Promote the proof into the hero. Flagged as an open question by the 08-21 critique and still open. |
| B5 | 880px of unshot photo plate at 375px = 14.2% of the page. Honest (§6 forbids stock, correctly) but it is a large fraction of the first impression. | `.ld-plate` ×4 | Aesthetic/minimalist | **2** | Fewer, smaller plates until the shoot happens. |
| B6 | Source comment drift: the file header still describes "DARK SHELL, RECORDS ON PAPER… a cool steel dark" and claims to implement `handoff-landing-v2/` in full — the system Carbon replaced, and which `docs/design/README.md` marks HISTORICAL. Section comments still carry the `01/`–`05/` numbering §6 bans from the UI. | [Landing.tsx:7-19](../../../web/portal/src/screens/Landing.tsx#L7) | Design-system consistency | **2** | Rewrite the header to Carbon; drop the numbering. |

## MODULE C — Accessibility (POUR)

| # | Problem | Location | Rule | Sev | Fix |
|---|---|---|---|:--:|---|
| C1 | Skip link targets `#product` — band four. "Skip to content" jumps the keyboard user past the h1, the lead and the primary CTA. | [Landing.tsx:120](../../../web/portal/src/screens/Landing.tsx#L120) | Operable — bypass blocks | **3** | Target `<main>`, which already exists. |
| C2 | `aria-live` is on the seat *counts*, not the *total*. A screen-reader user stepping seats hears "2", "3" — never the figure they are there to learn. | [Landing.tsx:465](../../../web/portal/src/screens/Landing.tsx#L465), `.ld-total` has none | Perceivable — status changes | **3** | Move `aria-live="polite"` to `.ld-total`. |
| C3 | Five `PhotoPlate`s announce production notes to screen readers: *"Photograph to be shot: Truck doors open, first light."* Sighted users see a marked placeholder; AT users get the shot brief as content. | [Landing.tsx:97](../../../web/portal/src/screens/Landing.tsx#L97) | Perceivable — non-text content | **2** | `role="presentation"` while unshot, or a plain description of intent. |
| C4 | Touch targets under 44×44: four `.ld-input` at 42px, `.ld-skip` at 43px. Marginal. | ContactForm inputs | Operable — target size | **1** | Raise to 44. |
| C5 | Textarea uses a realistic placeholder as its only in-field hint ("Chasing job sheets, reports going missing…"); it has a real `<span>` label, so this is a downgrade from 08-21's finding but the placeholder still disappears on focus. | [ContactForm.tsx:111](../../../web/portal/src/components/ContactForm.tsx#L111) | Understandable — labels | **1** | Move the examples to persistent helper text. |

**Passing cleanly:** zero contrast failures at 1280px across every text node (corroborates §5's measured
work); no horizontal overflow at 375px or 1280px; heading order h1→h2→h3 with no skipped levels;
`:focus-visible` covers every control via `tokens.css:148`.

---

## Combined fix list, worst first

1. **[Sev 4] A1** — the form promises a reply and sends nothing.
2. **[Sev 3] B1** — unify the six weight-600 display roles to 300. *Highest visual return per line changed.*
3. **[Sev 3] B3 + B4** — break the eight-band metronome; promote the proof into the hero.
4. **[Sev 3] A2** — give mobile a navigation.
5. **[Sev 3] A4 + A5** — validation and error design (lands with A1).
6. **[Sev 3] C1, C2** — skip-link target; `aria-live` on the total.
7. **[Sev 3] B2** — collapse 23 type steps toward the documented 8.
8. **[Sev 2 and below]** — A3, A6, A7, B5, B6, C3; then A8, C4, C5.

## Why it still reads as generated

Three causes, none of which a design system swap could fix, which is why the second redesign
did not land:

1. **B1 — two type systems.** The reader meets Carbon's thin display type, then hits semibold
   headings that look like every template. Half the page contradicts the other half.
2. **B3 — the skeleton.** Eight interchangeable slabs. Both redesigns changed the skin.
3. **B4 — the proof is buried.** The one thing no competitor ships sits in band four while a
   placeholder holds the hero.

The 08-21 verdict — *"~75% authored; pricing block and header are transplantable"* — still holds.
The generated feel is concentrated, not diffuse, and B1 is the cheapest large win.

## Limitations

Expert inspection finds violations of known principles; it cannot find what real users hit.
One AI evaluator, three module passes. Screenshot capture would not follow scroll in this
session, so bands below the fold were assessed from DOM measurement (computed styles,
`getBoundingClientRect`, `elementFromPoint`) rather than by eye — reliable for type, contrast,
spacing and overflow, weaker for gestalt judgments. No user testing. Contrast measured at
1280px only.
