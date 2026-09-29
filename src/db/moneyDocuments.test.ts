import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createCustomer } from './customers.js';
import { createJob, getJob, type JobStatus } from './jobs.js';
import {
  getDocument,
  issueDocument,
  listDocuments,
  normalizeLines,
  recordEstimateOutcome,
  saveDraft,
  voidDocument,
  type MoneyDocumentKind,
} from './moneyDocuments.js';
import { appendMoneyEvent, listMoneyEventsForJob, summarizeMoney, syncJobStatusForMoney } from './moneyEvents.js';
import { upsertTenantProfile } from './tenantProfiles.js';
import { createTenant } from './tenants.js';

// Invoices and estimates as records (step 2e, Phase 1). Writes go through the
// typed layer; direct pg is the independent read-back channel. Each numbering
// test mints its OWN firm, so INV-1001 means "this firm's first", whatever else
// the suite has issued.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let otherTenantId: string;

const LINES = [
  { description: 'Replace water heater', quantity: 1, unitCents: 120000 },
  { description: 'Labour (hours)', quantity: 2.5, unitCents: 9500 },
];
const TOTAL = 120000 + 23750;

const freshFirm = async (label: string) => (await createTenant(`Docs ${label} ${Date.now()} ${Math.random()}`)).id;

async function freshJob(tid = tenantId, status: JobStatus = 'completed') {
  const c = await createCustomer({ tenantId: tid, name: `Doc Cust ${Math.random().toString(36).slice(2, 8)}` });
  return createJob({ tenantId: tid, customerId: c.id, title: 'bathroom', status });
}

const draft = (tid: string, jobId: string, kind: MoneyDocumentKind = 'invoice') =>
  saveDraft({ tenantId: tid, kind, jobId, lines: LINES, byRef: 'mgr-sam' });

const summary = async (jobId: string) => summarizeMoney(await listMoneyEventsForJob(tenantId, jobId));

const ledgerCount = async (jobId: string, kind: string): Promise<number> =>
  Number(
    (await pg.query('select count(*) n from money_events where job_id = $1 and kind = $2', [jobId, kind])).rows[0].n,
  );

beforeAll(async () => {
  await pg.connect();
  tenantId = await freshFirm('main');
  otherTenantId = await freshFirm('other');
});

afterAll(async () => {
  // The ledger is append-only by trigger: TRUNCATE is the house cleanup
  // (moneyEvents.test.ts). money_documents and its file links go with it.
  await pg.query('truncate table money_documents, money_events cascade');
  await pg.end();
});

describe('lines', () => {
  test('priced here: amount = quantity × unitCents rounded; total is the sum', () => {
    const { lines, totalCents } = normalizeLines([
      { description: ' Pipe ', quantity: 3, unitCents: 1999 },
      { description: 'Half hour', quantity: 0.333, unitCents: 1000 },
    ]);
    expect(lines).toEqual([
      { description: 'Pipe', quantity: 3, unitCents: 1999, amountCents: 5997 },
      { description: 'Half hour', quantity: 0.333, unitCents: 1000, amountCents: 333 },
    ]);
    expect(totalCents).toBe(6330);
  });

  test('refused in words: none, over 100, no description, quantity ≤ 0, fractional or negative cents, a wrong stated amount', () => {
    const ok = { description: 'x', quantity: 1, unitCents: 100 };
    expect(() => normalizeLines([])).toThrow('at least one line');
    expect(() => normalizeLines(Array(101).fill(ok))).toThrow('at most 100');
    expect(() => normalizeLines([{ ...ok, description: '  ' }])).toThrow('needs a description');
    expect(() => normalizeLines([{ ...ok, quantity: 0 }])).toThrow('quantity must be a number above 0');
    expect(() => normalizeLines([{ ...ok, unitCents: 10.5 }])).toThrow('whole number of cents');
    expect(() => normalizeLines([{ ...ok, unitCents: -1 }])).toThrow('whole number of cents');
    expect(() => normalizeLines([{ ...ok, quantity: 2, amountCents: 100 }])).toThrow('is not quantity × unitCents');
    expect(normalizeLines(Array(100).fill(ok)).totalCents).toBe(10000);
  });
});

