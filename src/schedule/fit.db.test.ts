import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from '../db/client.js';
import { setTenantSeats } from '../db/tenants.js';
import {
  insertTechnician,
  setTechnicianAvailability,
  setTechnicianSkills,
  setTechnicianState,
  type Technician,
  type WeeklyPattern,
} from '../db/technicians.js';
import { addTimeOff } from '../db/timeOff.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { createAssignment } from '../db/assignments.js';
import { assembleFitContext, findDisplacementCandidates, generateCandidates } from './fit.js';

// Integration for the fit engine's DB-composing wrapper (Plan 3b Phase 1) —
// local stack, scheduling.test.ts truncate discipline. The PURE engine is
// pinned in fit.test.ts; this file pins what assembleFitContext feeds it:
// who is in/out (and that every exclusion is NAMED, never silent) and how
// real assignment rows become per-day visit context.
const TRUNCATE =
  'truncate table customers, jobs, technicians, technician_time_off, job_type_durations, review_items, schedule_events cascade';

const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

const MON_FRI: WeeklyPattern = {
  mon: [['08:00', '17:00']],
  tue: [['08:00', '17:00']],
  wed: [['08:00', '17:00']],
  thu: [['08:00', '17:00']],
  fri: [['08:00', '17:00']],
  sat: [],
  sun: [],
};

// 2026-08-03 is a Monday; the whole file schedules inside that week.
const WEEK_START = '2026-08-03';
const WEEK_END = '2026-08-07';

let plumber: Technician; // pattern + skills ['plumbing', 'hvac']
let blank: Technician; // pattern + skills never configured (empty)
let sparky: Technician; // pattern + skills ['electrical'] — explicit mismatch
let bare: Technician; // active but NO pattern

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient()
    .from('tenants')
    .select('id')
    .eq('name', 'Default Tenant')
    .single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });

  const mk = async (ref: string, name: string, pattern: WeeklyPattern | null, skills: string[]) => {
    const t = await insertTechnician({ tenantId, ref, displayName: name });
    await setTechnicianState(t.id, 'active');
    if (pattern) await setTechnicianAvailability(t.id, pattern);
    if (skills.length > 0) await setTechnicianSkills(t.id, skills);
    return t;
  };
  plumber = await mk('fit-plumber', 'Fit Plumber', MON_FRI, ['plumbing', 'hvac']);
  blank = await mk('fit-blank', 'Fit Blank', MON_FRI, []);
  sparky = await mk('fit-sparky', 'Fit Sparky', MON_FRI, ['electrical']);
  bare = await mk('fit-bare', 'Fit Bare', null, []);
  // A patterned-but-offboarding tech must be absent from EVERY list — the
  // active filter, not the skills/pattern logic, removes them.
  const gone = await mk('fit-gone', 'Fit Gone', MON_FRI, ['plumbing']);
  await setTechnicianState(gone.id, 'offboarding');
});

afterAll(async () => {
  await pg.query(TRUNCATE);
  await setTenantSeats(tenantId, { managerSeats: 2, technicianSeats: 5 });
  await pg.end();
});

const ctx = (over: Partial<Parameters<typeof assembleFitContext>[0]> = {}) =>
  assembleFitContext({ tenantId, earliest: WEEK_START, latest: WEEK_END, ...over });

async function makeVisit(opts: {
  technicianId: string | null;
  startsAt: string;
  endsAt: string;
  city?: string;
  status?: 'proposed' | 'confirmed';
}) {
  const customer = await createCustomer({
    tenantId,
    name: `Fit cust ${opts.startsAt}`,
    ...(opts.city ? { city: opts.city } : {}),
  });
  const job = await createJob({ tenantId, customerId: customer.id, title: 'fit ctx', status: 'open' });
  return createAssignment({
    tenantId,
    jobId: job.id,
    technicianId: opts.technicianId,
    startsAt: opts.startsAt,
    endsAt: opts.endsAt,
    status: opts.status ?? 'confirmed',
  });
}

