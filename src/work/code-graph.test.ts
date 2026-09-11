// End-to-end tests for scripts/code-graph.mjs, driven through the work.mjs verbs that use it.
//
// Same rule as work-cli.test.ts: a real git repository, real worktrees, the real script. The
// graph's hard parts ARE git and the compiler — which commit a worktree's HEAD names, what the
// porcelain status says about an untracked file, how `./lib.js` resolves to `lib.ts` — and a
// mocked version of either would only assert our assumptions back at us.
//
// Every case builds fresh worktrees from the same committed fixture, so no case can pass
// because of state an earlier one left behind.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'scripts', 'work.mjs');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Graph Test',
  GIT_AUTHOR_EMAIL: 'graph@test.invalid',
  GIT_COMMITTER_NAME: 'Graph Test',
  GIT_COMMITTER_EMAIL: 'graph@test.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

interface Item {
  severity: string;
  kind: string;
  file: string;
  symbol: string;
  detail: string;
  sizes: Record<string, number>;
}

let tmp: string;
let home: string;
let mainCheckout: string;
let counter = 0;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

function work(args: string[], cwd: string, input = ''): string {
  return execFileSync('node', [CLI, ...args], {
    cwd, encoding: 'utf8', input, env: { ...process.env, ...GIT_ENV, HOME: home },
  }).trim();
}

function overlap(a: string, b: string): Item[] {
  return JSON.parse(work(['overlap', a, b, '--json'], mainCheckout)) as Item[];
}

function taskFiles(id: string): string {
  const text = readFileSync(join(mainCheckout, '.claude', 'work', 'tasks', `${id}.md`), 'utf8');
  // `[ \t]*`, not `\s*`: an empty value would let `\s` swallow the newline and read the next line.
  return /^files:[ \t]*(.*)$/m.exec(text)?.[1].trim() ?? '';
}

/** A fresh worktree on its own branch from origin/main, holding a claimed task. */
function newTask(title: string): { wt: string; id: string } {
  const n = ++counter;
  const wt = join(tmp, `wt-${n}`);
  git(['worktree', 'add', '--no-track', wt, '-b', `branch-${n}`, 'origin/main'], mainCheckout);
  const id = work(['park', '--title', title, '--kind', 'task'], mainCheckout);
  work(['claim', id], wt);
  return { wt, id };
}

/** Edit a file in place the way a Bash script would: no Edit tool, no hook, no `touch`. */
function rewrite(wt: string, file: string, from: string, to: string): void {
  const p = join(wt, file);
  const before = readFileSync(p, 'utf8');
  if (!before.includes(from)) throw new Error(`fixture drift: ${file} has no ${JSON.stringify(from)}`);
  writeFileSync(p, before.replace(from, to));
}

function commit(wt: string, message: string): void {
  git(['add', '-A'], wt);
  git(['commit', '-m', message], wt);
}

const finish = (...ids: string[]) => { for (const id of ids) work(['done', id], mainCheckout); };

