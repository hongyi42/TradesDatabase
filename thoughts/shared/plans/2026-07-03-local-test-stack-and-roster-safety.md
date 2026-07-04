---
date: 2026-07-03
task: Move the test suite onto a local Supabase stack and close the truncation → live-box outage path
research: thoughts/shared/research/2026-07-03-test-suite-cleanup-and-live-box-safety.md
status: complete
---

## Overview

> **Amendment (2026-07-04, host migration):** the deployed box is now **`trades-box-1`
> (AWS Lightsail)** — the Brev `nemoclaw-box` is retired (see
> `Box_Setup_Stuff/migration-runbook-lightsail.md`). Three consequences for this plan:
> (1) the box is **agent-reachable over plain SSH** (`ssh tradesbox`), so Phase 3's
> "human-only" deploy/verify caveats no longer hold; (2) the guarded `badge-pull.sh`
> is **already deployed and running** on trades-box-1 (installed 2026-07-04 by
> `bootstrap-box.sh badgepull`); (3) Phase 2's `--with-roster` re-mint warning gained
> teeth — on new-generation NemoClaw, installing a re-minted badge (`provider update`)
> bumps the provider generation and can trip the placeholder **versioning trap**
> (see the runbook's "What the build actually hit" §2/§3).

Running `npm test` today truncates roster tables on the hosted test project — the same database the
deployed stack (Render web service, Render cron, trades-box-1 badge-pull timer) reads. On 2026-07-03
this locked a technician out for ~8 minutes. This plan moves all test writes to a **local Supabase
stack** (Docker on the dev machine), adds a hard guard so tests can never again point at a hosted
database, defuses the seed script's roster wipe, and hardens the box's `badge-pull.sh` against
accepting an empty roster. After Phase 1 lands, the standing "no test runs" prohibition is lifted.

## Decisions

- **Where tests run** — options: shared hosted project with row-scoped cleanup / Supabase branch DBs
  (Pro-plan, experimental) / dedicated hosted test project / **local Supabase stack (CHOSEN, user
  decision)**. Free, fully isolated, migrations already in-repo and byte-identical to the hosted
  project's applied list (verified via MCP `list_migrations`, 2026-07-03).
- **Deployed stack stays on the hosted "test" project for now** (user-approved 2A). Out of scope here;
  revisit at a real launch.
- **Cleanup style unchanged** (user-approved 4A) — TRUNCATE-based cleanup stays; it's harmless on a
  disposable local DB, and row-scoped deletes are impossible for `raw_captures` anyway (append-only
  trigger blocks DELETE).
- **Box-side empty-file guard** (user-approved 3A) — `badge-pull.sh` refuses to replace a non-empty
  `badges.json` with a 0-entry one unless `ALLOW_EMPTY_BADGES=1` is set in its env file. Server-side
  guard rejected: the server's only memory of "roster existed" is the roster itself.
- **Seed roster wipe behind a flag** (user-approved 5A) — `npm run seed` touches only spine demo data
  by default; `--with-roster` restores today's full behavior.
- **Test env via `.env.test` overriding `.env`** (implementation call) — `.env` keeps serving live
  helper scripts; `src/test.setup.ts` loads `.env` then `.env.test` with `override: true`. Only the
  three DB vars go in `.env.test`, so `ANTHROPIC_API_KEY` still reaches the key-gated live-model tests.
- **Guard hard-fails the whole suite** (implementation call) — if `DATABASE_URL`/`SUPABASE_URL` aren't
  local, even pure unit tests won't run. Safety over convenience; the error message says exactly how
  to fix it. Guard logic lives in an exported pure function so it is itself unit-testable.
- **`getTenantByName()` added to the typed layer** (implementation call) — seed currently hardcodes the
  hosted tenant UUID, which doesn't exist on a fresh local DB. CLAUDE.md forbids hand-written Supabase
  queries outside `src/db/`, so the lookup becomes a typed-layer function.
- **Docs sync for the box script** — `badge-pull.sh`'s header says it pairs with
  `doorman-architecture-memory.md`; `docs/control-plane.md:69-74` documents its deployment. Both get
  the guard note. `docs/nemoclaw-tech-agent.md` never mentions badge-pull (verified by grep) and the
  guard isn't architectural, so it is not touched.
- **Seeding the hosted pilot stays allowed but gets a loud warning** (implementation call, post-review) —
  bare `npm run seed` against the hosted project remains the documented playground-restore path, but it
  now prints which target it matched and warns that pilot spine tables are about to be wiped. A hard
  block was rejected: it would break the documented restore flow the user still needs.
- **`scripts/assign-host.mjs` guard unchanged** — it manages the *hosted* hosts registry; there is no
  local use case, so widening its guard would only reduce safety.
- **Final-review hardening (2026-07-04, supersedes two earlier calls):** the full-diff review
  (8 finder angles) converged on four Important fixes, all applied: (1) *hosted seeding now
  requires an explicit `--hosted` flag* — the warn-only decision above is superseded; bare
  `npm run seed` aimed at the pilot refuses (three angles flagged warn-then-wipe as the incident
  path left open), and `npm run seed:local` / `--local` retargets to the local stack via
  `.env.test`; (2) *roster reseed is automatic on the local target* (the seeded schedule/captures
  reference roster refs; without it the local playground demos silently return nothing) — the
  spine-only default now applies to hosted only; (3) the env guard is *host-parse based*
  (`isLocalDbUrl`, shared with seed via dist) — the substring regex accepted
  `postgresql://localhost:pw@db.<hosted>` (username "localhost"), and it now also rejects an
  empty `SUPABASE_SERVICE_ROLE_KEY` (an unfilled `.env.test` would clobber the real key via
  `override:true`); (4) `badge-pull.sh` keys the doorman chown off `id doorman` (runtime fact)
  instead of a `BADGE_PULL_TEST` env flag that the sourced env file could spoof into silently
  breaking file ownership on a real host, and the empty-file guard now also refuses over a
  *corrupt* existing badges.json (5th + 6th test cases added). trades-box-1 initially received
  the PRE-review script; the FINAL script was redeployed 2026-07-04 by the user over ssh —
  EVIDENCE: `journalctl -u badge-pull` 10:01:38 `badge-pull: no change`, unit
  `Deactivated successfully` (clean pull with the final guard in place).
- **Local-stack divergence found during Phase 1 (implementation record):** the CLI's new default gives
  Data API roles (incl. `service_role`) NO grants on migration-created tables, so every supabase-js
  call failed `permission denied` locally; the hosted project predates this default. Fixed with
  `auto_expose_new_tables = true` in `supabase/config.toml` (legacy-parity flag). ⚠ **FOLLOW-UP, due
  before 2026-10-30 (flag removal):** replace the flag with an explicit GRANT + default-privileges
  migration, else the local stack silently breaks with permission errors.

## Plain-language walkthrough

**Phase 1 — tests move onto your Mac.** Supabase's command-line tool can run the whole database stack
in Docker (containers — lightweight sandboxed processes) on your machine. Your 10 migration files
rebuild the exact schema, including the `Default Tenant` row tests need. A new `.env.test` file points
tests at `127.0.0.1` (your own machine), and a guard makes the suite refuse to start if it's aimed
anywhere else. You'd notice it working because `npm test` goes green while the hosted project's roster
stays byte-for-byte untouched — no timer-stopping runbook.

```
BEFORE: npm test ──► hosted test DB ──► box pulls empty roster ──► techs locked out
AFTER:  npm test ──► local Docker DB (guard blocks anything non-local); hosted DB never touched
```

**Phase 2 — the seed script stops being a roster hazard.** `npm run seed` currently wipes and rebuilds
*everything*, including the technician roster — and rebuilt rows lack badge fingerprints, so the box
would re-mint credentials. After this phase, seeding touches only demo customer data unless you
explicitly pass `--with-roster`. It also learns to accept the local database and to look the tenant up
by name instead of a hardcoded ID that only exists on the hosted project.

**Phase 3 — the box refuses an empty roster.** `badge-pull.sh` (the 5-minute timer script on the live
box) will keep its last good badge file and exit loudly if the server ever hands it zero badges while
the current file is non-empty. A deliberate full wipe needs a one-line override in the box's env file.
The guard logic gets a real automated test (we run the script locally against a fake server). You
deploy the updated script to the box by hand — that's the one manual step in this plan.

**Phase 4 — the paperwork catches up.** CLAUDE.md's testing convention, the `verifying-behavior`
skill's "wired tools" section, and the stale comment in `vitest.config.ts` are updated so the next
session reads the new reality instead of the old one.

## Secrets & env preflight

- **Phase 1:** Docker Desktop (or OrbStack/colima) installed and running — user installs.
  `.env.test` values (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`) — all printed by
  `npx supabase start`; no dashboard needed. `ANTHROPIC_API_KEY` in `.env` — `already required`
  (optional; live-model tests skip without it). `psql` for read-back checks — if absent, use
  `docker exec supabase_db_TradesDatabase psql -U postgres -c "<sql>"` instead (container name derives
  from `config.toml`'s `project_id`).
- **Phase 2:** none new (runs against the local stack from Phase 1).
- **Phase 3:** `jq`, `curl`, `bash` on the dev machine — verified present 2026-07-03. Box deploy needs
  SSH access to trades-box-1 (`ssh tradesbox`, plain keys — agent-reachable since the 2026-07-04
  Lightsail migration).
- **Phase 4:** none.

## Phase 1: Local Supabase stack + test-environment guard

### What this phase does
Brings up the local stack, wires tests to it via `.env.test`, and adds a hard local-only guard so no
test process can ever connect to a hosted database again. Test files themselves are untouched.

### Changes required

**`.gitignore`**
- Under the env section add `.env.test` (it will hold the local service key — gitignore it anyway).

**`.env.test.example`** (new file)
- Template with the three vars and a header comment: values come from `npx supabase start` output;
  copy to `.env.test`. Local defaults: `SUPABASE_URL=http://127.0.0.1:54321`,
  `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres`,
  `SUPABASE_SERVICE_ROLE_KEY=<"Secret" key (sb_secret_...) printed by supabase start>`.

**`src/testEnvGuard.ts`** (new file)
- Export a pure function the setup file calls and a unit test can import:
```ts
export function assertLocalTestEnv(env: Record<string, string | undefined>): void {
  const isLocal = (u: string) => /(?:127\.0\.0\.1|localhost)[:/]/.test(u);
  for (const name of ['DATABASE_URL', 'SUPABASE_URL'] as const) {
    const value = env[name] ?? '';
    if (!isLocal(value)) throw new Error(
      `${name} does not point at the LOCAL Supabase stack. Tests only run against ` +
      `127.0.0.1 (see .env.test.example; values come from \`npx supabase start\`). ` +
      `Refusing to start — this guard exists because a test run truncated the live ` +
      `roster on 2026-07-03.`);
  }
}
```

**`src/test.setup.ts`**
- Replace the single `import 'dotenv/config'` with: load `.env`, then `.env.test` with
  `override: true`, then call `assertLocalTestEnv(process.env)`:
```ts
import { config } from 'dotenv';
import { assertLocalTestEnv } from './testEnvGuard.js';
config();
config({ path: '.env.test', override: true });
assertLocalTestEnv(process.env);
```

**`src/testEnvGuard.test.ts`** (new file)
- Unit tests: accepts `127.0.0.1` and `localhost` URLs; rejects the hosted test ref, a prod-looking
  URL, an empty/missing var; error message names the offending var.

**`vitest.config.ts`**
- Update the lines 8-9 comment: files still run sequentially because they share the one *local* stack.

### Automated verification
- [x] `npx supabase start` then `npx supabase db reset` — output lists all 10 migrations applied
      (note: `start` needs `supabase/.temp` link-state set aside once — linked projects demand a
      platform token; restored after)
- [x] `psql …` → done via fallback `docker exec supabase_db_TradesDatabase psql -U postgres -c
      "select name from tenants"` → `Default Tenant`
- [x] `npm run typecheck`, `npm run lint` pass
- [x] `src/testEnvGuard.test.ts` passes (6/6; re-confirmed independently by the phase reviewer)
- [x] `npm test` — 26/26 files, 153/153 tests green against the local stack (2026-07-03, after the
      `auto_expose_new_tables` parity fix; live-model tests ran, key present)
- [x] Guard proof — test the REAL failure mode (`.env.test` absent → `.env`'s hosted values reach the
      guard): `mv .env.test .env.test.bak && npx vitest run src/sanity.test.ts; mv .env.test.bak .env.test`
      — the run must fail fast with the guard's message. (Do NOT test via hostile shell vars: the
      setup's `override: true` would clobber them with `.env.test` values and prove nothing —
      adversarial-review finding.)
      EVIDENCE (2026-07-03): `Error: DATABASE_URL does not point at the LOCAL Supabase stack. …
      Refusing to start — this guard exists because a test run truncated the live roster on
      2026-07-03.` → `Test Files 1 failed (1)`; `.env.test` restored.

### Live verification (agent-executable)
- Prerequisites: `supabase-test` MCP server (wired in this project).
- [x] DONE 2026-07-03, fresh-context verification subagent, VERDICT PASS — hosted `technicians`
      before == after a full 153-test local run, byte-identical:
      `[{"n":3,"roster":["manager-sam:-","pair-drill:8eef0782…f59","tech-jane:d67b85ee…083"]}]`
      (full hashes in session transcript; suite summary `26 passed / 153 passed, 20.94s`).
      Original spec: cross-channel read-back per `verifying-behavior` §2: capture
      `select count(*), array_agg(ref || ':' || coalesce(badge_hash,'-') order by ref) from technicians`
      on the **hosted** project via MCP `execute_sql` BEFORE `npm test`, re-run AFTER — byte-identical
      (proves the hosted roster + badge fingerprints were never touched; the box needs no timer stop).
      Record both outputs as evidence in this plan's status notes. Do NOT use `raw_captures` counts as
      the signal — live inbound mail / the cron heartbeat legitimately write there during the window;
      a delta there needs source attribution before it means anything.

### Manual verification
- [ ] none

---
*No manual items — implementer continues after automated + live checks pass.*

## Phase 2: Defuse `scripts/seed.mjs`

### What this phase does
Seed accepts the local stack, looks the tenant up by name, and only touches the roster behind an
explicit flag — so a routine re-seed of the hosted project can no longer churn box credentials.

### Changes required

**`src/db/tenants.ts`**
- Add `getTenantByName(name: string): Promise<Tenant>` using `getClient()`, `.eq('name', name)
  .single()`, throwing a clear error if absent (mirrors the existing modules' error style).

**`scripts/seed.mjs`**
- Guard (lines 35-45): allow EITHER the hosted test ref OR local — both URLs must satisfy
  `u.includes(TEST_REF) || /127\.0\.0\.1|localhost/.test(u)`; update the refusal message.
- Replace `const TENANT_ID = '82bbc6f8-…'` (line 48) with a lookup at the top of `main()`:
  `const tenant = await getTenantByName('Default Tenant')` (import from `../dist/db/index.js`);
  thread `tenant.id` into `truncateSpine`/`seedRoster`/`seed` (small signature changes within the file).
- Roster flag: `const WITH_ROSTER = process.argv.includes('--with-roster')`.
  - `truncateSpine()`: truncate `customers, jobs, visits, raw_captures, schedule_entries,
    dropped_audit` always; append `, technicians, review_items` only when `WITH_ROSTER`.
  - `main()`: call `seedRoster()` + its `setTenantSeats` only when `WITH_ROSTER`; otherwise log
    `Roster untouched (pass --with-roster to wipe/reseed it — re-seeded rows have NO badge
    fingerprints, so the box re-mints credentials on its next pull).`
  - *(2026-07-04 addendum)* a re-mint is worse than credential churn on new-generation NemoClaw:
    installing the replacement badge (`openshell provider update`) bumps the provider generation,
    which can trip the placeholder **versioning trap** and kill the sandbox's Telegram bridge
    (observed live 2026-07-04; see the migration runbook's postmortem §2/§3). Treat
    `--with-roster` against the hosted project as a maintenance operation on every sandbox, not
    just a data reset.
- `main()` line 233 logs the removed `TENANT_ID` constant (`Seeding TEST project … (tenant ${TENANT_ID})`)
  — update it to log the looked-up `tenant.id` and which target (hosted ref vs local) the guard matched;
  when the target is the hosted ref, also print a loud warning that spine tables on the PILOT database
  are about to be wiped. (`.mjs` is outside `tsc` coverage — a stale reference here is a runtime
  `ReferenceError`, adversarial-review finding.)
- Update the header comment (lines 1-16) for the new default.
- Note: spine rows referencing `tech-jane` etc. without roster rows are fine — `technician_ref` is
  free text by design (loose validation; no FK — verified in migration 20260702194603).
- npm script passthrough: `npm run seed -- --with-roster` (argv reaches the script through the
  `build &&` chain unchanged; verify while implementing).

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass (26 files / 153 tests, 2026-07-03;
      `getTenantByName` exercised by both seed runs below)
- [x] Against LOCAL stack — ⚠ bare `npm run seed` loads `.env` and would truncate the HOSTED pilot's
      spine tables (adversarial-review finding). ALL seed verification runs MUST prefix the three shell
      vars (shell vars win — this dotenv invocation has no `override`; the service-role key is needed
      because `getTenantByName` goes through supabase-js):
      `DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<sb_secret from supabase start> npm run seed`
      → summary prints, then local read-back: `customers` has 3 rows, `technicians` has 0 rows
      ✓ DONE 2026-07-03 — read-back `customers=3 / technicians=0`; log showed the LOCAL tenant id
      (63fb5691…), proving the by-name lookup replaced the hosted hardcode.
- [x] Same prefix + `npm run seed -- --with-roster` → read-back `technicians=3`, `seats=2/5`
- [x] Guard refusal: `DATABASE_URL=postgres://x@db.example.com/p SUPABASE_URL=https://x.supabase.co node -r dotenv/config scripts/seed.mjs`
      exits 1 with `REFUSING TO SEED` before any connection — EVIDENCE: exact message printed,
      `exit=1`; guard implemented stricter than spec (both URLs must agree on ONE target, so
      mixed hosted/local also refuses — Phase 2 reviewer confirmed).

