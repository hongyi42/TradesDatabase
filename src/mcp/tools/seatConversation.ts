// A team member's conversation with their assistant — the office READS what an
// assistant knows instead of asking it (step 3, plan 2026-09-23-step-3-office-
// reaches-glue-seats; operator, 2026-09-23).
//
// One domain's slice of the spine's tool surface (the ./office.ts pattern). The
// planner's surface only: listing it under `teamLead` is what puts it in
// TEAM_LEAD_ONLY_TOOL_NAMES, so a technician or manager badge calling it is
// refused at the hub before this handler runs. The office door a MANAGER faces
// is handed it too (MANAGER_FACING_TOOLS); the door a technician faces is not.
//
// Snippets, never a transcript: a turn's text is cut to a short line, so the
// office gets a table of contents it can quote from, not a dump of someone's
// chat (the customer-context rule).
import { getTechnician, searchSeatTurns, seatTurnRetentionDays } from '../../db/index.js';
import type { DomainTools, ToolContext } from './types.js';

export const CONVERSATION_SNIPPET_MAX = 300;
const DAYS_DEFAULT = 7;
const LIMIT_DEFAULT = 20;
const LIMIT_MAX = 40;

const TEAM_LEAD_TOOLS = [
  {
    name: 'read_conversation',
    description:
      "What a team member and their OWN ASSISTANT said to each other on Telegram: their words, " +
      "the assistant's replies, and which record tools the assistant used. Use it to learn what " +
      'someone has already told their assistant, or what their assistant was told, instead of ' +
      'sending their assistant a question. It is evidence of what was SAID, not the record: quote ' +
      'it only as "they told their assistant …", and check the record before relying on a fact. ' +
      'Newest first, as short snippets. Only people on the new assistants appear here; for anyone ' +
      "else it comes back empty. A MANAGER's conversation is private and never readable: to learn " +
      'what a manager knows, ask them directly.',
    inputSchema: {
      type: 'object',
      properties: {
        person: {
          type: 'string',
          description: 'Their ref, exactly as THE TEAM spells it (e.g. ben-shelton).',
        },
        query: {
          type: 'string',
          description:
            'Optional words to look for (a customer name, "parts", a tool such as record_field_note). ' +
            'Leave it out for their latest turns.',
        },
        days: {
          type: 'number',
          description: `How many days back to look — a count, never a date. Default ${DAYS_DEFAULT}; nothing older than the retention window exists.`,
        },
        limit: {
          type: 'number',
          description: `How many turns, default ${LIMIT_DEFAULT}, at most ${LIMIT_MAX}.`,
        },
      },
      required: ['person'],
    },
  },
];

const clamp = (v: unknown, fallback: number, max: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(Math.floor(v), max) : fallback;

const snippet = (text: string): string => {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= CONVERSATION_SNIPPET_MAX ? one : `${one.slice(0, CONVERSATION_SNIPPET_MAX)}…`;
};

async function handleReadConversation(toolCtx: ToolContext): Promise<unknown> {
  const { tenantId, str, args } = toolCtx;
  const ref = str('person')?.trim();
  if (!ref) throw new Error('pass `person` — their ref exactly as THE TEAM spells it');
  // Tenant-scoped: a ref from another firm resolves to nobody here.
  const person = await getTechnician(tenantId, ref);
  if (!person) throw new Error(`no team member "${ref}" in this firm — copy the ref exactly from THE TEAM`);
  // Operator, 2026-09-24: a manager's chat with their assistant is private.
  // Not an error — the answer the office needs is WHERE to go instead.
  if (person.tier === 'manager') {
    return {
      status: 'private',
      person: ref,
      note: `${ref} is a manager: their conversation with their assistant is private and cannot be read. Ask them directly (send, as "chat").`,
    };
  }
  // The retention window is the ceiling: nothing older exists (seatTurnRetentionDays).
  const days = clamp(typeof args.days === 'string' ? Number(args.days) : args.days, DAYS_DEFAULT, seatTurnRetentionDays());
  const limit = clamp(args.limit, LIMIT_DEFAULT, LIMIT_MAX);
  const query = str('query')?.trim() || undefined;
  const rows = await searchSeatTurns({ tenantId, technicianId: person.id, query, days, limit });
  return {
    status: 'ok',
    person: ref,
    days,
    ...(rows.length === 0
      ? {
          note:
            `Nothing in the last ${days} day(s)${query ? ` matching "${query}"` : ''}. They may be on an ` +
            'assistant that does not share its conversation yet (only the new ones do), or simply have ' +
            'not talked about it — absence here is not absence from the record.',
        }
      : {}),
    turns: rows.map((r) => ({
      at: r.at,
      role: r.role,
      ...(r.text ? { snippet: snippet(r.text) } : {}),
      ...(r.tool ? { tool: r.tool } : {}),
      ...(r.role === 'tool' ? { ok: r.ok } : {}),
    })),
  };
}

export const seatConversationTools = {
  domain: 'seatConversation',
  teamLead: TEAM_LEAD_TOOLS,
  handlers: {
    read_conversation: handleReadConversation,
  },
} satisfies DomainTools;