describe('assembleFitContext — who is in, who is out, always named', () => {
  test('pattern-less tech lands in skippedNoPattern; offboarding tech is absent everywhere', async () => {
    const c = await ctx();
    expect(c.skippedNoPattern).toEqual([bare.ref]);
    const refs = c.technicians.map((t) => t.ref).sort();
    expect(refs).toEqual([blank.ref, plumber.ref, sparky.ref].sort());
    const everywhere = [...refs, ...c.skippedNoPattern, ...c.skippedSkills, ...c.unknownSkills];
    expect(everywhere).not.toContain('fit-gone');
  });

  test('skills three-state: no requiredSkills → skills never filter', async () => {
    const c = await ctx();
    expect(c.skippedSkills).toEqual([]);
    expect(c.unknownSkills).toEqual([]);
    expect(c.technicians.map((t) => t.ref)).toContain(sparky.ref); // mismatch irrelevant
  });

  test('skills three-state: unknown ≠ unqualified — empty list INCLUDED + flagged; configured mismatch excluded + named', async () => {
    const c = await ctx({ requiredSkills: [' Plumbing '] }); // normalization too
    const refs = c.technicians.map((t) => t.ref);
    expect(refs).toContain(plumber.ref); // configured match
    expect(refs).toContain(blank.ref); // never configured — included, flagged
    expect(c.unknownSkills).toEqual([blank.ref]);
    expect(refs).not.toContain(sparky.ref); // explicit list lacking the skill
    expect(c.skippedSkills).toEqual([sparky.ref]);
  });

  test('technicianRef pin narrows to that person; their skills mismatch is still named', async () => {
    const c = await ctx({ technicianRef: sparky.ref, requiredSkills: ['plumbing'] });
    expect(c.technicians).toEqual([]);
    expect(c.skippedSkills).toEqual([sparky.ref]);
  });

  test('time off excludes the day: the inclusive range lands in timeOffDates and candidates skip it', async () => {
    await addTimeOff({
      tenantId,
      technicianId: plumber.id,
      startsOn: '2026-08-04',
      endsOn: '2026-08-05',
      reason: 'fit test',
    });
    const c = await ctx({ technicianRef: plumber.ref });
    expect(c.technicians[0].timeOffDates).toEqual(new Set(['2026-08-04', '2026-08-05']));

    const cands = generateCandidates({
      todayISO: WEEK_START,
      nowHHMM: '00:00',
      earliest: WEEK_START,
      latest: WEEK_END,
      durationMin: 60,
      durationLabel: '1h check',
      customerCity: null,
      priority: 'routine',
      technicians: c.technicians,
    });
    const dates = new Set(cands.map((x) => x.date));
    expect(dates.has('2026-08-04')).toBe(false);
    expect(dates.has('2026-08-05')).toBe(false);
    expect(dates.has('2026-08-03')).toBe(true);
  });
});

