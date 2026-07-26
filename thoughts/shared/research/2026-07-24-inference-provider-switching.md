---
date: 2026-07-24
branch: feature/cost-dashboard
commit: 5bb7981
topic: Inference provider switching — configuration surface, what varies per provider, and where those facts live
note: re-derived at HEAD 5bb7981 after main advanced 29 commits from the e03eb12 baseline the first pass used; the superseded 2026-07-21 drafts were discarded uncommitted.
---

## Summary

This documents how the agents' AI model provider is configured and what a deliberate switch would
touch. Plain language: every manager and technician talks to an AI agent over Telegram; that
agent's "brain" is a model (GLM-5.2) rented from an outside company (DeepInfra). The question is
what it would take to rent it from someone else.

Re-verified at commit `5bb7981` after `main` advanced 29 commits. **Every repo-side anchor in the
prior research is unchanged** — the 4a/4a.5 work was board and scheduling surface, and touched no
inference configuration. What did change is outside the repo: **DeepInfra's input price moved
$0.95 → $0.93 in three days and a third pricing tier appeared**, which is the sharpest available
argument for the cost ledger storing units rather than dollars.

Two findings continue to dominate. **A constraint recorded in this repo is refuted by live vendor
documentation** — `doorman-nemoclaw-setup-guide.md:478` still states that gateway-level custom
providers are impossible, when the current docs document a custom base URL on the `openai` type
that makes any OpenAI-compatible vendor reachable. **And provider-switching machinery already runs
in production** — the inference medic fails DeepInfra over to NVIDIA and back on a 5-minute timer.
What does not exist is one declarative place where provider facts live.

## Entry Points

Provider configuration is not in this repo's TypeScript:

| Location | Role | Status at HEAD |
|---|---|---|
| [Box_Setup_Stuff/nemoclaw-inference-medic.sh](../../../Box_Setup_Stuff/nemoclaw-inference-medic.sh) | The live switch. Constants at **lines 34–37**; `set -euo pipefail` at 31 | unchanged |
| `nemoclaw-inference-medic.{service,timer}` | 5-min timer + boot unit | unchanged |
| [Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:478](../../../Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md) | Provisioning; **carries the refuted constraint** | unchanged |
| [Box_Setup_Stuff/doorman-architecture-memory.md](../../../Box_Setup_Stuff/doorman-architecture-memory.md) | Model-line history, id-spelling warnings | +6 lines, none about inference |
| `docs/engineering-memory.md` §2, §4 | Standing model decision; s2 prompt-cache trial | +43 lines, none about inference |
| s2's rendered `openclaw.json` on the box | `compat.supportsPromptCacheKey` — **one sandbox, not in version control** | unchanged |
| [scripts/eval-date-reliability.mjs](../../../scripts/eval-date-reliability.mjs) | The only provider-parameterized harness | unchanged |

## Key Files

**`Box_Setup_Stuff/nemoclaw-inference-medic.sh`** — the production switch and the best existing
model for a deliberate one. Its mechanism is notable: `openshell inference set` **live-verifies
the endpoint and key before saving**, so one call is both health probe and switch. Constants:

```sh
WANT_PROVIDER="deepinfra-prod"
WANT_MODEL="zai-org/GLM-5.2"     # NOTE: DeepInfra id spelling
FALLBACK_PROVIDER="nvidia-prod"
FALLBACK_MODEL="z-ai/glm-5.2"    # NOTE: NVIDIA id spelling (dashed differently)
```

Failure semantics per its header: primary success → done; primary fails → try fallback, loud
failover, automatic failback on the next healthy run, no state file; both fail → exit 1.
Worst-case dead-agent window is one timer interval plus validation.

**`scripts/eval-date-reliability.mjs`** — measures how often the agent lands on the correct
calendar date, with ground truth computed independently of `src/schedule/dateResolve.ts`.
Parameterized by `EVAL_PROVIDER`, `EVAL_INFERENCE_BASE_URL`, `EVAL_MODEL`,
`EVAL_INFERENCE_API_KEY` (read at lines 119–121 and 133) and `EVAL_OUT` (line 236). **It has no
exports**: 238 lines of top-level code with a top-level `await` at line 206, so importing it runs
the whole live-model matrix as a side effect. It always exits 0.

