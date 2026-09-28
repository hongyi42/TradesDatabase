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

describe('manager doctrine (step 2a)', () => {
  it('carries every ported block, the spine- and composio- prefixes, memory and ask_user', async () => {
    const { MANAGER_DOCTRINE, MANAGER_PREAMBLE } = await import('./doctrine.js');
    for (const block of PORTED_BLOCKS.map((b) => DOCTRINE_UPDATES.reduce((t, [from, to]) => t.split(from).join(to), b))) {
      expect(MANAGER_DOCTRINE).toContain(block);
    }
    expect(MANAGER_DOCTRINE.startsWith(MANAGER_PREAMBLE)).toBe(true);
    expect(MANAGER_PREAMBLE).toContain('composio-COMPOSIO_MANAGE_CONNECTIONS');
    expect(MANAGER_PREAMBLE).toContain('spine-write_my_memory');
    expect(MANAGER_PREAMBLE).toContain('`ask_user`');
    // Operator 2026-09-27: choices go to ask_user first; a plan is one course of action.
    expect(MANAGER_PREAMBLE).toContain('PLANS. A plan you show for approval is ONE course of action');
    // Operator 2026-09-28: a plan a manager can read — plain words, the assumptions, no machinery.
    expect(MANAGER_PREAMBLE).toContain('Write the plan for the manager, not for yourself');
    expect(MANAGER_PREAMBLE).toContain('Never tool names, file paths, queries');
    // Step 2b: the computer is NOT in the preamble — only a seat with the tools is told (engine.ts).
    expect(MANAGER_PREAMBLE).not.toContain('FILES. You have a computer of your own');
    const { FILES_SECTION } = await import('./doctrine.js');
    expect(FILES_SECTION).toContain('FILES. You have a computer of your own for this manager');
    expect(FILES_SECTION).toContain('never by copying rows');
    expect(FILES_SECTION).not.toContain('technician');
    expect(MANAGER_PREAMBLE).not.toContain('technician');
    expect(MANAGER_DOCTRINE).not.toContain('## Long or bulk tasks');
  });
});
