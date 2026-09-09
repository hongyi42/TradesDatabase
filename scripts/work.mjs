#!/usr/bin/env node
// The shared work record — one place every Claude session reads and writes.
//
// Why this exists: sessions are isolated by design (each in its own git worktree, each with its
// own context window), so the only thing joining them today is the operator's memory. That is
// the bottleneck this file removes. Tasks and parked findings live in ONE directory that every
// worktree can see the instant it is written, so a session can answer "what else is in flight,
// and does it touch what I am about to change?" without anyone remembering to say so.
//
// Where the record lives, and why: `<main checkout>/.claude/work/`. A linked worktree shares the
// main checkout's `.git` directory, so `git rev-parse --git-common-dir` is a path every worktree
// can compute and agree on — no config, no daemon, no commit needed for a sibling to see a write.
// Putting it inside a worktree instead would make it invisible to siblings until a commit landed,
// which is exactly the delay that lets two sessions drift apart.
//
//   node scripts/work.mjs park --title "..." [--files a,b] [--body -]
//   node scripts/work.mjs claim <id> [--force]
//   node scripts/work.mjs done|drop <id>
//   node scripts/work.mjs packet [--cwd <path>] [--json]
//   node scripts/work.mjs board
//
// Failure policy: verbs a PERSON runs report the problem on stderr and exit non-zero, because a
// silent no-op would read as success. Verbs a HOOK runs are added in later phases and must never
// cost the user an edit, so they exit 0 silently — the two policies are deliberate and different.

import {
  readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, renameSync, statSync,
} from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isatty } from 'node:tty';

const MAX_SLUG = 40;

// ── git helpers ───────────────────────────────────────────────────────────────

/** Run git, returning trimmed stdout, or null if it fails for any reason. */
function git(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The main checkout, from anywhere in any worktree.
 *
 * `--path-format=absolute` is load-bearing: without it `--git-common-dir` answers a RELATIVE
 * path (plain `.git`) when run from the main checkout, and resolving that against the wrong
 * base silently puts the record in a different directory — a failure with no error message.
 */
function mainCheckout(cwd) {
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd)
    // Older git without --path-format answers RELATIVE TO THE CWD (`../.git` from a
    // subdirectory), so the base has to be that same cwd. Resolving against the toplevel
    // instead lands a directory above the repo — silently, with no error.
    ?? (() => {
      const rel = git(['rev-parse', '--git-common-dir'], cwd);
      return rel ? resolve(cwd, rel) : null;
    })();
  return common ? resolve(common, '..') : null;
}

/**
 * The canonical (realpath) toplevel of the worktree containing `path`.
 *
 * Canonical matters because macOS hands out symlinked temp dirs (`/var/...` → `/private/var/...`)
 * and git always answers with the realpath. Comparing a raw cwd against a stored toplevel would
 * silently never match, so every stored and compared worktree value goes through here.
 */
function worktreeOf(path) {
  return git(['rev-parse', '--show-toplevel'], path);
}

// ── the record on disk ────────────────────────────────────────────────────────

const recordDir = (main) => join(main, '.claude', 'work');
const tasksDir = (main) => join(recordDir(main), 'tasks');
const archiveDir = (main) => join(recordDir(main), 'archive');

function ensureRecord(main) {
  mkdirSync(tasksDir(main), { recursive: true });
  mkdirSync(archiveDir(main), { recursive: true });
}

/**
 * Tolerant `key: value` frontmatter, deliberately the same shape the decision index parses
 * (scripts/decision-index.mjs:54-75) so the two records read alike. Split on the FIRST colon so
 * titles and prose may contain colons freely.
 */
function parseFrontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { fm: {}, body: text };
  const fm = {};
  let i = 1;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === '---') { i++; break; }
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(lines[i]);
    if (m) fm[m[1]] = m[2].trim();
  }
  return { fm, body: lines.slice(i).join('\n').replace(/^\n+/, '') };
}

const FIELDS = ['id', 'kind', 'title', 'status', 'tags', 'origin', 'files', 'worktree', 'branch', 'base', 'created', 'updated'];

function serializeTask(fm, body) {
  const head = FIELDS.map((k) => `${k}: ${fm[k] ?? ''}`).join('\n');
  return `---\n${head}\n---\n\n${body.replace(/\s*$/, '')}\n`;
}

// `typeof v === 'string'`, not `v ?? ''`: a valueless trailing flag (`--files` with nothing
// after it) parses to boolean `true`, and `true.split` is a stack trace in the user's face.
const listField = (v) => (typeof v === 'string' ? v : '').split(',').map((s) => s.trim()).filter(Boolean);
const joinField = (a) => a.join(', ');

function taskPath(main, id) {
  return join(tasksDir(main), `${id}.md`);
}

