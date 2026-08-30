import { listMemoryPaths, readMemoryFile } from '../db/plannerMemory.js';

// The planner's memory, above the raw store (plan 2026-08-30, Build 3). This is
// where the RAILS and the RENDERING live; src/db/plannerMemory.ts is an import
// leaf and holds only the four database operations.
//
// WHAT IS DELIBERATELY NOT HERE. There is no date rail (user, 2026-08-30,
// overriding the 2026-08-28 "code enforces the date rail" direction). The rail
// lessons.ts carried was built for a 300-character sentence, where refusing on
// one bad date costs one rule; on a 4,000-character document one stray date
// would refuse the whole write — and a to-do file, the thing we most want to
// watch for, is exactly the file that carries dates. The consequence is
// recorded rather than mitigated: the planner can write an absolute date into a
// memory and nothing stops it going stale except reconcile-first.
//
// There is also no evidence check and no citation stamp. Those retired with
// planner_lessons. Reconcile-first is what replaces all of them, which is why
// its paragraph in PLANNER_SYSTEM is load-bearing rather than advisory.

/** The one path that is structurally reserved — the database CHECK enforces it. */
export const MEMORY_INDEX_PATH = 'MEMORY.md';

// BOUNDING THE INDEX IS ABOUT ATTENTION, NOT MONEY. It rides in every prompt,
// so an index that grows without limit crowds out the gaps it exists to serve.
export const MEMORY_INDEX_MAX = 3000;
// Sized against PLANNER_MAX_TOKENS = 8192, which the model SHARES with its
// reasoning at reasoningEffort 'medium'. A write big enough to hit
// finish_reason=length throws out of runToolLoop and kills the whole firm's
// tick — not just the write — so this ceiling protects the tick, not the table.
export const MEMORY_FILE_MAX = 4000;
// How many un-indexed files the footer names before it starts counting.
export const ORPHANS_SHOWN = 10;

// Mirrors the database CHECK exactly (see the migration header). Duplicated in
// TypeScript for ONE reason: to answer with an instructive sentence instead of
// a Postgres constraint-violation string. The database remains the authority.
const PATH_SHAPE = /^(MEMORY\.md|[a-z0-9][a-z0-9/_-]{0,120}\.md)$/;

const SHAPE_RULE =
  'a path must be lowercase letters, digits, "-", "_" and "/" and end in ".md" ' +
  `(for example "firm/pacing.md"), or exactly "${MEMORY_INDEX_PATH}"`;

/**
 * The path rail. Refuses `..` and `//` with their own messages BEFORE the shape
 * check, because those two are the mistakes worth naming precisely — and `//`
 * in particular the database's CHECK does NOT catch (`/` is a legal character,
 * so `a//b.md` passes it). This is the only guard against an empty path
 * segment.
 */
export function validateMemoryPath(raw: unknown): { path: string } | { refused: string } {
  if (typeof raw !== 'string' || raw.length === 0) return { refused: 'path is required' };
  if (raw.includes('..')) {
    return { refused: `".." is not allowed in a path — ${SHAPE_RULE}` };
  }
  if (raw.includes('//')) {
    return { refused: `an empty folder name ("//") is not allowed — ${SHAPE_RULE}` };
  }
  if (!PATH_SHAPE.test(raw)) return { refused: `'${raw}' is not a usable path — ${SHAPE_RULE}` };
  return { path: raw };
}

/**
 * The size rail. REFUSED with an instructive error, never truncated and never
 * auto-pruned (the activateLesson precedent): a silently trimmed memory is a
 * memory whose last sentence is missing, and the planner would never learn it.
 */
export function validateMemoryContent(
  path: string,
  content: string,
): { content: string } | { refused: string } {
  const budget = path === MEMORY_INDEX_PATH ? MEMORY_INDEX_MAX : MEMORY_FILE_MAX;
  if (content.length > budget) {
    return {
      refused:
        `that is ${content.length} characters and the limit for ${path} is ${budget} — ` +
        (path === MEMORY_INDEX_PATH
          ? 'the index rides in every prompt, so keep it a list of pointers and move the ' +
            'detail into files'
          : 'split it into two files, or drop what is no longer true'),
    };
  }
  return { content };
}

/** The footer's opening words. ONE definition — the doctrine in PLANNER_SYSTEM
 *  teaches this exact string, and a test pins that the two still agree. */
export const ORPHAN_FOOTER_PREFIX = 'not in your index: ';

// Lines that would forge one of the prompt's own structures. `gap ` opens every
// gap block (planner.ts:793) and a SHOUTED word followed by ':' or '.' is how
// every section of PLANNER_SYSTEM announces itself.
//
// The all-caps rule is the plan's; the LITERALS below go beyond it, and the
// reason is that the index now sits at the TOP of the user message. Everything
// in this list is a mixed-case line the prompt itself writes at column zero
// AFTER the index — so a memory could open with `Right now it is <wrong date>.`
// and the model would meet the forgery before the real clock line. No all-caps
// pattern can reach these; only naming them can.
const FORGED_LINE_STARTS = [
  'Right now it is ',
  'In UTC that instant is ',
  'This firm has ',
  'You last planned for this firm at ',
  'You are scheduled to think about it ',
  'This is the first time you have planned ',
  'YOUR OWN NOTES',
  // trimEnd: with the trailing space, `not in your index:phantom.md` matches
  // neither this literal nor the all-caps rule (lowercase 'n') and reaches
  // column zero unescaped.
  ORPHAN_FOOTER_PREFIX.trimEnd(),
];
const FORGED_HEADING = /^([A-Z][A-Z ]{3,}[.:]|gap )/;

