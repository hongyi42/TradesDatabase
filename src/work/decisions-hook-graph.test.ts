// Tests for the pre-edit hook's code-graph lines: what a sibling worktree, or main, has changed
// in a function the file being edited imports.
//
// The hook runs exactly as Claude Code runs it — payload on stdin, JSON on stdout — against a
// real TypeScript fixture with real worktrees, because the whole point is what git and the
// compiler say about files no session told the record about. Sibling changes here are written
// straight to disk and never go through `touch`: that is the Bash path the file list cannot see.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const HOOK = join(process.cwd(), '.claude', 'hooks', 'decisions-for-file.mjs');
const CLI = join(process.cwd(), 'scripts', 'work.mjs');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Hook Graph Test',
  GIT_AUTHOR_EMAIL: 'hook-graph@test.invalid',
  GIT_COMMITTER_NAME: 'Hook Graph Test',
  GIT_COMMITTER_EMAIL: 'hook-graph@test.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let tmp: string;
let home: string;
let markers: string;
let mainCheckout: string;
let counter = 0;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

function work(args: string[], cwd: string): string {
  return execFileSync('node', [CLI, ...args], {
    cwd, encoding: 'utf8', input: '', env: { ...process.env, ...GIT_ENV, HOME: home },
  }).trim();
}

/** Run the hook as Claude Code does, and return the context it injected ('' when silent). */
function hookContext(payload: Record<string, unknown>, extraEnv: Record<string, string> = {}, hook = HOOK): string {
  const out = execFileSync('node', [hook], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    // CLAUDE_PROJECT_DIR left at the main checkout, as Claude Code leaves it for a session that
    // entered a worktree: the hook must find everything from the edited file alone.
    env: { ...process.env, ...GIT_ENV, HOME: home, TMPDIR: markers, CLAUDE_PROJECT_DIR: mainCheckout, ...extraEnv },
  });
  if (!out.trim()) return '';
  const parsed = JSON.parse(out);
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  return parsed.hookSpecificOutput.additionalContext as string;
}

const edit = (wt: string, file: string, session = randomUUID()) => ({
  session_id: session, cwd: wt, hook_event_name: 'PreToolUse', tool_name: 'Edit',
  tool_input: { file_path: join(wt, file) },
});

function newTask(title: string): { wt: string; id: string } {
  const n = ++counter;
  const wt = join(tmp, `wt-${n}`);
  git(['worktree', 'add', '--no-track', wt, '-b', `branch-${n}`, 'origin/main'], mainCheckout);
  const id = work(['park', '--title', title, '--kind', 'task'], mainCheckout);
  work(['claim', id], wt);
  return { wt, id };
}

function rewrite(wt: string, file: string, from: string, to: string): void {
  const p = join(wt, file);
  const before = readFileSync(p, 'utf8');
  if (!before.includes(from)) throw new Error(`fixture drift: ${file} has no ${JSON.stringify(from)}`);
  writeFileSync(p, before.replace(from, to));
}

const finish = (...ids: string[]) => { for (const id of ids) work(['done', id], mainCheckout); };

