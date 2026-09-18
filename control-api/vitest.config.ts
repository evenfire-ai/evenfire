import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

export default defineConfig({
  resolve: {
    // The image authorization integration imports the real Host and proxy
    // sources. CI installs this package alone; resolve their shared runtime
    // imports from Control API's declared dependencies, without requiring
    // unrelated sibling node_modules or replacing the implementation.
    alias: Object.fromEntries(
      ['@clerum/llm-provider-attempt-contract', '@clerum/llm-providers', 'pino'].map(name => [
        name,
        require.resolve(name),
      ])
    ),
  },
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
    // Real-Postgres beforeAll runs initDb across the full migration list.
    // Default hookTimeout follows testTimeout (10s) and turns a slow CREATE
    // DATABASE into skipped tests with an empty JSON reporter message.
    hookTimeout: process.env.CONTROL_API_REAL_PG_ADMIN_URL ? 60_000 : 10_000,
    sequence: {
      hooks: 'list',
    },
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
})
