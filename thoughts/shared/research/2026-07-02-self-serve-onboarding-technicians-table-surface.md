---
date: 2026-07-02
branch: composio-per-person-phases-1-4
commit: 1580191
topic: Self-serve onboarding + technicians table — every surface that constitutes technician identity today (ref storage, minting, matching, badges, sandbox provisioning, Composio pairing) and the current manual onboarding/offboarding procedures
---

## Summary

This documents the as-is state of everything a self-serve onboarding cycle (firm → person →
connector) and a `technicians` table would touch. Today there is **no technicians table and no
firm-level configuration beyond a 3-column `tenants` table** (`id`, `name`, `created_at`). A
technician "exists" only as a **free-text ref string that must appear byte-identically in four
independent places**: the Composio composite `user_id` (`"<tenantUuid>:<technicianRef>"`), the
doorman badge file on each host (`/etc/doorman/badges.json`), the manager's schedule sheet
(mirrored to `schedule_entries.technician_ref`), and — as of the current branch — the L1/drop
attribution columns (`raw_captures.technician_ref`, `dropped_audit.technician_ref`) plus
`visits.technician_name`. Nothing enforces the byte-equality contract or per-tenant ref
uniqueness; the only guards are procedural (§7 pairing rules in `docs/nemoclaw-tech-agent.md`)
and one interim script guard (`composio-reconnect.mjs` refuses an already-paired ref without
`--replace`). Onboarding today is a fully manual, multi-host procedure (manual tenant insert →
`openssl rand` badge + hand-edit of badges.json → `nemoclaw onboard` sandbox provisioning →
two dev scripts + a human OAuth consent for Gmail pairing → manager sheet column). Offboarding
exists only as scattered fragments: instant badge revocation via a `"revoked": true` flag,
Composio connected-account/trigger deletion via SDK calls (exercised manually in the Phase 4
E2E cleanup), and no `active` flag, no cascade, no documented decommission procedure.

## Entry Points

- `src/inbound/webhook.ts:109` — `handleInboundWebhook()`: where a person's identity enters from
  Composio. Composite `user_id` split on the first colon at `webhook.ts:155-157`; validation at
  `:158-167`; attribution resolution (`personRef ?? 'connector:<toolkit>'`) at `:171`.
- `Box Setup Stuff/doorman.mjs:20` — the doorman HTTP server: where a person's identity enters
  from a sandbox agent (badge → signed `x-tenant-id`/`x-technician-ref` headers).
- `src/mcp/identity.ts:41-63` — `resolveIdentityFromHeaders()`: where the central HTTP MCP server
  verifies the doorman's signed identity; `identityFromEnv()` (`:21-27`) pins the stdio server to
  `DEFAULT_TENANT_ID`/`DEFAULT_TECHNICIAN_REF`.
- `src/schedule/sheetSync.ts` — `syncScheduleFromSheet()`: where a person's identity enters from
  the manager's Google Sheet (technician column → `schedule_entries.technician_ref`, verbatim).
- `scripts/composio-reconnect.mjs:82` / `scripts/composio-trigger.mjs:49` — the only tooling that
  mints a person's Composio pairing today (`connectedAccounts.link()` / `triggers.create()`).
- `docs/doorman-runbook.md` + `Box Setup Stuff/doorman-nemoclaw-setup-guide.md` — the manual
  onboarding runbooks (badge issuance, sandbox provisioning, per-agent wiring).

## Key Files

### Identity storage (schema)

| File | Role |
|---|---|
| `supabase/migrations/20260620005307_context_spine.sql` | `tenants` (`:35-39` — 3 columns: id/name/created_at, no tier/manager/plan fields; seeds `'Default Tenant'` at `:136`); `visits.technician_name text` (`:79` — nullable free text, receives whatever `technicianRef` string arrives); `raw_captures` (`:92-104`, append-only via trigger `:117-119`) |
| `supabase/migrations/20260620013000_schedule_entries.sql` | `schedule_entries.technician_ref text not null` (`:9`), indexed (`:30`) — free text, no FK |
| `supabase/migrations/20260701231454_raw_capture_technician_ref.sql` | Adds nullable `raw_captures.technician_ref` — "Nullable: raw_captures is append-only (no UPDATE path), so pre-existing rows cannot be backfilled and stay NULL" |
| `supabase/migrations/20260701235400_dropped_audit_technician_ref.sql` | Adds nullable `dropped_audit.technician_ref` — needed because "external_id alone no longer identifies WHICH mailbox to re-fetch a misclassified message from (Gmail message ids are mailbox-local)" |
| `supabase/migrations/20260629001515_dropped_audit_and_indexes.sql` | `dropped_audit` (`:11-20`) — mutable/purgeable, content-free (sender domain only) |

