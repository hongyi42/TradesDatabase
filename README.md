# TradesDatabase

One customer/job record that every role in a small trades firm reads from and writes to — so
context is captured once and never re-typed.

Our customers are HVAC, plumbing, electrical, pest control and roofing firms of roughly 5–50
people. A job passes through a relay of humans:

```
customer → front desk (CSR) → manager / dispatcher → technician → back to the office → (sales)
```

Every handoff loses information. We replace the relay with a shared record, and put AI features on
top of it that are only possible *because* the record exists: brief a technician before a visit,
answer a question on site, schedule a week, re-optimize it when reality changes.

**Two things to internalize early:**

1. **The UI is Telegram.** Managers and technicians talk to an AI agent in a Telegram DM. There is
   no customer-facing web app and none is planned. The deliberate exceptions are a Telegram Mini
   App for dispatch ("the board"), an operator-only `/admin` cost page, and the `/portal` customer
   billing site.
2. **This is a pilot, not a launched product.** The pilot database carries two tenants — a shared
   demo tenant and one real beta customer — on a single Lightsail box. Much of what looks like
   over-engineering is scar tissue from specific incidents, and the incidents are all written down.

---

## Start here

**New to the repo? Read [docs/onboarding.md](docs/onboarding.md).** It is the map: what we're
building, how the pieces fit, day-1 setup, and the rules that cost us incidents. This README is
just the front door.

Then, in order:

1. [docs/Three-Layer-Context-Spine-Overview.md](docs/Three-Layer-Context-Spine-Overview.md) — the product's core idea
2. [CLAUDE.md](CLAUDE.md) — the hard rules (and the file Claude Code reads automatically)
3. [docs/engineering-memory.md](docs/engineering-memory.md) — everything that isn't in the code

## The core idea: the three-layer context spine

A single customer/job record, split into three layers, where every structured field links back to
the raw evidence it came from:

| Layer | What it is |
|---|---|
| **L1 raw** | `raw_captures` — append-only, verbatim capture. Never updated, never deleted. |
| **L2 structured** | `customers ─(1:N)─ jobs ─(1:N)─ visits` |
| **L3 attributes** | an `attributes` JSONB column on each L2 row |

## Local setup

Needs Docker running.

```bash
npm install
npx supabase start
cp .env.test.example .env.test   # fill from what `supabase start` printed
npm run seed:local
```

If `migration up` complains about out-of-order migrations, add `--include-all` — that is expected,
not a broken checkout. [docs/onboarding.md §8](docs/onboarding.md) explains why, along with the
other day-1 surprises.

## Verification gates

Run the relevant ones after every change, **all four before any commit**, and show the real output
— never assert success without it.

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Tests run **only** against the local Supabase stack; `src/testEnvGuard.ts` refuses to start the
suite against any non-local URL. The hosted "test" project is the deployed pilot's live database.

## Layout

```
src/         application code — see docs/onboarding.md §5 for the per-module map
  db/          ALL database access. Typed layer over Supabase; never hand-write a query elsewhere.
  mcp/         the MCP server: tool definitions, HTTP entry, HMAC identity
  writePath/   raw → structured extraction
  synthesis/   briefings, question answering, citation grounding
  schedule/    booking verbs, availability, the fit engine and solvers
  telegram/    the Mini App board API and notification worker
web/         three separate front ends, each served by its own module in src/
  admin/       operator cost dashboard      → src/admin/adminApi.ts
  board/       Telegram Mini App (dispatch) → src/telegram/boardApi.ts
  portal/      customer billing portal + marketing landing (React + Vite)
               → src/portal/portalApi.ts
supabase/    migrations — the schema's source of truth
scripts/     operator scripts: seeding, host assignment, Composio helpers
docs/        onboarding, the overview, engineering memory, runbooks, design material
thoughts/    research + plan artifacts, one per feature, dated. The decision history.
Box_Setup_Stuff/   host-side files for trades-box-1. NOT documentation.
.claude/     skills and slash commands for the RPI workflow
```

**Conventions:** TypeScript, ESM (`"type":"module"`, `NodeNext`) — relative imports need explicit
`.js` extensions even in `.ts` files. Tests live beside their code as `*.test.ts`. Comments in this
codebase are dense and explain *why*; match that. Read a file's header comment before editing it.

## Design

- **[DESIGN.md](DESIGN.md)** — the marketing landing page. IBM Carbon, adapted.
- **[docs/design/](docs/design/)** — the signed-in app's system (a different one, on purpose),
  plus decision records and source material.

## How we work

Non-trivial features go through Research → Plan → Implement:

```
/research <area>          # read-only; writes to thoughts/shared/research/
/plan <research-path>     # read-only; writes to thoughts/shared/plans/
/implement <plan-path>    # executes the approved plan phase by phase
```

The plan is the human-review gate — approve it before running `/implement`, not the code diff.
