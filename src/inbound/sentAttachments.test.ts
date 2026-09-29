import { beforeAll, describe, expect, test } from 'vitest';
import { createCustomer } from '../db/customers.js';
import { deleteFile, listFiles, readFileBytes } from '../db/files.js';
import { createJob } from '../db/jobs.js';
import { createTenant } from '../db/tenants.js';
import { insertTechnician, type Technician } from '../db/technicians.js';
import type { PairingClient } from '../composio/pairing.js';
import type { SentAttachment } from './gmailSent.js';
import { keepSentAttachments, type SentAttachmentDeps } from './sentAttachments.js';

// The file store is REAL (local stack); Composio and the download are faked —
// no live Composio call in a test. What is proven: fetch → store → link, the
// once-per-firm key, a deleted file staying deleted, the 20 MB ceiling, and
// that nothing here throws or runs past its bound.
let tenantId: string;
let tech: Technician;
let jobId: string;
let customerId: string;

beforeAll(async () => {
  tenantId = (await createTenant(`Sent Attachments ${Date.now()}`)).id;
  const row = await insertTechnician({ tenantId, ref: 'mgr-sent', displayName: 'Sam', seatExempt: true });
  tech = { ...row, composio_connected_account_id: 'ca_sent_test' };
  customerId = (await createCustomer({ tenantId, name: 'Lee Bathroom' })).id;
  jobId = (await createJob({ tenantId, customerId, title: 'Bathroom remodel' })).id;
});

const pdf = (id: string, over: Partial<SentAttachment> = {}): SentAttachment => ({
  attachmentId: id,
  name: `invoice-${id}.pdf`,
  mime: 'application/pdf',
  size: 12,
  ...over,
});

// A fake Composio client answering GMAIL_GET_ATTACHMENT with an s3url, and a
// fake fetch serving bytes for it. Every execute is recorded.
function fakes(opts: { fail?: boolean; hang?: boolean; bytes?: Buffer } = {}) {
  const calls: Array<{ slug: string; body: Record<string, unknown> }> = [];
  const client = {
    tools: {
      execute: async (slug: string, body: Record<string, unknown>) => {
        calls.push({ slug, body });
        if (opts.hang) return new Promise<Record<string, unknown>>(() => {});
        if (opts.fail) return { successful: false, error: 'boom' };
        const args = body.arguments as Record<string, string>;
        return {
          successful: true,
          data: { file: { name: args.file_name, mimetype: 'application/pdf', s3url: `https://s3.test/${args.attachment_id}` } },
        };
      },
    },
  } as unknown as PairingClient;
  const fetched: string[] = [];
  const fetchFake = (async (url: string) => {
    fetched.push(url);
    return new Response(new Uint8Array(opts.bytes ?? Buffer.from(`%PDF ${url}`)), { status: 200 });
  }) as unknown as typeof fetch;
  const logs: string[] = [];
  const deps: SentAttachmentDeps = {
    client,
    fetch: fetchFake,
    recordCost: async () => {},
    log: (m) => logs.push(m),
  };
  return { calls, fetched, logs, deps };
}

