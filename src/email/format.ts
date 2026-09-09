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
  // AN ADDRESS, NOT MERELY A STRING WITH AN '@' IN IT. Without the shape check
  // a header the parser cannot handle — `Team: jane@x.com;` (group syntax),
  // `a@x.com; b@y.com` (semicolons) — comes back as one long "address" that
  // matches nothing, so the message silently loses its identity key instead of
  // saying it has none. Local@domain, no whitespace either side.
  return /^[^\s@]+@[^\s@]+$/.test(candidate) ? candidate : null;
}

// IS THIS THE FIRM MAILING ITSELF? Rung 10b.2, from a live specimen: the pilot
// mailbox was mailed FROM the pilot mailbox, and the extractor duly recorded the
// firm's own address as the caller's `customerEmail`. Filed onto a customer that
// address becomes an identity KEY, so every later message from our own mailbox
// would match that one person — confidently and wrongly. An address the firm
// sends from identifies the firm, never whoever is writing in; the same reason
// the extractor may not take identity from our own signature block. Callers use
// this to withhold a key, never to drop a capture: the message still lands.
//
// WHICH WAY IT FAILS IS THE WHOLE DESIGN, so it is written down.
//
// A FALSE POSITIVE costs a real customer their identity key: the fallback is
// withheld, they are created with no email, and their next message opens a
// SECOND unmatched item — rung 10b's central promise broken for somebody who did
// nothing unusual. A FALSE NEGATIVE files the firm's own address on a customer,
// which is bad but needs the firm to mail itself first. So this refuses to
// guess: it says yes only when it can NAME our mailbox, two ways.
//
// (1) `pairedMailbox` — the roster's `connected_email` for the person the
//     message was delivered under. Authoritative, and it settles a
//     multi-recipient line outright.
// (2) Failing that, a `to` header carrying exactly ONE address: the best
//     available evidence of the mailbox it arrived at. Evidence, not proof — a
//     customer who mails THEMSELVES and blind-copies the firm also lands here
//     with from == the single recipient, and loses their key. Narrow, and the
//     reason (1) is the arm that matters.
//
// With SEVERAL recipients and no paired mailbox we genuinely cannot tell which
// is ours, so we say no. An earlier version tested every address on the line and
// thereby matched any sender who kept themselves on `To` — a contact form's
// copy-to-sender, a reply-all — which is the false positive above. Semicolon and
// group-syntax headers are left alone too: Gmail's `to` is a comma list
// (src/inbound/gmail.ts), so those shapes are unreachable from our only producer.
//
// ⚠ ARM (1) IS DEAD IN THE PILOT TODAY: the roster row the Gmail trigger
// delivers under carries no connected account, so `connected_email` is null and
// the single-recipient heuristic is all that runs. That is the same roster gap
// that keeps the Composio thread fetch from ever firing — populating
// `connected_email` closes both at once.
export function isOwnMailbox(
  from: string | null | undefined,
  to: string | null | undefined,
  pairedMailbox?: string | null,
): boolean {
  const sender = emailAddressOf(from);
  if (sender === null) return false;
  if (pairedMailbox && emailAddressOf(pairedMailbox) === sender) return true;
  return soleRecipientOf(to) === sender;
}

// THE ONE ADDRESS A MESSAGE WENT TO, or null if it did not go to exactly one.
// Gmail's `to` is a comma list (src/inbound/gmail.ts), and this is the same
// unique-or-refuse rule every identity key follows: with two recipients we
// cannot say which of them the message is ABOUT, and guessing one would file a
// reply on whichever name came first. Semicolon and group-syntax headers are
// deliberately not parsed — unreachable from our only producer.
//
// Used two ways, and they are the same question asked from either end: the
// firm's own OUTBOUND mail (rung 10b.3) identifies the customer by who it was
// SENT to, and `isOwnMailbox` above reads a single recipient as evidence of
// which mailbox an inbound message ARRIVED at.
export function soleRecipientOf(to: string | null | undefined): string | null {
  // DISTINCT addresses: a reply-all that lists the same person twice, or the
  // same address under two display names, still went to exactly one person, and
  // counting it as two would withhold a key we plainly have.
  const recipients = new Set(
    (to ?? '')
      .split(',')
      .map((one) => emailAddressOf(one))
      .filter((one): one is string => one !== null),
  );
  return recipients.size === 1 ? [...recipients][0] : null;
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
