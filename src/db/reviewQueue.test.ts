import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createTenant } from './tenants.js';

// review_queue_page (migration 20260917140000_retrieval_layer_schedule.sql), driven
// through the RPC. The manager's review queue used to come back whole, every
// item's full `detail` included; this pins the page: a total keyset order that
// neither repeats nor skips (items minted in one transaction share created_at),
// the kind filter, the withheld oversized detail, and the tenant wall.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let otherTenantId: string;
let emptyTenantId: string;

interface Item {
  id: string;
  kind: string;
  subject_ref: string;
  created_at: string;
  detail: unknown;
  detail_chars: number;
  detail_withheld: boolean;
}
interface Page {
  total: number;
  by_kind: Record<string, number>;
  items: Item[];
  has_more: boolean;
  next_after_created: string | null;
  next_after_id: string | null;
}

const page = async (tenant: string, args: Record<string, unknown> = {}): Promise<Page> => {
  const { data, error } = await getClient().rpc('review_queue_page', { p_tenant: tenant, ...args });
  if (error) throw new Error(error.message);
  return data as unknown as Page;
};

const insertItem = (tenant: string, kind: string, ref: string, createdAt: string, detail: unknown = {}) =>
  pg.query(
    `insert into review_items (tenant_id, kind, subject_ref, detail, created_at)
     values ($1, $2, $3, $4::jsonb, $5::timestamptz) returning id`,
    [tenant, kind, ref, JSON.stringify(detail), createdAt],
  );

beforeAll(async () => {
  await pg.connect();
  tenantId = (await createTenant('rq-tenant', { managerSeats: 1 })).id;
  otherTenantId = (await createTenant('rq-other', { managerSeats: 1 })).id;
  emptyTenantId = (await createTenant('rq-empty', { managerSeats: 1 })).id;
  // 25 open items. Items 10..14 share ONE created_at — the tie the id tiebreak
  // exists for — and 3 are a second kind.
  for (let i = 0; i < 25; i++) {
    const at =
      i >= 10 && i <= 14
        ? '2027-01-01T00:00:10.123456Z'
        : `2027-01-01T00:00:${String(i).padStart(2, '0')}.000001Z`;
    await insertItem(tenantId, i < 3 ? 'call_action' : 'unknown_ref_capture', `rq-${i}`, at);
  }
  // Resolved, and another firm's: neither may ever appear.
  const resolved = await insertItem(tenantId, 'call_action', 'rq-resolved', '2027-01-01T00:00:00Z');
  await pg.query(`update review_items set status = 'resolved' where id = $1`, [resolved.rows[0].id]);
  await insertItem(otherTenantId, 'call_action', 'rq-foreign', '2027-01-01T00:00:00Z');
});

afterAll(async () => {
  for (const t of [tenantId, otherTenantId, emptyTenantId]) {
    await pg.query('delete from review_items where tenant_id = $1', [t]);
    await pg.query('delete from tenants where id = $1', [t]);
  }
  await pg.end();
});

describe('review_queue_page', () => {
  test('an empty queue is empty lists and zero counts, never null', async () => {
    const p = await page(emptyTenantId);
    expect(p.items).toEqual([]);
    expect(p.by_kind).toEqual({});
    expect(p.total).toBe(0);
    expect(p.has_more).toBe(false);
    expect(p.next_after_created).toBeNull();
  });

  test('25 items page as 20 + 5 with no repeat and no gap, across a created_at tie', async () => {
    const first = await page(tenantId);
    expect(first.items).toHaveLength(20);
    expect(first.has_more).toBe(true);
    expect(first.total).toBe(25);
    const second = await page(tenantId, {
      p_after_created: first.next_after_created,
      p_after_id: first.next_after_id,
    });
    expect(second.items).toHaveLength(5);
    expect(second.has_more).toBe(false);
    const refs = [...first.items, ...second.items].map((i) => i.subject_ref);
    expect(new Set(refs).size).toBe(25);
    expect(refs).not.toContain('rq-resolved');
    expect(refs).not.toContain('rq-foreign');
  });

  test('a page boundary INSIDE the tie still neither repeats nor skips', async () => {
    const seen: string[] = [];
    let after: { p_after_created?: string | null; p_after_id?: string | null } = {};
    for (let n = 0; n < 10; n++) {
      const p = await page(tenantId, { ...after, p_limit: 3 });
      seen.push(...p.items.map((i) => i.subject_ref));
      if (!p.has_more) break;
      after = { p_after_created: p.next_after_created, p_after_id: p.next_after_id };
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  test('the kind filter narrows items and total; by_kind still counts every open kind', async () => {
    const p = await page(tenantId, { p_kind: 'call_action' });
    expect(p.items.map((i) => i.kind)).toEqual(['call_action', 'call_action', 'call_action']);
    expect(p.total).toBe(3);
    expect(p.by_kind).toEqual({ call_action: 3, unknown_ref_capture: 22 });
  });

  test('a detail over the limit is withheld whole, with its size; a small one is served', async () => {
    const big = await insertItem(tenantId, 'call_action', 'rq-big', '2027-02-01T00:00:00Z', {
      words: 'x'.repeat(3000),
    });
    const small = await insertItem(tenantId, 'call_action', 'rq-small', '2027-02-01T00:00:01Z', {
      words: 'short',
    });
    try {
      const p = await page(tenantId, { p_kind: 'call_action' });
      const bigItem = p.items.find((i) => i.subject_ref === 'rq-big');
      expect(bigItem?.detail).toBeNull();
      expect(bigItem?.detail_withheld).toBe(true);
      expect(bigItem?.detail_chars).toBeGreaterThan(3000);
      const smallItem = p.items.find((i) => i.subject_ref === 'rq-small');
      expect(smallItem?.detail).toEqual({ words: 'short' });
      expect(smallItem?.detail_withheld).toBe(false);
    } finally {
      await pg.query('delete from review_items where id = any($1::uuid[])', [
        [big.rows[0].id, small.rows[0].id],
      ]);
    }
  });

  test('the limit is clamped to 1..50', async () => {
    expect((await page(tenantId, { p_limit: 0 })).items).toHaveLength(1);
    expect((await page(tenantId, { p_limit: 500 })).items).toHaveLength(25);
  });
});
