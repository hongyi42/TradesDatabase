# TradesDatabase — CLAUDE.md

## Domain
This repo builds the **three-layer context spine**: a single customer/job record split into
**L1 raw** (`raw_captures`, append-only verbatim capture), **L2 structured**
(`customers ─(1:N)─ jobs ─(1:N)─ visits`), and **L3 attributes** (an `attributes` JSONB column on
each L2 row). Every structured field links back to the raw evidence it came from. See
[Three-Layer-Context-Spine-Overview.md](docs/Three-Layer-Context-Spine-Overview.md) for the full design.

Institutional knowledge (process rules, product principles, environment/state maps, and the
catalog of operational traps) lives in [docs/engineering-memory.md](docs/engineering-memory.md) —
read it before touching the agent stack, the pilot DB, or deploys, and keep it updated when those
facts change.

**The decision index — read before building on prior work.** `thoughts/INDEX.md` lists every
research and plan document with evidence of whether it is still current: `landed` (its `commit:`
reached `main`), `not landed` (a proposal, not a record), and `drift N` (the source files it
describes have taken N commits since it was written — verify against the code before quoting it).
`docs/engineering-memory.md` now opens with a generated map of its entries; grep that map instead
of reading 3000 lines. A `PreToolUse` hook (`.claude/hooks/decisions-for-file.mjs`) hands you the
decisions attached to a file the moment you edit it, once per file per session — when it names a
rule governing the file you are changing, that rule outranks your plan.

Regenerate all three with `npm run decisions:index` whenever you add or amend a document under
`thoughts/`, and commit the regenerated files with it.

**The work record — what is in flight right now.** `thoughts/` is the durable half; the live half
is `.claude/work/` in the **main checkout**, shared by every worktree through the common `.git`
directory, so a write is visible to sibling sessions instantly with no commit. `npm run board`
shows every worktree, its branch, how far behind `main` it is, and its active task. Rules: **one
active task per worktree, and every code-editing session in its own worktree** — so "who is
touching this file" always has an answer. Hooks and commands run the **main checkout's**
`scripts/work.mjs`, and Claude Code reads hooks from the directory the session was *launched* in,
so launch a session inside the worktree it will work in or none of this fires.

**A running session never gains a hook it did not start with** (measured 2026-09-10).
`settings.json` is read once, at launch — neither a new hook *event* nor a new command inside an
existing event reaches a session already running. What IS picked up live is a change to a hook
*script's* contents, because that file is re-read on every invocation. So after pulling anything
that edits `settings.json`, restart the session; an old one keeps its original hook set and fails
silently, since every hook command here ends in `; true` so it can never cost you an edit.

**The board is the operator's.** Notice something mid-task? A small fix that needs no decision is
made in place and named in your report; anything too big to fix in place, or that needs the
operator's decision, is **asked** (a side effect of your own change is never "out of scope"). Only big work
that needs a decision (or whatever the operator asks to park) goes on the board, and only after
the operator's yes: **`/park`** asks, and a
`permissions.ask` rule makes Claude Code prompt on the park command itself. **`/spawn <id>`** is
what picks a parked item up: its own worktree, after a sized check against everything in flight. Finishing a task? **`/handoff`** records
what a diff cannot: what was decided, what you assumed, what is still open. Then `work.mjs done
<id>` and `work.mjs promote <id>` writes it to `thoughts/shared/findings/` and archives it out of
the live record. Never promote a task that is not `done` or `dropped`.

**Raise promotion yourself — nobody will remember to ask you.** The moment something surfaces that
a future session would otherwise lose an afternoon rediscovering, say so in one line: *"worth
promoting: <what, and what it would cost to relearn>"*. What qualifies: a vendor or tool contract
that changed under us; a trap whose symptom points somewhere other than its cause; a decision whose
rejected alternative is invisible in the code; a measurement that would otherwise be re-measured.
Say it while it is fresh — by the end of the task the reason has already gone fuzzy, which is
exactly how it gets lost. What does **not** qualify matters as much: a fix that a test already pins
and a commit message already explains. A promoted finding is shown before every future edit of its
files, so "this was fixed" becomes noise standing between the next session and its work. Promote
what someone must KNOW, not what they can read.

