import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    setupFiles: ['../scripts/testing/bind-loopback-in-tests.mjs'],
    // Client construction in unit tests uses a fixture, never a live context.
    env: {
      KUBECONFIG: fileURLToPath(new URL('./test/fixtures/kubernetes-unit.yaml', import.meta.url)),
      // Runtime config now requires the projected edge credential for every
      // non-dev Host. Unit tests use a synthetic value, never a live secret.
      MCP_HOST_RPC_PROXY_EDGE_TOKEN: 'vitest-rpc-proxy-edge-token',
    },
    // Keep package tests independent of sibling packages.
    include: ['src/**/*.test.ts', 'src/**/__tests__/**/*.test.ts'],
    exclude: ['dist/**', 'node_modules/**'],
  },
})
