'use strict'

// CommonJS supports both Playwright's config loader and native ESM callers.
// Its main-module identity also remains valid through symlinked checkout paths.
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const minimumNodeVersion = readFileSync(join(__dirname, '../.nvmrc'), 'utf8').trim()

function assertNodeVersion(version = process.versions.node, { major } = {}) {
  const parse = value => /^(\d+)\.(\d+)\.(\d+)$/.exec(value)?.slice(1).map(Number)
  const current = parse(version)
  const minimum = parse(minimumNodeVersion)
  if (!minimum) throw new Error('.nvmrc must pin a complete Node.js version')
  const comparison = current?.findIndex((part, index) => part !== minimum[index])
  if (
    !current ||
    (major !== undefined && current[0] !== major) ||
    (comparison !== -1 && current[comparison] < minimum[comparison])
  ) {
    throw new Error(
      `Node.js ${major === undefined ? '' : `${major}.x `}>=${minimumNodeVersion} is required; found v${version}`
    )
  }
}

exports.minimumNodeVersion = minimumNodeVersion
exports.assertNodeVersion = assertNodeVersion

if (require.main === module) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--major=24')) {
    throw new Error('Usage: node scripts/check-node-version.cjs [--major=24]')
  }
  assertNodeVersion(process.versions.node, args.length ? { major: 24 } : {})
}
