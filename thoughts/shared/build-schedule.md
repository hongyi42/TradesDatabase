# Build schedule — parked features & future candidates

The holding pen for features we've decided NOT to build yet, so they don't get lost.
When one gets picked up: run `/research` on it (the RPI cycle starts fresh from the entry's
context links), then plan → approve → implement as usual.

Each entry records: what it is, why it's parked, what would trigger building it, and where
the prior thinking lives. Newest decisions at the top of each entry.

---

## Feature C+D — per-tenant agent memory on a completed L3 write surface (merged 2026-07-11; C parked 2026-07-04, D split out 2026-07-09, folded back in)

One feature in two phases, planned as a single RPI cycle. Phase 1 (formerly **Feature D**) is
the structured substrate; Phase 2 (formerly **Feature C**) is the memory layer on top. Phase 1
is **independently shippable** — if only its trigger fires, run the RPI on this entry but scope
the plan to Phase 1.

**STATUS 2026-07-14: Phase 1 is implemented** (RPI cycle run 2026-07-13/14; user decisions:
new `record_standing_fact` spine tool, wrapped-value provenance in the existing `attributes`
JSONB, retraction-fold as the removal path). Research:
`thoughts/shared/research/2026-07-13-feature-cd-l3-write-surface-and-agent-memory.md`; plan:
`thoughts/shared/plans/2026-07-14-feature-cd-phase1-standing-facts.md`. **Phase 2 stays parked**
with the triggers below; its RPI should start from that research doc plus the shipped Phase-1
shape (facts are `{value, sourceCaptureId, recordedAt}` bundles — memory rows cite L1 the same
way).

