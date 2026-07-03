import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { setTenantSeats } from './tenants.js';
import {
  getTechnician,
  insertTechnician,
  isSeatCapError,
  listTeam,
  listTechniciansInStates,
  setTechnicianState,
  updateTechnician,
} from './technicians.js';
import {
  flagUnknownRefCapture,
  listOpenReviewItems,
  resolveReviewItem,
  upsertOpenReviewItem,
} from './reviewItems.js';

// Integration against the TEST project (pattern: spine.test.ts / context.test.ts).
// Exercises the DB-side guards the admin tools rely on: unique (tenant_id, ref)
// across ALL rows, the seat-cap trigger, and the one-open-review-item dedup.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  // BY NAME: `limit(1)` returns an unspecified row if a crashed run ever left a
  // second tenant behind (same hardening as server.test.ts).
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  // Claim a known starting state: an empty roster AND known capacity. Without the
  // truncate, seeded roster rows (npm run seed) occupy the cap and the assertions
  // below shift by however many active technicians already exist.
  await pg.query('truncate table technicians, review_items cascade');
  await setTenantSeats(tenantId, { managerSeats: 1, technicianSeats: 2 });
});

afterAll(async () => {
  await pg.query('truncate table technicians, review_items cascade');
  // Restore the seed capacity (2/5) so live-verification runbooks that run after
  // the suite aren't left with whatever this file set.
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

describe('technicians roster', () => {
  test('insert + lookup + list; ref is unique per tenant across ALL rows', async () => {
    const jane = await insertTechnician({
      tenantId,
      ref: 'jane-doe',
      displayName: 'Jane Doe',
    });
    expect(jane.state).toBe('invited');
    expect(jane.tier).toBe('technician');

    expect((await getTechnician(tenantId, 'jane-doe'))?.id).toBe(jane.id);
    expect(await getTechnician(tenantId, 'nobody')).toBeNull();
    expect((await listTeam(tenantId)).map((t) => t.ref)).toContain('jane-doe');

    // Duplicate ref → 23505, even though the first row could later be offboarded:
    // refs are never reused across humans (L1 attribution is permanent).
    await expect(
      insertTechnician({ tenantId, ref: 'jane-doe', displayName: 'Another Jane' }),
    ).rejects.toMatchObject({ code: '23505' });
    await setTechnicianState(jane.id, 'offboarded');
    await expect(
      insertTechnician({ tenantId, ref: 'jane-doe', displayName: 'Another Jane' }),
    ).rejects.toMatchObject({ code: '23505' });
  });

  test('seat cap blocks the N+1th active technician; a confirmed deactivation frees the seat', async () => {
    // Capacity is 2 technician seats; jane-doe is offboarded (frees hers).
    const a = await insertTechnician({ tenantId, ref: 'tech-a', displayName: 'Tech A' });
    await insertTechnician({ tenantId, ref: 'tech-b', displayName: 'Tech B' });

    let capErr: unknown;
    await insertTechnician({ tenantId, ref: 'tech-c', displayName: 'Tech C' }).catch((e) => {
      capErr = e;
    });
    expect(capErr).toBeDefined();
    expect(isSeatCapError(capErr)).toBe(true);

    // 'offboarding' rows do not occupy a seat → the same insert now passes.
    await setTechnicianState(a.id, 'offboarding');
    const c = await insertTechnician({ tenantId, ref: 'tech-c', displayName: 'Tech C' });
    expect(c.ref).toBe('tech-c');

    // Reactivating the offboarding row at cap is blocked by the same trigger.
    let reErr: unknown;
    await setTechnicianState(a.id, 'active').catch((e) => {
      reErr = e;
    });
    expect(isSeatCapError(reErr)).toBe(true);
  });
});

describe('control-plane fields (Plan 2)', () => {
  test('updateTechnician round-trip; badge_hash is unique across rows', async () => {
    // The cap test above leaves both technician seats occupied (tech-b, tech-c)
    // — raise capacity for the two probe rows; afterAll restores seed values.
    await setTenantSeats(tenantId, { managerSeats: 1, technicianSeats: 4 });
    const p = await insertTechnician({ tenantId, ref: 'patch-probe', displayName: 'Patch Probe' });
    const patched = await updateTechnician(p.id, {
      badge_hash: 'a'.repeat(64),
      sandbox_ref: 's9',
      link_issued_at: new Date().toISOString(),
    });
    expect(patched.badge_hash).toBe('a'.repeat(64));
    expect(patched.sandbox_ref).toBe('s9');
    expect(patched.link_issued_at).toBeTruthy();
    expect(patched.offboarding_started_at).toBeNull();

    // A second row cannot claim the same badge fingerprint (unique constraint).
    const q = await insertTechnician({ tenantId, ref: 'patch-probe-2', displayName: 'Probe Two' });
    await expect(updateTechnician(q.id, { badge_hash: 'a'.repeat(64) })).rejects.toMatchObject({
      code: '23505',
    });

    // Cross-tenant sweep read used by the lifecycle job: finds rows by state.
    const invited = await listTechniciansInStates(['invited']);
    expect(invited.map((t) => t.ref)).toContain('patch-probe');
    expect(await listTechniciansInStates(['offboarding'])).not.toContainEqual(
      expect.objectContaining({ ref: 'patch-probe' }),
    );

    // Free the seats for the tests below (this describe runs before 'review
    // items' but after the cap test consumed capacity).
    await updateTechnician(p.id, { state: 'offboarded' });
    await updateTechnician(q.id, { state: 'offboarded' });
  });
});

describe('review items', () => {
  test('one open item per (kind, subject): repeat upsert returns the same row', async () => {
    const first = await upsertOpenReviewItem({
      tenantId,
      kind: 'sheet_ref_mismatch',
      subjectRef: 'tehc-jane',
      suggestion: 'tech-jane',
    });
    const again = await upsertOpenReviewItem({
      tenantId,
      kind: 'sheet_ref_mismatch',
      subjectRef: 'tehc-jane',
    });
    expect(again.id).toBe(first.id);
    expect(again.suggestion).toBe('tech-jane'); // the original row, not a rewrite

    const open = await listOpenReviewItems(tenantId);
    expect(open.filter((i) => i.subject_ref === 'tehc-jane')).toHaveLength(1);
  });

  test('resolve stamps resolved_at; a resolved subject can be re-flagged as a NEW item', async () => {
    const item = await upsertOpenReviewItem({
      tenantId,
      kind: 'unknown_ref_capture',
      subjectRef: 'ghost-ref',
    });
    const resolved = await resolveReviewItem(item.id, tenantId, 'resolved', 'roster row added');
    expect(resolved?.status).toBe('resolved');
    expect(resolved?.resolved_at).toBeTruthy();

    // Already-resolved → null (only open items resolve); cross-tenant id → null.
    expect(await resolveReviewItem(item.id, tenantId, 'resolved')).toBeNull();
    expect(
      await resolveReviewItem(item.id, '00000000-0000-0000-0000-000000000000', 'resolved'),
    ).toBeNull();

    // The partial index only dedups OPEN rows — a fresh flag opens a new item.
    const reFlagged = await upsertOpenReviewItem({
      tenantId,
      kind: 'unknown_ref_capture',
      subjectRef: 'ghost-ref',
    });
    expect(reFlagged.id).not.toBe(item.id);
    expect(reFlagged.status).toBe('open');
  });

  test('flagUnknownRefCapture is once-per-message: same externalId never re-opens after resolve; a new message does', async () => {
    const first = await flagUnknownRefCapture({
      tenantId,
      subjectRef: 'mystery-ref',
      externalId: 'msg-001',
    });
    expect(first?.status).toBe('open');

    // Redelivery of the SAME message while open → suppressed (already flagged);
    // the original item stays the sole open row.
    expect(
      await flagUnknownRefCapture({ tenantId, subjectRef: 'mystery-ref', externalId: 'msg-001' }),
    ).toBeNull();
    expect(
      (await listOpenReviewItems(tenantId)).filter((i) => i.subject_ref === 'mystery-ref'),
    ).toHaveLength(1);

    await resolveReviewItem(first!.id, tenantId, 'resolved', 'roster row added');

    // Redelivery of the SAME message after resolve → suppressed (null, no new row).
    expect(
      await flagUnknownRefCapture({ tenantId, subjectRef: 'mystery-ref', externalId: 'msg-001' }),
    ).toBeNull();
    expect(
      (await listOpenReviewItems(tenantId)).filter((i) => i.subject_ref === 'mystery-ref'),
    ).toHaveLength(0);

    // A NEW message from the still-unknown ref → legitimately re-flags.
    const fresh = await flagUnknownRefCapture({
      tenantId,
      subjectRef: 'mystery-ref',
      externalId: 'msg-002',
    });
    expect(fresh?.status).toBe('open');
    expect(fresh?.id).not.toBe(first?.id);
  });
});
