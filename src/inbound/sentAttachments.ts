import {
  FILE_MAX_BYTES,
  linkFile,
  recordComposioCall,
  storeFileOnce,
  type FileKind,
  type Technician,
} from '../db/index.js';
import { PDFParse } from 'pdf-parse';
import { compositeUserId, getComposioClient, type PairingClient } from '../composio/pairing.js';
import type { SentAttachment } from './gmailSent.js';

// STEP 2E PHASE 4 — THE FILES ON THE FIRM'S OWN SENT MAIL, KEPT. A manager who
// emails an invoice PDF from Gmail should find that PDF on the job afterwards,
// exactly as if the bot had made it. So once the sent email's capture is filed,
// each attachment is fetched from Gmail and stored in the file store, attached to
// the capture's job (else its customer, else left unattached).
//
// BEST-EFFORT AND OFF THE REQUEST PATH. The webhook answers Composio first and
// runs this detached (webhook.ts), so a slow Gmail or a failed download can never
// cost the email itself: every failure is logged and swallowed, and the whole
// call is bounded (60 s total, 20 s per download).
//
// THE VENDOR CONTRACT. `GMAIL_GET_ATTACHMENT` takes `message_id`,
// `attachment_id` and `file_name` (`user_id` defaults to 'me') and returns
// `data.file = {name, mimetype, s3url}` — the file is flagged downloadable, and
// our client is `new Composio()` with auto-download OFF, so what comes back is
// Composio's raw `s3url` and the bytes are one `fetch` away (Composio tool
// schema for GMAIL_GET_ATTACHMENT, read 2026-09-29;
// https://docs.composio.dev/docs/tools-direct/executing-tools). The call shape is
// `sendGmailEmail`'s (src/composio/outbound.ts): the person's own pinned
// connected account, `dangerouslySkipVersionCheck` required. `GMAIL_GET_` is a
// READ prefix to logIngest, so the execution is never swept into L1.
//
// ONCE PER FIRM, EVER. The file's `source_ref` is `gmail:<messageId>:<attachmentId>`
// and unique per firm — a redelivered webhook finds the file already kept and
// uploads nothing, and a file the manager DELETED stays deleted (storeFileOnce).

export const SENT_ATTACHMENT_TOTAL_MS = 60_000;
export const SENT_ATTACHMENT_EACH_MS = 20_000;

export interface SentAttachmentDeps {
  client?: PairingClient;
  fetch?: typeof fetch;
  store?: typeof storeFileOnce;
  link?: typeof linkFile;
  recordCost?: typeof recordComposioCall;
  totalMs?: number;
  eachMs?: number;
  log?: (message: string) => void;
  /** A kept PDF's text (null = unreadable). Seam for tests; default pdf-parse. */
  pdfText?: (bytes: Buffer) => Promise<string | null>;
}

/** How much of a kept PDF's text rides along to the office (an invoice is one page). */
export const SENT_PDF_TEXT_MAX = 3000;

// THE OFFICE READS THE PDF (operator 2026-09-30: "why can't the office read
// pdf?"). An invoice's amount and number usually live only in the attachment, not
// the email's words, so a kept PDF's text is read here and handed to the office
// with the ask. The pdf-parse call is the web reader's (src/web/fetchPage.ts).
export async function readPdfText(bytes: Buffer): Promise<string | null> {
  const parser = new PDFParse({ data: new Uint8Array(bytes) });
  try {
    const parsed = await parser.getText();
    const text = parsed.text.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, SENT_PDF_TEXT_MAX) : null;
  } catch {
    return null;
  } finally {
    await parser.destroy().catch(() => {}); // long-lived server: never leak workers
  }
}

export interface KeepSentAttachmentsInput {
  tenantId: string;
  tech: Technician;
  /** Gmail's own id for the message (NOT the `sent:` storage key). */
  messageId: string;
  attachments: SentAttachment[];
  target: { jobId?: string | null; customerId?: string | null };
  deps?: SentAttachmentDeps;
}

export type SentAttachmentOutcome =
  | 'stored'
  | 'already'
  | 'deleted'
  | 'too_large'
  | 'failed'
  | 'out_of_time';

export interface SentAttachmentResult {
  name: string;
  outcome: SentAttachmentOutcome;
  /** Where it was attached; null when it was kept unattached (or not kept). */
  linkedTo: 'job' | 'customer' | null;
  /** A kept PDF's text, when it could be read. */
  text?: string;
}

const kindOf = (mime: string): FileKind => (mime.toLowerCase().startsWith('image/') ? 'photo' : 'document');

class OutOfTime extends Error {}

