---
date: 2026-07-12
task: Sandbox recycler — self-serve member replacement (auto destroy + restock) and zero-operator badge install
research: thoughts/shared/research/2026-07-11-member-lifecycle-onboarding-offboarding-replacement.md
status: draft
lines-note: ~350 lines, over the 300 guideline — flagged, not split. One feature spanning
  server + box + deploy; the overage is spec density (reviewer-hardened idempotency/race
  detail), not extra scope.
---

## Overview

Make member replacement fully chat-side: a confirmed deactivation automatically destroys the
person's sandbox on the box and rebuilds it as a fresh cold blank (reusing its Telegram bot),
which re-enters the pool with no operator involved. Also remove the last manual onboarding step:
badge-pull installs minted spine badges and restarts the container itself. Pool invariant
restored: free blanks ≈ purchased seats − active members, self-healing ~15 min after a swap.

## Decisions

- **Destroy timing** — options: at deactivation confirm / at 7-day grace expiry / hybrid.
  **User chose: at deactivation confirm.** Pool refills in ~15 min; the existing single
  confirmation carries the destruction warning (per agent-confirmation UX rule).
- **Reactivation semantics (self-decided, forced by the above)** — reactivating during grace
  CANCELS a still-pending retirement (sandbox survives intact); if the sandbox was already
  destroyed, the retired pool row releases its `technician_id` and the roster residue is cleared
  at completion, so the reactivated person simply re-binds and claims a fresh blank (their agent
  memory is gone — the cost the user accepted). The recycler re-checks the server immediately
  before destroying, shrinking the cancel race to seconds.
- **Bot identity for the rebuilt blank** — options: reuse retired bot token / pre-created vault /
  manual. **User chose: reuse.** Token is recovered box-side from `~/.nemoclaw/sandboxes.json`;
  the handle is confirmed via `getMe` and re-registered with the new pool row.
- **Badge install automation** — options: automate / keep manual. **User chose: automate.**
  badge-pull installs each minted badge (`openshell provider update` + container restart);
  the pending-file becomes the failure fallback, not the happy path.
- **Signal transport (self-decided)** — extend the existing 5-min pull with `retirements[]`
  (the `bindings[]` precedent; old boxes ignore unknown keys).
- **Box→server registration (self-decided)** — new `POST /control/sandboxes` (host pull-token
  auth) that ONLY completes a recycle: stamps the retired row, inserts the replacement
  inheriting `tenant_id` from it — the box cannot invent tenants.
- **Pool bookkeeping (self-decided)** — add `retire_requested_at`, `retired_at`, and
  `retired_technician_id` to `sandbox_pool`; retired rows are kept forever (audit), never
  deleted. At completion the row's `technician_id` moves to `retired_technician_id` — releasing
  the UNIQUE slot so the same person (if reactivated) can claim a fresh blank. The rebuilt blank
  is a NEW row under a NEW `sandbox_ref` (`unique(host_id, sandbox_ref)` requires it).
- **Refs (standing rule)** — the new blank gets a fresh sandbox ref; technician refs are never
  reused. Roster residue (`sandbox_ref`, `telegram_user_id`) stays on the offboarding row.
- **Vendor destroy command (OPEN — resolved by Phase 4 spike)** — no teardown has ever been run;
  the spike on a scratch sandbox determines `nemoclaw <ref> destroy` vs. manual teardown
  (container rm + sandboxes.json entry removal). Both paths are specified below.

## Plain-language walkthrough

**Phase 1 — the server learns to ask for a recycle.** New columns on the sandbox pool table.
A confirmed deactivation stamps the person's sandbox "retirement requested", and the
confirmation message says plainly that their agent will be destroyed and the slot recycled.
The "pool is empty" error gets honest: if a recycle is in flight it says a blank is minutes
away instead of "contact support". Reactivating someone cancels a still-pending retirement.

**Phase 2 — the request travels.** The 5-minute pull the box already makes gains a
`retirements` list ("destroy s4"), and a new authenticated endpoint lets the box report back
"s4 is gone, s5 is racked, its bot is @ragisan03_bot" — the server stamps the old row retired
and inserts the new blank into the pool.

**Phase 3 — badges install themselves.** Today a freshly minted spine credential waits in a
file for an operator to paste in and restart the container; badge-pull now does that itself,
falling back to the file only on failure.

