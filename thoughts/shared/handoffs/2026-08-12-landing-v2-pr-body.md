## What this is

The customer account portal at `/portal` (React + Vite, entirely mock data — nothing is wired
to Supabase or Stripe yet), plus a full rebuild of the marketing landing page against the new
design in `docs/design/handoff-landing-v2/`.

## The landing rebuild

The previous landing was rejected twice and has been replaced rather than patched. The new one
implements the handoff's organising idea — **dark shell, records on paper**: the page base is a
cool steel dark, and the two bands that represent *records* (the product proof and the pricing
ledger) sit on warm paper. That alternation is load-bearing; it is what stops the page reading
as another dark SaaS template.

Ten bands: sticky nav → hero with the product-film placeholder → photo band → `01` what we heard
→ `02` one text in, one record out → photo strip → `03` adding someone takes one tap → `04` two
kinds of seat → `05` get in touch → footer.

Kept and restyled: `ContactForm.tsx`, `VideoPlaceholder.tsx`. Removed: `PhoneMock.tsx`,
`Illustrations.tsx` — the new design has no phone mock and bans icons outright, and they were
never tracked, so they were dead files.

## Things worth a reviewer's attention

**Landing tokens are scoped, not global.** The landing's palette collides *by name* with the
app's — `--bg`, `--surface`, `--line`, `--text`, `--amber`, `--teal` all exist in `tokens.css`
with completely different values. They are declared on `.landing` so they shadow the app's for
that subtree only. The signed-in app is untouched and keeps its slate shell.

**Two type systems on one origin, deliberately.** The app runs Archivo / Inter Tight / JetBrains
Mono; the landing runs the handoff's Chivo / IBM Plex Sans / IBM Plex Mono, rebound onto the same
three role variables inside `.landing`. All self-hosted via `@fontsource`, Latin subsets only —
no CDN fonts, no video embed, no trackers.

**`overflow-x: clip`, not `hidden`, on the landing root.** `hidden` makes `.landing` a scroll
container, which silently breaks `position: sticky` on the nav — it anchors to `.landing`
(which never scrolls) instead of the viewport. The property computed correctly the whole time,
so this survived review; it only showed up when scroll position was actually measured. Note for
future testing: `clip` also hides overflow from `document.scrollWidth`, so horizontal-overflow
checks must compare element rects against `clientWidth`.

**Divergence from the handoff — the quote grid.** The handoff asks for
`repeat(auto-fit, minmax(340px, 1fr))` *and* for "4 → 2 → 1, never 3". `auto-fit` cannot honour
both: at the 1240px column that minimum resolves to exactly 3 tracks and orphans the fourth
quote. Fixed counts at two breakpoints are the only way to get the stated behaviour, so this is
the one grid on the page driven by media queries. Commented at the point it occurs.

**Divergence — gap-grid dividers.** The handoff draws dividers as 1px gaps over a `--line`
background. Done literally, any row that does not fill leaves an empty cell painted `--line` —
the blank grey panel the handoff itself flags as the thing to avoid. The container stays
`--surface` and each cell casts a 1px `--line` box-shadow instead: identical hairlines, but an
unfilled cell reads as surface.

**Currency.** The design prices in £ and flags the £/$ split as an open question. Rendered as $
per the owner's call, reading `PRICE_CENTS` off `data/model.ts` so the landing cannot drift from
what Billing charges. One constant to flip later. Both seat prices are always shown separately —
$80 manager, $50 technician — and the calculator is the only place a combined figure appears.

**Provisioning copy** says one tap → Managed Bots creates the bot → sandbox in ~10 minutes.
Nothing mentions pasting a BotFather token; that flow has been obsolete since Bot API 9.6.

## Verification

`npm run portal:build`, `npm run typecheck`, `npm run lint`, `npm test` — all green
(66 files, 1012 tests).

**Contrast audit** (the gate that has caught four real faults on this surface). Walked every text
node in the rendered page, resolved colours through a canvas — `getComputedStyle` returns
`oklch()` here and naive parsing silently produces garbage — found the first opaque ancestor
background, and computed WCAG ratios.

- **122 text nodes, 0 failures.** Lowest pair anywhere is **5.53:1** against a 4.5 requirement.
- Worst-case composites computed separately for the 22 nodes sitting over a background-image
  (blueprint grid, amber hatch plates, photo-band gradient) — lowest 5.53:1.
- Hover, focus, placeholder and the form's confirmation state audited separately — all pass.

It caught one real fault: `.landing a` scores (0,1,1) and outranked every single-class component
rule, so the amber CTA's label inherited `--text` instead of `--on-amber` — **2.17:1**. Fixed
with `:where()` in 67fbaf7.

**Behaviour**, driven in a real browser rather than asserted from the source:

- Every band checked against the handoff spec item by item (~90 assertions) — nav, hero, film
  placeholder, photo band and its five trades, four quotes verbatim, the chat→job-sheet proof
  including the SOURCE evidence block and the page's only shadow, three provisioning steps, both
  seat cards, calculator, contact form, footer. Nothing missing.
- **Calculator** swept across 8 states including both bounds: total always equals
  `managers×80 + technicians×50`, zero mismatches. Clamps at 1 manager / 0 technicians / 60 max
  with the bound buttons disabled; `$7,800` carries its thousands separator.
- **Sticky nav** verified at scrollY 0 / 600 / 2000 / 3500 — and the header's translucent
  background measured over all four backdrops it crosses (`--bg`, `--paper`, `--paper-2`, white
  card): worst pair 7.78:1.
- All three nav anchors and both hero CTAs land on the right band; the team-size select is
  genuinely controlled; the form submits to an in-place confirmation and "Send another" returns.
- **Focus** under real keyboard `Tab` navigation: 2px amber at 2px offset on every control,
  including the fields that set `outline: none`.
- No green anywhere, zero third-party requests, zero iframes, clean console. The landing
  downloads exactly its own 7 font files — the app's three families never load on it.

Three **non-text** values measured below 3:1, all designer-specified and reported rather than
silently changed:

| Value | Measured | Note |
|---|---|---|
| `--line` hairline on `--bg` | 1.61:1 | The handoff declares this token **non-text only** at 1.6:1 |
| Stepper border `#b9b4ab` on `--paper-2` | 1.54:1 | Handoff-specified; the `–`/`+` glyphs carry perceivability |
| Disabled stepper label (45% opacity) | 2.70:1 | WCAG exempts inactive controls |

**Responsive** — verified at 390 / 900 / 1440px: no horizontal overflow at any width, quote grid
goes 1 → 2 → 4 (never 3), all `auto-fit` empty tracks collapse to 0 with no orphaned cells, nav
collapses to wordmark + Sign in under 520px, steppers stay exactly 44px, and on a phone the hero
order is headline → lead → buttons → film with the pricing cards stacking technician → manager →
calculator.

## Not in scope

Nothing is wired to Supabase or Stripe — the portal is still mock data. The four photographs and
the product film do not exist; both ship as the designed placeholders, which the handoff is
explicit about ("an obvious placeholder is more honest than stock"). Note the standing gotcha
that Render deploys a **separate repo** (`Yu-C1/TradesDatabase`), and needs `npm run portal:build`
in its build command or `/portal` 404s in production.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
