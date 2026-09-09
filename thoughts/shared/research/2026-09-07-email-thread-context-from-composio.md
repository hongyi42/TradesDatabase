---
date: 2026-09-07
branch: main
commit: caad21f
topic: Can the spine see an email's whole reply chain? What Composio's Gmail trigger delivers (it carries `thread_id` — we dropped it until PR #213), what a thread read returns (proven live on the pilot mailbox), what the extractor is handed today, where the firm's own replies go missing, and the first live reply (captured with its thread id, then parked unmatched).
supersedes: nothing
---

**`supersedes:` is not optional bookkeeping.** This document overturns no prior decision. It
settles the "likely but UNVERIFIED" items in the 2026-09-07 email-chain finding (local memory
`email-chain-context-gap`) against Composio's live API and the pilot mailbox, so rung 10b's plan
can be written against facts rather than guesses.

## Summary

Every email reaches the spine one message at a time: a Composio Gmail trigger POSTs the new
message to our webhook, the normalizer keeps five fields, and the extractor is handed the string
`Subject: …\nFrom: …\n\n<body>` and nothing else. So a reply arrives with no memory of what it is
replying to — "yes, Friday works" is extracted as an island. **The chain is available.** The
trigger payload carries a `thread_id` field that we have been dropping since the channel was
built, and Composio's Gmail toolkit has a tool, `GMAIL_FETCH_MESSAGE_BY_THREAD_ID`, that returns
every message in a thread in the same shape the trigger delivers. Both were confirmed against
Composio's live API and then proven on the pilot's own paired mailbox (manager-sam's account) on
2026-09-07: one read by message id returned the thread id, one read by thread id returned the
thread, each in about 0.7 seconds, and neither is swept into L1 by the Composio log ingestion
(reads are skipped by prefix). Two things the chain still cannot contain: mail that arrived before
we started watching, and replies a person sends from the Gmail app rather than through the
assistant, because the trigger watches the INBOX label only. The outbound side already stores a
thread id on every email the assistant sends (`metadata.threadId`); the inbound side stores
`from`, `subject`, `occurredAt`. L1 is append-only, so every inbound email landing today without
its thread id is permanently un-chainable.

## Entry Points

- `src/inbound/webhook.ts:124` `handleInboundWebhook` — verify → parse → route → classify → `recordFieldNote`. Builds the L1 `sourceMeta` at `:270-281` (`from`, `subject`, optional pairing stamp).
- `src/inbound/gmail.ts:17` `gmailNewMessageNormalizer` — reads `message_id`, `sender`, `subject`, `message_text`, `message_timestamp` from the trigger's `data` (`:7-13`); everything else is dropped.
- `src/writePath/recordFieldNote.ts:226` — `extract(rawText, …)` where `rawText = landed.raw_text` (`:210`): the extractor's whole input is the stored L1 text.
- `src/writePath/extract.ts:57` `Extractor = (rawText, ctx?) => …` — no context parameter exists.
- `src/composio/pairing.ts:245-247` `ensureTrigger` — creates `GMAIL_NEW_GMAIL_MESSAGE` with `triggerConfig: { interval: 1, labelIds: 'INBOX', userId: 'me' }`; `scripts/composio-trigger.mjs:59-61` does the same by hand.

## Key Files

- **`src/inbound/gmail.ts`** — `GmailMessagePayload` (5 of the payload's 12 fields), `formatEmailRawText` call.
- **`src/email/format.ts:13`** — `formatEmailRawText({from, subject, body})` → `Subject: …\nFrom: …\n\n<body>`. The single L1 storage form for email, inbound and outbound.
- **`src/inbound/webhook.ts`** — `sourceMeta` keys written to L1 metadata; `requiresWorkClassifier` gate before L1.
- **`src/composio/outbound.ts:42-91`** — `sendGmailEmail`: the server-side execute shape (`client.tools.execute(slug, { connectedAccountId, userId, arguments, dangerouslySkipVersionCheck: true })`), cost recorded via `recordComposioCall` (`:57-66`), and `threadId` picked from the send response (`:83`).
- **`src/mcp/server.ts:3445-3462`** — the outbound L1 capture: `metadata: { to, subject, sentVia: 'GMAIL_SEND_EMAIL', threadId }`. **The outbound side already keeps the thread id, under the key `threadId`.**
- **`src/composio/pairing.ts:117-175`** — `checkPairing`: the other server-side execute precedent (`GMAIL_GET_PROFILE`), with the `billed` flag pattern for cost recording.
- **`src/composio/logIngest.ts:30-33`** — `READ_SLUG_PREFIXES` includes `GMAIL_FETCH_`, `GMAIL_GET_`, `GMAIL_LIST_`: a thread read never becomes an L1 row. `EMAIL_SEND_SLUGS` (`:23`) already lists `GMAIL_REPLY_TO_THREAD`.
- **`src/db/droppedAudit.ts:19`** — `senderDomain`: the only existing parser of a `"Name <user@host>"` sender string (domain only).

## Data Flows

### 1. What the trigger delivers, and what survives (verified against the live API, 2026-09-07)

`GET https://backend.composio.dev/api/v3/triggers_types/GMAIL_NEW_GMAIL_MESSAGE` returns the
event **payload** schema (the docs say `triggers.getType()` returns the config schema; the REST
resource carries both `config` and `payload`). Payload properties, verbatim:

```
attachment_list, id, label_ids, message_id, message_text, message_timestamp,
payload, preview, sender, subject, thread_id, to
```

`thread_id` — `{ "type": "string", "description": "The thread ID of the message" }`.

```
Composio trigger (poll INBOX every 1 min)         src/inbound/gmail.ts            L1 raw_captures
 data: { message_id, sender, subject,      ──►   keeps 5 fields          ──►   raw_text = Subject/From/body
         message_text, message_timestamp,        DROPS thread_id, to,           metadata = { from, subject, occurredAt }
         thread_id, to, label_ids, payload,      label_ids, payload,            external_id = message_id
         preview, attachment_list, id }          preview, attachments
```

Pilot evidence (hosted DB, read-only, 2026-09-07): three email captures exist — the two rung-10
test emails (`external_id` `1a07e2678ec82d70`, `1a07e2f8962a4f06`) and one seed row. Metadata keys
on all three: `from`, `subject`, `occurredAt` (seed: `from`, `subject`). No thread id anywhere.

### 2. Reading a thread (proven live on the pilot mailbox, 2026-09-08T01:02Z)

Executed through `@composio/core` exactly as `outbound.ts:49` does, under the pilot's paired
account (`ca_VmvfIjwbvfjQ`, user `<tenant>:manager-sam`), read-only, two billed executions:

| call | argument | result | time |
|---|---|---|---|
| `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID` | `message_id: 1a07e2f8962a4f06` | `successful: true`, `threadId: 1a07e2f8962a4f06` | 713 ms |
| `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` | `thread_id: 1a07e2f8962a4f06` | `successful: true`, `messages: [1]` | 657 ms |

Tool output shape (`data.messages[]`, camelCase — the trigger payload is snake_case):
`to, sender, payload, preview, subject, labelIds, threadId, messageId, messageText,
attachmentList, messageTimestamp`, plus `display_url` on the live rows. The thread object also
carries `historyId` and `threadId`. A thread-starter's `threadId` equals its own `messageId`
(Gmail's convention, confirmed on both test emails).

```
inbound email (thread_id = T)
   │
   ├─ today: extract(Subject/From/body)                       ← one message, no history
   │
   └─ possible: GMAIL_FETCH_MESSAGE_BY_THREAD_ID(T) ~0.7 s   ← every message Gmail holds in T,
                 under the MAILBOX's own connected account       including the firm's replies
                 (webhook already has tech.composio_connected_account_id)
```

### 3. Where the firm's own replies go

- Sent **through the assistant** (`send_email` → `GMAIL_SEND_EMAIL`): captured as `outbound_email` with `metadata.threadId` (`server.ts:3455-3461`), classifier-free (recorded exception, CLAUDE.md).
- Sent **from the Gmail app by a person**: never arrives. The trigger watches `labelIds: 'INBOX'`; a sent message carries the `SENT` label, not `INBOX`. The trigger config's `query` field accepts Gmail search syntax and its own examples include `'label:inbox OR label:sent'`; `query` takes precedence over `labelIds` (config schema, live API). Config is per trigger instance — the live one (`ti_hSKW81HqamaI`) has `{ query: "", userId: "me", interval: 1, labelIds: "INBOX" }`.

### 4. What a thread assembled from L1 alone would contain

Captures sharing a thread id: inbound rows (once the key is stored) plus outbound rows (`threadId`
already stored). Missing by construction: messages from before the mailbox was paired, human-sent
replies (flow 3), and the three existing pilot captures. Partial free backfill: because a
thread-starter's thread id equals its message id, and `external_id` IS the Gmail message id, a
later reply's `thread_id` can be matched to an already-captured starter by `external_id`.

### 5. The first reply, end to end (live, 2026-09-08, after PR #213 deployed as `262a27a`)

The owner replied from the other test address to the "Friday morning for the water heater" thread:
*"Is it possible to do Friday afternoon instead?"*

```
06:42:48Z  reply sent (Composio's provider watermark)
06:44:05Z  Composio's trigger state lists the new message id 1a07fc177a6ca10a
06:44:08Z  POST /inbound/composio → 200 in 2758 ms (Render request log)
06:44:06Z  capture 473a9b35… lands: metadata keys from, labelIds, occurredAt, subject, threadId, to
           threadId = 1a07e2f8962a4f06  ← the ORIGINAL email's external_id (thread starter == its message id)
           labelIds = [UNREAD, IMPORTANT, CATEGORY_PERSONAL, INBOX]
           raw_text 564 chars vs the original's 258: quote lines ("\n>") and an "… wrote:" marker present
```

What the door then did: **nothing** — 0 observations, 0 `job_captures`, 0 `visit_notes`. The reply
was parked as unmatched (`needs_disambiguation` → webhook `ingested`, no retry), although it is the
same sender as the original, in the same thread, about a job that has a booked visit (Fri 09-11,
crew Hman), and the customer's exact phone string sits in the quoted history. The customer (Tom
Becker) has a phone and an address on file and **no email**. So: the extractor did not read the
phone out of the quoted text (it did from the original's fresh body); email matching could not have
helped here; the thread id is the only key that links this reply to its customer.

Two of the four earlier polls on this mailbox were personal newsletters (03:01Z, 03:18Z), both
dropped before L1 with content-free receipts — the classifier at work on a real inbox.

## External Dependencies

- **Composio Gmail toolkit** — 23 tools (`GET /api/v3/tools?toolkit_slug=gmail`, 2026-09-07). Thread-relevant: `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` (input `thread_id` required, `user_id`, `page_token`), `GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID`, `GMAIL_LIST_THREADS` (`query`, `verbose`, `max_results`, `page_token`), `GMAIL_FETCH_EMAILS`, `GMAIL_REPLY_TO_THREAD`. Documented with parameters at <https://docs.composio.dev/toolkits/gmail>.
- **Trigger delivery** — Gmail is a *polling* trigger; the docs state latency of "up to ~15 min on Composio-managed auth" for polling triggers (<https://docs.composio.dev/docs/triggers>). Measured 2026-09-07 with our `interval: 1`: test email timestamped `23:23:46Z`, capture landed `23:24:44Z` (58 s). One data point.
- **Trigger creation / config** — `triggerConfig` (TypeScript) / `trigger_config` (Python); `triggers.getType('SLUG')` returns the config schema (<https://docs.composio.dev/docs/setting-up-triggers/creating-triggers>). No documented endpoint returns trigger *delivery logs*; `/api/v3/logs/trigger`, `/api/v3/trigger_instances/logs` and `/api/v3/triggers/logs` all 404 (probed 2026-09-07).
- **SDK** — `@composio/core ^0.13.1` pinned (`package.json:49`); the SDK prints "Latest version: 0.18.1" on every run.

## Constraints and Invariants

- **L1 is append-only, one capture per message.** A thread read must never be stored as a new capture: its messages are either captures already, or mail that was never classified. The chain is *context for extraction*, not a record.
- **Un-stored is un-recoverable.** A field the normalizer drops is gone; there is no update path. Every inbound email landing today is permanently un-chainable.
- **Two spellings of the same id.** Trigger payload: `thread_id` (snake_case). Tool output and the outbound capture: `threadId` (camelCase). Any inbound key must be chosen against `server.ts:3460`.
- **The extractor's signature has no context slot.** `Extractor = (rawText, ctx?: CostContext)`; every stub in the test suite is 1-arg. Prepending history to `rawText` would store it in L1 (`rawText` is the stored text) — the storage form and the extraction input are the same string today.
- **A thread read is billed and must be recorded** (`recordComposioCall`, the `outbound.ts:57-66` and `pairing.ts` `billed` precedents); it is *not* swept into L1 (`READ_SLUG_PREFIXES`).
- **It runs inside the webhook request** if done at ingest time: the rung-10 research rejected a *model* call in-request because of the connector's delivery timeout and retries; a 0.7 s API read is a different order of cost but sits inside the same timeout.
- **The connected account is the mailbox's own**: the webhook resolves `tech` from the composite `user_id` and `tech.composio_connected_account_id` is the pinned account (`webhook.ts:199, :279`).
- **Trigger config is per instance and pinned by code** (`pairing.ts:247`); changing what is watched means re-creating the instance and amending `ensureTrigger`.

## Decision Points

1. **Which payload fields to keep in `sourceMeta`, and under what key.** `thread_id` is the load-bearing one; `to` and `label_ids` are also dropped today. Keeping `threadId` (camelCase) matches the outbound capture; keeping `thread_id` matches the payload. Additive either way; no migration (`metadata` is JSONB).
2. **Where the chain comes from at extraction time.** (a) Assemble from L1 by thread id: no network, no cost, but blind to pre-pairing mail and human-sent replies. (b) `GMAIL_FETCH_MESSAGE_BY_THREAD_ID` per inbound email: complete as far as Gmail knows, ~0.7 s and one billed execution per email, inside the webhook request. (c) Both, in that order. Each needs (1) first.
3. **How the chain reaches the extractor.** A second argument on `Extractor` (prior messages, bounded, oldest first) leaves `rawText` — and therefore L1 — untouched; the alternative changes the stored text.
4. **Whether to watch SENT.** `query: 'label:inbox OR label:sent'` would deliver a person's own replies as trigger events: they would pass through the work/personal classifier like any inbound mail (the classifier-free exception covers assistant-performed sends only), the normalizer would need `label_ids` to tell direction, and the live instance would be re-created.
5. **Thread membership as an identity key.** A reply whose thread starter was already matched to a customer is not from a stranger. Today `matchIdentity` keys on phone and street address only (`src/writePath/identityMatch.ts:62-71`); the 10b plan decides whether thread linkage sits beside email as a key, and in what order.
6. **Backfill of the three existing pilot captures.** None carry a thread id; only the starter-id equality in flow 4 links them, and only for replies that arrive after the key is stored.

## Open Questions

Three of the four were answered by the live reply above (flow 5):
- **A reply's `message_text` DOES carry the client's quoted history** — 564 chars against the
  original's 258, with quote lines and a "wrote:" marker. Quoted history is what the sender's mail
  client chose to include; it is not the record, and the extractor did not read a phone number out
  of it.
- **`thread_id` IS present in the delivered webhook `data`** — the capture carries it, and it
  equals the thread starter's message id.
- **Latency held at ~80 s** with `interval: 1` (06:42:48Z sent → 06:44:06Z captured); the docs'
  "up to ~15 min" was not observed on either day.

Still unopened: what the `payload` and `preview` objects hold (both `additionalProperties: true`);
if `payload` carries the RFC headers (`In-Reply-To`, `References`), thread linkage would not depend
on Composio's `thread_id` at all.
