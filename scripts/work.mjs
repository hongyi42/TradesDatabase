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
//   node scripts/work.mjs touch            # PostToolUse(Edit|Write): record the touched file
//   node scripts/work.mjs promote <id>     # a done/dropped task -> thoughts/shared/findings/
//   node scripts/work.mjs archive <id>     # ...or out of the live record with no document
//   node scripts/work.mjs board
//
// Failure policy, deliberately two-sided: verbs a PERSON runs report the problem on stderr and
// exit non-zero, because a silent no-op would read as success. Verbs a HOOK runs (`packet`,
// `touch` — see HOOK_VERBS) must never cost the user an edit, so every failure is a silent
// exit 0, including "this is not a git repository", which for a hook is an ordinary condition.

import {
  readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, renameSync, rmSync, statSync,
} from 'node:fs';
import {
  join, basename, dirname, isAbsolute, relative, resolve,
} from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { isatty } from 'node:tty';

const MAX_SLUG = 40;

// ── git helpers ───────────────────────────────────────────────────────────────

/** Run git, returning raw stdout, or null if it fails for any reason. */
function gitRaw(args, cwd) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

/**
 * Run git and trim the answer — right for every command whose output is one value.
 *
 * NOT for `status --porcelain`, whose first two columns are a status field that may begin with
 * a space (` M path`). Trimming the whole output eats that space, and a fixed `slice(3)` then
 * eats the first character of the first filename: `.claude/x` came back as `claude/x`, wrong in
 * exactly one entry and silently. Use gitRaw() where leading whitespace carries meaning.
 */
function git(args, cwd) {
  const out = gitRaw(args, cwd);
  return out === null ? null : out.trim();
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

/**
 * The commit this work forked from — the reference an overlap check measures "changed since"
 * against, recorded once at claim time.
 *
 * `origin/main` is the usual answer but never a given: a local-only clone has no remote at all,
 * and a fork's remote may be called anything. Asking only for `origin/main` left `base` EMPTY in
 * those repositories, and an empty base is not a small loss — it is the fixed point the whole
 * overlap question is asked from, so the answer degrades to "everything" or "nothing" with no
 * way to tell which. Hence a chain: whatever the remote itself calls its default branch, then
 * the usual names, and finally HEAD.
 *
 * HEAD is the honest floor, not a fudge. `base` is captured at the moment of the claim, before
 * any of the work exists, so in a repository with no branch to compare against, "where this work
 * started" really is the commit that was checked out when it was claimed.
 */
function mergeBase(cwd) {
  const candidates = ['origin/main', 'main', 'origin/master', 'master'];
  const remoteDefault = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (remoteDefault) candidates.unshift(remoteDefault);
  for (const ref of candidates) {
    if (!git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)) continue;
    const found = git(['merge-base', 'HEAD', ref], cwd);
    if (found) return found;
  }
  return git(['rev-parse', 'HEAD'], cwd) ?? '';
}

/**
 * The nearest ancestor that exists. A Write creating `src/deep/new/file.ts` names a directory
 * that is not there yet, and `git -C <missing dir>` fails — so asking git about the file's own
 * directory would silently give up on precisely the edits that add new modules.
 */
function nearestExistingDir(p) {
  let d = p;
  for (let i = 0; i < 64; i++) {
    if (existsSync(d)) return d;
    const up = dirname(d);
    if (up === d) return d;
    d = up;
  }
  return d;
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

/** How long a lock may sit before it is assumed to belong to a process that died holding it. */
const STALE_LOCK_MS = 5000;

/**
 * Hold an exclusive lock on one task file while `fn` reads and rewrites it.
 *
 * Read-modify-write on a shared file needs real mutual exclusion, and "write then check it
 * stuck" is NOT enough: a writer working from a stale read can clobber a write that has
 * already verified itself, so the earlier one is lost after it reported success. Measured on
 * eight simultaneous edits: 1 of 8 recorded unguarded, 4 of 8 with verify-after-write, 8 of 8
 * under this lock. Callers must re-read inside `fn` — that is the point of taking the lock.
 *
 * The lock is a `.lock` sibling (never `.md`, so it cannot be mistaken for a task) created
 * exclusively, with a staleness steal so one killed hook process cannot wedge every later edit.
 */
function withTaskLock(file, fn) {
  const lock = `${file}.lock`;
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') return undefined; // unwritable record — give up quietly
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) rmSync(lock, { force: true });
      } catch { /* another process cleaned it up first */ }
      sleepMs(2 + (attempt % 8));
      continue;
    }
    try {
      return fn();
    } finally {
      try { rmSync(lock, { force: true }); } catch { /* nothing left to remove */ }
    }
  }
  return undefined;
}

