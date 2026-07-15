---
date: 2026-07-14
task: Retraction fold-impact preview (server-computed) + confirmation-count reduction
research: none (decided in-session 2026-07-14 after live E2E on the pilot; see Decisions)
status: draft
---

## Overview

Live E2E (2026-07-14, s2/manager-sam): retracting Maria's seeded intake transcript correctly
folded every standing fact citing it — but the *warning* about what would fold came from the
agent's own reasoning: it caught `prefers`, silently missed the AC job's `symptom`, and the
job lost its symptom without anyone being told. Separately, the flow cost 4 "Yes" replies where
2 suffice, because the agent pre-asked ("want me to…?") before staging each action — despite an
AGENTS.md rule that already bans exactly that (the rule was in context; GLM ignored it).

This plan makes the fold warning a **server guarantee** (exhaustive, computed from the DB, shown
in the staged preview and echoed machine-readably on commit so the agent can stage a one-batch
restore), and attacks the Yes-inflation **structurally** — guidance embedded in the tool
response at decision time, where prompt-layer rules have proven unreliable — plus one new
AGENTS.md rule for the case the current rule doesn't cover (agent-*proposed* follow-ups).

## Decisions

- **Fold stays as-is** — evidence retracted ⇒ facts citing it disappear. User decision: the fold
  is the system being honest; the fixes are *warning* and *recovery*, not fold semantics.
- **No auto-restore of folded facts** — user decision. Whether a fact survives its evidence's
  retraction is human judgment (the transcript might be wholly wrong). Restore = a staged
  `record_standing_fact` batch the manager confirms: one preview, one yes.
- **No claim-level/partial L1 retraction** — user decision. Fights append-only verbatim design.
- **Confirmation floor stays: one per state change** — user decision (memory: agent-confirmation
  UX tone). We remove the inflation above the floor, not the floor.
- **Warning is server-computed at stage AND recomputed at confirm** — my call: facts can be
  recorded between stage and confirm (15-min window); the commit response must reflect commit
  time. The scan is cheap and retraction is a rare manager action.
