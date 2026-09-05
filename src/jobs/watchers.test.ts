import { describe, expect, test } from 'vitest';
import type { PlacedAssignment } from '../db/assignments.js';
import type { JobWithCustomer } from '../db/jobs.js';
import type { Observation } from '../db/observations.js';
import type { ReviewItem } from '../db/reviewItems.js';
import type { Tenant } from '../db/tenants.js';
import type { Technician } from '../db/technicians.js';
import { resolveSettings, type TenantSettings } from '../db/tenantSettings.js';
import {
  ASK_UNATTENDED_ALARM_HOURS,
  DELIVERY_STUCK_ALARM_HOURS,
  OBSERVATION_STALE_HOURS,
  PLANNER_JUDGMENT_ACTIONS,
  runWatchers,
  wallClockLabel,
  type WatcherDeps,
} from './watchers.js';
import { MAX_DELIVERY_ATTEMPTS, MAX_SERVE_COUNT } from '../control/nudgeQueue.js';
import type { Nudge } from '../db/nudges.js';
import type { NudgeDecision } from '../db/nudgeDecisions.js';
import { PLANNER_ACTIONS } from '../teamLead/planner.js';
import {
  JOB_COST_GAP_SPEC,
  OVERDUE_VISIT_GAP_SPEC,
  type NudgeKindSpec,
} from './nudgeKinds.js';

// Pure unit tests — every collaborator injected (lifecycle.test.ts pattern).
//
// Semantics under test: "filled" = job activity at-or-after the visit's START
// (minute-floored); FRESH = never surfaced in any dedup store; detection
// records observations, uncapped. SINCE BUILD 5 the sweep decides nothing
// else: no moot close, no fail-safe, no escalation, no expiry, no push — the
// only judgment left is the manager-queue self-clean (item auto-resolve).

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
    status: 'confirmed',
    source_capture_id: null,
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
    listCostCandidates: async () => [],
    listCostEvents: async () => [],
    // The alarm pass's reads — stubbed empty ('t1' is not a uuid; the standing
    // reason). Alarm tests override.
    listNudges: async () => [],
    listOpenObservations: async () => [],
    listDecisions: async () => new Map(),
    findOpenGaps: async () => [],
    resolveGap: async () => null,
    createObservation: async () => null,
    listObserved: async () => [],
    listNudged: async () => [],
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

