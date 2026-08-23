# Design — customer account portal

Design material for the customer-facing portal (`/portal`, source in `web/portal/`), kept here
so the implementation can be checked against its brief without hunting for a Downloads folder.

> ## ⚠️ Read this first — the landing page changed systems on 2026-08-21
>
> **The active design system for the landing page is [`/DESIGN.md`](../../DESIGN.md) at the repo
> root.** It is an adaptation of **IBM Carbon** — white canvas, charcoal type, one blue accent,
> square corners, no shadows, display type at weight 300.
>
> - Why, and what it replaced: [`decisions/2026-08-21-landing-direction.md`](decisions/2026-08-21-landing-direction.md)
> - Source material (Carbon + four runners-up): [`reference/`](reference/), pulled from
>   <https://github.com/VoltAgent/awesome-design-md>
> - The critique that drove the work: [`decisions/2026-08-21-landing-critique.md`](decisions/2026-08-21-landing-critique.md)
>
> **`handoff-landing-v2/` is now HISTORICAL.** Everything below that describes the landing as a
> dark page with warm-paper bands, an amber accent, or a Chivo display face describes the
> *previous* system. It is kept because the reasoning is still useful and several of its
> non-visual decisions still bind — but where it disagrees with `/DESIGN.md`, `/DESIGN.md` wins.

**Three surfaces, three sets of material:**

- **`/DESIGN.md` (root)** — the **landing page**, current. IBM Carbon adapted.
- **`handoff-2026-08-07/`** — the **signed-in app** (Billing, Seats, Seat detail, Data &
  exports, Admin queue, Sign in). White cards on a dark slate shell. **Still current, untouched
  by the landing migration.**
- **`handoff-landing-v2/`** — the **landing page, previous system**. Historical; see the box above.

## What's in this directory

| Path | What it is |
|---|---|
| [../../DESIGN.md](../../DESIGN.md) | **The active landing design system.** Tokens with measured contrast, type scale, components, spacing. **Start here for the landing.** |
| [reference/](reference/) | Unmodified `DESIGN.md` files from awesome-design-md — Carbon (adopted) plus PostHog, Binance, WIRED and Intercom (runners-up). Read `reference/README.md` before reusing any of them. |
| [decisions/](decisions/) | Dated decision records and the critique snapshots that produced them. |
| [handoff-landing-v2/README.md](handoff-landing-v2/README.md) | **The landing handoff.** Tokens with measured contrast, type scale, all ten bands, interaction and responsive rules, photography brief. **Start here for the landing.** |
| `handoff-landing-v2/TradesDatabase Landing.dc.html` | The landing prototype. Open in a browser with its sibling files present. |
| `handoff-landing-v2/Design spec.dc.html` | Token table with measured contrast, type scale, photography brief. |
| `handoff-landing-v2/Directions.dc.html` | Four earlier exploratory directions. Context only — the landing file is the spec. |
| `handoff-landing-v2/support.js`, `image-slot.js` | Generated runtime the `.dc.html` files need. Not ours, don't edit, not for production. |
| [landing-redesign-brief.md](landing-redesign-brief.md) | The brief that was sent out and produced `handoff-landing-v2/`. Historical. |
| [handoff-2026-08-07/README.md](handoff-2026-08-07/README.md) | The app handoff. Design tokens, type scale, all six screens, the interaction table, and the designer's own open questions. **Start here for the app.** |
| [handoff-2026-08-07/2d-slate-shell.md](handoff-2026-08-07/2d-slate-shell.md) | Theme amendment "2d Slate shell" — the dark app shell. **Supersedes the neutral tokens in the README**; read it second. |
| `handoff-2026-08-07/TradesDatabase v2 workwear.dc.html` | The interactive prototype, all six screens. Open in a browser; the dark bar at the top switches screens. Needs `support.js` beside it. |
| `handoff-2026-08-07/Palette options.dc.html` | The four colour directions considered. Reference only — 1b (workwear) was chosen, then amended by the slate-shell note. |
| `handoff-2026-08-07/support.js` | Generated runtime the two `.dc.html` files need. Not ours, don't edit. |

The handoff is a **point-in-time brief, not a spec of what shipped.** Where the two differ,
the code is right and the divergence is listed below with its reason.

## Where the design actually lives in code

