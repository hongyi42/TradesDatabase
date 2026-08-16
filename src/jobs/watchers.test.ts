import { describe, expect, test } from 'vitest';
import type { PlacedAssignment } from '../db/assignments.js';
import type { JobWithCustomer } from '../db/jobs.js';
import type { Nudge } from '../db/nudges.js';
import type { ReviewItem } from '../db/reviewItems.js';
import type { Tenant } from '../db/tenants.js';
import type { Technician } from '../db/technicians.js';
import {
  MAX_NEW_ITEMS_PER_TENANT_TICK,
  NUDGE_BUDGET_PER_PERSON_DAY,
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
    createNudge: async () => null,
    listNudged: async () => [],
    listNudges: async () => [],
    resolveNudge: async () => null,
    countAsks: async () => 0,
    ...over,
  };
}

// A fully reachable technician — the rung-1 precondition.
const boundTech = (over: Partial<Technician> = {}): Technician =>
  ({
    id: 'tech-1',
    ref: 'ben-shelton',
    display_name: 'Ben Shelton',
    state: 'active',
    telegram_user_id: '8991633730',
    sandbox_ref: 's5',
    host_id: 'host-1',
    tenant_id: 't1',
    ...over,
  }) as unknown as Technician;

function nudgeRow(over: Partial<Nudge>): Nudge {
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
    created_at: '2026-08-14T11:05:00.000Z',
    updated_at: '2026-08-14T11:05:00.000Z',
    ...over,
  } as unknown as Nudge;
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

