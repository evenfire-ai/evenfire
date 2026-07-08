import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Explicitly scope to this package's src/ directory so vitest does not
    // scan sibling packages when invoked from a parent directory.
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
