// End-to-end tests for `work.mjs prune` — removing worktrees whose work is provably finished.
//
// Pruning deletes things, so every KEEP reason is pinned as carefully as the REMOVEs. `gh` and
// `npx` are stand-ins placed first on PATH: the first answers "which PR merged this branch" from
// a fixture file (or fails, like an unauthenticated gh), the second records every `supabase stop`
// it is asked to run and from where — so a test can prove which stack is stopped, when, and that
// it is never asked of the main checkout, without touching Docker.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'scripts', 'work.mjs');

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Prune Test',
  GIT_AUTHOR_EMAIL: 'prune@test.invalid',
  GIT_COMMITTER_NAME: 'Prune Test',
  GIT_COMMITTER_EMAIL: 'prune@test.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

// The shape scripts/second-stack.sh actually rewrites: port lines, a commented-out port with a
// digit in its name, the inspector. A fixture with only project_id once hid a real bug here.
const CONFIG = [
  'project_id = "fixture"',
  '[api]',
  'port = 54321',
  '[inbucket]',
  '# pop3_port = 54326',
  '[edge_runtime]',
  'inspector_port = 8083',
  '',
].join('\n');
const stackRewrite = (id: string, n: number) => CONFIG
  .replace('"fixture"', `"${id}"`).replace(/543(\d\d)/g, `54${3 + n}$1`).replace('8083', `8${n}83`);

let tmp: string;
let home: string;
let stubs: string;
let npxLog: string;
let ghFixture: string;
let mainCheckout: string;
const wt: Record<string, string> = {};

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

function env(): NodeJS.ProcessEnv {
  return { ...process.env, ...GIT_ENV, HOME: home, PATH: `${stubs}:${process.env.PATH}`, GH_FIXTURE: ghFixture, NPX_LOG: npxLog };
}

function prune(args: string[] = [], cwd = mainCheckout): { status: number | null; stdout: string } {
  const r = spawnSync('node', [CLI, 'prune', ...args], { cwd, encoding: 'utf8', input: '', env: env() });
  return { status: r.status, stdout: r.stdout };
}

function row(out: string, name: string): string {
  return out.split('\n').find((l) => new RegExp(`^\\s+(REMOVE|KEEP)\\s+${name}\\s`).test(l)) ?? '';
}

/** A worktree on a new branch from origin/main — or, given one, on that existing branch. */
function add(name: string, existingBranch?: string): string {
  const path = join(tmp, name);
  git(existingBranch
    ? ['worktree', 'add', path, existingBranch]
    : ['worktree', 'add', '--no-track', path, '-b', name, 'origin/main'], mainCheckout);
  wt[name] = path;
  return path;
}

function commitIn(path: string, message: string): string {
  writeFileSync(join(path, `${message}.txt`), `${message}\n`);
  git(['add', '-A'], path);
  git(['commit', '-q', '-m', message], path);
  return git(['rev-parse', 'HEAD'], path);
}