### Identity code (typed DB layer + write-path)

| File | Role |
|---|---|
| `src/db/tenants.ts:8-16` | `tenantExists(tenantId)` — the only tenant read; exact `eq('id', …)`. No tenant-create function exists in `src/` |
| `src/db/rawCaptures.ts:7-23` | `AppendRawCaptureInput.technicianRef?: string \| null` ("badge-mapped ref or `connector:<toolkit>`"); written at `:36`. No read filters by technician |
| `src/db/droppedAudit.ts:4-17` | `DroppedAuditInput.technicianRef?` ("WHICH mailbox the message arrived in"); written at `:39` |
| `src/db/scheduleEntries.ts` | `upsertScheduleEntry` (`:27-56`, `technicianRef` required); `listScheduleForTechnicianOnDate(tenantId, technicianRef, isoDate)` (`:61-77`, `.eq('technician_ref', …)` at `:71`) |
| `src/db/visits.ts:9,24` | `CreateVisitInput.technicianName?` → `visits.technician_name` |
| `src/writePath/recordFieldNote.ts` | `technicianRef: string` required (`:23-39`); flows to `appendRawCapture` (`:104`) and `technicianName: technicianRef` on the visit (`:191`) |
| `src/writePath/identityMatch.ts:12-14,67` | `technicianRef` used only for the schedule lookup — the schedule-assisted branch is dead for any ref not byte-equal to the sheet's column |
| `src/mcp/identity.ts` | `RequestIdentity {tenantId, technicianRef, scopes?}`; HMAC payload `"<tenantId>.<technicianRef>"` (hex, `GATEWAY_IDENTITY_SECRET`); no timestamp/nonce |
| `src/inbound/webhook.ts` | Composite parsing + validation + attribution (see Entry Points); status codes at `:76-90` |
| `src/schedule/sheetSync.ts` | `ScheduleRow.technicianRef` read from any header column containing "technician" (case-insensitive substring), verbatim, no validation against any roster |

### Onboarding/offboarding tooling and runbooks

| File | Role |
|---|---|
| `scripts/composio-reconnect.mjs` | Per-person Gmail pairing. Fail-closed arg parsing (`:22-40`: unrecognized args abort; uuid + composite shape check; `connector:` refs rejected). **Same-ref guard** (`:57-73`): existing Gmail connection under the ref → abort without `--replace` ("Different person? Pick a different technicianRef — this ref is taken"). Replace path deletes old connections (`:76-79`) then `connectedAccounts.link(TENANT, 'ac_5CdPk4l3GV2V')` (`:82`) |
| `scripts/composio-trigger.mjs` | Per-person trigger creation: `triggers.create(USER_ID, 'GMAIL_NEW_GMAIL_MESSAGE', {triggerConfig: {interval: 1, labelIds: 'INBOX', userId: 'me'}})` (`:49-55`). Same shape check (`:18-30`). Not idempotent (`--create` twice errors). SDK-only — the dashboard cannot create this trigger (`:2`) |
| `scripts/seed.mjs` | Live ref vocabulary in test data: `'office-dispatch'` (`:72`), `'tech-jane'` (`:106`, `:155`), `'connector:web'` (`:130`), `'connector:gmail'` (`:174`). Assumes the tenant already exists (`:45`) — does not create one |
| `Box Setup Stuff/doorman.mjs` | 47-line badge→identity translator. Badge file re-read per request (revocation is instant); entry = `{tenantId, technicianRef, revoked}`; forwards signed headers, never the badge |
| `docs/doorman-runbook.md` | Badge issuance: `openssl rand -hex 32` (`:192`) + hand-edit `/etc/doorman/badges.json` (`:193-197`, mode 600); revocation: set `"revoked": true`, instant, no restart (`:299-302`) |
| `Box Setup Stuff/doorman-nemoclaw-setup-guide.md` | The full per-person sandbox onboarding: brev box create (`:32-38`) → Docker/NemoClaw install (`:44-60`) → doorman deploy (`:66-232`) → `nemoclaw onboard` (`:282-293`) → egress policy + badge-as-provider-credential (`openshell provider update <AGENT>-telegram-bridge --credential TRADES_SPINE_BADGE=<badge>`, `:356-364`) + MCP config (`:368-389`) → bake-in (4 NemoClaw source edits, `:406-520`) → reboot resilience (`:526-570`) |
| `Box Setup Stuff/doorman-architecture-memory.md` | Portable operator reference for the above |
| `docs/nemoclaw-tech-agent.md` §7 (`:129-175`) | The vocabulary contract + pairing rules (see Constraints below); "Onboarding company #N = send a Connect Link" (`:160-162`); explicit deferral: "Nothing in the DB enforces this yet (no technicians table; that belongs to the future self-serve-onboarding cycle)" (`:151-153`) |
| `.env.example` | `DEFAULT_TENANT_ID`/`DEFAULT_TECHNICIAN_REF` (`:30-32`); `COMPOSIO_WEBHOOK_SECRET` semantics incl. SDK-only webhook subscription (`:46-54`); `COMPOSIO_API_KEY` custody rule — control-plane secret, never in a sandbox (`:56-59`) |

