import { describe, expect, test } from 'vitest';
import type { QueuedNudgeForHost } from '../db/index.js';
import {
  buildNudgeDelivery,
  completeNudgeDelivery,
  MAX_DELIVERY_ATTEMPTS,
  MAX_SERVE_COUNT,
  type NudgeQueueDeps,
} from './nudgeQueue.js';

// Pure unit tests — every DB accessor injected (badgeFile pattern). The wire
// shapes are pinned in httpServer.test.ts; this file pins the serve/report
// semantics.

const QUESTION = 'How did it go?\n\n(re: Henderson — Furnace tune-up, visit on 2026-08-14)';

function queuedRow(over: Partial<QueuedNudgeForHost> = {}): QueuedNudgeForHost {
  return {
    id: 'n1',
    tenant_id: 't1',
    kind: 'overdue_visit_gap',
    subject_ref: 'a1',
    technician_id: 'tech-1',
    status: 'queued',
    question: QUESTION,
    context: {
      customerName: 'Henderson',
      jobTitle: 'Furnace tune-up',
      technicianRef: 'ben-shelton',
      technicianName: 'Ben Shelton',
      jobId: 'j1',
      startsAtLocal: '2026-08-14T07:00:00.000Z',
      endsAtLocal: '2026-08-14T08:00:00.000Z',
    },
    attempts: 0,
    serve_count: 0,
    actor_ref: 'spine:team-lead',
    resolution: null,
    queued_at: '2026-08-16T10:00:00.000Z',
    asked_at: null,
    resolved_at: null,
    created_at: '2026-08-16T09:55:00.000Z',
    updated_at: '2026-08-16T10:00:00.000Z',
    technicians: {
      id: 'tech-1',
      ref: 'ben-shelton',
      state: 'active',
      sandbox_ref: 's5',
      telegram_user_id: '8991633730',
      host_id: 'host-1',
      tenant_id: 't1',
    },
    ...over,
  } as unknown as QueuedNudgeForHost;
}

function baseDeps(over: Partial<NudgeQueueDeps> = {}): NudgeQueueDeps {
  return {
    listQueued: async () => [queuedRow()],
    getQueued: async () => queuedRow(),
    serveCount: async (_id, _t, n) => queuedRow({ serve_count: n }),
    asked: async () => queuedRow({ status: 'asked' }),
    outcome: async () => queuedRow({ status: 'failed' }),
    attempts: async (_id, _t, n) => queuedRow({ attempts: n }),
    flagNudge: async () => null,
    ...over,
  };
}

describe('buildNudgeDelivery', () => {
  test('serves a deliverable: fresh session id, base64 message, serve counted BEFORE shipping', async () => {
    const serves: Array<[string, string, number]> = [];
    const { nudges } = await buildNudgeDelivery('host-1', baseDeps({
      serveCount: async (id, t, n) => {
        serves.push([id, t, n]);
        return queuedRow({ serve_count: n });
      },
    }));
    expect(nudges).toHaveLength(1);
    expect(nudges[0]).toMatchObject({
      id: 'n1',
      sandboxRef: 's5',
      replyTo: '8991633730',
      sessionId: 'nudge-n1',
    });
    expect(Buffer.from(nudges[0].messageB64, 'base64').toString('utf8')).toBe(QUESTION);
    expect(serves).toEqual([['n1', 't1', 1]]);
  });

  test('liveness re-filter at serve time: inactive/unbound techs are SKIPPED, not failed', async () => {
    for (const tech of [
      null,
      { ...queuedRow().technicians!, state: 'offboarded' },
      { ...queuedRow().technicians!, sandbox_ref: null },
      { ...queuedRow().technicians!, telegram_user_id: null },
    ]) {
      const { nudges } = await buildNudgeDelivery('host-1', baseDeps({
        listQueued: async () => [queuedRow({ technicians: tech } as Partial<QueuedNudgeForHost>)],
        serveCount: async () => {
          throw new Error('a skipped row must not be serve-counted');
        },
        outcome: async () => {
          throw new Error('a skipped row must not be failed');
        },
      }));
      expect(nudges).toEqual([]);
    }
  });

  test('the serve cap: a poison item hands to the manager and fails instead of serving', async () => {
    const flagged: string[] = [];
    const outcomes: Array<[string, string, string | null | undefined]> = [];
    const { nudges } = await buildNudgeDelivery('host-1', baseDeps({
      listQueued: async () => [queuedRow({ serve_count: MAX_SERVE_COUNT })],
      flagNudge: async (input) => {
        flagged.push(input.subjectRef);
        return { id: 'ri1' } as unknown as Awaited<ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>>;
      },
      outcome: async (id, _t, status, resolution) => {
        outcomes.push([id, status, resolution]);
        return queuedRow({ status: 'failed' });
      },
      serveCount: async () => {
        throw new Error('a capped row must not be served again');
      },
    }));
    expect(nudges).toEqual([]);
    expect(flagged).toEqual(['a1']); // the gap reached the manager (F1 doctrine)
    expect(outcomes).toEqual([
      ['n1', 'failed', `undeliverable: served ${MAX_SERVE_COUNT}x with no delivery ack`],
    ]);
  });

  test('a row that moved under us (serve write returns null) is dropped; one bad row never blocks the rest', async () => {
    const { nudges } = await buildNudgeDelivery('host-1', baseDeps({
      listQueued: async () => [
        queuedRow({ id: 'n-moved' }),
        queuedRow({ id: 'n-throws' }),
        queuedRow({ id: 'n-ok' }),
      ],
      serveCount: async (id, _t, n) => {
        if (id === 'n-moved') return null;
        if (id === 'n-throws') throw new Error('db blip');
        return queuedRow({ id, serve_count: n });
      },
    }));
    expect(nudges.map((x) => x.id)).toEqual(['n-ok']);
  });
});

