import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { createTenant } from './tenants.js';
import { createCustomer } from './customers.js';
import { createJob } from './jobs.js';
import { createVisit } from './visits.js';

// THE LOCAL DAY IS THE STORED WALL CLOCK — pinned against the real database.
//
// This suite exists because of a live defect. `visits.starts_at` is NAIVE-LOCAL:
// the firm's wall clock written as if it were UTC, the '+00' a deliberate lie
// (20260714120000:11). From 2026-08-06 to 2026-09-16 the schedule views derived
// their day column as `(starts_at at time zone tn.timezone)::date` — converting
// it AS IF it were a real instant. For a Pacific firm that shifts a 06:00 visit
// back seven hours onto the PREVIOUS day; for a UTC+ firm a late-evening visit
// lands on the NEXT one.
//
// It survived SEVEN migrations and six weeks. Nothing caught it, and nothing
// could have: `create or replace view` restates the whole body, so each of the
// six copies faithfully reproduced a line whose migration was about something
// else entirely (dropping a column, excluding cancelled rows, renaming a
// table). Postgres itself endorses the expression — `timestamptz at time zone
// X` is the correct, idiomatic way to get a local date, and Postgres has no way
// to know this particular timestamptz is not an instant. The DECLARED COLUMN
// TYPE is what lies, so every check downstream of it agreed.
//
// WHY THE ASSERTIONS NAME LITERAL DAYS. The obvious test — compare local_day
// against `starts_at at time zone 'UTC'` — would re-derive the answer the same
// way the view does, and pass just as happily if both were wrong. So each case
// carries the day and weekday a HUMAN can read off the fixture it inserted.
// The firm's timezone is set to a real, non-UTC zone on purpose: under 'UTC' a
// reintroduced conversion is a no-op and the whole suite goes green while the
// bug is back.
const pg = new Client({ connectionString: process.env.DATABASE_URL });

const FIRM_TZ = 'America/Los_Angeles';

let tenantId: string;
let jobId: string;

// Each case is (what was stored) → (the day and weekday it IS, by construction:
// the stored digits are the firm's wall clock). `note` says what the old, wrong
// view produced — the value this case exists to refuse.
const CASES = [
  {
    startsAt: '2026-09-15T06:00:00.000Z',
    day: '2026-09-15',
    weekday: 'Tuesday',
    note: 'the recorded defect: a 6 AM visit read as 2026-09-14 (Monday) for a Pacific firm',
  },
  {
    startsAt: '2026-09-15T23:00:00.000Z',
    day: '2026-09-15',
    weekday: 'Tuesday',
    note: 'the other direction: an 11 PM visit rolls to the NEXT day for a UTC+ firm',
  },
  {
    startsAt: '2026-11-01T01:30:00.000Z',
    day: '2026-11-01',
    weekday: 'Sunday',
    note: 'US fall-back day — 01:30 local happens twice, but a wall clock has no ambiguity to resolve',
  },
  {
    startsAt: '2026-09-15T14:00:00.000Z',
    day: '2026-09-15',
    weekday: 'Tuesday',
    note: 'CONTROL: mid-afternoon survives a 7h shift within the same day, so it passes either way — its job is to prove the cases above are the ones doing the work',
  },
];

const visitIds = new Map<string, string>(); // startsAt → visit id
let cancelledVisitId: string;

beforeAll(async () => {
  await pg.connect();
  const tenant = await createTenant('schedule-views-local-day');
  tenantId = tenant.id;
  // createTenant takes no timezone, and the column default is already Pacific —
  // set it explicitly anyway, so this suite states its own premise instead of
  // inheriting one a future migration could change out from under it.
  await pg.query('update tenants set timezone = $1 where id = $2', [FIRM_TZ, tenantId]);

  const customer = await createCustomer({ tenantId, name: 'Local Day Cust' });
  const job = await createJob({
    tenantId,
    customerId: customer.id,
    title: 'local day job',
    status: 'open',
  });
  jobId = job.id;

  for (const c of CASES) {
    const visit = await createVisit({
      tenantId,
      jobId,
      technicianId: null,
      startsAt: c.startsAt,
      endsAt: c.startsAt.replace(/T(\d{2})/, (_m, h) => `T${String(Number(h) + 1).padStart(2, '0')}`),
      status: 'confirmed',
    });
    visitIds.set(c.startsAt, visit.id);
  }

  // v_cancelled_visits derives its day the same way and was fixed in the same
  // migration, so it gets the defect's own case rather than a mid-day one.
  const cancelled = await createVisit({
    tenantId,
    jobId,
    technicianId: null,
    startsAt: '2026-09-15T06:00:00.000Z',
    endsAt: '2026-09-15T07:00:00.000Z',
    status: 'cancelled',
  });
  cancelledVisitId = cancelled.id;
});

