# Handoff: TradesDatabase marketing landing page

## Overview

A full redesign of the public marketing landing page for TradesDatabase — a customer/job record
system for small UK trades firms that runs inside Telegram. The page speaks to one reader: a
working owner-operator, 35–60, who has bought software before and been burned by it. It has to land
one idea in four seconds: *my crew already texts me, and this turns that into records I can search,
without anyone learning anything.*

Scope is the marketing page only. The signed-in app is not touched.

The organising idea is **dark shell, records on paper**. The page background is a cool steel dark
(the vans, the sites, the phone at 14:52). The two sections that represent *records* — the product
demo and the pricing ledger — sit on warm paper. That alternation is deliberate: it is what stops
the page reading as another dark SaaS template, and it should survive implementation. Do not
flatten it to one background.

## About the design files

The files in this bundle are **design references written in HTML** — prototypes that show intended
look, copy and behaviour. They are not production code to lift.

`TradesDatabase Landing.dc.html` uses a small streaming-component runtime (`support.js`) and
inline styles. That structure is an artefact of the design tool, **not** a recommendation. The
task is to rebuild the design in the target codebase — React + Vite, plain CSS custom properties,
no CSS framework — replacing `web/portal/src/screens/Landing.tsx`.

To view the prototype: open `TradesDatabase Landing.dc.html` in a browser with all files in this
folder kept side by side (it loads `support.js` and `image-slot.js` as siblings).

- `TradesDatabase Landing.dc.html` — the design.
- `Design spec.dc.html` — type scale, token table with measured contrast, photography brief.
- `Directions.dc.html` — four earlier exploratory directions, for context only. Not the spec.

## Fidelity

**High fidelity.** Colours, type sizes, spacing and copy are final unless the team changes them.
Recreate faithfully, using the codebase's own CSS custom property conventions.

Two things are intentionally unfinished and must stay visible as placeholders:
1. The hero **product film** does not exist yet — the designed placeholder state ships as is.
2. **Photographs** have not been shot. Four image slots are marked; see *Assets*.

## Design tokens

Colour is hue-250 cool steel with an amber brand colour, matching the app's token hues. Every
value below is given in oklch (authoring) and hex (rendered sRGB). Contrast ratios are **measured**
with WCAG 2.1 relative luminance, not estimated.

| Token | oklch | hex | Use | Measured |
|---|---|---|---|---|
| `--bg` | `oklch(0.18 0.012 250)` | `#0e1217` | page base, dark sections | — |
| `--surface` | `oklch(0.225 0.014 250)` | `#171c22` | alternate dark bands, cards, form | — |
| `--raised` | `oklch(0.27 0.014 250)` | `#21272d` | raised fills | — |
| `--line` | `oklch(0.34 0.012 250)` | `#33393e` | hairlines, grid gaps — **non-text only** (1.6:1) | 1.6:1 |
| `--text` | `oklch(0.97 0.004 250)` | `#f3f5f8` | primary on dark | 17.2:1 on `--bg` |
| `--text-2` | `oklch(0.80 0.012 250)` | `#b8bec5` | body on dark | 10.0:1 |
| `--text-3` | `oklch(0.68 0.014 250)` | `#9299a1` | meta/mono on dark | 6.5:1 (5.2:1 on `--raised`) |
| `--amber` | `oklch(0.78 0.15 75)` | `#efa831` | amber **text** on dark only | 9.2:1 |
| `--amber-fill` | `oklch(0.74 0.16 70)` | `#ea9602` | button and tag fills | 7.3:1 with `--on-amber` |
| `--on-amber` | `oklch(0.22 0.04 70)` | `#261704` | label on amber fill | 7.3:1 |
| `--teal` | `oklch(0.75 0.09 200)` | `#60bfc4` | settled/done marks, sub-labels | 8.7:1 |
| `--paper` | `oklch(0.95 0.008 85)` | `#f1eee9` | light section background | — |
| `--paper-2` | `oklch(0.90 0.010 85)` | `#e1ded7` | card headers, calculator panel | — |
| `--paper-line` | — | `#cfcbc3` | borders on paper | — |
| `--paper-line-2` | — | `#e6e3dd` | inner rules on white cards | — |
| `--paper-ink` | `oklch(0.27 0.02 250)` | `#1f2730` | primary on paper | 13.0:1 |
| `--paper-ink-2` | `oklch(0.45 0.02 250)` | `#4d5660` | secondary on paper | 6.5:1 |
| `--chat-grey` | — | `#e8e5df` | technician chat bubbles on paper | — |
| `--field-line` | — | `#4a525a` | input underlines on dark | — |

