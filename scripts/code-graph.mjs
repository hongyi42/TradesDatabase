// The code graph — which exported functions each task has changed, and where two tasks collide.
//
// Why this exists: the work record could say "two sessions touched the same FILE", and that is
// both too loud and too quiet. Too loud, because two tasks editing different functions in one
// file are usually fine, and the file-level rule is what made every plan-two verdict say
// "stack". Too quiet, because the dangerous collision is usually in two different files: one
// task changes a function's signature and the other calls it. Only a graph of symbols and the
// imports between them can see that.
//
// The truth is the code as the TypeScript compiler reads it, recomputed on every call. Nothing
// is stored. Parsing all 135 modules and resolving every import took 168 ms when measured
// (2026-09-10), which is cheaper than any rule for deciding when a stored graph has gone stale —
// and a stored graph going quietly stale is exactly what every indexing tool surveyed in
// thoughts/shared/research/2026-09-09-code-graph-as-source-of-truth.md §3.2 was measured doing.
//
// Parse-only, never the type checker: the checker costs seconds, and an exact resolver plus the
// declaration text is enough to tell a signature change from a body change. The one thing that
// costs: a function whose return type is INFERRED can change its type without its text changing.
//
// A task's footprint comes from git, not only from its `files:` list. That list is a floor —
// the edit hook never sees a file rewritten through Bash (see
// thoughts/shared/findings/2026-09-10-settings-json-says-hooks-on-one-event-sh.md) — so the
// committed diff and the working tree's own status are what say what a task has really touched.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { isAbsolute, join, posix, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

// ── git ───────────────────────────────────────────────────────────────────────

/**
 * Raw git stdout, or null. Bounded, because the pre-edit hook calls into this on every edit.
 *
 * `--no-optional-locks` because this runs `status` inside OTHER sessions' worktrees, and a plain
 * `status` refreshes the index under a lock that "may conflict with other simultaneous processes,
 * causing them to fail" (git-status(1), BACKGROUND REFRESH) — a sibling's own commit, say.
 */
function gitRaw(args, cwd) {
  try {
    return execFileSync('git', ['--no-optional-locks', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
      timeout: gitTimeoutMs,
    });
  } catch {
    return null;
  }
}

let gitTimeoutMs = 3000;

/**
 * Tighten the per-call bound. The pre-edit hook sets it low: it stands between the session and
 * every edit, and one wedged sibling (a hung filesystem, a held lock) must cost a second, not three.
 */
export function setGitTimeout(ms) {
  gitTimeoutMs = ms;
}

function git(args, cwd) {
  const out = gitRaw(args, cwd);
  return out === null ? null : out.trim();
}

/** The commit a ref names, or null. Every subject carries shas, never names that can move. */
function sha(ref, cwd) {
  return ref ? git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd) : null;
}

/**
 * A file's text, or null for anything that cannot be read as one — missing, unreadable, a
 * directory behind a `.ts` symlink. Same rule as gitRaw: a question this file cannot answer is
 * "no answer", never a stack trace in the middle of someone's overlap report or edit.
 */
function readText(p) {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/**
 * The branch this clone treats as "main": whatever the remote calls its default, then the usual
 * names. The same chain `work.mjs`'s `mergeBase` walks, for the same reason — a local-only clone
 * or a fork's remote does not have to be called `origin/main`.
 */
export function defaultRef(cwd) {
  const candidates = ['origin/main', 'main', 'origin/master', 'master'];
  const remoteDefault = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  if (remoteDefault) candidates.unshift(remoteDefault);
  return candidates.find((ref) => sha(ref, cwd)) ?? null;
}

/**
 * TypeScript from the node_modules beside THIS file, or null. Loaded lazily and only by the verbs
 * that need it, so a checkout without `npm ci` degrades to file-level answers instead of failing.
 */
let tsModule;
export function loadTs() {
  if (tsModule === undefined) {
    try {
      tsModule = createRequire(import.meta.url)('typescript');
    } catch {
      tsModule = null;
    }
  }
  return tsModule;
}

// ── subjects: what a task (or a branch, or main) is, in commits ───────────────

const listField = (v) => (typeof v === 'string' ? v : '').split(',').map((s) => s.trim()).filter(Boolean);

/**
 * Words in a parked finding's prose that could be function names. Matched against exports later.
 *
 * Every word, on purpose: a word too many can only make an overlap look bigger, and the operator
 * still decides — a word too few lets spawn go ahead alone. (Reading only backticked names was
 * tried and did exactly that: findings here backtick paths and commands, not function names.)
 * The one word never counted is `default` — the name this file gives an anonymous default export,
 * so as an English word it turned "should be two by default" into a HIGH on every one of them.
 */
function identifiers(text) {
  return [...new Set(text.match(/[A-Za-z_$][\w$]{2,}/g) ?? [])].filter((w) => w !== 'default');
}

/** Every file under `rel` in a checkout, repo-relative — how a directory in `files:` is read. */
function filesUnder(root, rel) {
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...filesUnder(root, p));
    else out.push(p);
  }
  return out;
}

/**
 * Whether `path` IS a checkout, not merely a folder inside one: true, false, or null when git
 * could not say (a timeout, a held lock, a `.git` file pointing nowhere). A worktree folder that
 * has lost its `.git` file still exists, and git run inside it walks up to whatever repository
 * encloses it — for `.claude/worktrees/x`, the main checkout — whose uncommitted edits would
 * then be blamed on whoever held that folder.
 */
function isCheckout(path) {
  if (!path || !existsSync(path)) return false;
  const top = git(['rev-parse', '--show-toplevel'], path);
  if (top !== null) return top === path;
  return existsSync(join(path, '.git')) ? null : false;
}

/**
 * A `files:` list as repo paths. People and agents type these as well as the edit hook, so
 * `./src/h.ts`, an absolute path and `src/db/` all arrive meaning a path in the repo — and
 * matched verbatim against git's paths, each matched nothing and read as "no overlap".
 *
 * With `ref` (a parked finding's, whose list is its whole footprint), a directory is expanded to
 * the files in it there, and a path that is not in the repo at `ref` is also returned in
 * `unknown`: a new file, or a typo — either way nothing could be checked for what calls it.
 * Without `ref`, a directory is expanded from the checkout's disk (the file system, never git:
 * the edit hook reads every sibling's list on every edit) — or a spawned task that names `src/db/`
 * would stop overlapping anything the moment it started.
 */
