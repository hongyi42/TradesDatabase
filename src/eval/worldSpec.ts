// The eval world, as a declarative spec built from day OFFSETS against an anchor.
//
// This is the answer to "the seed expires": nothing here is an absolute date.
// buildWorldSpec(anchor) emits the same shape whatever day it runs, so a world
// generated in November is as valid as one generated today, and a failing
// scenario is reproducible from (anchor, seed) alone.
//
// Pure on purpose — no DB, no clock, no I/O. scripts/spine-eval/world.mjs walks
// this and calls the typed db layer; every interesting decision (which day, which
// technician, which planted edge) is therefore unit-testable without a database.

import {
  addDays,
  addMinutes,
  eachDay,
  isWeekend,
  naiveLocal,
  nextWorkday,
  pick,
  prevWorkday,
  rng,
  weekdayIndexOf,
  type Weekday,
} from './clock.js';

// ─────────────────────────────────────────────────────────────── the shapes ──

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export type Tier = 'manager' | 'technician';

export interface CaptureSpec {
  key: string;
  channel: string;
  technicianRef: string;
  rawText: string;
  /** 'pre' = written before its customer exists (an intake call); 'post' = stamped with customer/job. */
  phase: 'pre' | 'post';
  customerKey?: string;
  jobKey?: string;
  externalId?: string;
}

export interface FactSpec {
  key: string;
  value: string | number | boolean;
  /** Capture key that evidences this fact — standing facts are never plain values. */
  evidence: string;
}

export interface CustomerSpec {
  key: string;
  name: string;
  phone: string | null;
  email: string | null;
  addressLine1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  cluster: ClusterKey | null;
  facts: FactSpec[];
  sourceCapture?: string;
}

export interface JobSpec {
  key: string;
  customerKey: string;
  title: string;
  jobType: string | null;
  status: 'open' | 'in_progress' | 'completed' | 'invoiced';
  durationMinutes: number | null;
  priority?: 'routine' | 'urgent';
  facts: FactSpec[];
  sourceCapture?: string;
}

export interface VisitSpec {
  key: string;
  jobKey: string;
  technicianRef: string | null;
  /** Placed rows carry date+startTime+durationMinutes; unplaced carry earliest/latest only. */
  date?: string;
  startTime?: string;
  durationMinutes?: number;
  earliestDate?: string;
  latestDate?: string;
  status: 'proposed' | 'confirmed' | 'completed' | 'cancelled';
  promiseLevel: 'none' | 'day' | 'time';
}

export interface TechnicianSpec {
  ref: string;
  displayName: string;
  tier: Tier;
  seatExempt?: boolean;
  availability?: Record<DayKey, [string, string][]>;
  serviceCities?: string[];
  skills?: string[];
  /** Slot starts this technician's day is built from. */
  slots?: string[];
}

export interface TimeOffSpec {
  technicianRef: string;
  startsOn: string;
  endsOn: string;
  reason: string;
}

export interface TenantSpec {
  key: string;
  name: string;
  purpose: string;
  managerSeats: number;
  technicianSeats: number;
  horizonDays: number;
  technicians: TechnicianSpec[];
  captures: CaptureSpec[];
  customers: CustomerSpec[];
  jobs: JobSpec[];
  visits: VisitSpec[];
  timeOff: TimeOffSpec[];
  durations: { jobType: string; minutes: number }[];
  /**
   * Cold sandboxes to register in this tenant's pool.
   *
   * bind_telegram CLAIMS a sandbox from the cold pool, so with an empty pool it
   * refuses with "no free sandbox" and the tool's real path is never exercised.
   * Infra rather than spine, but a manager flow worth covering.
   */
  coldSandboxes: number;
}

export interface WorldSpec {
  anchor: string;
  seed: number;
  timezone: string;
  /** Bounds of the generated schedule, for the report's coverage line. */
  span: { from: string; to: string };
  tenants: TenantSpec[];
  /**
   * The deliberately-planted edges, by name. Both the corpus and the invariant
   * tests reference these rather than re-deriving them, so an edge that stops
   * being generated fails a test instead of silently weakening a scenario.
   */
  edges: Record<EdgeKey, string>;
}

export type EdgeKey =
  | 'noAddressCustomer'
  | 'sameSurnameA'
  | 'sameSurnameB'
  | 'richHistoryCustomer'
  | 'silentRecordCustomer'
  | 'durationlessJob'
  | 'retractFoldCapture'
  | 'horizonEdgeVisit'
  | 'beyondHorizonVisit'
  | 'crossTenantCanary';

// ──────────────────────────────────────────────────────────────── the world ──

export const TIMEZONE = 'America/Los_Angeles';
/** How far back and forward the generated schedule reaches. */
export const SPAN_BACK = 14;
export const SPAN_FORWARD = 21;
/** Tenant default technician visibility horizon (tenants.technician_horizon_days). */
export const HORIZON_DAYS = 28;

type ClusterKey = 'seattle' | 'eastside' | 'south';

/**
 * Real street names so geocoding and drive-time scoring behave like production;
 * the PEOPLE are invented. Nothing here is or resembles a real customer record —
 * L1 has no delete path, so synthetic-only is a hard rule, not a preference.
 */
