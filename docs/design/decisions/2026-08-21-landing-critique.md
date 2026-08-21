---
target: the landing page
total_score: 22
max_score: 36
na_heuristics: 10
p0_count: 2
p1_count: 2
timestamp: 2026-08-21T00-42-18Z
slug: web-portal-src-screens-landing-tsx
---
# Critique — TradesDatabase landing page

Method: dual-agent (A: a917e537543b3a8fb · B: a0324e0227551e323)

## Design Health Score — 22/36 (heuristic 10 n/a)

| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2 | Hero play button dead — `<VideoPlaceholder />` mounts with no `onSeeHow` |
| 2 | Match System / Real World | 3 | "Sandbox ready" is our word, not the trade's |
| 3 | User Control and Freedom | 3 | No way to review or correct what was submitted |
| 4 | Consistency and Standards | 3 | Play ring + scrub bar reads as video; never becomes one |
| 5 | Error Prevention | 2 | No validation design; no `:invalid` in landing.css |
| 6 | Recognition Rather Than Recall | 3 | $280 total sits ~3000px from the form |
| 7 | Flexibility and Efficiency | 2 | Below 520px all nav anchors display:none on a 5800px page |
| 8 | Aesthetic and Minimalist Design | 3 | ~900px of hatched placeholder on mobile |
| 9 | Error Recovery | 1 | No error state exists anywhere on the page |
| 10 | Help and Documentation | n/a | No docs site; onboarding is by hand, routed to a human |

## Design Specificity Verdict
~75% authored. Proof section (chat->job sheet + SOURCE block), dark/paper alternation and
Chivo/Plex voice are genuinely product-specific. Pricing block and header are transplantable;
pricing is a 2019 SaaS card template on the page where the money is decided.

Deterministic: 0 CLI findings, but detect.mjs on a FILE target never follows `import './landing.css'`,
so the CLI never saw 27KB of styling. Canary file confirmed the scanner works. In-page run: 8 findings
/ 7 elements / 5 root causes. all-caps-body x4 = one root cause (PhotoPlate .ld-plate-note).
gpt-thin-border-wide-shadow = false positive (0 14px 40px rgba(...,0.12) is directional elevation,
not a centered glow, and is the only shadow on the page). No low-contrast findings at 398px or 1280px,
corroborating that earlier URL-scan contrast hits were anti-aliasing artifacts.

## Priority Issues
- [P0] No CTA between hero and footer form. Peak intent (calculator total) answered with a disclaimer.
  Compounded by the distill pass removing the secondary hero CTA while the film button is dead.
- [P0] Conversion form has zero reassurance; Status/Terms/Privacy are href="#..." with 0 matching ids.
- [P1] Hero's largest control is dead: VideoPlaceholder.tsx:50 wires onClick={onSeeHow};
  Landing.tsx:175 mounts <VideoPlaceholder /> with no prop. aria-label promises "skip to how it works".
- [P1] Form placeholders are complete realistic values; a11y tree names every field by its placeholder.
- [P2] "Placeholder pricing." undermines the number, in the same grey mono as the reassurance.

## Persona Red Flags
- Burned owner-operator: zero social proof; "Sandbox ready" jargon; "no contract" buried with
  "Placeholder pricing".
- Screen-reader user: PhotoPlate aria-labels announce production notes; <select> wrapped in <label>
  drops the question; aria-live on seat count, not the total.
- Owner on a phone: ~800px hatch before the first real sentence, 600px more right after the proof
  section; "Everything opposite" is coupled to a desktop layout.

## Minor
- AT LEAST ONE tab reads as a kicker again at 375px (DOM reorder did not survive mobile layout)
- .ld-trades wraps at 375px leaving ROOFING with a dangling left hairline
- Calculator clamps at 60 seats for a 5-50 product; technicians step to 0
- GET /portal/api/me -> 500 (incidental to the signed-out page)

## Questions
- Pricing block as an invoice/ledger rather than three cards?
- Move the chat->job-sheet proof above the fold instead of the empty film frame?
- One true sentence next to submit ("We're onboarding four firms this month. Ray does it himself.")

## Verified corrections to Assessment A
- A claimed CTAs fall back to the UA focus ring. FALSE: a bare `:focus-visible { outline: 2px solid
  var(--amber); outline-offset: 2px }` in tokens.css applies to every landing control; the
  .ld-input rule is a redundant duplicate.
