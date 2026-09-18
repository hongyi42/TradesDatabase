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
//   node scripts/work.mjs overlap <a> <b> [--json]   # where two tasks/branches collide, sized
//   node scripts/work.mjs spawn <id> [--proceed] [--branch <b>]   # a parked task into its own worktree
//   node scripts/work.mjs integrate [<id>] [--json]   # before landing: what moved under you, whom you affect
//   node scripts/work.mjs prune [--apply]            # remove worktrees whose work is provably finished
//
// Env: WORK_RECORD_READONLY=1 turns `touch` and `snapshot` into no-ops, for a session that must
// run a worktree's hooks without OWNING its task — see recordIsReadOnly at the entry point.
//
// Failure policy, deliberately two-sided: verbs a PERSON runs report the problem on stderr and
// exit non-zero, because a silent no-op would read as success. Verbs a HOOK runs (`packet`,
// `touch` — see HOOK_VERBS) must never cost the user an edit, so every failure is a silent
// exit 0, including "this is not a git repository", which for a hook is an ordinary condition.

import {
  readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, renameSync, rmSync, statSync,
  openSync, fstatSync, readSync, closeSync, mkdtempSync,
} from 'node:fs';
import {
  join, basename, dirname, isAbsolute, relative, resolve,
} from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { isatty } from 'node:tty';

const MAX_SLUG = 40;

// ── git helpers ───────────────────────────────────────────────────────────────

/** Run git, returning raw stdout, or null if it fails for any reason (a `timeout` in `opts` included). */
function gitRaw(args, cwd, opts = {}) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
      ...opts,
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
  for (const ref of mainRefs(cwd)) {
    const found = git(['merge-base', 'HEAD', ref], cwd);
    if (found) return found;
  }
  return git(['rev-parse', 'HEAD'], cwd) ?? '';
}

/** The branches this clone might call "main", best first — only those that exist. */
function mainRefs(cwd) {
  const candidates = ['origin/main', 'main', 'origin/master', 'master'];
  const remoteDefault = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (remoteDefault) candidates.unshift(remoteDefault);
  return candidates.filter((ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd));
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
 * (`parseFrontmatter` in scripts/decision-index.mjs) so the two records read alike. Split on the FIRST colon so
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

/**
 * Flags that never take a value. Without this list `integrate --json <id>` read the id as the
 * flag's value and silently reported this worktree's own task instead.
 */
const SWITCHES = new Set(['json', 'proceed', 'apply', 'force', 'for-session']);

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else if (!SWITCHES.has(a.slice(2)) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) flags[a.slice(2)] = argv[++i];
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
  const here = worktreeOf(cwd);
  if (!here) fail('not inside a git worktree');
  const error = claimInto(main, id, here, Boolean(flags.force));
  if (error) fail(error);
  process.stdout.write(`${id} active in ${basename(here)}\n`);
}

/**
 * Make `id` the active task of the checkout `here` (a canonical toplevel). Returns an error
 * message instead of exiting, so `spawn` — which has just created that checkout — can undo what
 * it built before it says what went wrong.
 *
 * `handoff`, when given, is appended in the SAME locked write as the claim: `spawn`'s overlap
 * report must never be lost between the two, and a task claimed without it would start its
 * session knowing nothing of what it was told to proceed past.
 */
