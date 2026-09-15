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
//
// EVERY RULE STARTS WITH THE PARK ITSELF (user, 2026-09-14, final review). The first set had
// `node *work.mjs park *`, whose leading `*` spans quoted text, so a `node -e` or a handoff whose
// body merely MENTIONED a park was prompted — and denied outright in a subagent, which has nobody
// to ask. "Only fire when something is actually being parked." The price is accepted: a park
// spelled some other way (`node $W park`, a full path to work.mjs) is not prompted; `/park`'s own
// question is the gate, and this rule is the backstop.
//
// AND THE TAUGHT PARK IS ONE COMMAND, NEVER `W=…` THEN `node "$W" park` (measured 2026-09-14,
// Claude Code 2.1.270, `claude -p` in throwaway repos). Neither `Bash(node "$W" park *)` nor the
// same rule with the assignment's value written in matched that two-line form; only the wide
// `node *work.mjs park *` did, which is the rule that also fires on mentions. So a park through a
// variable set in the same command goes unprompted, and this file's single-line matcher cannot see
// that — hence the test that refuses `$W` on a taught park line.

import { describe, expect, test } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const COMMANDS = join(ROOT, '.claude', 'commands');

const INLINE = 'node "$(git rev-parse --path-format=absolute --git-common-dir)/../scripts/work.mjs"';
const PARK_RULES = [
  `Bash(${INLINE} park *)`,
  'Bash(node scripts/work.mjs park *)',
  'Bash(npm run work -- park *)',
];

// What Claude Code will actually apply: every Bash ask rule in the file, not this test's copy, so a
// broader rule added there is checked against the commands that must NOT prompt.
const SETTINGS = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf8'));
const ASK_RULES: string[] = (SETTINGS.permissions?.ask ?? []).filter((r: string) => r.startsWith('Bash('));

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

const matchesAny = (line: string) => ASK_RULES.some((rule) => matches(rule, line));

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
  test('.claude/settings.json asks before the taught spellings of the park command', () => {
    expect(ASK_RULES).toEqual(expect.arrayContaining(PARK_RULES));
  });

  test('every ask rule starts with the park itself, so a mere mention cannot match', () => {
    const prefixes = [INLINE, 'node scripts/work.mjs', 'npm run work --'];
    for (const rule of ASK_RULES) {
      expect(prefixes.some((p) => rule === `Bash(${p} park *)`), rule).toBe(true);
    }
  });

  test('a taught park command never runs through $W', () => {
    // The two-line `W=…` + `node "$W" park` form parks with no prompt (measured; see the header),
    // and the single-line matcher here would wrongly call it covered if a `$W` rule came back.
    for (const l of lines.filter((x) => x.verb === 'park')) {
      expect(l.line, `${l.file}: ${l.line}`).not.toMatch(/\$\{?W\}?/);
    }
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
      'node "$W" park --title x',
      'node $W park --title x',
      'node "${W}" park --title x',
      'node "$W" \\\n  park --title x',
      'node "$W" done 20260914-x && node "$W"  park --title x',
      'npm run -s work -- park --title x',
      'node /abs/path/scripts/work.mjs park --title x',
    ]) {
      const parks = seen(body);
      expect(parks.length, body).toBe(1);
      expect(matchesAny(parks[0].line), body).toBe(false);
    }
  });

  test('the direct spellings are caught, and neighbouring commands are not', () => {
    expect(matchesAny(`${INLINE} park --title x --body -`)).toBe(true);
    expect(matchesAny(`${INLINE} handoff --body -`)).toBe(false);
    expect(matchesAny('node scripts/work.mjs park --title x')).toBe(true);
    expect(matchesAny('npm run work -- park --title x')).toBe(true);
    expect(matchesAny('npm run board')).toBe(false);
    expect(matchesAny('npm run work -- overlap a b')).toBe(false);
    expect(matchesAny('node "$W" spawn 20260914-x')).toBe(false);
  });

  test('a command that only MENTIONS a park is not caught', () => {
    // Both were prompted — the node -e denied outright in a review subagent — under the first
    // rule set, whose `node *work.mjs park *` let the leading `*` span quoted text.
    expect(matchesAny(`node -e "console.log('run node scripts/work.mjs park --title x')"`)).toBe(false);
    expect(matchesAny('node "$W" handoff --body "parked it with node scripts/work.mjs park --title x"')).toBe(false);
    expect(matchesAny('node "$W" promote 20260914-x # after node "$W" park --title x')).toBe(false);
    expect(matchesAny(`${INLINE} handoff --body "then ${INLINE} park --title x"`)).toBe(false);
  });
});
