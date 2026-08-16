import { describe, expect, test } from 'vitest';
import type { PlacedAssignment } from '../db/assignments.js';
import type { JobWithCustomer } from '../db/jobs.js';
import type { ReviewItem } from '../db/reviewItems.js';
import type { Tenant } from '../db/tenants.js';
import type { Technician } from '../db/technicians.js';
import {
  MAX_NEW_ITEMS_PER_TENANT_TICK,
  runWatchers,
  type WatcherDeps,
} from './watchers.js';

// Pure unit tests — every collaborator injected (lifecycle.test.ts pattern).
// hasPushToken is always injected too, so nothing here reads process.env.
//
// Semantics under test (final-review fixes included): "filled" = job activity
// at-or-after the visit's START (minute-floored), the per-tick cap meters
// FRESH gaps only (ever-flagged filtered out first), and auto-resolve closes
// items on arrived activity OR on the visit leaving 'confirmed'.

const NOW = '2026-08-16T12:00:00.000Z';

const tenant = (timezone: string): Tenant => ({ id: 't1', timezone }) as unknown as Tenant;

function visit(over: Partial<PlacedAssignment>): PlacedAssignment {
  return {
    id: 'a1',
    tenant_id: 't1',
    job_id: 'j1',
    technician_id: null,
    starts_at: '2026-08-16T07:00:00.000Z',
    ends_at: '2026-08-16T08:00:00.000Z',
    earliest_date: null,
    latest_date: null,
    status: 'confirmed',
    source_capture_id: null,
    promise_level: 'none',
    promised_day: null,
    locked: false,
    reason: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...over,
  } as unknown as PlacedAssignment;
}

function openItem(over: Partial<ReviewItem>): ReviewItem {
  return {
    id: 'ri1',
    tenant_id: 't1',
    kind: 'overdue_visit_gap',
    subject_ref: 'a1',
    suggestion: null,
    detail: {},
    status: 'open',
    resolution: null,
    resolved_at: null,
    created_at: '2026-08-15T00:00:00.000Z',
    ...over,
  } as unknown as ReviewItem;
}

function baseDeps(over: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    listTenants: async () => ['t1'],
    getTenant: async () => tenant('UTC'),
    listOverdue: async () => [],
    listCaptureTimes: async () => [],
    listVisitTimes: async () => [],
    listTeam: async () => [],
    listJobs: async () => [],
    listEverFlagged: async () => [],
    listAssignments: async () => [],
    flagGap: async () => null,
    findOpenGaps: async () => [],
    resolveGap: async () => null,
    notify: async () => {},
    hasPushToken: () => true,
    ...over,
  };
}

