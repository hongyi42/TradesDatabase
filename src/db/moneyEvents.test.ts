import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer } from './customers.js';
import { ALLOWED_TRANSITIONS, createJob, getJob, type JobStatus } from './jobs.js';
import { isUniqueViolation } from './rawCaptures.js';
import {
  appendMoneyEvent,
  listJobIdsWithCostEvents,
  listLiveMoneyEventsForJobsSince,
  technicianMoneyView,
  deriveStatusTarget,
  listMoneyEventsForJob,
  summarizeMoney,
  syncJobStatusForMoney,
  type MoneyEvent,
  type MoneyEventKind,
} from './moneyEvents.js';

// ── Pure-fold fixtures ──────────────────────────────────────────────────────
let seq = 0;
const mk = (
  kind: MoneyEventKind,
  amountCents: number | null = null,
  opts: Partial<MoneyEvent> = {},
): MoneyEvent => {
  seq += 1;
  return {
    id: seq,
    tenant_id: 'T1',
    job_id: 'J1',
    kind,
    amount_cents: amountCents,
    currency: 'USD',
    occurred_at: `2026-08-15T00:00:${String(seq % 60).padStart(2, '0')}+00:00`,
    actor_ref: null,
    source_capture_id: null,
    corrects_event_id: null,
    method: null,
    external_ref: null,
    dedupe_key: null,
    detail: {},
    created_at: '2026-08-15T00:00:00+00:00',
    ...opts,
  };
};
const target = (current: JobStatus, events: MoneyEvent[]): JobStatus | null =>
  deriveStatusTarget(current, summarizeMoney(events), events);

// The representability matrix (plan acceptance test): five real firm payment
// styles, each just a different ORDERING of events over the one schema.
describe('representability matrix — five firm archetypes, zero schema change', () => {
  test('1. flat-rate repair: fee → approved estimate → invoice → paid in full', () => {
    const ev = [mk('fee_charged', 8900), mk('estimate_approved', 42000)];
    expect(target('open', ev)).toBeNull(); // nothing invoiced yet
    ev.push(mk('invoice_issued', 50900));
    expect(target('open', ev)).toBe('invoiced'); // walk will pass through completed
    ev.push(mk('payment_received', 50900));
    const s = summarizeMoney(ev);
    expect(s).toMatchObject({ quotedCents: 42000, invoicedCents: 50900, paidCents: 50900, balanceDueCents: 0 });
    expect(target('open', ev)).toBe('paid');
  });

  test('2. deposit-then-final install: deposit NEVER advances status', () => {
    const ev = [mk('estimate_approved', 1_200_000), mk('payment_received', 120_000)];
    expect(target('open', ev)).toBeNull(); // deposit-only chain: no opinion
    expect(summarizeMoney(ev).balanceDueCents).toBe(-120_000); // customer credit until invoiced
    ev.push(mk('change_order', 25_000), mk('invoice_issued', 1_225_000));
    expect(summarizeMoney(ev).quotedCents).toBe(1_225_000);
    expect(target('in_progress', ev)).toBe('invoiced');
    ev.push(mk('payment_received', 1_105_000));
    expect(summarizeMoney(ev).balanceDueCents).toBe(0);
    expect(target('in_progress', ev)).toBe('paid');
  });

  test('3. progress-billed commercial: milestones derive NOTHING, even fully paid', () => {
    const ev: MoneyEvent[] = [mk('estimate_approved', 5_000_000)];
    ev.push(mk('invoice_issued', 1_500_000, { detail: { progress: true } }));
    ev.push(mk('payment_received', 1_500_000));
    ev.push(mk('invoice_issued', 1_500_000, { detail: { progress: true } }));
    ev.push(mk('payment_received', 1_500_000));
    // Every prefix of the all-progress chain has no status opinion.
    for (let i = 1; i <= ev.length; i++) {
      for (const cur of ['open', 'in_progress', 'completed'] as JobStatus[]) {
        expect(target(cur, ev.slice(0, i))).toBeNull();
      }
    }
    ev.push(mk('invoice_issued', 2_000_000)); // the final, non-progress invoice
    expect(summarizeMoney(ev)).toMatchObject({ invoicedCents: 5_000_000, balanceDueCents: 2_000_000 });
    expect(target('in_progress', ev)).toBe('invoiced');
    ev.push(mk('payment_received', 2_000_000));
    expect(target('in_progress', ev)).toBe('paid');
  });

  test('4. T&M bill-after: no estimate ever, straight to invoice', () => {
    const ev = [mk('invoice_issued', 68_000), mk('payment_received', 68_000)];
    expect(summarizeMoney(ev)).toMatchObject({ quotedCents: 0, balanceDueCents: 0 });
    expect(target('completed', ev)).toBe('paid');
  });

  test('5. books-live-in-QuickBooks: externally-referenced events, same fold', () => {
    const ev = [
      mk('invoice_issued', 45_000, { external_ref: 'QB-1042' }),
      mk('payment_received', 45_000, { method: 'check' }),
    ];
    expect(summarizeMoney(ev).balanceDueCents).toBe(0);
    expect(target('open', ev)).toBe('paid');
  });
});

