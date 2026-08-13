import tseslint from 'typescript-eslint';

// Minimal flat config: typescript-eslint's recommended rules, scoped to source
// TypeScript only. Generated types and build output are ignored.
export default tseslint.config(
  // `.claude/` holds git worktrees for the concurrent-feature workflow
  // (CLAUDE.md), i.e. whole extra checkouts of this repo carrying their own
  // tsconfig.json. Without this ignore, typescript-eslint sees two candidate
  // roots and refuses to parse ANYTHING — 289 errors on every file, none of
  // them real, whenever a second feature session has a worktree open.
  { ignores: ['dist/', 'node_modules/', '.claude/', 'src/db/database.types.ts'] },
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    // Pinned rather than inferred, so a stray tsconfig.json anywhere under the
    // repo can never make the root ambiguous again.
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
  },
  {
    // The spine-eval drivers are plain Node ESM (they import the compiled
    // dist/, so they cannot be TypeScript without a second build step). Same
    // reasoning as the web/ block below: without this they would pass `eslint .`
    // vacuously — zero rules matched — and sit outside EVERY gate, which is
    // exactly wrong for code whose job is to GRADE other code. The load-bearing
    // logic deliberately lives in src/eval/*.ts, inside typecheck and vitest;
    // these files are the thin I/O shell around it.
    files: ['scripts/spine-eval/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        Buffer: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        AbortController: 'readonly',
        performance: 'readonly',
        Date: 'readonly',
        Math: 'readonly',
        JSON: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'error',
    },
  },
  {
    // The board Mini App is plain browser JS served as a static file (no build
    // step, so it can't be TypeScript without introducing one) — without this
    // block it would pass `eslint .` vacuously (zero rules matched) and sit
    // outside EVERY gate. Identifier-level breakage (typo'd names, dead vars)
    // now fails lint; property-typo coverage would need checkJs + JSDoc types.
    files: ['web/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Telegram: 'readonly',
        // The admin dashboard holds its bearer token in sessionStorage —
        // deliberately not the URL, where it would land in history and logs.
        sessionStorage: 'readonly',
        Date: 'readonly',
        Math: 'readonly',
        encodeURIComponent: 'readonly',
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'error',
    },
  },
);
