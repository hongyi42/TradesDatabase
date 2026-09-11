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

import { readFileSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
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
      timeout: 3000,
    });
  } catch {
    return null;
  }
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

/** Words in a parked finding's prose that could be function names. Matched against exports later. */
function identifiers(text) {
  return [...new Set(text.match(/[A-Za-z_$][\w$]{2,}/g) ?? [])];
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
export function subjectFromTask(main, fm, body = '') {
  const def = defaultRef(main);
  const at = def ? sha(def, main) : null;
  const files = listField(fm.files);
  if (fm.status === 'open') {
    // Parked: nothing is changed yet. It names files, and its prose may name the functions it is
    // about — those are what an overlap can be measured against.
    return {
      label: fm.id, checkout: null, ref: at, base: at, files, mentions: identifiers(`${fm.title ?? ''}\n${body}`), predicted: true,
    };
  }
  if (fm.worktree && existsSync(fm.worktree)) {
    const ref = sha('HEAD', fm.worktree);
    const live = def ? git(['merge-base', 'HEAD', def], fm.worktree) : null;
    return {
      label: fm.id, checkout: fm.worktree, ref, base: live || fm.base || ref, files, mentions: [], predicted: false,
    };
  }
  // `refs/heads/` explicitly: a task claimed on a detached HEAD records its branch as `HEAD`, and
  // resolving that bare name here would hand the task the MAIN checkout's commit.
  const branchSha = fm.branch && fm.branch !== 'HEAD' ? sha(`refs/heads/${fm.branch}`, main) : null;
  if (branchSha) {
    const live = def ? git(['merge-base', branchSha, def], main) : null;
    return {
      label: fm.id, checkout: null, ref: branchSha, base: live || fm.base || branchSha, files, mentions: [], predicted: false,
    };
  }
  // Closed, and its checkout and branch are gone: all that is left is the list of files it named.
  return { label: fm.id, checkout: null, ref: at, base: at, files, mentions: [], predicted: false };
}

/** A branch that may have no task — a stale worktree, say. Its checkout, if one holds it, adds uncommitted work. */
export function subjectFromBranch(main, branch) {
  const ref = sha(branch, main);
  if (!ref) return null;
  const def = defaultRef(main);
  const base = (def && git(['merge-base', ref, def], main)) || ref;
  const checkout = worktreeHolding(main, branch);
  const head = checkout ? sha('HEAD', checkout) : ref;
  return { label: branch, checkout, ref: head || ref, base, files: [], mentions: [], predicted: false };
}

/** What main has changed since `checkout` last took it — the "main moved under you" subject. */
export function mainSince(main, checkout, fallbackBase) {
  const def = defaultRef(main);
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
  const out = new Set();
  // `-z` on both: without it git quotes and backslash-escapes any path with an accent or a quote
  // in it, so one file would arrive in two spellings and match neither the other nor `files:`.
  // `--no-renames` on both: rename detection reports a move as its NEW path only, and the old
  // path — the one a sibling is still editing, or importing — would vanish from the footprint.
  // Without detection a move is what it is to everyone else: a deletion plus a new file.
  if (s.base && s.ref && s.base !== s.ref) {
    for (const f of (gitRaw(['diff', '--name-only', '--no-renames', '-z', `${s.base}...${s.ref}`], s.checkout ?? main) ?? '').split('\0')) {
      if (f) out.add(f);
    }
  }
  if (s.checkout) {
    // Read raw, never trimmed: porcelain's status column can begin with a space, and trimming it
    // once ate the first letter of a filename (work.mjs:58-65). With renames off, every entry is
    // one `XY path`; a copy (`C`) is the one pair left, `XY new\0old\0`, so its old path is skipped.
    const parts = (gitRaw(['status', '--porcelain', '--no-renames', '-z', '-uall'], s.checkout) ?? '').split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      out.add(entry.slice(3));
      if (entry[0] === 'C' || entry[1] === 'C') i++;
    }
  }
  for (const f of s.files) out.add(f);
  out.delete('supabase/config.toml');
  for (const f of out) if (f === 'node_modules' || f.startsWith('node_modules/')) out.delete(f);
  return out;
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
  const out = new Map();
  if (text == null) return out;
  const sf = parse(ts, text, fileName);
  const printer = ts.createPrinter({ removeComments: true });
  const print = (node) => printer.printNode(ts.EmitHint.Unspecified, node, sf);
  // One name can have several declarations — function overloads, or a `const X` beside a
  // `type X` — so each export is ALL of them, in order. Keeping only the last would let a change
  // to any earlier overload's parameters pass as no change at all.
  const add = (name, decls) => {
    const body = decls.map((d) => print(d.node)).join('\n');
    const sig = decls.map((d) => (d.sig === d.node ? print(d.node) : print(d.sig))).join('\n');
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
  return out;
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
  const f = ts.factory;
  if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
    return [{ name: st.name.text, sig: signatureOf(ts, st), node: st }];
  }
  if (ts.isVariableStatement(st)) {
    return st.declarationList.declarations.filter((d) => ts.isIdentifier(d.name)).map((d) => {
      const init = d.initializer;
      // An annotation IS the contract. Without one, a function-valued const is its parameters;
      // anything else (a config object, a string constant) is its value.
      const sig = d.type ? d.type
        : init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
          ? f.createFunctionTypeNode(init.typeParameters, init.parameters, init.type ?? f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword))
          : init ?? d;
      return { name: d.name.text, sig, node: d };
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

/** What a subject did to each export of one file: added, removed, a signature change, or a body change. */
export function symbolDelta(main, ts, s, file) {
  if (!ts || s.predicted || !isSymbolFile(file)) return [];
  const before = exportedSymbols(ts, textAt(main, s, file, 'before'), file);
  const after = exportedSymbols(ts, textAt(main, s, file, 'after'), file);
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

/** `./x.js` from `fromFile`, resolved the way the compiler resolves it — to `x.ts` under NodeNext. */
function resolveSpec(ts, root, fromFile, spec) {
  if (!spec.startsWith('.')) return null; // packages are not ours to track
  const r = ts.resolveModuleName(spec, join(root, fromFile), projectOf(ts, root).options, ts.sys);
  const target = r.resolvedModule?.resolvedFileName;
  if (!target) return null;
  const rel = toPosix(relative(root, target));
  return rel.startsWith('..') ? null : rel;
}

/** Every import and re-export statement in a file, with its bindings. */
function moduleStatements(ts, text, fileName) {
  const out = [];
  for (const st of parse(ts, text, fileName).statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier)) {
      const clause = st.importClause;
      const bindings = [];
      if (clause?.name) bindings.push({ imported: 'default', local: clause.name.text });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) bindings.push({ imported: '*', local: nb.name.text });
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
      }
      out.push({ spec: st.moduleSpecifier.text, bindings, isExport: false });
    } else if (ts.isExportDeclaration(st) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      const bindings = [];
      if (!st.exportClause) bindings.push({ imported: '*', local: null, all: true });
      else if (ts.isNamespaceExport(st.exportClause)) bindings.push({ imported: '*', local: st.exportClause.name.text });
      else for (const el of st.exportClause.elements) bindings.push({ imported: (el.propertyName ?? el.name).text, local: el.name.text });
      out.push({ spec: st.moduleSpecifier.text, bindings, isExport: true });
    } else if (ts.isExportDeclaration(st) && !st.moduleSpecifier && st.exportClause && ts.isNamedExports(st.exportClause)) {
      // A local export list, `export { x }`. Kept (with no spec) so that a name IMPORTED and passed
      // straight back out — `import { x } from './y.js'; export { x }` — can be followed to y.
      const bindings = st.exportClause.elements.map((el) => ({ imported: (el.propertyName ?? el.name).text, local: el.name.text }));
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
    if (b) return { spec: st.spec, imported: b.imported };
  }
  return null;
}

const infoCache = new Map();

/** One on-disk file's exports and module statements, parsed once per process. */
function fileInfo(ts, root, file) {
  const key = `${root}\0${file}`;
  if (infoCache.has(key)) return infoCache.get(key);
  const text = readText(join(root, file));
  const info = text == null ? null : { exports: exportedSymbols(ts, text, file), statements: moduleStatements(ts, text, file) };
  infoCache.set(key, info);
  return info;
}

/**
 * The file that actually DECLARES `name` as exported by `file`, followed through barrels.
 *
 * `src/db/index.ts` is `export * from './jobs.js'` and thirty-one more like it, and 48 modules
 * import through it. Without this, a signature change in `src/db/jobs.ts` would be invisible to
 * every one of them: their import resolves to the barrel, which no task ever changes.
 */
function declarerOf(ts, root, file, name, depth = 0, seen = new Set()) {
  const key = `${file}\0${name}`;
  if (depth > 5 || seen.has(key)) return null;
  seen.add(key);
  const info = fileInfo(ts, root, file);
  if (!info) return null;
  if (info.exports.has(name)) return { file, name };
  for (const st of info.statements) {
    if (!st.isExport) continue;
    if (st.spec === null) {
      // Passed through a local export list: follow the import it came in by.
      const b = st.bindings.find((x) => x.local === name);
      const via = b ? importBinding(info, b.imported) : null;
      const target = via && via.imported !== '*' ? resolveSpec(ts, root, file, via.spec) : null;
      if (target) return declarerOf(ts, root, target, via.imported, depth + 1, seen) ?? { file: target, name: via.imported };
      continue;
    }
    const target = resolveSpec(ts, root, file, st.spec);
    if (!target) continue;
    for (const b of st.bindings) {
      if (b.all) {
        const hit = declarerOf(ts, root, target, name, depth + 1, seen);
        if (hit) return hit;
      } else if (b.local === name) {
        return declarerOf(ts, root, target, b.imported, depth + 1, seen) ?? { file: target, name: b.imported };
      }
    }
  }
  return null;
}

/** Everything `file` exports, declared or re-exported, each traced to its declarer. */
function allExportsOf(ts, root, file, depth = 0, seen = new Set()) {
  if (depth > 5 || seen.has(file)) return [];
  seen.add(file);
  const info = fileInfo(ts, root, file);
  if (!info) return [];
  const out = [...info.exports.keys()].map((name) => ({ file, name, as: name }));
  for (const st of info.statements) {
    if (!st.isExport) continue;
    if (st.spec === null) {
      for (const b of st.bindings) {
        if (info.exports.has(b.local)) continue; // declared here, so already listed above
        const d = declarerOf(ts, root, file, b.local);
        if (d) out.push({ ...d, as: b.local });
      }
      continue;
    }
    const target = resolveSpec(ts, root, file, st.spec);
    if (!target) continue;
    for (const b of st.bindings) {
      if (b.all) out.push(...allExportsOf(ts, root, target, depth + 1, seen));
      else if (b.imported !== '*') {
        const d = declarerOf(ts, root, target, b.imported);
        if (d) out.push({ ...d, as: b.local });
      }
    }
  }
  return out;
}

/**
 * What `file` (with contents `text`) imports, grouped by the file that DECLARES each name:
 * `[{ from, names, locals }]`, where `locals[name]` is how this file refers to it — the local
 * binding, or `ns.member` for a namespace import. Re-exports count too: a barrel depends on
 * everything it re-exports. `root` is the checkout whose files the specifiers resolve against.
 */
export function namedImports(ts, root, file, text) {
  const byFrom = new Map();
  const note = (from, name, local) => {
    let e = byFrom.get(from);
    if (!e) { e = { from, names: [], locals: {} }; byFrom.set(from, e); }
    if (!e.names.includes(name)) { e.names.push(name); e.locals[name] = local; }
  };
  for (const st of moduleStatements(ts, text, file)) {
    if (st.spec === null) continue; // a local export list imports nothing; its imports are counted
    const target = resolveSpec(ts, root, file, st.spec);
    if (!target) continue;
    for (const b of st.bindings) {
      if (b.imported === '*') {
        for (const d of allExportsOf(ts, root, target)) note(d.file, d.name, b.local ? `${b.local}.${d.as}` : d.as);
      } else {
        const d = declarerOf(ts, root, target, b.imported) ?? { file: target, name: b.imported };
        note(d.file, d.name, b.local ?? b.imported);
      }
    }
  }
  return [...byFrom.values()];
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

const SEVERITY = { HIGH: 0, MED: 1, LOW: 2 };

const describeChange = (c) => (c.change === 'removed' ? 'removed' : c.change === 'added' ? `added, ${c.lines} lines` : `${c.change}, ${c.lines} lines`);

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
 */
export function overlaps(main, ts, a, b) {
  const fa = footprint(main, a);
  const fb = footprint(main, b);
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
  const high = new Set();

  for (const f of fa) {
    if (!fb.has(f)) continue;
    if (GENERATED.has(f)) {
      items.push({ severity: 'LOW', kind: 'generated file', file: f, symbol: '', detail: `both change it — regenerate it after merging (${GENERATED.get(f)}); never merge it by hand`, sizes: {} });
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
      const keptSide = kept.predicted ? `${kept.label} names it`
        : `${kept.label} changes it${ts && isSymbolFile(f) ? ` (${listChanges(delta(kept, f))})` : ''}`;
      items.push({ severity: 'HIGH', kind: 'deleted file', file: f, symbol: '', detail: `${gone.label} deletes this file; ${keptSide}`, sizes: {} });
      continue;
    }
    if (!ts || !isSymbolFile(f) || (a.predicted && b.predicted)) {
      const who = a.predicted && b.predicted ? 'both name it'
        : a.predicted || b.predicted ? `${a.predicted ? b.label : a.label} changes it; ${a.predicted ? a.label : b.label} names it`
          : 'both change it';
      items.push({ severity: 'LOW', kind: 'same file only', file: f, symbol: '', detail: who, sizes: {} });
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
      const detail = a.predicted || b.predicted
        ? `${a.predicted ? b.label : a.label} changed ${listChanges(a.predicted ? db : da)}; ${a.predicted ? a.label : b.label} names this file`
        : `${a.label} changed ${listChanges(da)}; ${b.label} changed ${listChanges(db)}`;
      items.push({ severity: 'LOW', kind: 'same file only', file: f, symbol: '', detail, sizes: {} });
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
    const root = y.checkout ?? main;
    for (const g of fy) {
      if (!isSymbolFile(g)) continue;
      const text = textAt(main, y, g, 'after');
      if (text == null) continue;
      for (const imp of namedImports(ts, root, g, text)) {
        // A generated file's "signature change" is a regeneration, and 31 modules import the
        // generated database types — reporting each as MED would bury every real item.
        if (imp.from === g || GENERATED.has(imp.from) || !fx.has(imp.from)) continue;
        for (const c of changesOf(imp.from)) {
          if (c.change === 'added' || !imp.names.includes(c.name) || high.has(`${imp.from}\0${c.name}`)) continue;
          const k = `${imp.from}\0${c.name}`;
          const hit = hits.get(k) ?? { c, from: imp.from, files: [], sites: 0 };
          hit.files.push(g);
          hit.sites += callSites(ts, text, imp.locals[c.name], g);
          hits.set(k, hit);
        }
      }
    }
    for (const { c, from, files, sites } of hits.values()) {
      const where = `called at ${sites} site${sites === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'} ${y.label} ${y.predicted ? 'names' : 'changes'} (${files.join(', ')})`;
      if (c.change === 'body') {
        items.push({ severity: 'LOW', kind: 'changed behaviour', file: from, symbol: c.name, detail: `${x.label} changed what it does (${c.lines} lines); ${where}`, sizes: { [x.label]: c.lines, callSites: sites } });
        continue;
      }
      const importers = importersOf(ts, main, from, c.name);
      const repoWide = `${importers} module${importers === 1 ? ' imports' : 's import'} it repo-wide`;
      if (c.change === 'named') {
        items.push({ severity: 'MED', kind: 'calls what it names', file: from, symbol: c.name, detail: `${x.label} names this file and mentions \`${c.name}\`; ${where}; ${repoWide}`, sizes: { callSites: sites, importers } });
      } else {
        const what = c.change === 'removed' ? 'removed it' : `changed its signature (${c.lines} lines)`;
        items.push({ severity: 'MED', kind: 'changed signature', file: from, symbol: c.name, detail: `${x.label} ${what}; ${where}; ${repoWide}`, sizes: { [x.label]: c.lines, callSites: sites, importers } });
      }
    }
  };
  dependents(a, b, fa, fb);
  dependents(b, a, fb, fa);

  return items.sort((p, q) => SEVERITY[p.severity] - SEVERITY[q.severity] || p.file.localeCompare(q.file) || p.symbol.localeCompare(q.symbol));
}
