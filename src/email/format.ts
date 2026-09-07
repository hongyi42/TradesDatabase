// Single source of truth for the email → L1 raw_text representation. The Composio
// webhook normalizer (inbound/gmail.ts) is the only path that reaches it today —
// the direct Gmail puller that shared it was deleted in rung 10 — and it stays a
// shared helper because the shape is what every reader of an email capture
// depends on, whatever writes it next. Keep the CLEAN body separate (for the
// work/personal classifier): only the STORAGE form prepends the headers.
export interface EmailParts {
  from: string;
  subject: string;
  body: string;
}

export function formatEmailRawText({ from, subject, body }: EmailParts): string {
  return `Subject: ${subject}\nFrom: ${from}\n\n${body}`;
}
