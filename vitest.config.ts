import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          // The e2e suites spawn the bundled server (build/dev/index.js); build it once per run.
          globalSetup: ['test/global-build.ts'],
          // Every integration suite shares the one test-infra mail server, so files must never run in parallel.
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { concurrent: false },
          testTimeout: 60_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
