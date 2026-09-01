import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { insertTechnician } from '../db/technicians.js';
import { createPendingNudge } from '../db/nudges.js';
import type { ForcedToolSpec } from '../model/forcedTool.js';
import type { Nudge, OfficeMessage } from '../db/index.js';
import { hasModelCredentials } from '../model/forcedTool.js';
import type { ToolLoopResult } from '../model/toolLoop.js';
import {
  answerDeskQuestion,
  DESK_FALLBACK_NOTE,
  DESK_READ_TOOLS,
  renderAskerState,
  type DeskDeps,
} from './desk.js';
import { DESK_NARROW_DISCLOSURE, DESK_SYSTEM } from './deskPrompt.js';
import { TEAM_LEAD_REF } from './identity.js';

// ── hermetic unit tests: every collaborator stubbed ─────────────────────────

const TEAM_LEAD_READS: ForcedToolSpec[] = [
  { name: 'spine_read', description: 'r', inputSchema: { type: 'object', properties: {} } },
  { name: 'recall_decisions', description: 'r', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_memory', description: 'r', inputSchema: { type: 'object', properties: {} } },
  { name: 'write_memory', description: 'w', inputSchema: { type: 'object', properties: {} } },
  { name: 'read_job_note', description: 'r', inputSchema: { type: 'object', properties: {} } },
  { name: 'write_job_note', description: 'w', inputSchema: { type: 'object', properties: {} } },
];

function askRow(over: Partial<OfficeMessage> = {}): OfficeMessage {
  return {
    id: 'ask-1',
    tenant_id: 't1',
    direction: 'to_planner',
    kind: 'ask',
    status: 'unread',
    ...over,
  } as unknown as OfficeMessage;
}

type SeenLoop = { req?: { system: string; user: string }; tools?: ForcedToolSpec[] };
function stubDeps(over: Partial<DeskDeps> = {}, seen: SeenLoop = {}) {
  const created: unknown[] = [];
  const markRead = vi.fn<(tenantId: string, ids: string[], nowIso: string) => Promise<number>>(async () => 1);
  const deps: DeskDeps & { created: unknown[] } = {
    toolSchemas: TEAM_LEAD_READS,
    dispatch: vi.fn(async () => ({})),
    memoryIndex: async () => '- firm/pacing.md — how patient to be',
    runLoop: (async (
      req: { system: string; user: string },
      tools: ForcedToolSpec[],
    ): Promise<ToolLoopResult> => {
      seen.req = req;
      seen.tools = tools;
      return { text: 'the office has nothing open for you', turns: 1, calls: [] };
    }) as unknown as NonNullable<DeskDeps['runLoop']>,
    createMessage: (async (input: unknown) => {
      created.push(input);
      return askRow();
    }) as unknown as NonNullable<DeskDeps['createMessage']>,
    markRead,
    listNudges: async () => [],
    created,
    ...over,
  };
  return deps;
}

const baseInput = {
  tenantId: 't1',
  askerRef: 'ben-shelton',
  askerTier: 'technician' as string | null,
  managerDesk: false,
  askerTechnicianId: 'tech-1' as string | null,
  question: 'am I square with the office?',
};

describe('the desk — tier decides the toolset (leak-proof by construction)', () => {
  test('a technician-tier asker gets NO dispatched tools; their own state is inlined', async () => {
    const seen: SeenLoop = {};
    const listNudges = vi.fn(async () =>
      [
        { technician_id: 'tech-1', kind: 'overdue_visit_gap', status: 'asked', question: 'How did the marina visit go?', asked_at: '2026-08-30T18:00:00Z' },
        { technician_id: 'tech-OTHER', kind: 'job_cost_gap', status: 'asked', question: 'SECRET other-person question', asked_at: null },
      ] as unknown as Nudge[],
    );
    const deps = stubDeps({ listNudges }, seen);
    const res = await answerDeskQuestion(baseInput, deps);
    expect(res.answer).toBe('the office has nothing open for you');
    expect(seen.tools).toEqual([]); // no tools AT ALL — nothing to leak through
    expect(seen.req!.user).toContain('How did the marina visit go?');
    // The pre-read is self-scoped: another person's question never enters.
    expect(seen.req!.user).not.toContain('SECRET other-person question');
  });

  test('a roster-less asker gets the technician treatment (least privilege)', async () => {
    const seen: SeenLoop = {};
    const deps = stubDeps({}, seen);
    await answerDeskQuestion({ ...baseInput, askerTier: null, askerTechnicianId: null }, deps);
    expect(seen.tools).toEqual([]);
  });

  test('manager TIER without the capability still gets the self-scoped desk (review F-A)', async () => {
    // An invited manager's pre-minted badge: tier says manager, the caller's
    // active-manager predicate says no — the desk must not widen.
    const seen: SeenLoop = {};
    const deps = stubDeps({}, seen);
    await answerDeskQuestion({ ...baseInput, askerTier: 'manager', managerDesk: false }, deps);
    expect(seen.tools).toEqual([]);
  });

  test('a manager-tier asker gets the team-lead READ surface — writes excluded', async () => {
    const seen: SeenLoop = {};
    const deps = stubDeps({}, seen);
    await answerDeskQuestion({ ...baseInput, askerTier: 'manager', managerDesk: true }, deps);
    const names = (seen.tools ?? []).map((t) => t.name);
    expect(new Set(names)).toEqual(new Set(DESK_READ_TOOLS));
    // The ALLOWLIST is the mechanism (fail-closed): a write verb added to the
    // team-lead surface later must NOT reach the desk automatically.
    for (const w of ['write_memory', 'write_job_note']) expect(names).not.toContain(w);
  });

  test("the manager desk's tools dispatch under the TEAM LEAD's identity", async () => {
    const dispatch = vi.fn(async () => [{ n: 1 }]);
    const deps = stubDeps({
      dispatch,
      runLoop: (async (
        _req: unknown,
        _tools: unknown,
        execute: (name: string, args: Record<string, unknown>) => Promise<unknown>,
      ): Promise<ToolLoopResult> => {
        await execute('spine_read', { sql: 'select 1' });
        return { text: 'answered from a read', turns: 2, calls: [] };
      }) as unknown as NonNullable<DeskDeps['runLoop']>,
    });
    await answerDeskQuestion({ ...baseInput, askerTier: 'manager', managerDesk: true }, deps);
    expect(dispatch).toHaveBeenCalledWith(
      'spine_read',
      { sql: 'select 1' },
      { tenantId: 't1', technicianRef: TEAM_LEAD_REF },
    );
  });
});

describe('the desk — transcript and degrade', () => {
  test('success writes the ask, then the answer (in_reply_to, born read), then marks the ask read', async () => {
    const deps = stubDeps();
    const res = await answerDeskQuestion(baseInput, deps);
    expect(res.answer).toBeTruthy();
    expect(deps.created).toHaveLength(2);
    expect(deps.created[0]).toMatchObject({
      direction: 'to_planner',
      kind: 'ask',
      fromRef: 'ben-shelton',
      tier: 'technician',
      body: baseInput.question,
    });
    expect(deps.created[1]).toMatchObject({
      kind: 'desk',
      fromRef: TEAM_LEAD_REF,
      toRef: 'ben-shelton',
      inReplyTo: 'ask-1',
      status: 'read',
    });
    expect(deps.markRead).toHaveBeenCalledWith('t1', ['ask-1'], expect.any(String));
  });

  test('a loop failure keeps the ask UNREAD and returns the honest degrade', async () => {
    const deps = stubDeps({
      runLoop: (async () => {
        throw new Error('provider down');
      }) as unknown as NonNullable<DeskDeps['runLoop']>,
    });
    const res = await answerDeskQuestion(baseInput, deps);
    expect(res.answer).toBeNull();
    expect(res.note).toBe(DESK_FALLBACK_NOTE);
    expect(deps.created).toHaveLength(1); // the ask only — no transcript row
    expect(deps.markRead).not.toHaveBeenCalled();
  });

  test('an empty answer is a failure, not an answer', async () => {
    const deps = stubDeps({
      runLoop: (async (): Promise<ToolLoopResult> => ({ text: '   ', turns: 1, calls: [] })) as unknown as NonNullable<DeskDeps['runLoop']>,
    });
    const res = await answerDeskQuestion(baseInput, deps);
    expect(res.answer).toBeNull();
    expect(deps.markRead).not.toHaveBeenCalled();
  });

  test('a memory-read failure degrades to answering without the notes', async () => {
    const seen: SeenLoop = {};
    const deps = stubDeps(
      {
        memoryIndex: async () => {
          throw new Error('db hiccup');
        },
      },
      seen,
    );
    const res = await answerDeskQuestion(baseInput, deps);
    expect(res.answer).toBeTruthy();
    expect(seen.req!.user).not.toContain("THE OFFICE'S OWN NOTES");
  });

  test("the planner's notes ride EVERY desk — a desk without them is not the planner", async () => {
    // User ruling 2026-09-01, reversing the final review's mechanism fix: the
    // notes are what make the desk a reconstitution rather than a stranger in
    // the planner's name, and the material is low-stakes enough for a prompt
    // guard. The TOOLS stay mechanism-bounded (asserted above).
    const seen: SeenLoop = {};
    const memoryIndex = vi.fn(async () => '- firm/pacing.md — patience notes');
    let deps = stubDeps({ memoryIndex }, seen);
    await answerDeskQuestion(baseInput, deps); // technician desk
    expect(memoryIndex).toHaveBeenCalled();
    expect(seen.req!.user).toContain("THE OFFICE'S OWN NOTES");
    expect(seen.req!.user).toContain('- firm/pacing.md — patience notes');
    deps = stubDeps({ memoryIndex }, seen);
    await answerDeskQuestion({ ...baseInput, askerTier: 'manager', managerDesk: true }, deps);
    expect(seen.req!.user).toContain("THE OFFICE'S OWN NOTES");
  });

  test('a non-manager asker carries the narrow-disclosure guard beside the question', async () => {
    const seen: SeenLoop = {};
    let deps = stubDeps({}, seen);
    await answerDeskQuestion(baseInput, deps);
    expect(seen.req!.user).toContain(DESK_NARROW_DISCLOSURE);
    // …and it sits AFTER the notes, next to the question it governs.
    expect(seen.req!.user.indexOf(DESK_NARROW_DISCLOSURE)).toBeGreaterThan(
      seen.req!.user.indexOf("THE OFFICE'S OWN NOTES"),
    );
    // A roster-less badge is a non-manager too.
    deps = stubDeps({}, seen);
    await answerDeskQuestion({ ...baseInput, askerTier: null, askerTechnicianId: null }, deps);
    expect(seen.req!.user).toContain(DESK_NARROW_DISCLOSURE);
    // The manager desk does not carry it.
    deps = stubDeps({}, seen);
    await answerDeskQuestion({ ...baseInput, askerTier: 'manager', managerDesk: true }, deps);
    expect(seen.req!.user).not.toContain(DESK_NARROW_DISCLOSURE);
  });
});

describe('the desk prompt — the rules that are load-bearing', () => {
  test('pins the read-only identity and the secrecy rules', () => {
    expect(DESK_SYSTEM).toContain('You READ, you never act');
    expect(DESK_SYSTEM).toContain('Never quote a note verbatim');
    expect(DESK_SYSTEM).toContain('office will follow up');
    expect(DESK_SYSTEM).toContain('Four sentences at most');
    // The notes ride every desk now, so the guard on them is load-bearing.
    expect(DESK_SYSTEM).toContain('never recite your index');
    expect(DESK_NARROW_DISCLOSURE).toContain('Do not read your notes or your index back');
    expect(DESK_NARROW_DISCLOSURE).toContain('about ANOTHER person');
    expect(DESK_NARROW_DISCLOSURE).toContain('what you were considering doing about them');
  });

  test('renderAskerState is self-scoped and honest about nothing', () => {
    expect(renderAskerState([], 'tech-1')).toContain('nothing');
    expect(renderAskerState([], null)).toContain('nothing');
    const rows = [
      { technician_id: 'tech-1', kind: 'job_cost_gap', status: 'asked', question: 'What did parts cost?', asked_at: '2026-08-30T18:00:00Z' },
      { technician_id: 'tech-2', kind: 'job_cost_gap', status: 'asked', question: 'NOT YOURS', asked_at: null },
    ] as unknown as Nudge[];
    const out = renderAskerState(rows, 'tech-1');
    expect(out).toContain('What did parts cost?');
    expect(out).not.toContain('NOT YOURS');
  });
});

// ── key-gated live smoke (the planner-eval idiom): a REAL desk answer over
// the local stack, transcripts verified by independent pg read-back ──────────

describe.skipIf(!hasModelCredentials())('the desk (live model, local stack)', () => {
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  let tenantId: string;
  let techId: string;
  const RUN = `desk-live-${Date.now()}`;
  const nudgeIds: string[] = [];

  beforeAll(async () => {
    await pg.connect();
    const { data, error } = await getClient()
      .from('tenants')
      .select('id')
      .eq('name', 'Default Tenant')
      .single();
    if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
    tenantId = data.id;
    const tech = await insertTechnician({
      tenantId,
      ref: `${RUN}-tech`,
      displayName: 'Desk Live Tech',
      seatExempt: true,
    });
    techId = tech.id;
    const n = await createPendingNudge({
      tenantId,
      kind: 'overdue_visit_gap',
      subjectRef: `${RUN}-subject`,
      technicianId: techId,
      context: { jobTitle: 'Marina boiler check', customerName: 'Harborside' },
    });
    if (n) nudgeIds.push(n.id);
  });

  afterAll(async () => {
    await pg.query('delete from office_messages where tenant_id = $1 and (from_ref = $2 or to_ref = $2)', [tenantId, `${RUN}-tech`]);
    if (nudgeIds.length > 0) await pg.query('delete from nudges where id = any($1::uuid[])', [nudgeIds]);
    await pg.query('delete from technicians where id = $1', [techId]);
    await pg.end();
  });

  test('answers a technician "am I square" from their own inlined state', async () => {
    const res = await answerDeskQuestion({
      tenantId,
      askerRef: `${RUN}-tech`,
      askerTier: 'technician',
      managerDesk: false,
      askerTechnicianId: techId,
      question: 'Is the office waiting on anything from me right now?',
    });
    console.log('[desk live] answer:', res.answer ?? `(degraded: ${res.note})`);
    // A provider outage degrades honestly; the smoke asserts the CONTRACT
    // either way — but a real answer is the expected outcome.
    const { rows } = await pg.query(
      'select kind, status, in_reply_to from office_messages where tenant_id = $1 and (from_ref = $2 or to_ref = $2) order by created_at',
      [tenantId, `${RUN}-tech`],
    );
    if (res.answer) {
      expect(rows.map((r) => r.kind)).toEqual(['ask', 'desk']);
      expect(rows[0].status).toBe('read'); // answered — left the unread queue
      expect(rows[1].status).toBe('read'); // transcript, born read
      expect(rows[1].in_reply_to).not.toBeNull();
    } else {
      expect(rows.map((r) => r.kind)).toEqual(['ask']);
      expect(rows[0].status).toBe('unread'); // kept for the tick
    }
  }, 60_000);
});
