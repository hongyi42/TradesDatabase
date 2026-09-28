import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Only dist/seatGlue/ ships to the box, next to a package.json that holds the
// Copilot SDK and, since step 2b, the E2B SDK — nothing else. So a seatGlue
// module may import node built-ins, its siblings, and those two — any other
// import passes every gate here and then crashes on the box.
const DIR = join(process.cwd(), 'src', 'seatGlue');
const SDKS = new Set(['@github/copilot-sdk', 'e2b']);

describe('seatGlue is self-contained', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

  it('has modules to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it.each(files)('%s imports only node:*, ./siblings and the two SDKs', (file) => {
    const src = readFileSync(join(DIR, file), 'utf8');
    const specs = [...src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    const bad = specs.filter((s) => !s.startsWith('node:') && !s.startsWith('./') && !SDKS.has(s));
    expect(bad).toEqual([]);
  });
});
