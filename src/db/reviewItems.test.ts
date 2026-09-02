import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  openCallActionReview,
  resolveReviewItem,
  upsertOpenReviewItem,
} from './reviewItems.js';
import { createTenant } from './tenants.js';

// Integration test against the LOCAL stack (testEnvGuard enforces local-only).
// Exercises the call_action review helper's write + the one-open-per-call dedup
// that the worker relies on across retries.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let tenantB: string | undefined;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query('truncate table review_items cascade');
  // After the truncate, tenant B has no children left — the row deletes clean.
  if (tenantB) await pg.query('delete from tenants where id = $1', [tenantB]);
  await pg.end();
});

describe('openCallActionReview', () => {
  test('writes a call_action row carrying the intent list in detail', async () => {
    const captureId = 'cap-call-action-1';
    const item = await openCallActionReview({
      tenantId,
      captureId,
      intents: ['cancel'],
      priority: 'normal',
      callerPhone: '+15551230001',
      snippet: 'please cancel my Tuesday appointment',
    });

    expect(item.kind).toBe('call_action');
    expect(item.subject_ref).toBe(captureId);
    expect(item.status).toBe('open');
    expect(item.suggestion).toBe('+15551230001'); // caller number for callback

    // Cross-check the persisted detail via direct pg.
    const row = await pg.query<{ detail: { intents?: string[]; priority?: string } }>(
      'select detail from review_items where id = $1',
      [item.id],
    );
    expect(row.rows[0].detail.intents).toEqual(['cancel']);
    expect(row.rows[0].detail.priority).toBe('normal');
  });

  test('a second call on the same captureId returns the SAME open row (dedup by captureId)', async () => {
    const captureId = 'cap-call-action-dedup';
    const first = await openCallActionReview({ tenantId, captureId, intents: ['cancel'] });
    // Different intents on the retry — still one review per call (the partial
    // unique index resolves to the existing open row rather than a second one).
    const second = await openCallActionReview({
      tenantId,
      captureId,
      intents: ['cancel', 'complaint'],
      priority: 'high',
    });

    expect(second.id).toBe(first.id); // same open row, not a duplicate

    const count = await pg.query<{ n: string }>(
      "select count(*)::int as n from review_items where tenant_id = $1 and kind = 'call_action' and subject_ref = $2 and status = 'open'",
      [tenantId, captureId],
    );
    expect(Number(count.rows[0].n)).toBe(1); // exactly one open call_action for this call
  });
});

// (Two describes stood here — 'flagNudgeGap — the visit-kind dedup' and
// 'flagNudgeGap — the kind-generic flagger', seven tests over the app-level
// once-per-subject-EVER guard. `flagNudgeGap` was `escalate`'s writer and both
// died together in build 6 Phase 1. What it guarded did NOT die: the two
// any-status unique indexes are still on the table, they still make a gap item
// once-ever, and they are now the ONLY thing that does — so they are pinned
// here directly, against raw inserts, with no application code in the path.)
describe('the gap kinds stay once-per-subject-EVER at the DB level', () => {
  test.each([
    ['overdue_visit_gap', 'uq_review_items_overdue_gap_ever'],
    ['job_cost_gap', 'uq_review_items_job_cost_gap_ever'],
  ])('%s: a second row for the same subject is refused by %s', async (kind, index) => {
    const subject = `subj-${kind}-${Date.now()}`;
    const first = await upsertOpenReviewItem({
      tenantId,
      kind: kind as 'overdue_visit_gap' | 'job_cost_gap',
      subjectRef: subject,
      suggestion: 'the first and only item this subject ever gets',
      detail: { jobId: 'job-1', technicianRef: 'ben-shelton' },
    });
    expect(first.status).toBe('open');
    // ACROSS STATUS, which is the whole point: settling the item must not let
    // the subject be flagged again. The open-only partial index would.
    await resolveReviewItem(first.id, tenantId, 'resolved', 'field report arrived');
    await expect(
      pg.query(
        `insert into review_items (tenant_id, kind, subject_ref, suggestion)
         values ($1, $2, $3, 'a second item for a subject already flagged once')`,
        [tenantId, kind, subject],
      ),
    ).rejects.toThrow(new RegExp(`${index}|duplicate key`));
  });

  test('the dedup is tenant-scoped and kind-scoped', async () => {
    tenantB = (await createTenant(`ri-tenant-b-${Date.now()}`)).id;
    const subject = `subj-shared-${Date.now()}`;
    const a = await upsertOpenReviewItem({
      tenantId, kind: 'overdue_visit_gap', subjectRef: subject, suggestion: 'A',
    });
    // Another firm's identical subject id is a different gap…
    const b = await upsertOpenReviewItem({
      tenantId: tenantB, kind: 'overdue_visit_gap', subjectRef: subject, suggestion: 'B',
    });
    // …and so is the same id under another kind (assignment ids and job ids
    // live in different namespaces).
    const other = await upsertOpenReviewItem({
      tenantId, kind: 'job_cost_gap', subjectRef: subject, suggestion: 'C',
    });
    expect(new Set([a.id, b.id, other.id]).size).toBe(3);
    expect(b.tenant_id).toBe(tenantB);
  });
});
