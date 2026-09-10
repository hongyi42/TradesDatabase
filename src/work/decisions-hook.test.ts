// Tests for .claude/hooks/decisions-for-file.mjs — the pre-edit hook — and for the `touch`
// verb that feeds it.
//
// The defect these exist to pin: the hook resolved its repository root from
// `${CLAUDE_PROJECT_DIR}`, which Claude Code deliberately leaves at the directory a session
// launched from even after that session enters a worktree. Every path then came out relative
// to the wrong root, matched no index key, and the hook fell silent — in exactly the parallel
// worktree sessions it was built to protect. A test that only ever runs in the main checkout
// cannot see that, so every case here is driven through a real linked worktree.
//
// `TMPDIR` is redirected per run because the hook's once-per-file-per-session marker lives
// under the system temp dir; without it, markers from an earlier run silence later ones.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const HOOK = join(process.cwd(), '.claude', 'hooks', 'decisions-for-file.mjs');
const CLI = join(process.cwd(), 'scripts', 'work.mjs');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Hook Test',
  GIT_AUTHOR_EMAIL: 'hook@test.invalid',
  GIT_COMMITTER_NAME: 'Hook Test',
  GIT_COMMITTER_EMAIL: 'hook@test.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

const DECISION = 'the decision under test';

let tmp: string;
let home: string;
let markers: string;
let mainCheckout: string;
let wtA: string;
let wtB: string;
let sessionA: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

function work(args: string[], cwd: string): string {
  return execFileSync('node', [CLI, ...args], {
    cwd, encoding: 'utf8', input: '', env: { ...process.env, ...GIT_ENV, HOME: home },
  }).trim();
}

/** Run the hook exactly as Claude Code does: payload on stdin, JSON (or nothing) on stdout. */
function hook(payload: Record<string, unknown>, extraEnv: Record<string, string> = {}): string {
  return execFileSync('node', [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV, HOME: home, TMPDIR: markers, ...extraEnv },
  });
}

/** The context string the hook injected, or '' when it stayed silent. */
function context(out: string): string {
  if (!out.trim()) return '';
  const parsed = JSON.parse(out);
  // The documented shape. The top-level `additionalContext` this hook used before 2026-09-09
  // is undocumented, so assert the nesting rather than accepting either.
  expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  return parsed.hookSpecificOutput.additionalContext as string;
}