- **Scan = tenant-scoped PAGINATED fetch + in-memory match** — my call: PostgREST JSON filters
  require explicitly named key paths, so "any JSONB key whose value cites capture X" is not
  expressible as a filter (verified 2026-07-14:
  https://docs.postgrest.org/en/v12/references/api/tables_views.html, JSON columns), and
  CLAUDE.md bans hand-written SQL outside `src/db/`. Final-review finding: PostgREST also caps
  every response at db-max-rows (1000 locally and hosted; a silent fetch limit —
  https://docs.postgrest.org/en/v12/references/configuration.html#db-max-rows), so the scan
  pages via `.range()` until a short page; an unpaginated fetch would silently under-report
  the fold list past 1000 rows. Visits filter directly on `source_capture_id`.
- **`retract_capture` description gains one sentence** (the preview lists what folds) — improves
  agent planning; costs a gateway-restart on rollout (tool descriptions are cached per gateway
  process), which Phase 3 already does for AGENTS.md anyway.
- **Structural nudge over more prompt text** — the confirm response's `restoreHint` tells the
  agent, at exactly the decision moment, to stage the restore batch immediately rather than
  pre-ask. The one genuinely new AGENTS.md rule is "propose by staging" (agent-initiated
  follow-ups arrive as a staged preview, not a "want me to?"), which the current rule text
  doesn't cover.
- **Restores across MULTIPLE customers/jobs go one target at a time** (stage → yes → confirm,
  then the next) — plan-review finding: the server enforces ONE open staged fact-batch per
  person (`record_standing_fact` dismisses any open `pending_standing_fact` as superseded,
  src/mcp/server.ts:1592-1600), so staging restore B would kill restore A's token. Cost is one
  yes per affected row — consistent with the one-per-state-change floor. (Multi-target batching
  would be a tool-schema expansion; out of scope here.)

## Plain-language walkthrough

**Phase 1 — the server tells you what the retraction takes with it.** Today the bot *guesses*
what else disappears when you retract a note; today it guessed wrong (missed `symptom`). After
this phase, the confirmation preview itself carries a list computed straight from the database:
every standing fact (on any customer or job) whose evidence is the capture being retracted, and
every visit logged from that capture. After you confirm, the reply repeats that list in a form
the bot can act on, with an instruction to immediately stage a one-confirmation batch restore of
whichever facts you say are still true. You'd notice it working because the preview says
"⚠ also removes: Maria's prefers, AC job's symptom" — all of them, every time. (When the folded
facts span several customers/jobs, the restore is one staged batch per row, each with its own
yes — today's Maria scenario would cost 3 Yeses total instead of 4, a single-row fold costs 2.)

```
retract_capture (stage)                    retract_capture (confirm)
  │                                          │
  ├─ server scans tenant DB ────────┐        ├─ retraction row lands (unchanged)
  │   facts citing capture          │        ├─ server RE-scans (facts may have
  │   visits sourced from capture   │        │   changed in the 15-min window)
  ▼                                 ▼        ▼
preview: "will retract X            reply: alsoRemoved:[…] + restoreHint:
  ⚠ also removes: […]"                "stage ONE record_standing_fact batch
                                       for the ones still true — don't pre-ask"
```

**Phase 2 — one new conversation rule.** The existing "stage first, the preview is the question"
rule covers actions the *user* asked for. It says nothing about follow-ups the *bot* invents
("prefers folded — want me to re-record it?"). New rule in the AGENTS.md template: when you
propose an action, propose it *by staging it* — the preview is the offer; the person saying no
(or ignoring it — staged items expire in 15 minutes) declines it. Your retract-and-restore
session drops from 4 Yeses to the floor: one per actual write (2 for a single-row fold; 3 for
the Maria case, whose fold spanned two rows).

**Phase 3 — ship it to the box.** PR → merge → Render deploy, then patch the same rule into the
four live sandboxes' AGENTS.md files and restart the s2/s3/s5 gateways so the updated tool
description is re-fetched. Ends with a live re-run of the Maria scenario to judge the UX.

## Secrets & env preflight

- **Phase 1:** none new — local Supabase stack + `.env.test` (already required; `npx supabase start`).
- **Phase 2:** none.
- **Phase 3:** SSH access to trades-box-1 via `~/.ssh/config` host `tradesbox` (already working
  this session); Render deploy is user-performed (no API key on hand — "Deploy latest commit",
  never "Redeploy").

## Phase 1: Server-computed fold impact in retract_capture

### What this phase does

Adds `src/db/foldImpact.ts` (scan helper + types), wires it into the `retract_capture` stage
preview and confirm response in `src/mcp/server.ts`, extends the tool description by one
sentence, and locks the behavior in with tests. No schema changes; nothing else calls the
helper.

### Changes required

**`src/db/foldImpact.ts`** (new)
```ts
export interface FoldedFact {
  rowType: 'customer' | 'job';
  rowId: string;
  rowLabel: string;            // customer.name / job.title ?? job.job_type ?? 'job'
  key: string;
  value: string | number | boolean;
}
export interface FoldedVisit {
  visitId: string;
  jobId: string;
  scheduledAt: string | null;
  technicianName: string | null;
}
export interface FoldImpact { facts: FoldedFact[]; visits: FoldedVisit[]; }
export async function findFoldImpact(tenantId: string, captureId: string): Promise<FoldImpact>
```
- Queries (follow the existing `src/db/*.ts` supabase-client pattern; throw on `error` like the
  neighbors do):
  - `customers`: `.select('id, name, attributes').eq('tenant_id', tenantId)` → for each row,
    for each attributes entry where `isFactBundle(v)` (import from `./standingFacts.js`) and
    `v.sourceCaptureId === captureId`, emit a `FoldedFact` with `v.value`.
  - `jobs`: `.select('id, title, job_type, attributes').eq('tenant_id', tenantId)` → same match.
  - `visits`: `.select('id, job_id, scheduled_at, technician_name').eq('tenant_id', tenantId).eq('source_capture_id', captureId)` → `FoldedVisit`s.
- Code comment stating the bound: tenant-scoped scan on a rare, manager-gated action; revisit
  with a JSONB index/path query if tenants outgrow it.
- Visit *attributes* are intentionally not scanned: only `record_standing_fact` writes bundles,
  and only to customers/jobs (`src/db/standingFacts.ts:7`); visit attributes stay plain values.

**`src/mcp/server.ts`**
- `retract_capture` tool description (line 311-322): after "…(no follow-up write needed)."
  insert: `The staged preview's willAlsoRemove lists exactly which standing facts and visits
  will disappear — show it to the person as part of the confirmation.`
- STAGE branch (after the guards, alongside building the review item around line 1393): compute
  `const impact = await findFoldImpact(tenantId, target.id)` and add to the return (line
  1410-1417): `willAlsoRemove: impact`, and extend `note` with: `If willAlsoRemove is non-empty,
  the shown preview MUST include it.` Do NOT store the impact in the review-item detail — it is
  recomputed at confirm (drift rule), and detail should stay minimal.
- CONFIRM branch: after the commit + review-item resolution succeed (i.e. immediately before the
  `return` at line 1489), compute the impact **advisory** — the retraction has already landed,
  so a scan failure must NOT turn a committed retraction into an error (review finding: an
  unguarded throw here dead-ends the token exactly like the crash case the late-retry path
  exists for). Post-commit recompute is sound: the scan reads stored bundles, which the fold
  never rewrites.
  ```ts
  let impact: FoldImpact | undefined;
  try { impact = await findFoldImpact(tenantId, target.id); } catch { /* advisory */ }
  return {
    status: 'retracted', captureId: target.id, retractionId,
    alsoRemoved: impact,                      // undefined if the scan failed (stage already warned)
    restoreHint: !impact || impact.facts.length === 0 ? undefined :
      'These standing facts disappeared with the retracted evidence. Ask the person which are ' +
      'still true, then restore them by STAGING record_standing_fact — no "want me to?" first; ' +
      'the staged preview is the question. One call per affected customer/job, SEQUENTIALLY: ' +
      'stage one, get its yes, confirm it, then stage the next (staging a second batch before ' +
      'the first is confirmed cancels the first).',
  };
  ```
  Also add the same advisory scan + fields to the late-retry success return (line 1444). There
  the target id comes from `landed.retracts_capture_id`, which is typed `string | null`
  (database.types.ts) — guard it (`if (landed.retracts_capture_id) …`) rather than asserting;
  never fall back to `''` (that would silently scan nothing and report an empty impact).

**`src/mcp/server.test.ts`** (extend `describe('retract_capture + retraction folding')`)
- Setup caveat (review finding): `record_standing_fact` always mints its OWN evidence capture at
  confirm, and one call targets exactly one customer/job — so no tool sequence produces a
  capture cited by both a customer fact and a job fact. Build the fixtures with **direct
  writes**: `createCustomer`/`createJob` accept `attributes` (both already imported in the test
  file), so write the bundles inline, e.g.
  `attributes: { prefers: { value: 'afternoons', sourceCaptureId: cap.id, recordedAt: new Date().toISOString() } }`,
  or use the suite's raw `pg.query` jsonb-update pattern (server.test.ts:2280-2283) for rows
  that already exist. The visit fixture uses `createVisit` with `sourceCaptureId: cap.id`.
- New test: capture cited by a customer fact AND a job fact AND a visit → stage response
  `willAlsoRemove.facts` has both entries (rowType/key/value asserted), `.visits` has the visit;
  confirm response `alsoRemoved` matches and `restoreHint` is a non-empty string.
- New test: retraction with no citing facts/visits → `willAlsoRemove` = `{facts: [], visits: []}`
  and confirm's `restoreHint` is undefined.
- New test (recompute-at-confirm): stage the retraction, then direct-write ANOTHER bundle citing
  the same capture onto a second row, then confirm → `alsoRemoved.facts` includes the late fact.
- Existing tests must pass unchanged (response gained fields only).

### Automated verification
- [x] `npm run typecheck` passes
- [x] `npm run lint` passes
- [x] `npm test` passes (419 passed | 7 key-gated skips; second stack :54421)
- [x] the three new tests above pass (`-t 'fold impact'` → 3 passed)
- [x] `npm run build` passes (pre-PR gate)

### Live verification (agent-executable)
- Prerequisites: none beyond the local test stack — behavior is fully codified above; live
  confirmation happens once deployed (Phase 3).
- [ ] n/a (deferred to Phase 3)

### Manual verification
- (none)

---
*No manual items — continue to Phase 2 after gates pass.*

## Phase 2: "Propose by staging" rule in the AGENTS.md template

### What this phase does

One addition to the permanent-record rules block in `Box_Setup_Stuff/bootstrap-box.sh` (the
template every sandbox's AGENTS.md is built from). The existing rule 2 (lines 547-557) already
bans pre-asks for user-requested actions — including retractions, with the 2026-07-14 live
finding cited — so the only gap is agent-initiated follow-ups.

### Changes required

**`Box_Setup_Stuff/bootstrap-box.sh`**
- In the `## Permanent-record writes` heredoc, insert a new item between rule 2 (ends line 557)
  and rule 3 (starts line 558), renumbering 3→4 and 4→5 (only within this block):
  ```
  3. Propose by staging. When YOU suggest a follow-up write the person didn't ask for (e.g.
     re-recording standing facts a retraction just removed — see the tool's restoreHint), do
     NOT ask "want me to?" — stage it and show the preview: the preview IS the offer. A "no"
     (or just ignoring it) declines; staged items expire on their own in 15 minutes. One yes
     records it; zero extra questions. Restores across several customers/jobs go one at a
     time: stage → yes → confirm, then the next (a second staged batch cancels the first).
  ```
- **`Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md:130-148`** (review finding — this, not
  `nemoclaw-tech-agent.md`, is the doc that quotes the rules block verbatim, and it is already
  one revision stale: its rule 2 predates the 2026-07-14 stage-first update and omits
  `record_standing_fact`): replace the quoted block wholesale with the updated template text
  (refreshed rule 2 + new rule 3 + renumbered 4/5), same commit, per the Box-Setup-Stuff sync
  rule.

### Automated verification
- [x] `bash -n Box_Setup_Stuff/bootstrap-box.sh` (syntax intact around the heredoc edit)
- [x] `grep -c 'Propose by staging' Box_Setup_Stuff/bootstrap-box.sh` → 1
- [x] `grep -c 'Propose by staging' Box_Setup_Stuff/doorman-nemoclaw-setup-guide.md` → 1; full
  block diff template↔guide → IDENTICAL (guide was one revision stale; refreshed wholesale)
- [x] full gates before the PR: typecheck/lint clean, 419 passed | 7 key-gated skips, build clean

### Live verification (agent-executable)
- (none — template only; live rollout is Phase 3)

### Manual verification
- (none)

---
*No manual items — continue to Phase 3.*

## Phase 3: Rollout to the pilot + live E2E

### What this phase does

Lands the PR (standing rule: PR to main, user merges), user does a real Render deploy, then
box-side: patch the new rule into the live sandboxes' AGENTS.md (s1/s2/s3/s5 — same in-place
docker-exec edit recipe as the 2026-07-13 tightening: append/insert, `chown sandbox:sandbox`,
`chmod 660`), restart the s2/s3/s5 gateways (s1 stays parked — seat deactivated) so the updated
`retract_capture` description is re-fetched, and re-run the Maria scenario live.

### Changes required
- Open PR from a feature branch; user merges; user deploys on Render ("Deploy latest commit").
- On trades-box-1 (`ssh tradesbox`, nemoclaw at `/home/ubuntu/.local/bin/nemoclaw`): insert the
  "Propose by staging" rule into each sandbox's `/sandbox/.openclaw/workspace/AGENTS.md`
  (docker exec into `openshell-sN-*`), renumber as in Phase 2, verify with a grep read-back.
- `for s in s2 s3 s5; do nemoclaw $s gateway restart; done` — health output as evidence.
- Refresh the box's installed script copy: `scp` the merged `bootstrap-box.sh` over
  `/usr/local/sbin/bootstrap-box.sh` on trades-box-1 (Phase-2-review finding: the sandbox
  recycler wires future cold blanks from that installed copy — without the refresh, a recycled
  sandbox would get the OLD rules block).

### Automated verification
- [ ] PR opened with all gates green; merged commit hash recorded here
- [ ] grep read-back of 'Propose by staging' = 1 per live AGENTS.md (4 sandboxes)
- [ ] gateway restart health lines for s2/s3/s5

### Live verification (agent-executable)
- Prerequisites: `mcp__supabase-test` (pilot read-backs — READ ONLY per standing rule); ssh
  `tradesbox`. The Telegram side is user-driven (no Telegram MCP).
- [ ] After the user's live test (below): pilot read-back shows the retraction row landed and
  the restored facts cite a fresh capture (evidence: SQL read-back of the affected rows).

### Manual verification (user, in Telegram — the point of the feature)
- [ ] Record a throwaway standing fact on a test customer, retract its evidence capture: the
  staged preview lists the fact under "will also remove" (server list, not agent guesswork).
- [ ] After confirming the retraction, the bot immediately shows a staged restore preview
  (no "want me to?"), and the whole retract+restore flow costs exactly 2 Yeses.
- [ ] Judge the tone: informative preview, no permanence lecturing.

---
*Pause for the user's manual verification at the end of Phase 3.*