**`src/mcp/server.ts`** — carries the tool descriptions the model consumes; now **35 tools**. Two
constraints bear on a switch: MCP tool descriptions are fetched once per process (so description
changes need container restarts), and `engineering-memory` now records that the gateway
**truncates AGENTS.md at 12,000 characters** and serves a cached `tools/list`.

## Data Flows

```
 sandbox s2 ─┐
 sandbox s3 ─┼─► ONE gateway on trades-box-1 ─────► DeepInfra  zai-org/GLM-5.2
 sandbox s5 ─┘        │                                  ▲
                      │                                  │ re-asserted every 5 min
                      │                            ┌─────┴──────────────┐
                      │                            │ inference-medic.sh │
                      │                            └────────────────────┘
              GATEWAY-SCOPED: "Every sandbox on that gateway
              sees the same inference.local backend."
```

A deliberate switch touches, in order: the medic's constants → `openshell inference set` (validates
before saving) → per-sandbox `gateway restart` → verify with `openshell inference get`. The route
**forces the model id per request**, so sandbox configs need no change for a model swap.

## External Dependencies

Provider-mechanism findings verified 2026-07-21; pricing re-verified 2026-07-24.

**Provider types accepted by `openshell provider create`:** `anthropic`, `aws-bedrock`, `claude`,
`codex`, `copilot`, `deepinfra`, `generic`, `github`, `gitlab`, `nvidia`, `openai`, `opencode`
— https://docs.nvidia.com/openshell/sandboxes/manage-providers

**Custom base URL on the `openai` type — supported.** *"Any cloud provider that exposes an
OpenAI-compatible API works with the openai provider type"*; *"Set `--config OPENAI_BASE_URL` to
point to the provider."*

```sh
openshell provider create --name <name> --type openai \
  --config OPENAI_BASE_URL=<url> --credential OPENAI_API_KEY=<key>
```

Applies to clients sending `POST /v1/chat/completions` or `/v1/responses`. Named examples: vLLM,
TensorRT-LLM, llama.cpp, LocalAI.

**Inference routing scope — gateway-level only.** *"Every sandbox using the active gateway sees
the same `inference.local` backend."* No per-sandbox flag on `inference set`/`get`/`update`.
— https://docs.nvidia.com/openshell/sandboxes/inference-routing

**Provider attachment vs routing.** Providers are created at gateway level and *attached* to
sandboxes (`openshell sandbox provider attach`). Distinct from routing; the interaction is
documented on neither page.

**Per-sandbox usage accounting — not documented.** Provider plugins are said to own "usage
reporting" with no stated fields, paths, or API. — https://docs.openclaw.ai/concepts/model-providers

