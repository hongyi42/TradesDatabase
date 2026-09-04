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

// THE CHAT LEG (build 6.5 Phase 4). Office rows the planner marked via='chat'
// ride the NUDGE pull, because the box-side runner that texts a person
// verbatim is this one — and it never asks what table an id came from. That is
// what makes the whole leg spine-side: no Box_Setup_Stuff change, no rollout.
function chatRow(over: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    tenant_id: 't1',
    direction: 'to_agent',
    kind: 'inform',
    via: 'chat',
    body: 'Jane says the van needs a service soon.',
    status: 'queued',
    serve_count: 0,
    attempts: 0,
    technicians: {
      id: 'tech-1',
      ref: 'ben-shelton',
      state: 'active',
      sandbox_ref: 'sb-1',
      telegram_user_id: '5501',
      host_id: 'host-1',
      tenant_id: 't1',
    },
    ...over,
  } as never;
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
    attempts: async (_id, _t, n) => queuedRow({ attempts: n }),
    // THE CHAT LEG (build 6.5 Phase 4) rides this same pull, so every test
    // here must stub its reader or it reaches the real database — the same
    // reason every other reader above is stubbed. Empty by default: these
    // tests are about the nudge half, and a test that wants a chat row says so.
    listQueuedChat: async () => [],
    getQueuedChat: async () => null,
    // The chat leg's writers too — unstubbed, these reach the real database
    // and the row is silently dropped by the serve loop's own try/catch, which
    // reads as "the item was not served" rather than as a missing stub.
    chatServeCount: async (_id, _t, n) => chatRow({ serve_count: n }),
    chatAttempts: async (_id, _t, n) => chatRow({ attempts: n }),
    chatDelivery: async () => chatRow({ status: 'delivered' }),
    ...over,
  };
}

