// End-to-end tests for scripts/work.mjs, the work record's CLI.
//
// Why spawn the real script against a real git repository instead of unit-testing functions:
// every hard part of this tool IS the git interaction — which directory counts as the main
// checkout, whether a worktree's toplevel compares equal to the cwd it was claimed from, what
// `--path-format=absolute` answers where. A mocked git would assert our assumptions back at us.
//
// The temp repo is realpath'd on purpose: macOS hands out `/var/folders/...` symlinks and git
// always answers with `/private/var/folders/...`, so a raw temp path would never compare equal
// to a stored worktree and every lookup here would silently find nothing.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'scripts', 'work.mjs');

// Isolated identity and config: without GIT_CONFIG_GLOBAL the developer's own git config leaks
// in, and without the author vars `git commit` fails outright under an overridden HOME.
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Work Record Test',
  GIT_AUTHOR_EMAIL: 'work-record@test.invalid',
  GIT_COMMITTER_NAME: 'Work Record Test',
  GIT_COMMITTER_EMAIL: 'work-record@test.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

let tmp: string;
let mainCheckout: string;
let worktree: string;
/** A symlink to `worktree` — the non-canonical shape a hook's `cwd` can arrive in. */
let worktreeLink: string;
let home: string;
/** The task the middle tests claim and hand along; shared so each can assert on the same one. */
let claimableId: string;

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

function work(args: string[], cwd: string, input = ''): string {
  return execFileSync('node', [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    input,
    env: { ...process.env, ...GIT_ENV, HOME: home },
  }).trim();
}