describe('runWatchers', () => {
  test('cutoffs: UTC tenant gets now−72h / now−3h, formatted naive-local', async () => {
    const windows: Array<[string, string]> = [];
    await runWatchers(NOW, 'shadow', baseDeps({
      listOverdue: async (_t, from, to) => {
        windows.push([from, to]);
        return [];
      },
    }));
    expect(windows).toEqual([['2026-08-13T12:00:00.000Z', '2026-08-16T09:00:00.000Z']]);
  });

  test('cutoffs: America/Los_Angeles tenant gets WALL-CLOCK bounds (UTC-straddle)', async () => {
    // 2026-08-16T02:00Z = Aug 15, 7pm PDT — the evening regime where UTC has
    // already flipped to "tomorrow".
    const windows: Array<[string, string]> = [];
    await runWatchers('2026-08-16T02:00:00.000Z', 'shadow', baseDeps({
      getTenant: async () => tenant('America/Los_Angeles'),
      listOverdue: async (_t, from, to) => {
        windows.push([from, to]);
        return [];
      },
    }));
    expect(windows).toEqual([['2026-08-12T19:00:00.000Z', '2026-08-15T16:00:00.000Z']]);
  });

  test('UTC-straddle activity: an evening PDT capture (next UTC day) suppresses; one before the visit START does not', async () => {
    // Visit runs 2-3pm PDT Aug 15 (naive-local). A capture at 2026-08-16T01:30Z
    // is 6:30pm PDT Aug 15 — after the start in wall-clock terms even though
    // its UTC date is the 16th. It must suppress.
    const deps = (capturedAt: string) =>
      baseDeps({
        getTenant: async () => tenant('America/Los_Angeles'),
        listOverdue: async () => [
          visit({ starts_at: '2026-08-15T14:00:00.000Z', ends_at: '2026-08-15T15:00:00.000Z' }),
        ],
        listCaptureTimes: async () => [{ job_id: 'j1', captured_at: capturedAt }],
      });
    const suppressed = await runWatchers('2026-08-16T02:00:00.000Z', 'shadow', deps('2026-08-16T01:30:00.000Z'));
    expect(suppressed.gapsFound).toBe(0);
    // 2026-08-15T20:00Z = 1pm PDT — BEFORE the 2pm start: booking-time noise,
    // not a field report.
    const detected = await runWatchers('2026-08-16T02:00:00.000Z', 'shadow', deps('2026-08-15T20:00:00.000Z'));
    expect(detected.gapsFound).toBe(1);
  });

  test('activity since the visit START suppresses (during OR after); before the start does not; visits-only counts too', async () => {
    const summary = await runWatchers(NOW, 'shadow', baseDeps({
      listOverdue: async () => [
        visit({ id: 'a1', job_id: 'j1' }), // capture after the end → suppressed
        visit({ id: 'a2', job_id: 'j2' }), // capture before the start → gap
        visit({ id: 'a3', job_id: 'j3' }), // visit row DURING the visit → suppressed
      ],
      listCaptureTimes: async () => [
        { job_id: 'j1', captured_at: '2026-08-16T08:30:00.000Z' },
        { job_id: 'j2', captured_at: '2026-08-16T06:30:00.000Z' },
      ],
      listVisitTimes: async () => [{ job_id: 'j3', created_at: '2026-08-16T07:30:00.000Z' }],
    }));
    expect(summary.gapsFound).toBe(1);
    expect(summary.freshGaps).toBe(1);
  });

  test('same-minute activity counts as filling (minute-floored >= compare)', async () => {
    // The naive-local conversion is minute-precision: a note filed at 07:00:45
    // for a visit starting 07:00:00 must suppress, not read as "before".
    const summary = await runWatchers(NOW, 'shadow', baseDeps({
      listOverdue: async () => [visit({})],
      listCaptureTimes: async () => [{ job_id: 'j1', captured_at: '2026-08-16T07:00:45.000Z' }],
    }));
    expect(summary.gapsFound).toBe(0);
  });

  test('shadow mode: counts gaps AND fresh gaps — no write dep, no open-items read, no push', async () => {
    let everFlaggedCalls = 0;
    const summary = await runWatchers(NOW, 'shadow', baseDeps({
      listOverdue: async () => [visit({ id: 'a1' }), visit({ id: 'a2', job_id: 'j2' })],
      listEverFlagged: async () => {
        everFlaggedCalls += 1;
        return ['a1']; // flagged in some earlier live period
      },
      findOpenGaps: async () => {
        throw new Error('shadow must not read open items');
      },
      flagGap: async () => {
        throw new Error('shadow must not write');
      },
      resolveGap: async () => {
        throw new Error('shadow must not resolve');
      },
      notify: async () => {
        throw new Error('shadow must not push');
      },
    }));
    expect(everFlaggedCalls).toBe(1); // the read that makes freshGaps a live predictor
    expect(summary).toMatchObject({
      mode: 'shadow',
      gapsFound: 2,
      freshGaps: 1,
      itemsOpened: 0,
      pushed: 0,
      tenantErrors: 0, // the throwing sentinels would have landed here
    });
  });

  test('live: the cap meters FRESH gaps — ever-flagged assignments never occupy the slots', async () => {
    // 7 gaps, the 3 oldest already flagged on earlier ticks (2 still open, 1
    // dismissed). Without the pre-filter they would fill the cap and starve
    // the fresh ones (final-review finding).
    const flagged: string[] = [];
    const seven = Array.from({ length: 7 }, (_, i) =>
      visit({ id: `a${i}`, job_id: `j${i}`, ends_at: `2026-08-15T0${i + 1}:00:00.000Z` }),
    );
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => seven,
      listEverFlagged: async (_t, _k, ids) => ids.filter((id) => ['a0', 'a1', 'a2'].includes(id)),
      flagGap: async (input) => {
        flagged.push(input.assignmentId);
        return openItem({ subject_ref: input.assignmentId });
      },
    }));
    expect(flagged).toEqual(['a3', 'a4', 'a5', 'a6']); // fresh only, oldest first, under the cap
    expect(summary.gapsFound).toBe(7);
    expect(summary.freshGaps).toBe(4);
    expect(summary.itemsOpened).toBe(4);
  });

  test('live: opens at most the cap, oldest end first; suggestion carries job/customer; tech ref maps; start+end land in detail input', async () => {
    const flagged: Array<{
      assignmentId: string;
      technicianRef: string | null;
      startsAtLocal: string;
      suggestion: string;
    }> = [];
    const seven = Array.from({ length: 7 }, (_, i) =>
      visit({
        id: `a${i}`,
        job_id: `j${i}`,
        technician_id: i === 0 ? 'tech-1' : null,
        starts_at: `2026-08-15T0${i}:00:00.000Z`,
        ends_at: `2026-08-15T0${i + 1}:00:00.000Z`,
      }),
    );
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => seven,
      listTeam: async () => [{ id: 'tech-1', ref: 'ben-shelton' } as unknown as Technician],
      listJobs: async (_t, ids) =>
        ids.map((id) => ({
          id,
          tenant_id: 't1',
          title: 'Furnace tune-up',
          customers: { name: 'Henderson' },
        }) as unknown as JobWithCustomer),
      flagGap: async (input) => {
        flagged.push({
          assignmentId: input.assignmentId,
          technicianRef: input.technicianRef,
          startsAtLocal: input.startsAtLocal,
          suggestion: input.suggestion,
        });
        return openItem({ subject_ref: input.assignmentId });
      },
    }));
    expect(flagged.map((f) => f.assignmentId)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4']); // cap, oldest first
    expect(summary.itemsOpened).toBe(MAX_NEW_ITEMS_PER_TENANT_TICK);
    expect(flagged[0].technicianRef).toBe('ben-shelton');
    expect(flagged[1].technicianRef).toBeNull();
    expect(flagged[0].startsAtLocal).toBe('2026-08-15T00:00:00.000Z');
    expect(flagged[0].suggestion).toContain("The visit for 'Furnace tune-up' (Henderson)");
    // a0's ends_at (2026-08-15T01:00 naive) as the warm wall-clock label —
    // weekday and date come from one Intl derivation, so they can't disagree.
    expect(flagged[0].suggestion).toContain('Saturday, Aug 15 at 1:00 AM');
    expect(flagged[0].suggestion).not.toContain('Spine'); // operator jargon stays internal
  });

  test('live: a null from flagGap (concurrent flag) is not counted opened; no push when nothing opened', async () => {
    const texts: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => [visit({ id: 'a1' }), visit({ id: 'a2', job_id: 'j2' })],
      flagGap: async (input) => (input.assignmentId === 'a1' ? openItem({ subject_ref: 'a1' }) : null),
      notify: async (_t, text) => {
        texts.push(text);
      },
    }));
    expect(summary.itemsOpened).toBe(1);
    expect(summary.gapsFound).toBe(2);
    expect(texts).toHaveLength(1); // pushed for the ONE tenant, once — not per item
    // One item → the singular phrasing, not "1 visits".
    expect(texts[0]).toBe(
      'Heads-up: a recent visit has nothing on record yet — it’s waiting in your pending reviews whenever you have a minute.',
    );

    const quiet = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => [visit({ id: 'a1' })],
      listEverFlagged: async (_t, _k, ids) => ids, // everything already flagged
      flagGap: async () => {
        throw new Error('ever-flagged gaps must not reach flagGap');
      },
      notify: async () => {
        throw new Error('no NEW items → no push');
      },
    }));
    expect(quiet.itemsOpened).toBe(0);
    expect(quiet.freshGaps).toBe(0);
    expect(quiet.pushed).toBe(0);
    // The throwing sentinels are swallowed by the per-tenant catch, so the
    // real assertion is that NO tenant errored — a call would have thrown.
    expect(quiet.tenantErrors).toBe(0);
  });

  test('live: push text is the count-only line, sent once per tenant', async () => {
    const pushes: Array<[string, string]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => [visit({ id: 'a1' }), visit({ id: 'a2', job_id: 'j2' })],
      flagGap: async (input) => openItem({ subject_ref: input.assignmentId }),
      notify: async (t, text) => {
        pushes.push([t, text]);
      },
    }));
    expect(pushes).toEqual([
      [
        't1',
        'Heads-up: 2 recent visits have nothing on record yet — they’re waiting in your pending reviews whenever you have a minute.',
      ],
    ]);
    expect(summary.pushed).toBe(1);
    expect(summary.pushSkipped).toBe(false);
  });

  test('live: no push token → pushSkipped, items still open, nothing throws', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => [visit({})],
      flagGap: async () => openItem({}),
      hasPushToken: () => false,
      notify: async () => {
        throw new Error('must not push without a token');
      },
    }));
    expect(summary.itemsOpened).toBe(1);
    expect(summary.pushSkipped).toBe(true);
    expect(summary.pushed).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });

  test('live auto-resolve: arrived activity resolves; a status change resolves; malformed detail is dropped fail-closed', async () => {
    const resolved: Array<[string, string | null | undefined]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async () => [
        openItem({ subject_ref: 'a-filled', detail: { jobId: 'j9', startsAtLocal: '2026-08-15T10:00:00.000Z' } }),
        openItem({ subject_ref: 'a-still-open', detail: { jobId: 'j8', startsAtLocal: '2026-08-15T10:00:00.000Z' } }),
        openItem({ subject_ref: 'a-cancelled', detail: { jobId: 'j7', startsAtLocal: '2026-08-15T10:00:00.000Z' } }),
        openItem({ subject_ref: 'a-malformed', detail: { jobId: 'j9' } }), // no startsAtLocal → dropped
      ],
      listCaptureTimes: async () => [{ job_id: 'j9', captured_at: '2026-08-15T11:00:00.000Z' }],
      listAssignments: async () => [
        visit({ id: 'a-cancelled', status: 'cancelled' } as Partial<PlacedAssignment>),
        visit({ id: 'a-still-open', job_id: 'j8' }),
      ],
      resolveGap: async (_t, _kind, subjectRef, _status, resolution) => {
        resolved.push([subjectRef, resolution]);
        return openItem({ subject_ref: subjectRef, status: 'resolved' } as Partial<ReviewItem>);
      },
    }));
    expect(resolved).toEqual([
      ['a-filled', 'field report arrived after this was flagged'],
      ['a-cancelled', 'visit was cancelled after this was flagged'],
    ]);
    expect(summary.itemsResolved).toBe(2);
  });

  test('one tenant throwing never blocks the siblings; tenantErrors counted', async () => {
    const seen: string[] = [];
    const summary = await runWatchers(NOW, 'shadow', baseDeps({
      listTenants: async () => ['bad', 'good'],
      getTenant: async (t) => {
        if (t === 'bad') throw new Error('db blip');
        return tenant('UTC');
      },
      listOverdue: async (t) => {
        seen.push(t);
        return [];
      },
    }));
    expect(seen).toEqual(['good']);
    expect(summary.tenants).toBe(2);
    expect(summary.tenantErrors).toBe(1);
  });
});
