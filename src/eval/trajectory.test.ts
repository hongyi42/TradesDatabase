import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_PREFIXES, parseSessionJsonl, parseTs, stripMcpPrefix } from './trajectory.js';

/**
 * A REAL s6 gateway transcript (D01, 2026-08-12 22:24:55Z), trimmed only by
 * shortening long text blobs — every key and every timestamp is verbatim.
 *
 * It is a file rather than a string literal ON PURPOSE. The first version of this
 * test used a hand-written fixture, and I had mislabelled which of the two
 * timestamps was which: I gave `message.timestamp` an ISO string when the real
 * field is epoch milliseconds. The parser then skipped every message and returned
 * an empty trajectory — and all 18 tests passed, because the fixture encoded the
 * same misreading as the code. The eval reported "the agent said nothing".
 *
 * A fixture you wrote from memory tests your memory. This one came off the wire.
 */
const REAL = readFileSync(join(import.meta.dirname, 'fixtures', 'gateway-session-d01.jsonl'), 'utf8');

describe('parseTs', () => {
  it('accepts both encodings openclaw uses in the SAME file', () => {
    // message.timestamp is epoch ms; the event's own timestamp is ISO.
    expect(parseTs(1786573495732)).toBe(1786573495732);
    expect(parseTs('2026-08-12T22:24:55.736Z')).toBe(1786573495736);
  });

  it('treats a numeric string as epoch ms, not a date', () => {
    expect(parseTs('1786573495732')).toBe(1786573495732);
  });

  it('returns NaN rather than 1970 for junk', () => {
    // Silently producing an epoch-zero timestamp would make every duration
    // enormous and every scenario "slow".
    for (const bad of [undefined, null, '', 'not-a-date', {}, []]) {
      expect(Number.isNaN(parseTs(bad)), String(bad)).toBe(true);
    }
  });
});

describe('stripMcpPrefix', () => {
  it('strips known MCP server prefixes so graders can match tool names', () => {
    expect(stripMcpPrefix('trades-spine__resolve_date')).toBe('resolve_date');
    expect(stripMcpPrefix('composio__GMAIL_SEND_EMAIL')).toBe('GMAIL_SEND_EMAIL');
  });

  it('leaves openclaw NATIVE tool names alone', () => {
    // "The agent reached for a built-in instead of a spine tool" is a finding; a
    // generic /^\w+__/ strip would erase it.
    for (const native of ['web_fetch', 'canvas', 'memory_search', 'sessions_history']) {
      expect(stripMcpPrefix(native)).toBe(native);
    }
    expect(stripMcpPrefix('someother__tool')).toBe('someother__tool');
  });

  it('has an explicit prefix list, not a pattern', () => {
    expect(MCP_PREFIXES).toContain('trades-spine__');
  });
});

