# Build schedule — parked features & future candidates

The holding pen for features we've decided NOT to build yet, so they don't get lost.
When one gets picked up: run `/research` on it (the RPI cycle starts fresh from the entry's
context links), then plan → approve → implement as usual.

Each entry records: what it is, why it's parked, what would trigger building it, and where
the prior thinking lives. Newest decisions at the top of each entry.

---

## Feature C — per-tenant agent memory (parked 2026-07-04, reaffirmed 2026-07-06)

**What:** a real memory layer for the agents — soft, narrative knowledge ("Mrs. Lee prefers
morning visits", "the manager likes totals rounded") stored server-side per tenant, next to
the spine. Shared by all of a tenant's agents, survives sandbox rebuilds by construction,
tier-aware, and every memory must cite the L1 evidence it came from.

**Why parked:** no demonstrated need yet. Today's substitutes cover the ground:
- Customer/business facts → `record_field_note` L3 attributes (gate codes, pets,
  preferences) — permanent, evidence-linked, visible to every agent and briefing.
- Personal tone preferences → the bot's own sandbox `MEMORY.md` (OpenClaw convention;
  per-bot, informal, zero files written as of 2026-07-06).

**Trigger to build:** "remember this" becomes a real usage pattern in the pilot — i.e.
technicians/managers repeatedly ask the bots to hold things that DON'T fit the customer
record. Secondary trigger: a sandbox rebuild loses a MEMORY.md someone actually cared about.

**Design constraints already decided (2026-07-04 brainstorm, recorded in session memory
`spine-capture-expansion`):**
- Memory must never REPLACE L2 — free text can't aggregate, dedup, or enforce integrity.
- Every memory cites L1 evidence ids (same provenance discipline as synthesis citations).
- Open questions for the RPI: where it lives (table shape), per-person vs per-tenant scope,
  tier sensitivity on memories, write discipline (confirm-gated like notes?).

**Interim stopgap if needed before this ships:** a host-side reconciler on trades-box-1 that
auto-restores `MEMORY.md` from `~/.nemoclaw/rebuild-backups/` after a rebuild (~30 min build,
throwaway once Feature C exists). Not built — build only if MEMORY.md usage starts first.

---

## Phone-call input channel (researched + planned 2026-06-30; not implemented)

**What:** phone calls as a spine capture channel (the `phone_call` enum value already exists).
**Where the thinking lives:** `thoughts/shared/research/2026-06-30-phone-call-input-feature.md`
and `thoughts/shared/plans/2026-06-30-phone-call-input-short-two-tier.md`.
**Trigger:** pilot demand for call capture; re-check the plan against the codebase before
implementing (it predates the note-lifecycle stage→confirm rework of the write path).

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
