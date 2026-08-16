---
date: 2026-08-15
task: Direction — the intelligent spine (a spine-side "team leader" agent; fleet becomes a team)
research: none yet (this is a direction sketch, not an implementable plan — run /research + /plan when picked up)
status: direction
depends: nothing; reframes the front door (onboarding §1, overview §2) and shapes future proactive features
---

# The intelligent spine — the direction, in one page

## The perspective shift this sits on (user decision, 2026-08-15)

The product is the **harness and context-management engine for a fleet of AI agents** serving a
trades firm. The agents are the entire interface; the spine is their shared memory; the harness
(identity, guardrails, confirmation doctrine, date machinery, evals) is what makes their output
trustworthy enough to act on. "One record every role reads and writes" is the same system
described data-first — the agent-first framing is now the front door.

## Today's shape, honestly

A fleet of **freelancers**. Each person's agent acts alone; the only thing connecting them is the
context they all read and write. The spine is passive — a pile of well-organized, evidence-linked
knowledge that answers when queried and otherwise sits still. The closest thing to spine-side
initiative is the 15-minute Render cron: six deterministic sweeps (pairing, grace expiry, session
provisioning, log ingestion, cost backfill/rollup) — reflexes, with no voice and no judgment.
Agents cannot talk to each other at all.

## The direction

Make the spine itself intelligent: a **team-leader agent that lives spine-side**, monitors the
information flow, notices gaps, and **actively prompts the other agents** to fill them. The spine
goes from passively intaking through connected flows to something that closes its own gaps — and,
eventually, anticipates what the manager will need before they ask. The fleet stops being
freelancers who happen to share a filing cabinet and starts operating like a small business
actually operates: a team, with someone paying attention to the whole.

**The canonical scenario:** technician A's 9:00 visit ended hours ago and nothing has come back —
no field note, no status change. The team leader notices, and through A's *own* agent asks: "how
did the Miller visit go?" A answers in Telegram like they would answer a dispatcher; the reply
flows through the normal write path and the gap closes. Nobody re-typed anything; nobody had to
remember to ask.

Two honest mechanics of that scenario:
- Usually the technician's agent doesn't know the answer either — **the ask ultimately reaches the
  human**, through the agent they already talk to. The machinery's value is asking the right
  person, at the right moment, with the context attached.
- Sometimes the agent *does* know: a fact said conversationally in-session that never became a
  capture. That's a real, distinct gap class ("recorded nowhere but a chat log") the team leader
  can harvest without bothering the human.

## What already exists to build on

- **The pulse:** the cron heartbeat is a working spine-side scheduler — the team leader's clock.
- **The mouth:** the CLI gateway path — `openclaw agent` runs a turn on the person's gateway
  (full AGENTS.md, real tool policy; verified s2+s6 2026-08-12), and `--deliver` sends the reply
  out through the person's channel **with outbound plugin hooks firing** (the weekday guard
  logged on exactly such a run). Shell-shaped (ssh → exec), but proven — date-eval Phase 4
  already drives it. ⚠ `POST /hooks/agent` looks like the obvious HTTP entry and is a **dead end
  on trades-box-1**: it admits the request then skips the run (the cron runner's provider
  preflight does a direct DNS probe in a namespace with no public DNS — a false negative on a
  working provider, and the preflight cannot be disabled).
- **The memory the spine can't see (the bonus class — verified 2026-08-15):** chat sessions
  **never auto-reset**. Our sandboxes set no `session.reset` (live-checked on s2: config path
  unset) and the vendor default is `none`, so a person's session persists until a manual `/new`
  or maintenance pruning (stale sessions pruned after ~30 days). Long sessions **compact** in the
  live context — past ~50k recent tokens, older turns become summaries — but the on-disk
  transcript (`/sandbox/.openclaw/agents/main/sessions/<sid>.jsonl`) stays verbatim and complete.
  Two consequences: harvesting should read **transcripts**, not ask the agent to remember
  (compaction may have eaten the detail; model recall is untrustworthy anyway), and un-harvested
  session-only facts have a **~30-day shelf life**. Docs:
  https://docs.openclaw.ai/gateway/config-agents (`session.*`, `agents.defaults.compaction`).
- **Gap surfaces that exist but wait to be read:** `list_pending_reviews`, the loose pile, digest
  patterns (board push digest; the money weekly digest).
- **Evidence linkage:** the team leader can always say *why* it's asking, with citations — same
  grounding rules as every other read.

## Doctrine collisions to respect (the design constraints, up front)

