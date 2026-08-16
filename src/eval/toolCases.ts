// Tier 1 — the tool-layer cases.
//
// These do NOT re-test tool semantics. src/mcp/server.test.ts is 329KB and
// already does that exhaustively against small fixtures. Tier 1 exists for the
// five things unit tests structurally cannot see:
//
//   1. per-tool LATENCY on a realistic world (191 visits, not 3 rows)
//   2. the real INTEGRATION path — HTTP + HMAC identity + stateless MCP
//   3. TIER GATING — a technician badge must not even be offered admin tools
//   4. cross-tenant ISOLATION — one firm's data must never reach another's manager
//   5. that every tool still ANSWERS at all (the "it timed out" complaint)
//
// So the checks are outcome-shaped, not shape-shaped: "did it refuse", "does the
// reply name this customer", "did the row actually land in the database". That
// keeps them robust to response-shape churn while still failing on real breakage.

import type { TenantKey, TenantManifest, WorldManifest } from './worldManifest.js';
import { captureId, customerId, customerName, jobId, visitId } from './worldManifest.js';
import { addDays, naiveLocal, nextWorkday } from './clock.js';

/** An external dependency a case needs. Cases carrying one are skipped LOUDLY. */
export type Requirement = 'model' | 'network' | 'composio' | 'maps';

export interface ToolOutcome {
  /** false = transport/protocol failure. A tool REFUSAL is ok:true, isError:true. */
  ok: boolean;
  isError: boolean;
  timedOut: boolean;
  httpStatus: number;
  text: string;
  json: unknown;
  ms: number;
}

export interface CaseContext {
  world: WorldManifest;
  tenant: TenantManifest;
  anchor: string;
  /** Outcomes of the earlier steps in this same case. */
  prior: ToolOutcome[];
  /** Read-only SQL, for verifying a write actually landed. */
  sql: (text: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;
}

export type Check = (out: ToolOutcome, ctx: CaseContext) => Promise<string | null> | string | null;

export interface ToolStep {
  label: string;
  /** Defaults to the case's tool. */
  tool?: string;
  /** Defaults to the case's badge. */
  badge?: string;
  args: (ctx: CaseContext) => Record<string, unknown>;
  check?: Check;
  /** Skip this step unless the earlier ones made it applicable (e.g. a staged confirm). */
  when?: (ctx: CaseContext) => boolean;
  /** tools/list instead of tools/call — the tier-gating probe. */
  listTools?: true;
}

export interface ToolCase {
  id: string;
  family: string;
  title: string;
  /** The tool this case is ABOUT — latency is grouped by this. */
  tool: string;
  tenant: TenantKey;
  badge: string;
  requires?: Requirement;
  steps: ToolStep[];
}

// ───────────────────────────────────────────────────────────────── check kit ──

const ok: Check = (out) =>
  out.isError ? `the tool refused or errored: ${out.text.slice(0, 200)}` : null;

const refused =
  (pattern?: RegExp): Check =>
  (out) => {
    if (!out.isError && !(pattern && pattern.test(out.text))) {
      return `expected a refusal, got a normal result: ${out.text.slice(0, 200)}`;
    }
    if (pattern && !pattern.test(out.text)) {
      return `refused, but the message does not explain why (want ${pattern}): ${out.text.slice(0, 200)}`;
    }
    return null;
  };

const mentions =
  (...needles: string[]): Check =>
  (out) => {
    const hay = out.text.toLowerCase();
    const missing = needles.filter((n) => !hay.includes(n.toLowerCase()));
    return missing.length ? `result never mentions ${missing.map((m) => `'${m}'`).join(', ')}` : null;
  };

const omits =
  (...needles: string[]): Check =>
  (out) => {
    const hay = out.text.toLowerCase();
    const leaked = needles.filter((n) => hay.includes(n.toLowerCase()));
    return leaked.length ? `result LEAKED ${leaked.map((m) => `'${m}'`).join(', ')}` : null;
  };

const all =
  (...checks: Check[]): Check =>
  async (out, ctx) => {
    for (const c of checks) {
      const failure = await c(out, ctx);
      if (failure) return failure;
    }
    return null;
  };

/** The confirmId a staged tool handed back, if it staged at all. */
export function confirmIdOf(out: ToolOutcome | undefined): string | null {
  if (!out) return null;
  const fromJson = (out.json as { confirmId?: unknown } | null)?.confirmId;
  if (typeof fromJson === 'string') return fromJson;
  const m = /"confirmId"\s*:\s*"([^"]+)"/.exec(out.text);
  return m ? m[1] : null;
}

const staged: Check = (out) =>
  confirmIdOf(out) ? null : `expected a staged preview with a confirmId, got: ${out.text.slice(0, 200)}`;

/** Only run the follow-up when the first call actually staged something. */
const ifStaged = (ctx: CaseContext) => confirmIdOf(ctx.prior[ctx.prior.length - 1]) !== null;
const lastConfirmId = (ctx: CaseContext) => ({ confirmId: confirmIdOf(ctx.prior[ctx.prior.length - 1]) as string });

/** A DB read-back check: `expect` rows to satisfy a predicate. */
const dbCheck =
  (
    describe: string,
    query: (ctx: CaseContext) => { text: string; params: unknown[] },
    predicate: (rows: Record<string, unknown>[]) => boolean,
  ): Check =>
  async (_out, ctx) => {
    const { text, params } = query(ctx);
    const rows = await ctx.sql(text, params);
    return predicate(rows) ? null : `${describe} — database says ${JSON.stringify(rows).slice(0, 200)}`;
  };

const count = (rows: Record<string, unknown>[]) => Number(rows[0]?.n ?? 0);

// ─────────────────────────────────────────────────────────────────── the set ──

