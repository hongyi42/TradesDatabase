# Handoff: TradesDatabase — account, billing & seat provisioning

## Overview
Customer-facing web app for TradesDatabase, a Telegram-bot-based record system for trades
businesses (electricians, plumbers, roofers, HVAC, carpenters). Each member of staff is a
"seat". A seat = a Telegram bot (token from BotFather) + that person's Telegram user ID +
an isolated sandbox container provisioned on the company's Amazon Lightsail host.

The app covers six screens: marketing landing, sign in, billing & payments, the seats data
table, an individual seat detail page, and an internal admin queue.

## About the Design Files
The files in this bundle are **design references created in HTML** — prototypes showing the
intended look and behaviour. They are **not production code to copy directly**.

The task is to **recreate these designs in the target codebase's existing environment**
(React, Vue, Svelte, Rails views, whatever is already in use) using its established
components, routing and styling patterns. If no front-end environment exists yet, pick the
framework that best suits the project and implement the designs there.

`TradesDatabase v2 workwear.dc.html` is the approved design. `Palette options.dc.html` shows
the four colour directions that were considered — reference only, direction "1b (workwear)"
was chosen and is what v2 implements.

## Fidelity
**High-fidelity.** Final colours, typography, spacing and interaction model. Recreate the UI
faithfully using the codebase's existing libraries where they exist.

Two caveats:
- The design was built without access to the existing TradesDatabase codebase. Field names,
  ID formats and the exact provisioning step list are plausible placeholders — reconcile
  them against the real data model.
- All data is mock data hardcoded in the prototype. Nothing is wired to an API.

---

## Design Tokens

> **Amended:** the app shell is now dark — see `2d-slate-shell.md`, which overrides the
> neutral background tokens below. Accent, status, type and spacing are unaffected.

All colours are authored in `oklch()`. Hex equivalents are approximate (sRGB) and given for
convenience; prefer the oklch values if the target supports them.

### Colour — neutrals (cool steel, hue 250)
| Token | oklch | ~hex | Use |
|---|---|---|---|
| `bg` | `oklch(0.975 0.01 250)` | `#f6f7f9` | Page background |
| `surface` | `oklch(1 0 0)` | `#ffffff` | Cards, table bodies, inputs |
| `surface-alt` | `oklch(0.99 0.006 250)` | `#fbfcfd` | Sidebar, table headers, footers |
| `surface-alt-2` | `oklch(0.98 0.006 250)` | `#f8f9fb` | Column header rows |
| `nav-selected` | `oklch(0.94 0.008 250)` | `#ecedf1` | Active sidebar item |
| `line` | `oklch(0.9 0.008 250)` | `#dfe1e7` | Card and section borders |
| `line-soft` | `oklch(0.95 0.008 250)` | `#eff0f4` | Table row dividers |
| `input-border` | `oklch(0.88 0.008 250)` | `#d9dbe2` | Input / button borders |
| `ink` | `oklch(0.27 0.02 250)` | `#3a4050` | Primary text, dark panels |
| `ink-2` | `oklch(0.45 0.02 250)` | `#666e80` | Body copy |
| `ink-3` | `oklch(0.5 0.02 250)` | `#737b8d` | Secondary values |
| `ink-4` | `oklch(0.55 0.02 250)` | `#818999` | Labels |
| `ink-5` | `oklch(0.62 0.02 250)` | `#959cab` | Meta text, mono captions |

### Colour — accent & status
| Token | oklch | ~hex | Use |
|---|---|---|---|
| `amber` | `oklch(0.72 0.16 70)` | `#e08a1e` | Primary buttons, logo mark, "Provisioning" pill, brand rules |
| `amber-on` | `oklch(0.25 0.04 70)` | `#3a2c14` | Text on amber |
| `amber-deep` | `oklch(0.5 0.12 68)` | `#8a5a10` | Accent text, links, step numerals |
| `amber-deep-hover` | `oklch(0.4 0.1 68)` | `#6b450a` | Link hover |
| `amber-tint-bg` | `oklch(0.96 0.035 78)` | `#fbf1e0` | Eyebrow chip background |
| `amber-tint-line` | `oklch(0.85 0.07 78)` | `#e5cba2` | Eyebrow chip border |
| `teal` | `oklch(0.55 0.09 200)` | `#3c8194` | Health dots, "Active" indicator |
| `teal-bg` | `oklch(0.93 0.04 200)` | `#dcecef` | "Active" / "Paid" pill background |
| `teal-fg` | `oklch(0.4 0.09 200)` | `#1f5c6d` | "Active" / "Paid" pill text |
| `danger` | `oklch(0.5 0.14 25)` | `#a8402f` | Destructive text, failure counts |
| `danger-line` | `oklch(0.85 0.04 25)` | `#e5cac4` | Destructive button border |
| `suspended-bg` | `oklch(0.94 0.008 250)` | `#ecedf1` | "Suspended" pill background |

