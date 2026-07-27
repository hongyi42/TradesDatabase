---
date: 2026-07-24
task: Make the inference provider declarative, gate any switch behind an acceptance suite, and baseline it on DeepInfra
research: thoughts/shared/research/2026-07-24-inference-provider-switching.md
status: draft
note: re-derived at HEAD 5bb7981 after main advanced 29 commits from the e03eb12 baseline the first pass used; the superseded 2026-07-21 drafts were discarded uncommitted.
---

## Overview

Make switching the agents' AI model provider a config change with a quality gate in front of it,
rather than archaeology across a bash script, one sandbox's JSON, and two markdown files.
**Readiness only — this plan does not switch providers.** It ends with the acceptance suite run
against the *current* provider, because a gate you have never executed is not a gate.

**Stacking:** requires the cost plan **merged and deployed to the pilot** (its Phase 4), not merely
merged — Phase 2 here reads `cost_rates` through `.env`, which points at the pilot. Alternatively
point the acceptance script at the local stack.

## Decisions

- **Scope = readiness + baseline** (user decision). Rejected: evaluating a named alternative (needs
  a second vendor key and live spend) and cutting over (nothing suggests you want off DeepInfra).
- **Custom base URLs are available** — verified against live docs: type `openai` accepts
  `--config OPENAI_BASE_URL`, and the type list is twelve, not six. The repo's recorded constraint
  (`doorman-nemoclaw-setup-guide.md:478`, dated 2026-07-06, **still present at HEAD**) is wrong;
  corrected in Phase 3. Consequence: no adapter layer — any OpenAI-compatible vendor is reachable.
- **No metering proxy** — it carried two jobs (reach arbitrary vendors, meter tokens). The first is
  free now; the second doesn't justify hot-path code given two recorded DeepInfra outages.
- **Registry lives in this repo AND renders into `Box_Setup_Stuff/`** — CLAUDE.md and
  `engineering-memory` §1 require that directory to be self-contained (the box-side Claude cannot
  read this repo; "see docs/X" is forbidden there).
- **The registry records the pricing TIER** *(new — research finding)*. DeepInfra now publishes
  three tiers (Standard, Priority 1.5×, Flex 0.8×) and the live tier is recorded nowhere in this
  repo, which makes every inference cost figure uncertain by up to 1.9×.
- **The cost join is `costProvider` + a three-SKU map, not one `rateSku`** — the cost plan seeds
  three SKUs per model, and its `provider` vocabulary (`deepinfra`) differs from registry keys
  (`deepinfra-prod`) and types (`deepinfra`). One string cannot address those rows. **This join
  serves the acceptance script only** — the ledger stores inference as `method:'allocated'`.
- **Per-tenant provider keys are out of scope** — routing is gateway-scoped, so they'd require one
  gateway per tenant. Noted as an open path, not built.
- **Capability flags move into the registry** — `compat.supportsPromptCacheKey` exists only in s2's
  rendered JSON and is silently wiped by any rebuild. Given cached input is 5.2× cheaper than
  uncached and input is ~98.6% of spend, this flag is a bigger lever than the model's sticker
  price. A live bug in a running experiment, fixed here regardless of any switch.

## Plain-language walkthrough

**Phase 1 — one place for provider facts.** Today a switch means remembering that DeepInfra spells
the model `zai-org/GLM-5.2` while NVIDIA spells it `z-ai/glm-5.2`, that one sandbox has a caching
flag the others lack, that a shell script hardcodes both provider names, and that nothing anywhere
records which price tier you are on. This phase puts all of it in one declarative file with
citations and dates, and makes the failover script read from it.

```
 BEFORE                                  AFTER
 medic.sh constants ─┐                   src/inference/providers.ts
 s2's openclaw.json ─┼─ must agree  ──►   (type, baseUrl, modelId, capabilities,
 2 markdown files   ─┘  …nothing          limits, tier, costProvider, rateSkus{},
 price + tier: nowhere  enforces it        catalogUrl, verifiedOn)
                                                  │
                                    ┌─────────────┴──────────────┐
                                    ▼                            ▼
                            rendered .env for the box     joins cost_rates
                            (medic.sh sources it)         (acceptance script)
```