/** Frontmatter of a task file, read straight off disk — the record's real storage format. */
function taskFile(id: string): Record<string, string> {
  const text = readFileSync(join(mainCheckout, '.claude', 'work', 'tasks', `${id}.md`), 'utf8');
  const fm: Record<string, string> = {};
  for (const line of text.split('\n').slice(1)) {
    if (line.trim() === '---') break;
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(line);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'work-record-')));
  home = join(tmp, 'home');
  mkdirSync(home, { recursive: true });

  mainCheckout = join(tmp, 'repo');
  mkdirSync(mainCheckout, { recursive: true });
  git(['init', '-b', 'main'], mainCheckout);
  mkdirSync(join(mainCheckout, 'src'), { recursive: true });
  writeFileSync(join(mainCheckout, 'src', 'a.ts'), 'export const a = 1;\n');
  git(['add', '.'], mainCheckout);
  git(['commit', '-m', 'first'], mainCheckout);
  // No remote in a temp repo, so stand in for one: this is the ref the CLI measures against.
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], mainCheckout);

  worktree = join(tmp, 'wt-feature');
  git(['worktree', 'add', worktree, '-b', 'feature'], mainCheckout);
  writeFileSync(join(worktree, 'src', 'b.ts'), 'export const b = 2;\n');
  git(['add', '.'], worktree);
  git(['commit', '-m', 'ahead by one'], worktree);

  // A cwd that is NOT the canonical path. process.cwd() is always already a realpath, so
  // without a symlink no test here can tell whether the tool canonicalizes at all.
  worktreeLink = join(tmp, 'wt-link');
  symlinkSync(worktree, worktreeLink);
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('work.mjs — the shared work record', () => {
  test('park writes a parseable task with the expected fields and a dated id', () => {
    const id = work(['park', '--title', 'The colon: a test finding', '--files', 'src/a.ts,src/b.ts',
      '--tags', 'hooks,record', '--body', '-'], mainCheckout, 'Two lines\nof notes.\n');

    expect(id).toMatch(/^\d{8}-the-colon-a-test-finding$/);
    const fm = taskFile(id);
    expect(fm.kind).toBe('finding');
    // A title containing a colon must survive the frontmatter round-trip intact.
    expect(fm.title).toBe('The colon: a test finding');
    expect(fm.status).toBe('open');
    expect(fm.files).toBe('src/a.ts, src/b.ts');
    expect(fm.tags).toBe('hooks, record');
    expect(fm.worktree).toBe('');
    expect(fm.created).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const body = readFileSync(join(mainCheckout, '.claude', 'work', 'tasks', `${id}.md`), 'utf8');
    expect(body).toContain('## Notes\n\nTwo lines\nof notes.');
    expect(body).toContain('## Decisions');
  });

  test('the record lives in the MAIN checkout and a sibling worktree writes to the same one', () => {
    const id = work(['park', '--title', 'parked from the worktree'], worktree);
    // The proof that siblings share one record: parked over there, on disk over here, no commit.
    expect(existsSync(join(mainCheckout, '.claude', 'work', 'tasks', `${id}.md`))).toBe(true);
    expect(existsSync(join(worktree, '.claude', 'work'))).toBe(false);
  });

  test('claim binds a task to the canonical worktree, its branch and its base commit', () => {
    claimableId = work(['park', '--title', 'claimable work', '--kind', 'task'], mainCheckout);
    const out = work(['claim', claimableId], worktree);
    expect(out).toContain(claimableId);

    const fm = taskFile(claimableId);
    expect(fm.status).toBe('active');
    // Canonical, i.e. what `git rev-parse --show-toplevel` answers — not the raw cwd.
    expect(fm.worktree).toBe(realpathSync(worktree));
    expect(fm.branch).toBe('feature');
    expect(fm.base).toBe(git(['rev-parse', 'HEAD'], mainCheckout));
  });

  test('a second claim is refused, and --force RELEASES the incumbent rather than doubling up', () => {
    const second = work(['park', '--title', 'the interloper'], mainCheckout);
    expect(() => work(['claim', second], worktree)).toThrow(/already active/);
    // The escape hatch still exists, because refusing forever would be its own trap.
    expect(work(['claim', second, '--force'], worktree)).toContain(second);

    // One active task per worktree is the rule the whole tool rests on. If forcing merely
    // skipped the refusal, both files would claim this checkout and "the active task" would
    // be whichever was written last — so assert the incumbent was actually let go.
    const incumbent = taskFile(claimableId);
    expect(incumbent.status).toBe('open');
    expect(incumbent.worktree).toBe('');

    work(['drop', second], mainCheckout);
    work(['claim', claimableId], worktree); // hand it back to the tests below
  });

  test('parks racing each other never overwrite one another', async () => {
    // The premise of the whole record is concurrent sessions, so the id allocation must be the
    // filesystem's decision. With a check-then-write it was not: five simultaneous parks
    // returned five ids and left two files, losing three findings that each reported success.
    const N = 5;
    const ids = await Promise.all(Array.from({ length: N }, () => new Promise<string>((res, rej) => {
      const p = spawn('node', [CLI, 'park', '--title', 'race condition'], {
        cwd: mainCheckout,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...GIT_ENV, HOME: home },
      });
      let buf = '';
      p.stdout.on('data', (d) => { buf += d; });
      p.on('close', (code) => (code === 0 ? res(buf.trim()) : rej(new Error(`exit ${code}`))));
    })));

    expect(new Set(ids).size).toBe(N); // every park got a distinct id...
    for (const id of ids) expect(taskFile(id).title).toBe('race condition'); // ...and a real file
    for (const id of ids) work(['drop', id], mainCheckout);
  });

  test('a non-canonical cwd (a symlink) resolves to the same worktree', () => {
    // This is the shape a hook's `cwd` can arrive in. Without canonicalization the lookup
    // silently finds nothing, which reads exactly like "no active task".
    const viaLink = work(['packet', '--cwd', worktreeLink], mainCheckout);
    expect(viaLink).toContain('claimable work');
    expect(viaLink).toContain(`worktree: ${realpathSync(worktree)}`);
  });

  test('packet answers for the worktree that holds the task, and stays silent elsewhere', () => {
    const fromWorktree = work(['packet', '--cwd', worktree], mainCheckout);
    expect(fromWorktree).toContain('status: active');
    expect(fromWorktree).toContain('claimable work');

    // The main checkout holds no active task, and "nothing here" is a normal state: empty, exit 0.
    expect(work(['packet', '--cwd', mainCheckout], mainCheckout)).toBe('');
  });

  test('packet --json returns the frontmatter as data', () => {
    const parsed = JSON.parse(work(['packet', '--cwd', worktree, '--json'], mainCheckout));
    expect(parsed.status).toBe('active');
    expect(parsed.branch).toBe('feature');
    expect(parsed.body).toContain('## Notes');
  });

  test('board lists every worktree with its distance, and names the active task', () => {
    const out = work(['board'], mainCheckout);
    const lines = out.split('\n');
    expect(out).toContain('WORKTREES');
    // Assert on ROWS, not on the whole output: the header already prints the record path, which
    // contains "repo", so `toContain('repo')` would pass with the main checkout's row missing.
    expect(lines.some((l) => l.startsWith('repo '))).toBe(true);
    expect(lines.some((l) => l.startsWith('wt-feature'))).toBe(true);
    // The worktree committed once on top of origin/main: behind 0, ahead 1. The row must also
    // carry the ACTIVE TASK ID — that column is the canonical-path join, and asserting only on
    // the title would pass against the TASKS table below while the join was broken.
    const row = out.split('\n').find((l) => l.startsWith('wt-feature')) ?? '';
    expect(row).toMatch(/wt-feature\s+feature\s+0\/1/);
    expect(row).toContain(claimableId);
    expect(out).toContain('TASKS');
    expect(out).toMatch(/claimable work/);
  });

  test('done releases the worktree so the next task can claim it', () => {
    const active = JSON.parse(work(['packet', '--cwd', worktree, '--json'], mainCheckout));
    // Pin the identity: without this the test would pass having operated on some other task.
    expect(active.id).toBe(claimableId);
    work(['done', active.id], mainCheckout);

    const fm = taskFile(active.id);
    expect(fm.status).toBe('done');
    expect(fm.worktree).toBe('');
    expect(work(['packet', '--cwd', worktree], mainCheckout)).toBe('');
  });

  test('an unknown task id fails loudly rather than silently doing nothing', () => {
    expect(() => work(['claim', '19990101-nope'], worktree)).toThrow(/no task/);
  });

  test('a list flag given without a value degrades to empty, never a stack trace', () => {
    // `--files` with an empty shell expansion parses to boolean true. Reading that as "no
    // files" is the forgiving answer; the failure this guards against is `true.split(',')`
    // reaching the user as a raw TypeError with the task half-created.
    const id = work(['park', '--title', 'no value', '--files'], mainCheckout);
    expect(id).toMatch(/^\d{8}-no-value$/);
    expect(taskFile(id).files).toBe('');
    work(['drop', id], mainCheckout);
  });

  test('a hook payload arriving late on stdin is still read', async () => {
    // The regression this pins: reading `process.stdin.isTTY` instead of `isatty(0)` puts the
    // pipe into non-blocking mode, so a payload written even a moment after spawn is dropped
    // and the verb silently answers for its own cwd instead. Every other packet test passes
    // --cwd, which short-circuits stdin entirely and would never catch it.
    //
    // `--for-session` because that is the only `packet` form a hook invokes, and therefore the
    // only one that waits for a payload at all. The bare form must not — see the test below.
    const id = work(['park', '--title', 'late payload probe', '--kind', 'task'], mainCheckout);
    work(['claim', id, '--force'], worktree);

    const out = await new Promise<string>((res) => {
      const p = spawn('node', [CLI, 'packet', '--for-session'], {
        // Deliberately a NON-REPOSITORY directory: only the payload names a worktree. This
        // also pins that the main checkout is resolved from the payload's cwd rather than
        // from process.cwd(), which would otherwise exit early and answer nothing.
        cwd: home,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...process.env, ...GIT_ENV, HOME: home },
      });
      let buf = '';
      p.stdout.on('data', (d) => { buf += d; });
      p.on('close', () => res(buf));
      setTimeout(() => { p.stdin.write(JSON.stringify({ cwd: worktree })); p.stdin.end(); }, 250);
    });

    try {
      expect(out).toContain('late payload probe');
    } finally {
      // In a finally so a failure here reports once, rather than cascading into every test
      // downstream that expects this worktree to be holding `claimableId`.
      work(['done', id], mainCheckout);
      work(['claim', claimableId, '--force'], worktree);
    }
  });

  test('bare packet never waits on a pipe nobody is going to close', async () => {
    // Measured while building Phase 4: `node scripts/work.mjs packet` inherited a pipe that was
    // never closed and hung forever, because stdin was read for every hook verb. Only
    // `packet --for-session` comes from a hook, and a hook always closes its pipe. The bare form
    // is the one a person runs by hand, and an agent's shell rarely gives it a tty — so it must
    // answer from its own cwd and never block.
    const id = work(['park', '--title', 'no hang probe', '--kind', 'task'], mainCheckout);
    work(['claim', id, '--force'], worktree);
    try {
      const result = await new Promise<{ done: boolean; out: string }>((res) => {
        const p = spawn('node', [CLI, 'packet'], {
          cwd: worktree,
          // stdin is a pipe that is deliberately never written to and never closed.
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { ...process.env, ...GIT_ENV, HOME: home },
        });
        let buf = '';
        p.stdout.on('data', (d) => { buf += d; });
        const timer = setTimeout(() => { p.kill('SIGKILL'); res({ done: false, out: buf }); }, 5000);
        p.on('close', () => { clearTimeout(timer); res({ done: true, out: buf }); });
      });
      expect(result.done).toBe(true);
      expect(result.out).toContain('no hang probe');
    } finally {
      work(['done', id], mainCheckout);
      work(['claim', claimableId, '--force'], worktree);
    }
  });

  test('base falls back to a real commit when there is no origin/main', () => {
    // A local-only clone has no remote at all, and a fork's remote may be named anything. base is
    // the fixed point an overlap check measures "changed since" from, so leaving it empty makes
    // that question unanswerable rather than merely approximate.
    const solo = realpathSync(mkdtempSync(join(tmpdir(), 'work-record-solo-')));
    try {
      // Branch deliberately named neither main nor master, and no remote configured.
      git(['init', '-b', 'trunk'], solo);
      writeFileSync(join(solo, 'a.txt'), 'x\n');
      git(['add', '.'], solo);
      git(['commit', '-m', 'first'], solo);

      const id = work(['park', '--title', 'solo repo task'], solo);
      work(['claim', id], solo);
      const text = readFileSync(join(solo, '.claude', 'work', 'tasks', `${id}.md`), 'utf8');
      const base = /^base: (.*)$/m.exec(text)?.[1] ?? '';
      expect(base).toBe(git(['rev-parse', 'HEAD'], solo));
      expect(base).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      rmSync(solo, { recursive: true, force: true });
    }
  });

  test('claiming a task already active in another worktree is refused', () => {
    // The mirror of the --force case: taking a task out from under a sibling session would
    // strip its packet and board column with no signal on either side.
    expect(() => work(['claim', claimableId], mainCheckout)).toThrow(/already active in/);
    expect(taskFile(claimableId).worktree).toBe(realpathSync(worktree));
  });

  test('packet --for-session carries the task, its decisions and its newest handoff', () => {
    const id = work(['park', '--title', 'session packet target', '--kind', 'task', '--files', 'src/a.ts'], mainCheckout);
    work(['claim', id, '--force'], worktree);
    work(['handoff', '--body', '-'], worktree, 'first pass, superseded');
    work(['handoff', '--body', '-'], worktree, 'the newest handoff line');

    const raw = work(['packet', '--for-session', '--cwd', worktree], mainCheckout);
    const parsed = JSON.parse(raw);
    expect(parsed.hookSpecificOutput.hookEventName).toBe('SessionStart');
    const ctx = parsed.hookSpecificOutput.additionalContext as string;

    expect(ctx).toContain('session packet target');
    expect(ctx).toContain('src/a.ts');
    expect(ctx).toContain('the newest handoff line');
    // Only the newest: an accumulating pile of handoffs would blow the output cap.
    expect(ctx).not.toContain('first pass, superseded');
    // Hook output is capped at 10,000 characters; past that Claude Code files it away instead.
    expect(raw.length).toBeLessThan(10000);

    work(['done', id], mainCheckout);
    work(['claim', claimableId, '--force'], worktree);
  });

  test('packet --for-session points a worktree at the main checkout\'s session memory', () => {
    const memoryDir = join(home, '.claude', 'projects',
      mainCheckout.replace(/[^A-Za-z0-9]/g, '-'), 'memory');
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, 'MEMORY.md'),
      '# Memory Index\n- [A remembered thing](a.md) — hook\n- [Another one](b.md) — hook\n');

    const fromWorktree = JSON.parse(work(['packet', '--for-session', '--cwd', worktree], mainCheckout))
      .hookSpecificOutput.additionalContext as string;
    // A worktree gets its own (empty) project directory, so it starts with none of this.
    expect(fromWorktree).toContain('Session memory');
    expect(fromWorktree).toContain(join(memoryDir, 'MEMORY.md'));
    expect(fromWorktree).toContain('A remembered thing');

    // The main checkout already has it loaded; repeating it there would be pure waste.
    const fromMain = work(['packet', '--for-session', '--cwd', mainCheckout], mainCheckout);
    expect(fromMain === '' || !fromMain.includes('Session memory')).toBe(true);
  });

  test('snapshot records the mechanical state and prints nothing', () => {
    // A MODIFIED TRACKED file, deliberately: `git status --porcelain` writes those with a
    // leading space (` M src/a.ts`), and trimming the whole output ate that space, so a fixed
    // slice(3) then ate the first character of the first filename — silently, and in exactly
    // one entry per snapshot. Untracked files (`?? …`) have no leading space and never showed it.
    const tracked = join(worktree, 'src', 'a.ts');
    const original = readFileSync(tracked, 'utf8');
    writeFileSync(tracked, `${original}// modified\n`);
    writeFileSync(join(worktree, 'src', 'dirty.ts'), 'export const d = 1;\n');
    expect(work(['snapshot', '--cwd', worktree], mainCheckout)).toBe('');

    const snap = JSON.parse(readFileSync(
      join(mainCheckout, '.claude', 'work', 'tasks', `${claimableId}.snapshot.json`), 'utf8',
    ));
    expect(snap.branch).toBe('feature');
    expect(snap.head).toMatch(/^[0-9a-f]{40}$/);
    expect(snap.changedFiles).toContain('src/a.ts');
    expect(snap.changedFiles).toContain('src/dirty.ts');
    for (const f of snap.changedFiles) expect(f).not.toMatch(/^rc\//);
    writeFileSync(tracked, original);
    rmSync(join(worktree, 'src', 'dirty.ts'));
  });

  test('handoff appends a stamped section and refuses when nothing is active', () => {
    const before = taskFile(claimableId).updated;
    work(['handoff', '--body', '-'], worktree, 'what only the model knows');
    const text = readFileSync(join(mainCheckout, '.claude', 'work', 'tasks', `${claimableId}.md`), 'utf8');
    expect(text).toMatch(/## Handoff \d{4}-\d{2}-\d{2}T/);
    expect(text).toContain('what only the model knows');
    expect(taskFile(claimableId).updated).not.toBe(before);

    // A person verb: silence here would read as "recorded", which is the worst outcome.
    expect(() => work(['handoff', '--body', '-'], mainCheckout, 'nowhere to put this'))
      .toThrow(/no active task/);
  });

  test('a hook verb outside a git repository exits 0 in silence', () => {
    // Hooks run on the critical path of every session. "Not a git repository" is an ordinary
    // condition there, and an error banner at session start would be the tool's own fault.
    expect(work(['packet', '--cwd', home], mainCheckout)).toBe('');
  });

  test('promote writes a finding document, carries every handoff, and archives the task', () => {
    const id = work(['park', '--title', 'A promotable finding', '--files', 'src/a.ts,src/b.ts',
      '--body', '-'], worktree, 'what was noticed').trim();
    // --force because the suite left an earlier task active here; promote itself needs no claim,
    // but a handoff does, and a handoff is the part of the document worth proving carries over.
    work(['claim', id, '--force'], worktree);
    work(['handoff', '--body', '-'], worktree, 'the first thing only the model knew');
    work(['handoff', '--body', '-'], worktree, 'the second thing only the model knew');
    work(['snapshot'], worktree);
    work(['done', id], worktree);

    const day = id.slice(0, 8);
    const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
    const rel = work(['promote', id], worktree);
    expect(rel).toBe(join('thoughts', 'shared', 'findings', `${date}-${id.slice(9)}.md`));

    const doc = readFileSync(join(worktree, rel), 'utf8');
    expect(doc).toContain(`date: ${date}`);
    expect(doc).toContain('task: A promotable finding');
    expect(doc).toContain('status: complete');
    expect(doc).toContain('files: src/a.ts, src/b.ts');
    expect(doc).toContain('supersedes: nothing');
    expect(doc).toContain('## Files\n\n- src/a.ts\n- src/b.ts');
    expect(doc).toContain('what was noticed');
    // "every Handoff", not just the newest — the packet shows one, the document keeps the lot.
    expect(doc).toContain('the first thing only the model knew');
    expect(doc).toContain('the second thing only the model knew');
    // An empty section is dropped rather than promoted as a bare heading with nothing under it.
    expect(doc).not.toContain('## Decisions');

    const tasks = join(mainCheckout, '.claude', 'work', 'tasks');
    const archive = join(mainCheckout, '.claude', 'work', 'archive');
    expect(existsSync(join(tasks, `${id}.md`))).toBe(false);
    expect(existsSync(join(archive, `${id}.md`))).toBe(true);
    expect(existsSync(join(tasks, `${id}.snapshot.json`))).toBe(false);
    expect(existsSync(join(archive, `${id}.snapshot.json`))).toBe(true);

    // Promotion is one-way. A second run must say so rather than find "no task" and look like
    // a typo, or write a second copy of a document that already exists.
    expect(() => work(['promote', id], worktree)).toThrow(/already promoted/);
  });

  test('a dropped task promotes as dropped, so the index ranks it with the reversed decisions', () => {
    const id = work(['park', '--title', 'A finding decided against'], worktree).trim();
    work(['drop', id], worktree);
    const rel = work(['promote', id], worktree);
    const doc = readFileSync(join(worktree, rel), 'utf8');
    expect(doc).toContain('status: dropped');
    expect(doc).toContain('## Files\n\n_none recorded_');
  });

  test('promote refuses a task that is still open or active', () => {
    const id = work(['park', '--title', 'Still open'], worktree).trim();
    expect(() => work(['promote', id], worktree)).toThrow(/only a done or dropped task/);
    work(['claim', id, '--force'], worktree);
    expect(() => work(['promote', id], worktree)).toThrow(/only a done or dropped task/);
    // The live record still holds it — a refused promote must not half-archive anything.
    expect(existsSync(join(mainCheckout, '.claude', 'work', 'tasks', `${id}.md`))).toBe(true);
  });

  test('a promoted id is retired, never reissued to a later task with the same title', () => {
    // promote empties the task's slot in tasks/, so without a check against archive/ the next
    // park of the same title on the same day takes the id back — and promoting THAT task renames
    // over the archived copy, which by then is the only record of the first task's body.
    const first = work(['park', '--title', 'Recyclable'], worktree).trim();
    work(['done', first], worktree);
    work(['promote', first], worktree);

    const second = work(['park', '--title', 'Recyclable'], worktree).trim();
    expect(second).not.toBe(first);
    work(['done', second], worktree);
    work(['promote', second], worktree);

    const archive = join(mainCheckout, '.claude', 'work', 'archive');
    expect(existsSync(join(archive, `${first}.md`))).toBe(true);
    expect(existsSync(join(archive, `${second}.md`))).toBe(true);
    expect(readFileSync(join(archive, `${first}.md`), 'utf8')).toContain(`id: ${first}`);
  });

  test('promote refuses rather than proceeding when the task lock is held', () => {
    const id = work(['park', '--title', 'Locked out'], worktree).trim();
    work(['done', id], worktree);
    // `<id>.md.lock` — the lock is a sibling of the task FILE, not of its id.
    const lock = join(mainCheckout, '.claude', 'work', 'tasks', `${id}.md.lock`);
    writeFileSync(lock, '999999'); // a live holder: fresh mtime, so the staleness steal declines
    try {
      expect(() => work(['promote', id], worktree)).toThrow(/could not take the lock/);
      // Refusing is only safe if it refuses whole. Nothing may be half-done: the task stays in
      // the live record, and no document is left behind for the next run to trip over.
      expect(existsSync(join(mainCheckout, '.claude', 'work', 'tasks', `${id}.md`))).toBe(true);
      expect(existsSync(join(mainCheckout, '.claude', 'work', 'archive', `${id}.md`))).toBe(false);
      const findings = join(worktree, 'thoughts', 'shared', 'findings');
      expect(readdirSync(findings).filter((f) => f.includes('locked-out'))).toEqual([]);
    } finally {
      rmSync(lock, { force: true });
    }
  });
});