/** Synchronous sleep — these processes have no event loop to yield to and must not spin hot. */
function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch { /* without SharedArrayBuffer, retry immediately */ }
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
    // An id is retired for good, never reissued. `promote` empties a task's slot in `tasks/`,
    // and without this the next park of the same title on the same day would take the id back —
    // after which promoting THAT task would rename straight over the archived copy, which is the
    // only remaining record of the first one's body, decisions and handoffs.
    if (existsSync(join(archiveDir(main), `${id}.md`))) continue;
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
    withTaskLock(held.file, () => {
      const t = findTask(main, held.fm.id);
      if (!t) return;
      t.fm.status = 'open';
      t.fm.worktree = '';
      writeTask(t.file, t.fm, t.body);
    });
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], here) ?? '';
  const base = mergeBase(here);
  withTaskLock(task.file, () => {
    const t = findTask(main, id);
    if (!t) return;
    t.fm.status = 'active';
    t.fm.worktree = here;
    t.fm.branch = branch;
    t.fm.base = base;
    writeTask(t.file, t.fm, t.body);
  });
  process.stdout.write(`${id} active in ${basename(here)}\n`);
}

function cmdSetStatus(main, { positional }, status) {
  const id = positional[0];
  if (!id) fail(`${status} needs a task id`);
  const existing = findTask(main, id);
  if (!existing) fail(`no task ${id}`);
  withTaskLock(existing.file, () => {
    const task = findTask(main, id);
    if (!task) return;
    task.fm.status = status;
    // Release the worktree, or the next claim there would be refused by a task nobody is doing.
    task.fm.worktree = '';
    writeTask(task.file, task.fm, task.body);
  });
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

/** Split a task body into its `## ...` sections, in order. */
function sections(body) {
  const out = [];
  const re = /^## (.+)$/gm;
  let m;
  let open = null;
  while ((m = re.exec(body)) !== null) {
    if (open) out.push({ title: open.title, text: body.slice(open.end, m.index).trim() });
    open = { title: m[1].trim(), end: m.index + m[0].length };
  }
  if (open) out.push({ title: open.title, text: body.slice(open.end).trim() });
  return out;
}

/**
 * SessionStart: hand the session back what compaction and a fresh start would otherwise lose.
 *
 * This is the piece that stops the operator being the only thing joining one session's turns to
 * the next. It carries the active task, the decisions recorded against it, the newest handoff,
 * and the file list the edit hook maintained — none of which survive a summary reliably.
 *
 * `PreCompact` cannot do this: the docs give it only `decision`/`block`, no additionalContext.
 * `SessionStart` with matcher `compact` fires right after a compaction, which is the moment the
 * context is thinnest, so that is where the packet goes back in.
 */
function cmdPacketForSession(main, cwd) {
  const wt = worktreeOf(cwd);
  const task = wt ? activeTaskFor(main, wt) : null;
  const parts = [];

  if (task) {
    const secs = sections(task.body);
    const decisions = secs.find((s) => /^Decisions?$/i.test(s.title));
    const handoffs = secs.filter((s) => /^Handoff\b/i.test(s.title));
    const latest = handoffs[handoffs.length - 1];
    const files = listField(task.fm.files);

    parts.push(
      `Your active task in this worktree, from the shared work record (${recordDir(main)}):`,
      '',
      `- id: ${task.fm.id}   kind: ${task.fm.kind}   branch: ${task.fm.branch || '(none)'}`,
      `- title: ${task.fm.title}`,
      files.length
        ? `- files touched so far (${files.length}): ${files.join(', ')}`
        : '- files touched so far: none recorded yet',
    );
    if (task.fm.origin) parts.push(`- parked from: ${task.fm.origin}`);
    if (decisions?.text) parts.push('', '## Decisions on this task', '', decisions.text);
    if (latest?.text) parts.push('', `## ${latest.title} (most recent handoff)`, '', latest.text);
  }

  const all = listTasks(main);
  const open = all.filter((t) => t.fm.status === 'open');
  if (open.length) {
    parts.push('', `${open.length} finding(s) are parked and unclaimed in the record.`
      + ' Run `npm run board` to see them before starting something new.');
  }

  // Finished, but still sitting in the live half. This is the backstop under the judgement the
  // commands ask for: both answers are one command, and what is NOT an answer is leaving it here,
  // because then "deliberately not durable" and "nobody got round to it" look identical.
  const pending = all.filter((t) => t.fm.status === 'done' || t.fm.status === 'dropped');
  if (pending.length) {
    const named = pending.slice(0, 5).map((t) => t.fm.id).join(', ');
    parts.push('', `${pending.length} finished task(s) are still in the live record, waiting on a`
      + ` promote-or-archive call: ${named}${pending.length > 5 ? ', …' : ''}.`
      + ' `promote` when a future session must KNOW it; `archive` when the test and the commit'
      + ' already say it.');
  }

  // A worktree has its own project directory, so it starts with none of the main checkout's
  // session memory. Point at the index rather than inlining it: hook output is capped at
  // 10,000 characters and the index alone is longer than that.
  if (wt && wt !== main) {
    const memory = join(homedir(), '.claude', 'projects', encodeProjectDir(main), 'memory', 'MEMORY.md');
    if (existsSync(memory)) {
      parts.push('', 'Session memory (from the main checkout — this worktree has none of its own):',
        `  ${memory}`, '  Read it before starting; it is the index, one line per memory.');
      const titles = [];
      try {
        for (const line of readFileSync(memory, 'utf8').split(/\r?\n/)) {
          const m = /^-\s*\[([^\]]+)\]/.exec(line);
          if (m) titles.push(m[1].trim());
        }
      } catch { /* unreadable index — the path alone is still worth having */ }
      if (titles.length) {
        const budget = 9000 - parts.join('\n').length;
        const kept = [];
        let used = 0;
        for (const t of titles) {
          if (used + t.length + 3 > budget) break;
          used += t.length + 3;
          kept.push(t);
        }
        if (kept.length) {
          parts.push(`  Topics (${kept.length} of ${titles.length}): ${kept.join(' · ')}`);
        }
      }
    }
  }

  const text = parts.join('\n').replace(/^\n+/, '').trimEnd();
  if (!text) return; // nothing to say is a normal state
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  }));
}