**Phase 2 — a gate with teeth.** `scripts/eval-date-reliability.mjs` already measures how often the
agent gets a calendar date right, parameterised by provider/URL/model. This phase wraps it into a
suite covering the behaviours that have actually bitten you, then runs it against DeepInfra to
record what "good" currently looks like. Without that baseline a future candidate's score is
meaningless.

**Phase 3 — the runbook and the stale doc.** Writes down the switching procedure (pre-flight,
canary on **s2 only** — never Judy's s3, cutover, rollback), corrects the refuted constraint, and
closes the capability-flag drift hole.

## Secrets & env preflight

- **Phase 1:** none
- **Phase 2:** `EVAL_INFERENCE_API_KEY`, `EVAL_INFERENCE_BASE_URL`, `EVAL_MODEL`, `EVAL_PROVIDER`,
  **`EVAL_OUT`** — five vars, read by `scripts/eval-date-reliability.mjs` at **lines 119–121, 133,
  and 236** (not the header comment). None are in `.env.example`; add all five. **Live model spend
  applies.**
  ⚠️ `EVAL_PROVIDER` defaults by *presence* of `EVAL_INFERENCE_API_KEY` (:119) and the anthropic
  branch authenticates with `ANTHROPIC_API_KEY` (:152) — an unset key does **not** skip, it
  silently spends against your Anthropic account. Phase 2 adds an explicit gate.
- **Phase 3:** none. Box work needs ssh to trades-box-1 (key at `~/.ssh/tradesbox_ed25519`, user
  `ubuntu`) plus `export PATH=$HOME/.local/bin:$PATH` — non-interactive ssh lacks `nemoclaw` on PATH.

---

## Phase 1: Declarative provider registry

### What this phase does
One source of truth for provider facts; the failover script consumes it.

### Changes required

**`src/inference/providers.ts`** (new)
```ts
export interface ProviderSpec {
  type: 'deepinfra' | 'nvidia' | 'openai' | 'anthropic' | 'aws-bedrock';
  modelId: string;              // EXACT vendor spelling — differs per provider
  baseUrl: string;
  tier: string;                 // 'standard' | 'priority' | 'flex' — changes cost up to 1.9x
  capabilities: { promptCacheKey: boolean };
  limits: { concurrent?: number };
  costProvider: string;         // === cost_rates.provider, e.g. 'deepinfra'
  rateSkus: { input: string; output: string; cachedInput: string };
  catalogUrl: string;           // how to re-verify the model id is live
  verifiedOn: string;           // YYYY-MM-DD — treat as stale after ~30 days
}
export const PROVIDERS: Record<string, ProviderSpec> = { … };
export const PRIMARY = 'deepinfra-prod';
export const FALLBACK = 'nvidia-prod';
```
Seed `deepinfra-prod` (`zai-org/GLM-5.2`, `promptCacheKey:true`, concurrent 200,
`costProvider:'deepinfra'`, skus `glm-5.2-input`/`-output`/`-cached-input`) and `nvidia-prod`
(`z-ai/glm-5.2`). The differing id spellings have already caused live 410s and 404s.

**`scripts/render-provider-env.mjs`** (new) — emits `Box_Setup_Stuff/provider-registry.env`
(`WANT_PROVIDER`, `WANT_MODEL`, `FALLBACK_PROVIDER`, `FALLBACK_MODEL`). Output is **committed** —
the box-side Claude cannot read this repo.

**`Box_Setup_Stuff/nemoclaw-inference-medic.sh`** — replace the constants at **lines 34–37**
(confirmed unchanged at HEAD). The script runs under `set -euo pipefail` (:31), so:
```sh
[ -r /usr/local/sbin/provider-registry.env ] && . /usr/local/sbin/provider-registry.env
WANT_PROVIDER="${WANT_PROVIDER:-deepinfra-prod}"   # literal fallback: an undeployed
WANT_MODEL="${WANT_MODEL:-zai-org/GLM-5.2}"        # registry must never leave the box routeless
```
A bare `.` of a missing file — or `[ -f … ] && …` as a block's final command — exits under `-e`,
and `bash -n` will not catch it. Keep every existing comment block; it is the box Claude's only
context.

**`Box_Setup_Stuff/doorman-architecture-memory.md`** — point the model-id section at the rendered
env file, inlining current values (no cross-repo references).

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] new `src/inference/providers.test.ts`: every entry has non-empty `modelId`, `baseUrl`, `tier`,
      `costProvider`, all three `rateSkus`, `catalogUrl`, `verifiedOn`; `PRIMARY`/`FALLBACK` resolve
      and differ
