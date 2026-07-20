import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { setTenantSeats } from './tenants.js';
import {
  findRosterByTelegramUserIdGlobal,
  findTechnicianByTelegramUserId,
  getTechnician,
  insertTechnician,
  isSeatCapError,
  listTeam,
  listTechniciansInStates,
  listTenantIdsWithTelegramBindings,
  setTechnicianState,
  updateTechnician,
} from './technicians.js';
import { createTenant } from './tenants.js';
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
  // The global-lookup suite creates a second tenant; drop it so the DB returns
  // to the single seeded tenant (getTenantByName treats duplicates as a bug).
  await pg.query("delete from tenants where name = 'Board Probe Tenant'");
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

  test('seat-exempt rows: insert past a full cap, never count toward it, graduation re-checks', async () => {
    // Both technician seats are occupied (tech-b, tech-c from the cap test
    // above). A seat-exempt insert fits anyway — it occupies nothing — and
    // lands straight in 'active' via the state override.
    const helper = await insertTechnician({
      tenantId,
      ref: 'helper-hman',
      displayName: 'Helper Hman',
      seatExempt: true,
    });
    expect(helper.seat_exempt).toBe(true);
    expect(helper.state).toBe('active'); // derived: exempt rows skip the pairing lifecycle

    // Managers can never be seat-exempt — DB CHECK, not just the chat verb.
    await expect(
      insertTechnician({
        tenantId,
        ref: 'exempt-boss',
        displayName: 'Exempt Boss',
        tier: 'manager',
        seatExempt: true,
      }),
    ).rejects.toThrow(/no_seat_exempt_managers/);

    // The exempt row is invisible to the cap in BOTH directions: a seated
    // insert at the full cap still fails exactly as before…
    let capErr: unknown;
    await insertTechnician({ tenantId, ref: 'tech-d', displayName: 'Tech D' }).catch((e) => {
      capErr = e;
    });
    expect(isSeatCapError(capErr)).toBe(true);

    // Graduation guard: flipping seat_exempt OFF at a full cap re-fires the
    // trigger (the flag is in its update-of column list) — no silent re-seating.
    await expect(
      pg.query('update technicians set seat_exempt = false where id = $1', [helper.id]),
    ).rejects.toThrow(/seat_cap_exceeded/);

    // …and freeing ONE seat admits exactly one seated row alongside the exempt
    // one (if the exempt row counted, occupancy would already be full again).
    const b = await getTechnician(tenantId, 'tech-b');
    await setTechnicianState(b!.id, 'offboarded');
    const d = await insertTechnician({ tenantId, ref: 'tech-d', displayName: 'Tech D' });
    expect(d.seat_exempt).toBe(false); // omitted seatExempt = seat-occupying default
    expect(d.state).toBe('invited'); // omitted state = pre-feature default
    let refillErr: unknown;
    await insertTechnician({ tenantId, ref: 'tech-e', displayName: 'Tech E' }).catch((e) => {
      refillErr = e;
    });
    expect(isSeatCapError(refillErr)).toBe(true); // cap is full again: c + d, helper uncounted
  });
});