| Design concern | File |
|---|---|
| **App** colour tokens, type stack, radius, shadow, focus ring | [web/portal/src/tokens.css](../../web/portal/src/tokens.css) |
| **Landing** colour tokens and every landing component class | [web/portal/src/screens/landing.css](../../web/portal/src/screens/landing.css) |
| Buttons, pills, cards, inputs, section headings (app only) | [web/portal/src/components/ui.tsx](../../web/portal/src/components/ui.tsx) |
| Sidebar and app frame | [web/portal/src/components/AppShell.tsx](../../web/portal/src/components/AppShell.tsx) |
| One screen per file | `web/portal/src/screens/` |
| The landing's ten bands | [web/portal/src/screens/Landing.tsx](../../web/portal/src/screens/Landing.tsx) |
| Landing contact form, product-film placeholder | `src/components/ContactForm.tsx`, `VideoPlaceholder.tsx` |
| Fonts — app (Archivo, Inter Tight, JetBrains Mono) and landing (IBM Plex Sans, IBM Plex Mono) | self-hosted via `@fontsource`, imported in `src/main.tsx` — no CDN at runtime. **Chivo was removed in the Carbon migration**; the landing now runs one family plus mono. |

## The landing is a separate design system

This is the thing most likely to trip someone up, so it is spelled out.

**The landing's tokens are declared on `.landing`, not `:root`.** `--bg`, `--surface`,
`--line`, `--text`, `--amber` and `--teal` all exist in both `tokens.css` and `landing.css`
with completely different values — the app is white cards on a slate shell, the landing is now
a white Carbon canvas. Scoping the landing's set to `.landing` shadows the app's for that
subtree only. **Do not lift landing tokens into `:root` and do not "unify" the two palettes** —
it would repaint every app screen.

**The landing's token NAMES are historical and no longer describe their colours.** They were
coined for the dark design and deliberately kept through the Carbon migration so ~106 component
rules did not have to be rewritten. Read them as roles: `--amber` / `--amber-fill` mean *the
accent* and are now IBM Blue `#0f62fe`; `--paper` means *the record surface* and is now white;
`--teal` means *the quiet accent* and is also blue. The mapping is commented at the top of
`landing.css`.

**Inverted surfaces rebind their roles rather than patching descendants.** The footer, the
manager seat card and the bot chat bubble sit on `#161616`. Each one re-declares `--text-2`,
`--amber`, `--teal` and `--on-amber` locally so descendants stay legible without knowing they
are on dark. This exists because the ordinary accent is **3.62:1** on `#161616` and fails AA;
`--blue-on-dark` (`#78a9ff`) is 7.68:1.

**Two type stacks on one origin, on purpose.** The app runs Archivo / Inter Tight / JetBrains
Mono; the landing runs Chivo / IBM Plex Sans / IBM Plex Mono, rebound onto the same three role
variables (`--display`, `--sans`, `--mono`) inside `.landing` so the shared `.mono` utility
keeps working. The landing does not have to match the app and deliberately doesn't.

**Both handoffs ban third-party requests.** Fonts are self-hosted `@fontsource` (Latin subsets
for the landing's three), the product film will be a self-hosted `<video>` and never a YouTube
iframe, and there are no trackers. Keep it that way.

**Amber does two jobs and the designer flagged it.** In the app amber means *attention
required*; on the landing it is the brand. Anyone crossing between the two daily will feel the
collision. Still undecided — see the landing handoff's open questions.

## Deviations from the app handoff (`handoff-2026-08-07`), and why

Each is also commented at the point it occurs in the code. Listed here because the reasons
are the kind of thing that gets lost.

**Forced by the data model**

1. **Two seat tiers, not one flat price.** The handoff prices every seat the same.
   `tenants.manager_seats` and `technician_seats` are separate columns with separate caps and
   separate prices ($80 / $50), and the repo deliberately never sums them into a blended
   "$/seat" — that divides two different products by one denominator. So the seats table has a
   TIER column, the estimate card has one line per tier, and the add-seat modal picks a tier.
2. **Five lifecycle states, not three.** The roster runs
   `invited → pending_verification → active → offboarding → offboarded`, plus `seat_exempt`.
   The handoff's Active / Provisioning / Suspended is a display projection, computed by
   `displayStatus()` in `src/data/model.ts`. Seat-exempt people render as "No seat".
3. **No per-seat region or sandbox size.** The add-seat modal's two selects were dropped:
   sandboxes are pre-built cold blanks claimed from `sandbox_pool` on a single host, and
   `hosts` carries no region or plan column. Host and region are account facts, shown as text.
4. **Delete is behind a confirmation** and does not remove the row — it moves the person to
   `offboarding`. Refs are never reused, so the copy says re-hiring means a new seat. The
   handoff flagged the missing dialog itself as a production requirement.

**Forced by a platform change after the design was drawn**

5. **Modal step 2 is a one-tap link, not a pasted token.** Telegram's Managed Bots (Bot API
   9.6, Apr 2026) lets a manager bot create bots via a `t.me/newbot/...` deep link and fetch
   the token with `getManagedBotToken`. The customer never handles a credential and no live
   bot token passes through a web form. The landing page's step-01 copy changed to match.

