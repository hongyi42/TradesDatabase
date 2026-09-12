import { describe, expect, test } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// THE GATE NOTHING ELSE IS: a literal control character in source passes tsc,
// eslint, the whole suite and the build, and is invisible in review — while
// `grep` calls the file BINARY and shows none of its lines, so a later session
// searching it gets silence that reads as "not there".
//
// It arrives the same way every time: a unicode escape typed through an editing
// tool that decodes escapes before saving, so the six characters meant for the
// compiler land as the byte itself. Twice on 2026-09-11/12 — once in
// planner.ts (caught before commit), once in toolLoop.ts's fingerprint
// separator, which reached `main` and deployed.
//
// NO ESCAPES IN THIS FILE, deliberately: a test that wrote the escape it hunts
// for would be the first thing the trap ate — the first draft of this very file
// was, and this test caught it. Character codes only.
const ROOTS = ['src', 'scripts'];
const CODE = new Set(['.ts', '.mts', '.cts', '.mjs', '.cjs', '.js', '.sql', '.json']);
// Tab (9), newline (10) and carriage return (13) are the legal ones; everything
// below the space is not. DEL (127) is left alone — it is not what this trap
// produces, and flagging it would fail on legitimate fixtures.
const isForbidden = (code: number): boolean => code < 32 && code !== 9 && code !== 10 && code !== 13;

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (CODE.has(path.slice(path.lastIndexOf('.')))) yield path;
  }
}

describe('source hygiene', () => {
  test('no source file carries a control character — grep would call it binary', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(root)) {
        const text = readFileSync(file, 'utf8');
        for (let i = 0; i < text.length; i++) {
          if (!isForbidden(text.charCodeAt(i))) continue;
          const line = text.slice(0, i).split('\n').length;
          offenders.push(`${file}:${line} has character code ${text.charCodeAt(i)}`);
          break; // one report per file is enough to find it
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
