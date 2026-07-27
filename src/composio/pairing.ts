import { Composio } from '@composio/core';
import {
  casTechnician,
  recordComposioCall,
  updateTechnician,
  upsertOpenReviewItem,
  type Technician,
} from '../db/index.js';

// Composio pairing lifecycle, server-side. This module is the ONLY place the
// spine talks to Composio at runtime; it holds no state — the technicians row
// (ca_*/ti_*/connected_email/state) is the inventory. All entry points take
// injectable deps so tests never need COMPOSIO_API_KEY.

// Minimal structural view of the SDK surface we use (verified against
// @composio/core 0.13 typings + a live probe 2026-07-02). Item shapes are
// loose on purpose: list envelopes vary (items/data/bare array — same
// tolerance as scripts/composio-reconnect.mjs).
interface ConnectedAccountItem {
  id: string;
  status?: string;
  toolkit?: { slug?: string };
  [k: string]: unknown;
}
export interface PairingClient {
  connectedAccounts: {
    list(q: { userIds: string[] }): Promise<unknown>;
    link(userId: string, authConfigId: string): Promise<Record<string, unknown>>;
    delete(id: string): Promise<unknown>;
    disable(id: string): Promise<unknown>;
    enable(id: string): Promise<unknown>;
  };
  triggers: {
    listActive(q: { connectedAccountIds: string[]; triggerNames?: string[] }): Promise<unknown>;
    create(userId: string, slug: string, opts: unknown): Promise<Record<string, unknown>>;
    delete(id: string): Promise<unknown>;
    disable(id: string): Promise<unknown>;
    enable(id: string): Promise<unknown>;
  };
  tools: {
    execute(slug: string, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  };
  // Sessions (Tool Router GA) — per-person, tier-scoped tool access. Same
  // structural tolerance as the rest of this surface (@composio/core ≥0.13.1
  // has sessions.create/use/delete; verified in installed typings 2026-07-04).
  sessions: {
    create(userId: string, config: Record<string, unknown>): Promise<Record<string, unknown>>;
    use(id: string, opts?: Record<string, unknown>): Promise<Record<string, unknown>>;
    delete(id: string): Promise<unknown>;
  };
}

// Lazy singleton: importing this module must not require the key (the MCP
// server imports it unconditionally; tests inject a stub client). Shared by
// pairing and offboarding.
let liveClient: PairingClient | null = null;
export function getComposioClient(): PairingClient {
  if (!liveClient) liveClient = new Composio() as unknown as PairingClient;
  return liveClient;
}
const getComposio = getComposioClient;

function authConfigId(): string {
  const id = process.env.COMPOSIO_GMAIL_AUTH_CONFIG_ID;
  if (!id) throw new Error('COMPOSIO_GMAIL_AUTH_CONFIG_ID is not set');
  return id;
}

// The vocabulary-contract composite user id (webhook splits on the 1st colon).
// Exported: outbound + sessions must build the IDENTICAL id — never duplicate
// the definition.
export function compositeUserId(tech: Technician): string {
  return `${tech.tenant_id}:${tech.ref}`;
}

function asItems(listResult: unknown): ConnectedAccountItem[] {
  const r = listResult as { items?: unknown; data?: unknown };
  const arr = r?.items ?? r?.data ?? listResult;
  return Array.isArray(arr) ? (arr as ConnectedAccountItem[]) : [];
}

export interface PairingDeps {
  client?: PairingClient;
  update?: typeof updateTechnician;
  cas?: typeof casTechnician;
  openReviewItem?: typeof upsertOpenReviewItem;
  recordCost?: typeof recordComposioCall;
}

// Mint a Connect Link (Composio-hosted OAuth page) for this person and stamp
// the cooldown clock. The URL is sensitive — deliver via the manager only.
export async function createConnectLink(
  tech: Technician,
  deps: PairingDeps = {},
): Promise<{ url: string }> {
  const client = deps.client ?? getComposio();
  const update = deps.update ?? updateTechnician;
  const req = await client.connectedAccounts.link(compositeUserId(tech), authConfigId());
  const url = (req.redirectUrl ?? req.redirect_url) as string | undefined;
  if (!url) throw new Error('Composio returned no redirect URL for the connect link');
  await update(tech.id, { link_issued_at: new Date().toISOString() });
  return { url };
}

export type CheckPairingResult =
  | { status: 'no_op'; reason: string }
  | { status: 'not_connected' }
  | { status: 'paired'; connectedAccountId: string; email: string | null };

// Detect a completed OAuth consent and advance the lifecycle: ensure the mail
// trigger exists, learn the mailbox address, persist the inventory, move the
// row invited → pending_verification, and open the manager's verification item.
//
// GATED ON state === 'invited': the transition is what opens the review item,
// so it fires exactly once per pairing episode — the 15-min cron sweep can
// never re-open an item the manager dismissed (review finding, plan Decisions).
export async function checkPairing(
  tech: Technician,
  deps: PairingDeps = {},
): Promise<CheckPairingResult> {
  const client = deps.client ?? getComposio();
  const update = deps.update ?? updateTechnician;
  const cas = deps.cas ?? casTechnician;
  const openReviewItem = deps.openReviewItem ?? upsertOpenReviewItem;

  // Healing branch: a prior run CLAIMED the row (state advanced, item open)
  // but died before the trigger landed. Finish the trigger, touch nothing else.
  if (
    tech.state === 'pending_verification' &&
    tech.composio_connected_account_id &&
    !tech.composio_trigger_id
  ) {
    const healedId = await ensureTrigger(client, tech, tech.composio_connected_account_id);
    await update(tech.id, { composio_trigger_id: healedId ?? null });
    return {
      status: 'paired',
      connectedAccountId: tech.composio_connected_account_id,
      email: tech.connected_email,
    };
  }
  if (tech.state !== 'invited') return { status: 'no_op', reason: `state is ${tech.state}` };

  const accounts = asItems(await client.connectedAccounts.list({ userIds: [compositeUserId(tech)] }));
  const active = accounts.find(
    (it) => it.toolkit?.slug === 'gmail' && String(it.status).toUpperCase() === 'ACTIVE',
  );
  if (!active) return { status: 'not_connected' };

  // Which mailbox actually connected? The SDK's typed account object exposes
  // no email field (verified offline 2026-07-02), so ask Gmail itself, pinned
  // to this exact connected account. dangerouslySkipVersionCheck is REQUIRED:
  // with no pinned toolkit version the SDK throws ComposioToolVersionRequiredError.
  // Advisory: a null email still opens the review item — the manager can
  // dismiss (wrong mailbox → unpair) if they can't identify it.
  let email: string | null = null;
  // Did the execution actually happen? A throw before/inside it means Composio
  // billed nothing, so the counter below must not fire.
  let billed = false;
  try {
    const profile = await client.tools.execute('GMAIL_GET_PROFILE', {
      connectedAccountId: active.id,
      userId: compositeUserId(tech),
      arguments: {},
      dangerouslySkipVersionCheck: true,
    });
    // Set IMMEDIATELY after the execution: everything below is pure parsing that
    // cannot throw today, but pushing the flag past it would make the "a throw
    // means Composio billed nothing" invariant one edit away from false — and
    // that failure is a silent under-count.
    billed = true;
    const data = profile?.data as Record<string, unknown> | undefined;
    const nested = (data?.response_data ?? data) as Record<string, unknown> | undefined;
    email = typeof nested?.emailAddress === 'string' ? nested.emailAddress : null;
  } catch {
    /* advisory — see above */
  }
  // Billed OUTSIDE the advisory try: another Composio execution that never
  // traverses the relay, and the only one that accrues with no human action at
  // all (the 15-min cron runs it for every invited/pending row). Kept out of the
  // block above so a ledger fault cannot land in that catch and silently blank
  // the email — cost accounting must not degrade what it measures.
  if (billed) {
    await (deps.recordCost ?? recordComposioCall)({
      tenantId: tech.tenant_id,
      technicianRef: tech.ref,
    }).catch((err: unknown) => {
      console.error(
        `cost: pairing probe not recorded — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }
  // One-time shape log (plan: check for an untyped email field on the raw
  // account object). Key names only — data/params may carry token material.
  console.error(
    `[pairing] account object keys for ${tech.ref}: ${Object.keys(active).join(', ')}`,
  );

  // CLAIM the row before the trigger goes live (CAS on 'invited'). Three races
  // die here at the DB level (review findings):
  //  - a concurrent deactivate is never overwritten — the CAS misses and this
  //    sweep stops instead of resurrecting a removed person;
  //  - a concurrent second checkPairing (cron tick + get_connect_link) loses
  //    the CAS before it can create a duplicate trigger;
  //  - deliveries can only start once the trigger exists (below), by which
  //    time the row is already pending_verification — the webhook's
  //    pendingVerification stamp can no longer miss the earliest captures.
  const claimed = await cas(tech.id, 'invited', {
    composio_connected_account_id: active.id,
    connected_email: email,
    state: 'pending_verification',
  });
  if (!claimed) return { status: 'no_op', reason: 'state changed concurrently' };
  await openReviewItem({
    tenantId: tech.tenant_id,
    kind: 'pairing_verification',
    subjectRef: tech.ref,
    detail: { email, connectedAccountId: active.id },
  });
  // Trigger LAST (see the claim comment). If this throws, the claim + item
  // stand and the next sweep's healing branch finishes the trigger.
  const triggerId = await ensureTrigger(client, tech, active.id);
  await update(tech.id, { composio_trigger_id: triggerId ?? null });
  return { status: 'paired', connectedAccountId: active.id, email };
}

// Idempotent trigger provisioning: adopt OUR trigger type if it already exists
// (triggers.create errors on repeat; the triggerNames filter keeps an
// unrelated trigger from being adopted as ti_* and later torn down), else
// create it PINNED to the verified account — without the pin the SDK attaches
// to "the first connected account for the user", which can be a stale
// INITIATED request from an abandoned link (review finding).
async function ensureTrigger(
  client: PairingClient,
  tech: Technician,
  connectedAccountId: string,
): Promise<string | undefined> {
  const existing = asItems(
    await client.triggers.listActive({
      connectedAccountIds: [connectedAccountId],
      triggerNames: ['GMAIL_NEW_GMAIL_MESSAGE'],
    }),
  );
  let triggerId = existing[0]?.id as string | undefined;
  if (!triggerId) {
    const created = await client.triggers.create(compositeUserId(tech), 'GMAIL_NEW_GMAIL_MESSAGE', {
      connectedAccountId,
      triggerConfig: { interval: 1, labelIds: 'INBOX', userId: 'me' },
    });
    triggerId = (created.triggerId ?? created.id) as string | undefined;
  }
  return triggerId;
}

// Already-deleted detection: ONLY a real API 404 counts (the Composio client
// attaches `.status` to API errors). No message-text fallback — the obvious
// regex (/not[ _-]?found/i) also matches DNS failures like "getaddrinfo
// ENOTFOUND backend.composio.dev" (review finding), which would let a network
// outage masquerade as "already deleted" and permanently offboard people whose
// Gmail grants were never actually torn down.
export function isGoneError(err: unknown): boolean {
  return (err as { status?: number })?.status === 404;
}

// Delete the Composio objects for a pairing — trigger FIRST (no deliveries
// racing the account delete). Idempotent: already-deleted (404) is success;
// any other failure throws so the caller can retry (offboarding expiry runs
// again next cron tick). Does NOT touch the roster row.
export async function deleteComposioPairing(tech: Technician, deps: PairingDeps = {}): Promise<void> {
  const client = deps.client ?? getComposio();
  if (tech.composio_trigger_id) {
    try {
      await client.triggers.delete(tech.composio_trigger_id);
    } catch (err) {
      if (!isGoneError(err)) throw err; // already-deleted is fine; anything else must surface
    }
  }
  if (tech.composio_connected_account_id) {
    try {
      await client.connectedAccounts.delete(tech.composio_connected_account_id);
    } catch (err) {
      if (!isGoneError(err)) throw err;
    }
  }
}

// "That's not their mailbox" — the manager dismissed the verification item.
// Tear the pairing down, clear the inventory, and return the row to 'invited'
// so a fresh connect link can be issued (re-link() on an ACTIVE account would
// throw ComposioMultipleConnectedAccountsError).
export async function unpair(tech: Technician, deps: PairingDeps = {}): Promise<void> {
  const cas = deps.cas ?? casTechnician;
  await deleteComposioPairing(tech, deps);
  // CAS: only a still-pending row returns to invited. If a deactivation landed
  // mid-teardown, leave its state alone — the ids then point at objects this
  // call just deleted, which the expiry teardown treats as already-gone (404).
  await cas(tech.id, 'pending_verification', {
    composio_connected_account_id: null,
    composio_trigger_id: null,
    connected_email: null,
    link_issued_at: null, // wrong-mailbox retry shouldn't wait out the cooldown
    state: 'invited',
  });
}
