import { describe, expect, test } from 'vitest';
import type { QueuedNudgeForHost } from '../db/index.js';
import {
  FOOTER_DELIMITER,
} from '../teamLead/composeCopy.js';
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

// A footer-carrying deliverable, the LEGACY pre-Phase-5 shape (rows queued
// before the retirement deploy still look like this): human half + the
// agent-facing footer on the shared delimiter. The strip must keep serving
// these clean for as long as any such row can exist.
const HUMAN_HALF = 'How did it go?\n\n(re: Henderson — Furnace tune-up, visit on 2026-08-14)';
const QUESTION =
  HUMAN_HALF + "\n\nNote for the assistant: you are Ben's own assistant — ask them here.";

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
    // An ARRAY since Phase 2 (plan 2026-08-25): one delivery report moves a
    // whole ask-group, so the writer returns every row it moved.
    asked: async () => [queuedRow({ status: 'asked' })],
    groupMembers: async () => [],
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
    // ④b: a LEGACY footered row serves with the footer stripped — exactly the
    // human half, ending at the "(re: …)" line. (messageB64 removed Phase 5.)
    expect('messageB64' in nudges[0]).toBe(false);
    expect(Buffer.from(nudges[0].directMessageB64, 'base64').toString('utf8')).toBe(HUMAN_HALF);
    expect(serves).toEqual([['n1', 't1', 1]]);
  });

  test('stored = shown: a planner-written message passes the legacy strip unchanged', () => {
    // Since the collapse (plan 2026-08-24) the PLANNER writes the whole
    // delivered message and it is queued verbatim — there is no assemble step
    // left to test. What still matters here is the outbox invariant: a message
    // written today carries no trace of the retired footer delimiter, so the
    // strip kept for LEGACY rows is a no-op on it.
    const planner = 'How did the Henderson furnace tune-up go — anything worth noting?';
    expect(planner.includes(FOOTER_DELIMITER)).toBe(false);
    expect(planner.split(FOOTER_DELIMITER)[0]).toBe(planner); // strip = no-op
  });

  test('a footer-less question (Phase 5 onward) passes through the serve unchanged', async () => {
    const { nudges } = await buildNudgeDelivery('host-1', baseDeps({
      listQueued: async () => [queuedRow({ question: HUMAN_HALF })],
    }));
    expect(Buffer.from(nudges[0].directMessageB64, 'base64').toString('utf8')).toBe(HUMAN_HALF);
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

// ── plan 2026-08-25 Phase 2: one message may cover several gaps ─────────────
//
// The transport half. Nothing WRITES a group yet (that is Phase 3), so these
// seed `ask_group_id` by hand — which is also the point: the pipes must carry a
// group before anything forms one.
describe('ask-groups in the transport', () => {
  // The lead is the row that NAMES the group (id === ask_group_id), and here it
  // is deliberately NOT the earliest-created row — the two rules disagree
  // whenever the planner picks by judgment rather than by age, and the lead is
  // what owns the anchor, the session id and the serve ledger.
  const LEAD = 'n2';
  const group = (id: string, over: Partial<QueuedNudgeForHost> = {}) =>
    queuedRow({ id, ask_group_id: LEAD, question: `grouped text (${LEAD})`, ...over });
  const trio = () => [
    group('n1', { created_at: '2026-08-16T09:00:00.000Z' }), // earliest
    group('n2', { created_at: '2026-08-16T09:30:00.000Z' }), // the LEAD
    group('n3', { created_at: '2026-08-16T09:45:00.000Z' }),
  ];

  test('three grouped rows serve as ONE item, keyed on the lead not the eldest', async () => {
    const serves: string[] = [];
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () => trio(),
        serveCount: async (id, _t, n) => {
          serves.push(id);
          return queuedRow({ serve_count: n });
        },
      }),
    );
    expect(nudges).toHaveLength(1);
    expect(nudges[0].id).toBe(LEAD);
    expect(nudges[0].sessionId).toBe(`nudge-${LEAD}`);
    expect(Buffer.from(nudges[0].directMessageB64, 'base64').toString('utf8')).toBe(
      `grouped text (${LEAD})`,
    );
    // ONE serve for the message, on the lead's ledger — not three.
    expect(serves).toEqual([LEAD]);
  });

  test('a mixed pull yields one item per GROUP, ungrouped rows untouched', async () => {
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () => [
          group('n1'),
          group('n2'),
          queuedRow({ id: 'solo', ask_group_id: null }),
        ],
      }),
    );
    expect(nudges.map((n) => n.id)).toEqual([LEAD, 'solo']);
  });

  test('an inactive technician freezes the WHOLE group — no item, no failure', async () => {
    const outcomes: string[] = [];
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () =>
          trio().map((r) => ({
            ...r,
            technicians: { ...r.technicians!, state: 'offboarded' },
          })) as unknown as QueuedNudgeForHost[],
        outcome: async (_id, _t, status) => {
          outcomes.push(status);
          return null;
        },
      }),
    );
    expect(nudges).toEqual([]);
    expect(outcomes).toEqual([]); // frozen, not failed — a rebind may heal them
  });

  test('a group whose LEAD carries no question stays frozen', async () => {
    // The tamper-freeze is the only thing between a malformed row and an
    // infinite re-serve loop; grouping must not open a hole in it.
    const outcomes: string[] = [];
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () => [group('n1'), group('n2', { question: null }), group('n3')],
        outcome: async (_id, _t, status) => {
          outcomes.push(status);
          return null;
        },
      }),
    );
    expect(nudges).toEqual([]);
    expect(outcomes).toEqual([]);
  });

  test('serve-cap exhaustion hands EVERY member to the manager and fails all three', async () => {
    // One undeliverable message orphans all of the gaps it was written for.
    const flagged: string[] = [];
    const failed: string[] = [];
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () =>
          trio().map((r) => ({ ...r, serve_count: MAX_SERVE_COUNT })) as QueuedNudgeForHost[],
        flagNudge: async (input) => {
          flagged.push((input as { subjectRef: string }).subjectRef);
          return { id: 'ri' } as unknown as Awaited<
            ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>
          >;
        },
        outcome: async (id, _t, status) => {
          failed.push(`${id}:${status}`);
          return null;
        },
      }),
    );
    expect(nudges).toEqual([]);
    expect(flagged).toHaveLength(3);
    expect(failed).toEqual(['n1:failed', 'n2:failed', 'n3:failed']);
  });

  test('one delivery report moves the whole group, and passes the group id through', async () => {
    const seen: Array<[string, string, string | null | undefined]> = [];
    const result = await completeNudgeDelivery('host-1', LEAD, 'delivered', null, {
      ...baseDeps(),
      getQueued: async () => group(LEAD),
      asked: async (leadId, tenantId, groupId) => {
        seen.push([leadId, tenantId, groupId]);
        return trio().map((r) => ({ ...r, status: 'asked' })) as never;
      },
    });
    expect(result).toBe('asked');
    expect(seen).toEqual([[LEAD, 't1', LEAD]]);
  });

  test('terminal delivery failure hands every member over', async () => {
    const flagged: string[] = [];
    const failed: string[] = [];
    const result = await completeNudgeDelivery('host-1', LEAD, 'failed', 'boom', {
      ...baseDeps(),
      getQueued: async () => group(LEAD, { attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      attempts: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS }),
      groupMembers: async (groupId, hostId) => {
        expect(groupId).toBe(LEAD);
        expect(hostId).toBe('host-1');
        return trio();
      },
      flagNudge: async (input) => {
        flagged.push((input as { subjectRef: string }).subjectRef);
        return { id: 'ri' } as unknown as Awaited<
          ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>
        >;
      },
      outcome: async (id, _t, status) => {
        failed.push(`${id}:${status}`);
        return null;
      },
    });
    expect(result).toBe('failed');
    expect(flagged).toHaveLength(3);
    expect(failed).toEqual(['n1:failed', 'n2:failed', 'n3:failed']);
  });

  test('an UNGROUPED row skips the group read entirely', async () => {
    // The common path must not pay for a feature it does not use.
    let called = false;
    const result = await completeNudgeDelivery('host-1', 'n1', 'failed', 'boom', {
      ...baseDeps(),
      getQueued: async () => queuedRow({ ask_group_id: null, attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      attempts: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS }),
      groupMembers: async () => {
        called = true;
        return [];
      },
      flagNudge: async () =>
        ({ id: 'ri' }) as unknown as Awaited<ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>>,
      outcome: async () => null,
    });
    expect(result).toBe('failed');
    expect(called).toBe(false);
  });
});