describe('control-plane fields (Plan 2)', () => {
  test('updateTechnician round-trip; badge_hash is unique across rows', async () => {
    // The tests above leave both technician seats occupied (tech-c, tech-d;
    // helper-hman is seat-exempt and uncounted) — raise capacity for the two
    // probe rows; afterAll restores seed values.
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

describe('telegram binding (Feature A)', () => {
  test('telegram_user_id patch round-trip; reverse lookup finds active, skips inactive + cross-tenant', async () => {
    await setTenantSeats(tenantId, { managerSeats: 1, technicianSeats: 6 });
    const jane = await insertTechnician({ tenantId, ref: 'tg-jane', displayName: 'TG Jane' });

    // Round-trip: the column is nullable and defaults null, patches and reads back.
    expect(jane.telegram_user_id).toBeNull();
    const bound = await updateTechnician(jane.id, { telegram_user_id: '12345678' });
    expect(bound.telegram_user_id).toBe('12345678');

    // Reverse lookup finds the bound active row…
    expect((await findTechnicianByTelegramUserId(tenantId, '12345678'))?.id).toBe(jane.id);
    // …and returns null for an id nobody holds.
    expect(await findTechnicianByTelegramUserId(tenantId, '99999999')).toBeNull();
    // …and never matches a foreign tenant (the id is tenant-scoped).
    expect(
      await findTechnicianByTelegramUserId(
        '00000000-0000-0000-0000-000000000000',
        '12345678',
      ),
    ).toBeNull();

    // An offboarded holder does not block the id — the guard only sees non-inactive
    // rows, so the same id is re-bindable to a new hire after the old one leaves.
    await setTechnicianState(jane.id, 'offboarded');
    expect(await findTechnicianByTelegramUserId(tenantId, '12345678')).toBeNull();
  });
});

describe('global telegram lookup (Plan 2 board)', () => {
  test('unknown → null; one live match → that row; two firms → ambiguous; inactive-only → null', async () => {
    await setTenantSeats(tenantId, { managerSeats: 1, technicianSeats: 8 });
    const other = await createTenant('Board Probe Tenant', { managerSeats: 1, technicianSeats: 2 });

    expect(await findRosterByTelegramUserIdGlobal('777000999')).toBeNull();

    // One live binding in one tenant resolves — and carries its tenant, the
    // board's entire tenant-isolation anchor.
    const al = await insertTechnician({ tenantId, ref: 'board-al', displayName: 'Board Al' });
    await updateTechnician(al.id, { telegram_user_id: '777000111' });
    const hit = await findRosterByTelegramUserIdGlobal('777000111');
    expect(hit && 'technician' in hit && hit.technician.id).toBe(al.id);
    expect(hit && 'technician' in hit && hit.technician.tenant_id).toBe(tenantId);

    // The same id live in a SECOND firm → ambiguous, both tenants named (v1
    // one-firm-per-account rule: refuse, don't guess).
    const bo = await insertTechnician({
      tenantId: other.id,
      ref: 'board-bo',
      displayName: 'Board Bo',
    });
    await updateTechnician(bo.id, { telegram_user_id: '777000111' });
    const amb = await findRosterByTelegramUserIdGlobal('777000111');
    expect(amb && 'ambiguous' in amb && [...amb.tenantIds].sort()).toEqual(
      [tenantId, other.id].sort(),
    );

    // Offboarding the second firm's row disambiguates back to the first…
    await setTechnicianState(bo.id, 'offboarded');
    const again = await findRosterByTelegramUserIdGlobal('777000111');
    expect(again && 'technician' in again && again.technician.id).toBe(al.id);

    // A SAME-tenant duplicate live binding refuses too (deactivate → re-bind
    // → reactivate can mint this state; an unordered live[0] would make board
    // identity/tier flap per request — refuse, don't guess).
    const em = await insertTechnician({ tenantId, ref: 'board-em', displayName: 'Board Em' });
    await updateTechnician(em.id, { telegram_user_id: '777000111' });
    const sameTenantDup = await findRosterByTelegramUserIdGlobal('777000111');
    expect(sameTenantDup && 'ambiguous' in sameTenantDup && sameTenantDup.tenantIds).toEqual([
      tenantId,
    ]);
    await setTechnicianState(em.id, 'offboarded');

    // …and an inactive-only holder resolves to null, same as the tenant-scoped
    // lookup's contract.
    await setTechnicianState(al.id, 'offboarded');
    expect(await findRosterByTelegramUserIdGlobal('777000111')).toBeNull();
  });

  test('listTenantIdsWithTelegramBindings: live bindings only, distinct per tenant', async () => {
    // State from the previous test: every '777000111' holder is now inactive,
    // and tg-jane (12345678) was offboarded earlier — no live binding remains
    // in the default tenant.
    expect(await listTenantIdsWithTelegramBindings()).not.toContain(tenantId);

    // Two live bindings in the same tenant → the tenant appears exactly once.
    const cy = await insertTechnician({ tenantId, ref: 'board-cy', displayName: 'Board Cy' });
    await updateTechnician(cy.id, { telegram_user_id: '777000222' });
    const dee = await insertTechnician({ tenantId, ref: 'board-dee', displayName: 'Board Dee' });
    await updateTechnician(dee.id, { telegram_user_id: '777000333' });
    const ids = await listTenantIdsWithTelegramBindings();
    expect(ids.filter((id) => id === tenantId)).toHaveLength(1);
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