const LIB = [
  'export function price(amount: number): number {',
  '  return amount + 1;',
  '}',
  '',
  'export function greet(): string {',
  "  return 'hello';",
  '}',
  '',
  'export type Row = { id: number };',
  '',
].join('\n');

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'code-graph-')));
  home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });

  mainCheckout = join(tmp, 'repo');
  mkdirSync(join(mainCheckout, 'src', 'db'), { recursive: true });
  git(['init', '-b', 'main'], mainCheckout);
  writeFileSync(join(mainCheckout, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(mainCheckout, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, target: 'ES2022' },
    include: ['src'],
  }));
  writeFileSync(join(mainCheckout, 'src', 'lib.ts'), LIB);
  writeFileSync(join(mainCheckout, 'src', 'use.ts'),
    "import { price } from './lib.js';\n\nexport const one = price(1);\nexport const two = price(2);\n");
  // The barrel is the shape that hides most of this repo's imports: src/db/index.ts re-exports
  // 32 modules and 48 modules import through it.
  writeFileSync(join(mainCheckout, 'src', 'barrel.ts'), "export * from './lib.js';\n");
  writeFileSync(join(mainCheckout, 'src', 'use2.ts'),
    "import { price } from './barrel.js';\n\nexport const three = price(3);\n");
  writeFileSync(join(mainCheckout, 'src', 'db', 'database.types.ts'), 'export type Db = { a: string };\n');
  writeFileSync(join(mainCheckout, 'src', 'db', 'useDb.ts'),
    "import type { Db } from './database.types.js';\n\nexport const row: Db = { a: 'x' };\n");
  // A renaming re-export, and a local export list: two more ways a name leaves a file.
  writeFileSync(join(mainCheckout, 'src', 'barrel2.ts'), "export { price as cost } from './lib.js';\n");
  writeFileSync(join(mainCheckout, 'src', 'use3.ts'),
    "import { cost } from './barrel2.js';\n\nexport const four = cost(4);\n");
  writeFileSync(join(mainCheckout, 'src', 'local.ts'),
    'function hidden(n: number): number {\n  return n;\n}\n\nexport { hidden };\n');
  writeFileSync(join(mainCheckout, 'src', 'use4.ts'),
    "import { hidden } from './local.js';\n\nexport const five = hidden(5);\n");
  mkdirSync(join(mainCheckout, 'supabase'), { recursive: true });
  writeFileSync(join(mainCheckout, 'supabase', 'config.toml'), 'project_id = "fixture"\n');
  // A name git escapes unless asked for -z: without it this path arrives as "src/caf\303\251 x.ts".
  writeFileSync(join(mainCheckout, 'src', 'café x.ts'), 'export function tip(n: number): number {\n  return n;\n}\n');
  // Overloads: one export, three declarations.
  writeFileSync(join(mainCheckout, 'src', 'over.ts'), [
    'export function fmt(n: number): string;',
    'export function fmt(n: number, unit: string): string;',
    "export function fmt(n: number, unit = ''): string {",
    '  return `${n}${unit}`;',
    '}',
    '',
  ].join('\n'));
  writeFileSync(join(mainCheckout, 'src', 'useOver.ts'), "import { fmt } from './over.js';\n\nexport const s = fmt(1);\n");
  // An imported name passed straight back out through a local export list.
  writeFileSync(join(mainCheckout, 'src', 'pass.ts'), "import { greet } from './lib.js';\n\nexport { greet };\n");
  writeFileSync(join(mainCheckout, 'src', 'usePass.ts'), "import { greet } from './pass.js';\n\nexport const hi = greet();\n");
  git(['add', '.'], mainCheckout);
  git(['commit', '-m', 'fixture'], mainCheckout);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], mainCheckout);
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('work.mjs overlap — where two tasks collide, and how badly', () => {
  test('(a) a changed signature is found from git alone, and sized by its call sites', () => {
    const A = newTask('widen price');
    const B = newTask('touch the caller');
    try {
      // Written straight to disk and never committed: the Bash path the edit hook cannot see.
      rewrite(A.wt, 'src/lib.ts', 'price(amount: number): number {\n  return amount + 1;',
        'price(amount: number, tax: number): number {\n  return amount + tax;');
      rewrite(B.wt, 'src/use.ts', 'export const two', 'export const extra = 0;\nexport const two');
      // The record never heard about either edit. The overlap must come from git, not files:.
      expect(taskFiles(A.id)).toBe('');

      const hit = overlap(A.id, B.id).find((i) => i.kind === 'changed signature');
      expect(hit).toMatchObject({ severity: 'MED', file: 'src/lib.ts', symbol: 'price' });
      expect(hit?.sizes.callSites).toBe(2);
      expect(hit?.detail).toContain('src/use.ts');
    } finally {
      finish(A.id, B.id);
    }
  });

  test('(b) both tasks changing the same function is HIGH, with both sides sized', () => {
    const A = newTask('greet in French');
    const B = newTask('greet in Spanish');
    try {
      rewrite(A.wt, 'src/lib.ts', "return 'hello';", "return 'bonjour';");
      commit(A.wt, 'A');
      rewrite(B.wt, 'src/lib.ts', "return 'hello';", "return 'hola';");
      commit(B.wt, 'B');

      const items = overlap(A.id, B.id);
      const high = items.find((i) => i.severity === 'HIGH');
      expect(high).toMatchObject({ kind: 'same function', file: 'src/lib.ts', symbol: 'greet' });
      // Committed work, so this also pins that HEAD is read inside each task's own checkout.
      expect(high?.sizes[A.id]).toBeGreaterThan(0);
      expect(high?.sizes[B.id]).toBeGreaterThan(0);
    } finally {
      finish(A.id, B.id);
    }
  });

  test('(c) the same file with different functions is only LOW', () => {
    const A = newTask('change greet');
    const B = newTask('change price body');
    try {
      rewrite(A.wt, 'src/lib.ts', "return 'hello';", "return 'hi';");
      commit(A.wt, 'A');
      rewrite(B.wt, 'src/lib.ts', 'return amount + 1;', 'return amount + 2;');
      commit(B.wt, 'B');

      const items = overlap(A.id, B.id);
      expect(items.map((i) => `${i.severity} ${i.kind} ${i.file}`)).toEqual(['LOW same file only src/lib.ts']);
      expect(items[0].detail).toContain('`greet`');
      expect(items[0].detail).toContain('`price`');
    } finally {
      finish(A.id, B.id);
    }
  });

  test('(d) a comment-only edit changes neither signature nor body', () => {
    const A = newTask('annotate price');
    const B = newTask('edit a caller');
    try {
      rewrite(A.wt, 'src/lib.ts', '  return amount + 1;', '  // one is the handling fee\n  return amount   +   1;');
      rewrite(B.wt, 'src/use.ts', 'export const two', 'export const extra = 0;\nexport const two');
      expect(overlap(A.id, B.id)).toEqual([]);
    } finally {
      finish(A.id, B.id);
    }
  });

  test('(e) a generated file both tasks touch says regenerate, never merge', () => {
    const A = newTask('migration one');
    const B = newTask('migration two');
    try {
      rewrite(A.wt, 'src/db/database.types.ts', 'a: string', 'a: string; b: number');
      commit(A.wt, 'A');
      rewrite(B.wt, 'src/db/database.types.ts', 'a: string', 'a: string; c: boolean');
      commit(B.wt, 'B');

      const items = overlap(A.id, B.id);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ severity: 'LOW', kind: 'generated file', file: 'src/db/database.types.ts' });
      expect(items[0].detail).toContain('gen:types:local');
    } finally {
      finish(A.id, B.id);
    }
  });

  test('(f) a parked finding that names the file and mentions the function is HIGH', () => {
    const A = newTask('rework greet');
    const finding = work(['park', '--title', 'greet sounds too formal', '--files', 'src/lib.ts',
      '--body', '-'], mainCheckout, 'Customers say greet should be friendlier.\n');
    try {
      rewrite(A.wt, 'src/lib.ts', "return 'hello';", "return 'good day';");
      commit(A.wt, 'A');

      const high = overlap(A.id, finding).find((i) => i.severity === 'HIGH');
      expect(high).toMatchObject({ kind: 'same function', file: 'src/lib.ts', symbol: 'greet' });
      expect(high?.detail).toContain(`${finding} names this file and mentions \`greet\``);
    } finally {
      finish(A.id);
      work(['drop', finding], mainCheckout);
    }
  });

  test('(g) a signature change is seen through a barrel re-export', () => {
    const A = newTask('widen price again');
    const B = newTask('edit the barrel caller');
    try {
      rewrite(A.wt, 'src/lib.ts', 'price(amount: number)', 'price(amount: number, tax = 0)');
      rewrite(B.wt, 'src/use2.ts', 'export const three', 'export const four = 4;\nexport const three');
      // use2.ts imports from barrel.ts, which A never touched. Without following `export *`
      // back to lib.ts, this collision is invisible.
      const hit = overlap(A.id, B.id).find((i) => i.kind === 'changed signature');
      expect(hit).toMatchObject({ severity: 'MED', file: 'src/lib.ts', symbol: 'price' });
      expect(hit?.detail).toContain('src/use2.ts');
      expect(hit?.sizes.callSites).toBe(1);
    } finally {
      finish(A.id, B.id);
    }
  });

  test('the text report prints the worst first, with the numbers inline', () => {
    const A = newTask('report greet');
    const B = newTask('report greet too');
    try {
      rewrite(A.wt, 'src/lib.ts', "return 'hello';", "return 'hey';");
      rewrite(B.wt, 'src/lib.ts', "return 'hello';", "return 'yo';");
      const out = work(['overlap', A.id, B.id], mainCheckout);
      expect(out).toMatch(/— 1 overlap\n/);
      expect(out).toMatch(/HIGH\s+same function\s+src\/lib\.ts › greet/);
      expect(out).toMatch(/lines\)/);
    } finally {
      finish(A.id, B.id);
    }
  });

  test('a name that is neither a task nor a branch fails loudly', () => {
    expect(() => work(['overlap', 'no-such-thing', 'main'], mainCheckout)).toThrow(/neither a task in the record nor a branch/);
  });

  test('a regenerated types file is never reported as a changed signature to its importers', () => {
    const A = newTask('regenerate types');
    const B = newTask('use the row');
    try {
      rewrite(A.wt, 'src/db/database.types.ts', 'a: string', 'a: string; b: number');
      rewrite(B.wt, 'src/db/useDb.ts', 'export const row', 'export const other = 1;\nexport const row');
      // 31 modules in this repo import the generated Database type; each would otherwise be MED.
      expect(overlap(A.id, B.id).filter((i) => i.file === 'src/db/database.types.ts')).toEqual([]);
    } finally {
      finish(A.id, B.id);
    }
  });

  test('a parked finding that names a function flags a task that calls it, both ways round', () => {
    const B = newTask('edit the caller of price');
    const finding = work(['park', '--title', 'price ignores tax', '--files', 'src/lib.ts'], mainCheckout);
    try {
      rewrite(B.wt, 'src/use.ts', 'export const two', 'export const extra = 0;\nexport const two');
      for (const items of [overlap(B.id, finding), overlap(finding, B.id)]) {
        const hit = items.find((i) => i.kind === 'calls what it names');
        expect(hit).toMatchObject({ severity: 'MED', file: 'src/lib.ts', symbol: 'price' });
        expect(hit?.sizes.callSites).toBe(2);
      }
    } finally {
      finish(B.id);
      work(['drop', finding], mainCheckout);
    }
  });

  test('a file one task deletes and another edits is HIGH, however the functions compare', () => {
    const A = newTask('delete lib');
    const B = newTask('edit greet');
    try {
      git(['rm', '-q', 'src/lib.ts'], A.wt);
      commit(A.wt, 'A deletes lib');
      rewrite(B.wt, 'src/lib.ts', "return 'hello';", "return 'hiya';");
      const item = overlap(A.id, B.id).find((i) => i.file === 'src/lib.ts' && i.severity === 'HIGH');
      expect(item).toMatchObject({ kind: 'deleted file' });
      expect(item?.detail).toContain(`${A.id} deletes this file`);
      expect(item?.detail).toContain('`greet`');
    } finally {
      finish(A.id, B.id);
    }
  });

  test('a closed task whose checkout and branch are gone is not mistaken for a parked finding', () => {
    const A = newTask('change greet for the closed case');
    const n = ++counter;
    const goneWt = join(tmp, `wt-${n}`);
    git(['worktree', 'add', '--no-track', goneWt, '-b', `branch-${n}`, 'origin/main'], mainCheckout);
    const gone = work(['park', '--title', 'greet was wrong once', '--kind', 'task', '--files', 'src/lib.ts'], mainCheckout);
    work(['claim', gone], goneWt);
    try {
      rewrite(A.wt, 'src/lib.ts', "return 'hello';", "return 'hullo';");
      work(['done', gone], mainCheckout);
      git(['worktree', 'remove', '--force', goneWt], mainCheckout);
      git(['branch', '-D', `branch-${n}`], mainCheckout);
      // It names lib.ts and its title mentions `greet`. Read as PARKED, that is a HIGH it never
      // earned; read as what it is — a finished task with only a file list left — it is LOW.
      const items = overlap(A.id, gone);
      expect(items.filter((i) => i.severity === 'HIGH')).toEqual([]);
      expect(items.map((i) => i.kind)).toEqual(['same file only']);
    } finally {
      finish(A.id);
    }
  });

  test('a task claimed on a detached HEAD never borrows the main checkout\'s commits', () => {
    const wt = join(tmp, `wt-${++counter}`);
    git(['worktree', 'add', '--detach', wt, 'origin/main'], mainCheckout);
    const id = work(['park', '--title', 'detached claim', '--kind', 'task'], mainCheckout);
    work(['claim', id], wt);
    const B = newTask('edit use for the detached case');
    try {
      work(['done', id], mainCheckout);
      git(['worktree', 'remove', '--force', wt], mainCheckout);
      // A local commit in the MAIN checkout. Resolving the recorded branch `HEAD` there would make
      // it this closed task's footprint.
      rewrite(mainCheckout, 'src/use.ts', 'export const two', 'export const local = 1;\nexport const two');
      // `-a`, never `add -A`: the record's own task files are untracked in this checkout, and the
      // reset below would delete them if they had been swept into this commit.
      git(['commit', '-q', '-am', 'local only'], mainCheckout);
      rewrite(B.wt, 'src/use.ts', 'export const two', 'export const extra = 0;\nexport const two');
      expect(overlap(id, B.id)).toEqual([]);
    } finally {
      git(['reset', '-q', '--hard', 'origin/main'], mainCheckout);
      finish(B.id);
    }
  });

  test('supabase/config.toml, rewritten in every stacked worktree, is never an overlap', () => {
    const A = newTask('stack one');
    const B = newTask('stack two');
    try {
      rewrite(A.wt, 'supabase/config.toml', '"fixture"', '"fixture-a"');
      rewrite(B.wt, 'supabase/config.toml', '"fixture"', '"fixture-b"');
      expect(overlap(A.id, B.id)).toEqual([]);
    } finally {
      finish(A.id, B.id);
    }
  });

  test('a renaming re-export and a local export list are both followed', () => {
    const A = newTask('widen price and hidden');
    const B = newTask('edit use3 and use4');
    try {
      rewrite(A.wt, 'src/lib.ts', 'price(amount: number)', 'price(amount: number, tax = 0)');
      rewrite(A.wt, 'src/local.ts', 'hidden(n: number)', 'hidden(n: number, m = 0)');
      rewrite(B.wt, 'src/use3.ts', 'export const four', 'export const x3 = 3;\nexport const four');
      rewrite(B.wt, 'src/use4.ts', 'export const five', 'export const x4 = 4;\nexport const five');
      const items = overlap(A.id, B.id).filter((i) => i.kind === 'changed signature');
      // `cost` in use3.ts is `price` renamed on the way through barrel2.ts.
      expect(items.find((i) => i.symbol === 'price')).toMatchObject({ file: 'src/lib.ts', sizes: { callSites: 1 } });
      expect(items.find((i) => i.symbol === 'hidden')).toMatchObject({ file: 'src/local.ts' });
    } finally {
      finish(A.id, B.id);
    }
  });

  test('a file moved away by one task is a deletion to a task still editing it', () => {
    const A = newTask('move lib');
    const B = newTask('edit greet where it was');
    try {
      git(['mv', 'src/lib.ts', 'src/lib2.ts'], A.wt);
      commit(A.wt, 'A moves lib');
      rewrite(B.wt, 'src/lib.ts', "return 'hello';", "return 'still here';");
      // With rename detection on, the move is reported as src/lib2.ts alone and src/lib.ts —
      // the file B is editing — silently drops out of A's footprint.
      expect(overlap(A.id, B.id).find((i) => i.file === 'src/lib.ts')).toMatchObject({ severity: 'HIGH', kind: 'deleted file' });
    } finally {
      finish(A.id, B.id);
    }
  });

  test('a path git would escape is matched exactly, down to the function', () => {
    const A = newTask('tip in whole units');
    const B = newTask('tip in cents');
    try {
      // One side committed and one not, so both `git diff` and `git status` must spell it the same.
      rewrite(A.wt, 'src/café x.ts', 'return n;', 'return Math.round(n);');
      commit(A.wt, 'A');
      rewrite(B.wt, 'src/café x.ts', 'return n;', 'return n * 100;');
      expect(overlap(A.id, B.id)).toEqual([
        expect.objectContaining({ severity: 'HIGH', kind: 'same function', file: 'src/café x.ts', symbol: 'tip' }),
      ]);
    } finally {
      finish(A.id, B.id);
    }
  });

  test('a file that cannot be read as text is skipped, never a stack trace', () => {
    const A = newTask('odd symlink');
    const B = newTask('edit use beside the symlink');
    try {
      // A `.ts` name that is really a directory: readFileSync would throw EISDIR.
      symlinkSync('.', join(A.wt, 'src', 'link.ts'));
      rewrite(B.wt, 'src/use.ts', 'export const two', 'export const extra = 0;\nexport const two');
      expect(overlap(A.id, B.id)).toEqual([]);
    } finally {
      finish(A.id, B.id);
    }
  });

  test('a change to any overload of a function is a signature change', () => {
    const A = newTask('narrow the first fmt overload');
    const B = newTask('edit the fmt caller');
    try {
      rewrite(A.wt, 'src/over.ts', 'export function fmt(n: number): string;', 'export function fmt(n: bigint): string;');
      rewrite(B.wt, 'src/useOver.ts', 'export const s', 'export const t = 0;\nexport const s');
      // Only the FIRST overload changed. Keeping just the last declaration would see nothing.
      expect(overlap(A.id, B.id).find((i) => i.kind === 'changed signature')).toMatchObject({ file: 'src/over.ts', symbol: 'fmt' });
    } finally {
      finish(A.id, B.id);
    }
  });

  test('a name imported and passed back out through an export list is followed to its declarer', () => {
    const A = newTask('greet takes a name');
    const B = newTask('edit usePass');
    try {
      rewrite(A.wt, 'src/lib.ts', 'export function greet(): string {', "export function greet(name = ''): string {");
      rewrite(B.wt, 'src/usePass.ts', 'export const hi', 'export const bye = 0;\nexport const hi');
      const hit = overlap(A.id, B.id).find((i) => i.kind === 'changed signature');
      expect(hit).toMatchObject({ file: 'src/lib.ts', symbol: 'greet' });
      expect(hit?.detail).toContain('src/usePass.ts');
    } finally {
      finish(A.id, B.id);
    }
  });

  // Last, because it moves origin/main (and puts it back).
  test('after a task merges main, what main changed is no longer counted as the task\'s own work', () => {
    const original = git(['rev-parse', 'refs/remotes/origin/main'], mainCheckout);
    const B = newTask('edit use, then take main');
    const mover = join(tmp, `wt-${++counter}`);
    try {
      rewrite(B.wt, 'src/use.ts', 'export const two', 'export const extra = 0;\nexport const two');
      commit(B.wt, 'B');
      git(['worktree', 'add', '--detach', mover, 'origin/main'], mainCheckout);
      rewrite(mover, 'src/lib.ts', "return 'hello';", "return 'main moved';");
      commit(mover, 'main moves');
      git(['update-ref', 'refs/remotes/origin/main', git(['rev-parse', 'HEAD'], mover)], mainCheckout);
      git(['merge', '-q', '--no-edit', 'origin/main'], B.wt);

      const C = newTask('change greet after main moved');
      try {
        rewrite(C.wt, 'src/lib.ts', "return 'main moved';", "return 'again';");
        // With the claim-time base, B's footprint would include lib.ts — main's change, merged in.
        expect(overlap(B.id, C.id)).toEqual([]);
      } finally {
        finish(C.id);
      }
    } finally {
      git(['update-ref', 'refs/remotes/origin/main', original], mainCheckout);
      finish(B.id);
    }
  });
});