const ADDRESSES: Record<ClusterKey, { line1: string; city: string; postal: string }[]> = {
  seattle: [
    { line1: '412 Dexter Ave N', city: 'Seattle', postal: '98109' },
    { line1: '1104 NW 85th St', city: 'Seattle', postal: '98117' },
    { line1: '733 Rainier Ave S', city: 'Seattle', postal: '98144' },
    { line1: '2208 California Ave SW', city: 'Seattle', postal: '98116' },
    { line1: '505 Broadway E', city: 'Seattle', postal: '98102' },
    { line1: '1620 N 45th St', city: 'Seattle', postal: '98103' },
  ],
  eastside: [
    { line1: '860 108th Ave NE', city: 'Bellevue', postal: '98004' },
    { line1: '15 Lake Bellevue Dr', city: 'Bellevue', postal: '98005' },
    { line1: '320 Central Way', city: 'Kirkland', postal: '98033' },
    { line1: '7625 166th Ave NE', city: 'Redmond', postal: '98052' },
    { line1: '1075 Bellevue Way NE', city: 'Bellevue', postal: '98004' },
    { line1: '450 NW Gilman Blvd', city: 'Issaquah', postal: '98027' },
  ],
  south: [
    { line1: '1201 S 320th St', city: 'Federal Way', postal: '98003' },
    { line1: '628 Central Ave N', city: 'Kent', postal: '98032' },
    { line1: '3105 S 38th St', city: 'Tacoma', postal: '98409' },
    { line1: '820 W Main St', city: 'Auburn', postal: '98001' },
    { line1: '17200 Southcenter Pkwy', city: 'Tukwila', postal: '98188' },
    { line1: '2401 Bridgeport Way W', city: 'University Place', postal: '98466' },
  ],
};

const FIRST = [
  'Maria', 'Tom', 'Priya', 'Dana', 'Luis', 'Aisha', 'Ken', 'Rosa', 'Marcus', 'Hana',
  'Omar', 'Ellen', 'Ivan', 'Grace', 'Pedro', 'Nadia', 'Ruth', 'Victor', 'Lena', 'Sam',
];
// NOTE: 'Whitfield' is deliberately ABSENT. It belongs to the planted
// same-surname pair below, and a random base customer sharing it would turn a
// controlled two-way ambiguity into an uncontrolled four-way one — the
// find_customer scenario would then grade the agent against a question whose
// right answer nobody decided.
const LAST = [
  'Gonzalez', 'Becker', 'Raman', 'Ortiz', 'Karim', 'Tanaka', 'Delgado',
  'Nguyen', 'Sato', 'Haddad', 'Brooks', 'Petrov', 'Okonkwo', 'Alvarez', 'Rahimi',
];

/**
 * Names for per-scenario fixtures — one each, globally unique, and realistic.
 *
 * Two lessons paid for by a real run. (1) Uniqueness: the previous scheme reused
 * FIRST/LAST and told the two apart with a "(rs-01)" suffix, which produced two
 * customers called "Aisha Nguyen" and an agent that could not decide which one it
 * had been asked about. (2) No suffix: the harness marker looked like an
 * identifier, and the agent duly passed `"rs-05"` to a tool expecting a uuid.
 * Fixture data must look like customer data, or the eval measures its own labels.
 */
const FIXTURE_NAMES = [
  'Aurelia Fenwick', 'Bartholomew Nkemdirim', 'Cassia Lindgren', 'Desmond Achterberg',
  'Elowen Fitzcharles', 'Fabien Oyelaran', 'Giselle Marchetti-Vaux', 'Horatio Mbeki',
  'Isolde Vranken', 'Jasper Okonjo', 'Kalliope Standish', 'Leopold Ferreiro',
  'Marisol Thackeray', 'Nikolai Abernethy', 'Ottoline Baptiste', 'Percival Nyamekye',
  'Quintessa Halvorsen', 'Rodrigo Wexler', 'Seraphina Ondaatje', 'Thaddeus Brightwater',
  'Ulyana Petrossian', 'Valentin Osei-Bonsu', 'Wilhelmina Drescher', 'Xavier Lundqvist',
  'Yolanda Castellanos', 'Zacharias Melnyk', 'Anouk Delacroix-Pryce', 'Bruno Sandoval',
  'Clementine Ashworth', 'Dmitri Kowalczyk', 'Esperanza Villalobos', 'Florian Habicht',
  'Genevieve Okoro', 'Hamish Torrington', 'Ingrid Solheim', 'Julius Nkosi',
  'Katarzyna Wisniewski', 'Lorcan Fairweather', 'Magdalena Rusnak', 'Nathaniel Osborne-Hale',
  'Ophelia Vasquez', 'Piotr Zielinski', 'Rosalind Kettleborough', 'Sebastian Adeyemi',
  'Tatiana Broekhuis', 'Ulrich Sandberg', 'Verity Chukwuma', 'Wolfgang Isaksson',
  'Yasmina Bouchard', 'Zephyrine Toussaint', 'Alistair Penhaligon', 'Beatrix Nowakowski',
  'Cormac Sigurdsson', 'Delphine Ntambwe', 'Emeric Vandersteen', 'Fionnuala Brannigan',
  'Gustav Lindqvist-Roe', 'Hyacinth Adeyinka', 'Ignatz Vorobyov', 'Josephine Kalinowski',
  // Extended for the wf (workflow) pool: two tiers × five pools must never
  // exhaust this list — the cursor wraps silently (`% length`), and a wrapped
  // name recreates the two-customers-one-name ambiguity uniqueness exists to
  // prevent. 80 names ≥ 78 fixtures. A unit test pins this arithmetic.
  'Araminta Vellacott', 'Benedikt Oyelowo', 'Cordelia Maskelyne', 'Dashiell Okwuosa',
  'Eulalia Brandhorst', 'Ferdinand Quilliam', 'Guinevere Ostrowski', 'Heathcliff Vandermeer',
  'Imogen Fairbairn', 'Jerome Castellane', 'Kerensa Middlemiss', 'Lysander Achebe',
  'Morwenna Vasiliev', 'Nikolina Draycott', 'Oberon Silverthorne', 'Perpetua Winslade',
  'Quillon Abramczyk', 'Rosamund Tiverton', 'Sylvester Nakagawa', 'Theodora Ellsworth',
];