// The observation fixture (plan 2026-08-31) — what createObservation returns.
function obsRow(over: Partial<Observation> = {}): Observation {
  return {
    id: 'o1',
    tenant_id: 't1',
    kind: 'overdue_visit_gap',
    subject_ref: 'a1',
    technician_id: null,
    status: 'open',
    context: {},
    dismiss_reason: null,
    dismissed_at: null,
    not_before: null,
    noticed_at: '2026-08-15T00:00:00.000Z',
    updated_at: '2026-08-15T00:00:00.000Z',
    ...over,
  } as Observation;
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

  test('max_new_per_tick no longer meters detection — recording is uncapped (plan 2026-08-31)', async () => {
    // The cap metered QUESTIONS — a scarce claim on a person's attention. An
    // observation asks nobody anything, so even a firm that dialled its cap to
    // 2 records every fresh finding. The setting stays declared (build 5 owns
    // retiring it); this pins that it is UNREAD at mint.
    const observed: string[] = [];
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
      createObservation: async (input) => {
        observed.push(input.subjectRef);
        return obsRow({ subject_ref: input.subjectRef });
      },
    }));
    expect(observed).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6']); // ALL seven, oldest first
    expect(summary.observationsCreated).toBe(7);
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
      createObservation: async () => {
        throw new Error('shadow must not write');
      },
      resolveGap: async () => {
        throw new Error('shadow must not resolve');
      },
    }));
    expect(everFlaggedCalls).toBe(1); // the read that makes freshGaps a live predictor
    expect(summary).toMatchObject({
      mode: 'shadow',
      gapsFound: 2,
      freshGaps: 1,
      tenantErrors: 0, // the throwing sentinels would have landed here
    });
  });

  test('live: the pre-filter still excludes ever-surfaced subjects — and every fresh one is recorded', async () => {
    // 7 gaps, the 3 oldest already flagged on earlier (pre-split) ticks. The
    // fresh filter survives the split unchanged; what died is the cap behind
    // it — all four fresh gaps become observations in one tick.
    const observed: string[] = [];
    const seven = Array.from({ length: 7 }, (_, i) =>
      visit({ id: `a${i}`, job_id: `j${i}`, ends_at: `2026-08-15T0${i + 1}:00:00.000Z` }),
    );
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => seven,
      listEverFlagged: async (_t, _k, ids) => ids.filter((id) => ['a0', 'a1', 'a2'].includes(id)),
      createObservation: async (input) => {
        observed.push(input.subjectRef);
        return obsRow({ subject_ref: input.subjectRef });
      },
    }));
    expect(observed).toEqual(['a3', 'a4', 'a5', 'a6']); // fresh only, oldest first, NO cap
    expect(summary.gapsFound).toBe(7);
    expect(summary.freshGaps).toBe(4);
    expect(summary.observationsCreated).toBe(4);
  });

  test('live: every fresh gap is recorded oldest first; context carries the whole story; tech is ADVISORY', async () => {
    const observed: Array<{ subjectRef: string; technicianId: string | null; context: Record<string, unknown> }> = [];
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
      listTeam: async () => [{ id: 'tech-1', ref: 'ben-shelton', display_name: 'Ben Shelton' } as unknown as Technician],
      listJobs: async (_t, ids) =>
        ids.map((id) => ({
          id,
          tenant_id: 't1',
          title: 'Furnace tune-up',
          customers: { name: 'Henderson' },
        }) as unknown as JobWithCustomer),
      createObservation: async (input) => {
        observed.push({
          subjectRef: input.subjectRef,
          technicianId: input.technicianId,
          context: input.context as Record<string, unknown>,
        });
        return obsRow({ subject_ref: input.subjectRef });
      },
    }));
    expect(observed.map((o) => o.subjectRef)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6']);
    expect(summary.observationsCreated).toBe(7);
    // The tech rides along ADVISORILY when known, and its absence is normal.
    expect(observed[0].technicianId).toBe('tech-1');
    expect(observed[0].context).toMatchObject({
      customerName: 'Henderson',
      jobTitle: 'Furnace tune-up',
      technicianRef: 'ben-shelton',
      technicianName: 'Ben Shelton',
      jobId: 'j0',
      startsAtLocal: '2026-08-15T00:00:00.000Z',
      endsAtLocal: '2026-08-15T01:00:00.000Z',
      // The warm wall-clock label — weekday and date from one Intl derivation.
      visitEndLabel: 'Saturday, Aug 15 at 1:00 AM',
    });
    expect(observed[1].technicianId).toBeNull();
    expect(observed[1].context).not.toHaveProperty('technicianRef'); // absent, not null
  });

  test('live: a null create (concurrent notice) is uncounted; ever-flagged is never re-noticed', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => [visit({ id: 'a1' }), visit({ id: 'a2', job_id: 'j2' })],
      createObservation: async (input) =>
        input.subjectRef === 'a1' ? obsRow({ subject_ref: 'a1' }) : null,
    }));
    expect(summary.observationsCreated).toBe(1); // a2 was noticed concurrently — not counted
    expect(summary.gapsFound).toBe(2);
    expect(summary.tenantErrors).toBe(0);

    const quiet = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => [visit({ id: 'a1' })],
      listEverFlagged: async (_t, _k, ids) => ids, // everything already flagged
      createObservation: async () => {
        throw new Error('ever-flagged gaps must not be re-noticed');
      },
    }));
    expect(quiet.freshGaps).toBe(0);
    expect(quiet.observationsCreated).toBe(0);
    // The throwing sentinel is swallowed by the per-tenant catch, so the
    // real assertion is that NO tenant errored — a call would have thrown.
    expect(quiet.tenantErrors).toBe(0);
  });




  test('live auto-resolve: activity AFTER the flag resolves; a status change resolves; jobId-less detail is dropped', async () => {
    // The activity anchor is the FLAG time (final review, build 5): the copy
    // says "after this was flagged", and a flag-time anchor needs no
    // detail.startsAtLocal at all — created_at is a DB column, not
    // watcher-written JSON.
    const resolved: Array<[string, string | null | undefined]> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async () => [
        openItem({ subject_ref: 'a-filled', detail: { jobId: 'j9', startsAtLocal: '2026-08-15T10:00:00.000Z' } }),
        openItem({ subject_ref: 'a-still-open', detail: { jobId: 'j8', startsAtLocal: '2026-08-15T10:00:00.000Z' } }),
        openItem({ subject_ref: 'a-cancelled', detail: { jobId: 'j7', startsAtLocal: '2026-08-15T10:00:00.000Z' } }),
        openItem({ subject_ref: 'a-thin', detail: { jobId: 'j9' } }), // no visit window — still resolvable
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
      ['a-thin', 'field report arrived after this was flagged'],
    ]);
    expect(summary.itemsResolved).toBe(3);
  });

  test('a planner-ESCALATED item never self-cleans on pre-flag activity or the visit status (build 5)', async () => {
    // The archetype escalation IS a completed visit with no report, and the
    // planner escalates DESPITE activity it judged non-answering — resolving
    // on either would eat the handover within one sweep, with the once-ever
    // dedup blocking any re-flag.
    const resolved: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async () => [
        openItem({
          subject_ref: 'a-esc',
          created_at: '2026-08-16T10:00:00.000Z', // flagged at 10:00
          detail: { jobId: 'j-esc', startsAtLocal: '2026-08-15T07:00:00.000Z', escalatedFromNudge: 'n-esc' },
        } as Partial<ReviewItem>),
      ],
      // Activity BEFORE the flag (09:00 < 10:00) — what the planner escalated despite.
      listCaptureTimes: async () => [{ job_id: 'j-esc', captured_at: '2026-08-16T09:00:00.000Z' }],
      listAssignments: async () => [
        visit({ id: 'a-esc', status: 'completed' } as Partial<PlacedAssignment>),
      ],
      resolveGap: async (_t, _k, subjectRef) => {
        resolved.push(subjectRef);
        return openItem({});
      },
    }));
    expect(resolved).toEqual([]); // the handover stands

    // …but genuinely NEW activity (after the flag) does resolve it — the
    // manager's answer arriving is the self-clean the ruling kept.
    const resolvedAfter: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async () => [
        openItem({
          subject_ref: 'a-esc',
          created_at: '2026-08-16T10:00:00.000Z',
          detail: { jobId: 'j-esc', escalatedFromNudge: 'n-esc' },
        } as Partial<ReviewItem>),
      ],
      listCaptureTimes: async () => [{ job_id: 'j-esc', captured_at: '2026-08-16T11:30:00.000Z' }],
      resolveGap: async (_t, _k, subjectRef) => {
        resolvedAfter.push(subjectRef);
        return openItem({});
      },
    }));
    expect(resolvedAfter).toEqual(['a-esc']);
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
    }));
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
    }));
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
    }));
    expect(notes).toEqual(['the job was cancelled after this was flagged']);
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
    }));
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
    }));
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
    }));
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
    }));
    // (2) the visit left 'confirmed'
    await runWatchers(NOW, 'live', baseDeps({
      findOpenGaps: async (_t, kind) =>
        kind === 'overdue_visit_gap'
          ? [openItem({ detail: { jobId: 'j1', startsAtLocal: '2026-08-16T07:00:00.000Z' } })]
          : [],
      listAssignments: async () => [visit({ id: 'a1', status: 'cancelled' })],
      resolveGap,
    }));
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
    itemResolved: () => null,
    ...over,
  });


  test('recording is UNCAPPED — every fresh gap becomes a row (the caps are deleted, build 5)', async () => {
    // Recording is deliberately unbounded (the record is unbounded — user
    // direction); a misfiring detector floods a table nobody is messaged
    // from, and the planner's dismissal is the cleanup verb.
    const created: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      specs: [OVERDUE_VISIT_GAP_SPEC, secondSpec()],
      listOverdue: async () => [
        visit({ id: 'a1', job_id: 'j1', technician_id: 'tech-1', ends_at: '2026-08-15T01:00:00.000Z' }),
        visit({ id: 'a2', job_id: 'j2', technician_id: 'tech-1', ends_at: '2026-08-15T02:00:00.000Z' }),
        visit({ id: 'a3', job_id: 'j3', technician_id: 'tech-1', ends_at: '2026-08-15T03:00:00.000Z' }),
      ],
      listTeam: async () => [boundTech()],
      createObservation: async (input) => {
        created.push(input.subjectRef);
        return obsRow({ subject_ref: input.subjectRef });
      },
    }));
    expect(created).toEqual(['a1', 'a2', 'a3']); // ALL fresh, oldest first — brake of 1 unread
    expect(summary.observationsCreated).toBe(3);
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
      createObservation: async () => {
        throw new Error('must not record an observation for an unregistered kind');
      },
    }));
    expect(summary.tenantErrors).toBe(0);
    expect(summary.observationsCreated).toBe(0);
  });

  test('the tenant-wide ceiling is UNREAD at mint too — nine fresh gaps, nine rows', async () => {
    const routed: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      specs: [OVERDUE_VISIT_GAP_SPEC],
      listOverdue: async () => Array.from({ length: 9 }, (_, i) =>
        visit({ id: `a${i}`, job_id: `j${i}`, ends_at: `2026-08-15T0${i}:00:00.000Z` })),
      createObservation: async (input) => {
        routed.push(input.subjectRef);
        return obsRow({ subject_ref: input.subjectRef });
      },
    }));
    expect(routed.length).toBe(9);
    expect(summary.observationsCreated).toBe(9);
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

  test('a finished job with no cost recorded becomes a cost OBSERVATION, subject = the JOB', async () => {
    const created: Array<Record<string, unknown>> = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [candidate()],
      listTeam: async () => [boundTech()],
      createObservation: async (input) => {
        created.push({ ...input });
        return obsRow({ kind: 'job_cost_gap', subject_ref: 'j-cost' });
      },
    }));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: 'job_cost_gap', subjectRef: 'j-cost', technicianId: 'tech-1' });
    // Context carries everything the planner's view and a later send need —
    // and NO visit window, because the subject is a job.
    expect(created[0].context).toMatchObject({ jobId: 'j-cost', jobTitle: 'Boiler swap', customerName: 'Henderson' });
    expect(summary.byKind['job_cost_gap']).toEqual({ gapsFound: 1, observationsCreated: 1 });
    expect(summary.tenantErrors).toBe(0);
  });

  test('cost observations are created unconditionally — the old mode wrapper is gone (review F2; NUDGES_MODE retired build 5)', async () => {
    // Left standing, `nudgeMode !== 'off'` would have silently produced ZERO
    // cost observations under lifecycle's default. Detection gates on watcher
    // mode alone now.
    const created: string[] = [];
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [candidate()],
      listTeam: async () => [boundTech()],
      createObservation: async (input) => {
        created.push(input.subjectRef);
        return obsRow({ kind: 'job_cost_gap', subject_ref: input.subjectRef });
      },
    })); // nudgeMode defaulted — 'off'
    expect(created).toEqual(['j-cost']);
    expect(summary.byKind['job_cost_gap']).toEqual({ gapsFound: 1, observationsCreated: 1 });
    expect(summary.tenantErrors).toBe(0);
  });

  test('a job that ALREADY has a cost recorded is not a gap', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [candidate()],
      listCostEvents: async () => ['j-cost'], // material_cost already exists
      listTeam: async () => [boundTech()],
      createObservation: async () => {
        throw new Error('a job with a cost recorded must not be noticed as a gap');
      },
    }));
    expect(summary.byKind['job_cost_gap']?.gapsFound ?? 0).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });

  test('ONCE-EVER is real: a job already nudged (pre-split) for cost is never re-noticed', async () => {
    // The accepted limitation (user decision 2026-08-19), store MOVED: noticed
    // once per subject FOREVER. Pre-split nudge history still blocks.
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [candidate()],
      listNudged: async (_t, kind, ids) => (kind === 'job_cost_gap' ? ids : []),
      listTeam: async () => [boundTech()],
      createObservation: async () => {
        throw new Error('once-ever: this job was already surfaced');
      },
    }));
    expect(summary.byKind['job_cost_gap']?.gapsFound ?? 0).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });

  test('ONCE-EVER, the new store: an already-OBSERVED subject is never re-noticed — dismissed included', async () => {
    // listObserved answers ANY status, so a dismissed observation keeps
    // blocking re-notice — which is what makes "dismiss" mean "stop showing me
    // this" rather than "show me again next tick".
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [candidate()],
      listObserved: async (_t, kind, ids) => (kind === 'job_cost_gap' ? ids : []),
      listTeam: async () => [boundTech()],
      createObservation: async () => {
        throw new Error('once-ever: this subject is already in the record');
      },
    }));
    expect(summary.byKind['job_cost_gap']?.gapsFound ?? 0).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });






  test('a cost gap ALREADY on the manager queue is not re-raised as a nudge', async () => {
    // The ever-flagged store is the third filter. Without it a gap the manager
    // is already looking at would be asked about again as if it were new.
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () => [candidate()],
      listEverFlagged: async (_t, kind, ids) => (kind === 'job_cost_gap' ? ids : []),
      listTeam: async () => [boundTech()],
      createObservation: async () => {
        throw new Error('a flagged cost gap must not also be re-noticed');
      },
    }));
    expect(summary.byKind['job_cost_gap']?.gapsFound ?? 0).toBe(0);
    expect(summary.tenantErrors).toBe(0);
  });

  test('the per-kind cost brake is UNREAD at mint — nine candidates, nine observations', async () => {
    // The backstop metered ASKS from a misfiring detector; recording is
    // unbounded by ruling, and the planner's dismissal is the cleanup verb.
    const created: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      listCostCandidates: async () =>
        Array.from({ length: 9 }, (_, i) => candidate({ jobId: `j-cost-${i}` })),
      listTeam: async () => [boundTech()],
      createObservation: async (input) => {
        created.push(input.subjectRef);
        return obsRow({ kind: 'job_cost_gap', subject_ref: input.subjectRef });
      },
    }));
    expect(created).toHaveLength(9); // no brake, no ceiling — nine rows
  });



  test('both passes record everything in ONE tick — no ceiling starves the cost pass any more', async () => {
    // The old shape: 5 visit gaps spent the whole ceiling and the cost pass got
    // none. Now both record in full — the starvation the ceiling caused is gone
    // with the ceiling.
    const created: string[] = [];
    await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => Array.from({ length: 5 }, (_, i) =>
        visit({ id: `a${i}`, job_id: `j${i}`, technician_id: 'tech-1', ends_at: `2026-08-15T0${i}:00:00.000Z` })),
      listCostCandidates: async () => [candidate(), candidate({ jobId: 'j-cost-2' })],
      listTeam: async () => [boundTech()],
      createObservation: async (input) => {
        created.push(input.subjectRef);
        return obsRow({ subject_ref: input.subjectRef });
      },
    }));
    expect(created).toHaveLength(7); // 5 visit + 2 cost
    expect(created.filter((r) => r.startsWith('a'))).toHaveLength(5);
    expect(created.filter((r) => r.startsWith('j-cost'))).toHaveLength(2);
  });

  test('the cost spec is registered in production, not just in tests', async () => {
    expect(JOB_COST_GAP_SPEC.kind).toBe('job_cost_gap');
    expect(JOB_COST_GAP_SPEC.subjectIsVisit).toBe(false);
  });
});

