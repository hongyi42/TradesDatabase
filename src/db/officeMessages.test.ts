import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  createOfficeMessage,
  listDeskTranscriptsSince,
  listOfficeMessagesForRef,
  listOfficeMessagesByStatus,
  markOfficeMessagesRead,
  OFFICE_MESSAGE_BODY_MAX,
  setOfficeMessageAttempts,
  setOfficeMessageDelivery,
  setOfficeMessageServeCount,
} from './officeMessages.js';
import { insertTechnician } from './technicians.js';

// Writes go through the app path (supabase-js); direct pg is the INDEPENDENT
// read-back channel and the cleanup — the observations.test.ts convention.
// Isolation is by this run's own rows (tracked ids); cleanup deletes exactly
// what this file created.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let technicianId: string;
const RUN = `office-${Date.now()}`;
const createdIds: string[] = [];

async function mkMessage(
  over: Partial<Parameters<typeof createOfficeMessage>[0]> = {},
) {
  const row = await createOfficeMessage({
    tenantId,
    direction: 'to_planner',
    kind: 'inform',
    fromRef: `${RUN}-sender`,
    toRef: 'spine:team-lead',
    tier: 'technician',
    body: 'Ben is on leave this week',
    ...over,
  });
  createdIds.push(row.id);
  return row;
}

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  // A roster row for the to_agent CHECK (the addressee FK). seat_exempt so the
  // fixture occupies no seat and needs no pairing lifecycle.
  const tech = await insertTechnician({
    tenantId,
    ref: `${RUN}-tech`,
    displayName: 'Office Test Tech',
    seatExempt: true,
  });
  technicianId = tech.id;
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await pg.query('delete from office_messages where id = any($1::uuid[])', [createdIds]);
  }
  await pg.query('delete from technicians where id = $1', [technicianId]);
  await pg.end();
});

