import type { OpsOutcome } from '../db/opsEvents.js';
import { opsBotToken, sendOpsMessage } from './opsBot.js';

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
// NEVER let this break what it watches. The caller sends its 200 BEFORE calling
// this and swallows anything thrown — same doctrine as ops-report.sh, which
// always exits 0. A monitoring path that can fail its subject is worse than no
// monitoring at all.

export interface OpsNotifyDeps {
  // Injected by tests. The HTTP suite drives a real server over a real socket,
  // so there is no other seam — and `.env` carries a REAL bot token, which
  // would otherwise make `npm test` fire live Telegram messages at the operator.
  send?: typeof sendOpsMessage;
}

// Where the alert goes. Deliberately NOT a tenant lookup: an ops incident is
// host-scoped infrastructure news for whoever runs the box, not something a
// customer's manager can act on. One operator chat id, set in the environment.
const chatId = (): string | undefined => process.env.OPS_ALERT_CHAT_ID?.trim() || undefined;

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
 * Push one ops-incident transition to the operator.
 *
 * Silent by design in three cases, none of them an error:
 *   - `suppressed` / `noop` — not a transition. This is the anti-spam invariant:
 *     an outage notifies once, not once per 5-minute tick.
 *   - no `OPS_ALERT_CHAT_ID` — alerting is not configured here.
 *   - no ops bot token — nothing to send with. Checked rather than left to
 *     throw inside sendOpsMessage, so an unconfigured deploy skips cleanly
 *     instead of logging an exception every tick. `opsBotToken()` resolves
 *     OPS_BOT_TOKEN first and falls back to BOARD_BOT_TOKEN until the board bot
 *     is retired, so this stays silent only when NEITHER is set.
 *
 * Throws only if the send itself fails; the caller is responsible for swallowing.
 */
export async function notifyOpsTransition(
  outcome: OpsOutcome,
  service: string,
  host: string,
  detail?: Record<string, unknown>,
  deps: OpsNotifyDeps = {},
): Promise<void> {
  if (outcome.action !== 'opened' && outcome.action !== 'closed') return;
  const to = chatId();
  if (!to || !opsBotToken()) return;
  const text =
    outcome.action === 'opened'
      ? openedText(service, host, detail)
      : `✅ ${service} recovered after ${elapsed(outcome.openMs)}.`;
  await (deps.send ?? sendOpsMessage)(to, text);
}
