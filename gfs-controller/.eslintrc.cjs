// gfs-controller lint config. Mirrors the lint posture of the other Node
// services (e.g. mcp-proxy): the `lint` script runs eslint with the
// TypeScript parser, resolved from the repo/CI toolchain. Kept minimal and
// strict; rule depth is owned by the shared toolchain, not duplicated here.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  env: {
    node: true,
    es2022: true,
  },
  extends: ['eslint:recommended'],
  ignorePatterns: ['dist/', 'node_modules/'],
  rules: {},
}
