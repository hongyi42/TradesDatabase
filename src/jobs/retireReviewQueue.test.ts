import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import {
  appendRawCapture,
  createTenant,
  insertTechnician,
  updateTechnician,
} from '../db/index.js';
import {
  LEGACY_DEACTIVATION_RESOLUTION,
  RETIREMENT_RESOLUTION,
  retireReviewQueue,
} from './retireReviewQueue.js';

// The review queue's retirement sweep, against the LOCAL stack (testEnvGuard).
// Every fixture lives in a firm made for this file, and the sweep is scoped to
// it — the real script sweeps the whole fleet. `seed.mjs` writes no
// review_items, so a run against seed data would prove nothing: each case the
// sweep must handle is inserted here, and each row's after-state is asserted.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const RUN = `retire-${Date.now()}`;
let tenantId: string;
const ids: Record<string, string> = {};
let ghostCaptureId: string;
let stillGoneStartedAt: string;

async function item(
  name: string,
  kind: string,
  subjectRef: string,
  detail: Record<string, unknown> = {},
): Promise<void> {
  const { rows } = await pg.query<{ id: string }>(
    'insert into review_items (tenant_id, kind, subject_ref, detail) values ($1, $2, $3, $4) returning id',
    [tenantId, kind, subjectRef, JSON.stringify(detail)],
  );
  ids[name] = rows[0].id;
}

async function statusOf(name: string): Promise<{ status: string; resolution: string | null }> {
  const { rows } = await pg.query<{ status: string; resolution: string | null }>(
    'select status, resolution from review_items where id = $1',
    [ids[name]],
  );
  return rows[0];
}

async function observations(): Promise<Array<{ kind: string; subject_ref: string; context: Record<string, unknown> }>> {
  const { rows } = await pg.query<{ kind: string; subject_ref: string; context: Record<string, unknown> }>(
    'select kind, subject_ref, context from observations where tenant_id = $1 order by kind, subject_ref',
    [tenantId],
  );
  return rows;
}

beforeAll(async () => {
  await pg.connect();
  tenantId = (await createTenant(RUN, { managerSeats: 1, technicianSeats: 5 })).id;

  // People the carry-over consults.
  const stillGone = await insertTechnician({ tenantId, ref: `${RUN}-still-gone`, displayName: 'Still Gone' });
  stillGoneStartedAt = new Date(Date.now() - 6 * 86_400_000).toISOString();
  await updateTechnician(stillGone.id, { state: 'offboarding', offboarding_started_at: stillGoneStartedAt });
  await insertTechnician({ tenantId, ref: `${RUN}-came-back`, displayName: 'Came Back' });
  await insertTechnician({ tenantId, ref: `${RUN}-since-joined`, displayName: 'Since Joined' });

  // Mail that arrived through a connection nobody on the roster owns.
  ghostCaptureId = (
    await appendRawCapture({
      tenantId,
      channel: 'email',
      technicianRef: `${RUN}-ghost`,
      rawText: 'mail through an unknown connection',
    })
  ).id;

  await item('sheet', 'sheet_ref_mismatch', `${RUN}-sheet`);
  await item('unlinked', 'unlinked_call', `${RUN}-unlinked`);
  await item('call', 'call_action', `${RUN}-call`, { intents: ['cancel'] });
  await item('overdue', 'overdue_visit_gap', `${RUN}-overdue`);
  await item('escalated', 'overdue_visit_gap', `${RUN}-escalated`, {
    escalatedFromNudge: '00000000-0000-4000-8000-0000000000aa',
  });
  await item('cost', 'job_cost_gap', `${RUN}-cost`);
  await item('stillGone', 'offboarding_reminder', `${RUN}-still-gone`, { startedAt: stillGoneStartedAt });
  await item('cameBack', 'offboarding_reminder', `${RUN}-came-back`, { startedAt: 'an earlier episode' });
  await item('ghost', 'unknown_ref_capture', `${RUN}-ghost`);
  await item('joined', 'unknown_ref_capture', `${RUN}-since-joined`);
  await item('legacyDeactivation', 'pending_deactivation', `${RUN}-legacy`, { requestedBy: 'mgr' });
  await item('liveDeactivation', 'pending_deactivation', `${RUN}-live`, {
    requestedBy: 'mgr',
    stagedAt: new Date().toISOString(),
  });
  await item('pairing', 'pairing_verification', `${RUN}-pairing`);
  await item('availability', 'availability_setup', `${RUN}-availability`);
  await item('sendToken', 'pending_outbound_send', `${RUN}-send`, { stagedAt: new Date().toISOString() });
});

