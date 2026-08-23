# DESIGN.md — TradesDatabase

The active design system for the **public marketing landing page** (`web/portal/src/screens/Landing.tsx`
+ `landing.css`). Adopted 2026-08-21.

> **Scope.** This file governs the landing page only. The **signed-in app** (Billing, Seats, Seat
> detail, Data & exports, Admin queue, Sign in) runs a different, still-current system — white cards
> on a dark slate shell — documented in [docs/design/handoff-2026-08-07/](docs/design/handoff-2026-08-07/).
> The two do not match, on purpose. Don't "harmonise" them without a decision.

**Base:** IBM Carbon, adapted.

- **Upstream source:** <https://github.com/VoltAgent/awesome-design-md> → `design-md/ibm/DESIGN.md`
  (retrieved 2026-08-21). Go back there when this system needs extending — the file carries
  component, layout, depth and responsive guidance this summary does not repeat.
- **Verbatim copy in-repo:** [docs/design/reference/ibm-carbon-DESIGN.md](docs/design/reference/ibm-carbon-DESIGN.md)
  — kept unmodified so our adaptation can always be diffed against what we started from.
- **Four runners-up** (PostHog, Binance, WIRED, Intercom) are in
  [docs/design/reference/](docs/design/reference/) for the next time this question comes up.
Why this one and what it replaced: [docs/design/decisions/2026-08-21-landing-direction.md](docs/design/decisions/2026-08-21-landing-direction.md).

---

## 1. The idea in one line

**White canvas, charcoal type, one assertive blue, square corners, no shadows.** The chrome is
flat and the typography is *light* — display sizes run at weight 300, which is the signature and
the thing most likely to get "fixed" by someone who thinks headlines should be bold. They should not.

## 2. Colour

Every value is a token on `.landing` in `landing.css`. Nothing on the page may be a literal hex.

| Token | Value | Use |
|---|---|---|
| `--canvas` | `#ffffff` | Page base |
| `--surface-1` | `#f4f4f4` | Alternating record bands, input fills, the job sheet's header strip |
| `--surface-2` | `#e0e0e0` | Disabled fills, hairline-as-fill |
| `--ink` | `#161616` | Headlines, body, the inverted card and footer background |
| `--ink-muted` | `#525252` | Secondary type, meta rows, field labels |
| `--ink-subtle` | `#8c8c8c` | **Non-text only** — disabled controls, decorative rules. See §5. |
| `--hairline` | `#e0e0e0` | Every 1px divider and card border |
| `--blue` | `#0f62fe` | The single accent: primary CTA fill, the source-block rule, active states |
| `--blue-hover` | `#0050e6` | CTA hover |
| `--blue-on-dark` | `#78a9ff` | The accent **on the inverted footer / manager card only**. See §5. |
| `--inverse-canvas` | `#161616` | Footer, manager seat card |
| `--inverse-ink` | `#ffffff` | Type on inverse |
| `--inverse-ink-muted` | `#c6c6c6` | Secondary type on inverse |

Semantic colours (`#24a148` success, `#f1c21b` warning, `#da1e28` error) exist in Carbon and are
reserved. The landing has no state that needs them yet; don't spend them on decoration.

## 3. Type

**IBM Plex Sans carries the entire hierarchy.** IBM Plex Mono is for machine values only — job refs,
bot handles, timestamps, field labels, prices-per-unit. Mono is never used for a sentence one person
wrote to another. There is no third family; **Chivo was removed** when this system was adopted.

| Role | Size | Weight | Line-height | Tracking |
|---|---|---|---|---|
| Display XL (hero h1) | `clamp(38px, 5.4vw, 68px)` | **300** | **1.02** | **`-0.01em`** |
| Display LG (section h2) | `clamp(26px, 3.1vw, 42px)` | **300** | 1.06 | `-0.01em` |
| Display (contact h2) | `clamp(30px, 3.8vw, 50px)` | **300** | 1.02 | `-0.01em` |
| Display (seat names) | `clamp(28px, 3vw, 38px)` | **300** | 1.05 | `-0.01em` |
| Display (prices, totals) | `46px` / `38px` | **300** | 1.0 | `-0.01em` |
| Body | `16px` | 400 | 1.50 | **`0.16px`** |
| Body emphasis | `14px` | 600 | 1.29 | `0.16px` |
| Label / meta (mono) | `12px` | 400–500 | 1.5 | `0.10em`, uppercase |

**Every display role uses one treatment: weight 300, tracking `-0.01em`, tight leading.** That
uniformity is the point — the first Carbon pass left half the display rules on the old design's
`-0.03em` and the page visibly ran two type systems at once.

