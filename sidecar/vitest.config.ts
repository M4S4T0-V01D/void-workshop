import { defineConfig } from 'vitest/config';

// Gentle on the machine: one test file at a time in a single worker process.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    maxWorkers: 1,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: { VOID_WORKSHOP_KEY_BACKEND: 'file' },
  },
});