### Live verification (agent-executable)
- Prerequisites: none beyond Phase 1's local stack (do NOT run seed against the hosted project to
  "test" it — nothing about the hosted path differs except the guard string match).
- [x] covered by the automated psql read-backs above

### Manual verification
- [ ] none

---
*No manual items — implementer continues.*

## Phase 3: `badge-pull.sh` empty-file guard

### What this phase does
The box keeps its last good `badges.json` when the server returns zero badges, with an explicit
override for deliberate wipes. The guard is locked in by a codified test that runs the real script
against a stub HTTP server.

### Changes required

**`Box_Setup_Stuff/badge-pull.sh`**
- Make the three path constants (lines 44-46) env-overridable so the test can redirect them:
  `ENV_FILE="${ENV_FILE:-/etc/doorman/badge-pull.env}"` (same pattern for `BADGES_FILE`,
  `PENDING_FILE`).
- Line 69 hardcodes `mktemp /etc/doorman/.badges.json.XXXXXX` — change to
  `tmp=$(mktemp "$(dirname "$BADGES_FILE")/.badges.json.XXXXXX")`. Without this, test cases 2-3 abort
  on the dev machine (no `/etc/doorman`), and it also preserves the same-filesystem atomic-rename
  property wherever `BADGES_FILE` lives (adversarial-review finding).
