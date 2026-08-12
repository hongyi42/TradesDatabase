# Current state of the landing page — 2026-08-10

What the page looks like **today**, to send alongside
[../landing-redesign-brief.md](../landing-redesign-brief.md).

This is the version that was rejected. It is here as an **anti-reference** — "this is what we
have, don't do this again" — not as a starting point.

| File | What it is |
|---|---|
| `02-landing-desktop-fold.png` | What you see first, 1440px. Start here. |
| `01-landing-desktop-full.png` | The whole page top to bottom, 1440px. |
| `03-landing-mobile-390.png` | iPhone width. **Broken — see below.** |
| `tradesdatabase-landing-current.html` | The real page as one self-contained file. Double-click to open; no server, no install, works offline. |

All captures are at 2× device pixel ratio.

## Known-broken, no need to report back

**Mobile has never been designed.** The screenshot at 390px shows the nav overlapping the logo,
the headline breaking to seven lines, and the video, stat band and phone mockup all overflowing
the viewport. The page is fixed-width desktop-first throughout. Mobile is part of what we are
asking for, not a bug to flag.

**The video is a placeholder.** No product video exists yet. The dark 16:9 box with a play
button is a stand-in and needs a designed empty state.

**The three dashed boxes are photo slots.** We have no photo library. Part of the ask is a point
of view on what to shoot and what to do until we have it.

## What is deliberate and should survive a redesign

- Amber is the brand accent; teal means healthy/settled. There is **no green** in the system.
- Mono type is only ever used for machine-generated values — IDs, bot handles, timestamps.
- Both seat prices are shown **separately**, never averaged into one figure.
- Nav is Product / Pricing / Contact / Sign in. There is no docs site.