function repoPaths(main, checkout, list, ref = null) {
  const files = [];
  const unknown = [];
  for (const raw of list) {
    let p = raw.replace(/\\/g, '/');
    for (const root of [checkout, main]) {
      if (root && p.startsWith(`${root}/`)) { p = p.slice(root.length + 1); break; }
    }
    p = posix.normalize(p).replace(/\/+$/, '');
    if (!p || p === '.' || p.startsWith('../') || isAbsolute(p)) { unknown.push(raw); continue; }
    if (!ref) {
      let dir = false;
      try { dir = Boolean(checkout) && statSync(join(checkout, p)).isDirectory(); } catch { /* not on disk: a file path */ }
      if (dir) files.push(...filesUnder(checkout, p));
      else files.push(p);
      continue;
    }
    const type = git(['cat-file', '-t', `${ref}:${p}`], main);
    if (type === 'tree') {
      const listed = gitRaw(['ls-tree', '-r', '--name-only', '-z', ref, '--', `${p}/`], main);
      // Git could not list it: an unread directory, never an empty one.
      if (listed === null) unknown.push(raw);
      files.push(...(listed ?? '').split('\0').filter(Boolean));
      continue;
    }
    files.push(p);
    if (type !== 'blob') unknown.push(raw);
  }
  return { files: [...new Set(files)], unknown };
}

/**
 * Where a task stands, as a subject the rest of this file can compare.
 *
 * `base` is LIVE — the merge-base of the task's HEAD with main, computed now — and the one stored
 * at claim time is only a fallback. Once `integrate` has merged main into the branch, the
 * claim-time base would make every file main changed since look like the task's own work, and
 * would keep announcing "main moved" about changes the task already has.
 *
 * `HEAD` is resolved inside the task's own checkout. Asked from the main checkout it would name
 * the main checkout's commit, and a sibling's committed work would vanish from its footprint.
 */
export function subjectFromTask(main, fm, body = '', def = defaultRef(main)) {
  const at = def ? sha(def, main) : null;
  if (fm.status === 'open') {
    // Parked: nothing is changed yet. It names files, and its prose may name the functions it is
    // about — those are what an overlap can be measured against.
    const { files, unknown } = repoPaths(main, null, listField(fm.files), at);
    return {
      label: fm.id, checkout: null, ref: at, base: at, files, unknown, mentions: identifiers(`${fm.title ?? ''}\n${body}`), predicted: true,
    };
  }
  const files = repoPaths(main, fm.worktree, listField(fm.files)).files;
  // `unread` names what git could not read. A subject missing part of its footprint is an
  // incomplete check, and `overlaps` says so — reading it as "no changes" is how a slow or broken
  // checkout once let spawn proceed on its own.
  const unread = [];
  // Without a base there is no committed diff to read, and "nothing committed" is not what that means.
  const baseOf = (live, ref) => {
    if (def && !live && !fm.base) unread.push(`where it branched from ${def}`);
    return live || fm.base || ref;
  };
  const held = fm.worktree ? isCheckout(fm.worktree) : false;
  if (held) {
    const ref = sha('HEAD', fm.worktree);
    if (!ref) unread.push(`the commit ${fm.worktree} is on`);
    const base = baseOf(def ? git(['merge-base', 'HEAD', def], fm.worktree) : null, ref);
    return {
      label: fm.id, checkout: fm.worktree, ref, base, files, mentions: [], predicted: false, unread,
    };
  }
  if (held === null) unread.push(`its checkout ${fm.worktree}`);
  // A folder that is there but is no longer a checkout may still hold the task's uncommitted
  // work, and git cannot see it — an incomplete check, not a task with nothing uncommitted.
  else if (fm.worktree && existsSync(fm.worktree)) unread.push(`${fm.worktree}, which has lost its .git`);
  // `refs/heads/` explicitly: a task claimed on a detached HEAD records its branch as `HEAD`, and
  // resolving that bare name here would hand the task the MAIN checkout's commit.
  const branchSha = fm.branch && fm.branch !== 'HEAD' ? sha(`refs/heads/${fm.branch}`, main) : null;
  if (branchSha) {
    const base = baseOf(def ? git(['merge-base', branchSha, def], main) : null, branchSha);
    return {
      label: fm.id, checkout: null, ref: branchSha, base, files, mentions: [], predicted: false, unread,
    };
  }
  // Closed, and its checkout and branch are gone: all that is left is the list of files it named.
  return { label: fm.id, checkout: null, ref: at, base: at, files, mentions: [], predicted: false, unread };
}

/** A branch that may have no task — a stale worktree, say. Its checkout, if one holds it, adds uncommitted work. */
export function subjectFromBranch(main, branch) {
  const ref = sha(branch, main);
  if (!ref) return null;
  const def = defaultRef(main);
  const live = def ? git(['merge-base', ref, def], main) : null;
  const unread = def && !live ? [`where it branched from ${def}`] : [];
  const path = worktreeHolding(main, branch);
  // Same guard as a task's: a folder that has lost its `.git` would describe the main checkout.
  const held = isCheckout(path);
  const checkout = held ? path : null;
  const head = checkout ? sha('HEAD', checkout) : ref;
  if (held === null) unread.push(`its checkout ${path}`);
  else if (!held && path) unread.push(`${path}, which has lost its .git`);
  return { label: branch, checkout, ref: head || ref, base: live || ref, files: [], mentions: [], predicted: false, unread };
}

/** What main has changed since `checkout` last took it — the "main moved under you" subject. */
export function mainSince(main, checkout, fallbackBase, def = defaultRef(main)) {
  const at = def ? sha(def, main) : null;
  if (!at) return null;
  const base = git(['merge-base', 'HEAD', at], checkout) || fallbackBase || at;
  return { label: def, checkout: null, ref: at, base, files: [], mentions: [], predicted: false };
}

function worktreeHolding(main, branch) {
  const raw = git(['worktree', 'list', '--porcelain'], main) ?? '';
  let path = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) path = line.slice(9);
    else if (line === `branch refs/heads/${branch}` && path && existsSync(path)) return path;
  }
  return null;
}

// ── footprint ─────────────────────────────────────────────────────────────────

/**
 * Generated files: two tasks changing one of these is never a real collision, because the right
 * resolution is to regenerate, not to merge. Each carries the command that regenerates it.
 */
const GENERATED = new Map([
  ['src/db/database.types.ts', 'npm run gen:types:local'],
  ['thoughts/INDEX.md', 'npm run decisions:index'],
  ['thoughts/by-file.json', 'npm run decisions:index'],
]);

export const isGenerated = (f) => GENERATED.has(f);

/**
 * Every path a subject has touched: committed since its base, uncommitted in its checkout, and
 * whatever its `files:` list names.
 *
 * `supabase/config.toml` is dropped: scripts/second-stack.sh rewrites it and leaves it modified
 * in every worktree that has its own stack, so keeping it would make every such pair "overlap".
 * So is `node_modules`: a worktree that symlinks it shows it as UNTRACKED, because the
 * `.gitignore` entry `node_modules/` matches directories and a symlink is not one.
 */
export function footprint(main, s) {
  return readFootprint(main, s).files;
}