**Forced by measured contrast**

6. **`ink-4` 0.55 → 0.53, `ink-5` 0.62 → 0.56.** At the handoff's values `ink-5` renders
   **3.65:1** on white, under the 4.5:1 minimum, and it carries text people need to read
   (log lines, dates, "expires 13 Aug", the `×` delete control). `ink-5` had to move; moving it
   alone collapsed it onto `ink-4`, so both did. The muted scale is now an even 0.03 step —
   0.50 / 0.53 / 0.56 → 6.00 / 5.27 / 4.62:1.
7. **`--amber-on-shell` and `--danger-on-shell` added.** The slate note specifies the lifted
   amber for the landing step numerals; the same value is needed for any amber text on the
   shell, including the `.on-shell` link rule (nav and footer links were 2.5:1). `danger` on
   `shell-bg` is ~1.9:1, so the on-shell "Delete seat" button needs a lifted variant. Pills and
   figures inside white cards keep the original `danger`.
8. **White containers reset `color: var(--ink)`.** `body` now carries `shell-ink` for the dark
   frame, so any text inside a white card without its own colour inherits white-on-white. The
   reset lives on the containers (`S.card`, both modal panels, the landing browser mock) so it
   can't recur as screens are added.

**Product decisions**

9. **A fourth nav item, "Data & exports."** The handoff has no home for downloading records or
   logs; filing it under Billing would misfile it as a finance action.
10. **Sign-in leads with the magic link**, password behind a secondary control — a password
    field is credential custody this system does not otherwise have.

## Deviations from the landing handoff (`handoff-landing-v2`), and why

The landing handoff is high fidelity and was followed literally almost everywhere. Four places
it wasn't, all commented at the point they occur in `landing.css` / `Landing.tsx`.

1. **The quote grid uses fixed column counts, not `auto-fit`.** The handoff asks for
   `repeat(auto-fit, minmax(340px, 1fr))` **and** for "4 → 2 → 1, never 3". Those contradict
   each other: at the 1240px content column that minimum resolves to exactly three tracks and
   orphans the fourth quote as the blank grey panel the handoff itself warns about. Fixed
   counts at two breakpoints (`≥1180px` → 4, `≥660px` → 2, else 1) are the only way to get the
   stated behaviour. This is the **only** media-query-driven grid on the page; everything else
   is fluid as specified.
2. **Grid dividers are cell box-shadows, not a `--line` container background.** The handoff
   draws dividers as 1px gaps over a `--line` background. Done literally, any row that does not
   fill leaves an *empty cell* painted `--line`. The container stays `--surface` and each cell
   casts a `0 0 0 1px var(--line)` shadow instead: adjacent shadows meet exactly in the 1px
   gap, so the hairlines are identical, but an unfilled cell reads as surface.
3. **Prices render in `$`, not the handoff's `£`.** The handoff's own open question #1 flags
   the split — the design prices in £ because the customers are UK, the app shows $. Owner call
   2026-08-11 was `$` so the landing cannot disagree with Billing. The landing reads
   `PRICE_CENTS` out of `data/model.ts` rather than carrying its own numbers, so the two cannot
   drift; moving to £ is that constant plus `CURRENCY`.
4. **The landing root uses `overflow-x: clip`, never `overflow-x: hidden`.** `hidden` makes
   `.landing` a scroll container, and a sticky descendant then anchors to *that* instead of the
   viewport — so the nav silently stopped sticking and scrolled away with the page while still
   computing `position: sticky`. `clip` gives the same guard against horizontal overflow without
   establishing a scroll container. **Consequence for testing:** `clip` also hides overflow from
   `document.scrollWidth`, so horizontal-overflow checks must compare element bounding rects
   against `clientWidth`, not read `scrollWidth`.