function transcript(folder: string, lines: string[], ageMs: number): void {
  const dir = join(home, '.claude', 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(file, `${lines.join('\n')}\n`);
  const when = new Date(Date.now() - ageMs);
  utimesSync(file, when, when);
}

const branchExists = (name: string) => git(['branch', '--list', name], mainCheckout) !== '';

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'prune-')));
  home = join(tmp, 'home');
  stubs = join(tmp, 'stubs');
  npxLog = join(tmp, 'npx.log');
  ghFixture = join(tmp, 'gh.json');
  mkdirSync(home, { recursive: true });
  mkdirSync(stubs, { recursive: true });
  writeFileSync(npxLog, '');
  writeFileSync(join(stubs, 'npx'), '#!/bin/sh\necho "$PWD|$*|$(grep "^project_id" supabase/config.toml 2>/dev/null)" >> "$NPX_LOG"\n', { mode: 0o755 });
  writeFileSync(join(stubs, 'gh'), [
    '#!/usr/bin/env node',
    "const a = process.argv.slice(2); const i = a.indexOf('--head');",
    "const map = JSON.parse(require('fs').readFileSync(process.env.GH_FIXTURE, 'utf8'));",
    'let v = map[a[i + 1]];',
    // A commit landing in another worktree WHILE prune is still asking about this one.
    "if (v && v.commitIn) { require('child_process').execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'landed during prune'], { cwd: v.commitIn }); v = v.result; }",
    "if (v === 'FAIL') { process.stderr.write('gh: not logged in\\n'); process.exit(1); }",
    'process.stdout.write(JSON.stringify(v ?? []));',
    '',
  ].join('\n'), { mode: 0o755 });

  mainCheckout = join(tmp, 'repo');
  mkdirSync(join(mainCheckout, 'supabase'), { recursive: true });
  git(['init', '-b', 'main'], mainCheckout);
  writeFileSync(join(mainCheckout, 'supabase', 'config.toml'), CONFIG);
  writeFileSync(join(mainCheckout, 'README.md'), 'fixture\n');
  writeFileSync(join(mainCheckout, '.gitignore'), 'node_modules\n.env\n.env.test\n.scratch/\n');
  writeFileSync(join(mainCheckout, 'supabase', '.gitignore'), '.branches\n.temp\n'); // as the repo's own
  git(['add', '.'], mainCheckout);
  git(['commit', '-q', '-m', 'fixture'], mainCheckout);
  git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], mainCheckout);
  writeFileSync(join(mainCheckout, '.env'), 'KEY=main\n');
  // A setting that hides untracked files from plain `git status` — and from git's own check in
  // `worktree remove`. Prune must see them anyway, or an untracked draft is deleted silently.
  git(['config', 'status.showUntrackedFiles', 'no'], mainCheckout);
  // The main checkout moves to another branch so a linked worktree can hold `main` itself.
  git(['switch', '-q', '-c', 'trunk-work'], mainCheckout);

  add('merged-clean'); // tip is origin/main itself: merged, clean, same project_id as main
  commitIn(add('unmerged'), 'ahead');
  writeFileSync(join(add('merged-untracked'), 'scratch.txt'), 'not committed\n');
  add('merged-active');
  const id = execFileSync('node', [CLI, 'park', '--title', 'still running', '--kind', 'task'], { cwd: mainCheckout, encoding: 'utf8', env: env() }).trim();
  execFileSync('node', [CLI, 'claim', id], { cwd: wt['merged-active'], encoding: 'utf8', env: env() });
  // A session that wrote in the worktree's OWN project folder an hour ago...
  transcript(add('merged-live'), ['{}'], 60 * 60 * 1000);
  // ...and one launched in the MAIN checkout that then worked inside this worktree: its
  // transcript lives under the main checkout's folder, and only its `cwd` says where it was.
  transcript(mainCheckout, [JSON.stringify({ cwd: mainCheckout }), JSON.stringify({ cwd: add('merged-visited') })], 30 * 60 * 1000);
  const subagents = join(home, '.claude', 'projects', mainCheckout.replace(/[^A-Za-z0-9]/g, '-'), 'a-session', 'subagents');
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(subagents, 'agent-1.jsonl'), `${JSON.stringify({ cwd: add('merged-subagent') })}\n`);
  // Squash-merged: GitHub's merged PR head is exactly this tip...
  const squashTip = commitIn(add('squash-match'), 'squashed');
  // ...a branch sharing only the NAME of a merged PR...
  commitIn(add('squash-other'), 'never-merged');
  // ...and one gh cannot answer for at all (not logged in, rate-limited).
  commitIn(add('squash-ghfail'), 'unknowable');
  writeFileSync(ghFixture, JSON.stringify({
    'squash-match': [{ number: 7, headRefOid: squashTip }],
    'squash-other': [{ number: 8, headRefOid: '0000000000000000000000000000000000000000' }],
    'squash-ghfail': 'FAIL',
  }));
  // Merged with its own stack, rewritten exactly as second-stack.sh does.
  writeFileSync(join(add('own-stack'), 'supabase', 'config.toml'), stackRewrite('fixture-own-stack', 1));
  // Merged, with a project_id that sanitises to NOTHING: stopping it would match every stack.
  writeFileSync(join(add('empty-label'), 'supabase', 'config.toml'), stackRewrite('-+-', 6));
  // Merged with a REAL edit to config.toml, beside the stack rewrite: that edit is work.
  writeFileSync(join(add('config-edited'), 'supabase', 'config.toml'), `${stackRewrite('fixture-edited', 2)}[auth]\nsite_url = "http://x"\n`);
  // Merged, stack rewrite STAGED rather than left as second-stack.sh leaves it.
  writeFileSync(join(add('config-staged'), 'supabase', 'config.toml'), stackRewrite('fixture-staged', 3));
  git(['add', 'supabase/config.toml'], wt['config-staged']);
  // Two worktrees sharing one stack: the merged one must not stop it under the kept one.
  writeFileSync(join(add('shared-merged'), 'supabase', 'config.toml'), stackRewrite('fixture-shared', 4));
  writeFileSync(join(add('shared-kept'), 'supabase', 'config.toml'), stackRewrite('fixture-shared', 4));
  commitIn(wt['shared-kept'], 'shared-kept-work');
  // Locked by someone who wanted it kept.
  add('merged-locked');
  git(['worktree', 'lock', '--reason', 'keep me', wt['merged-locked']], mainCheckout);
  // A linked worktree holding `main` itself.
  add('on-main', 'main');
  // The worktree prune will be run FROM, in the case that tests that.
  add('merged-self');
  // Merged and clean to `git status`, holding IGNORED files. What rebuilds itself may go; what
  // does not — scratch notes, an edited .env — is somebody's, and `worktree remove` deletes it.
  mkdirSync(join(add('merged-regenerable'), 'node_modules', 'x'), { recursive: true });
  writeFileSync(join(wt['merged-regenerable'], 'node_modules', 'x', 'index.js'), '');
  writeFileSync(join(wt['merged-regenerable'], '.env.test'), 'LOCAL=1\n');
  writeFileSync(join(wt['merged-regenerable'], '.env'), 'KEY=main\n'); // a copy of the main checkout's
  // What `supabase start` leaves in every worktree that has run a stack.
  mkdirSync(join(wt['merged-regenerable'], 'supabase', '.branches'), { recursive: true });
  writeFileSync(join(wt['merged-regenerable'], 'supabase', '.branches', '_current_branch'), 'main');
  mkdirSync(join(wt['merged-regenerable'], 'supabase', '.temp'), { recursive: true });
  writeFileSync(join(wt['merged-regenerable'], 'supabase', '.temp', 'cli-latest'), 'v2.107.0');
  mkdirSync(join(add('merged-ignored'), '.scratch'));
  writeFileSync(join(wt['merged-ignored'], '.scratch', 'notes.md'), 'half a thought\n');
  writeFileSync(join(add('merged-env-edited'), '.env'), 'KEY=edited\n');
  // Merged, but git cannot read its status at all: that proves nothing, least of all "clean".
  add('merged-unreadable');
  writeFileSync(join(mainCheckout, '.git', 'worktrees', 'merged-unreadable', 'index'), 'not an index');
  // Registered with git, folder gone; and registered, link broken, folder still there.
  rmSync(add('gone'), { recursive: true, force: true });
  renameSync(join(add('orphaned'), '.git'), join(wt.orphaned, '.git.bak'));
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('work.mjs prune', () => {
  test('the dry run sorts every worktree into REMOVE or KEEP, with the reason, and changes nothing', () => {
    const before = git(['worktree', 'list', '--porcelain'], mainCheckout);
    const { status, stdout } = prune();
    expect(status).toBe(0);
    expect(row(stdout, 'merged-clean')).toMatch(/REMOVE.*on origin\/main · no own stack/);
    expect(row(stdout, 'squash-match')).toMatch(/REMOVE.*merged PR #7/);
    expect(row(stdout, 'own-stack')).toMatch(/REMOVE.*then stop its stack fixture-own-stack/);
    expect(row(stdout, 'empty-label')).toMatch(/REMOVE.*no own stack/);
    expect(row(stdout, 'shared-merged')).toMatch(/REMOVE.*shared with shared-kept, left running/);
    expect(row(stdout, 'on-main')).toMatch(/REMOVE.*branch main kept/);
    expect(row(stdout, 'gone')).toMatch(/REMOVE.*registration only.*its folder is gone/);
    expect(row(stdout, 'orphaned')).toMatch(/REMOVE.*registration only.*still on disk and is left there/);
    expect(row(stdout, 'merged-self')).toMatch(/REMOVE/); // only because prune is run from main here
    expect(row(stdout, 'unmerged')).toMatch(/KEEP.*no merge proof/);
    expect(row(stdout, 'squash-other')).toMatch(/KEEP.*no merge proof/); // a NAME is not a merge
    expect(row(stdout, 'squash-ghfail')).toMatch(/KEEP.*no merge proof/); // no answer is not a yes
    expect(row(stdout, 'merged-untracked')).toMatch(/KEEP.*uncommitted: 1 file/);
    expect(row(stdout, 'config-edited')).toMatch(/KEEP.*uncommitted: 1 file/);
    expect(row(stdout, 'config-staged')).toMatch(/KEEP.*uncommitted: 1 file/);
    expect(row(stdout, 'merged-active')).toMatch(/KEEP.*active task/);
    expect(row(stdout, 'merged-live')).toMatch(/KEEP.*a session worked here 1h ago/);
    expect(row(stdout, 'merged-visited')).toMatch(/KEEP.*a session worked here/);
    expect(row(stdout, 'merged-subagent')).toMatch(/KEEP.*a session worked here/);
    expect(row(stdout, 'merged-locked')).toMatch(/KEEP.*locked/);
    expect(row(stdout, 'merged-regenerable')).toMatch(/REMOVE.*on origin\/main/);
    expect(row(stdout, 'merged-ignored')).toMatch(/KEEP.*ignored files that removing it would delete: \.scratch\//);
    expect(row(stdout, 'merged-env-edited')).toMatch(/KEEP.*ignored files that removing it would delete: \.env /);
    expect(row(stdout, 'merged-unreadable')).toMatch(/KEEP.*git could not read its status/);
    expect(stdout).not.toMatch(/^\s+(REMOVE|KEEP)\s+repo\s/m); // never the main checkout
    expect(git(['worktree', 'list', '--porcelain'], mainCheckout)).toBe(before);
    expect(readFileSync(npxLog, 'utf8')).toBe('');
  });

  test('the worktree prune is run from is always kept', () => {
    expect(row(prune([], wt['merged-self']).stdout, 'merged-self')).toMatch(/KEEP.*prune is running from inside it/);
  });

  test('--apply removes exactly the REMOVE rows; a stack is stopped by its config, after, and never a shared one', () => {
    const { status, stdout } = prune(['--apply']);
    expect(status).toBe(0);
    for (const name of ['merged-clean', 'squash-match', 'own-stack', 'shared-merged', 'on-main', 'merged-self', 'merged-regenerable']) {
      expect(existsSync(wt[name])).toBe(false);
    }
    for (const name of ['merged-clean', 'squash-match', 'own-stack', 'shared-merged', 'merged-self']) {
      expect(branchExists(name)).toBe(false);
    }
    // `main` was held by a worktree that went; the branch itself never goes.
    expect(branchExists('main')).toBe(true);
    // Broken registrations dropped — and a folder still on disk left exactly where it was.
    const list = git(['worktree', 'list'], mainCheckout);
    expect(list).not.toContain(wt.gone);
    expect(list).not.toContain(wt.orphaned);
    expect(existsSync(wt.orphaned)).toBe(true);
    // Exactly one stop: the own stack, by its config, from a directory that is not the main
    // checkout (where `supabase stop` would take down the PRIMARY stack). The shared stack, still
    // used by shared-kept, was not stopped.
    const stops = readFileSync(npxLog, 'utf8').trim().split('\n');
    expect(stops).toHaveLength(1);
    const [where, what, project] = stops[0].split('|');
    // By its config, from a throwaway folder holding only that — so the CLI resolves the id
    // exactly as `start` did (a raw --project-id can silently miss a long, sanitised one).
    expect(what).toBe('supabase stop --no-backup');
    expect(project).toBe('project_id = "fixture-own-stack"');
    expect(where).not.toBe(mainCheckout);
    expect(where).not.toBe(wt['own-stack']);
    expect(stdout).toMatch(/removed own-stack — worktree removed; branch own-stack deleted/);
    expect(stdout).toContain('stack fixture-own-stack stopped (its data volumes deleted)');
    for (const name of ['unmerged', 'squash-other', 'squash-ghfail', 'merged-untracked', 'config-edited',
      'config-staged', 'merged-active', 'merged-live', 'merged-visited', 'merged-subagent', 'merged-locked', 'shared-kept',
      'merged-ignored', 'merged-env-edited', 'merged-unreadable']) {
      expect(existsSync(wt[name])).toBe(true);
    }
    expect(readFileSync(join(wt['merged-ignored'], '.scratch', 'notes.md'), 'utf8')).toBe('half a thought\n');
    // The real edit to config.toml, which a blanket `git checkout` would have thrown away.
    expect(readFileSync(join(wt['config-edited'], 'supabase', 'config.toml'), 'utf8')).toContain('site_url');
  });
});

describe('work.mjs prune — a shared stack under a removal that fails', () => {
  test('the stack two removed worktrees share is left running when one of them could not go', () => {
    const repo = join(tmp, 'pair-repo');
    mkdirSync(join(repo, 'supabase'), { recursive: true });
    git(['init', '-q', '-b', 'main'], repo);
    writeFileSync(join(repo, 'supabase', 'config.toml'), CONFIG);
    // A tracked directory, so the worktree is clean — and in pair-2 one git cannot empty:
    // `status` has nothing to say about it, and `worktree remove` fails part-way on it.
    mkdirSync(join(repo, 'stuck'));
    writeFileSync(join(repo, 'stuck', 'file'), 'x');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'fixture'], repo);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], repo);
    git(['switch', '-q', '-c', 'trunk'], repo);
    const pair = ['pair-1', 'pair-2'].map((name) => {
      const p = join(tmp, name);
      git(['worktree', 'add', '--no-track', p, '-b', name, 'origin/main'], repo);
      writeFileSync(join(p, 'supabase', 'config.toml'), stackRewrite('fixture-pair', 5));
      return p;
    });
    const stuck = join(pair[1], 'stuck');
    chmodSync(stuck, 0o555);
    writeFileSync(npxLog, '');
    try {
      const r = spawnSync('node', [CLI, 'prune', '--apply'], { cwd: repo, encoding: 'utf8', input: '', env: env() });
      expect(existsSync(pair[0])).toBe(false);
      expect(r.stdout).toMatch(/KEPT\s+pair-2/);
      expect(r.stdout).toContain('stack fixture-pair left running — pair-2 could not be removed');
      // --no-backup deletes a stack's data: never while a worktree using it is still there.
      expect(readFileSync(npxLog, 'utf8')).toBe('');
      expect(r.status).toBe(1);
    } finally {
      chmodSync(stuck, 0o755);
    }
  });
});