describe('completeNudgeDelivery', () => {
  test('delivered → asked; unknown/foreign/moved rows → ignored', async () => {
    expect(await completeNudgeDelivery('host-1', 'n1', 'delivered', null, baseDeps())).toBe('asked');
    expect(
      await completeNudgeDelivery('host-1', 'nope', 'delivered', null, baseDeps({
        getQueued: async () => null, // wrong host / unknown id / already moved
      })),
    ).toBe('ignored');
  });

  test('failed below the cap → retry (bump only); at the cap → manager handoff + terminal failed', async () => {
    const bumps: number[] = [];
    const first = await completeNudgeDelivery('host-1', 'n1', 'failed', 'CLI timeout', baseDeps({
      attempts: async (_id, _t, n) => {
        bumps.push(n);
        return queuedRow({ attempts: n });
      },
      outcome: async () => {
        throw new Error('below the cap must not be terminal');
      },
      flagNudge: async () => {
        throw new Error('below the cap must not hand off');
      },
    }));
    expect(first).toBe('retry');
    expect(bumps).toEqual([1]);

    const flagged: string[] = [];
    const outcomes: string[] = [];
    const last = await completeNudgeDelivery('host-1', 'n1', 'failed', 'CLI timeout', baseDeps({
      getQueued: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      flagNudge: async (input) => {
        flagged.push(input.subjectRef);
        return { id: 'ri1' } as unknown as Awaited<ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>>;
      },
      outcome: async (_id, _t, status, resolution) => {
        outcomes.push(`${status}: ${resolution}`);
        return queuedRow({ status: 'failed' });
      },
    }));
    expect(last).toBe('failed');
    expect(flagged).toEqual(['a1']);
    expect(outcomes).toEqual([
      [`failed: delivery failed ${MAX_DELIVERY_ATTEMPTS}x: CLI timeout`],
    ].flat());
  });
});

describe('terminal-failure doctrine regressions (plan 2026-08-19 Phase 2)', () => {
  test('delivery give-up + LANDED handoff → failed, as before', async () => {
    const outcomes: string[] = [];
    const result = await completeNudgeDelivery('host-1', 'n1', 'failed', 'boom', {
      getQueued: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      attempts: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS }),
      flagNudge: async () =>
        ({ id: 'ri1' }) as unknown as Awaited<ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>>,
      outcome: async (_id, _t, status) => {
        outcomes.push(status);
        return null;
      },
    });
    expect(result).toBe('failed');
    expect(outcomes).toEqual(['failed']);
  });
});

describe('a JOB-SCOPED gap reaches the manager (plan 2026-08-19 Phase 4)', () => {
  // The orphan Phase 2 deferred. handToManager used to read visit-shaped fields
  // straight off the context, so a cost row — no startsAtLocal, no endsAtLocal
  // — could never be handed over, and the row closed with NO manager surface at
  // all. Now the KIND's spec builds the handoff.
  const costRow = (over: Partial<QueuedNudgeForHost> = {}) =>
    queuedRow({
      kind: 'job_cost_gap',
      subject_ref: 'j-cost',
      context: {
        customerName: 'Henderson',
        jobTitle: 'Boiler swap',
        technicianRef: 'ben-shelton',
        technicianName: 'Ben Shelton',
        jobId: 'j-cost',
      },
      ...over,
    });

  test('delivery gives up on a cost nudge → the manager gets it, with cost copy', async () => {
    const flagged: Array<Record<string, unknown>> = [];
    const outcomes: string[] = [];
    const result = await completeNudgeDelivery('host-1', 'n1', 'failed', 'boom', {
      getQueued: async () => costRow({ attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      attempts: async () => costRow({ attempts: MAX_DELIVERY_ATTEMPTS }),
      flagNudge: async (input) => {
        flagged.push({ ...input });
        return { id: 'ri1' } as unknown as Awaited<ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>>;
      },
      outcome: async (_id, _t, status) => {
        outcomes.push(status);
        return null;
      },
    });
    expect(result).toBe('failed');
    expect(outcomes).toEqual(['failed']);
    // The gap DID reach a manager surface, as the right kind, keyed on the job.
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({
      kind: 'job_cost_gap',
      subjectRef: 'j-cost',
      jobId: 'j-cost',
      startsAtLocal: null,
      endsAtLocal: null,
    });
    expect(String(flagged[0].suggestion)).toContain('cost in parts');
  });

  test('"already flagged" counts as ON A SURFACE, not as a failed handoff', async () => {
    // flagNudgeGap returns null for two opposite reasons — the once-ever dedup
    // found an existing item, or nothing landed. Conflating them would refuse
    // to close rows the manager already has.
    let probed: string[] = [];
    const result = await completeNudgeDelivery('host-1', 'n1', 'failed', 'boom', {
      getQueued: async () => costRow({ attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      attempts: async () => costRow({ attempts: MAX_DELIVERY_ATTEMPTS }),
      flagNudge: async () => null, // dedup: an item already exists
      reviewItemExists: async (_t, kind, subjectRef) => {
        probed = [kind, subjectRef];
        return true;
      },
      outcome: async () => null,
    });
    expect(result).toBe('failed'); // safe to close — the manager HAS the gap
    expect(probed).toEqual(['job_cost_gap', 'j-cost']);
  });
});
