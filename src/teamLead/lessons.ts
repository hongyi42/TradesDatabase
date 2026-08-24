import { getClient } from '../db/client.js';
import type { Database } from '../db/database.types.js';
import { flatten } from './composeCopy.js';

// ⑤ Phase 3: the lessons store's typed layer and the CURATOR — plain code
// guarding everything that touches stored lessons. The model (Phase 4's
// Reflector) only ever PROPOSES; nothing model-written mutates the list, and
// the list is never rewritten wholesale (the ACE context-collapse finding).

export type PlannerLesson = Database['public']['Tables']['planner_lessons']['Row'];

// The token-budget ruling (user, 2026-08-23): the ACTIVE set is bounded by
// the rendered block's SIZE, not a count — chars as the repo's standing
// token proxy (~4 chars/token → ~500 tokens/tick worst case).
export const LESSONS_BLOCK_BUDGET = 2000;
export const LESSON_TEXT_MAX = 300;
// Proposals neither activated nor refuted in this window go 'stale' — kept,
// never re-shown (user ruling: unlimited proposals must not accumulate).
export const PROPOSAL_STALE_DAYS = 60;
// Two contradicting outcomes retire a lesson.
export const RETIRE_STRIKES = 2;

// The lesson date rail: weekday/time-of-day words are ALLOWED — patterns like
// "Friday evening" are the content — but absolute dates are refused: a lesson
// is a RULE, not an event. (cleanPlannerText is the wrong rail here: it only
// admits served date labels, and a lesson legitimately has none.)
const ABSOLUTE_DATE = /\d{4}-\d{2}-\d{2}/;
const MONTH_AND_DAY =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b/i;

export function cleanLessonText(raw: unknown): { text: string } | { refused: string } {
  if (typeof raw !== 'string') return { refused: 'lesson text must be a string' };
  const text = flatten(raw, LESSON_TEXT_MAX);
  if (text.length === 0) return { refused: 'empty lesson text' };
  if (ABSOLUTE_DATE.test(text) || MONTH_AND_DAY.test(text)) {
    return { refused: 'a lesson is a rule, not an event — absolute dates are refused' };
  }
  if (/note for the assistant/i.test(text)) {
    return { refused: 'footer-register phrase refused' };
  }
  return { text };
}

export interface ProposeLessonInput {
  tenantId: string;
  text: string;
  evidence: string[]; // gap_summaries ids
  scope?: 'firm' | 'person';
}

// Verifies EVERY cited evidence id exists in gap_summaries for that tenant —
// a proposal citing rows that do not support it is refused whole, never
// trimmed (a lesson with laundered evidence is worse than no lesson).
export async function proposeLesson(input: ProposeLessonInput): Promise<PlannerLesson> {
  const clean = cleanLessonText(input.text);
  if ('refused' in clean) throw new Error(`proposeLesson refused: ${clean.refused}`);
  if (input.evidence.length === 0) throw new Error('proposeLesson refused: no evidence cited');
  const { data: found, error: evErr } = await getClient()
    .from('gap_summaries')
    .select('id')
    .eq('tenant_id', input.tenantId)
    .in('id', input.evidence);
  if (evErr) throw new Error(`proposeLesson evidence check failed: ${evErr.message}`, { cause: evErr });
  const known = new Set((found ?? []).map((r) => r.id));
  const missing = input.evidence.filter((id) => !known.has(id));
  if (missing.length > 0) {
    throw new Error(`proposeLesson refused: unknown evidence ids ${missing.join(', ')}`);
  }
  const { data, error } = await getClient()
    .from('planner_lessons')
    .insert({
      tenant_id: input.tenantId,
      text: clean.text,
      evidence: input.evidence,
      scope: input.scope ?? 'firm',
      status: 'proposed',
    })
    .select()
    .single();
  if (error) throw new Error(`proposeLesson failed: ${error.message}`, { cause: error });
  return data as PlannerLesson;
}

