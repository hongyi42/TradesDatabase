# seat-eval — driven tests of the manager seat on the Copilot SDK engine

Two measured tests from step 2 (2026-09-23). Results and the write-up:
`thoughts/shared/research/2026-09-23-plan-mode-and-jev-tool-search-tests.md`, raw results in
`thoughts/shared/evals/seat-tool-search-2026-09-23/`.

**Local only.** Everything runs against THIS worktree's local Supabase stack (`.env.test`,
`spine-env.mjs` refuses a non-127.0.0.1 URL). The model calls go to OpenRouter on the pilot's
shared key — they cost real money and count against the key's monthly limit (the live seats stop
at the limit), so check `GET https://openrouter.ai/api/v1/key` first.

## Setup (once per worktree)

```bash
npm ci && npm run build          # dist/mcp/server.js (the spine) + dist/seatGlue/doctrine.js
bash scripts/second-stack.sh <N> # the worktree's own local stack, if not running
npm run seed:local               # manager-sam, tech-jane, Maria / Tom / Acme
npm i --no-save @github/copilot-sdk@1.0.14   # NOT a repo dependency (see engine.ts) — do not commit it
export OPENROUTER_API_KEY=...    # or KEY_ENV_FILE=/path/to/.env
```

The seed's tenant id is hard-coded in `tool-search/spine-env.mjs` (`DEFAULT_TENANT_ID`) — re-read it
from the local `technicians` table if the seed changes.

## plan-mode/ — does the SDK's plan mode gate our tools? (27 runs + 24-turn switching test)

- `probe-mcp.mjs` — a stand-in spine over stdio (lookup/record/send/schedule), logs every execution.
- `test.mjs <scenario|all> [reps]` — plan mode set per message vs per session, approve/reject, "just do it".
- `test2.mjs [jevRuns]` — Jev decides per message; the glue calls `session.rpc.mode.set` before each send.

## tool-search/ — Jev as the seat's tool search vs a strong model vs all tools loaded

```bash
cd scripts/seat-eval/tool-search
node export-catalog.mjs                       # the real manager catalog from the local spine
node run.mjs --retriever llm --mode search --out ref.jsonl     --ids $(cat sample100.txt)  # reference
node score.mjs --reps 3                       # Jev variants on every real search (offline, pennies)
node run.mjs --retriever jev --mode search --out cmp-jev.jsonl  --ids $(cat sample30.txt)
node run.mjs --retriever llm --mode all    --out cmp-all2.jsonl --ids $(cat sample30.txt)
node compare.mjs
```

- `corpus.jsonl` — 300 synthetic manager messages with `needs` / `alsoOk` tool labels (written by
  `gen_corpus.py`); `sample100.txt` / `sample30.txt` — the stratified samples used.
- `seat.mjs` — the manager seat: spine tools served as the glue's OWN tools (each proxies one MCP
  call), the model sees core tools + `find_tools`, swapped mid-turn with `session.rpc.tools.set`.
  The engine's own tool search never deferred anything under our setup (`probe-defer.mjs`).
- `--budget` is a runaway guard priced from OpenRouter's generation records, not an estimate.
- Run ONE `run.mjs` at a time: two in parallel on one laptop timed out 18 of 59 turns (measured).
