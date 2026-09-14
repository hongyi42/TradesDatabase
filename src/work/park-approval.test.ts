// Pins the permission prompt on `park` to the commands that teach the park command.
//
// Nothing goes on the operator's board without their yes (user, 2026-09-14). `/park` asks first,
// and a `permissions.ask` rule in .claude/settings.json makes Claude Code prompt on the park
// command itself. That rule matches command TEXT, so rewording the park line in a command file
// would silently disarm it — no error anywhere, just a board that fills again. This test is what
// makes that rewording fail loudly.
//
// The matcher below approximates Claude Code's (`*` stands in for any text, the rule anchored at
// both ends), for single lines only. It is not the truth about multi-line heredoc commands or
// quoting — the live probe in plan 2026-09-14-the-task-board-is-the-operators (Phase 2) is.

import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const COMMANDS = join(ROOT, '.claude', 'commands');

const PARK_RULES = [
  'Bash(node "$W" park *)',
  'Bash(node *work.mjs park *)',
  'Bash(node *work.mjs" park *)',
  'Bash(npm run work -- park *)',
];

/** Does a `Bash(<pattern>)` rule match this command line? `*` = any text, anchored. */
function matches(rule: string, line: string): boolean {
  const m = /^Bash\((.*)\)$/.exec(rule);
  if (!m) return false;
  const pattern = m[1]
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s\\S]*');
  return new RegExp(`^${pattern}$`).test(line);
}

const matchesAny = (line: string) => PARK_RULES.some((rule) => matches(rule, line));

/**
 * Every work-record CLI invocation inside a fenced code block, with its verb.
 *
 * Deliberately wider than the rules: a spelling the rules do not cover must still be SEEN as a park
 * command, so the rule check fails on it instead of the scan quietly skipping it. Hence any `$W`
 * spelling (`$W`, `"$W"`, `${W}`), npm flags around `work`, backslash continuations joined first,
 * and each `&&` / `||` / `;` / `|` segment checked on its own — the same split Claude Code applies
 * before matching a rule.
 */
function cliLines(markdown: string): { verb: string; line: string }[] {
  const out: { verb: string; line: string }[] = [];
  const invocation = /(?:"?\$\{?W\}?"?|work\.mjs"?|npm\s+run(?:\s+-\S+)*\s+work(?:\s+-\S+)*\s+--)\s+([a-z]+)/;
  let inFence = false;
  let pending = '';
  for (const raw of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      pending = '';
      continue;
    }
    if (!inFence) continue;
    const joined = pending + raw;
    if (/\\\s*$/.test(joined)) {
      pending = `${joined.replace(/\\\s*$/, '')} `;
      continue;
    }
    pending = '';
    for (const segment of joined.split(/&&|\|\||;|\|/)) {
      const m = invocation.exec(segment);
      if (m) out.push({ verb: m[1], line: segment.trim() });
    }
  }
  return out;
}

describe('the permission prompt on park', () => {
  test('.claude/settings.json asks before every spelling of the park command', () => {
    const settings = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
    expect(settings.permissions?.ask).toEqual(expect.arrayContaining(PARK_RULES));
  });

  const files = readdirSync(COMMANDS).filter((f) => f.endsWith('.md'));
  const lines = files.flatMap((f) => cliLines(readFileSync(join(COMMANDS, f), 'utf8')).map((l) => ({ ...l, file: f })));

  test('park.md teaches at least one park command', () => {
    expect(lines.filter((l) => l.file === 'park.md' && l.verb === 'park').length).toBeGreaterThan(0);
  });

  test('every park command a command file teaches is caught by an ask rule', () => {
    for (const l of lines.filter((x) => x.verb === 'park')) {
      expect(matchesAny(l.line), `${l.file}: ${l.line}`).toBe(true);
    }
  });

  test('no other work-record command a command file teaches is caught', () => {
    const others = lines.filter((x) => x.verb !== 'park');
    expect(others.length).toBeGreaterThan(0);
    for (const l of others) {
      expect(matchesAny(l.line), `${l.file}: ${l.line}`).toBe(false);
    }
  });

  test('the scan sees park spellings the rules do not cover, so drift to them fails', () => {
    const fence = (body: string) => `\`\`\`bash\n${body}\n\`\`\``;
    const seen = (body: string) => cliLines(fence(body)).filter((l) => l.verb === 'park');
    for (const body of [
      'node $W park --title x',
      'node "${W}" park --title x',
      'node "$W" \\\n  park --title x',
      'node "$W" done 20260914-x && node "$W"  park --title x',
      'npm run -s work -- park --title x',
    ]) {
      const parks = seen(body);
      expect(parks.length, body).toBe(1);
      expect(matchesAny(parks[0].line), body).toBe(false);
    }
  });

  test('the direct spellings are caught, and neighbouring commands are not', () => {
    expect(matchesAny('node scripts/work.mjs park --title x')).toBe(true);
    expect(matchesAny('node /abs/path/scripts/work.mjs park --title x')).toBe(true);
    expect(matchesAny('npm run work -- park --title x')).toBe(true);
    expect(matchesAny('npm run board')).toBe(false);
    expect(matchesAny('npm run work -- overlap a b')).toBe(false);
    expect(matchesAny('node "$W" spawn 20260914-x')).toBe(false);
  });
});