**"No" is an answer, and it has a verb: `work.mjs archive <id>`.** It takes a closed task out of
the live record without writing a document, losing nothing — the task file moves to `archive/`
intact. Use it whenever the promotion call is no. Leaving a finished task sitting in the record is
the one thing that is *not* an answer, because then work deliberately left undocumented looks
exactly like work nobody got round to, and the count stops meaning anything. Every session start
lists what is still waiting on that call.

New to the repo? [docs/onboarding.md](docs/onboarding.md) is the map — what the project is, how the
pieces fit, day-1 local setup, and the rules that cost us incidents.

## Conventions
- TypeScript, ESM (`"type":"module"`, `NodeNext`) — use explicit `.js` extensions on relative imports.
- All database access goes through the typed layer in `src/db/`; don't hand-write Supabase queries elsewhere.
- **L1 (`raw_captures`) is append-only** — insert only, never update or delete (enforced by a DB trigger too).
  Because there is no delete path, **any filtering/classification (e.g. work-vs-personal email) must gate
  the L1 insert — run it _before_ writing, never after**, or misrouted rows are retained permanently.
  - *Recorded exception (2026-07-02):* mail arriving while a Gmail pairing is still
    `pending_verification` (the window between OAuth consent and the manager confirming the
    account) is ingested normally rather than gated — silently dropping real work mail in that
    window is worse than retaining rows from a mis-paired mailbox. Each such capture is stamped
    in its source metadata (`pendingVerification: true` + `pendingAccount: <connected-account id>`,
    see `src/inbound/webhook.ts`) so a bad pairing's rows are findable for forensics.
  - *Recorded exception (2026-07-04, user decision):* **outbound/agent-action captures are
    classifier-free** — every send via the spine `send_email` tool and every state-changing
    Composio execution ingested by `src/composio/logIngest.ts` is captured with NO work/personal
    gate. An outbound action is something the agent *performed* on the business's behalf; the
    audit record matters most exactly when the action was personal or inappropriate, so dropping
    it is worse than retaining it. The classify-before-L1 rule above targets the *inbound*
    category only. Consequences: (a) disclosure obligation — managers/technicians must be told
    "emails sent via the assistant are logged"; (b) non-send captures store argument KEY NAMES
    only, never values (keys-only redaction — L1 is undeletable).