/** A free workday well inside the horizon, for booking fixtures. */
const bookingDay = (ctx: CaseContext) => nextWorkday(addDays(ctx.anchor, 4));

export function buildToolCases(): ToolCase[] {
  const cases: ToolCase[] = [];
  const add = (c: ToolCase) => cases.push(c);
  /** Single-step shorthand — most read cases are one call and one assertion. */
  const one = (
    c: Omit<ToolCase, 'steps'> & { args: ToolStep['args']; check: Check; label?: string },
  ) => {
    const { args, check, label, ...rest } = c;
    add({ ...rest, steps: [{ label: label ?? rest.tool, args, check }] });
  };

  // ── reads ────────────────────────────────────────────────────────────────────
  one({
    id: 'R01',
    family: 'reads',
    title: 'find_customer disambiguates a shared surname instead of picking',
    tool: 'find_customer',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({ query: 'Whitfield' }),
    // BOTH must come back. A tool that silently returns one of two matches is how
    // the agent ends up confidently working on the wrong customer.
    check: all(ok, mentions('Dana Whitfield', 'Marcus Whitfield')),
  });

  one({
    id: 'R02',
    family: 'reads',
    title: 'get_customer_context returns the rich history',
    tool: 'get_customer_context',
    tenant: 'main',
    badge: 'manager-sam',
    args: (ctx) => ({ customerId: customerId(ctx.tenant, 'edge-rich') }),
    check: all(ok, mentions('Kastellani', 'gate_code')),
  });

  one({
    id: 'R03',
    family: 'reads',
    title: 'get_job fetches one job',
    tool: 'get_job',
    tenant: 'main',
    badge: 'manager-sam',
    args: (ctx) => ({ jobId: jobId(ctx.tenant, 'job-rich-1') }),
    check: all(ok, mentions('AC not cooling')),
  });

  one({
    id: 'R04',
    family: 'reads',
    title: 'resolve_date carries the grounding rider',
    tool: 'resolve_date',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({ dayShift: 1 }),
    check: all(ok, (out, ctx) => {
      const j = out.json as { date?: string; today?: string; now?: string } | null;
      if (j?.date !== addDays(ctx.anchor, 1)) return `date ${String(j?.date)} ≠ ${addDays(ctx.anchor, 1)}`;
      // The `now` rider rides on every result by design (PR #83) — its absence is
      // a silent regression that costs the model its only grounding.
      if (!j?.now) return 'result carries no `now` grounding rider';
      return null;
    }),
  });

  one({
    id: 'R05',
    family: 'reads',
    title: 'list_recent_captures shows the customer trail',
    tool: 'list_recent_captures',
    tenant: 'main',
    badge: 'manager-sam',
    args: (ctx) => ({ customerId: customerId(ctx.tenant, 'edge-rich') }),
    // A technician note, NOT the intake call: an intake capture is written before
    // its customer exists, so it carries no customer_id and correctly does not
    // appear in a customer-scoped list. (It is still reachable as the customer's
    // source_capture_id, which is how the retract-fold in W03 finds it.)
    check: all(ok, mentions('Replaced the run capacitor')),
  });

  one({
    id: 'R06',
    family: 'reads',
    title: 'get_schedule gives a technician their own day with a maps link',
    tool: 'get_schedule',
    tenant: 'main',
    badge: 'tech-jane',
    args: (ctx) => ({ from: ctx.anchor, to: ctx.anchor }),
    check: all(ok, mentions('mapsUrl')),
  });

  one({
    id: 'R07',
    family: 'reads',
    title: 'get_team_schedule returns the whole board for a day',
    tool: 'get_team_schedule',
    tenant: 'main',
    badge: 'manager-sam',
    args: (ctx) => ({ from: ctx.anchor, to: ctx.anchor }),
    check: all(ok, mentions('stops')),
  });

  one({
    id: 'R08',
    family: 'reads',
    title: 'get_team_schedule over a whole week stays inside its cap',
    tool: 'get_team_schedule',
    tenant: 'main',
    badge: 'manager-sam',
    args: (ctx) => ({ from: ctx.anchor, to: addDays(ctx.anchor, 6) }),
    check: ok,
  });

  one({
    id: 'R09',
    family: 'reads',
    title: 'list_team lists the roster',
    tool: 'list_team',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({}),
    check: all(ok, mentions('tech-jane', 'helper-pat')),
  });

  one({
    id: 'R10',
    family: 'reads',
    title: 'list_pending_reviews answers even when empty',
    tool: 'list_pending_reviews',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({}),
    check: ok,
  });

  one({
    id: 'R11',
    family: 'reads',
    title: 'get_availability reports a working pattern',
    tool: 'get_availability',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({ ref: 'tech-jane' }),
    check: all(ok, mentions('08:00')),
  });

  one({
    id: 'R12',
    family: 'reads',
    title: 'query_spine runs a read-only query through the tenant views',
    tool: 'query_spine',
    tenant: 'main',
    badge: 'manager-sam',
    // The SQL executes inside a SECURITY DEFINER function against tenant-scoped
    // VIEWS — the tenant is a separate verified parameter, never interpolated.
    args: () => ({ sql: 'select count(*) as n from v_customers' }),
    // Compared against a DIRECT count rather than a pinned number. The first
    // version asserted '50' and broke the moment the world grew a fixture pool —
    // a literal in an expectation is the same rot as a literal in a seed.
    check: all(ok, async (out, ctx) => {
      const rows = await ctx.sql('select count(*)::int as n from customers where tenant_id = $1', [ctx.tenant.id]);
      const direct = Number(rows[0]?.n ?? -1);
      return out.text.includes(String(direct))
        ? null
        : `query_spine reported a count that disagrees with a direct one (${direct}): ${out.text.slice(0, 160)}`;
    }),
  });

  one({
    id: 'R13',
    family: 'reads',
    title: 'a customer with no address reports no maps link rather than inventing one',
    tool: 'get_customer_context',
    tenant: 'main',
    badge: 'manager-sam',
    args: (ctx) => ({ customerId: customerId(ctx.tenant, 'edge-no-address') }),
    check: all(ok, mentions('Delacroix')),
  });

  one({
    id: 'R14',
    family: 'reads',
    title: 'find_slots offers candidates for a job that has a length',
    tool: 'find_slots',
    tenant: 'main',
    badge: 'manager-sam',
    args: (ctx) => ({ jobId: jobId(ctx.tenant, 'job-loose-2') }),
    check: ok,
  });

  one({
    id: 'R15',
    family: 'reads',
    title: 'find_slots FAILS CLOSED on a job with no length',
    tool: 'find_slots',
    tenant: 'main',
    badge: 'manager-sam',
    args: (ctx) => ({ jobId: jobId(ctx.tenant, 'job-durationless') }),
    // Never a 120-minute assumption: the duration ladder must be offered instead.
    check: (out) =>
      /how long|duration|minutes|length/i.test(out.text)
        ? null
        : `expected a fail-closed ask for the job length, got: ${out.text.slice(0, 200)}`,
  });

  // ── tier gating and isolation ────────────────────────────────────────────────
  add({
    id: 'G01',
    family: 'gating',
    title: 'a manager badge is offered the full surface',
    tool: 'tools/list',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'tools/list as manager',
        listTools: true,
        args: () => ({}),
        check: (out) => {
          const names = (out.json as string[]) ?? [];
          if (names.length !== 42) return `manager sees ${names.length} tools, expected 42`;
          for (const need of ['book_visit', 'run_freeze', 'query_spine', 'add_technician_seat', 'record_money_event']) {
            if (!names.includes(need)) return `manager surface is missing ${need}`;
          }
          // get_schedule is deliberately withheld from managers (PR #54).
          if (names.includes('get_schedule')) return 'manager was offered get_schedule, which was removed for managers';
          return null;
        },
      },
    ],
  });

  add({
    id: 'G02',
    family: 'gating',
    title: 'a technician badge is offered no admin surface at all',
    tool: 'tools/list',
    tenant: 'main',
    badge: 'tech-jane',
    steps: [
      {
        label: 'tools/list as technician',
        listTools: true,
        args: () => ({}),
        check: (out) => {
          const names = (out.json as string[]) ?? [];
          if (names.length !== 14) return `technician sees ${names.length} tools, expected 14`;
          if (!names.includes('get_schedule')) return 'technician surface is missing get_schedule';
          const leaked = ['book_visit', 'run_freeze', 'add_technician_seat', 'query_spine', 'get_team_schedule'].filter(
            (n) => names.includes(n),
          );
          return leaked.length ? `technician was OFFERED admin tools: ${leaked.join(', ')}` : null;
        },
      },
    ],
  });

  one({
    id: 'G03',
    family: 'gating',
    title: 'a technician calling an admin tool by name is refused at dispatch',
    tool: 'book_visit',
    tenant: 'main',
    badge: 'tech-jane',
    // Not being offered a tool is not the same as not being able to call it. The
    // surface is a hint; requireManager is the boundary.
    args: (ctx) => ({
      jobId: jobId(ctx.tenant, 'job-t1-bk-08'),
      technicianRef: 'cfg-tech-08',
      date: bookingDay(ctx),
      startTime: '09:00',
      endTime: '10:00',
    }),
    check: all(
      refused(/manager|not authorized|unknown tool/i),
      dbCheck(
        'the refused booking must not have written a row',
        (ctx) => ({
          text: 'select count(*)::int n from assignments where job_id = $1',
          params: [jobId(ctx.tenant, 'job-t1-bk-08')],
        }),
        (rows) => count(rows) === 0,
      ),
    ),
  });

  one({
    id: 'G04',
    family: 'gating',
    title: "one firm's manager cannot find another firm's customer",
    tool: 'find_customer',
    tenant: 'main',
    badge: 'manager-sam',
    // Tenant isolation rests on a hand-written filter in every accessor, with RLS
    // off and the service-role key in play. This is the leak canary.
    args: (ctx) => ({ query: ctx.world.edges.crossTenantCanary.split(' ')[0] }),
    check: (out, ctx) => omits(ctx.world.edges.crossTenantCanary)(out, ctx),
  });

  one({
    id: 'G05',
    family: 'gating',
    title: "another firm's job id is not readable by id",
    tool: 'get_job',
    tenant: 'main',
    badge: 'manager-sam',
    args: (ctx) => ({ jobId: jobId(other(ctx), 'canary-job') }),
    // A bare `null` is the fail-closed answer: the tenant-scoped accessor matched
    // no row. Anything that echoes the foreign job back is the leak.
    check: (out) =>
      out.isError || out.text.trim() === 'null' || /not found|no job|unknown/i.test(out.text)
        ? null
        : `a foreign job id was READ across the tenant boundary: ${out.text.slice(0, 200)}`,
  });

  one({
    id: 'G06',
    family: 'gating',
    title: 'query_spine cannot reach another tenant even when asked to',
    tool: 'query_spine',
    tenant: 'main',
    badge: 'manager-sam',
    // The model's SQL runs against tenant-scoped views with the tenant supplied
    // separately, so an explicit cross-tenant predicate must still come back empty.
    args: (ctx) => ({ sql: `select name from v_customers where name like '%${ctx.world.edges.crossTenantCanary.split(' ')[0]}%'` }),
    check: (out, ctx) => omits(ctx.world.edges.crossTenantCanary)(out, ctx),
  });

  // ── staged writes ───────────────────────────────────────────────────────────
  add({
    id: 'W01',
    family: 'writes',
    title: 'record_field_note stages before it records, and records on confirm',
    tool: 'record_field_note',
    tenant: 'main',
    badge: 'tech-jane',
    // Model-backed: the note is passed through a FORCED tool call that extracts
    // structured fields (src/writePath/extract.ts), so the technician's primary
    // capture verb cannot run without INFERENCE_API_KEY.
    requires: 'model',
    steps: [
      {
        label: 'stage the note',
        args: (ctx) => ({
          text: `Replaced the thermostat for ${customerName(ctx.tenant, 'fx-t1-cap-01')} and tested the cycle.`,
        }),
        // Either a preview or a needs_identity question — both are "nothing
        // recorded yet", which is the property that matters.
        check: all(
          ok,
          (out) =>
            /needs_confirmation|needs_identity/.test(out.text)
              ? null
              : `first call neither staged nor asked who: ${out.text.slice(0, 200)}`,
        ),
      },
      {
        label: 'confirm with the customer named',
        when: ifStaged,
        args: (ctx) => ({
          confirmId: confirmIdOf(ctx.prior[0]) as string,
          confirmed: { customerId: customerId(ctx.tenant, 'fx-t1-cap-01') },
        }),
        check: all(
          ok,
          dbCheck(
            'the confirmed note must be in L1',
            (ctx) => ({
              text: `select count(*)::int n from raw_captures
                      where tenant_id = $1 and customer_id = $2 and raw_text like '%thermostat%'`,
              params: [ctx.tenant.id, customerId(ctx.tenant, 'fx-t1-cap-01')],
            }),
            (rows) => count(rows) >= 1,
          ),
        ),
      },
    ],
  });

  add({
    id: 'W02',
    family: 'writes',
    title: 'record_standing_fact takes three facts in ONE confirmation',
    tool: 'record_standing_fact',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'stage three facts',
        args: (ctx) => ({
          customerId: customerId(ctx.tenant, 'fx-t1-cap-02'),
          facts: [
            { key: 'gate_code', value: '9182' },
            { key: 'prefers_contact', value: 'text message' },
            { key: 'pets', value: 'two cats indoors' },
          ],
          sourceText: 'Gate code is 9182, text me rather than call, and there are two cats inside.',
        }),
        // One preview listing all three — not three confirmations for one breath
        // of speech.
        check: all(staged, mentions('gate_code', 'prefers_contact', 'pets')),
      },
      {
        label: 'confirm',
        when: ifStaged,
        args: lastConfirmId,
        check: all(
          ok,
          dbCheck(
            'all three facts must be stored as evidence-carrying bundles',
            (ctx) => ({
              text: 'select attributes from customers where id = $1',
              params: [customerId(ctx.tenant, 'fx-t1-cap-02')],
            }),
            (rows) => {
              const attrs = (rows[0]?.attributes ?? {}) as Record<string, { sourceCaptureId?: string }>;
              return ['gate_code', 'prefers_contact', 'pets'].every(
                (k) => attrs[k] && typeof attrs[k].sourceCaptureId === 'string',
              );
            },
          ),
        ),
      },
    ],
  });

  add({
    id: 'W03',
    family: 'writes',
    title: 'retract_capture previews exactly which standing facts would fold',
    tool: 'retract_capture',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'stage the retraction (never confirmed)',
        args: (ctx) => ({
          captureId: captureId(ctx.tenant, 'cap-rich-intake'),
          reason: 'eval: staged only, deliberately not confirmed',
        }),
        // Stage ONLY. Confirming would fold the rich-history fixture that other
        // cases read — and L1 has no delete path, so it could not be undone.
        check: all(staged, mentions('willAlsoRemove')),
      },
      {
        label: 'nothing was retracted',
        // A second read proving the stage was inert. The staged copy is what
        // commits, so an eager implementation would already have folded the facts.
        tool: 'get_customer_context',
        args: (ctx) => ({ customerId: customerId(ctx.tenant, 'edge-rich') }),
        check: all(ok, mentions('gate_code')),
      },
    ],
  });

  add({
    id: 'W04',
    family: 'writes',
    title: 'book_visit puts a real row on the calendar',
    tool: 'book_visit',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'book',
        args: (ctx) => ({
          jobId: jobId(ctx.tenant, 'job-t1-bk-01'),
          technicianRef: 'cfg-tech-06',
          date: bookingDay(ctx),
          startTime: '09:00',
          endTime: '10:00',
        }),
        check: ok,
      },
      {
        label: 'confirm if it staged',
        when: ifStaged,
        args: lastConfirmId,
        check: ok,
      },
      {
        label: 'the row is on the calendar at the naive-local time asked for',
        tool: 'get_job',
        args: (ctx) => ({ jobId: jobId(ctx.tenant, 'job-t1-bk-01') }),
        check: dbCheck(
          'a confirmed assignment must exist at exactly 09:00 on the requested day',
          (ctx) => ({
            text: `select count(*)::int n from assignments
                    where job_id = $1 and status = 'confirmed' and starts_at = $2`,
            params: [jobId(ctx.tenant, 'job-t1-bk-01'), naiveLocal(bookingDay(ctx), '09:00')],
          }),
          (rows) => count(rows) === 1,
        ),
      },
    ],
  });

  add({
    id: 'W05',
    family: 'writes',
    title: 'move_visit on an unpromised visit moves it without ceremony',
    tool: 'move_visit',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'move an unpromised visit',
        // visit-rs-01 carries promiseLevel 'none' (odd fixtures are unpromised),
        // so doctrine says one-shot: act, then say what you did.
        args: (ctx) => ({
          assignmentId: visitId(ctx.tenant, 'visit-t1-rs-01'),
          date: nextWorkday(addDays(ctx.anchor, 9)),
          // 16:15, not 15:15: the rs fixtures themselves sit at 15:15 across
          // seven consecutive working days, so a move INTO that window collides
          // with a sibling fixture. jane's book is clear from 15:45 to 17:00.
          startTime: '16:15',
          endTime: '16:45',
          reason: 'eval: unpromised move',
        }),
        check: ok,
      },
      { label: 'confirm if it staged', when: ifStaged, args: lastConfirmId, check: ok },
      {
        label: 'the calendar moved',
        tool: 'get_team_schedule',
        args: (ctx) => ({ from: nextWorkday(addDays(ctx.anchor, 9)), to: nextWorkday(addDays(ctx.anchor, 9)) }),
        check: dbCheck(
          'a confirmed row must now sit on the new day',
          (ctx) => ({
            text: `select count(*)::int n from assignments
                    where tenant_id = $1 and status = 'confirmed'
                      and starts_at = $2`,
            params: [ctx.tenant.id, naiveLocal(nextWorkday(addDays(ctx.anchor, 9)), '16:15')],
          }),
          (rows) => count(rows) >= 1,
        ),
      },
    ],
  });

  add({
    id: 'W06',
    family: 'writes',
    title: 'moving a DAY-PROMISED visit off its promised day demands a confirmation',
    tool: 'move_visit',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'try to move a promised visit',
        // visit-rs-02 is promised at day level. Breaking a promise made to a
        // customer is the case the ladder exists to gate.
        args: (ctx) => ({
          assignmentId: visitId(ctx.tenant, 'visit-t1-rs-02'),
          date: nextWorkday(addDays(ctx.anchor, 11)),
          // 06:00 — BEFORE every pattern's open (earliest 07:00) and every
          // generated slot (earliest 07:30), so no anchor can ever place a
          // colliding visit here. The first version used 16:15, inside working
          // hours, and for anchor 2026-08-13 the generator happened to occupy
          // that slot: the overlap pre-check fired before the promise gate and
          // the case failed without ever testing what it exists to test. The
          // scenario has to OWN its destination slot, same as its rows.
          startTime: '06:00',
          endTime: '06:30',
          reason: 'eval: promised move',
        }),
        check: (out) =>
          confirmIdOf(out) || /promis/i.test(out.text)
            ? null
            : `a promised day was moved with no gate: ${out.text.slice(0, 200)}`,
      },
      {
        label: 'nothing moved before the yes',
        when: (ctx) => confirmIdOf(ctx.prior[0]) !== null,
        tool: 'get_job',
        args: (ctx) => ({ jobId: jobId(ctx.tenant, 'job-t1-rs-02') }),
        check: dbCheck(
          'the visit must still be on its promised day until confirmed',
          (ctx) => ({
            text: `select count(*)::int n from assignments
                    where id = $1 and status = 'confirmed' and (starts_at)::date = promised_day`,
            params: [visitId(ctx.tenant, 'visit-t1-rs-02')],
          }),
          (rows) => count(rows) === 1,
        ),
      },
    ],
  });

  add({
    id: 'W07',
    family: 'writes',
    title: 'unschedule_visit says the WORK survives',
    tool: 'unschedule_visit',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'unschedule',
        args: (ctx) => ({ assignmentId: visitId(ctx.tenant, 'visit-t1-rs-03'), reason: 'eval: unschedule path' }),
        // The vocabulary matters: "cancel" a visit and "cancel" the job are
        // different acts, and the 2026-07-25 device pass found the agent
        // conflating them. The tool must disclose which one this is.
        check: (out) =>
          /loose|open|still|not cancelled|unschedul/i.test(out.text)
            ? null
            : `no disclosure that the work itself survives: ${out.text.slice(0, 200)}`,
      },
      { label: 'confirm if it staged', when: ifStaged, args: lastConfirmId, check: ok },
      {
        label: 'the job is still open',
        tool: 'get_job',
        args: (ctx) => ({ jobId: jobId(ctx.tenant, 'job-t1-rs-03') }),
        check: dbCheck(
          'the job must remain open after its visit is unscheduled',
          (ctx) => ({ text: `select status from jobs where id = $1`, params: [jobId(ctx.tenant, 'job-t1-rs-03')] }),
          (rows) => rows[0]?.status === 'open',
        ),
      },
    ],
  });

  add({
    id: 'W08',
    family: 'writes',
    title: 'cancel_job always confirms, and discloses the cascade',
    tool: 'cancel_job',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'stage the cancellation',
        args: (ctx) => ({ jobId: jobId(ctx.tenant, 'job-t1-rs-04'), reason: 'eval: cancel_job path' }),
        // Terminal and irreversible, so it confirms unconditionally under the
        // PR #48 doctrine — no promise level exempts it.
        check: staged,
      },
      {
        label: 'confirm',
        when: ifStaged,
        args: lastConfirmId,
        check: all(
          ok,
          dbCheck(
            'the job must be terminal and its visits cancelled',
            (ctx) => ({
              text: `select j.status,
                            (select count(*)::int from assignments a
                              where a.job_id = j.id and a.status <> 'cancelled') as live
                       from jobs j where j.id = $1`,
              params: [jobId(ctx.tenant, 'job-t1-rs-04')],
            }),
            (rows) => rows[0]?.status === 'cancelled' && Number(rows[0]?.live ?? 1) === 0,
          ),
        ),
      },
    ],
  });

  add({
    id: 'W09',
    family: 'writes',
    title: 'set_promise records what the customer was told',
    tool: 'set_promise',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'promise the day',
        args: (ctx) => ({ assignmentId: visitId(ctx.tenant, 'visit-t1-rs-05'), promiseLevel: 'day' }),
        check: ok,
      },
      { label: 'confirm if it staged', when: ifStaged, args: lastConfirmId, check: ok },
      {
        label: 'the promised day is server-derived',
        tool: 'get_job',
        args: (ctx) => ({ jobId: jobId(ctx.tenant, 'job-t1-rs-05') }),
        // promised_day is derived from the visit's OWN date — never from agent
        // date arithmetic (the bookVisit precedent).
        check: dbCheck(
          'promise_level day with promised_day equal to the visit date',
          (ctx) => ({
            text: `select promise_level, promised_day::text = (starts_at)::date::text as agrees
                     from assignments where id = $1`,
            params: [visitId(ctx.tenant, 'visit-t1-rs-05')],
          }),
          (rows) => rows[0]?.promise_level === 'day' && rows[0]?.agrees === true,
        ),
      },
    ],
  });

  add({
    id: 'W10',
    family: 'writes',
    title: 'set_visit_locks pins a visit as a human privilege',
    tool: 'set_visit_locks',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'pin one visit',
        args: (ctx) => ({ locked: true, assignmentIds: [visitId(ctx.tenant, 'visit-t1-rs-06')] }),
        check: ok,
      },
      { label: 'confirm if it staged', when: ifStaged, args: lastConfirmId, check: ok },
      {
        label: 'the pin is on the row',
        tool: 'get_job',
        args: (ctx) => ({ jobId: jobId(ctx.tenant, 'job-t1-rs-06') }),
        check: dbCheck(
          'the visit must be locked',
          (ctx) => ({ text: 'select locked from assignments where id = $1', params: [visitId(ctx.tenant, 'visit-t1-rs-06')] }),
          (rows) => rows[0]?.locked === true,
        ),
      },
    ],
  });

  one({
    id: 'W11',
    family: 'writes',
    title: 'update_job echoes the old and new title',
    tool: 'update_job',
    tenant: 'main',
    badge: 'manager-sam',
    args: (ctx) => ({ jobId: jobId(ctx.tenant, 'job-t1-bk-02'), title: 'Condenser coil clean (eval W11)' }),
    check: all(ok, mentions('Condenser coil clean')),
  });

  one({
    id: 'W12',
    family: 'writes',
    title: 'set_job_duration teaches the firm a default length',
    tool: 'set_job_duration',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({ jobType: 'roofing', minutes: 240 }),
    check: all(
      ok,
      dbCheck(
        'the duration must be stored for the tenant',
        (ctx) => ({
          text: `select minutes from job_type_durations where tenant_id = $1 and job_type = 'roofing'`,
          params: [ctx.tenant.id],
        }),
        (rows) => Number(rows[0]?.minutes) === 240,
      ),
    ),
  });

  one({
    id: 'W13',
    family: 'writes',
    title: 'record_money_event lands a ledger fact',
    tool: 'record_money_event',
    tenant: 'main',
    badge: 'manager-sam',
    // fee_charged on purpose: it never holds the status gate, so the world
    // job's status is untouched and no other case can be perturbed by this one
    // (an invoice_issued here would walk the job to 'invoiced' world-wide).
    args: (ctx) => ({
      jobId: jobId(ctx.tenant, 'job-t1-bk-02'),
      kind: 'fee_charged',
      amountCents: 8900,
      note: 'diagnostic fee (eval W13)',
    }),
    check: all(
      ok,
      dbCheck(
        'the ledger row must land, amount intact, with the acting badge stamped',
        (ctx) => ({
          text:
            `select amount_cents, actor_ref from money_events ` +
            `where tenant_id = $1 and job_id = $2 and kind = 'fee_charged'`,
          params: [ctx.tenant.id, jobId(ctx.tenant, 'job-t1-bk-02')],
        }),
        (rows) => Number(rows[0]?.amount_cents) === 8900 && rows[0]?.actor_ref === 'manager-sam',
      ),
    ),
  });

  // ── roster and configuration (each owns its own technician) ─────────────────
  one({
    id: 'C01',
    family: 'config',
    title: 'set_technician_skills records skills',
    tool: 'set_technician_skills',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({ ref: 'cfg-tech-01', skills: ['plumbing', 'gas'] }),
    check: all(
      ok,
      dbCheck(
        'skills must be stored',
        (ctx) => ({ text: 'select skills from technicians where tenant_id = $1 and ref = $2', params: [ctx.tenant.id, 'cfg-tech-01'] }),
        (rows) => JSON.stringify(rows[0]?.skills ?? []).includes('plumbing'),
      ),
    ),
  });

  one({
    id: 'C02',
    family: 'config',
    title: 'set_availability rewrites a weekly pattern',
    tool: 'set_availability',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({
      ref: 'cfg-tech-02',
      pattern: { mon: [['07:00', '12:00']], tue: [['07:00', '12:00']], wed: [], thu: [], fri: [], sat: [], sun: [] },
    }),
    check: all(
      ok,
      dbCheck(
        'the new pattern must be stored',
        (ctx) => ({ text: 'select availability from technicians where tenant_id = $1 and ref = $2', params: [ctx.tenant.id, 'cfg-tech-02'] }),
        (rows) => JSON.stringify(rows[0]?.availability ?? {}).includes('07:00'),
      ),
    ),
  });

  add({
    id: 'C03',
    family: 'config',
    title: 'time off is added and removed again',
    tool: 'add_time_off',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'add time off',
        args: (ctx) => ({
          ref: 'cfg-tech-03',
          startsOn: nextWorkday(addDays(ctx.anchor, 15)),
          endsOn: nextWorkday(addDays(ctx.anchor, 16)),
          reason: 'eval: time off',
        }),
        check: ok,
      },
      { label: 'confirm if it staged', when: ifStaged, args: lastConfirmId, check: ok },
      {
        label: 'remove it',
        tool: 'remove_time_off',
        args: (ctx) => ({ ref: 'cfg-tech-03', date: nextWorkday(addDays(ctx.anchor, 15)) }),
        check: all(
          ok,
          dbCheck(
            'the time-off row must be gone',
            (ctx) => ({
              text: `select count(*)::int n from technician_time_off o
                       join technicians t on t.id = o.technician_id
                      where t.tenant_id = $1 and t.ref = 'cfg-tech-03'`,
              params: [ctx.tenant.id],
            }),
            (rows) => count(rows) === 0,
          ),
        ),
      },
    ],
  });

  one({
    id: 'C04',
    family: 'config',
    title: 'set_technician_horizon takes weeks, not days',
    tool: 'set_technician_horizon',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({ weeks: 6 }),
    check: all(
      ok,
      dbCheck(
        'the horizon must be stored as 42 days',
        (ctx) => ({ text: 'select technician_horizon_days from tenants where id = $1', params: [ctx.tenant.id] }),
        (rows) => Number(rows[0]?.technician_horizon_days) === 42,
      ),
    ),
  });

  one({
    id: 'C05',
    family: 'config',
    title: 'bind_telegram links a chat account to a roster row',
    tool: 'bind_telegram',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({ ref: 'cfg-tech-05', telegramUserId: '9100000001' }),
    check: all(
      ok,
      dbCheck(
        'the telegram id must be on the roster row',
        (ctx) => ({ text: 'select telegram_user_id from technicians where tenant_id = $1 and ref = $2', params: [ctx.tenant.id, 'cfg-tech-05'] }),
        (rows) => String(rows[0]?.telegram_user_id ?? '') === '9100000001',
      ),
    ),
  });

  add({
    id: 'C06',
    family: 'config',
    title: 'a seat is deactivated and reactivated',
    tool: 'deactivate_technician_seat',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      { label: 'stage the deactivation', args: () => ({ ref: 'cfg-tech-04' }), check: staged },
      {
        // Unlike the other staged verbs, this one wants the ref BACK on the
        // confirming call — confirmId alone is refused with "ref is required".
        label: 'confirm',
        when: ifStaged,
        args: (ctx) => ({ ref: 'cfg-tech-04', ...lastConfirmId(ctx) }),
        check: ok,
      },
      {
        label: 'reactivate',
        tool: 'reactivate_technician_seat',
        args: () => ({ ref: 'cfg-tech-04' }),
        check: all(
          ok,
          // Reactivation returns the person to 'invited', NOT straight to
          // 'active': the seat is theirs again but the pairing lifecycle starts
          // over, and the reply must say what the manager has to do next. Pinned
          // because a future change to 'active' would silently hand someone a
          // live badge they never re-paired for.
          (out) =>
            /get_connect_link|bind_telegram|pair/i.test(out.text)
              ? null
              : `reactivation did not tell the manager how to finish re-pairing: ${out.text.slice(0, 200)}`,
          dbCheck(
            'the roster row must be back in the pairing lifecycle',
            (ctx) => ({ text: 'select state from technicians where tenant_id = $1 and ref = $2', params: [ctx.tenant.id, 'cfg-tech-04'] }),
            (rows) => rows[0]?.state === 'invited',
          ),
        ),
      },
    ],
  });

  add({
    id: 'C07',
    family: 'config',
    title: 'add_technician_seat mints a ref and occupies a seat',
    tool: 'add_technician_seat',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      {
        label: 'stage the seat',
        args: () => ({ displayName: 'Wendell Ashgrove' }),
        // Irreversible: the ref is permanent and never reused, because L1
        // attribution is append-only and would merge two people's history.
        check: all(staged, mentions('wendell-ashgrove')),
      },
      {
        label: 'confirm',
        when: ifStaged,
        args: lastConfirmId,
        check: all(
          ok,
          dbCheck(
            'the roster row must exist',
            (ctx) => ({ text: 'select count(*)::int n from technicians where tenant_id = $1 and ref = $2', params: [ctx.tenant.id, 'wendell-ashgrove'] }),
            (rows) => count(rows) === 1,
          ),
        ),
      },
    ],
  });

  add({
    id: 'C08',
    family: 'config',
    title: 'a seat-exempt part-timer can be added without occupying a seat',
    tool: 'add_technician_seat',
    tenant: 'main',
    badge: 'manager-sam',
    steps: [
      { label: 'stage a schedule-only helper', args: () => ({ displayName: 'Perpetua Voss', seatExempt: true }), check: staged },
      {
        label: 'confirm',
        when: ifStaged,
        args: lastConfirmId,
        check: all(
          ok,
          dbCheck(
            'the row must be seat-exempt and active',
            (ctx) => ({ text: 'select seat_exempt, state from technicians where tenant_id = $1 and ref = $2', params: [ctx.tenant.id, 'perpetua-voss'] }),
            (rows) => rows[0]?.seat_exempt === true && rows[0]?.state === 'active',
          ),
        ),
      },
    ],
  });

  add({
    id: 'C09',
    family: 'config',
    title: 'add_technician_seat FAILS CLOSED when the seats are full',
    tool: 'add_technician_seat',
    tenant: 'seats',
    badge: 'manager-sam',
    steps: [
      { label: 'stage against a full tenant', args: () => ({ displayName: 'Overflow Person' }), check: () => null },
      {
        label: 'confirm hits the cap',
        when: ifStaged,
        args: lastConfirmId,
        // The cap is a DB trigger, so it holds regardless of which surface asks.
        check: all(
          refused(/seat|cap|no free|full/i),
          dbCheck(
            'no roster row may be created past the cap',
            (ctx) => ({ text: 'select count(*)::int n from technicians where tenant_id = $1 and ref = $2', params: [ctx.tenant.id, 'overflow-person'] }),
            (rows) => count(rows) === 0,
          ),
        ),
      },
    ],
  });

  // ── graceful failure ────────────────────────────────────────────────────────
  one({
    id: 'F01',
    family: 'failure',
    title: 'undo_run with nothing to undo says so instead of crashing',
    tool: 'undo_run',
    tenant: 'resolve',
    badge: 'manager-sam',
    args: () => ({}),
    check: (out) =>
      out.timedOut ? 'timed out' : /nothing|no run|no recent|not found/i.test(out.text) || out.isError ? null : `expected a clean "nothing to undo": ${out.text.slice(0, 200)}`,
  });

  one({
    id: 'F02',
    family: 'failure',
    title: 'resolve_review on an unknown id refuses cleanly',
    tool: 'resolve_review',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({ reviewItemId: '00000000-0000-4000-8000-000000000000', resolution: 'dismissed' }),
    check: (out) => (out.timedOut ? 'timed out' : out.isError || /not found|unknown|no review/i.test(out.text) ? null : 'an unknown review id was accepted'),
  });

  one({
    id: 'F03',
    family: 'failure',
    title: 'a malformed date is refused rather than guessed',
    tool: 'resolve_date',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({ explicitDate: '2026-02-30' }),
    check: mentions('unresolvable'),
  });

  one({
    id: 'F04',
    family: 'failure',
    title: 'an unknown job id is refused rather than invented',
    tool: 'get_job',
    tenant: 'main',
    badge: 'manager-sam',
    args: () => ({ jobId: '00000000-0000-4000-8000-000000000000' }),
    check: (out) =>
      out.isError || out.text.trim() === 'null' || /not found|no job|unknown/i.test(out.text)
        ? null
        : `an unknown job id produced a result: ${out.text.slice(0, 200)}`,
  });

  // ── requires an external service: run only when explicitly enabled ──────────
  one({
    id: 'X01',
    family: 'external',
    title: 'brief_customer writes a cited briefing',
    tool: 'brief_customer',
    tenant: 'main',
    badge: 'manager-sam',
    requires: 'model',
    args: (ctx) => ({ customerId: customerId(ctx.tenant, 'edge-rich'), focus: 'next_visit' }),
    check: all(ok, mentions('citations')),
  });

  one({
    id: 'X02',
    family: 'external',
    title: 'answer_customer_question admits when the record does not say',
    tool: 'answer_customer_question',
    tenant: 'main',
    badge: 'manager-sam',
    requires: 'model',
    args: (ctx) => ({
      customerId: customerId(ctx.tenant, 'edge-silent'),
      question: 'What is the gate code for this property?',
    }),
    // The anti-fabrication case: this customer has no gate code on file.
    check: all(ok, (out) =>
      /don't|does not|no .*(record|information)|not on file|unknown/i.test(out.text)
        ? null
        : `expected an admission that the record is silent, got: ${out.text.slice(0, 200)}`,
    ),
  });

  one({
    id: 'X03',
    family: 'external',
    title: 'web_search returns public results',
    tool: 'web_search',
    tenant: 'main',
    badge: 'manager-sam',
    requires: 'network',
    args: () => ({ query: 'Trane XR14 capacitor part number', maxResults: 3 }),
    check: ok,
  });

  one({
    id: 'X04',
    family: 'external',
    title: 'read_webpage fetches one page',
    tool: 'read_webpage',
    tenant: 'main',
    badge: 'manager-sam',
    requires: 'network',
    args: () => ({ url: 'https://example.com/' }),
    check: ok,
  });

  one({
    id: 'X05',
    family: 'external',
    title: 'send_email stages without sending',
    tool: 'send_email',
    tenant: 'main',
    badge: 'manager-sam',
    requires: 'composio',
    args: (ctx) => ({
      to: `${customerName(ctx.tenant, 'fx-t1-ext-01').split(' ')[0].toLowerCase()}@example.test`,
      subject: 'Your appointment',
      body: 'Confirming your visit.',
    }),
    check: staged,
  });

  one({
    id: 'X06',
    family: 'external',
    title: 'get_connect_link mints a pairing link',
    tool: 'get_connect_link',
    tenant: 'main',
    badge: 'manager-sam',
    requires: 'composio',
    args: () => ({ ref: 'cfg-tech-07' }),
    check: ok,
  });

  one({
    id: 'X07',
    family: 'external',
    title: 'run_freeze proposes a plan and stops',
    tool: 'run_freeze',
    tenant: 'freeze',
    badge: 'manager-sam',
    requires: 'maps',
    args: (ctx) => ({ throughDate: addDays(ctx.anchor, 7) }),
    check: all(staged, mentions('pinned')),
  });

  one({
    id: 'X08',
    family: 'external',
    title: 'run_resolve proposes a re-plan and stops',
    tool: 'run_resolve',
    tenant: 'resolve',
    badge: 'manager-sam',
    requires: 'maps',
    args: (ctx) => ({ throughDate: addDays(ctx.anchor, 7) }),
    check: staged,
  });

  return cases;
}

/** The 'other' tenant, for the cross-tenant probes. */
function other(ctx: CaseContext): TenantManifest {
  const t = ctx.world.tenants.find((x) => x.key === 'other');
  if (!t) throw new Error('world has no `other` tenant for the isolation probes');
  return t;
}

/** Every spine tool a case touches — used to prove the corpus covers the surface. */
export function toolsCovered(cases: ToolCase[]): string[] {
  const names = new Set<string>();
  for (const c of cases) {
    for (const s of c.steps) names.add(s.tool ?? c.tool);
  }
  return [...names].sort();
}