/** The work a trades firm actually books, with realistic lengths. */
const WORK: { title: string; jobType: string; minutes: number }[] = [
  { title: 'AC not cooling', jobType: 'hvac', minutes: 120 },
  { title: 'Furnace inspection', jobType: 'hvac', minutes: 60 },
  { title: 'Water heater replacement', jobType: 'plumbing', minutes: 120 },
  { title: 'Kitchen drain clearing', jobType: 'plumbing', minutes: 60 },
  { title: 'Thermostat replacement', jobType: 'hvac', minutes: 60 },
  { title: 'Rooftop unit maintenance', jobType: 'hvac', minutes: 90 },
  { title: 'Leaking shut-off valve', jobType: 'plumbing', minutes: 60 },
  { title: 'Duct cleaning', jobType: 'hvac', minutes: 90 },
  { title: 'Sump pump check', jobType: 'plumbing', minutes: 60 },
  { title: 'Mini-split install', jobType: 'hvac', minutes: 120 },
];

const MON_FRI = (from: string, to: string): Record<DayKey, [string, string][]> => ({
  mon: [[from, to]],
  tue: [[from, to]],
  wed: [[from, to]],
  thu: [[from, to]],
  fri: [[from, to]],
  sat: [],
  sun: [],
});

const TUE_SAT = (from: string, to: string): Record<DayKey, [string, string][]> => ({
  mon: [],
  tue: [[from, to]],
  wed: [[from, to]],
  thu: [[from, to]],
  fri: [[from, to]],
  sat: [[from, to]],
  sun: [],
});

const DAY_KEYS: DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const dayKeyOf = (iso: string): DayKey => DAY_KEYS[weekdayIndexOf(iso)];

/**
 * Which geographic cluster each technician works. Kept beside the roster rather
 * than on it: TechnicianSpec is the shape the applier writes, and a field it has
 * to strip before every insert is a field that will one day be inserted.
 */
const CLUSTER_OF: Record<string, ClusterKey> = {
  'tech-jane': 'seattle',
  'tech-marco': 'eastside',
  'tech-dee': 'south',
};

/** The three working technicians the base schedule is built from. */
const WORKING: TechnicianSpec[] = [
  {
    ref: 'tech-jane',
    displayName: 'Jane Alvarez',
    tier: 'technician',
    availability: MON_FRI('08:00', '17:00'),
    serviceCities: ['Seattle'],
    skills: ['hvac'],
    slots: ['08:00', '10:30', '13:00', '15:30'],
  },
  {
    ref: 'tech-marco',
    displayName: 'Marco Silva',
    tier: 'technician',
    availability: MON_FRI('07:00', '16:00'),
    serviceCities: ['Bellevue', 'Kirkland', 'Redmond', 'Issaquah'],
    skills: ['plumbing', 'hvac'],
    slots: ['07:30', '10:00', '12:30', '15:00'],
  },
  {
    // Skills deliberately EMPTY: unknown never excludes (the recorded fairness
    // decision), and a scenario asserts that.
    ref: 'tech-dee',
    displayName: 'Dee Okonkwo',
    tier: 'technician',
    availability: TUE_SAT('09:00', '18:00'),
    serviceCities: ['Kent', 'Federal Way', 'Tacoma', 'Auburn'],
    skills: [],
    slots: ['09:00', '11:30', '14:00', '16:30'],
  },
];

/**
 * Fixture pools: one row per write scenario, so scenarios never collide.
 *
 * Allocated PER TIER. Tier 1 cancelled job `rs-04` and tier 2 then asked the agent
 * to cancel the same visit, which had already gone — a shared-world collision that
 * read as an agent failure. Disjoint pools make that impossible rather than
 * merely discouraged.
 */