/**
 * The footprint in full: `files` (everything, as `footprint` returns), `changed` (what git says
 * the subject has really changed — without the `files:` list), and `unread` (what git could not
 * read). A failed git call is never "no changes": it is named in `unread`, and `overlaps` turns
 * that into an item, so a check that could not finish cannot pass for a clean one.
 */
export function readFootprint(main, s) {
  const changed = new Set();
  const unread = [...(s.unread ?? [])];
  // `-z` on both: without it git quotes and backslash-escapes any path with an accent or a quote
  // in it, so one file would arrive in two spellings and match neither the other nor `files:`.
  // `--no-renames` on both: rename detection reports a move as its NEW path only, and the old
  // path — the one a sibling is still editing, or importing — would vanish from the footprint.
  // Without detection a move is what it is to everyone else: a deletion plus a new file.
  if (s.base && s.ref && s.base !== s.ref) {
    const diff = gitRaw(['diff', '--name-only', '--no-renames', '-z', `${s.base}...${s.ref}`], s.checkout ?? main);
    if (diff === null) unread.push(`its commits since ${s.base.slice(0, 7)}`);
    for (const f of (diff ?? '').split('\0')) if (f) changed.add(f);
  }
  if (s.checkout) {
    // Read raw, never trimmed: porcelain's status column can begin with a space, and trimming it
    // once ate the first letter of a filename (work.mjs:58-65). With renames off, every entry is
    // one `XY path`; a copy (`C`) is the one pair left, `XY new\0old\0`, so its old path is skipped.
    const status = gitRaw(['status', '--porcelain', '--no-renames', '-z', '-uall'], s.checkout);
    if (status === null) unread.push(`the uncommitted changes in ${s.checkout}`);
    const parts = (status ?? '').split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      changed.add(entry.slice(3));
      if (entry[0] === 'C' || entry[1] === 'C') i++;
    }
  }
  const drop = (set) => {
    set.delete('supabase/config.toml');
    for (const f of set) if (f === 'node_modules' || f.startsWith('node_modules/')) set.delete(f);
    return set;
  };
  return { files: drop(new Set([...changed, ...s.files])), changed: drop(changed), unread };
}

// ── exported symbols ──────────────────────────────────────────────────────────

/** Files whose exports we read. Tests export nothing anyone imports, so they are skipped. */
export function isSymbolFile(f) {
  return /\.(ts|tsx|mts|cts|mjs|cjs|js)$/.test(f) && !/\.test\.[cm]?[jt]sx?$/.test(f);
}

function parse(ts, text, fileName) {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX
    : /\.[cm]?js$/.test(fileName) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, kind);
}

const hash = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);

function modifiersOf(ts, node) {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined) ?? [];
}

/** A class's public face: private and protected members are nobody else's business. */
function isPublicMember(ts, m) {
  if (m.name && ts.isPrivateIdentifier(m.name)) return false;
  return !modifiersOf(ts, m).some((x) => x.kind === ts.SyntaxKind.PrivateKeyword || x.kind === ts.SyntaxKind.ProtectedKeyword);
}

/** A member with its body (or initialiser) removed — what a caller depends on. */
function memberSignature(ts, m) {
  const f = ts.factory;
  if (ts.isMethodDeclaration(m)) return f.updateMethodDeclaration(m, m.modifiers, m.asteriskToken, m.name, m.questionToken, m.typeParameters, m.parameters, m.type, undefined);
  if (ts.isConstructorDeclaration(m)) return f.updateConstructorDeclaration(m, m.modifiers, m.parameters, undefined);
  if (ts.isGetAccessorDeclaration(m)) return f.updateGetAccessorDeclaration(m, m.modifiers, m.name, m.parameters, m.type, undefined);
  if (ts.isSetAccessorDeclaration(m)) return f.updateSetAccessorDeclaration(m, m.modifiers, m.name, m.parameters, undefined);
  if (ts.isPropertyDeclaration(m)) return f.updatePropertyDeclaration(m, m.modifiers, m.name, m.questionToken ?? m.exclamationToken, m.type, undefined);
  return m;
}

/**
 * Every exported declaration in `text`, each with a SIGNATURE hash (what callers depend on) and a
 * BODY hash (what it does). Both are taken from the printed node with comments removed, so an
 * edit that only touches comments or whitespace changes neither.
 */
export function exportedSymbols(ts, text, fileName) {
  return exportTable(ts, text, fileName).declared;
}

/** `export * from '<spec>'` — how a star re-export is named, since it has no name of its own. */
const starKey = (spec) => `export * from '${spec}'`;

/**
 * A file's exports in two halves. `declared` is what it declares (exportedSymbols). `passed` is
 * what it only passes through from another module, keyed the way an importer reaches it — the
 * exported name, or starKey(spec) for a star — with where it points as its signature.
 *
 * The halves stay apart because following barrels depends on the difference: a barrel does not
 * DECLARE what it re-exports. But symbolDelta reads both, so a barrel dropping a re-export is a
 * removal to everyone importing through it — before, their import broke and nothing said so.
 */
