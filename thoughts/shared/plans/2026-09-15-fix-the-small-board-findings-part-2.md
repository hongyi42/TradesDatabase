---
date: 2026-09-15
task: small board findings part 2 — unschedule confirm re-check, desk answers not citable, seat-add row leak, drifted text, phone match key, tool-search guard on the boxes
research: thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md
status: complete
supersedes: nothing
---

## Overview

Items (5)–(10) the operator added to task 20260914-fix-the-small-board-findings-listjobsfor on
2026-09-15 (task record, "Added by the operator"), from the research doc's Findings 1, 2, 10, 13,
14 and 17. They land as their OWN PR, after #243 (operator, 2026-09-15). Every line number below
was re-verified on main bf9d5ea (includes #242 and #243).

## Decisions

- **Separate PR from #243 (user, 2026-09-15).**
- **(9) Phones: a computed match key, not a rewrite (user, 2026-09-15, option A)** — options: (A)
  a Postgres generated column `phone_key` + compare on it, stored phone kept as given; (B)
  normalise to E.164 on every write + a one-off data rewrite of `customers.phone`. Chosen A: no
  customer data rewritten, existing rows keyed automatically, agent-facing phone text unchanged.
  Cost accepted: the digit rule exists in SQL and TypeScript, pinned by a parity test. A number
  stored without an area code keys as its 7 digits and matches only other 7-digit spellings;
  guessing an area code could attach a caller to the wrong customer.
- **Test-suite phones are disposable (user, 2026-09-15)** — no fixture phone is worth keeping;
  the implementer may rewrite any fixture to a realistic 10-digit number where a test needs it.
- **(10)+(8, AGENTS.md) roll out to the boxes in THIS task (user, 2026-09-15, option A)** — s2
  first, then the other five; the operator's go is asked before touching trades-box-1.
- **(6) The view route, settled by the schema** — a `to_agent` desk row violates the CHECK requiring a
  technician_id (20260901150000:55-56) and desk.ts would drop the answer; so the view filters
  `kind is distinct from 'desk'`.
- **(5) Compare starts_at AND ends_at** (a crew change is not what is cancelled); a pre-deploy token
  without `detail.expected` is refused (fail closed). The snapshot is wall-clock, never raw.
- **(5) Board/console cancel buttons left out** — same race, but preview and confirm are one dialog
  seconds apart with the card on screen (web/board/board.js:1634-1650, web/console/app.js).
- **(7) An allowlist projection keeping snake_case** — tests read `id`/`seat_exempt`; a column
  added later stays hidden by default.
- **AGENTS.md rule 8 wording** — states the facts: get_connect_link connects Gmail only (manager
  tier); a manager's seat connects other accounts through Composio's own connection tool
  (`manageConnections: true`, src/composio/sessions.ts:33-34); a technician's seat cannot connect
  accounts. (Corrected at the Phase 4 review from "cannot be connected yet", untrue for managers.)
- **Migrations applied to the pilot BEFORE merge** — the Calls-worker auto-deploys at merge and
  runs `matchIdentity` → `findCustomersByPhone` (memory deploy-does-not-migrate). Never `db push`.

- **Added at the final code review (user, 2026-09-15):** (1) `cancel_job` gets the same fix — the
  stage snapshots the job's live visits (wall-clock), the yes refuses if that set changed, and
  cancelJob's cascade is a per-visit compare-and-set; (2) `v_customers` exposes `phone_key` to the
  planner (migration 20260916130200 + catalog line), `find_customer` strips it, and the retrieval
  task is noted to project it out of `customer_contents`; (3) an 11-digit number starting with 1
  is read as US +1 — known limit, accepted. The unschedule check also became a compare-and-set
  (`expectedTimes` on unscheduleVisit / updateVisitStatus).

## Plain-language walkthrough

**Phase 1: two confirm fixes.** Cancelling a booked visit is two-step: preview, then "yes". Today
the "yes" cancels whatever the visit is NOW, so if someone moved it to Thursday between preview
and yes, the manager approved cancelling Tuesday and loses Thursday. The yes now checks the time
still matches and asks to restage if not. Separately, adding a technician seat returns the new
row into the AI's context, including credential columns; it returns only safe fields now.

**Phase 2: the planner stops quoting itself; text stops lying.** The planner may close gaps only
by citing evidence. Its "desk" (a helper that answers seats in the planner's name) writes answers
into a table the evidence view shows, so the planner could cite its own words as proof. One view
change removes them. Five tool and prompt texts that describe things the code no longer does are
corrected ("sixteen views" when there are eighteen, a "customer promise" field that was deleted).

**Phase 3: one number, one match.** `(206) 555-0170`, `206-555-0170` and a phone call's
`+12065550170` are three strangers to the matcher today. The database computes a match key (the
digits, minus a leading US 1) for every customer, and lookups compare keys.

```
stored "(206) 555-0170" ─► phone_key 2065550170 ◄─ phoneKey("+12065550170") ◄─ Twilio caller
```

**Phase 4: the seat boxes.** OpenClaw (the agent runtime on each seat) switches "tool search" on
by itself when its setting is missing, which hides every spine tool; a rebuild erases the setting.
Wiring a seat now reads the setting back and stops loudly if it is not `false`, and the health
check reports it. The same rollout fixes the seat instructions that send Sheets/Excel/Drive to a
Gmail-only link.

## Secrets & env preflight

- **Phases 1–3:** this worktree's `.env.test` and local stack (#242's migration applied); no `.env` keys.
- **Pre-merge (phases 2–3):** the `supabase-test` MCP connected, and the operator's go to apply two
  migrations to the pilot (project daqapdlkgxfrhquacprv).
- **Phase 4:** `ssh tradesbox` working from this machine (already configured); the operator's go.

## Phase 1: The unschedule confirm re-checks the visit; the seat add stops leaking its row

### Changes required

**`src/mcp/tools/schedule.ts`** — `handleUnscheduleVisit`. The preview (booking.ts:955-982) is NOT
changed: it goes back to the model and the board, and raw `+00:00` timestamps there are the
2026-07-22 defect (schedule.ts:852-856). Instead, on STAGE (:1314-1324) read
`getVisitForTenant(visitId, tenantId)` once more and add `expected: { startsAt: row.starts_at,
endsAt: row.ends_at }` to `detail` (not echoed to the model). On CONFIRM widen `d` (:1341) with
`expected?: { startsAt?: string | null; endsAt?: string | null }`, and after the malformed guard
(:1346-1348), BEFORE `resolveReviewItem(... 'resolved')` (:1349):

```ts
const now = await getVisitForTenant(d.visitId, tenantId);
const staged = d.expected;
if (!now || !staged || staged.startsAt === undefined
    || now.starts_at !== staged.startsAt || now.ends_at !== staged.endsAt) {
  await resolveReviewItem(item.id, tenantId, 'dismissed', 'visit moved while the confirmation was pending');
  throw new Error('visit NOT cancelled: it moved (or lost its time) since the manager approved — nothing was cancelled; restage to see its current time');
}
```
(`getVisitForTenant` is already imported, :32; both sides come from its `.select()` (visits.ts:682-694)
and JSONB keeps the strings, so `!==` is exact. A gone or foreign visit is refused too.)

**`src/mcp/tools/roster.ts`** — `handleAddTechnicianSeat` return (:422-430): replace `...created`
with an allowlist `id, ref, display_name, tier, state, seat_exempt, skills, service_cities,
sandbox_ref, created_at`. Never badge_hash, composio_*, telegram_user_id, connected_email,
host_id, tenant_id, link_issued_at, offboarding_started_at (database.types.ts:2224-2247).

**`src/mcp/server.test.ts`** — in `describe('scheduling tools …')` (:4318), after the expiry test
(:4831), a test modelled on it: `book_visit` 2026-12-09 09:00-10:00 → `unschedule_visit` stage →
`move_visit` {visitId, date: '2026-12-10', startTime: '13:00', reason} (shape as :4645-4650) →
confirm → `isError` true, text contains `moved`, and the visit is still `confirmed` at its new
time (read back with `pg`). A second case on a FRESH customer (re-booking the same one trips the
open-work guard, booking.ts:350): stage → confirm with no move still cancels. In the admin test
(:910) next to :972: every key of `added.data` must not match
`/^(badge_hash|composio_|telegram_user_id|connected_email|host_id|tenant_id)/`.

### Automated verification
- [x] Red first: the move test fails on current code (the visit is cancelled); the leak assertion fails
- [x] `npx vitest run src/mcp/server.test.ts src/schedule/booking.test.ts`
- [x] `npm run typecheck`, `npm run lint`

### Live / manual verification
None — both behaviours are fully exercised through the real MCP server on the local stack.

---

## Phase 2: Desk answers leave the citable view; drifted text corrected

### Changes required

**`supabase/migrations/20260916130000_desk_answers_not_citable.sql`** (new) — `create or replace
view v_office_messages` with the exact column list of 20260904120000_office_messages_read_surface
.sql:42-56, the same tenant filter, `and m.direction = 'to_planner' and m.kind is distinct from
'desk'`; a comment correcting the old one (:60-62 claimed desk answers are `to_agent`; they are
`to_planner`, kind `desk`, desk.ts:228-237); re-state `grant select … to spine_reader` and `revoke
all … from anon, authenticated`. Apply locally: `npx supabase migration up --local`.

**`src/db/querySpine.test.ts`** — in the inbox-only test (:386-422): assert the viewdef contains
`'desk'`, and add a probe row `direction 'to_planner', kind 'desk'` (inserted like the existing
probes, WITH their `technician_id` so the :420 cleanup deletes it; `kind` is NOT NULL and its CHECK
allows 'desk') that must be ABSENT from the view. The :416 `toEqual(['INBOUND probe body'])` stays
exact. Fix the comment at :379-380 to match.

**Text drifts** (no behaviour change):
- `src/mcp/server.ts:138` "sixteen views" → "eighteen views"; `src/mcp/server.test.ts:7668-7670`
  comment + `toContain('eighteen views')`.
- `src/mcp/server.ts:230-234` → v_office_messages is what seats told you (`to_planner` only); what
  you sent is summarised in your briefing's sent block; your desk answers are not in it.
- `src/mcp/server.ts:755-756` "five views" → "the spine views only"; the `server.test.ts:5196`
  comment "only the five views exist" likewise.
- `src/mcp/tools/customers.ts:196` drop "(with any customer promise)"; `:608` drop "(promises
  included)"; `src/schedule/booking.ts:1289-1290` comment drop "promises included".