export const FIXTURE_POOLS = {
  /** Own customer + job: booking, reschedule, capture, email families. */
  bk: 8,
  rs: 7,
  cap: 9,
  ext: 3,
  /**
   * The workflow (multi-tool) family: scenarios where one manager request
   * chains reads → slot search → writes. Each tier's wf rows live on that
   * tier's DEDICATED technician (`wf-tech-t1`/`wf-tech-t2`, no base schedule),
   * so a chain that cancels, rebooks and clears whole afternoons can never
   * collide with another scenario's fixtures. Some indexes carry a planted
   * visit (WF_PLACED below); the rest are queued jobs for slot-search chains.
   */
  wf: 12,
  /**
   * Own technician: roster + config families mutate a roster row each.
   *
   * Twelve, split 01–06 for tier 1 and 07–12 for tier 2. Per-tier CUSTOMER pools
   * were not enough: both tiers booked onto cfg-tech-06 on the same day and the
   * overlap constraint refused the second one, which read as a booking failure.
   * Whatever a scenario writes to, it has to own.
   */
  cfg: 12,
} as const;

/** The tiers that get their own fixture rows. */
export const FIXTURE_TIERS = ['t1', 't2'] as const;
export type FixtureTier = (typeof FIXTURE_TIERS)[number];

/**
 * Which wf fixtures carry a planted visit, and where it sits on the wf
 * technician's book. Day numbers are WORKDAY steps from nextWorkday(anchor+3)
 * — the same weekend-proof arithmetic as the rs cursor. Two pairs share a day
 * ON PURPOSE (a time-off sweep and a clear-the-afternoon both need two visits
 * on one day); everything else is distinct, and the pairs never overlap in
 * time, so the GiST no_confirmed_overlap guard stays quiet at generation.
 *
 *   day 0  09:00        wf-04  the visit a customer calls off (slot handover)
 *   day 1  09:00/13:00  wf-05+06  the day a time-off booking collides with
 *   day 2  10:00        wf-09  the blocker a same-time booking must dodge
 *   day 3  11:00        wf-12  a TIME-promised visit (gate, then release)
 *   day 4  13:00/15:00  wf-07+08  the afternoon that gets cleared — LAST on
 *          purpose: M05's instruction is "push these to the next open slots
 *          AFTER that day", and on an earlier day those rehomed visits landed
 *          squarely on M06's blocker morning, turning "book the closest slot
 *          Thursday" into a full Thursday and a defensible Friday booking
 *          that failed the end-state. Unconstrained moves must only ever
 *          spill PAST every other wf fixture.
 */
export const WF_PLACED: Record<number, { day: number; start: string; promise: 'none' | 'time' }> = {
  4: { day: 0, start: '09:00', promise: 'none' },
  5: { day: 1, start: '09:00', promise: 'none' },
  6: { day: 1, start: '13:00', promise: 'none' },
  7: { day: 4, start: '13:00', promise: 'none' },
  8: { day: 4, start: '15:00', promise: 'none' },
  9: { day: 2, start: '10:00', promise: 'none' },
  12: { day: 3, start: '11:00', promise: 'time' },
};

// ─────────────────────────────────────────────────────────────── the builder ──

export interface BuildOptions {
  anchor: string;
  seed?: number;
}

export function buildWorldSpec({ anchor, seed = 7 }: BuildOptions): WorldSpec {
  const edges = {} as Record<EdgeKey, string>;

  const main = buildMainTenant(anchor, seed, edges);
  const seats = buildSeatsTenant(anchor);
  const other = buildOtherFirmTenant(anchor, edges);
  const tenants = [main, seats, other];

  // Measured from the rows actually generated, not from SPAN_BACK/FORWARD: the
  // horizon-boundary edges deliberately sit past the base span, and a span that
  // excluded its own rows would understate coverage in every report.
  const days = tenants
    .flatMap((t) => t.visits.flatMap((v) => [v.date, v.earliestDate, v.latestDate]))
    .filter((d): d is string => typeof d === 'string')
    .sort();

  return {
    anchor,
    seed,
    timezone: TIMEZONE,
    span: { from: days[0], to: days[days.length - 1] },
    tenants,
    edges,
  };
}

