import { google } from 'googleapis';
import { recordFieldNote } from '../writePath/recordFieldNote.js';
import { upsertDroppedAudit } from '../db/index.js';
import type { Extractor } from '../writePath/extract.js';
import { defaultClassifier, type WorkClassifier, type EmailInput } from './classify.js';
import { formatEmailRawText } from './format.js';

export interface Email extends EmailInput {
  id: string;
}

// Injected so the pipeline is testable without hitting Gmail.
export type MailFetcher = () => Promise<Email[]>;

export interface IngestDeps {
  fetch?: MailFetcher;
  classify?: WorkClassifier;
  extract?: Extractor;
}

export interface IngestResult {
  ingested: number; // work emails fed to the write-path (L1 appended)
  skipped: number; // non-work emails dropped
}

function decodeBody(data: string | null | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

// Default fetcher: recent messages from the connected mailbox via Gmail OAuth2
// (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN). Untested-live
// pending Gmail provisioning — ingestEmail tests inject a stub fetcher instead.
const gmailFetcher: MailFetcher = async () => {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail OAuth env not set (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN)');
  }
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  const gmail = google.gmail({ version: 'v1', auth });

  const list = await gmail.users.messages.list({ userId: 'me', q: 'newer_than:7d', maxResults: 25 });
  const ids = (list.data.messages ?? []).map((m) => m.id).filter((id): id is string => !!id);

  const emails: Email[] = [];
  for (const id of ids) {
    const msg = await gmail.users.messages.get({ userId: 'me', id, format: 'full' });
    const headers = msg.data.payload?.headers ?? [];
    const header = (name: string) => headers.find((h) => h.name?.toLowerCase() === name)?.value ?? '';
    const textPart = (msg.data.payload?.parts ?? []).find((p) => p.mimeType === 'text/plain');
    const body =
      decodeBody(textPart?.body?.data) || decodeBody(msg.data.payload?.body?.data) || msg.data.snippet || '';
    emails.push({ id, from: header('from'), subject: header('subject'), body });
  }
  return emails;
};

// Second input channel: pull email, drop non-work, feed work mail through the
// SAME L1 → extract → match → L2/L3 write-path as field notes (channel 'email').
// No human-in-the-loop here, so an unmatched work email still lands verbatim in
// L1 (raw preserved for later resolution); only matched ones gain L2 rows.
//
// IDEMPOTENCY: each email's Gmail message id is passed as recordFieldNote's
// externalId, which dedups the L1 insert per tenant (uq_raw_captures_external_id).
// So the default gmailFetcher's overlapping `newer_than:7d` window re-fetches the
// same message but it does NOT write duplicate L1/L2 rows — a watermark in the
// fetcher is now an efficiency optimization, not a correctness requirement.
//   - A previously MATCHED email re-fetches to a 'duplicate' no-op (its L2 links back).
//   - An email whose L2 never built (extract failed, OR work-but-unmatched) re-runs
//     extract on re-fetch (the heal path) — harmless (writes nothing new if still
//     unresolved), but it does re-incur the model call each window. Acceptable; a
//     watermark eliminates it.
export async function ingestEmail(
  tenantId: string,
  technicianRef: string,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const fetch = deps.fetch ?? gmailFetcher;
  const classify = deps.classify ?? defaultClassifier;

  const emails = await fetch();
  let ingested = 0;
  let skipped = 0;
  for (const email of emails) {
    const { isWork, reason } = await classify(
      { subject: email.subject, body: email.body, from: email.from },
      // Billed even when the mail is dropped as personal — see webhook.ts.
      { tenantId, technicianRef },
    );
    if (!isWork) {
      // classify-before-L1: the email itself is NOT stored (privacy — append-only L1
      // must not retain personal mail). Record only a content-free audit receipt so a
      // mis-drop is detectable/recoverable from the source by message id.
      await upsertDroppedAudit({
        tenantId,
        channel: 'email',
        externalId: email.id,
        from: email.from,
        reason,
      });
      skipped++;
      continue;
    }
    const r = await recordFieldNote(
      {
        tenantId,
        technicianRef,
        channel: 'email',
        text: formatEmailRawText({ from: email.from, subject: email.subject, body: email.body }),
        externalId: email.id, // Gmail message id → per-tenant L1 dedup
        sourceMeta: { from: email.from, subject: email.subject },
      },
      { extract: deps.extract },
    );
    if (r.status !== 'duplicate') ingested++; // a re-fetched dup is not a new ingest
  }
  return { ingested, skipped };
}
