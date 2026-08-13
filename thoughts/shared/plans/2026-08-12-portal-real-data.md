# Portal on real data — sign-in and tenant-scoped reads (2026-08-12)

**Supersedes Phases 1–3 of** [2026-08-07-customer-billing-portal.md](2026-08-07-customer-billing-portal.md)
**for scope and framework only.** That plan's decision briefs (D1–D7), architecture and Phases
4–7 still stand; this document replaces the parts that went stale and narrows the near-term scope.

## What changed since 2026-08-07

| Then | Now |
|---|---|
| Phase 2: `web/portal/{index.html,portal.css,portal.js}`, "no framework, no build step" | **React + Vite** (owner overrode the recommendation). Seven screens exist and are built. |
| Landing page unresolved | Rebuilt against `docs/design/handoff-landing-v2/`, shipped, verified |
| Billing was the spine of Phases 1–3 | **Billing descoped by the owner (2026-08-12).** No Stripe account, no key, no `stripe` package. |
| Portal was a design | Portal is a working prototype on `web/portal/src/data/mock.ts` |

**The near-term product is therefore a roster/seats console on real data, not a billing portal.**
The Billing screen stays on mock data and must say so on its face — see Phase 3.

## The problem, in one sentence

Everything the portal shows is invented in `mock.ts`; a real manager cannot sign in, and if they
could, nothing would scope what they see to their own firm.

## Decision brief

### D1 — How does a customer authenticate?

The repo has **no browser identity model at all**. It has two unrelated things, neither reusable:

- **Doorman badges** — HMAC-signed headers (`x-tenant-id` + `x-identity-signature`) issued to
  *sandboxes*. Machine-to-machine. A browser can't hold one, and the skill is explicit that no
  signed header or secret may ever live outside the host.
- **`/admin`** — one shared bearer token, no per-person identity, because there is no operator
  identity system to hang it on.

| Option | Trade-off |
|---|---|
| **Supabase Auth magic link** ✅ | Already paid for and running in the stack (`supabase_auth` container is up). No password custody — which the repo deliberately does not have anywhere. Costs: a wholly new subsystem, currently **unused** — no migration references `auth.users`. |
| Shared token like `/admin` | Trivial, and wrong. Customers are not operators; one token across firms is a cross-tenant leak by construction. |
| Password auth | Credential custody this system does not have. Already rejected once (design README deviation 10). |

**Recommend: Supabase Auth magic link, server-side session cookie.** Password stays unbuilt.

### D2 — How does an authenticated email become exactly one tenant?

`technicians` has no login email (`connected_email` is the Composio Gmail binding — a different
fact, and null for most rows). Nothing maps a person who signs in to a firm.

**Recommend a new `portal_accounts` table** — `tenant_id`, `email` (citext, unique), `auth_user_id`
(→ `auth.users.id`), `role`, `invited_at`, `last_seen_at`. This is the 2026-08-07 plan's
`billing_contacts` with the billing framing removed and the same reasoning intact: the person who
administers the account is often not a dispatcher, so it must not be a column on `technicians`.

**Invite-only** (settled 2026-08-07). No self-serve signup: a sign-in attempt from an email with no
`portal_accounts` row must fail closed and reveal nothing about whether the address exists.

### D3 — Where does tenant scoping actually get enforced?

This is the security core, and the honest answer today is uncomfortable: per the `data-security`
skill, **isolation rests entirely on a hand-written `.eq('tenant_id', …)` in each accessor — RLS is
off and the app runs as `service_role`, which bypasses RLS anyway.** That has been survivable
because every existing surface is machine-to-machine or operator-only. **The portal is the first
surface outsiders use**, so one forgotten filter becomes a customer reading another firm's roster.

**Recommend defence in depth, all three:**

1. **One choke point.** Every `/portal/api/*` handler receives a resolved `tenantId` from the
   session and may only call accessors in a new `src/portal/queries.ts` that *takes `tenantId` as
   its first argument*. No handler touches `src/db/` directly.
