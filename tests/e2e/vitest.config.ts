import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['**/*.test.ts', 'integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/fixtures/**/node_modules/**'],
    testTimeout: 360_000, // 360s — workflow lifecycle tests wait up to 5 min for LLM execution
    hookTimeout: 360_000,
    fileParallelism: false,
    sequence: { concurrent: false },
    reporters: ['verbose'],
    // A run that matched zero test files must FAIL, never exit 0. Vitest's
    // default is `true` (fail-open); an e2e gate that resolves an empty glob
    // proves nothing. The runner (scripts/e2e/run-vitest-e2e.sh) adds a
    // per-suite existence precheck and a "Tests N>0" floor guard on top.
    passWithNoTests: false,
  },
})
