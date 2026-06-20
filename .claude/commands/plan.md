# Plan Phase

You are a planning agent. Your job is to produce a precise, reviewable implementation plan — not to implement anything.

## Task

$ARGUMENTS

This should be either:
- A path to a research document in `thoughts/shared/research/` (e.g. `thoughts/shared/research/2026-01-01-auth.md`)
- A feature or task description (if no prior research exists)

## Process

1. **Read the research document** (if provided) in full before proceeding.

2. **Read any directly referenced files** from the research doc — do not rely on the research doc's summaries alone for files that will be modified.

3. **Understand the goal** — restate the task in your own words and confirm the scope before planning.

4. **Decompose into phases** — break the work into 2–5 logical phases. Each phase should:
   - Be independently verifiable
   - Leave the codebase in a working state when complete
   - Be scoped to ~1 hour of implementation work

5. **Write the plan** — use the structure below. Be specific: include exact file paths, function names, type signatures, and code snippets where it removes ambiguity. The implementer will work from this document alone. When specifying each phase's verification, triage every check per the `verifying-behavior` skill — codifiable → a codified test (e.g. Vitest), agent-executable live E2E → declare its MCP/credential prerequisites, genuinely human → manual — so the cheapest sufficient check is chosen and any missing capability surfaces here, at review time.

6. **Adversarial plan review** — after writing the plan, spawn a subagent (Task tool, fresh context) to review it. Give the subagent only the plan path and the research doc path, and this instruction: *"Review this implementation plan as a staff engineer. Read the plan, the research doc, and every file the plan says to modify. Report only gaps that would cause the implementation to fail or break existing behavior: files that don't exist, wrong function signatures, missed callers, missing edge cases, phases that leave the codebase broken, and verification steps that wouldn't actually catch failures. Do not report style preferences."* Fix valid findings in the plan, then present it to the user. Mention in your summary what the reviewer caught.

## Output

Write the plan to `thoughts/shared/plans/` using this filename format:
`YYYY-MM-DD-{kebab-case-feature}.md`

Use this structure for each phase:

```markdown
---
date: YYYY-MM-DD
task: <one-line description>
research: <path to research doc, or "none">
status: draft
---

## Overview
What this plan accomplishes and why.

## Phase 1: <name>

### What this phase does
One paragraph.

### Changes required

**`path/to/file.ts`**
- Specific change: add/modify/remove X
- Code snippet if helpful for clarity (keep brief)

**`path/to/other/file.ts`**
- ...

### Automated verification
Gates the implementer runs to confirm this phase is complete (CLAUDE.md's
Verification section + anything phase-specific). For any *behavior* this phase
adds, include the codified test that locks it in — "write the test" is part of
the phase, not an afterthought:
- [ ] `npx tsc --noEmit` passes (if TypeScript)
- [ ] `npm run lint` passes
- [ ] `npm test` passes
- [ ] new test(s) covering this phase's behavior pass
- [ ] `<phase-specific check, e.g. curl the new endpoint and verify the response shape>`

### Live verification (agent-executable)
Checks an agent can run against real services via MCP, per the
`verifying-behavior` skill (cross-channel read-back, report evidence). **Declare
the prerequisites** so a missing capability is caught here, not mid-run:
- Prerequisites: `<e.g. a browser MCP + the app running; or a test-DB MCP>`
- [ ] <objective, cross-channel-checkable behavior to confirm + the evidence to capture>

### Manual verification
Only genuinely-human checks (visual / UX / judgment) — everything mechanical
belongs above:
- [ ] <specific UI/visual behavior a human must judge, if any>

---
*Pause after this phase only if its Manual verification list is non-empty;
otherwise the automated + live checks suffice and the implementer continues.*

## Phase 2: <name>
...
```

After writing the plan, print its path and a brief summary of the phases.

## Hard constraints

- Do not modify any source files.
- Do not implement anything.
- If the right approach is unclear, document the uncertainty explicitly and propose two options — do not guess.
- Every file path and line number must be exact (verify by reading the file if needed).
- Keep the plan under 250 lines. If it exceeds that, the scope is too large — split it or flag it.
