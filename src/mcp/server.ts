import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fileURLToPath } from 'node:url';
import {
  getJob,
  getCustomer,
  searchCustomers,
  getCustomerContext,
  listRawCapturesForJob,
  listRawCapturesForCustomer,
  type CaptureChannel,
} from '../db/index.js';
import { recordFieldNote } from '../writePath/recordFieldNote.js';
import type { Extractor } from '../writePath/extract.js';
import {
  sonnetBriefer,
  sonnetAnswerer,
  type Briefer,
  type Answerer,
  type BriefFocus,
} from '../synthesis/index.js';
import { identityFromEnv, type RequestIdentity } from './identity.js';

// The single boundary the agent calls. The agent never holds the Supabase or
// Anthropic keys — this server (launched by the gateway with those secrets in
// env) is the only thing that touches the spine. The (tenant, technician)
// identity is supplied per request via deps.identity — env-pinned for stdio, the
// gateway's signed header for the central HTTP server — never from model args, so
// the agent cannot address another firm's data or claim another technician.
export interface ServerDeps {
  extract?: Extractor; // injectable so tests don't call the live model
  brief?: Briefer; // injectable briefing synthesizer (same reason)
  answer?: Answerer; // injectable Q&A synthesizer (same reason)
  identity?: RequestIdentity; // gateway-pinned tenant + technician for this request
}

const TECH_CHANNELS: CaptureChannel[] = ['technician_voice', 'technician_note', 'technician_photo'];
const BRIEF_FOCUSES: BriefFocus[] = ['next_visit', 'full_history'];

const TOOLS = [
  {
    name: 'record_field_note',
    description:
      'Record a technician field note into the spine (L1 → extract → identity match → L2/L3). ' +
      'Returns {status, captureId, ...}. If status is needs_confirmation or needs_disambiguation, ' +
      'ask the technician, then call again with the same captureId plus confirmed:{address} (or {customerId}).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The note text (voice already transcribed to text).' },
        blobPath: { type: 'string', description: 'Optional object-store pointer for audio/photo.' },
        channel: { type: 'string', enum: TECH_CHANNELS, description: 'Defaults to technician_note.' },
        captureId: { type: 'string', description: 'Set only when resuming after a confirmation.' },
        confirmed: {
          type: 'object',
          properties: { customerId: { type: 'string' }, address: { type: 'string' } },
        },
      },
      required: [],
    },
  },
  {
    name: 'find_customer',
    description: 'Search customers by name, phone, or address.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'get_customer_context',
    description: "Brief on a customer: their jobs, recent visits, and recent raw captures.",
    inputSchema: {
      type: 'object',
      properties: { customerId: { type: 'string' } },
      required: ['customerId'],
    },
  },
  {
    name: 'get_job',
    description: 'Fetch one job by id.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' } },
      required: ['jobId'],
    },
  },
  {
    name: 'list_recent_captures',
    description: 'List raw captures for a job (jobId) or a customer (customerId), newest first.',
    inputSchema: {
      type: 'object',
      properties: { jobId: { type: 'string' }, customerId: { type: 'string' } },
    },
  },
  {
    name: 'brief_customer',
    description:
      'Generate a grounded, cited briefing on a customer from their record. focus=next_visit ' +
      '(pre-visit cheat-sheet, default) or full_history (the relationship over time). ' +
      'Returns {briefing, citations:[{claim, captureId}]}.',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        focus: { type: 'string', enum: ['next_visit', 'full_history'] },
      },
      required: ['customerId'],
    },
  },
  {
    name: 'answer_customer_question',
    description:
      'Answer a free-text question about a customer using only their record (says so if the ' +
      'record lacks the answer). Returns {answer, citations:[{claim, captureId}]}.',
    inputSchema: {
      type: 'object',
      properties: {
        customerId: { type: 'string' },
        question: { type: 'string' },
      },
      required: ['customerId', 'question'],
    },
  },
];

