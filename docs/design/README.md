# Design — customer account portal

The approved design for the customer-facing portal (`/portal`, source in `web/portal/`),
kept here so the implementation can be checked against its brief without hunting for a
Downloads folder.

## What's in this directory

| Path | What it is |
|---|---|
| [handoff-2026-08-07/README.md](handoff-2026-08-07/README.md) | The handoff. Design tokens, type scale, all six screens, the interaction table, and the designer's own open questions. **Start here.** |
| [handoff-2026-08-07/2d-slate-shell.md](handoff-2026-08-07/2d-slate-shell.md) | Theme amendment "2d Slate shell" — the dark app shell. **Supersedes the neutral tokens in the README**; read it second. |
| `handoff-2026-08-07/TradesDatabase v2 workwear.dc.html` | The interactive prototype, all six screens. Open in a browser; the dark bar at the top switches screens. Needs `support.js` beside it. |
| `handoff-2026-08-07/Palette options.dc.html` | The four colour directions considered. Reference only — 1b (workwear) was chosen, then amended by the slate-shell note. |
| `handoff-2026-08-07/support.js` | Generated runtime the two `.dc.html` files need. Not ours, don't edit. |

The handoff is a **point-in-time brief, not a spec of what shipped.** Where the two differ,
the code is right and the divergence is listed below with its reason.

## Where the design actually lives in code

| Design concern | File |
|---|---|
| Every colour token, type stack, radius, shadow, focus ring | [web/portal/src/tokens.css](../../web/portal/src/tokens.css) |
| Buttons, pills, cards, inputs, section headings | [web/portal/src/components/ui.tsx](../../web/portal/src/components/ui.tsx) |
| Sidebar and app frame | [web/portal/src/components/AppShell.tsx](../../web/portal/src/components/AppShell.tsx) |
| One screen per file | `web/portal/src/screens/` |
| Fonts (Inter Tight, JetBrains Mono) | self-hosted via `@fontsource`, imported in `src/main.tsx` — no CDN at runtime |

## Deviations from the handoff, and why

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

## Still not designed

Carried over from the handoff and still true: loading state during provisioning, error states
(token rejected, capacity, payment declined), form validation, empty states, hover states, and
**responsive behaviour** — the design is desktop-first and fixed-width (236px sidebar, 1280px
main, 560px modal). Below ~1100px it degrades. The repo's other two web surfaces are
phone-first, so this is worth settling before a customer sees it.

## Checking a change against the design

```bash
npm run portal:dev        # hot-reload dev server
npm run portal:build      # production build into web/portal/dist
npm run portal:standalone # one self-contained HTML file, for sharing
```

Contrast is a gate worth re-running by hand after any colour change — the audit that caught
the faults above walks every text node, resolves the rendered colour through a canvas (needed:
`getComputedStyle` returns `oklch()` here, which naive parsing gets wrong), finds the first
opaque ancestor background, and checks against WCAG AA.
