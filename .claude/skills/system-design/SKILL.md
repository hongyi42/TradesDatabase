---
name: system-design
description: Principles for system design, database migrations, production changes/deploys, and failure handling on this repo — the hard-won rules distilled from its incident history. Tier 1 is the always-on core; the by-situation tiers are lookups. Consult before any schema change, migration, deploy/rollout, new subsystem design, or when handling a live failure.
---

# System design & change

Rules distilled from this repo's incident history. Each carries one concrete example. Tier 1 is the
core (almost every change); Tiers 2–6 are situational lookups. Full evidence:
`thoughts/shared/research/2026-07-30-system-design-principles-for-skill.md`.

---

## Tier 1 — Core (almost every change)

1. **Gate before the irreversible write, never after.** *Ex:* work-vs-personal classification runs
   before the L1 `raw_captures` insert (`webhook.ts`) — L1 has no delete path.
2. **When a behavior must hold, move it into the mechanism, not a prompt.** *Ex:* GLM kept skipping
   `endTime` → PR #53 made it a required param.
3. **One write path, one gate.** *Ex:* board gestures call the same `src/schedule/booking.ts` verbs
   as chat, through the same confirmation gate.
4. **One source of truth, many readers, agree by construction.** *Ex:* chat-confirm and the board
   view both call `assessStagedFreeze` (`freezeProposal.ts`) — never hand-mirrored checks.
5. **Fail closed on the safety axis.** *Ex:* `testEnvGuard` treats a URL parse failure as non-local
   and refuses to run.
6. **Verify what's actually running; read back what actually happened.** *Ex:* Render "Redeploy"
   re-runs the OLD commit — confirm the live hash; a stalled turn's `set_availability` writes had
   landed, only the reply died.
7. **Confirm only the irreversible/externally-visible; else just do and say so.** *Ex:*
   `requiresConfirmation` on booking previews, keyed to the promise ladder.
8. **Hardcode what must be correct; let the model interpret.** *Ex:* identity matching is hardcoded
   and tested (`identityMatch.ts`); field extraction is left to the model.
9. **Rollout order is a design artifact — write it down, name the class.** *Ex:* the freeze's
   one-time lock reset runs AFTER deploy; the digest shipped as board-worker redeploy only.
10. **Keep a reversible escape hatch.** *Ex:* the GLM provider swap kept `MODEL_PROVIDER=anthropic`
    as a one-env-var revert.
11. **Verify vendor claims against live docs, cite the URL, read deprecations precisely.** *Ex:*
    "Composio managed OAuth is dead" was wrong — only the `initiate()` method was retiring, `link()`
    was fine.
12. **Narrow first, widen deliberately.** *Ex:* build order = schema → one write path end-to-end →
    read/synthesis → more channels.

## Tier 2 — Database & schema changes

- **Migrations don't auto-apply — separate apply from deploy.** *Ex:* pilot DDL goes through the
  Supabase MCP `apply_migration`; Render only builds+starts.
- **Order deploy vs. migrate; the safe order fails noisily.** *Ex:* deploy-before-migrate → PostgREST
  "unknown column" (2026-07-19); fix = apply migration + `NOTIFY pgrst, 'reload schema'`.
- **Trust schema read-backs, not the version ledger.** *Ex:* the MCP stamps its own apply-time
  version → confirm via SELECT; never run `db push --linked`'s repair suggestion.
- **Know silent caps and paginate past them.** *Ex:* PostgREST caps responses at 1000 rows →
  `foldImpact.ts` pages until a short page.
- **Narrow a guard to exactly the rows it means.** *Ex:* `no_confirmed_overlap` is scoped to placed
  rows — an unplaced null-range row would have blocked the whole calendar.
- **Encode invariants as DB constraints, not just app checks.** *Ex:* the L1 append-only trigger; the
  `assignment_placed_or_windowed` CHECK (PLACED xor UNPLACED).
- **Invalidate derived columns in the same UPDATE that changes their source.** *Ex:* changing an
  address nulls `lat/lng/geocoded_at` together (the `customers.ts` guard).
- **Dated debts carry a date + trigger.** *Ex:* the `auto_expose_new_tables` GRANT migration is due
  before 2026-10-30.
- **All DB access through the typed layer.** *Ex:* everything routes via `src/db/` — no hand-written
  Supabase queries elsewhere.

## Tier 3 — Production changes & deploys

- **Verify the live commit hash after deploying.** *Ex:* two E2E attempts failed on stale server code
  because "Redeploy" re-ran the old commit.
- **Enumerate live targets from ground truth at rollout time.** *Ex:* a fleet pass missed s7 (added
  since the written map) → use `nemoclaw list` + `channels status`, not a remembered map.
- **A change takes effect only at a boundary — force it in the rollout.** *Ex:* a badge in the store
  but absent from the process env silently killed Judy's MCP for 4 days (creds inject at container
  launch only).
- **Follow the written rollout order.** *Ex:* a one-time data fix run before the deploy is undone by
  the old code (the freeze lock reset).