const WIDEN = ['price(amount: number): number {\n  return amount + 1;', 'price(amount: number, tax: number): number {\n  return amount + tax;'] as const;

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'hook-graph-')));
  home = join(tmp, 'home');
  markers = join(tmp, 'markers');
  mkdirSync(home, { recursive: true });
  mkdirSync(markers, { recursive: true });

  mainCheckout = join(tmp, 'repo');
  mkdirSync(join(mainCheckout, 'src', 'db'), { recursive: true });
  git(['init', '-b', 'main'], mainCheckout);
  writeFileSync(join(mainCheckout, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(mainCheckout, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, target: 'ES2022' },
    include: ['src'],
  }));
  writeFileSync(join(mainCheckout, 'src', 'lib.ts'), [
    'export function price(amount: number): number {',
    '  return amount + 1;',
    '}',
    '',
    'export function greet(): string {',
    "  return 'hello';",
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(mainCheckout, 'src', 'use.ts'),
    "import { price } from './lib.js';\n\nexport const one = price(1);\n");
  writeFileSync(join(mainCheckout, 'src', 'barrel.ts'), "export * from './lib.js';\n");
  writeFileSync(join(mainCheckout, 'src', 'use2.ts'),
    "import { price } from './barrel.js';\n\nexport const two = price(2);\n");
  writeFileSync(join(mainCheckout, 'src', 'db', 'database.types.ts'), 'export type Db = { a: string };\n');
  writeFileSync(join(mainCheckout, 'src', 'db', 'useDb.ts'),
    "import type { Db } from './database.types.js';\n\nexport const row: Db = { a: 'x' };\n");
  // One committed decision, on use2.ts, so a case can check the graph never costs the lines the
  // hook already gave.
  mkdirSync(join(mainCheckout, 'thoughts'), { recursive: true });
  writeFileSync(join(mainCheckout, 'thoughts', 'by-file.json'), JSON.stringify({
    'src/use2.ts': [{
      date: '2026-01-01', what: 'the decision about use2', where: 'thoughts/shared/plans/x.md',
      kind: 'doc', drift: 0, dead: 0, durable: '## Decisions', durableFirm: true,
    }],
  }));
  git(['add', '.'], mainCheckout);
  git(['commit', '-m', 'fixture'], mainCheckout);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], mainCheckout);
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('the pre-edit hook names what a sibling or main changed', () => {
  test('a sibling\'s signature change reaches the file that imports it — directly and through a barrel', () => {
    const sibling = newTask('widen price');
    const me = newTask('work on the callers');
    try {
      rewrite(sibling.wt, 'src/lib.ts', ...WIDEN);
      const line = `changed the signature of \`price\` (src/lib.ts), which this file imports`;
      const direct = hookContext(edit(me.wt, 'src/use.ts'));
      expect(direct).toContain(`SIBLING ${sibling.wt.split('/').pop()} · ${sibling.id} ${line}`);
      expect(hookContext(edit(me.wt, 'src/use2.ts'))).toContain(line);
    } finally {
      finish(sibling.id, me.id);
    }
  });

  test('a sibling dropping the re-export a file imports through is a removal to that file', () => {
    const sibling = newTask('trim the barrel');
    const me = newTask('edit the barrel caller');
    try {
      // lib.ts is untouched: the break is in the barrel between them, which use2.ts imports from.
      rewrite(sibling.wt, 'src/barrel.ts', "export * from './lib.js';\n", '');
      expect(hookContext(edit(me.wt, 'src/use2.ts')))
        .toContain(`${sibling.id} removed \`export * from './lib.js'\` (src/barrel.ts), which this file imports`);
    } finally {
      finish(sibling.id, me.id);
    }
  });

  test('a body-only change is named as a change in what the function does', () => {
    const sibling = newTask('price rounds now');
    const me = newTask('edit use for the body case');
    try {
      rewrite(sibling.wt, 'src/lib.ts', 'return amount + 1;', 'return Math.round(amount + 1);');
      const out = hookContext(edit(me.wt, 'src/use.ts'));
      expect(out).toContain('changed what `price` does');
      expect(out).not.toContain('changed the signature');
    } finally {
      finish(sibling.id, me.id);
    }
  });

  test('a sibling editing the same file is found from git, with the functions it changed', () => {
    const sibling = newTask('greet differently');
    const me = newTask('also in lib');
    try {
      // The sibling's task file lists NO files: only git knows it touched lib.ts.
      rewrite(sibling.wt, 'src/lib.ts', "return 'hello';", "return 'howdy';");
      const out = hookContext(edit(me.wt, 'src/lib.ts'));
      expect(out).toMatch(new RegExp(`SIBLING wt-\\d+ on branch-\\d+ · active on ${sibling.id} ".*" — changed \`greet\` \\(body, \\d+ lines\\) in this file`));
    } finally {
      finish(sibling.id, me.id);
    }
  });

  test('a file that imports nothing anyone changed hears nothing', () => {
    const sibling = newTask('greet only');
    const me = newTask('edit use, unrelated');
    try {
      rewrite(sibling.wt, 'src/lib.ts', "return 'hello';", "return 'hey';");
      expect(hookContext(edit(me.wt, 'src/use.ts'))).toBe('');
    } finally {
      finish(sibling.id, me.id);
    }
  });

  test('a regenerated types file is never announced to the files that import it', () => {
    const sibling = newTask('regenerate');
    const me = newTask('edit a db user');
    try {
      rewrite(sibling.wt, 'src/db/database.types.ts', 'a: string', 'a: string; b: number');
      expect(hookContext(edit(me.wt, 'src/db/useDb.ts'))).toBe('');
    } finally {
      finish(sibling.id, me.id);
    }
  });

  test('a Write creating a new file is checked against the content it will have', () => {
    const sibling = newTask('widen price for the write case');
    const me = newTask('write a new caller');
    try {
      rewrite(sibling.wt, 'src/lib.ts', ...WIDEN);
      const out = hookContext({
        session_id: randomUUID(), cwd: me.wt, hook_event_name: 'PreToolUse', tool_name: 'Write',
        tool_input: { file_path: join(me.wt, 'src', 'fresh.ts'), content: "import { price } from './lib.js';\nexport const z = price(0);\n" },
      });
      expect(out).toContain('changed the signature of `price`');
    } finally {
      finish(sibling.id, me.id);
    }
  });

  test('a second edit to the same file in the same session is silent', () => {
    const sibling = newTask('widen price for the repeat case');
    const me = newTask('edit use twice');
    const session = randomUUID();
    try {
      rewrite(sibling.wt, 'src/lib.ts', ...WIDEN);
      expect(hookContext(edit(me.wt, 'src/use.ts', session))).toContain('SIBLING');
      expect(hookContext(edit(me.wt, 'src/use.ts', session))).toBe('');
    } finally {
      finish(sibling.id, me.id);
    }
  });

  test('a file already told about in this session costs no sibling git work at all', () => {
    const sibling = newTask('widen price for the no-work case');
    const me = newTask('edit use, then again');
    const session = randomUUID();
    // A git that leaves a mark whenever anyone asks about a worktree's state.
    const shim = join(tmp, `shim-${++counter}`);
    const sentinel = join(shim, 'touched');
    mkdirSync(shim, { recursive: true });
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shim, 'git'),
      `#!/bin/sh\ncase " $* " in *" status "*|*" merge-base "*) : > "${sentinel}" ;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    try {
      rewrite(sibling.wt, 'src/lib.ts', ...WIDEN);
      expect(hookContext(edit(me.wt, 'src/use.ts', session))).toContain('SIBLING');
      // The same file again. Being silent is not enough: the check must come BEFORE the work,
      // or every repeat edit still pays for git in every sibling worktree.
      const again = hookContext(edit(me.wt, 'src/use.ts', session), { PATH: `${shim}:${process.env.PATH}` });
      expect(again).toBe('');
      expect(existsSync(sentinel)).toBe(false);
    } finally {
      finish(sibling.id, me.id);
    }
  });

  test('a graph library that throws never costs the decisions and file-list lines already given', () => {
    // The sibling's file list names use2.ts, so there IS a file-list line for the floor to keep.
    const n = ++counter;
    const siblingWt = join(tmp, `wt-${n}`);
    git(['worktree', 'add', '--no-track', siblingWt, '-b', `branch-${n}`, 'origin/main'], mainCheckout);
    const siblingId = work(['park', '--title', 'a sibling for the broken-library case', '--kind', 'task', '--files', 'src/use2.ts'], mainCheckout);
    work(['claim', siblingId], siblingWt);
    const sibling = { wt: siblingWt, id: siblingId };
    const me = newTask('edit use2 with a broken library');
    // The same hook, beside a library whose every function exists but one throws outside the
    // per-query guard: the shape of a half-updated checkout.
    const fake = join(tmp, `fake-${++counter}`);
    mkdirSync(join(fake, '.claude', 'hooks'), { recursive: true });
    mkdirSync(join(fake, 'scripts'), { recursive: true });
    writeFileSync(join(fake, '.claude', 'hooks', 'decisions-for-file.mjs'), readFileSync(HOOK, 'utf8'));
    const ok = '() => null';
    writeFileSync(join(fake, 'scripts', 'code-graph.mjs'), [
      `export const loadTs = ${ok};`, `export const setGitTimeout = ${ok};`,
      "export const defaultRef = () => { throw new Error('half-updated'); };",
      `export const subjectFromTask = ${ok};`, `export const mainSince = ${ok};`, `export const footprint = ${ok};`,
      `export const symbolDelta = ${ok};`, `export const namedImports = ${ok};`,
      'export const isSymbolFile = () => true;', 'export const isGenerated = () => false;', '',
    ].join('\n'));
    try {
      const out = hookContext(edit(me.wt, 'src/use2.ts'), {}, join(fake, '.claude', 'hooks', 'decisions-for-file.mjs'));
      expect(out).toContain('the decision about use2');
      expect(out).toContain(`active on ${sibling.id} "a sibling for the broken-library case" — has touched this file`);
    } finally {
      finish(sibling.id, me.id);
    }
  });

  test('a worktree folder that has lost its .git is never blamed for the main checkout\'s edits', () => {
    // Inside the main checkout, where git run in the orphaned folder walks up to — main.
    const ghost = join(mainCheckout, '.claude', 'worktrees', 'ghost');
    git(['worktree', 'add', '--no-track', ghost, '-b', 'ghost-branch', 'origin/main'], mainCheckout);
    const ghostId = work(['park', '--title', 'ghost task', '--kind', 'task'], mainCheckout);
    work(['claim', ghostId], ghost);
    rmSync(join(ghost, '.git'));
    const me = newTask('edit lib beside a ghost');
    try {
      rewrite(mainCheckout, 'src/lib.ts', "return 'hello';", "return 'from main';");
      expect(hookContext(edit(me.wt, 'src/lib.ts'))).not.toContain('SIBLING ghost');
    } finally {
      git(['checkout', '--', 'src/lib.ts'], mainCheckout);
      work(['drop', ghostId], mainCheckout);
      rmSync(ghost, { recursive: true, force: true });
      git(['worktree', 'prune'], mainCheckout);
      finish(me.id);
    }
  });

  /** A git whose `status` hangs for three seconds — a wedged sibling worktree. */
  function wedgedGit(): string {
    const shim = join(tmp, `shim-${++counter}`);
    mkdirSync(shim, { recursive: true });
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(shim, 'git'),
      `#!/bin/sh\ncase " $* " in *" status "*) sleep 3 ;; esac\nexec "${realGit}" "$@"\n`, { mode: 0o755 });
    return `${shim}:${process.env.PATH}`;
  }

  test('one wedged sibling costs the edit about a second, not the three its git would take', () => {
    const sibling = newTask('one slow sibling');
    const me = newTask('edit use beside one slow sibling');
    try {
      const started = Date.now();
      hookContext(edit(me.wt, 'src/use.ts'), { PATH: wedgedGit() });
      // Measured: ~1.4 s with the hook's 1 s per-call cap, ~3.4 s with the library's default.
      expect(Date.now() - started).toBeLessThan(2500);
    } finally {
      finish(sibling.id, me.id);
    }
  }, 30_000);

  test('several siblings with a wedged git cost the edit a bounded wait, not one per sibling', () => {
    const siblings = Array.from({ length: 5 }, (_, i) => newTask(`slow sibling ${i}`));
    const me = newTask('edit use with slow siblings');
    try {
      const started = Date.now();
      hookContext(edit(me.wt, 'src/use.ts'), { PATH: wedgedGit() });
      // Five siblings × a 1 s per-call cap would be over five seconds; the 1.5 s budget stops
      // starting new siblings once it is spent.
      expect(Date.now() - started).toBeLessThan(4000);
    } finally {
      finish(...siblings.map((s) => s.id), me.id);
    }
  }, 30_000);

  // Last, because it moves origin/main (and puts it back).
  test('main changing an imported signature says MAIN MOVED, until the task merges main', () => {
    const original = git(['rev-parse', 'refs/remotes/origin/main'], mainCheckout);
    const me = newTask('long-running task');
    const mover = join(tmp, `wt-${++counter}`);
    try {
      git(['worktree', 'add', '--detach', mover, 'origin/main'], mainCheckout);
      rewrite(mover, 'src/lib.ts', ...WIDEN);
      git(['commit', '-q', '-am', 'main widens price'], mover);
      git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'], mover)], mainCheckout);

      const out = hookContext(edit(me.wt, 'src/use.ts'));
      expect(out).toContain('MAIN MOVED since this task started: `price` (src/lib.ts) changed signature on origin/main');

      git(['merge', '-q', '--ff-only', 'origin/main'], me.wt);
      expect(hookContext(edit(me.wt, 'src/use.ts'))).not.toContain('MAIN MOVED');
    } finally {
      git(['update-ref', 'refs/remotes/origin/main', original], mainCheckout);
      finish(me.id);
    }
  });
});
