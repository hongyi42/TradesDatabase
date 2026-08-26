import { isMissingCostLedger } from '../db/costs.js';
import { runForcedTool, type ForcedToolSpec } from '../model/forcedTool.js';
import { listRecentSummaries, countSummaries, type GapSummary } from '../db/gapSummaries.js';
import {
  insertReflectorRun,
  latestReflectorRunAt,
  latestSuccessfulReflectorRunAt,
} from '../db/reflectorRuns.js';
import { expireStaleProposals, listLessons, proposeLesson } from './lessons.js';
import { listTenantIdsWithTelegramBindings } from '../db/technicians.js';
import { getTenant } from '../db/tenants.js';
import { TEAM_LEAD_REF } from './identity.js';
import { flatten } from './composeCopy.js';

// ⑤ Phase 4: the Reflector — the distiller, running DARK. One forced-tool
// call per eligible firm per day reads recent gap-life summaries and PROPOSES
// up to three lessons; the Curator (lessons.ts) verifies evidence and stores
// them as 'proposed'. NOTHING reaches any prompt in this phase: shadow is the
// only real mode, and `live` is deliberately shadow-equivalent here —
// activation stays a human act until the adversarial-judge design (recorded
// in the plan's Decisions) replaces it.

export type ReflectorMode = 'off' | 'shadow' | 'live';

// Gate constants (plan-ruled): no distillation before a firm has a corpus,
// and no re-run on unchanged input.
export const MIN_SUMMARIES = 15;
export const MIN_NEW_SINCE_LAST_RUN = 5;
export const REFLECT_FROM_HOUR = 2; // firm-local; re-checkable all day

export const REFLECT_TOOL: ForcedToolSpec = {
  name: 'propose_lessons',
  description: 'Propose durable lessons distilled from this firm\'s gap histories.',
  inputSchema: {
    type: 'object',
    properties: {
      lessons: {
        type: 'array',
        maxItems: 3,
        items: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description:
                'ONE rule about how this firm should be handled, under 300 chars. ' +
                'Weekday/time-of-day words allowed; absolute dates refused.',
            },
            evidence: {
              type: 'array',
              minItems: 3,
              items: { type: 'string' },
              description: 'gap_summaries ids (at least 3) that genuinely support the rule.',
            },
          },
          required: ['text', 'evidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['lessons'],
    additionalProperties: false,
  },
};

export const REFLECT_SYSTEM =
  'You distill LESSONS from a trades firm\'s gap histories — records of questions the office ' +
  'asked its technicians and how each one ended. A lesson is a durable RULE about THIS firm ' +
  'that would change how future gaps are handled: pacing that works, escalations that proved ' +
  'premature, patterns in when people actually answer. Propose at most 3, each citing at ' +
  'least 3 summary ids that genuinely support it — never force one; an empty list is a fine ' +
  'answer. A lesson is a rule, never an event: no absolute dates (weekday and time-of-day ' +
  'words are fine). Never include a person\'s private details. Do not re-propose anything ' +
  'covered by the ACTIVE lessons shown, and never resurrect a RETIRED one.';

function renderSummary(s: GapSummary): string {
  const arc = Object.entries((s.arc ?? {}) as Record<string, number>)
    .map(([k, v]) => `${k}×${v}`)
    .join(' ');
  // Flatten EVERYTHING that crosses DB → prompt (the Phase-3 composeCopy
  // rail; review F3): subject derives from customer names, and
  // manager_resolution is free text — embedded newlines could forge corpus
  // lines or a fake ACTIVE section. Render-time on purpose: append-only rows
  // already exist with raw text.
  const subject = flatten(s.subject ?? '', 120);
  const resolution = s.resolution ? flatten(s.resolution, 160) : null;
  const managerRes = s.manager_resolution ? flatten(s.manager_resolution, 160) : null;
  const fate =
    s.manager_fate === 'none' ? '' : ` manager:${s.manager_fate}${managerRes ? ` "${managerRes}"` : ''}`;
  return (
    `- ${s.id} · ${s.kind} · ${subject} · ${s.status}` +
    `${resolution ? ` ("${resolution}")` : ''} · open ${s.working_hours_open ?? '?'}wh` +
    ` · considered ${s.considered}${arc ? ` (${arc})` : ''}${fate}`
  );
}

export interface ReflectorSummary {
  tenants: number;
  ran: number;
  skippedGate: number;
  proposed: number;
  refused: number;
  expired: number;
  tenantErrors: number;
}

export interface ReflectorDeps {
  listTenants?: typeof listTenantIdsWithTelegramBindings;
  tenant?: typeof getTenant;
  count?: typeof countSummaries;
  recent?: typeof listRecentSummaries;
  run?: typeof runForcedTool;
  propose?: typeof proposeLesson;
  expire?: typeof expireStaleProposals;
  lessons?: typeof listLessons;
}

function localHourAndDay(nowIso: string, tz: string): { hour: number; day: string } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    hour: 'numeric',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowIso)).map((p) => [p.type, p.value]));
  return { hour: Number(parts.hour), day: `${parts.year}-${parts.month}-${parts.day}` };
}

async function ranToday(tenantId: string, day: string, tz: string): Promise<boolean> {
  // The marker's firm-local day: compare in code (one small read; markers are
  // one row per tenant per day at most). ANY outcome closes the day — a failed
  // attempt still bounds the day's billing.
  const ranAt = await latestReflectorRunAt(tenantId);
  return !!ranAt && localHourAndDay(ranAt, tz).day === day;
}