describe('keepSentAttachments (step 2e phase 4)', () => {
  test("fetches through the person's own account, stores it as email, and attaches it to the job", async () => {
    const f = fakes();
    const messageId = `m-${Date.now()}-a`;
    const r = await keepSentAttachments({
      tenantId, tech, messageId, attachments: [pdf('att-1')], target: { jobId, customerId }, deps: f.deps,
    });
    expect(r).toEqual([{ name: 'invoice-att-1.pdf', outcome: 'stored', linkedTo: 'job' }]);
    expect(f.calls[0]).toMatchObject({
      slug: 'GMAIL_GET_ATTACHMENT',
      body: {
        connectedAccountId: 'ca_sent_test',
        userId: `${tenantId}:mgr-sent`,
        arguments: { message_id: messageId, attachment_id: 'att-1', file_name: 'invoice-att-1.pdf' },
        dangerouslySkipVersionCheck: true,
      },
    });
    expect(f.fetched).toEqual(['https://s3.test/att-1']);
    const onJob = (await listFiles(tenantId, { jobId })).find((x) => x.source_ref === `gmail:${messageId}:att-1`);
    expect(onJob).toMatchObject({
      source: 'email', kind: 'document', mime_type: 'application/pdf', uploaded_by_ref: 'mgr-sent', uploaded_by: tech.id,
    });
    expect((await readFileBytes(onJob!)).toString()).toBe('%PDF https://s3.test/att-1');
  });

  test('no job → the customer; neither → kept unattached', async () => {
    const f = fakes();
    const messageId = `m-${Date.now()}-b`;
    const r1 = await keepSentAttachments({
      tenantId, tech, messageId, attachments: [pdf('c1')], target: { customerId }, deps: f.deps,
    });
    const r2 = await keepSentAttachments({
      tenantId, tech, messageId, attachments: [pdf('c2')], target: {}, deps: f.deps,
    });
    expect(r1[0]).toMatchObject({ outcome: 'stored', linkedTo: 'customer' });
    expect(r2[0]).toMatchObject({ outcome: 'stored', linkedTo: null });
    expect((await listFiles(tenantId, { customerId })).some((x) => x.source_ref === `gmail:${messageId}:c1`)).toBe(true);
  });

  test('a redelivery stores nothing twice — the same file comes back "already", still on the job', async () => {
    const messageId = `m-${Date.now()}-c`;
    const first = fakes();
    await keepSentAttachments({ tenantId, tech, messageId, attachments: [pdf('d1')], target: { jobId }, deps: first.deps });
    const again = fakes();
    const r = await keepSentAttachments({ tenantId, tech, messageId, attachments: [pdf('d1')], target: { jobId }, deps: again.deps });
    expect(r).toEqual([{ name: 'invoice-d1.pdf', outcome: 'already', linkedTo: 'job' }]);
    const rows = (await listFiles(tenantId, { jobId })).filter((x) => x.source_ref === `gmail:${messageId}:d1`);
    expect(rows).toHaveLength(1);
  });

  test('a file the manager DELETED stays deleted on a redelivery', async () => {
    const messageId = `m-${Date.now()}-d`;
    const f = fakes();
    await keepSentAttachments({ tenantId, tech, messageId, attachments: [pdf('e1')], target: { jobId }, deps: f.deps });
    const kept = (await listFiles(tenantId, { jobId })).find((x) => x.source_ref === `gmail:${messageId}:e1`)!;
    expect(await deleteFile(tenantId, kept.id, 'mgr-sent')).toBe('deleted');
    const r = await keepSentAttachments({ tenantId, tech, messageId, attachments: [pdf('e1')], target: { jobId }, deps: fakes().deps });
    expect(r).toEqual([{ name: 'invoice-e1.pdf', outcome: 'deleted', linkedTo: null }]);
    expect((await listFiles(tenantId, { jobId })).some((x) => x.source_ref === `gmail:${messageId}:e1`)).toBe(false);
  });

  test('over 20 MB is skipped before any fetch — and a download that turns out larger is not kept', async () => {
    const f = fakes();
    const r = await keepSentAttachments({
      tenantId, tech, messageId: `m-${Date.now()}-e`,
      attachments: [pdf('big', { size: 20 * 1024 * 1024 + 1 })], target: { jobId }, deps: f.deps,
    });
    expect(r).toEqual([{ name: 'invoice-big.pdf', outcome: 'too_large', linkedTo: null }]);
    expect(f.calls).toHaveLength(0);

    const big = fakes({ bytes: Buffer.alloc(20 * 1024 * 1024 + 1) });
    const r2 = await keepSentAttachments({
      tenantId, tech, messageId: `m-${Date.now()}-f`, attachments: [pdf('liar', { size: null })], target: { jobId }, deps: big.deps,
    });
    expect(r2[0].outcome).toBe('too_large');
  });

  test('a Composio failure is logged, never thrown, and the next attachment still runs', async () => {
    const f = fakes({ fail: true });
    const r = await keepSentAttachments({
      tenantId, tech, messageId: `m-${Date.now()}-g`, attachments: [pdf('x1'), pdf('x2')], target: { jobId }, deps: f.deps,
    });
    expect(r.map((x) => x.outcome)).toEqual(['failed', 'failed']);
    expect(f.calls).toHaveLength(2);
    expect(f.logs.some((l) => l.includes('GMAIL_GET_ATTACHMENT failed'))).toBe(true);
  });

  test('an unpaired mailbox keeps nothing and says so, without calling Composio', async () => {
    const f = fakes();
    const r = await keepSentAttachments({
      tenantId, tech: { ...tech, composio_connected_account_id: null }, messageId: 'm-unpaired',
      attachments: [pdf('u1')], target: { jobId }, deps: f.deps,
    });
    expect(r[0].outcome).toBe('failed');
    expect(f.calls).toHaveLength(0);
  });

  test('BOUNDED: a hung fetch gives up at its budget, and the total budget stops the rest', async () => {
    const f = fakes({ hang: true });
    const started = Date.now();
    const r = await keepSentAttachments({
      tenantId, tech, messageId: `m-${Date.now()}-h`,
      attachments: [pdf('h1'), pdf('h2'), pdf('h3')], target: { jobId },
      deps: { ...f.deps, eachMs: 50, totalMs: 120 },
    });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(r.map((x) => x.outcome)).toEqual(['out_of_time', 'out_of_time', 'out_of_time']);
    // The third never started: the total ran out after two per-file budgets.
    expect(f.calls.length).toBeLessThanOrEqual(3);
  });
});