describe('a group that lost its lead is FROZEN, never re-delivered', () => {
  // The sweep's pre-ask carve-out and `moot` each close ONE queued row and leave
  // its siblings alone, so a group really can end up with no self-identifying
  // member. Promoting a sibling would change the delivery item id — and the box
  // dedupes on exactly that id — so the whole message would be sent again,
  // including the question that was just answered.
  const orphaned = () => [
    queuedRow({ id: 'n2', ask_group_id: 'n-gone', question: 'grouped text' }),
    queuedRow({ id: 'n3', ask_group_id: 'n-gone', question: 'grouped text' }),
  ];

  test('no item is served, and nothing is failed either', async () => {
    const outcomes: string[] = [];
    const serves: string[] = [];
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () => orphaned(),
        serveCount: async (id, _t, n) => {
          serves.push(id);
          return queuedRow({ serve_count: n });
        },
        outcome: async (_id, _t, status) => {
          outcomes.push(status);
          return null;
        },
      }),
    );
    expect(nudges).toEqual([]);
    expect(serves).toEqual([]); // no ledger touched — nothing was sent
    expect(outcomes).toEqual([]); // the 18h expiry is the terminal exit
  });

  test('a healthy group alongside it is still served', async () => {
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () => [
          ...orphaned(),
          queuedRow({ id: 'ok', ask_group_id: 'ok', question: 'fine' }),
        ],
      }),
    );
    expect(nudges.map((n) => n.id)).toEqual(['ok']);
  });
});

