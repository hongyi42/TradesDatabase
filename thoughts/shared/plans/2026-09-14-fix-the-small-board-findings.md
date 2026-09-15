---
date: 2026-09-14
task: fix the small board findings — listJobsForCustomer tiebreak, retract_capture customer-link test, retraction-check URL wall, decision-index finding rank
research: none (task record .claude/work/tasks/20260914-fix-the-small-board-findings-listjobsfor.md holds the four findings verbatim)
status: complete
supersedes: nothing
---

## Overview

Four small, independent fixes the operator approved onto one task (precedent: PR #223). Each is
re-verified against origin/main 7c2370c. The fourth original finding (getCustomerContext's
one-fetch-per-id and uncapped recentCaptures) was DROPPED from this task on 2026-09-14 and parked
as `20260915-customer-context-becomes-a-table-of-cont`, because the operator ruled the whole
dump-every-capture read should be redesigned. Only its design-independent piece survives here:
the retraction check's single-URL `in.()` that fails past ~205 ids.

**Closed 2026-09-15.** Final code review added in-place fixes: parallel chunks, gateway-accurate
comments, id tiebreaks on the unscheduled queue and listVisitsForCustomer (a63d8fd, 316d4d5). Its
wider finding (~16 more readers past the URL wall, 5 unpaged readers at the 1000-row cap) is the
retrieval task's by operator ruling. Items 5–10 later added to this task land as a SEPARATE PR
under their own plan (operator, 2026-09-15).

## Decisions

- **Scope (user, 2026-09-14)** — options: batch + cap getCustomerContext now / batch only / drop
  both and redesign. Chosen: drop both, park the redesign. Kept: tiebreak, customer-link test,
  finding rank, retraction-check chunking. No cap on recentCaptures.
- **Direction (user, 2026-09-14)** — never hand a model a customer's raw captures in bulk; the seat
  gets a table of contents and drills in (docs/engineering-memory.md §2). Nothing in this plan adds
  a bulk payload; the chunking fix is needed by any design that folds retractions over a list.
- **Tiebreak column: `id`** — options: `id` (exists, unique, arbitrary but stable) or a new
  sequence column (true insertion order, needs a migration, and deploys don't migrate). Chosen `id`:
  the finding's defect is that a tie resolves DIFFERENTLY between two deliveries; stability fixes
  that. A tie now always names the higher uuid as "newest".
- **`listOpenJobsForCustomer` gets the same tiebreak** — same one-line defect at src/db/jobs.ts:169.
  Its callers (src/mcp/tools/customers.ts:561, src/mcp/tools/schedule.ts:1689,
  src/schedule/booking.ts:351) only filter/count, but the order reaches the model in
  `openWorkSteer` text, which should not reshuffle between calls.
- **src/writePath/recordFieldNote.ts is NOT edited** — its "tail is newest" comments (:608, :656,
  :686) stay true, and the active sibling task 20260912-the-model-names-the-job-on-the-ambiguous
  edits that file; touching comments there buys a merge conflict and nothing else.
- **Chunk size 150, with dedupe** — the 8192-byte wall (src/db/rawCaptures.ts:708-716), measured
  for THIS read on the local stack 2026-09-14: 150 ids = 5,929 URL bytes (200), 214 = 8,425 (414);
  postgrest-js percent-encodes `( , )`, so the wall is ~205-213 ids. Dedupe: postgrest-js dedupes
  within one `.in()`, not across chunks. One retraction per target keeps a chunk ≤150 rows.
- **Rank fix: `finding` 2, `doc` 3, unranked 4, `superseded` 5** — options: (a) split the tier
  (chosen), (b) lower prose `mentions: 100` (would reorder docs against plans in every file),
  (c) inflate a finding's mentions (hides the intent in a magic number). Simulated on a scratch
  copy against this checkout: exactly 5 files change in by-file.json — src/mcp/server.ts gains
  its two findings (2026-09-11 tool-registry split, 2026-09-14 link views) in place of
  docs/nemoclaw-tech-agent.md:4 and docs/onboarding.md:149; src/calls/worker.ts,
  src/writePath/recordFieldNote.ts, src/teamLead/planner.ts, src/jobs/lifecycle.ts only reorder.
- **Customer-link test goes through the MCP server, with a mutation check** — the finding's whole
  point is that a unit test of src/db would not have caught the loop being dropped in a merge.

## Plain-language walkthrough

**Phase 1 — jobs listed in the same order every time.** When two jobs for one customer are created
at the same instant, the database may return them in either order, and the note-filing code picks
"the last one" as the newest. So the same note could land on different jobs on two deliveries.
Adding "then by id" as a second sort key makes the order fixed. You'd notice it working because a
new test creates five jobs with identical timestamps and gets the same order on every read.

**Phase 2 — prove a retraction follows a capture onto the customer.** When a capture filed under a
customer (no job) is retracted, the retraction row must be linked to that customer too, or readers
walking the link see the capture but not its cancellation. The code exists; nothing tests it. The
new test drives `retract_capture` the way a seat does, then looks in the `customer_captures` table.
To prove the test has teeth, the implementer deletes the loop temporarily and watches it fail.

**Phase 3 — the retraction check stops failing on long lists.** Checking "was any of these
captures retracted?" puts every id into one web address. Past ~205 ids the address exceeds 8,192
bytes and the database refuses, which would error every read of a chatty customer forever.

```
before:  [id1 … id500] ──► one request ──► 414 "URL too long" ──► whole read fails
after:   [id1 … id150] ─┐
         [id151… id300] ─┼─► 4 requests ──► results joined ──► same answer
         [id301… id450] ─┤
         [id451… id500] ─┘
```

**Phase 4 — the edit-time reminder stops hiding findings on busy files.** Before each edit, a hook
shows up to 4 past decisions about the file. Findings and generic doc mentions shared one rank,
and doc mentions always won the tiebreak, so `src/mcp/server.ts` showed two passing doc
references instead of the finding about the trap that bites in that very file.

```
rank:  rule 0 → memory 1 → finding 2 → doc mention 3 → plan/research 4 → superseded 5
                           (was: finding and doc mention both 2, doc always won)
```

## Secrets & env preflight

- **All phases:** this worktree's `.env.test` (from scripts/second-stack.sh) and its local Supabase
  stack running. No `.env`, no API keys: nothing calls a live model or a hosted service.

## Phase 1: Stable job order on a created_at tie

### What this phase does
Adds an `id` tiebreak to both customer job lists and pins it with a test that ties five jobs.

### Changes required

**`src/db/jobs.ts`**
- `listJobsForCustomer` (:144-152): after `.order('created_at', { ascending: true })` at :149 add
  `.order('id', { ascending: true })`, with a short comment above the function: equal created_at
  has no order in Postgres; recordFieldNote reads the tail as newest (PR #235's `mayGuess` arm and
  the settled-customer arm), so a tie must resolve the same way on every call.
- `listOpenJobsForCustomer` (:163-172): same second `.order` after :169.

**`src/db/spine.test.ts`**
- Import `listOpenJobsForCustomer` alongside `listJobsForCustomer` at :5.
- New test in `describe('context spine data-access layer')`:

```ts
test('jobs tied on created_at come back in ONE stable order — id ascending', async () => {
  const customer = await createCustomer({ tenantId, name: 'Tie Cust' });
  const jobs = await Promise.all([1, 2, 3, 4, 5].map((i) =>
    createJob({ tenantId, customerId: customer.id, title: `tie ${i}` })));
  const ids = jobs.map((j) => j.id);
  // Independent channel (pg) forces the tie PostgREST cannot create on demand.
  await pg.query('update jobs set created_at = $1 where id = any($2::uuid[])',
    ['2026-09-01T12:00:00Z', ids]);
  const expected = [...ids].sort(); // lowercase-hex order == Postgres uuid byte order
  for (let i = 0; i < 3; i++) {
    expect((await listJobsForCustomer(customer.id)).map((j) => j.id)).toEqual(expected);
    expect((await listOpenJobsForCustomer(customer.id)).map((j) => j.id)).toEqual(expected);
  }
});
```

### Automated verification
- [x] Red first: run `npx vitest run src/db/spine.test.ts` with ONLY the test added — it fails
      (5 random uuids match sorted order by chance 1 in 120; if it passes, rerun once).
- [x] After the change the same command passes.
- [x] `npm run typecheck` and `npm run lint` pass.
- [x] `npx vitest run src/writePath/recordFieldNote.test.ts src/mcp/server.test.ts` passes (the
      tail-is-newest consumers and the openWorkSteer callers).

### Live / manual verification
None — a query order, fully pinned by the codified test.

---

## Phase 2: retract_capture follows a capture onto its customer link

### What this phase does
Test-only. Pins the `listCustomerCapturesForCapture` loop at src/mcp/tools/captures.ts:800-807.

### Changes required

**`src/mcp/server.test.ts`**
- Import `insertCustomerCapture` from `'../db/customers.js'` (extend the :12 import).
- New test in `describe('rung 10 — job links and correspondence')`, directly after the job-link
  test that ends at :8878, modelled on it:

```ts
test('a retraction FOLLOWS its target onto the CUSTOMER link when there is no job', async () => {
  const customer = await createCustomer({ tenantId, name: 'Customer Link Cust', phone: '555-7790' });
  const cap = await appendRawCapture({
    tenantId, channel: 'technician_note', technicianRef: 'tech-mcp',
    rawText: 'filed on the customer, no job named',
  });
  await insertCustomerCapture({ tenantId, customerId: customer.id, captureId: cap.id });

  const staged = await call('retract_capture', { captureId: cap.id, reason: 'wrong customer' });
  expect(staged.isError).toBe(false);
  const done = await call('retract_capture', { confirmId: staged.data.confirmId });
  expect(done.data.status).toBe('retracted');

  // The loop is inside a swallow-and-log try: the tool reports success even if it
  // never ran, so only the table can tell. Read it on the independent channel.
  const links = await pg.query<{ capture_id: string }>(
    'select capture_id from customer_captures where customer_id = $1', [customer.id]);
  expect(links.rows.map((r) => r.capture_id).sort()).toEqual(
    [cap.id, done.data.retractionId as string].sort());
});
```

### Automated verification
- [x] `npx vitest run src/mcp/server.test.ts -t "CUSTOMER link"` passes.
- [x] Mutation check: comment out the `listCustomerCapturesForCapture` loop (captures.ts:800-807),
      rerun — the new test FAILS. Restore, then `git diff --stat src/mcp/tools/captures.ts` is empty.
- [x] `npm run typecheck` and `npm run lint` pass.

### Live / manual verification
None — codified through the real MCP server (in-memory transport).

---

## Phase 3: findRetractionsFor reads past the URL wall

### What this phase does
Chunks `findRetractionsFor`'s `in.()` at 150 deduped ids; no caller changes.

### Changes required

**`src/db/rawCaptures.ts`**
- Replace the body of `findRetractionsFor` (:316-325), keeping its existing comment and adding
  one paragraph on why it chunks (callers pass every capture id a context holds; L1 grows without
  bound; cite THIS read's measurement — 150 ids = 5,929 bytes OK, 214 = 8,425 bytes 414 — not "215"):

```ts
const RETRACTION_CHUNK = 150;
export async function findRetractionsFor(captureIds: string[]): Promise<RawCapture[]> {
  const ids = [...new Set(captureIds)]; // a repeat in two chunks would return its row twice
  const out: RawCapture[] = [];
  for (let i = 0; i < ids.length; i += RETRACTION_CHUNK) {
    const { data, error } = await getClient()
      .from('raw_captures')
      .select()
      .in('retracts_capture_id', ids.slice(i, i + RETRACTION_CHUNK));
    if (error) throw new Error(`findRetractionsFor failed: ${error.message}`);
    out.push(...(data ?? []));
  }
  return out;
}
```
  The empty-input fast path is preserved by the loop (zero iterations → `[]`, no request).

**`src/db/retractions.test.ts`**
- `import { randomUUID } from 'node:crypto';`
- New test in `describe('folding primitives')`:

```ts
test('findRetractionsFor reads past the 8192-byte URL wall, once per retraction', async () => {
  const first = await note();
  const last = await note();
  const rFirst = await retractionOf(first);
  const rLast = await retractionOf(last);
  const filler = Array.from({ length: 498 }, () => randomUUID());
  // 501 ids: past the ~205-id wall; first.id repeated so it lands in two chunks.
  const found = await findRetractionsFor([first.id, ...filler, last.id, first.id]);
  expect(found.map((r) => r.id).sort()).toEqual([rFirst.id, rLast.id].sort());
});
```

### Automated verification
- [x] Red first: with ONLY the test added, `npx vitest run src/db/retractions.test.ts` fails with a
      `findRetractionsFor failed:` error. **If it passes before the fix, stop and tell the
      operator** — the local stack does not reproduce the wall and the test cannot pin it.
- [x] After the change the same command passes, including the existing empty-input test at :96.
- [x] `npx vitest run src/db/context.test.ts src/mcp/server.test.ts` passes (fold consumers).
- [x] `npm run typecheck` and `npm run lint` pass.

### Live / manual verification
None — nothing deploys from this plan; the codified test hits the URL limit locally.

---

## Phase 4: A finding outranks a prose doc mention in the pre-edit hook

### What this phase does
Splits the shared rank so a finding survives MAX_PER_FILE against docs/ prose mentions, pins it
with a test, and regenerates the index.

### Changes required

**`scripts/decision-index.mjs`**
- :603-604 become:

```js
const RANK = { rule: 0, memory: 1, finding: 2, doc: 3, superseded: 5 };
const rank = (e) => RANK[e.statusClass] ?? 4; // plan/research: complete, unknown, …
```
- Extend the finding comment at :553-559 with one sentence: a prose mention from docs/ is seeded
  `mentions: 100` (:578), so sharing a rank with it lost every tiebreak too — src/mcp/server.ts
  hid its tool-registry finding behind two passing doc references (2026-09-14).

**`src/work/decision-index.test.ts`**
- In `beforeAll`, before the script runs: write a temp-tree source file `busy.ts` under `src`; write `docs/busy-1.md` …
  `docs/busy-4.md`, each `# Busy N\n\n- <that file> is mentioned in passing.\n`; write
  `thoughts/shared/findings/2026-09-10-a-finding-on-a-busy-file.md` (frontmatter like the
  promoted finding, `files:` naming that file).
- New test:

```ts
test('a finding outranks prose mentions from docs/, which are seeded at mentions 100', () => {
  const list = byFile[BUSY_FILE];
  expect(list).toHaveLength(4);
  expect(list[0].kind).toBe('finding');
  expect(list[0].where).toContain('a-finding-on-a-busy-file');
  expect(list.slice(1).map((e) => e.kind)).toEqual(['doc', 'doc', 'doc']);
});
```

**`thoughts/by-file.json`, `thoughts/INDEX.md`, `docs/engineering-memory.md`** — regenerated by
`npm run decisions:index`, never hand-edited. If the sibling task merges first, regenerate after
merging main; never merge by-file.json by hand.

### Automated verification
- [x] Red first: with ONLY the test changes, `npx vitest run src/work/decision-index.test.ts` fails
      on `list[0].kind` (a `doc`).
- [x] After the change all tests in that file pass, including `--check` and CRLF.
- [x] `npm run decisions:index`, then
      `node -e 'const j=require("./thoughts/by-file.json");console.log(j["src/mcp/server.ts"].map(e=>e.kind+" "+e.where))'`
      lists `thoughts/shared/findings/2026-09-11-split-src-mcp-server-ts-s-tool-registry.md`.
- [x] `node scripts/decision-index.mjs --check` exits 0 after the regenerate is committed.
- [x] `npm run typecheck`, `npm run lint`, full `npm test`, `npm run build` pass. Stage by name — never
      `git add -A`: supabase/config.toml holds the uncommitted second-stack rewrite.

### Live / manual verification
None — no phase pauses; the implementer runs straight through.
