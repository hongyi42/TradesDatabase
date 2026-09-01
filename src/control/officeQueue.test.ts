import { describe, expect, test, vi } from 'vitest';
import type { QueuedOfficeMessageForHost, Technician } from '../db/index.js';
import { TEAM_LEAD_REF } from '../teamLead/identity.js';
import { MAX_DELIVERY_ATTEMPTS, MAX_SERVE_COUNT } from './nudgeQueue.js';
import {
  buildOfficeDelivery,
  completeOfficeDelivery,
  wrapOfficeMessage,
  type OfficeQueueDeps,
} from './officeQueue.js';

// Pure unit tests — every DB accessor injected (the nudgeQueue.test.ts
// pattern). The wire shapes are pinned in httpServer.test.ts; this file pins
// the serve/report semantics and the two origin framings.

function queuedRow(over: Partial<QueuedOfficeMessageForHost> = {}): QueuedOfficeMessageForHost {
  return {
    id: 'm1',
    tenant_id: 't1',
    direction: 'to_agent',
    kind: 'ask',
    from_ref: TEAM_LEAD_REF,
    to_ref: 'ben-shelton',
    technician_id: 'tech-1',
    body: 'how did the marina visit go?',
    tier: null,
    nudge_id: 'n1',
    in_reply_to: null,
    status: 'queued',
    serve_count: 0,
    attempts: 0,
    created_at: '2026-08-16T10:00:00.000Z',
    updated_at: '2026-08-16T10:00:00.000Z',
    read_at: null,
    delivered_at: null,
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
  } as unknown as QueuedOfficeMessageForHost;
}

function baseDeps(over: Partial<OfficeQueueDeps> = {}): OfficeQueueDeps {
  return {
    listQueued: async () => [queuedRow()],
    getQueued: async () => queuedRow(),
    serveCount: async (_id, _t, n) => queuedRow({ serve_count: n }),
    attempts: async (_id, _t, n) => queuedRow({ attempts: n }),
    delivery: async () => queuedRow({ status: 'delivered' }),
    getTech: async () => null,
    ...over,
  };
}

const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');

describe('wrapOfficeMessage — the two origin framings', () => {
  test('an office ASK frames itself as the record system and teaches the reply path', () => {
    const wrapped = wrapOfficeMessage(queuedRow(), null);
    expect(wrapped).toContain('OFFICE QUESTION (from the office record system, not a person)');
    expect(wrapped).toContain('how did the marina visit go?');
    expect(wrapped).toContain('reply via inform_team_lead and mention this id: m1');
  });

  test('an office NOTE teaches verify-then-carry-on, never a reply obligation', () => {
    const wrapped = wrapOfficeMessage(queuedRow({ kind: 'inform' }), null);
    expect(wrapped).toContain('OFFICE NOTE');
    expect(wrapped).toContain('verify against the record with your tools');
    expect(wrapped).not.toContain('reply via inform_team_lead');
  });

  test("a seat-sender row is origin-honest: the SENDER's assistant, never the office", () => {
    const wrapped = wrapOfficeMessage(
      queuedRow({ from_ref: 'manager-sam', kind: 'inform', body: 'have Ben asked about the gap' }),
      'Sam Alvarez',
    );
    expect(wrapped).toContain("NOTE FROM Sam Alvarez's assistant");
    expect(wrapped).toContain('not a person speaking');
    expect(wrapped).toContain('ask them the normal way and record the answer as usual');
    expect(wrapped).not.toContain('OFFICE NOTE');
    // Degrades to the ref when the roster read gave nothing.
    expect(wrapOfficeMessage(queuedRow({ from_ref: 'manager-sam', kind: 'inform' }), null)).toContain(
      "NOTE FROM manager-sam's assistant",
    );
  });
});

