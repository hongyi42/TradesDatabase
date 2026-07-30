import { describe, expect, test } from 'vitest';
import {
  assessStagedFreeze,
  assessStagedResolve,
  FREEZE_PROPOSAL_TTL_MS,
  projectFreezeProposal,
  type FreezeProposalView,
} from './freezeProposal.js';
import { PINNED_SKIP_REASON, type FreezePlan, type ResolvePlan } from './freezeSolve.js';
import type { ReviewItem } from '../db/reviewItems.js';

// Pure-state matrix for the board's proposal view — no DB. The endpoint's
// auth/wiring (401/403 + live reads) is covered in boardApi.test.ts; every
// projection rule lives here so a state regression fails in milliseconds.

const NOW = Date.parse('2026-07-27T12:00:00.000Z');

const plan = (over: Partial<FreezePlan> = {}): FreezePlan => ({
  horizonFrom: '2026-07-27',
  horizonTo: '2026-08-09',
  placements: [
    {
      kind: 'unscheduled_job',
      jobId: 'job-1',
      assignmentId: null,
      customer: 'Ada Diaz',
      jobTitle: 'Water heater swap',
      technicianRef: 'mike-c',
      date: '2026-08-05',
      startTime: '09:00',
      endTime: '10:30',
    },
  ],
  skipped: [
    { ref: 'a-pin', label: 'Pinned Pete — boiler', reason: PINNED_SKIP_REASON },
    { ref: 'a-len', label: 'Len Less — drain', reason: 'no length set — ask and record it' },
  ],
  capacity: [
    { technicianRef: 'mike-c', technicianName: 'Mike Chen', committedMin: 90, availableMin: 480 },
  ],
  ...over,
});

// Only the fields the projection reads matter; the rest of the row envelope
// is inert. Cast through unknown so the fixture stays honest about that.
const row = (detail: unknown): ReviewItem =>
  ({ id: 'row-id', tenant_id: 't', kind: 'pending_freeze', detail }) as unknown as ReviewItem;

const staged = (agoMs: number, version = 7, p: FreezePlan = plan()) =>
  row({
    plan: p,
    scheduleVersion: version,
    stagedAt: new Date(NOW - agoMs).toISOString(),
  });

describe('assessStagedResolve (plan 2026-07-30: the generalized kernel)', () => {
  const resolvePlan = (over: Partial<ResolvePlan> = {}): ResolvePlan => ({
    ...plan(),
    moves: [
      {
        assignmentId: 'a-mv',
        jobId: 'job-mv',
        customer: 'Move Marta',
        jobTitle: 'panel check',
        fromTechnicianRef: 'mike-c',
        fromDate: '2026-08-04',
        fromStart: '09:00',
        fromEnd: '10:00',
        toTechnicianRef: 'mike-c',
        toDate: '2026-08-05',
        toStartTime: '13:00',
        toEndTime: '14:00',
      },
    ],
    keptCount: 4,
    ...over,
  });
  const detailOf = (agoMs: number, version = 7, p: ResolvePlan = resolvePlan()) => ({
    plan: p,
    scheduleVersion: version,
    stagedAt: new Date(NOW - agoMs).toISOString(),
  });

  test('a valid resolve detail is open; expiry and version verdicts pass through the freeze kernel', () => {
    const open = assessStagedResolve(detailOf(60_000), 7, NOW);
    expect(open.verdict).toBe('open');
    if (open.verdict === 'open') {
      expect(open.detail.plan.moves).toHaveLength(1);
      expect(open.detail.plan.keptCount).toBe(4);
    }
    expect(assessStagedResolve(detailOf(FREEZE_PROPOSAL_TTL_MS + 1), 7, NOW).verdict).toBe('expired');
    expect(assessStagedResolve(detailOf(60_000, 3), 7, NOW)).toEqual({
      verdict: 'stale',
      pinnedVersion: 3,
      currentVersion: 7,
    });
  });

  test('a freeze-shaped detail (no moves/keptCount) is MALFORMED for the resolve kind — it must dismiss, never commit as a zero-move run', () => {
    const freezeShaped = { plan: plan(), scheduleVersion: 7, stagedAt: new Date(NOW).toISOString() };
    expect(assessStagedResolve(freezeShaped, 7, NOW).verdict).toBe('malformed');
    // …while the FREEZE kernel still accepts a resolve detail (extra fields
    // are inert to it) — byte-compatible in that direction.
    expect(assessStagedFreeze(detailOf(60_000), 7, NOW).verdict).toBe('open');
  });

  test('junk shapes are malformed for both kernels alike', () => {
    for (const junk of [null, 42, 'x', [], { plan: { placements: [], skipped: [], capacity: [] } }]) {
      expect(assessStagedResolve(junk, 7, NOW).verdict).toBe('malformed');
    }
  });
});

