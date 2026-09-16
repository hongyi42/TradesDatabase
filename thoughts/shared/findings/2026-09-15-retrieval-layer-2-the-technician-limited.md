---
date: 2026-09-15
task: retrieval layer 2: the technician limited view — scope gate (their visits, their customers' current jobs), grants table + grant check, the firm's own rule, the content-tag hook
status: complete
origin: 20260915-customer-context-becomes-a-table-of-cont
files: supabase/migrations, src/db/context.ts, src/db/visits.ts, src/mcp/tools/shared.ts, src/mcp/tools/captures.ts, src/mcp/tools/customers.ts, src/mcp/server.ts, thoughts/shared/plans/2026-09-15-the-retrieval-layer-2-the-technician-limited-view.md, supabase/migrations/20260917120000_technician_view.sql, src/db/technicianView.ts, src/db/index.ts, src/mcp/server.test.ts, src/db/technicianView.test.ts, scripts/seed.mjs, scripts/spine-eval/world.mjs, docs/engineering-memory.md, docs/nemoclaw-tech-agent.md, src/db/moneyEvents.ts
supersedes: nothing
---

## What a future session must KNOW (the rest is the record)

**1. A composite `IS NOT NULL` in Postgres is false when ANY field is null.** Writing
`p_view is not null` as a "was a view passed?" guard refuses EVERYONE, and the symptom — every
technician read comes back empty — points at the scope rules, not at the guard. Test one
always-set field: `(p_view).tenant_id is not null`. Same family: `x = any(null_array)` is NULL, not
false, so every array in `technician_view` is initialised to `'{}'`.

**2. A technician's own field note MINTS the trip that would put that customer in her view.** The
note door creates a completed visit with its author on the crew when a job has no matching trip
(`attachNote.ts`), so counting it as a trip let anyone open any record by filing one note — no
manager, no grant. `technician_view_of` therefore excludes a visit whose `source_capture_id` is a
technician-channel capture; a trip minted from a CALL still counts. THE COST, accepted by the
operator: recording a genuine walk-in leaves her unable to read the record she just created, beyond
her own note. The planner contradiction detector that closes that loop is parked in
`20260915-the-technician-access-request-flow-tech`.

**3. Money hides in more places than the money block.** `jobs.price_cents` is the same figure one
key over, and it rode beside the status words until a review caught it. Status words must not lie
either: a cleared PROGRESS invoice is "deposit paid, more to invoice" (the job's own state machine
refuses `paid` there), a ledger with rows that owes nothing is "recorded, nothing owed", and money
taken before any invoice is a deposit, not a credit the firm owes back. Plan 3's keyword rail on the
SEND was withdrawn after its own reviewer measured 8 of 8 ordinary phrasings getting through, so
`viewShowsMoney` on the tool surface is the ONLY enforced money gate — the planner's leg is taught,
not checked.

**4. The seat-facing MCP web service does NOT auto-deploy — and the repo ALREADY said so.**
`TradesDatabase` (srv-d8uqmdegvqtc73bfn83g) has autoDeploy OFF, as do `lifecycle-heart` and
`Board_Worker`; only Calls-worker and Calls-purge deploy on commit. Merging a PR therefore does NOT
close a schema-ahead-of-code window — the deploy must be triggered by hand (the API trigger takes
the branch head correctly; the dashboard's "Redeploy" repeats the OLD commit).

The interesting part is not the fact, it is HOW IT WAS MISSED, because both the plan-2 and plan-4
sessions missed it the same way. It is written down twice — `docs/engineering-memory.md:6005`
("There are FIVE services, and three have `autoDeploy: no` — `TradesDatabase` (web) …") and
`:1237` ("six services, two with autoDeploy OFF", itself now stale on the count). What each of us
carried instead was the COMPLEMENTARY half — "Calls-worker and Calls-purge auto-deploy at merge",
true and load-bearing for the apply-before-merge rule — and we generalised it into "merging deploys
the code". A half-memory that is true reads exactly like a whole one. **So: never infer a service's
deploy behaviour from the fact that some service auto-deploys. Read it from the API
(`list_services` → `autoDeploy`) at the moment you plan the cutover.** On this task the pilot ran
plan-2 schema against plan-1 code until the deploy was triggered by hand.

**5. A per-firm rule row on the SHARED seed tenant is invisible to the file that does not set it.**
`server.test.ts` widens the seed firm to `whole_firm`; `retrievalLayer.test.ts` reads the same
tenant at technician tier and passed identically with a leaked rule planted. Both files now reset
the rule in `beforeAll`, not only `afterAll`.

**Verified live on the pilot after deploy** (signed identity, real HTTP, 2026-09-16): a technician
on a customer he serves got 9 jobs, `jobsOutsideView: 1` and no `price_cents`; on one he does not,
exactly `{id, name, inView:false, note}`; a manager on that same customer got 8 jobs and
`price_cents: 40000`; `get_job` and `search_captures` on out-of-view targets answered `inView:false`.

## Files

- supabase/migrations
- src/db/context.ts
- src/db/visits.ts
- src/mcp/tools/shared.ts
- src/mcp/tools/captures.ts
- src/mcp/tools/customers.ts
- src/mcp/server.ts
- thoughts/shared/plans/2026-09-15-the-retrieval-layer-2-the-technician-limited-view.md
- supabase/migrations/20260917120000_technician_view.sql
- src/db/technicianView.ts
- src/db/index.ts
- src/mcp/server.test.ts
- src/db/technicianView.test.ts
- scripts/seed.mjs
- scripts/spine-eval/world.mjs
- docs/engineering-memory.md
- docs/nemoclaw-tech-agent.md
- src/db/moneyEvents.ts

## Notes

Plan 2 of the retrieval-layer ladder (operator build order 2026-09-15: plans 2, 3, 4 run IN PARALLEL, each its own worktree + stack, integrated one at a time). Plan 1 landed as PR #242: capture_visible(channel, sensitivity, tier) is today's gate (option A by channel); plan 2 ADDS scope + grants + the firm rule to that same predicate, never a second one.
Start with /plan against thoughts/shared/research/2026-09-15-the-retrieval-and-delivery-layer.md, the ladder in thoughts/shared/plans/2026-09-15-the-retrieval-layer-1-captures-and-the-customer-read.md, and the rulings in task 20260915-customer-context-becomes-a-table-of-cont ("TECHNICIAN VIEW + GRANT ACCESS" 1-3, 7-9).
Operator must confirm in plan review: "the jobs of the customers they are serving" = current, non-terminal jobs of customers on their visits (proposed reading, not yet ruled). Grants: one customer or one job, time-boxed, standing option; a ledger row (who asked, who granted, scope, expiry, why). The request flow (asking, relay, grant_access) is a separate parked task that waits for this one.

## Decisions

OPEN MISMATCH (2026-09-15, from the plan-3 session after the operator withdrew its send rail —
"just use prompt engineering, no need for the rails"): `viewShowsMoney` is now the ONLY ENFORCED
money gate, and it sits on the tool surface (plan 2). The planner's leg — its gap block, the text it
writes to a technician, and the desk answer — is TAUGHT, not checked. So a firm that sets
technician_view_rules.money = 'amounts' opens the figures on the tools while the planner's doctrine
still tells it not to name a figure to a technician. Decide when the firm-rule verb is designed:
either the doctrine reads the firm's rule (a per-firm prompt line, so the planner opens up with the
tools), or the operator accepts that the planner stays conservative while the tools do not. Worth
knowing why the rail went: plan 3's reviewer measured it end to end — 8 of 8 ordinary ways to state
an amount got through ("her total is 900", spelled-out figures), because it matched digits rather
than amounts, and it refused 5 of 5 harmless messages. The measurement is in docs/engineering-memory.md.

OPERATOR, 2026-09-15 (plan review, brief in the /plan session; plan thoughts/shared/plans/2026-09-15-the-retrieval-layer-2-the-technician-limited-view.md):
 1A. "Serving" = a customer with UNFINISHED work (not paid/cancelled/declined) the technician has a non-cancelled trip on. In view: every unfinished job of a served customer + every job she ever had a trip on (her own work, any age) + granted. A customer served last year keeps her own old job + profile only.
 2B. Outside the view = name + id only, marked inView:false, "outside your view" in words (the request flow's hook). record_standing_fact refused on an out-of-view target.
 3C. A grant opens what the MANAGER PICKS per grant: `record` (the job/customer as if served; content gate still applies) or `record_and_notes` (every note, as the manager sees them). Money detail stays door numbers either way.
 OWN NOTES (operator, 2026-09-15, /implement Phase 1 review): a technician ALWAYS reads the notes she wrote herself, wherever they sit (on a customer/job outside her view, or never filed). Implemented as: a TECHNICIAN-channel capture stamped with her roster ref is in her scope; authorship lifts SCOPE only — the firm's content rules (channel, manager_only, hidden tags) still apply. Technician channels only, because inbound mail to her paired mailbox, her send/audit rows and phone-line captures also carry a ref.
 4B. The firm rule (width: own trips / serving / serving + history / whole firm; technician channels; hidden tags) + the check ship in plan 2; the manager-seat verb to set it ships WITH grant_access in 20260915-the-technician-access-request-flow-tech. Until then default everywhere, operator SQL to change a firm.

OPERATOR, 2026-09-15 (ruled in the plan-3 session; relayed here so it survives if the cross-session
message is not read): a technician sees money STATUS ONLY, in words — "invoiced, not yet paid",
"paid in full" — and NO amounts. The invoice amount is hidden by default, and balance due goes with
it (balance due EQUALS the invoice whenever nothing has been paid, so keeping it leaks the charge).
This supersedes decision 3C's "money detail stays door numbers either way": there are no door
numbers left, and a grant opens no money detail either. It supersedes `technicianMoneyView`
returning `{balanceDueCents, invoicedCents}` (src/db/moneyEvents.ts:609-613), applied at
src/mcp/tools/customers.ts:393 (moneyByJob) and :485 (get_job). Operator's reason, their words: if a
firm really finds the technician needs the amount (collecting a payment on a job), they can ask the
manager in real life, by text, or through their seat agent once the grant feature lands — a thing
you ask for, not a default.
OPERATOR, 2026-09-15 (same exchange, correcting the line above): "not by default" is a DEFAULT, not
a ceiling. The manager may widen to ANYTHING, money included — through the firm's own rule or
through a grant — because some firms do want their technicians to know the amount. So a grant MAY
open money amounts; "money detail stays door numbers either way" is wrong in that direction too.
Shape that follows: one predicate, "may this person be told money here?", answered by the tier by
default and by the grant / firm rule when one exists — never a hardcoded tier test.

FLAGGED, not fixed, by plan 3: the PLANNER relays money to technicians. Its gap block lists a job's
ledger lines with amounts for any gap, including one addressed to a technician, and it writes that
technician's text itself. Plan 3 deliberately left its prompt alone — the same gap is discussed with
managers — so the rule belongs on the SEND, beside the date rail, in whoever owns the technician
rule (this task or the parked access-request-flow task).
CONFIRMED BY THE OPERATOR IN THIS SESSION (2026-09-15) and BUILT HERE: technicianMoneyView now
returns `{status}` — seven states, no figure — and the retraction preview's alsoLosesEvidence.money
drops `amountCents` for a technician (she keeps eventId/job/kind, which is what inform_team_lead
asks her to name). The PLANNER RELAY above went to PLAN 3 on the operator's call, asked as its own
question: "it is the planner's own surface, so the plan-3 session takes it."

## Handoff 2026-09-15T20:57:12.581Z

Spawned by `work.mjs spawn` into /Users/hongyihe/GitHub/TradesDatabase/.claude/worktrees/retrieval-layer-2-the-technician-limited on work/retrieval-layer-2-the-technician-limited, from origin/main 2ca4f71.

Overlap check: none with any active task.

## Handoff 2026-09-16T00:35:52.932Z

**What changed** — A technician's seat no longer reads the whole firm. The database works out her
view once per read (technician_view_of → capture_in_scope + capture_content_open, inside plan 1's
same predicate) and every technician door now agrees on it: the contents page, note pages,
get_capture, search_captures, find_customer, get_job, record_standing_fact. Out-of-view customers
and jobs come back as a name and an id with "outside your view" in words — the hook the request
flow will pick up. New: access_grants (a ledger: revoke-stamp only, direct DELETE refused, cascade
allowed), technician_view_rules (job_scope, technician_channels, hidden_tags, money) and
capture_tags (the hook the extractor task fills). Money for a technician became STATUS IN WORDS,
then openable: technician_view_rules.money and access_grants.opens_money, read through
view_money_open / viewShowsMoney. In place along the way: the eval's G01/G02 hardcoded 43/17 tool
counts (G01 had been FAILING on a green main since plan 1 removed two tools) now derive from
surface.expected.ts; jobs.price_cents is stripped for a technician when money is closed; the
planner takes the manager-shaped money block on get_job/get_customer_context instead of the
technician projection (it reads everything, and it is unreachable there today anyway).

**Decisions** — Operator, each asked as its own question: 1A serving (a booked trip on unfinished
work) over "anyone she ever visited" and over "only her own jobs"; 2B name+id outside the view over
hiding the customer entirely, because hiding it makes the seat say the customer does not exist and
leaves no way to ask; 3C the manager picks per grant (record | record_and_notes) over one fixed
meaning; 4B the firm rule ships here but its seat verb ships with grant_access, accepting that
until then a technician has no in-product path to widen; her own notes are always readable
(scope only, technician channels only — inbound mail and phone-line rows carry her ref too); a
trip minted by her OWN note does NOT count as serving (it let anyone open a record by filing one
note) while a trip minted from a call does; money status-only is a DEFAULT, not a ceiling, and the
money gate asks the view rather than the tier so a grant can widen it without a rewrite. Rejected
approach worth recording: plan 3's keyword money rail on the send — its own reviewer measured 8 of
8 ordinary ways to state an amount getting through, so the operator withdrew it; enforcement lives
only on this tool surface now.

**Assumptions** — That a technician needs no in-product path to out-of-view data until the
request-flow task lands (the pilot is a test surface). That "amounts" for an opened technician
means the old door numbers (balance due + invoiced), not the ledger entries. That the migration
keeps version 20260917120000; plan 3 collides on it and re-dates if I land first. That the
brief-style Telegram check and the tier-2 corpus eval are owed rather than blocking.

**Open** — (a) The PILOT MIGRATION is not applied and nothing is pushed: apply
20260917120000_technician_view.sql by hand (supabase-test MCP) immediately before the PR merges,
then NOTIFY pgrst and read back pg_proc for technician_view_of / capture_in_scope /
capture_content_open / capture_restricted / two capture_visible rows. (b) No PR opened yet.
(c) Owed human check: restart the s2 gateway (seats cache tools/list), then ask a technician seat
about a customer it serves and one it does not, and judge how the refusal reads. (d) Tier-2 corpus
eval (Q01) not run — needs OPENROUTER_API_KEY copied into this worktree. (e) The enforced-vs-taught
money mismatch: a firm setting money='amounts' opens the tools while the planner's doctrine still
says no figures — recorded in this task and the request-flow task. (f) src/db/tenantSettings.test.ts
flaked once under full-suite load (it renames tenant_settings and waits on PostgREST's schema
cache); it passes alone and on a re-run, and it is not touched by this work.

**Downstream** — Plans 3 and 4 must merge main and regenerate database.types.ts with
gen:types:local, never by hand: this migration DROPS and recreates plan 1's four readers with two
trailing defaulted params (p_terminal_statuses, p_viewer) and rewrites 3-arg capture_visible to
return true only for manager and planner, so any technician read that does not pass the 5-arg form
sees nothing. The parked request-flow task now carries four additions: grant_access takes `opens`
and `opens_money`, the firm-rule verb and a revoke verb ship there, the planner may grant or deny,
and a contradiction detector should raise "she filed on a job she is not booked on". The
extractor-tags task carries the concrete correspondence hole (a price quoted in a call the
technician may not read is copied onto the job in words). docs/engineering-memory.md and
docs/nemoclaw-tech-agent.md were edited here and by both sibling worktrees — expect merge conflicts
in those two files.

## Handoff 2026-09-16T19:24:10.140Z

**Coordination with plans 3 and 4 (2026-09-16, operator asked)** — ORDER: plan 2 → plan 3 → plan 4,
migration versions ascending with it (mine 20260917120000 unchanged; plan 3 re-dates its two files,
which collide with mine, to 130000/130100; plan 4 keeps 140000), so a local `db reset` replays files
in the order the pilot received them. Each session applies its OWN migration by hand immediately
before its OWN merge; nobody applies another's; after each merge the other two merge main and
regenerate database.types.ts with gen:types:local. Rationale for me first: my migration drops and
recreates plan 1's four readers and narrows 3-arg capture_visible, so the others adapt once against
the final shape. PLAN 4 ACCEPTED and is also ready (14 commits, 3209 tests, tier-1 48/48, tier-2
3/3); it confirmed nothing on its branch calls the four readers or capture_visible in any arity.
Verified for it (asked, not assumed): my migration creates NO views and contains no "at time zone",
so it cannot reintroduce the naive-local local_day bug its v_schedule/v_cancelled_visits fix closes.
PLAN 4 WILL BREAK SIX find_customer ASSERTIONS in src/mcp/server.test.ts when it merges main after
me (:386, :392, :4277 pre-existing; :9877, :9880, :9919 mine) because it wraps find_customer as
{customers, note?} and wraps any array result as {items, count}; I told it the one shape that must
survive — an out-of-view match stays exactly {id, name, inView:false, note}, since that row is the
request flow's hook and a wrapper refactor could silently widen it back to the full customer row.
Also from plan 4, landing after me: list_team → {team}, list_pending_reviews → a page, get_job gains
a moneyNote, listUnplaced deleted, three visit readers paged, src/db/rowCap.ts added to index.ts
(one-line conflict with my technicianView.js export).
**Schedule reads and the view** — nothing in my branch gates a schedule read and nothing needs to
today: get_schedule returns only the technician's own visits (inside her view by construction), and
get_team_schedule plus the board tray are manager-only. THE RULE FOR WHOEVER ADDS ONE: a
technician-facing schedule read must pass her roster id through technician_view_of like every other
technician read — the fail-closed default means a reader that forgets sees nothing, which is safe
but reads as a bug.

## Handoff 2026-09-16T19:25:28.975Z

**Plan 4 coordination CLOSED (2026-09-16)** — it accepted the order, owns the find_customer merge
(it lands last and the shape change is its own), and will resolve the handleFindCustomer conflict
toward MY ternary — view test first, fold only for shown rows, `.filter(shown)` kept on the evidence
gather — adding only its `{customers}` wrapper. The hazard is NOT a missing guard (mine is already
guarded); it is resolving that hunk toward plan 1's unguarded `rows.map((c) => ({...c, attributes}))`,
which its branch still sits on, because that would add an `attributes` key to an out-of-view row and
turn the four-key row into five. It is pinning the wrapped `toEqual([{id, name, inView:false, note}])`
so a later drift fails a test instead of handing a technician a phone number. Plan 3 has NOT answered
(its session takes messages in prompting mode, so delivery waits on its own operator); its only
dependency on me is the 20260917120000 collision, which it resolves by re-dating whenever it reads.

## Handoff 2026-09-16T19:26:56.171Z

**Plan 3 coordination CLOSED (2026-09-16)** — it accepted and has ALREADY re-dated to
20260917130000 / 130100 (commit 1406192, gates green). It is code-complete but HELD by its operator:
not cleared for the pilot apply or a PR, so "plan 2 first" is an ORDER, not a schedule — if plan 3 is
cleared before me it takes the slot and I merge main and re-run, since its branch does not need mine.
Its complete dependency list on my side: 3-arg capture_visible (literal 'planner'), capture_is_live,
capture_scope_members(p_tenant,'job',job), capture_membership's six columns and its `via` values
(v_capture_links selects five of them; capture_records reads created_customer / created_job /
created_visit / job_link / visit_note), plus one named-argument captures_page call in a test.
VERIFIED for it by grep, not memory: my migration creates and drops NONE of capture_membership,
capture_scope_members, capture_is_live or capture_scope_found — it only CALLS them, so no signature,
column or `via` value moves. The only things my file redefines are plan 1's four readers (trailing
defaulted params) and the 3-arg capture_visible BODY (still true for 'planner'). Both sessions agreed
the same merge protocol: ping on landing, then merge main, gen:types:local, re-run gates.
Plan 3 ships NO money enforcement (its send rail was withdrawn), so after both land viewShowsMoney is
the whole of it — the enforced-vs-taught mismatch recorded earlier stands, for the firm-rule verb to
settle.

## Handoff 2026-09-16T19:32:59.036Z

**PILOT APPLIED + PR OPEN (2026-09-16)** — 20260917120000_technician_view.sql applied to the pilot
through the supabase-test MCP (its ledger names it `technician_view`; hosted ledger versions differ
from filenames, as always). VERIFIED after apply, not assumed: all 16 function bodies md5-match the
local stack — both capture_visible arities, plus plan 1's untouched capture_is_live and
capture_scope_members — so the transcription is provably identical; the three new tables have RLS on
with zero anon/authenticated grants; zero anon/authenticated EXECUTE on any of the twelve functions;
technician_view_rules, access_grants and capture_tags are all EMPTY, so no firm's behaviour changed
at apply time. `NOTIFY pgrst, 'reload schema'` sent. PR #247 open against main, branch pushed.
THE TECHNICIAN-BLIND WINDOW IS OPEN on the pilot from this apply until #247 merges and Render
redeploys: the deployed code is still plan 1's, passes no viewer, and now sees nothing on every
technician capture read (fail closed — no errors, no wider view). Managers and the planner are
unaffected. Closing it is merging #247.
