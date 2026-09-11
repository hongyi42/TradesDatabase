// PreToolUse(Edit|Write) — hand the session the decisions that govern the file it is about
// to change, without the session having to know they exist.
//
// Why: this repo's decision record is ~150 documents plus a 3000-line engineering memory. A
// session cannot be expected to go looking, and by the time it would think to, it has already
// written the edit. So the record comes to it instead, at the one moment it matters.
//
// It now answers with two things, not one: what was DECIDED about this file (the committed
// record, via thoughts/by-file.json) and what is HAPPENING to it right now (the live work
// record — open findings, and sibling worktrees whose active task has touched it). The second
// is what no amount of reading can tell you, because it has not been committed anywhere yet.
//
// Contract (verified against https://code.claude.com/docs/en/hooks, 2026-09-09):
//   in  — JSON on stdin: { session_id, cwd, tool_name, tool_input: { file_path, ... } }
//   out — JSON on stdout: { hookSpecificOutput: { hookEventName, additionalContext } }, exit 0.
//         The docs put `additionalContext` UNDER hookSpecificOutput; the top-level form this
//         hook used until 2026-09-09 is undocumented and worked only by grace.
//
// This hook must never block an edit. Every failure path exits 0 silently.

import { readFileSync, readdirSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname, basename, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

// Mirrors scripts/decision-index.mjs:36 — below this, churn is ordinary maintenance.
const DRIFT_LOUD = 15;

const quiet = () => process.exit(0);

let input = '';
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  let evt;
  try {
    evt = JSON.parse(input);
  } catch {
    return quiet(); // a malformed payload must not cost the user an edit
  }
  main(evt).catch(quiet); // nor may anything that goes wrong after it
});

