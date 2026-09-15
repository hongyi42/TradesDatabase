// The review queue.
//
// One domain's slice of the spine's tool surface: the definitions it contributes
// to each tier's catalog, and the handler behind each name. Split out of
// src/mcp/server.ts on 2026-09-12 (research 2026-09-09
// code-graph-as-source-of-truth §6.1 fix 3) so that adding a tool here touches
// no file another feature is also editing.
//
// Tier membership is DECLARATIVE only: listing a tool under `admin` is what puts
// it in ADMIN_TOOL_NAMES, and the hub applies that gate by name before any
// handler here runs. A handler never checks a tier itself.
import {
  unpair as liveUnpair,
} from '../../composio/pairing.js';
import {
  casTechnician,
  getOpenReviewItem,
  getReviewQueuePage,
  getTechnician,
  isSeatCapError,
  resolveReviewItem,
} from '../../db/index.js';
import {
  seatCapMessage,
} from './shared.js';
import type {
  DomainTools,
  ToolContext,
} from './types.js';

const ADMIN_TOOLS = [
  {
    name: 'list_pending_reviews',
    description:
      'List open review items needing a decision (manager only): open questions on jobs and ' +
      'visits (gap items), email from unrecognized team refs, pairing verifications, pending ' +
      "confirmations. An item's detail.agentContext is a briefing from the office's planner " +
      'FOR YOU — use it to help the manager decide; never read it aloud or relay it verbatim. ' +
      'Returns ONE PAGE, oldest first (20 by default), with total and byKind counts over the ' +
      'whole queue — quote those for how-many questions. hasMore:true means more: call again ' +
      'with after = next. Pass kind to page just one kind. An item with detailWithheld:true has ' +
      'a detail too large for the list — open it whole with reviewItemId before acting on it.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', description: 'Only items of this kind (e.g. "call_action").' },
        after: { type: 'string', description: 'The `next` value from the previous page, copied exactly.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Items per page (default 20, at most 50).' },
        reviewItemId: {
          type: 'string',
          description: 'Open ONE open item with its whole detail (use when detailWithheld is true).',
        },
      },
    },
  },
  {
    name: 'resolve_review',
    description:
      'Close a review item (manager only): resolved = handled, dismissed = not an issue / ' +
      'cancel it. For a STAGED ACTION (e.g. a pending booking): dismissed CANCELS it — ' +
      'this is the chat way to kill it before its expiry; resolved is refused ' +
      '(confirming happens via the staging tool, never here). For a pairing verification: ' +
      'resolved = the mailbox is right (person goes active); dismissed = wrong mailbox ' +
      '(pairing is torn down for a fresh connect link).',
    inputSchema: {
      type: 'object',
      properties: {
        reviewItemId: { type: 'string' },
        resolution: { type: 'string', enum: ['resolved', 'dismissed'] },
        note: { type: 'string', description: 'Optional short note recorded on the item.' },
      },
      required: ['reviewItemId', 'resolution'],
    },
  },
];

// `next` is the page's last item as "<created_at>|<id>" — the created_at exactly
// as the database rendered it, microseconds kept, so the next page starts after
// the precise row (a timestamp without its id would re-serve tied rows).
const REVIEW_CURSOR = /^([^|]+)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

async function handleListPendingReviews(toolCtx: ToolContext): Promise<unknown> {
  const { args, tenantId, str } = toolCtx;
      // ONE PAGE, not the whole queue (retrieval layer 4). A staged token whose
      // preview is large, or a pile of abandoned ones, used to land in the seat's
      // window all at once; review_queue_page bounds the page and withholds any
      // single oversized detail, which reviewItemId then opens whole.
      for (const key of ['kind', 'after', 'reviewItemId'] as const) {
        if (args[key] !== undefined && typeof args[key] !== 'string') {
          throw new Error(`${key} must be a string`);
        }
      }
      const reviewItemId = str('reviewItemId');
      if (reviewItemId) {
        const item = await getOpenReviewItem(reviewItemId, tenantId);
        return item
          ? { item }
          : { item: null, note: 'no OPEN review item with that id on this firm — it may already be closed' };
      }
      if (
        args.limit !== undefined &&
        (typeof args.limit !== 'number' || !Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)
      ) {
        throw new Error('limit must be a whole number from 1 to 50');
      }
      const after = str('after');
      let afterCreated: string | undefined;
      let afterId: string | undefined;
      if (after) {
        const m = REVIEW_CURSOR.exec(after);
        if (!m || !Number.isFinite(Date.parse(m[1]))) {
          throw new Error('after must be the `next` value from the previous page, copied exactly');
        }
        afterCreated = m[1];
        afterId = m[2];
      }
      const kind = str('kind') || undefined;
      const page = await getReviewQueuePage(tenantId, {
        ...(kind ? { kind } : {}),
        ...(afterCreated && afterId ? { afterCreated, afterId } : {}),
        ...(args.limit !== undefined ? { limit: args.limit as number } : {}),
      });
      const next =
        page.hasMore && page.nextAfterCreated && page.nextAfterId
          ? `${page.nextAfterCreated}|${page.nextAfterId}`
          : null;
      return {
        items: page.items,
        total: page.total,
        byKind: page.byKind,
        hasMore: next !== null,
        next,
        note:
          page.total === 0
            ? kind
              ? `no open review items of kind '${kind}'`
              : 'no open review items'
            : `${page.items.length} of ${page.total} shown` +
              (next ? ' — call again with after = next for more.' : '.') +
              (page.items.some((i) => i.detailWithheld)
                ? ' Items with detailWithheld:true: open with reviewItemId before acting.'
                : ''),
      };
}

