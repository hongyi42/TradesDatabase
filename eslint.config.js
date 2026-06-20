import tseslint from 'typescript-eslint';

// Minimal flat config: typescript-eslint's recommended rules, scoped to source
// TypeScript only. Generated types and build output are ignored.
export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'src/db/database.types.ts'] },
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
  },
);
