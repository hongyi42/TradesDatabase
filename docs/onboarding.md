# Onboarding guide — TradesDatabase

**Who this is for:** a new engineer joining this repo, on day one, with no prior context.
**How long:** ~2 hours to read, ~1 hour to get a local stack running.
**What it is not:** the source of truth. It is the *map*. Every section points at the file that
owns the detail, and those files win when they disagree with this one.

> **Heads-up about `README.md`:** the file at the repo root is **not** a project README — it
> documents a portable export of our Research→Plan→Implement workflow for *other* repos. Don't
> read it looking for this project. This file is the entry point.

**Reading order after this guide:**

1. [Three-Layer-Context-Spine-Overview.md](Three-Layer-Context-Spine-Overview.md) — the product's core idea
2. [`CLAUDE.md`](../CLAUDE.md) at the repo root — the hard rules
3. [engineering-memory.md](engineering-memory.md) — everything that isn't in the code (long; skim, then return)
4. The runbooks: [doorman-runbook.md](doorman-runbook.md), [control-plane.md](control-plane.md), [nemoclaw-tech-agent.md](nemoclaw-tech-agent.md), and `Box_Setup_Stuff/`

---

## 1. What we're building, in one page

Our customers are **small trades firms** — HVAC, plumbing, electrical, pest control, roofing,
roughly 5–50 people. A job passes through a relay of humans:

```
customer → front desk (CSR) → manager / dispatcher → technician → back to the office → (sales)
```

At every handoff, information gets re-typed, summarized, or lost. Two costs fall out:

- **Wasted time** — usually the manager's whole day, hand-routing information between phone,
  calendar, email, and sticky notes.
- **Context loss** — facts degrade between people, between the two visits of one job, and across
  months for a repeat customer.

**We build one customer/job record that every role reads from and writes to**, so context is
captured once and never re-typed. On top of that record sit AI features that only become possible
*because* the record exists: brief a technician before a visit, answer a question on site,
schedule a whole week, re-optimize it when reality changes.

Two things make us unusual and you should internalize both early:

1. **The UI is Telegram.** There is no web front end for customers of the product, and none is
   planned. Managers and technicians talk to an AI agent in a Telegram DM. The one deliberate
   exception is a Telegram **Mini App** ("the board") for dispatch. (There *is* an internal
   `/admin` cost page — that's for us, the operators, not for them.)
2. **We are a pilot, not a launched product.** One real external beta tenant, a handful of test
   tenants, running on one Lightsail box. Much of what looks like over-engineering in this repo is
   scar tissue from a specific incident — the incidents are all written down.

**Timeline for context:** first commit 2026-06-19. ~82 merged PRs, 59 test files, ~891 tests as of
the last recorded full run (2026-07-30). Four contributors.

---

## 2. The core idea: the three-layer context spine

This is the concept the whole repo is organized around. Learn it first; everything else is
downstream.

A single customer/job record, split into three layers **by how certain and how structured the data
is**:

| Layer | Name | Holds | Physically |
|---|---|---|---|
| **L1** | **Raw** | Verbatim, append-only capture — voice notes, emails, transcripts, photos. Lossless ground truth. | `raw_captures` table |
| **L2** | **Structured** | The typed fields the business acts on — name, address, job type, status, price. | `customers` → `jobs` → `visits` tables |
| **L3** | **Attributes** | The long tail: "dog on property", "prefers afternoons", "gate code 1234". | An `attributes` JSONB column on each L2 row |

```
customers ──(1:N)── jobs ──(1:N)── visits
   │                  │              │
   └── each L2 row carries an `attributes` JSONB column  ← L3
                      │
raw_captures (L1) ────┘   every capture links back to the customer/job/visit it informed,
                          and every L2 row carries `source_capture_id` back to its evidence
```

**The guiding principle:**

> Structure only what you must act on deterministically (L2). Preserve everything else verbatim
> (L1). Capture the in-between in flexible attributes (L3). And **link every structured field back
> to the raw evidence it came from.**

Why this split earns its keep:

- **L1 is a safety net.** Because the original is preserved, a bad AI extraction can be re-run
  later with a better prompt or a better model, with zero data loss. You are never locked into
  your first interpretation.
- **L1 is queryable ground truth.** A tech on site can ask "what did the last guy actually say?"
  and get the verbatim note, not a lossy summary.
- **L2 stays clean.** Only fields that business logic, pricing, and scheduling truly depend on
  become columns.
- **L3 absorbs the long tail** without a schema change per customer quirk.

A fact graduates from L3 to a real L2 column only when someone needs to **query across** it.

### Hardcode vs. let-the-model-decide

A rule of thumb that runs through the entire codebase:

- **Hardcode what must be correct and auditable:** the schema, **identity matching** (which
  existing customer/job does this capture belong to?), permission boundaries, pricing math,
  scheduling guards.
- **Let the model interpret:** extracting fields from a transcript, summarizing history, drafting
  a narrative, answering a question.

Identity matching in particular is deterministic code ([src/writePath/identityMatch.ts](../src/writePath/identityMatch.ts)),
never a model guess — it is what turns a pile of captures into a coherent longitudinal record.

---

## 3. System architecture — how the pieces fit

```
 Manager / technician phones
      │ Telegram DMs (one bot per person)        Telegram Mini App (the board)
      ▼                                                   ▼
 trades-box-1 — AWS Lightsail, static IP, `ssh tradesbox`
   per-person OpenClaw sandboxes (s2, s3, s5, s7, s8 …)
      │  each sandbox holds ONE revocable badge — never a real secret
      ▼
   doorman (host process, OUTSIDE the sandboxes; badge → identity)
      │  HTTPS + HMAC identity headers (x-tenant-id / x-technician-ref / x-identity-signature)
      ▼
 Render (tradesdatabase.onrender.com)
   ├─ spine MCP server (src/mcp/server.ts)  ──►  Supabase "test" project = THE PILOT LIVE DB
   ├─ /composio relay                       ──►  per-person Composio session (Gmail, Sheets, …)
   ├─ board web + background worker (global bot @DashboardMan_bot)
   ├─ /admin operator cost dashboard
   └─ cron heartbeat every 15 min (badge lifecycle, pairing sweep, grace expiry, cost rollup)
 Inference: sandbox gateway ──► DeepInfra GLM-5.2 (automatic failover: NVIDIA)
```

Read that top to bottom as the path of one message:

1. A technician sends a Telegram voice note. The bridge transcribes it.
2. The **agent** in that person's sandbox decides which of our tools to call. The agent is a
   *channel and collector*; it never touches the database.
3. The tool call leaves the sandbox carrying only a **badge** — a random token that means nothing
   to anyone but the doorman.
4. The **doorman** (on the host, outside the sandbox) maps badge → `{tenantId, technicianRef}`,
   computes an HMAC signature, and forwards to Render with three real identity headers.
5. Our **MCP server** on Render verifies the signature, resolves the identity *from the header,
   never from a tool argument*, and does the real work: append to L1 → model-extract → identity
   match → write L2/L3 with provenance.

### Why the doorman exists (the one piece that confuses everyone)

The MCP server demands a *computed, signed* identity per request. OpenClaw (the agent runtime) can
only send *static strings baked into a config file*. Bridging that directly is unsafe both ways:
bake signed headers into the sandbox and you've put a permanent forgeable credential in untrusted
space; put the master secret in the sandbox and any tenant can be impersonated.

The doorman is the translator: **static badge in → signed identity out.** The badge is
individually revocable and useless if stolen (only the doorman accepts it). Full detail and the
load-bearing invariants: [doorman-runbook.md](doorman-runbook.md).

### MCP, briefly

**MCP** (Model Context Protocol) is the standard by which an AI agent discovers and calls tools.
Our server exposes ~39 tools. Two deployment shapes exist in the repo:

- **stdio** (`npm run mcp:serve`) — one server per sandbox, identity pinned by env var. Dev/local.
- **HTTP** (`npm run mcp:serve:http`) — one shared, **stateless** server every bot calls; identity
  arrives per request in the signed header. This is what runs on Render, and it's stateless so it
  scales horizontally (the stage→confirm flows key off a DB-persisted token, not a session).

---

## 4. Key features — the tour

### 4a. The write path (spine capture)

`record_field_note` is the flagship. A technician says something; we:

L1 append (verbatim, with `external_id` for dedup) → model **extract** structured fields →
**identity match** (deterministic) → write/update L2 + L3 with `source_capture_id` provenance.

Two-step confirm: ambiguous identity stages a preview and asks. What the preview showed is exactly
what the commit does — the resolution travels with the token, so a commit never re-matches.

Related: `retract_capture` (L1 can't be deleted, so a retraction is a *new* row that folds the old
one out of reads), `record_standing_fact` (L3 facts wrapped with the capture that evidences them —
retract the evidence, the fact disappears from default reads).

### 4b. Inbound channels

- **Email** via Composio webhooks (`src/inbound/webhook.ts`) — HMAC-verified, normalized, and
  **classified work-vs-personal *before* the L1 insert** (see §7, rule 1).
- Channel enum already covers phone calls, web forms, SMS, chat, sales notes, quotes, CRM import,
  accounting events, IoT — the write path is deliberately channel-agnostic.

### 4c. The read/synthesis layer

`brief_customer` (pre-visit cheat sheet, or full relationship history), `answer_customer_question`,
`get_customer_context`. All grounded: every claim carries a **citation** back to an L1 capture, and
citations are validated ([src/synthesis/grounding.ts](../src/synthesis/grounding.ts)) — the model
cannot cite evidence that doesn't exist.

### 4d. Scheduling — the biggest subsystem

The database owns the schedule (`assignments` table). A Google Sheet used to be an input; it isn't
anymore.

**The promise ladder** is the central concept. It records *what the customer was told*:

| Level | Meaning | What may move |
|---|---|---|
| `none` | nothing promised | anything |
| `day` | promised a day | the time, within that day |
| `time_only` | promised a time but not the day | the day, keeping the time |
| `time` | promised a day **and** time | nothing (immovable) |

This is the human-facing constraint vocabulary and it drives the **confirmation doctrine**:

> Confirm only what's irreversible or externally visible; everything reversible, just do — and say
> what you did.

Over-confirming is treated as a *safety* problem, because it trains people to rubber-stamp. That
rule is single-sourced as `requiresConfirmation` on tool previews in
[src/schedule/booking.ts](../src/schedule/booking.ts) — new surfaces inherit it, never re-derive it.

The scheduling verbs, in rough order of depth:

- `book_visit` / `move_visit` / `unschedule_visit` / `cancel_job` — the deterministic one-visit
  verbs. **Every surface calls these** (chat, board, solver). One write path, one guard set.
- `find_slots` — the fit engine ([src/schedule/fit.ts](../src/schedule/fit.ts)): pure gap math and
  candidate scoring, no clock (`today`/`now` are inputs, so everything is fake-clock testable).
  Feasibility is a **tool verdict, never the model's opinion** — every emitted slot must be
  bookable verbatim.
- `run_freeze` — the weekly ritual. Calls Google Route Optimization to place the loose queues
  across the team's week, stages a proposal, and **stops**. The manager's "yes" in chat is the only
  commit path. ([src/schedule/freezeSolve.ts](../src/schedule/freezeSolve.ts))
- `run_resolve` — the freeze's sibling: a horizon-wide re-optimizer where every *unpinned* visit is
  movable and the promise level sets its degree of freedom. Displacement is priced, so the solver
  prefers cheap same-day shuffles over day hops.
- `undo_run` — restore the last batch run. **No solver.** The run-stamped event ledger plus the
  cancelled predecessor rows *are* the memory (every move cancels + remints a row, so each prior
  state still exists).
- `set_visit_locks` — pinning. Pinning is a **human privilege**: the verbs never auto-pin.

A **schedule read renders the booked order; it never re-derives one.** Reads return stops in booked
(time) order with a per-stop Maps link. Deciding order means *moving* visits, which is
freeze/resolve's job and requires a human yes.

### 4e. The dispatch board (Telegram Mini App)

`web/board/` + [src/telegram/boardApi.ts](../src/telegram/boardApi.ts) + a background worker. Day
grid, loose-bucket tray, job sheets, quick edits, freeze/resolve proposal view, push notifications
(digested — a freeze commit used to machine-gun one push per visit).

Non-negotiable guardrail: **every board gesture calls the same `src/schedule/booking.ts` verbs as
chat.** Never a parallel editing path.

Auth: Telegram `initData` signature verification → roster lookup of the verified Telegram user id.
Tenant isolation comes from the roster lookup, not from which bot you talked to.

### 4f. Control plane — people lifecycle

The `technicians` roster drives the real world: badges to hosts, Composio Gmail pairings, grace
-period offboarding.

```
add_technician_seat        get_connect_link           resolve_review
      ▼                          ▼                          ▼
   INVITED ──────────▶ PENDING_VERIFICATION ──────────▶ ACTIVE
                                                          │ deactivate_technician_seat
                                                          ▼
                          grace period (7d default)   OFFBOARDING ──▶ reactivate (the undo)
                                                          │
                                                          ▼
                                                     OFFBOARDED (permanent; ref NEVER reused)
```

Two access tiers: **manager** (39 tools; full Composio catalog; self-serve pairing) and
**technician** (14 tools; curated Composio list; email sends must go through the spine's two-step
`send_email`, never `GMAIL_SEND_EMAIL`). Seat-based licensing: a firm buys N seats and adding a
person needs a free one — enforced server-side, never trusted to the agent. Details:
[control-plane.md](control-plane.md).

### 4g. Cost tracking (operator-only)

Records what every tenant costs us in vendor spend, shown at `/admin`.

**The load-bearing rule: `cost_events` stores UNITS, never dollars.** Prices live in `cost_rates`,
versioned by effective date, joined at read time — so history re-prices when a vendor moves its
rates (DeepInfra changed $0.95 → $0.93 *during the three days this feature was being planned*).

```
cost_events (units, never $)         cost_rates (prices, versioned by date)
 tenant · provider · sku · qty  ──join at READ time──►  dollars
 method: measured | allocated                              │
infra_costs (monthly bills + allocation rule) ─────────────┘
                       │
                       ▼
              cost_rollup_monthly   ← the ONLY thing /admin reads
```

`method` (`measured` vs `allocated`) must be visible on every read surface, so an estimate never
renders like a metered fact.

### 4h. Web tools

`web_search` (Brave, metered) and `read_webpage` — hardened fetch, and the requests are logged to
`web_requests` which the cost backfill replays into the ledger.

---

## 5. The codebase map

```
src/
  db/           ← ALL database access. Typed layer over Supabase. Never hand-write a query elsewhere.
                  index.ts re-exports everything; database.types.ts is generated.
  mcp/          ← the MCP server: server.ts (tool definitions + dispatch), httpServer.ts (Render
                  entry, routes /inbound /control /board /admin /composio + MCP), identity.ts (HMAC)
  writePath/    ← raw → structured: extract.ts (model), identityMatch.ts (deterministic),
                  recordFieldNote.ts (the orchestrator)
  synthesis/    ← briefings, question answering, citation grounding
  schedule/     ← booking verbs, availability, fit engine, freeze/resolve solvers, undo, policy
  telegram/     ← the Mini App board API, initData verification, notification worker, roster cache
  admin/        ← the operator cost dashboard API
  composio/     ← connector integration: pairing, sessions, outbound sends, the doorman relay,
                  execution-log ingestion, offboarding
  inbound/      ← webhook receipt + per-source normalizers (Gmail)
  email/        ← work-vs-personal classifier, ingest, formatting
  routes/       ← Google Routes / Geocoding clients, Maps deep links, day source
  control/      ← badge minting, the badge file, the host pull script
  model/        ← forcedTool.ts: ONE transport for all four model calls; usage metering
  jobs/         ← lifecycle.ts, the Render cron heartbeat
web/            ← static assets for the board Mini App and the /admin dashboard
supabase/       ← migrations (the schema's source of truth)
scripts/        ← operator scripts: seeding, host assignment, Composio helpers, second-stack.sh
docs/           ← this file, the overview, engineering memory, runbooks
thoughts/       ← research + plan artifacts, one per feature, dated. The decision history.
Box_Setup_Stuff/← host-side files for trades-box-1. NOT documentation — see §7 rule 8.
.claude/        ← skills and slash commands for the RPI workflow
```

**Conventions:** TypeScript, ESM (`"type":"module"`, `NodeNext`) — relative imports need explicit
`.js` extensions even in `.ts` files. Tests live next to their code as `*.test.ts`.

**Code style note:** the comments in this codebase are unusually dense and frequently explain
*why*, cite vendor doc URLs, or name the incident that caused a guard. That is deliberate and you
should match it. Read the header comment of any file before editing it — it usually tells you the
one thing that will bite you.

---

## 6. Environments — read this before you touch anything

There are **three** Supabase environments and their names are actively misleading:

| Env | Ref | What it actually is |
|---|---|---|
| `supabase-prod` (MCP) | `lzlgysoydhknsdvovntz` | **Empty.** Factory-fresh, read-only, auto-pauses. Not real data. |
| `supabase-test` (MCP) | `daqapdlkgxfrhquacprv` | **Despite the name — the deployed pilot's LIVE database.** Render and the box read it. Its `raw_captures` holds real customer mail, which is unrecoverable. |
| Local Docker stack | `npx supabase start` | The **only** writable test environment. |

**`npm test` is hard-pinned to the local stack** by [src/testEnvGuard.ts](../src/testEnvGuard.ts),
which refuses to start against any non-loopback host. That guard exists because on 2026-07-03 a
test run truncated the pilot's roster and locked a technician out of their job. Do not weaken it,
do not work around it, and don't run a loopback tunnel to a remote DB on 127.0.0.1.

Also: `npm run gen:types` uses `--linked`, which points at **the pilot**. Locally you almost always
want `npm run gen:types:local`.

---

## 7. The rules you must not break

These are non-negotiable. Each one is either in `CLAUDE.md` or was written in blood.

1. **L1 is append-only.** Insert only — never update, never delete (a DB trigger enforces it too).
   Because there is no delete path, **any filtering or classification must gate the L1 insert — run
   it *before* writing, never after.** Two recorded exceptions, both deliberate: mail arriving
   during a `pending_verification` window is ingested (and stamped for forensics), and
   **outbound/agent-action captures are classifier-free** — the audit record matters most exactly
   when the action was inappropriate. Non-send captures store argument **key names only**, never
   values.
2. **All database access goes through `src/db/`.** No hand-written Supabase queries anywhere else.
3. **Tests only ever run against the local stack.** See §6.
4. **Every code change goes through a PR before `main`.** "You may commit" authorizes a commit, not
   a push. Doc-only carve-out: markdown-only diffs (`docs/`, `thoughts/`, READMEs) may commit and
   push on `main` directly.
5. **Verify vendor claims against live docs and cite the URL.** Never answer from memory or from
   this repo's own summaries — repo docs record point-in-time findings and go stale. Read
   deprecation notices precisely: which method, which mode, which dates, what is explicitly
   unaffected. (We once concluded "Composio managed OAuth is dead" when only one *method* was being
   retired. An uncited one-liner in a design doc propagated the error for weeks.)
6. **Never paste badge plaintext anywhere** — chat, docs, commits. A 2026-07-03 leak forced
   rotating every badge in the fleet. Fingerprints (sha256) only.
7. **The Composio master API key never enters a sandbox.** It can act as anyone. Sandbox access is
   doorman-relayed through Render with per-person session pinning. Same custody rule for
   `GATEWAY_IDENTITY_SECRET`.
8. **`Box_Setup_Stuff/` is not documentation — it's the only context a host-side Claude gets** when
   bootstrapping trades-box-1, and it cannot see this repo. So (a) any architectural change to the
   agent stack must update it in the same change, and (b) those files must be **self-contained** —
   never "see docs/X §N", always inline the fact.
9. **If a gate fails, fix the root cause.** Never suppress the error or loosen the gate.
10. **Prod remains read-only.**

---

## 8. Day 1 — getting set up

```bash
npm install
```

Start the local database (needs Docker running). This applies every migration:

```bash
npx supabase start
```

⚠️ **Use `--include-all` on a fresh stack.** The `cost_*` migrations are timestamped *before* the
geocoding migration, so a plain `npx supabase migration up` refuses the out-of-order insert:

```bash
npx supabase migration up --include-all
```

Copy the env templates and fill them from what `supabase start` printed:

```bash
cp .env.test.example .env.test
```

`.env.test` needs three values (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`) — all
printed by `supabase start` or `supabase status`. A copied-but-unfilled `.env.test` fails loudly
rather than silently, by design.

`.env` (from `.env.example`) is for live helper scripts and the key-gated live-model tests; you can
skip it on day one. Note that `src/test.setup.ts` loads `.env` first, then `.env.test` **with
override** — so tests hit local while `.env` keeps serving the scripts.

Build a playground dataset:

```bash
npm run seed:local
```

Run the gates. **All four before any commit** — and show the real output, never assert success:

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

To see the board or the admin dashboard locally, seed some data, start `createHttpServer()` on a
port, and open `/board` or `/admin` (the admin page wants the token from `.env`).

**Concurrent work:** if you take a second `git worktree` for a parallel feature, give it its own
Supabase stack with `scripts/second-stack.sh [N]` from inside that worktree — it shifts the ports
and writes that worktree's `.env.test`. Clean up with `npx supabase stop --no-backup` there.

---

## 9. How we work

### RPI: Research → Plan → Implement

For any non-trivial feature:

```
/research <area>        # read-only; writes to thoughts/shared/research/
/plan <research-path>    # read-only; writes to thoughts/shared/plans/
/implement <plan-path>   # executes the approved plan phase by phase
```

**The plan is the human-review gate, not the code diff.** Review and approve the plan before
implementing. Both artifacts get committed alongside the code they describe — `thoughts/` is the
decision history of this project, with citations, and it is genuinely the best place to find out
*why* something is the way it is.

Two features at once? **Plan both before implementing either.** Research and planning are
read-only, so run both cycles concurrently, then compare the two plans' file footprints. Disjoint →
implement in parallel (separate worktrees, separate Supabase stacks). Overlapping → stack them.

### Verification

The four gates in §8 are the static floor. For verifying **behavior** — live checks, agent-driven
checks, cross-channel verification — follow the `verifying-behavior` skill in `.claude/skills/`.
There are also `data-security`, `system-design`, and `heuristic-evaluation` skills; read the one
that matches what you're touching before you touch it.

### Communication style

The project owner is a **hands-on learner, not a career engineer**. When you explain something:

- Plain language first; expand jargon and acronyms on first use.
- Draw a diagram (ASCII or mermaid) whenever structure matters.
- When there are choices, lead with a **decision brief** — each decision, the options, trade-offs
  in practical terms, and a recommendation — before the detail.

---

## 10. Deploy topology (and why it surprises people)

- **Render deploys a *separate repo*, not this one.** Merging to `main` here does **not** move
  production. Someone must sync that repo first, *then* Render → **"deploy latest commit"**.
- **Never click "Redeploy"** — it re-runs the *old* commit. This once put an 18-commit-stale build
  live. Confirm the live commit hash in the dashboard.
- **Nothing auto-applies DB migrations to the pilot.** Render only builds and starts. Pilot DDL
  goes through the Supabase MCP's `apply_migration`. The pilot's migration ledger has drifted from
  the repo (the MCP stamps its own apply-time version), so **trust schema read-backs, not the
  version ledger**.
- Deploy-before-migration fails safe but noisily (PostgREST "unknown column"); fix by applying the
  migration and `NOTIFY pgrst, 'reload schema'`.
- **Rollout classes** — know which one your change is, or you'll either ship a stale fleet or force
  needless restarts:

  | Change | What it needs |
  |---|---|
  | Tool **result** field | Deploy only |
  | Tool **description** | Deploy + `nemoclaw <s> gateway restart` **on the affected tier only** |
  | AGENTS.md contract text or tool **names** | Deploy + a full box **wire pass** + restarts |
  | Board JS/CSS | Deploy (verify the served file byte-matches `main`) |
  | Board worker only | Board-worker redeploy |

---

## 11. Traps — the short list

The full catalog is [engineering-memory.md](engineering-memory.md) §5. These are the ones most
likely to catch you in your first month.

**Database / API**
- PostgREST silently caps result sets at **1000 rows**. Any scan that can exceed it must paginate —
  see [src/db/foldImpact.ts](../src/db/foldImpact.ts) for the pattern.
- Schedule times are stored **naive-local**: the firm's wall-clock time written as if it were UTC.
  Availability checks pass timezone `'UTC'`. This is deliberate; revisit only if a tenant spans
  timezones.
- `rescheduleAssignment` creates the new row as `'proposed'` while every reader filters
  `['confirmed']` — moves **must** pass `status:'confirmed'`.
- Terminal (cancelled) assignment rows retain a stale `locked=true`. Always filter by status when
  counting pins.

**The agent fleet**
- **Credentials inject into a sandbox's env at container launch only.** Any badge or token write
  needs a container restart. This silently killed a real beta customer's spine access for four days.
- **Never change a sandbox's `openclaw.json` with `openclaw config patch`** — it doesn't update the
  config hash, and the next gateway restart fails and leaves the gateway **down**. Three bots went
  down learning this. Use the gateway-mediated download → `jq` → upload → hash → restart recipe.
- **Never health-check with `nemoclaw <s> agent`** — it injects into that person's live Telegram
  conversation. Use `doctor`, `channels status`, or logs.
- **Enumerate live sandboxes from the box, never from a written-down map.** `nemoclaw list`, then
  `channels status` per sandbox. A rollout once missed a live manager sandbox added since the map
  was written.
- **DeepInfra's balance runs out roughly monthly and nothing alerts on it.** It goes unnoticed
  precisely because the failover works — the bots keep running on NVIDIA. Both-providers-dead alarm
  → check the balance (HTTP 402) first. Trust box evidence over vendor status pages.

**Working with the model**
- **GLM-5.2 does not reliably obey standing instructions.** Proven repeatedly: it skipped a required
  field despite a rule, skipped a link despite "always offer it", resolved an ambiguity it was told
  to ask about. **When a behavior matters, move it into the mechanism** — a required parameter, a
  result-embedded directive, server-side resolution like the `resolve_date` tool. Prompt rules are
  steering, not enforcement.
- **A tool's `parameters` schema costs real latency.** Every request compiles each tool's JSON
  Schema into a decoding grammar before the first token. One bloated built-in tool (113 params, 13
  levels deep) cost ~51 seconds per turn by itself; denying it took turns from 67s to 3s. Our own 39
  spine tools are cheap by comparison — keep them that way.
- **AGENTS.md is ~26.6k chars against a 12k injected-context budget**, so most of it never reaches
  the model (head 45% + a policy digest + tail 15%). Guidance added late in that file is probably
  invisible. Verify against the truncation model before trusting it.

---

## 12. Glossary

| Term | Meaning |
|---|---|
| **The spine** | The three-layer customer/job record. The product's core. |
| **L1 / L2 / L3** | Raw append-only capture / structured tables / JSONB attributes. |
| **Tenant** | One trades firm. Every row carries `tenant_id`. |
| **Ref** | A technician's stable string id (`manager-sam`). **Permanent, never reused across humans.** |
| **Badge** | A revocable random token a sandbox holds. Means nothing outside the doorman. |
| **Doorman** | Host process that turns a badge into signed identity headers. |
| **MCP** | Model Context Protocol — how the agent discovers and calls our tools. |
| **NemoClaw / OpenClaw** | The agent runtime and sandbox manager on trades-box-1. |
| **Composio** | Third-party connector platform (Gmail, Sheets…) with per-person sessions. |
| **The board** | The Telegram Mini App dispatch board. |
| **Promise ladder** | `none` / `day` / `time_only` / `time` — what the customer was told. |
| **The freeze** | The weekly ritual that plans the loose queue across the team's week. |
| **Re-solve** | Horizon-wide re-optimization of unpinned visits. |
| **Loose bucket / tray** | Work that exists but isn't scheduled yet. |
| **Pinned** | A manager-set flag meaning "the solver must not move this". |
| **Wire pass** | Re-running the box bootstrap so each sandbox's AGENTS.md contract text refreshes. |
| **RPI** | Research → Plan → Implement, our feature workflow. |
| **trades-box-1** | The AWS Lightsail host running all the agent sandboxes. |

---

## 13. Your first week — a suggested path

1. **Read** the spine overview, then `CLAUDE.md`, then skim engineering-memory §1–3.
2. **Stand up** the local stack, seed it, run all four gates green. (§8)
3. **Trace one request end to end** in the code: start at `record_field_note` in
   [src/mcp/server.ts](../src/mcp/server.ts), follow it into
   [recordFieldNote.ts](../src/writePath/recordFieldNote.ts), then into `src/db/`. Read the tests
   next to each — they're the clearest spec we have.
4. **Read one plan document** in `thoughts/shared/plans/` cover to cover — pick a recent one — to
   see what an approved plan looks like before you write one.
5. **Take a small change** through the full loop: branch → RPI if non-trivial → gates → PR.

Ask early about anything in §7. Those rules cost us real incidents, and none of them are obvious
from reading the code alone.
