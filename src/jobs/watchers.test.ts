import { describe, expect, test, vi } from 'vitest';
import type { PlacedAssignment } from '../db/assignments.js';
import type { JobWithCustomer } from '../db/jobs.js';
import type { Nudge } from '../db/nudges.js';
import type { ReviewItem } from '../db/reviewItems.js';
import type { Tenant } from '../db/tenants.js';
import type { Technician } from '../db/technicians.js';
import { resolveSettings, type TenantSettings } from '../db/tenantSettings.js';
import {
  MAX_NEW_ITEMS_PER_TENANT_TICK,
  NUDGE_DELIVERY_DEADLINE_HOURS,
  NUDGE_ESCALATE_HOURS,
  PLANNER_JUDGMENT_ACTIONS,
  runWatchers,
  wallClockLabel,
  type WatcherDeps,
} from './watchers.js';
import { PLANNER_ACTIONS } from '../teamLead/planner.js';
import {
  JOB_COST_GAP_SPEC,
  OVERDUE_VISIT_GAP_SPEC,
  stage0Suggestion,
  type NudgeKindSpec,
} from './nudgeKinds.js';

// Pure unit tests — every collaborator injected (lifecycle.test.ts pattern).
// hasPushToken is always injected too, so nothing here reads process.env.
//
// Semantics under test (final-review fixes included): "filled" = job activity
// at-or-after the visit's START (minute-floored), the per-tick cap meters
// FRESH gaps only (ever-flagged filtered out first), and auto-resolve closes
// items on arrived activity OR on the visit leaving 'confirmed'.
//
// SINCE 2026-08-22 (Phase 2): `filled` no longer closes an ASKED nudge — that
// judgment is the planner's. It still closes a never-asked one (the detector
// re-checking itself), and the sweep keeps a fail-safe at the escalation
// deadline for a planner that has gone silent. Item auto-resolve is unchanged.

const NOW = '2026-08-16T12:00:00.000Z';

// Times DERIVED from the tunable constants, never hardcoded hours. Both
// constants moved on 2026-08-20 (escalate 48->24, delivery deadline 24->18) and
// every test that had baked in "25h" or "22h" either broke or, worse, silently
// stopped testing the boundary it was named for.
const hoursBeforeNow = (h: number): string =>
  new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
/** Old enough that the delivery deadline has passed. */
const UNDELIVERED_PAST_DUE = hoursBeforeNow(NUDGE_DELIVERY_DEADLINE_HOURS + 1);
/** Young enough that the delivery deadline has NOT passed. */
const UNDELIVERED_YOUNG = hoursBeforeNow(NUDGE_DELIVERY_DEADLINE_HOURS - 1);

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
    flagNudge: async () => null,
    listCostCandidates: async () => [],
    listCostEvents: async () => [],
    findOpenGaps: async () => [],
    resolveGap: async () => null,
    notify: async () => {},
    hasPushToken: () => true,
    createNudge: async () => null,
    listNudged: async () => [],
    listNudges: async () => [],
    resolveNudge: async () => null,
    listDecisions: async () => new Map(),
    // The injection seam, NOT moved behaviour: this fixture's tenant id is the
    // literal 't1', so a real uuid-keyed settings read throws 22P02, the
    // per-tenant catch swallows it, and every `expect(tenantErrors).toBe(0)` in
    // this file fails. A firm that has recorded nothing resolves to exactly the
    // global constants — so every existing expectation below keeps its original
    // expected value.
    getSettings: async () => ({ settings: resolveSettings(null), tableMissing: false }),
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

