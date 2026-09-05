import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, eachDay, weekdayIndexOf } from './clock.js';
import {
  buildWorldSpec,
  FIXTURE_POOLS,
  FIXTURE_TIERS,
  HORIZON_DAYS,
  isPlacedSpec,
  visitEndTime,
  visitRange,
  type DayKey,
  type TenantSpec,
  type WorldSpec,
} from './worldSpec.js';

// The whole point of an anchor-relative world is that it holds on ANY day. So
// every invariant below runs against a deliberately hostile set of anchors —
// a weekend, a month end, a year rollover, a leap year — not just today.
// If the generator can only produce a valid world on a Wednesday, that is a bug
// that would otherwise surface as a mystery failure months from now.
const ANCHORS = [
  '2026-08-12', // Wednesday, mid-month — the ordinary case
  '2026-08-15', // Saturday
  '2026-08-16', // Sunday
  '2026-08-31', // month end (Monday)
  '2026-12-28', // spans the year rollover
  '2028-02-26', // leap year, spans Feb 29
  '2026-11-27', // day after US Thanksgiving, spans a month end
];

const DAY_KEYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dayKeyOf = (iso: string): DayKey => DAY_KEYS[weekdayIndexOf(iso)];

const worlds = ANCHORS.map((anchor) => ({ anchor, world: buildWorldSpec({ anchor }) }));
const eachWorld = (fn: (w: WorldSpec, anchor: string) => void) => {
  for (const { anchor, world } of worlds) fn(world, anchor);
};
const eachTenant = (fn: (t: TenantSpec, w: WorldSpec, anchor: string) => void) =>
  eachWorld((w, anchor) => {
    for (const t of w.tenants) fn(t, w, anchor);
  });