const edit = (file: string, cwd: string, session: string) => ({
  session_id: session,
  cwd,
  hook_event_name: 'PreToolUse',
  tool_name: 'Edit',
  tool_input: { file_path: join(cwd, file) },
});

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'hook-record-')));
  home = join(tmp, 'home');
  markers = join(tmp, 'markers');
  mkdirSync(home, { recursive: true });
  mkdirSync(markers, { recursive: true });

  mainCheckout = join(tmp, 'repo');
  mkdirSync(join(mainCheckout, 'src'), { recursive: true });
  mkdirSync(join(mainCheckout, 'thoughts'), { recursive: true });
  git(['init', '-b', 'main'], mainCheckout);
  writeFileSync(join(mainCheckout, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(mainCheckout, 'thoughts', 'by-file.json'), JSON.stringify({
    'src/a.ts': [{
      date: '2026-01-01', what: DECISION, where: 'thoughts/shared/plans/x.md',
      kind: 'doc', drift: 0, dead: 0, durable: '## Decisions', durableFirm: true,
    }],
  }));
  git(['add', '.'], mainCheckout);
  git(['commit', '-m', 'first'], mainCheckout);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], mainCheckout);

  // Added AFTER the commit on purpose: a worktree only carries files that were committed, and
  // the index has to be present in the worktree for case (b) to mean anything.
  wtA = join(tmp, 'wt-a');
  wtB = join(tmp, 'wt-b');
  git(['worktree', 'add', wtA, '-b', 'feature-a'], mainCheckout);
  git(['worktree', 'add', wtB, '-b', 'feature-b'], mainCheckout);
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('the pre-edit hook', () => {
  test('(a) surfaces the committed decision for a file in the main checkout', () => {
    sessionA = randomUUID();
    const out = context(hook(edit('src/a.ts', mainCheckout, sessionA)));
    expect(out).toContain('Decisions on record for src/a.ts');
    expect(out).toContain(DECISION);
  });

  test('(e) says it once per file per session, then stays quiet', () => {
    // Self-contained: `alreadyTold` treats a missing session_id as "never told", so a test that
    // inherited an id from another test would pass for the wrong reason when run alone.
    const session = randomUUID();
    expect(context(hook(edit('src/a.ts', mainCheckout, session)))).toContain(DECISION);
    // Same session, same file: the second edit must add nothing, or every edit to a hot file
    // re-spends context on something the session was already told.
    expect(hook(edit('src/a.ts', mainCheckout, session)).trim()).toBe('');
  });

  test('(b) still surfaces it from inside a WORKTREE, with CLAUDE_PROJECT_DIR left behind', () => {
    // The regression. CLAUDE_PROJECT_DIR points at the launch directory, as Claude Code
    // documents; before the fix this produced an empty result here.
    const out = context(hook(
      edit('src/a.ts', wtA, randomUUID()),
      { CLAUDE_PROJECT_DIR: mainCheckout },
    ));
    expect(out).toContain(DECISION);
  });

  test('(c) names an open finding parked against this file', () => {
    const id = work(['park', '--title', 'the parked finding', '--files', 'src/a.ts'], mainCheckout);
    const out = context(hook(edit('src/a.ts', wtA, randomUUID()), { CLAUDE_PROJECT_DIR: mainCheckout }));
    expect(out).toContain('In flight right now on src/a.ts');
    expect(out).toContain(`OPEN FINDING ${id}`);
    expect(out).toContain('the parked finding');
    work(['drop', id], mainCheckout);
  });

  test('(d) names a sibling worktree whose active task has touched this file', () => {
    const id = work(['park', '--title', 'the sibling task', '--kind', 'task', '--files', 'src/a.ts'], mainCheckout);
    work(['claim', id], wtB);

    const out = context(hook(edit('src/a.ts', wtA, randomUUID()), { CLAUDE_PROJECT_DIR: mainCheckout }));
    expect(out).toContain('SIBLING wt-b on feature-b');
    expect(out).toContain(`active on ${id}`);

    // ...and the session that OWNS the task is not told about its own work.
    const own = context(hook(edit('src/a.ts', wtB, randomUUID()), { CLAUDE_PROJECT_DIR: mainCheckout }));
    expect(own).not.toContain('SIBLING');
    work(['done', id], mainCheckout);
  });

  test('a worktree with no decision index still gets the live record', () => {
    // The index is committed, so a worktree branched before it existed simply has no copy.
    // Requiring by-file.json before saying anything is what made this hook useless in the
    // checkouts that most need it, so the read must stay best-effort.
    const index = join(wtA, 'thoughts', 'by-file.json');
    const saved = readFileSync(index, 'utf8');
    const id = work(['park', '--title', 'visible without an index', '--files', 'src/a.ts'], mainCheckout);
    try {
      rmSync(index);
      const out = context(hook(edit('src/a.ts', wtA, randomUUID()), { CLAUDE_PROJECT_DIR: mainCheckout }));
      expect(out).toContain('In flight right now on src/a.ts');
      expect(out).toContain('visible without an index');
      expect(out).not.toContain('Decisions on record'); // nothing to read there, and that is fine
    } finally {
      writeFileSync(index, saved);
      work(['drop', id], mainCheckout);
    }
  });

  test('a file with neither a decision nor a live task produces no output at all', () => {
    writeFileSync(join(wtA, 'src', 'quiet.ts'), 'export const q = 1;\n');
    expect(hook(edit('src/quiet.ts', wtA, randomUUID())).trim()).toBe('');
  });

  test('a file in a directory that does not exist yet is still resolved', () => {
    // A Write creating src/deep/new/thing.ts names directories git cannot be asked about.
    // Before walking up to an existing ancestor, this fell back to the launch directory and
    // skipped the live record entirely — for exactly the edits that add new modules.
    const id = work(['park', '--title', 'about a new module', '--files', 'src/deep/new/thing.ts'], mainCheckout);
    try {
      const out = context(hook(
        edit(join('src', 'deep', 'new', 'thing.ts'), wtA, randomUUID()),
        { CLAUDE_PROJECT_DIR: mainCheckout },
      ));
      expect(out).toContain('about a new module');
    } finally {
      work(['drop', id], mainCheckout);
    }
  });

  test('a task active in a worktree that no longer exists is not announced as live', () => {
    const gone = join(tmp, 'wt-deleted');
    git(['worktree', 'add', gone, '-b', 'feature-gone'], mainCheckout);
    const id = work(['park', '--title', 'orphaned task', '--kind', 'task', '--files', 'src/a.ts'], mainCheckout);
    work(['claim', id], gone);
    rmSync(gone, { recursive: true, force: true });
    expect(existsSync(gone)).toBe(false);

    try {
      // Saying "another session is editing this right now" about a pruned checkout is worse
      // than silence: it is a confident claim that cannot be true.
      const out = hook(edit('src/a.ts', wtA, randomUUID()), { CLAUDE_PROJECT_DIR: mainCheckout });
      expect(context(out)).not.toContain('SIBLING');
    } finally {
      work(['drop', id], mainCheckout);
    }
  });

  test('a malformed payload never costs the user an edit', () => {
    const out = execFileSync('node', [HOOK], {
      input: 'not json at all', encoding: 'utf8',
      env: { ...process.env, HOME: home, TMPDIR: markers },
    });
    expect(out.trim()).toBe('');
  });
});

