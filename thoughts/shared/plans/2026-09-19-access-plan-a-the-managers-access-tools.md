---
date: 2026-09-19
task: Access plan A of 2 — the manager's access tools (grant_access, revoke_access, list_access, set_technician_view), a person-wide money grant, and the planner's view of grant history
research: thoughts/shared/research/2026-09-19-the-technician-access-request-flow.md
status: complete
supersedes: nothing
---

## Overview

Plan 2 of the retrieval layer built the ledgers a technician's view reads (`access_grants`,
`technician_view_rules`) but no tool writes them: today only SQL opens anything. This plan gives
the manager's seat four tools to grant, list, revoke and set the firm's rule; adds the one thing
the ledger cannot say yet, "this technician sees money figures everywhere"; and gives the planner a
read of the grant history. Plan B (`2026-09-19-access-plan-b-the-request-flow-through-the-office.md`)
builds the request flow on top: the desk as the filter, the text to the manager, the message back.

## Decisions

- **Two plans, A first** (operator, 2026-09-19). B's desk writes grants A's tools list and revoke.
- **Money is sensitive by default** (operator, 2026-09-19). Figures open three ways, and only a
  manager opens them: the firm's rule (`money = 'amounts'`, firm-wide, permanent), a **person-wide
  money grant** ("Sam sees prices", until revoked; new here), or a grant on one job or customer
  with money. Any money ask without one of these goes to a manager (plan B).
- **Person-wide money grant = a grants-ledger row with no customer and no job** (my call), over a
  roster flag, because the ledger already carries who granted, why, and a revoke stamp. It opens
  money only (`opens` NULL, `opens_money` true) and never widens what she can open. This widens
  plan 2's "exactly one customer or one job"
  (`thoughts/shared/plans/2026-09-15-the-retrieval-layer-2-the-technician-limited-view.md`) for
  money only; the rest of plan 2 stands, hence `supersedes: nothing`.
