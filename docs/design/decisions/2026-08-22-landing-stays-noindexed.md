# The landing stays `noindex` until it has a domain of its own

**Date:** 2026-08-22 · **Status:** accepted · **Scope:** `web/portal/index.html` robots meta

## Decision

Keep `<meta name="robots" content="noindex, nofollow">` on the portal shell. Revisit when the
landing is served at the root of a domain we own.

## Why the old reason was wrong

The comment carrying this tag was written on 2026-08-10 (`8b44825`), when `web/portal/` was purely
the **customer account portal** and the landing was just the door you signed in from. It said
nothing here should be indexed because "every real page sits behind sign-in and the marketing site
lives elsewhere."

Both halves have since stopped being true, and nobody revisited the tag when they did:

- **The shell is served unauthenticated, deliberately.**
  [`src/portal/portalApi.ts`](../../../src/portal/portalApi.ts) serves it to anyone — it carries no
  data, only the markup that then asks for a session (the `/admin` and `/board` precedent). Only
  `/portal/api/*` checks auth. The landing is reachable by the public.
- **The landing *is* our public marketing page**, as of 2026-08-21 (`e276d11`). Root
  [`DESIGN.md`](../../../DESIGN.md) governs it and
  [`2026-08-21-landing-direction.md`](2026-08-21-landing-direction.md) scopes itself to "public
  landing page only". No other marketing site exists in this repo or its docs.

## Why we keep the tag anyway

**The URL, not the page.** The only place the landing is reachable is
`tradesdatabase.onrender.com/portal` — a sub-path on a Render subdomain. Letting search engines
rank that means inheriting a URL we would have to redirect away from the moment we have a real
domain, handing back whatever ranking it earned. Staying unindexed at a throwaway URL costs us
nothing today.

## What this does *not* block

`noindex` stops search indexing; it does not stop link unfurling. The `og:` tags added in
`750e2e6` work right now in Slack, iMessage and email previews. Only the `<title>` and
`<meta name="description">` are waiting on the tag being dropped.

## When to revisit

When the landing is served at the root of a domain we own. Drop the `noindex` at that point — the
title and description are already written and start working immediately.

Note that the tag lives on the **shared SPA shell**, so it currently covers the signed-in screens
too. Those should stay unindexed regardless; if the landing ever moves to its own entry point,
give the app shell its own `noindex` rather than dropping it wholesale.