**Hard rule:** amber never carries text on paper (`#ea9602` on `#f1eee9` is 2.05:1). On light
surfaces amber is a fill or a 3px rule only, with `--on-amber` or `--paper-ink` on top.

Lowest text pair anywhere on the page is 5.2:1. Accessibility gate (AA: 4.5:1 body, 3:1 large)
is cleared with margin throughout.

### Spacing, radii, shadows

- Section padding: `clamp(44px, 5vw, 80px)` block, `clamp(18px, 4vw, 44px)` inline.
- Content max width: `1240px`, centred.
- Radii: 3–6px throughout (square-ish "workwear" intent). Buttons and cards 5px, inner chips 3–4px,
  chat bubbles 10px with one 3px corner on the tail side.
- Only one shadow on the page: the job sheet card, `0 14px 40px rgba(15,20,26,0.12)`.
- Grid dividers are drawn as 1px gaps over a `--line` background, not per-cell borders.

## Typography

Three families, all SIL OFL and self-hostable. **The prototype loads them from Google Fonts for
preview only — self-host woff2 from your own origin before this ships.** No CDN fonts, per the CSP
position.

| Family | Weights needed | Use |
|---|---|---|
| **Chivo** | 600, 700, 900 | display: hero, section heads, sub-heads, prices, quotes |
| **IBM Plex Sans** | 400, 500, 600 | all running copy, form fields, list items |
| **IBM Plex Mono** | 400, 500 | machine values and margin notes only: job refs, bot handles, timestamps, section numbers, field labels |

Mono is never used for a sentence one person wrote to another. Roughly 180 KB total subset to Latin.

### Type scale

| Role | Size (fluid) | Family / weight | Line-height | Tracking |
|---|---|---|---|---|
| Hero h1 | `clamp(38px, 5.2vw, 74px)` | Chivo 900 | 1.0 | −0.035em |
| Section h2 | `clamp(27px, 3.1vw, 44px)` | Chivo 900 | 1.05 | −0.03em |
| Contact h2 | `clamp(30px, 3.8vw, 50px)` | Chivo 900 | 1.02 | −0.03em |
| Seat name h3 | `clamp(28px, 3vw, 38px)` | Chivo 900 | 1.05 | −0.03em |
| Price figure | `46px` | Chivo 900 | 1.0 | −0.03em |
| Total figure | `38px` | Chivo 900 | 1.0 | −0.03em |
| Quote | `clamp(22px, 2.3vw, 30px)` | Chivo 600 | 1.2 | −0.02em |
| Card title | `21–23px` | Chivo 700 | 1.15 | −0.02em |
| Hero lead | `clamp(17px, 1.6vw, 20px)` | Plex Sans 400 | 1.5 | — |
| Body | `14.5–16px` | Plex Sans 400 | 1.5–1.6 | — |
| Field value | `15px` | Plex Sans 500 | — | — |
| Label / meta | `10.5–12.5px` uppercase | Plex Mono 400/500 | 1.5 | 0.10–0.14em |

Headlines are **sentence case**. An earlier all-caps condensed treatment was rejected as hard to
read — do not reintroduce it.

## Screens / views

One page, eight bands, top to bottom. Section numbers (`01 /` … `05 /`) are part of the design —
they run down the left edge like a form.

### 1. Nav — sticky

- `position: sticky; top: 0; z-index: 50`, background `rgba(14,18,23,0.9)` with
  `backdrop-filter: blur(10px)`, bottom border `--line`.
- Left: 26×26px `--amber-fill` square with `TD` in Plex Mono 12px `--on-amber`, then the wordmark
  in Chivo 700 21px, tracking −0.02em.