describe('assembleFitContext — assignment rows become day context', () => {
  test('unplaced assigned rows fold into commitmentsByDate across their whole range, never into stops (plan 4b-2)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Fit tbd cust' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'fit tbd', status: 'open' });
    // Tue–Thu unplaced range for sparky + one placed Wednesday visit.
    const tbd = await createAssignment({
      tenantId,
      jobId: job.id,
      technicianId: sparky.id,
      startsAt: null,
      endsAt: null,
      earliestDate: '2026-08-04',
      latestDate: '2026-08-06',
      status: 'confirmed',
    });
    const placedWed = await makeVisit({
      technicianId: sparky.id,
      startsAt: '2026-08-05T09:00:00.000Z',
      endsAt: '2026-08-05T10:00:00.000Z',
    });
    try {
      const c = await ctx({ technicianRef: sparky.ref });
      const sp = c.technicians[0];
      // Load on every covered day; the placed Wednesday visit stacks on top.
      expect(sp.commitmentsByDate.get('2026-08-04')).toBe(1);
      expect(sp.commitmentsByDate.get('2026-08-05')).toBe(2);
      expect(sp.commitmentsByDate.get('2026-08-06')).toBe(1);
      expect(sp.commitmentsByDate.get('2026-08-07')).toBeUndefined();
      // Shape untouched: stops count ONLY the placed visit.
      expect(sp.stopsByDate.get('2026-08-04')).toBeUndefined();
      expect(sp.stopsByDate.get('2026-08-05')).toBe(1);
      // The subject-exclusion also frees an unplaced subject's own load.
      const excluded = await ctx({ technicianRef: sparky.ref, excludeAssignmentId: tbd.id });
      expect(excluded.technicians[0].commitmentsByDate.get('2026-08-04')).toBeUndefined();
      expect(excluded.technicians[0].commitmentsByDate.get('2026-08-05')).toBe(1);
    } finally {
      // Self-clean BOTH rows: the displacement suite shares this week and
      // caps at 5 candidates — a leftover placed visit shifts its ordering.
      await pg.query("update assignments set status = 'cancelled' where id = $1", [tbd.id]);
      await pg.query("update assignments set status = 'cancelled' where id = $1", [placedWed.id]);
    }
  });

  test('confirmed rows only; unassigned rows block nobody; city rides lowercased; excludeAssignmentId frees the subject', async () => {
    const mine = await makeVisit({
      technicianId: plumber.id,
      startsAt: '2026-08-03T09:00:00.000Z',
      endsAt: '2026-08-03T11:00:00.000Z',
      city: ' Springfield ',
    });
    await makeVisit({
      technicianId: plumber.id,
      startsAt: '2026-08-03T13:00:00.000Z',
      endsAt: '2026-08-03T14:00:00.000Z',
      status: 'proposed', // not confirmed → invisible to the fit context
    });
    await makeVisit({
      technicianId: null, // parked visit — must not appear in ANY tech's day
      startsAt: '2026-08-03T15:00:00.000Z',
      endsAt: '2026-08-03T16:00:00.000Z',
    });

    const c = await ctx({ technicianRef: plumber.ref });
    const p = c.technicians[0];
    expect(p.visitsByDate.get('2026-08-03')).toEqual([{ start: '09:00', end: '11:00' }]);
    expect(p.stopsByDate.get('2026-08-03')).toBe(1);
    expect(p.citiesByDate.get('2026-08-03')).toEqual(new Set(['springfield']));

    // The assignmentId ask: the subject's own row must not block the gaps it
    // would vacate.
    const excluded = await ctx({ technicianRef: plumber.ref, excludeAssignmentId: mine.id });
    expect(excluded.technicians[0].visitsByDate.get('2026-08-03')).toBeUndefined();
    expect(excluded.technicians[0].stopsByDate.get('2026-08-03')).toBeUndefined();
  });

  test('a row ending exactly at midnight (real wire format) blocks its evening, never the next day', async () => {
    // Round-trips through PostgREST, so the row arrives in the actual
    // '+00:00' serialization — the format the string-comparison bug
    // misclassified (Phase-1 review finding).
    await makeVisit({
      technicianId: blank.id,
      startsAt: '2026-08-05T22:00:00.000Z',
      endsAt: '2026-08-06T00:00:00.000Z',
    });
    const c = await ctx({ technicianRef: blank.ref });
    const b = c.technicians[0];
    expect(b.visitsByDate.get('2026-08-05')).toEqual([{ start: '22:00', end: '24:00' }]);
    expect(b.visitsByDate.get('2026-08-06')).toBeUndefined();
  });
});

describe('findDisplacementCandidates', () => {
  test('displacement candidates order EARLIEST FIRST and never include the asker', async () => {
    const earlier = await makeVisit({
      technicianId: sparky.id,
      startsAt: '2026-08-04T08:00:00.000Z',
      endsAt: '2026-08-04T10:00:00.000Z',
    });
    const later = await makeVisit({
      technicianId: sparky.id,
      startsAt: '2026-08-06T08:00:00.000Z',
      endsAt: '2026-08-06T10:00:00.000Z',
    });

    // Rung 9a: the promise-graded tiebreak is gone, so start time is the whole
    // rule — the Aug 4 row now sorts ahead of the Aug 6 one.
    const out = await findDisplacementCandidates(tenantId, WEEK_START, WEEK_END);
    const ids = out.map((d) => d.assignmentId);
    expect(ids.indexOf(earlier.id)).toBeLessThan(ids.indexOf(later.id));

    // An assignmentId ask's own subject never appears — a visit cannot be
    // proposed as displacement to make room for itself.
    const excluded = await findDisplacementCandidates(tenantId, WEEK_START, WEEK_END, 5, later.id);
    expect(excluded.map((d) => d.assignmentId)).not.toContain(later.id);
    expect(excluded.map((d) => d.assignmentId)).toContain(earlier.id);
    const p = out.find((d) => d.assignmentId === earlier.id);
    expect(p).toMatchObject({
      technicianRef: sparky.ref,
      day: '2026-08-04',
      weekday: 'Tue', // server-computed — the agent never does calendar math
      span: '08:00–10:00',
    });
    expect(p?.customer).toContain('Fit cust');
  });
});
