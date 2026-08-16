import { describe, expect, test } from 'vitest';
import type { Nudge } from '../db/index.js';
import {
  assembleNudgeMessage,
  MAX_COMPOSE_ATTEMPTS,
  runTeamLeadCompose,
  type ComposeDeps,
} from './compose.js';

// Pure unit tests — the model call and every DB accessor injected. The real
// model is exercised once in the phase's key-gated live check, not here.

function pendingNudge(over: Partial<Nudge> = {}): Nudge {
  return {
    id: 'n1',
    tenant_id: 't1',
    kind: 'overdue_visit_gap',
    subject_ref: 'a1',
    technician_id: 'tech-1',
    status: 'pending',
    question: null,
    context: {
      customerName: 'Henderson',
      jobTitle: 'Furnace tune-up',
      technicianRef: 'ben-shelton',
      technicianName: 'Ben Shelton',
      assignmentId: 'a1',
      jobId: 'j1',
      startsAtLocal: '2026-08-14T07:00:00.000Z',
      endsAtLocal: '2026-08-14T08:00:00.000Z',
      visitEndLabel: 'Friday, Aug 14 at 8:00 AM',
    },
    attempts: 0,
    serve_count: 0,
    actor_ref: 'spine:team-lead',
    resolution: null,
    queued_at: null,
    asked_at: null,
    resolved_at: null,
    created_at: '2026-08-16T10:00:00.000Z',
    updated_at: '2026-08-16T10:00:00.000Z',
    ...over,
  } as unknown as Nudge;
}

function baseDeps(over: Partial<ComposeDeps> = {}): ComposeDeps {
  return {
    listTenants: async () => ['t1'],
    listNudges: async () => [pendingNudge()],
    run: async () => ({ ask: true, question: 'How did the Henderson visit go?', reason: 'gap' }),
    markQueued: async () => pendingNudge({ status: 'queued' }),
    markOutcome: async () => pendingNudge({ status: 'cancelled' }),
    setAttempts: async () => pendingNudge(),
    ...over,
  };
}