- Right: Product · Pricing · Contact (14px, `--text-2`), then **Sign in** as a 5px-radius outlined
  button (1px `--line`, `--text`, 7px 15px).
- There is no docs link. Do not add one.
- Under ~520px the nav should collapse to wordmark + Sign in.

### 2. Hero — dark

- Background: 64px blueprint grid, two `linear-gradient`s in `--surface` at 1px over `--bg`.
- Two columns, `flex: 1 1 420px` / `1 1 440px`, `gap: clamp(28px, 4vw, 56px)`, vertically centred.
- Left: an 8px amber square + `RUNS INSIDE TELEGRAM` (Plex Mono 11.5px, 0.14em, `--amber`); h1
  "They already text you. **Now it's a record.**" with the second sentence in `--amber`; lead
  paragraph capped at `32ch`; two buttons — primary amber fill, secondary 1px `--line` outline.
- Right: **product film placeholder**. A `--surface` card, 6px radius, `--line` border, in three
  parts: a mono header strip (amber dot + "Product film" / "90 sec"); a 16:10 well on `--bg` with a
  45° amber hatch at 5% opacity, a 64px amber ring with a CSS triangle play mark, the title "One
  job, start to finish" and the caption "Film not shot yet", plus two 16px corner ticks
  (top-left, bottom-right); a mono scrub row `00:00 — [track] — 01:30`. **This placeholder is the
  approved state until the film exists.** It replaced a fake browser screenshot; that decision stands.

### 3. Photo band — full-bleed

- Height `clamp(280px, 34vw, 460px)`, one image, `object-fit: cover`.
- Overlaid at the bottom: a `transparent → rgba(14,18,23,0.85)` gradient carrying the trades list —
  `BUILT FOR` in amber, then Electrical · Plumbing · Roofing · HVAC · Carpentry in Plex Mono 11.5px,
  each separated by a 1px `rgba(243,245,248,0.3)` left border, `pointer-events: none` on the plate.

### 4. What we heard — `--surface`

- Label `01 / What we heard`.
- Four quote cells in `grid-template-columns: repeat(auto-fit, minmax(340px, 1fr))` with a 1px gap
  over a `--line` background and a `--line` border, so the dividers are the gaps.
  **The 340px minimum matters** — at 260px the grid resolves to 3 columns at common laptop widths
  and orphans the fourth cell as a blank grey panel.
- Each cell: the quote in Chivo 600 (curly quotes included), then attribution in Plex Mono 11px
  `--teal` uppercase. Nothing else — no icons, no explanatory paragraph.
- Copy, verbatim: "It's all in the group chat somewhere." (Owner · 11 vans) / "They won't use
  another app." (Owner · 6 vans) / "What did we do at this address?" (Office manager) / "I do the
  paperwork on Sunday." (Owner · 4 vans).

### 5. One text in. One record out. — `--paper`

The product proof. Three parts in a wrapping flex row.

- **Chat card** (`flex: 1 1 320px`): white, `--paper-line` border. Header: 30px `--paper-2` circle
  with `TD`, then `@harrowbros_pete_bot` in Plex Mono 11.5px. Then technician messages right-aligned
  on `--chat-grey` (10px radius, 3px on the tail corner) with 10px mono timestamps; an attachment
  row with a 22px white square and `EICR_14BellLane.pdf`; and the bot reply left-aligned on
  `--paper-ink` with white text and a `JOB-4471` chip in `--amber` / `--on-amber`.
- **Arrow**: a Plex Mono `→` at 26px in `--amber-fill`, self-centred. On mobile it sits between the
  stacked cards; rotating it 90° there is acceptable.
- **Job sheet card** (`flex: 1 1 380px`): white with the page's only shadow. `--paper-2` header
  strip reading `JOB SHEET` / `JOB-4471` in mono. Then four label/value rows (mono 11px uppercase
  label in a fixed 78px column, Plex Sans 15px/500 value) separated by `--paper-line-2` rules:
  Customer, Work, Visit, Attached. Finally a `--paper` block with a 3px `--amber-fill` left border
  holding `SOURCE · TELEGRAM 14:52` and the original message in quotes. **This source block is the
  product's core claim — evidence behind every field. Keep it.**
