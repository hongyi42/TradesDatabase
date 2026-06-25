import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Client as PgClient } from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { getClient } from '../db/client.js';
import { createCustomer } from '../db/customers.js';
import { createJob } from '../db/jobs.js';
import { upsertScheduleEntry } from '../db/scheduleEntries.js';
import { createServer } from './server.js';

// Drive the MCP server over the SDK's in-memory transport (no network/stdio).
// The extractor is stubbed so record_field_note never calls the live model.
const pg = new PgClient({ connectionString: process.env.DATABASE_URL });
let tenantId: string;
let client: Client;

beforeAll(async () => {
  await pg.connect();
  const { data, error } = await getClient().from('tenants').select('id').limit(1).single();
  if (error || !data) throw new Error(`could not load seed tenant: ${error?.message ?? 'none'}`);
  tenantId = data.id;

  const server = createServer({
    // Identity is injected here (the gateway/env source in prod); the agent never
    // supplies technicianRef. 'tech-mcp' matches the schedule entry below.
    identity: { tenantId, technicianRef: 'tech-mcp' },
    extract: async () => ({ workPerformed: 'did the work' }),
    // Stub the synthesizers so the MCP tests never call the live model.
    brief: async (ctx) => ({ briefing: `stub briefing for ${ctx.customer?.name}`, citations: [] }),
    answer: async (ctx, question) => ({
      answer: `stub answer to "${question}" for ${ctx.customer?.name}`,
      citations: [],
    }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
  await pg.query('truncate table schedule_entries, customers, jobs, visits, raw_captures cascade');
  await pg.end();
});

async function call(name: string, args: Record<string, unknown>) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text: string }>;
  const text = content[0].text;
  const isError = res.isError === true;
  // Success results are JSON; error results are a plain message string.
  return { isError, text, data: isError ? undefined : JSON.parse(text) };
}

// Build an isolated client whose server is pinned to a specific identity — used
// to exercise the tenant guards from a *different* tenant than the seeded rows.
async function clientFor(identity: { tenantId: string; technicianRef: string }) {
  const server = createServer({
    identity,
    extract: async () => ({ workPerformed: 'did the work' }),
    brief: async (ctx) => ({ briefing: `stub for ${ctx.customer?.name}`, citations: [] }),
    answer: async (ctx, question) => ({ answer: `stub: ${question}`, citations: [] }),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const isolated = new Client({ name: 'test-client-other-tenant', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), isolated.connect(clientTransport)]);
  const callWith = async (name: string, args: Record<string, unknown>) => {
    const res = await isolated.callTool({ name, arguments: args });
    const content = res.content as Array<{ type: string; text: string }>;
    const isError = res.isError === true;
    return { isError, data: isError ? undefined : JSON.parse(content[0].text) };
  };
  return { client: isolated, callWith };
}

describe('MCP server', () => {
  test('lists the technician tool surface', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'record_field_note',
        'find_customer',
        'get_customer_context',
        'get_job',
        'list_recent_captures',
        'brief_customer',
        'answer_customer_question',
      ]),
    );
  });

  test('record_field_note returns needs_confirmation, then resolves on resume', async () => {
    const tech = 'tech-mcp';
    const day = new Date().toISOString().slice(0, 10);
    await upsertScheduleEntry({
      tenantId,
      technicianRef: tech,
      externalRowKey: 'mcp-1',
      customerName: 'MCP Cust',
      addressLine1: '12 MCP St',
      scheduledStart: `${day}T12:00:00.000Z`,
    });

    const first = await call('record_field_note', {
      text: 'all wrapped up',
      channel: 'technician_voice',
    });
    expect(first.isError).toBe(false);
    expect(first.data.status).toBe('needs_confirmation');
    expect(first.data.suggestion.address).toBe('12 MCP St');

    const resumed = await call('record_field_note', {
      captureId: first.data.captureId,
      confirmed: { address: '12 MCP St' },
    });
    expect(resumed.data.status).toBe('matched');
    expect(resumed.data.customerId).toBeDefined();

    // Cross-channel read-back: the L1 capture exists with the voice channel.
    const cap = await pg.query<{ channel: string }>(
      'select channel from raw_captures where id = $1',
      [first.data.captureId],
    );
    expect(cap.rows[0].channel).toBe('technician_voice');

    // Identity, not call args, is the source of technicianRef: the visit's
    // technician_name comes from the injected identity ('tech-mcp'), even though
    // no technicianRef was passed in the tool call.
    const vis = await pg.query<{ technician_name: string }>(
      'select technician_name from visits where id = $1',
      [resumed.data.visitId],
    );
    expect(vis.rows[0].technician_name).toBe('tech-mcp');
  });

  test('get_customer_context returns the aggregated record', async () => {
    const customer = await createCustomer({ tenantId, name: 'Ctx Over Mcp', phone: '555-3300' });
    await createJob({ tenantId, customerId: customer.id, title: 'J' });

    const { isError, data } = await call('get_customer_context', { customerId: customer.id });
    expect(isError).toBe(false);
    expect(data.customer.id).toBe(customer.id);
    expect(data.jobs.length).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(data.recentVisits)).toBe(true);
    expect(Array.isArray(data.recentCaptures)).toBe(true);
  });

  test('brief_customer returns a briefing + citations (stubbed synthesizer)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Brief Me', phone: '555-4400' });
    await createJob({ tenantId, customerId: customer.id, title: 'J' });

    const { isError, data } = await call('brief_customer', { customerId: customer.id });
    expect(isError).toBe(false);
    expect(typeof data.briefing).toBe('string');
    expect(Array.isArray(data.citations)).toBe(true);
  });

  test('answer_customer_question returns an answer + citations (stubbed synthesizer)', async () => {
    const customer = await createCustomer({ tenantId, name: 'Ask Me', phone: '555-5500' });

    const { isError, data } = await call('answer_customer_question', {
      customerId: customer.id,
      question: 'What is going on with this customer?',
    });
    expect(isError).toBe(false);
    expect(typeof data.answer).toBe('string');
    expect(Array.isArray(data.citations)).toBe(true);
  });

  test('a synthesis tool on a bogus customerId is a clean "customer not found" error', async () => {
    const { isError, text } = await call('brief_customer', {
      customerId: '00000000-0000-0000-0000-000000000000',
    });
    expect(isError).toBe(true);
    expect(text).toContain('customer not found');
  });

  test('brief_customer rejects an invalid focus value', async () => {
    const customer = await createCustomer({ tenantId, name: 'Focus Test', phone: '555-6600' });
    const { isError, text } = await call('brief_customer', {
      customerId: customer.id,
      focus: 'deep_dive',
    });
    expect(isError).toBe(true);
    expect(text).toContain('invalid focus');
  });

  test('an invalid channel is rejected as a tool error', async () => {
    const { isError } = await call('record_field_note', {
      text: 'x',
      channel: 'not_a_channel',
    });
    expect(isError).toBe(true);
  });

  test('id-based read tools are tenant-scoped: a cross-tenant id reads as not-found', async () => {
    const WRONG_TENANT = '00000000-0000-0000-0000-000000000000';
    const customer = await createCustomer({ tenantId, name: 'Tenant Scoped', phone: '555-7700' });
    const job = await createJob({ tenantId, customerId: customer.id, title: 'Scoped Job' });

    // Correct tenant (the shared client, identity tenant == seed tenant) sees the rows.
    const okJob = await call('get_job', { jobId: job.id });
    expect(okJob.isError).toBe(false);
    expect(okJob.data.id).toBe(job.id);
    const okCtx = await call('get_customer_context', { customerId: customer.id });
    expect(okCtx.data.customer.id).toBe(customer.id);
    const okBrief = await call('brief_customer', { customerId: customer.id });
    expect(okBrief.isError).toBe(false);

    // Wrong tenant: the SAME ids read as empty / null / error across all five tools.
    const { client: otherClient, callWith } = await clientFor({
      tenantId: WRONG_TENANT,
      technicianRef: 'tech-x',
    });
    try {
      expect((await callWith('get_job', { jobId: job.id })).data).toBeNull();

      const ctx = await callWith('get_customer_context', { customerId: customer.id });
      expect(ctx.data.customer).toBeNull();
      expect(ctx.data.jobs).toEqual([]);

      expect((await callWith('list_recent_captures', { jobId: job.id })).data).toEqual([]);
      expect((await callWith('list_recent_captures', { customerId: customer.id })).data).toEqual([]);

      expect((await callWith('brief_customer', { customerId: customer.id })).isError).toBe(true);
      expect(
        (await callWith('answer_customer_question', { customerId: customer.id, question: 'hi' }))
          .isError,
      ).toBe(true);
    } finally {
      await otherClient.close();
    }
  });

  test('record_field_note write path is tenant-scoped: a cross-tenant confirmed.customerId is rejected', async () => {
    // A customer that belongs to the seed tenant...
    const customer = await createCustomer({ tenantId, name: 'Write Guard Cust', phone: '555-8800' });
    // ...is not addressable by a DIFFERENT tenant's agent via confirmed.customerId.
    const { client: otherClient, callWith } = await clientFor({
      tenantId: '00000000-0000-0000-0000-000000000000',
      technicianRef: 'tech-x',
    });
    try {
      const res = await callWith('record_field_note', {
        text: 'sneaky cross-tenant write',
        confirmed: { customerId: customer.id },
      });
      expect(res.isError).toBe(true); // rejected before any L1/L2 row is written
    } finally {
      await otherClient.close();
    }

    // And no raw_capture was appended for the rejected write (guard runs first).
    const caps = await pg.query<{ n: string }>(
      "select count(*)::text as n from raw_captures where raw_text = 'sneaky cross-tenant write'",
    );
    expect(caps.rows[0].n).toBe('0');
  });
});