export async function listLessons(
  tenantId: string,
  statuses: PlannerLesson['status'][] = ['proposed', 'active'],
): Promise<PlannerLesson[]> {
  const { data, error } = await getClient()
    .from('planner_lessons')
    .select()
    .eq('tenant_id', tenantId)
    .in('status', statuses)
    .order('proposed_at', { ascending: true });
  if (error) throw new Error(`listLessons failed: ${error.message}`, { cause: error });
  return (data ?? []) as PlannerLesson[];
}

function renderBullets(lessons: PlannerLesson[]): string {
  return lessons
    .map((l, i) => `  ${i + 1}. ${l.text} [${l.id.slice(0, 8)}]`)
    .join('\n');
}

// ALL active lessons as numbered bullets with short ids — bounded by the
// budget AT ACTIVATION time, by construction. Empty string when none.
export async function renderLessonsBlock(tenantId: string): Promise<string> {
  const active = await listLessons(tenantId, ['active']);
  if (active.length === 0) return '';
  return renderBullets(active);
}

// Tenant-scoped on purpose (operator scripts paste ids; a wrong paste must
// not cross tenants). Activation REFUSES when the resulting rendered block
// would exceed the budget — retire or shorten first.
export async function activateLesson(tenantId: string, id: string): Promise<PlannerLesson> {
  const lesson = await getLesson(tenantId, id);
  if (!lesson) throw new Error(`no such lesson ${id} for this tenant`);
  if (lesson.status === 'active') return lesson;
  if (lesson.status === 'retired') throw new Error('a retired lesson never comes back');
  const active = await listLessons(tenantId, ['active']);
  const rendered = renderBullets([...active, lesson]);
  if (rendered.length > LESSONS_BLOCK_BUDGET) {
    throw new Error(
      `activation refused: rendered block would be ${rendered.length} chars ` +
        `(budget ${LESSONS_BLOCK_BUDGET}) — retire or shorten first`,
    );
  }
  const { data, error } = await getClient()
    .from('planner_lessons')
    .update({ status: 'active', activated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .in('status', ['proposed', 'stale'])
    .select()
    .maybeSingle();
  if (error) throw new Error(`activateLesson failed: ${error.message}`, { cause: error });
  if (!data) throw new Error('activateLesson raced: the lesson moved under us');
  return data as PlannerLesson;
}

export async function strikeLesson(
  tenantId: string,
  id: string,
  why: string,
): Promise<PlannerLesson> {
  const lesson = await getLesson(tenantId, id);
  if (!lesson) throw new Error(`no such lesson ${id} for this tenant`);
  const strikes = lesson.strikes + 1;
  const retiring = strikes >= RETIRE_STRIKES;
  const { data, error } = await getClient()
    .from('planner_lessons')
    .update({
      strikes,
      ...(retiring
        ? {
            status: 'retired' as const,
            retired_at: new Date().toISOString(),
            retired_reason: flatten(why, 300),
          }
        : {}),
    })
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`strikeLesson failed: ${error.message}`, { cause: error });
  return data as PlannerLesson;
}

export async function getLesson(tenantId: string, id: string): Promise<PlannerLesson | null> {
  const { data, error } = await getClient()
    .from('planner_lessons')
    .select()
    .eq('tenant_id', tenantId)
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`getLesson failed: ${error.message}`, { cause: error });
  return (data as PlannerLesson) ?? null;
}

// Proposals past their shelf life go 'stale' — kept, never re-shown. Called
// by the Reflector before proposing (Phase 4) so its dedup context reads only
// live material.
export async function expireStaleProposals(tenantId: string, nowIso: string): Promise<number> {
  const cutoff = new Date(
    Date.parse(nowIso) - PROPOSAL_STALE_DAYS * 24 * 3_600_000,
  ).toISOString();
  const { data, error } = await getClient()
    .from('planner_lessons')
    .update({ status: 'stale' })
    .eq('tenant_id', tenantId)
    .eq('status', 'proposed')
    .lt('proposed_at', cutoff)
    .select('id');
  if (error) throw new Error(`expireStaleProposals failed: ${error.message}`, { cause: error });
  return (data ?? []).length;
}
