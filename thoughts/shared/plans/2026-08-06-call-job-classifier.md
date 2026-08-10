---
date: 2026-08-07
task: Inbound-call intent router — auto-create jobs for new-work calls; push manager reviews for reschedule/cancel/question/complaint; keep every transcript in L1
research: thoughts/shared/research/2026-08-06-call-transcript-job-classifier.md
status: complete
---

## Overview

The inbound line forwards to a **receptionist** with no scheduling tools, so the call worker is the
**only** systematic intake for the whole phone channel. This adds a GLM-5.2 **multi-label intent
router** on the transcript: `new_job` auto-creates/attaches a job (which surfaces in the board's
unscheduled bucket); `reschedule` / `cancel` / `question` / `complaint` open a **manager review that
is pushed to Telegram** — never auto-executed; `other` is L1-only. Every transcript is kept in L1
regardless. Classification is retried (backoff+jitter); a total failure routes to a pushed human
review, never to silence.

> **Companion design (deferred, not in Phases 1–5):** the router decides *what* a caller wants;
> a separate concern is *how much trust* is required before the spine discloses data or commits a
> consequential action, and how a tenant handles a repeat bad actor. That design — the weak-identity
> threat model, the provisional/verify posture, the **advisory identity flag** (which replaces a hard
> "fraud" status), payment/PCI, and the customer-facing notice — is captured at the end of this file
> under **"Companion design — identity assurance & the advisory flag."** It builds on this router's
> outputs (`new_job`, `call_action`, `unlinked_call`) and is what keeps the future dispatch/action
> features from skipping the gate.

## Decisions (all confirmed with the user)

- **Multi-label array**, not one label — a call can be `[new_job, cancel]`; each is handled, nothing dropped.
- **Never auto-execute mutations** — reschedule/cancel/complaint are *human tasks* (receptionist can't act; worker's read is unverified; move/cancel are irreversible + need stage→confirm).
- **`new_job` → auto** (additive/reversible); **`other` → L1 only**; keep L1 always (gate before-L2, not before-L1 — the transcript is the call log).
- **`complaint`** (dispute/refund/legal) → high-priority review; **never** literal-acted.
- **Fail-safe:** retry classify 3× (exp backoff + full jitter); on throw / empty / all-invalid → `unclassified` → pushed human review (NOT silent `new_job`). Validate each label with `isCallIntent`.
- **One `call_action` review kind**, intents in `detail` — dedups on `(tenant, kind, captureId)`, retry-safe.
- **Push every actionable review** to the tenant's managers (reuse `listManagersWithTelegram` + `sendBoardMessage`); pull queue is the backstop; best-effort (a send failure never fails the call).
- **New/unknown caller unchanged** — `new_job` unmatched → `unlinked_call` (no auto-created customers).
- **Personal calls** → `other` → L1 (consent + redaction now; stricter redaction later).
- **No DB migration** — `review_items.kind` is free-text (migration `20260702194603` L59); **no new MCP tool** → `nemoclaw-tech-agent.md` tool counts unchanged.

## Plain-language walkthrough

**P1 classifier** — one GLM call returns a *list* of intents + a reason. **P2** — `recordFieldNote`
gains a `structure` off-switch so a non-job call stores its transcript without building a job.
**P3** — a `call_action` review kind + helper (twin of `openUnlinkedCallReview`). **P4** — wire the
worker: classify (with retry), then route each intent — job → auto-create, mutating/enquiry →
review, junk → nothing. **P5** — push each review to the manager's Telegram.

```
transcript → classifyCall (retry×3) → intents[]
   new_job    → recordFieldNote(structure:true)  → L1 + job(+visit)
   reschedule/cancel/question/complaint → recordFieldNote(structure:false) + call_action review → PUSH manager
   other      → recordFieldNote(structure:false) → L1 only
   (classify failed) → unclassified → review → PUSH manager (HIGH)
```

## Secrets & env preflight

- **P1:** `INFERENCE_API_KEY` (`already required` — GLM/DeepInfra). **P2–P4:** none.
- **P5:** `BOARD_BOT_TOKEN` **on the `calls:worker` Render service** (the board web/worker has it; the calls worker needs it added — `sendBoardMessage` throws without it). Managers must have opened the board bot once (Telegram send-to-user constraint) — they have, via the Mini App.

