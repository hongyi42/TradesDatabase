# Theme change: 2d "Slate shell"

Supersedes the neutral tokens in `README.md` § Design Tokens. Everything else in the
handoff — layout, spacing, type, radii, interactions, status semantics — is unchanged.

**The idea:** the app *shell* goes dark (page background, sidebar, top areas). Content
containers — cards, tables, inputs, modals — stay white and keep the light tokens they
already use inside. Data pops off a dark frame; nothing inside a card changes.

## Shell tokens (new)

| Token | oklch | ~hex | Use |
|---|---|---|---|
| `shell-bg` | `oklch(0.26 0.012 250)` | `#33383f` | Page background behind cards |
| `shell-sidebar` | `oklch(0.2 0.012 250)` | `#272b31` | Sidebar background |
| `shell-line` | `oklch(0.32 0.012 250)` | `#3f444c` | Borders on dark: sidebar edge, card outline against the shell |
| `shell-line-soft` | `oklch(0.3 0.012 250)` | `#3b4047` | Dividers inside the sidebar |
| `shell-nav-selected` | `oklch(0.3 0.015 250)` | `#3b4048` | Active sidebar item |
| `shell-ink` | `oklch(0.96 0.006 250)` | `#f2f3f5` | Headings and primary text on the shell |
| `shell-ink-2` | `oklch(0.7 0.012 250)` | `#a5aab2` | Sub-lines, meta, inactive nav labels |

## What changes

- **Page background** `bg` → `shell-bg`. **Sidebar** `surface-alt` → `shell-sidebar`,
  its right border `line` → `shell-line`.
- **Sidebar contents:** nav labels `shell-ink-2`, active item `shell-nav-selected` +
  `shell-ink`, the "ACCOUNT" mono label `shell-ink-2`, the "This cycle" card border
  `shell-line` on a transparent fill with `shell-ink` figure, user row top border
  `shell-line-soft`.
- **Page headings and sub-lines** that sit directly on the background (h1 "Seats", the
  "8 seats · 6 active" summary, section headings, the seat-detail back link, table
  footnotes) → `shell-ink` / `shell-ink-2`.
- **Cards and table cards** keep `surface` white and every token inside them unchanged —
  only their outer border becomes `shell-line` so they read against the dark shell.
  Table headers stay `surface-alt-2`, row dividers stay `line-soft`.
- **Secondary / outlined buttons that sit on the shell** (Export CSV, Suspend, Pay now when
  outside a card) get `shell-line` borders and `shell-ink` labels on a transparent fill.
  Buttons inside white cards do not change.
- **Amber and status colours are untouched.** Amber primary buttons, the amber
  "Provisioning" pill, teal "Active"/"Paid" pills, `danger` — all identical. Status
  semantics still hold: amber = attention required, teal = healthy, never green.
- **Modal** is unchanged (white panel); the scrim can stay as specified.
- **Sign-in page** keeps its light left column — give that column an explicit `surface`
  background rather than letting it inherit the page, or it falls onto the dark shell with
  light-theme text. Its right pull-quote panel moves from `ink` to `shell-sidebar` so the
  two-column split still reads against the shell.
- **Landing page** also goes dark: header and three-step band on `shell-sidebar`, hero on
  `shell-bg`, headings `shell-ink`, body copy `shell-ink-2`, the mono step numerals lifted
  to `oklch(0.78 0.13 70)` so amber holds up on dark. The browser mock, the amber buttons
  and the eyebrow chip are unchanged.

## To check when it lands

- Contrast of `shell-ink-2` on `shell-sidebar` (~5.4:1) — fine for labels, do not go
  lighter on the background.
- White cards on a dark background make shadows invisible; drop the card shadows in the
  app shell rather than trying to tune them.
- Add the visible focus ring the README asks for — amber at 2px offset reads well on both
  the dark shell and white cards.
