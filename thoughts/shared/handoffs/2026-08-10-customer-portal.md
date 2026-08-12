# Session handoff — customer account portal

**Date:** 2026-08-10 · **Branch:** `feat/customer-billing-portal` · **HEAD:** `8b44825`

Paste this into a new chat to continue.

---

## Where things stand

A customer-facing portal exists at `/portal`, running entirely on **mock data**. Six screens
plus a seventh added on request. Nothing is wired to Supabase or Stripe.

**Committed** — `8b44825` "Add the customer account portal (React + Vite, mock data)":
36 files, all six handoff screens + Data & exports, the slate-shell dark theme, and
`src/portal/portalApi.ts` serving static assets. All gates were green at commit.

**Uncommitted** — a landing-page rewrite that was **rejected twice** and should probably be
thrown away rather than built on:
- `web/portal/src/screens/Landing.tsx` (rewritten light, more sections, fewer words)
- New: `ContactForm.tsx`, `VideoPlaceholder.tsx`, `PhoneMock.tsx`, `Illustrations.tsx`
- Archivo added as a display font (`package.json`, `main.tsx`, `tokens.css`)
- Display-font application across app screens (AppShell, Billing, AdminQueue, SeatDetail,
  SignIn, DataExports, both dialogs)

**A redesign brief has been written** for Claude Design at
`docs/design/landing-redesign-brief.md`. The intent is that the landing gets redesigned
externally and re-implemented, so **do not sink more time into Landing.tsx** until that comes
back. The ContactForm / VideoPlaceholder components and the Archivo font work are probably
worth keeping regardless.

---

## The decisions that are settled

Don't relitigate these; they were each decided deliberately.

| Decision | Value |
|---|---|
| Pricing | **$80 manager / $50 technician** per month. Placeholders, will change. **Never blended** into one per-seat figure — the DB keeps the tiers separate on purpose. |
| Trial | A **discounted first month via a Stripe coupon**, not `trial_period_days`. A real Stripe trial ends the moment a customer edits their subscription, which would silently kill their discount. |
| Signup | **Invite-only.** We create the tenant; the customer signs in to an account that exists. |
| Framework | **React + Vite** under `web/portal` — the repo's first build step. (Recommendation had been vanilla to match `/admin` and `/board`; owner chose React.) |
| Bot creation | **Telegram Managed Bots** (Bot API 9.6): one-tap `t.me/newbot/...` deep link, then `getManagedBotToken`. No customer ever pastes a token. This **overturns** `docs/engineering-memory.md` §2, which still says BotFather is un-automatable — that line needs correcting. |
| Sign-in | Magic link primary, password secondary. |
| Product name | **Daybook** was recommended and researched; **not adopted** — the product is still TradesDatabase. |
| Landing theme | Started dark per `2d-slate-shell.md`, then went light. Both rejected. **Open — see the brief.** |

---

## Ten divergences from the design handoff

All are commented in code and indexed in `docs/design/README.md`. The load-bearing ones:

1. **Two seat tiers**, not one flat price — `tenants.manager_seats` / `technician_seats` are
   separate columns with separate caps.
2. **Five lifecycle states** (`invited → pending_verification → active → offboarding →
   offboarded`) projected onto the handoff's three, plus a "No seat" treatment for
   `seat_exempt` people.
3. **Add-seat step 2** is the one-tap deep link, not a pasted BotFather token.
4. **Step 3 dropped** the region and sandbox-size selects — sandboxes are pre-built blanks
   claimed from `sandbox_pool` on one host, and `hosts` has no region or plan column.
5. **Delete** is behind a confirmation and moves the row to `offboarding`; refs are never reused.
6. **`ink-4` 0.55→0.53, `ink-5` 0.62→0.56** — the handoff's `ink-5` renders 3.65:1 on white,
   under AA, and carries log lines, dates and the delete control.
7. **Fourth nav item "Data & exports"** — the handoff has no home for it.

---

## Verification approach that worked

Static gates don't catch the real bugs here. Two that only surfaced under interaction:

- **`3 of 2 manager seats`** — `Seats.tsx` read the imported `PURCHASED` constant instead of
  live state, so buying a seat updated billing but not the seats summary.
- **White-on-white** — the dark shell puts light ink on `body`, so any text in a white card
  without its own colour inherited white. Fixed on the containers (`S.card`, both modal panels).

**A contrast audit is worth re-running after any colour change.** Walk every text node, resolve
the rendered colour *through a canvas* (`getComputedStyle` returns `oklch()` here and naive
parsing silently produces garbage — this bit me once), find the first opaque ancestor
background, check against WCAG AA. It has caught four separate real faults.

---

## Running it

```bash
npm run portal:dev          # hot reload
npm run portal:build        # production build → web/portal/dist
npm run portal:standalone   # single self-contained HTML for sharing
npm run typecheck && npm run lint && npm test && npm run build
```

Serve the real route:
```bash
PORTAL_STATIC_DIR=web/portal/dist MCP_HTTP_PORT=8932 node dist/mcp/httpServer.js
# then http://localhost:8932/portal
```

**Tests need Docker + the local Supabase stack.** If Docker is paused: `docker desktop restart`,
then `npx supabase start`. A fresh stack has no migrations — `npx supabase db reset` (local only;
`testEnvGuard` protects the pilot DB).

---

## What's next, in order

1. **Landing redesign** — send `docs/design/landing-redesign-brief.md` out, re-implement when
   it returns.
2. **Responsive** — never designed. Fixed widths throughout (236px sidebar, 1280px main, 560px
   modal). Rough below ~1100px. The repo's other two web surfaces are phone-first.
3. **Wire the data** — this is the real work and hasn't started. Plan is at
   `thoughts/shared/plans/2026-08-07-customer-billing-portal.md`; research at
   `thoughts/shared/research/2026-08-07-customer-billing-portal.md`. Phase order: billing
   schema → auth + tenant scoping → seat purchase via Stripe → managed bots → box provisioning
   → seat release → export.

### Blocking before data work
- **Phase 0 probe is unstarted and gates the whole design:** is there a cap on managed bots per
  manager bot (Telegram's historic limit was 20 per user)? And how many sandboxes actually fit
  on the 16 GB Lightsail box? Right now there is **one** free blank left. Selling a seat we
  can't provision fails ~10 minutes later on a machine the customer can't see.
- **Render needs `npm run portal:build`** added to its build command or `/portal` 404s in
  production. Note the standing gotcha: Render deploys a **separate repo**
  (`Yu-C1/TradesDatabase`), so merging here doesn't ship.
- **The admin queue is a second cross-tenant surface** reached from the same shell customers
  use. It must authenticate as an operator, and its nav item must not render for customer
  sessions.

### Also parked
- `stash@{0}` holds unrelated WIP from `chore/cleanup-verify` (staged deletions of
  `src/index.ts`, `src/email/ingest.ts`). Not mine — restore with `git stash pop` on that branch.
- `docs/engineering-memory.md` §2 still claims BotFather can't be automated. Wrong since
  Bot API 9.6.
