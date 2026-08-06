# Phone-call capture runbook (SignalWire + AssemblyAI)

Operational + regulatory checklist for the inbound phone-call channel. Design:
[plan 2026-08-04](../thoughts/shared/plans/2026-08-04-phone-call-signalwire.md). Not legal advice.

## What it does

A customer dials the tenant's SignalWire number → a consent line plays → the call is forwarded to the
tenant's real call-center line and recorded (both legs) → an out-of-band worker transcribes it
(AssemblyAI), redacts sensitive-auth data, and lands it in the spine as `channel:'phone_call'`. Audio is
auto-deleted after a retention window; the transcript is kept.

```
caller → SignalWire number ── voice webhook /inbound/phone/voice ──▶ cXML: <Say> consent + <Dial record>
                                                                     │
                             recording done ── /inbound/phone/recording ──▶ enqueue (call_ingest)
                                                                     │
                             calls:worker ──▶ download+copy → AssemblyAI → redact → recordFieldNote
                                                                     │
                             calls:purge ──▶ delete audio past retention (unless legal_hold)
```

## Env (both the web service and the workers need these)

| Var | Purpose |
|---|---|
| `SIGNALWIRE_SPACE_URL` | `https://<space>.signalwire.com` |
| `SIGNALWIRE_PROJECT_ID` | project id; also the Basic-auth username for recording downloads |
| `SIGNALWIRE_API_TOKEN` 🔒 | the **`PSK…` signing key** — validates the `X-SignalWire-Signature` on inbound webhooks. Signing only; it 401s on the REST API. No separate webhook secret. |
| `SIGNALWIRE_REST_TOKEN` 🔒 | the **`PT…` REST API Token** — Basic-auth for the recording-media download (`fetchRecording.ts`). **Scopes must include `Voice` + `Management`** (Management is required for protected-media GET; Voice alone → 401). |
| `SIGNALWIRE_WEBHOOK_BASE_URL` | public https base SignalWire posts to (e.g. the Render URL), no trailing slash |
| `ASSEMBLYAI_API_KEY` 🔒 | STT |
| `CALL_AUDIO_BUCKET` | private Storage bucket (default `call-audio`) |
| `CALL_AUDIO_RETENTION_DAYS` | days to keep audio; `0` = transcript-only |

## Provision a tenant's number

1. Buy/assign a SignalWire number in the tenant's space.
2. Point the number's **"when a call comes in"** (Voice) webhook at
   `${SIGNALWIRE_WEBHOOK_BASE_URL}/inbound/phone/voice` (HTTP POST).
3. Insert the routing row (**both** columns required for forward mode):
   `insert into call_numbers (tenant_id, phone_number, forward_to) values (<tenant>, '<E.164 SignalWire #>', '<E.164 real call-center line>');`
   — **`forward_to` is required**: without it the call can't connect (voicemail mode, `forward_to` null,
   is not the chosen path). This is a mandatory onboarding step whenever a number is provisioned.

## Consent (the one hard legal gate)

- The voice webhook returns cXML that plays a **non-skippable "this call is recorded" `<Say>` BEFORE the
  `<Dial record>`** — recording cannot start before the announcement (gate-before-the-irreversible-action).
