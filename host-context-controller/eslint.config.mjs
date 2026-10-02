// @ts-check
import { createRequire } from 'node:module'

// The documented development/CI prerequisite installs the toolchain pinned
// by mcp-host/package-lock.json. Reuse it without adding HCC dependencies.
const requireToolchain = createRequire(new URL('../mcp-host/package.json', import.meta.url))
const tsParser = requireToolchain('@typescript-eslint/parser')
const tsPlugin = requireToolchain('@typescript-eslint/eslint-plugin')

/** @type {import('../mcp-host/node_modules/eslint').Linter.Config[]} */
export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tsParser },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    files: ['src/k8sClient.ts', 'src/server.ts'],
    rules: { 'no-console': 'error' },
  },
]
