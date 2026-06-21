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
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
  await pg.end();
});

const emails: Email[] = [
  { id: 'e1', from: 'jane@homeowner.com', subject: 'AC repair follow-up', body: 'unit still noisy' },
  { id: 'e2', from: 'deals@newsletter.com', subject: '50% OFF sale', body: 'shop now' },
];

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

    // The work email matched the customer → an L2 job was created for them.
    const jobs = await listJobsForCustomer(customer.id);
    expect(jobs.length).toBe(1);
  });
});
