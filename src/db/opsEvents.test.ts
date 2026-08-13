import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { Client } from 'pg';
import { mintBadge } from '../control/badges.js';
import { createHost } from './hosts.js';
import {
  getOpenIncident,
  isValidService,
  listRecentIncidents,
  recordOpsEvent,
} from './opsEvents.js';

// Integration against the local stack (pattern: hosts.test.ts). Hosts and
// ops_events are infrastructure rows, so this suite deletes exactly what it
// creates.
const pg = new Client({ connectionString: process.env.DATABASE_URL });
const HOST_NAME = 'test-ops-host';
const SERVICE = 'inference-medic';
let hostId: string;
let otherHostId: string;

async function wipe() {
  await pg.query('delete from ops_events where host_id in (select id from hosts where name like $1)', [
    'test-ops-host%',
  ]);
  await pg.query('delete from hosts where name like $1', ['test-ops-host%']);
}

beforeAll(async () => {
  await pg.connect();
  await wipe();
});

afterAll(async () => {
  await wipe();
  await pg.end();
});

beforeEach(async () => {
  await wipe();
  hostId = (await createHost(HOST_NAME, mintBadge().hash)).id;
  otherHostId = (await createHost(`${HOST_NAME}-2`, mintBadge().hash)).id;
});

describe('ops incident transitions', () => {
  test('a healthy report on a healthy service writes nothing', async () => {
    expect(await recordOpsEvent({ hostId, service: SERVICE, status: 'ok' })).toEqual({ action: 'noop' });
    expect(await listRecentIncidents(hostId)).toHaveLength(0);
  });

  test('first bad report opens an incident and keeps the evidence', async () => {
    const r = await recordOpsEvent({
      hostId,
      service: SERVICE,
      status: 'down',
      detail: { message: 'deepinfra-prod IS NOT SERVING', route: 'deepinfra-prod/zai-org/GLM-5.2' },
    });
    expect(r.action).toBe('opened');

    const open = await getOpenIncident(hostId, SERVICE);
    expect(open?.closed_at).toBeNull();
    // The point of the payload: diagnosable without ssh-ing to the box.
    expect((open?.detail as Record<string, unknown>).message).toContain('IS NOT SERVING');
  });

  test('THE WHOLE POINT: repeat bad reports do NOT pile up rows', async () => {
    await recordOpsEvent({ hostId, service: SERVICE, status: 'down' });
    // Five more 5-minute ticks through the same outage.
    for (let i = 0; i < 5; i++) {
      expect((await recordOpsEvent({ hostId, service: SERVICE, status: 'down' })).action).toBe('suppressed');
    }
    // A 30-minute outage is ONE incident, not six. Without this a notifier
    // fires six times and gets muted.
    expect(await listRecentIncidents(hostId)).toHaveLength(1);
  });

  test('recovery closes the incident and records how long it was open', async () => {
    const opened = await recordOpsEvent({ hostId, service: SERVICE, status: 'down' });
    const closed = await recordOpsEvent({
      hostId,
      service: SERVICE,
      status: 'ok',
      detail: { message: 'route OK — serving verified' },
    });
    expect(closed.action).toBe('closed');
    if (closed.action !== 'closed' || opened.action !== 'opened') throw new Error('unreachable');
    expect(closed.incidentId).toBe(opened.incidentId);
    expect(closed.openMs).toBeGreaterThanOrEqual(0);

    expect(await getOpenIncident(hostId, SERVICE)).toBeNull();
    const rows = await listRecentIncidents(hostId);
    expect(rows[0].closed_at).not.toBeNull();
    // Recovery evidence survives too.
    expect((rows[0].resolved_detail as Record<string, unknown>).message).toContain('serving verified');
  });

  test('a later outage opens a SECOND incident rather than reopening the first', async () => {
    await recordOpsEvent({ hostId, service: SERVICE, status: 'down' });
    await recordOpsEvent({ hostId, service: SERVICE, status: 'ok' });
    await recordOpsEvent({ hostId, service: SERVICE, status: 'down' });
    expect(await listRecentIncidents(hostId)).toHaveLength(2);
    expect(await getOpenIncident(hostId, SERVICE)).not.toBeNull();
  });

  test('services are independent streams', async () => {
    await recordOpsEvent({ hostId, service: SERVICE, status: 'down' });
    await recordOpsEvent({ hostId, service: 'doorman', status: 'down' });
    // Closing one must not close the other.
    await recordOpsEvent({ hostId, service: SERVICE, status: 'ok' });
    expect(await getOpenIncident(hostId, SERVICE)).toBeNull();
    expect(await getOpenIncident(hostId, 'doorman')).not.toBeNull();
  });

  test('hosts are isolated — one host cannot close another host incident', async () => {
    await recordOpsEvent({ hostId, service: SERVICE, status: 'down' });
    // Same service name, different host: a separate incident, and 'ok' from the
    // other host must leave ours open.
    await recordOpsEvent({ hostId: otherHostId, service: SERVICE, status: 'ok' });
    expect(await getOpenIncident(hostId, SERVICE)).not.toBeNull();
  });

  test('the DB refuses a second OPEN incident for the same host+service', async () => {
    await recordOpsEvent({ hostId, service: SERVICE, status: 'down' });
    // The partial unique index is the real guarantee behind "one row per
    // incident" — the read-then-insert above could otherwise be raced.
    await expect(
      pg.query('insert into ops_events (host_id, service) values ($1, $2)', [hostId, SERVICE]),
    ).rejects.toThrow(/duplicate key|unique/i);
  });

  test('a race that loses the insert reports the existing incident, not an error', async () => {
    // Simulate the loser of the race: a row already exists when we try to open.
    await pg.query('insert into ops_events (host_id, service) values ($1, $2)', [hostId, SERVICE]);
    const r = await recordOpsEvent({ hostId, service: SERVICE, status: 'down' });
    expect(r.action).toBe('suppressed');
    expect(await listRecentIncidents(hostId)).toHaveLength(1);
  });
});

describe('service names', () => {
  test('accepts kebab-case, rejects the shapes that would fork a silent stream', () => {
    expect(isValidService('inference-medic')).toBe(true);
    expect(isValidService('doorman')).toBe(true);
    // A typo here creates a second incident stream nobody watches while the
    // real one looks quiet, so the write path rejects rather than accepts.
    expect(isValidService('Inference-Medic')).toBe(false);
    expect(isValidService('inference medic')).toBe(false);
    expect(isValidService('inference_medic')).toBe(false);
    expect(isValidService('-leading')).toBe(false);
    expect(isValidService('')).toBe(false);
    expect(isValidService('x'.repeat(65))).toBe(false);
  });
});