describe('buildWorldSpec — reproducibility', () => {
  it('is deterministic for the same (anchor, seed)', () => {
    expect(buildWorldSpec({ anchor: '2026-08-12', seed: 7 })).toEqual(
      buildWorldSpec({ anchor: '2026-08-12', seed: 7 }),
    );
  });

  it('varies with the seed', () => {
    const a = buildWorldSpec({ anchor: '2026-08-12', seed: 1 });
    const b = buildWorldSpec({ anchor: '2026-08-12', seed: 2 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('shifts wholesale with the anchor', () => {
    const a = buildWorldSpec({ anchor: '2026-08-12' });
    const b = buildWorldSpec({ anchor: '2026-08-19' }); // exactly +7d, same weekday
    // A multiple-of-7 shift must preserve the shape and move every date in step —
    // the same property that makes a schedule shift safe.
    expect(b.tenants[0].visits.length).toBe(a.tenants[0].visits.length);
    expect(daysBetween(a.span.from, b.span.from)).toBe(7);
  });
});

describe('buildWorldSpec — referential integrity', () => {
  it('every reference resolves', () => {
    eachTenant((t, _w, anchor) => {
      const where = `${t.name} @ ${anchor}`;
      const captures = new Set(t.captures.map((c) => c.key));
      const customers = new Set(t.customers.map((c) => c.key));
      const jobs = new Set(t.jobs.map((j) => j.key));
      const refs = new Set(t.technicians.map((x) => x.ref));

      for (const c of t.customers) {
        if (c.sourceCapture) expect(captures, `${where} customer ${c.key}`).toContain(c.sourceCapture);
        for (const f of c.facts) expect(captures, `${where} fact ${f.key}`).toContain(f.evidence);
      }
      for (const j of t.jobs) {
        expect(customers, `${where} job ${j.key}`).toContain(j.customerKey);
        if (j.sourceCapture) expect(captures, `${where} job ${j.key}`).toContain(j.sourceCapture);
        for (const f of j.facts) expect(captures, `${where} job fact ${f.key}`).toContain(f.evidence);
      }
      for (const v of t.visits) {
        expect(jobs, `${where} visit ${v.key}`).toContain(v.jobKey);
        if (v.technicianRef !== null) expect(refs, `${where} visit ${v.key}`).toContain(v.technicianRef);
      }
      for (const c of t.captures) {
        if (c.customerKey) expect(customers, `${where} capture ${c.key}`).toContain(c.customerKey);
        if (c.jobKey) expect(jobs, `${where} capture ${c.key}`).toContain(c.jobKey);
      }
      for (const o of t.timeOff) expect(refs, `${where} time-off`).toContain(o.technicianRef);
    });
  });

  it('has no duplicate keys', () => {
    eachTenant((t, _w, anchor) => {
      for (const [label, keys] of [
        ['captures', t.captures.map((x) => x.key)],
        ['customers', t.customers.map((x) => x.key)],
        ['jobs', t.jobs.map((x) => x.key)],
        ['visits', t.visits.map((x) => x.key)],
        ['technicians', t.technicians.map((x) => x.ref)],
      ] as const) {
        expect(new Set(keys).size, `${t.name} @ ${anchor} ${label}`).toBe(keys.length);
      }
    });
  });

  it('never repeats a customer NAME — the fixture name cursor must not wrap', () => {
    // FIXTURE_NAMES is consumed `% length`, so a pool expansion that outgrows
    // the list would silently reuse names — recreating the two-customers-one-
    // name ambiguity that broke a real run. Two tiers × the per-tier pools must
    // stay within the list, and this pins it.
    eachTenant((t, _w, anchor) => {
      const names = t.customers.map((c) => c.name);
      expect(new Set(names).size, `${t.name} @ ${anchor} customer names`).toBe(names.length);
    });
  });
});

describe('buildWorldSpec — every visit is a legal row', () => {
  it('is fully placed or fully untimed (the createAssignment contract)', () => {
    eachTenant((t, _w, anchor) => {
      for (const v of t.visits) {
        // Rung 9a: a visit has a time or it does not — there is no third
        // (windowed) shape, so the rule is that the time fields arrive
        // together or not at all. createAssignment throws on a half-timed row.
        const parts = [v.date, v.startTime, v.durationMinutes].filter((x) => x !== undefined);
        expect(
          parts.length === 3 || parts.length === 0,
          `${t.name} @ ${anchor} visit ${v.key}`,
        ).toBe(true);
      }
    });
  });

  it('never books a technician outside their own availability pattern', () => {
    eachTenant((t, _w, anchor) => {
      const byRef = new Map(t.technicians.map((x) => [x.ref, x]));
      for (const v of t.visits) {
        if (!isPlacedSpec(v) || v.technicianRef === null) continue;
        const tech = byRef.get(v.technicianRef)!;
        const windows = tech.availability?.[dayKeyOf(v.date!)] ?? [];
        const where = `${t.name} @ ${anchor}: ${v.key} (${v.technicianRef} on ${v.date})`;
        // A world that books someone on a day its own pattern marks unschedulable
        // is self-contradicting, and every find_slots/freeze answer graded against
        // it would be nonsense.
        expect(windows.length, `${where} — day not in pattern`).toBeGreaterThan(0);
        const start = v.startTime!;
        const end = visitEndTime(v);
        const fits = windows.some(([from, to]) => start >= from && end <= to);
        expect(fits, `${where} — ${start}-${end} outside ${JSON.stringify(windows)}`).toBe(true);
      }
    });
  });

  it('never books a technician on their own time off', () => {
    eachTenant((t, _w, anchor) => {
      for (const o of t.timeOff) {
        const off = new Set(eachDay(o.startsOn, o.endsOn));
        for (const v of t.visits) {
          if (v.technicianRef !== o.technicianRef || !isPlacedSpec(v)) continue;
          expect(off.has(v.date!), `${t.name} @ ${anchor}: ${v.key} lands on time off`).toBe(false);
        }
      }
    });
  });

  it('never overlaps two placed visits for one technician', () => {
    // no_confirmed_overlap is a non-deferrable GiST exclusion constraint: an
    // overlap here does not produce a bad world, it CRASHES generation. Catching
    // it in a unit test costs milliseconds; catching it at runtime costs a
    // half-built database.
    eachTenant((t, _w, anchor) => {
      const lanes = new Map<string, { key: string; startsAt: string; endsAt: string }[]>();
      for (const v of t.visits) {
        if (!isPlacedSpec(v) || v.technicianRef === null) continue;
        const lane = lanes.get(v.technicianRef) ?? [];
        lane.push({ key: v.key, ...visitRange(v) });
        lanes.set(v.technicianRef, lane);
      }
      for (const [ref, lane] of lanes) {
        lane.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
        for (let i = 1; i < lane.length; i++) {
          expect(
            lane[i].startsAt >= lane[i - 1].endsAt,
            `${t.name} @ ${anchor}: ${ref} — ${lane[i - 1].key} (${lane[i - 1].startsAt}..${lane[i - 1].endsAt}) overlaps ${lane[i].key} (${lane[i].startsAt})`,
          ).toBe(true);
        }
      }
    });
  });
});

describe('buildWorldSpec — the planted edges', () => {
  it('plants every edge on every anchor', () => {
    eachWorld((w, anchor) => {
      for (const [key, value] of Object.entries(w.edges)) {
        expect(value, `${key} @ ${anchor}`).toBeTruthy();
      }
      expect(Object.keys(w.edges).sort()).toEqual([
        'beyondHorizonVisit',
        'crossTenantCanary',
        'durationlessJob',
        'horizonEdgeVisit',
        'noAddressCustomer',
        'retractFoldCapture',
        'richHistoryCustomer',
        'sameSurnameA',
        'sameSurnameB',
        'silentRecordCustomer',
      ]);
    });
  });

  it('puts the horizon edge inside the horizon and the other one past it', () => {
    eachWorld((w, anchor) => {
      const inside = daysBetween(anchor, w.edges.horizonEdgeVisit);
      const beyond = daysBetween(anchor, w.edges.beyondHorizonVisit);
      // The technician read must SHOW the inside one and refuse the outside one.
      // Stepping forward off a weekend used to push "inside" past the horizon,
      // silently inverting the scenario — hence the assertion, not a comment.
      expect(inside, `inside @ ${anchor}`).toBeLessThan(HORIZON_DAYS);
      expect(beyond, `beyond @ ${anchor}`).toBeGreaterThan(HORIZON_DAYS);
      expect(w.edges.horizonEdgeVisit).not.toBe(w.edges.beyondHorizonVisit);
    });
  });

  it('makes the same-surname pair the ONLY source of that surname', () => {
    // The planted ambiguity has to be the only ambiguity, or find_customer is
    // graded against a question with more right answers than anyone decided.
    // A random base customer named Whitfield made it a four-way collision once.
    eachWorld((w, anchor) => {
      const surname = w.edges.sameSurnameA.split(' ').pop()!;
      for (const t of w.tenants) {
        const sharing = t.customers.filter((c) => c.name.endsWith(surname));
        const expected = t.key === 'main' ? 2 : 0;
        expect(sharing.length, `${t.name} @ ${anchor} '${surname}'`).toBe(expected);
      }
    });
  });

  it('keeps the no-address customer address-free', () => {
    eachWorld((w, anchor) => {
      const main = w.tenants.find((t) => t.key === 'main')!;
      const c = main.customers.find((x) => x.name === w.edges.noAddressCustomer)!;
      expect(c, `@ ${anchor}`).toBeDefined();
      expect(c.addressLine1).toBeNull();
      expect(c.city).toBeNull();
    });
  });

  it('gives the rich-history customer facts whose evidence can be retracted', () => {
    eachWorld((w) => {
      const main = w.tenants.find((t) => t.key === 'main')!;
      const rich = main.customers.find((x) => x.name === w.edges.richHistoryCustomer)!;
      expect(rich.facts.length).toBeGreaterThanOrEqual(3);
      // Every fact cites the capture the retract scenario targets, so
      // willAlsoRemove has something real to list.
      expect(rich.facts.every((f) => f.evidence === w.edges.retractFoldCapture)).toBe(true);
      const jobs = main.jobs.filter((j) => j.customerKey === rich.key);
      expect(jobs.length).toBeGreaterThanOrEqual(3);
      const visits = main.visits.filter((v) => jobs.some((j) => j.key === v.jobKey));
      expect(visits.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('leaves the duration-less job with no duration', () => {
    eachWorld((w) => {
      const main = w.tenants.find((t) => t.key === 'main')!;
      const job = main.jobs.find((j) => j.title === w.edges.durationlessJob)!;
      expect(job.durationMinutes).toBeNull();
    });
  });

  it('keeps the cross-tenant canary out of every other tenant', () => {
    eachWorld((w, anchor) => {
      const canary = w.edges.crossTenantCanary;
      const owner = w.tenants.find((t) => t.customers.some((c) => c.name === canary))!;
      expect(owner.key, `@ ${anchor}`).toBe('other');
      for (const t of w.tenants) {
        if (t.key === 'other') continue;
        expect(t.customers.map((c) => c.name), `${t.name} @ ${anchor}`).not.toContain(canary);
      }
    });
  });
});

describe('buildWorldSpec — isolation and density', () => {
  it('gives every fixture-scoped scenario its own customer and job', () => {
    eachWorld((w, anchor) => {
      const main = w.tenants.find((t) => t.key === 'main')!;
      for (const tier of FIXTURE_TIERS) {
        for (const [family, n] of Object.entries(FIXTURE_POOLS)) {
          if (family === 'cfg') continue;
          const customers = main.customers.filter((c) => c.key.startsWith(`fx-${tier}-${family}-`));
          const jobs = main.jobs.filter((j) => j.key.startsWith(`job-${tier}-${family}-`));
          expect(customers.length, `${tier}/${family} customers @ ${anchor}`).toBe(n);
          expect(jobs.length, `${tier}/${family} jobs @ ${anchor}`).toBe(n);
          // One job per customer — a shared job would let one scenario's write
          // change another's starting state.
          expect(new Set(jobs.map((j) => j.customerKey)).size).toBe(n);
        }
      }
      const cfg = main.technicians.filter((t) => t.ref.startsWith('cfg-tech-'));
      expect(cfg.length, `cfg technicians @ ${anchor}`).toBe(FIXTURE_POOLS.cfg);
    });
  });

  it('keeps the roster inside its purchased seats', () => {
    eachTenant((t, _w, anchor) => {
      // Seat-exempt rows occupy nothing; everyone else consumes a seat of their
      // tier, and the DB seat-cap trigger rejects the insert past capacity.
      const counted = t.technicians.filter((x) => !x.seatExempt);
      const managers = counted.filter((x) => x.tier === 'manager').length;
      const techs = counted.filter((x) => x.tier === 'technician').length;
      expect(managers, `${t.name} @ ${anchor} managers`).toBeLessThanOrEqual(t.managerSeats);
      expect(techs, `${t.name} @ ${anchor} technicians`).toBeLessThanOrEqual(t.technicianSeats);
    });
  });

  it('has a working book: real density ahead, history behind, a live queue', () => {
    eachWorld((w, anchor) => {
      const main = w.tenants.find((t) => t.key === 'main')!;
      const placed = main.visits.filter(isPlacedSpec);
      const future = placed.filter((v) => v.date! > anchor);
      const past = placed.filter((v) => v.date! < anchor);
      expect(future.length, `future visits @ ${anchor}`).toBeGreaterThan(40);
      expect(past.length, `past visits @ ${anchor}`).toBeGreaterThan(15);

      // Queue: open jobs with no visit at all — what find_slots and the tray read.
      const scheduled = new Set(main.visits.map((v) => v.jobKey));
      const queue = main.jobs.filter((j) => j.status === 'open' && !scheduled.has(j.key));
      expect(queue.length, `queue @ ${anchor}`).toBeGreaterThanOrEqual(4);

      // Time-TBD rows have to exist or the scenarios that read them grade
      // against an empty set.
      expect(main.visits.some((v) => !isPlacedSpec(v))).toBe(true);
      expect(main.visits.some((v) => v.technicianRef === null)).toBe(true);
    });
  });

  it('reports a span that actually covers its rows', () => {
    eachWorld((w, anchor) => {
      const dated = w.tenants
        .flatMap((t) => t.visits.flatMap((v) => [v.date]))
        .filter((d): d is string => typeof d === 'string');
      for (const d of dated) {
        expect(d >= w.span.from, `${d} before span.from @ ${anchor}`).toBe(true);
        expect(d <= w.span.to, `${d} after span.to @ ${anchor}`).toBe(true);
      }
      expect(w.span.from < anchor).toBe(true);
      expect(w.span.to > addDays(anchor, HORIZON_DAYS)).toBe(true);
    });
  });

  it('exhausts the seats tenant so the cap can be tested', () => {
    eachWorld((w) => {
      const seats = w.tenants.find((t) => t.key === 'seats')!;
      const techs = seats.technicians.filter((x) => x.tier === 'technician' && !x.seatExempt);
      expect(techs.length).toBe(seats.technicianSeats); // no room left
    });
  });
});