### Where this deviates from Carbon, and why

Carbon's own spec gives display-xl as **76px / 1.17 / −0.5px**. We use **68px / 1.02 / −0.01em**:

- **Leading.** Carbon's 1.17 assumes a single-line headline. Our hero is three stacked lines
  ("They already / text you. / Now it's a record."). At 1.17 the lines drift apart and weight 300
  reads washy. 1.02 is what was reviewed and approved.
- **Tracking.** Carbon's `-0.5px` is *absolute* — about −0.007em at 68px, i.e. effectively none.
  A relative `-0.01em` holds the same optical tightness at every size in the `clamp()`.
- **Size.** 76px was 12% larger than the approved mockup and pushed the hero past the fold.

Two rules that are easy to lose and are the whole voice:

1. **Do not bold display type.** Weight 300 reads as quietly authoritative. Weight 700 makes it
   look like every other B2B site.
2. **Keep `letter-spacing: 0.16px` on body sizes.** Small positive tracking is a Carbon precision
   detail. It looks like a mistake and is not.

## 4. Shape, depth, layout

- **Radii 0–4px.** Buttons and cards `0`; small inner chips at most `4px`. Nothing is rounded.
- **No shadows. Anywhere.** Carbon separates with thin borders and grey bands, not elevation. The
  job sheet's old `0 14px 40px` drop shadow was removed with this system.
- **Cards are thin-bordered tiles**: `1px solid var(--hairline)` on `--canvas`.
- Sections alternate `--canvas` and `--surface-1`. The footer is the **only** inverted surface.
- Grid dividers are drawn as 1px gaps over a `--hairline` background, not per-cell borders.
- Content max width `1180px`; section padding `clamp(44px, 5vw, 76px)` block.

## 4b. Spacing, components, states

Straight from the source file — these are Carbon's own numbers, not invented.

**Spacing is a 4px grid.** `4 · 8 · 12 · 16 · 24 · 32 · 48`, section rhythm `96`.
Carbon's whitespace philosophy is worth quoting because it cuts against the instinct:
sections separate via **thin grey rows, not large vertical gaps**, and content is dense by design.
Don't add air to make it feel premium — that is a different brand.

| Component | Spec |
|---|---|
| Primary button | `--blue` fill, `--canvas` text, padding `12px 16px`, radius `0` |
| Secondary button | `--ink` fill, white text, same padding, radius `0` |
| Tertiary button | `--canvas` fill, `--blue` text, 1px `--blue` border, radius `0` |
| Card | `--canvas`, 1px `--hairline`, radius `0`, padding `24px` (32px for a large tile, 48px for hero/CTA) |
| Text input | `--surface-1` fill, padding `11px 16px`, radius `0` |
| Input focus | **replace the bottom hairline with a 2px `--blue` underline** — Carbon's signature focus treatment |
| Section band | `--surface-1` background, no border needed |

**Elevation has four levels and none of them is a shadow:**

| Level | Treatment |
|---|---|
| 0 | Flat — no border, no shadow. Body copy, hero text, footer |
| 1 | 1px `--hairline` border on canvas. Cards, inputs, list items |
| 2 | `--surface-1` background on canvas. Alternate bands, hovered cards |
| 3 | 2px `--blue` focus outline |

## 5. Contrast — measured, not estimated

Computed with WCAG 2.1 relative luminance. **Two of Carbon's own tokens fail as body text and are
constrained here because of it:**

| Pair | Ratio | Verdict |
|---|---|---|
| `--ink` on `--canvas` | **18.1** | ✅ |
| `--ink-muted` on `--canvas` | **7.81** | ✅ |
| `--ink-muted` on `--surface-1` | **7.10** | ✅ |
| `--blue` on `--canvas` | **5.00** | ✅ |
| `--inverse-ink` on `--inverse-canvas` | **18.1** | ✅ |
| `--inverse-ink-muted` on `--inverse-canvas` | **10.59** | ✅ |
| `--blue-on-dark` on `--inverse-canvas` | **7.68** | ✅ |
| ~~`--ink-subtle` on `--canvas`~~ | 3.36 | ❌ **fails AA body** |
| ~~`--blue` on `--inverse-canvas`~~ | 3.62 | ❌ **fails AA body** |

**Two hard rules follow:**

1. **`--ink-subtle` (`#8c8c8c`) never carries text.** It is for disabled controls and decorative
   rules. Where Carbon's own docs suggest it for "captions and helper text", use `--ink-muted`
   instead — or `#6f6f6f` (5.02 on canvas, 4.57 on `--surface-1`) if you genuinely need a third,
   quieter step that still passes.
