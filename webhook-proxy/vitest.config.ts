import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['../scripts/testing/bind-loopback-in-tests.mjs'],
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    pool: 'forks',
  },
})
