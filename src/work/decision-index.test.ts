// Tests for the `finding` document kind in scripts/decision-index.mjs.
//
// The index script takes its root from `process.cwd()`, so it can be pointed at a throwaway
// tree and run for real — the same choice work-cli.test.ts makes, and for the same reason: the
// behaviour under test IS the file scanning and the ranking, and a mocked filesystem would
// assert our assumptions back at us.
//
// Only the finding-specific behaviour is covered here, plus `--check` (2026-09-14). The rest of the
// index predates this and has no tests; adding them is not this phase's job.

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CLI = join(process.cwd(), 'scripts', 'decision-index.mjs');

let tmp: string;
let byFile: Record<string, Array<{ kind: string; where: string; what: string }>>;
let index: string;

function write(rel: string, text: string): void {
  const abs = join(tmp, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

beforeAll(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'decision-index-')));
  write('src/foo.ts', 'export const foo = 1;\n');
  write('src/bar.ts', 'export const bar = 2;\n');
  // The script lifts file-specific rules from CLAUDE.md and docs/*.md, and reads docs/ without
  // guarding it. Both exist in any real checkout; the temp tree has to look like one.
  write('CLAUDE.md', '# Test repo\n');
  write('docs/onboarding.md', '# Onboarding\n');

  // Four competitors, each naming src/foo.ts far more often than a finding ever will, so the
  // file starts at MAX_PER_FILE. Half this repo's attached files are in exactly this state.
  for (let i = 1; i <= 4; i++) {
    write(`thoughts/shared/research/2026-01-0${i}-competitor-${i}.md`, [
      '---', `date: 2026-01-0${i}`, `topic: competitor ${i}`, 'status: complete',
      'supersedes: nothing', '---', '',
      '## Summary', '',
      'src/foo.ts src/foo.ts src/foo.ts src/foo.ts src/foo.ts', '',
    ].join('\n'));
  }

  // The finding names src/foo.ts exactly ONCE, in frontmatter. Without the frontmatter seeding
  // it sits below MENTION_FLOOR and attaches to nothing; without the ranking it is at the floor
  // and MAX_PER_FILE drops it. This document fails on either.
  write('thoughts/shared/findings/2026-09-10-a-promoted-finding.md', [
    '---', 'date: 2026-09-10', 'task: a promoted finding', 'status: complete',
    'origin: 20260910-something', 'files: src/foo.ts, scripts/not-source.mjs',
    'supersedes: nothing', '---', '',
    '## Notes', '', 'The prose never names the file a second time.', '',
  ].join('\n'));

  // A finding whose file list looks like a real one: a script outside src/, a dotted basename,
  // more entries than MAX_FILES_PER_DOC, and two paths that must be refused.
  write('scripts/tool.mjs', '// a tool\n');
  write('src/deep/thing.test.ts', 'export const t = 1;\n');
  for (let i = 1; i <= 9; i++) write(`src/many/m${i}.ts`, `export const m${i} = ${i};\n`);
  write('thoughts/shared/findings/2026-09-10-a-broad-finding.md', [
    '---', 'date: 2026-09-10', 'task: a broad finding', 'status: complete', 'origin: ',
    `files: scripts/tool.mjs, src/deep/thing.test.ts, ${
      Array.from({ length: 9 }, (_, i) => `src/many/m${i + 1}.ts`).join(', ')
    }, src/never/existed.ts, ../outside-the-repo.ts`,
    'supersedes: nothing', '---', '',
    '## Notes', '', 'The prose names none of them.', '',
  ].join('\n'));

  write('thoughts/shared/findings/2026-09-10-a-dropped-finding.md', [
    '---', 'date: 2026-09-10', 'task: a finding decided against', 'status: dropped',
    'origin: ', 'files: src/bar.ts', 'supersedes: nothing', '---', '',
    '## Notes', '', 'Decided against.', '',
  ].join('\n'));

  execFileSync('node', [CLI], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  });
  byFile = JSON.parse(readFileSync(join(tmp, 'thoughts', 'by-file.json'), 'utf8'));
  index = readFileSync(join(tmp, 'thoughts', 'INDEX.md'), 'utf8');
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