/** Claude Code's per-directory project folder name: every non-alphanumeric becomes a dash. */
function encodeProjectDir(abs) {
  return abs.replace(/[^A-Za-z0-9]/g, '-');
}

/**
 * Stop / PreCompact: record where the work stood, mechanically.
 *
 * Deliberately only what a machine can know for certain — branch, head, changed files. What was
 * DECIDED and what is still open cannot be extracted from a diff, which is why `/handoff` exists
 * and is written by the model. Prints nothing: any output on a Stop hook continues the turn.
 */
function cmdSnapshot(main, cwd) {
  const wt = worktreeOf(cwd);
  if (!wt) return;
  const task = activeTaskFor(main, wt);
  if (!task) return;
  const porcelain = gitRaw(['status', '--porcelain'], wt) ?? '';
  const snapshot = {
    ts: new Date().toISOString(),
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD'], wt) ?? '',
    head: git(['rev-parse', 'HEAD'], wt) ?? '',
    changedFiles: porcelain.split('\n').filter(Boolean).map((l) => l.slice(3).trim()),
    diffStat: git(['diff', '--stat'], wt) ?? '',
  };
  writeFileSync(join(tasksDir(main), `${task.fm.id}.snapshot.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
}

/** `/handoff`: append what only the model knows — decisions, assumptions, what is still open. */
function cmdHandoff(main, cwd, { flags }) {
  const wt = worktreeOf(cwd);
  if (!wt) fail('not inside a git worktree');
  const found = activeTaskFor(main, wt);
  if (!found) fail(`no active task in ${basename(wt)} — claim one first (work claim <id>)`);

  const text = flags.body === '-'
    ? readStdin().trim()
    : (typeof flags.body === 'string' ? flags.body.trim() : '');
  if (!text) fail('handoff needs --body - (text on stdin) or --body "<text>"');

  const stamp = new Date().toISOString();
  withTaskLock(found.file, () => {
    const task = findTask(main, found.fm.id);
    if (!task) return;
    writeTask(task.file, task.fm, `${task.body.replace(/\s*$/, '')}\n\n## Handoff ${stamp}\n\n${text}\n`);
  });
  process.stdout.write(`handoff appended to ${found.fm.id}\n`);
}

