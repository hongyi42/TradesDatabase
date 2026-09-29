import { beforeAll, describe, expect, test } from 'vitest';
import { readCaptureRecords } from '../db/captureMembership.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { issueDocument, namesIssuedNumber, numberCandidates, saveDraft } from '../db/moneyDocuments.js';
import { appendMoneyEvent } from '../db/moneyEvents.js';
import { createObservation, markObservationAsked } from '../db/observations.js';
import { appendRawCapture } from '../db/rawCaptures.js';
import { inboundAskFor } from '../mcp/tools/shared.js';
import { createTenant } from '../db/tenants.js';
import { invoiceWords, looksLikeInvoice, raiseOutboundInvoiceObservation } from './outboundInvoice.js';

// Step 2e phase 4 against the local stack: the no-double-ask number check, the
// observation the door raises, and the ledger row that closes it.
let tenantId: string;
let otherTenantId: string;
let customerId: string;
let jobId: string;
let issuedNumber: string;

beforeAll(async () => {
  tenantId = (await createTenant(`Sent Invoice ${Date.now()}`)).id;
  otherTenantId = (await createTenant(`Sent Invoice Other ${Date.now()}`)).id;
  customerId = (await createCustomer({ tenantId, name: 'Lee Park' })).id;
  jobId = (await createJob({ tenantId, customerId, title: 'Bathroom remodel', status: 'completed' })).id;
  const d = await saveDraft({
    tenantId, kind: 'invoice', jobId, lines: [{ description: 'Tile', quantity: 1, unitCents: 45000 }], byRef: 'mgr-sam',
  });
  issuedNumber = (await issueDocument(tenantId, d.id, 'mgr-sam')).document.number!;
  await appendMoneyEvent({ tenantId, jobId, kind: 'invoice_issued', amountCents: 9900, externalRef: 'QB-5521' });
});

describe('looksLikeInvoice — the cheap guard', () => {
  test('a PDF, or the word "invoice" in any case; nothing else', () => {
    expect(looksLikeInvoice({ subject: 'Bathroom', body: 'see attached', attachments: [{ name: 'bill.PDF', mime: 'application/octet-stream' }] })).toBe(true);
    expect(looksLikeInvoice({ subject: 'Bathroom', body: '', attachments: [{ name: 'x', mime: 'application/pdf' }] })).toBe(true);
    expect(looksLikeInvoice({ subject: 'Your INVOICE', body: '', attachments: [] })).toBe(true);
    expect(looksLikeInvoice({ subject: 'Thursday', body: 'see you then', attachments: [{ name: 'a.jpg', mime: 'image/jpeg' }] })).toBe(false);
  });

  test('the words are the subject and the body, bounded', () => {
    expect(invoiceWords('Invoice 7', '  $450 due  ')).toBe('Subject: Invoice 7\n\n$450 due');
    expect(invoiceWords('', 'x'.repeat(2000))).toHaveLength(1500);
  });
});

describe('namesIssuedNumber — no double ask', () => {
  test('candidates carry the number however it is written in a sentence', () => {
    const c = numberCandidates('Re: inv-1001, and #1002. Invoice 1003, invoice no. 1005. Thanks!');
    expect(c).toEqual(
      expect.arrayContaining(['inv-1001', 'INV-1001', '1002', 'INV-1002', 'EST-1002', 'INV-1003', 'INV-1005']),
    );
    expect(numberCandidates('no digits here')).toEqual([]);
    // BARE DIGITS WITHOUT A CUE are an address, an amount, a phone — not a number.
    expect(numberCandidates('Work done at 1004 Pine St, 450 dollars, call 5551234')).toEqual([]);
  });

  test("a document number this firm issued, or a ledger row's external ref, is named — another firm's is not", async () => {
    expect(await namesIssuedNumber(tenantId, `Subject: ${issuedNumber}\n\nthanks`)).toBe(true);
    expect(await namesIssuedNumber(tenantId, `Subject: bill\n\nsee ${issuedNumber.toLowerCase()} attached`)).toBe(true);
    expect(await namesIssuedNumber(tenantId, 'invoice #' + issuedNumber.replace(/\D/g, ''))).toBe(true);
    expect(await namesIssuedNumber(tenantId, 'Your invoice QB-5521 is attached')).toBe(true);
    expect(await namesIssuedNumber(tenantId, 'Invoice 2231 for $450')).toBe(false);
    expect(await namesIssuedNumber(otherTenantId, `Subject: ${issuedNumber}`)).toBe(false);
    const digits = issuedNumber.replace(/\D/g, '');
    // "1004 Pine St" — the same digits as an issued number, but an address.
    expect(await namesIssuedNumber(tenantId, `Invoice for the job at ${digits} Pine St`)).toBe(false);
    expect(await namesIssuedNumber(tenantId, `invoice #${digits}`)).toBe(true);
    expect(await namesIssuedNumber(tenantId, `Re: invoice ${digits}`)).toBe(true);
  });

  test("a payment's reference, or a voided invoice row's, is not an issued number", async () => {
    await appendMoneyEvent({ tenantId, jobId, kind: 'payment_received', amountCents: 100, externalRef: 'CHK-7781' });
    expect(await namesIssuedNumber(tenantId, 'invoice paid by CHK-7781')).toBe(false);
    const row = await appendMoneyEvent({ tenantId, jobId, kind: 'invoice_issued', amountCents: 100, externalRef: 'OLD-4410' });
    expect(await namesIssuedNumber(tenantId, 'invoice OLD-4410')).toBe(true);
    await appendMoneyEvent({ tenantId, jobId, kind: 'invoice_voided', correctsEventId: row.id });
    expect(await namesIssuedNumber(tenantId, 'invoice OLD-4410')).toBe(false);
  });
});