2. **RLS on the new table** with no policy, matching the cost tables (`20260725140000`), so the
   publishable anon key cannot route around the handler straight to PostgREST.
3. **A two-tenant leak test** is the phase's exit gate, not a nicety — seed two tenants, assert
   every endpoint returns zero rows belonging to the other.

### D3a — MEASURED 2026-08-12: the anon key already reads the roster cross-tenant

Probed against the local stack with the real publishable ("anon") key, after Phase 1 landed:

| Table | anon `GET` | Result |
|---|---|---|
| `technicians` | **HTTP 200** | 4 rows spanning **2 distinct tenants** — full cross-tenant roster read |
| `customers` | **HTTP 200** | rows returned |
| `tenants` | **HTTP 200** | rows returned |
| `cost_events` | 401 | closed by `20260725140000` |
| `portal_accounts` | 401 | closed by this phase |

An anon `POST` to `technicians` was rejected with **23503 — a foreign-key error, not a permission
error**, meaning the insert was *authorised* and only failed because the fake `tenant_id` did not
exist. With a real tenant id it would have written.

**Mitigating fact, verified:** the anon key is not shipped anywhere — absent from `.env`,
`.env.example`, `web/`, and the built portal bundle; `src/db/client.ts` uses the service-role key
exclusively. This is the same latent-not-live posture the cost-tables migration recorded.

**THE HARD CONSTRAINT THIS PUTS ON PHASE 2.** The obvious way to build magic-link auth is a
Supabase client in the browser, which requires publishing the anon key. Doing that here would turn
the latent exposure above into a live one: every firm's roster and customers readable, and the
roster writable, by anyone who opens devtools. Therefore:

> **The anon key must never reach the browser. All Supabase Auth calls are server-side, from
> `/portal/api/*`, using the service-role key that already lives on the server. The browser gets a
> session cookie and nothing else.**

This is a design constraint, not a preference. Closing `technicians` / `customers` / `tenants` to
anon is the right follow-up (service_role bypasses RLS, so the app would not notice), but it is a
migration against core tables and is **out of scope for this plan** — raise it separately.

### D4 — What happens to the Admin queue screen?

`AdminQueue.tsx` is a **cross-tenant operator surface reachable from the same shell customers use**
(flagged as blocking in the 2026-08-10 handoff). Shipping sign-in without addressing it means a
customer session renders an operator nav item.

**Recommend: the nav item and route are omitted server-side for customer sessions** — not hidden
with CSS, not gated in React. The session's role decides whether the endpoint exists at all.

### D5 — What do we do about the Billing screen with no Stripe?

**Recommend: leave it on mock data and label it.** The alternative — deriving an invoice figure
from `manager_seats × $80 + technician_seats × $50` — invents a number that is not what anyone will
be charged, on a screen whose entire purpose is telling someone what they owe. A visible
"not yet connected" state is honest; a plausible wrong number is not.

## Architecture

```
  browser
    │  POST /portal/api/auth/request-link   { email }
    │        │  always 204, even for an unknown address  ← no account enumeration
    │        ▼
    │  Supabase Auth ──▶ emails a one-time link
    │
    │  GET /portal/api/auth/callback?token=…
    │        │  verify with Supabase ──▶ auth_user_id
    │        │  portal_accounts lookup ──▶ EXACTLY ONE tenant_id  (else 403, fail closed)
    │        ▼
    │  Set-Cookie: session=…  HttpOnly; Secure; SameSite=Lax
    ▼
  GET /portal/api/summary        ─┐
  GET /portal/api/seats           ├─ every one resolves session → tenantId,
  GET /portal/api/seats/:ref      │  then calls src/portal/queries.ts (tenantId, …)
  GET /portal/api/exports        ─┘  cache-control: no-store
                                        │
                                        ▼
                          src/db/  (typed accessors, service_role)
```

**Invariant:** no `/portal/api/*` handler may read a tenant id from a query parameter, path segment,
or request body. Session only. This is the one rule that, if broken, makes everything else theatre.

