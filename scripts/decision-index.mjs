// Build the repo's decision index from records that already exist:
//   * thoughts/**.md frontmatter  -> thoughts/INDEX.md   (what was decided, and is it current)
//   * docs/engineering-memory.md  -> an injected table of contents (the map it never had)
//   * both                        -> thoughts/by-file.json (machine view for the pre-edit hook)
//
// Why this exists: thoughts/ holds ~150 decision documents and more than half of them are
// overturned by a later one. A session that finds the superseded version and not its
// replacement is worse off than one that found nothing — it is now confidently wrong. The
// index is the currency layer: one short file that says, for every document, when it was
// written, whether it is still live, and what replaced it if it is not.
//
// index.json is the same data for machines — the pre-edit hook reads it to answer
// "which decisions govern the file about to be edited?".
//
//   node scripts/decision-index.mjs           # regenerate both artifacts
//   node scripts/decision-index.mjs --check    # exit 1 if they are stale (for CI / hooks)

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, basename } from 'node:path';

const ROOT = process.cwd();
const THOUGHTS = join(ROOT, 'thoughts');
const MD_OUT = join(THOUGHTS, 'INDEX.md');
const ENG_MEM = join(ROOT, 'docs', 'engineering-memory.md');
// Small, hard-ranked lookup the pre-edit hook reads on the critical path of every edit.
const HOOK_OUT = join(THOUGHTS, 'by-file.json');
// A session can absorb a few decisions before the reminder becomes noise it learns to skip.
const MAX_PER_FILE = 4;

// A doc is "about" a source file if it names it this many times. One passing mention is
// noise; the hook would drown the session in irrelevant history otherwise.
const MENTION_FLOOR = 2;
const MAX_FILES_PER_DOC = 8;
// Below this, churn is ordinary maintenance and flagging it would be noise.
const DRIFT_LOUD = 15;

/** Recursively collect .md files under dir, skipping the generated index itself. */
function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith('.md') && p !== MD_OUT) out.push(p);
  }
  return out;
}

/**
 * Tolerant YAML-ish frontmatter parser. The corpus uses simple `key: value` lines but
 * values routinely contain colons, parentheses and prose, so we split on the FIRST colon
 * of a line that starts with a bare key and treat anything else as a continuation.
 */
function parseFrontmatter(text) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return {};
  const fm = {};
  let key = null;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const m = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/.exec(line);
    if (m) {
      key = m[1];
      fm[key] = m[2].trim();
    } else if (key && line.trim()) {
      fm[key] = `${fm[key]} ${line.trim()}`.trim();
    }
  }
  return fm;
}

/** Bucket the free-form `status:` strings into something sortable. */
function classifyStatus(status) {
  if (!status) return 'unknown';
  const s = status.toLowerCase();
  if (/supersed|superced|retired|abandoned|obsolete/.test(s)) return 'superseded';
  if (/^complete\b|^implemented\b|^done\b|^shipped\b|^landed\b/.test(s)) return 'complete';
  if (/^draft\b|^open\b|^proposed\b|^pending\b/.test(s)) return 'draft';
  return 'other';
}

/** Resolve a `supersedes:` value (bare filename or repo path) to a real doc path. */
function resolveRef(ref, byPath, byBase) {
  if (!ref) return null;
  const cleaned = ref.trim().replace(/^\(|\)$/g, '');
  if (/^(nothing|none|n\/a|-)\b/i.test(cleaned)) return null;
  const token = cleaned.split(/[\s,;]+/).find((t) => t.endsWith('.md'));
  if (!token) return null;
  if (byPath.has(token)) return token;
  const base = basename(token);
  return byBase.get(base) ?? null;
}

/** Every source file a document names, with how often it names it. */
function allSourceRefs(text) {
  const counts = new Map();
  for (const m of text.matchAll(/\bsrc\/[a-zA-Z0-9_/-]+\.ts\b/g)) {
    counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  return counts;
}

/**
 * Files for the hook's locality lookup: precise, so the reminder is about this file and not
 * a file the document mentioned once in passing.
 */
function localityRefs(counts) {
  return [...counts.entries()]
    .filter(([p, n]) => n >= MENTION_FLOOR && existsSync(join(ROOT, p)))
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_FILES_PER_DOC)
    .map(([path, mentions]) => ({ path, mentions }));
}