describe('projectFreezeProposal', () => {
  test('no open items → none, with chat-pointing copy', () => {
    const v = projectFreezeProposal([], 7, NOW);
    expect(v.state).toBe('none');
    expect((v as { message: string }).message).toContain('run the freeze in chat');
  });

  test('fresh + version-matched → open, with weekday, pinnedCount, expiresAt — and NO confirm handle', () => {
    const v = projectFreezeProposal([staged(60_000)], 7, NOW);
    expect(v.state).toBe('open');
    const open = v as Extract<FreezeProposalView, { state: 'open' }>;
    expect(open.placements[0].weekday).toBe('Wed'); // 2026-08-05, server-computed (house rule)
    expect(open.placements[0].startTime).toBe('09:00');
    // Exact-match on the exported constant, never a substring grep.
    expect(open.pinnedCount).toBe(1);
    expect(Date.parse(open.expiresAt) - Date.parse(open.stagedAt)).toBe(FREEZE_PROPOSAL_TTL_MS);
    expect(open.horizonFrom).toBe('2026-07-27');
    expect(open.capacity[0].committedMin).toBe(90);
    // The ritual doctrine: the page must not leak a confirm handle.
    const leaked = JSON.stringify(open);
    expect(leaked).not.toContain('confirmId');
    expect(leaked).not.toContain('row-id');
  });

  test('older than the TTL → expired (checked BEFORE the version pin)', () => {
    // Version mismatched too — expiry must win so the copy says "expired",
    // not "schedule changed" (mirrors the confirm branch's guard order).
    const v = projectFreezeProposal([staged(FREEZE_PROPOSAL_TTL_MS + 1, 999)], 7, NOW);
    expect(v.state).toBe('expired');
    expect((v as { message: string }).message).toContain('12 hours');
  });

  test('version drift → stale, with the will-refuse warning', () => {
    const v = projectFreezeProposal([staged(60_000, 6)], 7, NOW);
    expect(v.state).toBe('stale');
    expect((v as { message: string }).message).toContain('schedule changed');
  });

  test('malformed details degrade to none — no plan, bad version, missing or garbage stagedAt', () => {
    const good = plan();
    for (const detail of [
      null,
      'not-an-object',
      {},
      { plan: good, scheduleVersion: '7', stagedAt: new Date(NOW).toISOString() },
      { plan: good, scheduleVersion: 7 }, // stagedAt missing — the confirm path's `d.stagedAt &&` guard
      { plan: good, scheduleVersion: 7, stagedAt: 'not-a-date' }, // would serve expiresAt: NaN as open
      // Shapeless plan object: truthy but arrayless — must degrade, not throw
      // (the endpoint's "never 500 on stored junk" contract).
      { plan: {}, scheduleVersion: 7, stagedAt: new Date(NOW).toISOString() },
    ]) {
      expect(projectFreezeProposal([row(detail)], 7, NOW).state).toBe('none');
    }
  });

  test('assessStagedFreeze (the kernel BOTH the confirm branch and the board consume): a corrupt token never books', () => {
    // The old inline confirm guard (`d.stagedAt &&`) let a missing-stagedAt
    // row sail past expiry into a booking; the shared kernel calls it
    // malformed — the confirm dismisses instead of committing (and the board
    // agrees, showing none). One rule, two surfaces, by construction.
    expect(assessStagedFreeze({ plan: plan(), scheduleVersion: 7 }, 7, NOW).verdict).toBe('malformed');
    expect(assessStagedFreeze({ plan: {}, scheduleVersion: 7, stagedAt: new Date(NOW).toISOString() }, 7, NOW).verdict).toBe('malformed');
    const open = assessStagedFreeze(
      { plan: plan(), scheduleVersion: 7, stagedAt: new Date(NOW).toISOString() },
      7,
      NOW,
    );
    expect(open.verdict).toBe('open');
    const stale = assessStagedFreeze(
      { plan: plan(), scheduleVersion: 6, stagedAt: new Date(NOW).toISOString() },
      7,
      NOW,
    );
    expect(stale).toMatchObject({ verdict: 'stale', pinnedVersion: 6, currentVersion: 7 });
  });

  test('two open tokens (per-subject index anomaly) → newest stagedAt wins; invalid rows never outrank valid ones', () => {
    const older = staged(3_600_000, 7, plan({ horizonFrom: '2026-07-20' }));
    const newer = staged(60_000, 7, plan({ horizonFrom: '2026-07-27' }));
    const junk = row({ plan: plan(), scheduleVersion: 7, stagedAt: 'garbage' });
    const v = projectFreezeProposal([older, junk, newer], 7, NOW);
    expect(v.state).toBe('open');
    expect((v as Extract<FreezeProposalView, { state: 'open' }>).horizonFrom).toBe('2026-07-27');
  });
});