### Prior art (this cycle's inputs)

- `thoughts/shared/research/2026-07-01-composio-identity-pairing-model.md` — pre-branch identity
  survey (note: its "L1 carries no person attribution" and "`tenantId = userId` verbatim" findings
  are superseded by the current branch).
- `thoughts/shared/plans/2026-07-01-per-person-composio-identity.md` — the completed 4-phase plan,
  including Phase 4 live E2E evidence (two people, cross-mailbox isolation held, CC → two captures
  with distinct `external_id`s, per-person attribution verified in the test DB 2026-07-02).

## Data Flows

### Flow 1 — Inbound email (Composio → person-attributed L1/L2)

1. Composio POSTs the trigger envelope; HMAC-verified (`COMPOSIO_WEBHOOK_SECRET`, Standard-Webhooks
   shape) at `webhook.ts:116`.
2. `user_id` split on the **first** colon (`webhook.ts:155-157`): bare uuid → legacy whole-business
   pairing (`personRef = undefined`); composite → `{tenantId, personRef}` (ref may itself contain
   colons, e.g. `crew:alice`).
3. Rejections: empty half → `bad_payload` (`:158`); ref starting with reserved `connector:` →
   `bad_payload` (`:162`); non-uuid tenant → `unknown_tenant` without retry (`:167`, guards the
   22P02 retry storm); unprovisioned tenant → `unknown_tenant` via `tenantExists` (`:182`).
4. `technicianRef = personRef ?? 'connector:<toolkit lowercase>'` (`:171`) — one variable feeds
   everything the delivery writes.
5. Non-work mail → `recordDrop({tenantId, …, technicianRef})` (`:198-205`) — drop receipts are now
   mailbox-attributed. Work mail → `recordFieldNote({tenantId, technicianRef, …})` (`:210-221`) →
   `raw_captures.technician_ref` (L1, permanent) and `visits.technician_name` (L2).

### Flow 2 — MCP tool call (badge → signed headers → tools)

1. Sandbox agent sends `Authorization: Bearer <badge>` to the doorman; badge looked up in
   `/etc/doorman/badges.json` (re-read per request → instant revocation), rejected if unknown or
   `revoked` (`doorman.mjs:22-24`).
2. Doorman injects `x-tenant-id`, `x-technician-ref`, `x-identity-signature =
   HMAC-SHA256(GATEWAY_IDENTITY_SECRET, "<tenantId>.<technicianRef>")` and forwards
   (`doorman.mjs:34-37`); the badge itself never crosses to the MCP server.
3. `resolveIdentityFromHeaders()` recomputes and timing-safe-compares the HMAC
   (`identity.ts:54-58`); identity is injected as a server dependency, never read from tool args.
4. `recordFieldNote` receives `identity.technicianRef` → same L1/L2 attribution as Flow 1.

### Flow 3 — Schedule sheet → schedule-assisted matching

1. Manager edits the Google Sheet; `sheetSync.ts` reads the first worksheet, finds the technician
   column by header substring, and upserts rows verbatim into `schedule_entries`
   (`external_row_key` = sheet row number, so edits update in place).
2. `matchIdentity` calls `listScheduleForTechnicianOnDate(tenantId, technicianRef, capturedAt)`
   (`identityMatch.ts:67`) with an **exact, case-sensitive** `eq` on `technician_ref`
   (`scheduleEntries.ts:71`). A sheet typo or ref mismatch silently disables schedule-assisted
   matching for that person — no error surfaces anywhere.

### Flow 4 — Onboarding a person today (manual, end to end)