2. **`--blue` never carries text on the inverted footer or manager card.** Use `--blue-on-dark`
   (`#78a9ff`). On inverse surfaces the ordinary blue is a 3.62:1 failure.

Floor for the page: **4.5:1 body, 3:1 large.** Every text pair above clears it.

## 6. Non-negotiables inherited from the previous system

These are product decisions, not visual ones. They survive the redesign unchanged.

- **The source block stays.** Every structured field traces to the message that produced it, and the
  job sheet renders that link visibly. It is the product's core claim. Its accent rule is now
  `--blue` rather than amber; the block itself does not move.
- **Two seat prices are never blended into one average.** They are two products. The only combined
  figure on the page is the calculator total.
- **No kickers or eyebrows above headings**, and no `01 / 02 / 03` section numbers. Removed
  2026-08-20 as generated-UI tells; do not reintroduce them.
- **Placeholder imagery stays honest.** Unshot photographs render as marked plates carrying their
  shot brief. Stock photography is not an interim option — this audience spots it instantly.
- **Fonts are self-hosted** via `@fontsource`, Latin subsets only. No CDN font requests: it is a
  privacy and CSP position, not a preference.

## 7. Working on this page

```bash
npm run portal:dev     # vite dev server, http://localhost:5173/portal/
npm run typecheck && npm run lint && npm run build
```

Before committing a visual change, check it at **390px and 1280px**, confirm no horizontal
overflow at either, and confirm nothing new falls below the contrast floor in §5.

## 8. Motion

Adopted 2026-08-23. Carbon publishes a motion system and we use it rather than inventing timings.
Source: [carbon-design-system/carbon, `packages/motion`](https://github.com/carbon-design-system/carbon/tree/main/packages/motion)
— durations from `src/dtcg/motion.json`, curves from `src/tokens.ts`. Tokens are declared on
`.landing` in `landing.css`.

| Token | Value | Use |
|---|---|---|
| `--dur-fast-01` | `70ms` | Buttons, toggles. Instant response to a press. |
| `--dur-fast-02` | `110ms` | Small fades. |
| `--dur-moderate-01` | `150ms` | **Default transition speed.** |
| `--dur-moderate-02` | `240ms` | Expansion; elements carrying visual weight. |
| `--dur-slow-01` | `400ms` | Large expansion; a deliberate, prominent moment. |

| Curve | Value | Use |
|---|---|---|
| `--ease-standard` | `cubic-bezier(0.2, 0, 0.38, 0.9)` | Movement within the viewport. |
| `--ease-entrance` | `cubic-bezier(0, 0, 0.38, 0.9)` | **Productive** entrance — data arriving. |
| `--ease-entrance-expressive` | `cubic-bezier(0, 0, 0.3, 1)` | **Expressive** entrance — things with weight. |

**Productive vs expressive** is Carbon's own split and it is the decision to get right: productive
is fast and businesslike and belongs on data; expressive is slower and belongs on the few moments
that carry meaning. Most of this page is productive.

### Rules

1. **Animate `opacity` and `transform` only.** Both are GPU-composited. Animating `width`,
   `height`, `top` or `margin` forces layout on every frame.
2. **Motion must mean something.** The proof band's fill sequence exists because a record really is
   assembled from a message over time. Decorative movement is the generated-page signature this
   design has twice been rebuilt to escape — see the 2026-08-22 critique.
3. **Every motion is guarded by `prefers-reduced-motion`, and the guard renders the FINISHED state
   rather than a faster animation.** A reader who asked for less motion should not have to sit
   through a shortened performance. Forced motion is a vestibular problem, not a taste question.
4. **Scroll-triggered sequences play once.** Disconnect the observer after firing; a demonstration
   that replays every time the reader scrolls back becomes noise.
5. **No motion on first paint above the fold.** The hero must be readable the instant it renders.

### What is animated today

| Where | What | Timing |
|---|---|---|
| Buttons | Colour on hover, 1px press on `:active` | `150ms` / `80ms` |
| In-page anchors | `scroll-behavior: smooth` | browser default |
| Proof band | The record writing itself — chat, then sheet rows, then the source rule | `120ms`–`2500ms`, once, on scroll into view |

The proof band sequence is CSS-only past a single class flip: React adds `.is-playing` when the
band enters the viewport and every step's timing is a `transition-delay`. There are no timers to
leak and no per-frame JavaScript.