afterAll(async () => {
  // The tenant row is left behind, like every other suite here. Nothing below
  // reads a tenant by `limit(1)` — that is the shape that picked up a stray
  // UTC tenant and made ten suites fail only after 5pm Pacific (e8efdd4).
  await pg.query('truncate table customers, jobs, visits cascade');
  await pg.end();
});

// The spine views are tenant-gated by a TRANSACTION-LOCAL GUC
// (`current_setting('spine.tenant_id')`, 20260806120000:72), which query_spine
// sets with `set_config(..., true)`. Reading the view directly — rather than
// through query_spine — means setting it the same way, and keeps this suite
// pointed at the VIEW rather than at the RPC that wraps it.
const dayRow = async (
  view: 'v_schedule' | 'v_cancelled_visits',
  visitId: string,
): Promise<{ local_day: string; local_weekday: string; stored: string }> => {
  await pg.query('begin');
  try {
    await pg.query("select set_config('spine.tenant_id', $1, true)", [tenantId]);
    const { rows } = await pg.query<{ local_day: string; local_weekday: string; stored: string }>(
      `select to_char(local_day, 'YYYY-MM-DD') as local_day,
              trim(local_weekday)              as local_weekday,
              to_char(starts_at, 'YYYY-MM-DD"T"HH24:MI:SS') as stored
         from ${view}
        where visit_id = $1`,
      [visitId],
    );
    expect(rows, `${view} must return exactly one row for ${visitId}`).toHaveLength(1);
    return rows[0];
  } finally {
    await pg.query('rollback'); // read-only; nothing to keep
  }
};

describe('v_schedule.local_day is the stored wall clock, never a conversion of it', () => {
  for (const c of CASES) {
    test(`${c.startsAt} → ${c.day} (${c.weekday}) — ${c.note}`, async () => {
      const row = await dayRow('v_schedule', visitIds.get(c.startsAt) as string);
      expect(row.local_day, `local_day for a visit stored at ${c.startsAt}`).toBe(c.day);
      expect(row.local_weekday, `local_weekday for ${c.day}`).toBe(c.weekday);
      // And the view must not have moved the timestamp it passes through
      // either — the day column is derived, starts_at is carried verbatim.
      expect(row.stored.slice(0, 10)).toBe(c.day);
    });
  }

  test('the firm really is on a non-UTC zone, or none of the above proves anything', async () => {
    const { rows } = await pg.query<{ timezone: string }>(
      'select timezone from tenants where id = $1',
      [tenantId],
    );
    expect(rows[0].timezone).toBe(FIRM_TZ);
    // A reintroduced `at time zone <firm tz>` must actually CHANGE the answer
    // here, or these tests are green for the wrong reason. This is the shift
    // the defect applied, computed independently of the view.
    const { rows: shifted } = await pg.query<{ wrong_day: string }>(
      `select to_char((timestamptz '2026-09-15T06:00:00.000Z' at time zone $1)::date, 'YYYY-MM-DD')
                as wrong_day`,
      [FIRM_TZ],
    );
    expect(shifted[0].wrong_day, 'the buggy derivation must land on a DIFFERENT day').toBe(
      '2026-09-14',
    );
  });
});

describe('v_cancelled_visits derives its day the same way', () => {
  test('2026-09-15T06:00 → 2026-09-15 (Tuesday), not the previous day', async () => {
    const row = await dayRow('v_cancelled_visits', cancelledVisitId);
    expect(row.local_day).toBe('2026-09-15');
    expect(row.local_weekday).toBe('Tuesday');
  });
});