- After computing `file` and `current` (line 61), insert the guard:
```bash
new_count=$(jq 'length' <<<"$file"); cur_count=$(jq 'length' <<<"$current")
if [ "$new_count" -eq 0 ] && [ "$cur_count" -gt 0 ] && [ "${ALLOW_EMPTY_BADGES:-0}" != "1" ]; then
  echo "badge-pull: REFUSING empty badgesFile over $cur_count existing entries." \
       "If this wipe is deliberate, set ALLOW_EMPTY_BADGES=1 in $ENV_FILE and re-run." >&2
  exit 1
fi
```
  (Exit 1 marks the systemd unit failed — visible in `systemctl status`, which is the point.)
- Skip the `chown doorman:doorman` when `BADGE_PULL_TEST=1` (test machines have no `doorman` user):
  wrap line 71 in `if [ "${BADGE_PULL_TEST:-0}" != "1" ]; then … fi`. Document both test-only vars in
  the header.
- Header: add the guard + override to the "What it does" list.

**`src/control/badgePullScript.test.ts`** (new file)
- Vitest, `describe.skipIf` when `jq`/`bash` missing (both present on this machine). Uses
  `node:http` to serve canned JSON and `node:child_process.execFile('bash', [script], { env })` with
  `ENV_FILE`/`BADGES_FILE`/`PENDING_FILE`/`BADGE_PULL_TEST` pointed into a per-test temp dir
  (`fs.mkdtemp`). Cases:
  1. empty `badgesFile` + existing non-empty file → exit ≠ 0, file unchanged, stderr contains `REFUSING`
  2. same but `ALLOW_EMPTY_BADGES=1` in the env file → exit 0, file replaced with `{}`
  3. non-empty response ≠ current → exit 0, file replaced, entry count logged
  4. empty response + no existing file → exit 0 (first-boot case must not be blocked)

