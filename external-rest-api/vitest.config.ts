import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      // Cross-package contract tests import control-ui/lib modules, which resolve
      // shared constants through control-ui's own path alias.
      '@constants': path.resolve(__dirname, '../control-ui/app/constants'),
    },
  },
  test: {
    setupFiles: ['../scripts/testing/bind-loopback-in-tests.mjs', 'test/testJwtKey.setup.ts'],
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts', 'test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
