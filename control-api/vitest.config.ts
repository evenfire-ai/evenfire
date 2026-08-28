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
    // Deterministic failures must remain visible in ordinary and Real-Postgres
    // lanes. Retrying can also overlap abandoned database work after a timeout.
    retry: 0,
    testTimeout: 10_000,
    sequence: {
      hooks: 'list',
    },
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
})
