import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCTRINE_UPDATES, PORTED_BLOCKS, PORTED_HEADINGS, RULE5_REPLACEMENT, TECHNICIAN_DOCTRINE } from './doctrine.js';

// The seat glue's doctrine is a COPY of the AGENTS.md blocks bootstrap-box.sh
// wires into the openclaw seats. While both stacks run, a change to one without
// the other gives two seats different rules. This test is the tripwire: if it
// fails, regenerate src/seatGlue/doctrine.ts from the bootstrap blocks.
function bootstrapBlocks(): Map<string, string> {
  const lines = readFileSync(join(process.cwd(), 'Box_Setup_Stuff', 'bootstrap-box.sh'), 'utf8').split('\n');
  const blocks = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes("<<'EOF'")) continue;
    const body: string[] = [];
    for (i += 1; i < lines.length && lines[i] !== 'EOF'; i++) body.push(lines[i]);
    const text = body.join('\n').trim();
    if (text.startsWith('## ')) blocks.set(text.split('\n', 1)[0], text);
  }
  return blocks;
}

describe('technician doctrine', () => {
  const source = bootstrapBlocks();

  it.each(PORTED_HEADINGS.map((h, i) => [h, i] as const))('%s matches bootstrap-box.sh', (heading, i) => {
    const original = source.get(heading);
    expect(original, `no bootstrap block headed "${heading}" — renamed? regenerate doctrine.ts`).toBeDefined();
    const expected = heading.startsWith('## Dates and times')
      ? (original as string).replace(/\n5\. The `timestamp` in the conversation-info block[\s\S]*?(?=\n6\. )/, RULE5_REPLACEMENT)
      : original;
    expect(PORTED_BLOCKS[i]).toBe(expected);
  });

  it('drops the openclaw-only blocks and the UTC trap, and teaches the spine- prefix and the blobPath guard', () => {
    expect(TECHNICIAN_DOCTRINE).not.toContain('conversation-info');
    expect(TECHNICIAN_DOCTRINE).not.toContain('## Scheduled / recurring work');
    expect(TECHNICIAN_DOCTRINE).not.toContain('## Long or bulk tasks');
    expect(TECHNICIAN_DOCTRINE).toContain('spine-record_field_note');
    expect(TECHNICIAN_DOCTRINE).toContain('Never set `blobPath`');
  });

  it.each(DOCTRINE_UPDATES.map(([from, to], i) => [i, from, to] as const))(
    'update %i matches exactly once in the ported blocks and lands in the doctrine',
    (_i, from, to) => {
      const hits = PORTED_BLOCKS.join('\n\n').split(from).length - 1;
      expect(hits, 'a bootstrap edit moved this sentence — update DOCTRINE_UPDATES').toBe(1);
      expect(TECHNICIAN_DOCTRINE).not.toContain(from);
      expect(TECHNICIAN_DOCTRINE).toContain(to);
    },
  );
});