**Phase 4 — the box does the heavy lifting.** badge-pull queues each retirement and kicks a
recycler service: back up identity → recover the bot token → journal → destroy → provision a
fresh blank under the next ref with the same bot → report back. One recycle at a time; a crash
resumes from the journal next tick.

**Phase 5 — prove it live.** Deploy, then run the real thing: `office-dispatch` (already
offboarding, holding s4) becomes the first recycle, and a real-phone swap E2E confirms a
manager can deactivate + rehire with zero operator help.

```
manager confirms deactivate ──► roster: offboarding + pool row: retire_requested
        (warning shown)                        │ ≤5 min (existing pull)
box badge-pull: retirements[s4] ──► queue ──► recycler.service (serialized)
   backup identity → recover bot token → destroy s4 → provision s5 (~10 min)
        │ POST /control/sandboxes {retired: s4, new: s5, bot: @handle}
server: s4 row retired_at ✓ + NEW pool row s5 (free) ──► next bind_telegram claims it
```

## Secrets & env preflight

- **Phases 1–2:** local Supabase stack running (`.env.test` — already required). No new secrets.
- **Phase 3:** none new (tests stub the install command).
- **Phase 4:** SSH access to trades-box-1 (user-run deploy or approved commands);
  `/root/nemoclaw-provision.env` on the box must hold a CURRENT `NVIDIA_INFERENCE_API_KEY`
  (user refreshes it — the old `/root/s4-nvidia.env` copy is stale). `HOST_PULL_TOKEN` +
  `PULL_URL` already in `/etc/doorman/badge-pull.env`. Bot tokens never leave the box.
- **Phase 5:** `supabase-test` MCP (pilot `apply_migration`); Render dashboard (user confirms the
  LIVE commit hash — "Redeploy" re-runs the old commit); two real phones (user).

## Phase 1: Server-side retirement bookkeeping

### What this phase does
Schema + db layer for retirement, the deactivation hook, and honest manager-facing copy.

### Changes required

