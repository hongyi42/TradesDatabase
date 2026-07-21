---
date: 2026-07-20
status: diagnosis complete; benchmark plan drafted, NOT yet run
owner: Yutao
topic: GLM-5.2 vs GPT-5.6 Luna cost/quality benchmark + agent prompt-cache diagnosis
---

# Agent model cost benchmark + prompt-cache diagnosis

## Why this exists
Goal: decide whether to move the NemoClaw agents off **GLM-5.2** (current brain, via DeepInfra
gateway route) to a cheaper model **without losing quality**, and understand our token/cost/cache
picture. Along the way we parsed real agent traffic and found the dominant cost driver has nothing
to do with the model. This doc captures both the diagnosis and the benchmark plan so a fresh
session can continue.

Environment note (user-confirmed 2026-07-20): **everything in the pilot DB + connected mailboxes is
seed/internal-test data — no real customer data yet.** So data-privacy is not a blocker for this
work; the live concerns are (a) not disrupting the running deployment, (b) not permanently polluting
the append-only L1 log.

---

## TL;DR — headline findings

1. **~99% of agent model calls are OpenClaw's built-in `[OpenClaw heartbeat poll]` — a full
   ~18k-token inference every 30 minutes that does nothing** (output 35–67 tokens, "nothing to
   do"). On s5: **391 of 395 turns** were heartbeats. This is the #1 cost driver and it is
   **orthogonal to model choice.**
2. **Real production cache rate is ~2–8% (blended ~3%), not 25%.** Cause: heartbeats fire every
   1800s, exactly past DeepInfra's cache TTL, so the ~18k prefix (system + 9k tool catalog) is
   recomputed cold at full price every time.
3. The prefix **is** byte-stable — warm/rapid turns cache 96–99%. So it's **TTL vs traffic
   spacing**, not prompt instability, not a config bug.
4. **Priority order:** (1) fix/kill the heartbeat inference → biggest lever; (2) then caching
   (keep-warm or a longer-TTL provider) for real traffic; (3) then the model comparison; (4)
   tool-search is a distant last.
5. Model prices (verified): **GLM-5.2** $0.95 in / $3.00 out / $0.18 cached; **GPT-5.6 Luna**
   $1.00 in / $6.00 out / $0.10 cached. Luna's cache discount is deeper AND its TTL is a
   controllable **30-min floor** (vs DeepInfra's short/unspecified) — which would exactly cover a
   30-min heartbeat interval.

---

## Part 1 — Cache diagnosis (the real finding)

### Method
Parsed every OpenClaw session file across all 5 sandboxes:
`/sandbox/.openclaw/agents/main/sessions/*.jsonl` (NOT the `.trajectory.jsonl` twins — they
duplicate). Each model turn logs a normalized usage object:
`{"input": <fresh>, "output": <out>, "cacheRead": <cached-in>, "cacheWrite": 0, "totalTokens": …}`.
`input` = fresh (uncached) input billed at full rate; `cacheRead` = cached input at the cached
rate. openclaw normalizes BOTH providers into these fields, so the same parser works for Luna
later. (Parser: `$CLAUDE_JOB_DIR/tmp/cacheparse.py` / `whatfires.py` from the 2026-07-20 session.)

### Data (1,015 turns total)
| Sandbox | Turns | Cache rate | Cost actual (GLM rates) | If fully cached | Cold-turn median gap |
|---|---|---|---|---|---|
| s2 (manager-sam) | 57 | 7.7% | $1.74 | $0.35 | 1800s |
| s3 (judy) | 438 | 4.0% | $12.68 | $2.49 | 1800s |
| s5 (ben) | 395 | 1.8% | $8.91 | $1.72 | 1800s |
| s6 (pool) | 67 | 1.3% | $1.32 | $0.25 | 1800s |
| s7 (yutao/test) | 58 | 70.8% | $0.81 | $0.37 | 97s |

Production (s2/s3/s5/s6): ~957 turns, **~3% blended cache**, **$24.65 actual vs $4.83 if cached
→ ~80% overpay** on logged traffic. (s7's 71% is my rapid back-to-back E2E test traffic from the
setup session — NOT representative; ignore it.)

### Root cause — the heartbeat
Extracting the triggering messages (whatfires.py) on s5:
- **391× `[OpenClaw heartbeat poll]`** (every ~1800s), 1× "Hello", 1× "List recent captures",
  1× "Maria" + tool results. Same shape on s2/s3/s6.
- Each heartbeat = full ~18k-token prompt (system + 25-tool catalog) → cold (30 min > cache TTL)
  → recomputed at $0.95/1M → ~35–67 output tokens of nothing.
- Warm turns (human follow-ups, gap 5–35s) cache 96–99% → proves the prefix is stable and
  cacheable; the cache is just dead by the time the scheduled poll arrives.

Not in `openclaw.json` → it's an OpenClaw **default**. The enable/interval knob lives in OpenClaw's
own config schema (ACTION ITEM: find it — likely `openclaw config` heartbeat/proactive/wake key,
or an agent default).

### Fixes, ranked
1. **Cut the heartbeat inference cost** (biggest lever — it's ~99% of turns):
   - Disable it, or lengthen the interval, or make the poll NOT invoke the full-tool agent (a
     heartbeat shouldn't carry 25 tool schemas). Needs the OpenClaw config knob.
2. **If the poll must stay:** keep the prefix warm within the TTL, OR use a provider whose cache
   outlives 30 min. **GPT-5.6 Luna's 30-min TTL floor lands exactly here.**
3. Confirm DeepInfra's actual TTL (clearly < 30 min).

---

## Part 2 — Model prices (verified 2026-07-20)
| | GLM-5.2 (DeepInfra `zai-org/GLM-5.2`) | GPT-5.6 Luna (`gpt-5.6-luna`) |
|---|---|---|
| Input | $0.95/1M | $1.00/1M |
| Output | $3.00/1M | **$6.00/1M** |
| Cached input | $0.18/1M (81% off) | **$0.10/1M (90% off)** |
| Context | 1M | 1.05M (128k max out) |
| Cache TTL | short/unspecified ("recent") | **30-min floor, controllable** (`prompt_cache_options.ttl`) |
| Tool/function calling | yes | yes (Responses API) |

Sources: developers.openai.com/api/docs/models/gpt-5.6-luna ; deepinfra.com/blog/glm-5-2-pricing-benchmarks-cost-comparison ; docs.deepinfra.com/chat/prompt-caching ; developers.openai.com/api/docs/guides/prompt-caching

Crossover (input only): below ~38% cache, GLM cheaper input; above, Luna cheaper. But **Luna
output is 2× GLM** ($6 vs $3) — often the deciding factor. Net winner = input:output ratio × real
cache rate → what the benchmark measures.

## Part 3 — Tool loading (today)
- **All 5 sandboxes run `toolSearch:false`** → full tier-filtered catalog injected as native
  function tools every turn. No code-search.
- Manager catalog ≈ **8–10k tokens** (~35k source chars; `TOOLS` + `ADMIN_TOOLS` in
  `src/mcp/server.ts`). Technician ≈ 3.5–4k. This is the big fixed cacheable prefix.
- Code/tool-search mode (`toolSearch:true`) exists but is disabled. The "can't drive it" note in
  setup guide §5c is about **Nemotron**, NOT GLM-5.2 — GLM's capability here is **UNVERIFIED**
  (config carried over after the 2026-07-06 GLM switch, never re-tested).
- With caching available, cached full-catalog (~$1.62/1k mgr turns tool-portion) BEATS tool-search
  (~$2.38) — so tool-search is NOT worth chasing for GLM given caching exists. It's a distant 4th.

---

## Part 4 — Benchmark plan (GLM-5.2 vs GPT-5.6 Luna)

### Approach: controlled replica harness (decided)
A ~150-line script plays the openclaw agent's role, headless, swapping only the model. Faithful for
a *model* comparison; the literal sandbox is blocked for headless driving (gateway device-auth +
embedded fallback can't reach `inference.local`/badge — see setup-session notes).
- **Tools:** real 25 trades-spine schemas from `src/mcp/server.ts`.
- **Context:** s7's real `AGENTS.md` blocks + agent system framing.
- **Models:** OpenAI (`gpt-5.6-luna`, key `BENCH_OPENAI_API_KEY`) + DeepInfra
  (`zai-org/GLM-5.2`, key `BENCH_DEEPINFRA_API_KEY`) — dedicated keys for per-model spend tracking.
- **Execution (user chose EXECUTE for accuracy):**
  - Spine tools (read + write) → **local seeded Supabase stack** (`npx supabase start` +
    `npm run seed:local`), reversible, frozen so both models see identical data. NEVER the pilot
    (append-only L1 would be polluted permanently).
  - Gmail/Sheets → **existing Composio** (test data — OK per user). Reads execute; sends/edits
    execute too (test recipients). Gmail connect flow: `scripts/composio-reconnect.mjs`
    (`connectedAccounts.link()`, auth config `ac_5CdPk4l3GV2V`). Sheets needs a dashboard auth
    config (TBD).
- **Loop:** standard tool-use loop; log per task.

### Metrics (per task, per model)
- Fresh vs **cached** input tokens (from API `usage.prompt_tokens_details.cached_tokens` / openclaw
  `cacheRead`), output tokens, $ (× verified rates), latency, tool-selection correctness, answer
  quality (rubric + LLM-judge).
- **Cache sub-test:** hit the big system+tools prefix repeatedly to isolate cache-hit rate + $ saved
  per provider (Luna 30-min TTL vs DeepInfra short).

### Dimensions
1. Core: both models, **full-catalog mode** (matches today).
2. Bonus: can **GLM-5.2** and/or **Luna** drive **tool-search** mode? (GLM's = cheaper *today*.)

### Task suite (flexible count — size to cover the surface, not a round number)
Sections: identity/read (find_customer, get_customer_context, list_recent_captures, get_job,
list_team, get_schedule/get_team_schedule) · scheduling writes (book/move/cancel_visit, incl.
promise-ladder confirm paths) · notes (record_field_note stage→confirm, retract_capture) · standing
facts · seat lifecycle (add/deactivate/reactivate, bind_telegram) · web tools · Gmail/Sheets ·
multi-step chains · adversarial/edge (ambiguous customer, empty technicianRef, bad dates). Each task
has a known-correct expected tool call + answer (ground truth from the seeded DB) for grading.

### Grading
Objective: right tool + right args (vs expected). Prose quality: rubric + LLM-judge. Separate cost
table + quality table + cache table.

---

## Part 5 — Recommendation / priority order
1. **Fix the heartbeat** (find the OpenClaw knob; disable / lengthen / strip tools from its
   context). Biggest, model-agnostic saving — kills ~99% of wasted inferences.
2. **Improve caching for real traffic** (keep-warm within TTL, or a longer-TTL provider). Halves
   input cost on the turns that remain.
3. **Run the benchmark** (Luna vs GLM on real tasks) — decides the brain by input:output ratio ×
   achievable cache rate. Remember Luna output is 2× GLM.
4. **Tool-search** — only if a cheap win appears; distant last given caching exists.

## Open action items
- [ ] Find OpenClaw heartbeat config knob (interval / disable / no-tools-on-poll).
- [ ] Mint `BENCH_OPENAI_API_KEY` + `BENCH_DEEPINFRA_API_KEY` into `.env`.
- [ ] Write `scripts/bench/run.mjs` + task file + grader.
- [ ] Decide Sheets execution (dashboard auth config) vs Gmail-only.
- [ ] Probe whether GLM-5.2 / Luna can drive tool-search (throwaway sandbox, `toolSearch:true`).
- [ ] Confirm DeepInfra cache TTL.

## Key references
- Session usage logs (ground truth): `/sandbox/.openclaw/agents/main/sessions/*.jsonl` fields
  `input`/`output`/`cacheRead`/`cacheWrite` (provider-neutral).
- Sandboxes: s2=manager-sam, s3=judy, s5=ben-shelton, s6=free pool (@ragisan2_bot), s7=yutao/test
  (@yu_nemoclaw_bot). Tenant 82bbc6f8-…; host trades-box-1 ca1ace5f-…
- Manager tool defs: `src/mcp/server.ts` `TOOLS` (L169) + `ADMIN_TOOLS` (L471); `MANAGER_TOOLS`
  L856; tools/list L3798.
- Related memory: [[s7-yutao-manager-agent]].