function readTask(file) {
  const { fm, body } = parseFrontmatter(readFileSync(file, 'utf8'));
  return { fm, body, file };
}

/**
 * Replace a task file atomically: write a sibling temp file, then rename over the target.
 * A plain writeFileSync truncates first, so a concurrent reader — the pre-edit hook runs on
 * every Edit in every worktree — can observe an empty or half-written record. Rename is atomic
 * within a filesystem, so a reader sees either the old file or the new one, never a torn one.
 */
function writeTask(file, fm, body) {
  fm.updated = new Date().toISOString();
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, serializeTask(fm, body));
  renameSync(tmp, file);
}

/** Every task in the record, newest-updated first. Unreadable files are skipped, never fatal. */
function listTasks(main) {
  const dir = tasksDir(main);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    try {
      const task = readTask(join(dir, name));
      // No id means it is not a task file — a stray note, or a write caught mid-flight.
      // Skipping beats rendering a ghost row of empty columns.
      if (task.fm.id) out.push(task);
    } catch { /* a half-written file must not break the board */ }
  }
  return out.sort((a, b) => (b.fm.updated || '').localeCompare(a.fm.updated || ''));
}

/** The one task this worktree is working on. One active task per worktree is the whole rule. */
function activeTaskFor(main, worktreePath) {
  if (!worktreePath) return null;
  return listTasks(main).find((t) => t.fm.status === 'active' && t.fm.worktree === worktreePath) ?? null;
}

function findTask(main, id) {
  const p = taskPath(main, id);
  return existsSync(p) ? readTask(p) : null;
}

/**
 * Create a task file under `YYYYMMDD-<slug>`, returning the id that won.
 *
 * The create is EXCLUSIVE (`flag: 'wx'`) rather than "check existsSync, then write", because
 * the gap between those two is exactly where two sessions parking at the same moment both
 * decide on the same id and one silently overwrites the other. Measured before this: five
 * concurrent parks returned five ids and left two files — three findings lost, each having
 * printed an id and exited 0. Concurrency is the premise of this whole record, so the id
 * allocation has to be the filesystem's decision, not ours.
 */
function createTask(main, title, now, fm, body) {
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, MAX_SLUG)
    .replace(/-$/, '') || 'task';
  for (let n = 1; n < 1000; n++) {
    const id = n === 1 ? `${day}-${slug}` : `${day}-${slug}-${n}`;
    try {
      writeFileSync(taskPath(main, id), serializeTask({ ...fm, id }, body), { flag: 'wx' });
      return id;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  return fail(`could not allocate an id for "${title}" — 999 tasks already share that slug today`);
}

// ── argument parsing ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
      else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

/** Read stdin to EOF. Never called unless a flag or verb asked for it, so it cannot hang a CLI. */
function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

const fail = (msg) => { process.stderr.write(`work: ${msg}\n`); process.exit(1); };

// ── verbs ─────────────────────────────────────────────────────────────────────

function cmdPark(main, cwd, { flags }) {
  const title = typeof flags.title === 'string' ? flags.title.replace(/\s+/g, ' ').trim() : '';
  if (!title) fail('park needs --title "<what you found>"');
  // Silently filing `--kind bogus` as a finding would lose the distinction the plan draws
  // between a task somebody means to do and a finding somebody noticed.
  const kind = typeof flags.kind === 'string' ? flags.kind : 'finding';
  if (kind !== 'task' && kind !== 'finding') fail(`--kind must be task or finding, got '${kind}'`);
  const now = new Date();
  ensureRecord(main);

  const here = worktreeOf(cwd);
  const active = activeTaskFor(main, here);
  const notes = flags.body === '-' ? readStdin().trim() : (typeof flags.body === 'string' ? flags.body.trim() : '');

  const fm = {
    id: '',
    kind,
    title,
    status: 'open',
    tags: joinField(listField(flags.tags)),
    // Where it was found. A finding without its origin loses the reason it exists.
    origin: typeof flags.origin === 'string' ? flags.origin : (active?.fm.id ?? ''),
    files: joinField(listField(flags.files)),
    worktree: '',
    branch: '',
    base: '',
    created: now.toISOString(),
    updated: now.toISOString(),
  };
  const id = createTask(main, title, now, fm, `## Notes\n\n${notes}\n\n## Decisions\n`);
  process.stdout.write(`${id}\n`);
}

function cmdClaim(main, cwd, { flags, positional }) {
  const id = positional[0];
  if (!id) fail('claim needs a task id');
  const task = findTask(main, id);
  if (!task) fail(`no task ${id}`);

  const here = worktreeOf(cwd);
  if (!here) fail('not inside a git worktree');

  // The mirror of the check below: this task may already belong to a DIFFERENT checkout.
  // Taking it silently would strip that session of its packet, its file list and its board
  // column with no signal anywhere — the loss is invisible to the session it happens to.
  if (task.fm.status === 'active' && task.fm.worktree && task.fm.worktree !== here && !flags.force) {
    fail(`${id} is already active in ${basename(task.fm.worktree)} — pass --force to move it here`);
  }

  const held = activeTaskFor(main, here);
  if (held && held.fm.id !== id) {
    if (!flags.force) {
      fail(`${basename(here)} is already active on ${held.fm.id} ("${held.fm.title}") — finish it, or pass --force`);
    }
    // Forcing must RELEASE the incumbent, not just skip the refusal. Two tasks claiming one
    // worktree makes "the active task" ambiguous, and everything downstream — the packet, the
    // board's task column, the file list a hook appends to — would then write to whichever of
    // them happened to be touched last.
    held.fm.status = 'open';
    held.fm.worktree = '';
    writeTask(held.file, held.fm, held.body);
  }

  task.fm.status = 'active';
  task.fm.worktree = here;
  task.fm.branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], here) ?? '';
  // The commit this work forked from: what a later overlap check measures "changed since" against.
  task.fm.base = git(['merge-base', 'HEAD', 'origin/main'], here) ?? '';
  writeTask(task.file, task.fm, task.body);
  process.stdout.write(`${id} active in ${basename(here)}\n`);
}

