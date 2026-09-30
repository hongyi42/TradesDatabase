import { createObservation, getCustomer, getJob, type Observation } from '../db/index.js';

// STEP 2E PHASE 4 — "LOOKS LIKE YOU INVOICED LEE. RECORD IT?"
//
// A manager who invoices from their own Gmail leaves the ledger blank: the bot
// never saw the invoice. The sent email is captured anyway (rung 10b.4), so the
// door raises one `outbound_invoice` observation for it, pinged like the inbound
// asks, and the OFFICE decides whether it is really an invoice the firm issued
// and whether to ask the manager's seat to record it. Code only guards:
//   * a cheap test — a PDF attached, or the word "invoice" — never a judgment
//     of what the email is (the office decides; operator doctrine "code decides
//     little", 2026-09-22);
//   * no double ask — skipped when the email names a number already on the
//     books (documents or ledger external refs; webhook.ts calls
//     namesIssuedNumber first), and when the capture was a duplicate or
//     agent-written (the webhook returns before reaching here).

export interface OutboundInvoiceAttachment {
  name: string;
  mime: string;
}

/** A PDF on it, or it says "invoice" (subject or body, any case). */
export function looksLikeInvoice(input: {
  subject?: string | null;
  body?: string | null;
  attachments: OutboundInvoiceAttachment[];
}): boolean {
  const pdf = input.attachments.some(
    (a) => a.mime.toLowerCase() === 'application/pdf' || a.name.toLowerCase().endsWith('.pdf'),
  );
  return pdf || /invoice/i.test(`${input.subject ?? ''}\n${input.body ?? ''}`);
}

// The words the office reads: the subject and the body, bounded like every
// other inbound ask's copy (recordFieldNote keeps 1500).
const WORDS_MAX = 1500;

export function invoiceWords(subject: string | null | undefined, body: string | null | undefined): string {
  const s = (subject ?? '').trim();
  const b = (body ?? '').trim();
  return (s ? `Subject: ${s}\n\n${b}` : b).slice(0, WORDS_MAX);
}

export interface RaiseOutboundInvoiceInput {
  tenantId: string;
  captureId: string;
  customerId: string | null;
  jobId: string | null;
  sentTo: string | null;
  /** The mailbox owner — the manager whose seat the office asks. */
  technicianRef: string;
  senderName: string | null;
  words: string;
  attachments: OutboundInvoiceAttachment[];
  /** The text read out of the attached PDF(s) — where an invoice's amount and number usually are. */
  attachmentText?: string | null;
}

/**
 * Write the observation. subject_ref is the capture id and the author is the
 * detector, so the once-ever index makes a redelivery converge (null) instead
 * of asking twice. The job title and customer name are read here so the gap's
 * `about:` line names them; a cross-firm id resolves to nothing.
 */
export async function raiseOutboundInvoiceObservation(
  input: RaiseOutboundInvoiceInput,
): Promise<Observation | null> {
  const [job, customer] = await Promise.all([
    input.jobId ? getJob(input.jobId) : Promise.resolve(null),
    input.customerId ? getCustomer(input.customerId) : Promise.resolve(null),
  ]);
  const ownJob = job && job.tenant_id === input.tenantId ? job : null;
  const ownCustomer = customer && customer.tenant_id === input.tenantId ? customer : null;
  return createObservation({
    tenantId: input.tenantId,
    kind: 'outbound_invoice',
    subjectRef: input.captureId,
    // The manager's own question, and every inbound ask carries no person:
    // countsAsTheAsk is refused for these kinds, so a person here would mean
    // nothing (src/teamLead/planner.ts, "A CALL IS NOT A QUESTION").
    technicianId: null,
    context: {
      outbound: true,
      channel: 'outbound_email',
      captureId: input.captureId,
      customerId: ownCustomer?.id ?? null,
      ...(ownCustomer ? { customerName: ownCustomer.name } : {}),
      jobId: ownJob?.id ?? null,
      ...(ownJob ? { jobTitle: ownJob.title } : {}),
      sentTo: input.sentTo,
      technicianRef: input.technicianRef,
      senderName: input.senderName,
      words: input.words,
      attachments: input.attachments.map((a) => ({ name: a.name, mime: a.mime })),
      ...(input.attachmentText ? { attachmentText: input.attachmentText.slice(0, 3000) } : {}),
    },
  });
}
