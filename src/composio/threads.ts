import { recordComposioCall, type Technician } from '../db/index.js';
import type { ThreadMessage } from '../email/format.js';
import { compositeUserId, getComposioClient, type PairingClient } from './pairing.js';

// RUNG 10B — THE CONVERSATION, FETCHED. A reply's own words are often useless on
// their own ("Friday afternoon instead?"): the name, the number and the address
// are three messages up, and the extractor has never seen them. Gmail keeps the
// thread, so we ask for it.
//
// ADVISORY, ALWAYS. This runs inside the inbound webhook request, on the path
// that lands a customer's message in L1 — so a Composio blip, a revoked account
// or a malformed envelope must degrade to "no context", never to a lost email.
// Every failure returns null and the caller falls back to our own captures.
//
// Verified 2026-09-07 against the pilot's paired mailbox: `FETCH_MESSAGE_BY_
// THREAD_ID` returned the thread's `messages[]` in 657 ms under exactly this
// call shape (the `sendGmailEmail` shape — pinned connectedAccountId,
// dangerouslySkipVersionCheck REQUIRED, tolerant envelope parsing). Output is
// camelCase; the trigger payload that carries the thread id is snake_case.
// `READ_SLUG_PREFIXES` has `GMAIL_FETCH_`, so this execution is never swept into
// L1 as an agent action.
export interface ThreadDeps {
  client?: PairingClient;
  recordCost?: typeof recordComposioCall;
  timeoutMs?: number;
}

// A DEADLINE, because the try/catch covers throws and not LATENCY — and latency
// is the one way "context unavailable" can still cost the firm the email. This
// runs inside Composio's own delivery request: stall past its timeout and the
// delivery is marked failed and redelivered, into the same stall, forever. The
// budget is generous against the 657 ms the live fetch measured, and small
// against any connector's delivery timeout.
const THREAD_FETCH_TIMEOUT_MS = 8_000;

// Epoch milliseconds from either spelling: an ISO string, or the epoch-ms
// integer Gmail calls `internalDate` (as a string). NaN sorts as "unknown",
// which the caller resolves by falling back to the order it was given.
function msAt(at: string | null): number {
  if (!at) return Number.NaN;
  if (/^\d+$/.test(at)) return Number(at);
  const parsed = Date.parse(at);
  return Number.isNaN(parsed) ? Number.NaN : parsed;
}

function isoAt(at: string | null): string | null {
  const ms = msAt(at);
  return Number.isNaN(ms) ? at : new Date(ms).toISOString();
}

export async function fetchThreadMessages(
  tech: Technician,
  threadId: string,
  deps: ThreadDeps = {},
): Promise<ThreadMessage[] | null> {
  if (!threadId || !tech.composio_connected_account_id) return null;
  try {
    const client = deps.client ?? getComposioClient();
    const call = client.tools.execute('GMAIL_FETCH_MESSAGE_BY_THREAD_ID', {
      connectedAccountId: tech.composio_connected_account_id,
      userId: compositeUserId(tech),
      arguments: { thread_id: threadId },
      dangerouslySkipVersionCheck: true,
    });
    // The loser keeps running; swallow its rejection so a slow failure cannot
    // surface later as an unhandled rejection and take the process with it.
    call.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    // A SENTINEL, not a falsy check: `!result` would read a real answer of
    // `undefined` — or any other falsy shape a future SDK returns — as a timeout,
    // and silently skip the billing below with it.
    const TIMED_OUT = Symbol('timed out');
    const result = await Promise.race([
      call,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), deps.timeoutMs ?? THREAD_FETCH_TIMEOUT_MS);
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
    // BILLED EITHER WAY, and "either way" includes the TIMEOUT: we stopped
    // waiting, Composio did not stop working, and it charges for the execution
    // it ran. Skipping the ledger row there would make a slow-Composio period
    // look free. The cost write is itself advisory — a ledger fault must not
    // cost the firm the email.
    await (deps.recordCost ?? recordComposioCall)({
      tenantId: tech.tenant_id,
      technicianRef: tech.ref,
    }).catch((err: unknown) => {
      console.error(
        `cost: thread fetch not recorded — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    if (result === TIMED_OUT) {
      console.error(`thread fetch timed out for ${threadId} — running without the conversation`);
      return null;
    }
    if (result.successful === false) return null;
    const data = result.data as Record<string, unknown> | undefined;
    const nested = (data?.response_data ?? data) as Record<string, unknown> | undefined;
    const messages = nested?.messages;
    if (!Array.isArray(messages)) return null;
    const mapped = messages.flatMap((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
      const m = raw as Record<string, unknown>;
      const str = (...keys: string[]): string | null => {
        for (const k of keys) {
          const v = m[k];
          if (typeof v === 'string' && v) return v;
        }
        return null;
      };
      return [
        {
          messageId: str('messageId', 'message_id', 'id'),
          from: str('sender', 'from'),
          to: str('to', 'recipient'),
          subject: str('subject'),
          body: str('messageText', 'message_text', 'preview', 'snippet') ?? '',
          // NORMALIZED TO ISO HERE, not only for the sort. `at` is PRINTED to
          // the model beside each earlier message, and Gmail's `internalDate` is
          // epoch milliseconds — an unreadable integer is no help to a model
          // being asked to separate what was true THEN from the latest message.
          at: isoAt(str('messageTimestamp', 'message_timestamp', 'internalDate')),
        },
      ];
    });
    // OLDEST FIRST, SORTED HERE RATHER THAN ASSUMED. The renderer promises the
    // model "EARLIER IN THIS CONVERSATION" and shows the last eight; if the API
    // ever answers newest-first the model would be handed the eight OLDEST in
    // reverse and lose the recent exchange, silently. The live check that
    // verified these field NAMES ran against a one-message thread, so the order
    // is unverified — and the two timestamp spellings are different units
    // (`messageTimestamp` is ISO, `internalDate` is epoch milliseconds), so
    // normalize before comparing. Unparseable stamps keep the API's own order.
    return mapped
      .map((m, i) => ({ m, i, t: msAt(m.at) }))
      .sort((a, b) => {
        // An unknown stamp on EITHER side falls back to the order the API gave
        // us — a NaN comparison is not an ordering, it is a coin toss.
        if (Number.isNaN(a.t) || Number.isNaN(b.t) || a.t === b.t) return a.i - b.i;
        return a.t - b.t;
      })
      .map((x) => x.m);
  } catch (err) {
    console.error(
      `thread fetch failed for ${threadId} — running without the conversation: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