function exportTable(ts, text, fileName) {
  const out = new Map();
  const passed = new Map();
  if (text == null) return { declared: out, passed };
  const sf = parse(ts, text, fileName);
  const printer = ts.createPrinter({ removeComments: true });
  const print = (node) => printer.printNode(ts.EmitHint.Unspecified, node, sf);
  // One name can have several declarations — function overloads, or a `const X` beside a
  // `type X` — so each export is ALL of them, in order. Keeping only the last would let a change
  // to any earlier overload's parameters pass as no change at all.
  const add = (name, decls) => {
    const body = decls.map((d) => print(d.node)).join('\n');
    const sig = decls.map((d) => (d.shape ? valueShape(ts, d.sig, print) : d.sig === d.node ? print(d.node) : print(d.sig))).join('\n');
    out.set(name, { sig: hash(sig), body: hash(body), text: body });
  };

  // Every top-level declaration, exported or not, because `function x() {}; export { x }` exports
  // it just as surely as `export function x` does — and a signature change there must not vanish.
  const local = new Map();
  const exportedHere = new Map();
  for (const st of sf.statements) {
    const mods = modifiersOf(ts, st);
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = mods.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
    const decls = declarationsIn(ts, st);
    if (exported && isDefault && (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && !st.name) {
      decls.push({ name: 'default', sig: signatureOf(ts, st), node: st });
    }
    for (const d of decls) {
      local.set(d.name, [...(local.get(d.name) ?? []), d]);
      if (exported) exportedHere.set(isDefault ? 'default' : d.name, d.name);
    }
  }
  for (const [name, declared] of exportedHere) add(name, local.get(declared));
  for (const st of sf.statements) {
    if (ts.isExportAssignment(st)) {
      const target = ts.isIdentifier(st.expression) ? local.get(st.expression.text) : null;
      add('default', target ?? [{ sig: st, node: st }]);
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        const decls = local.get((el.propertyName ?? el.name).text);
        if (decls) add(el.name.text, decls);
      }
    }
  }

  const pass = (key, target) => passed.set(key, { sig: hash(target), body: hash(target), text: target });
  const imported = new Map(); // local binding → where it came from, for `import { x } …; export { x }`
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const clause = st.importClause;
    const type = clause?.isTypeOnly ? 'type ' : '';
    if (clause?.name) imported.set(clause.name.text, `${type}default from '${spec}'`);
    const nb = clause?.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) imported.set(nb.name.text, `${type}* from '${spec}'`);
    if (nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) imported.set(el.name.text, `${type || (el.isTypeOnly ? 'type ' : '')}${(el.propertyName ?? el.name).text} from '${spec}'`);
    }
  }
  // `type ` is part of where a re-export points: `export *` becoming `export type *` keeps every
  // name and breaks every caller that uses one as a value.
  for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st)) continue;
    const typeOnly = (el) => (st.isTypeOnly || el?.isTypeOnly ? 'type ' : '');
    if (st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const spec = st.moduleSpecifier.text;
      if (!st.exportClause) pass(starKey(spec), `${typeOnly()}* from '${spec}'`);
      else if (ts.isNamespaceExport(st.exportClause)) pass(st.exportClause.name.text, `${typeOnly()}* from '${spec}'`);
      else for (const el of st.exportClause.elements) pass(el.name.text, `${typeOnly(el)}${(el.propertyName ?? el.name).text} from '${spec}'`);
    } else if (st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const el of st.exportClause.elements) {
        const from = imported.get((el.propertyName ?? el.name).text);
        if (from && !local.has((el.propertyName ?? el.name).text)) pass(el.name.text, from.startsWith('type ') ? from : `${typeOnly(el)}${from}`);
      }
    }
  }
  return { declared: out, passed };
}

/**
 * What a caller can rely on from an unannotated const's VALUE: its shape, never its contents.
 * Rewording a prompt or changing a limit changes what the code does, not how anyone calls it —
 * a body change — and reporting every such edit as a changed signature buried the real ones (the
 * plan's own live run listed a prompt-text edit to `PLANNER_SYSTEM` as MED). What the parser
 * cannot type from its shape — a call, a name, `as const`, whose literal values ARE the type —
 * stays its whole value: a loud answer rather than a silent one.
 */
function valueShape(ts, e, print) {
  if (ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) return valueShape(ts, e.expression, print);
  if (ts.isAsExpression(e)) return ts.isConstTypeReference(e.type) ? print(e) : print(e.type);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isTemplateExpression(e)) return 'string';
  if (ts.isNumericLiteral(e) || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand))) return 'number';
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword) return 'boolean';
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    const f = ts.factory;
    return print(f.createFunctionTypeNode(e.typeParameters, e.parameters, e.type ?? f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword)));
  }
  if (ts.isObjectLiteralExpression(e)) {
    return `{ ${e.properties.map((p) => (ts.isPropertyAssignment(p) ? `${print(p.name)}: ${valueShape(ts, p.initializer, print)}`
      : ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p) ? print(memberSignature(ts, p))
        : print(p))).join('; ')} }`;
  }
  if (ts.isArrayLiteralExpression(e)) return `(${[...new Set(e.elements.map((x) => valueShape(ts, x, print)))].join(' | ')})[]`;
  return print(e);
}

/** What a caller depends on, for a function or class: the declaration with its bodies removed. */
function signatureOf(ts, st) {
  const f = ts.factory;
  if (ts.isFunctionDeclaration(st)) {
    return f.updateFunctionDeclaration(st, st.modifiers, st.asteriskToken, st.name, st.typeParameters, st.parameters, st.type, undefined);
  }
  const members = st.members.filter((m) => isPublicMember(ts, m)).map((m) => memberSignature(ts, m));
  return f.updateClassDeclaration(st, st.modifiers, st.name, st.typeParameters, st.heritageClauses, members);
}

/** The named declarations one top-level statement makes, each with its signature node and whole node. */
function declarationsIn(ts, st) {
  if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
    return [{ name: st.name.text, sig: signatureOf(ts, st), node: st }];
  }
  if (ts.isVariableStatement(st)) {
    return st.declarationList.declarations.filter((d) => ts.isIdentifier(d.name)).map((d) => {
      // An annotation IS the contract. Without one, the value's shape is (see valueShape).
      if (d.type) return { name: d.name.text, sig: d.type, node: d };
      return d.initializer ? { name: d.name.text, sig: d.initializer, node: d, shape: true } : { name: d.name.text, sig: d, node: d };
    });
  }
  if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st) || ts.isModuleDeclaration(st)) {
    return [{ name: st.name.text, sig: st, node: st }];
  }
  return [];
}

/** Lines that differ between two texts, counted as a multiset — a size, not a diff. */
function lineDelta(a, b) {
  const left = new Map();
  for (const l of a.split('\n')) left.set(l, (left.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of b.split('\n')) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1); else added++;
  }
  let removed = 0;
  for (const n of left.values()) removed += n;
  return added + removed;
}

const lineCount = (t) => t.split('\n').length;

/** A file's text on one side of a subject: `before` = at its base, `after` = its working tree or ref. */
function textAt(main, s, file, side) {
  if (side === 'before') return s.base ? gitRaw(['show', `${s.base}:${file}`], main) : null;
  if (s.checkout) return readText(join(s.checkout, file));
  return s.ref ? gitRaw(['show', `${s.ref}:${file}`], main) : null;
}

/** A file this subject deleted: present at its base, gone from its working tree or ref. */
function deletedBy(main, s, file) {
  return !s.predicted && textAt(main, s, file, 'after') == null && textAt(main, s, file, 'before') != null;
}

/**
 * What a subject did to each export of one file: added, removed, a signature change, or a body
 * change. Re-exports count, keyed as exportTable keys them: a barrel that stops passing a name
 * through has removed it for everyone who imports it from there.
 */
export function symbolDelta(main, ts, s, file) {
  if (!ts || s.predicted || !isSymbolFile(file)) return [];
  const was = exportTable(ts, textAt(main, s, file, 'before'), file);
  const now = exportTable(ts, textAt(main, s, file, 'after'), file);
  const before = new Map([...was.declared, ...was.passed]);
  const after = new Map([...now.declared, ...now.passed]);
  const out = [];
  for (const [name, a] of after) {
    const b = before.get(name);
    if (!b) out.push({ name, change: 'added', lines: lineCount(a.text) });
    else if (a.sig !== b.sig) out.push({ name, change: 'signature', lines: lineDelta(b.text, a.text) });
    else if (a.body !== b.body) out.push({ name, change: 'body', lines: lineDelta(b.text, a.text) });
  }
  for (const [name, b] of before) if (!after.has(name)) out.push({ name, change: 'removed', lines: lineCount(b.text) });
  return out;
}