Firm level: insert a `tenants` row by hand (the only seeded one is `'Default Tenant'` from the
migration; `seed.mjs` assumes it exists). No manager account, no tier — those concepts exist only
as prose in `nemoclaw-tech-agent.md` (§4 tool allowlist per tier; §7 "per-tier gateway allowlist"
marked as not built).

Person level, in order, per the runbooks:
1. Mint a ref (procedural rule: full-name slug or employee id, never bare first names —
   `nemoclaw-tech-agent.md:149-153`).
2. Badge: `openssl rand -hex 32`, hand-edit `/etc/doorman/badges.json` on the host with
   `{tenantId, technicianRef, revoked:false}` (`doorman-runbook.md:192-202`).
3. Sandbox: `nemoclaw onboard` + egress policy + badge registered as an OpenShell provider
   credential + MCP config/bake-in (`doorman-nemoclaw-setup-guide.md:282-520`).
4. Composio pairing: `composio-reconnect.mjs user=<tenant>:<ref>` → human approves OAuth consent →
   `--wait` to confirm ACTIVE → `composio-trigger.mjs user=<tenant>:<ref> --create`.
5. Schedule: the manager's sheet must use the same ref string in its technician column.

### Flow 5 — Offboarding today (fragments only)

- Badge: set `"revoked": true` in badges.json — instant, no restart (`doorman-runbook.md:299-302`).
  File-per-host: revoking means touching every host that has a badge for the person.
- Composio: `connectedAccounts.delete(id)` exists in the reconnect script's replace path
  (`composio-reconnect.mjs:76-79`); trigger deletion has **no script surface** — the Phase 4
  cleanup deleted triggers/accounts via ad-hoc SDK calls (plan `:250-252`).
- Sandbox deactivation: not documented anywhere.
- No `active` flag exists on any table; no cascade or cleanup of captures/visits/schedule rows
  (and none is possible for L1 — append-only). History stays attributed via the permanent
  `technician_ref` strings.

## External Dependencies

