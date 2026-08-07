import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.ts', 'test/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