async function newSinceLastRun(tenantId: string): Promise<number> {
  // Anchored on the last SUCCESSFUL run (review F2): a failure marker bounds
  // billing for the day (ranToday counts it) but must not make the summaries
  // the model never saw stop counting as new. No marker yet = the whole corpus
  // is new, which is what an unbounded count returns.
  const since = await latestSuccessfulReflectorRunAt(tenantId);
  return countSummaries(tenantId, since ?? undefined);
}

export async function runReflector(
  nowIso: string,
  mode: ReflectorMode,
  deps: ReflectorDeps = {},
): Promise<ReflectorSummary> {
  const listTenants = deps.listTenants ?? listTenantIdsWithTelegramBindings;
  const tenant = deps.tenant ?? getTenant;
  const count = deps.count ?? countSummaries;
  const recent = deps.recent ?? listRecentSummaries;
  const run = deps.run ?? runForcedTool;
  const propose = deps.propose ?? proposeLesson;
  const expire = deps.expire ?? expireStaleProposals;
  const lessons = deps.lessons ?? listLessons;

  const summary: ReflectorSummary = {
    tenants: 0, ran: 0, skippedGate: 0, proposed: 0, refused: 0, expired: 0, tenantErrors: 0,
  };
  if (mode === 'off') return summary;

  const tenantIds = await listTenants();
  summary.tenants = tenantIds.length;
  for (const tenantId of tenantIds) {
    try {
      const t = await tenant(tenantId);
      const tz = t?.timezone ?? 'UTC';
      const { hour, day } = localHourAndDay(nowIso, tz);
      if (
        hour < REFLECT_FROM_HOUR ||
        (await ranToday(tenantId, day, tz)) ||
        (await count(tenantId)) < MIN_SUMMARIES ||
        (await newSinceLastRun(tenantId)) < MIN_NEW_SINCE_LAST_RUN
      ) {
        summary.skippedGate += 1;
        continue;
      }

      summary.expired += await expire(tenantId, nowIso);

      const corpus = await recent(tenantId, 40);
      const context = await lessons(tenantId, ['active', 'retired']);
      const activeTexts = context.filter((l) => l.status === 'active').map((l) => `- ${l.text}`);
      const retiredTexts = context.filter((l) => l.status === 'retired').map((l) => `- ${l.text}`);
      const user =
        `GAP HISTORIES (newest first, each line one finished gap):\n` +
        corpus.map(renderSummary).join('\n') +
        `\n\nACTIVE lessons (do not re-propose):\n${activeTexts.join('\n') || '(none)'}` +
        `\n\nRETIRED lessons (never resurrect):\n${retiredTexts.join('\n') || '(none)'}`;

      // Marker BEFORE parsing proposals but AFTER the model call would lose
      // the call on a marker failure; marker AFTER everything means a crash
      // mid-proposals re-bills tomorrow at worst (the gate's day scope). One
      // billed attempt per firm per day is the bound either way.
      let proposedHere = 0;
      let callOk = false;
      try {
        const args = await run(
          REFLECT_TOOL,
          {
            system: REFLECT_SYSTEM,
            user,
            // PINNED (plan review find 5): GLM thinks by default and small
            // budgets truncate; 3 lessons + evidence uuids never fit 300.
            maxTokens: 2000,
            label: 'reflector',
            reasoningEffort: 'none',
          },
          { tenantId, technicianRef: TEAM_LEAD_REF },
        );
        callOk = true;
        const list = Array.isArray(args.lessons) ? args.lessons : [];
        for (const raw of list.slice(0, 3)) {
          const text = (raw as { text?: unknown }).text;
          const evidence = (raw as { evidence?: unknown }).evidence;
          // Refused WHOLE, never trimmed (review F4): providers honor
          // minItems only as a hint, and silently dropping non-string
          // entries would launder thin evidence past the Curator.
          if (
            !Array.isArray(evidence) ||
            evidence.length < 3 ||
            !evidence.every((e): e is string => typeof e === 'string')
          ) {
            summary.refused += 1;
            console.error(
              `[reflector] tenant ${tenantId}: proposal refused — evidence must be ≥3 summary ids`,
            );
            continue;
          }
          try {
            const lesson = await propose({
              tenantId,
              text: typeof text === 'string' ? text : '',
              evidence,
            });
            proposedHere += 1;
            console.log(
              `[reflector] tenant ${tenantId}: PROPOSED lesson ${lesson.id} — ${lesson.text}`,
            );
          } catch (err) {
            summary.refused += 1;
            console.error(`[reflector] tenant ${tenantId}: proposal refused`, err);
          }
        }
      } finally {
        await insertReflectorRun(tenantId, proposedHere, callOk);
      }
      summary.ran += 1;
      summary.proposed += proposedHere;
    } catch (err) {
      // A missing table is an ENVIRONMENT fact, not a tenant fact — rethrow
      // so lifecycle's skip branch reports it once as 'skipped' instead of
      // burying it as N tenantErrors under ok:true (review F1, the
      // "tick still reports ok:true" trap).
      if (isMissingCostLedger(err)) throw err;
      summary.tenantErrors += 1;
      console.error(`[reflector] tenant ${tenantId} failed`, err);
    }
  }
  return summary;
}
