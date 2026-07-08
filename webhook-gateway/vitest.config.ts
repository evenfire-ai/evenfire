import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    pool: 'forks', // Each test file gets its own process so server bind-port collisions don't cross-contaminate.
  },
})