- Below, above a `--paper-line` rule: four claims in a `repeat(auto-fit, minmax(200px, 1fr))` grid,
  each a Chivo 700 title plus one short line — No new app / Search the address / Evidence kept /
  Yours to take.

### 6. Photo strip — three up

`repeat(auto-fit, minmax(240px, 1fr))`, 2px gaps over `--bg`, each `clamp(200px, 22vw, 320px)` tall.

### 7. Adding someone takes one tap — `--bg`

- Label `03 /`.
- Three cells, same 1px-gap grid technique, `minmax(220px, 1fr)`, cells on `--surface`.
- Each: a `--teal` mono timing label (10 seconds / Automatic / ~10 minutes), a Chivo 700 title
  (You add the name / Their bot is created / Sandbox ready), and at most one mono line.
- **Copy constraint:** the provisioning story is one tap → Telegram Managed Bots creates the bot →
  sandbox builds in about ten minutes. Never write anything about pasting a BotFather token; that
  flow is obsolete.

### 8. Two kinds of seat — `--paper`

Three equal cards, `flex: 1 1 280px`, 14px gap.

- **Technician** — white card. `ON THE TOOLS` mono label, name in Chivo 900, price
  (`{currency}{technicianPrice}`, default £50) with `/ person / month` in mono, then three
  em-dash items: Own Telegram bot / Jobs, certs, photos / Sees their own day.
- **Manager** — inverted card on `--paper-ink` with white text, an `AT LEAST ONE` amber tab pinned
  to the top-right corner, `RUNS THE DAY` teal label, price in `--amber` (default £80), four items:
  Everything opposite / Books the crew's work / Dispatch board / Adds and drops seats.
- **Calculator** — `--paper-2` panel. Two stepper rows (Managers, Technicians) and a `PER MONTH`
  total in Chivo 900. Steppers are 44×44px white buttons with a `--paper-line` border.
- Footnote in mono: "Placeholder pricing. No setup fee, no contract."
- **Never blend the two seat prices into one average figure.** They are two products. The
  calculator adds them as separate line items and that is the only place a combined number appears.

### 9. Get in touch — `--bg`

- Left: `05 / GET IN TOUCH`, h2 "Fifteen minutes, no slide deck.", one line of body capped at `34ch`.
- Right: form card on `--surface`, `--line` border, 5px radius, 18px gap between fields.
  Fields: **Your name**, **Business** (side by side, `flex: 1 1 180px`), **Email**, **Phone
  (optional)** (side by side), **How many on the tools** (select), **What's driving you mad**
  (3-row textarea). Labels are Plex Mono 11px uppercase `--text-3`.
  Text inputs and the select are transparent with a 1px `--field-line` bottom rule only; the
  textarea is the one boxed field (`--bg` fill, `--line` border, 3px radius, vertical resize).
- Submit: amber fill, `--on-amber` label, "Ask us to get in touch".
- Onboarding is by hand, one firm at a time, so **this form matters more than a self-serve signup.**
  There is no signup flow to add.

### 10. Footer — `--bg`

20px amber square, `© 2026 TradesDatabase` in mono, and Status · Terms · Privacy right-aligned in
mono `--text-3`.

## Interactions & behaviour

Deliberately quiet. This is a marketing page for someone reading between jobs.

- **Nav links** are in-page anchors: `#product`, `#pricing`, `#contact`. `Sign in` goes to the app.
- **Seat calculator** is the only stateful widget: `managers` (min 1, max 60, default 1) and
  `technicians` (min 0, max 60, default 4). Total = `managers × managerPrice + technicians ×
  technicianPrice`, formatted `en-GB`. Recomputes on click, no animation.
- **Team-size select** is controlled, default `4–10 people`. (A plain `selected` attribute on the
  option does not survive React — set it as component state or `defaultValue` on the `<select>`.)
- **Form** is unwired in the prototype. On submit, post to whatever the team uses and swap the card
  for a plain confirmation in the same box: "Got it — we'll come back to you today." Do not add a
  modal.