describe('raiseOutboundInvoiceObservation', () => {
  test('one observation per email with the context the office reads; a ledger row citing the email closes it', async () => {
    const cap = await appendRawCapture({
      tenantId, channel: 'outbound_email', rawText: 'Subject: Invoice 2231\n\n$450', externalId: `sent:inv-${Date.now()}`,
      technicianRef: 'mgr-sam',
    });
    const input = {
      tenantId, captureId: cap.id, customerId, jobId, sentTo: 'lee@homeowner.test', technicianRef: 'mgr-sam', senderName: 'Sam',
      words: 'Subject: Invoice 2231\n\n$450', attachments: [{ name: 'Invoice-2231.pdf', mime: 'application/pdf' }],
    };
    const obs = await raiseOutboundInvoiceObservation(input);
    expect(obs).toMatchObject({ kind: 'outbound_invoice', subject_ref: cap.id, author: 'detector', technician_id: null });
    expect(obs?.context).toEqual({
      outbound: true,
      channel: 'outbound_email',
      captureId: cap.id,
      customerId,
      customerName: 'Lee Park',
      jobId,
      jobTitle: 'Bathroom remodel',
      sentTo: 'lee@homeowner.test',
      technicianRef: 'mgr-sam',
      senderName: 'Sam',
      words: 'Subject: Invoice 2231\n\n$450',
      attachments: [{ name: 'Invoice-2231.pdf', mime: 'application/pdf' }],
    });
    // A redelivery converges on the first row — asked once.
    expect(await raiseOutboundInvoiceObservation(input)).toBeNull();

    // The seat records it on a yes, citing the email: capture_records' money
    // arm is what the planner's moot fact reads to close the ask.
    expect((await readCaptureRecords(tenantId, [cap.id])).citing.some((c) => c.kind === 'money')).toBe(false);
    const row = await appendMoneyEvent({
      tenantId, jobId, kind: 'invoice_issued', amountCents: 45000, externalRef: '2231', sourceCaptureId: cap.id,
    });
    expect((await readCaptureRecords(tenantId, [cap.id])).citing).toContainEqual({
      kind: 'money', id: String(row.id), captureId: cap.id, jobId,
    });
  });

  test("another firm's job or customer id resolves to nothing — no name leaks across", async () => {
    const cap = await appendRawCapture({
      tenantId: otherTenantId, channel: 'outbound_email', rawText: 'invoice', externalId: `sent:x-${Date.now()}`,
    });
    const obs = await raiseOutboundInvoiceObservation({
      tenantId: otherTenantId, captureId: cap.id, customerId, jobId, sentTo: null, technicianRef: 'mgr-sam', senderName: null, words: 'invoice', attachments: [],
    });
    expect(obs?.context).toMatchObject({ customerId: null, jobId: null });
    expect(obs?.context).not.toHaveProperty('customerName');
    expect(obs?.context).not.toHaveProperty('jobTitle');
  });
});

describe('a booking never cites it (inboundAskFor)', () => {
  test('an asked outbound_invoice on the job is no call for a booking to answer — an asked inbound ask is', async () => {
    const firm = (await createTenant(`Ask For ${Date.now()}`)).id;
    const cust = (await createCustomer({ tenantId: firm, name: 'Ask Cust' })).id;
    const job = (await createJob({ tenantId: firm, customerId: cust, title: 'furnace' })).id;
    const cap = await appendRawCapture({ tenantId: firm, channel: 'outbound_email', rawText: 'invoice', externalId: `sent:a-${Date.now()}` });
    const inv = await raiseOutboundInvoiceObservation({
      tenantId: firm, captureId: cap.id, customerId: cust, jobId: job, sentTo: null, technicianRef: 'mgr-sam', senderName: null, words: 'invoice', attachments: [],
    });
    expect(await markObservationAsked(inv!.id, new Date(Date.now() - 86_400_000).toISOString())).not.toBeNull();
    expect(await inboundAskFor(firm, { jobId: job })).toBeNull();

    // The control: the same shape as an inbound ask IS cited.
    const call = await appendRawCapture({ tenantId: firm, channel: 'phone_call', rawText: 'come out', externalId: `call-${Date.now()}` });
    const ask = await createObservation({
      tenantId: firm, kind: 'inbound_commitment', subjectRef: call.id, technicianId: null,
      context: { captureId: call.id, customerId: cust, jobId: job, channel: 'phone_call' },
    });
    await markObservationAsked(ask!.id, new Date(Date.now() - 86_400_000).toISOString());
    expect((await inboundAskFor(firm, { jobId: job }))?.captureId).toBe(call.id);
  });
});
