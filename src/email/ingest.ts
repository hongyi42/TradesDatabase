import { google } from 'googleapis';
import { recordFieldNote } from '../writePath/recordFieldNote.js';
import type { Extractor } from '../writePath/extract.js';
import { sonnetClassifier, type WorkClassifier, type EmailInput } from './classify.js';

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
// ⚠️ IDEMPOTENCY (must be handled before enabling the cron): this does NOT dedup
// by message id, and the default gmailFetcher uses an overlapping `newer_than:7d`
// window — so re-running re-ingests the same message as duplicate L1/L2 rows. The
// fetcher must advance a watermark (or skip already-seen ids) before scheduling.
export async function ingestEmail(
  tenantId: string,
  technicianRef: string,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const fetch = deps.fetch ?? gmailFetcher;
  const classify = deps.classify ?? sonnetClassifier;

  const emails = await fetch();
  let ingested = 0;
  let skipped = 0;
  for (const email of emails) {
    const { isWork } = await classify({ subject: email.subject, body: email.body, from: email.from });
    if (!isWork) {
      skipped++;
      continue;
    }
    await recordFieldNote(
      {
        tenantId,
        technicianRef,
        channel: 'email',
        text: `Subject: ${email.subject}\nFrom: ${email.from}\n\n${email.body}`,
      },
      { extract: deps.extract },
    );
    ingested++;
  }
  return { ingested, skipped };
}
