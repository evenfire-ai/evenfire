import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    // Client construction in unit tests uses a fixture, never a live context.
    env: {
      KUBECONFIG: fileURLToPath(new URL('./test/fixtures/kubernetes-unit.yaml', import.meta.url)),
    },
    // Keep package tests independent of sibling packages.
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