**The division-of-information rule (why these are one feature):** a remembered fact about a
*customer or job* belongs in L3 via Phase 1 (structured key/value — queryable, aggregatable);
everything else — soft narrative knowledge that doesn't fit the customer record — belongs in
Phase 2 memory. Building memory without the L3 path would turn memory into a shadow customer
database in free text (can't aggregate, dedup, or enforce integrity), which is the failure mode
the 2026-07-04 constraints forbid. Tiebreaker for ambiguous facts: if you'd ever filter or
aggregate on it, it's L3.

### Phase 1 — customer/job-level L3 input path (was Feature D, parked 2026-07-09)

**What:** a write path that sets a **standing attribute on a customer or job** (not just a visit) —
e.g. "prefers email", "gate code 1234", "commercial account". The `attributes` JSONB already
exists on `customers` and `jobs` ([src/db/customers.ts:16](../../src/db/customers.ts#L16),
[src/db/jobs.ts:35](../../src/db/jobs.ts#L35)) and `createCustomer`/`createJob` accept it, but
**no live caller ever passes it** — today's only L3 writer is `recordFieldNote` →
`buildVisitAttributes` → `createVisit`, so every extracted long-tail fact lands on a single
**visit** ([src/writePath/recordFieldNote.ts:213-220](../../src/writePath/recordFieldNote.ts#L213-L220)).
This phase completes the L3 write surface: a confirm-gated, provenance-linked ("cites the L1
capture") upsert of a key/value onto the customer or job row, reachable as a spine tool.

**Why parked:** it's a spine write-path change (touches the stage→confirm machinery and the
retraction/audit story), and there's no demonstrated pull yet — the note→visit path covers
trip-scoped facts.

### Phase 2 — per-tenant agent memory (was Feature C; parked 2026-07-04, reaffirmed 2026-07-06, revisited 2026-07-09)

**What:** a real memory layer for the agents — soft, narrative knowledge ("Mrs. Lee prefers
morning visits", "the manager likes totals rounded") stored server-side per tenant, next to
the spine. Shared by all of a tenant's agents, survives sandbox rebuilds by construction,
tier-aware, and every memory must cite the L1 evidence it came from. Phase 1 is its
evidence-linked storage primitive at the L2-row level — customer/job facts route there, keeping
memory small and genuinely limited to what doesn't fit the record.

**Update 2026-07-09 (long-running-agent research):** two of the "substitutes" below turned out
weaker than recorded — see the corrections. Also a NEW consumer appeared: the batching block
(setup guide §0d) has the backlog agent distill task learnings into `MEMORY.md` on completion,
so agent-authored `MEMORY.md` files will now actually get written — which arms Phase 2's
secondary trigger ("a rebuild loses a MEMORY.md someone cared about"). OpenClaw's native memory
mechanics are now verified (MEMORY.md auto-loads per session; `memory/YYYY-MM-DD.md` daily notes;
`commitments` for short-lived follow-ups — https://docs.openclaw.ai/concepts/memory). Research:
`thoughts/shared/research/2026-07-08-long-running-agent-tasks.md`.

**Why parked:** no demonstrated need yet. Today's substitutes partly cover the ground:
- Customer/business facts → `record_field_note` L3 attributes — permanent, evidence-linked,
  visible to every agent and briefing. **CORRECTION (2026-07-09):** this only lands attributes on
  the **visit** row (`recordFieldNote` → `buildVisitAttributes` → `createVisit`); it does NOT set a
  standing **customer/job**-level attribute (those columns exist but have no live writer). So a
  durable per-customer fact ("prefers email") currently has no clean home — it ends up on one
  trip's visit, tied to that note. That gap is Phase 1 above, and it is a prerequisite for
  Phase 2's provenance-linked memory.
- Personal tone preferences → the bot's own sandbox `MEMORY.md` (OpenClaw convention;
  per-bot, informal). **CORRECTION (2026-07-09):** "survives sandbox rebuilds by construction" (the
  "What" above) is the DESIGN GOAL, not the MEMORY.md reality — a rebuild wipes the whole workspace
  including `MEMORY.md`, same as it wipes AGENTS.md. Only the host-re-appended §0c/§0d blocks come
  back; agent-authored MEMORY.md does not. That's exactly why Phase 2 wants server-side storage.

**Design constraints already decided (2026-07-04 brainstorm, recorded in session memory
`spine-capture-expansion`):**
- Memory must never REPLACE L2 — free text can't aggregate, dedup, or enforce integrity.
- Every memory cites L1 evidence ids (same provenance discipline as synthesis citations).
- Open questions for the RPI: where it lives (table shape), per-person vs per-tenant scope,
  tier sensitivity on memories (e.g. manager-only memories technicians can't read — the
  manager/technician tier machinery exists elsewhere, its application to memory rows does not),
  write discipline (confirm-gated like notes?), and the retrieval story (selective recall,
  NOT MEMORY.md-style load-everything — unbounded context growth is the thing to avoid).

**Interim stopgap if needed before Phase 2 ships:** a host-side reconciler on trades-box-1 that
auto-restores `MEMORY.md` from `~/.nemoclaw/rebuild-backups/` after a rebuild (~30 min build,
throwaway once Phase 2 exists). Not built — build only if MEMORY.md usage starts first.

### Triggers to build

- **Phase 1 alone:** the batching agent (§0d) or a manager repeatedly wants to record a
  standing customer/job fact and the visit-level landing proves wrong (facts scattered across
  trips, not queryable at the customer level).
- **Both phases:** "remember this" becomes a real usage pattern in the pilot — i.e.
  technicians/managers repeatedly ask the bots to hold things that DON'T fit the customer
  record. Secondary trigger: a sandbox rebuild loses a MEMORY.md someone actually cared about
  (now more likely once §0d starts writing MEMORY.md distillations). Either way Phase 1 lands
  first within the cycle.

**Where the thinking lives:** this entry + the L3 walkthrough in the long-running-agent chat;
research context `thoughts/shared/research/2026-07-08-long-running-agent-tasks.md`. Related:
`spine-capture-expansion` session memory (L2 fixed / L3 elastic; note lifecycle). Run
`/research` fresh before planning — the write path changed under the note-lifecycle
stage→confirm rework.

---

## Phone-call input channel (researched + planned 2026-06-30; not implemented)

**What:** phone calls as a spine capture channel (the `phone_call` enum value already exists).
**Where the thinking lives:** `thoughts/shared/research/2026-06-30-phone-call-input-feature.md`
and `thoughts/shared/plans/2026-06-30-phone-call-input-short-two-tier.md`.
**Trigger:** pilot demand for call capture; re-check the plan against the codebase before
implementing (it predates the note-lifecycle stage→confirm rework of the write path).
**Reconciled 2026-08-04:** both docs now carry a dated update block mapping the drift since
2026-06-30 — GLM-5.2 (not Sonnet) extraction, per-person `user_id` attribution (no more
`connector:`), the cost ledger (telephony/STT = counter + bill), and a 🛑 safety fix (the plan's
`supabase-test` MCP migration steps hit the pilot's LIVE DB — use the local stack). Still a full
`/research`→`/plan` before `/implement`.

---

## Connector-data mirroring (DE-QUEUED 2026-07-06 — build only on customer demand)

**What:** reconciliation sweeps / OneDrive change triggers / value hashes / deletable value
sidecar for connector-side data (e.g. manager Excel sheets).
**Why parked:** scope decision — the spine is the customer/job record, NOT a mirror of every
connector. Manual-edit invisibility and keys-only audit are ACCEPTED characteristics. The
durable pattern for numbers that matter is "spine originates, sheet displays".

---

## Per-bot scoped JWT / OAuth Resource Server (deferred migration path, 2026-06-23)

**What:** replace the shared-gateway HMAC identity scheme with per-bot scoped tokens
("Option B" of the MCP centralization design). Swaps only the header-verification step;
tools and tenant guards unchanged.
**Trigger:** multi-box scale-out or a security review demanding badge-independent identity.

---

## Retraction L2 compensation (consciously out of scope, 2026-07-06)

**What:** make `retract_capture` also revert L2 side effects of the retracted note (job
status transitions, job title/type, created customer shells). v1 folds captures + visits
only (user decision); jobs/customers stay.
**Trigger:** managers report confusion from surviving L2 facts of retracted notes in
briefings, or a wrong status transition causes a real dispatch mistake.
