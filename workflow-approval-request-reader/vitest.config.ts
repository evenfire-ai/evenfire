import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['../scripts/testing/bind-loopback-in-tests.mjs'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