## What the UI needs, and where it really lives

Checked against `src/db/database.types.ts` — the mock model was written schema-shaped, so this
maps almost 1:1 and needs no migration beyond `portal_accounts`:

| `Seat` field (UI) | Real source |
|---|---|
| `ref`, `name`, `tier`, `state`, `seatExempt` | `technicians.ref` / `display_name` / `tier` / `state` / `seat_exempt` |
| `trade` | `technicians.skills[]` |
| `telegramUserId`, `sandboxRef` | `technicians.telegram_user_id` / `sandbox_ref` |
| `botUsername` | `sandbox_pool.bot_username`, joined on `technician_id` |
| purchased seats per tier | `tenants.manager_seats` / `technician_seats` |
| `seatSince` | `technicians.created_at` |

`technician_state` is already exactly the UI's five states — no projection change needed.
**PostgREST embeds do not inherit tenancy**: the `sandbox_pool` join must carry its own
`tenant_id` filter, not rely on the parent's.

## Phases

Each phase ends green on `npm run typecheck && npm run lint && npm test`, against the **local**
Supabase stack only — `testEnvGuard` enforces it, and the hosted "test" project is the live pilot DB.

### Phase 1 — `portal_accounts` + the query choke point
- Migration: `portal_accounts` per D2; RLS enabled, no policy.
- `src/db/portalAccounts.ts` — typed accessors, tenant-scoped.
- `src/portal/queries.ts` — every function takes `tenantId` first. Nothing else in the portal path
  may import from `src/db/` directly.
- `npm run gen:types:local` regenerated.

**Verify:** schema test that RLS is on; a test that a `portal_accounts` insert with a duplicate
email for a second tenant is rejected.

### Phase 2 — Sign-in
- `POST /portal/api/auth/request-link`, `GET /portal/api/auth/callback`, `POST /portal/api/auth/signout`.
- Server-side session cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, short expiry, rotating on sign-in.
- Unset Supabase Auth config → **503, never open** (the `/admin` precedent).
- Unknown email → 204 and no mail. Known email, no `portal_accounts` row → 204 and no mail.

**Verify:** unauthenticated `/portal/api/*` → 401; expired/forged cookie → 401; account enumeration
test (unknown vs known address are indistinguishable in status, body and timing class).

### Phase 3 — Real reads behind the session
- `GET /portal/api/summary` — seats purchased/used per tier, member counts.
- `GET /portal/api/seats`, `GET /portal/api/seats/:ref`.
- `web/portal/src/data/mock.ts` retired for these screens; Billing keeps mock **and gains a visible
  "not connected to billing yet" state** (D5).
- Admin queue omitted server-side for customer sessions (D4).

**Verify (the exit gate):** the **two-tenant leak test** — seed tenants A and B, sign in as A, and
assert every endpoint returns zero B rows, including the `sandbox_pool` join. A missing tenant
filter must fail a test, not reach production.

### Phase 4 — Onward (unchanged from 2026-08-07)
Seat purchase/release, managed bots, box provisioning, export. **All still gated on Phase 0** of the
original plan, which remains unrun: the Telegram managed-bot cap and real box capacity (**one free
blank left**). Nothing here sells or provisions a seat, so Phase 0 does not block Phases 1–3.

## Out of scope (deliberate)

Stripe and every billing figure (owner, 2026-08-12); self-serve tenant signup (invite-only);
password auth; seat purchase and release; managed-bot creation; box provisioning; data export;
any change to the landing page or the signed-in app's visual design.

## Open questions for the owner

1. **Who gets the first `portal_accounts` row?** Real pilot tenants exist. Seeding a live account
   means a real person can sign in to real data — that is a production change, not a dev one.
2. **Email delivery.** Supabase Auth sends magic links via its own SMTP by default, which is
   rate-limited and lands in spam on custom domains. Do we point it at a real sender?
3. **Session lifetime.** A trades manager on a phone will not want a 1-hour expiry; a shared
   van tablet argues the other way.
