import type { OpsOutcome } from '../db/opsEvents.js';
import { findRosterByTelegramUserIdGlobal, queuePersonPush } from '../db/index.js';

// The missing half of the ops pipeline: somebody has to be TOLD.
//
// WHY THIS EXISTS. The box's inference medic has reported honestly since
// 2026-08-12 — it probes with a real tool call and knows within ~5 minutes when
// the provider stops serving. `ops-report.sh` carries that verdict off the box to
// POST /control/ops, and `recordOpsEvent` folds the 5-minute ticks into one
// incident row. Then the trail stopped: `ops_events` had a writer and NO reader.
// Eleven incidents between 2026-08-13 and 2026-08-19 — average 57 minutes, worst
// 517 — were recorded perfectly and surfaced to nobody. `recordOpsEvent`'s own
// docstring anticipated this ("any notifier built on top"); the notifier was
// never built. This is it.
//
// It matters more now than it did then: retiring DeepInfra leaves the fleet
// single-provider with NO fallback, so the medic's verdict is the only warning
// that every technician's assistant has gone quiet.
//
// WHY HERE AND NOT A CRON SWEEP. `recordOpsEvent` already collapses a stream of
// identical observations into exactly two transitions — `opened` and `closed`.
// That de-duplication is the whole reason a notifier is safe to hang here: a
// 30-minute outage reports six times and notifies ONCE. A polling sweep would
// need a `notified_at` column, a migration, and would add up to 5 minutes of
// latency to an alert whose entire value is speed.
//
// WHY IT QUEUES INSTEAD OF SENDING (2026-09-17). This used to call the Bot API
// directly with BOARD_BOT_TOKEN, which was the last job keeping the board bot
// alive after the one-bot merge. The goal is ONE bot per person — not a bot per
// purpose — so an "ops bot" would have missed the point as squarely as the board
// bot did. The alert now goes onto the same queue as every other person-facing
// message and is delivered by the box through the operator's own assistant.
//
// WHAT THAT GIVES UP, STATED PLAINLY. Delivery now travels box → seat gateway →
// seat bot, which are among the things an ops alert reports on. An alert about a
// dead box cannot be delivered BY that box. No Telegram transport could fix
// that — a bot on Render only moves the blind spot — so the box's own death is
// covered by inverted monitoring instead: a healthchecks.io dead-man switch that
// fires when pings STOP (deploy/n8n/README.md). Alerts about anything else — a
// provider outage, a badge failure — arrive on the operator's phone in ~15s.
//
// NEVER let this break what it watches. The caller sends its 200 BEFORE calling
// this and swallows anything thrown — same doctrine as ops-report.sh, which
// always exits 0. A monitoring path that can fail its subject is worse than no
// monitoring at all.

export interface OpsNotifyDeps {
  // Injected by tests, which must never reach a real database.
  queue?: typeof queuePersonPush;
  findRoster?: typeof findRosterByTelegramUserIdGlobal;
}

// WHO gets told, as Telegram USER ids — deliberately not the old
// OPS_ALERT_CHAT_ID, which held a GROUP id (negative). A group has no roster row
// and cannot be addressed on a queue whose addressee is a technician, so several
// operators are named here instead and each gets the alert on their own
// assistant. Still not a tenant lookup: an ops incident is host-scoped
// infrastructure news for whoever runs the box, not something a customer's
// manager can act on.
function operatorIds(): string[] {
  return (process.env.OPS_ALERT_TELEGRAM_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Sub-minute recoveries are real (the medic's own retry absorbs one slow probe),
// and "recovered after 0 min" reads like a bug. Say what actually happened.
function elapsed(openMs: number): string {
  const minutes = Math.round(openMs / 60_000);
  return minutes < 1 ? 'less than a minute' : `${minutes} min`;
}

function openedText(service: string, host: string, detail?: Record<string, unknown>): string {
  const lines = [`⚠️ ${service} is DOWN on ${host}.`];
  // The route is the single most useful line for diagnosis and the reason
  // ops-report.sh collects it — but it is absent when the reporter ran without
  // the gateway owner's environment, so it is rendered only when present.
  const route = detail?.route;
  if (typeof route === 'string' && route.trim()) lines.push(`route: ${route.trim()}`);
  lines.push('Agents may be unable to answer.');
  // No `.md` — Telegram auto-linkifies "…runbook.md" into a tappable link, because .md is
  // Moldova's TLD and the path parses as a domain. It resolves to nothing, and a dead link
  // is the worst thing to hand someone mid-incident (seen live in the 2026-08-19 drill).
  lines.push('Runbook: docs/inference-recovery-runbook');
  return lines.join('\n');
}

/**
 * Queue one ops-incident transition for each configured operator.
 *
 * Silent by design in three cases, none of them an error:
 *   - `suppressed` / `noop` — not a transition. This is the anti-spam invariant:
 *     an outage notifies once, not once per 5-minute tick.
 *   - no `OPS_ALERT_TELEGRAM_IDS` — alerting is not configured here.
 *   - an id that matches no live roster row, or matches several (the ambiguous
 *     case `findRosterByTelegramUserIdGlobal` refuses rather than guessing —
 *     two people really do share a Telegram id on this pilot). Logged, skipped,
 *     and never allowed to suppress the other operators' alerts.
 *
 * Throws only if a queue write fails; the caller is responsible for swallowing.
 */
export async function notifyOpsTransition(
  outcome: OpsOutcome,
  service: string,
  host: string,
  detail?: Record<string, unknown>,
  deps: OpsNotifyDeps = {},
): Promise<void> {
  if (outcome.action !== 'opened' && outcome.action !== 'closed') return;
  const ids = operatorIds();
  if (ids.length === 0) return;
  const find = deps.findRoster ?? findRosterByTelegramUserIdGlobal;
  const queue = deps.queue ?? queuePersonPush;
  const body =
    outcome.action === 'opened'
      ? openedText(service, host, detail)
      : `✅ ${service} recovered after ${elapsed(outcome.openMs)}.`;

  for (const id of ids) {
    const match = await find(id);
    if (!match) {
      console.error(`[opsNotify] telegram id ${id} matches no live roster row — alert not queued`);
      continue;
    }
    if ('ambiguous' in match) {
      console.error(
        `[opsNotify] telegram id ${id} is live in ${match.tenantIds.length} tenants — refusing to guess; alert not queued`,
      );
      continue;
    }
    await queue({
      tenantId: match.technician.tenant_id,
      technicianId: match.technician.id,
      kind: 'ops',
      body,
    });
  }
}