describe('office_messages accessors', () => {
  test('a create round-trips through the unread listing, oldest first', async () => {
    const first = await mkMessage({ body: `${RUN} first` });
    const second = await mkMessage({ body: `${RUN} second` });
    expect(first.status).toBe('unread');
    expect(first.direction).toBe('to_planner');
    const unread = await listOfficeMessagesByStatus(tenantId, 'to_planner', ['unread']);
    const mine = unread.filter((m) => m.body.startsWith(RUN));
    expect(mine.map((m) => m.id)).toEqual([first.id, second.id]);
    // tier rides as metadata, verbatim.
    expect(first.tier).toBe('technician');
  });

  test('an over-long body is CUT to the cap, never refused', async () => {
    const row = await mkMessage({ body: 'x'.repeat(OFFICE_MESSAGE_BODY_MAX + 500) });
    expect(row.body).toHaveLength(OFFICE_MESSAGE_BODY_MAX);
  });

  test('a to_agent row without an addressee is refused by the CHECK', async () => {
    await expect(
      createOfficeMessage({
        tenantId,
        direction: 'to_agent',
        kind: 'ask',
        fromRef: 'spine:team-lead',
        toRef: `${RUN}-tech`,
        body: 'how did the marina visit go?',
        status: 'queued',
      }),
    ).rejects.toThrow(/office_messages_addressee_check/);
  });

  test('mark-read is guarded: only unread rows move, and the count says how many', async () => {
    const a = await mkMessage();
    const b = await mkMessage();
    const nowIso = new Date().toISOString();
    const moved = await markOfficeMessagesRead(tenantId, [a.id, b.id], nowIso);
    expect(moved).toBe(2);
    // A second pass finds nothing unread — the guard loses cleanly, no re-stamp.
    expect(await markOfficeMessagesRead(tenantId, [a.id, b.id], nowIso)).toBe(0);
    const { rows } = await pg.query(
      'select status, read_at from office_messages where id = $1',
      [a.id],
    );
    expect(rows[0].status).toBe('read');
    expect(rows[0].read_at).not.toBeNull();
    // Empty ids is a no-op, not a PostgREST error.
    expect(await markOfficeMessagesRead(tenantId, [], nowIso)).toBe(0);
  });

  test('the delivery writer is status-guarded and loses a race honestly', async () => {
    const row = await mkMessage({
      direction: 'to_agent',
      kind: 'ask',
      fromRef: 'spine:team-lead',
      toRef: `${RUN}-tech`,
      technicianId,
      status: 'queued',
    });
    const delivered = await setOfficeMessageDelivery(
      row.id,
      tenantId,
      { status: 'delivered', deliveredAt: new Date().toISOString() },
      ['queued'],
    );
    expect(delivered?.status).toBe('delivered');
    expect(delivered?.delivered_at).not.toBeNull();
    // The row left 'queued' — a second queued-guarded write returns null.
    expect(
      await setOfficeMessageDelivery(row.id, tenantId, { status: 'failed' }, ['queued']),
    ).toBeNull();
  });

  test('the serve/attempt ledgers only write while queued', async () => {
    const row = await mkMessage({
      direction: 'to_agent',
      kind: 'inform',
      fromRef: 'spine:team-lead',
      toRef: `${RUN}-tech`,
      technicianId,
      status: 'queued',
    });
    expect((await setOfficeMessageServeCount(row.id, tenantId, 1))?.serve_count).toBe(1);
    expect((await setOfficeMessageAttempts(row.id, tenantId, 2))?.attempts).toBe(2);
    await setOfficeMessageDelivery(row.id, tenantId, { status: 'delivered' }, ['queued']);
    expect(await setOfficeMessageServeCount(row.id, tenantId, 2)).toBeNull();
    expect(await setOfficeMessageAttempts(row.id, tenantId, 3)).toBeNull();
  });

  test('desk transcripts are found by the time-bounded read, not the status one', async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    const desk = await mkMessage({
      kind: 'desk',
      fromRef: 'spine:team-lead',
      toRef: `${RUN}-sender`,
      body: `${RUN} desk answer`,
      status: 'read', // desk rows are born read — transcript, not queue
    });
    const unread = await listOfficeMessagesByStatus(tenantId, 'to_planner', ['unread']);
    expect(unread.some((m) => m.id === desk.id)).toBe(false);
    const transcripts = await listDeskTranscriptsSince(tenantId, before);
    expect(transcripts.some((m) => m.id === desk.id)).toBe(true);
    // The cutoff is exclusive-forward: a cutoff after the write finds nothing.
    const after = new Date(Date.now() + 60_000).toISOString();
    expect((await listDeskTranscriptsSince(tenantId, after)).some((m) => m.id === desk.id)).toBe(
      false,
    );
  });

  test('the publishable keys get zero rows — RLS deny-all holds (the ACL probe)', async () => {
    await mkMessage({ body: `${RUN} secret` });
    const { rows } = await pg.query(
      `select has_table_privilege('anon', 'office_messages', 'SELECT') as anon_select,
              has_table_privilege('authenticated', 'office_messages', 'SELECT') as auth_select,
              relrowsecurity
         from pg_class where relname = 'office_messages'`,
    );
    expect(rows[0].anon_select).toBe(false);
    expect(rows[0].auth_select).toBe(false);
    expect(rows[0].relrowsecurity).toBe(true);
  });
});

// The office's `asker_history` read (plan 2026-09-22): one person's business
// with the office, both directions, and nobody else's.
describe('listOfficeMessagesForRef', () => {
  test('returns rows the ref sent or was sent, newest first, and no one else\'s', async () => {
    const me = `${RUN}-me`;
    const sent = await mkMessage({ fromRef: me, body: `${RUN} from me` });
    const got = await mkMessage({ fromRef: 'spine:team-lead', toRef: me, kind: 'desk', status: 'read', body: `${RUN} to me` });
    await mkMessage({ fromRef: `${RUN}-other`, body: `${RUN} someone else` });
    const rows = await listOfficeMessagesForRef(tenantId, me, '2000-01-01T00:00:00Z');
    expect(rows.map((r) => r.id)).toEqual([got.id, sent.id]);
  });

  test('another firm sees none of them', async () => {
    const me = `${RUN}-me2`;
    await mkMessage({ fromRef: me, body: `${RUN} mine` });
    const rows = await listOfficeMessagesForRef(
      '00000000-0000-4000-8000-000000000000',
      me,
      '2000-01-01T00:00:00Z',
    );
    expect(rows).toEqual([]);
  });

  test('a ref that is not slug-shaped is refused, not escaped into the filter', async () => {
    expect(await listOfficeMessagesForRef(tenantId, 'a,from_ref.neq.x', '2000-01-01T00:00:00Z')).toEqual([]);
  });
});
