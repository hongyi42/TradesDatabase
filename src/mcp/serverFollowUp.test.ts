import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client as PgClient } from 'pg';

// A LOOKUP FAILURE MUST NEVER FAIL A NOTE THAT LANDED.
//
// `openQuestionsFor` swallows, and `src/mcp/server.test.ts` proves that against a
// REAL database error — but only by calling the helper directly. That leaves one
// mutation alive: delete the helper and inline an unguarded read in `commitNote`.
// The note is already in undeletable L1 by then, so the technician would be told
// their note did not land when it permanently did — and they would re-send it.
//
// The failure is not injectable through the tool with real inputs (`technicianId`
// is the badge's own roster uuid, `jobId` is minted by the write path, and a
// malformed jsonb context makes `->>` return NULL rather than raise), so this
// file stubs the ONE db function and drives the REAL tool over the REAL local
// stack. It lives in its own file because `vi.mock` is module-registry-wide:
// server.test.ts needs the genuine function.
vi.mock('../db/nudges.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/nudges.js')>()),
  listAskedNudgesForTechnicianJob: vi.fn().mockRejectedValue(new Error('nudges read is down')),
}));

const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let customerId: string;

beforeAll(async () => {
  await pg.connect();
  const { getClient } = await import('../db/client.js');
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  const { createCustomer } = await import('../db/customers.js');
  const { createJob } = await import('../db/jobs.js');
  const c = await createCustomer({ tenantId, name: 'Follow-up Failure Customer' });
  customerId = c.id;
  await createJob({ tenantId, customerId, title: 'Follow-up failure job' });
  // A REAL roster row is mandatory: without one the badge is roster-less,
  // `openQuestionsFor` fails closed before it ever queries, and this test would
  // pass while proving nothing.
  await pg.query(
    `insert into technicians (tenant_id, ref, display_name, tier, state, seat_exempt)
     values ($1, 'followup-fail-tech', 'Follow-up Fail Tech', 'technician', 'active', true)
     on conflict (tenant_id, ref) do update set state = 'active'`,
    [tenantId],
  );
});
afterAll(async () => {
  // The trips this note minted must go FIRST. Rung 9b gave a reported visit a
  // real technician foreign key (the per-note table carried a free TEXT name,
  // which referenced nothing), so deleting the roster row while its visits
  // stand now raises 23503. Rung 9c moved that key onto `visit_participants`,
  // so the reach is through the crew list; visit_notes and participant rows
  // both cascade with their visit.
  await pg.query(
    `delete from visits v
      where v.tenant_id = $1
        and exists (
          select 1 from visit_participants p
            join technicians t on t.id = p.technician_id
           where p.visit_id = v.id
             and t.tenant_id = $1
             and t.ref = 'followup-fail-tech'
        )`,
    [tenantId],
  );
  await pg.query(`delete from technicians where tenant_id = $1 and ref = 'followup-fail-tech'`, [
    tenantId,
  ]);
  await pg.end();
});

describe('record_field_note — a broken gap lookup never costs the note', () => {
  test('the note still reports recorded, with no openQuestions', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { dispatchForIdentity } = await import('./server.js');
    const out = (await dispatchForIdentity(
      'record_field_note',
      { text: 'bled the radiators and rechecked the pressure', confirmed: { customerId } },
      { tenantId, technicianRef: 'followup-fail-tech' },
      { extract: async () => ({ workPerformed: 'did the work' }) },
    )) as { status: string; captureId: string; openQuestions?: unknown };

    // The whole property: the write landed and was reported as landed.
    expect(out.status).toBe('recorded');
    expect(out.captureId).toBeTruthy();
    expect(out.openQuestions).toBeUndefined();
    // Both readers of that query swallowed — attribution and the follow-up.
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();

    // Cross-check the capture is genuinely on the record, not just claimed.
    const { rows } = await pg.query<{ id: string }>(
      'select id from raw_captures where id = $1',
      [out.captureId],
    );
    expect(rows).toHaveLength(1);
  });
});