function buildMainTenant(anchor: string, seed: number, edges: Record<EdgeKey, string>): TenantSpec {
  const rand = rng(seed);
  const captures: CaptureSpec[] = [];
  const customers: CustomerSpec[] = [];
  const jobs: JobSpec[] = [];
  const visits: VisitSpec[] = [];

  // ── roster ──
  const technicians: TechnicianSpec[] = [
    { ref: 'manager-sam', displayName: 'Sam Rivera', tier: 'manager' },
    { ref: 'manager-joy', displayName: 'Joy Ferreira', tier: 'manager' },
    ...WORKING,
    // Schedule-only part-timer: bookable, but the identity verbs must refuse it.
    { ref: 'helper-pat', displayName: 'Pat Lindqvist', tier: 'technician', seatExempt: true },
  ];
  for (let i = 1; i <= FIXTURE_POOLS.cfg; i++) {
    const n = String(i).padStart(2, '0');
    technicians.push({
      ref: `cfg-tech-${n}`,
      displayName: `Config Tech ${n}`,
      tier: 'technician',
      availability: MON_FRI('08:00', '17:00'),
      serviceCities: ['Seattle'],
      skills: ['hvac'],
    });
  }
  // The workflow-family technicians: one per tier, NO base schedule. The
  // multi-tool scenarios book, cancel and clear whole days on these two, so
  // every row on their book is a wf fixture and nothing else can collide.
  // Both trades, so any wf job's slot search lands on them.
  for (const [tier, displayName] of [['t1', 'Wren Fielding'], ['t2', 'Theo Marsh']] as const) {
    technicians.push({
      ref: `wf-tech-${tier}`,
      displayName,
      tier: 'technician',
      availability: MON_FRI('08:00', '17:00'),
      serviceCities: ['Seattle'],
      skills: ['hvac', 'plumbing'],
    });
  }

  // ── the base customer population, one per cluster slot ──
  let ci = 0;
  const clusterCustomers: Record<ClusterKey, string[]> = { seattle: [], eastside: [], south: [] };
  for (const cluster of ['seattle', 'eastside', 'south'] as ClusterKey[]) {
    for (const addr of ADDRESSES[cluster]) {
      const key = `base-${cluster}-${clusterCustomers[cluster].length + 1}`;
      const name = `${FIRST[ci % FIRST.length]} ${LAST[(ci * 3) % LAST.length]}`;
      ci++;
      const intake: CaptureSpec = {
        key: `cap-${key}`,
        channel: 'phone_call',
        technicianRef: 'manager-sam',
        phase: 'pre',
        rawText: `Intake call: ${name} at ${addr.line1}, ${addr.city}. Asked us to take a look.`,
      };
      captures.push(intake);
      customers.push({
        key,
        name,
        phone: `206-555-${String(1000 + ci).slice(-4)}`,
        email: null,
        addressLine1: addr.line1,
        city: addr.city,
        state: 'WA',
        postalCode: addr.postal,
        cluster,
        facts: [],
        sourceCapture: intake.key,
      });
      clusterCustomers[cluster].push(key);
    }
  }

  // ── planted edges ──
  // 1. No address at all: get_schedule's mapsUrl must come back null and the
  //    agent must say so rather than inventing directions.
  const noAddr: CustomerSpec = {
    key: 'edge-no-address',
    name: 'Corinne Delacroix',
    phone: '206-555-0170',
    email: null,
    addressLine1: null,
    city: null,
    state: null,
    postalCode: null,
    cluster: null,
    facts: [],
  };
  customers.push(noAddr);
  edges.noAddressCustomer = noAddr.name;

  // 2. Two customers sharing a surname: find_customer must disambiguate, not pick.
  for (const [key, name] of [
    ['edge-surname-a', 'Dana Whitfield'],
    ['edge-surname-b', 'Marcus Whitfield'],
  ] as const) {
    const addr = pick(rand, ADDRESSES.seattle);
    customers.push({
      key,
      name,
      phone: `206-555-${key === 'edge-surname-a' ? '0181' : '0182'}`,
      email: null,
      addressLine1: addr.line1,
      city: addr.city,
      state: 'WA',
      postalCode: addr.postal,
      cluster: 'seattle',
      facts: [],
    });
  }
  edges.sameSurnameA = 'Dana Whitfield';
  edges.sameSurnameB = 'Marcus Whitfield';

  // 3. Rich history: the briefing showcase — several jobs, past visits, notes,
  //    and standing facts whose evidence is retractable.
  const richIntake: CaptureSpec = {
    key: 'cap-rich-intake',
    channel: 'phone_call',
    technicianRef: 'manager-sam',
    phase: 'pre',
    rawText:
      'Intake call: Yvonne Kastellani, 412 Dexter Ave N. Gate code 4321, dog in the back yard, ' +
      'prefers afternoons. Second AC problem this year.',
  };
  captures.push(richIntake);
  const rich: CustomerSpec = {
    key: 'edge-rich',
    name: 'Yvonne Kastellani',
    phone: '206-555-0190',
    email: 'yvonne.k@example.test',
    addressLine1: '412 Dexter Ave N',
    city: 'Seattle',
    state: 'WA',
    postalCode: '98109',
    cluster: 'seattle',
    facts: [
      { key: 'gate_code', value: '4321', evidence: richIntake.key },
      { key: 'pets', value: 'dog in the back yard', evidence: richIntake.key },
      { key: 'prefers', value: 'afternoons', evidence: richIntake.key },
    ],
    sourceCapture: richIntake.key,
  };
  customers.push(rich);
  edges.richHistoryCustomer = rich.name;
  // The fact whose evidence gets retracted — retract_capture's willAlsoRemove
  // must list the standing facts that fold with it.
  edges.retractFoldCapture = richIntake.key;

  // Three historical jobs for the rich customer, walked to a terminal status.
  const richWork = [WORK[0], WORK[4], WORK[7]];
  richWork.forEach((w, i) => {
    const jobKey = `job-rich-${i + 1}`;
    jobs.push({
      key: jobKey,
      customerKey: rich.key,
      title: w.title,
      jobType: w.jobType,
      status: i === 2 ? 'open' : 'invoiced',
      durationMinutes: w.minutes,
      facts: i === 0 ? [{ key: 'symptom', value: 'not cooling', evidence: richIntake.key }] : [],
      sourceCapture: richIntake.key,
    });
    // A technician note per completed job, so full_history has something to cite.
    if (i < 2) {
      captures.push({
        key: `cap-rich-note-${i + 1}`,
        channel: 'technician_voice',
        technicianRef: 'tech-jane',
        phase: 'post',
        customerKey: rich.key,
        jobKey,
        rawText:
          i === 0
            ? 'Replaced the run capacitor, unit is cooling again. Compressor showing wear — ' +
              'recommend full replacement before next summer.'
            : 'Swapped the thermostat for a programmable one and walked her through the schedule.',
      });
      const day = nextWorkday(addDays(anchor, i === 0 ? -12 : -6));
      visits.push({
        key: `visit-rich-${i + 1}`,
        jobKey,
        technicianRef: 'tech-jane',
        date: day,
        startTime: '13:00',
        durationMinutes: w.minutes,
        status: 'completed',
        promiseLevel: 'none',
      });
    }
  });

  // 4. A customer whose record genuinely lacks the answer: answer_customer_question
  //    must say the record doesn't say, not invent a gate code.
  const silentIntake: CaptureSpec = {
    key: 'cap-silent-intake',
    channel: 'web_form',
    technicianRef: 'connector:web',
    phase: 'pre',
    rawText: 'Web form: furnace making a rattling noise on start-up. Best number is on file.',
  };
  captures.push(silentIntake);
  const silent: CustomerSpec = {
    key: 'edge-silent',
    name: 'Roland Abernathy',
    phone: '206-555-0195',
    email: null,
    addressLine1: '1620 N 45th St',
    city: 'Seattle',
    state: 'WA',
    postalCode: '98103',
    cluster: 'seattle',
    facts: [{ key: 'symptom', value: 'rattling on start-up', evidence: silentIntake.key }],
    sourceCapture: silentIntake.key,
  };
  customers.push(silent);
  edges.silentRecordCustomer = silent.name;

  // 5. A job with NO duration: find_slots must fail closed and offer the ladder
  //    rather than assume 120 minutes.
  jobs.push({
    key: 'job-durationless',
    customerKey: 'edge-surname-a',
    title: 'Unknown-length repipe assessment',
    jobType: 'plumbing',
    status: 'open',
    durationMinutes: null,
    facts: [],
  });
  edges.durationlessJob = 'Unknown-length repipe assessment';

  // ── the base schedule: every working day inside each technician's pattern ──
  const timeOff: TimeOffSpec[] = [
    {
      technicianRef: 'tech-marco',
      startsOn: nextWorkday(addDays(anchor, 8)),
      endsOn: nextWorkday(addDays(anchor, 10)),
      reason: 'vacation',
    },
  ];
  const offDays = new Set(eachDay(timeOff[0].startsOn, timeOff[0].endsOn));

  let wi = 0;
  let seq = 0;
  for (const tech of WORKING) {
    const pool = clusterCustomers[CLUSTER_OF[tech.ref]];
    for (const day of eachDay(addDays(anchor, -SPAN_BACK), addDays(anchor, SPAN_FORWARD))) {
      const windows = tech.availability?.[dayKeyOf(day)] ?? [];
      if (windows.length === 0) continue; // outside this technician's pattern
      if (tech.ref === timeOff[0].technicianRef && offDays.has(day)) continue; // on holiday
      // Denser in the current fortnight than in the tail, like a real book.
      const ahead = Number(day > anchor);
      const count = day < anchor ? 2 : ahead && day > addDays(anchor, 13) ? 2 : 3;
      for (let i = 0; i < count; i++) {
        const w = WORK[wi++ % WORK.length];
        const customerKey = pool[(seq + i) % pool.length];
        const jobKey = `job-base-${++seq}`;
        const past = day < anchor;
        jobs.push({
          key: jobKey,
          customerKey,
          title: w.title,
          jobType: w.jobType,
          status: past ? 'completed' : 'open',
          durationMinutes: w.minutes,
          facts: [],
        });
        // A promise on roughly every third future visit, so the ladder is
        // exercised without every move tripping a gate.
        const promiseLevel = past || seq % 3 !== 0 ? 'none' : seq % 6 === 0 ? 'time' : 'day';
        visits.push({
          key: `visit-base-${seq}`,
          jobKey,
          technicianRef: tech.ref,
          date: day,
          startTime: (tech.slots ?? ['08:00'])[i],
          durationMinutes: w.minutes,
          status: past ? 'completed' : 'confirmed',
          promiseLevel,
        });
      }
    }
  }

  // ── horizon boundary: one visit just inside the horizon, one past it ──
  // Inside uses prevWorkday, not nextWorkday: stepping FORWARD off a weekend can
  // land past anchor+HORIZON_DAYS, which would put the "inside" row outside the
  // horizon and quietly invert the scenario it exists for.
  const horizonDay = prevWorkday(addDays(anchor, HORIZON_DAYS - 1));
  const beyondDay = nextWorkday(addDays(anchor, HORIZON_DAYS + 2));
  for (const [label, day, key] of [
    ['horizonEdgeVisit', horizonDay, 'edge-horizon'],
    ['beyondHorizonVisit', beyondDay, 'edge-beyond-horizon'],
  ] as const) {
    const jobKey = `job-${key}`;
    jobs.push({
      key: jobKey,
      customerKey: 'base-seattle-1',
      title: label === 'horizonEdgeVisit' ? 'Horizon-edge tune-up' : 'Beyond-horizon tune-up',
      jobType: 'hvac',
      status: 'open',
      durationMinutes: 60,
      facts: [],
    });
    visits.push({
      key: `visit-${key}`,
      jobKey,
      technicianRef: 'tech-jane',
      date: day,
      // 16:00-17:00: after jane's last base slot ends (13:00 + 120 = 15:00) and
      // exactly flush with her pattern's 17:00 close — inside the pattern, and
      // unable to collide with anything the base loop places.
      startTime: '16:00',
      durationMinutes: 60,
      status: 'confirmed',
      promiseLevel: 'none',
    });
    edges[label] = day;
  }

  // ── the loose queue: work with no visit, plus unplaced (time-TBD) rows ──
  for (let i = 1; i <= 4; i++) {
    jobs.push({
      key: `job-loose-${i}`,
      customerKey: clusterCustomers.eastside[i % clusterCustomers.eastside.length],
      title: WORK[(i + 2) % WORK.length].title,
      jobType: WORK[(i + 2) % WORK.length].jobType,
      status: 'open',
      durationMinutes: WORK[(i + 2) % WORK.length].minutes,
      priority: i === 1 ? 'urgent' : 'routine',
      facts: [],
    });
  }
  for (let i = 1; i <= 3; i++) {
    const jobKey = `job-tbd-${i}`;
    jobs.push({
      key: jobKey,
      customerKey: clusterCustomers.south[i % clusterCustomers.south.length],
      title: WORK[(i + 5) % WORK.length].title,
      jobType: WORK[(i + 5) % WORK.length].jobType,
      status: 'open',
      durationMinutes: 60,
      facts: [],
    });
    const from = nextWorkday(addDays(anchor, 2 + i));
    visits.push({
      key: `visit-tbd-${i}`,
      jobKey,
      // One of them has no technician either — person-less AND time-less.
      technicianRef: i === 3 ? null : 'tech-dee',
      earliestDate: from,
      latestDate: addDays(from, 2),
      status: 'confirmed',
      promiseLevel: 'none',
    });
  }

  // ── per-scenario fixtures: one customer + one job each, per TIER ──
  let nameCursor = 0;
  let rsDay = 0;
  for (const tier of FIXTURE_TIERS) {
    for (const [family, n] of Object.entries(FIXTURE_POOLS)) {
      if (family === 'cfg') continue; // cfg scenarios own a technician, not a customer
      for (let i = 1; i <= n; i++) {
        const id = `${tier}-${family}-${String(i).padStart(2, '0')}`;
        const addr = ADDRESSES.seattle[nameCursor % ADDRESSES.seattle.length];
        const name = FIXTURE_NAMES[nameCursor % FIXTURE_NAMES.length];
        nameCursor++;
      const intake: CaptureSpec = {
        key: `cap-${id}`,
        channel: 'phone_call',
        technicianRef: 'manager-sam',
        phase: 'pre',
        rawText: `Intake call: ${name} at ${addr.line1} needs a technician out.`,
      };
      captures.push(intake);
      customers.push({
        key: `fx-${id}`,
        name,
        phone: `206-555-${String(2000 + nameCursor * 11).slice(-4)}`,
        email: `${name.split(' ')[0].toLowerCase()}@example.test`,
        addressLine1: addr.line1,
        city: addr.city,
        state: 'WA',
        postalCode: addr.postal,
        cluster: 'seattle',
        facts: [],
        sourceCapture: intake.key,
      });
      const w = WORK[i % WORK.length];
      jobs.push({
        key: `job-${id}`,
        customerKey: `fx-${id}`,
        title: w.title,
        jobType: w.jobType,
        status: 'open',
        durationMinutes: w.minutes,
        facts: [],
        sourceCapture: intake.key,
      });
      // Workflow fixtures: some carry a planted visit on the tier's dedicated
      // technician (see WF_PLACED); the rest stay queued for slot-search chains.
      if (family === 'wf' && WF_PLACED[i]) {
        const plant = WF_PLACED[i];
        visits.push({
          key: `visit-${id}`,
          jobKey: `job-${id}`,
          technicianRef: `wf-tech-${tier}`,
          date: nextWorkday(addDays(anchor, 3), plant.day),
          startTime: plant.start,
          durationMinutes: 60,
          status: 'confirmed',
          promiseLevel: plant.promise,
        });
      }
      // Reschedule fixtures need something already on the calendar to move.
      if (family === 'rs') {
        visits.push({
          key: `visit-${id}`,
          jobKey: `job-${id}`,
          technicianRef: 'tech-jane',
          // ONE DISTINCT WORKING DAY EACH, across BOTH tiers — a shared cursor,
          // not `i`, or tier 2's fixtures would land on tier 1's days at the same
          // minute and trip the GiST exclusion mid-generation.
          date: nextWorkday(addDays(anchor, 3), rsDay++),
          // 15:15-15:45. A fixture must never collide with the base schedule it
          // shares a technician with: jane's 10:30 slot can run 120 minutes to
          // 12:30, so anything late morning would trip the no_confirmed_overlap
          // exclusion at generation time. Her book is clear after 15:00.
          startTime: '15:15',
          durationMinutes: 30,
          status: 'confirmed',
          // Half promised, half not: the move gate should fire on some and not others.
          promiseLevel: i % 2 === 0 ? 'day' : 'none',
        });
      }
      }
    }
  }

  return {
    key: 'main',
    name: 'Eval Main',
    purpose: 'fixture-scoped scenarios — every write scenario owns its own rows',
    managerSeats: 3,
    // Headroom over the spec's ~17 seated rows: roster scenarios in BOTH tiers
    // add people at run time, and an accidental cap-hit would fail T01 with
    // "no free seats" — the seats tenant tests the cap; main must never.
    technicianSeats: 24,
    horizonDays: HORIZON_DAYS,
    technicians,
    captures,
    customers,
    jobs,
    visits,
    timeOff,
    durations: [
      { jobType: 'hvac', minutes: 120 },
      { jobType: 'plumbing', minutes: 60 },
    ],
    coldSandboxes: 3,
  };
}