// A deadline on a promise. The loser keeps running (a fetch is also aborted
// through its signal); its rejection is swallowed so it can never surface later
// as an unhandled rejection.
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  p.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new OutOfTime(`took longer than ${ms} ms`)), Math.max(0, ms));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The s3url from either envelope spelling (`data.file` or `data.response_data.file`).
function s3urlOf(result: Record<string, unknown>): string | null {
  const data = result.data as Record<string, unknown> | undefined;
  const nested = (data?.response_data ?? data) as Record<string, unknown> | undefined;
  const file = (nested?.file ?? data?.file) as Record<string, unknown> | undefined;
  for (const k of ['s3url', 's3Url', 'url']) {
    const v = file?.[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** Keep each attachment of a sent email. Never throws; one line logged per failure. */
export async function keepSentAttachments(input: KeepSentAttachmentsInput): Promise<SentAttachmentResult[]> {
  const { tenantId, tech, messageId, attachments, target } = input;
  const deps = input.deps ?? {};
  const log = deps.log ?? ((m: string) => console.error(m));
  const results: SentAttachmentResult[] = [];
  try {
    if (attachments.length === 0) return results;
    const accountId = tech.composio_connected_account_id;
    if (!accountId) {
      log(`sent attachments: ${tech.ref} has no paired mailbox — ${attachments.length} not kept`);
      return attachments.map((a) => ({ name: a.name, outcome: 'failed', linkedTo: null }));
    }
    const client = deps.client ?? getComposioClient();
    const doFetch = deps.fetch ?? fetch;
    const store = deps.store ?? storeFileOnce;
    const link = deps.link ?? linkFile;
    const recordCost = deps.recordCost ?? recordComposioCall;
    const eachMs = deps.eachMs ?? SENT_ATTACHMENT_EACH_MS;
    const deadline = Date.now() + (deps.totalMs ?? SENT_ATTACHMENT_TOTAL_MS);

    for (const a of attachments) {
      const left = deadline - Date.now();
      if (left <= 0) {
        results.push({ name: a.name, outcome: 'out_of_time', linkedTo: null });
        continue;
      }
      if (a.size !== null && a.size > FILE_MAX_BYTES) {
        log(`sent attachments: ${a.name} on ${messageId} is over 20 MB — not kept`);
        results.push({ name: a.name, outcome: 'too_large', linkedTo: null });
        continue;
      }
      try {
        const budget = Math.min(eachMs, left);
        const controller = new AbortController();
        const bytes = await within(
          (async () => {
            const call = client.tools.execute('GMAIL_GET_ATTACHMENT', {
              connectedAccountId: accountId,
              userId: compositeUserId(tech),
              arguments: { message_id: messageId, attachment_id: a.attachmentId, file_name: a.name },
              dangerouslySkipVersionCheck: true,
            });
            // Billed either way — Composio charges for the execution it ran.
            // Advisory: a ledger fault must never cost the file.
            const result = await call.finally(() =>
              recordCost({ tenantId, technicianRef: tech.ref }).catch((err: unknown) =>
                log(`cost: attachment fetch not recorded — ${err instanceof Error ? err.message : String(err)}`),
              ),
            );
            if (result.successful === false) {
              const e = typeof result.error === 'string' ? result.error : JSON.stringify(result.error ?? 'unknown');
              throw new Error(`GMAIL_GET_ATTACHMENT failed: ${e}`);
            }
            const url = s3urlOf(result);
            if (!url) throw new Error('GMAIL_GET_ATTACHMENT returned no file url');
            const res = await doFetch(url, { signal: controller.signal });
            if (!res.ok) throw new Error(`download answered ${res.status}`);
            const declared = Number(res.headers.get('content-length'));
            if (Number.isFinite(declared) && declared > FILE_MAX_BYTES) return null;
            return Buffer.from(await res.arrayBuffer());
          })(),
          budget,
        ).catch((err: unknown) => {
          controller.abort();
          throw err;
        });
        if (bytes === null || bytes.length > FILE_MAX_BYTES) {
          log(`sent attachments: ${a.name} on ${messageId} is over 20 MB — not kept`);
          results.push({ name: a.name, outcome: 'too_large', linkedTo: null });
          continue;
        }
        const kept = await within(
          store({
            tenantId,
            bytes,
            fileName: a.name,
            mimeType: a.mime,
            kind: kindOf(a.mime),
            uploadedByRef: tech.ref,
            uploadedBy: tech.id,
            source: 'email',
            sourceRef: `gmail:${messageId}:${a.attachmentId}`,
            // The manager's own correspondence — often an invoice with its
            // amounts — so no technician on the job lists or downloads it.
            managerOnly: true,
          }),
          Math.max(1, deadline - Date.now()),
        );
        if (kept.status === 'deleted') {
          // The firm removed it once; a redelivery must not bring it back.
          results.push({ name: a.name, outcome: 'deleted', linkedTo: null });
          continue;
        }
        let linkedTo: SentAttachmentResult['linkedTo'] = null;
        const to = target.jobId
          ? ({ where: 'job', t: { jobId: target.jobId } } as const)
          : target.customerId
            ? ({ where: 'customer', t: { customerId: target.customerId } } as const)
            : null;
        if (to) {
          try {
            await within(link(tenantId, kept.file.id, to.t, tech.ref), Math.max(1, deadline - Date.now()));
            linkedTo = to.where;
          } catch (err) {
            log(
              `sent attachments: ${a.name} kept but not attached to the ${to.where} — ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
        let text: string | undefined;
        if (/pdf/i.test(a.mime) || /\.pdf$/i.test(a.name)) {
          try {
            text = (await within((deps.pdfText ?? readPdfText)(bytes), Math.max(1, deadline - Date.now()))) ?? undefined;
          } catch {
            /* an unreadable PDF is still kept; the office just sees its name */
          }
        }
        results.push({ name: a.name, outcome: kept.status, linkedTo, ...(text ? { text } : {}) });
      } catch (err) {
        log(
          `sent attachments: ${a.name} on ${messageId} not kept — ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        results.push({ name: a.name, outcome: err instanceof OutOfTime ? 'out_of_time' : 'failed', linkedTo: null });
      }
    }
  } catch (err) {
    log(`sent attachments: ${messageId} — ${err instanceof Error ? err.message : String(err)}`);
  }
  return results;
}
