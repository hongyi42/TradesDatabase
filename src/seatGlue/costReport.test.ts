import { describe, expect, it } from 'vitest';
import type { CostLine } from './costLog.js';
import { parseCliArgs, parseLines, summarize } from './costReport.js';

const line = (p: Partial<CostLine>): CostLine => ({
  ts: '2026-09-22T00:00:00Z',
  status: 'ok',
  seat: 's5',
  tenantId: 't',
  technicianRef: 'r',
  sessionId: 's',
  replyId: 'r1',
  kind: 'seat',
  generationId: Math.random().toString(),
  model: 'google/gemini-3.8-flash-20260902',
  totalCost: 0.01,
  ...p,
});

describe('summarize', () => {
  it('adds every call of a reply, transcription included, and averages per reply', () => {
    const s = summarize(
      [
        line({ replyId: 'r1', totalCost: 0.01 }),
        line({ replyId: 'r1', totalCost: 0.005, kind: 'transcribe' }),
        line({ replyId: 'r2', totalCost: 0.015 }),
      ],
      0.02,
    );
    expect(s.replies).toBe(2);
    expect(s.avgPerReply).toBeCloseTo(0.015);
    expect(s.maxPerReply).toBeCloseTo(0.015);
    expect(s.pass).toBe(true);
  });

  it('counts calls served by anything but Gemini as fallbacks', () => {
    const s = summarize([line({ model: 'meta/muse-spark-1.3' }), line({})], 0.02);
    expect(s.fallbackCalls).toBe(1);
  });

  it('fails above the threshold, and fails with no replies at all', () => {
    expect(summarize([line({ totalCost: 0.05 })], 0.02).pass).toBe(false);
    expect(summarize([], 0.02).pass).toBe(false);
  });

  it('reports unresolved lines separately and leaves them out of the averages', () => {
    const s = summarize([line({}), line({ status: 'unresolved', totalCost: undefined })], 0.02);
    expect(s.unresolved).toBe(1);
    expect(s.calls).toBe(1);
  });
});

describe('parseCliArgs', () => {
  it('keeps every file when no threshold is given', () => {
    expect(parseCliArgs(['a.jsonl', 'b.jsonl'])).toEqual({ files: ['a.jsonl', 'b.jsonl'], threshold: 0.02 });
  });

  it('takes the threshold from anywhere in the arguments', () => {
    expect(parseCliArgs(['a.jsonl', '--threshold', '0.03', 'b.jsonl'])).toEqual({
      files: ['a.jsonl', 'b.jsonl'],
      threshold: 0.03,
    });
  });

  it('rejects a threshold that is not a positive number', () => {
    expect(() => parseCliArgs(['a.jsonl', '--threshold'])).toThrow('positive');
  });
});

describe('parseLines', () => {
  it('reads JSONL, skipping blank lines', () => {
    expect(parseLines(`${JSON.stringify(line({}))}\n\n${JSON.stringify(line({}))}\n`)).toHaveLength(2);
  });
});