describe('drafts', () => {
  test('a draft has no number; it is edited in place and the total recomputed; the customer comes from the job', async () => {
    const job = await freshJob();
    const d = await draft(tenantId, job.id);
    expect(d).toMatchObject({ status: 'draft', number: null, number_seq: null, total_cents: TOTAL, customer_id: job.customer_id });
    const edited = await saveDraft({
      tenantId, kind: 'invoice', jobId: job.id, documentId: d.id, byRef: 'mgr-sam', notes: ' Thanks! ',
      lines: [{ description: 'Flat rate', quantity: 1, unitCents: 50000 }],
    });
    expect(edited.id).toBe(d.id);
    expect(edited.total_cents).toBe(50000);
    expect(edited.notes).toBe('Thanks!');
    const row = (await pg.query('select total_cents, lines from money_documents where id = $1', [d.id])).rows[0];
    expect(row.total_cents).toBe(50000);
    expect(row.lines).toEqual([{ description: 'Flat rate', quantity: 1, unitCents: 50000, amountCents: 50000 }]);
    expect(await listDocuments(tenantId, { jobId: job.id })).toHaveLength(1);
    expect(await listDocuments(tenantId, { customerId: job.customer_id })).toHaveLength(1);
  });

  test('an issued document refuses edits', async () => {
    const job = await freshJob();
    const d = await draft(tenantId, job.id);
    const { document } = await issueDocument(tenantId, d.id, 'mgr-sam');
    await expect(
      saveDraft({ tenantId, kind: 'invoice', jobId: job.id, documentId: d.id, byRef: 'mgr-sam', lines: LINES }),
    ).rejects.toThrow(`${document.number} is issued and cannot be edited`);
  });

  test('a draft has nothing to void', async () => {
    const job = await freshJob();
    const d = await draft(tenantId, job.id);
    await expect(voidDocument(tenantId, d.id, 'oops', 'mgr-sam')).rejects.toThrow('nothing to void');
  });
});

describe('numbering', () => {
  test('INV-1001 then INV-1002; estimates count separately from EST-1001', async () => {
    const firm = await freshFirm('numbers');
    const job = await freshJob(firm);
    const a = await issueDocument(firm, (await draft(firm, job.id)).id, 'mgr');
    const b = await issueDocument(firm, (await draft(firm, job.id)).id, 'mgr');
    const e = await issueDocument(firm, (await draft(firm, job.id, 'estimate')).id, 'mgr');
    expect([a.document.number, b.document.number, e.document.number]).toEqual(['INV-1001', 'INV-1002', 'EST-1001']);
  });

  test("a firm's start of 5000 gives INV-5000", async () => {
    const firm = await freshFirm('start');
    await upsertTenantProfile(firm, { invoiceStart: 5000 });
    const job = await freshJob(firm);
    expect((await issueDocument(firm, (await draft(firm, job.id)).id, 'mgr')).document.number).toBe('INV-5000');
    expect((await issueDocument(firm, (await draft(firm, job.id, 'estimate')).id, 'mgr')).document.number).toBe('EST-1001');
  });

  test('two concurrent issues of ONE draft end with one number and one ledger row', async () => {
    const firm = await freshFirm('race-one');
    const job = await freshJob(firm);
    const d = await draft(firm, job.id);
    const [x, y] = await Promise.all([issueDocument(firm, d.id, 'mgr'), issueDocument(firm, d.id, 'mgr')]);
    expect(x.document.number).toBe('INV-1001');
    expect(y.document.number).toBe('INV-1001');
    expect(x.event.id).toBe(y.event.id);
    expect(await ledgerCount(job.id, 'invoice_issued')).toBe(1);
    const nums = (await pg.query('select number from money_documents where tenant_id = $1 and number is not null', [firm])).rows;
    expect(nums).toEqual([{ number: 'INV-1001' }]);
  });

  test('two drafts issued together get two numbers', async () => {
    const firm = await freshFirm('race-two');
    const job = await freshJob(firm);
    const [d1, d2] = [await draft(firm, job.id), await draft(firm, job.id)];
    const [x, y] = await Promise.all([issueDocument(firm, d1.id, 'mgr'), issueDocument(firm, d2.id, 'mgr')]);
    expect([x.document.number, y.document.number].sort()).toEqual(['INV-1001', 'INV-1002']);
    expect(await ledgerCount(job.id, 'invoice_issued')).toBe(2);
  });
});

