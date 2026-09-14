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
  getTechnician,
  isSeatCapError,
  listOpenReviewItems,
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
      'FOR YOU — use it to help the manager decide; never read it aloud or relay it verbatim.',
    inputSchema: { type: 'object', properties: {} },
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

async function handleListPendingReviews(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId } = toolCtx;
      // The staged solver tokens (pending_freeze / pending_resolve /
      // pending_undo) each embedded a WHOLE plan and were summarized here so
      // they could not flood the context. All three kinds died with the
      // solver (rung 8, 2026-09-03); every remaining staged token is small
      // enough to return as it stands. A future kind that embeds a plan adds
      // its summarizer back here.
      return await listOpenReviewItems(tenantId);
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
