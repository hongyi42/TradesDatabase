---
date: 2026-06-30
branch: main
commit: a82ec44
topic: Phone-call input feature — recording inbound customer calls, transcribing, and landing them in the three-layer context spine (incl. store-audio-vs-transcript and recording-stack decisions)
---

## Summary

This documents how an **inbound phone-call capture channel** would map onto the existing
context-spine infrastructure, and answers three open design questions: (1) store raw audio
alongside the transcript or transcript-only; (2) if audio, where it lives; (3) how to do the
recording + transcription, including whether Composio can help. The headline finding: **the spine
is already built for this.** The `capture_channel` enum already contains `'phone_call'`, the L1
`raw_captures` table already has both a `raw_text` column (for the transcript) and a `blob_path`
column whose code comment literally reads "pointer into object storage (audio/photos)", and the
entire write-path (`recordFieldNote` → extract → identity-match → L2/L3) is **channel-agnostic** —
the email connector already proves a non-technician source can reuse it end-to-end. The missing
pieces are all *outside* the spine: a telephony provider to record the call and fire a webhook, a
consent announcement before recording, a speech-to-text step, and a normalizer that maps the
provider payload into the existing `InboundEnvelope` seam. A key external finding: **Composio does
not meaningfully support telephony** — no Twilio toolkit, no "call recorded" trigger — so the phone
path terminates a telephony webhook directly, exactly like the design already anticipated for
non-Composio sources.

## Entry Points

The feature would attach to the system at these existing seams (no new architecture required):

