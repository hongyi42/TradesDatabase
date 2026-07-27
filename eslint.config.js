import tseslint from 'typescript-eslint';

// Minimal flat config: typescript-eslint's recommended rules, scoped to source
// TypeScript only. Generated types and build output are ignored.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'src/db/database.types.ts'] },
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
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