// ── imports, resolved exactly and followed through barrels ────────────────────

const configCache = new Map();

/** A checkout's compiler options and source list, from its own tsconfig.json. */
function projectOf(ts, root) {
  let entry = configCache.get(root);
  if (entry) return entry;
  entry = { options: { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, allowJs: true }, fileNames: [] };
  const cfgPath = join(root, 'tsconfig.json');
  if (existsSync(cfgPath)) {
    const cfg = ts.readConfigFile(cfgPath, ts.sys.readFile);
    if (!cfg.error) {
      const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, root);
      entry = { options: { ...parsed.options, allowJs: true }, fileNames: parsed.fileNames };
    }
  }
  configCache.set(root, entry);
  return entry;
}

const toPosix = (p) => p.split(sep).join('/');

/**
 * Where a subject's files are read and its imports resolved: `{ key, root, read(file), host }`. A
 * checkout is its folder. A subject with no checkout — a parked finding, main in `integrate` — is
 * its COMMIT, read through git and resolved against that commit's own file list. Resolving one
 * against the main checkout's disk dropped callers whenever the two differed: a caller main had
 * added through a barrel the main checkout had not pulled yet was never reported.
 */
function treeOf(ts, main, s) {
  if (s.checkout) return diskTree(ts, s.checkout);
  return s.ref ? commitTree(ts, main, s.ref) : diskTree(ts, main);
}

function diskTree(ts, root) {
  return { key: root, root, read: (f) => readText(join(root, f)), host: ts.sys };
}

const commitTrees = new Map();

function commitTree(ts, main, ref) {
  const key = `${main}@${ref}`;
  if (commitTrees.has(key)) return commitTrees.get(key);
  const listed = gitRaw(['ls-tree', '-r', '--name-only', '-z', ref], main);
  if (listed === null) return diskTree(ts, main); // git could not list it: the old, rougher answer
  const files = new Set(listed.split('\0').filter(Boolean));
  const dirs = new Set(['']);
  for (const f of files) for (let i = f.indexOf('/'); i !== -1; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  // Paths outside the repo — the compiler's own lib files, say — are the disk's to answer.
  const inRepo = (p) => {
    const r = toPosix(relative(main, p));
    return r.startsWith('..') || isAbsolute(r) ? null : r;
  };
  const show = (r) => (files.has(r) ? gitRaw(['show', `${ref}:${r}`], main) : null);
  const tree = {
    key,
    root: main,
    read: show,
    host: {
      fileExists: (p) => { const r = inRepo(p); return r === null ? ts.sys.fileExists(p) : files.has(r); },
      directoryExists: (p) => { const r = inRepo(p); return r === null ? ts.sys.directoryExists(p) : dirs.has(r); },
      readFile: (p) => { const r = inRepo(p); return r === null ? ts.sys.readFile(p) : show(r) ?? undefined; },
      realpath: (p) => p,
      getCurrentDirectory: () => main,
    },
  };
  commitTrees.set(key, tree);
  return tree;
}

/** A checkout path (the hook's, importersOf's) or a tree, as a tree. */
const asTree = (ts, t) => (typeof t === 'string' ? diskTree(ts, t) : t);

/** `./x.js` from `fromFile`, resolved the way the compiler resolves it — to `x.ts` under NodeNext. */
function resolveSpec(ts, tree, fromFile, spec) {
  if (!spec.startsWith('.')) return null; // packages are not ours to track
  const r = ts.resolveModuleName(spec, join(tree.root, fromFile), projectOf(ts, tree.root).options, tree.host);
  const target = r.resolvedModule?.resolvedFileName;
  if (!target) return null;
  const rel = toPosix(relative(tree.root, target));
  return rel.startsWith('..') ? null : rel;
}

/** Every import and re-export statement in a file, with its bindings. */
function moduleStatements(ts, text, fileName) {
  const out = [];
  for (const st of parse(ts, text, fileName).statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      // `typeOnly` here too: `import type { x }` passed back out passes on a type alone.
      const clause = st.importClause;
      const whole = Boolean(clause?.isTypeOnly);
      const bindings = [];
      if (clause?.name) bindings.push({ imported: 'default', local: clause.name.text, typeOnly: whole });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.push({ imported: '*', local: nb.name.text, typeOnly: whole });
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text, typeOnly: whole || el.isTypeOnly });
      }
      out.push({ spec: st.moduleSpecifier.text, bindings, isExport: false });
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      // `typeOnly`: the name passes through as a type alone — see lostThrough.
      const bindings = [];
      if (!st.exportClause) bindings.push({ imported: '*', local: null, all: true, typeOnly: st.isTypeOnly });
      else if (ts.isNamespaceExport(st.exportClause)) bindings.push({ imported: '*', local: st.exportClause.name.text, typeOnly: st.isTypeOnly });
      else {
        for (const el of st.exportClause.elements) {
          bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text, typeOnly: st.isTypeOnly || el.isTypeOnly });
        }
      }
      out.push({ spec: st.moduleSpecifier.text, bindings, isExport: true });
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      // A local export list, `export { x }`. Kept (with no spec) so that a name IMPORTED and passed
      // straight back out — `import { x } from './y.js'; export { x }` — can be followed to y.
      const bindings = st.exportClause.elements.map((el) => ({
        imported: (el.propertyName ?? el.name).text, local: el.name.text, typeOnly: st.isTypeOnly || el.isTypeOnly,
      }));
      out.push({ spec: null, bindings, isExport: true });
    }
  }
  return out;
}

/** Where a file's local binding `local` was imported from, if it was. */
function importBinding(info, local) {
  for (const st of info.statements) {
    if (st.isExport) continue;
    const b = st.bindings.find((x) => x.local === local);
    if (b) return { spec: st.spec, imported: b.imported, typeOnly: b.typeOnly };
  }
  return null;
}

const infoCache = new Map();

/** One file's exports and module statements, as a tree holds it, parsed once per process. */
function fileInfo(ts, tree, file) {
  const key = `${tree.key}\0${file}`;
  if (infoCache.has(key)) return infoCache.get(key);
  const text = tree.read(file);
  const info = text == null ? null : { exports: exportedSymbols(ts, text, file), statements: moduleStatements(ts, text, file) };
  infoCache.set(key, info);
  return info;
}