describe('issue and void write the ledger', () => {
  test('issue writes ONE invoice_issued for the total and walks completed → invoiced; a repeat writes nothing', async () => {
    const job = await freshJob(tenantId, 'completed');
    const d = await draft(tenantId, job.id);
    const first = await issueDocument(tenantId, d.id, 'mgr-sam');
    expect(first.already).toBe(false);
    expect(first.statusChange).toEqual({ from: 'completed', to: 'invoiced' });
    const ev = (await pg.query('select kind, amount_cents, external_ref, dedupe_key, actor_ref from money_events where id = $1', [first.event.id])).rows[0];
    expect(ev).toEqual({
      kind: 'invoice_issued', amount_cents: TOTAL, external_ref: first.document.number,
      dedupe_key: `doc:${d.id}:issue`, actor_ref: 'mgr-sam',
    });
    expect(first.document.money_event_id).toBe(first.event.id);
    expect((await getJob(job.id))?.status).toBe('invoiced');

    const again = await issueDocument(tenantId, d.id, 'mgr-sam');
    expect(again.already).toBe(true);
    expect(again.event.id).toBe(first.event.id);
    expect(await ledgerCount(job.id, 'invoice_issued')).toBe(1);
  });

  test('void writes invoice_voided against the issuing row and walks the job back; a second void is "already"', async () => {
    const job = await freshJob(tenantId, 'completed');
    const d = await draft(tenantId, job.id);
    const issued = await issueDocument(tenantId, d.id, 'mgr-sam');
    const v = await voidDocument(tenantId, d.id, 'wrong customer', 'mgr-sam');
    expect(v.event).toMatchObject({ kind: 'invoice_voided', corrects_event_id: issued.event.id, dedupe_key: `doc:${d.id}:void` });
    expect(v.document).toMatchObject({ status: 'void', void_reason: 'wrong customer', number: issued.document.number });
    expect(v.statusChange).toEqual({ from: 'invoiced', to: 'completed' });
    expect(summarizeMoney(await listMoneyEventsForJob(tenantId, job.id)).invoicedCents).toBe(0);
    expect((await voidDocument(tenantId, d.id, null, 'mgr-sam')).already).toBe(true);
    expect(await ledgerCount(job.id, 'invoice_voided')).toBe(1);
    await expect(issueDocument(tenantId, d.id, 'mgr-sam')).rejects.toThrow('is void');
  });

  test('issuing on an OPEN job walks it to invoiced; with progress it stays open', async () => {
    const open1 = await freshJob(tenantId, 'open');
    await issueDocument(tenantId, (await draft(tenantId, open1.id)).id, 'mgr');
    expect((await getJob(open1.id))?.status).toBe('invoiced');

    const open2 = await freshJob(tenantId, 'open');
    const dep = await issueDocument(tenantId, (await draft(tenantId, open2.id)).id, 'mgr', { progress: true });
    expect(dep.event.detail).toMatchObject({ progress: true });
    expect(dep.statusChange).toBeNull();
    expect((await getJob(open2.id))?.status).toBe('open');
  });

  test('a ledger write that never landed is written by a second issue', async () => {
    const job = await freshJob(tenantId, 'completed');
    const d = await draft(tenantId, job.id);
    // The state a crash between numbering and the ledger write leaves behind.
    await pg.query(
      "update money_documents set status = 'issued', number_seq = 9001, number = 'INV-9001', issued_at = now() where id = $1",
      [d.id],
    );
    expect(await ledgerCount(job.id, 'invoice_issued')).toBe(0);
    const r = await issueDocument(tenantId, d.id, 'mgr');
    expect(r.already).toBe(false);
    expect(r.event).toMatchObject({ kind: 'invoice_issued', external_ref: 'INV-9001', amount_cents: TOTAL });
    expect(r.document.money_event_id).toBe(r.event.id);
    expect((await getJob(job.id))?.status).toBe('invoiced');
  });

  test('a ledger row that landed but was never linked is found by its key, not written twice', async () => {
    const job = await freshJob(tenantId, 'completed');
    const d = await draft(tenantId, job.id);
    const first = await issueDocument(tenantId, d.id, 'mgr');
    await pg.query('update money_documents set money_event_id = null where id = $1', [d.id]);
    const r = await issueDocument(tenantId, d.id, 'mgr');
    expect(r.event.id).toBe(first.event.id);
    expect(r.document.money_event_id).toBe(first.event.id);
    expect(await ledgerCount(job.id, 'invoice_issued')).toBe(1);
  });
});