describe('runWatchers — the firm\'s OWN detection thresholds (plan 2026-08-29)', () => {
  // A row shaped like tenant_settings, with only the named columns recorded.
  // readSettingsTolerantly's shape: the resolved values plus whether the table
  // was there at all.
  const read = (row: TenantSettings | null) => ({ settings: resolveSettings(row), tableMissing: false });
  const settingsRow = (over: Partial<TenantSettings>): TenantSettings =>
    ({
      tenant_id: 't1',
      approx_work_start_hour: null,
      approx_work_end_hour: null,
      overdue_hours: null,
      lookback_hours: null,
      max_new_per_tick: null,
      created_at: '2026-08-29T00:00:00.000Z',
      updated_at: '2026-08-29T00:00:00.000Z',
      ...over,
    }) as TenantSettings;

  // Ends 2h ago: INSIDE a 1h overdue window, OUTSIDE the default 3h one. The
  // stub filters by the window it is handed, exactly as the SQL does — without
  // that this test would pass no matter what the cutoffs were.
  const ENDS_TWO_HOURS_AGO = '2026-08-16T10:00:00.000Z';
  const windowFiltered = (t: string, from: string, to: string) =>
    [visit({ id: `a-${t}`, job_id: `j-${t}`, ends_at: ENDS_TWO_HOURS_AGO })].filter(
      // `.gte(from)` / `.lt(to)` — upper bound EXCLUSIVE, matching
      // listOverdueConfirmedAssignments. `<=` would agree on today's fixture and
      // silently disagree on one placed exactly on `to`.
      (v) => v.ends_at! >= from && v.ends_at! < to,
    );

  test('overdue_hours is per FIRM: the same visit is a gap for one tenant and not the other', async () => {
    const summary = await runWatchers(NOW, 'shadow', baseDeps({
      listTenants: async () => ['t-default', 't-eager'],
      listOverdue: async (t, from, to) => windowFiltered(t, from, to),
      // Only the second firm has recorded anything.
      getSettings: async (t) => read(t === 't-eager' ? settingsRow({ overdue_hours: 1 }) : null),
    }));
    expect(summary.tenantErrors).toBe(0);
    // ONE of the two. The default firm's cutoff (now−3h) has not reached this
    // visit yet; the eager firm's (now−1h) has.
    expect(summary.gapsFound).toBe(1);
  });

  test('…and with NEITHER firm recording anything, the same fixture yields zero', async () => {
    // The control. Without it the test above could pass on a bug that made every
    // tenant eager.
    const summary = await runWatchers(NOW, 'shadow', baseDeps({
      listTenants: async () => ['t-default', 't-other'],
      listOverdue: async (t, from, to) => windowFiltered(t, from, to),
    }));
    expect(summary.gapsFound).toBe(0);
  });

  test('lookback_hours is per FIRM too — both cutoffs move together', async () => {
    const windows: Record<string, [string, string]> = {};
    await runWatchers(NOW, 'shadow', baseDeps({
      listTenants: async () => ['t-default', 't-tight'],
      listOverdue: async (t, from, to) => {
        windows[t] = [from, to];
        return [];
      },
      getSettings: async (t) => read(t === 't-tight' ? settingsRow({ lookback_hours: 6, overdue_hours: 2 }) : null),
    }));
    // now−72h / now−3h — the global fallbacks, unchanged.
    expect(windows['t-default']).toEqual(['2026-08-13T12:00:00.000Z', '2026-08-16T09:00:00.000Z']);
    // now−6h / now−2h — the firm's own.
    expect(windows['t-tight']).toEqual(['2026-08-16T06:00:00.000Z', '2026-08-16T10:00:00.000Z']);
  });

  test('max_new_per_tick is per FIRM: a firm that wants 2 gets 2, not the global 5', async () => {
    const flagged: string[] = [];
    const seven = Array.from({ length: 7 }, (_, i) =>
      visit({
        id: `a${i}`,
        job_id: `j${i}`,
        starts_at: `2026-08-15T0${i}:00:00.000Z`,
        ends_at: `2026-08-15T0${i + 1}:00:00.000Z`,
      }),
    );
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => seven,
      listJobs: async (_t, ids) =>
        ids.map((id) => ({ id, tenant_id: 't1', title: 'Furnace tune-up', customers: { name: 'Henderson' } }) as unknown as JobWithCustomer),
      getSettings: async () => read(settingsRow({ max_new_per_tick: 2 })),
      flagGap: async (input) => {
        flagged.push(input.assignmentId);
        return openItem({ subject_ref: input.assignmentId });
      },
    }));
    expect(flagged).toEqual(['a0', 'a1']); // the firm's ceiling, oldest first
    expect(summary.itemsOpened).toBe(2);
    expect(MAX_NEW_ITEMS_PER_TENANT_TICK).toBe(5); // …and the global default is untouched
  });

  test('settings are read ONCE per tenant per tick — not once per gap', async () => {
    const reads: string[] = [];
    await runWatchers(NOW, 'shadow', baseDeps({
      listTenants: async () => ['t-a', 't-b'],
      // Three candidate gaps each, so a per-gap read would show six.
      listOverdue: async (t) => [
        visit({ id: `${t}-1`, job_id: `${t}-j1` }),
        visit({ id: `${t}-2`, job_id: `${t}-j2` }),
        visit({ id: `${t}-3`, job_id: `${t}-j3` }),
      ],
      getSettings: async (t) => {
        reads.push(t);
        return read(null);
      },
    }));
    expect(reads).toEqual(['t-a', 't-b']);
  });

  test('an ABSENT settings table does not take the sweep dark — it runs on the defaults and SAYS so', async () => {
    // The round-1 finding, locked shut. Before the fix this threw for every
    // tenant, so tenantErrors === tenants, which lifecycle.ts reads as systemic
    // and turns the heartbeat red — while detection, escalation, the delivery
    // fail-safe and the manager push were all dark for everyone.
    const summary = await runWatchers(NOW, 'shadow', baseDeps({
      listTenants: async () => ['t-a', 't-b'],
      listOverdue: async () => [visit({})],
      getSettings: async () => ({ settings: resolveSettings(null), tableMissing: true }),
    }));
    expect(summary.tenantErrors).toBe(0);
    // Detection still happened, on the global fallbacks, for BOTH firms.
    expect(summary.gapsFound).toBe(2);
    // …and the condition reaches the summary, not just a log line.
    expect(summary.settingsTableMissing).toBe(true);
  });

  test('a healthy tick does not carry the missing-table marker at all', async () => {
    // Present ONLY when true: an operator condition, never a routine field.
    const summary = await runWatchers(NOW, 'shadow', baseDeps({}));
    expect(summary.settingsTableMissing).toBeUndefined();
  });

  test('a settings read that fails for ANY OTHER reason is contained to its own firm', async () => {
    // The read sits inside the per-tenant try, beside the tenant read it is
    // paired with — so a firm whose row is unreadable must not take the sweep
    // down for everyone else. Only a MISSING RELATION is tolerated (above); a
    // permission error, a bad uuid or a dead connection still counts as a fault.
    const summary = await runWatchers(NOW, 'shadow', baseDeps({
      listTenants: async () => ['t-broken', 't-fine'],
      listOverdue: async () => [visit({})],
      getSettings: async (t) => {
        if (t === 't-broken') throw new Error('settings read failed');
        return read(null);
      },
    }));
    expect(summary.tenantErrors).toBe(1);
    expect(summary.gapsFound).toBe(1); // t-fine still swept
  });
});

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
    expect(flagged[0].suggestion).toContain("'Furnace tune-up' (Henderson) was due to wrap up");
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
      'Heads-up: a recent visit has an open question on it — it’s waiting in your pending reviews whenever you have a minute.',
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
        'Heads-up: 2 recent visits have open questions on them — they’re waiting in your pending reviews whenever you have a minute.',
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
// (unreachable tech) and rung 2 (silence past the escalation default). Same pure-unit style.
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

  test("rollback rescue (review F1): in-flight nudges keep their lifecycle at nudgeMode 'off'", async () => {
    // The ladder was live, three questions went out, then the operator unset
    // NUDGES_MODE. Silence must STILL escalate — otherwise a nudged gap reaches
    // neither surface, ever (its assignment is never fresh again in any mode).
    //
    // The QUEUED row is here as the CONTROL, and its meaning changed on
    // 2026-08-29: the pre-ask carve-out is deleted, so activity on its job no
    // longer closes it. It is young enough not to have hit the delivery
    // deadline either, so the sweep must leave it entirely alone — open, for the
    // planner. The asked-and-silent row escalates exactly as before.
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
        nudgeRow({
          id: 'n-rolled-filled',
          subject_ref: 'a-filled',
          status: 'queued',
          created_at: UNDELIVERED_YOUNG,
        }),
      ],
      listCaptureTimes: async () => [{ job_id: 'j1', captured_at: '2026-08-14T07:30:00.000Z' }],
      flagNudge: async (input) => {
        flagged.push(input.subjectRef);
        return openItem({ subject_ref: input.subjectRef });
      },
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    })); // nudgeMode defaults to 'off'
    expect(resolved).toEqual([['n-rolled-silent', 'escalated']]);
    expect(flagged).toEqual(['a-silent']);
    expect(summary.nudgesResolved).toBe(0); // the sweep closes nothing on activity now
    expect(summary.nudgesAutoClosed).toBe(0);
    expect(summary.nudgesEscalated).toBe(1);
    expect(summary.itemsOpened).toBe(1);
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
    }), 'shadow');
    expect(summary.tenantErrors).toBe(0);
    expect(summary.nudgeMode).toBe('shadow');
    expect(summary.nudgesWouldCreate).toBe(1); // the reachable one
    expect(flagged).toEqual(['a1', 'a2']); // BOTH still reach the manager
    expect(summary.itemsOpened).toBe(2);
  });

  test('live ladder sweep: a cancelled visit cancels; activity closes NOTHING, asked or not', async () => {
    // The 2026-08-22 division, completed on 2026-08-29. `moot` is a FACT — a
    // cancelled visit — and still closes. `filled` now closes NOTHING at all: it
    // used to close a never-asked row, and that carve-out existed only because
    // the ask window held an evening gap until 7am, so a report filed at 8pm
    // would be followed by asking that technician at 7am how the job went. With
    // no window the planner sees the note at 8:05pm and decides for itself.
    //
    // The queued row is young — past the delivery deadline it would reach the
    // manager as never-delivered, which is a different path and its own test.

    const resolved: Array<[string, string, string | null | undefined]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({
          id: 'n-filled',
          subject_ref: 'a-filled',
          status: 'queued',
          created_at: UNDELIVERED_YOUNG,
        }),
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
          asked_at: '2026-08-16T10:00:00.000Z', // 2h ago — nowhere near the default
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
    // n-filled is ABSENT, and that is the assertion: its job gained a note, and
    // the sweep left it open for the planner to read.
    expect(resolved).toEqual([
      ['n-cancelled', 'cancelled', 'the visit was cancelled — nothing left to ask'],
    ]);
    expect(summary.nudgesResolved).toBe(1);
    expect(summary.nudgesAutoClosed).toBe(0);
    expect(summary.nudgesEscalated).toBe(0);
  });

  test('rung 2: silence past the default → ONE manager item with the escalation copy, nudge marked escalated, push fires', async () => {
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
      flagNudge: async (input) => {
        flagged.push({
          suggestion: input.suggestion,
          escalatedFromNudge: input.escalatedFromNudge,
          technicianRef: input.technicianRef,
        });
        return openItem({ subject_ref: input.subjectRef });
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
      "'Furnace tune-up' (Henderson) — no note or status update since the visit. We asked Ben Shelton on",
    );
    expect(flagged[0].suggestion).toContain('Friday, Aug 14 at 11:00 AM'); // the ask's wall-clock moment
    expect(flagged[0].suggestion).toContain("I'll put it on the record");
    expect(flagged[0].suggestion).not.toContain('Spine');
    expect(flagged[0].escalatedFromNudge).toBe('n-silent');
    expect(flagged[0].technicianRef).toBe('ben-shelton');
    expect(resolved).toEqual([['n-silent', 'escalated']]);
    expect(summary.nudgesEscalated).toBe(1);
    expect(summary.itemsOpened).toBe(1);
    expect(pushes).toEqual([
      'Heads-up: a recent visit has an open question on it — it’s waiting in your pending reviews whenever you have a minute.',
    ]);
  });

  test('delivery deadline (Phase-4 review F1): never-asked rows past the deadline hand to the manager with STAGE-0 copy', async () => {
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
          created_at: UNDELIVERED_PAST_DUE,
          context: quietCtx('j-quiet-1'),
        }),
        nudgeRow({
          id: 'n-stuck-queued',
          subject_ref: 'a-stuck',
          status: 'queued',
          created_at: UNDELIVERED_PAST_DUE,
          context: quietCtx('j-quiet-2'),
        }),
        nudgeRow({
          id: 'n-young-queued',
          subject_ref: 'a-young',
          status: 'queued',
          created_at: UNDELIVERED_YOUNG,
          context: quietCtx('j-quiet-3'),
        }),
      ],
      flagNudge: async (input) => {
        flagged.push({
          assignmentId: input.subjectRef,
          suggestion: input.suggestion,
          escalatedFromNudge: input.escalatedFromNudge,
        });
        return openItem({ subject_ref: input.subjectRef });
      },
      resolveNudge: async (id, _t, status, resolution) => {
        resolved.push([id, status, resolution]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(summary.tenantErrors).toBe(0);
    expect(flagged.map((f) => f.assignmentId).sort()).toEqual(['a-frozen', 'a-stuck']);
    for (const f of flagged) {
      expect(f.suggestion).toContain('was due to wrap up');
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

  test('delivery deadline: an undelivered row expires even when its job HAS activity; malformed context stays frozen', async () => {
    // Reversed on 2026-08-29, deliberately. Activity used to win over expiry, via
    // the pre-ask carve-out. It no longer does, and the reasoning is the
    // deadline's own: 18h with no ask means the MACHINERY is broken — nobody is
    // ignoring us, the question never went out. The planner has had dozens of
    // ticks to act on this row — 36 at the full rate, ~21 for a firm with 8
    // recorded working hours, since this same phase made the rate variable — and
    // it is still queued. Handing it to the manager is what
    // the deadline is for, and the manager's item self-closes on the next sweep
    // if the activity really did answer it.
    const resolved: Array<[string, string]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        // Old AND filled: the activity is no longer a reason to hold the expiry.
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
        // The expiry path uses the kind-generic flagNudge, never this one.
        throw new Error('the expired handoff must not go through the visit flagger');
      },
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(summary.tenantErrors).toBe(0);
    expect(resolved).toEqual([['n-old-filled', 'failed']]);
    expect(summary.nudgesExpired).toBe(1);
    // The thin row is unfit for handoff and stays frozen — no counter either way.
    expect(resolved.map(([id]) => id)).not.toContain('n-old-thin');
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

// ── Deadlines as DATA (plan 2026-08-19, Phase 2) ────────────────────────────
// The escalation constant becomes a DEFAULT, and the planner may stamp a per-row
// escalate_after. The fail-safe is that the safe behaviour lives in the ABSENCE
// of a stamp: if the planner never runs, every row still escalates on the
// constant.
//
// Times below are derived FROM the constant, never hardcoded. It moved 48 -> 24
// on 2026-08-20 and a test pinned to "49h" silently stopped testing the boundary
// it was named for; a test that bakes in a tunable value stops guarding it the
// moment somebody tunes it.
describe('escalate_after: the deadline on the row', () => {
  // An ask that is `h` hours before NOW.
  const askedHoursAgo = (h: number): string =>
    new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
  const PAST_DUE = askedHoursAgo(NUDGE_ESCALATE_HOURS + 1);
  const NOT_YET = askedHoursAgo(NUDGE_ESCALATE_HOURS - 1);

  const askedNudge = (over: Partial<Nudge>) =>
    nudgeRow({
      id: 'n-timed',
      subject_ref: 'a-timed',
      status: 'asked',
      context: {
        customerName: 'Henderson',
        jobTitle: 'Furnace tune-up',
        technicianRef: 'ben-shelton',
        technicianName: 'Ben Shelton',
        jobId: 'j1',
        startsAtLocal: '2026-08-16T07:00:00.000Z',
        endsAtLocal: '2026-08-16T08:00:00.000Z',
      },
      ...over,
    });

  const runWith = async (n: Nudge) => {
    const resolved: Array<[string, string]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [n],
      flagNudge: async (input) => openItem({ subject_ref: input.subjectRef }),
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    return { resolved, summary };
  };

  test('a stamp in the past escalates EARLY — well before the default', async () => {
    // Asked 1h ago: nowhere near the constant, so only the stamp can do this.
    const { resolved, summary } = await runWith(
      askedNudge({
        asked_at: '2026-08-16T11:00:00.000Z',
        escalate_after: '2026-08-16T11:30:00.000Z',
      } as Partial<Nudge>),
    );
    expect(resolved).toEqual([['n-timed', 'escalated']]);
    expect(summary.nudgesEscalated).toBe(1);
  });

  test('a stamp in the future HOLDS — even once the default has passed', async () => {
    // Past due on the constant, so only the stamp can be holding it back.
    const { resolved, summary } = await runWith(
      askedNudge({
        asked_at: PAST_DUE,
        escalate_after: '2026-08-17T00:00:00.000Z',
      } as Partial<Nudge>),
    );
    expect(resolved).toEqual([]);
    expect(summary.nudgesEscalated).toBe(0);
  });

  test('NO stamp falls back to the constant — the planner never running is safe', async () => {
    const late = await runWith(askedNudge({ asked_at: PAST_DUE }));
    expect(late.resolved).toEqual([['n-timed', 'escalated']]);
    const early = await runWith(askedNudge({ asked_at: NOT_YET }));
    expect(early.resolved).toEqual([]);
  });

  test('a MALFORMED stamp falls back to the constant rather than escalating now or never', async () => {
    const late = await runWith(
      askedNudge({
        asked_at: PAST_DUE, // past the constant → it says escalate
        escalate_after: 'not-a-timestamp',
      } as Partial<Nudge>),
    );
    expect(late.resolved).toEqual([['n-timed', 'escalated']]);
    const early = await runWith(
      askedNudge({
        asked_at: '2026-08-16T11:00:00.000Z', // 1h → the constant says wait
        escalate_after: 'not-a-timestamp',
      } as Partial<Nudge>),
    );
    expect(early.resolved).toEqual([]);
  });

  test('a stamp on a NEVER-ASKED row does not escalate — there is no silence to measure', async () => {
    const { resolved, summary } = await runWith(
      askedNudge({
        status: 'pending',
        asked_at: null,
        escalate_after: '2026-08-16T00:00:00.000Z', // long past
      } as Partial<Nudge>),
    );
    // The delivery deadline owns this row, and it was created 2026-08-14 —
    // so it EXPIRES to the manager instead. Never 'escalated': the escalation
    // path measures silence AFTER an ask, and no ask ever landed here.
    expect(resolved.map(([, status]) => status)).not.toContain('escalated');
    expect(summary.nudgesEscalated).toBe(0);
    expect(summary.nudgesExpired).toBe(1);
  });
});

// ── The manager queue drains for every kind (plan 2026-08-19, Phase 2) ──────
// Before this, the open-item sweep named ONE kind as a literal, so a cost item
// could only ever leave the queue by a human dismissing it.
describe('review-item auto-resolve is kind-generic', () => {
  const costItem = (over: Partial<ReviewItem> = {}) =>
    openItem({
      id: 'ri-cost',
      kind: 'job_cost_gap',
      subject_ref: 'j-cost', // the JOB id — this kind's subject is not a visit
      detail: { jobId: 'j-cost', technicianRef: 'ben-shelton' },
      ...over,
    });

  test('a cost item closes once the job gains a cost — the thing it asked for', async () => {
    const resolved: Array<[string, string, string | null]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async (_t, kind) => (kind === 'job_cost_gap' ? [costItem()] : []),
      // The manager recorded it.
      listCostEvents: async (_t, jobIds) => jobIds.filter((j) => j === 'j-cost'),
      resolveGap: async (_t, kind, subjectRef, _status, note) => {
        resolved.push([kind, subjectRef, note ?? null]);
        return costItem();
      },
    }), 'live');
    expect(resolved).toEqual([
      ['job_cost_gap', 'j-cost', 'a cost was recorded for this job after it was flagged'],
    ]);
    expect(summary.itemsResolved).toBe(1);
  });

  test('a cost item with no cost recorded STAYS OPEN — activity alone is not the answer', async () => {
    const resolved: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async (_t, kind) => (kind === 'job_cost_gap' ? [costItem()] : []),
      listCostEvents: async () => [],
      // A field note landed on the job — that closes a VISIT gap, not a cost one:
      // the item asks a MANAGER to record a number, and prose is not a number.
      listCaptureTimes: async () => [{ job_id: 'j-cost', captured_at: '2026-08-16T11:00:00.000Z' }],
      resolveGap: async (_t, kind) => {
        resolved.push(kind);
        return costItem();
      },
    }), 'live');
    expect(resolved).toEqual([]);
    expect(summary.itemsResolved).toBe(0);
  });

  test('a cost item closes when its job is cancelled — nothing left to record', async () => {
    const notes: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async (_t, kind) => (kind === 'job_cost_gap' ? [costItem()] : []),
      listCostEvents: async () => [],
      listJobs: async () =>
        [{ id: 'j-cost', tenant_id: 't1', status: 'cancelled' }] as unknown as JobWithCustomer[],
      resolveGap: async (_t, _k, _s, _status, note) => {
        notes.push(note ?? '');
        return costItem();
      },
    }), 'live');
    expect(notes).toEqual(['the job was cancelled after this was flagged']);
  });

  test("a job-scoped NUDGE's subject never reaches the ASSIGNMENTS lookup either", async () => {
    // The item half is pinned below; this is the nudge half of the same guard.
    // Wasted payload today (a job id matches no assignment), but a future
    // job-scoped spec that read visitStatusById would get a silent `undefined`.
    const asked: string[][] = [];
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({
          id: 'n-cost',
          kind: 'job_cost_gap',
          subject_ref: 'j-cost',
          status: 'asked',
          asked_at: '2026-08-16T11:00:00.000Z',
          context: { jobId: 'j-cost', jobTitle: 'Furnace tune-up', customerName: 'Henderson' },
        }),
      ],
      listAssignments: async (_t, ids) => {
        asked.push(ids);
        return [];
      },
    }), 'live');
    expect(asked.flat()).not.toContain('j-cost');
  });

  test("a job-scoped item's subject never reaches the ASSIGNMENTS lookup", async () => {
    // subject_ref is a job id for this kind. Sending it to listAssignments would
    // be a wasted `in()` element and a claim the id means something it does not.
    const asked: string[][] = [];
    await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async (_t, kind) => (kind === 'job_cost_gap' ? [costItem()] : []),
      listCostEvents: async () => [],
      listAssignments: async (_t, ids) => {
        asked.push(ids);
        return [];
      },
    }), 'live');
    expect(asked.flat()).not.toContain('j-cost');
  });

  // THE ONE INTENDED BEHAVIOUR CHANGE in a phase that otherwise promises none.
  // The old parse required a parseable startsAtLocal and DROPPED items without
  // one, so such an item could never auto-resolve by any path — it sat open until
  // a human dismissed it. jobId alone is required now, so it closes on the status
  // path, using the wording that already existed. Strictly better, and the class
  // is empty for rows written by current code (the visit flagger always passes
  // startsAtLocal), so only legacy or tampered rows are affected.
  test('a visit item with NO startsAtLocal can now close on the status path', async () => {
    const notes: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async (_t, kind) =>
        kind === 'overdue_visit_gap' ? [openItem({ detail: { jobId: 'j1' } })] : [],
      listAssignments: async () => [visit({ id: 'a1', status: 'cancelled' })],
      resolveGap: async (_t, _k, _s, _status, note) => {
        notes.push(note ?? '');
        return openItem({});
      },
    }), 'live');
    expect(notes).toEqual(['visit was cancelled after this was flagged']);
  });

  test('an item with no jobId at all is still DROPPED — that parse stays fail-closed', async () => {
    const notes: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async (_t, kind) =>
        kind === 'overdue_visit_gap' ? [openItem({ detail: { startsAtLocal: '2026-08-16T07:00:00.000Z' } })] : [],
      listAssignments: async () => [visit({ id: 'a1', status: 'cancelled' })],
      resolveGap: async (_t, _k, _s, _status, note) => {
        notes.push(note ?? '');
        return openItem({});
      },
    }), 'live');
    expect(notes).toEqual([]);
  });

  test('the visit item paths are UNCHANGED — same two closures, same wording', async () => {
    const notes: Array<[string, string]> = [];
    const resolveGap = async (
      _t: string,
      kind: string,
      _s: string,
      _status: string,
      note?: string | null,
    ) => {
      notes.push([kind, note ?? '']);
      return openItem({});
    };
    // (1) activity arrived after the flag
    await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async (_t, kind) =>
        kind === 'overdue_visit_gap'
          ? [openItem({ detail: { jobId: 'j1', startsAtLocal: '2026-08-16T07:00:00.000Z' } })]
          : [],
      listCaptureTimes: async () => [{ job_id: 'j1', captured_at: '2026-08-16T09:00:00.000Z' }],
      resolveGap,
    }), 'live');
    // (2) the visit left 'confirmed'
    await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async (_t, kind) =>
        kind === 'overdue_visit_gap'
          ? [openItem({ detail: { jobId: 'j1', startsAtLocal: '2026-08-16T07:00:00.000Z' } })]
          : [],
      listAssignments: async () => [visit({ id: 'a1', status: 'cancelled' })],
      resolveGap,
    }), 'live');
    expect(notes).toEqual([
      ['overdue_visit_gap', 'field report arrived after this was flagged'],
      ['overdue_visit_gap', 'visit was cancelled after this was flagged'],
    ]);
  });
});