- Treat every call as all-party consent (caller's state unknown); the announcement is the consent record,
  logged as `call_ingest.consent_announced = true`.
- Recording is **dual-channel** (`record-from-answer-dual`) — caller and business on separate tracks. This
  is acoustic channel separation, **NOT** voiceprint/biometric diarization. Never enable speaker-identifying
  voiceprints: that would trigger BIPA/CUBI/CCPA biometric regimes. A text transcript is not a biometric
  identifier.

## Retention + legal hold

- Audio auto-deletes after `CALL_AUDIO_RETENTION_DAYS`; the redacted transcript is kept long-term in L1.
- **Supabase Storage has no native object-expiry — `calls:purge` IS the lifecycle.** It must run on a cron.
- **Legal hold:** `setLegalHold(callIngestId, true)` suspends the purge for a specific call (deleting under
  a litigation hold is spoliation). `setLegalHold(id, false)` releases it.
- Redaction removes card/CVV/SSN/routing before the transcript is written (L1 is append-only — scrub before
  the insert). Names/addresses/phones/job details are kept — that is the spine's purpose. Keep spoken card
  data out of the recording entirely where possible (it is best-effort on the transcript).

## Recording download blocked — the `.env` token is rejected by the REST API (live finding 2026-08-06)

The worker downloads recording media over the Compatibility REST API (`src/calls/fetchRecording.ts`) with
HTTP Basic `PROJECT_ID:API_TOKEN` (Media URL Protection is ON — an un-authed media GET returns **401**).
**The webhook path works, but the `.env` token cannot READ from the REST API.** Confirmed live against
the pilot's `PSK…` token — the same token that validates `X-SignalWire-Signature` correctly:

| request | result |
|---|---|
| Relay REST `/api/relay/rest/phone_numbers` (authed) | **401 Unauthorized** |
| LaML `/Accounts/<sid>.json` (authed) | **401 Unauthorized** |
| LaML `Calls.json` / `Recordings.json` / `IncomingPhoneNumbers.json` / recording media (authed) | **200 + a 1-byte `" "` stub from SignalWire's *web frontend*** (website CSP + `x-runtime`), i.e. the request never reached the API backend |

So it is **NOT trial** (confirmed: exiting trial did not change it) and **NOT the webhook-signing token**
— that `PSK…` token signs `X-SignalWire-Signature` but is a *signing key only*, refused by REST. **The
project's REST credential is a separate `PT…`-prefixed API Token** created under API Credentials.

**RESOLVED (credential):** put the `PT…` REST token in `.env` as **`SIGNALWIRE_REST_TOKEN`** (keep the
`PSK…` `SIGNALWIRE_API_TOKEN` for signature validation). With the `PT…` token, REST *lists* work:
`GET .../Calls.json` and `.../Recordings.json` both return real JSON. Wire `fetchRecording.ts` to use
`SIGNALWIRE_REST_TOKEN` for the Basic-auth download (keep `SIGNALWIRE_API_TOKEN` for signing).

**RESOLVED 2026-08-06 — Media URL Protection stays ON; the `PT…` REST token needs the `Management`
scope.** Two things had to be right, discovered live in order: (1) use the **`PT…` REST API Token**, not
the `PSK…` signing key, for the Basic-auth download; (2) that token needs the **`Management` scope** —
**not** just `Voice`. With `Voice` alone, an authenticated GET of the individual protected recording
returned **401** (while `Recordings.json` list returned 200) — the confusing symptom that looked like a
SignalWire bug. **Adding `Management` fixed it:** with **protection ON** and the token scoped
`Voice + Numbers + Storage + Management`, `GET .../Recordings/<sid>.wav` with Basic auth →
**200 `audio/x-wav`, 286,764 bytes, real RIFF/WAV**, and `downloadAndStore` copies it into the private
`call-audio` bucket intact. **`fetchRecording.ts` uses `SIGNALWIRE_REST_TOKEN`** (falls back to
`SIGNALWIRE_API_TOKEN`).

**Keep Media URL Protection ON** (the secure posture): the recording is auth-gated from creation, so it is
**never public** — no exposure window. Only our server (holding the REST token) can fetch it; it copies to
our private bucket and hands AssemblyAI a short-TTL signed URL to *our* bucket (AssemblyAI never sees the
SignalWire URL). **Required token scopes for the download: `Voice` + `Management`** (the load-bearing pair;
`Management` is the non-obvious one that unlocks protected media — undocumented). No support ticket needed;
no delete-after-copy needed for safety (protection ON already gives zero public window). (Media protection:
signalwire.com/docs/platform/media-protection.)

## Cron wiring

- `calls:worker` — **continuous** (long-running drain loop); one process is enough, more scale horizontally
  (SKIP LOCKED). Run alongside the other workers.
- `calls:purge` — **periodic** (e.g. daily). Runs once and exits.

## Cost

SignalWire (per-minute voice + number rental) and AssemblyAI (per-minute STT) are **metered per minute**.
Neither exposes a dollar API, so — like Brave/Composio — they are **counter + bill-driven**: units count
per tenant for attribution, and the monthly invoice dollars are hand-entered into `infra_costs` (there is
**no** auto-collector). A per-tenant minute split would need a new `infra_costs.allocation` branch
(the existing per-usage rule is hardcoded to `provider='spine'`). Until priced, they are silent counters —
add a crossover alert if spend can grow. See the cost-ledger docs.

## DPAs / vendors

- Sign DPAs with **Supabase**, **SignalWire**, **AssemblyAI**.
- AssemblyAI: set the **no-train opt-out** and use its DELETE endpoint as part of retention. Track
  sub-processors.
- **Controller/processor split:** each trades business is the controller for its own callers; this SaaS is
  the processor (provides the announcement + deletion tooling). The caller-facing privacy notice + CCPA
  "business" duties sit with the tenant; settle which side owes what in the tenant ToS.

## Verifying the webhook signature against a live event

`validateRequest` (Twilio-compatible, `X-SignalWire-Signature`) is implemented from the documented scheme;
the **exact signed bytes** (full-URL reconstruction + param encoding) should be confirmed on the first real
event. Capture it with `INBOUND_DEBUG=1` (dev only), compare, and adjust `validateSignalWireSignature` /
`SIGNALWIRE_WEBHOOK_BASE_URL` if needed. A signature mismatch fails closed (403), so a misconfigured base
URL blocks all calls — verify this first when live-firing.
