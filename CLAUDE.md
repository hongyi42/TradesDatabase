# TradesDatabase — CLAUDE.md

## Domain
This repo builds the **three-layer context spine**: a single customer/job record split into
**L1 raw** (`raw_captures`, append-only verbatim capture), **L2 structured**
(`customers ─(1:N)─ jobs ─(1:N)─ visits`), and **L3 attributes** (an `attributes` JSONB column on
each L2 row). Every structured field links back to the raw evidence it came from. See
[Three-Layer-Context-Spine-Overview.md](docs/Three-Layer-Context-Spine-Overview.md) for the full design.

## Conventions
- TypeScript, ESM (`"type":"module"`, `NodeNext`) — use explicit `.js` extensions on relative imports.
- All database access goes through the typed layer in `src/db/`; don't hand-write Supabase queries elsewhere.
- **L1 (`raw_captures`) is append-only** — insert only, never update or delete (enforced by a DB trigger too).
  Because there is no delete path, **any filtering/classification (e.g. work-vs-personal email) must gate
  the L1 insert — run it _before_ writing, never after**, or misrouted rows are retained permanently.
  - *Recorded exception (2026-07-02):* mail arriving while a Gmail pairing is still
    `pending_verification` (the window between OAuth consent and the manager confirming the
    account) is ingested normally rather than gated — silently dropping real work mail in that
    window is worse than retaining rows from a mis-paired mailbox. Each such capture is stamped
    in its source metadata (`pendingVerification: true` + `pendingAccount: <connected-account id>`,
    see `src/inbound/webhook.ts`) so a bad pairing's rows are findable for forensics.
- **Tests run ONLY against the local Supabase stack** (`npx supabase start`, values in `.env.test` —
  see `.env.test.example`; enforced by `src/testEnvGuard.ts`, which refuses to start the suite
  against any non-local URL). The hosted "test" project (`daqapdlkgxfrhquacprv`) is the **deployed
  pilot's live database** — Render web + cron and the trades-box-1 badge-pull read it — never point
  tests at it. Seeding: `npm run seed:local` rebuilds the local playground (roster included);
  seeding the pilot requires an explicit `npm run seed -- --hosted` and touches spine demo data
  only (`--with-roster` additionally resets the roster — churns box credentials and bumps sandbox
  provider generations). **Prod remains read-only.**
  (Why: a test run truncated the pilot's roster on 2026-07-03 and locked a technician out.)

## Communication defaults

The user is a hands-on learner, not a career engineer. For every explanation, in any session:
- Plain language first — expand jargon and acronyms on first use.
- Draw a simple diagram (ASCII or mermaid) whenever structure matters: architecture, data
  flows, request paths, sequences.
- When the work involves choices, lead with a decision brief — each decision, the options,
  their trade-offs in practical terms, and a recommendation — before diving into detail.

## Verification
These are the pass/fail gates. Run the relevant ones after every change, and all of them before any
commit. Show the actual command output — never assert success without it.

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run build        # before opening a PR
```

If a gate fails, fix the root cause — never suppress the error or loosen the gate to get past it.

For verifying **behavior** (live/agent-driven checks, test-environment safety, cross-channel
verification) — not just these static gates — follow the `verifying-behavior` skill.

## External services — verify against live docs first

When a question or design decision involves a third-party service (Composio, Supabase, Google
OAuth, Twilio, …), **check the service's current documentation before answering — never answer
from memory or from this repo's summaries alone.** Repo docs record point-in-time findings and go
stale; vendor products change under us.

- Cite the doc page (URL) for any load-bearing claim, and record the citation in the design
  doc/research artifact so the next reader doesn't have to re-derive it.
- Read deprecation notices precisely: *which method/endpoint*, *which mode*, *which dates*, and
  what is explicitly **unaffected**. (Case study: we briefly concluded "Composio managed OAuth is
  dead" when only the `initiate()` *method* was being retired — `link()` + managed OAuth were fine.
  An uncited one-liner in a design doc propagated the error.)
- If a doc claim in this repo has no citation, treat it as unverified — confirm it upstream before
  building on it.

## Development workflow (RPI)

For non-trivial features, use the Research → Plan → Implement workflow:

```
/research <area>          # read-only; writes to thoughts/shared/research/
/plan <research-path>     # read-only; writes to thoughts/shared/plans/
/implement <plan-path>    # executes the approved plan phase by phase
```

**Rule:** review and approve the plan before running `/implement`. The plan is the human-review
gate — not the code diff.

Artifacts live in `thoughts/shared/research/` and `thoughts/shared/plans/`. Commit them alongside
the code changes they describe.
