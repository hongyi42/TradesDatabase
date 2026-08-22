// Types for the eval's caller, so its arithmetic can be unit-tested from
// src/eval/*.test.ts without loosening the project's noImplicitAny.
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}
export interface CallCost {
  usd: number; inTok: number; outTok: number;
  read: number; write5m: number; write1h: number; cacheHit: boolean;
}
export const PRICES: Record<string, { base: number; out: number }>;
export const CACHE_MULT: { read: number; write5m: number; write1h: number };
export function costOf(usage: AnthropicUsage, model: string, ttl?: string): CallCost;
export function counterfactuals(
  rows: { read: number; write5m: number; write1h: number }[],
  model: string,
): { noCache: number; ttl5m: number; ttl1h: number; allWrites5m: number };
export function callPlanner(opts: {
  system: string;
  tool: { name: string; description?: string; inputSchema: unknown };
  user: string;
  model: string;
  ttl?: string;
  apiKey: string;
  fetchImpl?: unknown;
}): Promise<{
  plan: Record<string, unknown> | null;
  stopReason: string | null;
  usage: AnthropicUsage;
  cost: CallCost;
  raw: unknown;
}>;