**Status semantics — important.** Amber is reserved for *attention required*. Anything
provisioning, failing or pending uses amber; healthy/settled states use teal. Do not
introduce a green.

### Typography
- Sans: **Inter Tight**, weights 400 / 500 / 600 / 700. Fallback `system-ui, sans-serif`.
- Mono: **JetBrains Mono**, weights 400 / 500 / 600. Fallback `monospace`.

Mono is used for anything machine-generated: IDs, bot handles, tokens, regions, instance
names, amounts in tables, column headers, timestamps, log lines.

| Role | Size | Weight | Letter-spacing | Line-height |
|---|---|---|---|---|
| Hero h1 | 56px | 600 | -0.03em | 1.03 |
| Page h1 | 26px | 600 | -0.02em | default |
| Login h2 | 30px | 600 | -0.02em | default |
| Big figure (bill total) | 38px | 600 | -0.03em | default |
| Metric figure (admin cards) | 27px | 600 | -0.02em | default |
| Card figure (sidebar) | 21px | 600 | -0.02em | default |
| Section h2 / card title | 16px / 13px | 600 | default | default |
| Marketing h3 | 19px | 600 | -0.01em | default |
| Hero body | 18px | 400 | default | 1.6 |
| Marketing body | 15px | 400 | default | 1.6 |
| UI body | 14px | 400 | default | default |
| Table cell | 13.5px | 400 (500 for the name cell) | default | default |
| Table mono cell | 12–12.5px | 400 | default | default |
| Column header (mono, uppercase) | 10.5px | 400 | 0.07em | default |
| Eyebrow (mono, uppercase) | 11px | 400 | 0.09em | default |
| Pill | 11.5px | 500 (600 for solid amber) | default | default |
| Caption / helper | 12–13px | 400 | default | 1.55 |

`text-wrap: balance` on the hero h1, `text-wrap: pretty` on long marketing paragraphs.

### Spacing, radius, shadow
- Spacing scale in use: 4, 6, 7, 9, 11, 12, 14, 16, 18, 22, 26, 30, 38, 44, 56, 64, 88 px.
  The grid is loose rather than strict-8 — round to your system's nearest step.
- Radius: `4px` pills and status chips (deliberately square — part of the workwear look),
  `5px` primary buttons, `6–8px` inputs and secondary buttons, `9–13px` cards and modals,
  `50%` dots and avatars.
- Shadows: hero mock `0 18px 40px -24px oklch(0.27 0.02 250 / 0.28)`;
  modal `0 30px 70px -30px oklch(0.27 0.02 250 / 0.5)`;
  modal scrim `oklch(0.27 0.02 250 / 0.42)`.
- Focus states are browser default in the prototype. **Add a visible focus ring** in
  production — amber at 2px offset is the natural choice.

---

## Screens / Views

A mockup-only navigation bar sits at the top of the prototype (dark strip, mono type,
buttons: Landing / Sign in / Billing / Seats / Seat detail / Admin). **This is scaffolding
for reviewing the mockups — do not build it.** Real navigation is the marketing header, the
sign-in flow and the app sidebar.

### 1. Landing (marketing home)
**Purpose:** explain the product and get an existing customer to sign in.

**Layout:** full width, content max-width 1360px centred.
- Header: 22px/56px padding, space-between, bottom border `line`, background `surface-alt`.
  Left = 26px amber rounded square + "TradesDatabase" 16px/600/-0.01em. Right = nav links
  ("Product", "Pricing", "Docs") 14px `ink-2`, gap 30px, then a "Sign in" button
  (9px/18px, radius 7px, `surface`, `input-border`, 14px/500).
- Hero: `grid-template-columns: 1.05fr 0.95fr`, gap 64px, padding `88px 56px 76px`,
  vertically centred.
  - Left column: eyebrow chip "Telegram-native" (amber-tint bg + border, `amber-deep` text,
    5px/10px padding, radius 5px) → h1 "One database for every trade on your books."
    → 18px paragraph, max-width 30em → two buttons in a 12px flex row (primary amber
    "Sign in to your account", secondary outlined "Book a walkthrough", both 13px/24px,
    radius 8px, 15px/500) → mono caption "$18 per seat, per month · cancel a seat any time,
    billed prorated".
  - Right column: a fake browser window — 11px/14px title bar with three 9px grey dots and
    the mono URL `app.tradesdatabase.io/seats`, then an 18px-padded body listing four seats
    with name, mono bot handle, trade and a teal status dot.
