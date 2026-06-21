---
date: 2026-06-19
task: Stage 2 — technician write-path (voice/text note → spine) via a NemoClaw agent + custom MCP server
research: thoughts/shared/research/2026-06-19-technician-write-path-nemoclaw-input-channel.md
status: complete — code + automated + reachable-live verification done; deferred (infra-blocked): Phase 3 NemoClaw/Telegram live E2E + manual UX, Phase 4 Gmail live + manual (see [[deferred-agent-stack-verification]])
---

## Overview
Build the first write-path: a technician's voice/typed note lands as **L1** `raw_captures`, gets
**Sonnet-extracted** into candidate L2/L3, is **deterministically identity-matched** to a
customer/job/visit (schedule-confirm, ask fallback), and is written with provenance — then the same
agent can **read** the spine to answer questions. The NemoClaw tech agent (Telegram + cloud STT) is
the channel; our **custom MCP server** is the only thing that touches the spine and holds the keys.

Key constraints carried from research + code:
- **`raw_captures` is append-only** (trigger blocks UPDATE). Provenance flows via `L2.source_capture_id`,
  **not** by back-updating the capture. The capture's own `customer_id/job_id/visit_id` are set
  **only at insert**, when already known (e.g. a follow-up note on a known job).
- **Identity matching is deterministic, server-side, tested** — the agent only *suggests* (overview §5).
- **L1 first, always.** The verbatim note lands before extraction so a bad extraction can be re-run.
- All DB access stays in `src/db/`; business logic (extract/match/orchestrate) lives outside it and
  calls in. External clients (Anthropic, Google) are **injected** so phases are testable without live keys.
- Single tenant for now; tech identity is a `technicianRef` text threaded from the channel (no users table yet).

**New deps:** `@modelcontextprotocol/sdk` (server), `@anthropic-ai/sdk` (extraction), `googleapis` (Sheet sync).
**New env** (add to `.env.example` in the phase that introduces each, alongside the existing
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`DATABASE_URL`): `ANTHROPIC_API_KEY` (P1),
`SCHEDULE_SHEET_ID` + `GOOGLE_APPLICATION_CREDENTIALS` (P2), `DEFAULT_TENANT_ID` (P3).

---

## Phase 1: Write-path orchestrator + Sonnet extraction (ask-only matching)

### What this phase does
End-to-end core as plain, tested functions (no MCP yet): a note → L1 → extract → match → L2/L3 with
provenance. Matching this phase: exact deterministic match on phone/address, else `needs_disambiguation`
(agent will ask) or create-new on explicit resume. The schedule-confirm branch arrives in Phase 2.

### Changes required

**`src/writePath/extract.ts`** (new)
- `export interface ExtractedFields { customerName?; phone?; address?; city?; state?; postalCode?; jobTitle?; jobType?; workPerformed?; laborHours?; statusSignal?: 'completed'|'in_progress'|null; followUp?: string|null; attributes?: Json }`
- `export type Extractor = (rawText: string) => Promise<ExtractedFields>`
- `export const sonnetExtractor: Extractor` — calls `@anthropic-ai/sdk` with `model: 'claude-sonnet-4-6'`,
  a tool/JSON-schema-constrained response mapping to `ExtractedFields`. Reads `ANTHROPIC_API_KEY`.

**`src/writePath/identityMatch.ts`** (new)
- `export interface MatchInput { tenantId; technicianRef; capturedAt; extracted: ExtractedFields; confirmed?: { customerId?: string; address?: string } }`
- `export interface MatchResult { status: 'matched'|'needs_confirmation'|'needs_disambiguation'; customerId?; jobId?; suggestion?: { address: string; scheduleEntryId: string }; reason?: string }`
- `export async function matchIdentity(input): Promise<MatchResult>` — Phase 1 logic: if `confirmed.customerId`
  → matched; else exact unique match on `extracted.phone` then normalized `extracted.address` against
  existing `customers` → matched; else `needs_disambiguation`. Deterministic, **but it reads the DB**
  (queries `customers`) — so its test is DB-backed (see verification), not a pure unit test.