/**
 * Move a closed task and its snapshot out of `tasks/` into `archive/`. The caller holds the lock.
 *
 * Shared by `promote` and `archive` so the two exits from the live record cannot drift apart —
 * the difference between them is whether a document gets written, never what happens to the task.
 */
function moveToArchive(main, task, id) {
  renameSync(task.file, join(archiveDir(main), `${id}.md`));
  // Best effort: the task is archived by the time this runs, so a stack trace here would report
  // failure for work that actually succeeded.
  try {
    const snap = join(tasksDir(main), `${id}.snapshot.json`);
    if (existsSync(snap)) renameSync(snap, join(archiveDir(main), `${id}.snapshot.json`));
  } catch { /* the snapshot is derived state — it can be regenerated, the task cannot */ }
}

/**
 * `archive <id>`: take a closed task out of the live record WITHOUT writing a document.
 *
 * The counterpart to `promote`, and the reason both exist. Promotion answers one question — must
 * a future session KNOW this? — and for most finished work the honest answer is no: a fix a test
 * already pins and a commit already explains needs no document, and publishing one anyway puts
 * "this was fixed" in front of every later edit of those files, where it is noise.
 *
 * Until this verb existed that answer had nowhere to go. A task finished and deliberately not
 * made durable looked exactly like one nobody had got round to, so the count of finished tasks
 * meant nothing and was learned-past. Saying "no" is a decision; it needs recording like any other.
 */
function cmdArchive(main, { positional }) {
  const id = positional[0];
  if (!id) fail('archive needs a task id');
  const file = taskPath(main, id);
  const archived = join(archiveDir(main), `${id}.md`);
  if (!existsSync(file)) {
    if (existsSync(archived)) fail(`${id} is already archived — it is in ${relative(main, archiveDir(main))}`);
    fail(`no task ${id}`);
  }

  let error = null;
  let moved = false;
  withTaskLock(file, () => {
    const task = findTask(main, id);
    if (!task) { error = `no task ${id}`; return; }
    if (task.fm.status !== 'done' && task.fm.status !== 'dropped') {
      error = `${id} is ${task.fm.status || 'open'} — only a done or dropped task may be archived`;
      return;
    }
    ensureRecord(main);
    if (existsSync(archived)) {
      error = `${relative(main, archived)} already exists — refusing to write over it`;
      return;
    }
    moveToArchive(main, task, id);
    moved = true;
  });

  if (error) fail(error);
  if (!moved) fail(`could not take the lock on ${id} — another session is writing to it`);
  process.stdout.write(`${id} archived — no document written\n`);
}

/**
 * `promote <id>`: turn a closed task into a durable finding document under `thoughts/`.
 *
 * The record is the LIVE half and `thoughts/` is the DURABLE half. Mixing them is what made the
 * old prose notes untrustworthy: a directory where finished and in-flight work look alike is a
 * directory nobody trusts. So promotion is one-way and terminal — only a `done` or `dropped`
 * task may be promoted, and the same move archives it out of the live record.
 *
 * The document is written into the CALLER'S worktree, not the main checkout, because `thoughts/`
 * is tracked: the finding has to land in the tree whose branch is about to commit it. Writing it
 * to the main checkout would drop an untracked file onto whatever branch that checkout holds.
 *
 * Write first, archive second. If the archive move fails the finding still exists and the task
 * can be archived by hand; the other order can lose the task with nothing written in its place.
 */
