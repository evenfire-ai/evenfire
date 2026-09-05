import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'ui/src'),
      '@components': path.resolve(__dirname, 'ui/src/components'),
      '@constants': path.resolve(__dirname, 'ui/src/constants'),
      '@contexts': path.resolve(__dirname, 'ui/src/contexts'),
      '@hooks': path.resolve(__dirname, 'ui/src/hooks'),
      '@lib': path.resolve(__dirname, 'ui/src/lib'),
      '@pages': path.resolve(__dirname, 'ui/src/pages'),
      '@styles': path.resolve(__dirname, 'ui/src/styles'),
      '@types': path.resolve(__dirname, 'ui/src/types'),
    },
  },
  test: {
    testTimeout: 30_000,
    fileParallelism: false,
    teardownTimeout: 60_000,
    include: [
      'src/**/*.test.ts',
      'src/**/__tests__/**/*.ts',
      'test/**/*.test.ts',
      'ui/src/**/*.test.ts',
      'ui/src/**/*.test.tsx',
      'ui/src/**/__tests__/**/*.ts',
      'ui/src/**/__tests__/**/*.tsx',
    ],
    exclude: [
      'dist/**',
      'node_modules/**',
      'test/e2e/**',
      'test/e2e-playwright/**',
      '**/__fixtures__/**',
    ],
  },
})
