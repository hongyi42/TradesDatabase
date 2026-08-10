import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { openCallActionReview } from './reviewItems.js';

// Integration test against the LOCAL stack (testEnvGuard enforces local-only).
// Exercises the call_action review helper's write + the one-open-per-call dedup
// that the worker relies on across retries.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query('truncate table review_items cascade');
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