describe('decision-index.mjs — promoted findings', () => {
  test('a document under findings/ is indexed as its own kind', () => {
    expect(index).toContain('`finding` [2026-09-10-a-promoted-finding]');
    expect(index).toContain('Every research, plan and finding document');
  });

  test('the frontmatter file list attaches the finding, without the prose naming it twice', () => {
    const entry = byFile['src/foo.ts'].find((e) => e.where.includes('a-promoted-finding'));
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('finding');
    expect(entry?.what).toBe('a promoted finding');
  });

  test('a finding survives MAX_PER_FILE on a file that already has four louder documents', () => {
    // The competitors name the file five times each against the finding's seeded two, so on
    // mentions alone it loses every tiebreak. It is here because it ranks above a plain doc.
    expect(byFile['src/foo.ts']).toHaveLength(4);
    expect(byFile['src/foo.ts'][0].kind).toBe('finding');
  });

  test('a finding attaches to any repo path it names, not just the src/*.ts prose shape', () => {
    // The pattern the PROSE scanner uses is deliberately narrow, because a loose one would
    // credit a document with everything it wandered past. A finding's list is not prose — it was
    // named deliberately, and the pre-edit hook fires on every file. Measured 2026-09-10: the
    // first real promotion attached to NOTHING, its three files being one under scripts/ and two
    // with dotted basenames.
    expect(byFile['scripts/tool.mjs']?.[0]?.kind).toBe('finding');
    expect(byFile['src/deep/thing.test.ts']?.[0]?.kind).toBe('finding');
  });

  test('a finding is not capped at MAX_FILES_PER_DOC — its list is data, not prose', () => {
    // Nine files past the two above, all seeded at the same mention floor. Capped at 8 and sorted
    // stably, the ones dropped would be whichever the edit hook recorded LAST.
    for (let i = 1; i <= 9; i++) {
      expect(byFile[`src/many/m${i}.ts`]?.[0]?.kind, `src/many/m${i}.ts`).toBe('finding');
    }
  });

  test('a named path that does not exist, or escapes the repo, attaches nothing', () => {
    expect(byFile['src/never/existed.ts']).toBeUndefined();
    expect(byFile['../outside-the-repo.ts']).toBeUndefined();
    expect(byFile['outside-the-repo.ts']).toBeUndefined();
    // The prose-scanned document alongside it is unaffected: this widening is findings-only.
    expect(byFile['scripts/not-source.mjs']).toBeUndefined();
  });

  test('a document promote really wrote attaches to its file — the whole round trip', () => {
    // The fixtures above are hand-written, so they prove the index's half of the contract but
    // not that the two halves still agree. This runs work.mjs for real and feeds ITS output to
    // decision-index.mjs, which is the only check that fails if either side changes shape —
    // if `## Files` were dropped, or `files:` renamed, the hand-written fixtures would not notice.
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'round-trip-')));
    const env = {
      ...process.env,
      HOME: repo,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    };
    try {
      mkdirSync(join(repo, 'src'), { recursive: true });
      mkdirSync(join(repo, 'docs'), { recursive: true });
      writeFileSync(join(repo, 'src', 'qux.ts'), 'export const qux = 3;\n');
      writeFileSync(join(repo, 'docs', 'onboarding.md'), '# Onboarding\n');
      writeFileSync(join(repo, 'CLAUDE.md'), '# Test repo\n');
      execFileSync('git', ['init', '-b', 'main'], { cwd: repo, env, stdio: 'ignore' });

      const work = (args: string[]): string => execFileSync(
        'node', [join(process.cwd(), 'scripts', 'work.mjs'), ...args],
        { cwd: repo, encoding: 'utf8', env },
      ).trim();

      const id = work(['park', '--title', 'round trip', '--files', 'src/qux.ts',
        '--body', 'found while doing something else']);
      work(['done', id]);
      const rel = work(['promote', id]);

      execFileSync('node', [CLI], { cwd: repo, encoding: 'utf8', env });
      const attached = JSON.parse(
        readFileSync(join(repo, 'thoughts', 'by-file.json'), 'utf8'),
      )['src/qux.ts'] as Array<{ kind: string; where: string }>;
      expect(attached.map((e) => e.where)).toContain(rel);
      expect(attached.find((e) => e.where === rel)?.kind).toBe('finding');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test('--check passes on a fresh index, fails on a stale one, and writes nothing either way', () => {
    // Until 2026-09-14 --check regenerated all three artifacts and printed "OK" regardless, so the
    // gate its header advertised could never fail. Run AFTER the fixture tree was indexed above.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const check = () => spawnSync('node', [CLI, '--check'], { cwd: tmp, encoding: 'utf8', env });

    const fresh = check();
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(fresh.stdout).toContain('thoughts index OK');

    // Both generated files made stale, so "writes nothing" is checked on each, not just one.
    const indexPath = join(tmp, 'thoughts', 'INDEX.md');
    const byFilePath = join(tmp, 'thoughts', 'by-file.json');
    const byFileText = readFileSync(byFilePath, 'utf8');
    const staleIndex = `${index}\n<!-- hand edit the generator would undo -->\n`;
    const staleByFile = '{}\n';
    try {
      writeFileSync(indexPath, staleIndex);
      writeFileSync(byFilePath, staleByFile);
      const stale = check();
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('thoughts/INDEX.md');
      expect(stale.stderr).toContain('thoughts/by-file.json');
      expect(readFileSync(indexPath, 'utf8')).toBe(staleIndex);
      expect(readFileSync(byFilePath, 'utf8')).toBe(staleByFile);
    } finally {
      writeFileSync(indexPath, index);
      writeFileSync(byFilePath, byFileText);
    }
  });

  test('a CRLF copy of an unchanged index is not stale', () => {
    // A checkout with core.autocrlf holds the same text with CRLF line ends.
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
    const indexPath = join(tmp, 'thoughts', 'INDEX.md');
    try {
      writeFileSync(indexPath, index.replace(/\n/g, '\r\n'));
      const r = spawnSync('node', [CLI, '--check'], { cwd: tmp, encoding: 'utf8', env });
      expect(r.status, r.stderr).toBe(0);
    } finally {
      writeFileSync(indexPath, index);
    }
  });

  test('a dropped finding is kept but filed with the reversed decisions', () => {
    // Sliced at `## Live`, not matched across it: `## Superseded[\s\S]*<slug>` also passes when
    // the document renders in the Live section further down, which is the exact failure the
    // assertion exists to catch.
    const supersededSection = index.slice(index.indexOf('## Superseded'), index.indexOf('## Live'));
    expect(supersededSection).toContain('2026-09-10-a-dropped-finding');
    expect(index.slice(index.indexOf('## Live'))).not.toContain('a-dropped-finding');
    const entry = byFile['src/bar.ts'].find((e) => e.where.includes('a-dropped-finding'));
    expect(entry?.kind).toBe('superseded');
  });
});
