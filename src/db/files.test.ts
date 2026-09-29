import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer } from './customers.js';
import { FILES_BUCKET } from './fileStore.js';
import {
  type FileRow,
  type FileViewer,
  type ResolvedLink,
  createFile,
  deleteFile,
  fileVisibleTo,
  getFile,
  linkFile,
  linksOf,
  listFiles,
  readFileBytes,
  targetVisibleTo,
} from './files.js';
import { createJob } from './jobs.js';
import { appendMoneyEvent } from './moneyEvents.js';
import { createTenant } from './tenants.js';
import type { TechnicianView } from './technicianView.js';
import { createVisit } from './visits.js';

// The FIRST suite to touch real Supabase Storage (the local stack runs it).
// Writes go through the app path; direct pg and a Storage list are the
// independent read-back channels.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let otherTenantId: string;

const bytesOf = (s: string) => Buffer.from(s, 'utf8');
const objectExists = async (path: string): Promise<boolean> => {
  const [dir, name] = path.split('/');
  const { data, error } = await getClient().storage.from(FILES_BUCKET).list(dir, { search: name });
  if (error) throw error;
  return (data ?? []).some((o) => o.name === name);
};
const newFile = (over: Partial<Parameters<typeof createFile>[0]> = {}) =>
  createFile({
    tenantId,
    kind: 'photo',
    fileName: 'before.jpg',
    mimeType: 'image/jpeg',
    bytes: bytesOf('jpeg bytes'),
    uploadedByRef: 'tech-a',
    uploadedBy: null,
    source: 'telegram',
    ...over,
  });

beforeAll(async () => {
  await pg.connect();
  tenantId = (await createTenant(`Files Tenant ${Date.now()}`)).id;
  otherTenantId = (await createTenant(`Files Other ${Date.now()}`)).id;
});

afterAll(async () => {
  await pg.end();
});

describe('the file store (step 2d)', () => {
  test('create → get → bytes round trip; the object sits at <tenant>/<id>', async () => {
    const f = await newFile({ bytes: bytesOf('hello photo') });
    expect(f.storage_path).toBe(`${tenantId}/${f.id}`);
    expect(f.size_bytes).toBe(11);
    expect((await getFile(tenantId, f.id))?.file_name).toBe('before.jpg');
    expect((await readFileBytes(f)).toString('utf8')).toBe('hello photo');
    expect(await objectExists(f.storage_path)).toBe(true);
  });

  test('empty and oversized files are refused', async () => {
    await expect(newFile({ bytes: Buffer.alloc(0) })).rejects.toThrow('empty');
    await expect(newFile({ bytes: Buffer.alloc(20 * 1024 * 1024 + 1) })).rejects.toThrow('20 MB');
  });

  test('link to customer / job / visit / ledger entry; list per target; a repeat link is "already"', async () => {
    const cust = await createCustomer({ tenantId, name: 'File Cust' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'Bathroom' });
    const visit = await createVisit({ tenantId, jobId: job.id, startsAt: null, endsAt: null });
    const money = await appendMoneyEvent({ tenantId, jobId: job.id, kind: 'estimate_presented', amountCents: 420000 });
    const f = await newFile();
    expect(await linkFile(tenantId, f.id, { jobId: job.id }, 'mgr')).toBe('linked');
    expect(await linkFile(tenantId, f.id, { jobId: job.id }, 'mgr')).toBe('already');
    expect(await linkFile(tenantId, f.id, { visitId: visit.id }, 'mgr')).toBe('linked');
    expect(await linkFile(tenantId, f.id, { customerId: cust.id }, 'mgr')).toBe('linked');
    expect(await linkFile(tenantId, f.id, { moneyEventId: money.id }, 'mgr')).toBe('linked');
    for (const t of [{ jobId: job.id }, { visitId: visit.id }, { customerId: cust.id }, { moneyEventId: money.id }]) {
      expect((await listFiles(tenantId, t)).map((r) => r.id)).toEqual([f.id]);
    }
    const links = await linksOf(tenantId, f.id);
    expect(links.map((l) => l.kind).sort()).toEqual(['customer', 'job', 'money', 'visit']);
    expect(links.find((l) => l.kind === 'visit')).toMatchObject({ jobId: job.id, customerId: cust.id });
    expect(links.find((l) => l.kind === 'money')).toMatchObject({ jobId: job.id, customerId: cust.id });
  });

  test('tenant guard: another firm’s file or target reads as not found', async () => {
    const foreignCust = await createCustomer({ tenantId: otherTenantId, name: 'Foreign' });
    const f = await newFile();
    await expect(linkFile(tenantId, f.id, { customerId: foreignCust.id }, 'mgr')).rejects.toThrow('target not found');
    expect(await getFile(otherTenantId, f.id)).toBeNull();
    await expect(linkFile(otherTenantId, f.id, { customerId: foreignCust.id }, 'mgr')).rejects.toThrow('file not found');
  });

  test('the database refuses a link with no target or two', async () => {
    const f = await newFile();
    const cust = await createCustomer({ tenantId, name: 'Two Targets' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'J' });
    await expect(
      pg.query('insert into file_links (tenant_id, file_id, linked_by_ref) values ($1, $2, $3)', [tenantId, f.id, 'x']),
    ).rejects.toThrow(/file_links_one_target/);
    await expect(
      pg.query(
        'insert into file_links (tenant_id, file_id, customer_id, job_id, linked_by_ref) values ($1, $2, $3, $4, $5)',
        [tenantId, f.id, cust.id, job.id, 'x'],
      ),
    ).rejects.toThrow(/file_links_one_target/);
  });

  test('delete stamps the row, removes the bytes, hides it; a second delete is "already"', async () => {
    const cust = await createCustomer({ tenantId, name: 'Delete Cust' });
    const f = await newFile();
    await linkFile(tenantId, f.id, { customerId: cust.id }, 'mgr');
    expect(await deleteFile(tenantId, f.id, 'mgr')).toBe('deleted');
    const row = (await pg.query('select deleted_at, deleted_by_ref from files where id = $1', [f.id])).rows[0];
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_by_ref).toBe('mgr');
    expect(await objectExists(f.storage_path)).toBe(false);
    expect(await listFiles(tenantId, { customerId: cust.id })).toEqual([]);
    await expect(linkFile(tenantId, f.id, { customerId: cust.id }, 'mgr')).rejects.toThrow('file not found');
    expect(await deleteFile(tenantId, f.id, 'mgr')).toBe('already');
    expect(await deleteFile(otherTenantId, f.id, 'mgr')).toBe('not_found');
  });

  test('deleting a job drops its links and keeps the file (a link never pins L2)', async () => {
    const cust = await createCustomer({ tenantId, name: 'Cascade Cust' });
    const job = await createJob({ tenantId, customerId: cust.id, title: 'Doomed' });
    const f = await newFile();
    await linkFile(tenantId, f.id, { jobId: job.id }, 'mgr');
    await pg.query('delete from jobs where id = $1', [job.id]);
    expect(Number((await pg.query('select count(*) n from file_links where file_id = $1', [f.id])).rows[0].n)).toBe(0);
    expect(await getFile(tenantId, f.id)).not.toBeNull();
  });
});