- `src/teamLead/planner.ts:3295-3296` and `src/teamLead/plannerPrompt.ts:105-107`: v_office_messages
  holds what seats sent you, not what you sent.

### Automated verification
- [x] Red first: the desk probe row is visible before the migration
- [x] `npx vitest run src/db/querySpine.test.ts src/mcp/server.test.ts src/teamLead`
- [x] `grep -rn "sixteen views\|seats, BOTH ways\|five views\|customer promise\|promises included" src` → no hits
- [x] `npm run typecheck`, `npm run lint`

### Live verification (agent-executable, pre-merge)
- Prerequisites: `supabase-test` MCP; the operator's go.
- [x] Apply the migration SQL to the pilot (`apply_migration`); `execute_sql` `select
      pg_get_viewdef('v_office_messages'::regclass, true)` contains `'desk'`; capture the output.

---

## Phase 3: Phone lookups compare a match key

### Changes required

**`supabase/migrations/20260916130100_customers_phone_key.sql`** (new):
```sql
alter table customers add column phone_key text generated always as (
  case
    when length(regexp_replace(phone, '[^0-9]', '', 'g')) = 11
     and regexp_replace(phone, '[^0-9]', '', 'g') like '1%'
      then substr(regexp_replace(phone, '[^0-9]', '', 'g'), 2)
    when length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 7
      then regexp_replace(phone, '[^0-9]', '', 'g')
  end) stored;
create index idx_customers_tenant_phone_key on customers (tenant_id, phone_key)
  where phone_key is not null;
```
`[^0-9]`, not `\D`: Postgres `\D` treats Unicode digits (e.g. fullwidth) as digits and may vary
by locale; JS `\D` does not (reviewer, verified locally). Then `npm run gen:types:local` (never
`gen:types`, which points at the pilot). The new column rides along wherever customer rows are
returned whole (`customer_contents`' `customers%rowtype`, `find_customer`); harmless, no test pins keys.

**`src/db/phone.ts`** (new), exported via `src/db/index.ts`:
```ts
// The TypeScript twin of customers.phone_key (20260916130100). phone.test.ts pins the two together.
export function phoneKey(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return digits.slice(1);
  return digits.length >= 7 ? digits : null;
}
```

**`src/db/customers.ts`** — `findCustomersByPhone` (:135-145): `const key = phoneKey(phone); if
(!key) return [];` then `.eq('phone_key', key)`. `searchCustomers` (:274-284): when the query holds
≥4 digits, add `,phone_key.ilike.%<k>%` with `k = phoneKey(query) ?? digits` (so `+1 206 555 0170`
searches `2065550170`; digits only — no `.or()` syntax chars).

**`src/console/consoleApi.ts:339-344`** — the twin check compares
`(phoneKey(existing.phone) ?? existing.phone ?? null) === (phoneKey(phone) ?? phone)`.

`src/writePath/identityMatch.ts:155-164` needs no change: it passes the raw phone, and its miss
message (asserted at identityMatch.test.ts:462) still names the raw string. `call_numbers` is left
alone: both sides are Twilio E.164.

**Tests:**
- `src/db/phone.test.ts` (new) — pure cases: `(206) 555-0170`, `206.555.0170`, `+1 206-555-0170`,
  `12065550170` → `2065550170`; `555-0142` → `5550142`; `555-nobody-has-this`, `''`, `null` → null.
  Parity: `createCustomer` with each case phone, read `phone_key` back through `pg`, and expect it to
  equal `phoneKey(phone)`. Clean up like the other db tests.
- `src/writePath/identityMatch.test.ts` — a customer stored `(206) 555-0170` is matched from extracted
  phone `+1 206-555-0170`.
- `src/writePath/recordFieldNote.test.ts` — a stored `206-555-0170` customer is matched by an inbound
  capture whose only phone is `fallbackPhone: '+12065550170'` (pattern at :1188-1211).
- In `src/db/phone.test.ts`: `searchCustomers(tenant, '206 555 0170')` and `'+1 206 555 0170'` both
  find a customer stored `206-555-0170`.

### Automated verification
- [x] Red first: the identityMatch and recordFieldNote two-spelling tests fail before the change
- [x] `npx vitest run src/db/phone.test.ts src/writePath src/console src/calls`
- [x] `npm run typecheck`, `npm run lint`, full `npm test`, `npm run build`

### Live verification (agent-executable, pre-merge)
- Prerequisites: `supabase-test` MCP; the operator's go.
- [x] Apply the migration to the pilot; `execute_sql`: `select count(*) filter (where phone is not
      null) as with_phone, count(*) filter (where phone_key is not null) as keyed from customers`,
      and spot-check 3 rows' `phone` vs `phone_key`. Capture the output.

---

## Phase 4: The tool-search guard and rule 8, on every seat

### Changes required

**`Box_Setup_Stuff/bootstrap-box.sh`**
- Rule 8 in the AGENTS.md heredoc (:784-793): get_connect_link connects GMAIL only. Google Sheets,
  Excel and Drive cannot be connected yet; say so plainly and do not hunt for another way in. Keep
  the rest (no web search, no self-auth, the mail watcher, "being verified").
- `phase_wire`, between the cmp `fi` (:1483) and the running-container branch's `else` (:1484), so it
  runs whether or not the trim changed anything and never on a seat with no container (that stays a
  WARN). Read through `docker exec "$cid"` like :608, not `nemoclaw exec` (its output is not clean
  JSON, scripts/spine-eval/run-gateway.mjs:205-209), and never let jq abort `set -euo pipefail`:
```bash
ts_now=$(docker exec "$cid" cat /sandbox/.openclaw/openclaw.json 2>/dev/null \
  | jq -r 'if .tools.toolSearch == false then "false" else (.tools.toolSearch // "unset" | tostring) end' \
  || echo unreadable)
[ "$ts_now" = "false" ] || fail "tool search guard FAILED on ${agent}: tools.toolSearch is '${ts_now}' — OpenClaw turns tool search ON when it is unset on a local route, hiding every spine tool"
ok "tools.toolSearch=false read back on ${agent}"
```
- `phase_verify` per-sandbox loop (after the perms tripwire, ~:1634): read
  `docker exec "$c" cat /sandbox/.openclaw/openclaw.json 2>/dev/null | jq -r '.tools.toolSearch' || echo unreadable`; `false` →
  pass, anything else → `✗ … run: ./bootstrap-box.sh wire $a` and `warn=$((warn+1))`.

**`docs/engineering-memory.md`** — one §5 trap entry: OpenClaw auto-enables tool search on local
inference routes when `tools.toolSearch` is unset (https://docs.openclaw.ai/tools/tool-search,
fetched 2026-09-15); a rebuild wipes top-level `tools.*` (see :2850-2851); MCP tools cannot be kept
direct-visible under it; `wire` now fails loudly and `verify` reports it. Add the rollout's answer to
whether `inference.local` counts as local.

**`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:726-750`** — point §5c at the `wire` guard as the
enforcement, per the Box_Setup_Stuff sync rule.

### Automated verification
- [x] `bash -n Box_Setup_Stuff/bootstrap-box.sh`; `shellcheck` on the changed lines if installed
- [x] `npx vitest run src/eval/doctrine.test.ts` (it reads this script's doctrine)

### Live verification (agent-executable, operator's go at each step)
- Prerequisites: `ssh tradesbox`; before any sudo, `who` + `ps` show no other operator session
  (memory box-operators); never `openclaw config patch`.
- [x] Re-inventory every copy (`sudo find / -name bootstrap-box.sh -not -path '*/proc/*'` + `md5sum`;
      engineering-memory :3108-3123 found seven). rsync `Box_Setup_Stuff/` to `~/Box_Setup_Stuff/`
      (wire needs the whole tree), `sudo install` over `/usr/local/sbin/bootstrap-box.sh` (the
      recycler's copy); both md5 = the repo's. Report any other stale copy, do not delete it.
- [x] Per seat, BEFORE `wire`: read its current `NEMOCLAW_CTX_WINDOW` from the container
      (`.models.providers.inference.models[0].contextWindow`: 262144 manager, 131072 technician,
      :570-571) and pass exactly that — a wrong value silently halves a manager's window.
- [x] s2 (canary): `wire` prints `tools.toolSearch=false read back`; the in-container AGENTS.md shows
      the new rule 8; `verify` shows no toolSearch ✗; a real turn on s2 answers (memory
      nemoclaw-status-lies-after-restart). Grep the installed OpenClaw dist for how `inference.local`
      is classified for tool search; record the answer in engineering memory.
- [x] Remaining five seats, one at a time, same checks. Capture each `wire` and `verify` tail.

**Landing order:** Phase 4's s2 canary, then the pilot migrations (130000, 130100, 130200), merge, the other five seats.
