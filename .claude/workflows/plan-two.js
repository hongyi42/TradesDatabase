export const meta = {
  name: 'plan-two',
  description: 'Research + plan two features concurrently, then compare file footprints and recommend parallel vs stacked implementation. Read-only + plan drafts — never implements.',
  whenToUse: 'When two candidate features are ready for planning. Pass args as {featureA: "...", featureB: "..."} — a short description of each feature. Both plans still require human approval before /implement (CLAUDE.md rule).',
  phases: [
    { title: 'Research', detail: 'one read-only researcher per feature (Opus)', model: 'opus' },
    { title: 'Plan', detail: 'one plan writer per feature, session model at high effort' },
    { title: 'Compare', detail: 'file-footprint overlap → parallel vs stack verdict' },
  ],
}

if (!args || !args.featureA || !args.featureB) {
  throw new Error('plan-two needs args {featureA: "...", featureB: "..."} — one short description per feature.')
}

const RESEARCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['researchPath', 'summary'],
  properties: {
    researchPath: { type: 'string', description: 'Repo-relative path of the research doc written under thoughts/shared/research/' },
    summary: { type: 'string', description: '3-6 sentence summary of the key findings' },
  },
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['planPath', 'files', 'summary'],
  properties: {
    planPath: { type: 'string', description: 'Repo-relative path of the plan written under thoughts/shared/plans/' },
    files: { type: 'array', items: { type: 'string' }, description: 'Every repo file this plan intends to create or modify (repo-relative paths)' },
    summary: { type: 'string', description: '2-4 sentence summary of the plan' },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recommendation', 'reasoning', 'riskAreas'],
  properties: {
    recommendation: { type: 'string', enum: ['parallel', 'stack'] },
    reasoning: { type: 'string', description: 'Plain-language explanation a non-engineer can follow' },
    riskAreas: { type: 'array', items: { type: 'string' }, description: 'Specific files/behaviors where the two features could interact' },
  },
}

// ── Model routing ─────────────────────────────────────────────────────────────
// Two-tier policy (user decision, 2026-07-04): OPUS for mundane execution
// (reading, summarizing, mechanics), FABLE (the session model — omit `model`)
// for decision-making (plans, verdicts, reviews).
// $/MTok in/out: opus 5/25 · fable(session) 10/50. `effort` = how hard it thinks.
const ROUTING = {
  research: { model: 'opus' },     // mundane: reads + summarizes; the planner re-reads the code anyway
  plan:     { effort: 'high' },    // decision: plan errors propagate into implementation
  compare:  { effort: 'high' },    // decision: this verdict gates the parallel-vs-stack choice
}

const groundRules = (key) => `
Ground rules (you are a non-interactive subagent):
- You cannot ask the user questions. Where the command file says to confirm with the user, make the most reasonable assumption instead and record it in an "Assumptions" section of the document you write.
- Follow this repo's CLAUDE.md conventions. You are READ-ONLY with respect to src/ and all code — the only files you may create are your own docs under thoughts/shared/.
- Never run seeding or anything that writes to a database. Do not run npm test.
- Include "feature-${key}" in your output filename so the two concurrent runs never collide (get the date prefix with \`date +%F\` via Bash).`

const run = async () => {
  const features = [
    { key: 'A', desc: args.featureA },
    { key: 'B', desc: args.featureB },
  ]

  const plans = await pipeline(
    features,
    (f) => agent(
      `Read .claude/commands/research.md and follow its process. Research area: feature ${f.key} — ${f.desc}.
${groundRules(f.key)}
Write the research doc to thoughts/shared/research/.
Your final output is data, not prose: return researchPath and summary via the structured output schema.`,
      { label: `research:${f.key}`, phase: 'Research', schema: RESEARCH_SCHEMA, ...ROUTING.research },
    ),
    (research, f) => agent(
      `Read .claude/commands/plan.md and follow its process. Write an implementation plan for feature ${f.key} — ${f.desc}.
Base it on the research doc at ${research.researchPath} (read it in full), and read every code file it references before planning.
${groundRules(f.key)}
Additional requirements for this plan:
- Frontmatter status: draft. The plan will be human-reviewed before any implementation.
- Include a "File footprint" section listing EVERY repo file the plan will create or modify — this list decides whether the two features can be built in parallel, so err on the side of listing a file if unsure.
- Include per-phase automated verification (npm run typecheck / lint / test) per CLAUDE.md.
Write the plan to thoughts/shared/plans/.
Return planPath, the complete files list, and summary via the structured output schema.`,
      { label: `plan:${f.key}`, phase: 'Plan', schema: PLAN_SCHEMA, ...ROUTING.plan },
    ),
  )

  const [a, b] = plans
  if (!a || !b) {
    log('plan-two FAILED: one of the research→plan pipelines did not complete — see agent transcripts.')
    return
  }

  // Textual overlap is plain set intersection — no agent needed for this part.
  const sharedFiles = a.files.filter((f) => b.files.includes(f))
  log(`Footprints: A=${a.files.length} files (${a.planPath}), B=${b.files.length} files (${b.planPath}), shared=${sharedFiles.length}`)

  phase('Compare')
  const verdict = await agent(
    `Two implementation plans were just written for this repo. Read both in full:
- Plan A (${args.featureA}): ${a.planPath}
- Plan B (${args.featureB}): ${b.planPath}
Files both plans touch (exact-path intersection): ${JSON.stringify(sharedFiles)}

Decide whether the two features can be IMPLEMENTED IN PARALLEL (two sessions, two worktrees — see CLAUDE.md "Two concurrent features") or must be STACKED (land A, then re-check/rebase plan B).
Exact-path overlap is not the whole story — also check for SEMANTIC overlap: both plans changing the same behavior, table, API contract, or module through different files (e.g. one adds a migration whose absence the other's code assumes; both alter src/db/ query semantics). Recommend "parallel" only if merge-time interaction risk is genuinely low.

Then APPEND a "## Parallel/stack verdict (plan-two)" section to BOTH plan files stating the recommendation, the reasoning, the shared-file list, and the risk areas — so the verdict travels with the plans for human review.
Also return recommendation, reasoning, and riskAreas via the structured output schema.`,
    { label: 'compare:footprints', phase: 'Compare', schema: VERDICT_SCHEMA, ...ROUTING.compare },
  )

  log(`VERDICT: ${verdict ? verdict.recommendation.toUpperCase() : 'unavailable'} — ${verdict ? verdict.reasoning : 'compare agent failed'}`)
  log(`Next step: human-review both plans (verdict section appended to each), then implement accordingly — parallel: two sessions with claude --worktree + scripts/second-stack.sh; stack: implement A, land it, re-check plan B.`)
}

await run()