/** Seats deliberately exhausted: add_technician_seat must refuse, and say why. */
function buildSeatsTenant(anchor: string): TenantSpec {
  return {
    key: 'seats',
    name: 'Eval Seats',
    purpose: 'seat cap exhausted — add_technician_seat must fail closed',
    managerSeats: 1,
    technicianSeats: 1,
    horizonDays: HORIZON_DAYS,
    technicians: [
      { ref: 'manager-sam', displayName: 'Sam Rivera', tier: 'manager' },
      {
        ref: 'tech-only',
        displayName: 'Ola Fernsby',
        tier: 'technician',
        availability: MON_FRI('08:00', '17:00'),
        serviceCities: ['Seattle'],
        skills: ['hvac'],
      },
    ],
    captures: [],
    customers: [],
    jobs: [],
    visits: [],
    timeOff: [
      {
        technicianRef: 'tech-only',
        startsOn: nextWorkday(addDays(anchor, 4)),
        endsOn: nextWorkday(addDays(anchor, 4)),
        reason: 'sick',
      },
    ],
    durations: [],
    coldSandboxes: 0,
  };
}

/**
 * A second firm holding one unmistakably-named customer. Tenant isolation is
 * the #1 data risk and rests on a hand-written filter in every accessor, so the
 * corpus asks Main's manager for this name: it must never come back.
 */