- Three-step band: top border, `surface-alt` background, 64px/56px padding, three equal
  columns gap 40px. Each: mono numeral (01/02/03) in `amber-deep`, h3, 15px paragraph.
  Copy is exact and load-bearing — it is the clearest explanation of the provisioning model
  anywhere in the design:
  1. **Add a seat** — "Paste the bot token from BotFather and the person's Telegram user ID.
     Two fields, nothing else."
  2. **We provision the sandbox** — "An isolated container spins up on our Lightsail host and
     binds to that token. Typically under 90 seconds."
  3. **Billing follows the seat** — "Add or delete seats mid-cycle and the next invoice is
     prorated to the day. No support ticket."
- Footer: 28px/56px, top border, 13px `ink-5`, "© 2026 TradesDatabase" left, Status / Terms /
  Privacy right (gap 22px).

### 2. Sign in
**Purpose:** authenticate account owners and billing admins. Field staff never sign in here —
they use the bot.

**Layout:** two equal columns, full viewport height.
- Left: vertically centred, horizontal padding `clamp(48px, 8vw, 120px)`. Logo lockup (44px
  bottom margin) → h2 "Sign in" → 15px sub "Account owners and billing admins only. Field
  staff use the bot." → "Work email" input → "Password" input → primary amber "Continue"
  → "or" divider (1px rules either side of a 12px label, gap 14px) → outlined "Send me a
  magic link" → 13px "Locked out? Contact your account owner" with a link.
  All fields and buttons `max-width: 420px`, inputs 12px/14px padding, radius 8px, 15px text.
- Right: `ink` background, `oklch(0.9 0.01 250)` text, vertically centred, padding
  `clamp(48px, 6vw, 88px)`. A 24px/1.45 pull quote (max-width 20em) and a mono attribution
  line 28px below.

Both "Continue" and the magic-link button navigate to Billing in the prototype.

### 3. Billing
**App shell from here on.** `grid-template-columns: 236px 1fr`.

**Sidebar** (`surface-alt`, right border, 22px/14px padding, 26px gap column):
logo lockup → mono section label "ACCOUNT" (10px, 0.1em) → three nav buttons ("Billing",
"Seats", "Admin queue"; 9px/10px padding, radius 7px, 14px/500, active background
`nav-selected`, transparent otherwise) → spacer → a bordered "This cycle" card showing the
total and a mono "due 1 Sep 2026" → user row (26px avatar circle, name 13px/500, role 11px
`ink-5`) with a top border.

Note: "Seats" stays visually active when the user is on a seat detail page.

**Main** — 30px/38px padding, max-width 1280px.
- h1 "Billing", sub "Harrow Brothers Electrical · Team plan · billed monthly".
- Two cards, `grid-template-columns: 1.4fr 1fr`, gap 18px, radius 11px, 22px padding.
  - **Estimate card:** "Estimated for August" label, 38px total, outlined "Pay now" button
    top-right; 1px divider at 20px margin; then three label/value rows (11px gap):
    "N seats × $18", "Prorated additions (2 seats, 11 days)", "Sandbox overage" (value in
    `ink-5` when zero). Values in mono.
  - **Payment method card:** bordered row with a 38×25 dark card rectangle, "Visa ending
    4417" and a mono expiry; a dashed "Add another card" button below; spacer; then a
    top-bordered billing-contact line.
- **Invoices** section: heading row with "Export CSV" (mono, 11px, outlined, radius 6px)
  right-aligned; table in a radius-11 card. Columns `1.2fr 1fr 1fr 1fr auto` gap 16px —
  INVOICE (mono) / PERIOD / SEATS / AMOUNT (mono) / STATUS (teal "Paid" pill). Header row
  `surface-alt-2` with a bottom border; body rows 14px/18px with `line-soft` dividers.
  Five rows, INV-2026-07 back to INV-2026-03.

### 4. Seats (data table)
**Purpose:** the operational core — see every seat, sort, export, add, delete.

- Header row: h1 "Seats" + summary line "8 seats · 6 active · $18 each per month";
  right side "Export CSV" (mono outlined) and "Add seat" (primary amber).
- Filter bar (22px above, 14px below): search input (max-width 340px, placeholder
  "Search name, trade or Telegram ID"), status select, region select. All 9px padding,
  radius 7px, 13.5px.