afterAll(async () => {
  await pg.query('delete from observations where tenant_id = $1', [tenantId]);
  await pg.query('delete from review_items where tenant_id = $1', [tenantId]);
  await pg.query('delete from technicians where tenant_id = $1', [tenantId]);
  // TRUNCATE, the house pattern for L1-touching suites: raw_captures is
  // append-only by trigger, so DELETE is refused (files run sequentially).
  await pg.query('truncate table raw_captures cascade');
  await pg.query('delete from tenants where id = $1', [tenantId]);
  await pg.end();
});

describe('retireReviewQueue', () => {
  test('a dry run reports what a real run would do, and writes nothing', async () => {
    const report = await retireReviewQueue({ dryRun: true, tenantIds: [tenantId] });
    expect(report).toEqual({
      dryRun: true,
      byKind: {
        sheet_ref_mismatch: { carried: 0, skipped: 0, dismissed: 1 },
        unlinked_call: { carried: 0, skipped: 0, dismissed: 1 },
        call_action: { carried: 0, skipped: 0, dismissed: 1 },
        overdue_visit_gap: { carried: 0, skipped: 1, dismissed: 1 },
        job_cost_gap: { carried: 0, skipped: 0, dismissed: 1 },
        offboarding_reminder: { carried: 1, skipped: 0, dismissed: 2 },
        unknown_ref_capture: { carried: 1, skipped: 0, dismissed: 2 },
      },
      legacyDeactivations: 1,
    });
    for (const name of Object.keys(ids)) expect((await statusOf(name)).status).toBe('open');
    expect(await observations()).toEqual([]);
  });

  test('a real run closes the retired kinds, carries the live ones, and leaves the rest open', async () => {
    const report = await retireReviewQueue({ dryRun: false, tenantIds: [tenantId] });
    expect(report.dryRun).toBe(false);
    expect(report.legacyDeactivations).toBe(1);

    for (const name of ['sheet', 'unlinked', 'call', 'overdue', 'cost', 'stillGone', 'cameBack', 'ghost', 'joined']) {
      expect(await statusOf(name)).toEqual({ status: 'dismissed', resolution: RETIREMENT_RESOLUTION });
    }
    expect(await statusOf('legacyDeactivation')).toEqual({
      status: 'dismissed',
      resolution: LEGACY_DEACTIVATION_RESOLUTION,
    });
    // Untouched: an escalation (history the planner reads), live tokens, the
    // pairing check waiting for the settings page, the availability reminder.
    for (const name of ['escalated', 'liveDeactivation', 'pairing', 'availability', 'sendToken']) {
      expect(await statusOf(name)).toEqual({ status: 'open', resolution: null });
    }

    // Carried: the person still in their grace period, and the ref still off
    // the roster (pointed at its newest capture). Not carried: the person who
    // came back, and the ref that has since joined.
    const obs = await observations();
    expect(obs).toHaveLength(2);
    // The episode key is the roster's own offboarding_started_at, in the form
    // the database hands it back — the same string the offboarding sweep keys
    // on, so a later sweep tick converges on this row instead of adding one.
    expect(obs[0]).toMatchObject({ kind: 'offboarding_reminder', context: { ref: `${RUN}-still-gone` } });
    const startedAt = obs[0].context.startedAt as string;
    expect(Date.parse(startedAt)).toBe(Date.parse(stillGoneStartedAt));
    expect(obs[0].subject_ref).toBe(`${RUN}-still-gone@${startedAt}`);
    expect(obs[1]).toMatchObject({
      kind: 'unknown_ref_capture',
      subject_ref: `${RUN}-ghost`,
      context: { ref: `${RUN}-ghost`, captureId: ghostCaptureId },
    });
  });

  test('a second run finds nothing left to do', async () => {
    const report = await retireReviewQueue({ dryRun: false, tenantIds: [tenantId] });
    // Only the escalation is still listed, and it is still skipped.
    expect(report).toEqual({
      dryRun: false,
      byKind: { overdue_visit_gap: { carried: 0, skipped: 1, dismissed: 0 } },
      legacyDeactivations: 0,
    });
    expect(await observations()).toHaveLength(2);
  });
});