function cmdPromote(main, cwd, { positional }) {
  const id = positional[0];
  if (!id) fail('promote needs a task id');
  const wt = worktreeOf(cwd);
  if (!wt) fail('not inside a git worktree');

  const file = taskPath(main, id);
  const archived = join(archiveDir(main), `${id}.md`);
  if (!existsSync(file)) {
    if (existsSync(archived)) fail(`${id} is already promoted — it is in ${relative(main, archiveDir(main))}`);
    fail(`no task ${id}`);
  }

  // Reading the task and moving it happen under ONE lock, like every other mutating verb.
  // Without it a concurrent `claim` can turn this task active between the status check and the
  // archive move, and promote would then archive a task a live session is working on — silently,
  // because nothing reads `archive/`: that session's packet, file list and board row simply go
  // empty. `fail()` is never called inside the lock, because process.exit skips the `finally`
  // that releases it; the outcome is carried out and acted on after the lock is gone.
  let error = null;
  let written = null;
  withTaskLock(file, () => {
    const task = findTask(main, id);
    if (!task) { error = `no task ${id}`; return; }
    if (task.fm.status !== 'done' && task.fm.status !== 'dropped') {
      error = `${id} is ${task.fm.status || 'open'} — only a done or dropped task may be promoted`;
      return;
    }
    ensureRecord(main);
    // The archive is the only remaining copy of a promoted task's body. `createTask` already
    // refuses to reissue an archived id, so reaching this means something outside the tool put
    // a file here — never write over it.
    if (existsSync(archived)) {
      error = `${relative(main, archived)} already exists — refusing to write over it`;
      return;
    }

    // Dated by when the work STARTED, not when it was filed, so the finding sorts beside the
    // research and plan documents written alongside it.
    const date = /^\d{4}-\d{2}-\d{2}/.exec(task.fm.created || '')?.[0]
      ?? new Date().toISOString().slice(0, 10);
    const slug = id.replace(/^\d{8}-/, '') || 'finding';
    const files = listField(task.fm.files);

    const head = [
      `date: ${date}`,
      `task: ${task.fm.title ?? ''}`,
      // `dropped` is classified as superseded by the index, which is the honest reading: the
      // finding stays findable, but ranked last and labelled, because somebody decided against
      // it. `done` is a record of work that actually happened.
      `status: ${task.fm.status === 'done' ? 'complete' : 'dropped'}`,
      `origin: ${task.fm.origin ?? ''}`,
      `files: ${joinField(files)}`,
      'supersedes: nothing',
    ].join('\n');

    // Sections are re-emitted rather than the body copied verbatim, only to drop the ones that
    // were never filled in. Anything before the first heading is carried across as-is: the CLI's
    // own writers always open with `## Notes`, but a hand-edited task file need not, and losing
    // prose on promotion would be the worst possible moment to lose it.
    const firstHeading = task.body.search(/^## /m);
    const preamble = (firstHeading === -1 ? task.body : task.body.slice(0, firstHeading)).trim();
    const fileList = files.length ? files.map((f) => `- ${f}`).join('\n') : '_none recorded_';
    const blocks = [`## Files\n\n${fileList}`];
    if (preamble) blocks.push(preamble);
    for (const s of sections(task.body)) if (s.text) blocks.push(`## ${s.title}\n\n${s.text}`);
    const doc = `---\n${head}\n---\n\n${blocks.join('\n\n')}\n`;

    const dir = join(wt, 'thoughts', 'shared', 'findings');
    mkdirSync(dir, { recursive: true });
    const out = join(dir, `${date}-${slug}.md`);
    try {
      writeFileSync(out, doc, { flag: 'wx' });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      error = `${relative(wt, out)} already exists — move it aside first`;
      return;
    }

    moveToArchive(main, task, id);
    written = relative(wt, out);
  });

  if (error) fail(error);
  if (!written) fail(`could not take the lock on ${id} — another session is writing to it`);
  process.stdout.write(`${written}\n`);
}

/**
 * PostToolUse(Edit|Write): record that this worktree's active task touched a file.
 *
 * This is how a task's file list writes itself. Nobody remembers to maintain one by hand, and
 * the list is what the pre-edit hook uses to warn a sibling session, so a list that depends on
 * discipline would be empty exactly when it mattered. Silent in every failure case: it runs
 * after every single edit and must never produce output or a non-zero exit.
 */
function cmdTouch(main, flags) {
  // `--file` first, and it is the form the hook uses: `jq` parses the payload once in the hook
  // command and this process never reads stdin. The commit that introduced it (1e2cd42) said the
  // stdin route was dead because the hooks on one event share a single stdin. Measured false on
  // 2026-09-10 — each hook gets its own full copy. What this verb actually cannot see is any edit
  // that does not go through the Edit or Write tool: a file rewritten from Bash (sed, a node or
  // python script) is never recorded, and neither is anything a session did before it had this
  // hook. So files: is a floor, not the whole footprint; `snapshot` reads `git status`, which
  // catches those edits too, but only while they are still uncommitted.
  const fromFlag = typeof flags?.file === 'string' && flags.file ? flags.file : null;
  const filePath = fromFlag ?? hookPayload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || !filePath) return;
  const abs = isAbsolute(filePath) ? filePath : resolve(hookPayload?.cwd ?? process.cwd(), filePath);

  // The file's OWN worktree, not the session's cwd: an edit can name a path anywhere.
  const wt = worktreeOf(nearestExistingDir(dirname(abs)));
  if (!wt) return;
  const rel = relative(wt, abs);
  if (!rel || rel.startsWith('..')) return;

  // One assistant turn routinely issues several edits at once and each spawns its own copy of
  // this process, so the update has to be serialised. Everything that matters is re-read INSIDE
  // the lock, including the status: a `done` that landed in between must not be undone by a
  // stale copy resurrecting the task.
  const found = activeTaskFor(main, wt);
  if (!found) return;
  withTaskLock(found.file, () => {
    const task = findTask(main, found.fm.id);
    if (!task || task.fm.status !== 'active' || task.fm.worktree !== wt) return;
    const files = listField(task.fm.files);
    if (files.includes(rel)) return;
    files.push(rel);
    task.fm.files = joinField(files);
    writeTask(task.file, task.fm, task.body);
  });
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
const HOOK_VERBS = new Set(['packet', 'touch', 'snapshot']);

/** The hook payload, parsed once by resolveCwd — stdin can only be read to EOF once. */
let hookPayload = null;

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
 *
 * A tty is not the only thing that never sends EOF, which is why the payload read is narrowed to
 * the invocations a hook actually makes. `packet` is the one verb people also run by hand, and
 * reading stdin on the bare form hung forever whenever it inherited a pipe nobody was going to
 * close — a shell pipeline, a terminal multiplexer. Only `packet --for-session` comes from a
 * hook, and a hook always closes its pipe, so that is the only form that waits for one.
 */
const wantsHookPayload = (v, flags) => (v === 'packet' ? Boolean(flags['for-session']) : HOOK_VERBS.has(v));

function resolveCwd(v, flags) {
  if (typeof flags.cwd === 'string') return flags.cwd;
  if (wantsHookPayload(v, flags) && !isatty(0)) {
    try {
      hookPayload = JSON.parse(readStdin());
      if (hookPayload && typeof hookPayload.cwd === 'string') return hookPayload.cwd;
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
  case 'packet':
    if (args.flags['for-session']) {
      try { cmdPacketForSession(main, cwd); } catch { /* a session must still start */ }
    } else cmdPacket(main, cwd, args);
    break;
  case 'touch':
    // Runs after every edit in every session: swallow everything.
    try { cmdTouch(main, args.flags); } catch { /* never cost the user an edit */ }
    break;
  case 'snapshot':
    // Runs on every Stop and before every compaction: same policy.
    try { cmdSnapshot(main, cwd); } catch { /* never block a turn from ending */ }
    break;
  case 'handoff': cmdHandoff(main, cwd, args); break;
  case 'promote': cmdPromote(main, cwd, args); break;
  case 'archive': cmdArchive(main, args); break;
  case 'board': cmdBoard(main); break;
  default:
    process.stderr.write('work: usage: park | claim | done | drop | packet | touch | snapshot'
      + ' | handoff | promote | archive | board\n');
    process.exit(1);
}