function cmdSetStatus(main, { positional }, status) {
  const id = positional[0];
  if (!id) fail(`${status} needs a task id`);
  const task = findTask(main, id);
  if (!task) fail(`no task ${id}`);
  task.fm.status = status;
  // Release the worktree, or the next claim there would be refused by a task nobody is doing.
  task.fm.worktree = '';
  writeTask(task.file, task.fm, task.body);
  process.stdout.write(`${id} ${status}\n`);
}

function cmdPacket(main, cwd, { flags }) {
  const task = activeTaskFor(main, worktreeOf(cwd));
  if (!task) return; // nothing active here is a normal state, not an error
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({ ...task.fm, body: task.body })}\n`);
    return;
  }
  process.stdout.write(`${serializeTask(task.fm, task.body)}`);
}

// ── the board ─────────────────────────────────────────────────────────────────

/** Parse `git worktree list --porcelain` into one record per checkout. */
function parseWorktrees(main) {
  const raw = git(['worktree', 'list', '--porcelain'], main);
  if (!raw) return [];
  const out = [];
  let cur = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice(9), branch: '', head: '', prunable: false, detached: false };
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line.startsWith('prunable')) cur.prunable = true;
    else if (line === 'detached') cur.detached = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** Newest transcript mtime for a working directory, via Claude Code's per-directory project dir. */
function lastSessionActivity(path) {
  // Claude Code encodes the absolute path by replacing every non-alphanumeric character, so
  // `/a/b/.claude/x` becomes `-a-b--claude-x` (note the double dash the dot produces).
  const encoded = path.replace(/[^A-Za-z0-9]/g, '-');
  const dir = join(homedir(), '.claude', 'projects', encoded);
  if (!existsSync(dir)) return null;
  let newest = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const m = statSync(join(dir, name)).mtimeMs;
      if (m > newest) newest = m;
    }
  } catch { return null; }
  return newest || null;
}

function ageLabel(ms) {
  if (!ms) return '—';
  const mins = Math.floor((Date.now() - ms) / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function mergedLabel(wt, main) {
  if (!wt.head || !wt.branch) return '—';
  // Fast, offline answer first: is the tip already on main?
  if (git(['merge-base', '--is-ancestor', wt.head, 'origin/main'], main) !== null) return 'yes';
  // A squash merge leaves no ancestor, so ask GitHub — but never let its absence break the board.
  try {
    const out = execFileSync('gh', ['pr', 'list', '--state', 'merged', '--head', wt.branch, '--json', 'number'], {
      cwd: main, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    });
    const prs = JSON.parse(out);
    if (Array.isArray(prs) && prs.length) return `squash #${prs[0].number}`;
    return 'no';
  } catch {
    return '?';
  }
}

function pad(s, n) {
  const v = String(s ?? '');
  return v.length >= n ? v.slice(0, n) : v + ' '.repeat(n - v.length);
}