async function handleResolveReview(toolCtx: ToolContext): Promise<unknown> {
  const { deps, tenantId, str } = toolCtx;
      const reviewItemId = str('reviewItemId');
      if (!reviewItemId) throw new Error('reviewItemId is required');
      const resolution = str('resolution');
      if (resolution !== 'resolved' && resolution !== 'dismissed') {
        throw new Error(`invalid resolution: ${resolution ?? '(missing)'}`);
      }
      // ONE point read, then dispatch on the item's kind — behavioral kinds
      // add a branch here, not another guaranteed-null DB probe per call
      // (review finding: the sequential kind-filtered reads pattern costs two
      // wasted round trips on every common resolve and won't scale).
      const open = await getOpenReviewItem(reviewItemId, tenantId);
      if (!open) throw new Error('review item not found');
      // A pending_deactivation item is a live confirm token, not a review to
      // "handle": marking it resolved here would read as a completed
      // deactivation that never ran. Dismissing it (= cancel) is legitimate.
      if (open.kind === 'pending_deactivation' && resolution === 'resolved') {
        throw new Error(
          `this is a pending deactivation for '${open.subject_ref}' — confirm it via ` +
            `deactivate_technician_seat, or dismiss it to cancel`,
        );
      }
      // Same live-token rule for a staged send: "resolved" here would read as
      // a confirmed send that never ran. Dismissing (= cancel) is legitimate.
      if (open.kind === 'pending_outbound_send' && resolution === 'resolved') {
        throw new Error(
          `this is a staged email send for '${open.subject_ref}' — confirm it via send_email, ` +
            `or dismiss it to cancel`,
        );
      }
      // Same rule for a staged field note: it commits only via
      // record_field_note's confirm call.
      if (open.kind === 'pending_field_note' && resolution === 'resolved') {
        throw new Error(
          `this is a staged field note for '${open.subject_ref}' — confirm it via ` +
            `record_field_note, or dismiss it to cancel`,
        );
      }
      // And for a staged retraction: it commits only via retract_capture.
      if (open.kind === 'pending_retraction' && resolution === 'resolved') {
        throw new Error(
          `this is a staged retraction for '${open.subject_ref}' — confirm it via ` +
            `retract_capture, or dismiss it to cancel`,
        );
      }
      // And for a staged standing fact: it commits only via record_standing_fact.
      if (open.kind === 'pending_standing_fact' && resolution === 'resolved') {
        throw new Error(
          `this is a staged standing fact for '${open.subject_ref}' — confirm it via ` +
            `record_standing_fact, or dismiss it to cancel`,
        );
      }
      // Same live-token rule for every OTHER staged action kind: each commits
      // only via its own tool's confirm call; dismissing (= cancel) is fine.
      // New staged kinds get an entry here, not a fresh if-block.
      const STAGED_ACTION_KINDS: Record<string, string> = {
        pending_visit_cancel: 'unschedule_visit',
        pending_job_cancel: 'cancel_job',
        pending_seat_add: 'add_technician_seat',
      };
      if (STAGED_ACTION_KINDS[open.kind] && resolution === 'resolved') {
        throw new Error(
          `this is a staged action for '${open.subject_ref}' — confirm it via ` +
            `${STAGED_ACTION_KINDS[open.kind]}, or dismiss it to cancel`,
        );
      }
      // A pairing_verification verdict acts BEFORE the item closes (state-first,
      // mirroring deactivate): resolved = right mailbox → active; dismissed =
      // wrong mailbox → unpair back to invited. Both act ONLY while the row is
      // still pending_verification — a stale item on an offboarding/offboarded
      // row must neither resurrect nor unpair anyone; it just closes. The
      // state advance is a CAS so a deactivate landing mid-call wins.
      if (open.kind === 'pairing_verification') {
        const target = await getTechnician(tenantId, open.subject_ref);
        if (target && target.state === 'pending_verification') {
          if (resolution === 'resolved') {
            try {
              await casTechnician(target.id, 'pending_verification', { state: 'active' });
            } catch (err) {
              if (isSeatCapError(err)) throw new Error(seatCapMessage(target.tier));
              throw err;
            }
          } else {
            await (deps.unpair ?? liveUnpair)(target);
          }
        }
      }
      const item = await resolveReviewItem(reviewItemId, tenantId, resolution, str('note') ?? null);
      if (!item) throw new Error('review item not found');
      return item;
}

export const reviewsTools = {
  domain: 'reviews',
  admin: ADMIN_TOOLS,
  handlers: {
    list_pending_reviews: handleListPendingReviews,
    resolve_review: handleResolveReview,
  },
} satisfies DomainTools;
