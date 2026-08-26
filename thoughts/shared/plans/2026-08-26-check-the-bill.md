---
date: 2026-08-26
task: Check our derived model spend against Anthropic's own usage and billing records
research: thoughts/shared/research/2026-08-25-planner-tick-observability.md
status: draft
supersedes: nothing
---

## Overview

Our spend figure is **measured tokens × hand-typed prices**. The token counts come from the vendor's
own reply and are trustworthy; the prices are rows a person entered from a pricing page
(`cost_rates`, last checked 2026-08-24). Nothing has ever compared the result to a real bill. This
plan adds one operator command that does.

**Depends on** `thoughts/shared/plans/2026-08-26-the-tick-leaves-a-trace.md` Phase 3 — the `lane`
label and `priced_cost_events_daily` / `unpriced_cost_events_daily` views. Do not start before that
phase has landed.

**Blocked on credentials** the parent plan does not need — see the preflight. Collect them first.

## Decisions

- **Token-first, dollars-second.** Anthropic's `usage_report/messages` filters by **API key**, so its
  token counts compare like for like against ours. `cost_report` groups only by workspace, so today
  its dollars are **organization-wide** — Claude Code, playground and evals included. The script
  prints both and labels the dollar side a **bound** (ours ≤ theirs), never an equality. It becomes
  an equality only if the app gets its own workspace, which is a follow-up, not part of this plan.
- **The Admin key never goes on Render.** It is an org-admin credential: it reads all usage and cost
  and can rename or deactivate any API key. This is a **local operator script**, never a cron step
  and never a web route. (`data-security` §3, least privilege / custody.)
- **The diff logic lives in `src/`, not the script.** Day alignment is where an off-by-one silently
  produces a fake gap, so it is a pure, unit-tested function; the `.mjs` script imports it from
  `dist/` — the `scripts/seed.mjs` idiom.
- **Pagination is followed to exhaustion.** Both endpoints page. A truncated read under-reports, and
  a quietly low cost figure is the exact failure the whole ledger design exists to prevent
  (`cost_ledger.sql:1`–`:8`).
- **Read-only, both sides.** No writes to `cost_events`, no correction of history. The output is a
  report; acting on a discrepancy (re-seeding a rate, fixing `MODEL_SKUS`) is a separate decision
  with its own evidence.
- **Anthropic only.** Fireworks (GLM, the box agents) bills separately and has its own API. Out of
  scope; the report says so on its face rather than implying the total is complete.
- **`--since` defaults to the last 7 whole UTC days.** Whole days because `cost_report` is daily-only;
  UTC because every stored timestamp is UTC and the rate join already casts
  `at time zone 'utc'` (research constraint 9).

## Plain-language walkthrough

Every time the AI answers, it reports how much work it did, and we save that number. To turn work
into money we multiply by a price list someone typed in by hand. Nobody has ever checked the answer.

This adds one command, `npm run costs:reconcile`, that asks Anthropic what **it** recorded and prints
the two side by side:

```
        ours (calculated)              theirs (Anthropic's own records)
        ──────────────────             ────────────────────────────────
tokens  from each reply, saved   ←──►  usage report, filtered to OUR key   = exact match expected
money   tokens × typed prices    ←──?  cost report, whole account          = ours should be LOWER
```

The **token** row is the real test: same traffic, both sides, so any gap is a defect in how we
record. The **money** row is weaker for now — Anthropic's dollars cover everything on the account,
including your own Claude Code use — so it only proves ours isn't somehow *higher* than the whole
bill. That becomes exact if the app is later moved into its own workspace.

Two things it would catch that nothing catches today: a price that changed and nobody noticed, and
the model-assumption trap — the code maps "Anthropic" to Opus 5 prices, so a switch to a cheaper
model without editing that map would bill cheap traffic at expensive rates
(`costs.ts:127`, which carries the warning in a comment).

You'd notice it working the first time you run it: a token gap under about 2% means our recording is
sound, and any dollar difference is then a price-list question, not a counting question.

## Secrets & env preflight

**BLOCKING — collect all three before starting.**

- `ANTHROPIC_ADMIN_KEY` (`sk-ant-admin01-…`) — Claude Console → Settings → API keys → Admin keys.
  **Local `.env` only; never set on Render.** Requires an **organization** account: the Admin API is
  explicitly unavailable for individual accounts, so this is an account-setup step, not a code step.
- `ANTHROPIC_LEDGER_KEY_ID` (`apikey_…`) — the id of the key the deployed app actually uses. The
  script lists candidates from `GET /v1/organizations/api_keys` and exits when this is unset, so it
  is discoverable rather than guessed.
- `DATABASE_URL` — *already required* by `npm run metrics:planner`.

---

## Phase 1: The diff, in code and tested

### What this phase does
Adds the pure day-alignment logic and its tests, with no network calls. Leaves the repo working and
verifiable before any credential exists — so this phase can land even if the account setup stalls.

### Changes required

**`src/costs/reconcileDiff.ts`** (new)
```ts
export interface DaySpend { day: string; tokens: number; usd: number | null }
export interface DayDiff {
  day: string;
  ours: DaySpend | null;
  theirs: DaySpend | null;
  tokenGapPct: number | null;   // null when both sides are 0 — never a divide-by-zero
  missing: 'ours' | 'theirs' | null;
}
export function diffByDay(ours: DaySpend[], theirs: DaySpend[]): DayDiff[]
```
- Full outer join on `day`, sorted ascending, **every** day in the union present — a day missing from
  one side is a row flagged `missing`, never a silently dropped row. That asymmetry is the finding
  the report exists to surface.
