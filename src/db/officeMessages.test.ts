import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import {
  claimOfficeMessagePing,
  claimOfficeMessagesForTick,
  createOfficeMessage,
  hasFreshUnpingedOfficeMessage,
  listDeskTranscriptsSince,
  listOfficeReadSince,
  listUnpingedOfficeMessages,
  PINGED_MESSAGE_KINDS,
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
// A second firm, for the tenant-scoped claim and read (the costs.test.ts shape).
let tenantB: string;
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
  const other = await pg.query<{ id: string }>(
    'insert into tenants (name) values ($1) returning id',
    [`${RUN}-tenant-b`],
  );
  tenantB = other.rows[0].id;
});

afterAll(async () => {
  if (createdIds.length > 0) {
    await pg.query('delete from office_messages where id = any($1::uuid[])', [createdIds]);
  }
  await pg.query('delete from technicians where id = $1', [technicianId]);
  await pg.query('delete from office_messages where tenant_id = $1', [tenantB]);
  await pg.query('delete from tenants where id = $1', [tenantB]);
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

// Rung 10c: the claim column. A message's claim is `pinged_at`, a lease the
// tick can take back — never a read marker.
describe('the office message claim (rung 10c)', () => {
  const setPinged = (id: string, iso: string | null) =>
    pg.query('update office_messages set pinged_at = $2 where id = $1', [id, iso]);
  const minsAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();
  // The reader is FLEET-WIDE, so other suites' rows may be in the result; every
  // assertion looks only at this run's ids.
  const mine = (rows: { id: string }[], ids: string[]) =>
    rows.map((r) => r.id).filter((id) => ids.includes(id));

  test('only inform wakes', () => {
    expect(PINGED_MESSAGE_KINDS).toEqual(['inform']);
  });

  test('the reader returns unread, unclaimed informs oldest first, and nothing else', async () => {
    const first = await mkMessage({ body: `${RUN} ping first` });
    const second = await mkMessage({ body: `${RUN} ping second` });
    const reply = await mkMessage({ kind: 'reply', body: `${RUN} a reply` });
    const ask = await mkMessage({ kind: 'ask', body: `${RUN} an ask` });
    const news = await mkMessage({ kind: 'news', fromRef: 'mgr', tier: 'manager', body: `${RUN} granted` });
    const read = await mkMessage({ body: `${RUN} read` });
    await markOfficeMessagesRead(tenantId, [read.id], new Date().toISOString());
    const pinged = await mkMessage({ body: `${RUN} pinged` });
    await setPinged(pinged.id, new Date().toISOString());

    const ids = [first.id, second.id, reply.id, ask.id, news.id, read.id, pinged.id];
    const got = await listUnpingedOfficeMessages(PINGED_MESSAGE_KINDS, 1000);
    expect(mine(got, ids)).toEqual([first.id, second.id]);
    expect(await listUnpingedOfficeMessages([], 10)).toEqual([]);
  });

  test('access news never wakes, but the tick still reads it unread', async () => {
    const news = await mkMessage({ kind: 'news', fromRef: 'mgr', tier: 'manager', body: `${RUN} revoked` });
    expect(news.kind).toBe('news');
    expect(mine(await listUnpingedOfficeMessages(PINGED_MESSAGE_KINDS, 1000), [news.id])).toEqual([]);
    const unread = await listOfficeMessagesByStatus(tenantId, 'to_planner', ['unread']);
    expect(unread.some((m) => m.id === news.id)).toBe(true);
  });

  test('the first claim wins, the second gets null, and a read row cannot be claimed', async () => {
    const row = await mkMessage({ body: `${RUN} claim me` });
    const won = await claimOfficeMessagePing(row.id);
    expect(won?.id).toBe(row.id);
    expect(won?.pinged_at).not.toBeNull();
    expect(await claimOfficeMessagePing(row.id)).toBeNull();

    const read = await mkMessage({ body: `${RUN} already read` });
    await markOfficeMessagesRead(tenantId, [read.id], new Date().toISOString());
    expect(await claimOfficeMessagePing(read.id)).toBeNull();
    const { rows } = await pg.query('select pinged_at from office_messages where id = $1', [read.id]);
    expect(rows[0].pinged_at).toBeNull();
  });

  test('the tick takes an unclaimed row and a stale claim, and leaves a live claim', async () => {
    const free = await mkMessage({ body: `${RUN} free` });
    const stale = await mkMessage({ body: `${RUN} stale` });
    await setPinged(stale.id, minsAgo(20));
    const live = await mkMessage({ body: `${RUN} live` });
    await setPinged(live.id, minsAgo(1));
    const read = await mkMessage({ body: `${RUN} read` });
    await markOfficeMessagesRead(tenantId, [read.id], new Date().toISOString());

    const moved = await claimOfficeMessagesForTick(
      tenantId,
      [free.id, stale.id, live.id, read.id],
      minsAgo(10),
    );
    expect(moved.sort()).toEqual([free.id, stale.id].sort());
    const { rows } = await pg.query(
      'select id, pinged_at from office_messages where id = any($1::uuid[])',
      [[stale.id, live.id]],
    );
    const at = Object.fromEntries(rows.map((r) => [r.id, new Date(r.pinged_at).getTime()]));
    expect(at[stale.id]).toBeGreaterThan(Date.now() - 60_000); // re-stamped
    expect(at[live.id]).toBeLessThan(Date.now() - 30_000); // untouched
    expect(await claimOfficeMessagesForTick(tenantId, [], minsAgo(10))).toEqual([]);
  });

  test("another firm's tick claims nothing of this firm's", async () => {
    const row = await mkMessage({ body: `${RUN} not yours` });
    expect(await claimOfficeMessagesForTick(tenantB, [row.id], minsAgo(10))).toEqual([]);
    const { rows } = await pg.query('select pinged_at from office_messages where id = $1', [row.id]);
    expect(rows[0].pinged_at).toBeNull();
  });

  test('the heartbeat probe respects its window and ignores an ask', async () => {
    // The probe is a fleet-wide boolean, so any unclaimed inform another file
    // left behind would answer it. Claim those first (local stack, files run
    // sequentially — see vitest.config.ts) so the answer is about this test's rows.
    await pg.query(
      "update office_messages set pinged_at = now() where direction = 'to_planner' and status = 'unread' and pinged_at is null and kind = 'inform'",
    );
    const ask = await mkMessage({ kind: 'ask', body: `${RUN} probe ask` });
    expect(ask.kind).toBe('ask');
    expect(await hasFreshUnpingedOfficeMessage(PINGED_MESSAGE_KINDS, minsAgo(5))).toBe(false);
    const inform = await mkMessage({ body: `${RUN} probe inform` });
    expect(await hasFreshUnpingedOfficeMessage(PINGED_MESSAGE_KINDS, minsAgo(5))).toBe(true);
    // A window that starts after the row was written does not see it.
    const later = new Date(Date.parse(inform.created_at) + 60_000).toISOString();
    expect(await hasFreshUnpingedOfficeMessage(PINGED_MESSAGE_KINDS, later)).toBe(false);
    expect(await hasFreshUnpingedOfficeMessage([], minsAgo(5))).toBe(false);
  });

  test("the already-read read returns read informs and replies since the cutoff, this firm's only", async () => {
    const since = new Date(Date.now() - 1000).toISOString();
    const inform = await mkMessage({ body: `${RUN} read inform` });
    const reply = await mkMessage({ kind: 'reply', body: `${RUN} read reply` });
    const ask = await mkMessage({ kind: 'ask', body: `${RUN} read ask` });
    const unread = await mkMessage({ body: `${RUN} still unread` });
    const theirs = await createOfficeMessage({
      tenantId: tenantB, direction: 'to_planner', kind: 'inform', fromRef: `${RUN}-b`,
      toRef: 'spine:team-lead', body: `${RUN} theirs`,
    });
    const nowIso = new Date().toISOString();
    await markOfficeMessagesRead(tenantId, [inform.id, reply.id, ask.id], nowIso);
    await markOfficeMessagesRead(tenantB, [theirs.id], nowIso);

    const got = await listOfficeReadSince(tenantId, since, 1000);
    const ids = [inform.id, reply.id, ask.id, unread.id, theirs.id];
    expect(mine(got, ids).sort()).toEqual([inform.id, reply.id].sort());
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(mine(await listOfficeReadSince(tenantId, future, 1000), ids)).toEqual([]);
  });
});