describe('the kind registry (plan 2026-08-19 Phase 1)', () => {
  // A second detector does not exist in production yet, so the brake and the
  // stranded-kind behaviour are exercised through the injectable specs seam.
  const secondSpec = (over: Partial<NudgeKindSpec> = {}): NudgeKindSpec => ({
    kind: 'call_action' as NudgeKindSpec['kind'], // any registered ReviewKind
    subjectIsVisit: false,
    maxNewPerTenantTick: 2,
    filled: () => null,
    moot: () => null,
    itemResolved: () => null,
    handoff: () => null,
    ...over,
  });

  test('an UNREGISTERED kind is never swept, never escalated, never expired — and says so', async () => {
    // The silent-stranding failure this registry exists to make observable: an
    // unregistered kind used to be filtered out by a literal, with nothing
    // logged, and the row sat open forever.
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    try {
      const summary = await runWatchers(NOW, 'live', baseDeps({
        listNudges: async () => [
          nudgeRow({
            id: 'n-alien',
            kind: 'unlinked_call', // real ReviewKind, no spec registered
            status: 'asked',
            asked_at: '2026-08-13T00:00:00.000Z', // 49h+ stale → would escalate if swept
          }),
        ],
        resolveNudge: async () => {
          throw new Error('an unregistered kind must never be resolved');
        },
        flagGap: async () => {
          throw new Error('an unregistered kind must never reach the manager');
        },
      }), 'live');
      expect(summary.tenantErrors).toBe(0);
      expect(summary.nudgesResolved).toBe(0);
      expect(summary.nudgesEscalated).toBe(0);
      expect(summary.nudgesExpired).toBe(0);
      expect(errors.some((e) => e.includes('UNREGISTERED') && e.includes('unlinked_call'))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test('the per-kind brake caps creation below the tenant ceiling', async () => {
    // Three fresh gaps, a kind brake of 1 → only one is routed, even though the
    // tenant-wide ceiling (5) would have allowed all three. (Cross-KIND
    // independence cannot be exercised until a second kind routes — Phase 4.)
    const created: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      specs: [{ ...OVERDUE_VISIT_GAP_SPEC, maxNewPerTenantTick: 1 }, secondSpec()],
      listOverdue: async () => [
        visit({ id: 'a1', job_id: 'j1', technician_id: 'tech-1', ends_at: '2026-08-15T01:00:00.000Z' }),
        visit({ id: 'a2', job_id: 'j2', technician_id: 'tech-1', ends_at: '2026-08-15T02:00:00.000Z' }),
        visit({ id: 'a3', job_id: 'j3', technician_id: 'tech-1', ends_at: '2026-08-15T03:00:00.000Z' }),
      ],
      listTeam: async () => [boundTech()],
      createNudge: async (input) => {
        created.push(input.subjectRef);
        return nudgeRow({ subject_ref: input.subjectRef });
      },
    }), 'live');
    expect(created).toEqual(['a1']); // oldest first, brake at 1
    expect(summary.nudgesCreated).toBe(1);
    expect(summary.tenantErrors).toBe(0);
  });


  test('creation is REGISTRY-GATED: an unregistered kind is never minted', async () => {
    // Stranding is possible from BOTH ends. Filtering only the sweep would let
    // the watcher keep MINTING a kind the sweep then refuses to touch — open
    // forever, unresolvable, unescalatable. Nothing may be created for a kind
    // that has no spec.
    const summary = await runWatchers(NOW, 'live', baseDeps({
      specs: [], // no spec for overdue_visit_gap
      listOverdue: async () => [visit({ id: 'a1', technician_id: 'tech-1' })],
      listTeam: async () => [boundTech()],
      createNudge: async () => {
        throw new Error('must not create a nudge for an unregistered kind');
      },
      flagGap: async () => {
        throw new Error('an unregistered kind must not route at all');
      },
    }), 'live');
    expect(summary.tenantErrors).toBe(0);
    expect(summary.nudgesCreated).toBe(0);
    expect(summary.itemsOpened).toBe(0);
  });

  test('the tenant-wide ceiling still caps the tick even when a kind brake is higher', async () => {
    // A detector may never raise a firm's per-tick volume above the surge brake.
    const routed: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      specs: [{ ...OVERDUE_VISIT_GAP_SPEC, maxNewPerTenantTick: 99 }],
      listOverdue: async () => Array.from({ length: 9 }, (_, i) =>
        visit({ id: `a${i}`, job_id: `j${i}`, ends_at: `2026-08-15T0${i}:00:00.000Z` })),
      flagGap: async (input) => {
        routed.push(input.assignmentId);
        return openItem({ subject_ref: input.assignmentId });
      },
    }), 'live');
    expect(routed.length).toBe(MAX_NEW_ITEMS_PER_TENANT_TICK);
    expect(summary.itemsOpened).toBe(MAX_NEW_ITEMS_PER_TENANT_TICK);
  });

  test('escalation copy is byte-identical to the wording we chose', async () => {
    // A human reads this; lock the exact text. Re-pinned by plan ②
    // (2026-08-21): "hasn't heard back" is gone for good (no reply-side datum
    // exists anywhere to back it) and the record claim now states exactly the
    // predicate the sweep ran. Update this string deliberately, never loosen
    // the assertion.
    let suggestion = '';
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({ status: 'asked', asked_at: '2026-08-13T00:00:00.000Z' }),
      ],
      listAssignments: async () => [],
      flagNudge: async (input) => {
        suggestion = input.suggestion;
        return openItem({});
      },
    }), 'live');
    expect(suggestion).toBe(
      "'Furnace tune-up' (Henderson) — no note or status update since the visit. We asked " +
        "Ben Shelton on Thursday, Aug 13 at 12:00 AM. Tell me how it went and I'll put it " +
        'on the record.',
    );
  });
});