// A false positive here costs ONE SPACE on a line of prose that still reads
// perfectly ("This firm has two vans" indented by one). That asymmetry is why
// the list can be generous.
const forgesStructure = (line: string): boolean =>
  FORGED_HEADING.test(line) || FORGED_LINE_STARTS.some((p) => line.startsWith(p));

// Every C0 control except tab and newline, plus DEL. Carriage return goes
// too, so a CRLF document collapses to plain newlines rather than leaving
// stray returns mid-prompt. Written with escapes on purpose: the literal
// characters are invisible in a diff, which is how a class like this quietly
// loses a range.
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/**
 * Neutralise memory text before it is pasted into the user message.
 *
 * The planner wrote this text, so why guard it at all? Because the planner also
 * READS technician notes and customer mail, and nothing stops it copying a line
 * from one into its own notes. That is the laundering path: untrusted text
 * enters as data, gets stored as the planner's own words, and comes back as
 * PROMPT. One space in front of a forged heading is enough to break it — the
 * line still reads normally to the model, it just no longer sits at column zero
 * where the real headings live.
 *
 * NOT A COMPLETE DEFENCE, and the limit is worth knowing: only the FIRST line
 * of a forged block gets the space, so a memory can still emit lines 2..n of a
 * fake gap block byte-identical to a real one (`  kind:`, `  evidence since …`,
 * `    [1] …`) — every one of those is indented in the real thing too. What
 * stops that being cashed in is the CITATION RAIL, not this: a close's quote is
 * matched against the gap's own `evidenceText`, so invented evidence cannot
 * close anything. This function breaks the opening line, and the rails
 * downstream do the rest.
 */
export function escapeForPrompt(text: string): string {
  return (
    text
      .replace(CONTROL_CHARS, '')
      // Long runs of blank lines are how a block visually detaches itself from
      // what precedes it.
      .replace(/\n{3,}/g, '\n\n')
      .split('\n')
      .map((line) => (forgesStructure(line) ? ` ${line}` : line))
      .join('\n')
  );
}

/** The readers, injected so a unit test never needs the database. */
export interface MemoryIndexDeps {
  read?: typeof readMemoryFile;
  list?: typeof listMemoryPaths;
}

/**
 * What rides in every prompt: the planner's OWN index, plus a code-appended
 * footer naming files the index forgot.
 *
 * WHY THE FOOTER EXISTS. The index is the planner's only listing, so a file it
 * forgets to index is unreachable — it cannot read_memory a path it does not
 * know, and reconciliation starts from the index, so the mechanism meant to
 * keep memory honest would be blind to exactly the files that fell off it.
 * Write access does not fix that; DISCOVERY does. The stored row stays 100% the
 * planner's words: the footer is appended at RENDER time and never written back.
 *
 * Returns '' for a firm with no memory at all — no heading, nothing. A firm
 * that has never written a note pays nothing for this feature.
 */
export async function renderMemoryIndex(
  tenantId: string,
  deps: MemoryIndexDeps = {},
): Promise<string> {
  const read = deps.read ?? readMemoryFile;
  const list = deps.list ?? listMemoryPaths;
  const [indexRow, paths] = await Promise.all([read(tenantId, MEMORY_INDEX_PATH), list(tenantId)]);
  if (paths.length === 0 && !indexRow) return '';
  // TRIM FIRST, THEN ESCAPE — and the order is load-bearing, not tidiness.
  // escapeForPrompt defends a forged heading by putting ONE SPACE in front of
  // it; trimming afterwards strips exactly that space back off the first line,
  // silently undoing the guard on the one line most worth guarding. (Found by
  // the escaping test, which asserted the rendered output rather than
  // escapeForPrompt in isolation.)
  const index = indexRow ? escapeForPrompt(indexRow.content.trim()) : '';
  // MENTION, not a parse: the index is free-form markdown the planner organises
  // however it likes, so there is no list to read — the path appearing anywhere
  // in the text counts as indexing it.
  //
  // But a bare `includes` is WRONG in the one direction that matters. Every path
  // is a suffix of some longer path: `notes.md` occurs inside `firm-notes.md`,
  // and `pacing.md` inside `firm/pacing.md` — which is the exact naming style
  // the tool description teaches. Under `includes`, indexing the long one hides
  // the short one from the footer forever, and a file the footer never names is
  // a file the planner cannot reach, because it has no listing tool and cannot
  // read a path it does not know. So the match must not be preceded by another
  // path character.
  const mentions = (path: string): boolean => {
    for (let at = index.indexOf(path); at !== -1; at = index.indexOf(path, at + 1)) {
      if (at === 0 || !/[A-Za-z0-9/_.-]/.test(index[at - 1])) return true;
    }
    return false;
  };
  const orphans = paths.filter((p) => p !== MEMORY_INDEX_PATH && !mentions(p));
  const parts = index ? [index] : [];
  if (orphans.length > 0) {
    const shown = orphans.slice(0, ORPHANS_SHOWN).join(', ');
    const rest = orphans.length - ORPHANS_SHOWN;
    parts.push(`${ORPHAN_FOOTER_PREFIX}${shown}${rest > 0 ? ` (+${rest} more)` : ''}`);
  }
  return parts.join('\n');
}
