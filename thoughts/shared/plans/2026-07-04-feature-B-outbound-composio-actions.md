---
date: 2026-07-04
task: "Feature B — Outbound Composio actions via NemoClaw: Gmail draft/send tools on the spine MCP server, complementing the inbound webhook path"
research: thoughts/shared/research/2026-07-04-feature-B-outbound-composio-actions.md
status: superseded
---

> **SUPERSEDED (2026-07-04):** replaced by [2026-07-04-feature-B-outbound-composio-sessions.md](2026-07-04-feature-B-outbound-composio-sessions.md) — user decisions moved the architecture to per-person Composio sessions; the spine-proxied-everything shape below is dead (the two-step confirm, L1 capture, and roster-gate designs carry over).

## Overview

Give NemoClaw agents an outbound path: acting on a technician's own paired Gmail account through
the Composio connector layer — create a draft (including a reply draft) and, behind an explicit
confirm step, send an email. Today the repo has exactly one outbound Composio call
(`GMAIL_GET_PROFILE` during pairing); no agent-facing send/draft tool exists. This plan adds two
spine MCP tools (`draft_email`, `send_email`) that proxy `tools.execute` server-side, gated by the
roster, and logs every sent email into L1 as `outbound_email` evidence.

## Decisions

- **Shape: spine-proxied (research Option B), not Composio Tool Router MCP (Option A).** Option A
  is the design doc's long-term shape, but its work is control-plane/gateway config outside `src/`,
  it depends on the *unbuilt* per-tier gateway allowlist, and its interim mitigation (Composio
  Execution Allowlist ceiling) is unverified as an enforcement boundary (docs §7 `:214-216`). The
  spine proxy gives a server-side enforcement point today (tenant/state gates, model can never name
  a `connectedAccountId`), is fully testable with the existing stub-client pattern, and needs no new
  gateway registration. Option A stays the documented generalization path for connector breadth —
  Phase 4 records this in docs §7 rather than silently diverging. *(Product-facing pick made
  non-interactively — see Assumptions.)*
- **Draft freely; send only via a persisted two-step confirm.** `GMAIL_SEND_EMAIL` is irreversible
  and outbound has no retry-idempotency analogue (research Open Questions). Reuse the proven
  `pending_deactivation` review-item token pattern: first call stages the payload and returns a
  `confirmId`; the confirming call **consumes the token first, then sends** (at-most-once — a
  failure after consumption means "not sent, restage", never a double send).
- **Sent mail IS captured into L1** (`outbound_email`, the latent enum value) via
  `appendRawCapture` directly — NOT `recordFieldNote`, which would run extraction and fabricate a
  visit for a message that isn't a technician trip. L1-only, advisory (a capture failure never
  un-reports a real send). Drafts are not captured (nothing was "said" yet).
- **Capture-all: EVERY confirmed send is captured, with NO work/personal classifier gate**
  (user decision, 2026-07-04). This is a deliberate, reviewed departure from the inbound
  classify-before-L1 pattern, not an oversight. Rationale: an outbound send is an *action our
  agent performed* on the person's behalf, not ambient mail — the CLAUDE.md classify-before-L1
  rule targets the inbound category (retaining misrouted third-party mail forever). Here the
  audit trail matters most exactly when the send was personal or inappropriate, and dropping
  the record of an irreversible action the system took is worse than retaining a personal
  email. Consequence to disclose at rollout: a technician who asks the bot to send a personal
  email gets that email's subject/body permanently in `raw_captures` (append-only, no delete) —
  managers/technicians must be told "emails sent via the assistant are logged". These rows are
  action audit, not customer evidence; nothing downstream extracts from `outbound_email`.
- **Gmail-first, seam-shaped.** One new module `src/composio/outbound.ts` with a generic
  `executeOutboundAction` core + Gmail helpers; connector #2 (Sheets/Excel) is additive later. No
  speculative action registry (docs §7 YAGNI).
- **Both tiers get draft + confirmed send, on their OWN mailbox only.** Per-person pairing means the
  roster row resolved from the gateway identity is the only reachable account. The per-tier
  connector allowlist stays gateway work (out of scope); `RequestIdentity.scopes` stays unused.
