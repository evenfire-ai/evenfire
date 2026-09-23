import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  server: {
    fs: {
      // The loopback setup file below lives at the repository root, outside
      // this package. The `ui/**` suites are served through Vite's module
      // server, which refuses an out-of-root file unless it is allowed here.
      allow: [path.resolve(__dirname, '..')],
    },
  },
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
    // Absolute, because the ui/** suites run through Vite's module server,
    // which serves an out-of-root setup file under `/@fs/` and cannot resolve
    // it from a path relative to this package.
    setupFiles: [path.resolve(__dirname, '../scripts/testing/bind-loopback-in-tests.mjs')],
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