describe('fold edges — voids, refunds, corrections, write-offs', () => {
  test('voiding the only real invoice zeroes invoiced and walks invoiced → completed', () => {
    const inv = mk('invoice_issued', 100_000);
    const ev = [inv, mk('invoice_voided', 100_000, { corrects_event_id: inv.id })];
    expect(summarizeMoney(ev).invoicedCents).toBe(0);
    expect(target('invoiced', ev)).toBe('completed');
    expect(target('open', ev)).toBeNull(); // gate gone, nothing to derive upward
  });

  test('pre-ledger invoiced job: a ledger with no invoice has NO downward opinion', () => {
    // A job hand-walked to 'invoiced' before the ledger existed (seed shape):
    // recording a mere fee must not demote it — downward requires that a real
    // invoice existed IN the ledger and was voided (review finding).
    const ev = [mk('fee_charged', 8_900)];
    expect(target('invoiced', ev)).toBeNull();
  });

  test('refund after paid: balance reopens but paid never walks back', () => {
    const ev = [mk('invoice_issued', 100_000), mk('payment_received', 100_000)];
    expect(target('invoiced', ev)).toBe('paid');
    ev.push(mk('payment_refunded', 40_000));
    expect(summarizeMoney(ev)).toMatchObject({ paidCents: 60_000, balanceDueCents: 40_000 });
    expect(target('paid', ev)).toBeNull(); // terminal stays terminal
  });

  test('correction negates its target row', () => {
    const pay = mk('payment_received', 50_000);
    const ev = [mk('invoice_issued', 50_000), pay, mk('correction', 50_000, { corrects_event_id: pay.id })];
    expect(summarizeMoney(ev).paidCents).toBe(0);
    expect(summarizeMoney(ev).balanceDueCents).toBe(50_000);
  });

  test('write-off and credit reduce the balance; over-payment reads as customer credit', () => {
    const ev = [mk('invoice_issued', 100_000), mk('credit_applied', 20_000), mk('write_off', 80_000)];
    expect(summarizeMoney(ev).balanceDueCents).toBe(0);
    expect(target('completed', ev)).toBe('paid'); // nothing left to collect
    const over = [mk('invoice_issued', 10_000), mk('payment_received', 15_000)];
    expect(summarizeMoney(over).balanceDueCents).toBe(-5_000);
  });

  test('a re-approval supersedes earlier change orders', () => {
    const ev = [mk('change_order', 10_000), mk('estimate_approved', 50_000), mk('change_order', 5_000)];
    expect(summarizeMoney(ev).quotedCents).toBe(55_000);
  });

  test('a $0 comped invoice settles to paid — never strands at invoiced', () => {
    const ev = [mk('invoice_issued', 0)];
    expect(target('completed', ev)).toBe('paid');
  });
});

