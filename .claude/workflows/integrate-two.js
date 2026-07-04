export const meta = {
  name: 'integrate-two',
  description: 'Merge two implemented feature branches onto a local integration branch, run the full gates after each merge, then review the combined diff for cross-feature interactions with a capped fix loop. Local only — never pushes, never opens PRs, never touches main.',
  whenToUse: 'After two features are implemented on separate local branches and each passes the gates on its own. Pass args as {branchA: "...", branchB: "...", base: "main"} (base optional, defaults to main). Requires: clean working tree in the main checkout, and the local Supabase stack running (npx supabase start) — npm test runs here.',
  phases: [
    { title: 'Merge A', detail: 'integration branch off base, merge A, run gates', model: 'opus' },
    { title: 'Merge B', detail: 'merge B on top, run gates — failures here mean the COMBINATION broke', model: 'opus' },
    { title: 'Review', detail: 'combined diff reviewed for cross-feature interactions; fix loop capped at 2 rounds' },
  ],
}

if (!args || !args.branchA || !args.branchB) {
  throw new Error('integrate-two needs args {branchA, branchB} (and optional base, default "main").')
}

const BASE = args.base || 'main'
const slug = (s) => s.replace(/[^a-zA-Z0-9._-]+/g, '-')
const INTEGRATION = `integrate/${slug(args.branchA)}--${slug(args.branchB)}`

const MERGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'conflicts', 'gates', 'notes'],
  properties: {
    ok: { type: 'boolean', description: 'true only if the merge completed AND all three gates passed' },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'Files that had merge conflicts (resolved or not)' },
    gates: {
      type: 'object',
      additionalProperties: false,
      required: ['typecheck', 'lint', 'test'],
      properties: {
        typecheck: { type: 'string', description: 'pass | fail | skipped — with the last few output lines as evidence' },
        lint: { type: 'string' },
        test: { type: 'string', description: 'Include the vitest summary line (files/tests passed) as evidence' },
      },
    },
    notes: { type: 'string', description: 'What happened, including why it stopped if ok=false' },
  },
}

const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['severity', 'file', 'description'],
        properties: {
          severity: { type: 'string', enum: ['important', 'nit'] },
          file: { type: 'string' },
          description: { type: 'string', description: 'The cross-feature interaction problem and its failure scenario' },
        },
      },
    },
  },
}

// ── Model routing ─────────────────────────────────────────────────────────────
// Two-tier policy (user decision, 2026-07-04): OPUS for mundane execution
// (git mechanics, running gates), FABLE (the session model — omit `model`)
// for decision-making (review, code fixes).
// $/MTok in/out: opus 5/25 · fable(session) 10/50. `effort` = how hard it thinks.
const ROUTING = {
  merge:  { model: 'opus' },     // mundane: runs git + gates and reports evidence; the gates verify the work
  review: { effort: 'high' },    // decision: cross-feature misses are exactly what this stage exists for
  fix:    {},                    // decision: edits code that only gets 2 review rounds after it
}

const mergeRules = `
Hard rules:
- LOCAL ONLY: never push, never open a PR, never checkout or modify ${BASE} itself.
- If the working tree is dirty (git status --porcelain non-empty), STOP immediately with ok=false — do not stash or discard anything.
- Merge conflicts: resolve ONLY mechanically-trivial ones (independent adjacent-line edits). If any conflict requires judgment about intended behavior, run git merge --abort and report ok=false with the conflicting files. Do NOT guess semantic resolutions.
- Gates: npm run typecheck, npm run lint, npm test — in that order, in the repo root. Report real output tails as evidence; never claim a pass without output. Tests hit the LOCAL Supabase stack; if the test-env guard fails, report it — do not modify .env.test or any guard.`

