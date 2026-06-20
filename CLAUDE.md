# TradesDatabase — CLAUDE.md

## Domain
This repo builds the **three-layer context spine**: a single customer/job record split into
**L1 raw** (`raw_captures`, append-only verbatim capture), **L2 structured**
(`customers ─(1:N)─ jobs ─(1:N)─ visits`), and **L3 attributes** (an `attributes` JSONB column on
each L2 row). Every structured field links back to the raw evidence it came from. See
[Three-Layer-Context-Spine-Overview.md](Three-Layer-Context-Spine-Overview.md) for the full design.

## Conventions
- TypeScript, ESM (`"type":"module"`, `NodeNext`) — use explicit `.js` extensions on relative imports.
- All database access goes through the typed layer in `src/db/`; don't hand-write Supabase queries elsewhere.
- **L1 (`raw_captures`) is append-only** — insert only, never update or delete (enforced by a DB trigger too).
- Test writes target the **test** Supabase project only; **prod is read-only**. Tests self-clean rows they create.

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
