import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test.setup.ts'],
    // DB-backed test files share one live test project; run files sequentially so
    // one file's cleanup (TRUNCATE) can't race another file's in-flight transaction.
    fileParallelism: false,
  },
});
