import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const minimumNodeVersion = readFileSync(new URL('../.nvmrc', import.meta.url), 'utf8').trim()

export function assertNodeVersion(version = process.versions.node, { major } = {}) {
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== '--major=24')) {
    throw new Error('Usage: node scripts/check-node-version.mjs [--major=24]')
  }
  assertNodeVersion(process.versions.node, args.length ? { major: 24 } : {})
}