**`docs/control-plane.md`**
- In the deploy note around lines 69-74: one sentence on the guard + `ALLOW_EMPTY_BADGES` override.

**`Box_Setup_Stuff/doorman-architecture-memory.md`**
- In the badges section (~line 49): one bullet — pulls refuse a 0-entry file over a non-empty one
  since 2026-07-03 (post-incident hardening), override via `ALLOW_EMPTY_BADGES=1`.

### Automated verification
- [x] `npm run typecheck`, `npm run lint` pass
- [x] `npx vitest run src/control/badgePullScript.test.ts` — all 4 cases green (222ms, first run)
- [x] `npm test` still green — 27 files / 157 tests (2026-07-03)

### Live verification (agent-executable)
- Prerequisites: `ssh tradesbox` (agent-reachable since the 2026-07-04 Lightsail migration — the
  original "not agent-reachable, declared human" caveat applied to the retired Brev box).

### Manual verification
- [x] SATISFIED on trades-box-1, 2026-07-04 (deploy target changed by the host migration): the
      guarded script was installed by `bootstrap-box.sh badgepull`
      (`install -m 700 … /usr/local/sbin/badge-pull.sh` + root-only env + 5-min timer), and
      `journalctl -u badge-pull` showed a clean first pull (`badges.json updated (1 entries)`,
      `1 new badge(s) appended`) followed by normal `no change` ticks. The retired Brev box never
      received the guarded script and doesn't need it.

