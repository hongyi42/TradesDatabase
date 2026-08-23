// PreToolUse(Edit|Write) — hand the session the decisions that govern the file it is about
// to change, without the session having to know they exist.
//
// Why: this repo's decision record is ~150 documents plus a 3000-line engineering memory. A
// session cannot be expected to go looking, and by the time it would think to, it has already
// written the edit. So the record comes to it instead, at the one moment it matters.
//
// Contract (verified against https://code.claude.com/docs/en/hooks, 2026-08-22):
//   in  — JSON on stdin: { session_id, cwd, tool_name, tool_input: { file_path, ... } }
//   out — JSON on stdout: { additionalContext } and exit 0.  `additionalContext` is a
//         TOP-LEVEL field, not under hookSpecificOutput.
//
// This hook must never block an edit. Every failure path exits 0 silently.

import { readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

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

  const root = process.env.CLAUDE_PROJECT_DIR || evt.cwd || process.cwd();
  const rel = isAbsolute(filePath) ? relative(root, filePath) : filePath;
  if (!rel || rel.startsWith('..')) return quiet(); // outside the repo

  const indexPath = join(root, 'thoughts', 'by-file.json');
  if (!existsSync(indexPath)) return quiet(); // index not built yet — stay out of the way

  let byFile;
  try {
    byFile = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch {
    return quiet();
  }

  const hits = byFile[rel];
  if (!Array.isArray(hits) || hits.length === 0) return quiet();

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
    if (h.drift >= 15) signals.push(`code moved ${h.drift} commits since`);
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

  const context = [
    `Decisions on record for ${rel}:`,
    '',
    ...lines,
    '',
    'These are prior decisions about this exact file. Check them before changing its behaviour —'
      + ' re-deciding something already settled, or reviving something already rejected, is the'
      + ' failure this index exists to prevent. Where a note says the code has moved, the'
      + ' DECISION still stands; only the document\'s description of the code is stale.'
      + ' Full index: thoughts/INDEX.md',
  ].join('\n');

  process.stdout.write(JSON.stringify({ additionalContext: context }));
  process.exit(0);
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
