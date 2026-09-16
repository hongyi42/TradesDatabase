import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { captureHasLinkedL2, listCapturesByThread, appendRawCapture } from './rawCaptures.js';
import { createCustomer } from './customers.js';
import { createJob, insertJobCapture } from './jobs.js';

// The redelivery marker and the thread fallback. The evidence, activity and
// citing readers that used to be tested here moved onto the capture membership
// (retrieval layer plan 3) — their tests live in captureMembership.test.ts.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let jobA: string;

const after = '2026-08-16T13:00:00.000Z';

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  const c = await createCustomer({ tenantId, name: 'Evidence Job A Customer' });
  jobA = (await createJob({ tenantId, customerId: c.id, title: 'Evidence Job A' })).id;
});

afterAll(async () => {
  // The house pattern for L1-touching suites (context.test.ts): TRUNCATE, because
  // raw_captures is append-only by trigger — DELETE is refused, and so is the
  // `on delete set null` UPDATE that removing a referenced job would need.
  // vitest runs test FILES sequentially (fileParallelism: false) for exactly this.
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
  await pg.end();
});

// INSERTED DIRECTLY, not through appendRawCapture: captured_at defaults to now()
// and is not a writable input, and the append-only trigger refuses the UPDATE
// that would fix it afterwards. The trigger blocks UPDATE and DELETE, never
// INSERT, so a fixture may name its own timestamp — which every bound in this
// file depends on.
async function capture(opts: {
  tenantId: string;
  jobId?: string | null;
  text: string;
  at: string;
  sensitivity?: string | null;
  retracts?: string | null;
}): Promise<{ id: string }> {
  const { rows } = await pg.query<{ id: string }>(
    `insert into raw_captures
       (tenant_id, channel, raw_text, technician_ref, job_id, captured_at, sensitivity, retracts_capture_id)
     values ($1, 'technician_note', $2, 'evidence-tech', $3, $4, $5, $6)
     returning id`,
    [
      opts.tenantId,
      opts.text,
      opts.jobId ?? null,
      opts.at,
      opts.sensitivity ?? null,
      opts.retracts ?? null,
    ],
  );
  return rows[0];
}

describe('captureHasLinkedL2', () => {
  test('a job link alone marks the capture PROCESSED — the redelivery short-circuit', async () => {
    const linked = await capture({ tenantId, jobId: null, text: 'processed by its link', at: after });
    expect(await captureHasLinkedL2(linked.id)).toBe(false);
    await insertJobCapture({ tenantId, jobId: jobA, captureId: linked.id });
    expect(await captureHasLinkedL2(linked.id)).toBe(true);
  });
});

describe('listCapturesByThread', () => {
  test('listCapturesByThread reads the thread oldest-first, and never a RETRACTED message', async () => {
    // The fallback when Composio cannot hand us the conversation. A retracted
    // capture must not come back: the write-path treats it as terminal precisely
    // so it can never be rebuilt from, and handing its words to the extractor as
    // context would launder them into L2 against the NEW capture.
    const thread = `fallback-${Date.now()}`;
    // Appended WITH their metadata: L1 is append-only, so there is no later
    // update that could add it — which is the whole reason the thread id had to
    // be captured at the door in the first place.
    let msg = 0;
    const onThread = async (text: string) =>
      await appendRawCapture({
        tenantId,
        channel: 'email',
        technicianRef: 'connector:gmail',
        rawText: text,
        externalId: `${thread}-m${msg++}`,
        metadata: { threadId: thread, from: 'jane@home.test' },
      });
    await onThread('my number is 555-0199');
    await onThread('and my gate code is 4412');
    const bad = await onThread('personal, recorded in error');
    await appendRawCapture({
      tenantId,
      channel: 'manual_correction',
      technicianRef: 'tech-a',
      rawText: 'that one was recorded in error',
      retractsCaptureId: bad.id,
    });
    const read = await listCapturesByThread(tenantId, thread);
    expect(read.messages.map((r) => r.body)).toEqual([
      'my number is 555-0199',
      'and my gate code is 4412',
    ]);
    expect(read.messages[0].from).toBe('jane@home.test');
    // …and the retracted one comes back as something the OTHER source must not
    // show either — Gmail knows nothing of our retractions.
    expect(read.blockedMessageIds).toEqual([bad.external_id]);
  });
});
