import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { createCustomer } from '../db/customers.js';
import { listJobsForCustomer } from '../db/jobs.js';
import { ingestEmail, type Email } from './ingest.js';
import type { WorkClassifier } from './classify.js';
import type { Extractor } from '../writePath/extract.js';

// Hermetic integration test: stub the fetcher, classifier, and extractor so no
// Gmail/model calls happen. Verifies non-work mail is dropped and work mail flows
// through the same write-path (L1 channel='email' + L2 on a match).
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').order('created_at', { ascending: true }).limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query(
    'truncate table schedule_entries, customers, jobs, visits, raw_captures, dropped_audit, ' +
      'observations, job_captures cascade',
  );
  await pg.end();
});

const emails: Email[] = [
  { id: 'e1', from: 'jane@homeowner.com', subject: 'AC repair follow-up', body: 'unit still noisy' },
  { id: 'e2', from: 'deals@newsletter.com', subject: '50% OFF sale', body: 'shop now' },
];

async function emailCaptureCount(): Promise<number> {
  const { rows } = await pg.query<{ n: string }>(
    "select count(*)::int as n from raw_captures where channel = 'email'",
  );
  return Number(rows[0].n);
}

// Non-work = anything from a "newsletter" sender.
const stubClassify: WorkClassifier = async (email) => ({
  isWork: !email.from.includes('newsletter'),
  reason: 'stub',
});

describe('ingestEmail', () => {
  test('drops non-work mail and routes work mail through the write-path (L1 email + L2 on match)', async () => {
    // Seed a customer the work email will match on (by phone).
    const customer = await createCustomer({ tenantId, name: 'Email Match', phone: '555-9001' });
    const stubExtract: Extractor = async () => ({ phone: '555-9001', workPerformed: 'noisy AC' });

    const result = await ingestEmail(tenantId, 'tech-email', {
      fetch: async () => emails,
      classify: stubClassify,
      extract: stubExtract,
    });

    expect(result).toEqual({ ingested: 1, skipped: 1 });

    // Cross-channel read-back: exactly one L1 capture, channel 'email'.
    const caps = await pg.query<{ n: string }>(
      "select count(*)::int as n from raw_captures where channel = 'email'",
    );
    expect(Number(caps.rows[0].n)).toBe(1);

    // The work email matched the customer → and since RUNG 10 that is where it
    // stops: an inbound capture never creates a job. The manager is asked
    // instead, through an observation the planner is called about. (This pull
    // path is dead code with no production caller and goes in the same change;
    // the assertion is corrected rather than deleted so the file stays honest
    // until it does.)
    const jobs = await listJobsForCustomer(customer.id);
    expect(jobs.length).toBe(0);
    const asked = await pg.query<{ kind: string }>(
      `select o.kind from observations o
         join raw_captures c on c.id::text = o.subject_ref
        where c.tenant_id = $1 and c.external_id = 'e1'`,
      [tenantId],
    );
    expect(asked.rows.map((r) => r.kind)).toEqual(['inbound_new_job']);

    // The dropped newsletter left a CONTENT-FREE audit receipt: domain + external_id
    // only, no body/subject stored (the email itself was never persisted).
    const audit = await pg.query<{ external_id: string | null; sender_domain: string | null }>(
      'select external_id, sender_domain from dropped_audit where tenant_id = $1',
      [tenantId],
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].external_id).toBe('e2'); // the newsletter message id
    expect(audit.rows[0].sender_domain).toBe('newsletter.com'); // domain only
  });

  test('re-ingesting the same Gmail message ids does not duplicate L1 rows (externalId dedup)', async () => {
    const dedupEmails: Email[] = [
      { id: 'dedup-msg-1', from: 'owner@home.com', subject: 'Furnace', body: 'no heat' },
    ];
    const stubExtract: Extractor = async () => ({ workPerformed: 'no heat' });
    const deps = { fetch: async () => dedupEmails, classify: stubClassify, extract: stubExtract };

    const before = await emailCaptureCount();
    await ingestEmail(tenantId, 'tech-email', deps);
    const afterFirst = await emailCaptureCount();
    expect(afterFirst).toBe(before + 1);

    // Second run over the SAME message id (the overlapping newer_than:7d window) — the
    // load-bearing assertion: the L1 email count is unchanged, so no duplicate row.
    // (result.ingested is incremented unconditionally and proves nothing on its own.)
    await ingestEmail(tenantId, 'tech-email', deps);
    expect(await emailCaptureCount()).toBe(afterFirst);
  });
});