async function main(evt) {
  const filePath = evt?.tool_input?.file_path;
  if (!filePath) return quiet();

  const abs = isAbsolute(filePath) ? filePath : resolve(evt.cwd || process.cwd(), filePath);
  const root = resolveRoot(abs, evt);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..')) return quiet(); // outside the repo

  // Say it once per file per session. Repeating it on every edit to the same file burns
  // context to tell the session something it was already told — and asked FIRST, before any
  // record or graph work, because that work runs git in every sibling worktree and has no
  // business running for a file this session has already been told about.
  if (wasTold(evt.session_id, rel)) return quiet();

  // Best-effort, not a precondition: a worktree branched before the index existed still
  // deserves the LIVE record below. Requiring by-file.json here is what made this hook go
  // silent in exactly the checkouts that most need it.
  let byFile = {};
  try {
    byFile = JSON.parse(readFileSync(join(root, 'thoughts', 'by-file.json'), 'utf8'));
  } catch { /* no index, or an unreadable one */ }

  const hits = Array.isArray(byFile[rel]) ? byFile[rel] : [];
  const live = await recordLines(abs, root, rel, evt);
  if (hits.length === 0 && live.length === 0) return quiet();
  markTold(evt.session_id, rel);

  const lines = hits.map((h) => {
    const TAGS = {
      rule: 'REPO RULE',
      memory: 'ENGINEERING MEMORY',
      doc: 'DOC',
      // A promoted finding is ranked above every other document for this file, so it arrives
      // first. Without a tag of its own it would read as an ordinary dated document and the
      // ranking would buy nothing.
      finding: 'FINDING',
      superseded: 'SUPERSEDED — do not build on this',
    };
    const tag = TAGS[h.kind] ?? h.date ?? '';
    // A drifted document is not a wrong document. What it DECIDED still binds; what it said
    // about the code has rotted. Say which half to trust rather than "verify this".
    const signals = [];
    if (h.dead > 0) signals.push(`describes ${h.dead} file${h.dead > 1 ? 's' : ''} that no longer exist`);
    if (h.drift >= DRIFT_LOUD) signals.push(`code moved ${h.drift} commits since`);
    const note = signals.length
      ? `\n  ${signals.join('; ')} — ${
        h.durableFirm ? `its \`${h.durable}\` still binds`
          : h.durable ? `start from its \`${h.durable}\` for what still holds`
            : 'what it decided still holds'
      },`
        + ' its file/line references do not. Check the code, not the prose.'
      : '';
    return `- ${tag} · ${h.what}\n  ${h.where}${note}`;
  });

  const context = [];
  if (lines.length) {
    context.push(
      `Decisions on record for ${rel}:`,
      '',
      ...lines,
      '',
      'These are prior decisions about this exact file. Check them before changing its behaviour —'
        + ' re-deciding something already settled, or reviving something already rejected, is the'
        + ' failure this index exists to prevent. Where a note says the code has moved, the'
        + ' DECISION still stands; only the document\'s description of the code is stale.'
        + ' Full index: thoughts/INDEX.md',
    );
  }
  if (live.length) {
    if (context.length) context.push('');
    context.push(
      `In flight right now on ${rel}:`,
      '',
      ...live,
      '',
      'This is the LIVE work record (.claude/work/), not history — nothing here is committed yet.'
        + ' An OPEN FINDING is something already noticed about this file; read it before spending'
        + ' time rediscovering it. A SIBLING line means another session, in its own worktree, is'
        + ' changing this file or a function it imports right now — the names are what it changed,'
        + ' so coordinate rather than build on the old shape. MAIN MOVED means main changed a'
        + ' function this file imports since your task started: merge main before relying on it.'
        + ' See `npm run board`, and `npm run work -- overlap <a> <b>` for the full sized picture.',
    );
  }

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: context.join('\n') },
  }));
  process.exit(0);
}

/**
 * The repository root that OWNS the edited file — asked of git, not inferred from the session.
 *
 * `${CLAUDE_PROJECT_DIR}` stays at the directory the session launched from even after it enters
 * a worktree (documented behaviour), so the old `CLAUDE_PROJECT_DIR || cwd` produced a relative
 * path like `.claude/worktrees/x/src/a.ts` that matched no index key, and this hook fell silent
 * in every `--worktree` session — precisely the sessions running in parallel that most need it.
 */
function resolveRoot(abs, evt) {
  const top = askGit(abs, ['rev-parse', '--show-toplevel']);
  return top || process.env.CLAUDE_PROJECT_DIR || evt.cwd || process.cwd();
}

/** The main checkout, whose `.claude/work/` every worktree of this clone shares. */
function mainCheckoutOf(abs) {
  const common = askGit(abs, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return common ? resolve(common, '..') : null;
}

/**
 * Ask git about the file's location, from the nearest directory that actually exists.
 *
 * A `Write` creating `src/deep/new/file.ts` names directories that do not exist yet, and
 * `git -C <missing dir>` just fails — which would send this hook down its fallback path for
 * exactly the edits that introduce new modules.
 */
function askGit(abs, args) {
  let dir = dirname(abs);
  for (let i = 0; i < 64 && !existsSync(dir); i++) {
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const r = spawnSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.status === 0 ? (r.stdout ?? '').trim() : '';
}

/**
 * What is happening to this file right now, from the live record.
 *
 * The frontmatter reader is deliberately a small local copy rather than an import: this runs on
 * the critical path of every edit, and spawning scripts/work.mjs to ask would add a process per
 * keystroke-sized change. The canonical writer of this format is scripts/work.mjs.
 */
async function recordLines(abs, root, rel, evt) {
  const main = mainCheckoutOf(abs);
  if (!main) return [];
  const dir = join(main, '.claude', 'work', 'tasks');
  if (!existsSync(dir)) return [];

  const tasks = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    let fm;
    try { fm = frontmatter(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (fm.id) tasks.push(fm);
  }

  const out = [];
  // A task active in THIS worktree is the session's own work — it does not need telling.
  for (const fm of tasks) {
    if (fm.status === 'open' && fm.worktree !== root && listOf(fm.files).includes(rel)) {
      out.push(`- OPEN FINDING ${fm.id} · ${fm.title}${fm.origin ? ` (parked from ${fm.origin})` : ''}`);
    }
  }
  // The directory must still be there. A crashed session or a pruned worktree leaves a task
  // marked active forever, and announcing "another session is editing this right now" about a
  // checkout that no longer exists is worse than saying nothing.
  const siblings = tasks.filter((fm) => fm.status === 'active' && fm.worktree && fm.worktree !== root && existsSync(fm.worktree));
  const own = tasks.find((fm) => fm.status === 'active' && fm.worktree === root);
  const siblingLine = (fm, what) => `- SIBLING ${basename(fm.worktree)} on ${fm.branch || '(unknown branch)'}`
    + ` · active on ${fm.id} "${fm.title}" — ${what}`;

  // The floor, computed first and kept whatever happens below: what each sibling's own file list
  // says. If the graph is missing, slow, or throws, this is what the session still hears — the
  // graph can only ever ADD to it, never cost the lines this hook already gave.
  const floor = siblings.filter((fm) => listOf(fm.files).includes(rel)).map((fm) => siblingLine(fm, 'has touched this file'));

  // The graph is loaded only when there is someone to compare against — most edits in a quiet
  // repo pay nothing for it. It is this checkout's own copy, beside this hook, so a hook and the
  // library it calls can never come from two different versions of the code.
  const graph = siblings.length || own ? await loadGraph() : null;
  let rich = null;
  if (graph) {
    try {
      rich = graphLines(graph, { abs, root, rel, evt, main, siblings, own, siblingLine });
    } catch { /* keep the floor */ }
  }
  out.push(...(rich ?? floor));
  return out;
}

/**
 * Hard ceiling on the graph work in one edit. Every git call is also bounded (setGitTimeout), but
 * with several siblings they run one after another; past this, the remaining siblings get only
 * the file-list answer and the dependency lines are skipped. Measured against eleven siblings
 * with `git status` wedged: 34 s without a ceiling.
 */
const GRAPH_BUDGET_MS = 1500;

/** The SIBLING and MAIN MOVED lines the code graph can add. May throw; the caller keeps the floor. */
function graphLines(graph, { abs, root, rel, evt, main, siblings, own, siblingLine }) {
  const deadline = Date.now() + GRAPH_BUDGET_MS;
  const late = () => Date.now() > deadline;
  graph.setGitTimeout(1000);
  const def = graph.defaultRef(main); // once per edit, not once per sibling
  const ts = graph.isSymbolFile(rel) ? graph.loadTs() : null;
  const changes = (c) => (c.change === 'removed' ? 'removed' : `${c.change}, ${c.lines} line${c.lines === 1 ? '' : 's'}`);
  const out = [];

  const seen = [];
  for (const fm of siblings) {
    if (late()) {
      if (listOf(fm.files).includes(rel)) out.push(siblingLine(fm, 'has touched this file'));
      continue;
    }
    const s = safe(() => graph.subjectFromTask(main, fm, '', def));
    // What git says the sibling touched, not only what its file list says. The list is a floor:
    // an edit made through Bash never reaches it.
    const fp = s ? (safe(() => graph.footprint(main, s)) ?? new Set()) : new Set();
    seen.push({ fm, s, fp });
    if (!listOf(fm.files).includes(rel) && !fp.has(rel)) continue;
    const delta = ts && s ? (safe(() => graph.symbolDelta(main, ts, s, rel)) ?? []) : [];
    out.push(siblingLine(fm, delta.length
      ? `changed ${delta.map((c) => `\`${c.name}\` (${changes(c)})`).join(', ')} in this file`
      : 'has touched this file'));
  }
  if (!ts || late()) return out;

  // What this file imports, and whether anyone changed it. For a Write that creates the file,
  // the content being written is what will import.
  const text = readText(abs) ?? (typeof evt?.tool_input?.content === 'string' ? evt.tool_input.content : null);
  const imports = text == null ? [] : (safe(() => graph.namedImports(ts, root, rel, text)) ?? []);
  // A re-export this file comes through counts only when a name it uses no longer gets through —
  // a barrel narrowed to what is still used breaks nobody (lostThrough).
  const reaches = (s, imp, c) => {
    const lost = safe(() => graph.lostThrough(main, ts, s, imp, c.name, root));
    return !lost || lost.length > 0;
  };
  const used = (s, fp) => imports.filter((imp) => imp.from !== rel && fp.has(imp.from) && !graph.isGenerated(imp.from))
    .flatMap((imp) => (safe(() => graph.symbolDelta(main, ts, s, imp.from)) ?? [])
      .filter((c) => imp.names.includes(c.name) && reaches(s, imp, c))
      .map((c) => ({ c, from: imp.from })));

  for (const { fm, s, fp } of seen) {
    if (!s || late()) continue;
    for (const { c, from } of used(s, fp)) {
      if (c.change === 'signature' || c.change === 'removed') {
        out.push(`- SIBLING ${basename(fm.worktree)} · ${fm.id} ${c.change === 'removed' ? 'removed' : 'changed the signature of'}`
          + ` \`${c.name}\` (${from}), which this file imports — coordinate before relying on it`);
      } else if (c.change === 'body') {
        out.push(`- SIBLING ${basename(fm.worktree)} · ${fm.id} changed what \`${c.name}\` does (${c.lines} line${c.lines === 1 ? '' : 's'}, ${from}),`
          + ' which this file imports');
      }
    }
  }

  // Main moving under a task is the same drift in slow motion: a worktree cut weeks ago keeps
  // building on functions main has since reshaped. Signatures only — a body change on main is
  // ordinary, and repeating every one would bury the lines that matter.
  if (own && !late()) {
    const m = safe(() => graph.mainSince(main, root, own.base, def));
    const fp = m ? (safe(() => graph.footprint(main, m)) ?? new Set()) : new Set();
    for (const { c, from } of m ? used(m, fp) : []) {
      if (c.change !== 'signature' && c.change !== 'removed') continue;
      out.push(`- MAIN MOVED since this task started: \`${c.name}\` (${from}) ${c.change === 'removed' ? 'was removed' : 'changed signature'}`
        + ` on ${m.label}, and this file imports it — merge ${m.label} before relying on it`);
    }
  }
  return out;
}

