---
date: 2026-08-15
task: Part D direction — accounting-grade money via the firm's own books (QuickBooks/Stripe ingestion)
research: none yet (this is a direction sketch, not an implementable plan — run /research + /plan when picked up)
status: direction
depends: parts A (done) + B; independent of C
---

# Accounting ingestion — the direction, in one page

## Why this exists (the trust argument, user decision 2026-08-15)

Inference over emails/notes can never be accounting-grade: the manager's head (or their books)
always knows something our shadows don't, and every discrepancy the manager has to "correct"
spends trust the agent needs for everything else. The structural fix is not better inference —
it is making the numbers **theirs**: ingest the firm's real money system (QuickBooks, Stripe,
Square, …), so the ledger mirrors their books and our job shrinks to what we're actually good
at — **linking each book entry to the right job** in the spine. For a connected firm there is
no "their number vs. our number"; there is only their number, now job-aware.

Part B's role once this lands: inference demotes from *discovering amounts* to (a) the bridge
for firms with nothing connected, and (b) the cash-detector — cash handed to a technician
appears in no money system and no email, only in a field note.

## Shape of the build (sketch — verify everything against live docs at plan time)

1. **Transport:** Composio toolkits for the accounting provider(s) — webhook/trigger ingestion,
   like the Gmail sweep. Repo trap to re-check: Composio webhook subscription is SDK-only.
   Which providers first is a USER/market decision (pilot firms' actual books decide).
2. **L1:** producer for the reserved `accounting_event` channel (schema has it; zero producers
   today). Needs its own recorded capture policy: these are business money records — full-value
   capture is the point — but it is a NEW policy entry, not covered by the 2026-07-04 outbound
   exception. L1 is undeletable; decide fields deliberately.
3. **L2/ledger mapping:** each book entry → `money_events` row with `external_ref` = the
   provider's id (natural idempotency: provider id in `dedupe_key`), `source_capture_id` =
   the L1 row, `actor_ref: 'ingest:<provider>'`. The provider's edits/voids map onto the
   ledger's correction/void kinds — their books stay the source of truth, our ledger mirrors.
4. **Job linkage (the real work):** deterministic first (provider customer email/phone →
   spine customer → open job — part B's attribution machinery reused verbatim); anything
   ambiguous becomes a `money_event_suggestion` ("QuickBooks invoice #1042, $450, matches two
   open Henderson jobs — which one?"). Linkage asks; it never guesses.
5. **Reads:** evidence tier `'books'` added to the part-B provenance vocabulary — the agent can
   finally say "per QuickBooks" — and the digest gains a reconciliation section (book entries
   that matched no job; jobs invoiced in books but open in the spine).

## What this is NOT

- Not scheduled, not sized, not researched — gated on a real firm with connected books wanting
  it. When picked up: full /research (provider APIs, Composio toolkit coverage, auth custody)
  → /plan cycle.
- Not payment processing. Ever-closer to the books ≠ moving money.
- Not a replacement for part B — un-connected firms and cash remain inference's territory.

## Open questions for the eventual research phase

1. Which providers do the pilot + near-term firms actually use (QuickBooks Online vs Desktop
   matters enormously)?
2. Composio toolkit coverage/scopes for those providers; webhook payloads; historical backfill.
3. Multi-source precedence: books entry vs. an earlier inferred event for the same invoice —
   dedupe/supersede policy (likely: books row supersedes; inferred row gets corrected).
4. Where the reconciliation view lives (digest-only vs. a board surface).