**`supabase/migrations/20260712090000_sandbox_pool_retirement.sql`** (new)
```sql
alter table sandbox_pool
  add column retire_requested_at timestamptz,
  add column retired_at timestamptz,
  add column retired_technician_id uuid references technicians(id);
```
Apply locally, then regenerate types with `npx supabase gen types typescript --local > src/db/database.types.ts`
(NOT `npm run gen:types` — it is `--linked` and drops these columns until Phase 5's pilot migration).

**`src/db/sandboxPool.ts`** — four additions (existing idioms: write-if-null, SQLSTATE surfacing):
- `requestSandboxRetirement(technicianId: string): Promise<SandboxPoolRow | null>` — UPDATE
  `retire_requested_at = now()` WHERE `technician_id` eq AND `retire_requested_at IS NULL`;
  `maybeSingle`; null = no pool row or already requested (idempotent).
- `cancelSandboxRetirement(technicianId: string): Promise<SandboxPoolRow | null>` — UPDATE
  `retire_requested_at = null` WHERE `technician_id` eq AND `retire_requested_at` not null AND
  `retired_at` is null; null = nothing pending (either never requested, or already destroyed).
- `listRetirementsForHost(hostId: string): Promise<SandboxPoolRow[]>` — WHERE `host_id` eq AND
  `retire_requested_at` not null AND `retired_at` is null.
- `completeSandboxRecycle(input: { hostId: string; retiredSandboxRef: string; newSandboxRef: string; botUsername: string | null }): Promise<{ retired: boolean; registered: boolean; tenantId: string; retiredTechnicianId: string | null }>` —
  step 1: read the (host, sandbox_ref) row for `technician_id`/`tenant_id`, then CAS-style UPDATE
  `{ retired_at: now, retired_technician_id: <technician_id>, technician_id: null }` guarded on
  `retire_requested_at` not null AND `retired_at IS NULL`. No match → re-read: already-retired =
  idempotent OK (box retry); never retire-requested → throw (`'sandbox was not marked for
  retirement'` — the box cannot retire arbitrary refs).
  Step 2: `registerSandbox({tenantId, hostId, sandboxRef: newSandboxRef, botUsername})`; on
  `23505`, READ the existing (host, newSandboxRef) row and require it to look like this recycle's
  own product — same tenant, `technician_id` null, matching `bot_username` → `registered: false`
  (idempotent retry); mismatch → throw (a silent under-refill otherwise). Rethrow anything else.

**`src/mcp/server.ts`**
- Deactivate handler, in the advisory block after the CAS lands (after line 1329, alongside
  `disablePairing`): `try { await (deps.requestRetirement ?? requestSandboxRetirement)(target.id); } catch { /* advisory — row stays unretired; support can stamp it */ }`.
  Add `requestRetirement` to `ServerDeps` (same pattern as `disablePairing`).
- `needs_confirmation` return (lines 1291-1296): add
  `note: 'confirming permanently destroys ${displayName}\'s assistant and its chat memory; the sandbox is recycled into your pool as a fresh blank within ~15 minutes'`.
- Tool description (lines 290-293): append: `'Confirming also permanently destroys the person\'s assistant (its chat memory) and recycles the slot into the pool as a fresh blank.'`
- Reactivate handler, after the CAS lands (after line 1417's reminder close): advisory
  `cancelSandboxRetirement(target.id)` (dep-injected like `enablePairing`). Then if
  `await getPoolRowByTechnician(target.id)` is null (sandbox already recycled), add to the
  return: `note: 'their previous assistant was already recycled — use bind_telegram to claim a fresh one'`
  (merge with the existing no-mailbox note when both apply).
- Pool-empty error (line 1539): before throwing, check `(await listPoolRows(tenantId)).some(r => r.retire_requested_at && !r.retired_at)`; if true throw
  `'no free sandbox yet — one is being recycled and should be ready in ~15 minutes; try again then'`,
  else keep the existing message.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (330 passed, 1 pre-existing key-gated skip)
- [x] New `src/db/sandboxPool.test.ts` cases: request idempotent (second call null); cancel clears a pending request but not a completed one; list scoped to host, excludes retired; completeSandboxRecycle happy path (old row stamped, `technician_id` moved to `retired_technician_id`, new row free, tenant inherited), retry idempotency (both halves), rejection of a never-requested ref, and rejection of a 23505 against a mismatched pre-existing row
- [x] New `src/mcp/server.test.ts` cases: confirmed deactivation calls requestRetirement (dep-injected spy); needs_confirmation carries the destruction note; reactivation cancels a pending retirement and notes an already-recycled sandbox; a reactivated person whose sandbox was recycled can bind_telegram and claim a fresh blank (no 23505, no stale-row recovery); pool-empty error switches message when a retirement is in flight

### Live verification (agent-executable)
- Prerequisites: local Supabase stack seeded (`npm run seed:local`)
- [x] Against the local stack: deactivate a seeded member with a claimed sandbox → read `sandbox_pool` row and confirm `retire_requested_at` is stamped (SQL read-back, evidence: the row) — VERIFIED 2026-07-12 via in-memory MCP flow on local stack: bind→claim `verify-s1`, deactivate confirm → `retire_requested_at=2026-07-12T18:59:21.686Z`, reactivate → cancelled (null); cleanup verified

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 2: Control-plane transport (pull payload + report-back endpoint)

### What this phase does
Ships retirements to the box and accepts the box's completion report.

### Changes required

**`src/control/badgeFile.ts`**
- `BadgeResponse` gains `retirements: Array<{ sandboxRef: string }>` (comment: instruction to
  destroy + reprovision; served until the box reports completion via POST /control/sandboxes).
- `buildBadgeResponse` deps gain `listRetirements?: typeof listRetirementsForHost`; after the
  row loop: `retirements = (await listRetirements(hostId)).map(r => ({ sandboxRef: r.sandbox_ref }))`.
- **Update every existing `src/control/badgeFile.test.ts` call site**: the 8 existing tests pass
  a fake host id and no DB — the live default dep would throw on the non-uuid id and fail the
  suite. Add `listRetirements: async () => []` to the shared stub deps.

**`src/mcp/httpServer.ts`**
- New handler `handleSandboxReport` modeled on `handleBadgePull` (lines 120-138): same Bearer →
  `getHostByTokenHash(sha256hex(...))` auth, bare 401 on failure. Parse JSON body
  `{ retiredSandboxRef, newSandboxRef, botUsername }` (strings; botUsername nullable, validate
  `/^@[A-Za-z0-9_]{5,32}$/` when present — mirror assign-host.mjs). Call
  `completeSandboxRecycle({ hostId: host.id, ... })`; when it returns a `retiredTechnicianId`,
  clear roster residue via `clearSandboxAssignmentIfRef(id, retiredSandboxRef, host.id)` —
  ref+host-guarded so a retried report can never null a re-bound person's NEW assignment
  *(design of record, revised in review from the earlier advisory `updateTechnician` idea)*.
  200 `{ retired, registered, rosterCleared: true|false|null }` — `false` tells the box to
  retry the whole idempotent report (the only re-drive of a failed clear; see Phase 4 step 6);
  refusals (typed `code:'recycle_refused'`) → 409 `{ error }`; malformed body → 400; anything
  else → 500.
- Route in `handle()` (after line 151): `if (req.url === '/control/sandboxes' && req.method === 'POST')`
  — same pre-`allowed()` placement as the GET (host egress IPs rotate).

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (334 passed)
- [x] `src/control/badgeFile.test.ts`: retirements ride the pull; retired rows drop off (filter locked at the db layer + GET-drops-it in the HTTP loop); empty when none
- [x] `src/mcp/httpServer.test.ts`: POST auth (bad token 401), happy 200, retry idempotent 200, never-requested 409, malformed 400
- [x] Curl check against a locally-run server: GET returns `retirements[]`, POST completes one — real curl against `createHttpServer` on :8899, 2026-07-12

### Live verification (agent-executable)
- Prerequisites: local stack; server run locally with test env
- [x] Full loop in one script: request retirement (Phase 1 fn) → GET shows it → POST completes → GET no longer shows it → new pool row is free (SQL read-back evidence) — VERIFIED 2026-07-12: GET `[{"sandboxRef":"curl-s1"}]` → POST `{"retired":true,"registered":true,"rosterCleared":true}` → GET `[]`; read-back: curl-s1 retired+released, curl-s2 free with handle, roster nulled; negatives 401 (empty body) + 409 confirmed

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 3: Box-side badge auto-install

### What this phase does
badge-pull installs each minted badge itself; the pending file becomes the fallback.

### Changes required

**`Box_Setup_Stuff/badge-pull.sh`** — replace the newBadges block (lines 137-141):
- Add env-overridable `BADGE_INSTALL_CMD` (test stub; default empty → built-in path) next to
  `BIND_APPLY_CMD` (line 72). Built-in `install_badge <sandboxRef> <badge>`:
  1. `OSH="$(getent passwd "$NEMOCLAW_USER" | cut -d: -f6)/.local/bin/openshell"` — absolute
     path, NOT bare `openshell` (sudo's secure_path won't find `~/.local/bin`; bootstrap-box.sh
     uses the absolute-path idiom for the same reason, lines 219-220). Then
     `sudo -u "$NEMOCLAW_USER" -H "$OSH" provider update "<sandboxRef>-telegram-bridge" --credential TRADES_SPINE_BADGE=<badge> </dev/null`
  2. find container: `docker ps --format '{{.ID}} {{.Names}}' | awk -v s="$sref" '$2 ~ s'` — the
     agent-name→container mapping must be confirmed on the box during deploy (phase_verify's
     `openshell-*` iteration is the reference); `docker restart <cid>`.
  3. exit 0 only if both succeed.
- Loop `jq -c '.newBadges[]'`: entries with `sandboxRef == null` → pending file (legacy manual
  path, unchanged message). Else try install; success → do NOT write pending (plaintext dies with
  the process — one fewer copy than today); failure → append to pending file + stderr warning +
  unit exits 1 (per-row isolation like the bindings loop).
- Header comment (lines 17-30): rewrite to describe auto-install with manual fallback.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (339 passed)
- [x] `src/control/badgePullScript.test.ts` (existing harness, `BADGE_INSTALL_CMD` stub): install
  invoked with ref+badge; success → pending file absent; failure → pending file written + exit ≠ 0;
  null sandboxRef → straight to pending, stub never called; existing guard tests still pass
  (+ exit-2 stored-not-restarted routing; + badge failure doesn't skip the bindings reconcile)

### Live verification (agent-executable)
- Prerequisites: none beyond CI tools (bash/jq/curl)
- [x] Covered by the harness (15 script tests green); real-box proof deferred to Phase 5's E2E (badge lands + freshness probe green)

### Manual verification
- [ ] none

---
*No manual items — continue.*

## Phase 4: Box-side recycler

### What this phase does
Consumes `retirements[]`: queue → serialized destroy/reprovision/report service. Includes the
vendor-teardown spike. Architectural change → update BOTH `doorman-nemoclaw-setup-guide.md` and
`docs/nemoclaw-tech-agent.md` in the same change (Box Setup Stuff sync rule).

### Changes required

**Spike first (scratch sandbox on trades-box-1, user-approved):** determine the teardown command.
Try `nemoclaw <ref> destroy` (check `nemoclaw --help`); verify: container gone, `sandboxes.json`
entry gone, agent name reusable. If no destroy verb exists, fallback recipe: stop+rm the
container, `jq 'del(.sandboxes.<ref>)'` on `~/.nemoclaw/sandboxes.json` (backup first), remove
per-agent systemd revive unit. Record the outcome in the guide §"recycling".

**`Box_Setup_Stuff/badge-pull.sh`** — append a retirements section after bindings (line 204):
`jq -c '.retirements // []'`; for each `sandboxRef`: skip if present in this pull's `bindings[]`
(safety: an actively-bound sandbox is never queued); write queue entry
`$RECYCLER_QUEUE_DIR/<sandboxRef>` (default `/var/lib/sandbox-recycler/queue`, env-overridable
like `BINDINGS_FILE` so the unprivileged test harness can redirect it; mkdir -p, umask 077);
`systemctl start --no-block sandbox-recycler.service` (env-overridable `RECYCLE_KICK_CMD` stub).
Queueing is idempotent (same filename). Server keeps serving the retirement until the POST
lands, so a lost queue entry self-heals next tick.

**`Box_Setup_Stuff/recycle-sandbox.sh`** (new, root, installed to `/usr/local/sbin/`):
oldest queue entry → for `<ref>`. **Journal-first design** (a crash after teardown must be
resumable — the bot token and `sandboxes.json` entry die with the sandbox):
1. If a journal `/var/lib/sandbox-recycler/journal/<ref>.json` exists (root-only 700 dir), skip
   to the step it records (resume). Otherwise guards: container/agent exists; re-GET
   `$PULL_URL` and require `<ref>` still in `retirements[]` — a reactivation in the last
   minutes cancels the destroy (the seconds-wide race after this check is accepted).
2. `bootstrap-box.sh backup-identity <ref>` (as `$NEMOCLAW_USER`).
3. Recover bot token + handle: `jq -r '.sandboxes["<ref>"].messaging.plan.channels[]? | select(.channel=="telegram") | .inputs[]? | select(.inputId=="botToken") | .value' ~ubuntu/.nemoclaw/sandboxes.json`
   (exact path verified during the spike); `getMe` must succeed (bot deleted at BotFather →
   park queue entry in `…/failed/` + exit 1). Compute the new ref NOW: `s$((max+1))` scanning
   `s<digits>` names in `sandboxes.json`. **Write the journal** `{retiredRef, newRef, botUsername, botToken}`
   BEFORE any destructive step (`sandboxes.json` already holds this token in plaintext at the
   same trust level; the journal is deleted at completion).
4. Teardown per the spike's recipe.
5. Write secrets env (token from journal + `NVIDIA_INFERENCE_API_KEY` from
   `/root/nemoclaw-provision.env`) + hydrate the messaging plan for `newRef` (the §4b
   vendor-node recipe, scripted); `bootstrap-box.sh provision <newRef> <secrets> <plan>` then
   `wire <newRef>` + `boot <newRef>`. (Provision re-runs are the spike's problem to confirm;
   worst case a resumed provision needs a teardown of the half-built `newRef` first — document.)
6. Report: `source /etc/doorman/badge-pull.env`; `curl -fsS -X POST "${PULL_URL%/badges}/sandboxes"`
   with the bearer token and `{retiredSandboxRef, newSandboxRef, botUsername}` from the journal.
   200 with `rosterCleared !== false` → delete journal + queue entry; 200 with
   `rosterCleared: false` → KEEP both and retry next kick (the POST retry is the ONLY re-drive
   of a failed roster-residue clear — once retired, the pull stops serving the ref, and stale
   residue suppresses reactivation's re-bind nudge; retrying is safe, both halves idempotent
   and the clear is ref+host-guarded). 409 → park the entry in `…/failed/` + alarm (the server
   refused: the box's ref is wrong). Other non-200 → keep both (retried next kick), exit 1.
7. Serialization: systemd oneshot refuses concurrent starts; every step is either pre-journal
   (safe to redo) or journal-driven (resumable).

**`Box_Setup_Stuff/sandbox-recycler.service`** (new): oneshot, `User=root`,
`ExecStart=/usr/local/sbin/recycle-sandbox.sh`, no timer (kicked by badge-pull; a stuck queue
retries on every subsequent pull tick).

**`Box_Setup_Stuff/bootstrap-box.sh`** — new `recycler` phase (install script + unit; add to
dispatch list at lines 781-796 and the usage header) and a `phase_verify` line asserting the
queue dir exists and the service file is installed.

**Docs:** guide gains a "Sandbox recycling" section (flow, queue paths, failure modes, the
BotFather-deleted-bot edge); `docs/nemoclaw-tech-agent.md` lifecycle section gains the
deactivate→destroy→restock paragraph and the reactivation-gets-a-blank-agent caveat.

### Automated verification
- [x] `npm run typecheck` / `npm run lint` / `npm test` pass (345 passed)
- [x] badgePullScript tests: retirements enqueue (file created, kick cmd called via stub), skip-if-bound safety, idempotent re-queue, absent key no-op (old server) — plus kick-on-nonempty-queue-with-empty-retirements (the rosterCleared retry re-drive), parked-ref-never-requeued, and failing-kick-goes-red
- [x] `bash -n` on all new/edited shell scripts (badge-pull, recycle-sandbox, bootstrap-box)

### Live verification (agent-executable)
- Prerequisites: SSH to trades-box-1 (user-approved), scratch sandbox for the spike
- [x] Spike evidence (2026-07-12, non-destructive probes on trades-box-1, nemoclaw v0.0.73):
  `destroy` verb EXISTS (`--yes`, `--cleanup-gateway|--no-cleanup-gateway` — recycler pins
  `--no-cleanup-gateway`, shared gateway); dist = `~/.nemoclaw/source/dist`; `channelId` field
  confirmed; `networkPolicy.entries` manifest value captured + embedded; hydration executed
  live → `HYDRATION_OK bytes=5836`. Container-removal semantics of destroy observed at the
  first live recycle (script independently asserts container-gone either way).
- [x] (The full end-to-end recycler dry-run needs the Phase 5 server deploy — the pilot has neither the columns nor the POST route until then; it is Phase 5's first live check, deliberately NOT here)

### Manual verification
- [ ] User refreshes `/root/nemoclaw-provision.env` with the current NVIDIA key before Phase 5
- [x] User decision if the spike finds no vendor destroy verb — MOOT: the verb exists

---
*Pause here — the spike outcome needs user-side access and possibly a decision.*

## Phase 5: Pilot deploy + live swap E2E

### What this phase does
Deploys server + box, then proves the whole loop with the existing residue as the first case.

### Changes required
In this order (the box work depends on the server being live first):
1. Pilot migration via `supabase-test` MCP `apply_migration` (never db push); Render deploy —
   user confirms the LIVE commit hash in the dashboard; restart sandbox containers whose agents
   must see changed tool descriptions (descriptions are fetched once per process).
2. Box deploy: updated badge-pull.sh, recycle-sandbox.sh, unit, bootstrap phases (`recycler`,
   re-run `verify`).
3. First recycle = existing residue: stamp `retire_requested_at` on `office-dispatch`'s s4 row
   (it is already offboarding — Phase 1's hook never ran for it) and let the machinery run.

### Automated verification
- [ ] All four gates green on main before deploy (`typecheck`, `lint`, `test`, `build`)

### Live verification (agent-executable)
- Prerequisites: supabase-test MCP; box SSH (user-approved)
- [ ] s4 recycled: pilot `sandbox_pool` shows s4 `retired_at` set + new free row with a bot handle; box shows old container gone, new agent polling; OCSF/doorman logs clean
- [ ] Badge auto-install proof: next claimed member's badge lands with NO operator paste (freshness probe green after the automatic restart)

### Manual verification
- [ ] Real-phone swap E2E (user, both phones): deactivate a demo member (confirm message shows the destruction warning) → add replacement → bind → new person's /start works on the recycled blank's bot; deactivated person's phone gets silence
- [ ] Judy's real tenant untouched throughout (s3 never appears in any recycler log)

---
*Pause after this phase — E2E requires the user.*
