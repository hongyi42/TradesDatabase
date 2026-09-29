import { recordComposioCall, type Technician } from '../db/index.js';
import { compositeUserId, getComposioClient, type PairingClient } from './pairing.js';

// Server-side outbound Composio actions — the technician send path. The agent
// never names a connectedAccountId: the roster row resolved from the badge
// identity is the ONLY reachable account (per-person pairing), and `state` is
// the authority (ids persist after offboarding — offboarding.ts keeps ca_*).
// Manager-tier outbound goes Composio-direct via sessions (sessions.ts), not
// through here.

export interface OutboundDeps {
  client?: PairingClient;
  recordCost?: typeof recordComposioCall;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  body: string;
  /** One stored file sent attached (step 2e). */
  attachment?: SendEmailAttachment;
}

export interface SendEmailAttachment {
  name: string;
  mime: string;
  bytes: Buffer;
}

export interface SendEmailResult {
  messageId: string | null;
  threadId: string | null;
}

// The one authorization gate for outbound actions. Throws the clean,
// caller-facing reason; callers re-use it verbatim on both send_email steps.
export function requireOutboundCapable(tech: Technician | null): asserts tech is Technician {
  if (!tech) throw new Error('no roster row for this badge');
  if (tech.state !== 'active') throw new Error(`'${tech?.ref}' is not active (state: ${tech?.state})`);
  if (!tech.composio_connected_account_id) {
    throw new Error(
      `'${tech.ref}' has no paired mailbox yet — connecting one moves to the settings page`,
    );
  }
}

// Send an email as this person via their paired Gmail. Mirrors the
// GMAIL_GET_PROFILE pattern (pairing.ts): pinned connectedAccountId,
// dangerouslySkipVersionCheck REQUIRED (no pinned toolkit version → the SDK
// throws ComposioToolVersionRequiredError), tolerant envelope parsing
// (`data.response_data ?? data` — exact field names live-verified Phase 5).
export async function sendGmailEmail(
  tech: Technician,
  { to, subject, body, attachment }: SendEmailInput,
  deps: OutboundDeps = {},
): Promise<SendEmailResult> {
  requireOutboundCapable(tech);
  const client = deps.client ?? getComposioClient();
  const args: Record<string, unknown> = { recipient_email: to, subject, body };
  if (attachment) args.attachment = await uploadAttachment(client, attachment);
  const result = await client.tools.execute('GMAIL_SEND_EMAIL', {
    connectedAccountId: tech.composio_connected_account_id,
    userId: compositeUserId(tech),
    arguments: args,
    dangerouslySkipVersionCheck: true,
  });
  // A billed tool execution that NEVER traverses the doorman relay — the relay
  // collector cannot see this path, so it is counted here or not at all. Billed
  // on `successful === false` too: Composio charged for the attempt.
  // .catch() at the call site — a cost-ledger fault must never fail a send the
  // customer is waiting on (and which Composio has already charged for).
  await (deps.recordCost ?? recordComposioCall)({
    tenantId: tech.tenant_id,
    technicianRef: tech.ref,
  }).catch((err: unknown) => {
    console.error(
      `cost: outbound send not recorded — ${err instanceof Error ? err.message : String(err)}`,
    );
  });
  if (result.successful === false) {
    const errText = typeof result.error === 'string' ? result.error : JSON.stringify(result.error ?? 'unknown error');
    throw new Error(`Composio send failed: ${errText}`);
  }
  const data = result.data as Record<string, unknown> | undefined;
  const nested = (data?.response_data ?? data) as Record<string, unknown> | undefined;
  const pick = (...keys: string[]): string | null => {
    for (const k of keys) {
      const v = nested?.[k];
      if (typeof v === 'string' && v) return v;
    }
    return null;
  };
  return {
    messageId: pick('id', 'messageId', 'message_id'),
    threadId: pick('threadId', 'thread_id'),
  };
}

// The attachment goes up to Composio's S3 first and the send names it by its
// descriptor. Our client is `new Composio()` with no options, so the SDK's
// auto-upload is OFF and we upload ourselves: `files.upload` takes a File (not
// a Buffer) plus the tool and toolkit slugs, and returns `{name, mimetype,
// s3key}` — which GMAIL_SEND_EMAIL's `attachment` takes as ONE object, the
// safe shape since this send pins no tool version (@composio/core 0.13.1,
// dist/models/Files.node.d.mts;
// https://docs.composio.dev/docs/tools-direct/executing-tools). The bytes live
// on Composio's S3 from here — inherent to the vendor.
async function uploadAttachment(
  client: PairingClient,
  { name, mime, bytes }: SendEmailAttachment,
): Promise<{ name: string; mimetype: string; s3key: string }> {
  if (!client.files) throw new Error('this Composio client cannot upload files, so the attachment cannot be sent');
  const uploaded = await client.files.upload({
    file: new File([new Uint8Array(bytes)], name, { type: mime }),
    toolSlug: 'GMAIL_SEND_EMAIL',
    toolkitSlug: 'gmail',
  });
  return { name: uploaded.name, mimetype: uploaded.mimetype, s3key: uploaded.s3key };
}
