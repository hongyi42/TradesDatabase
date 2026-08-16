import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { flagOverdueVisitGap, openCallActionReview, resolveReviewItem } from './reviewItems.js';
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

// Stage-0 watcher flag (plan 2026-08-15 feature A): once per assignment, EVER —
// the dedup must hold across status changes, not just while the item is open.
describe('flagOverdueVisitGap', () => {
  const GAP = {
    jobId: 'job-watch-1',
    technicianRef: 'ben-shelton',
    startsAtLocal: '2026-08-10T15:00:00.000Z',
    endsAtLocal: '2026-08-10T16:00:00.000Z',
    suggestion: "Visit for 'Furnace' (Casa) scheduled to end … has no field report",
  };

  test('first flag opens; detail carries jobId/technicianRef/endsAtLocal', async () => {
    const item = await flagOverdueVisitGap({ tenantId, assignmentId: 'asg-watch-1', ...GAP });
    expect(item).not.toBeNull();
    expect(item?.kind).toBe('overdue_visit_gap');
    expect(item?.subject_ref).toBe('asg-watch-1');
    expect(item?.status).toBe('open');
    expect(item?.suggestion).toBe(GAP.suggestion);

    const row = await pg.query<{ detail: Record<string, unknown> }>(
      'select detail from review_items where id = $1',
      [item!.id],
    );
    expect(row.rows[0].detail).toEqual({
      jobId: GAP.jobId,
      technicianRef: GAP.technicianRef,
      startsAtLocal: GAP.startsAtLocal,
      endsAtLocal: GAP.endsAtLocal,
    });
  });

  test('second flag on the same assignment returns null (not a second row)', async () => {
    expect(await flagOverdueVisitGap({ tenantId, assignmentId: 'asg-watch-1', ...GAP })).toBeNull();
    const count = await pg.query<{ n: number }>(
      "select count(*)::int as n from review_items where tenant_id = $1 and kind = 'overdue_visit_gap' and subject_ref = 'asg-watch-1'",
      [tenantId],
    );
    expect(count.rows[0].n).toBe(1);
  });

  test('dedup holds ACROSS status: resolve, then re-flag → null (never re-opens)', async () => {
    const item = await flagOverdueVisitGap({ tenantId, assignmentId: 'asg-watch-2', ...GAP });
    expect(item).not.toBeNull();
    await resolveReviewItem(item!.id, tenantId, 'resolved', 'field report arrived');
    expect(await flagOverdueVisitGap({ tenantId, assignmentId: 'asg-watch-2', ...GAP })).toBeNull();
    const open = await pg.query<{ n: number }>(
      "select count(*)::int as n from review_items where tenant_id = $1 and kind = 'overdue_visit_gap' and subject_ref = 'asg-watch-2' and status = 'open'",
      [tenantId],
    );
    expect(open.rows[0].n).toBe(0); // the resolved item stayed closed
  });

  test('the dedup is tenant-scoped: tenant B flags the SAME assignment id independently', async () => {
    tenantB = (await createTenant(`ri-tenant-b-${Date.now()}`)).id;
    // Tenant A flagged 'asg-watch-1' above — that must never suppress B's flag.
    const item = await flagOverdueVisitGap({ tenantId: tenantB, assignmentId: 'asg-watch-1', ...GAP });
    expect(item).not.toBeNull();
    expect(item?.tenant_id).toBe(tenantB);
  });
});