## Phase 1: Multi-label classifier (`src/calls/classifyCall.ts`)

- `export type CallIntent = 'new_job'|'reschedule'|'cancel'|'question'|'complaint'|'other'`
- `export const CALL_INTENTS: readonly CallIntent[] = [...] as const`
- `export const isCallIntent = (v:unknown): v is CallIntent => typeof v==='string' && (CALL_INTENTS as readonly string[]).includes(v)`
- `export interface CallClassification { intents: CallIntent[]; reason: string }`
- `export type CallClassifier = (transcript: string, ctx?: CostContext) => Promise<CallClassification>`
- `export const CLASSIFY_CALL_TOOL: ForcedToolSpec` — `intents`: `{type:'array', items:{type:'string', enum:[the 6]}}`, `reason`: string; both `required`; `additionalProperties:false`. (`coerceBySchema` maps array items but leaves enum strings untouched — the worker validates.)
- `CLASSIFY_CALL_SYSTEM` — diarized call to a trades business; receptionist is one speaker. Define each label (scope `question` to **business enquiries about our service/job/appointment/pricing**; off-topic → `other`; supplier/wrong-number/thanks/personal → `other`). Rule: **list EVERY distinct actionable request** (a new job AND a cancel → both); off-topic chatter beside one request doesn't add a label. `complaint` = dissatisfied/dispute/refund/legal, regardless of literal demands.
- `defaultCallClassifier` — wraps `runForcedTool(CLASSIFY_CALL_TOOL, {system, user:transcript, maxTokens:256, label})` in a **retry loop: up to 3 attempts, on throw sleep `random(0 … 2^attempt·500ms)` then retry**; after 3 throws, rethrow. Returns `{intents, reason}`.