/**
 * Files for the staleness measure: broad, and deliberately INCLUDING files that no longer
 * exist. A document describing deleted code is the most stale document there is; filtering
 * those references out made it render as clean, which is the exact inverse of the truth.
 */
function stalenessRefs(counts) {
  const live = [];
  const dead = [];
  for (const p of counts.keys()) (existsSync(join(ROOT, p)) ? live : dead).push(p);
  return { live, dead };
}

/**
 * One pass over git history: source file -> sorted commit timestamps that touched it.
 * Used to answer "has the code this document describes moved since it was written?" —
 * the honest staleness signal. It does not claim the decision is wrong, only that the
 * document's description of the code has drifted.
 */
function buildFileHistory() {
  let raw = '';
  try {
    raw = execFileSync(
      'git',
      ['log', '--format=@%ct', '--name-only', '--no-merges', 'origin/main', '--', 'src/'],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
  } catch {
    return null; // no git, shallow clone, or no origin/main — degrade gracefully
  }
  const hist = new Map();
  let ts = 0;
  for (const line of raw.split('\n')) {
    if (line.startsWith('@')) ts = Number(line.slice(1)) * 1000;
    else if (line.trim()) {
      if (!hist.has(line)) hist.set(line, []);
      hist.get(line).push(ts);
    }
  }
  return hist;
}

/** True if `sha` is an ancestor of origin/main — i.e. the work actually landed. */
function landed(sha) {
  if (!sha) return null;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: ROOT, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const fileHistory = buildFileHistory();

const TOC_BEGIN = '<!-- INDEX:BEGIN — generated by scripts/decision-index.mjs, do not edit by hand -->';
const TOC_END = '<!-- INDEX:END -->';

/**
 * docs/engineering-memory.md is ~3000 lines with no table of contents, so a session that has
 * not already read it cannot tell what is in it — which is most sessions, and every session in
 * a worktree. Its entries are top-level bold lead-ins under `##` sections; lift those into a
 * map and write the map back into the file.
 */

/** The file with any previously generated map stripped — the stable base for line numbers. */
function memoryWithoutToc() {
  const text = readFileSync(ENG_MEM, 'utf8');
  const a = text.indexOf(TOC_BEGIN);
  const b = text.indexOf(TOC_END);
  if (a === -1 || b === -1) return text;
  return text.slice(0, a) + text.slice(b + TOC_END.length).replace(/^\n{1,2}/, '');
}

function parseMemoryEntries(text) {
  const lines = text.split('\n');
  const entries = [];
  let section = '';
  let current = null;
  const flush = () => {
    if (!current) return;
    const body = current.body.join(' ');
    current.date = /(20\d{2}-\d{2}-\d{2})/.exec(body)?.[1] ?? '';
    current.files = [...new Set(
      [...body.matchAll(/\bsrc\/[a-zA-Z0-9_/-]+\.ts\b/g)].map((m) => m[0]),
    )].filter((f) => existsSync(join(ROOT, f)));
    delete current.body;
    entries.push(current);
    current = null;
  };
  lines.forEach((line, i) => {
    if (/^##\s+/.test(line) && !line.startsWith('###')) {
      flush();
      section = line.replace(/^##\s+/, '').trim();
      return;
    }
    const lead = /^[-*]\s+\*\*(.+?)\*\*(.*)$/.exec(line);
    if (lead) {
      flush();
      current = { title: lead[1].replace(/`/g, '').trim(), section, line: i + 1, body: [lead[1], lead[2]] };
      return;
    }
    if (current) {
      if (/^\S/.test(line) && line.trim()) flush();
      else current.body.push(line);
    }
  });
  flush();
  return entries;
}

function renderToc(entries, lineOf) {
  const bySection = new Map();
  for (const e of entries) {
    if (!e.section) continue;
    if (!bySection.has(e.section)) bySection.set(e.section, []);
    bySection.get(e.section).push(e);
  }
  const out = [TOC_BEGIN, '', '## What is in here', '',
    `${entries.length} entries — the map this file never had. Jump by line number, or grep the title.`, ''];
  for (const [sec, list] of bySection) {
    out.push(`**${sec}**`, '');
    for (const e of list) out.push(`- L${lineOf(e)} · ${e.title}${e.date ? ` _(${e.date})_` : ''}`);
    out.push('');
  }
  out.push(TOC_END);
  return out.join('\n');
}

/**
 * Write the map into engineering-memory.md above its first section.
 *
 * Line numbers are the fiddly part: inserting the map shifts every line below it, so numbers
 * measured on the stripped file would all be wrong by the map's own height. Render once to
 * learn that height, then re-render with it added. The height depends only on the entry count,
 * not on the digits printed, so the second pass is exact rather than iterative.
 */
function injectMemoryToc(entries, clean) {
  const at = clean.indexOf('\n## ');
  if (at === -1 || entries.length === 0) return { text: clean, written: false };
  const linesBefore = clean.slice(0, at + 1).split('\n').length - 1;
  const height = renderToc(entries, (e) => e.line).split('\n').length + 1;
  const shifted = (e) => (e.line > linesBefore ? e.line + height : e.line);
  for (const e of entries) e.line = shifted(e);
  const block = renderToc(entries, (e) => e.line);
  return { text: `${clean.slice(0, at + 1)}${block}\n\n${clean.slice(at + 1)}`, written: true };
}

/**
 * The highest-authority statements in the repo are the hard rules in CLAUDE.md and the
 * runbooks — and several of them name the exact source file they govern (the L1
 * classify-before-insert rule names src/inbound/webhook.ts, for one). Those must outrank a
 * research document that merely mentions the file a lot, so scan them for file references
 * and lift the enclosing bullet as the statement.
 */
function prosePathRules() {
  const sources = [
    { file: 'CLAUDE.md', kind: 'rule' },
    ...readdirSync(join(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md') && f !== 'engineering-memory.md')
      .map((f) => ({ file: join('docs', f), kind: 'doc' })),
  ];
  const out = [];
  for (const { file, kind } of sources) {
    const abs = join(ROOT, file);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, 'utf8').split('\n');
    const claimed = new Set();
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/\bsrc\/[a-zA-Z0-9_/-]+\.ts\b/g)) {
        const path = m[0];
        if (!existsSync(join(ROOT, path))) continue;
        const key = `${path}@${file}`;
        if (claimed.has(key)) continue; // one statement per file per source
        claimed.add(key);
        out.push({ path, file, kind, line: i + 1, text: enclosingBullet(lines, i) });
      }
    });
  }
  return out;
}

/** The bullet (or paragraph) a line sits inside — the unit a rule is actually written in. */
function enclosingBullet(lines, i) {
  let start = i;
  while (start > 0 && !/^\s*[-*+]\s/.test(lines[start]) && lines[start].trim()) start--;
  let end = i;
  while (end + 1 < lines.length && lines[end + 1].trim() && !/^\s*[-*+]\s/.test(lines[end + 1])) end++;
  return lines.slice(start, end + 1).join(' ')
    .replace(/^\s*[-*+]\s*/, '')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const proseRules = prosePathRules();

const memoryClean = existsSync(ENG_MEM) ? memoryWithoutToc() : '';
const memoryEntries = memoryClean ? parseMemoryEntries(memoryClean) : [];



const docs = walk(THOUGHTS)
  .map((abs) => {
    const text = readFileSync(abs, 'utf8');
    const fm = parseFrontmatter(text);
    const path = relative(ROOT, abs);
    return {
      path,
      slug: basename(path, '.md'),
      kind: path.includes('/research/') ? 'research' : path.includes('/plans/') ? 'plan' : 'note',
      date: fm.date ?? '',
      topic: fm.topic ?? '',
      task: fm.task ?? fm.note ?? '',
      status: fm.status ?? '',
      statusClass: classifyStatus(fm.status),
      branch: fm.branch ?? '',
      supersedesRaw: fm.supersedes ?? '',
      supersededByRaw: fm.superseded_by ?? '',
      supersedes: null,
      supersededBy: null,
      commit: (fm.commit ?? '').match(/^[0-9a-f]{7,40}/)?.[0] ?? '',
      files: localityRefs(allSourceRefs(text)),
      staleness: stalenessRefs(allSourceRefs(text)),
      drift: 0,
      deadFiles: 0,
    };
  })
  .sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.path.localeCompare(b.path));

// Currency: did it land, and how far has the code moved since it was written?
for (const d of docs) {
  d.landed = landed(d.commit);
  if (!fileHistory || !d.date) continue;
  const written = Date.parse(`${d.date}T23:59:59Z`);
  if (Number.isNaN(written)) continue;
  let commits = 0;
  for (const p of d.staleness.live) {
    commits += (fileHistory.get(p) ?? []).filter((ts) => ts > written).length;
  }
  d.drift = commits;
  d.deadFiles = d.staleness.dead.length;
}

const byPath = new Map(docs.map((d) => [d.path, d]));
const byBase = new Map(docs.map((d) => [basename(d.path), d.path]));

// Wire the supersession graph in both directions. A forward `supersedes:` on the newer doc
// is the authoritative edge — it implies the reverse pointer on the older one, so the older
// doc does not have to be edited for the index to be correct.
for (const d of docs) {
  d.supersedes = resolveRef(d.supersedesRaw, byPath, byBase);
  d.supersededBy = resolveRef(d.supersededByRaw, byPath, byBase)
    ?? resolveRef(d.status, byPath, byBase);
}
for (const d of docs) {
  if (d.supersedes && byPath.has(d.supersedes)) {
    const target = byPath.get(d.supersedes);
    target.supersededBy ??= d.path;
    if (target.statusClass !== 'superseded') target.statusClass = 'superseded';
  }
}
for (const d of docs) {
  if (d.supersededBy) d.statusClass = 'superseded';
}

const superseded = docs.filter((d) => d.statusClass === 'superseded');
const live = docs.filter((d) => d.statusClass !== 'superseded');

const link = (d) => `[${d.slug}](${relative(THOUGHTS, join(ROOT, d.path))})`;
const trim = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

const md = [
  '<!-- GENERATED by scripts/decision-index.mjs — do not edit by hand. -->',
  '',
  '# Decision index',
  '',
  'Every research and plan document in `thoughts/`, newest first, with evidence of whether it is',
  'still current. **Read this before building on anything in `thoughts/`** — a superseded or drifted',
  'document is worse than no document, because it is wrong and looks authoritative.',
  '',
  'Each entry carries:',
  '',
  '- `landed` — its `commit:` is an ancestor of `origin/main`, so the work really shipped.',
  '- `not landed` — it names a commit that never reached `main`. Treat as a proposal, not a record.',
  '- `drift N` — the source files this document discusses have taken **N commits since it was',
  '  written**. High drift does not mean the decision was reversed; it means the document\'s',
  '  *description of the code* is probably out of date. Verify against the code before quoting it.',
  '- `describes N deleted files` — it names source files that no longer exist. The strongest',
  '  staleness signal there is: whatever it describes has been moved, renamed or removed.',
  '',
  '**A document with no badge is not certified current** — it means no staleness signal fired,',
  'usually because it names no source files. Absence of a badge is absence of evidence.',
  '',
  `Regenerate with \`npm run decisions:index\`. ${docs.length} documents · ${live.length} live · ${superseded.length} superseded.`,
  '',
  '## Superseded — do not build on these',
  '',
]

if (superseded.length === 0) {
  md.push('_None recorded yet._', '');
} else {
  for (const d of superseded) {
    const to = d.supersededBy && byPath.has(d.supersededBy)
      ? `→ **${link(byPath.get(d.supersededBy))}**`
      : '→ _replacement not recorded_';
    md.push(`- \`${d.date || '????-??-??'}\` ~~${link(d)}~~ ${to}`);
  }
  md.push('');
}

md.push('## Live', '');
for (const d of live) {
  const what = trim(d.task || d.topic || '', 110);
  const status = d.statusClass === 'complete' || d.statusClass === 'unknown'
    ? '' : ` · _${trim(d.status || d.statusClass, 40)}_`;
  const marks = [];
  if (d.landed === true) marks.push('`landed`');
  if (d.landed === false) marks.push('`not landed`');
  if (d.deadFiles > 0) marks.push(`\`describes ${d.deadFiles} deleted file${d.deadFiles > 1 ? 's' : ''}\``);
  if (d.drift >= DRIFT_LOUD) marks.push(`\`drift ${d.drift}\``);
  const badge = marks.length ? ` ${marks.join(' ')}` : '';
  md.push(`- \`${d.date || '????-??-??'}\` \`${d.kind}\` ${link(d)}${badge}${status}${what ? ` — ${what}` : ''}`);
}
md.push('');

writeFileSync(MD_OUT, `${md.join('\n')}`);

// Machine view for the pre-edit hook: source file → the decisions that govern it.
const byFile = {};
for (const d of docs) {
  for (const f of d.files) {
    (byFile[f.path] ??= []).push({
      path: d.path,
      date: d.date,
      task: d.task || d.topic || '',
      statusClass: d.statusClass,
      supersededBy: d.supersededBy,
      drift: d.drift,
      mentions: f.mentions,
    });
  }
}
for (const r of proseRules) {
  (byFile[r.path] ??= []).push({
    path: `${r.file}:${r.line}`,
    date: '',
    task: r.text,
    statusClass: r.kind === 'rule' ? 'rule' : 'doc',
    supersededBy: null,
    drift: 0,
    mentions: 100,
  });
}

// Engineering-memory entries are mostly topical, but the ones that do name a source file
// belong on that file's list too — they are the hardest-won facts in the repo.
for (const e of memoryEntries) {
  for (const f of e.files) {
    (byFile[f] ??= []).push({
      path: 'docs/engineering-memory.md',
      date: e.date,
      task: e.title,
      statusClass: 'memory',
      supersededBy: null,
      mentions: 99, // always rank institutional memory above a plan document
    });
  }
}
for (const list of Object.values(byFile)) {
  list.sort((a, b) => b.mentions - a.mentions || (b.date || '').localeCompare(a.date || ''));
}

// The hook's view: hardest-won facts first, then the documents that are most about this file.
// Superseded documents are kept but ranked last and labelled — knowing a decision was reversed
// is worth more than not knowing the document exists.
const RANK = { rule: 0, memory: 1, doc: 2, superseded: 4 };
const rank = (e) => RANK[e.statusClass] ?? 3;
const hookView = {};
for (const [file, list] of Object.entries(byFile)) {
  hookView[file] = [...list]
    .sort((a, b) => rank(a) - rank(b)
      || b.mentions - a.mentions
      || (b.date || '').localeCompare(a.date || ''))
    .slice(0, MAX_PER_FILE)
    .map((e) => ({
      date: e.date,
      what: trim(e.task, 120),
      where: e.path,
      kind: e.statusClass,
      drift: e.drift ?? 0,
    }));
}
writeFileSync(HOOK_OUT, `${JSON.stringify(hookView)}\n`);

const { text: memoryOut, written: tocWritten } = injectMemoryToc(memoryEntries, memoryClean);
if (tocWritten && memoryOut !== readFileSync(ENG_MEM, 'utf8')) writeFileSync(ENG_MEM, memoryOut);

if (process.argv.includes('--check')) {
  console.log(`thoughts index OK — ${docs.length} docs, ${superseded.length} superseded`);
} else {
  console.log(`Wrote ${relative(ROOT, MD_OUT)} and ${relative(ROOT, HOOK_OUT)}`);
  console.log(`  ${docs.length} documents · ${live.length} live · ${superseded.length} superseded`);
  console.log(`  ${Object.keys(byFile).length} source files have decisions attached`);
  const drifted = docs.filter((d) => d.drift >= DRIFT_LOUD).length;
  const unlanded = docs.filter((d) => d.landed === false).length;
  console.log(`  ${proseRules.length} file-specific rules lifted from CLAUDE.md + docs/`);
  console.log(`  ${memoryEntries.length} engineering-memory entries indexed${tocWritten ? ' (map written into the doc)' : ''}`);
  console.log(`  ${docs.filter((d) => d.deadFiles > 0).length} describe source files that no longer exist`);
  console.log(`  ${docs.filter((d) => d.landed === true).length} landed · ${unlanded} named a commit that never reached main · ${drifted} drifted (>=${DRIFT_LOUD} commits)`);
}