describe('parseSessionJsonl on a real gateway transcript', () => {
  const t = parseSessionJsonl(REAL);

  it('parses the messages at all', () => {
    // The regression that motivated the file fixture: this was 0/0/0.
    expect(t.turns.length).toBeGreaterThan(0);
    expect(t.calls.length).toBeGreaterThan(0);
    expect(t.finalText.length).toBeGreaterThan(0);
  });

  it('finds both tool calls with names the graders recognise', () => {
    expect(t.calls.map((c) => c.tool)).toEqual(['resolve_date', 'get_team_schedule']);
  });

  it('reads arguments from `arguments`, not `args`', () => {
    expect(t.calls[0].args).toEqual({ dayShift: 0 });
  });

  it('ignores `thinking` blocks when building the visible reply', () => {
    // GLM-5.2 thinks by default; that is not what the person saw.
    expect(t.finalText).not.toContain('<thinking>');
    expect(t.assistantTexts.every((x) => !x.includes('<thinking>'))).toBe(true);
  });

  it('builds one turn per user message, owning its calls', () => {
    expect(t.turns).toHaveLength(1);
    expect(t.turns[0].calls).toHaveLength(2);
    expect(t.calls.every((c) => c.turn === 0)).toBe(true);
  });

  it('times the wall clock from first to last event completion', () => {
    // 22:24:55.736 → 22:25:13.086
    expect(t.wallMs).toBe(17350);
  });

  it('MEASURES the model leg per assistant message rather than deriving it', () => {
    // completed − started: 6758ms + 8704ms
    expect(t.modelMsMeasured).toBe(true);
    expect(t.modelMs).toBe(15462);
  });

  it('attributes a BATCH per call by the gaps, not from the shared start', () => {
    // Both calls were issued in ONE assistant message, and the gateway runs a
    // batch sequentially. Measuring from the shared start would report the second
    // call as 1878ms when it actually took 1149ms — a real run inflated a 2.9s
    // find_slots to 12.6s that way, which is how you end up optimising the wrong
    // tool.
    expect(t.calls[0].ms).toBe(729);
    expect(t.calls[1].ms).toBe(1878 - 729);
  });

  it('counts a batch ONCE against the turn, however calls are attributed', () => {
    // toolMs uses the latest result in the group, so it is unaffected by the
    // per-call model and the sum of parts can never exceed the window.
    expect(t.toolMs).toBe(1878);
    expect(t.calls.reduce((n, c) => n + c.ms, 0)).toBeLessThanOrEqual(t.toolMs);
  });

  it('reconciles: model + tools ≈ wall', () => {
    // The invariant that proves the timing model is coherent. If this drifts, one
    // of the three numbers is measuring the wrong thing.
    expect(Math.abs(t.modelMs + t.toolMs - t.wallMs)).toBeLessThan(50);
  });

  it('records the model, stop reasons and token usage', () => {
    expect(t.models.join(',')).toContain('glm-5.2');
    expect(t.stopReasons).toEqual(['toolUse', 'stop']);
    expect(t.tokens.input).toBeGreaterThan(0);
  });

  it('reports no dangling calls when every call got a result', () => {
    expect(t.danglingCalls).toBe(0);
  });
});

describe('parseSessionJsonl edge cases', () => {
  it('survives a truncated final line', () => {
    // Normal when reading a transcript while the agent is still writing.
    const t = parseSessionJsonl(`${REAL}\n{"type":"message","messa`);
    expect(t.calls).toHaveLength(2);
  });

  it('returns an empty trajectory for empty input rather than throwing', () => {
    const t = parseSessionJsonl('');
    expect(t.calls).toEqual([]);
    expect(t.turns).toEqual([]);
    expect(t.finalText).toBe('');
    expect(t.wallMs).toBe(0);
  });

  it('counts a tool call that never returned', () => {
    // A hung tool is a real production failure (answer_customer_question once blew
    // a 30s timeout), so it must surface as a number rather than a silent gap.
    const id = /"id":"([^"]+)","name":"trades-spine__get_team_schedule"/.exec(REAL)?.[1];
    expect(id).toBeTruthy();
    const lines = REAL.split('\n').filter((l) => !l.includes(`"toolCallId":"${id}"`));
    const t = parseSessionJsonl(lines.join('\n'));
    expect(t.danglingCalls).toBe(1);
  });

  it('keeps a toolResult that has no matching call', () => {
    const orphan =
      '{"type":"message","timestamp":"2026-08-12T22:25:14.000Z","message":{"role":"toolResult","timestamp":1786573514000,"toolName":"trades-spine__get_job","toolCallId":"nope","isError":false,"content":[{"type":"text","text":"null"}]}}';
    const t = parseSessionJsonl(`${REAL}\n${orphan}`);
    expect(t.calls.map((c) => c.tool)).toContain('get_job');
  });

  it('falls back to derived modelMs when start timestamps are absent', () => {
    // Older transcripts, or a vendor change: say WHICH method produced the number.
    const stripped = REAL.split('\n')
      .map((l) => l.replace(/"timestamp":\d+,/g, ''))
      .join('\n');
    const t = parseSessionJsonl(stripped);
    expect(t.modelMsMeasured).toBe(false);
    expect(t.modelMs).toBe(t.wallMs - t.toolMs);
  });
});
