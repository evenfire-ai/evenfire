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
      next: path.resolve(__dirname, 'node_modules/next'),
      react: path.resolve(__dirname, 'node_modules/react'),
      'react-dom': path.resolve(__dirname, 'node_modules/react-dom'),
      'react/jsx-dev-runtime': path.resolve(__dirname, 'node_modules/react/jsx-dev-runtime.js'),
      'react/jsx-runtime': path.resolve(__dirname, 'node_modules/react/jsx-runtime.js'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    testTimeout: 15_000,
    setupFiles: ['./vitest.setup.ts'],
    include: [
      'lib/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'lib/__tests__/**/*.{test,spec}.{ts,tsx}',
      'components/__tests__/**/*.{test,spec}.{ts,tsx}',
      'app/**/__tests__/**/*.{test,spec}.{ts,tsx}',
      'test/**/__tests__/**/*.{test,spec}.{ts,tsx}',
    ],
    exclude: ['node_modules', '.next'],
  },
})
