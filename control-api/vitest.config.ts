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
      [
        '@clerum/grok-provider-attempt-contract',
        '@clerum/llm-provider-attempt-contract',
        '@clerum/llm-providers',
        'pino',
      ].map(name => [name, require.resolve(name)])
    ),
  },
  test: {
    environment: 'node',
    setupFiles: [
      '../scripts/testing/bind-loopback-in-tests.mjs',
      'test/realPostgres.requirement.ts',
    ],
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
    // Real-Postgres beforeAll runs initDb across the full migration list.
    // A bounded extra allowance prevents a slow CREATE
    // DATABASE into skipped tests with an empty JSON reporter message.
    hookTimeout: process.env.CONTROL_API_REAL_PG_ADMIN_URL ? 60_000 : 30_000,
    sequence: {
      hooks: 'list',
    },
    include: ['test/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
  },
})