test('TERMINAL_STATUSES derivation is unchanged: exactly paid/cancelled/declined', () => {
  const terminal = (Object.keys(ALLOWED_TRANSITIONS) as JobStatus[]).filter(
    (s) => ALLOWED_TRANSITIONS[s].length === 0,
  );
  expect(new Set(terminal)).toEqual(new Set(['paid', 'cancelled', 'declined']));
});

// ── DB-backed: real inserts, trigger/constraint guards, the status walk ─────
// Writes via the app path (supabase-js); direct pg is the independent
// read-back channel and cleanup (spine.test.ts convention).
const pg = new Client({ connectionString: process.env.DATABASE_URL });
let tenantId: string;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;
});

afterAll(async () => {
  await pg.query('truncate table money_events, customers, jobs, visits, raw_captures cascade');
  await pg.end();
});

async function freshJob(): Promise<{ customerId: string; jobId: string }> {
  const customer = await createCustomer({ tenantId, name: `Money Test ${Math.random().toString(36).slice(2, 8)}` });
  const job = await createJob({ tenantId, customerId: customer.id, title: 'water heater' });
  return { customerId: customer.id, jobId: job.id };
}

describe('money_events — append, validation, DB guards', () => {
  test('round-trip with cross-channel pg read-back', async () => {
    const { jobId } = await freshJob();
    const ev = await appendMoneyEvent({
      tenantId, jobId, kind: 'invoice_issued', amountCents: 45_000,
      externalRef: 'INV-TEST-1', method: 'card', actorRef: 'manager-sam',
    });
    const row = await pg.query('select kind, amount_cents, external_ref from money_events where id = $1', [ev.id]);
    expect(row.rows[0]).toEqual({ kind: 'invoice_issued', amount_cents: 45_000, external_ref: 'INV-TEST-1' });
    expect((await listMoneyEventsForJob(tenantId, jobId)).map((e) => e.id)).toEqual([ev.id]);
  });

  test('validation: amount rules, unknown job, reference rules', async () => {
    const { jobId } = await freshJob();
    await expect(appendMoneyEvent({ tenantId, jobId, kind: 'invoice_issued' }))
      .rejects.toThrow(/requires amountCents/);
    await expect(appendMoneyEvent({ tenantId, jobId, kind: 'payment_received', amountCents: -5 }))
      .rejects.toThrow(/whole number of cents/);
    await expect(appendMoneyEvent({ tenantId, jobId, kind: 'payment_received', amountCents: 10.5 }))
      .rejects.toThrow(/whole number of cents/);
    await expect(appendMoneyEvent({
      tenantId, jobId: '00000000-0000-0000-0000-000000000000', kind: 'fee_charged', amountCents: 100,
    })).rejects.toThrow(/not found for this tenant/);
    // estimate_declined is the one amount-less kind
    await expect(appendMoneyEvent({ tenantId, jobId, kind: 'estimate_declined' })).resolves.toBeTruthy();
    // voids/corrections must reference, and voids must target an invoice
    await expect(appendMoneyEvent({ tenantId, jobId, kind: 'invoice_voided', amountCents: 100 }))
      .rejects.toThrow(/requires correctsEventId/);
    await expect(appendMoneyEvent({ tenantId, jobId, kind: 'correction', amountCents: 100 }))
      .rejects.toThrow(/requires correctsEventId/);
    const pay = await appendMoneyEvent({ tenantId, jobId, kind: 'payment_received', amountCents: 100 });
    await expect(appendMoneyEvent({
      tenantId, jobId, kind: 'invoice_voided', amountCents: 100, correctsEventId: pay.id,
    })).rejects.toThrow(/must target an invoice_issued/);
    // a reference must live on the SAME job
    const other = await freshJob();
    await expect(appendMoneyEvent({
      tenantId, jobId: other.jobId, kind: 'correction', amountCents: 100, correctsEventId: pay.id,
    })).rejects.toThrow(/not an event on this job/);
    // negation is ONE-LEVEL: correcting a correction/void is refused with the
    // re-issue remedy, never accepted as a silent no-op (review finding)
    const corr = await appendMoneyEvent({
      tenantId, jobId, kind: 'correction', correctsEventId: pay.id,
    });
    await expect(appendMoneyEvent({
      tenantId, jobId, kind: 'correction', correctsEventId: corr.id,
    })).rejects.toThrow(/negation is one-level/);
    // checksum: a stated amount on a void/correction must equal the target's
    const inv = await appendMoneyEvent({ tenantId, jobId, kind: 'invoice_issued', amountCents: 45_000 });
    await expect(appendMoneyEvent({
      tenantId, jobId, kind: 'invoice_voided', amountCents: 5_000, correctsEventId: inv.id,
    })).rejects.toThrow(/cancels the WHOLE entry/);
    // amount is optional on voids/corrections — omitting it is the clean form
    await expect(appendMoneyEvent({
      tenantId, jobId, kind: 'invoice_voided', correctsEventId: inv.id,
    })).resolves.toBeTruthy();
  });

  test('money_events is RLS-enabled with zero anon/authenticated privileges', async () => {
    const rls = await pg.query("select relrowsecurity from pg_class where relname = 'money_events'");
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const priv = await pg.query(
      `select count(*)::int as n from information_schema.table_privileges
        where table_name = 'money_events' and grantee in ('anon', 'authenticated')`,
    );
    expect(priv.rows[0].n).toBe(0);
  });

  test('dedupe key: replay collides as a unique violation', async () => {
    const { jobId } = await freshJob();
    const input = { tenantId, jobId, kind: 'invoice_issued' as const, amountCents: 500, dedupeKey: `test:${jobId}` };
    await appendMoneyEvent(input);
    const err = await appendMoneyEvent(input).catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  test('append-only trigger blocks UPDATE and DELETE; job delete is RESTRICTed', async () => {
    const { jobId } = await freshJob();
    const ev = await appendMoneyEvent({ tenantId, jobId, kind: 'fee_charged', amountCents: 8_900 });
    await expect(pg.query('update money_events set amount_cents = 1 where id = $1', [ev.id]))
      .rejects.toThrow(/append-only/);
    await expect(pg.query('delete from money_events where id = $1', [ev.id]))
      .rejects.toThrow(/append-only/);
    await expect(pg.query('delete from jobs where id = $1', [jobId]))
      .rejects.toThrow(/(violates foreign key|restrict)/i);
  });

  test('status walk: invoice walks open → invoiced, void walks back, payment finishes', async () => {
    const { jobId } = await freshJob();
    const inv = await appendMoneyEvent({ tenantId, jobId, kind: 'invoice_issued', amountCents: 100_000 });
    expect(await syncJobStatusForMoney(tenantId, jobId)).toEqual({ from: 'open', to: 'invoiced' });
    expect((await getJob(jobId))?.status).toBe('invoiced');

    await appendMoneyEvent({
      tenantId, jobId, kind: 'invoice_voided', amountCents: 100_000, correctsEventId: inv.id,
    });
    expect(await syncJobStatusForMoney(tenantId, jobId)).toEqual({ from: 'invoiced', to: 'completed' });
    expect((await getJob(jobId))?.status).toBe('completed');

    await appendMoneyEvent({ tenantId, jobId, kind: 'invoice_issued', amountCents: 60_000 });
    await appendMoneyEvent({ tenantId, jobId, kind: 'payment_received', amountCents: 160_000 });
    expect(await syncJobStatusForMoney(tenantId, jobId)).toEqual({ from: 'completed', to: 'paid' });
    expect((await getJob(jobId))?.status).toBe('paid');
    // Terminal: a refund reopens the balance but never the status.
    await appendMoneyEvent({ tenantId, jobId, kind: 'payment_refunded', amountCents: 50_000 });
    expect(await syncJobStatusForMoney(tenantId, jobId)).toBeNull();
    expect((await getJob(jobId))?.status).toBe('paid');
  });

  test('progress invoice on a fresh job: event records, status untouched', async () => {
    const { jobId } = await freshJob();
    await appendMoneyEvent({
      tenantId, jobId, kind: 'invoice_issued', amountCents: 25_000, detail: { progress: true },
    });
    expect(await syncJobStatusForMoney(tenantId, jobId)).toBeNull();
    expect((await getJob(jobId))?.status).toBe('open');
  });
});

describe('material_cost — a COST kind is inert in every revenue number (plan 2026-08-19 Phase 3)', () => {
  // The whole safety argument for putting cost in the revenue ledger is that
  // the fold sums PER KIND, so a new kind contributes to nothing that exists.
  // That is structural, but it is load-bearing for the analytics direction, so
  // prove it rather than trust it.
  const revenue = (): MoneyEvent[] => [
    mk('estimate_approved', 42000),
    mk('invoice_issued', 50900),
    mk('payment_received', 30000),
    mk('credit_applied', 900),
    mk('write_off', 100),
  ];

  test('every existing number is byte-identical with and without a cost row', () => {
    const before = summarizeMoney(revenue());
    const withCost = revenue();
    withCost.push(mk('material_cost', 4000), mk('material_cost', 1500));
    const after = summarizeMoney(withCost);

    // Every revenue/AR number, named explicitly — a new summary field must not
    // be able to shift any of them.
    const revenueFields = (m: typeof before) => ({
      quotedCents: m.quotedCents,
      invoicedCents: m.invoicedCents,
      paidCents: m.paidCents,
      creditsCents: m.creditsCents,
      writtenOffCents: m.writtenOffCents,
      balanceDueCents: m.balanceDueCents,
      hasProgressInvoice: m.hasProgressInvoice,
    });
    expect(revenueFields(after)).toEqual(revenueFields(before));
    expect(before.materialCostCents).toBe(0);
    expect(after.materialCostCents).toBe(5500);
    // Cost is NOT receivable — the customer does not owe it.
    expect(after.balanceDueCents).toBe(before.balanceDueCents);
  });

  test('a cost row can never advance or walk back job status', () => {
    // deriveStatusTarget gates on invoice_issued only; a cost-only ledger must
    // have NO opinion, and adding cost must not change an existing opinion.
    expect(target('open', [mk('material_cost', 9900)])).toBeNull();
    const ev = revenue();
    const withoutCost = target('open', ev);
    const withCost = target('open', [...ev, mk('material_cost', 9900)]);
    expect(withCost).toBe(withoutCost);
  });

  test('correction negates a cost row out of the cost total — for free', () => {
    // negatedIds/live are kind-agnostic, so correction semantics come free for
    // any new kind. Prove it, and prove the correction does not leak into AR.
    const cost = mk('material_cost', 4000);
    const ev = [...revenue(), cost, mk('correction', null, { corrects_event_id: cost.id })];
    const s = summarizeMoney(ev);
    expect(s.materialCostCents).toBe(0);
    expect(s.balanceDueCents).toBe(summarizeMoney(revenue()).balanceDueCents);
  });

  test('technicianMoneyView still withholds cost — it is manager-only', () => {
    // The tier boundary has ONE definition; a new summary field must not widen
    // it by accident (technicians are ASKED about cost, but never shown it).
    const s = summarizeMoney([...revenue(), mk('material_cost', 4000)]);
    expect(technicianMoneyView(s)).toEqual({
      balanceDueCents: s.balanceDueCents,
      invoicedCents: s.invoicedCents,
    });
  });

  test('material_cost is a real enum value the DB accepts (and stays non-negative)', async () => {
    const { jobId } = await freshJob();
    const ev = await appendMoneyEvent({
      tenantId,
      jobId,
      kind: 'material_cost',
      amountCents: 4000,
    });
    expect(ev?.kind).toBe('material_cost');
    await expect(
      appendMoneyEvent({ tenantId, jobId, kind: 'material_cost', amountCents: -1 }),
    ).rejects.toThrow();
    // And it does not move the job off its status.
    expect((await getJob(jobId))?.status).toBe('open');
  });
});

describe('listLiveMoneyEventsForJobsSince — what the planner is shown', () => {
  const PAST = '2000-01-01T00:00:00.000Z';

  test('returns money on the named jobs, and nothing from another job', async () => {
    const a = await freshJob();
    const b = await freshJob();
    await appendMoneyEvent({ tenantId, jobId: a.jobId, kind: 'payment_received', amountCents: 50000 });
    await appendMoneyEvent({ tenantId, jobId: b.jobId, kind: 'payment_received', amountCents: 1 });
    const rows = await listLiveMoneyEventsForJobsSince(tenantId, [a.jobId], PAST);
    expect(rows.map((r) => r.job_id)).toEqual([a.jobId]);
  });

  test('the bound EXCLUDES what landed before it', async () => {
    const { jobId } = await freshJob();
    await appendMoneyEvent({ tenantId, jobId, kind: 'payment_received', amountCents: 50000 });
    // A bound in the future of the row that was just written.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await listLiveMoneyEventsForJobsSince(tenantId, [jobId], future)).toEqual([]);
  });

  // The bound is created_at, NOT occurred_at, and the two genuinely differ here.
  // A payment the manager states happened last year but records TODAY is still
  // them answering today's question — and occurred_at is caller-supplied, so
  // filtering on it would also let a caller hide a row from the planner.
  test('filters on created_at, not the caller-supplied occurred_at', async () => {
    const { jobId } = await freshJob();
    await appendMoneyEvent({
      tenantId, jobId, kind: 'payment_received', amountCents: 50000,
      occurredAt: '2020-01-01T00:00:00.000Z',
    });
    // A bound AFTER the stated occurrence but BEFORE the row was written.
    const rows = await listLiveMoneyEventsForJobsSince(tenantId, [jobId], '2021-01-01T00:00:00.000Z');
    expect(rows.map((r) => r.kind)).toEqual(['payment_received']);
    expect(rows[0].occurred_at.slice(0, 4)).toBe('2020');
  });

  test('empty input returns empty (PostgREST in.() with zero values errors)', async () => {
    expect(await listLiveMoneyEventsForJobsSince(tenantId, [], PAST)).toEqual([]);
  });

  // The load-bearing one. The canceller is written AFTER the target, so a
  // second pass that carried the same time filter would miss it and the
  // cancelled amount would render to the planner as live money.
  test('an event cancelled by a LATER correction disappears — and so does the correction', async () => {
    const { jobId } = await freshJob();
    const target = await appendMoneyEvent({
      tenantId, jobId, kind: 'invoice_issued', amountCents: 90000,
    });
    await appendMoneyEvent({
      tenantId, jobId, kind: 'invoice_voided', correctsEventId: target.id,
    });
    const rows = await listLiveMoneyEventsForJobsSince(tenantId, [jobId], PAST);
    expect(rows.map((r) => r.kind)).toEqual([]);
  });

  test('a payment_refunded is NOT a negation — both rows still show', async () => {
    // Refunds fold by subtraction, not by cancellation. The planner is entitled
    // to see both and weigh them; hiding either would misstate the job.
    const { jobId } = await freshJob();
    await appendMoneyEvent({ tenantId, jobId, kind: 'payment_received', amountCents: 50000 });
    await appendMoneyEvent({ tenantId, jobId, kind: 'payment_refunded', amountCents: 50000 });
    const rows = await listLiveMoneyEventsForJobsSince(tenantId, [jobId], PAST);
    expect(rows.map((r) => r.kind).sort()).toEqual(['payment_received', 'payment_refunded']);
  });

  test('a live row survives beside a cancelled one', async () => {
    const { jobId } = await freshJob();
    const doomed = await appendMoneyEvent({
      tenantId, jobId, kind: 'invoice_issued', amountCents: 1000,
    });
    await appendMoneyEvent({ tenantId, jobId, kind: 'invoice_voided', correctsEventId: doomed.id });
    await appendMoneyEvent({ tenantId, jobId, kind: 'payment_received', amountCents: 2500 });
    const rows = await listLiveMoneyEventsForJobsSince(tenantId, [jobId], PAST);
    expect(rows.map((r) => r.kind)).toEqual(['payment_received']);
  });

  test('pages past the silent 1000-row cap', async () => {
    // listMoneyEventsForJobs has no paging loop; this reader must not copy it.
    const { jobId } = await freshJob();
    const rowsToWrite = 1005;
    const values = Array.from(
      { length: rowsToWrite },
      (_, i) => `('${tenantId}','${jobId}','payment_received',${i + 1})`,
    ).join(',');
    await pg.query(
      `insert into money_events (tenant_id, job_id, kind, amount_cents) values ${values}`,
    );
    const rows = await listLiveMoneyEventsForJobsSince(tenantId, [jobId], PAST);
    expect(rows.length).toBe(rowsToWrite);
  });
});

describe('listJobIdsWithCostEvents — the cost detector\'s "already recorded" filter', () => {
  test('returns only jobs with a material_cost — an invoice is NOT a cost', async () => {
    // The whole detector hangs on this being kind-scoped: without the kind
    // filter, any job with an invoice would look like its cost was recorded and
    // would never be asked about.
    const withCost = await freshJob();
    const withInvoiceOnly = await freshJob();
    const withNothing = await freshJob();
    await appendMoneyEvent({
      tenantId, jobId: withCost.jobId, kind: 'material_cost', amountCents: 4000,
    });
    await appendMoneyEvent({
      tenantId, jobId: withInvoiceOnly.jobId, kind: 'invoice_issued', amountCents: 90000,
    });
    const hit = await listJobIdsWithCostEvents(tenantId, [
      withCost.jobId, withInvoiceOnly.jobId, withNothing.jobId,
    ]);
    expect(hit).toEqual([withCost.jobId]);
  });

  test('empty input returns empty (PostgREST in.() with zero values errors)', async () => {
    expect(await listJobIdsWithCostEvents(tenantId, [])).toEqual([]);
  });

  test('de-duplicates a job with several cost rows', async () => {
    const { jobId } = await freshJob();
    await appendMoneyEvent({ tenantId, jobId, kind: 'material_cost', amountCents: 100 });
    await appendMoneyEvent({ tenantId, jobId, kind: 'material_cost', amountCents: 200 });
    expect(await listJobIdsWithCostEvents(tenantId, [jobId])).toEqual([jobId]);
  });

  test('a CORRECTED cost does not count — fixing a typo must not gag the detector', async () => {
    // REGRESSION (final-review finding): this probe used to select raw
    // kind='material_cost' rows, so a cancelled cost still read as "recorded".
    // Costs are never edited — a mistake is cancelled by a NEW row pointing at
    // it — so a manager fixing a typo permanently suppressed the gap: the
    // nudge's subject_ref is the JOB and uq_nudges_subject_ever is any-status,
    // meaning the job could never be asked again. Doing the right thing buried
    // it. summarizeMoney already folds this correctly; now the probe agrees.
    const { jobId } = await freshJob();
    const bad = await appendMoneyEvent({
      tenantId, jobId, kind: 'material_cost', amountCents: 40_000, // meant 400
    });
    await appendMoneyEvent({
      tenantId, jobId, kind: 'correction', correctsEventId: bad.id,
    });
    // the fold agrees there is no cost left…
    expect(summarizeMoney(await listMoneyEventsForJob(tenantId, jobId)).materialCostCents).toBe(0);
    // …so the detector must still consider this job un-costed.
    expect(await listJobIdsWithCostEvents(tenantId, [jobId])).toEqual([]);
  });

  test('one live cost among corrected ones still counts', async () => {
    // The inverse guard: "some cancelled" must not be read as "all cancelled".
    const { jobId } = await freshJob();
    const bad = await appendMoneyEvent({
      tenantId, jobId, kind: 'material_cost', amountCents: 40_000,
    });
    await appendMoneyEvent({ tenantId, jobId, kind: 'correction', correctsEventId: bad.id });
    await appendMoneyEvent({ tenantId, jobId, kind: 'material_cost', amountCents: 400 });
    expect(await listJobIdsWithCostEvents(tenantId, [jobId])).toEqual([jobId]);
  });
});