5. **The link reset is `.landing :where(a)`, not `.landing a`.** Written without `:where()` the
   rule scores (0,1,1) and outranks every single-class component rule below it — which silently
   repainted the amber CTA's label `--text` instead of `--on-amber` (**2.17:1**, caught by the
   contrast audit) and the nav links `--text` instead of `--text-2`. `:where()` contributes no
   specificity, so the rule still beats `tokens.css`'s bare `a` but loses to the component
   classes. **Keep that rule above them in the file.**

> **The two subsections below describe the PREVIOUS (dark) landing system.** They are kept as
> reasoning, not as current spec. Under Carbon the amber/paper values they discuss no longer
> exist; the current measured contrast table is [`/DESIGN.md`](../../DESIGN.md) §5, and the
> current audit result is **112 text nodes, 0 failures, lowest pair 4.55:1**.

### Landing values that are below 3:1 and are meant to be

Measured, reported, and left alone because the handoff specifies them. Do not "fix" these
without a design decision:

| Value | Measured | Why it stands |
|---|---|---|
| `--line` hairline on `--bg` | 1.61:1 | The handoff's token table marks `--line` **non-text only** at 1.6:1 |
| Stepper border `#b9b4ab` on `--paper-2` | 1.54:1 | Handoff-specified; the `–`/`+` glyphs carry the control's perceivability |
| Disabled stepper label (45% opacity) | 2.70:1 | WCAG exempts inactive controls |

Every actual **text** pair on the landing clears AA with margin — 122 text nodes, 0 failures,
lowest pair 5.53:1 against a 4.5 requirement.

## Still not designed

**The app** (not the landing): loading state during provisioning, error states (token rejected,
capacity, payment declined), form validation, empty states, hover states, and **responsive
behaviour** — the app design is desktop-first and fixed-width (236px sidebar, 1280px main,
560px modal). Below ~1100px it degrades. The repo's other two web surfaces are phone-first, so
this is worth settling before a customer sees it.

**The landing** still specifies hover, focus and responsive behaviour, and all three are built.
It reflows with no horizontal overflow at 390px, 800px or 1280px, re-verified after the Carbon
migration. Two P0 issues from the 2026-08-21 critique remain open, though: there is no call to
action between the hero and the footer form, and no reassurance beside the submit button. See
[decisions/2026-08-21-landing-critique.md](decisions/2026-08-21-landing-critique.md).

**Two things on the landing ship as deliberate placeholders**, and the handoff is emphatic that
they stay visible rather than being filled with something fake:

- **The product film does not exist.** The designed placeholder is the approved state. Dropping
  the real film in is `<VideoPlaceholder src="…" poster="…" />` — the header strip, 16:10 well
  and scrub row stay and the well becomes a self-hosted `<video>`.
- **Four photographs have not been shot** (hero, van at first light, hands/scuffed phone,
  kitchen table at 9pm). They render as hatched amber plates carrying the brief for the shot
  each one holds. **Do not buy stock as an interim** — the handoff's reasoning is that this
  audience spots it instantly and it costs trust.

There are also no customer logos or testimonials anywhere, on purpose: pre-launch with two
pilot firms, and a faked social-proof band would undo the page.

## Checking a change against the design

```bash
npm run portal:dev        # hot-reload dev server
npm run portal:build      # production build into web/portal/dist
npm run portal:standalone # one self-contained HTML file, for sharing
```

Contrast is a gate worth re-running by hand after any colour change — the audit that caught
the faults above walks every text node, resolves the rendered colour through a canvas (needed:
`getComputedStyle` returns `oklch()` here, which naive parsing gets wrong), finds the first
opaque ancestor background, and checks against WCAG AA. It has now caught **five** separate
real faults across the two surfaces, most recently the amber CTA at 2.17:1.

Three things that audit does *not* catch on its own, and that need doing by hand:

- **Text over a `background-image`.** The landing's blueprint grid, amber hatch plates and
  photo-band gradient all sit between the text and its background colour. Compute the
  worst-case composite (for light text on a dark page, the *lightest* pixel under the glyph).
- **States with no DOM presence** — hover, focus, placeholder, disabled, and the contact form's
  post-submit confirmation. Each has to be measured or triggered separately.
- **Colours that are correct in CSS but lose a specificity fight.** The 2.17:1 CTA was a
  correctly-authored rule being outranked. Audit the *rendered* colour, never the stylesheet.