describe('progress is decided once, at issue', () => {
  test('stored with the number; the ledger row is written from the stored value; a disagreeing retry is refused', async () => {
    const job = await freshJob(tenantId, 'open');
    const d = await draft(tenantId, job.id);
    const r = await issueDocument(tenantId, d.id, 'mgr', { progress: true });
    expect(r.document.progress).toBe(true);
    expect(r.event.detail).toMatchObject({ progress: true });
    await expect(issueDocument(tenantId, d.id, 'mgr')).rejects.toThrow('was issued as a progress (deposit) invoice');
    expect((await issueDocument(tenantId, d.id, 'mgr', { progress: true })).already).toBe(true);

    // The retry of a ledger write that never landed takes progress from the document.
    const d2 = await draft(tenantId, job.id);
    await pg.query(
      "update money_documents set status = 'issued', number_seq = 9101, number = 'INV-9101', progress = true where id = $1",
      [d2.id],
    );
    await expect(issueDocument(tenantId, d2.id, 'mgr')).rejects.toThrow('progress');
    expect(await ledgerCount(job.id, 'invoice_issued')).toBe(1);
    const retried = await issueDocument(tenantId, d2.id, 'mgr', { progress: true });
    expect(retried.event.detail).toMatchObject({ progress: true });
  });

  test('concurrent issues with DIFFERENT progress end with one row matching the stored document', async () => {
    for (let i = 0; i < 4; i++) {
      const job = await freshJob(tenantId, 'open');
      const d = await draft(tenantId, job.id);
      const results = await Promise.allSettled([
        issueDocument(tenantId, d.id, 'mgr', { progress: true }),
        issueDocument(tenantId, d.id, 'mgr', { progress: false }),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const stored = await getDocument(tenantId, d.id);
      const rows = (await pg.query("select detail from money_events where job_id = $1 and kind = 'invoice_issued'", [job.id])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0].detail.progress === true).toBe(stored?.progress);
    }
  });
});

describe('void racing issue and outcome', () => {
  test('an invoice retry racing a void leaves no live invoice and the job walked back', async () => {
    for (let i = 0; i < 5; i++) {
      const job = await freshJob(tenantId, 'completed');
      const d = await draft(tenantId, job.id);
      // Numbered, ledger write never landed (a crash); now a retry and a void race.
      await pg.query(
        "update money_documents set status = 'issued', number_seq = $2, number = $3, issued_at = now() where id = $1",
        [d.id, 9200 + i, `INV-${9200 + i}`],
      );
      await Promise.allSettled([issueDocument(tenantId, d.id, 'mgr'), voidDocument(tenantId, d.id, 'race', 'mgr')]);
      expect((await getDocument(tenantId, d.id))?.status).toBe('void');
      expect((await summary(job.id)).invoicedCents).toBe(0);
      expect((await getJob(job.id))?.status).toBe('completed');
    }
  });

  test('a void repeated after a crash between the status flip and the ledger write writes the missing row', async () => {
    const job = await freshJob(tenantId, 'completed');
    const d = await draft(tenantId, job.id);
    await issueDocument(tenantId, d.id, 'mgr');
    await pg.query("update money_documents set status = 'void', voided_at = now() where id = $1", [d.id]);
    const v = await voidDocument(tenantId, d.id, null, 'mgr');
    expect(v.already).toBe(true);
    expect(v.event?.kind).toBe('invoice_voided');
    expect((await summary(job.id)).invoicedCents).toBe(0);
    expect((await getJob(job.id))?.status).toBe('completed');
    expect((await voidDocument(tenantId, d.id, null, 'mgr')).event?.id).toBe(v.event?.id);
  });

  // A void whose cancelling write never landed: the doc is numbered but its
  // ledger row is missing, the void finds nothing to cancel, and THEN the
  // issuer's row lands (and its job walk) before it dies without linking.
  async function voidWithLiveIssue(i: number) {
    const job = await freshJob(tenantId, 'completed');
    const d = await draft(tenantId, job.id);
    await pg.query(
      "update money_documents set status = 'issued', number_seq = $2, number = $3, issued_at = now() where id = $1",
      [d.id, 9300 + i, `INV-${9300 + i}`],
    );
    expect((await voidDocument(tenantId, d.id, null, 'mgr')).event).toBeNull();
    await appendMoneyEvent({
      tenantId, jobId: job.id, kind: 'invoice_issued', amountCents: TOTAL,
      externalRef: `INV-${9300 + i}`, dedupeKey: `doc:${d.id}:issue`,
    });
    await syncJobStatusForMoney(tenantId, job.id);
    expect((await getJob(job.id))?.status).toBe('invoiced');
    expect((await listDocuments(tenantId, { jobId: job.id }))[0].unsettled).toBe(true);
    return { job, d };
  }

  test('a void document with a live invoice is healed by the next issue call, and the job walks back', async () => {
    const { job, d } = await voidWithLiveIssue(1);
    await expect(issueDocument(tenantId, d.id, 'mgr')).rejects.toThrow('is void');
    expect((await summary(job.id)).invoicedCents).toBe(0);
    expect((await getJob(job.id))?.status).toBe('completed');
    expect((await listDocuments(tenantId, { jobId: job.id }))[0].unsettled).toBe(false);
  });

  test('… and by a repeated void', async () => {
    const { job, d } = await voidWithLiveIssue(2);
    const v = await voidDocument(tenantId, d.id, null, 'mgr');
    expect(v.already).toBe(true);
    expect(v.event?.kind).toBe('invoice_voided');
    expect((await summary(job.id)).invoicedCents).toBe(0);
    expect((await getJob(job.id))?.status).toBe('completed');
  });

  test('a void document with a live approval is healed by the next outcome call', async () => {
    const job = await freshJob(tenantId, 'open');
    const d = await draft(tenantId, job.id, 'estimate');
    const issued = await issueDocument(tenantId, d.id, 'mgr');
    await voidDocument(tenantId, d.id, null, 'mgr');
    await appendMoneyEvent({
      tenantId, jobId: job.id, kind: 'estimate_approved', amountCents: TOTAL,
      externalRef: issued.document.number, dedupeKey: `doc:${d.id}:outcome`,
    });
    expect((await summary(job.id)).quotedCents).toBe(TOTAL);
    expect((await listDocuments(tenantId, { jobId: job.id }))[0].unsettled).toBe(true);
    await expect(recordEstimateOutcome(tenantId, d.id, 'declined', 'mgr')).rejects.toThrow('is void');
    expect((await summary(job.id)).quotedCents).toBe(0);
    expect((await listDocuments(tenantId, { jobId: job.id }))[0].unsettled).toBe(false);
  });

  test('a job status walk that fails after the cancel is said in words, and a repeated void retries it', async () => {
    const job = await freshJob(tenantId, 'completed');
    const d = await draft(tenantId, job.id);
    await issueDocument(tenantId, d.id, 'mgr');
    expect((await getJob(job.id))?.status).toBe('invoiced');
    await pg.query(`
      create function zz_refuse_job_update() returns trigger language plpgsql as $$
      begin
        if new.id = '${job.id}' then raise exception 'simulated outage'; end if;
        return new;
      end $$`);
    await pg.query('create trigger zz_refuse_job_update before update on jobs for each row execute function zz_refuse_job_update()');
    try {
      const v = await voidDocument(tenantId, d.id, null, 'mgr');
      expect(v.event?.kind).toBe('invoice_voided');
      expect(v.note).toMatch(/stands cancelled, but the job's status could not be moved.*void it again/);
      expect((await summary(job.id)).invoicedCents).toBe(0);
      expect((await getJob(job.id))?.status).toBe('invoiced');
      // The refusal path says the same when it cannot walk.
      await expect(issueDocument(tenantId, d.id, 'mgr')).rejects.toThrow(/is void.*stands cancelled, but the job's status/);
    } finally {
      await pg.query('drop trigger zz_refuse_job_update on jobs');
      await pg.query('drop function zz_refuse_job_update()');
    }
    const again = await voidDocument(tenantId, d.id, null, 'mgr');
    expect(again.note).toBeUndefined();
    expect(again.statusChange).toEqual({ from: 'invoiced', to: 'completed' });
  });

  test('an issue whose job status walk fails is said in words, and a repeat moves the job', async () => {
    const job = await freshJob(tenantId, 'completed');
    const d = await draft(tenantId, job.id);
    await pg.query(`
      create function zz_refuse_job_update() returns trigger language plpgsql as $$
      begin
        if new.id = '${job.id}' then raise exception 'simulated outage'; end if;
        return new;
      end $$`);
    await pg.query('create trigger zz_refuse_job_update before update on jobs for each row execute function zz_refuse_job_update()');
    try {
      const first = await issueDocument(tenantId, d.id, 'mgr');
      expect(first.already).toBe(false);
      expect(first.statusChange).toBeNull();
      expect(first.note).toMatch(/stands issued and recorded, but the job's status could not be moved.*issue it again/);
      expect(await ledgerCount(job.id, 'invoice_issued')).toBe(1);
      expect((await getJob(job.id))?.status).toBe('completed');
      // A repeat while the fault lasts says the same, and still writes nothing.
      const stillDown = await issueDocument(tenantId, d.id, 'mgr');
      expect(stillDown.already).toBe(true);
      expect(stillDown.note).toMatch(/issue it again/);
    } finally {
      await pg.query('drop trigger zz_refuse_job_update on jobs');
      await pg.query('drop function zz_refuse_job_update()');
    }
    const again = await issueDocument(tenantId, d.id, 'mgr');
    expect(again.already).toBe(true);
    expect(again.note).toBeUndefined();
    expect(again.statusChange).toEqual({ from: 'completed', to: 'invoiced' });
    expect(await ledgerCount(job.id, 'invoice_issued')).toBe(1);
    expect((await getJob(job.id))?.status).toBe('invoiced');
  });

  test('an outcome is never stamped onto a void estimate (racing a void with the other answer in the ledger)', async () => {
    for (let i = 0; i < 8; i++) {
      const job = await freshJob(tenantId, 'open');
      const d = await draft(tenantId, job.id, 'estimate');
      const issued = await issueDocument(tenantId, d.id, 'mgr');
      // The ledger already holds "declined"; the stamp never landed.
      await appendMoneyEvent({
        tenantId, jobId: job.id, kind: 'estimate_declined',
        externalRef: issued.document.number, dedupeKey: `doc:${d.id}:outcome`,
      });
      await Promise.allSettled([
        recordEstimateOutcome(tenantId, d.id, 'accepted', 'mgr'),
        voidDocument(tenantId, d.id, null, 'mgr'),
      ]);
      const row = (await pg.query('select status, outcome, outcome_at <= voided_at as before_void from money_documents where id = $1', [d.id])).rows[0];
      expect(row.status).toBe('void');
      if (row.outcome !== null) expect(row.before_void).toBe(true);
    }
  });

  test('a void racing an accepted outcome ends void with nothing quoted', async () => {
    for (let i = 0; i < 5; i++) {
      const job = await freshJob(tenantId, 'open');
      const d = await draft(tenantId, job.id, 'estimate');
      await issueDocument(tenantId, d.id, 'mgr');
      await Promise.allSettled([
        recordEstimateOutcome(tenantId, d.id, 'accepted', 'mgr'),
        voidDocument(tenantId, d.id, 'race', 'mgr'),
      ]);
      expect((await getDocument(tenantId, d.id))?.status).toBe('void');
      expect((await summary(job.id)).quotedCents).toBe(0);
    }
  });

  test('void cancels an approval the ledger holds even when the outcome was never stamped', async () => {
    const job = await freshJob(tenantId, 'open');
    const d = await draft(tenantId, job.id, 'estimate');
    const issued = await issueDocument(tenantId, d.id, 'mgr');
    // The outcome's ledger write landed; its stamp on the document did not.
    await appendMoneyEvent({
      tenantId, jobId: job.id, kind: 'estimate_approved', amountCents: TOTAL,
      externalRef: issued.document.number, dedupeKey: `doc:${d.id}:outcome`,
    });
    expect((await getDocument(tenantId, d.id))?.outcome).toBeNull();
    const v = await voidDocument(tenantId, d.id, null, 'mgr');
    expect(v.event?.kind).toBe('correction');
    expect((await summary(job.id)).quotedCents).toBe(0);
  });

  test('an outcome after a void is refused and leaves no live approval', async () => {
    const job = await freshJob(tenantId, 'open');
    const d = await draft(tenantId, job.id, 'estimate');
    await issueDocument(tenantId, d.id, 'mgr');
    await voidDocument(tenantId, d.id, null, 'mgr');
    await expect(recordEstimateOutcome(tenantId, d.id, 'accepted', 'mgr')).rejects.toThrow('is void');
    expect(await ledgerCount(job.id, 'estimate_approved')).toBe(0);
    expect((await summary(job.id)).quotedCents).toBe(0);
  });

  test('a refused second answer stamps the document with the answer the ledger holds', async () => {
    const job = await freshJob(tenantId, 'open');
    const d = await draft(tenantId, job.id, 'estimate');
    const issued = await issueDocument(tenantId, d.id, 'mgr');
    await appendMoneyEvent({
      tenantId, jobId: job.id, kind: 'estimate_declined',
      externalRef: issued.document.number, dedupeKey: `doc:${d.id}:outcome`,
    });
    await expect(recordEstimateOutcome(tenantId, d.id, 'accepted', 'mgr')).rejects.toThrow('already recorded as declined');
    expect((await getDocument(tenantId, d.id))?.outcome).toBe('declined');
    expect(await ledgerCount(job.id, 'estimate_approved')).toBe(0);
  });
});

describe('estimates', () => {
  test('issue → estimate_presented; accepted → estimate_approved and quoted = total; a second outcome is refused', async () => {
    const job = await freshJob(tenantId, 'open');
    const d = await draft(tenantId, job.id, 'estimate');
    await expect(recordEstimateOutcome(tenantId, d.id, 'accepted', 'mgr')).rejects.toThrow('still a draft');
    const issued = await issueDocument(tenantId, d.id, 'mgr');
    expect(issued.event).toMatchObject({ kind: 'estimate_presented', amount_cents: TOTAL });
    expect((await getJob(job.id))?.status).toBe('open');

    const r = await recordEstimateOutcome(tenantId, d.id, 'accepted', 'mgr');
    expect(r.event).toMatchObject({ kind: 'estimate_approved', amount_cents: TOTAL, dedupe_key: `doc:${d.id}:outcome` });
    expect(r.document.outcome).toBe('accepted');
    expect(summarizeMoney(await listMoneyEventsForJob(tenantId, job.id)).quotedCents).toBe(TOTAL);

    await expect(recordEstimateOutcome(tenantId, d.id, 'declined', 'mgr')).rejects.toThrow('already recorded as accepted');
    await expect(recordEstimateOutcome(tenantId, d.id, 'accepted', 'mgr')).rejects.toThrow('already recorded as accepted');
    expect(await ledgerCount(job.id, 'estimate_approved')).toBe(1);
    expect(await ledgerCount(job.id, 'estimate_declined')).toBe(0);
  });

  test('a racing second answer converges on the first row and is refused', async () => {
    const job = await freshJob(tenantId, 'open');
    const d = await draft(tenantId, job.id, 'estimate');
    await issueDocument(tenantId, d.id, 'mgr');
    const results = await Promise.allSettled([
      recordEstimateOutcome(tenantId, d.id, 'accepted', 'mgr'),
      recordEstimateOutcome(tenantId, d.id, 'declined', 'mgr'),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await ledgerCount(job.id, 'estimate_approved')) + (await ledgerCount(job.id, 'estimate_declined'))).toBe(1);
  });

  test('declined → estimate_declined; voiding an ACCEPTED estimate clears quoted', async () => {
    const job = await freshJob(tenantId, 'open');
    const no = await draft(tenantId, job.id, 'estimate');
    await issueDocument(tenantId, no.id, 'mgr');
    expect((await recordEstimateOutcome(tenantId, no.id, 'declined', 'mgr')).event.kind).toBe('estimate_declined');

    const yes = await draft(tenantId, job.id, 'estimate');
    await issueDocument(tenantId, yes.id, 'mgr');
    const approved = await recordEstimateOutcome(tenantId, yes.id, 'accepted', 'mgr');
    expect(summarizeMoney(await listMoneyEventsForJob(tenantId, job.id)).quotedCents).toBe(TOTAL);
    const v = await voidDocument(tenantId, yes.id, 'customer changed their mind', 'mgr');
    expect(v.event).toMatchObject({ kind: 'correction', corrects_event_id: approved.event.id });
    expect(v.document.status).toBe('void');
    expect(summarizeMoney(await listMoneyEventsForJob(tenantId, job.id)).quotedCents).toBe(0);
    await expect(recordEstimateOutcome(tenantId, yes.id, 'accepted', 'mgr')).rejects.toThrow('is void');
  });

  test('an invoice has no outcome; progress is for invoices', async () => {
    const job = await freshJob();
    const inv = await draft(tenantId, job.id);
    await issueDocument(tenantId, inv.id, 'mgr');
    await expect(recordEstimateOutcome(tenantId, inv.id, 'accepted', 'mgr')).rejects.toThrow('only an estimate');
    const est = await draft(tenantId, job.id, 'estimate');
    await expect(issueDocument(tenantId, est.id, 'mgr', { progress: true })).rejects.toThrow('invoices only');
  });
});

describe('tenant guard', () => {
  test("another firm's document and job read as missing, everywhere", async () => {
    const job = await freshJob(tenantId);
    const d = await draft(tenantId, job.id);
    expect(await getDocument(otherTenantId, d.id)).toBeNull();
    expect(await listDocuments(otherTenantId, { jobId: job.id })).toEqual([]);
    await expect(issueDocument(otherTenantId, d.id, 'x')).rejects.toThrow('no such document');
    await expect(voidDocument(otherTenantId, d.id, null, 'x')).rejects.toThrow('no such document');
    await expect(recordEstimateOutcome(otherTenantId, d.id, 'accepted', 'x')).rejects.toThrow('no such document');
    await expect(draft(otherTenantId, job.id)).rejects.toThrow('no such job on this firm');
    await expect(
      saveDraft({ tenantId: otherTenantId, kind: 'invoice', jobId: job.id, documentId: d.id, byRef: 'x', lines: LINES }),
    ).rejects.toThrow('no such job on this firm');
    const theirJob = await freshJob(otherTenantId);
    await expect(
      saveDraft({ tenantId: otherTenantId, kind: 'invoice', jobId: theirJob.id, documentId: d.id, byRef: 'x', lines: LINES }),
    ).rejects.toThrow('no such document');
    expect(await getDocument(tenantId, 'not-a-uuid')).toBeNull();
    expect((await getDocument(tenantId, d.id))?.status).toBe('draft');
  });

  test('money_documents is RLS-enabled with zero anon/authenticated privileges', async () => {
    expect((await pg.query("select relrowsecurity from pg_class where relname = 'money_documents'")).rows[0].relrowsecurity).toBe(true);
    const priv = await pg.query(
      `select count(*)::int as n from information_schema.table_privileges
        where table_name = 'money_documents' and grantee in ('anon', 'authenticated')`,
    );
    expect(priv.rows[0].n).toBe(0);
  });
});
