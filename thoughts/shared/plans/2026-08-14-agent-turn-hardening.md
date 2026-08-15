# Plan: harden the agent turn against the three spine-eval failure classes

**Date:** 2026-08-14 · **Branch:** `feat/agent-turn-hardening` (new, off main)
**Evidence:** [2026-08-14-glm-5.2-inference-provider-options.md](../research/2026-08-14-glm-5.2-inference-provider-options.md)
(spine-eval Nebius run + 8-cycle repeat experiment). The three classes: M09 re-asks after
assent (2/5 on Nebius), Q04-class runaway reasoning (fired on BOTH providers), S04 fabricated
link (1/71, chance-level, but a hard-zero class).

Order: cheapest/highest-observed-rate first. Each phase lands independently.

---

## Phase 1 — Doctrine: assent takes the recommendation (fixes M09 class)

**File:** `Box_Setup_Stuff/bootstrap-box.sh`, the `## Confirmations — what needs a yes` heredoc
(delete-then-append refreshed block, currently rules 1–5, stamped "updated 2026-07-26").

Add rule 6 and bump the stamp to 2026-08-14:

> 6. When you have laid out options and marked a recommendation, and the person assents
>    without naming one ("yes", "go ahead", "sounds good"), TAKE THE RECOMMENDATION and act
>    on it — never answer an assent with "which one?". Ask which only when you gave no
>    recommendation, or when the choice itself is irreversible (rule 2).

Notes:
- The eval reads doctrine straight out of this heredoc (`src/eval/doctrine.ts`), so tier 2
  measures the new rule with no other wiring. Content edits inside an existing section are
  safe; only renaming/dropping a section breaks `npm test`.
- Grep for embedded copies of the confirmations block elsewhere in Box_Setup_Stuff (the
  runbook/setup-guide byte-identical-copy trap) and sync any found.
- Doctrine fingerprint will change (`335d29a5947b` → new) — expected; note it in the PR.

**Verify:** `npm test` (doctrine extraction + suite) → rebuild world → `--only M09 --yes` ×3
fresh-world cycles on Nebius (the provider that showed the failure): expect 3/3 pass, and the
transcript on at least one cycle showing options → "go ahead" → booking, no re-ask.

## Phase 2 — Harness: output-token cap + empty-completion retry (mitigates Q04 class)

**File:** `scripts/spine-eval/run-agent.mjs` (`chat()` + `readStream()`).

1. Add `max_tokens` to the request body, new flag `--max-output-tokens` (default 32768 —
   far above any legitimate turn observed tonight, small enough that a runaway dies at the
   cap in ~1–2 min even on a slow provider instead of at the 2× wall backstop).
2. Capture `finish_reason` in `readStream` (not currently read).
3. Treat a COMPLETED stream with no content, no tool calls (including `finish_reason:
   "length"` with empty content — the capped-runaway signature) as retryable, same as a
   stall: burn an attempt, log an `empty-retry` line, keep the time in the scenario's ms.
   Attempt cap (4) unchanged. A retry that also comes back empty falls through to the
   existing failure path — findings taxonomy unchanged.

Notes:
- This mirrors patterns that already exist in the repo (synthesis token ceiling +
  empty-completion retry; the watchdog's stall-retry) — no new concepts.
- Production fleet exposure is separately bounded by the gateway's 60s call timeout; a
  gateway-level max-token knob is a follow-up investigation when box access is back
  (out of scope here).

**Verify:** `npm run lint` (scripts are covered) → S04/Q04/M09 ×2 fresh-world cycles on each
provider with the cap active (no regression, no legit-turn cap hits — the run prints a line
if the cap ever fires) → one `--quick` run on DeepInfra (~$0.70) as a broader no-regression
check, expecting ≥ baseline 82.4% and zero cap hits.

## Phase 3 — Link guard: trades-weekday-guard v0.4.0, observe-only (fixes S04 class)

**Files:** `Box_Setup_Stuff/plugins/trades-weekday-guard/index.js` (+ version bumps in
`package.json` / `openclaw.plugin.json`), mirror tests in `src/control/weekdayGuardPlugin.test.ts`.

Design constraint (verified): the outbound hooks see only the outgoing text — no tool
results — so "URL must have come from a tool result" is not expressible in-plugin today.

1. New `scanLinks(text)` beside `scanMessage`: extract absolute URLs; allowlist hosts —
   the board host (from `BOARD_PUBLIC_URL`, default tradesdatabase.onrender.com), `t.me`,
   Google-Maps hosts (`maps.google.*`, `goo.gl`, `maps.app.goo.gl`) — anything else is
   flagged `{url, context}`.
2. **Observe-only fleet-side** (log records, never block/strip) — the same rollout shape
   the weekday guard itself used; act-mode is a later decision from observed rates.
   The eval's fabricated-link grader remains the hard gate.
3. Investigate (in-phase, vendor docs live per CLAUDE.md): does openclaw expose a
   tool-result-visible hook? If yes, note the upgrade path (session-scoped cache of
   tool-returned URLs → exact-match guard) for a v0.5 follow-up; do not build it now.
4. Mirror tests: S04's fabricated `dispatch.evalmain.com` URL flags; board/maps/t.me links
   pass; bare domains in prose don't flag.

**Deploy (deferred):** `plugins install --force` → `doctor --fix` → restart → verify startup
line, on each sandbox — needs box ssh; code + tests land now, deploy is its own step when
access returns. Follow the chmod-2770/660 install sequence (PR #126 lesson).

## Landing

- Gates on the branch: `npm run typecheck && npm run lint && npm test && npm run build`.
- Full tier-2 spine eval on Nebius post-fix (~$6): expect M09/S04 classes at zero; Q04
  runaway, if it recurs, now costs ≤ ~2 min and usually self-heals via retry.
- One PR (`feat/agent-turn-hardening`), research + this plan committed alongside.
- Update `docs/engineering-memory.md` (doctrine rule 6, guard v0.4.0 observe-only, harness
  cap/retry) + local memory per the standing sync rule.
