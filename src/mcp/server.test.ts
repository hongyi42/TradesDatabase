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
  process.env.DEFAULT_TENANT_ID = tenantId;

  const server = createServer({
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
      technicianRef: tech,
      text: 'all wrapped up',
      channel: 'technician_voice',
    });
    expect(first.isError).toBe(false);
    expect(first.data.status).toBe('needs_confirmation');
    expect(first.data.suggestion.address).toBe('12 MCP St');

    const resumed = await call('record_field_note', {
      technicianRef: tech,
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
      technicianRef: 'tech-bad',
      text: 'x',
      channel: 'not_a_channel',
    });
    expect(isError).toBe(true);
  });
});