describe('who may see a file (fileVisibleTo)', () => {
  const view = (over: Partial<TechnicianView> = {}): TechnicianView => ({
    allScope: false,
    jobIds: new Set(['job-in']),
    customerIds: new Set(['cust-in']),
    moneyAll: false,
    moneyJobIds: new Set(),
    moneyCustomerIds: new Set(),
    ...over,
  });
  const tech = (v: TechnicianView = view()): FileViewer => ({ tier: 'technician', ref: 'tech-b', personId: 'p-b', view: v });
  const file = (over: Partial<FileRow> = {}): FileRow =>
    ({ uploaded_by: 'p-a', uploaded_by_ref: 'tech-a', deleted_at: null, ...over }) as FileRow;
  const job = (id: string, customerId = 'cust-x'): ResolvedLink => ({ kind: 'job', jobId: id, customerId });
  const visit = (jobId: string): ResolvedLink => ({ kind: 'visit', jobId, customerId: 'cust-x' });
  const cust = (id: string): ResolvedLink => ({ kind: 'customer', jobId: null, customerId: id });
  const money = (jobId: string, customerId = 'cust-x'): ResolvedLink => ({ kind: 'money', jobId, customerId });

  test('managers and the planner see every live file, none deleted', () => {
    for (const tier of ['manager', 'planner'] as const) {
      const who: FileViewer = { tier, ref: 'm', personId: null, view: null };
      expect(fileVisibleTo(file(), [], who)).toBe(true);
      expect(fileVisibleTo(file({ deleted_at: '2026-09-28' }), [], who)).toBe(false);
    }
  });

  test('a technician: her own upload, job/visit/customer in view, never out of view', () => {
    expect(fileVisibleTo(file({ uploaded_by: 'p-b' }), [], tech())).toBe(true);
    expect(fileVisibleTo(file({ uploaded_by: null, uploaded_by_ref: 'tech-b' }), [], tech())).toBe(true);
    expect(fileVisibleTo(file(), [], tech())).toBe(false); // someone else's unlinked file
    expect(fileVisibleTo(file(), [job('job-in')], tech())).toBe(true);
    expect(fileVisibleTo(file(), [job('job-out')], tech())).toBe(false);
    expect(fileVisibleTo(file(), [visit('job-in')], tech())).toBe(true);
    expect(fileVisibleTo(file(), [visit('job-out')], tech())).toBe(false);
    expect(fileVisibleTo(file(), [cust('cust-in')], tech())).toBe(true);
    expect(fileVisibleTo(file(), [cust('cust-out')], tech())).toBe(false);
    expect(fileVisibleTo(file(), [job('job-out'), job('job-in')], tech())).toBe(true); // any one link
    expect(fileVisibleTo(file(), [job('anything')], tech(view({ allScope: true })))).toBe(true);
    expect(fileVisibleTo(file({ uploaded_by: 'p-b', deleted_at: 'x' }), [], tech())).toBe(false);
  });

  test('money files need the job in view AND money open', () => {
    expect(targetVisibleTo(money('job-in'), tech())).toBe(false);
    expect(targetVisibleTo(money('job-in'), tech(view({ moneyAll: true })))).toBe(true);
    expect(targetVisibleTo(money('job-in'), tech(view({ moneyJobIds: new Set(['job-in']) })))).toBe(true);
    expect(targetVisibleTo(money('job-in', 'cust-g'), tech(view({ moneyCustomerIds: new Set(['cust-g']) })))).toBe(true);
    expect(targetVisibleTo(money('job-out'), tech(view({ moneyAll: true })))).toBe(false);
    expect(targetVisibleTo(job('job-out'), { tier: 'technician', ref: 'x', personId: null, view: null })).toBe(false);
  });
});
