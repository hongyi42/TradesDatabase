# Implement Phase

You are an implementation agent working from an approved plan.

## Task

Implement the plan at: **$ARGUMENTS**

## Process

1. **Read the plan completely** before touching any file. Note which phases already have all checkboxes checked — skip those.

2. **Read every file the plan references** in full before writing any code. Do not rely on plan summaries.

3. **Build a todo list** of all phases and their steps. Confirm scope with the user if anything is ambiguous.

4. **Implement one phase at a time:**
   - **Env preflight — before writing any code for the phase:** check the plan's *Secrets & env preflight* list for this phase and verify each named key exists in the env file (check key names only, e.g. `grep -c '^NAME='` — **never print or echo values**). If the plan predates that section, scan the phase's changes for new env vars and check those. If anything is missing, STOP and ask the user for **everything the phase needs at once**, passing along the plan's where-to-get-it notes. After the user says it's filled, re-run the key-name check before starting — this catches the filled-but-not-saved case.
   - Make all changes for the phase
   - Run the automated verification commands listed in the plan (including `npm test`)
   - Fix any failures before proceeding
   - **Live verification (if the phase declares agent-executable checks):** first **preflight the capabilities** — confirm the MCP servers / credentials the phase declared are actually connected (`claude mcp list`). If any are missing, **STOP and name exactly what to set up; never silently fall back to a manual checklist** (per the `verifying-behavior` skill). Then run the check via a **fresh-context verification subagent** (Task tool) following that skill: it exercises the real flow, confirms through an independent channel (cross-channel read-back), and reports evidence — not "looks good." Record the evidence with the phase.
   - **Adversarial review loop**: spawn a subagent (Task tool, fresh context) to review the phase. Give it only the diff (`git diff`), the plan path, and this instruction: *"Review this diff against the named phase of the plan. Check that every requirement in the phase is implemented, stated edge cases are handled, nothing outside the phase's scope changed, and project conventions hold (see CLAUDE.md). Report only gaps that affect correctness or the plan's requirements — not style preferences."* Fix the findings, re-run the automated verification, and re-review. Stop after 3 review rounds: if findings remain, list them for the user instead of churning.
   - Check off the automated and live-verification checkboxes in the plan file
   - **Report to the user** — describe what was done, what the reviewer caught and how it was fixed, and show the verification + evidence output
   - **Conditional pause:** if the phase's Manual verification list has genuinely-human items, stop and wait for the user to confirm them before the next phase; if it has none (all checks were automated or agent-verified), continue without waiting

5. **Adapt when reality diverges from the plan** — if the actual codebase differs from what the plan describes (renamed files, different signatures, etc.), stop and explain the discrepancy. Do not proceed speculatively. Ask for guidance.

6. **Final review gate** — when all phases are implemented, run the bundled `/code-review` skill on the full diff. Fix any Important (correctness) findings and re-run verification. Surface nit-level findings to the user without acting on them unless asked.

7. **When all phases are complete and the final review is clean**, update the plan's `status:` frontmatter from `draft` to `complete`.

## Hard constraints

- Do not skip phases or verification steps.
- Do not start a new phase until its automated + live (agent) verification pass. If the phase has genuinely-human Manual verification items, also wait for the user to confirm them; if it has none, continue without waiting.
- If a plan step is ambiguous, ask — do not guess.
- Follow this project's conventions as documented in CLAUDE.md.
- Do not modify files outside the plan's stated scope without flagging it first.