describe('work.mjs touch — the file list writes itself', () => {
  test('records an edited file on the worktree\'s active task, once', () => {
    const id = work(['park', '--title', 'touch target', '--kind', 'task'], mainCheckout);
    work(['claim', id], wtA);

    const payload = JSON.stringify({
      cwd: wtA,
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: join(wtA, 'src', 'a.ts') },
    });
    const touch = () => execFileSync('node', [CLI, 'touch'], {
      input: payload, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, HOME: home },
    });

    expect(touch().trim()).toBe(''); // a PostToolUse hook must print nothing
    const after = readFileSync(join(mainCheckout, '.claude', 'work', 'tasks', `${id}.md`), 'utf8');
    expect(after).toContain('files: src/a.ts');

    touch(); // idempotent: the same file must not accumulate
    const twice = readFileSync(join(mainCheckout, '.claude', 'work', 'tasks', `${id}.md`), 'utf8');
    expect(twice.match(/src\/a\.ts/g)).toHaveLength(1);
    work(['done', id], mainCheckout);
  });

  test('simultaneous edits all get recorded, not just the last one', async () => {
    // One assistant turn routinely issues several edits at once, and each spawns its own copy
    // of this process. An unguarded read-modify-write kept only the last rename: measured, a
    // batch of eight recorded one file. The list would then be emptiest in the busiest
    // sessions — the opposite of what the sibling warning needs.
    const id = work(['park', '--title', 'concurrent touches', '--kind', 'task'], mainCheckout);
    work(['claim', id], wtA);
    const N = 8;
    const paths = Array.from({ length: N }, (_, i) => join('src', `c${i}.ts`));

    await Promise.all(paths.map((p) => new Promise<void>((res, rej) => {
      const proc = spawn('node', [CLI, 'touch'], {
        cwd: wtA, stdio: ['pipe', 'ignore', 'ignore'],
        env: { ...process.env, ...GIT_ENV, HOME: home },
      });
      proc.on('close', (code) => (code === 0 ? res() : rej(new Error(`exit ${code}`))));
      proc.stdin.write(JSON.stringify({ cwd: wtA, tool_input: { file_path: join(wtA, p) } }));
      proc.stdin.end();
    })));

    const text = readFileSync(join(mainCheckout, '.claude', 'work', 'tasks', `${id}.md`), 'utf8');
    for (const p of paths) expect(text).toContain(p);
    work(['done', id], mainCheckout);
  });

  test('with no active task in that worktree it does nothing, silently', () => {
    const payload = JSON.stringify({
      cwd: wtA,
      tool_input: { file_path: join(wtA, 'src', 'a.ts') },
    });
    const out = execFileSync('node', [CLI, 'touch'], {
      input: payload, encoding: 'utf8', env: { ...process.env, ...GIT_ENV, HOME: home },
    });
    expect(out.trim()).toBe('');
  });
});
