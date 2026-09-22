import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    setupFiles: ['../scripts/testing/bind-loopback-in-tests.mjs'],
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts', 'test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
