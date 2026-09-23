import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { CostLine } from './costLog.js';

// The step-1 cost check (operator, 2026-09-22): the new seat's average cost per
// REPLY must be at or below openclaw's ~$0.02 — a figure only ever known as a
// residual of the OpenRouter bill. A reply is every model call between one
// message from the technician and the seat going idle, transcription included.
export interface CostSummary {
  replies: number;
  calls: number;
  unresolved: number;
  totalCost: number;
  avgPerReply: number;
  maxPerReply: number;
  /** Seat calls served by anything but Gemini — the preset's sticky Muse fallback shows up here. */
  fallbackCalls: number;
  thresholdUsd: number;
  pass: boolean;
}

export function summarize(lines: CostLine[], thresholdUsd: number): CostSummary {
  const ok = lines.filter((l) => l.status === 'ok');
  const perReply = new Map<string, number>();
  let totalCost = 0;
  let fallbackCalls = 0;
  for (const l of ok) {
    const cost = l.totalCost ?? 0;
    totalCost += cost;
    if (l.replyId) perReply.set(l.replyId, (perReply.get(l.replyId) ?? 0) + cost);
    if (l.kind === 'seat' && !(l.model ?? '').startsWith('google/gemini')) fallbackCalls += 1;
  }
  const values = [...perReply.values()];
  const avgPerReply = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  return {
    replies: values.length,
    calls: ok.length,
    unresolved: lines.length - ok.length,
    totalCost,
    avgPerReply,
    maxPerReply: values.length ? Math.max(...values) : 0,
    fallbackCalls,
    thresholdUsd,
    // An unresolved line is a call we could not price: the average would read
    // low, so the check cannot pass until every line is resolved.
    pass: values.length > 0 && avgPerReply <= thresholdUsd && lines.length === ok.length,
  };
}

export function parseLines(text: string): CostLine[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as CostLine);
}

export function parseCliArgs(argv: string[]): { files: string[]; threshold: number } {
  const i = argv.indexOf('--threshold');
  const threshold = i >= 0 ? Number(argv[i + 1]) : 0.02;
  if (!Number.isFinite(threshold) || threshold <= 0) throw new Error('costReport: --threshold must be a positive number');
  const files = argv.filter((_, j) => !(i >= 0 && (j === i || j === i + 1)));
  return { files, threshold };
}

// CLI: node costReport.js <costs.jsonl>... [--threshold 0.02]
async function main(argv: string[]): Promise<void> {
  const { files, threshold } = parseCliArgs(argv);
  if (!files.length) throw new Error('usage: costReport <costs.jsonl>... [--threshold 0.02]');
  const lines = (await Promise.all(files.map((f) => readFile(f, 'utf8')))).flatMap(parseLines);
  console.log(JSON.stringify(summarize(lines, threshold), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
