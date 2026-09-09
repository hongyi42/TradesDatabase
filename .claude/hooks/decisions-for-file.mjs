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
  try {
    main(JSON.parse(input));
  } catch {
    quiet(); // a malformed payload must not cost the user an edit
  }
});

function main(evt) {
  const filePath = evt?.tool_input?.file_path;
  if (!filePath) return quiet();

  const abs = isAbsolute(filePath) ? filePath : resolve(evt.cwd || process.cwd(), filePath);
  const root = resolveRoot(abs, evt);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..')) return quiet(); // outside the repo

  // Best-effort, not a precondition: a worktree branched before the index existed still
  // deserves the LIVE record below. Requiring by-file.json here is what made this hook go
  // silent in exactly the checkouts that most need it.
  let byFile = {};
  try {
    byFile = JSON.parse(readFileSync(join(root, 'thoughts', 'by-file.json'), 'utf8'));
  } catch { /* no index, or an unreadable one */ }

  const hits = Array.isArray(byFile[rel]) ? byFile[rel] : [];
  const live = recordLines(abs, root, rel);
  if (hits.length === 0 && live.length === 0) return quiet();

  // Say it once per file per session. Repeating it on every edit to the same file burns
  // context to tell the session something it was already told.
  if (alreadyTold(evt.session_id, rel)) return quiet();

  const lines = hits.map((h) => {
    const TAGS = {
      rule: 'REPO RULE',
      memory: 'ENGINEERING MEMORY',
      doc: 'DOC',
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
        + ' time rediscovering it. A SIBLING line means another session is editing this same file'
        + ' in its own worktree right now, so coordinate rather than assume. See `npm run board`.',
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
function recordLines(abs, root, rel) {
  const main = mainCheckoutOf(abs);
  if (!main) return [];
  const dir = join(main, '.claude', 'work', 'tasks');
  if (!existsSync(dir)) return [];

  const out = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return []; }
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    let fm;
    try { fm = frontmatter(readFileSync(join(dir, name), 'utf8')); } catch { continue; }
    if (!fm.id) continue;
    const files = (fm.files ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!files.includes(rel)) continue;
    // A task active in THIS worktree is the session's own work — it does not need telling.
    if (fm.worktree === root) continue;
    if (fm.status === 'open') {
      out.push(`- OPEN FINDING ${fm.id} · ${fm.title}${fm.origin ? ` (parked from ${fm.origin})` : ''}`);
    } else if (fm.status === 'active' && fm.worktree && existsSync(fm.worktree)) {
      // The directory must still be there. A crashed session or a pruned worktree leaves a
      // task marked active forever, and announcing "another session is editing this right
      // now" about a checkout that no longer exists is worse than saying nothing.
      out.push(`- SIBLING ${basename(fm.worktree)} on ${fm.branch || '(unknown branch)'}`
        + ` · active on ${fm.id} "${fm.title}" — has touched this file`);
    }
  }
  return out;
}

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

/** Session-scoped marker so each file's decisions are surfaced once, not on every edit. */
function alreadyTold(sessionId, rel) {
  if (!sessionId) return false;
  try {
    const dir = join(tmpdir(), `claude-decisions-${sessionId.replace(/[^\w-]/g, '')}`);
    mkdirSync(dir, { recursive: true });
    const marker = join(dir, `${createHash('sha1').update(rel).digest('hex')}.seen`);
    if (existsSync(marker)) return true;
    writeFileSync(marker, '');
    return false;
  } catch {
    return false; // if the marker cannot be written, prefer repeating over staying silent
  }
}
