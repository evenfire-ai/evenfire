#!/usr/bin/env node
// The one release-cut writer. Writes every coordinate in the table, then
// delegates the manifest to update-desktop-release-manifest.mjs rather than
// duplicating its renderer.
//
//   node scripts/release/prepare-release.mjs --version 0.6.0 --release-id <id> \
//        [--minimum-desktop-version 0.6.0]
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { COORDINATES, SEMVER_RE, compareVersions } from './release-coordinates.mjs'

const ROOT = process.cwd()

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : ''
}

function die(message) {
  console.error(message)
  process.exit(1)
}

const version = argValue('--version')
const releaseId = argValue('--release-id')
const minimumDesktopVersion = argValue('--minimum-desktop-version')

if (!SEMVER_RE.test(version)) {
  die(`--version must be MAJOR.MINOR.PATCH, got: ${version || '(missing)'}`)
}

// releaseId is required, never defaulted. update-desktop-release-manifest.mjs
// falls back to the string 'local', which would ship in a customer-facing
// manifest if this script stayed silent.
if (!releaseId) {
  die('--release-id is required (it reaches a customer-facing manifest)')
}

if (minimumDesktopVersion && !SEMVER_RE.test(minimumDesktopVersion)) {
  die(`--minimum-desktop-version must be MAJOR.MINOR.PATCH, got: ${minimumDesktopVersion}`)
}

const current = COORDINATES.find(c => c.name === 'desktop-app/package.json').read(ROOT)
if (compareVersions(version, current) <= 0) {
  die(`--version ${version} is not greater than the current desktop version ${current}`)
}

for (const coordinate of COORDINATES) {
  // Rows without a write are owned by the delegated updater below.
  coordinate.write?.(ROOT, version)
}

const manifestArgs = [
  'scripts/release/update-desktop-release-manifest.mjs',
  '--release-id',
  releaseId,
]
if (minimumDesktopVersion) {
  manifestArgs.push('--minimum-desktop-version', minimumDesktopVersion)
}
execFileSync('node', manifestArgs, { cwd: ROOT, stdio: 'inherit' })

console.log(`prepared release ${version}`)
