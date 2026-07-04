# RPI + loop-engineering workflow — portable export

This folder is a de-projectified copy of the Research → Plan → Implement (RPI) workflow and its
loop-engineering verification layer, ready to drop into a **different Node/JS or TS** repository.
All project-specific content from the source repo has been stripped or replaced with placeholders.

> **Note (2026-07-04):** this description predates later work in THIS repo. The in-repo
> `.claude/skills/verifying-behavior/SKILL.md` §1/§5 have since been **bound to this project's
> live environments** (local Supabase stack, `supabase-test`/`supabase-prod` MCP, trades-box-1) —
> the "live bindings = TODO / none wired" lines below no longer describe it. If you export this
> tree to another repo, re-strip those two sections first.

## What's here

```
.claude/
  commands/research.md          # /research  — generic, verbatim
  commands/plan.md              # /plan      — generic; gate examples genericized to npm/tsc
  commands/implement.md         # /implement — conventions de-coupled (points at CLAUDE.md)
  skills/verifying-behavior/
    SKILL.md                    # principles + missing-capability rule; live bindings = TODO (§5)
  settings.json                 # generic allow-list + a JS `node --check` PostToolUse hook
thoughts/shared/
  research/.gitkeep             # /research writes here
  plans/.gitkeep                # /plan writes here
CLAUDE-md-sections.md           # the two CLAUDE.md sections to paste into the target repo
```

## How to install in the target repo

1. **Copy the tree.** Copy `.claude/` and `thoughts/` from this folder into the target repo root.
   - If the target already has `.claude/settings.json`, **merge** rather than overwrite (fold in the
     `permissions.allow` entries and the `hooks.PostToolUse` block).
2. **Merge the CLAUDE.md sections** from `CLAUDE-md-sections.md` into the target's `CLAUDE.md`.
3. **Stand up a test harness** so the verification gates exist. The workflow assumes `npm test`
   runs something. For Node/TS, Vitest mirrors the source repo:
   ```bash
   npm i -D vitest
   ```
   add to `package.json` scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, and a minimal
   `vitest.config.js`:
   ```js
   import { defineConfig } from 'vitest/config';
   export default defineConfig({ test: { environment: 'node', include: ['**/*.test.js'] } });
   ```
   (Use `.ts`/`jsdom`/Jest instead if that fits the target better — just keep `npm test` green.)
4. **Fix the gate commands** in `CLAUDE.md` (and the example checklists in `plan.md`) to match the
   target's real scripts — monorepo paths, `tsc` vs not, lint command, etc.
5. **Re-bind conventions.** `implement.md` and the review-subagent prompt point at "CLAUDE.md's
   Conventions section" — make sure the target's CLAUDE.md actually has one.

## What still needs your input (deliberately left as TODO)

- **Live verification infrastructure** — none is wired. `verifying-behavior` §5 lists what to add
  (browser MCP, a test-DB MCP with a writable-test / read-only-prod split, any API sandbox). Until
  one exists, bucket-2 live E2E checks are blocked and the **missing-capability rule** (§4) applies.
  When you wire something, fill in §1 and §5 with the concrete bindings.
- **The SSO-login note** (§6) is kept as a general principle; adapt it to the target's auth.

## What was intentionally NOT copied

- The source repo's CLAUDE.md domain/architecture/deployment sections.
- The source repo's `thoughts/` research & plan documents.
- The source repo's actual `*.test.js` files (they test the old project's code).
- Concrete MCP/DB bindings (project IDs, `supabase`/`supabase-test`, OAuth specifics).
- `/code-review` is a **bundled global skill** — it ships with Claude Code, so it works in the
  target repo with nothing to copy.