- **Composio** (`@composio/core ^0.13.1`, devDependency only; never imported in `src/`):
  `connectedAccounts.link()/list()/delete()`, `triggers.create()/getType()`,
  `triggers.setWebhookSubscription()` (webhook endpoint is SDK-only config, one subscription
  `ws_mfL3RD8klzYo`, no dashboard page — `.env.example:49-50`, plan `:280-286`). Auth config
  `gmail-test` (`ac_5CdPk4l3GV2V`), Composio-Managed, 11 scopes incl. `https://mail.google.com/`.
  Docs cited in §7: [Authentication](https://docs.composio.dev/docs/authentication),
  [Managed vs custom auth](https://docs.composio.dev/docs/custom-app-vs-managed-app),
  [Connected Accounts](https://docs.composio.dev/docs/auth-configuration/connected-accounts).
- **Supabase**: all identity-bearing tables. `COMPOSIO_API_KEY` and `GATEWAY_IDENTITY_SECRET` are
  control-plane secrets (custody rules in `.env.example`).
- **Doorman / OpenShell / NemoClaw / Brev**: host-side stack, entirely outside `src/` — badge file,
  provider credentials, sandbox lifecycle (`Box Setup Stuff/`).
- **Google Sheets API** (`googleapis`): schedule sheet read (`SCHEDULE_SHEET_ID` +
  `GOOGLE_APPLICATION_CREDENTIALS`).
- **Anthropic**: work/personal classifier — identity-agnostic.

## Constraints and Invariants

1. **The vocabulary contract is unenforced.** `technicianRef` must byte-equal (case-sensitive)
   across Composio composite `user_id`, doorman badge, and schedule sheet column
   (`nemoclaw-tech-agent.md:139-153`). Violation modes are silent: schedule matching goes dead
   (Flow 3); L1↔badge joins fail. No table, FK, or check constraint backs any of it — refs are
   free text in `schedule_entries` (not null), `raw_captures`/`dropped_audit` (nullable), and
   `visits.technician_name`.
2. **Per-tenant ref uniqueness is procedural only.** Two people minted as `<tenant>:jane` would
   merge both inboxes into one identity permanently (L1 append-only). Guards: §7 rule (4) (mint
   from full-name slugs/employee ids) + the reconnect script's same-ref `--replace` guard — which
   only fires if the operator uses that script and the ref already has a *Gmail connection* (it
   checks Composio state, not any roster).
3. **L1 attribution is permanent and first-writer-wins.** Append-only `raw_captures`; the
   orphan-heal path reuses the existing row, so its `technician_ref` is whatever the first
   delivery wrote (plan `:23-25`). One pairing per mailbox (§7 rule 1): during bare-uuid →
   composite migration the legacy pairing must be deleted first or whichever delivery lands first
   stamps the ref.
4. **`connector:` is a reserved namespace.** The webhook rejects composite refs starting with it
   (`webhook.ts:159-162`); it is the fallback attribution for bare-uuid pairings and
   non-person channels (`connector:gmail`, `connector:web` in seed data).
5. **Bare-uuid `user_id`s remain valid** (legacy whole-business pairing) — any onboarding design
   inherits a two-mode webhook.
6. **Dedup is per-tenant, not per-person**: `(tenant_id, external_id)` unique. Holds for Gmail
   because message ids are mailbox-local (E2E-verified: CC → two captures, distinct ids). A future
   connector whose external ids are *not* recipient-local would collide across people within a
   tenant.
7. **Badge trust root**: HMAC payload is only `"<tenantId>.<technicianRef>"` — no
   timestamp/nonce/expiry. Badge lifecycle is a hand-edited root-owned file per host; issuance and
   revocation are not scripted.
8. **Trigger/pairing provisioning is not idempotent and not inventoried.** `triggers.create` twice
   errors; nothing lists which refs have triggers; no repo record maps person → connected account
   id → trigger id (Phase 4's ids live only in the plan's run notes).
9. **Tenant provisioning is out-of-band.** `tenantExists` is the only tenant code path; creating a
   tenant means a manual insert. The webhook treats an unknown tenant as deterministic rejection
   (422, mail not retried) — a misprovisioned tenant loses mail silently except for the status code
   returned to Composio.
10. **Per-person capability control is designed to live at the gateway** (doorman badge → future
    per-tier tool allowlist), not in Composio — its Execution Allowlist is the global ceiling
    shared by all tenants/people (§7, decided 2026-07-01). The per-tier gateway allowlist is an
    accepted interim gap (§ Scopes: "any agent holding a tenant's Tool Router `mcp.url` can both
    read the full mailbox and (if the ceiling permits) send").
11. **`visits.technician_name` stores refs, not display names** — every writer passes
    `technicianRef` verbatim (`recordFieldNote.ts:191`). No display-name concept exists anywhere.
12. **No TODO/FIXME markers** for technicians/onboarding/offboarding exist in code; the only
    recorded deferral is the §7 prose (`nemoclaw-tech-agent.md:151-153`).

## Open Questions

1. **Composio `user_id` constraints** (carried from 2026-07-01 research, still open): whether
   Composio imposes length/charset limits that would constrain ref minting for composite ids —
   unverified against their API docs.
2. **Envelope `connected_account_id`** (research open question #2, explicitly still open — Phase 4
   didn't capture a raw envelope because `INBOUND_DEBUG` wasn't enabled on the deployed service):
   whether the trigger metadata identifies the source connected account independently of `user_id`.
3. **Connect Link lifecycle**: §7 says "Onboarding company #N = send a Connect Link", but nothing
   records how long a `link()` redirect URL stays valid, whether it is single-use, or how to track
   pending/completed links — no code or doc covers it.
4. **Trigger inventory/removal surface**: how to list and delete a person's triggers and connected
   accounts programmatically (offboarding) — `triggers.delete`/list usage exists nowhere in the
   repo; Phase 4 cleanup was ad-hoc.
5. **Execution Allowlist semantics** (flagged ⚠ in §7): whether it blocks execution or only hides
   tools from discovery — unverified against Composio docs.
6. **Fate of the legacy June pairing** `ca_HfiWAMe4IZkZ` (bare-uuid, left undeleted "for the user
   to decide", plan `:252`) — while it exists, the one-pairing-per-mailbox rule is violated for
   that mailbox if a composite pairing is ever added for the same account.
   **RESOLVED (addendum, 2026-07-02 same-day):** verified live — `connectedAccounts.list` under
   the bare tenant `user_id` returns 0 Gmail connections and `triggers.listActive({})` returns 0
   instances project-wide. The pairing and all triggers are already deleted; the plan run-note
   was stale.
7. **Multi-host badge state**: badges.json is per host; how many hosts exist and whether badge
   state can diverge across them is not recorded in the repo (one documented box:
   `nemoclaw-box` via brev).
8. **Deferred live checks**: the Phase 3 (NemoClaw/Telegram chat channel) and §Live-verification
   connector-isolation checks in `nemoclaw-tech-agent.md:257-267` have not been run — the agent
   stack is still to-be-provisioned (doc header note, `:8-10`).