function buildOtherFirmTenant(anchor: string, edges: Record<EdgeKey, string>): TenantSpec {
  const canary = 'Zylatha Pemberton-Quist';
  edges.crossTenantCanary = canary;
  const intake: CaptureSpec = {
    key: 'cap-canary',
    channel: 'phone_call',
    technicianRef: 'manager-other',
    phase: 'pre',
    rawText: `Intake call: ${canary} at 900 Fauntleroy Way SW, boiler out.`,
  };
  return {
    key: 'other',
    name: 'Eval Other Firm',
    purpose: 'cross-tenant leak canary — these rows must never reach Eval Main',
    managerSeats: 1,
    technicianSeats: 2,
    horizonDays: HORIZON_DAYS,
    technicians: [
      { ref: 'manager-other', displayName: 'Dev Marchetti', tier: 'manager' },
      {
        ref: 'tech-other',
        displayName: 'Bo Trellis',
        tier: 'technician',
        availability: MON_FRI('08:00', '17:00'),
        serviceCities: ['Seattle'],
        skills: ['hvac'],
      },
    ],
    captures: [intake],
    customers: [
      {
        key: 'canary',
        name: canary,
        phone: '206-555-0999',
        email: null,
        addressLine1: '900 Fauntleroy Way SW',
        city: 'Seattle',
        state: 'WA',
        postalCode: '98116',
        cluster: 'seattle',
        facts: [],
        sourceCapture: intake.key,
      },
    ],
    jobs: [
      {
        key: 'canary-job',
        customerKey: 'canary',
        title: 'Boiler replacement (other firm)',
        jobType: 'hvac',
        status: 'open',
        durationMinutes: 120,
        facts: [],
      },
    ],
    visits: [
      {
        key: 'canary-visit',
        jobKey: 'canary-job',
        technicianRef: 'tech-other',
        date: nextWorkday(addDays(anchor, 1)),
        startTime: '09:00',
        durationMinutes: 120,
        status: 'confirmed',
        promiseLevel: 'none',
      },
    ],
    timeOff: [],
    durations: [],
    coldSandboxes: 0,
  };
}

// ─────────────────────────────────────────────────────────────────── helpers ──

/** End time of a placed visit, as an HH:MM wall clock. */
export function visitEndTime(v: VisitSpec): string {
  if (!v.startTime || v.durationMinutes == null) throw new Error(`visit ${v.key} is not placed`);
  return addMinutes(v.startTime, v.durationMinutes);
}

/** The naive-local [start, end) a placed visit occupies. */
export function visitRange(v: VisitSpec): { startsAt: string; endsAt: string } {
  if (!v.date) throw new Error(`visit ${v.key} has no date`);
  return {
    startsAt: naiveLocal(v.date, v.startTime as string),
    endsAt: naiveLocal(v.date, visitEndTime(v)),
  };
}

export const isPlacedSpec = (v: VisitSpec): boolean => v.date !== undefined;

/** Every weekday name a technician's pattern allows work on. */
export function workingDayNames(t: TechnicianSpec): Weekday[] {
  const names: Weekday[] = [];
  const order: Weekday[] = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  DAY_KEYS.forEach((k, i) => {
    if ((t.availability?.[k] ?? []).length > 0) names.push(order[i]);
  });
  return names;
}

export { isWeekend };
