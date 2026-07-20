# Long-running / bulk agent tasks — chunked, resumable batching

**Status (2026-07-20):** decision made and mechanism shipped (2026-07-09); **compliance
verification still open** — that's the work this doc hands off. Origin: this is the repo copy of
an operator-session memory; the full cited research lives in
[thoughts/shared/research/2026-07-08-long-running-agent-tasks.md](../thoughts/shared/research/2026-07-08-long-running-agent-tasks.md).

## The problem

The Telegram agents (OpenClaw sandboxes running GLM-5.2) sometimes get handed a task far bigger
than one conversation turn — "clean my 38,000-email inbox", "re-tag every record". Left alone,
the model tries to do it all in one go: it keeps every touched item in the conversation, the
prompt balloons, and the run dies at the per-run timeout with **no resumable progress**.

**Triggering incident (2026-07-08):** Judy's beta box (sandbox s3) was cleaning a ~38k-email
inbox. It streamed actively for the full 10 minutes, ballooned the prompt to ~115k tokens, and
was killed by the `agents.defaults.timeoutSeconds=600` cutoff. A follow-up Composio
remote-workbench batch call also timed out. Nothing was recorded, so a retry would start from
zero.

## What the research established

(Deep-research pass 2026-07-09, verified against live vendor docs — citations in the research
artifact.)

- **The 115k blow-up was a harness/config budget, not the model's context window.** GLM-5.2 via
  DeepInfra genuinely has a 1M-token window. But no window saves us: 38k emails ≈ 7.6M+ tokens,
  10–40× past it. **Batching is structural, not a workaround for a small window.**
- **Anthropic's platform context features (compaction, context editing, the memory tool) are
  Claude-API-only** — not available on our GLM-5.2 / DeepInfra / OpenClaw runtime. Only
  prompt-level patterns transfer.
- Field consensus (Anthropic "effective harnesses for long-running agents", OpenAI Batch API):
  **assume interruption → record progress externally → resume in a fresh small window.**

## The decision

**Option B — chunked/resumable batching**, task-agnostic (email is just one instance).
Option A (raise the per-run timeout) was rejected: it doesn't scale to 38k items, context still
bloats, and it spends more tokens for less durable progress.

This is **prompt engineering, not spine code**: the behavior lives in each sandbox's
`AGENTS.md` (the agent's standing instructions), not in TypeScript.

## What shipped, and where it lives

The "§0d batching block", appended into every sandbox's
`/sandbox/.openclaw/workspace/AGENTS.md` by
[Box_Setup_Stuff/bootstrap-box.sh](../Box_Setup_Stuff/bootstrap-box.sh) (search for
`batching block (§0d`). Mirrored in `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` §6 and
referenced in [docs/nemoclaw-tech-agent.md](nemoclaw-tech-agent.md). A sandbox **rebuild wipes
AGENTS.md** — the block comes back on the next `bootstrap-box.sh wire` run.

The loop it prescribes:

```
            ┌──────────────────────────────────────────────┐
            │ read task-progress/<task>.md (the cursor)    │◄─── every turn that
            └──────────────┬───────────────────────────────┘     continues the task
                           ▼
            ┌──────────────────────────────────────────────┐
            │ pull ONE small batch (~300–500 items)        │
            │ process it — never load the whole list       │
            └──────────────┬───────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────┐
            │ append outcome to progress file, advance     │
            │ cursor, let the processed items go           │
            └──────────────┬───────────────────────────────┘
                           ▼
            ┌──────────────────────────────────────────────┐
            │ near the time limit? STOP cleanly, report    │
            │ honest numbers ("1,200 of ~38,000"), wait    │──► "continue" → top
            └──────────────┬───────────────────────────────┘
                           ▼ (task done)
            ┌──────────────────────────────────────────────┐
            │ distill learnings → MEMORY.md (terse);       │
            │ durable customer/job facts →                 │
            │ record_standing_fact / record_field_note;    │
            │ delete the progress file                     │
            └──────────────────────────────────────────────┘
```

Key design points:

- The cursor is a **plain file** (`task-progress/<task>.md`) in the sandbox workspace — NOT
  auto-loaded into context, deliberately (it's verbose scratch). A one-line pointer in the daily
  note lets a fresh session find it.
- Each resume turn starts nearly empty and touches only its own batch.
- On completion, lasting business facts are routed to the **spine** (permanent,
  evidence-linked), because OpenClaw's own memory does not survive a rebuild.

Related OpenClaw memory facts (verified against docs.openclaw.ai/concepts/memory, 2026-07-09):
`MEMORY.md` auto-loads per session (oversized → truncated — keep it terse); daily notes
`memory/YYYY-MM-DD.md` auto-load for today+yesterday; **a rebuild wipes all of it**, so
agent-authored memory is never the durable home for business knowledge — the spine is.

## Open work (the handoff)

The block **steers** the model but nothing **enforces** it — and this repo has repeatedly seen
GLM-5.2 ignore standing instructions under pressure (the endTime default incident, the
"next week" boundary miss). Before trusting this at scale:

1. **Run a real large-inbox compliance test.** Point a sandbox at a genuinely large mailbox and
   verify from the box side that it: creates/reads `task-progress/`, keeps batches ~300–500,
   stops cleanly before the 600s cutoff, resumes from the cursor, and reports honest counts.
   Evidence = the progress file's history + gateway logs, not the agent's self-report.
2. **Check OpenClaw workspace sync mode** (`mirror` vs `remote`) on our boxes — it affects
   whether the progress file behaves as assumed.
3. **If the model won't comply, harden at the mechanism, not the prompt** (the recurring lesson
   here — see the confirmation-doctrine history): e.g. cap items per tool response server-side,
   or have bulk-capable tools paginate and return an explicit cursor so batching is the only
   possible shape. Ideas, not decisions — scope them if (1) fails.

## Related

- Research: `thoughts/shared/research/2026-07-08-long-running-agent-tasks.md`
- Side-finding parked as **Feature D**: the only live L3-attribute writer lands on the *visit*
  (`recordFieldNote` → `createVisit`); customer/job `attributes` columns exist with no live
  writer — standing per-customer facts had no clean home. (`record_standing_fact` has since
  shipped for durable key/value facts; re-check the remaining gap before building.)
- Agent model + timeout config: [docs/nemoclaw-tech-agent.md](nemoclaw-tech-agent.md),
  `Box_Setup_Stuff/doorman-architecture-memory.md`.