describe('detector #2 — job cost gaps (plan 2026-08-19 Phase 4)', () => {
  const candidate = (over: Record<string, unknown> = {}) => ({
    jobId: 'j-cost',
    jobTitle: 'Boiler swap',
    customerName: 'Henderson',
    technicianId: 'tech-1',
    endsAtLocal: '2026-08-15T11:00:00.000Z',
    ...over,
  });
  const costNudge = (over: Partial<Nudge> = {}): Nudge =>
    nudgeRow({
      id: 'n-cost',
      kind: 'job_cost_gap',
      subject_ref: 'j-cost',
      context: {
        customerName: 'Henderson',
        jobTitle: 'Boiler swap',
        technicianRef: 'ben-shelton',
        technicianName: 'Ben Shelton',
        jobId: 'j-cost',
        endsAtLocal: '2026-08-15T11:00:00.000Z',
      },
      ...over,
    });

  test('a finished job with no cost recorded becomes a cost NUDGE, subject = the JOB', async () => {
    const created: Array<Record<string, unknown>> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [candidate()],
      listTeam: async () => [boundTech()],
      createNudge: async (input) => {
        created.push({ ...input });
        return costNudge({});
      },
    }), 'live');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: 'job_cost_gap', subjectRef: 'j-cost', technicianId: 'tech-1' });
    // Context carries everything compose and the handoff will ever need — and
    // NO visit window, because the subject is a job.
    expect(created[0].context).toMatchObject({ jobId: 'j-cost', jobTitle: 'Boiler swap', customerName: 'Henderson' });
    expect(summary.byKind['job_cost_gap']).toEqual({ gapsFound: 1, nudgesCreated: 1 });
    expect(summary.tenantErrors).toBe(0);
  });

  test('a job that ALREADY has a cost recorded is not a gap', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [candidate()],
      listCostEvents: async () => ['j-cost'], // material_cost already exists
      listTeam: async () => [boundTech()],
      createNudge: async () => {
        throw new Error('a job with a cost recorded must not be asked about');
      },
    }), 'live');
    expect(summary.byKind['job_cost_gap']?.gapsFound ?? 0).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });

  test('ONCE-EVER is real: a job already nudged for cost is never asked again', async () => {
    // The accepted limitation (user decision 2026-08-19): subject_ref is the
    // job and uq_nudges_subject_ever asks once per subject FOREVER, so a second
    // material purchase on a multi-day job is never chased. Asserted so it
    // reads as a DECISION, not an oversight.
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [candidate()],
      listNudged: async (_t, kind, ids) => (kind === 'job_cost_gap' ? ids : []),
      listTeam: async () => [boundTech()],
      createNudge: async () => {
        throw new Error('once-ever: this job was already asked about');
      },
    }), 'live');
    expect(summary.byKind['job_cost_gap']?.gapsFound ?? 0).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });

  test('an answer to an ASKED gap no longer closes it — the planner judges', async () => {
    // The 2026-08-22 ruling, at the point it bites hardest. A note landed after
    // the ask, so `filled` is TRUE — and the sweep closes nothing, because "did
    // this note answer the cost question?" is a judgment. The gap stays open so
    // the planner can read the words.
    //
    // Asked 2h ago, deliberately: the deadline is 24h out, so the fail-safe
    // below is not in play and this test measures ONLY the removal of the close.
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [costNudge({ status: 'asked', asked_at: '2026-08-16T10:00:00.000Z' })],
      // A note landed AFTER the ask.
      listCaptureTimes: async () => [{ job_id: 'j-cost', captured_at: '2026-08-16T11:00:00.000Z' }],
      listJobs: async () => [{ id: 'j-cost', tenant_id: 't1', status: 'completed' } as never],
      resolveNudge: async () => {
        throw new Error('an asked gap must not be closed by the sweep');
      },
    }), 'live');
    expect(summary.nudgesResolved).toBe(0);
    expect(summary.nudgesAutoClosed).toBe(0);
    expect(summary.nudgesEscalated).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });

  test('the predicate itself is UNCHANGED — only its authority moved', async () => {
    // `filled` still answers "is this gap answerable from the record?" exactly as
    // it did; the fail-safe and the planner's gap view both read it. If this ever
    // goes false the fail-safe silently stops working, so pin the predicate
    // directly rather than inferring it from a close that no longer happens.
    const asked = '2026-08-16T10:00:00.000Z';
    const facts = {
      hasActivitySince: (jobId: string, since: string) =>
        jobId === 'j-cost' && Date.parse('2026-08-16T11:00:00.000Z') >= Date.parse(since),
      visitStatusById: new Map<string, string>(),
      jobStatusById: new Map<string, string>(),
      naiveLocal: (iso: string) => iso,
      jobsWithCostEvents: new Set<string>(),
    };
    expect(JOB_COST_GAP_SPEC.filled(costNudge({ status: 'asked', asked_at: asked }), facts))
      .toBe('the technician answered — a note landed on the job');
    // …and it is still bounded by the ASK, not the visit.
    expect(JOB_COST_GAP_SPEC.filled(costNudge({ status: 'asked', asked_at: '2026-08-16T11:30:00.000Z' }), facts))
      .toBeNull();
  });

  test('activity BEFORE the ask does NOT close it (the trap this bound exists for)', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [costNudge({ status: 'asked', asked_at: '2026-08-15T12:00:00.000Z' })],
      // The note that completed the job, an hour BEFORE we asked about cost.
      listCaptureTimes: async () => [{ job_id: 'j-cost', captured_at: '2026-08-15T11:00:00.000Z' }],
      listJobs: async () => [{ id: 'j-cost', tenant_id: 't1', status: 'completed' } as never],
      resolveNudge: async () => {
        throw new Error('pre-ask activity must not count as an answer');
      },
    }), 'live');
    expect(summary.nudgesResolved).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });

  test('a cancelled JOB makes the cost question moot', async () => {
    const resolved: Array<[string, string]> = [];
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [costNudge({ status: 'asked', asked_at: NOW })],
      listJobs: async () => [{ id: 'j-cost', tenant_id: 't1', status: 'cancelled' } as never],
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return costNudge({});
      },
    }), 'live');
    expect(resolved).toEqual([['n-cost', 'cancelled']]);
  });

  test('silence past the default escalates a cost gap to the manager, with COST copy and no visit window', async () => {
    const flagged: Array<Record<string, unknown>> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [costNudge({ status: 'asked', asked_at: '2026-08-13T00:00:00.000Z' })],
      listJobs: async () => [{ id: 'j-cost', tenant_id: 't1', status: 'completed' } as never],
      flagNudge: async (input) => {
        flagged.push({ ...input });
        return openItem({ subject_ref: input.subjectRef });
      },
      resolveNudge: async () => costNudge({ status: 'escalated' }),
    }), 'live');
    expect(summary.nudgesEscalated).toBe(1);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toMatchObject({
      kind: 'job_cost_gap',
      subjectRef: 'j-cost',
      jobId: 'j-cost',
      startsAtLocal: null, // job-scoped: NO visit window
      endsAtLocal: null,
      escalatedFromNudge: 'n-cost',
    });
    expect(String(flagged[0].suggestion)).toContain('cost in parts');
    expect(String(flagged[0].suggestion)).not.toContain('visit');
  });

  test('a cost gap ALREADY on the manager queue is not re-raised as a nudge', async () => {
    // The ever-flagged store is the third filter. Without it a gap the manager
    // is already looking at would be asked about again as if it were new.
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [candidate()],
      listEverFlagged: async (_t, kind, ids) => (kind === 'job_cost_gap' ? ids : []),
      listTeam: async () => [boundTech()],
      createNudge: async () => {
        throw new Error('a flagged cost gap must not also become a nudge');
      },
    }), 'live');
    expect(summary.byKind['job_cost_gap']?.gapsFound ?? 0).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });

  test('the per-kind cost brake BINDS — the runaway backstop is real', async () => {
    // The backstop that justifies removing the per-person cap. It must actually
    // stop a misfiring detector, so make it bind with nothing else in the tick.
    const created: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () =>
        Array.from({ length: 9 }, (_, i) => candidate({ jobId: `j-cost-${i}` })),
      listTeam: async () => [boundTech()],
      createNudge: async (input) => {
        created.push(input.subjectRef);
        return costNudge({ subject_ref: input.subjectRef });
      },
    }), 'live');
    expect(created).toHaveLength(JOB_COST_GAP_SPEC.maxNewPerTenantTick); // 3, not 9, not 5
  });

  test('the SAME-job limit is GONE: one note no longer closes both questions', async () => {
    // This used to be a KNOWN LIMIT, asserted so it was visible: hasActivitySince
    // is keyed on the JOB, not on who answered, so one note satisfied both a
    // visit gap and a cost gap on that job and closed the pair. That was the
    // clearest case for moving closing to the planner (2026-08-22) — code cannot
    // tell which question a sentence answers, and a mind can. Both gaps now stay
    // open, and the planner sees the note with the SHARED warning on it.
    const resolved: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({ id: 'n-visit', subject_ref: 'a1', status: 'asked', asked_at: NOW }),
        costNudge({ status: 'asked', asked_at: NOW, context: {
          customerName: 'Henderson', jobTitle: 'Boiler swap', technicianRef: 'ben-shelton',
          technicianName: 'Ben Shelton', jobId: 'j1', // the SAME job as the visit nudge
        } }),
      ],
      listCaptureTimes: async () => [{ job_id: 'j1', captured_at: '2026-08-16T13:00:00.000Z' }],
      listJobs: async () => [{ id: 'j1', tenant_id: 't1', status: 'completed' } as never],
      resolveNudge: async (id) => {
        resolved.push(id);
        return costNudge({});
      },
    }), 'live');
    expect(resolved).toEqual([]); // NEITHER closes — one note, two questions
  });

  test('both kinds run in one tick and NEITHER asked gap is closed by the sweep', async () => {
    // The partial-answer shape, after the closing move: activity on the visit's
    // job used to close the visit gap and leave the cost gap open. Now both are
    // asked gaps, so the sweep closes neither and the planner sorts out which
    // question the note actually answered.
    const resolved: Array<[string, string]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({ id: 'n-visit', subject_ref: 'a1', status: 'asked', asked_at: NOW }),
        costNudge({ status: 'asked', asked_at: NOW }),
      ],
      // Activity on the VISIT's job only — j1, not j-cost.
      listCaptureTimes: async () => [{ job_id: 'j1', captured_at: '2026-08-16T11:00:00.000Z' }],
      listJobs: async () => [{ id: 'j-cost', tenant_id: 't1', status: 'completed' } as never],
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved).toEqual([]); // both stay open for the planner
    expect(summary.nudgesResolved).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });

  test('the tenant ceiling is shared across kinds — a detector cannot raise per-tick volume', async () => {
    const created: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => Array.from({ length: 5 }, (_, i) =>
        visit({ id: `a${i}`, job_id: `j${i}`, technician_id: 'tech-1', ends_at: `2026-08-15T0${i}:00:00.000Z` })),
      listCostCandidates: async () => [candidate(), candidate({ jobId: 'j-cost-2' })],
      listTeam: async () => [boundTech()],
      createNudge: async (input) => {
        created.push(input.subjectRef);
        return nudgeRow({ subject_ref: input.subjectRef });
      },
    }), 'live');
    // The visit pass spends all 5; the cost pass gets none — total stays 5.
    expect(created).toHaveLength(MAX_NEW_ITEMS_PER_TENANT_TICK);
    expect(created.every((r) => r.startsWith('a'))).toBe(true);
  });

  test('the cost spec is registered in production, not just in tests', async () => {
    expect(JOB_COST_GAP_SPEC.kind).toBe('job_cost_gap');
    expect(JOB_COST_GAP_SPEC.maxNewPerTenantTick).toBe(3);
  });
});