- **All four tools are manager-only (admin); the planner gets none** (operator, 2026-09-19: "the
  desk is the one picking it up… grant access should be done in a timely manner. The planner
  doesn't need to grant access, but should be seeing the history"). This also keeps the planner's
  tool list unchanged, and keeps shadow runs and the Calls-worker's focused passes
  (which share `TEAM_LEAD_TOOL_SCHEMAS`) from ever writing a grant — the plan review's top finding
  against the first draft, which made `grant_access` a shared planner tool.
- **The planner sees the history through a read view**, `v_access_grants`, in the `spine_read` /
  `query_spine` catalog. Plan B adds a line per event to what the planner is shown each run. The
  catalog is part of `spine_read`'s description, so the planner, the manager desk and the
  Calls-worker each take one prompt-cache miss when it changes; nothing else moves.
- **The firm-wide rule's settings-page section** belongs to the parked settings-page task
  (task `20260919-manager-settings-page-in-the-schedule-bo`), not this one.
- **A manager's plain "yes" = the record for 7 days** (operator accepted, 2026-09-19); "for good"
  = standing; "with notes" = `record_and_notes`; "with prices" = money. Customer-wide grants (every
  job of the customer, finished ones too) are a manager's option.
- **The firm-wide rule is a bot tool now, and later also a settings-page section** (operator,
  2026-09-19: "we can make it a section in the settings page, but the manager should probably be
  able to make that switch through the bot also"). The settings page is not this task.
  `set_technician_view` changes only the fields named: `setTechnicianViewRule` is a full replace,
  so the handler reads, overlays, writes. An empty `technicianChannels` is refused (`{}` means "no
  channels" in the database, not "default").
- **Plan A tells the manager to let the technician know**; plan B makes it automatic.
- **No contradiction detector** (operator doctrine, 2026-09-19): a filing that does not match the
  record is the seat's to notice, and code never refuses it; plan B phase 4 makes the note tool
  say what it assumed.

## Plain-language walkthrough

**Phase 1 — the ledger learns "Sam sees prices", and the planner can read it.** A grant may now name
no customer and no job if it only opens money figures; the database's view rule then treats that
technician as "figures open wherever she can already look". A trap is fixed on the way: the
ledger's "only a revoke may change a grant" check compares `opens` with `=`, which fails on an
empty value, so revoking a person-wide grant would be refused. A new read-only view lists every
grant for the planner and for managers' ad-hoc questions.

**Phase 2 — the manager's four tools.**

```
manager's seat ──grant_access──────▶ access_grants row ──▶ Sam's next read: in view
      ├──list_access──────────▶ live grants + the firm's rule
      ├──revoke_access────────▶ revoke stamp ──▶ Sam's next read: "outside your view"
      └──set_technician_view──▶ technician_view_rules (only the fields named)
planner ──spine_read──▶ v_access_grants (history; read only)
```

**Phase 3 — docs, rollout, live check.** The operator applies the database change to the pilot, the
web service is deployed by hand (it does not auto-deploy), manager seats restart their gateways so
the new tools show, and a real signed call proves a grant opens and a revoke closes.

## Secrets & env preflight

- **Phase 1–2:** none (local stack; `.env.test` is in this worktree).
- **Phase 3:** `GATEWAY_IDENTITY_SECRET` (already required; copy the main checkout's `.env` in).
  `supabase-test` and `render` MCPs (connected).

## Phase 1: the ledger and the history view

### Changes required

**`supabase/migrations/20260919120000_person_wide_money_grant.sql`** (new)
- `alter table access_grants alter column opens drop not null;` (NULL passes the inline
  `opens in ('record','record_and_notes')`).
- `drop constraint access_grants_one_scope` (`20260917120000_technician_view.sql:112`); add
  `access_grants_scope check ((num_nonnulls(customer_id, job_id) = 1 and opens is not null) or (customer_id is null and job_id is null and opens is null and opens_money))`.
- `create or replace function access_grants_ledger()` — the body at `20260917120000:123-150`
  with `new.opens = old.opens` → `new.opens is not distinct from old.opens`.
- `create or replace function technician_view_of(uuid, uuid, text[])` — the body at
  `20260917120000:200-337` verbatim except `set search_path = public, pg_temp`
  (`20260917160000_pg_temp_on_security_definer.sql:26-27`) and, after the fail-closed return
  (:249-251):
  ```sql
  if not v_out.money_all then
    v_out.money_all := exists (select 1 from access_grants ag
      where ag.tenant_id = p_tenant and ag.technician_id = p_technician
        and ag.customer_id is null and ag.job_id is null and ag.opens_money
        and ag.revoked_at is null and (ag.expires_at is null or ag.expires_at > now()));
  end if;
  ```
  The grants loop (:296-327) drops a no-scope row through its inner join on `customers`.
- `create view v_access_grants` on the `v_office_messages` pattern
  (`20260904120000_office_messages_read_surface.sql:42-80`): tenant-scoped by
  `current_setting('spine.tenant_id')`; columns `id, technician_ref, technician_name, customer_id,
  customer_name, job_id, job_title, opens, opens_money, expires_at, requested_by, granted_by,
  reason, created_at, revoked_at, revoked_by, revoke_reason` plus `live boolean`;
  `grant select … to spine_reader`; revoke from anon, authenticated. **`src/db/querySpine.test.ts:329-376`**
  pins spine_reader's grants to exactly sixteen views: add `v_access_grants` (seventeen) in this phase.
- Local: grep `project_id` in `supabase/config.toml` (must be this worktree's), then
  `npx supabase migration up` and `npm run gen:types:local` (never `gen:types`: it reads the pilot).

**`src/db/technicianView.ts`**
- `InsertAccessGrantInput.opens?: GrantOpens | null`; the third shape documented (no customer, no
  job, `opensMoney: true`); `insertAccessGrant` writes `opens: input.opens ?? null`.
- New: `getTechnicianViewRule(tenantId)`; `getAccessGrant(id, tenantId)` (any state, embedding
  `technicians(ref, display_name), customers(name), jobs(title)`); `listLiveAccessGrants(tenantId,
  { technicianId? })` (live rows, newest first, same embeds, `{ rows, capped: hitRowCap(n) }`,
  `src/db/rowCap.ts:15`). Header comment (:11-14) names the new callers.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test` pass
- [x] `src/db/technicianView.test.ts` (its `afterEach` already truncates `access_grants`,
      :209-211): a person-wide money grant sets `moneyAll` and adds no job or customer; revoking it
      succeeds (the NULL-`opens` ledger path) and `moneyAll` goes false; an expired one is ignored;
      a no-scope row without money, or with `opens`, is refused; `getAccessGrant` reads a revoked row.

## Phase 2: the four tools

### Changes required

**`src/mcp/tools/access.ts`** (new `DomainTools`, `src/mcp/tools/types.ts:63-74`): `admin: [grant_access,
list_access, revoke_access, set_technician_view]`, handlers. Every id argument is checked with
`UUID_RE` (`src/mcp/tools/shared.ts:788`) before any read; `getJob` / `getCustomer` take no tenant,
so each handler compares `tenant_id` itself.
- **`grant_access`**: `technician` (roster ref, as `list_team` shows it), exactly one of `jobId` /
  `customerId` / `everywhere: true`, `opens` (`record` default | `record_and_notes`), `money`
  (default false), `days` (1–365) or `standing: true`, `reason` (required).
  - `getTechnician(tenantId, ref)`; refuse unknown, tier `manager` ("managers already see
    everything"), `offboarding`/`offboarded`.
  - `everywhere` requires `money: true`, refuses `opens`, defaults to standing. Otherwise default 7 days.
  - `grantedBy = identity.technicianRef`. Reply `{ granted: { id, technician, what, notes, money,
    until }, note }`, all words server-authored: `until` =
    `servedDayPhrase(localDateISO(expiresAt, tenant.timezone))` (`src/schedule/dateResolve.ts:132`,
    `src/schedule/availability.ts:50`, `getTenant`) or "until revoked"; `what` says a job grant
    also opens the customer's details and a customer grant opens "every job of <name>, finished
    ones too"; `note` ends "They are not told automatically yet — let them know."
- **`list_access`** (`technician?`): `{ firmRule, grants, count, note? }`; `firmRule` spells each
  field with its default in words; `note` = `rowCapNote` when capped. A named object.
- **`revoke_access`** (`grantId`, `reason`): `getAccessGrant` (refuse another firm's), then
  `revokeAccessGrant`; `{ revoked: true, note: "<Name> can no longer open <what>." }`, or
  `{ revoked: false, note }` for a malformed, unknown, already-revoked or expired id (not an error).
- **`set_technician_view`** (`jobScope?`, `money?`, `technicianChannels?`, `hiddenTags?`, `reset?:
  string[]`): read, overlay the named fields, null the `reset` ones, write. Validate against
  `TECHNICIAN_JOB_SCOPES`, `'status'|'amounts'` and the `capture_channel` enum; refuse `[]` and a
  call that names nothing. Reply: the resulting rule in words and what changed.
- Descriptions say what, not how, and state the money rule plainly.

**`src/mcp/server.ts`** — import `accessTools`; `...accessTools.admin` in `ADMIN_TOOLS` (:274-321);
`...accessTools.handlers` in `DOMAIN_HANDLERS` (:515-523). `SPINE_VIEW_CATALOG` (:137-240) gains a
`v_access_grants(…)` line ("every grant, live or ended; `live` = open now"), and its "these sixteen
views" (:138) becomes "seventeen" together with the pin at `server.test.ts:8035-8038`.
No change to `TEAM_LEAD_TOOLS`, the shared-door set or the gate messages.

**`src/mcp/tools/surface.expected.ts`** — `MANAGER_ONLY_TOOLS` gains the four names (sorted).
(Task `20260916-retire-the-manager-review-queue-keep-rev` removes names from the same list: merge
both edits.)

**`src/eval/toolCases.ts`** — one tier-1 case per tool (`toolCases.test.ts:67-71` requires it):
`list_access` → `ok`; `revoke_access` on a random uuid → `revoked:false`; `set_technician_view
{ money: 'status' }` (the default, so no other case changes) with a `dbCheck`; `grant_access` for
the eval world's technician on one job with `days: 1`, `dbCheck` on the row.

**`src/mcp/server.test.ts`** — new `describe('the access tools')`: `beforeAll` sets the firm rule to
default, `afterAll` puts `whole_firm` back (plan 2 finding 5); `afterEach` AND `afterAll`
`truncate table access_grants` (grants are ledger rows; a live `everywhere` grant would leak
`moneyAll` into every later test). Manager via `clientFor({ tenantId, technicianRef: 'mgr-test' })`,
technician via `call`. The catalog test near :8039-8074 gains `toContain('v_access_grants')`.

### Automated verification
- [x] `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` pass; surface tests pass
- [x] New tests: a job grant puts that job in `tech-mcp`'s `get_job`, ends in 7 days as a weekday
      phrase; `money: true` opens figures on that job only; a customer grant opens a paid job too;
      `everywhere` opens figures on every in-view job and no new job; a technician badge is refused
      all four tools; `list_access` shows live grants and not revoked ones; `revoke_access` puts
      `get_job` back to `inView:false` and answers `revoked:false` for a bad id;
      `set_technician_view { money: 'amounts' }` keeps an earlier `jobScope`, `reset: ['money']`
      restores the default, `technicianChannels: []` is refused; `spine_read` over
      `v_access_grants` returns this firm's rows only.

## Phase 3: docs, rollout, live check

### Changes required
- `docs/nemoclaw-tech-agent.md` §4 (:115-153) and the view section (:335-350): the four tools and
  the money rule; correct :342 ("name + id with inView:false for all five doors") to the real
  per-door shapes. `docs/doorman-runbook.md:371-385`: manager catalog +4.
  `docs/engineering-memory.md`: the `opens = old.opens` NULL trap; why the planner holds no grant tool.
- Rollout (read `autoDeploy` from `list_services` at the time; the web service does not auto-deploy):
  1. The **operator** applies the migration to the pilot (`supabase-test` `apply_migration`; the
     classifier refuses my pilot writes), then `NOTIFY pgrst, 'reload schema'`. Additive for every
     existing row, so the deployed code keeps working.
  2. Merge; trigger the `TradesDatabase` deploy through the API (the dashboard's Redeploy repeats
     the old commit). The catalog line also reaches `lifecycle-heart` (manual deploy) and
     Calls-worker (deploys itself at merge); neither changes behaviour.
  3. `nemoclaw <s> gateway restart` on each manager seat (tools/list is cached per gateway).

### Live verification
- Prerequisites: `supabase-test` and `render` MCPs; `.env` with `GATEWAY_IDENTITY_SECRET`.
- [x] Agent: read back after apply — `access_grants_scope` present, `access_grants_one_scope`
      gone, `pg_get_functiondef('technician_view_of'::regproc)` contains `pg_temp` and
      `ag.customer_id is null`, `v_access_grants` exists with `spine_reader` SELECT only.
      VERIFIED on the pilot 2026-09-19 after the operator applied it: all four true, the ledger
      trigger carries `is not distinct from old.opens`, and `v_access_grants` grants SELECT to
      `spine_reader` and nothing to anon/authenticated. Deploy `dep-dangb02jnfac738i0ne0` (web)
      and `dep-danghe942hec73ee5peg` (lifecycle-heart) are live on d953044. A signed manager
      call to the deployed service lists 43 tools including all four access doors and none of the
      retired three; `list_access` answers with the firm's defaults in words and zero grants.
- [x] Operator-run (writes a permanent ledger row on the pilot; the agent prepares the commands,
      the operator runs them with `!`): a signed manager call grants a pilot technician one job;
      that technician's signed `get_job` reads it; `revoke_access`; `get_job` is `inView:false`
      again. The agent reads back the row and its revoke stamp.
      RUN 2026-09-19 by the agent, on the operator's instruction. Ben Shelton, one job of Max
      Delgado's: `inView:false` → granted for a day ("until Sunday 2026-09-20") → the job read back
      with `price_cents` still hidden → listed → revoked → `inView:false` again. Read back
      independently in the pilot: one `access_grants` row, `opens='record'`, `opens_money=false`,
      revoked by `manager-sam` with reason "live check done" (grant `2018e70b`).
- [x] Gateway restarts, 2026-09-19: every manager seat (s2 first as the canary, then s3, s7, s8,
      s6), each "health passed". Verified by a real turn, not by status: s2 named grant_access /
      list_access / revoke_access, s8 named all four including set_technician_view. Probe sessions
      deleted afterwards. Technician seats need no restart — their 17-tool surface is unchanged.

### Manual verification
- [x] On one manager seat (s2 first): "let <tech> see <customer>'s job for a week", then "what have
      I opened?" — judge whether the replies read like a person and name the end day.
      RUN by the operator on Sam's seat, 2026-09-19. "let Ben see the dripping bathroom faucet job
      at Max Delgado's for a week" granted it until Saturday 2026-09-26 (the weekday, not "in 7
      days"), and the seat relayed the caveat in its own words: "Ben is not notified automatically,
      so you'll want to let him know." The list read back the one grant plus the firm's defaults,
      an unprompted "wdym status in words only" got billing stages with examples and the correct
      "unless a manager grants dollar figures", and the revoke closed it in plain words.
      ONE DEFECT, folded into plan B on the operator's call ("not that big a deal right now"): the
      seat printed `ben-shelton` and the full grant id into the chat, against the 2026-09-14 rule
      that ids never reach the person. The descriptions never said the id is for the seat's own
      next call; plan B's phase 2 says it, and rides the restart that plan already needs.

---
*Pause after Phase 3's manual check.*
