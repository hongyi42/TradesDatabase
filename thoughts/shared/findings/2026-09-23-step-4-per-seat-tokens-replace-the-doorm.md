---
date: 2026-09-23
task: Step 4: per-seat tokens replace the doorman's badges — Render mints one token per seat (with its firm timezone), identity.ts verifies it, the glue stops holding GATEWAY_IDENTITY_SECRET
status: complete
origin: 
files: src/mcp/identity.ts, src/mcp/httpServer.ts, src/control/badgeFile.ts, src/control/badges.ts, src/db/sandboxPool.ts, src/db/technicians.ts, src/seatGlue/identity.ts, src/seatGlue/engine.ts, src/seatGlue/config.ts, Box_Setup_Stuff/doorman.mjs, Box_Setup_Stuff/badge-pull.sh, Box_Setup_Stuff/seat-glue/install.sh, thoughts/shared/research/2026-09-23-step-4-seat-identity-doorman-badges-sandbox-pool.md, thoughts/shared/plans/2026-09-23-step-4-per-seat-tokens.md, supabase/migrations/20260923200000_seats.sql, src/db/seats.ts, src/db/index.ts, src/db/seats.test.ts, scripts/apply-pilot-migration.mjs
supersedes: nothing
---

## Files

- src/mcp/identity.ts
- src/mcp/httpServer.ts
- src/control/badgeFile.ts
- src/control/badges.ts
- src/db/sandboxPool.ts
- src/db/technicians.ts
- src/seatGlue/identity.ts
- src/seatGlue/engine.ts
- src/seatGlue/config.ts
- Box_Setup_Stuff/doorman.mjs
- Box_Setup_Stuff/badge-pull.sh
- Box_Setup_Stuff/seat-glue/install.sh
- thoughts/shared/research/2026-09-23-step-4-seat-identity-doorman-badges-sandbox-pool.md
- thoughts/shared/plans/2026-09-23-step-4-per-seat-tokens.md
- supabase/migrations/20260923200000_seats.sql
- src/db/seats.ts
- src/db/index.ts
- src/db/seats.test.ts
- scripts/apply-pilot-migration.mjs

## Notes

Openclaw retirement step 4 (memory openclaw-retirement-plan; operator parked it 2026-09-23). Today the seat glue signs identity itself with GATEWAY_IDENTITY_SECRET (src/seatGlue/identity.ts, a step-1 stopgap: one host secret that can sign as anyone, in the glue process). Replace it with one token per seat minted by the spine and verified by src/mcp/identity.ts; the glue holds only its seat's token + bot token. Also carries: Render sends each seat's firm TIMEZONE with its details (step 1 hand-sets SEAT_TZ in /etc/seat-glue/<seat>.env, "retire in step 4").
Constraint (inferred from the code, not measured): the doorman, badges.json, badge-pull and sandbox_pool (16 call sites, 4 migrations) still serve every seat that runs openclaw (s2, s3, s7, s8) until step 5 — step 4 can add the token path beside them, but retiring them waits for the last seat to move.
Operator decisions: what a seat IS once the pool is gone (roster row + bot + token); token rotation/revocation (today deactivation bites via the roster check in dispatch, src/mcp/server.ts:610-613). Related open item: 20260919-manager-settings-page (bot tokens and ids in a settings UI).

## Handoff 2026-09-23T16:10:57.849Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/step-4-per-seat-tokens-replace-the-doorm on work/step-4-per-seat-tokens-replace-the-doorm, from origin/main c655f91.

Overlap check: none with any active task.

## Handoff 2026-09-24T01:39:32.173Z

**What changed** — A glue seat now proves who it is with its own revocable bearer token (`st_`+64 hex; Render keeps only sha256 in `seats.token_hash`) instead of HMAC-signing with GATEWAY_IDENTITY_SECRET; the glue asks `GET /seat/whoami` at start for firm/person/Telegram id/timezone, and `install.sh <seat>` mints (= rotates) the token with the box's host token via `POST /control/seat-token`. LIVE: PR #281 (phases 1-3) + PR #282 (phases 4-5), web at 4ab4296; s5's env holds no identity secret since 2026-09-23 21:13 UTC, phone-tested (spine calls recorded as ben-shelton). `bind_telegram` can now give a new hire a `g_…` glue seat from a registered `seat_bots` row (dormant on the pilot: no seat bots registered). Pilot migration `20260923200000_seats` applied by the operator with the new `scripts/apply-pilot-migration.mjs` (ledgered under the file's version). In-place extras: that script; token generator named `newSeatToken` (db already had `mintSeatToken`); allowlist union in `botIds.refresh` (import cycle).

**Decisions** — Operator: scope = 4a+4b; ALL removal (doorman, badges, badge-pull, sandbox_pool, /control/{badges,sandboxes,seat-bots}, badge_hash, HMAC path, hosts) moves to STEP 5. A seat = a `seats` row, GLUE seats only (plan review rejected mirroring OpenClaw seats: two records to keep in step through recycles/rebinds/rollback). Bots = own record `seat_bots`, granularity OPEN (operator asked "one bot for all by user id?" — viable on the glue since the August router blocker was openclaw's outbound hooks; decide in step 5). Token delivery "C" (install fetches via host token) over printed/pasted (plaintext through terminal/chat) and box-pull timer (lost-response silently kills a seat; 4th unit). Glue learns identity via whoami at start. Final review: a running glue learns of deactivation/rebind ONLY on restart until STEP 3's pull carries "your seat changed" (operator; Render cannot call the box; rejected: glue polling timer, long-lived line, refusal trigger). Badge kept for any glue seat that still has a pool sandbox (so rollback.sh needs nothing new).

**Assumptions** — ALLOWED_CLIENT_IPS is unset on Render (the new routes sit before allowed(), /mcp after it) — not checked. The g_ glue-seat bind path is tested locally only; no real seat bot or /root/bots/<handle>.env exists yet, so a first real g_ install is unproven on the box. The OpenClaw seats still on the doorman are the packet's s2, s3, s7, s8 (my chat said "s1-s4" — wrong).

**Open** — Step 3 owns: office/nudge delivery to glue seats (g_ items burn ~10 serves then escalate) AND the "seat changed" signal. Step 5 owns: every removal above, a `seats` row per moved seat (`assign-host.mjs add-glue-seat` then `install.sh` then `cutover.sh`), the bot model, drop `seats_live_bot_key` if bots go per firm, a provisioner. Offboarding a glue seat keeps its bot. A manager bound onto a glue seat runs technician doctrine until step 2.

**Downstream** — Step 2 worktree (manager seat s2 on the glue) must build on the NEW install.sh (no SEAT_* identity env; SEAT_TOKEN; mint after selfcheck) and on `seatDeps(cfg, who, …)`/`engineConfig(cfg, who)` signatures in src/seatGlue/main.ts. Anyone touching bind_telegram: branch order is recovery-first (see roster.ts claimGlueSeat).