- **Hover states** to add in build (the prototype does not show them): buttons lighten the amber
  fill by ~4% lightness; outlined buttons move their border to `--text-3`; nav links go to
  `--text`; the film placeholder's play ring fills amber with `--on-amber` triangle. 120ms ease-out
  on colour only. No transforms, no lifts, no parallax.
- **Focus** must be visible on every control: 2px `--amber` outline with 2px offset.
- `prefers-reduced-motion` — nothing on the page moves, so no work beyond honouring transitions.

## Responsive behaviour

The prototype is fluid rather than breakpoint-driven: every type size is `clamp()`d and every
column pair is `flex: 1 1 <min>` with `min-width: min(100%, <n>px)`, so it reflows continuously
from 360px to 1440px with no media queries. Reproduce that approach — it is the reason mobile works
without a second design.

Check these in build:
- Nav collapses to wordmark + Sign in under ~520px.
- On a phone the order is headline → lead → buttons → film. The film should be reachable without a
  long scroll.
- Quote grid goes 4 → 2 → 1, never 3.
- Pricing cards stack technician → manager → calculator.
- Tap targets are 44px minimum (the steppers are exactly 44px; keep them).

## State management

Three pieces of local component state, nothing global, no data fetching:

```
managers: number      // default 1, min 1
technicians: number   // default 4, min 0
teamSize: string      // default '4–10 people'
```

Plus form field state if you wire the form. Prices are constants (or props) — `managerPrice: 80`,
`technicianPrice: 50`, `currency: '£'`.

## Assets

Nothing in this bundle is a shippable asset. Four photographs need commissioning — one half-day
with a pilot firm, available light, real workwear, nobody performing for the camera:

1. **Hero, landscape** — sparky mid-job, phone in one hand, consumer unit open behind. Shot from
   the side.
2. **Van doors open at first light**, kit going in.
3. **Detail** — hands and a scuffed phone screen, close enough to read that the phone is not new.
4. **Kitchen table, 9pm** — the moment the paperwork used to happen. Reserve.

Until they exist, ship the hatched amber placeholder plates as drawn. An obvious placeholder is
more honest than a stock photo of a smiling man in a clean hi-vis; this audience spots that
instantly and it costs trust. **Do not buy stock as an interim.**

No customer logos or testimonials anywhere — pre-launch with two pilot firms, and a faked
social-proof band would undo the page.

The only other graphic elements are CSS: the amber play triangle (border trick), the blueprint grid
and hatch (repeating gradients), and the `TD` mark. There are no icons on the page by design; an
earlier version's line-icon set was part of what made it read as a template.

## Constraints carried over from the brief

- **No third-party embeds.** No YouTube iframe for the film — self-host and use a native `<video>`
  with a poster frame. No CDN fonts. No external trackers.
- **React + Vite, plain CSS custom properties, no CSS framework.** Replaces
  `web/portal/src/screens/Landing.tsx`.
- **The dark app shell stays.** The landing does not have to match it and deliberately doesn't.
- **Voice is British, plain, slightly blunt.** No exclamation marks, no "revolutionise", no
  "seamless". Copy in the prototype is final; if it changes, keep that register.

## Open questions for the team

1. **Currency.** The prototype shows £. The app currently shows $, but the customers are UK — an
   owner reading $80 per person will assume this is an American product. Decide before launch;
   it is a one-constant change.
2. **Amber does two jobs.** In the app amber means *attention required*; here it is the brand.
   Anyone crossing between the two daily will feel the collision. Worth deciding whether the app
   keeps amber for alerts or moves them to teal.
3. **Film script.** The placeholder promises one job start to finish, 90 seconds: a text from the
   van at 14:52 → the customer, job and cert filed by 14:53. Shoot it that literally.

## Files

- `TradesDatabase Landing.dc.html` — the design. Open in a browser with the sibling files present.
- `Design spec.dc.html` — token table with measured contrast, type scale, photography brief.
- `Directions.dc.html` — four exploratory directions (job sheet, van livery, chat thread, night
  shift). Context only; the landing file is the spec.
- `support.js`, `image-slot.js` — runtime files the prototypes need in order to open. Not for
  production.
