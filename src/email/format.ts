// Single source of truth for the email → L1 raw_text representation. Both inbound
// email paths (the Gmail pull in ingest.ts and the Composio webhook normalizer in
// inbound/gmail.ts) store this exact shape, so the same message lands as identical
// L1 evidence regardless of which path ingested it. Keep the CLEAN body separate
// (for the work/personal classifier) — only the STORAGE form prepends the headers.
export interface EmailParts {
  from: string;
  subject: string;
  body: string;
}

export function formatEmailRawText({ from, subject, body }: EmailParts): string {
  return `Subject: ${subject}\nFrom: ${from}\n\n${body}`;
}