- Table card, columns `1.5fr 1fr 1.1fr 1.3fr 0.9fr 1fr 34px` gap 14px:
  NAME · TRADE · TELEGRAM ID · BOT · SANDBOX · STATUS · (delete).
  - NAME, TRADE and STATUS headers are sort buttons; the active one appends `↑` / `↓`.
    Clicking toggles direction, clicking a new column resets to ascending.
  - Name cell is a button that opens the seat detail page; 500 weight, `ink`.
  - TELEGRAM ID, BOT and SANDBOX are mono 12px `ink-3`.
  - STATUS pill: Active = teal bg/fg; Provisioning = **solid amber** with `amber-on` text;
    Suspended = `suspended-bg` with `ink-3`.
  - Last column is a `×` delete button, 16px, `ink-5`.
- Footnote below the table, 12.5px `ink-5`: "Deleting a seat destroys its sandbox and revokes
  the bot token. Credit is prorated to the next invoice."

**Production note:** delete is immediate in the prototype. It must be behind a confirmation
dialog in production — it destroys infrastructure and revokes a token.

### 5. Seat detail
**Purpose:** inspect and manage one seat's bot binding, its sandbox, and what it has logged.

- Back link "← Seats" (13px, `ink-4`).
- Header: 52px rounded-11 avatar + h1 name + sub "{trade} · seat since Mar 2026 · $18/mo";
  right side "Suspend" (outlined) and "Delete seat" (outlined in `danger-line`, `danger` text).
- Two cards, `1.25fr 1fr`, gap 18px, 22px padding:
  - **Bot binding** — a `130px 1fr` definition grid (13px row gap, 18px column gap):
    Bot handle, Token (**masked**, e.g. `7642••••••••••••••••••••••••fA1c`), Telegram user ID,
    Webhook path, Last message. Then two outlined buttons: "Rotate token", "Send test message".
  - **Lightsail sandbox** — `110px 1fr` grid: Instance (`td-sbx-04`), Region (`eu-west-2`),
    Plan (`1 GB / 2 vCPU`), Uptime, Health (teal dot + "Healthy"). Below a top border, three
    mono log lines at 11.5px / 1.8 line-height.
- **Recent records logged** card: four rows, columns `110px 1fr 1fr 90px` gap 16px —
  mono job ID, job description, site, mono date. `line-soft` top borders.

### 6. Admin queue (internal)
**Purpose:** internal staff triage of provisioning failures and flagged records.

- h1 "Admin queue", sub "Internal only. Provisioning failures and records held for review."
- Three metric cards (equal columns, gap 14px, radius 10px, 16px padding): "Provisioning now"
  = 3, "Failed in 24h" = 1 (figure in `danger`), "Lightsail capacity used" = 62%.
- Queue table, columns `1fr 1.3fr 1.4fr 190px` gap 16px: ACCOUNT (500 weight) · ITEM · REASON ·
  actions. Each row ends with a right-aligned pair of buttons — outlined "Dismiss" and a
  filled dark primary whose label varies by row type (Retry / Notify / Review / Approve),
  both 6px/12px, radius 6px, 12.5px.

Four seeded rows cover the four failure classes worth designing for: sandbox stuck
provisioning, bot token rejected by Telegram (401), duplicate Telegram ID across accounts,
and a record photo flagged by moderation.

### Add-seat modal (opens from Seats)
Fixed overlay, scrim `oklch(0.27 0.02 250 / 0.42)`, centred, 40px page padding.
Panel 560px wide, `surface`, radius 13px, `overflow: hidden`.

- **Head** (20px/24px, bottom border): title "Add a seat" 16px/600 and a mono sub
  "Step N of 3 · {Person | BotFather token | Sandbox & billing}". Close `×` right.
- **Body** (24px padding), three steps:
  1. **Person** — Name input, Trade select (Electrician / Plumber / Roofer / HVAC /
     Carpenter), Telegram user ID input (mono). Helper under the ID field: "Ask them to
     message @userinfobot — it replies with the number."
  2. **BotFather token** — an instruction panel (`surface-alt-2` background, `line` border,
     radius 9px, 14px padding, 13px/1.6): "In Telegram, open **@BotFather** → **/newbot**.
     Name it after the person, then paste the token it gives you below." Then a mono
     "Bot token" input (placeholder `7642119284:AAH...fA1c`) and a live validation line —
     teal dot + "Token valid · bot resolves to @harrow_pr_bot".
  3. **Sandbox & billing** — two selects side by side (Lightsail region: eu-west-2 London /
     eu-west-1 Dublin; Sandbox size: 1 GB / 2 vCPU standard, 2 GB / 2 vCPU heavy media).
     Then a bordered "WHAT HAPPENS ON CONFIRM" panel listing five mono steps:
     ```
     1 · create container td-sbx-09 on host td-prod-1
     2 · write token to sandbox secret store
     3 · register webhook /hook/s_9c04e2
     4 · whitelist Telegram ID 418902733
     5 · add seat to invoice, prorated 11 days
     ```
     Then a 13px line: "Adds $6.39 to this month's invoice, then $18/mo."