1. **Detection is deterministic; the model interprets.** "Visit end + N hours, job status
   unchanged, no capture linked" is SQL over the spine, not intelligence — watchers are free and
   run on the pulse. The model's turn fires only on a trigger, to decide whether/whom/how to ask
   and to compose it. (Hardcode-vs-model rule, overview §5; also the cost envelope.)
2. **A new identity class — with a hard ceiling.** Every actor today is a human with a signed
   identity. The team leader acts on its own initiative, so it needs its own identity
   (`actor_ref` spine-side, its own tool allowlist) — and because it has **no human to confirm**,
   the confirmation doctrine caps it structurally: it may **read, ask, and stage — never commit
   anything irreversible or externally visible**. Its entire output vocabulary is questions,
   nudges, and proposals.
3. **Attention economics = the over-confirmation lesson.** Over-pinging trains people to ignore
   pings, exactly as over-confirming trains rubber-stamping. Nudges need a budget, deduplication
   (ask once, not every 15 minutes), and an escalation ladder: check the spine → ask the person's
   agent (session context) → agent asks the human → unanswered items surface in the manager's
   digest. Never sideways-broadcast.
4. **Agent-to-agent stays spine-mediated.** Agents don't get a private channel to each other; the
   team leader is the hub, and everything it asks and learns lands in the spine like any other
   capture. Whether/how its outreach is itself L1-captured is a **new capture-policy entry**
   (L1 is undeletable — decide fields deliberately; the 2026-07-04 outbound exception does not
   cover this by analogy).
5. **The all-seeing eye watches employees.** A thing that notices you're behind schedule and asks
   about it is an ops manager or a surveillance system depending entirely on tone, disclosure,
   and defaults. The nudge arrives as a colleague's question, not an audit; what the manager sees
   about unanswered nudges is a product decision to make explicitly, not a default to inherit.
   **Disclosure ratified (user decision, 2026-08-15):** workers connected to a company-provided
   agent must be told up front that things said in that chat can be recorded to the firm's
   record — extending the 2026-07-04 outbound-send disclosure into a general one. **And the
   work-relevance classifier gates HARD before anything harvested reaches L1** (user decision,
   same day): the spine must not be contaminated with non-work context, and L1's undeletability
   makes "filter after" too late — this is the classify-before-insert rule at full strength, not
   a new exception.

## Staging sketch

- **Stage 0 — the watchers (no new agent, no new identity).** Deterministic gap detectors on the
  cron pulse, surfacing into existing channels (digest / pending queue). Proves the gap inventory
  is real and calibrates volume before anything speaks.
- **Stage 1 — the voice.** The team-leader turn composes outreach on a watcher trigger and
  delivers it through the person's own agent via `/hooks/agent`; replies flow back as normal
  captures. Needs: the identity class, the nudge budget, reply-hook mechanics resolved.
- **Stage 2 — the brain.** Anticipation: pre-briefing the manager's morning, noticing patterns
  ("quotes to the Hendersons go unanswered ~a week"), predicting what will be asked. Only after
  stages 0–1 have earned trust — prediction from an entity that already pings too much or asks
  dumb questions is dead on arrival.

## What this is NOT

- Not scheduled, not sized, not researched. Direction only.
- Not autonomy: the ceiling in constraint 2 is permanent by default — raising it would be its own
  user decision, not scope creep.
- Not customer-facing, and not a replacement for the manager — it fills gaps and asks; humans
  still decide.

## Open questions for the eventual research phase

1. Transport hardening for the voice: the CLI gateway path works today (ssh → exec, hooks fire
   on `--deliver`) — acceptable for production nudges, or do we pursue a real HTTP entry (fixing
   the `/hooks/agent` preflight false-negative upstream or by config)?
2. The watcher inventory: which gaps actually occur in pilot data, at what volume? (Overdue-visit
   status is the archetype; what else — unlinked transcripts, quotes with no follow-up, jobs
   stuck in a status?)
3. Capture policy for team-leader outreach and replies (constraint 4).
4. Where the team-leader turn runs: extend the Render cron (simplest), a dedicated worker, or a
   spine-side session — "lives inside the spine" is a trust-zone statement, not necessarily a
   daemon.
5. Cost envelope: watcher queries are free; what does a model turn per trigger cost at realistic
   gap volumes?
6. GLM obedience: the nudge-budget and ask-don't-act rules must live in **mechanism** (allowlist,
   server-side budget), not prompt text — prompt rules are steering, not enforcement.
7. Transcript harvesting (the bonus class): disclosure and the hard pre-L1 relevance gate are
   **decided** (constraint 5). Still open: what reads transcripts and at what cadence, the
   disclaimer's wording and delivery moment (onboarding? first message?), and how harvested facts
   surface — as suggestions/questions per the read/ask/stage ceiling, never silent writes.