describe('buildOfficeDelivery', () => {
  test('serves a queued row: serve counted BEFORE shipping, payload wrapped + base64', async () => {
    const serveCount = vi.fn(async (_id: string, _t: string, n: number) => queuedRow({ serve_count: n }));
    const { messages } = await buildOfficeDelivery('host-1', baseDeps({ serveCount }));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'm1', sandboxRef: 's5', kind: 'ask' });
    expect(serveCount).toHaveBeenCalledWith('m1', 't1', 1);
    expect(decode(messages[0].directMessageB64)).toContain('OFFICE QUESTION');
  });

  test('a seat-sender row serves identically, with the teammate framing', async () => {
    const row = queuedRow({ from_ref: 'manager-sam', kind: 'inform' });
    const getTech = vi.fn(async () => ({ display_name: 'Sam Alvarez' }) as unknown as Technician);
    const { messages } = await buildOfficeDelivery(
      'host-1',
      baseDeps({ listQueued: async () => [row], serveCount: async () => row, getTech }),
    );
    expect(messages).toHaveLength(1);
    expect(getTech).toHaveBeenCalledWith('t1', 'manager-sam');
    expect(decode(messages[0].directMessageB64)).toContain("NOTE FROM Sam Alvarez's assistant");
  });

  test('liveness is re-filtered at serve time: inactive or sandbox-less rows are SKIPPED', async () => {
    for (const tech of [
      null,
      { ...queuedRow().technicians!, state: 'offboarded' },
      { ...queuedRow().technicians!, sandbox_ref: null },
    ]) {
      const { messages } = await buildOfficeDelivery(
        'host-1',
        baseDeps({ listQueued: async () => [queuedRow({ technicians: tech } as never)] }),
      );
      expect(messages).toHaveLength(0);
    }
  });

  test('rows past the serve or attempt caps are FROZEN — never served, never failed', async () => {
    for (const over of [{ serve_count: MAX_SERVE_COUNT }, { attempts: MAX_DELIVERY_ATTEMPTS }]) {
      const serveCount = vi.fn(async () => queuedRow());
      const { messages } = await buildOfficeDelivery(
        'host-1',
        baseDeps({ listQueued: async () => [queuedRow(over)], serveCount }),
      );
      expect(messages).toHaveLength(0);
      expect(serveCount).not.toHaveBeenCalled();
    }
  });

  test('a row whose serve-count write loses its race is dropped this tick', async () => {
    const { messages } = await buildOfficeDelivery(
      'host-1',
      baseDeps({ serveCount: async () => null }),
    );
    expect(messages).toHaveLength(0);
  });

  test('one poisoned row never blocks the rest', async () => {
    const good = queuedRow({ id: 'm2' });
    const { messages } = await buildOfficeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () => [queuedRow(), good],
        serveCount: async (id: string) => {
          if (id === 'm1') throw new Error('boom');
          return good;
        },
      }),
    );
    expect(messages.map((m) => m.id)).toEqual(['m2']);
  });

  test('a failed sender-name read degrades to the ref, never blocks the serve', async () => {
    const row = queuedRow({ from_ref: 'manager-sam', kind: 'inform' });
    const { messages } = await buildOfficeDelivery(
      'host-1',
      baseDeps({
        listQueued: async () => [row],
        serveCount: async () => row,
        getTech: async () => {
          throw new Error('db hiccup');
        },
      }),
    );
    expect(messages).toHaveLength(1);
    expect(decode(messages[0].directMessageB64)).toContain("NOTE FROM manager-sam's assistant");
  });
});

describe('completeOfficeDelivery', () => {
  test('delivered moves the row queued→delivered, guarded', async () => {
    const delivery = vi.fn(async () => queuedRow({ status: 'delivered' }));
    const res = await completeOfficeDelivery('host-1', 'm1', 'delivered', null, baseDeps({ delivery }));
    expect(res).toBe('delivered');
    expect(delivery).toHaveBeenCalledWith(
      'm1',
      't1',
      expect.objectContaining({ status: 'delivered', deliveredAt: expect.any(String) }),
      ['queued'],
    );
  });

  test('an unknown id, wrong host, or already-moved row is ignored', async () => {
    expect(
      await completeOfficeDelivery('host-1', 'm1', 'delivered', null, baseDeps({ getQueued: async () => null })),
    ).toBe('ignored');
    expect(
      await completeOfficeDelivery('host-1', 'm1', 'delivered', null, baseDeps({ delivery: async () => null })),
    ).toBe('ignored');
  });

  test('failure bumps attempts; the cap FREEZES with no status flip', async () => {
    expect(await completeOfficeDelivery('host-1', 'm1', 'failed', 'agent turn failed', baseDeps())).toBe(
      'retry',
    );
    const delivery = vi.fn();
    const res = await completeOfficeDelivery(
      'host-1',
      'm1',
      'failed',
      'agent turn failed',
      baseDeps({
        getQueued: async () => queuedRow({ attempts: MAX_DELIVERY_ATTEMPTS - 1 }),
        delivery: delivery as unknown as OfficeQueueDeps['delivery'],
      }),
    );
    expect(res).toBe('failed'); // tells the BOX to stop; the row stays queued/frozen
    expect(delivery).not.toHaveBeenCalled();
  });
});
