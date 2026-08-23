import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createTenant } from '../db/tenants.js';
import { insertTechnician, setTechnicianState } from '../db/technicians.js';

// GROUNDING_BARE is read at MODULE LOAD (the flag rides a deploy), so this
// file sets it before dynamically importing the server — its own vitest
// worker keeps the bare module instance away from every other test file.
// server.test.ts pins the un-bare shapes (resolve_date listed, steering
// present), so together the two files pin the flag in both positions.
process.env.GROUNDING_BARE = '1';
const { createServer } = await import('./server.js');

let tenantId: string;
let mgrClient: Client;
let techClient: Client;

const connect = async (technicianRef: string): Promise<Client> => {
  const server = createServer({ identity: { tenantId, technicianRef } });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bare-test', version: '0.0.0' });
  await Promise.all([server.connect(st), client.connect(ct)]);
  return client;
};

beforeAll(async () => {
  tenantId = (await createTenant(`bare-test-${Date.now()}`, { managerSeats: 1, technicianSeats: 1 })).id;
  const mgr = await insertTechnician({
    tenantId,
    ref: 'bare-mgr',
    displayName: 'Bare Mgr',
    tier: 'manager',
  });
  await setTechnicianState(mgr.id, 'active');
  const tech = await insertTechnician({ tenantId, ref: 'bare-tech', displayName: 'Bare Tech' });
  await setTechnicianState(tech.id, 'active');
  mgrClient = await connect('bare-mgr');
  techClient = await connect('bare-tech');
});

afterAll(async () => {
  delete process.env.GROUNDING_BARE;
  await mgrClient?.close();
  await techClient?.close();
});

describe('GROUNDING_BARE — the bare-clock surface', () => {
  test('resolve_date is hidden from both tiers', async () => {
    for (const c of [techClient, mgrClient]) {
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('resolve_date');
      expect(names).toContain('record_field_note'); // the surface itself is intact
    }
  });

  test('query_spine keeps schema facts, loses the date-discipline steering', async () => {
    const qs = (await mgrClient.listTools()).tools.find((t) => t.name === 'query_spine');
    expect(qs).toBeDefined();
    const d = qs!.description ?? '';
    // Steering gone: the distrust doctrine written for the GLM-era model.
    expect(d).not.toContain('DATE BOUNDS');
    expect(d).not.toContain('your clock is UTC');
    expect(d).not.toContain('resolve_date');
    expect(d).not.toContain('never work out');
    // Schema facts stay: true statements about the data, not advice.
    expect(d).toContain('local_day');
    expect(d).toContain('local_weekday');
  });
});
