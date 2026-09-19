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
    const healedId = await ensureTriggers(client, tech, tech.composio_connected_account_id);
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
  //  - a concurrent second checkPairing (two overlapping cron ticks; the
  //    manager's get_connect_link was the other caller until 2026-09-19) loses
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
  const triggerId = await ensureTriggers(client, tech, active.id);
  await update(tech.id, { composio_trigger_id: triggerId ?? null });
  return { status: 'paired', connectedAccountId: active.id, email };
}

export const GMAIL_TRIGGER_SLUG = 'GMAIL_NEW_GMAIL_MESSAGE';
export const GMAIL_SENT_TRIGGER_SLUG = 'GMAIL_EMAIL_SENT_TRIGGER';

// TWO WATCHERS PER MAILBOX, because Gmail's trigger menu has exactly two and
// each sees ONE DIRECTION OF MAIL (rung 10b.4).
//
// The received one is named, in Composio's own metadata, "New Gmail Message
// RECEIVED Trigger" — "triggers when a new message is received in Gmail". No
// config widens it to the firm's own sends: `labelIds` and `query` both filter
// WITHIN mail that arrived, and a sent message never arrives. Verified live on
// 2026-09-10 — a `query` of `label:inbox OR label:sent` delivered nothing new
// and the sent message never entered the instance's tracked-message state.
// GMAIL_EMAIL_SENT_TRIGGER "polls the 'SENT' label" and is the other half.
//
// WHY THAT MATTERS: a manager replying from Gmail by hand was never captured —
// not filtered, not dropped, never delivered — so a job's correspondence was
// one-sided and a promise typed out ("we'll come Thursday") bound the firm with
// the spine unaware.
export const GMAIL_TRIGGERS: { slug: string; config: Record<string, string | number> }[] = [
  // `labelIds` takes exactly ONE label (live trigger-type schema, 2026-09-09);
  // this is its default and the only one this door wants.
  { slug: GMAIL_TRIGGER_SLUG, config: { interval: 1, labelIds: 'INBOX', userId: 'me' } },
  // The sent trigger takes no label — it IS the SENT label — only an optional
  // extra `query`, which we deliberately leave empty: every reply the firm
  // types is a candidate, and the work/personal classifier is what decides.
  { slug: GMAIL_SENT_TRIGGER_SLUG, config: { interval: 1, userId: 'me' } },
];

// Does a live trigger already carry the config we want? The list response
// spells it BOTH ways (`trigger_config` snake and `triggerConfig` camel — seen
// on a live read 2026-09-09), so read either, and compare as STRINGS because
// the values come back off the API untyped and an `interval` of "1" would
// otherwise read as stale forever. An absent config reads as stale, which is
// the safe direction: at worst we upsert a trigger that was already correct.
function triggerConfigIsCurrent(
  item: Record<string, unknown>,
  want: Record<string, string | number>,
): boolean {
  const cfg = (item.triggerConfig ?? item.trigger_config) as Record<string, unknown> | undefined;
  if (!cfg) return false;
  return Object.entries(want).every(([key, value]) => String(cfg[key]) === String(value));
}

// Idempotent provisioning of BOTH watchers, PINNED to the verified account —
// without the pin the SDK attaches to "the first connected account for the
// user", which can be a stale INITIATED request from an abandoned link.
//
// CREATE IS AN UPSERT, AND IT KEYS ON THE CONFIGURATION. `triggers.create`
// posts to POST /api/v3/trigger_instances/{slug}/upsert, documented as
// "creates a new trigger instance or updates an existing one WITH THE SAME
// configuration". That last clause is load-bearing and was verified the hard
// way on 2026-09-10: changing a live trigger's config MINTED A SECOND INSTANCE
// and left the first one polling. So a trigger that already carries the config
// is left strictly alone here — re-upserting an existing one is safe only
// because the config is identical.
//
// Returns the RECEIVED trigger's id for the roster row, which keeps it as a
// human-readable handle. Teardown no longer depends on it (see below).
async function ensureTriggers(
  client: PairingClient,
  tech: Technician,
  connectedAccountId: string,
): Promise<string | undefined> {
  let receivedId: string | undefined;
  // DID EVERY WATCHER LAND? Returning the received id while the SENT one failed
  // would write a non-null `composio_trigger_id`, and checkPairing's healing
  // branch fires only on a NULL one — so the seat would watch inbound only,
  // FOREVER: the 15-minute sweep skips anything past `pending_verification`,
  // and nothing else revisits an active seat. Reporting nothing instead keeps
  // the column null, and the healing branch retries. That retry is idempotent —
  // a watcher that already exists is adopted below, never re-created.
  let allLanded = true;
  for (const { slug, config } of GMAIL_TRIGGERS) {
    const existing = asItems(
      await client.triggers.listActive({
        connectedAccountIds: [connectedAccountId],
        triggerNames: [slug],
      }),
    );
    const found = existing[0];
    const foundId = found?.id as string | undefined;
    let id = foundId;
    if (!foundId || !triggerConfigIsCurrent(found, config)) {
      try {
        const created = await client.triggers.create(compositeUserId(tech), slug, {
          connectedAccountId,
          triggerConfig: { ...config },
        });
        id = ((created.triggerId ?? created.id) as string | undefined) ?? foundId;
      } catch (err) {
        // ONE WATCHER FAILING MUST NOT COST THE OTHER, NOR THE PAIRING. With
        // nothing live for this slug there is genuinely less coverage, and it
        // is said out loud; checkPairing's healing branch retries only when the
        // ROSTER id is missing, so a failed SENT trigger is picked up by the
        // reconciliation script rather than silently forgotten.
        console.error(
          `[pairing] ${slug} not provisioned for ${tech.ref} — ` +
            `${err instanceof Error ? err.message : String(err)}. ` +
            `Reconcile with: npm run composio:retrigger -- ` +
            `user=${compositeUserId(tech)} account=${connectedAccountId}`,
        );
      }
    }
    if (!id) allLanded = false;
    if (slug === GMAIL_TRIGGER_SLUG) receivedId = id;
  }
  return allLanded ? receivedId : undefined;
}

