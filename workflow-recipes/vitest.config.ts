import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['../scripts/testing/bind-loopback-in-tests.mjs'],
    testTimeout: 15_000,
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
})