- **Verify on the authoritative path, not a proxy.** *Ex:* a CLI probe truncates AGENTS.md at 12k
  chars — the Telegram path is the authority.
- **Platform env values are bare.** *Ex:* dotenv quotes around `GOOGLE_ROUTES_SA_KEY_JSON` are file
  syntax, not part of the value — paste raw.

## Tier 4 — Failure handling & resilience

- **A best-effort decoration must never break a committed action.** *Ex:* the temporal `now` rider
  omits itself on failure rather than erroring an already-committed tool result.
- **Distinguish reachability from function in health checks.** *Ex:* the medic v2 probe passed twice
  while real completions hung ~12 min — it validated key+endpoint, not the work path.
- **A component can be alive-but-dead.** *Ex:* a deactivated seat's bot answers small talk while every
  spine call 403s (native `web.fetch` masks the dead MCP).
- **Trust your own evidence over vendor status pages; read back the real effect.** *Ex:* DeepInfra
  stayed green through two real outages; the stalled turn's DB writes had actually landed.
- **Make silent failures loud — a green signal must never hide a dead subsystem.** *Ex:* a missing
  `COMPOSIO_API_KEY` returned `{skipped}` on a green cron; `ALLOWED_CLIENT_IPS` empty defaults to
  allow-all. Fix pattern: fail-fast config validator at boot, fail-closed on dangerous flags
  (empty allowlist / `INBOUND_DEBUG` in prod → refuse to boot), loud cron skips, and a canary that
  does a **real completion, not a ping** (the medic ping passed while completions hung). Full spec:
  `prod-migration-checklist.md` B3 + Tier 10.
- **Assume at-least-once delivery; dedup at the sink.** *Ex:* Composio retries a webhook ~5s in →
  duplicate visit, caught only because L1 dedup holds.
- **Guard inbound boundaries: signature + replay window + length check, never throw.** *Ex:*
  `verifyWebhookSignature` — HMAC over `id.timestamp.body`, 300s tolerance, length-guard before
  `timingSafeEqual`.
- **Write the diagnosis recipe down after an incident.** *Ex:* the medic-stall recipe (log grep → read
  back writes → keyless curl → journalctl → probe) in `engineering-memory.md §2`. **When triaging a
  live incident,** that file is the runbook: §2 for the model/inference recipes, §5 ("the walls") for
  the box/spine/Composio traps (zombie seat, `web.fetch` masking a dead MCP, shields-lock,
  rebuild-destroys-device-key), and `prod-migration-checklist.md` Tier 9 for the DR/rollback drills.

## Tier 5 — Data & subsystem design

- **Structure only what you act on; preserve the rest verbatim; long tail in a flexible layer; link
  every field to its evidence.** *Ex:* L1 raw / L2 typed columns / L3 JSONB `attributes`, each field
  carrying `source_capture_id`.
- **Model lifecycle as a state machine; authoritative signal = a downstream business event.** *Ex:*
  job `open → in_progress → completed → invoiced → paid` — "done" is the invoice paid.
- **Identity matching is hardcoded and tested, never a model guess.** *Ex:* `identityMatch.ts` decides
  which existing customer/job a capture belongs to.
- **Hold a scope boundary: originate in one place, display in others.** *Ex:* "spine originates, sheet
  displays" — don't mirror a connector's data into the system of record.
- **Design write-paths channel-agnostic.** *Ex:* adding a channel = adding a normalizer
  (`normalize.ts` registry; `gmail.ts` self-registers), not a new pipeline.

## Tier 6 — Agent behavior & safety rails

- **Move required behavior into the mechanism.** *Ex:* GLM skipped the board link → PR #59 fused it
  into the result string.
- **Give the executor less to get wrong.** *Ex:* week-mode returns both candidate dates + an ask-note
  instead of making the model compute and compose.
- **Refreshable instruction blocks, not append-once.** *Ex:* AGENTS.md blocks are delete-then-append
  per `wire` run, so they don't drift stale.
- **Don't surface solver-internal flags to humans until the consumer exists.** *Ex:* the
  `assignments.locked` badge was pulled from the UI (PR #74) — it read as a promise it didn't make.
- **Encode the lesson as a fail-closed guard with the incident in the comment.** *Ex:* `testEnvGuard`'s
  comment cites the 2026-07-03 roster truncation.
- **Keep guards pure + tested; hard-pin destructive tooling to safe targets.** *Ex:* the suite is
  host-pinned to the local stack; prod is read-only; ambiguous input fails closed.
- **Live-only behavior needs live-gated tests.** *Ex:* Google Routes' `optimizedIntermediateWaypoint
  Index: [-1]` sentinel appears only against the real API.
- **Secrets: fingerprints only; store key-names, not values, in undeletable logs.** *Ex:* a 2026-07-03
  badge-plaintext leak forced rotating every badge — sha256 only since.

---

*Full derivation + anchors: `thoughts/shared/research/2026-07-30-system-design-principles-for-skill.md`.
Context: `docs/engineering-memory.md`. Keep synced — verify against code, don't assert from memory.*
