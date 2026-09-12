---
name: verifying-behavior
description: Rules for verifying that behavior actually works — test-environment safety, the cross-channel verification-subagent recipe, how to triage a check (codified test vs live E2E vs human), and the missing-capability rule. Consult before any live or agent-driven verification, and when planning a phase's verification steps.
---

# Verifying behavior

The static gates in CLAUDE.md (`tsc`, `lint`, `npm test`, build) prove code *parses, types, and the
unit suite passes*. They do **not** prove behavior — does the endpoint return the right shape, did
the row land, does the auth flow work. This skill is how we verify *behavior*, safely and
consistently. Follow it whenever you run live/agent-driven verification or plan a phase's
verification steps.

## 1. Test-environment safety (non-negotiable)

- **All verification *writes* go to a disposable test environment** (test DB / test tenant /
  sandbox) that holds only fake data — write freely there.
- **Production is READ-ONLY.** Use it to *inspect* or cross-check real state, **never to write.**
  Never create or mutate verification data in production.
- **Self-clean.** Prefer temp tables / scoped fixtures, or delete rows you created. Don't leave
  residue in the sandbox — it accumulates and makes later runs flaky.
- **Concrete environments (since 2026-07-04):**
  - **LOCAL Supabase stack** (Docker; `npx supabase start`, creds in `.env.test`) — the ONLY
    writable test environment. `npm test` is pinned to it by `src/testEnvGuard.ts`; wipe/rebuild
    freely (`npx supabase db reset`).
  - **Hosted "test" project `daqapdlkgxfrhquacprv`** — despite the name, this is the deployed
    pilot's LIVE database (Render web + cron, trades-box-1 badge-pull read it). Treat it like
    production: read-back/inspection yes, verification writes NO. (A test run truncated its
    roster on 2026-07-03 → real lockout.)
  - **Prod project** — read-only, always.

## 2. The verification-subagent recipe (maker ≠ checker)

- Run live verification in a **fresh-context subagent that did NOT write the code under test** —
  otherwise it's grading its own homework.
- It **exercises the real flow** (don't just re-read the diff and declare success).
- It **confirms through an independent channel** (cross-channel read-back): the feature writes via
  the app's own path; the verifier reads it back a *different* way — e.g. the feature writes via the
  app's DB client, the verifier reads via a direct SQL / MCP query.
- It **reports evidence** — actual row values, an accessibility snapshot, a screenshot — never
  "looks good."

### Launching a probe inside a worktree: `WORK_RECORD_READONLY=1`

A probe that has to exercise a worktree's **hooks** must be launched *inside that worktree* —
hooks come from the directory a session was launched in, so there is no other way to make them
fire. That session then runs the worktree's record-writing hooks too, and writes into a task it
does not own. Set the switch:

```bash
WORK_RECORD_READONLY=1 claude -p "<the probe>"      # run from inside the worktree
```

`work.mjs touch` and `work.mjs snapshot` become no-ops; every other hook — the `PreToolUse`
decisions hook, anything under test — still fires, and `packet --for-session` still gives the
probe its context. Verified 2026-09-12: a var set on the `claude -p` command line reaches the
hook subprocess (`hook saw: [1]`; empty without it).

Why it matters, from the incident that produced it (2026-09-11): a probe edited a file and
reverted it, and the edit stuck in the *implementation* task's `files:` list and overwrote its
`.snapshot.json` — both cleaned by hand. `files:` is an **input**, not a log: the pre-edit hook's
SIBLING line and every `overlap`/`spawn` check read it, so a probe's footprint becomes a standing
false "a sibling has touched this file" in every other session.

Two exceptions worth knowing:
- **Do not set it when the probe is verifying `touch` or `snapshot` themselves** — that grades a
  disabled feature.
- It gates a separately launched **process**. An Agent-tool subagent shares the parent's
  environment, so its edits stay recorded — which is correct: they are the task's edits.

## 3. Triage every check into one of three buckets

When planning a phase's verification, sort each behavioral check:

1. **Codifiable → a unit/integration test** (mock the outside world). Cheap, deterministic, runs
   every time. This is the default; reach for it first.
2. **Agent-executable live E2E → drive it via MCP/tooling.** Self-verify *only* when the success
   signal is **objective and cross-channel-checkable**; if there's any interpretive element, set it
   up and hand the finished state to a human for a glance.
3. **Genuinely human → hand off** (visual, UX, judgment).

Pick the cheapest bucket that actually *proves* the behavior. Keep the pyramid shape: many codified
tests, few live E2E runs (per-phase / pre-PR, not on every change — live browser/API work is
token-heavy).

## 4. The missing-capability rule (never silently degrade)

- **Preflight:** before live verification, confirm the MCP servers / creds the check needs are
  actually connected (`claude mcp list`, or the tools are present).
- **If a needed capability is missing** (no MCP, no creds): **STOP and name exactly what to set
  up.** Do **not** quietly fall back to handing the human a manual checklist — that's the silent
  reversion to ad-hoc QA.
- **Classify why a check can't run:** *missing capability* → name it and ask; *inherently human* →
  hand off for a glance. Never collapse the first into the second.

## 5. Wired verification tools (current state, 2026-07-04)

- **Local Supabase stack** (writes) — via Bash: `docker exec supabase_db_TradesDatabase psql -U
  postgres -c "<sql>"` for read-back, `npx supabase db reset` to rebuild. Tests reach it through
  `.env.test` (see `.env.test.example`).
- **`supabase-test` MCP** — the hosted pilot DB (`daqapdlkgxfrhquacprv`). Production-adjacent:
  `execute_sql` SELECT read-backs yes (this is the cross-channel read channel for anything the
  deployed stack wrote), verification WRITES no (§1). Also carries `search_docs` for Supabase docs.
- **`supabase-prod` MCP** — prod project, read-only, inspection only.
- **trades-box-1** (deployed box, AWS Lightsail) — agent-reachable over `ssh tradesbox`; use for
  box-side evidence (`journalctl -u badge-pull`, doorman logs). The Brev nemoclaw-box is RETIRED —
  never target it or use `brev` CLI.
- Still unwired: a browser MCP (no UI exists yet) and third-party sandboxes (Composio/Google run
  live-only). For checks needing those, apply §4 — name what's missing, don't fake it.

## 6. Don't automate third-party SSO logins

- If user auth is via a third-party identity provider (Google / Microsoft / etc.), do **not** try to
  automate that login in a browser — providers block automated logins; it's fragile and a dead end.
- Instead, **seed an authenticated session directly**: insert the user + a session row in the test
  DB, then inject the session cookie into the browser. (Sessions often store *hashed* tokens —
  confirm the exact cookie name and any hashing against the auth code when you build this.)
- Use the browser **only for user-visible UI behavior**; for data/state correctness use the DB
  read-back (§2) instead — it's faster and more reliable.

## 7. Guardrails for any autonomous verification loop

- Always a **hard iteration cap + no-progress detection.** A loop whose tools return errors as data
  can otherwise spin forever.
- Live E2E is **expensive** — keep it sparse and let codified tests carry the routine load.