// ── plan 2026-08-22 Phase 2: closing is the planner's, the sweep keeps a fail-safe ──
describe('the deadline fail-safe', () => {
  // Asked 25h before NOW — past the 24h default deadline, so this row is at the
  // exact instant the sweep would otherwise hand a manager a gap claiming
  // nobody answered.
  const OVERDUE_ASK = '2026-08-15T11:00:00.000Z';
  const answeredGap = () =>
    nudgeRow({
      id: 'n-fs',
      subject_ref: 'a-fs',
      status: 'asked',
      asked_at: OVERDUE_ASK,
      context: {
        customerName: 'Henderson',
        jobTitle: 'Furnace tune-up',
        technicianRef: 'ben-shelton',
        technicianName: 'Ben Shelton',
        jobId: 'j1',
        startsAtLocal: '2026-08-14T07:00:00.000Z',
        endsAtLocal: '2026-08-14T08:00:00.000Z',
      },
    });
  // A note on j1 after the visit started — `filled` is true for this gap.
  const answeredOnJob = async () => [{ job_id: 'j1', captured_at: '2026-08-14T07:30:00.000Z' }];
  const dec = (over: Record<string, unknown>) =>
    ({
      action: 'hold',
      outcome: 'applied',
      reason: 'r',
      handoff_note: null,
      decided_at: '2026-08-16T09:00:00.000Z', // 3h before NOW — inside the window
      ...over,
    }) as never;

  test('answered + a SILENT planner → auto-closed, and the text names the fail-safe', async () => {
    const resolved: Array<[string, string, string | null | undefined]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [answeredGap()],
      listCaptureTimes: answeredOnJob,
      listDecisions: async () => new Map(), // the planner has said nothing, ever
      flagNudge: async () => {
        throw new Error('an answered gap must not reach the manager');
      },
      resolveNudge: async (id, _t, status, resolution) => {
        resolved.push([id, status, resolution]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved).toHaveLength(1);
    const [id, status, resolution] = resolved[0];
    expect(id).toBe('n-fs');
    expect(status).toBe('answered');
    // A manager reading this later must not mistake it for a considered
    // decision, and the next engineer must be able to tell it from a planner
    // close by reading the row alone.
    expect(resolution).toContain('closed automatically');
    expect(resolution).toContain('Nobody reviewed it within 24h');
    // It says WHAT it is about. `nudges.resolution` has no reader today, which
    // is exactly why this is easy to get wrong: the row has to stand alone for
    // the engineer reading it now and for the planner reading it after ④.
    expect(resolution).toContain("'Furnace tune-up' (Henderson)");
    // And no internal component name — the same rule that killed the ref code.
    expect(resolution).not.toContain('planner');
    expect(summary.nudgesAutoClosed).toBe(1);
    expect(summary.nudgesResolved).toBe(0); // counted apart — this is an ALARM
    expect(summary.nudgesEscalated).toBe(0);
  });

  test('answered + a LIVE planner → ESCALATES; its judgment stands', async () => {
    // The planner has been deciding about this gap and chose not to close it.
    // That is a judgment, not an outage, and the fail-safe must not overrule it.
    const resolved: Array<[string, string]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [answeredGap()],
      listCaptureTimes: answeredOnJob,
      listDecisions: async () => new Map([['n-fs', [dec({ action: 'hold' })]]]),
      flagNudge: async (input) => openItem({ subject_ref: input.subjectRef }),
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved).toEqual([['n-fs', 'escalated']]);
    expect(summary.nudgesAutoClosed).toBe(0);
    expect(summary.nudgesEscalated).toBe(1);
  });

  test('a THIN context degrades to no subject, never to "undefined"', async () => {
    const resolved: Array<string | null | undefined> = [];
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({
          id: 'n-fs',
          subject_ref: 'a-fs',
          status: 'asked',
          asked_at: OVERDUE_ASK,
          context: { jobId: 'j1', startsAtLocal: '2026-08-14T07:00:00.000Z' }, // no title
        }),
      ],
      listCaptureTimes: answeredOnJob,
      listDecisions: async () => new Map(),
      resolveNudge: async (id, _t, status, resolution) => {
        resolved.push(resolution);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved[0]).not.toContain('undefined');
    expect(resolved[0]).toMatch(/^closed automatically/);
  });

  test('CROSS-PHASE: only `unmentioned` rows → AUTO-CLOSES', async () => {
    // The regression this phase's seam exists for. Phase 3 appends an
    // `unmentioned` row with outcome 'applied' for every gap the planner merely
    // LOOKED at. A naive `outcome === applied` liveness test would then be true
    // for every open gap on every tick and the fail-safe would silently never
    // fire again — with nothing in any log to show for it.
    const resolved: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [answeredGap()],
      listCaptureTimes: answeredOnJob,
      listDecisions: async () =>
        new Map([['n-fs', [dec({ action: 'unmentioned' }), dec({ action: 'unmentioned' })]]]),
      resolveNudge: async (id, _t, status) => {
        resolved.push(`${id}:${status}`);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved).toEqual(['n-fs:answered']);
    expect(summary.nudgesAutoClosed).toBe(1);
  });

  test('a judgment OUTSIDE the liveness window does not count as alive', async () => {
    const resolved: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [answeredGap()],
      listCaptureTimes: answeredOnJob,
      // 30h before NOW — the planner decided once and then went quiet.
      listDecisions: async () =>
        new Map([['n-fs', [dec({ decided_at: '2026-08-15T06:00:00.000Z' })]]]),
      resolveNudge: async (id, _t, status) => {
        resolved.push(`${id}:${status}`);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved).toEqual(['n-fs:answered']);
    expect(summary.nudgesAutoClosed).toBe(1);
  });

  test('a REFUSED or SHADOW decision is not evidence of a planner that can act', async () => {
    const resolved: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [answeredGap()],
      listCaptureTimes: answeredOnJob,
      listDecisions: async () =>
        new Map([['n-fs', [dec({ outcome: 'refused' }), dec({ outcome: 'shadow' })]]]),
      resolveNudge: async (id, _t, status) => {
        resolved.push(`${id}:${status}`);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved).toEqual(['n-fs:answered']);
  });

  test('NOT answered → escalates, exactly as before', async () => {
    const resolved: Array<[string, string]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [answeredGap()],
      listCaptureTimes: async () => [], // nothing landed on the job at all
      listDecisions: async () => new Map(),
      flagNudge: async (input) => openItem({ subject_ref: input.subjectRef }),
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved).toEqual([['n-fs', 'escalated']]);
    expect(summary.nudgesAutoClosed).toBe(0);
    expect(summary.nudgesEscalated).toBe(1);
  });

  test('a FAILED decision read holds the fail-safe back — it escalates instead', async () => {
    // Fail toward the manager, never toward an automatic close on missing
    // evidence. A read that did not happen is not evidence of silence, and the
    // two mistakes are not equally bad: escalating loses nobody's answer.
    const resolved: Array<[string, string]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [answeredGap()],
      listCaptureTimes: answeredOnJob,
      listDecisions: async () => {
        throw new Error('decision log unreachable');
      },
      flagNudge: async (input) => openItem({ subject_ref: input.subjectRef }),
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved).toEqual([['n-fs', 'escalated']]);
    expect(summary.nudgesAutoClosed).toBe(0);
    expect(summary.nudgesEscalated).toBe(1);
    expect(summary.tenantErrors).toBe(0); // isolated, not a tenant failure
  });

  test('TWO gaps on one job → the fail-safe DECLINES; one note cannot close two questions', async () => {
    // The same-job double-close, deferred by 24h rather than removed (final
    // review). `filled` is job-keyed and cannot tell which QUESTION a note
    // answers, so at the deadline it would close both — and the cost gap's
    // PERMANENT resolution would read "the technician answered" about a
    // question nobody answered, with the figure never captured.
    const resolved: Array<[string, string]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        answeredGap(),
        nudgeRow({
          id: 'n-fs2',
          subject_ref: 'a-fs2',
          kind: 'job_cost_gap',
          status: 'asked',
          asked_at: OVERDUE_ASK,
          context: { jobId: 'j1', jobTitle: 'Furnace tune-up', customerName: 'Henderson' },
        }),
      ],
      listCaptureTimes: answeredOnJob,
      listDecisions: async () => new Map(), // planner silent — the fail-safe's own case
      flagNudge: async (input) => openItem({ subject_ref: input.subjectRef }),
      resolveNudge: async (id, _t, status) => {
        resolved.push([id, status]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    // Both escalate — fails toward the manager, like every other ambiguity here.
    expect(summary.nudgesAutoClosed).toBe(0);
    expect(resolved.map(([, st]) => st)).toEqual(['escalated', 'escalated']);
  });

  test('an ANSWERABLE gap that escalates must not claim "no note or status update"', async () => {
    // The false claim this phase re-opened the door to (review finding). Before
    // Phase 2 a `filled`-true row could never reach the escalation loop — it
    // closed at the top of the sweep — so the clause was backed implicitly. Now
    // an answered gap whose planner is ALIVE and chose not to close it falls
    // through to here, and the item would tell a manager there is no note with
    // the field report sitting on the job. That is exactly the claim plan ②
    // deleted, re-entering through a door this phase opened.
    const flagged: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [answeredGap()],
      listCaptureTimes: answeredOnJob, // a report IS on the job
      // A live planner that chose `extend` — so it escalates rather than
      // auto-closing, and no handoff_note masks the template.
      listDecisions: async () =>
        new Map([['n-fs', [dec({ action: 'extend', handoff_note: null })]]]),
      flagNudge: async (input) => {
        flagged.push(input.suggestion);
        return openItem({ subject_ref: input.subjectRef });
      },
      resolveNudge: async (id, _t, status) => nudgeRow({ id, status } as Partial<Nudge>),
    }), 'live');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).not.toContain('no note or status update');
    // …and it does not ask the manager for a datum the record already holds.
    // The stage-0 doctrine's premise is "the RECORD does not know it", which is
    // exactly what an answerable gap falsifies.
    expect(flagged[0]).not.toContain("Tell me how it went");
    expect(flagged[0]).toContain('Something has landed on the job since');
    expect(flagged[0]).toContain('Furnace tune-up');
  });

  test('the nudge’s own resolution stops saying "no reply" when something landed', async () => {
    const resolved: Array<[string, string, string | null | undefined]> = [];
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [answeredGap()],
      listCaptureTimes: answeredOnJob,
      listDecisions: async () =>
        new Map([['n-fs', [dec({ action: 'extend', handoff_note: null })]]]),
      flagNudge: async (input) => openItem({ subject_ref: input.subjectRef }),
      resolveNudge: async (id, _t, status, resolution) => {
        resolved.push([id, status, resolution]);
        return nudgeRow({ id, status } as Partial<Nudge>);
      },
    }), 'live');
    expect(resolved[0][2]).toBe('not confirmed as answered — handed to the manager');
  });

  test('a genuinely SILENT gap still gets the clause — the fix narrows, it does not delete', async () => {
    const flagged: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [answeredGap()],
      listCaptureTimes: async () => [], // nothing landed — the claim is TRUE here
      listDecisions: async () => new Map(),
      flagNudge: async (input) => {
        flagged.push(input.suggestion);
        return openItem({ subject_ref: input.subjectRef });
      },
      resolveNudge: async (id, _t, status) => nudgeRow({ id, status } as Partial<Nudge>),
    }), 'live');
    expect(flagged).toHaveLength(1);
    expect(flagged[0]).toContain('no note or status update');
    expect(flagged[0]).toContain("Tell me how it went"); // the ask is right here
  });

  test('the JUDGMENT vocabulary is pinned — a new action must be added here too', () => {
    // watchers.ts and planner.ts have to agree about what counts as a decision.
    // If PLANNER_ACTIONS grows and this set does not, the new verb silently
    // stops counting as liveness and the fail-safe starts firing under a planner
    // that is working fine.
    expect([...PLANNER_JUDGMENT_ACTIONS].sort()).toEqual([
      'close', 'escalate', 'extend', 'hold', 'leave', 'send',
    ]);
    for (const a of PLANNER_ACTIONS) expect(PLANNER_JUDGMENT_ACTIONS.has(a)).toBe(true);
    expect(PLANNER_JUDGMENT_ACTIONS.has('unmentioned')).toBe(false);
  });
});

