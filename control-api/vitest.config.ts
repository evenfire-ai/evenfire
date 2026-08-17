import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['test/realPostgres.requirement.ts'],
    // Control API route suites mock shared modules, env-backed config, and
    // Supertest apps. Running files in parallel can leak those process-level
    // fixtures across workers and produce nondeterministic HTTP parse failures.
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'threads',
    // Real-Postgres tests mutate shared database state and cannot be retried safely
    // after a timeout because the abandoned async work may still commit.
    retry: process.env.CONTROL_API_REAL_PG_ADMIN_URL ? 0 : 2,
    testTimeout: 10_000,
    sequence: {
      hooks: 'list',
    },
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
})
