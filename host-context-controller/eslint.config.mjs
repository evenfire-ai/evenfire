// @ts-check
import { createRequire } from 'node:module'

// The required repository install already provides the Node-service ESLint
// toolchain in mcp-host. Reuse that pinned parser/plugin instead of depending
// on a global executable or introducing a second dependency set for HCC.
const requireToolchain = createRequire(new URL('../mcp-host/package.json', import.meta.url))
const tsParser = requireToolchain('@typescript-eslint/parser')
const tsPlugin = requireToolchain('@typescript-eslint/eslint-plugin')

/** @type {import('../mcp-host/node_modules/eslint').Linter.Config[]} */
export default [
  {
    files: ['src/**/*.ts'],
    languageOptions: { parser: tsParser },
    plugins: { '@typescript-eslint': tsPlugin },
  },
]