// ── plan ② (2026-08-21): the manager copy asserts nothing it wasn't given ────
//
// The rule under test: a template may render data it was given and may carry
// instructions, but must NEVER assert a fact it did not receive as an argument.
// These are the locks. Every deletion below has a live specimen behind it —
// 2026-08-20 told a manager a technician "hasn't heard back" and that "nothing
// is on the job's record" on a job the customer had already paid for, and both
// halves were false.
describe('the manager copy asserts nothing it was not given (plan ② 2026-08-21)', () => {
  const NAIVE = (iso: string) => iso;
  const askedVisit = nudgeRow({ status: 'asked', asked_at: '2026-08-13T00:00:00.000Z' });
  const costRow = (over: Partial<Nudge> = {}): Nudge =>
    nudgeRow({
      id: 'n-cost',
      kind: 'job_cost_gap',
      subject_ref: 'j-cost',
      context: {
        customerName: 'Henderson',
        jobTitle: 'Boiler swap',
        technicianRef: 'ben-shelton',
        technicianName: 'Ben Shelton',
        jobId: 'j-cost',
        endsAtLocal: '2026-08-15T11:00:00.000Z',
      },
      ...over,
    });
  // The shape listDecisionsForNudges returns; only the four fields the reader
  // reads are meaningful.
  const decision = (over: Record<string, unknown>) =>
    ({
      action: 'escalate',
      outcome: 'applied',
      // Diagnostic. Must NEVER reach a manager — it is written for refusals too
      // and is the corpus continual learning reads (user, 2026-08-22).
      reason: 'INTERNAL-ONLY diagnostic line',
      handoff_note: "'Furnace tune-up' (Henderson) still has no write-up. A quick word with Ben and I'll record it.",
      decided_at: '2026-08-16T09:00:00.000Z',
      ...over,
    }) as never;

  test('the deleted claims are gone from BOTH escalated copies', () => {
    const visit = OVERDUE_VISIT_GAP_SPEC.handoff(askedVisit, 'escalated', NAIVE, {
      noNoteOrStatusChange: true,
      noCostOnLedger: true,
    })!;
    expect(visit.suggestion).not.toContain("hasn't heard back");
    expect(visit.suggestion).not.toContain("on the job's record");

    const cost = JOB_COST_GAP_SPEC.handoff(costRow({ status: 'asked' }), 'escalated', NAIVE, {
      noCostOnLedger: true,
    })!;
    expect(cost.suggestion).not.toContain("hasn't heard back");
    expect(cost.suggestion).not.toContain('incomplete');
    // The backed replacement IS there.
    expect(cost.suggestion).toContain('nothing recorded for it yet');
  });

  test('without a ctx every factual clause is omitted, and the plan is still valid', () => {
    // The compose.ts:98 / handToManager shape: two arguments, nothing checked.
    const expired = JOB_COST_GAP_SPEC.handoff(costRow({}), 'expired')!;
    expect(expired).not.toBeNull();
    expect(expired.jobId).toBe('j-cost');
    expect(expired.suggestion).not.toContain('nothing recorded for it yet');
    expect(expired.suggestion).not.toContain('incomplete');
    // …but the SUBJECT survives: gating the whole lead-in shipped a manager
    // item that named neither the job nor the topic.
    expect(expired.suggestion).toContain('cost in parts or materials');
    expect(expired.suggestion).toContain('Boiler swap');
    expect(expired.suggestion).toContain('Henderson');

    const visit = OVERDUE_VISIT_GAP_SPEC.handoff(askedVisit, 'escalated', NAIVE)!;
    expect(visit).not.toBeNull();
    expect(visit.suggestion).not.toContain('no note or status update');
    expect(visit.suggestion).not.toContain("The assistant's note");
  });

  test('stage0Suggestion states the predicate it was given, and nothing wider', () => {
    const without = stage0Suggestion('Furnace tune-up', 'Henderson', '2026-08-14T08:00:00.000Z');
    expect(without).not.toContain('no note or status update');
    expect(without).not.toContain('nothing has been recorded');
    expect(without).toContain('Furnace tune-up');

    const withFlag = stage0Suggestion(
      'Furnace tune-up',
      'Henderson',
      '2026-08-14T08:00:00.000Z',
      true,
    );
    expect(withFlag).toContain('— no note or status update on it yet');
    // The general claim is DELETED, not merely reworded: it is a statement about
    // the whole record made from a predicate that reads two tables.
    expect(withFlag).not.toContain('nothing has been recorded');
  });

  test("the planner's note IS the message, and `reason` never reaches the manager", async () => {
    let suggestion = '';
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askedVisit],
      listDecisions: async () => new Map([['n1', [decision({})]]]),
      flagNudge: async (input) => {
        suggestion = input.suggestion;
        return openItem({});
      },
    }), 'live');
    // The planner's line replaces the template WHOLESALE — not appended to it,
    // not quoted under it, not framed by it (user, 2026-08-22).
    expect(suggestion).toBe(
      "'Furnace tune-up' (Henderson) still has no write-up. A quick word with Ben and I'll record it.",
    );
    expect(suggestion).not.toContain('INTERNAL-ONLY');
    expect(suggestion).not.toContain('We asked'); // no template text survives
  });

  test('no note → the template, unchanged', async () => {
    // The clock-driven escalation: the sweep has no model, so nobody wrote a
    // line. This is the normal case, not the exception.
    let suggestion = '';
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askedVisit],
      listDecisions: async () => new Map([['n1', [decision({ handoff_note: null })]]]),
      flagNudge: async (input) => {
        suggestion = input.suggestion;
        return openItem({});
      },
    }), 'live');
    expect(suggestion).toContain('We asked Ben Shelton on Thursday, Aug 13 at 12:00 AM');
    expect(suggestion).not.toContain('INTERNAL-ONLY');
  });

  test('the briefing rides detail-bound agentContext, never the suggestion (④b)', async () => {
    let capturedContext: unknown = 'UNSET';
    let capturedSuggestion = '';
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askedVisit],
      listDecisions: async () =>
        new Map([['n1', [decision({ agent_context: 'Job j-1: asked once; ledger empty.' })]]]),
      flagNudge: async (input) => {
        capturedContext = input.agentContext;
        capturedSuggestion = input.suggestion;
        return openItem({});
      },
    }), 'live');
    expect(capturedContext).toBe('Job j-1: asked once; ledger empty.');
    expect(capturedSuggestion).not.toContain('ledger empty'); // machine context never in human copy

    // Absent when the planner wrote none — the normal, sweep-clock case.
    let absent: unknown = 'UNSET';
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askedVisit],
      listDecisions: async () => new Map([['n1', [decision({})]]]),
      flagNudge: async (input) => {
        absent = input.agentContext;
        return openItem({});
      },
    }), 'live');
    expect(absent).toBeUndefined();
  });

  test('only an APPLIED escalate is quoted — never a refusal, a shadow, or an extend', async () => {
    const cases: Array<Record<string, unknown>> = [
      { outcome: 'refused', reason: 'REFUSED-REASON' },
      { outcome: 'shadow', reason: 'SHADOW-REASON' },
      { action: 'extend', outcome: 'applied', reason: 'EXTEND-REASON' },
    ];
    for (const over of cases) {
      let suggestion = '';
      await runWatchers(NOW, 'live', baseDeps({
        listNudges: async () => [askedVisit],
        listDecisions: async () =>
          new Map([['n1', [decision({ ...over, handoff_note: 'DO NOT SHOW THIS' })]]]),
        flagNudge: async (input) => {
          suggestion = input.suggestion;
          return openItem({});
        },
      }), 'live');
      expect(suggestion).not.toContain('DO NOT SHOW THIS');
      expect(suggestion).toContain('We asked Ben Shelton'); // fell back
    }
  });

  test('the NEWEST applied escalate wins, read in ONE batched call for N gaps', async () => {
    const calls: string[][] = [];
    let suggestion = '';
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        askedVisit,
        nudgeRow({ id: 'n2', subject_ref: 'a2', status: 'asked', asked_at: '2026-08-13T00:00:00.000Z' }),
      ],
      listDecisions: async (_t, ids) => {
        calls.push(ids);
        return new Map([
          [
            'n1',
            [
              decision({ handoff_note: 'OLD note', decided_at: '2026-08-16T08:00:00.000Z' }),
              decision({ handoff_note: 'NEWEST note', decided_at: '2026-08-16T10:00:00.000Z' }),
            ],
          ],
        ]);
      },
      flagNudge: async (input) => {
        if (input.escalatedFromNudge === 'n1') suggestion = input.suggestion;
        return openItem({ subject_ref: input.subjectRef });
      },
      resolveNudge: async () => askedVisit,
    }), 'live');
    expect(summary.nudgesEscalated).toBe(2);
    expect(calls).toEqual([['n1', 'n2']]); // ONE call, both ids
    expect(suggestion).toBe('NEWEST note');
  });

  test('a throwing decision read still escalates — the handoff outranks the note', async () => {
    let suggestion = '';
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const summary = await runWatchers(NOW, 'live', baseDeps({
        listNudges: async () => [askedVisit],
        listDecisions: async () => {
          throw new Error('nudge_decisions is down');
        },
        flagNudge: async (input) => {
          suggestion = input.suggestion;
          return openItem({});
        },
        resolveNudge: async () => askedVisit,
      }), 'live');
      expect(summary.nudgesEscalated).toBe(1);
      expect(suggestion).toContain('We asked Ben Shelton'); // the template
      expect(suggestion).not.toContain('INTERNAL-ONLY');
    } finally {
      spy.mockRestore();
    }
  });

  test('the EXPIRED path carries the ledger fact but never the note/status flag', async () => {
    // A pending row past the delivery deadline was NEVER asked, so the cost
    // spec's filled short-circuits before hasActivitySince ever runs. Passing
    // noNoteOrStatusChange there would be honest for one kind and vacuous for
    // the other.
    let suggestion = '';
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        costRow({
          status: 'pending',
          created_at: new Date(Date.parse(NOW) - (NUDGE_DELIVERY_DEADLINE_HOURS + 1) * 3_600_000).toISOString(),
        }),
      ],
      listJobs: async () => [{ id: 'j-cost', tenant_id: 't1', status: 'completed' } as never],
      listCostEvents: async () => [],
      flagNudge: async (input) => {
        suggestion = input.suggestion;
        return openItem({ subject_ref: input.subjectRef });
      },
      resolveNudge: async () => costRow({ status: 'failed' }),
    }), 'live');
    expect(suggestion).toContain('nothing recorded for it yet');
    expect(suggestion).not.toContain('no note or status update');
    expect(suggestion).not.toContain("The assistant's note");
  });

  test('an EXPIRED VISIT nudge omits the note/status clause entirely', async () => {
    // The counterpart lock for the expired path: the cost copy never renders
    // that clause, so only a VISIT row can prove the flag is not being passed.
    // It must stay absent — an expired row was never asked, and the detector
    // fallback at :812 (which DID run !hasActivitySince) is the only place the
    // clause is earned.
    let suggestion = '';
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({
          status: 'pending',
          created_at: new Date(
            Date.parse(NOW) - (NUDGE_DELIVERY_DEADLINE_HOURS + 1) * 3_600_000,
          ).toISOString(),
        }),
      ],
      flagNudge: async (input) => {
        suggestion = input.suggestion;
        return openItem({});
      },
      resolveNudge: async () => askedVisit,
    }), 'live');
    expect(suggestion).toContain('Furnace tune-up'); // it IS the stage-0 copy
    expect(suggestion).not.toContain('no note or status update');
    expect(suggestion).not.toContain('nothing has been recorded');
  });

  // F1 from the Phase-1 review: the detector's unreachable-technician fallback
  // had NO test touching its suggestion at all, so restoring the deleted
  // conclusion there left the suite green.
  test('the cost detector fallback states the ledger fact and draws no conclusion', async () => {
    let suggestion = '';
    await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [
        {
          jobId: 'j-cost',
          technicianId: 'tech-1',
          jobTitle: 'Boiler swap',
          customerName: 'Henderson',
          endsAtLocal: '2026-08-15T11:00:00.000Z',
        } as never,
      ],
      listTeam: async () => [boundTech({ telegram_user_id: null })], // UNREACHABLE
      flagNudge: async (input) => {
        suggestion = input.suggestion;
        return openItem({ subject_ref: input.subjectRef });
      },
    }), 'live');
    // Backed by this detector's own ledger filter (freshCost excludes withCost).
    expect(suggestion).toBe(
      "'Boiler swap' (Henderson) — nothing recorded yet about what it cost in parts or " +
        "materials. Tell me the figure and I'll put it on the books.",
    );
    // The CONCLUSION is deleted: a job with no parts has complete costs.
    expect(suggestion).not.toContain('incomplete');
  });

  // F2 from the review: the per-tick push is a manager-facing template too, and
  // its cost wording was reachably false — a cost nudge escalates even when the
  // ledger HAS the cost.
  test('the push line says what opened, never what is on the record', async () => {
    const pushes: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [costRow({ status: 'asked', asked_at: '2026-08-13T00:00:00.000Z' })],
      listJobs: async () => [{ id: 'j-cost', tenant_id: 't1', status: 'completed' } as never],
      listCostEvents: async () => ['j-cost'], // the ledger DOES have the cost
      flagNudge: async (input) => openItem({ subject_ref: input.subjectRef }),
      resolveNudge: async () => costRow({ status: 'escalated' }),
      notify: async (_t, line) => {
        pushes.push(line);
      },
    }), 'live');
    expect(pushes).toHaveLength(1);
    // The old copy asserted this about a job whose cost IS recorded.
    expect(pushes[0]).not.toContain('no parts cost on record');
    expect(pushes[0]).not.toContain('nothing on record');
    expect(pushes[0]).toContain('an open question about its parts cost');
  });

  // F4: a job-scoped kind consults no assignment status, so it must not be
  // handed the flag whose clause asserts one.
  test('the note/status flag goes only to a kind whose subject status was read', async () => {
    const seen: Array<boolean | undefined> = [];
    const probe: NudgeKindSpec = {
      ...JOB_COST_GAP_SPEC,
      handoff: (n, mode, naive, ctx) => {
        seen.push(ctx?.noNoteOrStatusChange);
        return JOB_COST_GAP_SPEC.handoff(n, mode, naive, ctx);
      },
    };
    await runWatchers(NOW, 'live', baseDeps({
      specs: [OVERDUE_VISIT_GAP_SPEC, probe],
      listNudges: async () => [costRow({ status: 'asked', asked_at: '2026-08-13T00:00:00.000Z' })],
      listJobs: async () => [{ id: 'j-cost', tenant_id: 't1', status: 'completed' } as never],
      flagNudge: async (input) => openItem({ subject_ref: input.subjectRef }),
      resolveNudge: async () => costRow({ status: 'escalated' }),
    }), 'live');
    expect(seen).toEqual([undefined]); // never `true` for a job-scoped kind
  });

  // F5: an unparseable startsAtLocal makes `filled` return before
  // hasActivitySince runs, so the flag describes nothing.
  test('an unparseable visit start drops the claim but still escalates', async () => {
    let suggestion = '';
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        nudgeRow({
          status: 'asked',
          asked_at: '2026-08-13T00:00:00.000Z',
          context: {
            customerName: 'Henderson',
            jobTitle: 'Furnace tune-up',
            technicianRef: 'ben-shelton',
            technicianName: 'Ben Shelton',
            jobId: 'j1',
            startsAtLocal: 'not-a-date',
            endsAtLocal: '2026-08-14T08:00:00.000Z',
          },
        }),
      ],
      flagNudge: async (input) => {
        suggestion = input.suggestion;
        return openItem({});
      },
      resolveNudge: async () => askedVisit,
    }), 'live');
    expect(summary.nudgesEscalated).toBe(1); // the manager still hears about it
    expect(suggestion).not.toContain('no note or status update');
  });

  // The standing guard for the 2026-08-21 decision. Every one of these strings
  // used to end "just dismiss this", which tells a manager that if they know
  // the answer they need not tell us — backwards, since the record not knowing
  // is the whole reason the item exists.
  test('NO manager copy invites a dismissal, in any ctx combination', () => {
    const ctxs = [
      undefined,
      {},
      { noNoteOrStatusChange: true },
      { noCostOnLedger: true },
      { noNoteOrStatusChange: true, noCostOnLedger: true, plannerReason: 'nothing came back' },
    ];
    const rendered: string[] = [
      stage0Suggestion('Furnace tune-up', 'Henderson', '2026-08-14T08:00:00.000Z'),
      stage0Suggestion('Furnace tune-up', 'Henderson', '2026-08-14T08:00:00.000Z', true),
    ];
    for (const ctx of ctxs) {
      for (const mode of ['escalated', 'expired'] as const) {
        rendered.push(
          OVERDUE_VISIT_GAP_SPEC.handoff(askedVisit, mode, NAIVE, ctx)?.suggestion ?? '',
          JOB_COST_GAP_SPEC.handoff(costRow({ status: 'asked' }), mode, NAIVE, ctx)?.suggestion ?? '',
        );
      }
    }
    for (const text of rendered) {
      expect(text).not.toMatch(/dismiss/i);
      // …and every one of them asks for the datum instead.
      if (text) expect(text).toMatch(/Tell me/);
    }
  });

  test('a ZERO cost really does close the gap — the unstated half of the ask', () => {
    // The copy asks for "the figure" without qualifying it, which is only fair
    // because a zero is a real answer here: itemResolved keys on the KIND, with
    // no amount predicate, so a $0 material_cost resolves the item exactly like
    // any other figure. If that ever changes, the plain ask becomes a trap for
    // the manager who answers "no parts".
    const item = { subjectRef: 'j-cost', jobId: 'j-cost', startsAtLocal: null };
    const facts = {
      hasActivitySince: () => false,
      visitStatusById: new Map<string, string>(),
      jobStatusById: new Map<string, string>(),
      naiveLocal: (i: string) => i,
      jobsWithCostEvents: new Set(['j-cost']), // what a ZERO material_cost produces
    };
    expect(JOB_COST_GAP_SPEC.itemResolved(item, facts)).toBe(
      'a cost was recorded for this job after it was flagged',
    );
  });

  test('a job that DOES have a live cost gets no cost claim at all', async () => {
    let suggestion = '';
    await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [costRow({ status: 'asked', asked_at: '2026-08-13T00:00:00.000Z' })],
      listJobs: async () => [{ id: 'j-cost', tenant_id: 't1', status: 'completed' } as never],
      listCostEvents: async () => ['j-cost'], // the ledger says a cost IS recorded
      flagNudge: async (input) => {
        suggestion = input.suggestion;
        return openItem({ subject_ref: input.subjectRef });
      },
      resolveNudge: async () => costRow({ status: 'escalated' }),
    }), 'live');
    expect(suggestion).toContain('cost in parts and materials');
    expect(suggestion).not.toContain('Nothing is recorded');
  });
});