- **Authorization = roster state, not id presence.** Outbound requires the caller's roster row to
  exist, `state === 'active'`, and `composio_connected_account_id` set — ids persist after
  offboarding (`offboarding.ts:18-20`), so `state` is the authority, mirroring the inbound gate.
- **Response parsing is tolerant + live-verified.** The send/draft response envelope is unconfirmed
  (research Open Questions); parse `data.response_data ?? data` like `pairing.ts:151-153`, treat
  `successful === false` as failure, and confirm field names in Phase 4 live verification.

## Plain-language walkthrough

**Phase 1** builds the plumbing: a small module that, given a technician's roster row, asks
Composio (the hosted service that safely holds each person's Google login) to create a Gmail draft
or send an email *as that person*. It refuses anyone who isn't active-and-paired. You'd notice it
working because its unit tests pass with a fake Composio client.

**Phase 2** exposes drafting to the agent: a new `draft_email` tool on the spine MCP server (the
one server every agent talks to). A technician can say "draft a reply to Mrs. Lee" in Telegram and
a draft appears in their own Gmail Drafts folder — nothing is sent.

**Phase 3** adds `send_email` with a safety catch: the first call stages the email and returns a
confirmation ticket; the agent shows the technician exactly what will go out; only a second call
with that ticket actually sends. The ticket is single-use, so a network retry can never double-send.
Every real send is also recorded into L1 (the append-only evidence layer) so the customer record
shows what the business *said*, not just what it received. This applies to *all* sends, including
personal ones — deliberately no work/personal filter here (see the capture-all decision above);
do not add one during implementation.

**Phase 4** syncs the docs of record (tool counts, design doc §7) and runs the live end-to-end
checks against a real paired mailbox.

```
Telegram → NemoClaw agent ──MCP──> trades-spine (gateway-signed identity)
                                      │  dispatch: roster gate (active + paired)
                                      │  draft_email ──> Composio GMAIL_CREATE_EMAIL_DRAFT
                                      │  send_email  ─1st─> stage payload → confirmId
                                      │              ─2nd─> consume token → GMAIL_SEND_EMAIL
                                      │                        └─> L1 raw_captures (outbound_email)
                                      └─ (inbound complement: Composio webhook → classify → L1)
```

## Secrets & env preflight

- **Phase 1:** none (tests use a stub `PairingClient`; local stack `.env.test` as usual).
- **Phase 2:** none.
- **Phase 3:** none.
- **Phase 4 (live only):** `COMPOSIO_API_KEY` and `COMPOSIO_GMAIL_AUTH_CONFIG_ID` in `.env` —
  Composio dashboard → Settings → API keys / auth config `gmail-test` (`already required` by
  pairing today). Plus one live ACTIVE paired technician row (exists on the pilot roster) and
  access to that Gmail mailbox to observe the draft/sent message.

## File footprint

Every repo file this plan creates (N) or modifies (M) — for the parallel-vs-stacked comparison:

- `src/composio/outbound.ts` (N) · `src/composio/outbound.test.ts` (N)
- `src/composio/pairing.ts` (M — export `compositeUserId`)
- `src/mcp/server.ts` (M) · `src/mcp/server.test.ts` (M)
- `src/db/reviewItems.ts` (M — `ReviewKind` union + one dedup helper)
- `docs/nemoclaw-tech-agent.md` (M) · `docs/doorman-runbook.md` (M) · `docs/control-plane.md`
  (M — only if it states tool counts; verify at implementation)
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` (M) ·
  `Box_Setup_Stuff/doorman-architecture-memory.md` (M) ·
  `Box_Setup_Stuff/migration-runbook-lightsail.md` (M)
- `CLAUDE.md` (M — Phase 4: recorded exception for classifier-free outbound capture)
- `thoughts/shared/plans/2026-07-04-feature-B-outbound-composio-actions.md` (N — this plan)

No migrations (review `kind` is a plain string column; `outbound_email` already in the
`capture_channel` enum). No changes to `httpServer.ts`, `identity.ts`, `webhook.ts`, or seeds.

## Phase 1: Outbound Composio seam (`src/composio/outbound.ts`)

### What this phase does
Creates the one module that performs outbound Composio actions, mirroring the
`GMAIL_GET_PROFILE` pattern (`pairing.ts:145-150`), with the roster-state gate built in.

### Changes required

**`src/composio/pairing.ts`**
- Change `function compositeUserId` (line 61) to `export function compositeUserId` (outbound must
  build the identical `"<tenant>:<ref>"` id; never duplicate the definition).

**`src/composio/outbound.ts`** (new)
- `export interface OutboundDeps { client?: PairingClient }` (reuse `getComposioClient`).
- `export function requireOutboundCapable(tech: Technician | null): asserts` — throws
  `'no roster row for this badge'` if null; `'not active'` unless `tech.state === 'active'`;
  `'no paired mailbox — use get_connect_link'` unless `tech.composio_connected_account_id`.
- `async function executeOutboundAction(tech, slug, args, deps)` — core wrapper:
  `client.tools.execute(slug, { connectedAccountId: tech.composio_connected_account_id, userId:
  compositeUserId(tech), arguments: args, dangerouslySkipVersionCheck: true })` (the skip flag is
  mandatory — `pairing.ts:139-141`). Read `res.successful === false` / `res.error` → throw with the
  Composio error text; return `(res.data?.response_data ?? res.data)` as `Record<string, unknown>`.
- `export async function createGmailDraft(tech, { to, subject, body, threadId? }, deps)` →
  `GMAIL_CREATE_EMAIL_DRAFT` with `{ recipient_email: to, subject, body, thread_id: threadId }`
  (omit undefined keys; for a reply draft pass `thread_id` and empty subject — verified slugs/
  params, research `:170-176`). Returns `{ draftId: string | null }` parsed tolerantly
  (`id` / `draft_id` fields — confirmed live in Phase 4).
- `export async function sendGmailEmail(tech, { to, subject, body }, deps)` →
  `GMAIL_SEND_EMAIL` with `{ recipient_email: to, subject, body }`. Returns
  `{ messageId: string | null, threadId: string | null }` (tolerant: `id`/`messageId`/
  `message_id`, `threadId`/`thread_id`).

**`src/composio/outbound.test.ts`** (new — pattern: `pairing.test.ts` stub client)
- Asserts: correct slug + `dangerouslySkipVersionCheck: true`; `connectedAccountId`/`userId` come
  from the roster row (never from args); gate throws for null row, `pending_verification`,
  `offboarding`, `offboarded`, and active-but-unpaired; `successful:false` → throw;
  `response_data` nesting and bare-`data` shapes both parse.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass (local stack only)
- [ ] new `outbound.test.ts` covers every bullet above

### Live verification (agent-executable)
None — no live call until a tool exposes this (Phase 4 covers it).

### Manual verification
None.

---

## Phase 2: `draft_email` MCP tool + tool-count docs

### What this phase does
Exposes drafting to every active paired badge via the spine MCP server, and keeps the doc-of-record
tool counts true (7→8 technician, 14→15 manager).

### Changes required

**`src/mcp/server.ts`**
- `ServerDeps`: add `createDraft?: typeof liveCreateGmailDraft` (import from
  `../composio/outbound.js`) — injectable like the pairing seams.
- Append to `TOOLS` (line 72): `draft_email` — description: creates a Gmail draft in the caller's
  own paired mailbox; never sends; for a reply draft pass `threadId` and omit `subject`.
  `inputSchema`: `to` (string, required), `subject` (string), `body` (string, required),
  `threadId` (string, optional).
- New `dispatch` case `'draft_email'`: validate `to`/`body` present, `subject` required unless
  `threadId`; reuse the `caller` row already read at line 299 (no second roster read);
  `requireOutboundCapable(caller)`; call `(deps.createDraft ?? liveCreateGmailDraft)(caller, …)`;
  return `{ status: 'drafted', draftId, to, subject }`.

**`src/mcp/server.test.ts`**
- Cases: stubbed `createDraft` receives the caller's roster row + args; inactive caller →
  `'deactivated team member'` (existing gate); active-but-unpaired → paired-mailbox error; a badge
  with no roster row → error (NOT the read-tool pass-through); tools/list now shows 8 for
  technician, 15 for manager.

**Docs (counts only in this phase):** `docs/doorman-runbook.md` (`:242,308,321,367`),
`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` (`:20,24,269`),
`Box_Setup_Stuff/doorman-architecture-memory.md` (`:97,227`),
`Box_Setup_Stuff/migration-runbook-lightsail.md` (`:114`), and `docs/control-plane.md` if it
states counts — update "7 tools"/"14" and the tool name lists.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] new server tests above pass; `grep -rn "7 tools" docs Box_Setup_Stuff` returns nothing stale

### Live verification (agent-executable)
Deferred to Phase 4 (needs the live pairing).

### Manual verification
None.

---

## Phase 3: `send_email` with persisted two-step confirm + L1 capture

### What this phase does
Adds irreversible send behind a single-use confirm token (review-items pattern from
`deactivate_technician_seat`, `server.ts:440-523`) and logs each sent email into L1.

### Changes required

**`src/db/reviewItems.ts`**
- Add `'pending_outbound_send'` to the `ReviewKind` union (line 10 — plain string column, no
  migration by design).

**`src/mcp/server.ts`**
- `ServerDeps`: add `sendEmail?: typeof liveSendGmailEmail`.
- Append `send_email` to `TOOLS` (counts → 9/16): schema `to`/`subject`/`body` (strings, all
  optional in-schema — validated in dispatch) + `confirmId`. Description: two-step; first call
  returns `{status:'needs_confirmation', confirmId}` — show the technician exactly what will be
  sent, then call again with ONLY `confirmId`; the staged copy is what gets sent.
- Dispatch case, **stage** (no `confirmId`): `requireOutboundCapable(caller)`; require
  `to`/`subject`/`body`; if an open `pending_outbound_send` item exists for `caller.ref` with
  *different* staged detail, supersede it first (`resolveOpenReviewItemFor(…,'dismissed',
  'superseded by a new send request')` — the `flagOffboardingReminder` pattern, `reviewItems.ts:162`),
  then `upsertOpenReviewItem({ tenantId, kind:'pending_outbound_send', subjectRef: caller.ref,
  detail: { to, subject, body, stagedAt } })`; return `{status:'needs_confirmation', confirmId:
  item.id, to, subject}`.
- Dispatch case, **confirm** (`confirmId` set): `requireOutboundCapable(caller)`;
  `getOpenReviewItem(confirmId, tenantId, { kind:'pending_outbound_send', subjectRef: caller.ref })`
  (forged/cross-person ids match nothing); reject if `detail.stagedAt` older than 15 min
  (`'confirmation expired — restage the send'`, dismiss the item); **consume first**:
  `resolveReviewItem(confirmId, tenantId, 'resolved', 'send confirmed')` — a null result means
  another call won the race → `'already confirmed or cancelled'`; then
  `(deps.sendEmail ?? liveSendGmailEmail)(caller, detail)` — on throw, report clearly that the
  email was NOT sent and the send must be restaged (at-most-once, never double-send); on success,
  advisory L1 capture (below); return `{status:'sent', to, subject, messageId, captured}`.
- L1 capture (advisory try/catch): `appendRawCapture({ tenantId, channel:'outbound_email',
  technicianRef: caller.ref, rawText: formatEmailRawText({ from: caller.connected_email ?? caller.ref,
  subject, body }), externalId: messageId ? `sent:${messageId}` : `sent:confirm:${confirmId}`,
  metadata: { to, subject, sentVia:'GMAIL_SEND_EMAIL', threadId } })`. Direct `appendRawCapture`,
  NOT `recordFieldNote` (no extraction/visit for outbound). `captured:false` on failure.
- `resolve_review` case (line 678): extend the `pending_deactivation` guard — a
  `pending_outbound_send` item may be `dismissed` (cancel) but `resolved` is rejected with
  `'confirm it via send_email, or dismiss it to cancel'`.

**`src/mcp/server.test.ts`**
- Cases: stage → confirm sends the STAGED payload (stub `sendEmail`) and ignores fresh args on the
  confirm call; forged/other-person `confirmId` rejected; second confirm → already-confirmed error,
  stub called exactly once; restage with different body supersedes the old token; expired token
  rejected; send-throw → no L1 row + clear not-sent error; success → `raw_captures` row with
  `channel='outbound_email'`, `external_id='sent:<id>'`, correct `technician_ref`; capture failure
  still reports `status:'sent'`; `resolve_review` blocks `resolved`, allows `dismissed`.

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` pass
- [ ] all new cases above pass; tools/list counts 9/16 asserted

### Live verification (agent-executable)
Deferred to Phase 4.

### Manual verification
None.

---

## Phase 4: Docs of record + live E2E verification

### What this phase does
Amends the design doc, resolves the research doc's open questions live, and proves the path
end-to-end against a real paired mailbox.

### Changes required

**`docs/nemoclaw-tech-agent.md`** (§7)
- Dated amendment: outbound v1 ships **spine-proxied** (`draft_email`/`send_email`, roster-gated,
  two-step send, L1 `outbound_email` capture); Tool Router `mcp.url` (Option A) remains the
  deferred generalization path for connector breadth; record the live-verified send/draft response
  shapes and the Execution Allowlist finding (below) with citations, per CLAUDE.md's
  external-services rule.

**`CLAUDE.md`**
- Add a second *Recorded exception* under the L1 append-only rule (alongside the 2026-07-02
  pending-verification one): **outbound sends are captured with NO work/personal classifier gate**
  (user decision, 2026-07-04) — an outbound send is an action the agent performed, so the audit
  record must never be dropped; classify-before-L1 applies to the *inbound* category only. Note
  the disclosure obligation ("emails sent via the assistant are logged").

### Automated verification
- [ ] `npm run typecheck` · `npm run lint` · `npm test` · `npm run build` pass (pre-PR gate)

### Live verification (agent-executable — follow the `verifying-behavior` skill)
Prerequisites: `COMPOSIO_API_KEY` + `COMPOSIO_GMAIL_AUTH_CONFIG_ID` in `.env`; one ACTIVE paired
technician on the pilot roster; access to that Gmail mailbox; `supabase-test` MCP for **read-only**
read-backs (the hosted "test" project is the pilot's LIVE DB — SELECT only, never write/seed).
- [ ] `draft_email` live: draft appears in the real mailbox's Drafts (evidence: draft id + a
      mailbox screenshot/read-back); confirm the response field names match the Phase 1 parser —
      fix the parser if not.
- [ ] `send_email` live: stage → confirm → message arrives at a controlled recipient; read back the
      L1 `outbound_email` row via `supabase-test` `execute_sql` SELECT (evidence: row id +
      `external_id`).
- [ ] **Execution Allowlist semantics** (research open question): set the dashboard ceiling to
      exclude `GMAIL_SEND_EMAIL`, attempt a send via `tools.execute` — record whether it blocks
      execution or only hides discovery; update docs §7 `:214-216` (remove the ⚠) with the result.
- [ ] Isolation spot-check: a second identity's badge cannot draft into the first mailbox
      (expect the no-paired-mailbox/roster error).

### Manual verification
- [ ] The manager-facing wording (`needs_confirmation` message, error texts) reads sensibly in a
      real Telegram conversation.

---
*Pause after Phase 4 (manual check non-empty). Phases 1–3 continue on green automated gates.*

## Assumptions

Recorded because this is a non-interactive run (could not present the decision brief live):

- **Picked spine-proxied (Option B) over the Tool Router (Option A)** — a product-facing choice the
  command would normally put to the user. Rationale in Decisions; the plan's Phase 4 doc amendment
  makes the divergence from docs §7 explicit and reviewable. **If the reviewer prefers Option A,
  Phases 2–3 are the disposable part; Phase 1's seam and the live findings still apply.**
- **Draft-for-everyone + confirmed-send-for-everyone** (no tier split) — per-person pairing already
  limits blast radius to the caller's own mailbox; the pricing-tier connector split attaches at the
  gateway later.
- **Sent mail is captured to L1** (L1-only, advisory) — resolving research Decision Point 3 in
  favor of "the record reflects what the business said", using the already-provisioned enum value.
- **Gmail-only in this feature** (research Decision Point 5) — Sheets/Excel outbound is a follow-up
  connector, not scoped here.
- **Adversarial plan review** was performed as a careful self-review pass (checked every cited
  file/line, the review-kind string-column claim, the enum value, dedup/one-open-item semantics,
  and the tool-count doc sites) — this subagent environment has no Task tool for a fresh-context
  reviewer, so a human reviewer should weigh that step as not independently executed.
- **No new env vars or migrations** are needed; verified against `.env.example`, the
  `capture_channel` enum (`database.types.ts:605`), and `reviewItems.ts:8-9`.

## Parallel/stack verdict (plan-two)

**Recommendation: STACK** — land one feature fully (suggested order: B first, then A; see below), then re-check/rebase the other plan on the result. Do not run these as two parallel worktree sessions.

**Shared files (exact-path intersection):**
- `src/mcp/server.ts`
- `src/mcp/server.test.ts`
- `Box_Setup_Stuff/doorman-architecture-memory.md`
- `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`
- `docs/nemoclaw-tech-agent.md`
- `docs/control-plane.md`

**Reasoning (plain language):** the two plans don't just touch the same files — they change the
same *facts* in those files, and each plan's version of the fact is wrong once the other lands.

1. **Tool counts are asserted as absolute numbers.** `src/mcp/server.test.ts:646` asserts the
   manager tool surface is exactly 14 today. Plan A makes it 15 (adds `bind_telegram` to
   `ADMIN_TOOLS`); Plan B makes it 16 (adds `draft_email` + `send_email` to the shared `TOOLS`
   list, which managers also see). Merged, the true number is **17** — so both branches pass alone
   and both assertions are wrong together. The same drifting counts are hand-edited in prose in
   `docs/nemoclaw-tech-agent.md`, `docs/control-plane.md`, and both Box_Setup_Stuff docs, often on
   the same lines.
2. **Plan A widens the `Technician` row type; Plan B creates new fixtures of that type.** A adds
   `telegram_user_id` and patches every existing full-literal `Technician` fixture — but B's new
   `src/composio/outbound.test.ts` (and its server-test stubs) builds fixtures A's list cannot
   include. After merging both, those fresh fixtures fail `npm run typecheck` until reconciled.
3. **Both plans edit the same hot region of `server.ts` by cited line numbers** (tool tables
   ~72/163, the dispatch switch, the caller-roster read ~299). Whichever lands first shifts every
   line reference in the other plan — the second plan needs a re-check pass regardless, which is
   exactly the stacked workflow.

None of these are dangerous-in-production interactions (no shared DB semantics: A's migration and
`sandbox_pool` are untouched by B; B's Composio/review-item work is untouched by A), and the
integration gates would catch them — but the merge-time interaction risk is clearly not "genuinely
low", so per CLAUDE.md the stacked path applies.

**Suggested order — B first, then A:** Plan B is self-contained through Phase 3 and its live Phase 4
needs only existing secrets; Plan A's Phase 4 is gated on the unresolved late-re-bind experiment and
may pause or re-scope. Landing B first avoids rebasing a finished feature onto a paused one. (Either
order works; the second plan must be re-checked against the landed diff before `/implement`.)

**Risk areas to re-verify when rebasing the second plan:**
- `src/mcp/server.ts` — tool tables, dispatch switch, and all cited line numbers
- `src/mcp/server.test.ts` — the absolute manager/technician tool-count assertions (final: +3 over today's 14/7 baseline for managers, +2 for technicians)
- `Technician` full-literal fixtures anywhere new tests create them (typecheck after A's column)
- Tool-count prose in `docs/nemoclaw-tech-agent.md`, `docs/control-plane.md`, `Box_Setup_Stuff/doorman-architecture-memory.md`, `Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md`