describe('a group member says which ledger failed it', () => {
  // The lead owns serve_count and attempts, so a member's own columns read 0
  // while its resolution says "served 10x". The text names the lead rather than
  // leaving a psql reader to reconcile a row against itself.
  test('serve-cap resolutions point non-lead members at the lead', async () => {
    const failed: string[] = [];
    await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () => [
          queuedRow({ id: 'lead', ask_group_id: 'lead', serve_count: MAX_SERVE_COUNT }),
          queuedRow({ id: 'other', ask_group_id: 'lead', serve_count: 0 }),
        ],
        flagNudge: async () =>
          ({ id: 'ri' }) as unknown as Awaited<
            ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>
          >,
        outcome: async (id, _t, _s, resolution) => {
          failed.push(`${id}=${resolution}`);
          return null;
        },
      }),
    );
    expect(failed[0]).toBe(`lead=undeliverable: served ${MAX_SERVE_COUNT}x with no delivery ack`);
    // The sibling's own serve_count is 0; the text says whose ledger counted.
    expect(failed[1]).toBe(
      `other=undeliverable: served ${MAX_SERVE_COUNT}x with no delivery ack (counted on the group's lead lead)`,
    );
  });
});

describe('the guards round-2 review found untested', () => {
  test('a delivered report whose LEAD has closed still moves the survivors', async () => {
    // `moot` and the pre-ask carve-out close ONE queued row, so the lead can be
    // gone by the time the box reports. Without this the survivors — really
    // delivered, inside the shared message — would wait out the 18h sweep and
    // reach a manager captioned "never delivered".
    const seen: Array<[string, string, string | null | undefined]> = [];
    const result = await completeNudgeDelivery('host-1', 'lead-gone', 'delivered', null, {
      ...baseDeps(),
      getQueued: async () => null, // the lead is no longer queued
      groupMembers: async (groupId, hostId) => {
        expect(groupId).toBe('lead-gone');
        expect(hostId).toBe('host-1');
        return [queuedRow({ id: 'survivor', ask_group_id: 'lead-gone' })];
      },
      asked: async (leadId, tenantId, groupId) => {
        seen.push([leadId, tenantId, groupId]);
        return [queuedRow({ id: 'survivor', status: 'asked' })] as never;
      },
    });
    expect(result).toBe('asked');
    expect(seen).toEqual([['survivor', 't1', 'lead-gone']]);
  });

  test('an unknown id with no group still reports ignored', async () => {
    const result = await completeNudgeDelivery('host-1', 'nope', 'delivered', null, {
      ...baseDeps(),
      getQueued: async () => null,
      groupMembers: async () => [],
    });
    expect(result).toBe('ignored');
  });

  test('a FAILED report on a vanished lead is ignored, not expanded', async () => {
    let called = false;
    const result = await completeNudgeDelivery('host-1', 'gone', 'failed', 'boom', {
      ...baseDeps(),
      getQueued: async () => null,
      groupMembers: async () => {
        called = true;
        return [];
      },
    });
    expect(result).toBe('ignored');
    expect(called).toBe(false);
  });

  test('a throwing group read still hands the lead over (the F1 doctrine)', async () => {
    // Before Phase 2 this path needed no read at all. An unwrapped throw would
    // skip the handoff entirely with attempts already bumped.
    const flagged: string[] = [];
    const failed: string[] = [];
    const result = await completeNudgeDelivery('host-1', 'n1', 'failed', 'boom', {
      ...baseDeps(),
      getQueued: async () => queuedRow({ ask_group_id: 'n1', attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      attempts: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS }),
      groupMembers: async () => {
        throw new Error('database is on fire');
      },
      flagNudge: async (input) => {
        flagged.push((input as { subjectRef: string }).subjectRef);
        return { id: 'ri' } as unknown as Awaited<
          ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>
        >;
      },
      outcome: async (id, _t, status) => {
        failed.push(`${id}:${status}`);
        return null;
      },
    });
    expect(result).toBe('failed');
    expect(flagged).toHaveLength(1); // the lead alone, but handed over
    expect(failed).toEqual(['n1:failed']);
  });

  test('a group read that OMITS the lead still fails the lead', async () => {
    const failed: string[] = [];
    await completeNudgeDelivery('host-1', 'n1', 'failed', 'boom', {
      ...baseDeps(),
      getQueued: async () => queuedRow({ id: 'n1', ask_group_id: 'n1', attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      attempts: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS }),
      groupMembers: async () => [queuedRow({ id: 'sibling', ask_group_id: 'n1' })],
      flagNudge: async () =>
        ({ id: 'ri' }) as unknown as Awaited<ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>>,
      outcome: async (id, _t, status) => {
        failed.push(`${id}:${status}`);
        return null;
      },
    });
    expect(failed).toEqual(['n1:failed', 'sibling:failed']);
  });

  test('the delivery-failure resolution names the lead for non-lead members', async () => {
    const failed: string[] = [];
    await completeNudgeDelivery('host-1', 'lead', 'failed', null, {
      ...baseDeps(),
      getQueued: async () => queuedRow({ id: 'lead', ask_group_id: 'lead', attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      attempts: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS }),
      groupMembers: async () => [
        queuedRow({ id: 'lead', ask_group_id: 'lead' }),
        queuedRow({ id: 'other', ask_group_id: 'lead' }),
      ],
      flagNudge: async () =>
        ({ id: 'ri' }) as unknown as Awaited<ReturnType<NonNullable<NudgeQueueDeps['flagNudge']>>>,
      outcome: async (id, _t, _s, resolution) => {
        failed.push(`${id}=${resolution}`);
        return null;
      },
    });
    expect(failed[0]).toBe(`lead=delivery failed ${MAX_DELIVERY_ATTEMPTS}x`);
    expect(failed[1]).toBe(
      `other=delivery failed ${MAX_DELIVERY_ATTEMPTS}x (counted on the group's lead lead)`,
    );
  });
});