function claimInto(main, id, here, force, handoff = null) {
  const task = findTask(main, id);
  if (!task) return `no task ${id}`;

  // The mirror of the check below: this task may already belong to a DIFFERENT checkout.
  // Taking it silently would strip that session of its packet, its file list and its board
  // column with no signal anywhere — the loss is invisible to the session it happens to.
  if (task.fm.status === 'active' && task.fm.worktree && task.fm.worktree !== here && !force) {
    return `${id} is already active in ${basename(task.fm.worktree)} — pass --force to move it here`;
  }

  const held = activeTaskFor(main, here);
  if (held && held.fm.id !== id) {
    if (!force) {
      return `${basename(here)} is already active on ${held.fm.id} ("${held.fm.title}") — finish it, or pass --force`;
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
  // Re-checked inside the lock: another session may have claimed the task since it was read above.
  const outcome = withTaskLock(task.file, () => {
    const t = findTask(main, id);
    if (!t) return `${id} disappeared from the record while it was being claimed`;
    if (t.fm.status === 'active' && t.fm.worktree && t.fm.worktree !== here && !force) {
      return `${id} was claimed in ${basename(t.fm.worktree)} a moment ago — pass --force to move it here`;
    }
    t.fm.status = 'active';
    t.fm.worktree = here;
    t.fm.branch = branch;
    t.fm.base = base;
    const body = handoff ? `${t.body.replace(/\s*$/, '')}\n\n## Handoff ${new Date().toISOString()}\n\n${handoff}\n` : t.body;
    writeTask(t.file, t.fm, body);
    return true;
  });
  // `undefined` is withTaskLock giving up: the claim was NOT written, and saying otherwise would
  // leave a session working in a checkout the record says nobody holds.
  if (outcome === undefined) return `could not take the lock on ${id} — another session is writing to it`;
  return outcome === true ? null : outcome;
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

// ── the code graph ────────────────────────────────────────────────────────────

/**
 * Imported on demand, never at the top of this file. The graph verbs are the only callers, so a
 * fault in the graph can never reach `touch`, `packet` or `snapshot` — the verbs a hook runs on
 * the critical path of every session.
 */
const loadGraph = () => import('./code-graph.mjs');

/** A task id from the record, or any branch name — the two things an overlap can be asked about. */
function subjectFor(graph, main, x) {
  const task = findTask(main, x);
  if (task) return graph.subjectFromTask(main, task.fm, task.body);
  const s = graph.subjectFromBranch(main, x);
  if (!s) fail(`${x} is neither a task in the record nor a branch`);
  return s;
}

/**
 * The sized overlap report. One block per item, worst first, with the numbers inline — the
 * operator decides from how BIG an overlap is, so a bare "these overlap" would not be enough.
 */
function renderOverlaps(items) {
  // 19 = the longest kind, "calls what it names". pad() truncates, so narrower cuts it off.
  return items.map((i) => `  ${pad(i.severity, 5)} ${pad(i.kind, 19)} ${i.file}${i.symbol ? ` › ${i.symbol}` : ''}\n        ${i.detail}`)
    .join('\n');
}

async function cmdOverlap(main, { positional, flags }) {
  const [x, y] = positional;
  if (!x || !y) fail('overlap needs two task ids or branch names');
  const graph = await loadGraph();
  const ts = graph.loadTs();
  const a = subjectFor(graph, main, x);
  const b = subjectFor(graph, main, y);
  let items;
  try {
    items = graph.overlaps(main, ts, a, b);
  } catch (e) {
    // A person verb reports its problem in one line; a stack trace here would read as a crash.
    fail(`overlap could not finish: ${e?.message ?? e}`);
  }
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(items)}\n`);
    return;
  }
  const out = [`overlap ${x} × ${y} — ${items.length ? `${items.length} overlap${items.length === 1 ? '' : 's'}` : 'none'}`];
  if (items.length) out.push(renderOverlaps(items));
  if (!ts) out.push('(TypeScript not found beside scripts/ — file-level answers only)');
  process.stdout.write(`${out.join('\n')}\n`);
}

/** Exit code for a spawn that stopped on overlaps: not an error, and not a success either. */
const SPAWN_STOPPED = 2;

/**
 * `spawn <id> [--proceed] [--branch <b>]`: start a parked task in parallel, in its own worktree.
 *
 * This is what stops parked findings being serialized behind whatever is in flight. It checks
 * the finding against EVERY active task first, and on any overlap it stops with nothing created
 * and shows how big each one is — the operator's call (user, 2026-09-10: "warn, but don't
 * automatically proceed … the operator should know how big these overlaps are first"). With no
 * overlap, or with --proceed after reading them, it cuts a worktree from main, claims the task
 * there, leaves the overlap report as the new session's first handoff, and prints the one command
 * that starts that session. It never starts a session itself.
 */
async function cmdSpawn(main, { positional, flags }) {
  const id = positional[0];
  if (!id) fail('spawn needs a task id');
  const task = findTask(main, id);
  if (!task) fail(`no task ${id}`);
  if (task.fm.status !== 'open') fail(`${id} is ${task.fm.status} — only an open (parked) task can be spawned`);

  const fetched = fetchOrigin(main);
  const graph = await loadGraph();
  const ts = graph.loadTs();
  const ref = graph.defaultRef(main);
  if (!ref) fail('no default branch to spawn from (origin/main, main, …)');
  const refSha = git(['rev-parse', ref], main) ?? '';

  let items = [];
  let compared = 0;
  let finding;
  const unclosed = []; // active in the record, with neither a worktree nor a branch left
  try {
    finding = graph.subjectFromTask(main, task.fm, task.body);
    // Every active task, its folder gone or not: a removed worktree's branch can still hold
    // unmerged commits, and subjectFromTask reads it from the branch.
    for (const t of listTasks(main)) {
      if (t.fm.status !== 'active') continue;
      const branch = t.fm.branch && t.fm.branch !== 'HEAD' ? git(['rev-parse', '--verify', '--quiet', `refs/heads/${t.fm.branch}`], main) : null;
      if (!(t.fm.worktree && existsSync(t.fm.worktree)) && !branch) unclosed.push(t.fm.id);
      compared++;
      items.push(...graph.overlaps(main, ts, graph.subjectFromTask(main, t.fm, t.body), finding));
    }
  } catch (e) {
    fail(`spawn could not check for overlaps: ${e?.message ?? e}`);
  }
  items = items.sort((p, q) => graph.SEVERITY[p.severity] - graph.SEVERITY[q.severity] || p.file.localeCompare(q.file));
  const report = renderOverlaps(items);
  const notes = [
    fetched ? null : `(could not fetch origin — checked against the local ${ref})`,
    ts ? null : '(TypeScript not found beside scripts/ — file-level answers only)',
    // Checked from its file list alone. If an overlap above names one of these, the task is
    // probably finished and never closed: `drop` it, rather than --proceed past it.
    unclosed.length ? `(active in the record but with no worktree or branch left: ${unclosed.join(', ')} — \`work.mjs drop <id>\` if it is finished)` : null,
  ].filter(Boolean);
  // A finding's footprint IS its file list. With none, there was nothing to check — and "none
  // found" would be a claim the check never earned, so it stops for the operator like an overlap.
  // So does a path that is not in the repo (a new file, or a typo): what calls it cannot be
  // checked. Only when there was something to check it AGAINST: with no active task, there is no
  // overlap to miss, and the rule is that no overlap proceeds.
  const unchecked = compared > 0 && listField(task.fm.files).length === 0;
  const unknown = compared > 0 ? finding.unknown : [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const unknownLine = unknown.length
    ? `It names ${plural(unknown.length, 'path')} not in ${ref} — ${unknown.join(', ')} — a new file, or a typo? Only a path that exists can be checked for what calls it.`
    : null;

  if ((items.length || unchecked || unknown.length) && !flags.proceed) {
    process.stdout.write([
      items.length
        ? `spawn ${id} — STOPPED: ${plural(items.length, 'overlap')} with active tasks. Nothing created.`
        : unchecked
          ? `spawn ${id} — STOPPED: it names no files, so nothing could be checked against the active tasks. Nothing created.`
          : `spawn ${id} — STOPPED: part of what it names could not be checked. Nothing created.`,
      ...(items.length ? [report] : []),
      ...(unknownLine ? [unknownLine] : []),
      ...notes,
      'Re-run with --proceed to create the worktree anyway.',
    ].join('\n') + '\n');
    process.exit(SPAWN_STOPPED);
  }

  const slug = id.replace(/^\d{8}-/, '') || id;
  const path = join(main, '.claude', 'worktrees', slug);
  const branch = typeof flags.branch === 'string' && flags.branch ? flags.branch : `work/${slug}`;
  // Every refusal happens BEFORE anything is created, so a refused spawn leaves nothing behind.
  if (existsSync(path)) fail(`${path} already exists — remove it, or spawn with a different task`);
  if (parseWorktrees(main).some((w) => w.path === path)) {
    fail(`${path} is still registered with git though its folder is gone — run \`git worktree prune\` first`);
  }
  const stale = activeTaskFor(main, path);
  if (stale) fail(`${stale.fm.id} is still marked active in ${path} — close it (done/drop) before spawning there`);
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], main)) fail(`branch ${branch} already exists — pass --branch <name>`);

  // --no-track: without it the new branch's upstream is main itself, and a bare `git push` from
  // the spawned session fails because the upstream's name does not match the branch's.
  try {
    execFileSync('git', ['worktree', 'add', '--no-track', path, '-b', branch, ref], { cwd: main, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  } catch (e) {
    const stderr = String(e?.stderr ?? '');
    // git creates the -b branch BEFORE it checks the path, so a failed add can leave the branch —
    // unless it failed BECAUSE the branch exists, in which case it is someone else's to keep.
    if (!/a branch named .* already exists/.test(stderr)) gitRaw(['branch', '-D', branch], main);
    // The reason, not the preamble: git prints "Preparing worktree (…)" before its fatal line.
    const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
    const reason = [...lines].reverse().find((l) => /^(fatal|error):/.test(l)) ?? lines[lines.length - 1] ?? 'no detail';
    fail(`git worktree add ${path} failed: ${reason}`);
  }
  const undo = () => {
    gitRaw(['worktree', 'remove', '--force', path], main);
    gitRaw(['branch', '-D', branch], main);
  };

  const handoff = [
    `Spawned by \`work.mjs spawn\` into ${path} on ${branch}, from ${ref} ${refSha.slice(0, 7)}.`,
    '',
    items.length
      ? `Overlap check: ${plural(items.length, 'overlap')} with active tasks — the operator read them and proceeded (--proceed):\n\n${report}`
      : unchecked
        ? 'Overlap check: NOT POSSIBLE — the task names no files, so nothing was compared; the operator proceeded (--proceed).'
        : compared ? 'Overlap check: none with any active task.' : 'Overlap check: no other task was active.',
    ...(unknownLine ? [`${unknownLine} The operator proceeded (--proceed).`] : []),
    ...notes,
  ].join('\n');
  const here = worktreeOf(path);
  const error = here ? claimInto(main, id, here, false, handoff) : 'the new worktree could not be resolved';
  if (error) {
    undo();
    fail(`could not claim ${id} in the new worktree, so it was removed again (worktree and branch): ${error}`);
  }

  const stack = nextFreeStack(main);
  process.stdout.write([
    `spawned ${id} into ${path} on ${branch} (from ${ref} ${refSha.slice(0, 7)})`,
    // What --proceed went past, as it stands NOW — the overlaps are recomputed on every run, so
    // this, not the report read before, is what the new task's handoff records.
    ...(items.length ? [`Proceeded past ${plural(items.length, 'overlap')}:`, report] : []),
    ...(unchecked ? ['Proceeded without an overlap check: the task names no files.'] : []),
    ...(unknownLine ? [`Proceeded past: ${unknownLine}`] : []),
    ...notes,
    '',
    'Start a session there — it must be LAUNCHED there, or none of the record\'s hooks fire:',
    `  cd ${shellQuote(path)} && claude`,
    '',
    `Tests need their own local Supabase stack first: scripts/second-stack.sh ${stack ?? '<N>'} (inside it).`,
  ].join('\n') + '\n');
}

/**
 * `integrate [<id>] [--json]`: before a task lands, what changed under it and whom it affects.
 *
 * The successor to integrate-two, reshaped for many tasks landing one at a time instead of two
 * features known up front. It reports two things and changes nothing: what main has landed since
 * this task's base that the task touches or calls (with the commits that did it), and which other
 * active tasks this one overlaps — who needs to know when it lands. Then it names the steps. The
 * merge, the gates and the focused review are the `/integrate` command's, where a person can stop
 * them; this verb only ever reads.
 */
async function cmdIntegrate(main, cwd, { positional, flags }) {
  const id = positional[0];
  const task = id ? findTask(main, id) : activeTaskFor(main, worktreeOf(cwd));
  if (!task) fail(id ? `no task ${id}` : 'no active task in this worktree — pass a task id');
  if (task.fm.status !== 'active' || !task.fm.worktree || !existsSync(task.fm.worktree)) {
    fail(`${task.fm.id} is not active in an existing worktree — integrate is for work in progress`);
  }

  const fetched = fetchOrigin(main);
  const graph = await loadGraph();
  const ts = graph.loadTs();
  let landed = [];
  const affects = [];
  let moved = null;
  try {
    const self = graph.subjectFromTask(main, task.fm, task.body);
    // The task's OWN base, which subjectFromTask computed behind its guard: re-deriving it with a
    // plain merge-base in a folder that has lost its `.git` would ask the enclosing main checkout
    // instead, and report "nothing landed" about a task main has moved a long way under.
    const m = graph.mainSince(main, task.fm.worktree, task.fm.base);
    moved = m && { ...m, base: self.base };
    if (!moved) fail('no default branch (origin/main, main, …) to compare this task against');
    landed = graph.overlaps(main, ts, moved, self);
    for (const t of listTasks(main)) {
      if (t.fm.id === task.fm.id || t.fm.status !== 'active') continue; // folder gone or not, as in spawn
      affects.push(...graph.overlaps(main, ts, self, graph.subjectFromTask(main, t.fm, t.body)));
    }
  } catch (e) {
    fail(`integrate could not finish: ${e?.message ?? e}`);
  }
  // Which commits on main did it, so the review starts from the change rather than the file. Main
  // is sometimes the CALLER — the task changed a function and main added a use of it — and then
  // main's commits are in the calling files, not in the file that declares the function.
  for (const item of landed) {
    if (!item.file) { item.commits = []; continue; } // a `?` row: the check itself, not a change
    const paths = item.changer && item.changer !== moved.label ? (item.callers ?? [item.file]) : [item.file];
    item.commits = (git(['log', '--format=%h %s', '-n', '3', `${moved.base}..${moved.ref}`, '--', ...paths], main) ?? '')
      .split('\n').filter(Boolean);
  }
  const detached = git(['rev-parse', '--abbrev-ref', 'HEAD'], task.fm.worktree) === 'HEAD';
  if (flags.json) {
    process.stdout.write(`${JSON.stringify({
      task: task.fm.id, main: moved.label, base: moved.base, fetched, typescript: Boolean(ts), detached, landed, affects,
    })}\n`);
    return;
  }

  const mainLabel = moved.label;
  const count = (n) => `${n} overlap${n === 1 ? '' : 's'}`;
  // The base is printed because `/integrate` needs it AFTER the merge, when a merge-base would be
  // main itself — and a diff from there hides main's side of every item below.
  const out = [`integrate ${task.fm.id} — ${basename(task.fm.worktree)} on ${task.fm.branch || '(unknown branch)'}`,
    `base: ${moved.base}   (compared with ${mainLabel} at ${moved.ref.slice(0, 7)})`];
  if (!fetched) out.push(`(could not fetch origin — compared against the local ${mainLabel})`);
  if (!ts) out.push('(TypeScript not found beside scripts/ — file-level answers only)');
  if (detached) out.push('(this worktree is on a detached HEAD — `git switch -c <branch>` before merging, or the merge has no branch to keep it)');
  out.push('', `LANDED ON ${mainLabel} SINCE THIS TASK'S BASE — ${landed.length ? count(landed.length) : 'none that this task touches or calls'}`);
  for (const item of landed) {
    out.push(renderOverlaps([item]));
    for (const c of item.commits) out.push(`          ${c}`);
  }
  out.push('', `WHOM YOU AFFECT — ${affects.length ? `${count(affects.length)} with other active tasks` : 'no other active task overlaps this one'}`);
  if (affects.length) out.push(renderOverlaps(affects));
  const generated = landed.some((i) => i.kind === 'generated file');
  out.push(
    '',
    'NEXT',
    `  1. git merge ${mainLabel}   (in ${task.fm.worktree} — merge, never rebase: the branch may be pushed)`,
    ...(generated ? ['  2. regenerate each generated file flagged above (the command is in its row) — never merge it by hand'] : []),
    `  ${generated ? 3 : 2}. npm run typecheck && npm run lint && npm test && npm run build`,
    `  ${generated ? 4 : 3}. review only the items above — the combination, not each side again`,
    `  ${generated ? 5 : 4}. npm run work -- integrate ${task.fm.id}   (clean = nothing left from ${mainLabel})`,
  );
  process.stdout.write(`${out.join('\n')}\n`);
}

/** How recent a session's last transcript write must be for its worktree to count as in use. */
const LIVE_SESSION_MS = 24 * 60 * 60 * 1000;

/**
 * How prune reads OTHER worktrees: never taking their index lock — a plain `status` refreshes
 * the index under one that "may conflict with other simultaneous processes" (git-status(1),
 * BACKGROUND REFRESH), a live session's commit included — and never for longer than this. A
 * read that times out is null, and null keeps the worktree.
 */
const READ_ONLY = ['--no-optional-locks'];
const PRUNE_GIT_MS = 30000;

/**
 * Proof, by COMMIT, that a worktree's branch is merged: its tip is already on the default
 * branch, or GitHub has a merged PR whose head was exactly that tip. The name alone proves
 * nothing — `mergedLabel` (the board's) matches on it, and spawn's `work/<slug>` names recur, so a
 * new branch can share a name with a merged one while holding commits that were never pushed.
 */
function mergeProof(wt, main, def) {
  if (!wt.head) return null;
  if (def && git(['merge-base', '--is-ancestor', wt.head, def], main) !== null) return `on ${def}`;
  if (!wt.branch) return null;
  try {
    const out = execFileSync('gh', ['pr', 'list', '--state', 'merged', '--head', wt.branch, '--json', 'number,headRefOid'], {
      cwd: main, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000,
    });
    const pr = (JSON.parse(out) ?? []).find((p) => p.headRefOid === wt.head);
    return pr ? `merged PR #${pr.number}` : null;
  } catch {
    return null;
  }
}

/** `project_id` from a checkout's supabase/config.toml, or null. */
function projectIdOf(dir) {
  try {
    return /^project_id\s*=\s*"([^"]+)"/m.exec(readFileSync(join(dir, 'supabase', 'config.toml'), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether two project ids can name the same running stack. The CLI sanitises `project_id` when it
 * loads config.toml — every run of other characters to `_`, leading `_.-` trimmed, cut to 40 —
 * and labels containers with that, so two ids that differ only past character 40 share one stack.
 * Used only to decide NOT to stop something: erring toward "same" can leave a stack up, never
 * take one down.
 *
 * Supabase CLI v2.107.0 (the repo's pin; its npm `stop` proxies to the Go implementation,
 * https://github.com/supabase/cli/blob/v2.107.0/apps/cli/src/legacy/commands/stop/stop.handler.ts#L5-L14):
 * sanitizeProjectId and its plain byte cut, https://github.com/supabase/cli/blob/v2.107.0/apps/cli-go/pkg/config/config.go#L1036-L1053,
 * applied on load at https://github.com/supabase/cli/blob/v2.107.0/apps/cli-go/pkg/config/config.go#L825-L829.
 */
function sameStack(x, y) {
  return x === y || stackLabel(x) === stackLabel(y);
}

/** The id Supabase actually labels a project's containers with: sanitised, capped at 40. */
function stackLabel(id) {
  return id.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^[_.-]+/, '').slice(0, 40);
}

/**
 * The newest moment any Claude session was working inside `path`: its own project folder, AND
 * every transcript of this repo written in the last day whose recent entries ran there. A session
 * launched in the main checkout that then entered a worktree keeps writing its transcript under
 * the MAIN checkout's folder, with `cwd` set to the worktree — so the worktree's own folder alone
 * says "no session" about exactly how this repo is usually worked.
 */
function sessionActivityIn(main, path) {
  let newest = lastSessionActivity(path) ?? 0;
  const root = join(homedir(), '.claude', 'projects');
  const quoted = JSON.stringify(path);
  const needles = [`"cwd":${quoted}`, `"cwd":${quoted.slice(0, -1)}/`];
  let dirs = [];
  try { dirs = readdirSync(root).filter((d) => d.startsWith(encodeProjectDir(main))); } catch { return newest || null; }
  for (const dir of dirs) {
    let names = [];
    try { names = readdirSync(join(root, dir)); } catch { continue; }
    // Subagents too, under <session>/subagents/: a worktree-isolated subagent is clean and "on
    // main" until its first commit — exactly the shape prune would otherwise remove mid-run.
    const files = [];
    for (const name of names) {
      if (name.endsWith('.jsonl')) { files.push(join(root, dir, name)); continue; }
      try {
        for (const sub of readdirSync(join(root, dir, name, 'subagents'))) {
          if (sub.endsWith('.jsonl')) files.push(join(root, dir, name, 'subagents', sub));
        }
      } catch { /* not a session directory */ }
    }
    for (const file of files) {
      let stat;
      try { stat = statSync(file); } catch { continue; }
      // mtime is the cheap upper bound, never the answer: an entry can only be older than the
      // file, so a file whose mtime already loses is skippable without reading it.
      if (Date.now() - stat.mtimeMs > LIVE_SESSION_MS || stat.mtimeMs <= newest) continue;
      // Only the tail: where a session is NOW is in its latest entries, and transcripts run long.
      const tail = readTail(file, 256 * 1024);
      if (!needles.some((n) => tail.includes(n))) continue;
      const when = newestEntryTime(tail) || stat.mtimeMs;
      if (when > newest) newest = when;
    }
  }
  return newest || null;
}

function readTail(file, bytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const buf = Buffer.alloc(Math.min(bytes, size));
    readSync(fd, buf, 0, buf.length, Math.max(0, size - buf.length));
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

/**
 * When a transcript slice says its session last DID something — read from the entries, never from
 * the file's mtime.
 *
 * A transcript's mtime is not its session's clock. Claude Code appends a summary record when a
 * session ends, and other tooling rewrites transcripts long after the last turn, so mtime runs
 * ahead of the conversation by hours or days. Measured 2026-09-17: three finished worktrees were
 * all held with "a session worked here 4m ago" — a label that reads as "someone is typing in there
 * right now" — when the newest real entry in each transcript was 2026-09-16T20:35Z, 27.3 hours
 * before the run. The window is 24h, so this was not a cosmetic slip in the label: the KEEP itself
 * was wrong, and every later run would have repeated it, because mtime only ever moves forward.
 * That is the failure mode to hold on to — a guard that never releases stops being a guard and
 * becomes a leak, and the operator who eventually overrides it has been taught to distrust it.
 *
 * Returns 0 when nothing parses, so callers fall back to mtime — fixtures and any transcript
 * format without per-entry timestamps keep working, and the fallback can only ever over-estimate
 * activity, which keeps a worktree rather than removing one.
 */
function newestEntryTime(text) {
  let newest = 0;
  for (const m of text.matchAll(/"timestamp":"([^"]{4,40})"/g)) {
    const t = Date.parse(m[1]);
    if (t > newest) newest = t;
  }
  return newest;
}

/**
 * An ignored path in a worktree that costs nothing to lose, because it is rebuilt on demand:
 * dependencies, build output, Supabase's scratch state, the `.env.test` second-stack.sh writes,
 * and a `.env` that is a byte-for-byte copy of the main checkout's. Anything else ignored — an
 * eval run's trajectories, `.scratch/` notes, an edited `.env` — is somebody's, and keeps the
 * worktree (see cmdPrune).
 */
function regenerable(main, path, p) {
  const bare = p.replace(/\/$/, '');
  if (bare === 'node_modules' || bare.endsWith('/node_modules') || bare === '.DS_Store' || bare.endsWith('/.DS_Store')) return true;
  // `supabase/.branches` and `.temp`: `supabase start` writes both (supabase/.gitignore) in every
  // worktree that has run a stack — without them here, prune would keep every one of those.
  if (['dist', '.env.test', 'supabase/.temp', 'supabase/.branches'].includes(bare)) return true;
  if (bare !== '.env') return false;
  try {
    return readFileSync(join(path, '.env')).equals(readFileSync(join(main, '.env')));
  } catch {
    return false;
  }
}

/** The config.toml sections scripts/second-stack.sh turns off — keep the two in step. */
const STACK_TRIMMED = new Set(['analytics', 'studio', 'realtime']);

/**
 * True when the only change to supabase/config.toml is what scripts/second-stack.sh writes: the
 * project_id, the port lines, and `enabled = false` in the sections it trims. Anything else in
 * that file is real work, and prune would throw it away with the `git checkout` it needs before
 * `git worktree remove` will agree — so the trim is matched by SECTION, not by the line alone:
 * `enabled = false` under `[storage]` or `[auth]` is somebody's edit and keeps the worktree.
 */
function onlyStackRewrite(path) {
  const diff = gitRaw([...READ_ONLY, 'diff', '--unified=0', '--', 'supabase/config.toml'], path, { timeout: PRUNE_GIT_MS }) ?? '';
  let file;
  try {
    file = readFileSync(join(path, 'supabase', 'config.toml'), 'utf8').split('\n');
  } catch {
    return false;
  }
  // The section a line of the WORKING file sits in: the nearest `[header]` above it.
  const sectionAt = (n) => {
    for (let i = n - 1; i >= 0; i -= 1) {
      const m = /^\[([^\]]+)\]/.exec(file[i] ?? '');
      if (m) return m[1];
    }
    return '';
  };
  let line = 0; // 1-based line number in the working file of the next `+` line
  let changed = 0;
  for (const l of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(l);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (!/^[+-]/.test(l) || /^(\+\+\+|---)/.test(l)) continue;
    changed += 1;
    const body = l.slice(1);
    // `#?`: the script shifts every line mentioning a port, commented-out ones included
    // (`# smtp_port = 54325`), so those are part of its rewrite too.
    const stack = /^\s*#?\s*(project_id|[a-z0-9_]*port)\s*=/.test(body)
      || (l[0] === '-' && body.trim() === 'enabled = true')
      || (l[0] === '+' && body.trim() === 'enabled = false' && STACK_TRIMMED.has(sectionAt(line)));
    if (!stack) return false;
    if (l[0] === '+') line += 1;
  }
  return changed > 0;
}

/**
 * `prune [--apply]`: remove worktrees whose work is finished — and only those.
 *
 * Stale worktrees never close on their own (Claude Code's sweep skips interactive ones, and a
 * squash merge leaves every branch looking unmerged to git), so they pile up holding stacks and
 * stale pictures of the code. This removes a worktree only when nothing can be lost. KEEP, always:
 * the main checkout; the worktree prune is running from; a locked one; one with an active task;
 * one any session worked in during the last day; one git cannot read the status of; one with any
 * uncommitted or untracked file (bar a config.toml second-stack.sh rewrote and nothing else), or
 * any ignored one that is not regenerable (see regenerable); a branch without a merge proof by
 * commit. Dry run by default; `--apply` acts, row by row, and exits 1 if any row failed.
 *
 * A stack is stopped only AFTER every worktree using it is gone, from a throwaway folder holding a
 * copy of its config (see stopStack) — never inside a real checkout, where `supabase stop` acts on
 * whatever that checkout's config names and in one without its own config stops the PRIMARY stack
 * (engineering memory, 2026-08-19). Never a stack another kept worktree still uses.
 */
function cmdPrune(main, cwd, { flags }) {
  const refs = mainRefs(main);
  const def = refs[0] ?? null;
  const mainProject = projectIdOf(main);
  const here = worktreeOf(cwd);
  // Never deleted, whatever worktree holds them: the branches this clone treats as main.
  const keepBranches = new Set([...refs.map((r) => r.replace(/^origin\//, '')), git(['rev-parse', '--abbrev-ref', 'HEAD'], main)]);
  const tasks = listTasks(main);
  const rows = [];
  for (const wt of parseWorktrees(main)) {
    if (wt.path === main) continue;
    const row = { wt, name: basename(wt.path), branch: wt.detached ? '(detached)' : wt.branch || '—' };
    if (wt.prunable) {
      const folder = existsSync(wt.path) ? 'its folder is still on disk and is left there' : 'its folder is gone';
      rows.push({ ...row, remove: true, why: `registration only — git's link to it is broken; ${folder}`, prunable: true });
      continue;
    }
    row.project = projectIdOf(wt.path);
    const canonical = worktreeOf(wt.path) ?? wt.path;
    const active = tasks.find((t) => t.fm.status === 'active' && t.fm.worktree === canonical);
    const session = sessionActivityIn(main, wt.path);
    // Ignored files too (`!!`): `git worktree remove` deletes them with the folder without a word,
    // and "ignored" here covers eval runs, scratch notes and a hand-edited .env as well as
    // node_modules. Null is not clean: a status git could not produce proves nothing.
    const raw = gitRaw([...READ_ONLY, 'status', '--porcelain', '--untracked-files=all', '--ignored=matching'], wt.path, { timeout: PRUNE_GIT_MS });
    const lines = (raw ?? '').split('\n').filter(Boolean);
    const status = lines.filter((l) => !l.startsWith('!! '));
    const ignored = lines.filter((l) => l.startsWith('!! ')).map((l) => l.slice(3)).filter((p) => !regenerable(main, wt.path, p));
    const rewritten = status.includes(' M supabase/config.toml') && onlyStackRewrite(wt.path);
    const dirty = status.filter((l) => !(l === ' M supabase/config.toml' && rewritten));
    let proof = null;
    const keep = (why) => rows.push({ ...row, remove: false, why });
    if (canonical === here) keep('prune is running from inside it');
    else if (wt.locked) keep('locked (git worktree lock) — unlock it first if it is really finished');
    else if (active) keep(`active task ${active.fm.id}`);
    else if (session && Date.now() - session < LIVE_SESSION_MS) keep(`a session worked here ${ageLabel(session)} ago`);
    else if (raw === null) keep('git could not read its status — look at it by hand');
    else if (dirty.length) keep(`uncommitted: ${dirty.length} file${dirty.length === 1 ? '' : 's'}`);
    else if (ignored.length) {
      const shown = ignored.slice(0, 3).join(', ') + (ignored.length > 3 ? ` and ${ignored.length - 3} more` : '');
      keep(`ignored files that removing it would delete: ${shown} — move them, or delete them by hand`);
    } else if (!(proof = mergeProof(wt, main, def))) {
      const counts = def ? git(['rev-list', '--left-right', '--count', `${def}...${wt.head}`], main) : null;
      const [behind, ahead] = counts ? counts.split(/\s+/) : ['?', '?'];
      keep(`no merge proof (behind ${behind}, ahead ${ahead}) — decide by hand`);
    } else {
      // An id that sanitises to NOTHING is never stopped: the CLI would filter on the bare label,
      // which matches every Supabase stack on the machine — the primary one included.
      const own = row.project && stackLabel(row.project) && mainProject && !sameStack(row.project, mainProject);
      rows.push({ ...row, remove: true, why: proof, rewritten, stack: own ? row.project : null });
    }
  }
  // A stack still used by a worktree that stays is not this worktree's to stop.
  for (const r of rows) {
    if (!r.stack) continue;
    const sharer = rows.find((k) => !k.remove && k.project && sameStack(k.project, r.stack));
    if (sharer) { r.sharedWith = sharer.name; r.stack = null; }
  }

  const removable = rows.filter((r) => r.remove);
  const out = [`PRUNE — ${rows.length} worktree${rows.length === 1 ? '' : 's'} besides the main checkout${flags.apply ? '' : ' (dry run)'}`];
  for (const r of rows) {
    const verdict = r.remove ? 'REMOVE' : 'KEEP';
    const stack = r.stack ? ` · then stop its stack ${r.stack}`
      : r.sharedWith ? ` · its stack is shared with ${r.sharedWith}, left running`
        : r.remove && !r.prunable ? ' · no own stack' : '';
    const branch = r.remove && r.wt.branch && keepBranches.has(r.wt.branch) ? ` · branch ${r.wt.branch} kept` : '';
    out.push(`  ${pad(verdict, 7)} ${pad(r.name, 30)} ${pad(r.branch, 34)} ${r.why}${stack}${branch}`);
  }
  if (!flags.apply) {
    out.push('', removable.length
      ? `Nothing removed. Re-run with --apply to remove ${removable.length}.`
      : 'Nothing to remove.');
    process.stdout.write(`${out.join('\n')}\n`);
    return;
  }

  out.push('');
  let failed = false;
  let pruneRegistrations = false;
  for (const r of removable) {
    if (r.prunable) { pruneRegistrations = true; continue; }
    // The stack's config, read BEFORE the folder holding it goes (see stopStack).
    if (r.stack) {
      try { r.stackConfig = readFileSync(join(r.wt.path, 'supabase', 'config.toml'), 'utf8'); } catch { r.stack = null; }
    }
    r.result = removeWorktree(main, r, keepBranches);
    if (!r.result.ok) failed = true;
    out.push(`  ${r.result.removed ? 'removed' : 'KEPT   '} ${r.name} — ${r.result.note}`);
  }
  // Stacks last, once each, and only when EVERY worktree using that stack is actually gone:
  // stopping with --no-backup deletes the stack's data, which must never happen under a worktree
  // that ended up staying because its own removal failed.
  const stopped = new Set();
  for (const r of removable) {
    if (!r.stack || [...stopped].some((s) => sameStack(s, r.stack))) continue;
    stopped.add(r.stack);
    const users = removable.filter((u) => u.stack && sameStack(u.stack, r.stack));
    const stayed = users.filter((u) => !u.result?.removed);
    if (stayed.length) {
      failed = true;
      out.push(`  stack ${r.stack} left running — ${stayed.map((u) => u.name).join(', ')} could not be removed`);
    } else if (stopStack(main, r.stackConfig)) {
      out.push(`  stack ${r.stack} stopped (its data volumes deleted)`);
    } else {
      failed = true;
      out.push(`  stack ${r.stack} could NOT be stopped — run: npx supabase stop --no-backup --project-id ${stackLabel(r.stack)}`);
    }
  }
  if (pruneRegistrations) {
    if (gitRaw(['worktree', 'prune'], main) === null) {
      failed = true;
      out.push('  could not drop the broken registrations — run `git worktree prune`');
    } else {
      out.push('  dropped the registrations git reported as broken (any folder left on disk is untouched)');
    }
  }
  process.stdout.write(`${out.join('\n')}\n`);
  if (failed) process.exit(1);
}

/**
 * Stop a removed worktree's stack by running the repo's own Supabase CLI in a throwaway folder
 * holding only a copy of that worktree's config.toml. Not `--project-id`: `start` labels
 * containers with a sanitised, length-capped id (see sameStack) while `stop --project-id` filters
 * on the id exactly as typed (https://github.com/supabase/cli/blob/v2.107.0/apps/cli-go/internal/stop/stop.go#L19-L24),
 * so a long worktree name turns a raw-id stop into a silent no-op. From the config, the CLI works the
 * id out exactly as `start` did. And never inside a real checkout, where `supabase stop` acts on
 * whatever that checkout's config names — in the main checkout, the PRIMARY stack.
 */
function stopStack(main, config) {
  const scratch = mkdtempSync(join(tmpdir(), 'work-prune-stack-'));
  try {
    mkdirSync(join(scratch, 'supabase'), { recursive: true });
    writeFileSync(join(scratch, 'supabase', 'config.toml'), config);
    // The pinned CLI, not whatever `npx` would fetch; npx only when the repo has none installed.
    const pinned = join(main, 'node_modules', '.bin', 'supabase');
    const [cmd, args] = existsSync(pinned) ? [pinned, ['stop', '--no-backup']] : ['npx', ['supabase', 'stop', '--no-backup']];
    execFileSync(cmd, args, { cwd: scratch, stdio: 'ignore', timeout: 120000 });
    return true;
  } catch {
    return false;
  } finally {
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* a temp dir */ }
  }
}

/**
 * Take one proven-finished worktree apart, reversible step first. The config.toml second-stack.sh
 * rewrote is put back (a copy kept), then `git worktree remove` WITHOUT --force — the one step
 * git can refuse, and if it does, config.toml is restored. Then the branch. The stack is NOT
 * stopped here: cmdPrune does that last, once every worktree using it is known to be gone.
 */
function removeWorktree(main, r, keepBranches) {
  const path = r.wt.path;
  const configFile = join(path, 'supabase', 'config.toml');
  let saved = null;
  if (r.rewritten) {
    try { saved = readFileSync(configFile, 'utf8'); } catch { return { ok: false, removed: false, note: 'could not read its config.toml — left exactly as it was' }; }
    gitRaw(['checkout', '--', 'supabase/config.toml'], path);
  }
  if (gitRaw(['worktree', 'remove', path], main) === null) {
    // git can fail part-way — registration dropped, some files left — so say which it was.
    if (parseWorktrees(main).some((w) => w.path === path)) {
      if (saved !== null) try { writeFileSync(configFile, saved); } catch { /* reported by the note */ }
      return { ok: false, removed: false, note: 'git refused to remove it (it changed since the check?) — left as it was' };
    }
    return { ok: false, removed: false, note: `git dropped its registration but could not delete everything in ${path} — look before deleting the rest` };
  }
  const notes = ['worktree removed'];
  let ok = true;
  // Deleted by the COMMIT the merge proof was about, never by name: `update-ref -d <ref> <old>`
  // deletes only while the branch still points there. A commit landing in the worktree after the
  // check — from a terminal, or a session whose transcript this could not see — would leave it
  // clean, so `worktree remove` goes through; `branch -D` would then take that commit with it.
  // Not `-d` either: it checks against the MAIN checkout's HEAD and refuses a squash merge. And
  // never a branch this clone treats as main, whichever worktree happened to hold it.
  if (r.wt.branch && keepBranches.has(r.wt.branch)) notes.push(`branch ${r.wt.branch} kept (a main branch)`);
  else if (r.wt.branch) {
    const deleted = gitRaw(['update-ref', '-d', `refs/heads/${r.wt.branch}`, r.wt.head], main) !== null;
    if (deleted) gitRaw(['config', '--remove-section', `branch.${r.wt.branch}`], main); // its upstream settings, if any
    else ok = false;
    notes.push(deleted ? `branch ${r.wt.branch} deleted`
      : `branch ${r.wt.branch} KEPT — it no longer points at the commit proven merged (did a commit land after the check?)`);
  }
  return { ok, removed: true, note: notes.join('; ') };
}

/** A path as a shell word: bare when it is safe, single-quoted when it is not. */
function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * Best-effort `git fetch origin`, bounded so a dead network cannot hang the verb.
 *
 * Never allowed to ASK for anything. `stdio: 'ignore'` does not stop git prompting: it opens the
 * terminal itself for a username, a passphrase or a host key, and when the timeout then kills
 * `git fetch`, its credential helper survives, still reading that terminal — and swallows the
 * operator's next typed line. So prompting is switched off at every layer that can do it.
 */
function fetchOrigin(main) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  if (!env.GIT_SSH_COMMAND && !git(['config', '--get', 'core.sshCommand'], main)) {
    env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';
  }
  try {
    execFileSync('git', ['fetch', '--quiet', 'origin'], { cwd: main, stdio: 'ignore', timeout: 30000, env });
    return true;
  } catch {
    return false;
  }
}

/**
 * The lowest stack index scripts/second-stack.sh can use without colliding: it shifts the API
 * port to 54(3+N)21, so every worktree's config.toml says which N it already holds.
 */
function nextFreeStack(main) {
  const used = new Set();
  for (const wt of parseWorktrees(main)) {
    let text = '';
    try { text = readFileSync(join(wt.path, 'supabase', 'config.toml'), 'utf8'); } catch { continue; }
    const m = /^port = 54(\d)21$/m.exec(text);
    if (m) used.add(Number(m[1]) - 3);
  }
  for (let n = 1; n <= 6; n++) if (!used.has(n)) return n;
  return null;
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
      cur = { path: line.slice(9), branch: '', head: '', prunable: false, detached: false, locked: false };
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '');
    else if (line.startsWith('prunable')) cur.prunable = true;
    else if (line === 'detached') cur.detached = true;
    else if (line === 'locked' || line.startsWith('locked ')) cur.locked = true;
  }
  if (cur) out.push(cur);
  return out;
}

/** Newest session activity for a working directory, via Claude Code's per-directory project dir. */
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
      const file = join(dir, name);
      // The entries' own clock, not the file's — see newestEntryTime. mtime is the fallback.
      let when = 0;
      try { when = newestEntryTime(readTail(file, 256 * 1024)) || statSync(file).mtimeMs; } catch { continue; }
      if (when > newest) newest = when;
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
    // /park only, never the raw verb: /park asks the operator first (user, 2026-09-14), and a hint
    // that offers the bare command teaches a session to skip that question.
    out.push('  none — /park puts an item here, after the operator says yes');
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

/**
 * A session that must run a worktree's hooks WITHOUT owning its task sets WORK_RECORD_READONLY.
 *
 * The case this exists for: a `claude -p` verification probe, launched inside an implementation
 * worktree because that is the only way that worktree's hooks fire at all. Measured 2026-09-11 —
 * the probe edited a file, reverted it, and left behind a `files:` entry on the IMPLEMENTATION
 * task plus a `.snapshot.json` overwritten with the probe's edit. Both had to be cleaned by hand.
 *
 * Why that is not cosmetic: `files:` is an INPUT, not a log. The pre-edit hook's SIBLING line and
 * every `overlap`/`spawn` check read it, so one probe's footprint becomes a standing false "a
 * sibling has touched this file" in every other session, and can stop a spawn on a file the task
 * never changed. So the gate covers exactly the two verbs a hook WRITES with; `packet` only
 * reads, and a read-only session should still get its context.
 *
 * Two things it deliberately does not do. A probe verifying `touch` or `snapshot` THEMSELVES must
 * not set it — it would be grading a disabled feature. And it gates a separately launched
 * PROCESS: an Agent-tool subagent shares the parent's environment, so its edits stay recorded,
 * which is right, because they are the task's edits.
 *
 * Forgiving about the value on purpose. The failure mode of this switch is SILENT — a probe that
 * sets `=true` and is not believed goes right back to corrupting the record with nothing on
 * screen to say so — so anything set and not plainly negative counts as on.
 */
function recordIsReadOnly() {
  const v = process.env.WORK_RECORD_READONLY;
  return Boolean(v) && !['0', 'false', 'no'].includes(v.trim().toLowerCase());
}

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
    // Runs after every edit in every session: swallow everything. Silent under the read-only
    // switch too — PostToolUse output lands in the transcript of a session that did not ask.
    try { if (!recordIsReadOnly()) cmdTouch(main, args.flags); } catch { /* never cost the user an edit */ }
    break;
  case 'snapshot':
    // Runs on every Stop and before every compaction: same policy, and the silence matters more
    // here — output on a Stop hook CONTINUES the turn.
    try { if (!recordIsReadOnly()) cmdSnapshot(main, cwd); } catch { /* never block a turn from ending */ }
    break;
  case 'handoff': cmdHandoff(main, cwd, args); break;
  case 'promote': cmdPromote(main, cwd, args); break;
  case 'archive': cmdArchive(main, args); break;
  case 'board': cmdBoard(main); break;
  case 'overlap': await cmdOverlap(main, args); break;
  case 'spawn': await cmdSpawn(main, args); break;
  case 'integrate': await cmdIntegrate(main, cwd, args); break;
  case 'prune': cmdPrune(main, cwd, args); break;
  default:
    process.stderr.write('work: usage: park | claim | done | drop | packet | touch | snapshot'
      + ' | handoff | promote | archive | board | overlap | spawn | integrate | prune\n');
    process.exit(1);
}