describe('work.mjs prune — a commit landing between the check and the removal', () => {
  test('a branch that moved after its merge proof is kept, with the commit that moved it', () => {
    const repo = join(tmp, 'race-repo');
    mkdirSync(repo, { recursive: true });
    git(['init', '-q', '-b', 'main'], repo);
    writeFileSync(join(repo, 'README.md'), 'race\n');
    git(['add', '.'], repo);
    git(['commit', '-q', '-m', 'fixture'], repo);
    git(['update-ref', 'refs/remotes/origin/main', 'HEAD'], repo);
    git(['switch', '-q', '-c', 'trunk'], repo);
    // race-a is merged by ancestry and checked FIRST (worktrees list sorted by path). race-b needs
    // gh — and the stand-in, answering for race-b, commits in race-a: the gap the check leaves.
    const [a, b] = ['race-a', 'race-b'].map((name) => {
      const p = join(tmp, name);
      git(['worktree', 'add', '--no-track', p, '-b', name, 'origin/main'], repo);
      return p;
    });
    const tipB = commitIn(b, 'race-b-work');
    const fixture = join(tmp, 'gh-race.json');
    writeFileSync(fixture, JSON.stringify({ 'race-b': { commitIn: a, result: [{ number: 9, headRefOid: tipB }] } }));
    const r = spawnSync('node', [CLI, 'prune', '--apply'], { cwd: repo, encoding: 'utf8', input: '', env: { ...env(), GH_FIXTURE: fixture } });
    expect(r.stdout).toMatch(/REMOVE\s+race-a/); // proven at the time it was checked
    // The worktree could go (the commit left it clean); the branch, holding that commit, stays.
    expect(existsSync(a)).toBe(false);
    expect(git(['log', '-1', '--format=%s', 'race-a'], repo)).toBe('landed during prune');
    expect(r.stdout).toContain('branch race-a KEPT — it no longer points at the commit proven merged');
    expect(r.status).toBe(1);
    // race-b itself went as normal: its proof was about the commit it still points at.
    expect(git(['branch', '--list', 'race-b'], repo)).toBe('');
  });
});
