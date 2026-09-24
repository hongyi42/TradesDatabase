// A stand-in for the spine: an MCP server over stdio with one read tool and two
// state-changing tools. Every EXECUTION appends a line to $PROBE_LOG, so the
// driver can tell what actually ran (not just what the model asked for).
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const LOG = process.env.PROBE_LOG;
const hit = (name, args) => appendFileSync(LOG, JSON.stringify({ t: Date.now(), src: 'mcp', name, args }) + '\n');

const server = new McpServer({ name: 'probe-spine', version: '0.0.1' });

server.registerTool(
  'lookup_job',
  { description: 'Read a job: customer, status, money summary, line items.', inputSchema: { jobId: z.string() }, annotations: { readOnlyHint: true } },
  async ({ jobId }) => {
    hit('lookup_job', { jobId });
    return { content: [{ type: 'text', text: JSON.stringify({ jobId, customer: 'Byrne', title: 'Kitchen remodel', status: 'completed', lineItems: [{ desc: 'Cabinets install', cents: 420000 }, { desc: 'Parts', cents: 38000 }] }) }] };
  },
);

server.registerTool(
  'record_note',
  { description: 'Record a note on a job in the permanent record.', inputSchema: { jobId: z.string(), text: z.string() }, annotations: { readOnlyHint: false } },
  async ({ jobId, text }) => {
    hit('record_note', { jobId, text });
    return { content: [{ type: 'text', text: 'recorded' }] };
  },
);

server.registerTool(
  'send_invoice',
  { description: 'Email an invoice PDF to the customer and record it as issued.', inputSchema: { jobId: z.string(), path: z.string() }, annotations: { readOnlyHint: false, destructiveHint: true } },
  async ({ jobId, path }) => {
    hit('send_invoice', { jobId, path });
    return { content: [{ type: 'text', text: 'sent and recorded' }] };
  },
);

server.registerTool(
  'get_schedule',
  { description: 'Read the schedule for a day (YYYY-MM-DD or "tomorrow").', inputSchema: { day: z.string() }, annotations: { readOnlyHint: true } },
  async ({ day }) => {
    hit('get_schedule', { day });
    return { content: [{ type: 'text', text: JSON.stringify({ day, visits: [{ time: '09:00', job: 'J-12', customer: 'Byrne', tech: 'Ben' }, { time: '13:00', job: 'J-14', customer: 'Okafor', tech: 'Sam' }] }) }] };
  },
);

await server.connect(new StdioServerTransport());