describe('runTeamLeadCompose', () => {
  test('ask:true → queued with the assembled deliverable (question + evidence line + footer)', async () => {
    const queuedWith: string[] = [];
    const summary = await runTeamLeadCompose(baseDeps({
      markQueued: async (_id, _t, message) => {
        queuedWith.push(message);
        return pendingNudge({ status: 'queued' });
      },
    }));
    expect(summary).toEqual({ composed: 1, cancelled: 0, failed: 0, rowErrors: 0 });
    expect(queuedWith).toHaveLength(1);
    const msg = queuedWith[0];
    expect(msg).toContain('How did the Henderson visit go?');
    // Code-printed evidence: bare date only — no weekday for the guard to
    // dispute, and the model's sentence carries no date at all.
    expect(msg).toContain('(re: Henderson — Furnace tune-up, visit on 2026-08-14)');
    expect(msg).not.toContain('Friday');
    // The standing footer steers the receiving agent.
    expect(msg).toContain('check this conversation');
    expect(msg).toContain('record_field_note');
    expect(msg).toContain('Ben Shelton');
    expect(msg).not.toContain('spine');
  });

  test('the model sees ONLY the code-built context (fabrication guard)', async () => {
    const prompts: string[] = [];
    await runTeamLeadCompose(baseDeps({
      run: async (_tool, req) => {
        prompts.push(req.user, req.system);
        return { ask: true, question: 'q', reason: 'r' };
      },
    }));
    expect(prompts[0]).toBe(
      'Customer: Henderson\nJob: Furnace tune-up\nTechnician: Ben Shelton\n' +
        'The scheduled visit ended hours ago; no field note and no status change since.',
    );
    // No ids, no timestamps, no jargon reach the model.
    expect(prompts[0]).not.toContain('a1');
    expect(prompts[1]).toContain('never the word "spine"');
  });

  test('ask:false → cancelled with the model reason; nothing queued', async () => {
    const outcomes: Array<[string, string | null | undefined]> = [];
    const summary = await runTeamLeadCompose(baseDeps({
      run: async () => ({ ask: false, question: '', reason: 'evidence too thin' }),
      markQueued: async () => {
        throw new Error('declined nudges must not queue');
      },
      markOutcome: async (_id, _t, status, resolution) => {
        outcomes.push([status, resolution]);
        return pendingNudge({ status: 'cancelled' });
      },
    }));
    expect(summary).toEqual({ composed: 0, cancelled: 1, failed: 0, rowErrors: 0 });
    expect(outcomes).toEqual([['cancelled', 'declined: evidence too thin']]);
  });

  test('incomplete context → cancelled WITHOUT a model call (never guess around thin evidence)', async () => {
    const outcomes: string[] = [];
    const summary = await runTeamLeadCompose(baseDeps({
      listNudges: async () => [pendingNudge({ context: { jobTitle: 'only this' } })],
      run: async () => {
        throw new Error('the model must not see incomplete context');
      },
      markOutcome: async (_id, _t, status, resolution) => {
        outcomes.push(`${status}: ${resolution}`);
        return pendingNudge({ status: 'cancelled' });
      },
    }));
    expect(summary).toEqual({ composed: 0, cancelled: 1, failed: 0, rowErrors: 0 });
    expect(outcomes).toEqual(['cancelled: context incomplete']);
  });

  test('a throwing model is a rowError with attempts bookkeeping; the attempt cap fails the row', async () => {
    // First failure on a fresh row: attempts 0 → 1, no terminal write.
    const writes: Array<[string, number] | [string, string]> = [];
    const first = await runTeamLeadCompose(baseDeps({
      run: async () => {
        throw new Error('inference 503');
      },
      setAttempts: async (id, _t, attempts) => {
        writes.push([id, attempts]);
        return pendingNudge({ attempts });
      },
      markOutcome: async () => {
        throw new Error('one failure must not be terminal');
      },
    }));
    expect(first).toEqual({ composed: 0, cancelled: 0, failed: 0, rowErrors: 1 });
    expect(writes).toEqual([['n1', 1]]);

    // The LAST allowed attempt failing goes terminal.
    const outcomes: string[] = [];
    const last = await runTeamLeadCompose(baseDeps({
      listNudges: async () => [pendingNudge({ attempts: MAX_COMPOSE_ATTEMPTS - 1 })],
      run: async () => {
        throw new Error('inference 503');
      },
      markOutcome: async (_id, _t, status, resolution) => {
        outcomes.push(`${status}: ${resolution}`);
        return pendingNudge({ status: 'failed' });
      },
    }));
    expect(last).toEqual({ composed: 0, cancelled: 0, failed: 1, rowErrors: 1 });
    expect(outcomes).toEqual([`failed: compose failed ${MAX_COMPOSE_ATTEMPTS}x: inference 503`]);
  });

  test('an unusable question (empty / oversize) is a rowError, not a queued deliverable', async () => {
    for (const question of ['', '   ', 'x'.repeat(501)]) {
      const summary = await runTeamLeadCompose(baseDeps({
        run: async () => ({ ask: true, question, reason: 'r' }),
        markQueued: async () => {
          throw new Error('unusable questions must not queue');
        },
      }));
      expect(summary.composed).toBe(0);
      expect(summary.rowErrors).toBe(1);
    }
  });

  test('kind-scoped: a pending nudge of another kind is left alone', async () => {
    const summary = await runTeamLeadCompose(baseDeps({
      listNudges: async () => [pendingNudge({ kind: 'call_action' } as Partial<Nudge>)],
      run: async () => {
        throw new Error('unknown kinds must not reach the model');
      },
    }));
    expect(summary).toEqual({ composed: 0, cancelled: 0, failed: 0, rowErrors: 0 });
  });
});

describe('assembleNudgeMessage', () => {
  test('trims the question and prints the bare end date', () => {
    const msg = assembleNudgeMessage('  How did it go?  ', {
      customerName: 'Acme',
      jobTitle: 'AC repair',
      technicianName: 'Jane Alvarez',
      endsAtLocal: '2026-08-15T16:00:00.000Z',
    });
    expect(msg.startsWith('How did it go?')).toBe(true);
    expect(msg).toContain('(re: Acme — AC repair, visit on 2026-08-15)');
  });
});