function cmdBoard(main) {
  const tasks = listTasks(main);
  const rows = [];
  for (const wt of parseWorktrees(main)) {
    if (wt.prunable) {
      rows.push({ name: basename(wt.path), branch: '—', dist: '—', merged: '—', commit: '—', marker: '—', task: 'PRUNABLE', session: '—' });
      continue;
    }
    const counts = git(['rev-list', '--left-right', '--count', 'origin/main...HEAD'], wt.path);
    const [behind, ahead] = counts ? counts.split(/\s+/) : ['?', '?'];
    const last = git(['log', '-1', '--format=%ct'], wt.path);
    const gitDir = git(['rev-parse', '--absolute-git-dir'], wt.path);
    const canonical = worktreeOf(wt.path);
    const active = tasks.find((t) => t.fm.status === 'active' && t.fm.worktree === canonical);
    rows.push({
      name: basename(wt.path),
      branch: wt.detached ? '(detached)' : wt.branch,
      dist: `${behind}/${ahead}`,
      merged: mergedLabel(wt, main),
      commit: last ? ageLabel(Number(last) * 1000) : '—',
      marker: gitDir && existsSync(join(gitDir, 'CLAUDE_BASE')) ? 'yes' : '—',
      task: active ? active.fm.id : '—',
      session: ageLabel(lastSessionActivity(wt.path)),
    });
  }

  const out = [];
  out.push(`WORKTREES (${rows.length})  ·  record: ${recordDir(main)}`);
  out.push([pad('worktree', 26), pad('branch', 34), pad('behind/ahead', 13), pad('merged', 12), pad('commit', 8), pad('mark', 5), pad('session', 8), 'task'].join(' '));
  for (const r of rows) {
    out.push([pad(r.name, 26), pad(r.branch, 34), pad(r.dist, 13), pad(r.merged, 12), pad(r.commit, 8), pad(r.marker, 5), pad(r.session, 8), r.task].join(' '));
  }

  out.push('');
  const open = tasks.filter((t) => t.fm.status === 'open' || t.fm.status === 'active');
  out.push(`TASKS (${open.length} open/active of ${tasks.length})`);
  if (tasks.length === 0) {
    out.push('  none — park one with /park, or: node scripts/work.mjs park --title "..."');
  } else {
    out.push([pad('id', 30), pad('kind', 8), pad('status', 8), pad('where', 18), pad('files', 6), pad('origin', 22), 'title'].join(' '));
    for (const t of tasks) {
      out.push([
        pad(t.fm.id, 30), pad(t.fm.kind, 8), pad(t.fm.status, 8),
        pad(t.fm.worktree ? basename(t.fm.worktree) : '—', 18),
        pad(String(listField(t.fm.files).length), 6),
        pad(t.fm.origin || '—', 22),
        (t.fm.title || '').slice(0, 60),
      ].join(' '));
    }
  }
  process.stdout.write(`${out.join('\n')}\n`);
}

// ── entry point ───────────────────────────────────────────────────────────────

// Verbs a HOOK invokes. These run on the critical path of a session and must never cost the
// user an edit or an error banner, so any failure is a silent exit 0 — including "this is not
// a git repository", which for a hook is an ordinary condition rather than a mistake.
const HOOK_VERBS = new Set(['packet']);

/**
 * Which directory this invocation is about — and it must be settled BEFORE the main checkout is
 * resolved, because a hook names its directory in the payload. Resolving the repository from
 * this process's own cwd first would exit early whenever the hook happens to run somewhere
 * outside a repository, discarding a payload that named a perfectly good worktree.
 *
 * `isatty(0)`, never `process.stdin.isTTY`: touching `process.stdin` instantiates the stream and
 * puts the pipe into non-blocking mode, after which readFileSync(0) fails with EAGAIN unless the
 * writer got there first — turning "the hook sent a payload" into "no active task", a silent
 * wrong answer. Guarded on a tty because reading a terminal waits for an EOF nobody sends.
 */
function resolveCwd(v, flags) {
  if (typeof flags.cwd === 'string') return flags.cwd;
  if (HOOK_VERBS.has(v) && !isatty(0)) {
    try {
      const evt = JSON.parse(readStdin());
      if (evt && typeof evt.cwd === 'string') return evt.cwd;
    } catch { /* no hook payload — fall through to this process's cwd */ }
  }
  return process.cwd();
}

const [verb, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);
const cwd = resolveCwd(verb, args.flags);
const main = mainCheckout(cwd);
if (!main) {
  if (HOOK_VERBS.has(verb)) process.exit(0);
  fail('not inside a git repository');
}

switch (verb) {
  case 'park': cmdPark(main, cwd, args); break;
  case 'claim': cmdClaim(main, cwd, args); break;
  case 'done': cmdSetStatus(main, args, 'done'); break;
  case 'drop': cmdSetStatus(main, args, 'dropped'); break;
  case 'packet': cmdPacket(main, cwd, args); break;
  case 'board': cmdBoard(main); break;
  default:
    process.stderr.write('work: usage: park | claim | done | drop | packet | board\n');
    process.exit(1);
}
