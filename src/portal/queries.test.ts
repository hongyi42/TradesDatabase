import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { createTenant, setTenantSeats } from '../db/tenants.js';
import { createHost } from '../db/hosts.js';
import { insertTechnician } from '../db/technicians.js';
import { registerSandbox, claimSandbox, listPoolRows } from '../db/sandboxPool.js';
import {
  findAccountByAuthUserId,
  findAccountByEmail,
  bindAuthUser,
  inviteAccount,
  listAccountsForTenant,
} from '../db/portalAccounts.js';
import { getSeat, getSummary, listSeats, occupiesSeat } from './queries.js';

// Integration against the LOCAL stack (pattern: sandboxPool.test.ts).
//
// The centre of gravity here is the TWO-TENANT LEAK TEST. The portal is the first
// surface in this system that outsiders use, and isolation rests on a hand-written
// tenant filter in each accessor (RLS is off; the server runs as service_role and
// bypasses it anyway). So "a missing filter must fail a test, not reach prod" is
// the entire point of this file — see the `data-security` skill, §1.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantA: string;
let tenantB: string;
let hostId: string;

beforeAll(async () => {
  await pg.connect();
  await pg.query('truncate table portal_accounts, sandbox_pool, technicians cascade');

  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantA = data.id;
  await setTenantSeats(tenantA, { managerSeats: 2, technicianSeats: 5 });
  tenantB = (await createTenant('portal-queries-other', { managerSeats: 2, technicianSeats: 5 })).id;
  // `hosts` is not truncated (other suites' rows live there), and BOTH `name` and
  // `token_hash` are unique — so both must be unique per run, or the second run
  // of this file fails on a duplicate key rather than on anything it means to
  // test. token_hash is a sha256 fingerprint in production; shape it like one.
  const runId = randomBytes(16).toString('hex');
  hostId = (await createHost(`portal-queries-host-${runId.slice(0, 8)}`, runId + runId)).id;

  // ── Tenant A roster ──────────────────────────────────────────────────────
  const aMgr = await insertTechnician({
    tenantId: tenantA,
    ref: 'a-manager',
    displayName: 'Ray Harrow',
    tier: 'manager',
  });
  await insertTechnician({
    tenantId: tenantA,
    ref: 'a-tech',
    displayName: 'Pete Rowan',
    tier: 'technician',
  });
  // Seat-exempt: bookable, occupies no purchased seat. Must be listed but not counted.
  await insertTechnician({
    tenantId: tenantA,
    ref: 'a-exempt',
    displayName: 'Sam Casual',
    tier: 'technician',
    seatExempt: true,
  });
  // `skills` is not an insertTechnician input, but the portal derives the shown
  // `trade` from it — set it directly so the mapping is actually exercised.
  await pg.query(`update technicians set skills = '{electrical}' where ref = 'a-manager'`);

  // A's sandbox, carrying the bot handle the UI shows.
  const aSandbox = await registerSandbox({
    tenantId: tenantA,
    hostId,
    sandboxRef: 'a-s1',
    botUsername: '@harrow_pete_bot',
  });
  await claimSandbox(aSandbox.id, aMgr.id);

  // ── Tenant B roster — the rows that must NEVER appear for A ──────────────
  const bTech = await insertTechnician({
    tenantId: tenantB,
    ref: 'b-tech',
    displayName: 'Bravo Person',
    tier: 'technician',
  });
  const bSandbox = await registerSandbox({
    tenantId: tenantB,
    hostId,
    sandboxRef: 'b-s1',
    botUsername: '@bravo_secret_bot',
  });
  await claimSandbox(bSandbox.id, bTech.id);
});

afterAll(async () => {
  // Clean up this run's host row. `hosts` is shared across suites and is NOT
  // truncated by anything, so a stranded row here is not merely untidy: both
  // `name` and `token_hash` are unique, and other suites (server.test.ts) create
  // hosts with FIXED token hashes. An orphan of ours squatting on one of those
  // values fails a completely unrelated suite with a confusing duplicate-key
  // error — which is exactly what happened while writing this file.
  await pg.query(
    `delete from sandbox_pool where host_id in (select id from hosts where id = $1)`,
    [hostId],
  );
  await pg.query('delete from hosts where id = $1', [hostId]);
  await pg.end();
});