- [ ] new test: every `costProvider` + `rateSkus` value matches a seeded `cost_rates` row — catches
      vocabulary drift between the two plans
- [ ] new test: rendered output parses as shell `KEY=value` (assert the real rendered string)
- [ ] `bash -n Box_Setup_Stuff/nemoclaw-inference-medic.sh`
- [ ] new test: committed `provider-registry.env` matches a fresh render — catches a registry edit
      that forgot to re-render

### Live verification (agent-executable)
- Prerequisites: ssh to trades-box-1 (`~/.ssh/tradesbox_ed25519`, user `ubuntu`).
- [ ] `openshell inference get` confirms the live route matches `PRIMARY`. If not, fix the registry,
      not the box.
- [ ] Copy `provider-registry.env` to `/usr/local/sbin/`, force one medic run, confirm via
      `journalctl` that it sourced the file and asserted the **same** route as before — the refactor
      must be operationally invisible. This is the phase that changes the script, so the proof
      belongs here.

### Manual verification
- [ ] Confirm on the DeepInfra dashboard which tier the account is on, and that `tier` in the
      registry matches. Nothing in the repo can verify this.

---
*Pause after this phase for the manual check.*

## Phase 2: Provider acceptance suite + DeepInfra baseline

### What this phase does
Wraps the existing eval into a multi-check suite and records the current provider's score.

### Changes required

