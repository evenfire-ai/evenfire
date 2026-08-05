import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname),
      '@components': path.resolve(import.meta.dirname, 'app/components'),
      '@constants': path.resolve(import.meta.dirname, 'app/constants'),
      '@lib': path.resolve(import.meta.dirname, 'lib'),
      next: path.resolve(import.meta.dirname, 'node_modules/next'),
      react: path.resolve(import.meta.dirname, 'node_modules/react'),
      'react-dom': path.resolve(import.meta.dirname, 'node_modules/react-dom'),
      'react/jsx-dev-runtime': path.resolve(
        import.meta.dirname,
        'node_modules/react/jsx-dev-runtime.js'
      ),
      'react/jsx-runtime': path.resolve(import.meta.dirname, 'node_modules/react/jsx-runtime.js'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['app/components/**/__tests__/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['node_modules', '.next'],
  },
})
