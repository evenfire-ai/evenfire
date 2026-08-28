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
    // A single retry-free pass can spend more than ten seconds inside a
    // Supertest request while this 5k-test suite is under full worker load.
    // Give the request its execution budget without rerunning assertions or
    // hiding deterministic failures behind retry state.
    testTimeout: 30_000,
    sequence: {
      hooks: 'list',
    },
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
})