**`src/calls/classifyCall.test.ts`** — always-on shape test (assert `CLASSIFY_CALL_TOOL.inputSchema.properties.intents.items.enum` holds the 6; `required` has both; cast `properties` — it's `Record<string,unknown>|undefined`); live test (`skipIf(!hasModelCredentials())`, mirror `email/classify.test.ts`): new-work → includes `new_job`; "cancel my appointment" → includes `cancel`; a two-request fixture → both labels.

**Verify:** `tsc`/`lint`/`test` green; shape test passes keyless.

## Phase 2: `structure` gate on `recordFieldNote`

**`src/writePath/recordFieldNote.ts`** — `RecordFieldNoteInput` (L34): `structure?: boolean; // default true`. `RecordFieldNoteResult.status` (L60): add `'captured'`. After the L1 block (after L151, before the `// (2-3)` comment L153): `if (input.structure === false) return { status:'captured', captureId };` — after dedup/heal, so a redelivered captured call re-returns `captured` (no L2 ever linked).

**`recordFieldNote.test.ts`** — `structure:false` → `{status:'captured'}`, L1 row exists, NO job/visit, `extract` spy NOT called; `structure` omitted → still structures.

**Verify:** `tsc`/`lint`/`test` (local stack) green; new tests pass.

## Phase 3: `call_action` review helper (`src/db/reviewItems.ts`)

- Extend `ReviewKind` (L10) with a single `| 'call_action'` (comment mirroring `unlinked_call` L41).
- Add beside `openUnlinkedCallReview` (L127):
  ```ts
  export async function openCallActionReview(input: {
    tenantId: string; captureId: string; intents: string[];
    priority?: 'normal' | 'high'; callerPhone?: string|null; snippet?: string|null;
  }): Promise<ReviewItem> {
    return upsertOpenReviewItem({
      tenantId: input.tenantId, kind: 'call_action',
      subjectRef: input.captureId,                       // one review per call (partial unique index)
      suggestion: input.callerPhone ?? null,
      detail: { intents: input.intents, priority: input.priority ?? 'normal',
                callerPhone: input.callerPhone ?? null, snippet: input.snippet ?? null },
    });
  }
  ```
  Auto-re-exported via `db/index.ts` `export *`. No migration (kind is free-text).

**`src/db/reviewItems.test.ts`** (create fresh — no such file today; use the pg/local-stack boilerplate from `recordFieldNote.test.ts`) — `openCallActionReview({intents:['cancel'], captureId})` writes a `call_action` row (`detail.intents=['cancel']`); a second call, same captureId, different intents → **same open row** (dedup by captureId).

**Verify:** `tsc`/`lint`/`test` green.

## Phase 4: Wire the router into the worker (`src/calls/worker.ts` + new `src/calls/notify.ts`)

- **`src/calls/notify.ts`** (new): `export async function notifyManagers(tenantId: string, text: string): Promise<void>` — loop `listManagersWithTelegram(tenantId)`, skip null `telegram_user_id`, `try { await sendBoardMessage(m.telegram_user_id, text) } catch (e) { console.error('call notify failed', e) }`. Best-effort, NEVER throws. Imports `listManagersWithTelegram` (`../db/index.js`), `sendBoardMessage` (`../telegram/boardBot.js`). (Declared here because Phase 4 calls it — review finding.)
- Worker imports: `type CostContext` (add to `../db/index.js` import L1-8); `openCallActionReview` (`../db/index.js`); `defaultCallClassifier`, `isCallIntent`, `type CallIntent` (`./classifyCall.js`); `notifyManagers` (`./notify.js`).
- `WorkerDeps` (L24): add explicit signatures — `classifyCall: (t:string, ctx?:CostContext)=>Promise<{intents:CallIntent[]; reason:string}>`; `openCallActionReview: (input:{tenantId:string; captureId:string; intents:string[]; priority?:'normal'|'high'; callerPhone?:string|null; snippet?:string|null})=>Promise<unknown>`; `notifyManagers: (tenantId:string, text:string)=>Promise<void>`.
- `liveDeps` (L45): `classifyCall:(t,ctx)=>defaultCallClassifier(t,ctx)`, `openCallActionReview`, `notifyManagers`.
- Between transcript (L79) and `recordFieldNote` (L81) — classify + validate + fail-safe:
  ```ts
  let validated: CallIntent[] = []; let unclassified = false; let reason = '';
  try {
    const c = await deps.classifyCall(transcript, { tenantId: row.tenant_id, technicianRef: 'phone-line' });
    validated = c.intents.filter(isCallIntent); reason = c.reason ?? '';
    if (validated.length === 0) unclassified = true;      // empty / all-garbage
  } catch { unclassified = true; }
  const structure = !unclassified && validated.includes('new_job');
  ```
- `recordFieldNote({...})`: set `structure`, and `sourceMeta:{ ...existing, callIntents: unclassified?['unclassified']:validated, reason }`.
- Replace the review branch (L100-107) — two independent checks + push:
  ```ts
  if (!unclassified && validated.includes('new_job')
      && (result.status==='needs_confirmation' || result.status==='needs_disambiguation')) {
    await deps.openUnlinkedCallReview({ tenantId: row.tenant_id, captureId: result.captureId,
      callerPhone: row.caller_phone, snippet: transcript.slice(0,200) });
    await deps.notifyManagers(row.tenant_id, `📋 Call — new customer to link · ${row.caller_phone ?? ''}`);
  }
  const reviewIntents = unclassified ? ['unclassified']
    : validated.filter(i => i==='reschedule'||i==='cancel'||i==='question'||i==='complaint');
  if (reviewIntents.length && result.status !== 'duplicate') {
    const priority = (unclassified || reviewIntents.includes('complaint')) ? 'high' : 'normal';
    await deps.openCallActionReview({ tenantId: row.tenant_id, captureId: result.captureId,
      intents: reviewIntents, priority, callerPhone: row.caller_phone, snippet: transcript.slice(0,200) });
    await deps.notifyManagers(row.tenant_id,
      `${priority==='high'?'🔴':'📋'} Call — ${reviewIntents.join(', ')} · ${row.caller_phone ?? ''} · "${transcript.slice(0,120)}"`);
  }
  // 'other' only → nothing
  ```
- `markCallIngested` (L111): `result.status` now includes `'captured'` (`call_ingest.match_status` is free-text — confirmed).

**`worker.test.ts`** — add defaults to `makeDeps` (L60-83): `classifyCall: async()=>({intents:['new_job'],reason:''})`, `openCallActionReview` spy, `notifyManagers` spy — or existing tests fail to compile. Assert WIRING (recordFieldNote is stubbed): `new_job` → called `structure:true`, no action review; `cancel` → `structure:false`, `openCallActionReview` intents `['cancel']`, `notifyManagers` called; `[new_job,cancel]` → `structure:true` AND action review; classify throws → `structure:false`, `openCallActionReview` `['unclassified']` priority high; `other` → neither review; `duplicate` status → no action review.

**`src/calls/notify.test.ts`** (new) — `listManagersWithTelegram` stub → 2 managers (1 with, 1 without `telegram_user_id`) → `sendBoardMessage` called once; a throwing `sendBoardMessage` does NOT reject `notifyManagers`. (Inject/spy per repo test style.)

**`docs/nemoclaw-tech-agent.md`** — short subsection near §6: inbound calls run an intent router; new_job auto-creates, others open a pushed manager review, never auto-executed; **no new MCP tool** (counts unchanged).

**Verify:** `tsc`/`lint`/`test` green; branch + notify tests pass.

## Phase 5: Dead-letter alert on terminal call failure

The pre-classification failure path (download/transcribe throws) retries and, when exhausted, parks
the row in `status='error'` — silently today. Push the manager so a dead call isn't invisible.

- **`src/db/callIngest.ts`** — `markCallError` (L93) currently returns `void` but already computes
  `status = attempts >= 5 ? 'error' : 'pending'`; **return `{ status, attempts }`** so the worker
  knows whether this was the final attempt (review finding — the "only when exhausted" condition is
  otherwise unwritable).
- **`src/calls/worker.ts`** — widen `WorkerDeps.markCallError` (L31) to
  `(id, message) => Promise<{ status: string; attempts: number }>`; `liveDeps` unchanged (points at
  the updated fn). In the catch (L126): `const r = await deps.markCallError(row.id, msg); if (r.status === 'error') { await deps.notifyManagers(row.tenant_id, '⚠️ a call failed to process — check the pending-call queue').catch(() => {}); }`.
- **`worker.test.ts`** — update the `makeDeps` `markCallError` stub to return `{status:'pending', attempts:1}` (and make it overridable); add a test: transcribe throws AND `markCallError` returns `{status:'error'}` → `notifyManagers` called with the dead-letter text; `{status:'pending'}` → NOT called.

**Verify:** `tsc`/`lint`/`test` green; dead-letter test passes.

## Live & manual verification (P4 + P5)

- **Live (agent-executable):** local stack + `INFERENCE_API_KEY` + `ASSEMBLYAI_API_KEY` (the existing worker-E2E rig):
  - new_job recording (seeded caller) → open job+visit, job in `listUnscheduledOpenJobsWithCustomer`.
  - cancel recording → L1 row, NO job, one `call_action` row (`detail.intents=['cancel']`), `match_status='captured'`.
- **Manual:** router accuracy spot-check on real diarized transcripts (borderline new_job/other/cancel/complaint) — the only genuinely human check. Confirm a real push lands in a manager's Telegram once `BOARD_BOT_TOKEN` is on the calls worker.

---
*Pause after Phase 5 for the manual accuracy + real-push checks; Phases 1–4 gate on automated tests.*

---

# Companion design — identity assurance & the advisory flag

**Status:** design, deferred. **NOT part of Phases 1–5.** The current pipeline is already safe on its
own — mutations never auto-execute (they open a pushed `call_action` review), and a `new_job` only
opens a job a human sees. This section records the surrounding identity design so the *future*
action/dispatch/flag features build on a written contract instead of re-deriving it. Where a piece
needs net-new schema or an MCP tool, it is called out — those diverge from Phases 1–5's "no migration
/ no new MCP tool" guarantee **by design**, because they are separate future scope.

## Why this is separate from the router
The router answers **what the caller wants** (intent). This answers **how much trust is required
before the spine discloses data or commits a consequential action**, and **how a tenant handles a
repeat bad actor**. The router already enforces the core of it ("never auto-execute mutations"); this
is the threat model + the lighter flag design + the system/tenant division that the router's outputs
(`new_job`, `call_action`, `unlinked_call`) feed into.

## The invariant (everything derives from this)
> A phone-asserted identity may **capture** freely and be a **suggestion** for matching. It may
> **never, on its own, disclose data or commit a consequential action.** Trust rises only with an
> **independent** signal — and what that signal is (deposit / callback / on-site) is **tenant policy**,
> not something the spine mandates.

## Threat model — phone identity is weak
- **Assertion, not authentication.** Caller-ID is spoofable; a name/address/phone is knowable. The
  matcher treats an asserted signal as identity — anyone who knows a customer's phone/address can
  assert it.
- **Impersonation via a known address.** An exact, unique address match auto-creates a job under the
  *real* customer — the caller need only know the address string.
- **But the blast radius is bounded:** the agentless phone path **discloses nothing back** to the
  caller (no IVR reading account data). So impersonation is **write-pollution**, never **exfiltration**.
  The hard rule that keeps this true: **never add read-back of customer data over an unauthenticated
  call.** If an IVR that reads account info is ever added, it must sit behind real auth (OTP to the
  on-file contact), not caller-ID.

## Decisions — identity assurance
- **Capture freely** (L1), **disclose nothing**, and **redact card/CVV/SSN before the L1 write**
  (already in the pipeline — keep it; see Payment below).
- **Match is a suggestion, never proof** — it never auto-acts. Consequential actions are gated.
- **New customer = provisional.** Verification is **tenant policy** (deposit / callback / on-site),
  **not** system-mandated. The spine provides the *hooks* (a trust field, a provisional state), not
  the policy — a shop that dispatches on trust is free to.
- **No auto-dispatch without an independent signal.** The signal, and its strength, is the tenant's
  gate. The spine's job is only to never *auto*-roll a truck on an asserted identity alone.
- **L2 is the correctable safeguard.** L2 rows are mutable → most-recent truth; a bad/fraudulent
  record is fixable anytime. **Guard:** an **unverified call must not silently overwrite a verified
  customer's existing fields** (that is impersonation-in-reverse — "my new number is X" corrupting a
  real record). New/empty fields may enrich freely; changing an *existing verified* field routes
  through the human. Every L2 field keeps its `source_capture_id`, so the claiming call is always
  visible.