// ── plan 2026-08-22 Phase 2: closing is the planner's, the sweep keeps a fail-safe ──
// Build 5: the sweep decides nothing — the vocabulary pin survives because the
// ALARM pass (Phase 4) is PLANNER_JUDGMENT_ACTIONS' consumer now: "unattended"
// means no applied action from that set inside the window.
// ── The alarm pass (build 5, Phase 4) ────────────────────────────────────────
// Alarm, never actor: three counters, nothing fired, never ok=false.
describe('the alarm pass', () => {
  const hoursAgo = (h: number): string => new Date(Date.parse(NOW) - h * 3_600_000).toISOString();
  const askRow = (over: Partial<Nudge> = {}): Nudge =>
    ({
      id: 'n-old', tenant_id: 't1', kind: 'overdue_visit_gap', subject_ref: 'a-old',
      status: 'asked', asked_at: hoursAgo(ASK_UNATTENDED_ALARM_HOURS + 6),
      created_at: hoursAgo(ASK_UNATTENDED_ALARM_HOURS + 7), context: {},
      serve_count: 0, attempts: 0,
      ...over,
    }) as unknown as Nudge;
  const obsOld = (over: Record<string, unknown> = {}) =>
    ({
      id: 'o-old', tenant_id: 't1', kind: 'overdue_visit_gap', subject_ref: 'a-obs',
      status: 'open', noticed_at: hoursAgo(OBSERVATION_STALE_HOURS + 12), context: {},
      ...over,
    }) as never;
  const applied = (action: string, hAgo: number): NudgeDecision =>
    ({ action, outcome: 'applied', decided_at: hoursAgo(hAgo) }) as unknown as NudgeDecision;

  test('unattended ask, stuck delivery and stale observation each count once', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        askRow(),
        askRow({ id: 'n-stuck', subject_ref: 'a-stuck', status: 'queued', asked_at: null,
          created_at: hoursAgo(DELIVERY_STUCK_ALARM_HOURS + 2) }),
      ],
      listOpenObservations: async () => [obsOld()],
    }));
    expect(summary.alarms).toEqual({ asksUnattended: 1, deliveryStuck: 1, observationsStale: 1 });
    expect(summary.tenantErrors).toBe(0); // an alarm is never an error
  });

  test('an applied judgment inside the window clears the ask alarm; outside it does not', async () => {
    // Driven with `close`, a LIVE verb, deliberately. It used to be `leave` —
    // which still works, because a historic leave counts as attention — but
    // that made the WINDOW's only pin depend on the deleted-verb carve-out
    // below: revisit that carve-out and this test fails for an unrelated
    // reason, and the window loses its pin silently.
    const attended = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askRow()],
      listDecisions: async () => new Map([['n-old', [applied('close', 2)]]]),
    }));
    expect(attended.alarms!.asksUnattended).toBe(0);

    const ancient = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askRow()],
      listDecisions: async () =>
        new Map([['n-old', [applied('close', ASK_UNATTENDED_ALARM_HOURS + 3)]]]),
    }));
    expect(ancient.alarms!.asksUnattended).toBe(1); // untouched WITHIN the window
  });

  // ── build 6 Phase 2: a hold must not switch off a BROKEN-DELIVERY alarm ───
  test('a held QUEUED row still alarms as delivery-stuck; a held PENDING one does not', async () => {
    // The exemption below `deliveryStuckRows` was written when `hold` was
    // pending-only, so a queued row could never carry a live not_before. Phase 2
    // made that reachable — and a queued row is out of the planner's hands:
    // listQueuedNudgesForHost selects on status alone and never reads
    // not_before, so the hold cannot pace the delivery. All it could do is
    // silence the operator's only signal that the box has stopped collecting.
    const stuckQueued = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        askRow({ id: 'n-q', subject_ref: 'a-q', status: 'queued', asked_at: null,
          created_at: hoursAgo(DELIVERY_STUCK_ALARM_HOURS + 2),
          not_before: hoursAgo(-6) }), // held six hours out
      ],
    }));
    expect(stuckQueued.alarms!.deliveryStuck).toBe(1);

    // PENDING keeps the exemption, and keeps it for a real reason: nothing
    // serves a pending row, so the planner really is the only thing that would
    // move it and its hold is the whole story.
    const heldPending = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        askRow({ id: 'n-p', subject_ref: 'a-p', status: 'pending', asked_at: null,
          created_at: hoursAgo(DELIVERY_STUCK_ALARM_HOURS + 2),
          not_before: hoursAgo(-6) }),
      ],
    }));
    expect(heldPending.alarms!.deliveryStuck).toBe(0);
  });

  // ── build 6 Phase 2: a paused question is paced, not neglected ────────────
  test('a HELD asked gap is exempt, and re-enters the moment the hold lapses', async () => {
    // Newly reachable: until Phase 2 `hold` was refused on an asked row, so an
    // asked gap could never carry a live not_before and this filter had nothing
    // to skip. Now that pausing a sent question is a real intent, the alarm has
    // to honour it — otherwise the planner's own decision reads back to the
    // operators as neglect 24 hours later.
    const held = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askRow({ not_before: hoursAgo(-6) })], // six hours out
    }));
    expect(held.alarms!.asksUnattended).toBe(0);

    // A hold that has PASSED is not a hold. The row is back in front of the
    // planner, so it is back in front of the alarm too.
    const lapsed = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askRow({ not_before: hoursAgo(1) })],
    }));
    expect(lapsed.alarms!.asksUnattended).toBe(1);
  });

  // ── build 6: a DELETED verb must not become retrospective neglect ─────────
  test.each(['escalate', 'leave'] as const)(
    'a historic %s still counts as attention on an ask, though the verb is gone',
    async (verb) => {
    // `escalate` left PLANNER_JUDGMENT_ACTIONS when it was deleted, and joined
    // `attentionActions` in the same change — exactly as `extend` did when the
    // escalation clock died. An applied escalate recorded last week WAS a real
    // judgment (it handed the gap to a person), so reclassifying those rows as
    // neglect would have the alarm shout about every gap the planner handed
    // over before this build landed.
    const attended = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askRow()],
      listDecisions: async () => new Map([['n-old', [applied(verb, 2)]]]),
    }));
    expect(attended.alarms!.asksUnattended).toBe(0);

    // The control: a word that was never a verb still alarms, which is what
    // proves the line above is the carve-out and not a broken read.
    const nonsense = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askRow()],
      listDecisions: async () => new Map([['n-old', [applied('not-a-verb', 2)]]]),
    }));
    expect(nonsense.alarms!.asksUnattended).toBe(1);
  });

  // Build 4 semantics, and they outlive the verb: `leaveCounts` still governs
  // which alarm a HISTORIC leave row exempts. The verb is deleted (build 6
  // Phase 2) but the rows are not, and an observation the planner only ever
  // LOOKED at must keep aging.
  test('for observations, a historic leave is looking, not acting', async () => {
    const left = await runWatchers(NOW, 'live', baseDeps({
      listOpenObservations: async () => [obsOld()],
      listDecisions: async () => new Map([['o-old', [applied('leave', 2)]]]),
    }));
    expect(left.alarms!.observationsStale).toBe(1);

    const held = await runWatchers(NOW, 'live', baseDeps({
      listOpenObservations: async () => [obsOld()],
      listDecisions: async () => new Map([['o-old', [applied('hold', 2)]]]),
    }));
    expect(held.alarms!.observationsStale).toBe(0); // a hold IS acting
  });

  test('the serve and attempt caps count as deliveryStuck even on a young row', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        askRow({ id: 'n-poison', subject_ref: 'a-p1', status: 'queued', asked_at: null,
          created_at: hoursAgo(1), serve_count: MAX_SERVE_COUNT }),
        askRow({ id: 'n-refused', subject_ref: 'a-p2', status: 'queued', asked_at: null,
          created_at: hoursAgo(1), attempts: MAX_DELIVERY_ATTEMPTS }),
      ],
    }));
    expect(summary.alarms!.deliveryStuck).toBe(2); // one per trigger, age irrelevant
  });

  test('a failed decisions read counts every candidate — fail TOWARD alarming', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askRow()],
      listOpenObservations: async () => [obsOld()],
      listDecisions: async () => {
        throw new Error('db blip');
      },
    }));
    expect(summary.alarms!.asksUnattended).toBe(1);
    expect(summary.alarms!.observationsStale).toBe(1);
    expect(summary.tenantErrors).toBe(0); // and never reddens
  });

  test('a PLANNER-HELD row is being paced, not stuck — holds exempt both alarms (final review)', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        askRow({ id: 'n-held', status: 'pending', asked_at: null,
          created_at: hoursAgo(40), not_before: '2099-01-01T00:00:00.000Z' } as never),
      ],
      listOpenObservations: async () => [obsOld({ not_before: '2099-01-01T00:00:00.000Z' })],
    }));
    expect(summary.alarms!.deliveryStuck).toBe(0);
    expect(summary.alarms!.observationsStale).toBe(0);
  });

  test('a freshly QUEUED relic anchors on queued_at — no alarm before delivery even starts', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        askRow({ id: 'n-relic', status: 'queued', asked_at: null,
          created_at: hoursAgo(400), queued_at: hoursAgo(1) } as never),
      ],
    }));
    expect(summary.alarms!.deliveryStuck).toBe(0);
  });

  test('the cap triggers read QUEUED rows only — a pending attempts column is the retired compose ledger', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        askRow({ id: 'n-compose', status: 'pending', asked_at: null,
          created_at: hoursAgo(1), attempts: MAX_DELIVERY_ATTEMPTS } as never),
      ],
    }));
    expect(summary.alarms!.deliveryStuck).toBe(0);
  });

  test('a HISTORIC applied extend counts as attention — old judgments are not reclassified', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [askRow()],
      listDecisions: async () => new Map([['n-old', [applied('extend', 2)]]]),
    }));
    expect(summary.alarms!.asksUnattended).toBe(0);
  });

  test('shadow mode carries NO alarms object — never-computed must not read as quiet', async () => {
    const summary = await runWatchers(NOW, 'shadow', baseDeps({}));
    expect(summary.alarms).toBeUndefined();
  });

  test('an alarm-pass failure marks the counts PARTIAL rather than reading quiet', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => {
        throw new Error('db blip');
      },
    }));
    expect(summary.alarmsPartial).toBe(true);
    expect(summary.tenantErrors).toBe(0); // still never an error
  });

  test('the alarm pass survives a DETECTION failure — separate failure domains (final review)', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listOverdue: async () => {
        throw new Error('detection is broken');
      },
      listNudges: async () => [askRow()],
    }));
    expect(summary.tenantErrors).toBe(1); // detection failed…
    expect(summary.alarms!.asksUnattended).toBe(1); // …and the watchdog still counted
  });

  test('young rows alarm nothing', async () => {
    const summary = await runWatchers(NOW, 'live', baseDeps({
      listNudges: async () => [
        askRow({ asked_at: hoursAgo(2), created_at: hoursAgo(3) }),
        askRow({ id: 'n-q', status: 'queued', asked_at: null, created_at: hoursAgo(2) }),
      ],
      listOpenObservations: async () => [obsOld({ noticed_at: hoursAgo(2) })],
    }));
    expect(summary.alarms).toEqual({ asksUnattended: 0, deliveryStuck: 0, observationsStale: 0 });
  });
});

