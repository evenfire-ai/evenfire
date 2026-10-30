import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    setupFiles: ['../scripts/testing/bind-loopback-in-tests.mjs'],
    exclude: ['dist/**', 'node_modules/**'],
    // CI runs with an empty HOME, so a suite that loads the ambient kubeconfig at
    // import time stays green there and only breaks on a developer machine. Pin a
    // kubeconfig without a current context so that breakage shows up everywhere.
    env: {
      KUBECONFIG: fileURLToPath(
        new URL('./test/__fixtures__/kubeconfig.no-current-context.yaml', import.meta.url)
      ),
    },
  },
})