/**
 * The file that actually DECLARES `name` as exported by `file`, followed through barrels:
 * `{ file, name, via }`, where `via` is every barrel passed on the way — `{ file, key, name,
 * typeOnly }`: the key its re-export has in exportTable, the name it passes on, and whether it
 * passes it as a type alone — so a barrel that stops passing that name on is seen to break this.
 *
 * `src/db/index.ts` is `export * from './jobs.js'` and thirty-one more like it, and 48 modules
 * import through it. Without this, a signature change in `src/db/jobs.ts` would be invisible to
 * every one of them: their import resolves to the barrel, which no task ever changes.
 */
function declarerOf(ts, tree, file, name, depth = 0, seen = new Set(), via = []) {
  const key = `${file}\0${name}`;
  if (depth > 5 || seen.has(key)) return null;
  seen.add(key);
  const info = fileInfo(ts, tree, file);
  if (!info) return null;
  if (info.exports.has(name)) return { file, name, via };
  for (const st of info.statements) {
    if (!st.isExport) continue;
    if (st.spec === null) {
      // Passed through a local export list: follow the import it came in by.
      const b = st.bindings.find((x) => x.local === name);
      const from = b ? importBinding(info, b.imported) : null;
      const target = from && from.imported !== '*' ? resolveSpec(ts, tree, file, from.spec) : null;
      if (target) {
        const hops = [...via, { file, key: name, name, typeOnly: b.typeOnly || from.typeOnly }];
        return declarerOf(ts, tree, target, from.imported, depth + 1, seen, hops) ?? { file: target, name: from.imported, via: hops };
      }
      continue;
    }
    const target = resolveSpec(ts, tree, file, st.spec);
    if (!target) continue;
    for (const b of st.bindings) {
      if (b.all) {
        const hit = declarerOf(ts, tree, target, name, depth + 1, seen, [...via, { file, key: starKey(st.spec), name, typeOnly: b.typeOnly }]);
        if (hit) return hit;
      } else if (b.local === name) {
        const hops = [...via, { file, key: name, name, typeOnly: b.typeOnly }];
        return declarerOf(ts, tree, target, b.imported, depth + 1, seen, hops) ?? { file: target, name: b.imported, via: hops };
      }
    }
  }
  return null;
}

/** Everything `file` exports, declared or re-exported, each traced to its declarer (`via` as declarerOf's). */
function allExportsOf(ts, tree, file, depth = 0, seen = new Set()) {
  if (depth > 5 || seen.has(file)) return [];
  seen.add(file);
  const info = fileInfo(ts, tree, file);
  if (!info) return [];
  const out = [...info.exports.keys()].map((name) => ({ file, name, as: name, via: [] }));
  for (const st of info.statements) {
    if (!st.isExport) continue;
    if (st.spec === null) {
      for (const b of st.bindings) {
        if (info.exports.has(b.local)) continue; // declared here, so already listed above
        const d = declarerOf(ts, tree, file, b.local);
        if (d) out.push({ ...d, as: b.local });
      }
      continue;
    }
    const target = resolveSpec(ts, tree, file, st.spec);
    if (!target) continue;
    for (const b of st.bindings) {
      if (b.all) {
        for (const d of allExportsOf(ts, tree, target, depth + 1, seen)) {
          out.push({ ...d, via: [{ file, key: starKey(st.spec), name: d.as, typeOnly: b.typeOnly }, ...d.via] });
        }
      } else if (b.imported !== '*') {
        const d = declarerOf(ts, tree, target, b.imported);
        if (d) out.push({ ...d, as: b.local, via: [{ file, key: b.local, name: b.local, typeOnly: b.typeOnly }, ...d.via] });
      }
    }
  }
  return out;
}

/**
 * What `file` (with contents `text`) imports: `[{ from, names, locals, through? }]`, one entry
 * per file that DECLARES what it uses — and one per barrel it reaches that through, whose names
 * are the barrel's re-export keys (exportTable's). `locals[name]` is every way this file refers
 * to it: the local binding, or `ns.member` for a namespace import. A barrel entry's
 * `through[key][name]` is what that key passes on to this file — `{ file, name, typeOnly,
 * locals }`: the declaration it reached, whether this file only ever needs it as a type, and this
 * file's locals for it (lostThrough reads it). Re-exports count too: a barrel depends on
 * everything it re-exports. `root` is a checkout path, or a tree (treeOf).
 */
export function namedImports(ts, root, file, text) {
  const tree = asTree(ts, root);
  const byFrom = new Map();
  const note = (from, name, local) => {
    let e = byFrom.get(from);
    if (!e) { e = { from, names: [], locals: {} }; byFrom.set(from, e); }
    if (!e.names.includes(name)) { e.names.push(name); e.locals[name] = []; }
    if (!e.locals[name].includes(local)) e.locals[name].push(local);
    return e;
  };
  const noteAll = (d, local, typeImport) => {
    note(d.file, d.name, local);
    // A type-only step anywhere on the way means this file already gets it as a type alone.
    const typeOnly = typeImport || d.via.some((h) => h.typeOnly);
    for (const hop of d.via) {
      const byName = ((note(hop.file, hop.key, local).through ??= {})[hop.key] ??= {});
      const rec = (byName[hop.name] ??= { file: d.file, name: d.name, typeOnly, locals: [] });
      rec.typeOnly &&= typeOnly; // one value use anywhere, and the route must carry values
      if (!rec.locals.includes(local)) rec.locals.push(local);
    }
  };
  for (const st of moduleStatements(ts, text, file)) {
    if (st.spec === null) continue; // a local export list imports nothing; its imports are counted
    const target = resolveSpec(ts, tree, file, st.spec);
    if (!target) continue;
    for (const b of st.bindings) {
      if (b.imported === '*') {
        for (const d of allExportsOf(ts, tree, target)) noteAll(d, b.local ? `${b.local}.${d.as}` : d.as, b.typeOnly);
      } else {
        noteAll(declarerOf(ts, tree, target, b.imported) ?? { file: target, name: b.imported, via: [] }, b.local ?? b.imported, b.typeOnly);
      }
    }
  }
  return [...byFrom.values()];
}

/**
 * What re-export `key` of `imp.from` (a namedImports entry, read in `importer` — a checkout path
 * or a tree) no longer gives the importer, as subject `s` has that file now: one `{ name, why,
 * file? }` per name it passed on that is not what it was — or null when `key` is not a re-export
 * the importer came through, and the change is an ordinary one.
 *
 *   gone       the name no longer gets through at all
 *   type       it gets through as a type alone, and the importer uses it as a value
 *   signature  it now reaches a different declaration (`file`) with a different signature
 *   behaviour  … with the same signature and a different body
 *
 * A re-export key changing is not by itself a break: narrowing `export *` to the names still
 * used, or re-pointing one at the module a function moved to (same declaration text), is nothing.
 * But "the name still resolves" is not enough — re-pointed at another module's `createJob`, it
 * resolves fine and breaks every caller.
 */
