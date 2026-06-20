# CLAUDE.md sections to merge into the target repo

Paste these two sections into the target repo's `CLAUDE.md`. Do **not** copy the rest of the
source repo's CLAUDE.md — it's project-specific.

Adjust the `Verification` gate commands to the target repo's real scripts before committing
(monorepo vs single package, Vitest vs Jest, etc.). The RPI section is already generic.

---

## Verification

These are the pass/fail gates. Run the relevant ones after every change, and all of them before any
commit. Show the actual command output — never assert success without it.

```bash
npx tsc --noEmit     # types (if TypeScript)
npm run lint         # lint
npm test             # unit tests
npm run build        # before opening a PR
```

If a gate fails, fix the root cause — never suppress the error or loosen the gate to get past it.

For verifying **behavior** (live/agent-driven checks, test-environment safety, cross-channel
verification) — not just these static gates — follow the `verifying-behavior` skill.

---

## Development workflow (RPI)

For non-trivial features, use the Research → Plan → Implement workflow:

```
/research <area>          # read-only; writes to thoughts/shared/research/
/plan <research-path>     # read-only; writes to thoughts/shared/plans/
/implement <plan-path>    # executes the approved plan phase by phase
```

**Rule:** review and approve the plan before running `/implement`. The plan is the human-review
gate — not the code diff.

Each phase has built-in review loops: `/plan` has its draft critiqued by a fresh-context subagent
before presenting it, and `/implement` has each phase's diff adversarially reviewed against the
plan, with a final `/code-review` pass over the full diff before the plan is marked complete.

Artifacts live in `thoughts/shared/research/` and `thoughts/shared/plans/`. Commit them alongside
the code changes they describe.
