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

// THE BARE ADDRESS inside a sender/recipient string: "Mike <mike@acme.com>" →
// "mike@acme.com". The `senderDomain` precedent (db/droppedAudit.ts) reads the
// same shape but keeps only the domain, because that row must stay content-free;
// this one keeps the WHOLE address, because rung 10b matches a customer on it.
// Trimmed and lower-cased so what the door looks up and what a customer record
// holds agree whatever case either was typed in. Null when there is no '@' at
// all — a display name on its own is not an address, and handing one to the
// matcher as a key would be a guess.
export function emailAddressOf(from: string | null | undefined): string | null {
  if (!from) return null;
  const angled = from.match(/<([^>]*)>/);
  const candidate = (angled ? angled[1] : from).trim().toLowerCase();
  return candidate.includes('@') ? candidate : null;
}

// ONE MESSAGE IN A CONVERSATION, as the extractor is shown it. Lives here rather
// than beside either producer because it has two: Composio's thread fetch
// (src/composio/threads.ts) and our own captures on that thread
// (db/rawCaptures.ts). A shape both a db module and a connector module import
// belongs in neither.
export interface ThreadMessage {
  messageId: string | null;
  from: string | null;
  to: string | null;
  subject: string | null;
  body: string;
  at: string | null;
}