export function lostThrough(main, ts, s, imp, key, importer) {
  const passed = imp.through?.[key];
  if (!passed) return null;
  const now = treeOf(ts, main, s);
  const was = asTree(ts, importer);
  const lost = [];
  for (const [name, rec] of Object.entries(passed)) {
    const hit = declarerOf(ts, now, imp.from, name);
    if (!hit) { lost.push({ name, why: 'gone' }); continue; }
    if (!rec.typeOnly && hit.via.some((h) => h.typeOnly)) { lost.push({ name, why: 'type' }); continue; }
    // The same declaration: its own changes are judged as its own, in the declaring file.
    if (hit.file === rec.file && hit.name === rec.name) continue;
    const before = fileInfo(ts, was, rec.file)?.exports.get(rec.name);
    const after = fileInfo(ts, now, hit.file)?.exports.get(hit.name);
    if (!before || !after || before.sig !== after.sig) lost.push({ name, why: 'signature', file: hit.file });
    else if (before.body !== after.body) lost.push({ name, why: 'behaviour', file: hit.file });
  }
  return lost;
}

/** How lostThrough's answer reads in a report: what each name no longer gets, and from where. */
function describeLost(lost) {
  return lost.map((l) => `\`${l.name}\` ${{
    gone: 'no longer comes through it',
    type: 'now comes through it as a type only',
    signature: `now comes from ${l.file}, with a different signature`,
    behaviour: `now comes from ${l.file}: same signature, different body`,
  }[l.why]}`).join('; ');
}

/**
 * How many times `local` is referenced in `text` — the size of a dependency, loosely "call sites".
 * `ns.member` counts property accesses of that member. The import binding itself is not counted.
 */
export function callSites(ts, text, local, fileName = 'x.ts') {
  if (text == null) return 0;
  const [head, member] = local.split('.');
  let n = 0;
  const visit = (node) => {
    if (member) {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === head && node.name.text === member) n++;
    } else if (ts.isIdentifier(node) && node.text === head) {
      const p = node.parent;
      const declaresIt = ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p);
      const isPropertyName = (ts.isPropertyAccessExpression(p) && p.name === node) || (ts.isPropertyAssignment(p) && p.name === node);
      if (!declaresIt && !isPropertyName) n++;
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(ts, text, fileName));
  return n;
}

const importerIndex = new Map();

/** How many non-test modules in `root` import `name` from its declaring `file`, barrels included. */
export function importersOf(ts, root, file, name) {
  let index = importerIndex.get(root);
  if (!index) {
    index = new Map();
    for (const abs of projectOf(ts, root).fileNames) {
      const rel = toPosix(relative(root, abs));
      const text = isSymbolFile(rel) ? readText(abs) : null;
      if (text == null) continue;
      for (const e of namedImports(ts, root, rel, text)) {
        for (const n of e.names) {
          const k = `${e.from}\0${n}`;
          index.set(k, (index.get(k) ?? 0) + 1);
        }
      }
    }
    importerIndex.set(root, index);
  }
  return index.get(`${file}\0${name}`) ?? 0;
}

// ── overlaps, sized ───────────────────────────────────────────────────────────

/** Worst first. `?` is a check that could not finish — first, because nothing below it is complete. */
export const SEVERITY = { '?': -1, HIGH: 0, MED: 1, LOW: 2 };

/** `1 line`, `2 lines` — the sizes are read by people deciding whether to proceed. */
const lineCountLabel = (n) => `${n} line${n === 1 ? '' : 's'}`;

const describeChange = (c) => (c.change === 'removed' ? 'removed' : `${c.change}, ${lineCountLabel(c.lines)}`);

function listChanges(delta) {
  if (!delta.length) return 'internal code only';
  const shown = delta.slice(0, 4).map((c) => `\`${c.name}\` (${describeChange(c)})`).join(', ');
  return delta.length > 4 ? `${shown} and ${delta.length - 4} more` : shown;
}

/**
 * Where subjects `a` and `b` collide, worst first. Each item carries its size, because the
 * operator decides from how big an overlap is, not merely from whether one exists:
 *
 *   HIGH  same function        both changed (or a parked finding names) the same export
 *   HIGH  deleted file         one side deletes a file the other changes or names
 *   MED   changed signature    one side changed or removed an export the other side calls
 *   MED   calls what it names  a parked finding names an export the other side calls
 *   LOW   changed behaviour    one side changed the body of something the other calls
 *   LOW   same file only       both touch a file, different functions (git merges or conflicts loudly)
 *   LOW   generated file       regenerate it after merging; never merge it by hand
 *   ?     not checked          git could not read part of one side, so this report is incomplete
 */