**`scripts/eval-date-reliability.mjs`** — add the repo's standard CLI guard
(`if (process.argv[1] === fileURLToPath(import.meta.url))`, as in
[lifecycle.ts:164](../../../src/jobs/lifecycle.ts#L164) and
[httpServer.ts:334](../../../src/mcp/httpServer.ts#L334)) and export `runDateEval()`. **Required**:
the file is 238 lines of top-level code with a top-level `await` at :206, so importing it fires the
whole live-model matrix as a side effect and returns nothing. Alternative if refactoring is
unwanted: spawn it via `child_process` with `EVAL_OUT` at a temp file and parse the JSON.

**`scripts/provider-acceptance.mjs`** (new) — same CLI guard so the fixture tests can import its
scorer. **Explicit key gate at the top**: exit 0 with a skip notice when `EVAL_INFERENCE_API_KEY`
is unset, rather than silently falling through to the Anthropic branch. Checks, each derived from a
recorded live failure:

| Check | Why it exists |
|---|---|
| Date/weekday reliability | delegates to `runDateEval()`; the 2026-07-21 weekday bug |
| Required tool params emitted | GLM skipped `endTime` → PR #53 made it required |
| Result-directive compliance | the fabricated `board.example.com` URL, 2026-07-21 |
| Multi-turn destructive confirm | the two-step confirm flow must survive |
| Tool-surface drivability | "run bridge code failed" disqualified Nemotron entirely |
| Latency p50/p95 | ~84s serial round-trips is a recorded open concern |
| Cost per representative turn | tokens × `cost_rates` via `costProvider` + `rateSkus` × `tier` |

Per-check status recorded independently (mirroring `runLifecycle`'s isolation); one check erroring
must not void the others. Non-zero exit on any check below threshold. Writes
`thoughts/shared/research/provider-baselines/<provider>-<date>.json`.

**`.env.example`** — add all five `EVAL_*` names with a comment naming this script.

**`package.json`** — `"provider:accept": "node -r dotenv/config scripts/provider-acceptance.mjs"`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] new test: the scorer returns the expected verdict from **recorded transcript fixtures** (no
      network) — one fixture per known failure mode above, each asserting the corresponding check
      actually **fails**. A gate that passes its own counter-example is worthless.
- [ ] new test: one check throwing leaves the others' results intact, marking only that one errored
- [ ] new test: with `EVAL_INFERENCE_API_KEY` unset the script exits 0 and makes no network call
- [ ] new test: importing `eval-date-reliability.mjs` runs nothing (CLI guard holds)

### Live verification (agent-executable)
- Prerequisites: five `EVAL_*` vars set with the DeepInfra key; the cost plan **deployed to the
  pilot**, or the script pointed at the local stack. **Real inference spend.**
- [ ] `npm run provider:accept` against `deepinfra-prod` / `zai-org/GLM-5.2`; commit the baseline
      JSON. Every future candidate is compared to this.
- [ ] Cost-per-turn is non-null and reconciles with a hand calculation at the tier's rates —
      proves the `costProvider` + `rateSkus` join works end to end.

### Manual verification
- [ ] Read the baseline report and judge whether the thresholds sit where you'd actually block a
      switch — too lax is worse than no gate

---
*Pause after this phase for the manual check.*

## Phase 3: Switching runbook, drift fix, stale-doc correction

### What this phase does
Writes the procedure down, closes the flag-drift hole, corrects the refuted constraint.

### Changes required

**`docs/provider-switching-runbook.md`** (new) — pre-flight (verify the model id against the
vendor's live catalog **from the host**; `nemoclaw --verify` cannot reach out from inside the
egress-restricted gateway container. Add `cost_rates` rows with `effective_from` = cutover date.
Run `npm run provider:accept`, compare to baseline). Canary (**s2 only — never s3; Judy is a real
customer**; soak 48h). Cutover (edit registry → re-render → deploy → `gateway restart` per sandbox;
keep the old provider configured as instant rollback). Rollback (one registry edit, ≤5 min via the
medic timer). After (set `effective_to` on old rate rows so history re-prices). Standing traps:
re-assert the route after any `onboard`/`rebuild`; MCP tool descriptions are fetched once per
process so description changes need container restarts; the gateway serves a **cached `tools/list`**
and **truncates AGENTS.md at 12,000 chars** (newly recorded in `engineering-memory`); prefer
`gateway restart` over `rebuild` (rebuild can strip the device private key).

**`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:478`** — the sentence *"Gateway-level custom
providers (e.g. OpenRouter) are NOT possible: cluster inference accepts only
openai/anthropic/nvidia/deepinfra/google-vertex-ai/aws-bedrock"* is **refuted**. Replace with the
verified twelve-type list, the `--config OPENAI_BASE_URL` syntax, a citation to
https://docs.nvidia.com/openshell/sandboxes/manage-providers, and a `verified 2026-07-24` stamp.
Note that routing remains gateway-scoped, citing
https://docs.nvidia.com/openshell/sandboxes/inference-routing.

**`Box_Setup_Stuff/bootstrap-box.sh`** — the script installs `badge-pull.sh` (:392),
`recycle-sandbox.sh` (:457), `sandbox-token-medic.mjs` (:856), `nemoclaw-agent-revive.sh` (:863) —
but **never installs `nemoclaw-inference-medic.sh` or its units**. Install the medic script (700),
its `.service`/`.timer`, and `provider-registry.env` (644) in one block using the existing
`install_unless_same` helper. Without this a fresh box gets a registry file and no consumer.

**`docs/engineering-memory.md`** — §4: fold the `supportsPromptCacheKey` trial note into a pointer
at the registry, and record the DeepInfra tier structure. §3/§5: record the corrected provider
constraint with its citation, as another instance of the uncited-vendor-claim class already
documented for Composio.

### Automated verification
- [ ] `bash -n Box_Setup_Stuff/bootstrap-box.sh`
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass
- [ ] grep confirms the refuted sentence appears nowhere in `Box_Setup_Stuff/`

### Live verification (agent-executable)
- Prerequisites: ssh to trades-box-1.
- [ ] `openshell inference get` still reports `deepinfra-prod / zai-org/GLM-5.2`
- [ ] `systemctl status nemoclaw-inference-medic.timer` shows the unit active after a
      bootstrap-script dry run on a scratch path

### Manual verification
- [ ] Read the runbook as if doing a switch at 11pm with something broken — does it tell you what
      to do without this repo open?
- [ ] The corrected setup-guide section is self-contained (no "see docs/X") — the box-side Claude
      cannot follow references

---
*Pause after this phase for the manual checks.*

## Deliberately not built

- **Per-tenant gateways** for per-tenant provider keys — documented
  (`NEMOCLAW_GATEWAY_PORT=<port> nemoclaw onboard`), untested, only worth it if exact per-tenant
  inference attribution becomes load-bearing.
- **A metering proxy** — reach is free now; metering alone doesn't justify hot-path code.
- **Evaluating an alternative vendor** — user scoped out; the suite makes it a one-command job.
- **Moving to the Flex tier** (0.8× across the board) — a real ~20% lever surfaced by this
  research, but a pricing/ops decision, not a readiness one.