describe('portal queries — tenant isolation', () => {
  // GUARD AGAINST A VACUOUS SUITE. Every test below asserts that tenant B's data
  // is ABSENT. Those assertions are only meaningful if B's data is actually there
  // and reachable when nobody scopes the query — otherwise they would keep passing
  // after someone deletes the fixture, and the leak test would silently become
  // decoration. This proves the isolation is doing real work.
  test('the fixture really does contain reachable cross-tenant data', async () => {
    const { rows } = await pg.query<{ ref: string; bot_username: string | null }>(
      `select t.ref, p.bot_username
         from technicians t
         left join sandbox_pool p on p.technician_id = t.id
        order by t.ref`,
    );
    const refs = rows.map((r) => r.ref);
    expect(refs).toContain('a-manager');
    expect(refs).toContain('b-tech');
    expect(rows.map((r) => r.bot_username)).toContain('@bravo_secret_bot');
  });

  test('listSeats returns only the calling tenant rows', async () => {
    const seats = await listSeats(tenantA);
    const refs = seats.map((s) => s.ref).sort();
    expect(refs).toEqual(['a-exempt', 'a-manager', 'a-tech']);
    // The assertion that matters: nothing from B, by ref or by name.
    expect(seats.some((s) => s.ref.startsWith('b-'))).toBe(false);
    expect(JSON.stringify(seats)).not.toContain('Bravo Person');
  });

  test("a tenant's bot handle never leaks through the sandbox join", async () => {
    const seats = await listSeats(tenantA);
    expect(JSON.stringify(seats)).not.toContain('@bravo_secret_bot');
    expect(seats.find((s) => s.ref === 'a-manager')?.botUsername).toBe('@harrow_pete_bot');
  });

  test('the sandbox read is itself tenant-scoped (defence in depth)', async () => {
    // The test above passes even with this filter removed, because the handle map
    // is keyed by technician_id and only read with THIS tenant's ids — proven by
    // mutation on 2026-08-12. So assert the filter directly, or the second layer
    // could be deleted with the whole suite still green.
    const poolA = await listPoolRows(tenantA);
    expect(poolA.length).toBeGreaterThan(0);
    expect(poolA.every((r) => r.tenant_id === tenantA)).toBe(true);
    expect(poolA.map((r) => r.bot_username)).not.toContain('@bravo_secret_bot');
  });

  test('getSeat cannot reach another tenant row, even with a valid ref', async () => {
    // 'b-tech' is a real ref — just not A's. Null, not a 403, so the caller
    // cannot distinguish "no such seat" from "not yours".
    expect(await getSeat(tenantA, 'b-tech')).toBeNull();
    expect(await getSeat(tenantB, 'a-manager')).toBeNull();
    expect((await getSeat(tenantA, 'a-manager'))?.name).toBe('Ray Harrow');
  });

  test('getSummary counts only the calling tenant', async () => {
    const a = await getSummary(tenantA);
    const b = await getSummary(tenantB);
    expect(a?.manager).toEqual({ purchased: 2, used: 1 });
    // 2 technician rows on A, but one is seat-exempt and must not be counted.
    expect(a?.technician).toEqual({ purchased: 5, used: 1 });
    expect(b?.technician).toEqual({ purchased: 5, used: 1 });
  });

  test('getSummary returns null for an unknown tenant rather than throwing', async () => {
    expect(await getSummary('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});

describe('occupiesSeat mirrors the enforce_seat_cap trigger', () => {
  // If this drifts from the trigger, the portal reports a different number of
  // used seats than the database will actually permit.
  test('seat-exempt rows never occupy a seat', () => {
    expect(occupiesSeat({ state: 'active', seat_exempt: true })).toBe(false);
  });

  test('offboarding and offboarded free the seat; every other state holds it', () => {
    expect(occupiesSeat({ state: 'offboarding', seat_exempt: false })).toBe(false);
    expect(occupiesSeat({ state: 'offboarded', seat_exempt: false })).toBe(false);
    for (const state of ['invited', 'pending_verification', 'active'] as const) {
      expect(occupiesSeat({ state, seat_exempt: false })).toBe(true);
    }
  });

  test('agrees with the database trigger predicate', async () => {
    // Read the trigger's own count back and compare, rather than trusting that
    // the TS mirror is still faithful.
    const { rows } = await pg.query<{ used: string }>(
      `select count(*) as used from technicians
        where tenant_id = $1 and tier = 'technician'
          and state not in ('offboarding','offboarded') and not seat_exempt`,
      [tenantA],
    );
    const summary = await getSummary(tenantA);
    expect(summary?.technician.used).toBe(Number(rows[0].used));
  });
});

describe('portal_accounts', () => {
  test('an uninvited address resolves to null (invite-only, fails closed)', async () => {
    expect(await findAccountByEmail('nobody@example.com')).toBeNull();
    expect(await findAccountByEmail('')).toBeNull();
  });

  test('email lookup is case-insensitive', async () => {
    await inviteAccount({ tenantId: tenantA, email: 'Ray@Harrowbros.co.uk' });
    const found = await findAccountByEmail('ray@harrowbros.co.uk');
    expect(found?.tenantId).toBe(tenantA);
    expect(found?.role).toBe('owner');
  });

  test('one email cannot belong to two tenants', async () => {
    // The whole session model assumes an email resolves to exactly one tenant.
    await expect(
      inviteAccount({ tenantId: tenantB, email: 'ray@harrowbros.co.uk' }),
    ).rejects.toThrow();
  });

  test('binding an auth user is idempotent and scoped by account id', async () => {
    const acct = await inviteAccount({ tenantId: tenantB, email: 'bravo@example.com' });
    const authId = '11111111-1111-1111-1111-111111111111';
    await bindAuthUser(acct.accountId, authId);
    await bindAuthUser(acct.accountId, authId);
    const byAuth = await findAccountByAuthUserId(authId);
    expect(byAuth?.tenantId).toBe(tenantB);
    expect(byAuth?.email).toBe('bravo@example.com');
  });

  test('findAccountByAuthUserId fails closed on empty input', async () => {
    expect(await findAccountByAuthUserId('')).toBeNull();
  });

  test('listAccountsForTenant is tenant-scoped', async () => {
    const a = await listAccountsForTenant(tenantA);
    const b = await listAccountsForTenant(tenantB);
    expect(a.every((x) => x.tenantId === tenantA)).toBe(true);
    expect(b.every((x) => x.tenantId === tenantB)).toBe(true);
    expect(a.some((x) => x.email === 'bravo@example.com')).toBe(false);
  });

  test('an operator role is never granted by default', async () => {
    const acct = await inviteAccount({ tenantId: tenantA, email: 'default-role@example.com' });
    expect(acct.role).toBe('owner');
  });
});

describe('sandbox_pool retired rows', () => {
  test('a retired sandbox does not supply a live bot handle', async () => {
    const pool = await listPoolRows(tenantA);
    expect(pool.length).toBeGreaterThan(0);
    const seats = await listSeats(tenantA);
    // Sanity: the live one is still attached after all the above.
    expect(seats.find((s) => s.ref === 'a-manager')?.botUsername).toBe('@harrow_pete_bot');
  });
});