const run = async () => {
  const mergeA = await agent(
    `In the repo at the current directory, prepare an integration branch and merge the first feature.
Steps: verify the working tree is clean and that branches "${args.branchA}", "${args.branchB}", and "${BASE}" all exist (git rev-parse --verify). Create branch "${INTEGRATION}" from "${BASE}" (fail with ok=false if it already exists — a previous run left it behind; do not delete it yourself). Merge "${args.branchA}" into it with git merge --no-ff. Then run the three gates.
${mergeRules}
Return the result via the structured output schema.`,
    { label: `merge:${args.branchA}`, phase: 'Merge A', schema: MERGE_SCHEMA, ...ROUTING.merge },
  )
  if (!mergeA || !mergeA.ok) {
    log(`STOPPED at Merge A: ${mergeA ? mergeA.notes : 'agent failed'} — branch ${INTEGRATION} may need manual cleanup (git branch -D).`)
    return
  }
  log(`Merge A clean, gates green (test: ${mergeA.gates.test}).`)

  const mergeB = await agent(
    `The integration branch "${INTEGRATION}" already has "${BASE}" + "${args.branchA}" merged, with all gates green. You are on that branch (verify with git branch --show-current; check it out if not).
Merge "${args.branchB}" into it with git merge --no-ff, then run the three gates again.
IMPORTANT context for your notes: feature A alone passed everything — so any gate failure now means THE COMBINATION of the two features broke it. Diagnose which interaction caused it in your notes; do not attempt to fix code.
${mergeRules}
Return the result via the structured output schema.`,
    { label: `merge:${args.branchB}`, phase: 'Merge B', schema: MERGE_SCHEMA, ...ROUTING.merge },
  )
  if (!mergeB || !mergeB.ok) {
    log(`STOPPED at Merge B — the combination failed: ${mergeB ? mergeB.notes : 'agent failed'}. Integration branch ${INTEGRATION} is left in place for inspection.`)
    return
  }
  log(`Merge B clean, gates green (test: ${mergeB.gates.test}). Reviewing the combined diff.`)

  const reviewPrompt = (round) => `You are reviewing the COMBINED result of two features merged onto branch "${INTEGRATION}" (round ${round}).
Feature A: branch ${args.branchA}. Feature B: branch ${args.branchB}. Each passed review and gates ALONE — do not re-review them individually.
Read the combined diff (git diff ${BASE}...${INTEGRATION}) and hunt ONLY for CROSS-FEATURE interactions: one feature changing behavior/data/contracts the other relies on, double-handling of the same event or row, conflicting migrations or seed expectations, L1 append-only gating assumptions broken by the other feature, race conditions between their code paths. Check CLAUDE.md conventions hold across the combination.
Severity "important" = could cause incorrect behavior, a test failure, or data damage. "nit" = everything else. Report findings via the structured output schema (empty array if clean).`

  let review = await agent(reviewPrompt(1), { label: 'review:combined', phase: 'Review', schema: REVIEW_SCHEMA, ...ROUTING.review })

  for (let round = 1; round <= 2; round++) {
    const important = review ? review.findings.filter((f) => f.severity === 'important') : []
    if (important.length === 0) break
    log(`Review round ${round}: ${important.length} important cross-feature finding(s) — fixing.`)
    await agent(
      `On branch "${INTEGRATION}" (verify/checkout), fix these confirmed cross-feature integration findings, then re-run the three gates (npm run typecheck, npm run lint, npm test) and make them pass. Fix root causes only — no refactoring beyond the findings, never loosen a gate or guard, never push.
Findings: ${JSON.stringify(important)}
Return via schema: ok=true only if all fixes applied and gates green.`,
      { label: `fix:round${round}`, phase: 'Review', schema: MERGE_SCHEMA, ...ROUTING.fix },
    )
    review = await agent(reviewPrompt(round + 1), { label: `review:round${round + 1}`, phase: 'Review', schema: REVIEW_SCHEMA, ...ROUTING.review })
  }

  const remaining = review ? review.findings : []
  const remainingImportant = remaining.filter((f) => f.severity === 'important')
  if (remainingImportant.length > 0) {
    log(`DONE WITH RESERVATIONS: ${remainingImportant.length} important finding(s) remain after 2 fix rounds — human decision needed: ${JSON.stringify(remainingImportant)}`)
  } else {
    log(`INTEGRATION CLEAN: branch ${INTEGRATION} has both features merged, all gates green, no important cross-feature findings (${remaining.length} nit(s): ${JSON.stringify(remaining)}).`)
  }
  log(`Branch ${INTEGRATION} is local-only — review it, then merge/push it yourself when satisfied.`)
}

await run()