export function overlaps(main, ts, a, b) {
  const ra = readFootprint(main, a);
  const rb = readFootprint(main, b);
  const fa = ra.files;
  const fb = rb.files;
  const deltas = new Map();
  const delta = (s, f) => {
    const k = `${s.label}\0${f}`;
    if (!deltas.has(k)) deltas.set(k, symbolDelta(main, ts, s, f));
    return deltas.get(k);
  };
  const mentioned = (s, f) => {
    if (!ts || !isSymbolFile(f)) return [];
    const exports = exportedSymbols(ts, textAt(main, s, f, 'after'), f);
    return s.mentions.filter((m) => exports.has(m));
  };
  const items = [];
  // A side git could not fully read is an incomplete check, never a clean one: said first, and
  // enough on its own to stop spawn (user, 2026-09-10: warn, never proceed on its own).
  for (const [s, r] of [[a, ra], [b, rb]]) {
    if (r.unread.length) {
      items.push({ severity: '?', kind: 'not checked', file: '', symbol: '', detail: `git could not read ${r.unread.join(', or ')} (${s.label}) — a timeout, a held lock or a broken checkout; what follows is incomplete, not clean`, sizes: {} });
    }
  }
  const high = new Set();
  // What each side has REALLY changed, per git — as against files it only lists. A task's
  // `files:` can name a file it has not touched yet, and "X changes it" about such a file is a
  // claim the report has not earned (found live, on a task whose HEAD still equalled its base).
  const gitOf = (s) => (s === a ? ra.changed : rb.changed);
  const sideOf = (s, f, d) => {
    if (s.predicted) return `${s.label} names it`;
    if (!gitOf(s).has(f)) return `${s.label} lists it but has not changed it`;
    return d ? `${s.label} changed ${listChanges(d)}` : `${s.label} changes it`;
  };

  for (const f of fa) {
    if (!fb.has(f)) continue;
    if (GENERATED.has(f)) {
      items.push({ severity: 'LOW', kind: 'generated file', file: f, symbol: '', detail: `${sideOf(a, f, null)}; ${sideOf(b, f, null)} — regenerate it after merging (${GENERATED.get(f)}); never merge it by hand`, sizes: {} });
      continue;
    }
    // A deletion against an edit is one collision, whatever the functions inside say: whichever
    // lands second either resurrects the file or loses the other side's work. Found live: a
    // branch that deleted src/jobs/watchers.ts came out as "same file only" against one editing it.
    const goneA = deletedBy(main, a, f);
    const goneB = deletedBy(main, b, f);
    if (goneA || goneB) {
      if (goneA && goneB) {
        items.push({ severity: 'LOW', kind: 'same file only', file: f, symbol: '', detail: 'both delete it', sizes: {} });
        continue;
      }
      const [gone, kept] = goneA ? [a, b] : [b, a];
      const keptSide = sideOf(kept, f, ts && isSymbolFile(f) ? delta(kept, f) : null);
      items.push({ severity: 'HIGH', kind: 'deleted file', file: f, symbol: '', detail: `${gone.label} deletes this file; ${keptSide}`, sizes: {} });
      continue;
    }
    if (!ts || !isSymbolFile(f) || (a.predicted && b.predicted)) {
      items.push({ severity: 'LOW', kind: 'same file only', file: f, symbol: '', detail: `${sideOf(a, f, null)}; ${sideOf(b, f, null)}`, sizes: {} });
      continue;
    }
    const da = delta(a, f);
    const db = delta(b, f);
    const namesA = a.predicted ? mentioned(a, f) : da.map((c) => c.name);
    const namesB = b.predicted ? mentioned(b, f) : db.map((c) => c.name);
    const shared = namesA.filter((n) => namesB.includes(n));
    for (const name of shared) {
      high.add(`${f}\0${name}`);
      const side = (s, d) => {
        const c = d.find((x) => x.name === name);
        return s.predicted ? `${s.label} names this file and mentions \`${name}\`` : `${s.label} changed it (${describeChange(c)})`;
      };
      const sizes = {};
      if (!a.predicted) sizes[a.label] = da.find((x) => x.name === name).lines;
      if (!b.predicted) sizes[b.label] = db.find((x) => x.name === name).lines;
      items.push({ severity: 'HIGH', kind: 'same function', file: f, symbol: name, detail: `${side(a, da)}; ${side(b, db)}`, sizes });
    }
    if (!shared.length) {
      items.push({ severity: 'LOW', kind: 'same file only', file: f, symbol: '', detail: `${sideOf(a, f, da)}; ${sideOf(b, f, db)}`, sizes: {} });
    }
  }

  // One side changed an export the other side's files use. Aggregated per export, so the report
  // says "called at 3 sites in 2 files" once rather than once per file.
  const dependents = (x, y, fx, fy) => {
    if (!ts) return;
    // A parked finding has changed nothing yet, but the functions it names are the ones it means
    // to change — so a task calling one of them is exactly what `spawn` has to stop and show.
    const changesOf = (f) => (x.predicted ? mentioned(x, f).map((name) => ({ name, change: 'named', lines: 0 })) : delta(x, f));
    const hits = new Map();
    const tree = treeOf(ts, main, y);
    for (const g of fy) {
      if (!isSymbolFile(g)) continue;
      const text = textAt(main, y, g, 'after');
      if (text == null) continue;
      for (const imp of namedImports(ts, tree, g, text)) {
        // A generated file's "signature change" is a regeneration, and 31 modules import the
        // generated database types — reporting each as MED would bury every real item.
        if (imp.from === g || GENERATED.has(imp.from) || !fx.has(imp.from)) continue;
        for (const c of changesOf(imp.from)) {
          if (c.change === 'added' || !imp.names.includes(c.name) || high.has(`${imp.from}\0${c.name}`)) continue;
          // A re-export this file came through: only what it no longer gets the same way counts.
          const lost = x.predicted ? null : lostThrough(main, ts, x, imp, c.name, tree);
          if (lost && !lost.length) continue;
          const k = `${imp.from}\0${c.name}`;
          const hit = hits.get(k) ?? { c, from: imp.from, files: [], sites: 0, lost: null };
          hit.files.push(g);
          const locals = lost ? lost.flatMap((l) => imp.through[c.name][l.name].locals) : imp.locals[c.name];
          for (const local of locals) hit.sites += callSites(ts, text, local, g);
          if (lost) hit.lost = [...(hit.lost ?? []), ...lost.filter((l) => !hit.lost?.some((m) => m.name === l.name))];
          hits.set(k, hit);
        }
      }
    }
    for (const { c, from, files, sites, lost } of hits.values()) {
      const changed = files.filter((g) => gitOf(y).has(g)).length;
      const verb = y.predicted ? 'names' : changed === files.length ? 'changes' : changed === 0 ? 'lists' : 'touches';
      const where = `called at ${sites} site${sites === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'} ${y.label} ${verb} (${files.join(', ')})`;
      // `changer` and `callers` say which side did what, so a caller of `integrate` can look for
      // the commits in the right files: the changer's in `file`, the other side's in `callers`.
      const who = { changer: x.label, callers: files };
      // Re-pointed at a same-signature function with another body: what it does changed, not how it is called.
      if (lost && lost.every((l) => l.why === 'behaviour')) {
        items.push({ severity: 'LOW', kind: 'changed behaviour', file: from, symbol: c.name, detail: `${x.label} re-pointed it — ${describeLost(lost)}; ${where}`, sizes: { callSites: sites }, ...who });
        continue;
      }
      if (c.change === 'body') {
        items.push({ severity: 'LOW', kind: 'changed behaviour', file: from, symbol: c.name, detail: `${x.label} changed what it does (${lineCountLabel(c.lines)}); ${where}`, sizes: { [x.label]: c.lines, callSites: sites }, ...who });
        continue;
      }
      const importers = importersOf(ts, main, from, c.name);
      const repoWide = `${importers} module${importers === 1 ? ' imports' : 's import'} it repo-wide`;
      if (c.change === 'named') {
        items.push({ severity: 'MED', kind: 'calls what it names', file: from, symbol: c.name, detail: `${x.label} names this file and mentions \`${c.name}\`; ${where}; ${repoWide}`, sizes: { callSites: sites, importers }, ...who });
      } else {
        const what = lost
          ? `${c.change === 'removed' ? 'removed it' : 'changed it'} — ${describeLost(lost)}`
          : c.change === 'removed' ? 'removed it' : `changed its signature (${lineCountLabel(c.lines)})`;
        items.push({ severity: 'MED', kind: 'changed signature', file: from, symbol: c.name, detail: `${x.label} ${what}; ${where}; ${repoWide}`, sizes: { [x.label]: c.lines, callSites: sites, importers }, ...who });
      }
    }
  };
  dependents(a, b, fa, fb);
  dependents(b, a, fb, fa);

  return items.sort((p, q) => SEVERITY[p.severity] - SEVERITY[q.severity] || p.file.localeCompare(q.file) || p.symbol.localeCompare(q.symbol));
}