/** Everything the hook calls on the library. A copy missing any of them is treated as absent. */
const GRAPH_API = ['loadTs', 'defaultRef', 'setGitTimeout', 'subjectFromTask', 'mainSince', 'footprint',
  'symbolDelta', 'namedImports', 'lostThrough', 'isSymbolFile', 'isGenerated'];

/**
 * The code graph from this checkout's own scripts/, or null. A missing library is no reason to
 * fail an edit — and neither is a mismatched one (a partial checkout, a file from another branch),
 * which is why every function the hook needs is checked before any is called.
 */
async function loadGraph() {
  try {
    const graph = await import(new URL('../../scripts/code-graph.mjs', import.meta.url));
    return GRAPH_API.every((name) => typeof graph[name] === 'function') ? graph : null;
  } catch {
    return null;
  }
}

/** Run a graph query; any failure is "no answer", never a lost edit. */
function safe(fn) {
  try {
    return fn();
  } catch {
    return null;
  }
}

function readText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

const listOf = (v) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function frontmatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return {};
  const fm = {};
  for (let i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(lines[i]);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

/**
 * Session-scoped markers so each file's context is surfaced once, not on every edit. Split in
 * two so the hook can ask BEFORE doing any work and mark only once it has actually said something.
 */
function markerFor(sessionId, rel) {
  const dir = join(tmpdir(), `claude-decisions-${sessionId.replace(/[^\w-]/g, '')}`);
  return { dir, file: join(dir, `${createHash('sha1').update(rel).digest('hex')}.seen`) };
}

function wasTold(sessionId, rel) {
  if (!sessionId) return false;
  try {
    return existsSync(markerFor(sessionId, rel).file);
  } catch {
    return false;
  }
}

function markTold(sessionId, rel) {
  if (!sessionId) return;
  try {
    const { dir, file } = markerFor(sessionId, rel);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '');
  } catch { /* if the marker cannot be written, prefer repeating over staying silent */ }
}