**`src/writePath/recordFieldNote.ts`** (new)
- `export async function recordFieldNote(input: { tenantId; technicianRef; text?; blobPath?; channel: CaptureChannel; confirmed?; captureId?; }, deps?: { extract?: Extractor }): Promise<{ status: MatchResult['status']; captureId: string; customerId?; jobId?; visitId?; suggestion? }>`
- Flow: (1) **first call** (`captureId` absent) → `appendRawCapture({ tenantId, channel, rawText: text, blobPath })` (provenance null; `tenantId` **must** be threaded — the column is `not null`). (2) load raw_text (from the insert result, or by `captureId` on resume). (3) `extract(rawText)`. (4) `matchIdentity`. (5) if `matched`: create/patch L2 — `createCustomer` if new, `createJob` (or reuse the matched job), `createVisit({ technicianName: technicianRef, laborHours: extracted.laborHours, attributes: { workPerformed, followUp, ... } })` — note `laborHours` maps to its **L2 column**, not attributes — each with `sourceCaptureId: captureId`. (6) else return `{status, captureId, suggestion}` for the agent to ask; **resume** = caller re-invokes with `captureId` + `confirmed`.
- **Status transitions:** apply `extracted.statusSignal` only when the transition is legal — check `ALLOWED_TRANSITIONS[currentStatus].includes(signal)` **before** calling `updateJobStatus`, and skip otherwise. Do **not** call `updateJobStatus` blindly: a new job defaults to `'open'`, and `open→completed` is illegal and **throws** (jobs.ts:70-74), which would abort the write after L1+L2 already exist. Cover this exact case (new job + `statusSignal:'completed'` → job stays `open`, no throw) in the integration test.
- **Resume determinism:** identity resolution on resume keys off `confirmed` (and in P2 the `scheduleEntryId`), so the *match* is stable even though step (3) re-extracts; only descriptive L2 fields (workPerformed, etc.) may drift slightly between the two extractions. Acceptable for v1 — note it; do not try to cache the extraction on the capture (`raw_captures` is insert-only, set before extraction runs, so it can't hold it).
- **Must not** update `raw_captures` after insert (append-only). Provenance = `source_capture_id` on L2 only.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm run build` pass
- [x] new **DB-backed** test `src/writePath/identityMatch.test.ts` (TEST Supabase — `matchIdentity` reads `customers`, so seed rows in `beforeAll`): phone-match→matched, address-match→matched, no-match→needs_disambiguation, `confirmed.customerId`→matched; `afterAll` truncates `customers,jobs,visits,raw_captures`
- [x] new integration test `src/writePath/recordFieldNote.test.ts` (TEST Supabase, **stubbed** extractor): note→ L1 row exists; matched path creates customer+job+visit with `source_capture_id===captureId` and `laborHours` on the visit column; **new job + `statusSignal:'completed'` stays `open` and does not throw**; resume call adds no second L1; cross-channel pg read-back of provenance; reuse-existing-job branch; `afterAll` truncates `customers,jobs,visits,raw_captures`

### Live verification (agent-executable)
- Prerequisites: `ANTHROPIC_API_KEY` set in `.env`
- [x] run `sonnetExtractor` once on a sample transcript (e.g. "Replaced the capacitor at 14 Smith St, unit running, charged 400") and confirm the returned `ExtractedFields` has address + workPerformed populated; capture the JSON — **PASSED 2026-06-19** (live `claude-sonnet-4-6`): returned `address:"14 Smith St"`, `workPerformed:"Replaced capacitor. Unit running after replacement."`, `jobType:"hvac"`, `statusSignal:"completed"`, `attributes.chargeAmount:400`

### Manual verification
- (none)

---
*No manual checks — implementer continues.*

## Phase 2: Schedule store + Google Sheet sync + schedule-confirm matching

### What this phase does
Add the firm schedule as a queryable spine table, a one-way **Google Sheet → table** sync (managers
edit the sheet), and the `needs_confirmation` branch: when a tech is on today's schedule, propose the
address ("Is this the address: <X>?") before writing.

### Changes required

**`supabase/migrations/<ts>_schedule_entries.sql`** (new)
- `create table schedule_entries ( id uuid pk default gen_random_uuid(), tenant_id uuid not null references tenants(id), technician_ref text not null, customer_id uuid references customers(id) on delete set null, job_id uuid references jobs(id) on delete set null, customer_name text, address_line1 text, city text, state text, postal_code text, phone text, scheduled_start timestamptz, scheduled_end timestamptz, external_row_key text not null, source text not null default 'google_sheet', attributes jsonb not null default '{}'::jsonb, created_at timestamptz not null default now(), updated_at timestamptz not null default now() );`
- `create unique index uq_schedule_entries_rowkey on schedule_entries(tenant_id, external_row_key);` plus indexes on `tenant_id`, `technician_ref`. Add an `updated_at` trigger **targeting `schedule_entries`** (mirror `20260620012321_add_updated_at_trigger.sql`; don't apply it to tables without the column — `visits` deliberately has none).
- Apply with `npm run db:push` **and confirm it succeeded**, then regenerate `npm run gen:types`. Note `gen:types --linked` overwrites all of `src/db/database.types.ts` from the linked TEST project, so the migration must be live there first or `scheduleEntries.ts` won't compile.

**`src/db/scheduleEntries.ts`** (new) + export from `src/db/index.ts`
- `upsertScheduleEntry(input)` — insert-or-update on `(tenant_id, external_row_key)` (idempotent).
- `listScheduleForTechnicianOnDate(tenantId, technicianRef, isoDate): Promise<ScheduleEntry[]>` — entries whose `scheduled_start` falls on that date.

**`src/schedule/sheetSync.ts`** (new)
- `export type SheetReader = (spreadsheetId: string) => Promise<ScheduleRow[]>` (injectable; default uses `googleapis`, `GOOGLE_APPLICATION_CREDENTIALS`).
- `export async function syncScheduleFromSheet(tenantId, spreadsheetId, deps?: { read?: SheetReader }): Promise<{ upserted: number }>` — reads rows, maps columns→`upsertScheduleEntry` with `external_row_key` = sheet row id. One-way for v1 (write-back deferred).

**`src/writePath/identityMatch.ts`** (extend)
- Before `needs_disambiguation`: call `listScheduleForTechnicianOnDate(tenantId, technicianRef, capturedAt)`. If exactly one entry → `needs_confirmation` with `suggestion={address, scheduleEntryId}`. On resume with `confirmed.address` matching that entry → resolve to its `customer_id`/`job_id`.
- **Dedup before creating from a schedule entry:** if the entry has no linked `customer_id`, run the **same** phone/address exact-match check against existing `customers` (the Phase 1 logic) before `createCustomer` — a scheduled address that already exists (e.g. from a prior phone-call capture) must reuse that customer, not mint a duplicate. This is the overview §5 invariant; cover it with a test (existing customer at the scheduled address → no duplicate created).

### Automated verification
- [x] `npm run gen:types` produces a `schedule_entries` type; `typecheck`/`lint`/`build` pass
- [x] extend `src/db/schema.test.ts`: `schedule_entries` exists with a unique `(tenant_id, external_row_key)` index
- [x] `src/schedule/sheetSync.test.ts` (stubbed `SheetReader`, TEST Supabase): syncing twice yields no duplicate rows (idempotent), verified cross-channel via pg; `afterAll` truncates `schedule_entries` + spine tables
- [x] extend `identityMatch.test.ts`: one schedule entry → needs_confirmation; resume with matching address → matched to entry's job; existing customer at scheduled address → reused, not duplicated. Its `afterAll` truncate must now also include `schedule_entries` (every write-touching test self-cleans exactly the tables it writes — files run serially via `fileParallelism:false`, so a missed truncate leaks rows into later files)
- [x] _extra:_ `recordFieldNote.test.ts` drives an unlinked scheduled entry through the orchestrator and asserts the new customer is prefilled from the sheet row (`createFrom`), not the empty extraction (added per Phase 2 review)

### Live verification (agent-executable)
- Prerequisites: `googleapis` creds + a TEST Google Sheet id in `SCHEDULE_SHEET_ID`
- [x] run `syncScheduleFromSheet` against the real test sheet; pg read-back shows the sheet's rows in `schedule_entries`; capture row count — **PASSED 2026-06-20** (live Sheets API + TEST Supabase): synced row `tech-jane / "Jane Smith" / "14 Smith St"` (external_row_key=2) read back over direct pg; second sync idempotent (count stayed 1, no duplicates); self-cleaned

### Manual verification
- [x] a human edits a row in the Sheet, re-runs sync, and confirms the change is reflected (sheet-as-edit-surface UX) — **CONFIRMED 2026-06-20**: user edited tech-jane to "John Doe" / "99 ranch st"; re-sync updated the row in place (count stayed 1), verified via pg read-back

---
*Pause after this phase (manual check present).*

## Phase 3: MCP server (write + read-to-chat tools) + NemoClaw/Telegram wiring

### What this phase does
Expose the write-path and read functions as MCP tools the NemoClaw tech agent calls (it never holds
the Supabase/Anthropic keys), and wire the agent (Telegram channel, cloud STT, narrow tool allowlist).

### Changes required

**`src/db/rawCaptures.ts`** (extend, read-only — does not violate append-only)
- `listRawCapturesForJob(jobId)`, `listRawCapturesForCustomer(customerId)` — select, newest first.

**`src/db/visits.ts`** (extend)
- `listVisitsForCustomer(customerId)` — joins through `jobs` (only `listVisitsForJob` exists today); needed by the aggregator's `recentVisits`.

**`src/db/context.ts`** (new) + export from `src/db/index.ts`
- `getCustomerContext(customerId)` → `{ customer, jobs, recentVisits, recentCaptures }` aggregator for "what did the last tech say" briefings (uses `listVisitsForCustomer` + `listRawCapturesForCustomer`).

**`src/mcp/server.ts`** (new) — stdio MCP server via `@modelcontextprotocol/sdk`; reads `SUPABASE_*` + `ANTHROPIC_API_KEY` from env (injected by the gateway as SecretRef). Tools:
- `record_field_note({ technicianRef, text, blobPath?, captureId?, confirmed? })` → wraps `recordFieldNote` (returns `needs_confirmation`/`needs_disambiguation` + `captureId` so the agent can ask, then resume).
- `find_customer({ query })`, `get_customer_context({ customerId })`, `get_job({ jobId })`, `list_recent_captures({ jobId | customerId })` — read tools for chat.
- The tool surface omits `tenantId`; the server reads `DEFAULT_TENANT_ID` from env and passes it into `recordFieldNote`/queries, so the single tenant is fixed server-side for v1 (the agent can't set it).

**`package.json`** — add deps; add script `"mcp:serve": "node dist/mcp/server.js"`.

**`docs/nemoclaw-tech-agent.md`** (new) — runbook: per-tech NemoClaw sandbox (light policy), Telegram BotFather token in the **gateway** (not our repo), cloud STT (Whisper/Deepgram) config, `mcp.servers` entry pointing at `mcp:serve`, `tools` allowlist = the tools above only, policy allow-list for our server. iMessage explicitly dropped.

### Automated verification
- [x] `typecheck`/`lint`/`build` pass; built `dist/mcp/server.js` boots over a real stdio handshake (serves all 5 tools)
- [x] `src/mcp/server.test.ts` — drive the server over the SDK's **in-memory transport** (no network): `record_field_note` returns `needs_confirmation` then resolves on resume; `get_customer_context` returns customer+jobs+visits+recent captures; invalid-channel rejected; self-cleans
- [x] `src/db/context.test.ts` — `getCustomerContext` shape (incl. tech notes surfaced via `source_capture_id` union) + `listRawCapturesFor*` ordering

### Live verification (agent-executable)
- **Status: BLOCKED until provisioned** — no NemoClaw gateway / Telegram bot / STT is wired yet. This is the real E2E and the reason the runbook ([docs/nemoclaw-tech-agent.md](../../../docs/nemoclaw-tech-agent.md)) exists; track it as a setup milestone. The in-memory MCP test + stdio smoke above are the gate until the channel is stood up.
- Prerequisites: NemoClaw gateway running with our MCP server wired, a Telegram test bot token, STT configured, TEST Supabase env
- [ ] send a Telegram **voice** note to the tech bot → answer the confirmation in chat → pg read-back shows an L1 `raw_captures` row (`channel='technician_voice'`) **and** an L2 job/visit with `source_capture_id` pointing at it; capture both rows
- [ ] ask the bot a question about the customer → it returns info sourced from `get_customer_context`

### Manual verification
- [ ] judge the agent's conversational quality and confirmation UX — does it feel like a smart assistant, not a ticket form (the product requirement)

---
*Pause after this phase (manual + live checks present).*

## Phase 4 (later): Email ingestion via the same write-path

### What this phase does
Add the tech's email as a second channel: pull messages, **classify work vs non-work**, and feed only
work mail through the *same* L1→extract→match→provenance pipeline (`channel: 'email'`).

### Changes required

**`src/email/classify.ts`** (new)
- `export type WorkClassifier = (email: { subject; body; from }) => Promise<{ isWork: boolean; reason: string }>` (injectable; default = Sonnet). Non-work mail is dropped (no spine writes).

**`src/email/ingest.ts`** (new)
- `export type MailFetcher = () => Promise<Email[]>` (injectable; default = Gmail via the agent connector / `googleapis`).
- `export async function ingestEmail(tenantId, technicianRef, deps): Promise<{ ingested; skipped }>` — for each work email: `recordFieldNote({ channel: 'email', text: subject+body, ... })`. Reuses Phase 1–2 logic unchanged.

**`docs/nemoclaw-tech-agent.md`** — add the Gmail connector + classifier to the tech agent's (still narrow) connector set.

### Automated verification
- [x] `typecheck`/`lint`/`build` pass
- [x] `src/email/classify.test.ts` — fixtures: a job email → isWork true; a newsletter → false. **Adapted:** implemented as a LIVE test gated with `describe.skipIf(!ANTHROPIC_API_KEY)` (skips without a key, e.g. CI) rather than a live call hard-wired into the gate. Ran live and passed on 2026-06-20.
- [x] `src/email/ingest.test.ts` (stubbed fetcher + classifier, TEST Supabase): work email → L1 `channel='email'` + L2 created; non-work → zero rows; self-cleans

### Live verification (agent-executable)
- **Status: blocked until provisioned** — depends on the Gmail connector + the Phase 3 channel being live. Automated checks (stubbed fetcher/classifier) are the gate until then.
- Prerequisites: a Gmail connector wired to the tech agent + test mailbox
- [ ] send a test **work** email → appears in spine (L1+L2, provenance linked); send a **non-work** email → filtered out (no rows); capture both outcomes

### Manual verification
- [ ] spot-check classifier precision on a small real-inbox sample (human judgment on false positives/negatives)

---
*Pause after this phase (manual + live checks present).*
