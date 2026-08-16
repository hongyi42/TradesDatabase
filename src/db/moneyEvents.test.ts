import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { getClient } from './client.js';
import { createCustomer } from './customers.js';
import { ALLOWED_TRANSITIONS, createJob, getJob, type JobStatus } from './jobs.js';
import { isUniqueViolation } from './rawCaptures.js';
import {
  appendMoneyEvent,
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