// Stage 1 (plan 2026-08-15 feature B): the ladder. Rung 1 = ask the
// technician through their own agent; the manager item becomes the fallback
// (unreachable tech) and rung 2 (48h silence). Same pure-unit style.
describe('runWatchers — the ladder (NUDGES_MODE)', () => {
  test("default nudgeMode 'off': rung-1 creation never happens — a reachable tech still gets the manager fallback", async () => {
    const flagged: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => [visit({ technician_id: 'tech-1' })],
      listTeam: async () => [boundTech()],
      flagGap: async (input) => {
        flagged.push(input.assignmentId);
        return openItem({});
      },
      createNudge: async () => {
        throw new Error('nudgeMode off must not create nudges');
      },
    }));
    expect(flagged).toEqual(['a1']);
    expect(summary.tenantErrors).toBe(0); // the creation sentinel never fired
    expect(summary).toMatchObject({ nudgeMode: 'off', nudgesCreated: 0, nudgesWouldCreate: 0 });
  });

  test("rollback rescue (review F1): in-flight nudges keep resolving AND escalating at nudgeMode 'off'", async () => {
    // The ladder was live, three questions went out, then the operator unset
    // NUDGES_MODE. Silence must STILL escalate and replies must still close —
    // otherwise a nudged gap reaches neither surface, ever (its assignment is
    // never fresh again in any mode).
    const resolved: Array<[string, string]> = [];
    const flagged: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({
          id: 'n-rolled-silent',
          subject_ref: 'a-silent',
          status: 'asked',
          asked_at: '2026-08-14T11:00:00.000Z', // 49h — escalation-ripe
          context: {
            customerName: 'Henderson',
            jobTitle: 'Furnace tune-up',
            technicianRef: 'ben-shelton',
            technicianName: 'Ben Shelton',
            jobId: 'j-quiet', // no activity on THIS job — genuinely silent
            startsAtLocal: '2026-08-14T07:00:00.000Z',
            endsAtLocal: '2026-08-14T08:00:00.000Z',
          },
        }),
        nudgeRow({ id: 'n-rolled-filled', subject_ref: 'a-filled', status: 'queued' }),
      ],
      listCaptureTimes: async () => [{ job_id: 'j1', captured_at: '2026-08-14T07:30:00.000Z' }],
      flagGap: async (input) => {
        flagged.push(input.assignmentId);
        return openItem({ subject_ref: input.assignmentId });
      },
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    })); // nudgeMode defaults to 'off'
    expect(resolved).toEqual([
      ['n-rolled-filled', 'answered'],
      ['n-rolled-silent', 'escalated'],
    ]);
    expect(flagged).toEqual(['a-silent']);
    expect(summary.nudgesResolved).toBe(1);
    expect(summary.nudgesEscalated).toBe(1);
    expect(summary.itemsOpened).toBe(1);
  });

  test('budget is incremental within a tick: the second same-tech gap sees the first ask (review F4)', async () => {
    // Stateful stubs: countAsks reflects prior creations, the way the DB does
    // (pending rows hold their slot at creation). Baseline 1 ask in the
    // window → gap #1 fits (1 < 2), gap #2 defers (2 >= 2) — and is
    // re-noticed on a later tick once the window frees a slot.
    const created: string[] = [];
    const deps = baseDeps({
      listOverdue: async () => [
        visit({ id: 'a1', job_id: 'j1', technician_id: 'tech-1', ends_at: '2026-08-15T01:00:00.000Z' }),
        visit({ id: 'a2', job_id: 'j2', technician_id: 'tech-1', ends_at: '2026-08-15T02:00:00.000Z' }),
      ],
      listTeam: async () => [boundTech()],
      listNudged: async (_t, _k, ids) => ids.filter((id) => created.includes(id)),
      countAsks: async () => 1 + created.length,
      createNudge: async (input) => {
        created.push(input.subjectRef);
        return nudgeRow({ subject_ref: input.subjectRef });
      },
      flagGap: async () => {
        throw new Error('budget deferral must not fall back to the manager');
      },
    });
    const first = await runWatchers(NOW, 'live', deps, 'live');
    expect(created).toEqual(['a1']); // oldest first; a2 deferred
    expect(first.nudgesCreated).toBe(1);
    expect(first.tenantErrors).toBe(0);

    // Next tick, a slot freed (baseline drops to 0): a2 is still fresh and
    // gets its ask.
    const laterDeps = { ...deps, countAsks: async () => created.length - 1 };
    const second = await runWatchers(NOW, 'live', laterDeps, 'live');
    expect(created).toEqual(['a1', 'a2']);
    expect(second.nudgesCreated).toBe(1);
  });

  test('live: a reachable tech gets a NUDGE — no manager item, no push; context carries the whole story', async () => {
    const created: Array<Record<string, unknown>> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => [
        visit({
          technician_id: 'tech-1',
          starts_at: '2026-08-16T07:00:00.000Z',
          ends_at: '2026-08-16T08:00:00.000Z',
        }),
      ],
      listTeam: async () => [boundTech()],
      listJobs: async (_t, ids) =>
        ids.map((id) => ({
          id,
          tenant_id: 't1',
          title: 'Furnace tune-up',
          customers: { name: 'Henderson' },
        }) as unknown as JobWithCustomer),
      createNudge: async (input) => {
        created.push(input as unknown as Record<string, unknown>);
        return nudgeRow({ subject_ref: input.subjectRef });
      },
      flagGap: async () => {
        throw new Error('a nudged gap must not also flag the manager');
      },
      notify: async () => {
        throw new Error('rung 1 must not push the manager');
      },
    }), 'live');
    expect(summary.tenantErrors).toBe(0);
    expect(summary.nudgesCreated).toBe(1);
    expect(summary.itemsOpened).toBe(0);
    expect(summary.pushed).toBe(0);
    expect(created).toHaveLength(1);
    expect(created[0].technicianId).toBe('tech-1');
    expect(created[0].subjectRef).toBe('a1');
    expect(created[0].context).toMatchObject({
      customerName: 'Henderson',
      jobTitle: 'Furnace tune-up',
      technicianRef: 'ben-shelton',
      technicianName: 'Ben Shelton',
      jobId: 'j1',
      startsAtLocal: '2026-08-16T07:00:00.000Z',
      endsAtLocal: '2026-08-16T08:00:00.000Z',
      visitEndLabel: 'Sunday, Aug 16 at 8:00 AM',
    });
  });

  test('live: an UNREACHABLE tech falls back to the manager item (deployed behavior)', async () => {
    const flagged: string[] = [];
    for (const tech of [
      boundTech({ sandbox_ref: null }),
      boundTech({ telegram_user_id: null }),
      boundTech({ state: 'offboarded' }),
      boundTech({ host_id: null }),
    ]) {
      const summary = await runWatchers(NOW, 'live', baseDeps({
        listOverdue: async () => [visit({ technician_id: 'tech-1' })],
        listTeam: async () => [tech],
        flagGap: async (input) => {
          flagged.push(input.assignmentId);
          return openItem({});
        },
        createNudge: async () => {
          throw new Error('an unreachable tech must not be nudged');
        },
      }), 'live');
      expect(summary.tenantErrors).toBe(0);
      expect(summary.nudgesCreated).toBe(0);
    }
    expect(flagged).toEqual(['a1', 'a1', 'a1', 'a1']);
  });

  test('live: budget exhausted → the gap DEFERS (no nudge, no manager item); under budget → nudge', async () => {
    const outcomes: string[] = [];
    for (const asks of [NUDGE_BUDGET_PER_PERSON_DAY, NUDGE_BUDGET_PER_PERSON_DAY - 1]) {
      const summary = await runWatchers(NOW, 'live', baseDeps({
        listOverdue: async () => [visit({ technician_id: 'tech-1' })],
        listTeam: async () => [boundTech()],
        countAsks: async () => asks,
        createNudge: async () => {
          outcomes.push('nudged');
          return nudgeRow({});
        },
        flagGap: async () => {
          outcomes.push('flagged');
          return openItem({});
        },
      }), 'live');
      expect(summary.tenantErrors).toBe(0);
      expect(summary.itemsOpened).toBe(0);
    }
    expect(outcomes).toEqual(['nudged']); // at-budget deferred silently; under-budget asked
  });

  test('a nudged gap is not fresh: the second dedup store feeds the pre-filter in both modes', async () => {
    const summary = await runWatchers(NOW, 'shadow', baseDeps({
      listOverdue: async () => [visit({ id: 'a1' }), visit({ id: 'a2', job_id: 'j2' })],
      listNudged: async (_t, _k, ids) => ids.filter((id) => id === 'a1'),
    }));
    expect(summary.gapsFound).toBe(2);
    expect(summary.freshGaps).toBe(1); // a1 was nudged once, ever — never fresh again
  });

  test("nudge-shadow: counts what live would ask, still flags the manager (safe observability)", async () => {
    const flagged: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => [
        visit({ id: 'a1', technician_id: 'tech-1' }),
        visit({ id: 'a2', job_id: 'j2' }), // no tech — never countable
      ],
      listTeam: async () => [boundTech()],
      flagGap: async (input) => {
        flagged.push(input.assignmentId);
        return openItem({ subject_ref: input.assignmentId });
      },
      createNudge: async () => {
        throw new Error('nudge-shadow must not create nudges');
      },
      countAsks: async () => {
        throw new Error('nudge-shadow must not read budgets');
      },
    }), 'shadow');
    expect(summary.tenantErrors).toBe(0);
    expect(summary.nudgeMode).toBe('shadow');
    expect(summary.nudgesWouldCreate).toBe(1); // the reachable one
    expect(flagged).toEqual(['a1', 'a2']); // BOTH still reach the manager
    expect(summary.itemsOpened).toBe(2);
  });

  test('live ladder auto-resolve: arrived activity answers; a cancelled visit cancels; asked-and-recent waits', async () => {
    const resolved: Array<[string, string, string | null | undefined]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({ id: 'n-filled', subject_ref: 'a-filled', status: 'queued' }),
        nudgeRow({
          id: 'n-cancelled',
          subject_ref: 'a-cancelled',
          status: 'asked',
          asked_at: '2026-08-16T11:00:00.000Z',
          context: { jobId: 'j7', startsAtLocal: '2026-08-14T07:00:00.000Z' },
        }),
        nudgeRow({
          id: 'n-waiting',
          subject_ref: 'a-waiting',
          status: 'asked',
          asked_at: '2026-08-16T10:00:00.000Z', // 2h ago — nowhere near 48h
          context: { jobId: 'j6', startsAtLocal: '2026-08-14T07:00:00.000Z' },
        }),
      ],
      listCaptureTimes: async () => [{ job_id: 'j1', captured_at: '2026-08-14T07:30:00.000Z' }],
      listAssignments: async () => [
        visit({ id: 'a-cancelled', job_id: 'j7', status: 'cancelled' } as Partial<PlacedAssignment>),
        visit({ id: 'a-waiting', job_id: 'j6' }),
      ],
      resolveNudge: async (id, _t, status, resolution) => {
        resolved.push([id, status, resolution]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
      flagGap: async () => {
        throw new Error('nothing here is escalation-ripe');
      },
    }), 'live');
    expect(summary.tenantErrors).toBe(0);
    expect(resolved).toEqual([
      ['n-filled', 'answered', 'a field report arrived — the gap filled itself'],
      ['n-cancelled', 'cancelled', 'the visit was cancelled — nothing left to ask'],
    ]);
    expect(summary.nudgesResolved).toBe(2);
    expect(summary.nudgesEscalated).toBe(0);
  });

  test('rung 2: 48h of silence → ONE manager item with the escalation copy, nudge marked escalated, push fires', async () => {
    const flagged: Array<{ suggestion: string; escalatedFromNudge?: string; technicianRef: string | null }> = [];
    const resolved: Array<[string, string]> = [];
    const pushes: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({
          id: 'n-silent',
          subject_ref: 'a-silent',
          status: 'asked',
          asked_at: '2026-08-14T11:00:00.000Z', // 49h before NOW
          context: {
            customerName: 'Henderson',
            jobTitle: 'Furnace tune-up',
            technicianRef: 'ben-shelton',
            technicianName: 'Ben Shelton',
            jobId: 'j1',
            startsAtLocal: '2026-08-14T07:00:00.000Z',
            endsAtLocal: '2026-08-14T08:00:00.000Z',
          },
        }),
      ],
      flagGap: async (input) => {
        flagged.push({
          suggestion: input.suggestion,
          escalatedFromNudge: input.escalatedFromNudge,
          technicianRef: input.technicianRef,
        });
        return openItem({ subject_ref: input.assignmentId });
      },
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
      notify: async (_t, text) => {
        pushes.push(text);
      },
    }), 'live');
    expect(summary.tenantErrors).toBe(0);
    expect(flagged).toHaveLength(1);
    expect(flagged[0].suggestion).toContain(
      "Ben Shelton's assistant asked about the 'Furnace tune-up' visit (Henderson)",
    );
    expect(flagged[0].suggestion).toContain('Friday, Aug 14 at 11:00 AM'); // the ask's wall-clock moment
    expect(flagged[0].suggestion).toContain('just dismiss this');
    expect(flagged[0].suggestion).not.toContain('Spine');
    expect(flagged[0].escalatedFromNudge).toBe('n-silent');
    expect(flagged[0].technicianRef).toBe('ben-shelton');
    expect(resolved).toEqual([['n-silent', 'escalated']]);
    expect(summary.nudgesEscalated).toBe(1);
    expect(summary.itemsOpened).toBe(1);
    expect(pushes).toEqual([
      'Heads-up: a recent visit has nothing on record yet — it’s waiting in your pending reviews whenever you have a minute.',
    ]);
  });

  test('delivery deadline (Phase-4 review F1): never-asked rows past 24h hand to the manager with STAGE-0 copy', async () => {
    // A rollback-frozen pending row and a liveness-stuck queued row, both a
    // day old; a young queued row waits. The manager copy must be the plain
    // Stage-0 shape — NEVER "their assistant asked" (the ask never landed).
    const flagged: Array<{ assignmentId: string; suggestion: string; escalatedFromNudge?: string }> = [];
    const resolved: Array<[string, string, string | null | undefined]> = [];
    const quietCtx = (jobId: string) => ({
      customerName: 'Henderson',
      jobTitle: 'Furnace tune-up',
      technicianRef: 'ben-shelton',
      technicianName: 'Ben Shelton',
      jobId,
      startsAtLocal: '2026-08-14T07:00:00.000Z',
      endsAtLocal: '2026-08-14T08:00:00.000Z',
    });
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({
          id: 'n-frozen-pending',
          subject_ref: 'a-frozen',
          status: 'pending',
          created_at: '2026-08-15T11:00:00.000Z', // 25h before NOW
          context: quietCtx('j-quiet-1'),
        }),
        nudgeRow({
          id: 'n-stuck-queued',
          subject_ref: 'a-stuck',
          status: 'queued',
          created_at: '2026-08-15T11:00:00.000Z',
          context: quietCtx('j-quiet-2'),
        }),
        nudgeRow({
          id: 'n-young-queued',
          subject_ref: 'a-young',
          status: 'queued',
          created_at: '2026-08-15T14:00:00.000Z', // 22h — still inside the deadline
          context: quietCtx('j-quiet-3'),
        }),
      ],
      flagGap: async (input) => {
        flagged.push({
          assignmentId: input.assignmentId,
          suggestion: input.suggestion,
          escalatedFromNudge: input.escalatedFromNudge,
        });
        return openItem({ subject_ref: input.assignmentId });
      },
      resolveNudge: async (id, _t, status, resolution) => {
        resolved.push([id, status, resolution]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(summary.tenantErrors).toBe(0);
    expect(flagged.map((f) => f.assignmentId).sort()).toEqual(['a-frozen', 'a-stuck']);
    for (const f of flagged) {
      expect(f.suggestion).toContain('was scheduled to wrap up by');
      expect(f.suggestion).not.toContain('assistant asked'); // the ask never landed
      expect(f.escalatedFromNudge).toBeDefined();
    }
    expect(resolved).toEqual([
      ['n-frozen-pending', 'failed', 'never delivered — handed to the manager'],
      ['n-stuck-queued', 'failed', 'never delivered — handed to the manager'],
    ]);
    expect(summary.nudgesExpired).toBe(2);
    expect(summary.itemsOpened).toBe(2);
    expect(summary.pushed).toBe(1);
  });

  test('delivery deadline: arrived activity still wins over expiry; malformed context stays frozen', async () => {
    const resolved: Array<[string, string]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        // Old AND filled: activity answered it — expiry must not fire.
        nudgeRow({
          id: 'n-old-filled',
          subject_ref: 'a-old-filled',
          status: 'queued',
          created_at: '2026-08-15T09:00:00.000Z',
        }),
        // Old and malformed: unfit for handoff — stays frozen, no counter.
        nudgeRow({
          id: 'n-old-thin',
          subject_ref: 'a-old-thin',
          status: 'queued',
          created_at: '2026-08-15T09:00:00.000Z',
          context: { jobTitle: 'only this' },
        }),
      ],
      listCaptureTimes: async () => [{ job_id: 'j1', captured_at: '2026-08-14T07:30:00.000Z' }],
      flagGap: async () => {
        throw new Error('neither row may reach the manager here');
      },
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(summary.tenantErrors).toBe(0);
    expect(resolved).toEqual([['n-old-filled', 'answered']]);
    expect(summary.nudgesExpired).toBe(0);
  });

  test('rung 2 races: a null flag (assignment somehow already flagged) still marks the nudge escalated', async () => {
    const resolved: Array<[string, string]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({
          id: 'n-raced',
          subject_ref: 'a-raced',
          status: 'asked',
          asked_at: '2026-08-13T11:00:00.000Z',
        }),
      ],
      flagGap: async () => null,
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved).toEqual([['n-raced', 'escalated']]);
    expect(summary.nudgesEscalated).toBe(1);
    expect(summary.itemsOpened).toBe(0); // nothing NEW for the manager
    expect(summary.pushed).toBe(0);
  });
});