async function dispatch(
  name: string,
  args: Record<string, unknown>,
  deps: ServerDeps,
): Promise<unknown> {
  const identity = deps.identity;
  if (!identity) throw new Error('identity is required');
  const { tenantId } = identity;
  const str = (k: string): string | undefined =>
    typeof args[k] === 'string' ? (args[k] as string) : undefined;

  switch (name) {
    case 'record_field_note': {
      const channelArg = str('channel');
      if (channelArg && !TECH_CHANNELS.includes(channelArg as CaptureChannel)) {
        throw new Error(`invalid channel: ${channelArg}`);
      }
      const channel: CaptureChannel = (channelArg as CaptureChannel | undefined) ?? 'technician_note';
      const confirmed = args.confirmed as { customerId?: string; address?: string } | undefined;
      // Tenant-guard the WRITE path too: a model-supplied confirmed.customerId wins
      // outright in matchIdentity, so without this a forged id would attach the
      // visit to another firm's customer/job. (The read-tool guards don't cover
      // writes; the address/phone/schedule match branches are already tenant-scoped.)
      if (confirmed?.customerId) {
        const customer = await getCustomer(confirmed.customerId);
        if (!customer || customer.tenant_id !== tenantId) {
          throw new Error('customer not found');
        }
      }
      return recordFieldNote(
        {
          tenantId,
          technicianRef: identity.technicianRef,
          text: str('text') ?? null,
          blobPath: str('blobPath') ?? null,
          channel,
          captureId: str('captureId'),
          confirmed,
        },
        { extract: deps.extract },
      );
    }
    case 'find_customer': {
      const query = str('query');
      if (!query) throw new Error('query is required');
      return searchCustomers(tenantId, query);
    }
    case 'get_customer_context': {
      const customerId = str('customerId');
      if (!customerId) throw new Error('customerId is required');
      const ctx = await getCustomerContext(customerId);
      // Tenant guard: a cross-tenant (or unknown) id reads as an empty record.
      if (!ctx.customer || ctx.customer.tenant_id !== tenantId) {
        return { customer: null, jobs: [], recentVisits: [], recentCaptures: [] };
      }
      return ctx;
    }
    case 'get_job': {
      const jobId = str('jobId');
      if (!jobId) throw new Error('jobId is required');
      const job = await getJob(jobId);
      // Tenant guard: a cross-tenant (or unknown) id reads as not found.
      return job && job.tenant_id === tenantId ? job : null;
    }
    case 'list_recent_captures': {
      const jobId = str('jobId');
      const customerId = str('customerId');
      // Tenant guard via the parent: captures inherit the job's/customer's tenant,
      // so verifying the parent gates the whole list (a mismatch reads as empty).
      if (jobId) {
        const job = await getJob(jobId);
        if (!job || job.tenant_id !== tenantId) return [];
        return listRawCapturesForJob(jobId);
      }
      if (customerId) {
        const customer = await getCustomer(customerId);
        if (!customer || customer.tenant_id !== tenantId) return [];
        return listRawCapturesForCustomer(customerId);
      }
      throw new Error('list_recent_captures requires jobId or customerId');
    }
    case 'brief_customer': {
      const customerId = str('customerId');
      if (!customerId) throw new Error('customerId is required');
      const focusArg = str('focus');
      // The SDK doesn't validate args against inputSchema, so check the enum here
      // (mirrors the channel guard on record_field_note).
      if (focusArg && !BRIEF_FOCUSES.includes(focusArg as BriefFocus)) {
        throw new Error(`invalid focus: ${focusArg}`);
      }
      const ctx = await getCustomerContext(customerId);
      // Guard a bad/cross-tenant id with a clean error before spending a model call.
      if (!ctx.customer || ctx.customer.tenant_id !== tenantId) {
        throw new Error('customer not found');
      }
      const focus = (focusArg as BriefFocus | undefined) ?? 'next_visit';
      return (deps.brief ?? sonnetBriefer)(ctx, focus);
    }
    case 'answer_customer_question': {
      const customerId = str('customerId');
      if (!customerId) throw new Error('customerId is required');
      const question = str('question');
      if (!question) throw new Error('question is required');
      const ctx = await getCustomerContext(customerId);
      if (!ctx.customer || ctx.customer.tenant_id !== tenantId) {
        throw new Error('customer not found');
      }
      return (deps.answer ?? sonnetAnswerer)(ctx, question);
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export function createServer(deps: ServerDeps = {}): Server {
  const server = new Server(
    { name: 'trades-spine', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      const result = await dispatch(name, (args ?? {}) as Record<string, unknown>, deps);
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      };
    }
  });

  return server;
}

async function main(): Promise<void> {
  const server = createServer({ identity: identityFromEnv() });
  await server.connect(new StdioServerTransport());
}

// Start the stdio server only when executed directly (node dist/mcp/server.js),
// not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
