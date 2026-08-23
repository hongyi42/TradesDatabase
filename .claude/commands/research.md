# Research Phase

**YOUR ONLY JOB IS TO DOCUMENT AND EXPLAIN THE CODEBASE AS IT EXISTS TODAY.**

You are a read-only research agent. Do not suggest changes, improvements, or opinions about the code. Do not modify any files. Document what exists — nothing more.

## Task

Research the following area of the codebase: **$ARGUMENTS**

If no area is specified, do a full architectural survey of the project.

## Process

1. **Confirm scope** — restate what you will research before starting.

2. **Read files completely** — when a file is directly relevant, read it in full (no limit/offset). Do not skim.

3. **Map the territory** — identify all files, modules, and entry points relevant to the scope. For each:
   - What it does
   - Its dependencies and dependents
   - Key data structures and interfaces
   - Non-obvious invariants or constraints

4. **Trace the flows** — for features, trace request/response paths end-to-end. For data, trace where it is created, transformed, stored, and read.

5. **Note seams and boundaries** — identify where the code connects to external systems, where auth/auth decisions happen, and where major module boundaries sit.

6. **Gather metadata** — run `git log --oneline -10` and `git branch --show-current` to capture commit context.

## Output

Write a research document to `thoughts/shared/research/` using this filename format:
`YYYY-MM-DD-{kebab-case-topic}.md`

Use this structure:

```markdown
---
date: YYYY-MM-DD
branch: <current branch>
commit: <short hash>
topic: <what was researched>
supersedes: <path to the document this overturns, or "nothing">
---


**`supersedes:` is not optional bookkeeping.** If this document overturns a decision made in an
earlier one, name that document's path. Now is the only moment the reason is fresh enough to
record accurately — nobody reconstructs it correctly three months later, and a superseded
document left unmarked is worse than no document, because a future session will find it and
build on it. If it overturns nothing, write `nothing`.

## Summary
One paragraph, in plain language a non-expert can follow (expand jargon on first use).
What is this area of the codebase? What problem does it solve?

## Entry Points
Files/routes/components where this area begins. Include file paths and line numbers.

## Key Files
Annotated list of every relevant file — path, role, key exports.

## Data Flows
How data moves through the system. Be specific: function names, argument shapes, return values.
When a flow spans 3+ components, include a simple diagram (ASCII or mermaid) of the hops.

## External Dependencies
Any third-party APIs, services, or packages this area depends on.

## Constraints and Invariants
Non-obvious rules the code relies on. Hardcoded assumptions. Known limitations.

## Decision Points
Choice points the current code creates for upcoming work, stated factually and in plain
language: what the choice is, and what each option would involve given how the code works
today. No recommendations — just make the fork in the road visible.

## Open Questions
Anything unclear from reading alone that would need testing or asking to resolve.
```

After writing the file, print its path, a one-paragraph plain-language summary of the most important finding, and the Decision Points list (if any) — the user should not have to ask "what decisions am I facing" as a follow-up.

## Hard constraints

- Do not edit any source file.
- Do not run the application or tests.
- Do not make suggestions or recommendations.
- If you find something surprising or concerning, document it as a finding — do not act on it.
- File paths and line numbers must be exact.

## Final step — refresh the decision index

After writing the document, run:

```bash
npm run decisions:index
```

This regenerates `thoughts/INDEX.md`, the machine index the pre-edit hook reads, and the map
inside `docs/engineering-memory.md`. Commit the regenerated files alongside the document. An
index that lags the corpus is the failure mode this whole mechanism exists to prevent.
