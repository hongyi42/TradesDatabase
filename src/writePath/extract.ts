import Anthropic from '@anthropic-ai/sdk';
import type { Json } from '../db/index.js';

// Candidate structured fields the model proposes from a raw note. Every field is
// optional — extraction is best-effort interpretation (overview §5: the model
// interprets, code decides). Identity/status are *suggestions* here; the
// deterministic write-path (identityMatch / recordFieldNote) makes the calls.
export interface ExtractedFields {
  customerName?: string | null;
  phone?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  jobTitle?: string | null;
  jobType?: string | null;
  workPerformed?: string | null;
  laborHours?: number | null;
  statusSignal?: 'completed' | 'in_progress' | null;
  followUp?: string | null;
  // L3 long-tail facts that don't deserve a column: gate codes, pets, access
  // notes, spotted replacement opportunities, etc.
  attributes?: Json;
}

// Injected into the write-path so tests can supply a deterministic stub instead
// of calling the live model.
export type Extractor = (rawText: string) => Promise<ExtractedFields>;

const EXTRACTION_SYSTEM =
  'You extract structured fields from a trades technician field note (HVAC/plumbing/' +
  'electrical/etc.). Map only what the note actually says — leave a field absent if ' +
  'the note does not support it; never invent customers, addresses, or prices. ' +
  'Put durable long-tail facts (gate codes, pets, access notes, spotted ' +
  'replacement opportunities) in `attributes`. Set `statusSignal` only if the note ' +
  'clearly indicates the job is finished (completed) or actively underway (in_progress).';

// Single forced tool — the model's only move is to return this structured object.
const EXTRACTION_TOOL: Anthropic.Tool = {
  name: 'record_extraction',
  description: 'Record the structured fields extracted from the technician field note.',
  input_schema: {
    type: 'object',
    properties: {
      customerName: { type: 'string', description: 'Customer / household / site name if stated.' },
      phone: { type: 'string', description: 'Customer phone if stated.' },
      address: { type: 'string', description: 'Street address line if stated.' },
      city: { type: 'string' },
      state: { type: 'string' },
      postalCode: { type: 'string' },
      jobTitle: { type: 'string', description: 'Short title for the work, e.g. "AC repair".' },
      jobType: { type: 'string', description: 'Trade/category, e.g. "hvac", "plumbing".' },
      workPerformed: { type: 'string', description: 'What the technician did or observed.' },
      laborHours: { type: 'number', description: 'Hours of labor if stated.' },
      statusSignal: {
        type: 'string',
        enum: ['completed', 'in_progress'],
        description: 'Only if the note clearly signals job completion or active work.',
      },
      followUp: { type: 'string', description: 'Any follow-up needed (return visit, quote, part).' },
      attributes: {
        type: 'object',
        description: 'Long-tail L3 facts as key/value pairs (gate code, pets, lead opportunity).',
        additionalProperties: true,
      },
    },
    additionalProperties: false,
  },
};

// Default extractor: Claude Sonnet, forced through the extraction tool so the
// reply is always a structured object (or an error we can surface).
export const sonnetExtractor: Extractor = async (rawText) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const client = new Anthropic({ apiKey });
  const message = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: EXTRACTION_SYSTEM,
    tools: [EXTRACTION_TOOL],
    tool_choice: { type: 'tool', name: EXTRACTION_TOOL.name },
    messages: [{ role: 'user', content: rawText }],
  });
  const toolUse = message.content.find(
    (block): block is Anthropic.ToolUseBlock =>
      block.type === 'tool_use' && block.name === EXTRACTION_TOOL.name,
  );
  if (!toolUse) throw new Error('sonnetExtractor: model returned no record_extraction tool_use block');
  return toolUse.input as ExtractedFields;
};