- **Foot** (16px/24px, top border, `surface-alt`, space-between): left button "Cancel" on
  step 1 / "Back" thereafter; right primary "Continue" / "Confirm & provision" on step 3.

Confirming closes the modal and appends a new seat with status **Provisioning**.

---

## Interactions & Behavior

| Trigger | Result |
|---|---|
| Landing "Sign in" (header or hero) | → Sign in |
| Sign in "Continue" / magic link | → Billing |
| Sidebar Billing / Seats / Admin queue | → that screen |
| Seats: name cell click | → Seat detail for that seat |
| Seats: NAME / TRADE / STATUS header click | Sort by that key; toggle asc/desc if already active |
| Seats: `×` | Removes the seat from the list (needs a confirm dialog in production) |
| Seats: "Add seat" | Opens the modal at step 1 |
| Modal Continue / Back | Advances / retreats one step; Back on step 1 closes |
| Modal "Confirm & provision" | Closes, appends a seat with status "Provisioning" |
| Seat detail "← Seats" | → Seats |

**Not yet designed — flag these before build:**
- Loading state while a sandbox provisions (the prototype jumps straight to a
  "Provisioning" pill; real provisioning takes up to ~90 s and should poll or stream).
- Error states: token rejected, region at capacity, payment declined.
- Form validation (Telegram ID numeric, token format `\d+:[\w-]{35}`).
- Empty states (no seats yet, no invoices yet).
- Responsive behaviour. The design is **desktop-first** and fixed-width in places
  (236px sidebar, 1280px main max-width, 560px modal). Mobile is undesigned.
- Hover states are undesigned throughout — the prototype has none. Add them per the
  codebase's conventions.

## State Management

Prototype state (all client-side, all mock):

```
screen      'landing' | 'login' | 'billing' | 'seats' | 'detail' | 'admin'
detailId    id of the seat shown on the detail screen
sortKey     'name' | 'trade' | 'status'
sortDir     'asc' | 'desc'
addOpen     boolean — add-seat modal visibility
step        1 | 2 | 3 — modal step
seats[]     { id, name, trade, tgId, bot, region, status }
            status ∈ 'Active' | 'Provisioning' | 'Suspended'
```

Derived values: active seat count, seat subtotal (`seats.length × seatPrice`), proration
(`price × 2 × 11 / 31` — placeholder maths, replace with real proration), cycle total,
sort arrows, per-row status booleans.

Configurable props exposed in the prototype: `seatPrice` (default 18) and `currency`
(GBP / USD / EUR, symbol-only formatting).

**Real data requirements:** account + plan, invoice history, seats with their bot binding
and sandbox metadata, sandbox health/log stream, records logged per seat, and the admin
queue. Provisioning is asynchronous and needs a status channel (poll or websocket).

## Assets
None. No images, no icon set — the prototype uses plain shapes as placeholders:
- Logo: a solid amber rounded square (26px landing/login, 22px sidebar). Replace with the
  real mark.
- Avatars: plain grey circles / rounded squares.
- Payment card: a dark rectangle standing in for a card-network logo.
- The card-network logo and any icons are still to be sourced.

Fonts load from Google Fonts (Inter Tight, JetBrains Mono) — self-host in production.

## Files
- `TradesDatabase v2 workwear.dc.html` — **the approved design**, all six screens plus the
  add-seat modal. Open it in a browser; use the dark bar at the top to move between screens.
- `Palette options.dc.html` — the four colour directions considered. Reference only.
- `support.js` — runtime required by both HTML files. Keep it alongside them.
- `2d-slate-shell.md` — background/shell token overrides that apply on top of the approved
  design. Read after the README.

## Open questions for the team
1. **Sandbox topology.** The design assumes one container per seat on a shared Lightsail
   host. If it is actually one instance per *customer* running N bot processes, then region
   and size are account-level settings and should move out of the seats table and the
   add-seat modal into account settings.
2. **Proration.** Placeholder maths (`price × days / 31`). Confirm the real rule, including
   what happens to credit when a seat is deleted mid-cycle.
3. **Token handling.** The design shows a masked token and a "Rotate token" action, which
   implies the token is stored and re-readable. Confirm that matches the security model.
4. **Admin queue ownership.** Built as an internal-only screen inside the same app. Confirm
   it should not be a separate tool.