- `tokenGapPct` = `(ours - theirs) / theirs * 100`, `null` when `theirs === 0`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] new test: matching days produce `tokenGapPct: 0` and `missing: null`
- [ ] new test: a day present only in ours → `missing: 'theirs'`; only in theirs → `missing: 'ours'`;
      both rows still appear in the output
- [ ] new test: `theirs.tokens === 0` yields `tokenGapPct: null`, not `Infinity` or `NaN`
- [ ] new test: input arrays in scrambled order still come back ascending by day

### Live verification (agent-executable)
- Prerequisites: none — this phase is pure
- [ ] n/a

### Manual verification
- [ ] none

---

## Phase 2: `npm run costs:reconcile`

### What this phase does
Wires the diff to both sides: our views, and Anthropic's Admin API.

### Changes required

**`scripts/costs/reconcile.mjs`** (new) — `pg` + `DATABASE_URL`, modelled on
`scripts/planner-metrics/report.mjs`; imports `diffByDay` from `../../dist/costs/reconcileDiff.js`.

Startup guards, in order, each exiting non-zero with the variable named — it must never half-run:
1. `ANTHROPIC_ADMIN_KEY` unset → exit.
2. `ANTHROPIC_LEDGER_KEY_ID` unset → `GET /v1/organizations/api_keys?limit=50`, print
   `id · name · workspace_id · status`, exit telling the operator which to set.

Then, for the window (`--since` / `--until`, default last 7 whole UTC days):
- **Ours** — `priced_cost_events_daily` where `provider = 'anthropic'`, grouped by day (and by lane
  for the breakdown), plus the `unpriced_cost_events_daily` count for the same window.
- **Theirs, tokens** — `GET /v1/organizations/usage_report/messages?bucket_width=1d`
  `&api_key_ids[]=$ANTHROPIC_LEDGER_KEY_ID&group_by[]=model`. Sum the four token classes
  (uncached input, cached input, cache creation, output) to match what `recordModelUsage` writes
  (`costs.ts:182`–`:230`) — **not** input+output alone, or cache activity would read as a gap.
- **Theirs, dollars** — `GET /v1/organizations/cost_report&group_by[]=description`. Costs come back
  as **decimal strings in cents** — convert once, explicitly. Print under a header stating it is
  organization-wide and that **Priority Tier is excluded** from this endpoint.
- Follow `has_more` / `next_page` to exhaustion on both. Poll no faster than once a minute.
- Headers: `x-api-key: $ANTHROPIC_ADMIN_KEY`, `anthropic-version: 2023-06-01`.

Output — one table from `diffByDay`, then a verdict block:
- token gap **> 2%** → flagged as a defect in *our recording* (a missing `usage` block, a mis-summed
  cache tier), pointing at `recordModelUsage`;
- tokens matching but dollars implausible → a *price-list* problem: a stale `cost_rates` row, or the
  `MODEL_SKUS` model assumption (`costs.ts:127` assumes `ANTHROPIC_MODEL=claude-opus-5`);
- any non-zero unpriced count → priced totals have been under-reporting, and the report says so
  rather than printing a clean-looking dollar figure;
- a closing line naming Fireworks/GLM as **not covered**.

**`package.json`** — `"costs:reconcile": "npm run build && node -r dotenv/config scripts/costs/reconcile.mjs"`

**`docs/engineering-memory.md`** — record: our spend is measured tokens × hand-typed prices; its five
drift modes (stale price, model-assumption, unpriced-vanishes, allocated-vs-measured, no
reconciliation); that `costs:reconcile` is the only check on it; and that per-firm API keys were
rejected (Anthropic cannot create keys programmatically; per-workspace prompt-cache isolation would
multiply our 2x cache writes by the customer count).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] `npm run costs:reconcile` with `ANTHROPIC_ADMIN_KEY` unset exits non-zero naming the variable,
      and makes **no** database connection (assert by running with `DATABASE_URL` unset too)
- [ ] `npm run costs:reconcile` with the key set but `ANTHROPIC_LEDGER_KEY_ID` unset prints the
      candidate key list and exits non-zero

### Live verification (agent-executable)
- Prerequisites: `ANTHROPIC_ADMIN_KEY` + an organization account + `ANTHROPIC_LEDGER_KEY_ID`;
  `DATABASE_URL` on the pilot. The script issues **read-only** SQL — confirm by reading it before
  running against the pilot.
- [ ] `npm run costs:reconcile -- --since 7d`; capture the full table. **Record the measured token
      gap in this plan's closing notes** — it is the number the plan exists to produce and has never
      been measured.
- [ ] Confirm the unpriced count is 0 for Anthropic in the window, answering the research's standing
      open question ("has `unpricedEvents` ever been non-zero?"). Non-zero = priced totals have been
      under-reporting, and that is a finding to raise, not a number to note.
- [ ] Sanity-check the direction: ours must be **≤** the organization-wide dollar figure. Ours coming
      out higher means a price row is wrong, and is a stop-and-report.

### Manual verification
- [ ] Read the verdict block and decide whether the ~3-workspace lane split is worth doing — it is
      what would turn the dollar comparison from a bound into an exact match. Out of scope here; this
      phase produces the evidence for that call.

---

*Phase 1 has no manual checks — the implementer continues. Pause after Phase 2: its manual check is
non-empty, and its live checks cannot run until the credentials above exist.*
