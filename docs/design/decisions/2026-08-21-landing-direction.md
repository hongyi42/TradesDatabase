# Landing page: adopt IBM Carbon, retire the dark shell

**Date:** 2026-08-21 · **Status:** accepted · **Scope:** public landing page only

## Decision

Replace the landing page's "dark shell, records on paper" system with an adaptation of
**IBM Carbon**. Root [`DESIGN.md`](../../../DESIGN.md) is now the authority. The signed-in app is
untouched and keeps its own system.

## Why

The v2 dark landing was implemented faithfully and still did not work. The owner's report was that
it "felt too AI" and did not differentiate us. Investigation found three separate causes, and only
one of them was the design:

1. **The page was British and the market is American.** EICR certificates, consumer units, a London
   postcode, `£`. Every concrete detail — the one thing that makes a contractor think *this is for
   me* — signalled the opposite. Fixed 2026-08-20, before any redesign.
2. **Real generated-UI tells.** A deterministic scan found kickers above headings, an eyebrow chip
   over the hero, `01 / 02 / 03` section numbers, a colored side-tab, a blueprint grid. Six were
   removed; the rest were judged deliberate.
3. **The dark + single-warm-accent skeleton itself.** This is what the redesign addresses.

## What was evaluated

Five directions were mocked with real page copy and reviewed by the team
(artifact: "Landing Page Direction Test"): PostHog, Binance, WIRED, IBM Carbon, Intercom.
Sources for all five are in [`../reference/`](../reference/).

**Carbon won on three grounds:**

- **Switching cost is near zero.** The page already ran IBM Plex Sans and IBM Plex Mono. Body type,
  mono labels and the whole label treatment survive untouched; only the display face changes, and it
  changes to a font we already ship. Chivo was dropped, which also removed three font weights from
  the bundle.
- **The shape language was already the intent.** The previous handoff described 3–6px "workwear"
  radii and a deliberately flat, unshadowed feel. Carbon is 0–4px, thin-bordered, and has no
  shadows at all — the same intent, executed by people who did it properly.
- **It is legitimately adoptable.** Apache 2.0, built to be used by anyone. Every other finalist
  would have meant borrowing a real company's visual identity for a commercial page.

## What we gave up

- **The amber.** It was doing real brand work and there is no equivalent in Carbon; the accent is
  now IBM Blue `#0f62fe`. If a warm accent later matters more than switching cost, PostHog is the
  recorded fallback.
- **The dark shell** — now inverted to a white canvas with a single dark footer.
- **The blueprint grid** on the hero, which was also a flagged generated-UI tell.
- **Heavy display type.** Chivo 900 → IBM Plex Sans 300 is the largest single visual change on the
  page, and the one most likely to be "corrected" by someone later. It is the Carbon signature.

## Two defects found while adopting it

Carbon's own token set has two pairs that fail WCAG AA as body text, and the root `DESIGN.md`
constrains both rather than shipping them:

- `ink-subtle #8c8c8c` on white is **3.36:1** — Carbon suggests it for helper text and captions;
  here it is barred from carrying text at all.
- `blue #0f62fe` on the inverted `#161616` footer is **3.62:1** — inverse surfaces use
  `blue-40 #78a9ff` (7.68:1) instead.

## Still open

- The two P0s from the 2026-08-21 critique are unaddressed: no CTA between hero and footer form,
  and no reassurance beside the submit button. See [the critique](2026-08-21-landing-critique.md).
- Four photographs and the hero film remain unshot. The page cannot ship without them.
- Pricing is still rendered as three cards rather than as an invoice — recorded as the sharpest
  structural criticism and deliberately deferred.