- **Tests run ONLY against the local Supabase stack** (`npx supabase start`, values in `.env.test` —
  see `.env.test.example`; enforced by `src/testEnvGuard.ts`, which refuses to start the suite
  against any non-local URL). The hosted "test" project (`daqapdlkgxfrhquacprv`) is the **deployed
  pilot's live database** — Render web + cron and the trades-box-1 badge-pull read it — never point
  tests at it. Seeding: `npm run seed:local` rebuilds the local playground (roster included);
  seeding the pilot requires an explicit `npm run seed -- --hosted` and touches spine demo data
  only (`--with-roster` additionally resets the roster — churns box credentials and bumps sandbox
  provider generations). **Prod remains read-only.**
  (Why: a test run truncated the pilot's roster on 2026-07-03 and locked a technician out.)

## Communication defaults

The user is a hands-on learner, not a career engineer. For every explanation, in any session:
- Plain language first — expand jargon and acronyms on first use.
- Draw a simple diagram (ASCII or mermaid) whenever structure matters: architecture, data
  flows, request paths, sequences.
- When the work involves choices, lead with a decision brief — each decision, the options,
  their trade-offs in practical terms, and a recommendation — before diving into detail.

## Verification
These are the pass/fail gates. Run the relevant ones after every change, and all of them before any
commit. Show the actual command output — never assert success without it.

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest
npm run build        # before opening a PR
```

If a gate fails, fix the root cause — never suppress the error or loosen the gate to get past it.

For verifying **behavior** (live/agent-driven checks, test-environment safety, cross-channel
verification) — not just these static gates — follow the `verifying-behavior` skill.

## External services — verify against live docs first

When a question or design decision involves a third-party service (Composio, Supabase, Google
OAuth, Twilio, …), **check the service's current documentation before answering — never answer
from memory or from this repo's summaries alone.** Repo docs record point-in-time findings and go
stale; vendor products change under us.

- Cite the doc page (URL) for any load-bearing claim, and record the citation in the design
  doc/research artifact so the next reader doesn't have to re-derive it.
- Read deprecation notices precisely: *which method/endpoint*, *which mode*, *which dates*, and
  what is explicitly **unaffected**. (Case study: we briefly concluded "Composio managed OAuth is
  dead" when only the `initiate()` *method* was being retired — `link()` + managed OAuth were fine.
  An uncited one-liner in a design doc propagated the error.)
- If a doc claim in this repo has no citation, treat it as unverified — confirm it upstream before
  building on it.

## Development workflow (RPI)

For non-trivial features, use the Research → Plan → Implement workflow:

```
/research <area>          # read-only; writes to thoughts/shared/research/
/plan <research-path>     # read-only; writes to thoughts/shared/plans/
/implement <plan-path>    # executes the approved plan phase by phase
```

**Rule:** review and approve the plan before running `/implement`. The plan is the human-review
gate — not the code diff.

Artifacts live in `thoughts/shared/research/` and `thoughts/shared/plans/`. Commit them alongside
the code changes they describe.

### Parallel work — park, spawn, integrate

Parallel work is many threads, not two features known up front. Big work needing the operator's
decision, approved by them → `/park`. Parked and able to start now → **`/spawn <id>`**: it checks the item against every active
task with the code graph (`scripts/code-graph.mjs` — exported functions, their signatures, who
calls them, read by the TypeScript compiler), and on any overlap it **stops and shows how big each
one is; the operator decides** before `--proceed` (user, 2026-09-10). It cuts
`.claude/worktrees/<slug>` from main, claims the task there, and prints the command that starts
its session — launched *inside* that worktree, as its own Claude Code session running
`/implement` (keeps the skill's stop-and-ask human gates intact — don't wrap `/implement` in
subagents, which can't pause). While work runs, the pre-edit hook names what a sibling or main has
changed in a function the file imports; `npm run work -- overlap <a> <b>` gives the full sized
picture for any two tasks or branches. Before a task lands, **`/integrate`**: it reports what
main landed since the task's base that the task touches or calls, and whom it affects; then merge
main (never rebase), run the gates, and review only those items.

Each extra worktree gets its **own local Supabase stack** via `scripts/second-stack.sh [N]` (run
inside the worktree; `spawn` prints a free N): it rewrites that worktree's `supabase/config.toml` — unique `project_id`,
ports shifted 543xx→54(3+N)xx, `analytics`/`studio`/`realtime` off, leave uncommitted — starts the
stack, and generates `.env.test`, so `npm test` and `npm run seed:local` target that stack
automatically (`testEnvGuard` is host-based and port-agnostic, so the pilot-DB protection holds). Note: a fresh worktree has
no `.env`, so key-gated live-model tests are skipped there; copy `.env` in if a phase needs them.
Scratch-stack cleanup: `npx supabase stop --no-backup` inside the worktree. **The trim is what lets
four worktrees coexist**: the Docker VM is a fixed 7.8 GB, a full stack is 1.5–2.1 GB and a trimmed
one 0.5 GB; at four full ones the VM swaps and the suite fails somewhere different every run rather
than failing honestly (docs/engineering-memory.md §5).
