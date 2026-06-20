---
date: 2026-06-19
task: Build the three-layer context spine basic structure (schema + typed read/write access) on Supabase
research: thoughts/shared/research/2026-06-19-three-layer-context-spine-structure.md
status: complete
---

## Overview
The repo today is design + RPI scaffolding only — no `package.json`, no `CLAUDE.md`, no schema, no code
(research doc Summary + Constraints). This plan builds **step 1 of the overview's build order**
([Three-Layer-Context-Spine-Overview.md:148-158](../../../Three-Layer-Context-Spine-Overview.md#L148-L158)):
the schema for the three layers plus a typed read/write access layer, on Supabase (Postgres + storage).

**In scope:** Node/TS toolchain, the L1/L2/L3 schema as version-controlled migrations, a typed
data-access module, tests. **Out of scope (next plan = build-order step 2, the write-path):** identity
matching ([overview:140-144](../../../Three-Layer-Context-Spine-Overview.md#L140-L144)), AI extraction,
field-level provenance, telephony/STT, RLS multi-tenant isolation, any UI.

**Key decisions** (✅ = confirmed with the user; alternatives kept for the record):
- **Runtime: TypeScript/Node** — every existing scaffold assumes it ([README.md:31-40](../../../README.md#L31-L40)).
- **Migrations: Supabase CLI SQL files** in `supabase/migrations/` — "schema in version control" is a
  hard requirement ([overview:158](../../../Three-Layer-Context-Spine-Overview.md#L158)).
- **Test target: a dedicated cloud Supabase *test* project** (writable, fake data only); **prod** is a
  separate project exposed **read-only** via its MCP — satisfies verifying-behavior §1 **with no Docker**.
  Migrations applied to test via the linked CLI (`db push`). Tests **self-clean** rows they create.
- **Independent read channel:** the **test Supabase MCP** `execute_sql` (or a direct `pg` connection to the
  test project's `DATABASE_URL`) — a real cross-channel reader vs. the app's supabase-js/PostgREST path.
- ✅ **Tenancy: `tenant_id` column on every table now, one seeded tenant, no RLS yet** — "leave room"
  (same rationale as the status-state-machine note, [overview:82-85](../../../Three-Layer-Context-Spine-Overview.md#L82-L85)).
  *Alt (declined): defer tenancy entirely — cheaper now, painful migration later.*
- ✅ **Provenance: nullable typed FKs `customer_id/job_id/visit_id` on `raw_captures`** (what a capture was
  about, as-of capture time; immutable) **+ a nullable `source_capture_id` back-link on each L2 table** (the
  capture a record was created from; set on the mutable side so it survives append-only).
  *Alt (declined): polymorphic `(entity_type, entity_id)` — loses FK integrity.* Field-level provenance deferred.

## Prerequisites (what you need to supply / install)
- **Node.js LTS + npm.** **No Docker needed** — two cloud Supabase projects replace the local stack.
- **Two Supabase projects:** a **test** project (writable, fake data only) and the **prod** project (real data).
- **Two Supabase MCP servers** (hosted HTTP, `https://mcp.supabase.com/mcp`) configured in Claude Code —
  **prod with `?read_only=true&project_ref=<prod-ref>`**, **test with `?project_ref=<test-ref>`** (writable).
  Auth is OAuth (browser) — no token stored. `claude mcp list` should show both connected before Phase 2.
- **Supabase CLI** (`npm i -D supabase`) — to `link` the **test** project and `db push` migrations (remote,
  no Docker). Linking prompts for the test project's DB password.
- **For `.env` (git-ignored):** the **test** project's `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and direct
  `DATABASE_URL` (from the dashboard). **Prod creds are not put in `.env`** — prod is reached read-only via MCP only.

## Phase 1: Toolchain, CLAUDE.md, and Supabase init

### What this phase does
Make the verification gates real and stand up the Supabase project skeleton, leaving an empty-but-green
test suite. The research doc flagged that `CLAUDE.md` references in the workflow are dangling and no
`package.json` exists — this phase fixes both.

> **Before starting:** the working tree has an uncommitted reorg (research doc Constraints —
> `workflow-export/` staged-deleted + untracked root copies). **Commit or stash it first** so each phase's
> `git diff` (the implement.md review loop) is scoped cleanly. Also confirm both Supabase MCP servers are
> connected (`claude mcp list`) — prod `--read-only`, test writable.

### Changes required
**`package.json`** (new) — scripts (invoke the CLI via `npx supabase`, since it ships as a devDep, not on PATH):
`"typecheck":"tsc --noEmit"`, `"lint":"eslint ."`, `"test":"vitest run"`, `"test:watch":"vitest"`,
`"build":"tsc -p tsconfig.json"`, `"db:push":"npx supabase db push"`,
`"gen:types":"mkdir -p src/db && npx supabase gen types typescript --linked > src/db/database.types.ts"`.
Dev deps: `typescript`, `vitest`, `@types/node`, `eslint`, `typescript-eslint`, `supabase`, `pg`, `@types/pg`.
Dep: `@supabase/supabase-js`, `dotenv`.
**`tsconfig.json`** (new) — `strict:true`, `module/moduleResolution:"NodeNext"`, `outDir:"dist"`, `rootDir:"src"`.
**`eslint.config.js`** (new) — minimal flat config using `typescript-eslint` recommended.
**`vitest.config.ts`** (new) — `test: { environment:'node', include:['src/**/*.test.ts'], setupFiles:['src/test.setup.ts'] }`.
**`src/test.setup.ts`** (new) — `import 'dotenv/config'` (vitest does not auto-load `.env`).
**`.gitignore`** (new) — `node_modules`, `dist`, `.env`, `supabase/.temp`.
**`.env.example`** (new) — `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` (the test project's
direct connection string) with placeholders. The real `.env` is filled from the test project dashboard in Phase 2.
**`CLAUDE.md`** (new) — paste both sections from [CLAUDE-md-sections.md](../../../CLAUDE-md-sections.md);
adjust the Verification block to the real scripts (`npm run typecheck`/`lint`/`test`/`build`); add a one-line
**Conventions** heading (referenced by [implement.md:38](../../../.claude/commands/implement.md#L38)) and a
**Domain** pointer to the overview doc.
**`.claude/settings.json`** — add to `permissions.allow`: `"Bash(supabase*)"`, `"Bash(npx supabase*)"`
(the existing list at [settings.json:3-22](../../../.claude/settings.json#L3-L22) lacks these).
**`supabase/`** — run `supabase init` (creates `config.toml`). Do **not** commit secrets.
**`src/index.ts`** (new, placeholder) + **`src/sanity.test.ts`** (new) — one trivial passing test so `npm test` is green.

### Automated verification
- [x] `npm install` succeeds
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm test` passes (sanity test green)
- [x] `npm run build` produces `dist/`
- [x] `npx supabase link --project-ref <test-ref>` succeeds — linked to `daqapdlkgxfrhquacprv`; direct pg connection verified (`select 1` → `{"ok":1}`)

### Live verification (agent-executable)
- Prerequisites: both Supabase MCP servers connected (`claude mcp list`) — prod read-only, test writable.
- [x] MCP `list_tables` against the **test** project returns — evidence: `{"tables":[]}` (test `public` schema empty, clean baseline)

### Manual verification
- [ ] None.

---
*No manual items — implementer continues.*

## Phase 2: The three-layer schema migration

### What this phase does
Create the L1/L2/L3 schema as one version-controlled migration and apply it to the test project, mirroring
the overview's record shape `customers ─(1:N)─ jobs ─(1:N)─ visits` + append-only `raw_captures`, with an
`attributes jsonb` (L3) on each L2 table and `job_status` as a state-machine enum
([overview:67-85](../../../Three-Layer-Context-Spine-Overview.md#L67-L85)).

### Changes required
**`supabase/migrations/0001_context_spine.sql`** (new):
- `create table tenants (id uuid pk default gen_random_uuid(), name text not null, created_at timestamptz default now())`;
  seed one row.
- `create type job_status as enum ('open','in_progress','completed','invoiced','paid','cancelled','declined')`
  ([overview:82-85](../../../Three-Layer-Context-Spine-Overview.md#L82-L85)).
- `create type capture_channel as enum (...)` covering the channels in
  [overview:94-122](../../../Three-Layer-Context-Spine-Overview.md#L94-L122) (technician_voice/photo/note,
  phone_call, web_form, sms, email, chat, manager_assistant, manual_correction, sales_note, quote,
  crm_import, accounting_event, iot).
- **customers** (L2): `id`, `tenant_id` fk→tenants not null, `name` not null, `phone`, `email`, address
  fields, `attributes jsonb not null default '{}'` (L3), `source_capture_id uuid` (nullable; FK→raw_captures
  added later — see below), `created_at`, `updated_at`.
- **jobs** (L2): `id`, `tenant_id`, `customer_id` fk→customers `on delete cascade`, `title`, `job_type`,
  `status job_status not null default 'open'`, `price_cents int`, `attributes jsonb default '{}'`,
  `source_capture_id uuid` (nullable), timestamps.
- **visits** (L2): `id`, `tenant_id`, `job_id` fk→jobs `on delete cascade`, `technician_name`,
  `scheduled_at`, `started_at`, `completed_at`, `labor_hours numeric`, `attributes jsonb default '{}'`,
  `source_capture_id uuid` (nullable), `created_at`.
- **raw_captures** (L1): `id`, `tenant_id`, nullable `customer_id`/`job_id`/`visit_id` fks
  `on delete set null` (provenance, [overview:72-74](../../../Three-Layer-Context-Spine-Overview.md#L72-L74)),
  `channel capture_channel not null`, `raw_text text`, `blob_path text`, `metadata jsonb default '{}'`,
  `captured_at timestamptz default now()`, `created_at`. **No `updated_at`** (append-only).
- **Back-link FKs (added after `raw_captures` exists, to break the circular reference):**
  `alter table customers add constraint customers_source_capture_fk foreign key (source_capture_id)
  references raw_captures(id) on delete set null;` — repeat for `jobs` and `visits`. The
  `source_capture_id` records the capture a record was created from (set on the mutable L2 side, so it
  survives the append-only trigger on `raw_captures`).
- **Append-only enforcement (two objects — Postgres has no inline trigger body):**
  `create function raise_append_only() returns trigger language plpgsql as $$ begin raise exception
  'raw_captures is append-only'; end; $$;` defined **before** the trigger, then `create trigger
  raw_captures_append_only before update or delete on raw_captures for each row execute function
  raise_append_only();` — locks the L1 invariant ([overview:43,55-59](../../../Three-Layer-Context-Spine-Overview.md#L43)).
- Indexes on every FK column (including each `source_capture_id`). (Object order in the file: enums →
  function → tenants → customers → jobs → visits → raw_captures → back-link `alter table` FKs → trigger → indexes.)

**Steps:** populate `.env` with the **test** project's `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and
`DATABASE_URL` (from the dashboard), then `npm run db:push` (applies the migration to the linked test
project) and `npm run gen:types` (writes `src/db/database.types.ts`).

### Automated verification
- [x] `npm run db:push` applies the migration to the **test** project with no error (via `--db-url`, dry-run then apply; Docker warning is non-fatal)
- [x] `npm run gen:types` writes `src/db/database.types.ts` (515 lines, all 5 tables); `npm run typecheck` still passes
- [x] **New test** `src/db/schema.test.ts` (direct `pg`): asserts all 5 tables exist, each L2 table has a jsonb
      `attributes` + nullable `source_capture_id`, `jobs.status` udt is `job_status`, and
      `raw_captures.{customer_id,job_id,visit_id}` are nullable — all pass
- [x] `npm test` passes (2 files, 6 tests)

### Live verification (agent-executable)
- Prerequisites: test Supabase MCP (writable) or a direct `pg` connection (`DATABASE_URL`).
- [x] Append-only enforced. **Codified** in `schema.test.ts` (insert + `UPDATE` inside a transaction →
      rejected with `raw_captures is append-only` → `rollback`, no residue). *Deviation:* done as a codified
      pg test, not a live insert-then-delete, because the trigger also blocks `DELETE` (a committed probe row
      couldn't self-clean). MCP cross-check (independent channel): trigger + guard function present, all entity
      tables 0 rows, `tenants` = 1 — evidence: `{"raw_captures_rows":0,...,"append_only_trigger_present":true}`

### Manual verification
- [ ] None.

---
*No manual items — implementer continues.*

## Phase 3: Typed data-access layer + tests

### What this phase does
Provide the hardcoded, deterministic read/write API over the three layers — the "trustworthy foundation"
([overview:136-138](../../../Three-Layer-Context-Spine-Overview.md#L136-L138)) — including job-status
transition validation and `appendRawCapture` (insert-only) with provenance links.

### Changes required
**`src/db/client.ts`** (new) — `getClient()` builds a `@supabase/supabase-js` client from `SUPABASE_URL` +
`SUPABASE_SERVICE_ROLE_KEY` (via `dotenv`); throws if either is unset.
**`src/db/customers.ts`** — `createCustomer(input): Promise<Customer>`, `getCustomer(id): Promise<Customer|null>`.
  `input` accepts an optional `sourceCaptureId` (the capture this record was created from); same for jobs/visits below.
**`src/db/jobs.ts`** — `createJob(input)`, `getJob(id)`, `listJobsForCustomer(customerId)`,
`updateJobStatus(id, next: JobStatus): Promise<Job>`. Status transitions validated against a hardcoded map
`ALLOWED_TRANSITIONS: Record<JobStatus, JobStatus[]>` (`open→in_progress|cancelled|declined`,
`in_progress→completed|cancelled`, `completed→invoiced`, `invoiced→paid`); illegal transition throws.
**`src/db/visits.ts`** — `createVisit(input)`, `listVisitsForJob(jobId)`.
**`src/db/rawCaptures.ts`** — `appendRawCapture(input)`: insert-only; accepts optional `customerId/jobId/visitId`
+ `channel` + `rawText`/`blobPath`. **No update/delete exported** (mirrors the DB append-only invariant).
**`src/db/index.ts`** — re-export the above. Types derive from `database.types.ts`.
**`src/db/spine.test.ts`** (new, Vitest, against the **test** project; self-cleans rows it creates) — see verification.

### Automated verification
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm test` passes (3 files, 9 tests), including new cases:
  - [x] round-trip: `createCustomer` → `appendRawCapture(phone_call)` = C1 →
        `createJob({sourceCaptureId: C1.id})` → `createVisit` →
        `appendRawCapture(technician_voice, linked to all three)` = C2; C2's three FKs resolve **and**
        `job.source_capture_id === C1.id` — asserted via the app path **and** an independent direct-pg read
  - [x] `updateJobStatus` accepts `open→in_progress` and **rejects** `open→paid` (throws)
  - [x] L3: a customer with `attributes:{gateCode:'1234'}` reads back with that JSON intact
- [x] `npm run build` passes

### Live verification (agent-executable)
- Prerequisites: the **test** Supabase project; its MCP (`execute_sql`) or a direct `pg` connection as the independent channel.
- [x] Cross-channel read-back verified across **three** channels: data layer writes via supabase-js/PostgREST;
      codified read-back via direct `pg` (in `spine.test.ts`); plus an agent-driven **MCP `execute_sql`** read-back
      of a demo row-set — evidence: `customer_attributes:{"gateCode":"9999"}`, `backlink_resolves:true`,
      `capture_links_customer:true`; then TRUNCATE self-clean → all entity tables 0 rows, `tenants`=1.
      *Deviation:* the MCP read-back was run by the main agent; the codified supabase-js→pg read-back is the
      maker≠checker cross-channel proof (the data-layer code under test was not graded by itself — pg/MCP are
      independent channels).

### Manual verification
- [ ] None.

---
*No manual items — implementer continues. Identity matching and the first real write-path are the next plan.*