- **Manager confirms "this is a real request worth acting on," NOT "I verified this identity."** A
  manager cannot authenticate a caller from a transcript; do not ask him to. Verification is
  **structural** (deposit/callback/on-site), not a human guess. (system-design: move the required
  check into the mechanism, not a human's judgment.)

## First-time-caller fraud — the honest ceiling
A stranger's first call **cannot be authenticated.** So: **contain the harm, do not try to prevent
the request.**
- capture (evidence in L1) → **provisional** job → **no dispatch** without the tenant's independent
  signal → verify by that signal, not by the call.
- **recoverable:** L2 is correctable; L1 is the permanent evidence trail; a taken deposit leaves a
  payment/chargeback trail.
- **the ceiling:** L2 correction fixes the *data*, not a dispatch that already rolled. The real-world
  harm (a truck already sent) is bounded by the **tenant's own pre-dispatch policy**, which the spine
  does not control. What the spine guarantees: a false request never *automatically* costs a truck
  roll or binds a verified identity.

## The advisory flag — replaces a hard "fraud" status
**Decision:** do **not** build a hard `fraud` status with enforcement (matcher exclusion +
auto-voiding child jobs + merge tombstones). It introduces too many costly edge cases (a "flagged"
row still matches unless every matcher is rewritten to exclude it; correcting L2 silently fails to
correct matching; the address follows the tombstone to the next real caller). Instead use a
**lightweight, advisory, human-in-the-loop flag.**

- **Flag the identity, not only a row.** A watchlist so a repeat *unmatched* caller (no customer row)
  is still caught:
  ```
  flagged_identities { tenant_id, type: phone|address|name, value, status, reason, flagged_by, flagged_at }
  ```
  plus an optional `customers.status` when a row exists.
- **The flag-check is SEPARATE from the customer matcher — leave `findCustomersBy*` untouched.** On
  each call, after extract, check whether phone/address/name hits the watchlist. Matching here may be
  **fuzzy / OR** (a false positive is cheap — just a manager review, unlike the customer matcher where
  a wrong match pollutes). A hit **opens a review and PUSHES the manager with the reason** — reusing
  the router's `call_action` push mechanism (`notifyManagers`).
- **Advisory only.** NEVER auto-refuse or auto-void. The manager decides on each reappearance (may
  still choose to serve a "watch" customer). The flag adds *context*, not enforcement.
- **Sensitive — treat as an internal accusation.** A blacklist label is PII and a judgment about a
  person: **internal-only, never disclosed or read back**; `reason` + `flagged_by` + timestamp
  recorded (the manager's flag instruction lands in L1 under the classifier-free outbound-action
  carve-out); strictly tenant-scoped. Because it is advisory + human-reviewed every time, a **wrong
  flag's blast radius is contained** — worst case, a dismissable review.
- **Reversible.** The manager updates or clears the status by telling the bot.
- **Manager tool (net-new, manager-only, staged-confirm):** a **single** `flag_identity` tool with an
  `op: set | update | clear` param plus `{ type: phone|address|name (or a customerId), value, status,
  reason }` — mirroring the repo's `resolve_review` one-tool-with-enum shape rather than a tool per
  verb. *(Diverges from Phases 1–5's "no new MCP tool" by exactly **one** tool — companion scope.)*
- **Net-new schema:** `flagged_identities` table + optional `customers.status`. *(Diverges from
  "no migration" — companion scope.)*

**MERGE (honest-duplicate dedup) is a SEPARATE concern** — the exact-match matcher creates duplicate
customer rows (address drift, spoken-vs-saved phone). If/when dedup is actually needed, a
survivor-plus-tombstone merge is the tool; it is **unrelated to flagging** and must not be bundled
with it.

## Customer-facing notice — a detective backstop (deferred)
On a consequential **mutation** (reschedule / cancel / dispatch), notify the customer's **on-file**
contact so the *real* customer catches an impersonation.
- **on-file contact ONLY** — never the asserted/caller contact (else the impersonator gets their own
  receipt and the victim stays blind).
- **email first** — SMS to customers needs explicit opt-in (TCPA-type law).
- **rate-limit + dedupe + log sends** — a notice that fires on a triggered action can be abused to
  spam the real customer; a silently-failed send gives false assurance.
- distinct from the router's **staff** push (`notifyManagers`) — this is a *customer*-facing channel
  the spine does not have today (net-new: outbound SMS via SignalWire, or email).

## Payment / PCI (when a deposit or payment is taken)
- **Never take a card by voice.** Send a **payment link** → the processor's hosted checkout. The card
  is never spoken, recorded, or stored; the deposit clearing is the independent signal.
- **Store a processor token + a `deposit_paid` flag — never the PAN, never the CVV.**
- **The transcript `redact` step (card/CVV/SSN) stays** as the backstop for a card blurted out on the
  recorded call. Redacting the transcript costs nothing operationally — the money lives in the
  processor, not the log; and a stored recording with a spoken CVV is a straight PCI-DSS violation.

## Net-new pieces this companion scope introduces (none in Phases 1–5)
```
customers.status  +  flagged_identities table            (migration)
flag-check in the worker → open+push a "flagged identity" review   (reuses call_action push)
flag_identity(op: set|update|clear)                      (ONE new manager-only MCP tool, staged-confirm)
provisional/verified trust state + dispatch gate         (hooks; policy is the tenant's)
customer-facing on-file notice                            (new outbound channel — email first)
payment link + token storage                              (processor integration)
```

## The standing contract (the one-screen summary)
```
1. Capture freely; disclose nothing; redact card/CVV/SSN before L1.
2. Match is a SUGGESTION, never proof — never auto-acts.
3. No consequential action on asserted identity alone — human / callback / deposit first (tenant policy).
4. New customer → provisional; the spine provides the hook, the TENANT owns the verification.
5. Bad actors → an ADVISORY flag (watchlist + optional row status) → notify-for-review → human decides.
   No hard fraud enforcement, no matcher surgery, no auto-void. Reversible + audited + internal-only.
6. L2 is correctable + current; an UNVERIFIED call may not silently overwrite VERIFIED fields.
7. Notices → on-file contact only; email first; rate-limit + log.
8. Payment via link/processor; store token, never PAN/CVV.
9. Manager confirms "real request," not "verified identity" — verification is structural.
```
