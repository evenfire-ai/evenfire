import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['../scripts/testing/bind-loopback-in-tests.mjs'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    pool: 'forks', // Each test file gets its own process so server bind-port collisions don't cross-contaminate.
  },
})
