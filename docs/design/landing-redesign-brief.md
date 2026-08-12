# Design brief: TradesDatabase marketing landing page

**For:** Claude Design
**Date:** 2026-08-10
**Scope:** The public marketing landing page only. The signed-in app is designed and built — do not redesign it.

---

## 1. What the product is

**TradesDatabase** is a customer/job record system for small trades businesses — electricians,
plumbers, roofers, HVAC, carpenters. UK-flavoured; think a 4–20 person firm with vans.

The mechanic that makes it different: **it runs inside Telegram.** Every member of staff gets
their own Telegram bot. They message it the way they'd text the boss — *"Done at 14 Bell Lane,
replaced the consumer unit, cert attached"* — and the system pulls that into a structured record:
customer → job → visit, with the original message kept as evidence behind every field.

Nobody installs an app. Nobody logs in. The only people who ever see this website are the
**owner or office manager**, and only to manage billing and seats.

### The unit of everything: a "seat"
One seat = one person = one Telegram bot + an isolated sandbox container on our server.
Two kinds, priced separately and **never blended into one average price**:

| Seat | Who | Price (placeholder) |
|---|---|---|
| **Manager** | Whoever runs the day. Books work for the crew, sees the dispatch board, adds/removes seats. | $80 / person / month |
| **Technician** | Everyone on the tools. Logs jobs, certs, photos. Sees only their own day. | $50 / person / month |

Prices are placeholders and will change. Never show a single blended "$X per seat" figure —
they are two different products.

---

## 2. Who the page is talking to

A working owner-operator, 35–60, reading on a phone between jobs or on a laptop at the kitchen
table at 9pm. Not a tech buyer. Has **bought software before and been burned** — it needed
logins and training, the lads ignored it, and they went back to WhatsApp.

**The four pains, in their words** (these were validated as the right angles, the execution just
wasn't good):
- "It's all in the group chat somewhere."
- "They won't use another app."
- "What did we do at this address?" — a customer rings about work from 18 months ago.
- "I do the paperwork on Sunday."

**What must land in four seconds:** *my crew keeps texting me anyway, and this turns that into
records I can search — without making anyone learn anything.*

---

## 3. What exists now, and what's wrong with it

There is a built landing page at `web/portal/src/screens/Landing.tsx`. **Two attempts have been
rejected. Please treat both as anti-references.**

**Attempt 1 — dark.** Followed the `2d-slate-shell.md` instruction that the landing goes dark
with the app. Verdict: *"so ugly… why's it so dark everywhere and so many words."*
A wall of dark grey text.

**Attempt 2 — light, current state.** Went light, cut the copy by two thirds, added drawn
illustrations. Verdict: *"you are doing a really bad job."*

**Honest diagnosis of what's still wrong** — the useful part of this brief:
- It reads like a **generic B2B SaaS template**: centred headline, three stat numbers, a
  feature grid of icon-title-line, two pricing cards. Structurally competent, zero personality.
- **No real imagery.** Everything is CSS-drawn: a phone mockup, some chat bubbles, five line
  icons. It looks like what it is — a developer avoiding the fact that there are no photos.
- **The trade isn't in the design.** Nothing about it feels like vans, workwear, sites,
  invoices, or the physical world these customers live in. It could be selling project
  management software.
- **Type is safe.** Archivo for headings, Inter Tight for body. Correct, characterless.
- **It explains rather than shows.** Still too many little paragraphs.

---

## 4. What we're asking for

A landing page that a plumber would look at and think *"this is for me"* — not *"this is another
software company."*

**Please deliver:**
1. The full landing page, all sections, desktop **and mobile** (mobile has never been designed
   and is a real gap).
2. A clear point of view on **imagery**: what photographs to commission and where, plus what to
   do in the interim. We have no photo library and no budget assumption yet.
3. Type direction with real personality, and a rationale.

**Structure we believe in** (change it if you disagree — this is not sacred):
hero → the problem in their words → how it works → what you get → pricing → get in touch.

### Must keep
- **A product video in the hero.** It doesn't exist yet, so it needs a designed placeholder
  state. It replaced a fake browser screenshot and that decision stands.
- **A "get in touch" form near the bottom.** Fields: name, business, email, phone (optional),
  team size, and a free-text "what's driving you mad". We onboard firms by hand, one at a time,
  so the form matters more than a self-serve signup.
- **Nav: Product · Pricing · Contact · Sign in.** There is no docs site; don't add one.
- **Both seat prices, shown separately.**
- **The provisioning story, told simply.** One tap creates the person's Telegram bot (we use
  Telegram's Managed Bots — the customer never copies a token), then their sandbox is built
  automatically in about ten minutes. Do **not** write copy about "pasting a BotFather token" —
  that's an obsolete flow.

### Constraints
- **Accessibility is a hard gate.** Every text/background pair must clear **WCAG AA** (4.5:1
  body, 3:1 large). Two prior colour choices failed this and had to be corrected after the fact.
  Please give measured values, not vibes.
- **No third-party embeds.** No YouTube iframe, no CDN fonts, no external trackers. Everything
  self-hosted — this is a privacy and CSP position, not a preference. Name the fonts and we'll
  self-host them.
- Built in **React + Vite**, plain CSS custom properties, no CSS framework.

### Free to change
The colour system, the type, the layout, the section order, and the illustration approach are
all open. **The dark app shell must stay** — but the landing page does **not** have to match it,
and probably shouldn't.

---

## 5. The existing design system (context, not a cage)

The signed-in app follows an approved handoff, `docs/design/handoff-2026-08-07/`, plus the
`2d-slate-shell.md` theme amendment. Full token list is in
`web/portal/src/tokens.css`. Summary:

| Role | Value | Notes |
|---|---|---|
| Accent | `oklch(0.72 0.16 70)` amber | **Reserved for "attention required"** in the app. On marketing it's the brand colour. |
| Healthy / settled | `oklch(0.55 0.09 200)` teal | There is deliberately **no green** in the system. |
| Ink | `oklch(0.27 0.02 250)` | Cool steel neutrals, hue 250 throughout. |
| App shell | `oklch(0.26 0.012 250)` bg, `oklch(0.2 0.012 250)` sidebar | Dark. Applies to the app, not necessarily the landing. |
| Type | Archivo (display) + Inter Tight (body) + JetBrains Mono (data) | Mono is for machine-generated values only: IDs, bot handles, timestamps. |

Radii are deliberately square-ish (4px pills, 5px buttons) — part of a "workwear" intent that
never really came through and is worth revisiting.

---

## 6. Practical notes

- Voice is British, plain, slightly blunt. No exclamation marks, no "revolutionise", no
  "seamless". *"They won't use another app"* is the register.
- No customer logos or testimonials — this is pre-launch with two pilot firms. Don't design
  a social-proof band that we'd have to fake.
- Currency shows as `$` today but the customers are UK. Flag it if it affects your copy.
- Deliver as you normally would (HTML prototype + written spec). A token table and a stated
  type scale are more useful to us than a pixel-perfect comp.