---
*Phase pause satisfied — the manual item completed as part of the Lightsail migration.*

## Phase 4: Documentation & convention closeout

### What this phase does
Updates the three places that still describe the old world so future sessions (and CLAUDE) inherit
the new rules.

### Changes required

**`CLAUDE.md`**
- Conventions bullet, currently `Test writes target the **test** Supabase project only; **prod is
  read-only**. Tests self-clean rows they create.` → tests run ONLY against the local Supabase stack
  (`supabase start`; enforced by `src/testEnvGuard.ts`); the hosted "test" project is the deployed
  pilot's live database — never point tests or default seeds at it; prod remains read-only.

**`.claude/skills/verifying-behavior/SKILL.md`**
- §1 fill-in and §5 "Wired verification tools": local stack (writes, via Bash/psql +
  `.env.test`), `supabase-test` MCP (hosted pilot DB — treat as production-adjacent: read-back yes,
  test writes no), `supabase-prod` MCP (read-only). Remove the "None wired yet / Setup status:
  blocked" banner — bucket-2 checks are now unblocked.

**`README.md`** (only if it documents running tests — check while implementing; add the
`supabase start` prerequisite where test instructions live, else skip)

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass (full pre-commit gate
      set — run 2026-07-04 after the doc edits: 27 files / 157 tests, build clean, `ALL_GATES_PASS`)

### Live verification (agent-executable)
- [ ] none needed (docs only)

### Manual verification
- [ ] User skims the CLAUDE.md + skill diffs — these steer every future session, worth a human glance

---
*Pause after this phase for the doc review.*