**DeepInfra pricing, 2026-07-24** (https://deepinfra.com/zai-org/GLM-5.2):

| Tier | Input /1M | Output /1M | Cached input /1M |
|---|---|---|---|
| Standard | **$0.93** *(was $0.95 on 07-21)* | $3.00 | $0.18 |
| Priority (1.5×) | $1.395 | $4.50 | $0.27 |
| **Flex (0.8×)** *(newly listed)* | $0.744 | $2.40 | $0.144 |

## Constraints and Invariants

- **The repo's recorded provider constraint is stale.** `doorman-nemoclaw-setup-guide.md:478`
  still says custom gateway providers are impossible and lists six types; the live list is twelve
  and `openai` takes a custom base URL. The block is dated 2026-07-06.
- **Model ids differ in spelling per provider** (`zai-org/GLM-5.2` vs `z-ai/glm-5.2`). Error
  decoding: 410 = retired route, 404 = id never existed, 401/403 = key, 5xx/timeout = blip.
- **Verify model ids from the HOST** — `nemoclaw --verify` runs inside the egress-restricted
  gateway container and fails on connection, not auth.
- **`nemoclaw onboard`/rebuild resets the route** to NVIDIA's free-tier default; this rate-limited
  a real customer's sandbox on 2026-07-08. The medic self-heals within 5 minutes.
- **A capability flag lives on exactly one sandbox, unversioned.** `compat.supportsPromptCacheKey`
  in s2's rendered `openclaw.json`; `engineering-memory` §4 records that any rebuild silently drops
  it. Given cached input is 5.2× cheaper than uncached and input is ~98.6% of spend, this flag is a
  larger cost lever than the model's sticker price.
- **`nemoclaw rebuild` can destroy a sandbox's device private key** (vendor bug). Prefer
  `gateway restart`.
- **Never health-check via `nemoclaw <s> agent`** — it injects into the person's live Telegram chat.
- **s3 belongs to a real external beta customer.** "Never hand-touch her sandbox (s3)."
- **The GLM line is a standing decision**; Nemotron-3 Super was judged too weak, GLM-5.1 retired.
- **Newly recorded:** the gateway truncates AGENTS.md at 12,000 chars and serves a cached
  `tools/list` — ground truth is `nemoclaw list`.

## Decision Points

**1. Which provider surface a candidate uses.** A dedicated type where one exists (`deepinfra`,
`anthropic`, `nvidia`, `aws-bedrock`) or `openai` + `OPENAI_BASE_URL`. They differ in what the
plugin handles natively — onboarding, model catalogs, auth env-var mapping, transport
normalization, tool-schema cleanup, failover classification, usage reporting.

**2. Whether provider facts stay distributed or become declarative.** The facts that must agree
across a switch (provider name, model id spelling, base URL, capability flags, rate limits, price,
**tier**) live in: shell constants, one sandbox's rendered JSON, two markdown files, and — for
price and tier — nowhere.

**3. Whether the cost ledger and the provider registry share a key.** If usage is recorded in
units against a provider/SKU identifier, a candidate's cost is computable against recorded history
before switching. If cost is recorded in currency at write time, that comparison is not derivable.
The 07-21→07-24 price drift is a live instance of what that choice governs.

**4. What gate a candidate must pass.** The repo's recorded model-behavior failures form an
implicit list: date/weekday computation (a harness exists), emitting required tool parameters
(PR #53), relaying result-embedded directives verbatim (the fabricated board URL), driving the
`toolSearch:false` surface, multi-turn destructive confirm, and latency. Only the first is
codified today.

**5. Whether per-tenant gateways are in scope.** Routing is gateway-scoped, so per-tenant provider
keys require one gateway per tenant. The setup guide documents `NEMOCLAW_GATEWAY_PORT=<port>
nemoclaw onboard` for a second gateway; whether that yields an independently routable provider is
untested.

**6. How capability flags survive a rebuild.** The prompt-cache flag's drift is recorded and
unaddressed — independent of any switch.

**7. Which DeepInfra tier the pilot is on.** Three tiers are now published; the live tier is
recorded nowhere in this repo and changes every cost figure by up to 1.9×.

## Open Questions

- **Does `--config OPENAI_BASE_URL` work against the nemoclaw-managed gateway** (`-g nemoclaw`)?
  The documented syntax omits the gateway scope this repo uses.
- **Does a provider *attached* to one sandbox override gateway-scoped routing?** If so, per-tenant
  keys may be possible on one gateway — which would reopen the cost plan's allocation decision.
- **Where does OpenClaw's "usage reporting" surface?** Determines whether per-provider token counts
  are readable without a proxy.
- **Which DeepInfra tier is active, and is Flex viable?** Flex is 0.8× across the board; its
  scheduling trade-off is not documented on the model page.
- **Does GLM-5.2 drive code mode (`tools.toolSearch:true`)?** Recorded UNVERIFIED; a fresh box
  defaults to it because the toolSearch-off manifest matches only the Nemotron model id.
- **Are the medic constants on the box still the live route?** `openshell inference get` is the
  only authority; the repo copy may have drifted from the installed one.
