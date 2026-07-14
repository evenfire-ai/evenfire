import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      '@components': path.resolve(__dirname, 'components'),
      '@constants': path.resolve(__dirname, 'app/constants'),
      '@lib': path.resolve(__dirname, 'lib'),
      '@types': path.resolve(__dirname, 'app/types'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'lib/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'lib/__tests__/**/*.{test,spec}.{ts,tsx}',
      'components/__tests__/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: ['node_modules', '.next'],
  },
})