- **L1 insert (the foundation):** [src/db/rawCaptures.ts:24](src/db/rawCaptures.ts#L24) — `appendRawCapture()`, already accepts `rawText`, `blobPath`, `externalId`, `metadata`, and provenance ids.
- **Channel enum (already includes phone):** [supabase/migrations/20260620005307_context_spine.sql:16-22](supabase/migrations/20260620005307_context_spine.sql#L16-L22) — `capture_channel` enum contains `'phone_call'`.
- **Inbound webhook handler:** [src/inbound/webhook.ts](src/inbound/webhook.ts) — Composio-shaped today, but the pattern (verify signature → route → normalize → gate → write) is what a Twilio recording webhook would also follow.
- **Normalizer registry (the extension point):** [src/inbound/normalize.ts:30](src/inbound/normalize.ts#L30) — `registerNormalizer(toolkit, triggerType, fn)`; a new `phone.ts` normalizer would self-register here exactly as [src/inbound/gmail.ts:40](src/inbound/gmail.ts#L40) does.
- **Channel-agnostic write-path:** [src/writePath/recordFieldNote.ts:60](src/writePath/recordFieldNote.ts#L60) — `recordFieldNote()`; works for any `channel` with no changes.
- **MCP tool (alternative manual entry):** [src/mcp/server.ts:42-62](src/mcp/server.ts#L42-L62) — `record_field_note` already exposes `channel` (enum incl. `phone_call`) and `blobPath` params.
- **HTTP server / webhook mount:** [src/mcp/httpServer.ts:113](src/mcp/httpServer.ts#L113) — `/inbound/*` routed before the IP allowlist.

## Key Files

### Spine / L1 storage
- **[supabase/migrations/20260620005307_context_spine.sql](supabase/migrations/20260620005307_context_spine.sql)** — defines the whole spine. Relevant pieces:
  - lines 16-22: `capture_channel` enum — **already contains `'phone_call'`** (and `'technician_voice'`).
  - lines 89-104: `raw_captures` table. Has `raw_text text` (nullable), `blob_path text` (nullable), `metadata jsonb default '{}'`, `channel capture_channel not null`, plus nullable `customer_id`/`job_id`/`visit_id` provenance FKs.
  - lines 24-32 + 117-119: `raise_append_only()` function + `raw_captures_append_only` trigger (fires `before update or delete`) → **L1 is hard-append-only at the DB level.**
  - lines 109-114: L2 rows (`customers`/`jobs`/`visits`) each carry `source_capture_id` FK back to `raw_captures(id)` — the evidence link.
- **[supabase/migrations/20260628213156_raw_capture_external_id.sql](supabase/migrations/20260628213156_raw_capture_external_id.sql)** — adds `external_id text` + partial unique index `uq_raw_captures_external_id (tenant_id, external_id) where external_id is not null`. This is the **dedup key for webhook retries** (a Twilio `RecordingSid` would go here).
- **[src/db/rawCaptures.ts](src/db/rawCaptures.ts)** — typed L1 layer. `AppendRawCaptureInput` (lines 7-20) documents `blobPath` as "pointer into object storage (audio/photos)" and `rawText` as "transcripts / notes". `appendRawCapture()` (lines 24-48) preserves SQLSTATE `23505` so callers can detect dedup collisions.

### Write-path (L1 → L2/L3)
- **[src/writePath/recordFieldNote.ts](src/writePath/recordFieldNote.ts)** — orchestrates append (Phase 1, with external-id dedup at lines 91-123), `extract()` (Phase 2), `matchIdentity()` (Phase 3), and L2/L3 creation with `sourceCaptureId` provenance stamping (customer/job/visit at lines 164/182/193). Accepts `{tenantId, technicianRef, text, blobPath, channel, externalId, occurredAt, sourceMeta, ...}`.
- **[src/writePath/extract.ts](src/writePath/extract.ts)** — `sonnetExtractor` (lines 73-91) calls **Claude `claude-sonnet-4-6`** with a forced extraction tool to pull customer/job/work fields + an L3 `attributes` catch-all from `rawText`. **Works on text only** — it consumes the transcript, never audio.
- **[src/writePath/identityMatch.ts](src/writePath/identityMatch.ts)** — deterministic resolution (confirmed customer → phone → address → today's schedule → ask agent). Phone-number match (lines 56-58) is especially relevant: an inbound call's caller-ID number is a strong identity key.

### Inbound connector seam (the template to copy)
- **[src/inbound/normalize.ts](src/inbound/normalize.ts)** — `InboundEnvelope` (lines 7-21): `{ channel, rawText?, blobRef?, externalId, occurredAt?, sourceMeta?, requiresWorkClassifier? }`. Registry keyed `${toolkit}:${triggerType}`.
- **[src/inbound/gmail.ts](src/inbound/gmail.ts)** — the worked example a `phone.ts` normalizer would mirror. Maps a provider payload → envelope, self-registers on import.
- **[src/inbound/webhook.ts](src/inbound/webhook.ts)** — verifies HMAC (Standard Webhooks), parses tenant + trigger, routes to normalizer, **classify-before-L1 gate** (lines 163-180), maps status → HTTP code with retry semantics (`transient_error → 503`). Uses `technicianRef: connector:${toolkit}`.

### Identity / transport / auth
- **[src/mcp/httpServer.ts](src/mcp/httpServer.ts)** — stateless Streamable HTTP MCP server (port `MCP_HTTP_PORT`, default 8080); `/inbound/*` webhook path is HMAC-authenticated (not the gateway identity header) and runs before the IP allowlist.
- **[src/mcp/identity.ts](src/mcp/identity.ts)** — `resolveIdentityFromHeaders()` verifies `x-tenant-id`/`x-technician-ref`/`x-identity-signature` HMAC (`GATEWAY_IDENTITY_SECRET`). Relevant only for the *agent* path, not the telephony webhook.

### Design docs / context
- **[Three-Layer-Context-Spine-Overview.md:102-103](Three-Layer-Context-Spine-Overview.md#L102-L103)** — already names inbound phone calls as a planned channel: *"recorded → transcribed. The richest and heaviest channel: needs telephony, speech-to-text, and recording-consent handling."*
- **[docs/nemoclaw-tech-agent.md:32-35](docs/nemoclaw-tech-agent.md#L32-L35)** — precedent for the "transcribe-before-the-agent-sees-it" pattern (Telegram voice → Whisper/Deepgram STT → `text` → `record_field_note` with `channel:'technician_voice'`). The phone path is the inbound-customer analog of this.
- **[thoughts/shared/research/2026-06-25-composio-connector-layer.md](thoughts/shared/research/2026-06-25-composio-connector-layer.md)** and **[thoughts/shared/plans/2026-06-25-composio-inbound-connector-seam.md](thoughts/shared/plans/2026-06-25-composio-inbound-connector-seam.md)** — the connector seam this feature plugs into (plan is complete through Phase 3; live Composio E2E deferred).
- **[thoughts/shared/research/2026-06-29-async-webhook-ingestion.md](thoughts/shared/research/2026-06-29-async-webhook-ingestion.md)** — documents that the inbound handler currently runs classify + extract **synchronously on the webhook thread** (two Sonnet calls block the HTTP ack). Directly relevant: telephony providers retry aggressively on slow acks (see Constraints).

## Data Flows

### Proposed end-to-end phone flow (mapped onto existing seams)
1. **Customer dials the business's number** (provisioned at a telephony provider, e.g. Twilio).
2. **Consent announcement plays** — TwiML `<Say>`/`<Play>` "this call may be recorded" **before** the record verb. This is the telephony-layer analog of the repo's "gate before the write" rule.
3. **Call is recorded** (dual-channel recommended: caller on one track, business on the other → clean diarization).
4. **Provider fires a recording webhook** with a media URL + `RecordingSid` + caller number + duration when the recording is ready.
5. **Webhook handler** (new telephony path, modeled on [src/inbound/webhook.ts](src/inbound/webhook.ts)): verify the provider's signature → optionally **copy audio to our object storage and delete from provider** → run STT on the audio → build `InboundEnvelope`.
6. **STT → transcript.** Deepgram/AssemblyAI accept the recording **URL** directly and return a diarized transcript.
7. **Normalizer** maps to `InboundEnvelope`: `{ channel:'phone_call', rawText: <transcript>, blobRef: <our-storage-path>, externalId: <RecordingSid>, occurredAt: <call time>, sourceMeta: {from, to, durationSec, recordingProvider}, requiresWorkClassifier: false }`.
8. **`recordFieldNote()`** runs unchanged: appends L1 row (dedup on `externalId`), `extract()` parses the transcript, `matchIdentity()` resolves the customer (caller-ID phone is a strong key), creates/links L2 job + visit with `source_capture_id` pointing back to the L1 capture.

### Resulting L1 row shape
```ts
await appendRawCapture({
  tenantId,
  channel: 'phone_call',
  rawText: '<diarized transcript>',     // → raw_captures.raw_text
  blobPath: 'audio/2026/06/call-<sid>.mp3', // → raw_captures.blob_path (object-store pointer)
  externalId: '<Twilio RecordingSid>',  // → dedup on (tenant_id, external_id)
  metadata: { fromNumber, toNumber, durationSec, recordingProvider, occurredAt },
  // customerId/jobId left null — resolved async by the write-path
});
```

### Mapping to the three layers
- **L1 (`raw_captures`):** the verbatim transcript in `raw_text`; the audio pointer in `blob_path`; call metadata in `metadata`. Append-only.
- **L2 (`customers`/`jobs`/`visits`):** structured fields the extractor pulls from the transcript (customer name/phone/address, job title/type, visit), each stamped with `source_capture_id`.
- **L3 (`attributes` JSONB on L2 rows):** long-tail fields from the extractor's `attributes` catch-all (e.g. urgency, callback preference).

## External Dependencies

### Existing (already in repo)
- **Supabase** (`raw_captures` + spine; service-role key). `blob_path` implies **Supabase Storage** is the natural home for audio, but **no Storage bucket / upload / URL-signing code exists yet** — `blob_path` is a reserved text pointer only.
- **Anthropic `claude-sonnet-4-6`** — extraction/classification/synthesis (`ANTHROPIC_API_KEY`).
- **Composio** — inbound connector layer (Gmail today). **Not usable for telephony — see below.**

### New (would be introduced by this feature)
- **A telephony provider** — Twilio is the reference. Inbound recording via `<Dial record="record-from-answer-dual">` + `recordingStatusCallback`; consent via `<Say>`/`<Play>` before recording (Twilio plays **no** disclosure automatically; `playBeep` is a tone, not consent). Recording cost ≈ **$0.0025/min**; Twilio retains recordings **indefinitely until you delete them**. Alternatives: Telnyx, Vonage, Bandwidth, Plivo (CPaaS), or all-in-one voice-AI platforms (Vapi/Bland/Retell, ~$0.05–0.14/min) that bundle number + recording + diarized transcript.
- **A speech-to-text provider** — **Deepgram Nova-3** (~$0.0077/min, diarization +$0.002/min) or **AssemblyAI** (~$0.0035/min batch, diarization +$0.02/hr). Both ingest a **remote recording URL** directly — the best fit for "transcribe this recording." **OpenAI Whisper/gpt-4o-transcribe is a poor fit here**: no remote-URL ingest (file upload ≤25 MB only) and no native speaker diarization. Twilio also offers built-in transcription (Voice Intelligence ~$0.024–0.07/min) if you want one fewer vendor.

### Composio — explicitly NOT a fit for telephony (key external finding)
Research against Composio's live docs/catalog (mid-2026):
- **No Twilio toolkit** — only an open feature request (GitHub Discussion #3013); `TWILIO_*` actions are proposed, not shipped.
- **No telephony trigger anywhere** — no "call recorded" / "transcription ready" inbound trigger. Composio's trigger model targets SaaS app events (Gmail/Slack/Calendar), not provider-push telephony webhooks carrying media URLs.
- Voice-AI toolkits that *do* exist (ElevenLabs ~155 tools, Retell AI ~67 tools) are **action-only with zero triggers** — you can *initiate* calls or *poll* for a transcript by ID, but nothing pushes a "call done" event in.
- Composio's own webhook delivery uses the Standard Webhooks HMAC scheme (`webhook-id`/`webhook-timestamp`/`webhook-signature`), which is for *Composio's* outbound delivery — unrelated to verifying an upstream telephony provider's signature (e.g. Twilio's `X-Twilio-Signature`), which Composio doesn't handle.

**Conclusion:** the phone path terminates the telephony provider's webhook **directly** (verify the provider's own signature, gate the L1 insert) — it does **not** flow through Composio. This is consistent with the connector-seam design, which already separates "Composio carries the credential" from "we own the judgment and the write."

## Constraints and Invariants

- **L1 is hard-append-only** (DB trigger `raw_captures_append_only`). Consequences for audio/transcripts:
  - Any **PII redaction must happen before the L1 insert** — there is no delete/update path to scrub a transcript after the fact (mirrors CLAUDE.md's email work-vs-personal rule).
  - **`blob_path` is just a text pointer, not the bytes** — so audio *lifecycle/retention/deletion lives in object storage (e.g. S3/Supabase lifecycle rules), never in L1.* Deleting the audio file later does not violate L1's append-only rule because the L1 row (the pointer + transcript) is unchanged. This cleanly separates "the immutable evidence record" from "the deletable heavy blob."
- **Transcript vs. audio size:** raw audio (~0.5 MB/min mono) is ~1,000× larger than its transcript. Transcripts are effectively free to keep forever; audio is linear unbounded cost + biometric/voiceprint privacy risk (GDPR Art. 9, Illinois BIPA, CCPA).
- **`external_id` dedup is per-tenant and partial-null** — telephony webhooks retry; pass the provider's stable recording id as `externalId` to make re-delivery idempotent. (Twilio observed to retry; Composio observed to retry 1→4 with ~5–11s deltas — providers in general retry aggressively.)
- **Inbound handler is synchronous today** ([2026-06-29-async-webhook-ingestion.md](thoughts/shared/research/2026-06-29-async-webhook-ingestion.md)): classify + extract (two Sonnet calls) block the HTTP ack. Adding STT (another network call) to that same synchronous path would lengthen the ack further and risk telephony-provider retry storms — this is the strongest argument for an **async/queued** phone ingestion path (download+transcribe out-of-band, ack the webhook fast).
- **Consent is one/two-party-dependent in the US** (federal one-party; ~11–12 all-party states incl. CA, FL, IL, MA, PA, WA). Architecturally: make the announcement a **non-skippable step that gates recording**, the same "gate before the irreversible action" pattern the spine already uses. (Not legal advice.)
- **Multi-tenancy invariant** ([docs/nemoclaw-tech-agent.md:130](docs/nemoclaw-tech-agent.md#L130)): one business = one tenant UUID. Each tenant's phone number must map to its `tenant_id` at the webhook boundary (e.g. look up tenant by the `To` number).
- **Caller-ID is a first-class identity key** — `matchIdentity()` already resolves customers by phone ([identityMatch.ts:56-58](src/writePath/identityMatch.ts#L56-L58)), so an inbound call's `from` number plugs straight into existing resolution.

## Open Questions

These are the decisions the user explicitly asked about. The research surfaces the tradeoffs; the choices remain to be made (and would belong in a `/plan`).

1. **Store audio + transcript, or transcript-only?** The schema already supports *both* (`raw_text` + `blob_path`), and the two are decoupled: the transcript is the durable L1 evidence, the audio is an optional pointer that can be lifecycle-deleted independently without violating append-only. Tradeoff is audio's ~1,000× size, ongoing storage cost, and biometric-PII/compliance surface vs. its dispute/evidentiary value. A two-tier policy (audio short-term 30–90 days with auto-expiry; redacted transcript long-term) is the conventional answer — **not yet decided here.**
2. **If audio is stored, Supabase Storage or elsewhere?** `blob_path`'s comment points at object storage generically; no bucket exists yet. Supabase Storage keeps it in one vendor (~$0.0213/GB/mo + egress); S3 is cheaper at scale with mature lifecycle/Glacier tiering and SSE-KMS. Either satisfies the `blob_path` contract. **Undecided — needs a bucket + upload + (signed-URL) read path that doesn't exist yet.**
3. **Recording/transcription stack:** assemble-it-yourself (Twilio record → copy to our storage → Deepgram/AssemblyAI URL transcription → normalizer) gives maximum control over storage/retention/cost; an all-in-one voice-AI platform (Vapi/Retell) is faster to stand up but cedes storage/retention control at higher per-minute cost. **Composio is ruled out as the integration layer for this path** (no telephony support). Whichever provider, the landing seam (`InboundEnvelope` → `recordFieldNote`) is identical.
4. **Sync vs. async ingestion** — given the existing synchronous webhook path already runs two Sonnet calls before acking, does the phone path need a queue/background worker so STT + extract don't block (and trip) the telephony retry timer? Likely yes; not yet designed.
5. **Does a phone call need the work-vs-personal classifier?** Email sets `requiresWorkClassifier: true`. Inbound business-line calls are presumably all work (the connector code suggests `false` for phone), but spam/wrong-number calls are a real category — undecided whether a pre-L1 gate is warranted.
6. **Tenant routing from a phone number** — the mechanism to resolve `tenant_id` from the dialed (`To`) number isn't built; needs a number↔tenant mapping.

---

## Follow-up: Retention/compliance + provider research (2026-06-30)

Decisions captured from the user: **storage location = Supabase Storage** (locked). Retention posture
(two-tier vs transcript-only) deferred pending the compliance investigation below. Provider choice to
be driven by transcription quality + future flexibility for an AI-receptionist-with-human-handoff.
Both threads are *compliance-structure / market* research, **not legal advice**.

### A. Audio-retention compliance structure

**The single most load-bearing finding: the biometric-privacy laws trigger on a *voiceprint*, not on
storing raw audio.** BIPA (740 ILCS 14/10), Texas CUBI (§ 503.001), and Washington (RCW 19.375) all
enumerate "voiceprint" — a mathematical template of vocal characteristics extracted and used to
*identify* a person — not the audio file itself. WA *expressly excludes* audio recordings. CCPA/CPRA
(§ 1798.140) is broadest ("voice recordings, from which an identifier template … can be extracted")
but a customer-service recording is biometric *information* only, and rises to *sensitive* PI only if
used to uniquely identify. **A text transcript is not a biometric identifier under any of the four.**

- **Decisive design lever:** *never compute speaker-identifying voiceprints / biometric diarization.*
  That one choice removes the biometric trigger under all four regimes and reduces the audio-vs-transcript
  question to a **retention / breach-surface / PCI** question, not a biometric one. **Caveat that matters
  for this repo:** caller-vs-business separation should come from **dual-channel recording** (caller on
  one track, business on the other — acoustic channel split, no template), *not* from acoustic
  voiceprint diarization. Some STT tools labeled "diarization" attribute speakers via voiceprints —
  using channel-based separation sidesteps that. Discarding audio *after* a voiceprint was computed
  does **not** cure the violation.
- **What auto-delete (30–90d) buys, compliance-wise:** data-minimization / storage-limitation
  (GDPR Art. 5 as the canonical articulation — likely *out of territorial scope* for a US-only SaaS, cite
  as best practice; CCPA § 1798.100(c)+(a)(3) as the binding analog: retention must be "reasonably
  necessary and proportionate" and the period must be *disclosed*). The FTC has repeatedly ordered
  retention schedules that "preclude indefinite retention" (Drizly). A **documented + automated +
  disclosed** schedule is the control that matters — and it must be **litigation-hold-suspendable**
  (auto-deleting under a hold is spoliation).
- **Consent is a *separate* regime keyed to capture, not retention.** Federal one-party (18 U.S.C.
  § 2511); ~11–12 all-party states (the list/count genuinely varies by source — *don't hard-code it*;
  obtain all-party consent on every call, strictest state as the floor). Storing audio vs. transcript
  **does not change** the consent calculus, and transcript-only does **not** cure a consent defect.
  The "this call is recorded" announcement must gate *recording itself* — matching the repo's
  "gate before the irreversible write" rule.
- **PCI / spoken card data:** never store a spoken CVV (PCI DSS v4.0.1 Req 3.3.1 names `.wav`/`.mp3`);
  the old "can't be data-mined" carve-out is effectively obsolete. Transcript-only + redaction-at-
  transcription (Deepgram/AssemblyAI emit `[CREDIT_CARD_NUMBER]`/`[US_SOCIAL_SECURITY_NUMBER]`
  placeholders) materially reduces exposure; best is to keep card SAD out of the recording entirely
  (DTMF/pause-resume). Audio redaction is coarser (mutes a segment, keeps the original by default).
- **Vendors:** sign DPAs (Supabase + whichever STT vendor); all major STT vendors are no-train-by-default
  (AssemblyAI requires affirmatively setting opt-out + calling DELETE). BAA only needed if health
  context ever enters — a trades CRM is presumptively neither a HIPAA covered entity nor BA.

**Comparison for the decision:**

| | Two-tier (audio 30–90d auto-delete + transcript forever) | Transcript-only |
|---|---|---|
| Biometric-law exposure | Low-to-moderate *if no voiceprint is ever computed*; raw-audio-at-rest is the artifact a plaintiff points at (CCPA's "can be extracted" is capability-based). | Lowest — nothing to extract a template from. Transcript still "personal information" under CCPA. |
| Breach surface | Larger during the window (audio may contain spoken PAN/CVV/SSN, hard to redact/search); bounded by auto-delete. | Smaller — redact PII at transcription, store scrubbed text only. |
| Compliance burden | Higher: retention schedule + automated deletion + litigation-hold override + disclosed period + PCI controls. | Lower: redaction pipeline + transcript retention policy + DPAs. |
| What you lose | Storage cost + deletion engineering + residual window exposure. | The audio: dispute evidence, QA, tone/intent, **and the ability to re-transcribe with a better model later.** |

### B. The genuine tension (retention length ↔ re-transcription)

The compliance thread leans **transcript-only or short auto-delete**. The provider thread (below)
makes the opposite point for *your domain*: trades-call audio is noisy / accented / jargon-heavy /
multi-speaker — exactly the regime where STT WER still improved **~15–50% from 2024→2026** (clean
read-speech has plateaued). So "store the audio, re-transcribe when a better model ships" is a *real*
benefit here — **but only if audio is kept long enough for a materially better model to appear
(months–years) and stored losslessly (WAV/FLAC; MP3 discards data no future model recovers).** A
30–90-day window captures breach-surface savings but **won't** capture next year's model. **This is
the crux of the two-tier-vs-transcript-only decision:** the re-transcription upside wants *long*
audio retention; compliance/breach wants *short*. They can't both be maximized.

### C. Provider research (transcription quality + AI-receptionist flexibility)

**Architectural principle from the research: decouple the call layer from the STT layer.** Store the
raw recording (lossless) to Supabase Storage on every call into L1; run STT separately and
re-runnably. This satisfies the re-transcription goal, fits L1 append-only, and lets you swap STT
vendors as the leaderboard moves.

**STT quality today (for noisy, channel-separated phone audio):**
- **AssemblyAI Universal-3** — best *balance*: strong noisy-audio WER (~8%), most mature diarization,
  ingests a remote recording **URL** async, cheapest mainstream (~$0.15–0.21/hr). Best fit for
  "point STT at audio sitting in Supabase and get a clean transcript."
- **ElevenLabs Scribe v2** — accuracy leader on the independent Artificial Analysis leaderboard
  (~2.2% AA-WER), strong diarization, URL ingest. Reservation: lead is on general audio, not 8 kHz telephony.
- **Deepgram Nova-3** — the streaming/real-time pick (sub-300ms; it's the default STT inside Twilio
  ConversationRelay).
- **Rule out for batch-from-storage:** OpenAI gpt-4o-transcribe / Whisper — no remote-URL ingest, 25 MB cap.
- **Trajectory:** decelerating overall, still meaningful on *hard* audio (your case). Benchmark on your
  own trades-call audio — vendor numbers are clean-studio.

**AI-receptionist-with-human-handoff platforms (the future "wait for a human OR talk to AI" flow):**

| Platform | Live AI | Human warm-transfer | "Press 1 human / press 2 AI" + queue | Recording+transcript to our DB | Supabase export | Notes |
|---|---|---|---|---|---|---|
| **Vapi** | Yes | Richest warm-transfer toolkit | **Not documented** (no DTMF/queue) | `end-of-call-report` webhook | **Native BYO-bucket → Supabase** | Easiest "start passive → grow into AI"; best fit for this stack |
| **Twilio ConversationRelay + Flex/TaskRouter** | Yes | Documented AI→human handoff w/ context | **Best-in-class** — native `<Gather>`+`<Enqueue>`+TaskRouter | You own pipeline (Recording + STT) | External storage **S3-only** | Only stack that does the exact press-1/press-2 + queue flow; cost = build effort (you run the WebSocket/LLM loop) |
| **Retell AI** | Yes | Clearest cold/warm semantics | Routing yes; explicit DTMF queue unconfirmed | `call_ended` webhook (URL expires 10 min) | Pull-and-store | BAA on pay-as-you-go; built-in PII redaction |

- **Cleanest fit for this repo (start simple, keep optionality):** **Vapi** in record-first mode with
  custom storage pointed at **Supabase** (aligns with the locked storage decision), capturing the
  end-of-call webhook into L1; run **AssemblyAI** async on the stored audio for the canonical diarized
  transcript. Vapi already supports live AI + warm transfer, so the receptionist can be switched on
  later without changing platforms — its one gap is DTMF press-1/queue routing.
- **If the exact "press 1 wait for a human / press 2 talk to the AI" + queue is a hard requirement
  sooner:** **Twilio ConversationRelay + Flex/TaskRouter** is the only stack that natively does it
  (BYO-LLM, BYO-STT) — but it's S3-only for native external storage (a download→copy-to-Supabase step
  would be needed to honor the Supabase decision) and is the most build-heavy.

### Updated decision state
- **Storage location:** Supabase Storage — **decided.**
- **Retention posture:** still open — turns on §B's tension. If re-transcription matters → longer-retention
  two-tier (lossless WAV); if compliance-minimalism wins → transcript-only (or short 30–90d two-tier). In
  *either* case: never compute voiceprints (use dual-channel), redact PII before persisting, gate consent
  at capture.
- **Provider:** leaning Vapi (record-first, native Supabase) + AssemblyAI (batch STT) for the optionality
  path; Twilio ConversationRelay+Flex if the press-1/queue receptionist is needed sooner. Not decided.
- **Retention (updated):** leaning **short two-tier** — audio ~30d auto-delete (config knob, dial-to-zero
  = transcript-only), transcript long-term. Dual-channel (no voiceprints), redact only SAD (card/CVV/SSN),
  keep name/address/job details (that's the spine's purpose).

### D. Regulatory setup for the short two-tier design (not legal advice)

No licenses, filings, or agency registrations. The "setup" is behaviors + contracts + a deletion job.

**Must-dos:**
1. **Consent announcement (the only hard legal gate):** play "this call is recorded" before recording
   starts, non-skippable, on every call; treat as all-party (caller's state unknown). **Log that the
   announcement played** as the consent record. Mirrors the repo's "gate before the irreversible action."
2. **Documented retention schedule + working deletion:** written policy (audio ~30d, transcript [X]);
   **automated deletion** — note **Supabase Storage has no native S3-style object-expiry lifecycle**, so
   the 30-day purge must be built (`pg_cron` / Edge Function deleting audio objects older than N days);
   **litigation-hold override** to suspend auto-delete (deleting under a hold = spoliation).
3. **Privacy-notice disclosure (CCPA/CPRA if in scope):** disclose collection of recordings+transcripts,
   purpose, and **retention period**. A notice, not a filing.
4. **DPAs** with Supabase, Vapi, AssemblyAI, telephony carrier; AssemblyAI needs explicit no-train opt-out
   + DELETE; track sub-processors.

**Controller/processor split (architectural):** each trades business is the "business"/controller for its
own callers; the SaaS is the processor. Caller-facing notice + CCPA "business" duties sit with the tenant;
the SaaS must supply the tooling (announcement, deletion support) and sign a DPA *with* the tenant. Settle
which side owes what in the tenant ToS.

**Not required (and why):** biometric notice/consent — N/A by design (no voiceprints, channel-based
diarization, content-only transcripts); STIR/SHAKEN & 10DLC — outbound/SMS only, inbound is out of scope
(revisit if the receptionist dials out); PCI DSS — out of scope unless card payments are taken by phone
(redact SAD before persist keeps it out); HIPAA/BAA — not a covered entity/BA for a trades CRM.