// EVERY WATCHER ON THIS MAILBOX — what we recorded, plus whatever Composio says
// is actually there. The roster keeps ONE trigger id and a mailbox now carries
// TWO, so our note can only ever be a subset; the connected account is the
// handle we do record reliably, and every watcher hangs off it.
//
// `ok` reports whether the LIST succeeded. Callers that are about to destroy the
// account must not proceed on a false — deleting it would take away the only
// handle that could ever find the watchers we failed to enumerate.
async function watchersOn(
  client: PairingClient,
  tech: Technician,
): Promise<{ ids: Set<string>; ok: boolean }> {
  const ids = new Set<string>();
  if (tech.composio_trigger_id) ids.add(tech.composio_trigger_id);
  const accountId = tech.composio_connected_account_id;
  if (!accountId) return { ids, ok: true };
  try {
    // No `triggerNames` filter: whatever is on this mailbox counts, including a
    // slug this code has never heard of. That is what makes it self-healing for
    // watchers nobody wrote down. Composio scopes `connectedAccountIds`
    // server-side, and an account belongs to exactly one composite user id, so
    // this can never reach another person's or another tenant's trigger.
    for (const item of asItems(await client.triggers.listActive({ connectedAccountIds: [accountId] }))) {
      if (typeof item.id === 'string' && item.id) ids.add(item.id);
    }
    return { ids, ok: true };
  } catch (err) {
    console.error(
      `[pairing] could not list watchers on ${accountId} for ${tech.ref} — ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return { ids, ok: false };
  }
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

// Delete the Composio objects for a pairing — triggers FIRST (no deliveries
// racing the account delete). Idempotent: already-deleted (404) is success;
// any other failure throws so the caller can retry (offboarding expiry runs
// again next cron tick). Does NOT touch the roster row.
//
// WE ASK COMPOSIO WHAT EXISTS RATHER THAN TRUSTING OUR OWN NOTE (rung 10b.4).
// The roster has ONE `composio_trigger_id` column and a mailbox now carries TWO
// watchers, so the column cannot name them all. The CONNECTED ACCOUNT is the
// handle we do record reliably, and every trigger hangs off it, so the live
// system can answer "what is watching this mailbox" better than our copy can.
//
// It is also SELF-HEALING, which the column could never be: it tears down
// watchers nobody ever wrote down — including any left by a pairing that
// pre-dates this code, or by an upsert that minted an instance under a new id.
//
// ⚠ UNVERIFIED, AND DELIBERATELY NOT RELIED ON: whether deleting a connected
// account also destroys the trigger instances pinned to it. Composio does not
// document that cascade either way (checked 2026-09-10), and we have no
// specimen — every teardown this code has ever run deleted the trigger first.
// So this does NOT rest on "an unlisted trigger keeps polling forever": it
// rests on the weaker and provable claim that once the account is gone we have
// no handle left to find one with, whatever it is or is not still doing.
//
// The stored id is still tried, and deliberately: if the LIST fails we would
// otherwise tear down nothing at all, and one known id removed beats none.
export async function deleteComposioPairing(tech: Technician, deps: PairingDeps = {}): Promise<void> {
  const client = deps.client ?? getComposio();
  const accountId = tech.composio_connected_account_id;
  const { ids, ok } = await watchersOn(client, tech);
  for (const id of ids) {
    try {
      await client.triggers.delete(id);
    } catch (err) {
      if (!isGoneError(err)) throw err; // already-deleted is fine; anything else must surface
    }
  }
  // THE ACCOUNT IS DESTROYED ONLY IF WE KNOW WHAT WAS ON IT. Deleting it after a
  // failed enumeration takes away the only handle that could ever find the
  // watchers we could not list — they would be unreachable by id, by account and
  // by roster row, with no way left to stop them. Throwing instead leaves the
  // pairing intact and findable; the expiry sweep has already CASed the row to
  // 'offboarded' by this point, so the objects stay as inert clutter (the mail
  // is dropped by the webhook's roster gate regardless) rather than becoming an
  // orphan nothing can name.
  if (!ok) {
    throw new Error(
      `could not enumerate the watchers on ${accountId} — refusing to delete the account ` +
        'while they cannot be found again',
    );
  }
  if (accountId) {
    try {
      await client.connectedAccounts.delete(accountId);
    } catch (err) {
      if (!isGoneError(err)) throw err;
    }
  }
}

// EVERY WATCHER, SWITCHED OFF — the non-destructive half, used by
// deactivate/reactivate. Same reasoning as the teardown: the roster names one
// and the mailbox carries two, so a column-driven disable leaves a deactivated
// person's outgoing mail streaming to our webhook for the whole grace period.
export async function setWatchersEnabled(
  client: PairingClient,
  tech: Technician,
  enabled: boolean,
): Promise<void> {
  const { ids } = await watchersOn(client, tech);
  for (const id of ids) {
    try {
      await (enabled ? client.triggers.enable(id) : client.triggers.disable(id));
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