describe('build 5 — the judgment vocabulary', () => {
  test('PLANNER_JUDGMENT_ACTIONS equals the planner verb list exactly, and never the filler', () => {
    expect([...PLANNER_JUDGMENT_ACTIONS].sort()).toEqual([...PLANNER_ACTIONS].sort());
    expect(PLANNER_JUDGMENT_ACTIONS.has('unmentioned')).toBe(false);
    expect(PLANNER_JUDGMENT_ACTIONS.has('extend')).toBe(false); // retired with the clock
    // Build 6. The COUNT is pinned as well as the equality: two sets that drift
    // together are still equal, and seven is the number this build arrives at.
    expect(PLANNER_JUDGMENT_ACTIONS.has('escalate')).toBe(false); // deleted, Phase 1
    expect(PLANNER_JUDGMENT_ACTIONS.has('leave')).toBe(false); // deleted, Phase 2
    // 9 -> 7 in build 6 (escalate, leave), 7 -> 5 in build 6.5 Phase 4 when one
    // `send` absorbed ask_agent and inform_agent, 5 -> 6 in build 7 (`observe`,
    // the only verb that CREATES a gap rather than acting on one).
    expect(PLANNER_ACTIONS).toHaveLength(6);
    expect(PLANNER_JUDGMENT_ACTIONS.has('observe')).toBe(true);
  });
});

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
