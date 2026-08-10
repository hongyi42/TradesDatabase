import tseslint from 'typescript-eslint';

// Minimal flat config: typescript-eslint's recommended rules, scoped to source
// TypeScript only. Generated types and build output are ignored.
export default tseslint.config(
  // `.claude/` holds git worktrees for the concurrent-feature workflow
  // (CLAUDE.md), i.e. whole extra checkouts of this repo carrying their own
  // tsconfig.json. Without this ignore, typescript-eslint sees two candidate
  // roots and refuses to parse ANYTHING — 289 errors on every file, none of
  // them real, whenever a second feature session has a worktree open.
  {
    ignores: [
      'dist/',
      'node_modules/',
      '.claude/',
      'src/db/database.types.ts',
      // Vite build output. Without this the bundled React lands in the
      // `web/**/*.js` block below and fails no-undef on every browser global.
      'web/portal/dist/',
    ],
  },
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    // Pinned rather than inferred, so a stray tsconfig.json anywhere under the
    // repo can never make the root ambiguous again.
    languageOptions: { parserOptions: { tsconfigRootDir: import.meta.dirname } },
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
  {
    // The customer portal (web/portal) is React + TypeScript with a Vite build,
    // so unlike the board it can carry the full typescript-eslint ruleset. Its
    // own tsconfig is the parser root — the block above pins the ROOT tsconfig,
    // which does not include web/, so without this the .tsx files would be
    // unparseable rather than merely unlinted.
    files: ['web/portal/**/*.{ts,tsx}'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        project: './web/portal/tsconfig.json',
      },
    },
  },
);