describe('the chat leg rides the nudge pull', () => {
  test('one pull carries BOTH kinds of item, and the chat body is the message itself', async () => {
    const { nudges } = await buildNudgeDelivery('host-1', baseDeps({
      listQueuedChat: async () => [chatRow()],
    }));
    expect(nudges).toHaveLength(2);
    const chat = nudges.find((n) => n.id === 'msg-1');
    expect(chat?.sandboxRef).toBe('sb-1');
    expect(chat?.replyTo).toBe('5501');
    expect(chat?.sessionId).toBe('chat-msg-1');
    expect(Buffer.from(chat!.directMessageB64, 'base64').toString('utf8')).toBe(
      'Jane says the van needs a service soon.',
    );
  });

  test('no Telegram binding = frozen, not failed — this is the leg that texts a phone', async () => {
    const { nudges } = await buildNudgeDelivery('host-1', baseDeps({
      listQueued: async () => [],
      listQueuedChat: async () => [
        chatRow({
        technicians: {
          id: 'tech-1', ref: 'ben-shelton', state: 'active', sandbox_ref: 'sb-1',
          telegram_user_id: null, host_id: 'host-1', tenant_id: 't1',
        },
      }),
      ],
    }));
    expect(nudges).toEqual([]);
  });

  test('the caps freeze it, and the serve is counted BEFORE shipping', async () => {
    const served: number[] = [];
    const one = await buildNudgeDelivery('host-1', baseDeps({
      listQueued: async () => [],
      listQueuedChat: async () => [chatRow()],
      chatServeCount: async (_i, _t, n) => {
        served.push(n);
        return chatRow({ serve_count: n });
      },
    }));
    expect(one.nudges).toHaveLength(1);
    expect(served).toEqual([1]);

    for (const over of [{ serve_count: MAX_SERVE_COUNT }, { attempts: MAX_DELIVERY_ATTEMPTS }]) {
      const frozen = await buildNudgeDelivery('host-1', baseDeps({
        listQueued: async () => [],
        listQueuedChat: async () => [chatRow(over)],
      }));
      expect(frozen.nudges).toEqual([]);
    }
  });

  test('a report is routed to the table that owns the id', async () => {
    // The box posts {id, outcome} and never says which table it came from.
    const settled: unknown[] = [];
    const delivered = await completeNudgeDelivery('host-1', 'msg-1', 'delivered', null, baseDeps({
      getQueued: async () => null, // not a nudge...
      getQueuedChat: async () => chatRow(), // ...it is a chat message
      chatDelivery: async (...args) => {
        settled.push(args);
        return chatRow({ status: 'delivered' });
      },
    }));
    expect(delivered).toBe('delivered');
    expect(settled).toHaveLength(1);
  });

  test('a FAILED chat report bumps attempts — freezing on attempts, not on serves', async () => {
    // Without the routing this could never happen: the closed-lead group path
    // below returns 'ignored' for any non-delivered report, so a chat row would
    // only ever freeze at MAX_SERVE_COUNT (10) instead of MAX_DELIVERY_ATTEMPTS (3).
    const bumped: number[] = [];
    const deps = (attempts: number) => baseDeps({
      getQueued: async () => null,
      getQueuedChat: async () => chatRow({ attempts }),
      chatAttempts: async (_i, _t, n) => {
        bumped.push(n);
        return chatRow({ attempts: n });
      },
    });
    expect(await completeNudgeDelivery('host-1', 'msg-1', 'failed', 'boom', deps(0))).toBe('retry');
    expect(await completeNudgeDelivery('host-1', 'msg-1', 'failed', 'boom', deps(2))).toBe('failed');
    expect(bumped).toEqual([1, 3]);
  });

  test('an id neither table claims is ignored', async () => {
    expect(
      await completeNudgeDelivery('host-1', 'ghost', 'delivered', null, baseDeps({
        getQueued: async () => null,
        getQueuedChat: async () => null,
        groupMembers: async () => [],
      })),
    ).toBe('ignored');
  });
});

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
      }));
      expect(nudges).toEqual([]);
    }
  });

  test('the serve cap FREEZES: no serve, no manager item, no terminal status (build 5)', async () => {
    const { nudges } = await buildNudgeDelivery('host-1', baseDeps({
      listQueued: async () => [queuedRow({ serve_count: MAX_SERVE_COUNT })],
      serveCount: async () => {
        throw new Error('a capped row must not be served again');
      },
    }));
    expect(nudges).toEqual([]); // frozen — a broken pipe is the OPERATOR's, via the alarms
  });

  test('the attempt cap freezes the serve too — a thrice-failed message is never re-sent', async () => {
    const { nudges } = await buildNudgeDelivery('host-1', baseDeps({
      listQueued: async () => [queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS })],
      serveCount: async () => {
        throw new Error('an attempts-capped row must not be served again');
      },
    }));
    expect(nudges).toEqual([]);
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

  test('failed below the cap → retry (bump only); at the cap → the BOX stops, the row stays queued', async () => {
    const bumps: number[] = [];
    const first = await completeNudgeDelivery('host-1', 'n1', 'failed', 'CLI timeout', baseDeps({
      attempts: async (_id, _t, n) => {
        bumps.push(n);
        return queuedRow({ attempts: n });
      },
    }));
    expect(first).toBe('retry');
    expect(bumps).toEqual([1]);

    // At the cap: 'failed' tells the BOX to stop retrying — but the row
    // freezes rather than going terminal, and NOTHING reaches a manager
    // (build 5: broken pipes are the operator's, via the alarms).
    const last = await completeNudgeDelivery('host-1', 'n1', 'failed', 'CLI timeout', baseDeps({
      getQueued: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
    }));
    expect(last).toBe('failed');
  });
});

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
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () =>
          trio().map((r) => ({
            ...r,
            technicians: { ...r.technicians!, state: 'offboarded' },
          })) as unknown as QueuedNudgeForHost[],
      }),
    );
    expect(nudges).toEqual([]); // frozen, not failed — a rebind may heal them
  });

  test('a group whose LEAD carries no question stays frozen', async () => {
    // The tamper-freeze is the only thing between a malformed row and an
    // infinite re-serve loop; grouping must not open a hole in it.
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () => [group('n1'), group('n2', { question: null }), group('n3')],
      }),
    );
    expect(nudges).toEqual([]);
  });

  test('serve-cap exhaustion FREEZES the whole group — nothing served, nothing failed (build 5)', async () => {
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () =>
          trio().map((r) => ({ ...r, serve_count: MAX_SERVE_COUNT })) as QueuedNudgeForHost[],
        serveCount: async () => {
          throw new Error('a capped group must not be served');
        },
      }),
    );
    expect(nudges).toEqual([]); // the alarm counters carry it from here
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

  test('terminal delivery failure freezes — the box stops, no member goes anywhere (build 5)', async () => {
    const result = await completeNudgeDelivery('host-1', LEAD, 'failed', 'boom', {
      ...baseDeps(),
      getQueued: async () => group(LEAD, { attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
      attempts: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS }),
      groupMembers: async () => {
        throw new Error('the failure path reads no group any more — nothing is handed over');
      },
    });
    expect(result).toBe('failed'); // tells the BOX to stop retrying, nothing more
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
    });
    expect(result).toBe('failed');
    expect(called).toBe(false); // build 5: the failure path reads no group at all
  });
});

describe('a group that lost its lead is FROZEN, never re-delivered', () => {
  // The planner's own `close` (or a moot-fact close) can end ONE queued row
  // and leave its siblings alone, so a group really can end up with no
  // self-identifying member. Promoting a sibling would change the delivery
  // item id — and the box dedupes on exactly that id — so the whole message
  // would be sent again, including the question that was just answered.
  const orphaned = () => [
    queuedRow({ id: 'n2', ask_group_id: 'n-gone', question: 'grouped text' }),
    queuedRow({ id: 'n3', ask_group_id: 'n-gone', question: 'grouped text' }),
  ];

  test('no item is served, and nothing is failed either', async () => {
    const serves: string[] = [];
    const { nudges } = await buildNudgeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () => orphaned(),
        serveCount: async (id, _t, n) => {
          serves.push(id);
          return queuedRow({ serve_count: n });
        },
      }),
    );
    expect(nudges).toEqual([]);
    expect(serves).toEqual([]); // no ledger touched — nothing was sent
    // build 5: no expiry exists any more — the alarm counters carry it, and
    // the planner may escalate the members deliberately.
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



});