// ── plan 2026-08-25 Phase 2: one message, one fate ──────────────────────────
describe('ask-groups expire together', () => {
  const ctx = (jobId: string) => ({
    customerName: 'Henderson',
    jobTitle: 'Boiler swap',
    technicianRef: 'ben-shelton',
    technicianName: 'Ben Shelton',
    jobId,
    startsAtLocal: '2026-08-14T07:00:00.000Z',
    endsAtLocal: '2026-08-14T08:00:00.000Z',
  });

  test('one member past the deadline expires the WHOLE group, young siblings included', async () => {
    // Members of one message are minted at different times — a visit gap and a
    // cost gap on one job can be days apart — but they only ever leave together.
    // Expiring the elder alone would tell a manager "never delivered" about a
    // question still being served inside the shared text, and would leave the
    // group half-asked when the ack finally landed.
    const flagged: string[] = [];
    const resolved: Array<[string, string, string | null | undefined]> = [];
    const summary = await runWatchers(
      NOW,
      'live',
      baseDeps({
        listNudges: async () => [
          nudgeRow({
            id: 'n-lead',
            subject_ref: 'a-lead',
            status: 'queued',
            created_at: UNDELIVERED_PAST_DUE,
            ask_group_id: 'n-lead',
            context: ctx('j-grouped'),
          }),
          nudgeRow({
            id: 'n-young',
            subject_ref: 'a-young',
            status: 'queued',
            created_at: UNDELIVERED_YOUNG, // nowhere near its own deadline
            ask_group_id: 'n-lead',
            context: ctx('j-grouped'),
          }),
        ],
        flagNudge: async (input) => {
          flagged.push(input.subjectRef);
          return openItem({ subject_ref: input.subjectRef });
        },
        resolveNudge: async (id, _t, status, resolution) => {
          resolved.push([id, status, resolution]);
          return nudgeRow({ id, status } as Partial<Nudge>);
        },
      }),
      'live',
    );
    expect(summary.tenantErrors).toBe(0);
    expect(flagged.sort()).toEqual(['a-lead', 'a-young']);
    expect(resolved.map((r) => r[0]).sort()).toEqual(['n-lead', 'n-young']);
    for (const r of resolved) {
      expect(r[1]).toBe('failed');
      expect(r[2]).toBe('never delivered — handed to the manager');
    }
    expect(summary.nudgesExpired).toBe(2);
  });

  test('an ASKED sibling is left alone — it owns its own escalation clock', async () => {
    const resolved: string[] = [];
    const summary = await runWatchers(
      NOW,
      'live',
      baseDeps({
        listNudges: async () => [
          nudgeRow({
            id: 'n-lead',
            subject_ref: 'a-lead',
            status: 'queued',
            created_at: UNDELIVERED_PAST_DUE,
            ask_group_id: 'n-lead',
            context: ctx('j-mixed'),
          }),
          nudgeRow({
            id: 'n-asked',
            subject_ref: 'a-asked',
            status: 'asked',
            created_at: UNDELIVERED_PAST_DUE,
            asked_at: hoursBeforeNow(1),
            ask_group_id: 'n-lead',
            context: ctx('j-mixed'),
          }),
        ],
        flagNudge: async (input) => openItem({ subject_ref: input.subjectRef }),
        resolveNudge: async (id, _t, status) => {
          resolved.push(id);
          return nudgeRow({ id, status } as Partial<Nudge>);
        },
      }),
      'live',
    );
    expect(summary.tenantErrors).toBe(0);
    expect(resolved).toEqual(['n-lead']);
    expect(summary.nudgesExpired).toBe(1);
  });

  test('a sibling closed EARLIER in the same tick is not resurrected by the expansion', async () => {
    // The expansion reads openNudgeGaps, whose in-memory rows still say
    // 'queued' for a member `moot` closed seconds ago. Without closedThisTick
    // that member is handed to a manager anyway — flagNudge runs BEFORE the
    // ['pending','queued']-guarded resolveNudge returns null, so the item opens
    // even though the row never moves.
    const flagged: string[] = [];
    const resolved: Array<[string, string]> = [];
    const summary = await runWatchers(
      NOW,
      'live',
      baseDeps({
        listNudges: async () => [
          nudgeRow({
            id: 'n-lead',
            subject_ref: 'a-lead',
            status: 'queued',
            created_at: UNDELIVERED_PAST_DUE,
            ask_group_id: 'n-lead',
            context: ctx('j-moot'),
          }),
          nudgeRow({
            id: 'n-mooted',
            subject_ref: 'a-mooted',
            status: 'queued',
            created_at: UNDELIVERED_YOUNG,
            ask_group_id: 'n-lead',
            context: { ...ctx('j-moot'), jobId: 'j-moot' },
          }),
        ],
        // The sibling's visit was cancelled — `moot` closes it this tick.
        listAssignments: async () => [
          visit({ id: 'a-mooted', job_id: 'j-moot', status: 'cancelled' } as Partial<PlacedAssignment>),
        ],
        flagNudge: async (input) => {
          flagged.push(input.subjectRef);
          return openItem({ subject_ref: input.subjectRef });
        },
        resolveNudge: async (id, _t, status) => {
          resolved.push([id, status]);
          return nudgeRow({ id, status } as Partial<Nudge>);
        },
      }),
      'live',
    );
    expect(summary.tenantErrors).toBe(0);
    // The mooted sibling closed as cancelled and NEVER reached a manager.
    expect(resolved).toEqual([
      ['n-mooted', 'cancelled'],
      ['n-lead', 'failed'],
    ]);
    expect(flagged).toEqual(['a-lead']);
    expect(summary.nudgesExpired).toBe(1);
  });

  test('an UNGROUPED young row is still left alone (the control)', async () => {
    const resolved: string[] = [];
    const summary = await runWatchers(
      NOW,
      'live',
      baseDeps({
        listNudges: async () => [
          nudgeRow({
            id: 'n-old',
            subject_ref: 'a-old',
            status: 'queued',
            created_at: UNDELIVERED_PAST_DUE,
            context: ctx('j-solo-1'),
          }),
          nudgeRow({
            id: 'n-young',
            subject_ref: 'a-young',
            status: 'queued',
            created_at: UNDELIVERED_YOUNG,
            context: ctx('j-solo-2'),
          }),
        ],
        flagNudge: async (input) => openItem({ subject_ref: input.subjectRef }),
        resolveNudge: async (id, _t, status) => {
          resolved.push(id);
          return nudgeRow({ id, status } as Partial<Nudge>);
        },
      }),
      'live',
    );
    expect(summary.tenantErrors).toBe(0);
    expect(resolved).toEqual(['n-old']);
    expect(summary.nudgesExpired).toBe(1);
  });
});

// The offset rule (handoff 2026-08-25). This label is the manager's and the
// technician's only statement of WHEN — the escalation template prints it and
// the planner may quote nothing else — so it must be a property of the stamp,
// never of the machine that formatted it.
describe('wallClockLabel — the same stamp reads the same on every host', () => {
  const underTZ = <T>(tz: string, fn: () => T): T => {
    const prior = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      if (prior === undefined) delete process.env.TZ;
      else process.env.TZ = prior;
    }
  };

  test('offset-carrying and bare stamps agree, in UTC and far from it', () => {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      // The shape naiveLocalISO actually writes.
      expect(underTZ(tz, () => wallClockLabel('2026-08-15T16:00:00.000Z'))).toBe(
        'Saturday, Aug 15 at 4:00 PM',
      );
      // The shape a hand-built caller would produce. Before the guard this
      // read 9:00 AM in LA and rolled to Sunday 1:00 AM in Tokyo.
      expect(underTZ(tz, () => wallClockLabel('2026-08-15T16:00:00'))).toBe(
        'Saturday, Aug 15 at 4:00 PM',
      );
    }
  });
});
