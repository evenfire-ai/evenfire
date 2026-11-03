#!/usr/bin/env node
// The one release-cut writer. Writes every coordinate in the table, then
// delegates the manifest to update-desktop-release-manifest.mjs rather than
// duplicating its renderer.
//
//   node scripts/release/prepare-release.mjs --version 0.6.0 --release-id <id> \
//        [--compatible-desktop-version 0.5.9 --compatible-desktop-version 0.6.0]
import { execFileSync, execFileSync as run } from 'node:child_process'
import process from 'node:process'
import {
  COORDINATES,
  SEMVER_RE,
  argValue,
  compareVersions,
  writtenCoordinatePaths,
} from './release-coordinates.mjs'

const ROOT = process.cwd()

// The monotonic guard below must compare against the last COMMITTED desktop
// version, not the working file. A cut that failed after writing package.json
// leaves the new version on disk; comparing against that makes re-running the
// very command this script and validate-release-tag.mjs tell you to run fail
// with "not greater than", which is a dead end.
function committedDesktopVersion() {
  try {
    const raw = run('git', ['show', 'HEAD:desktop-app/package.json'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return JSON.parse(raw).version
  } catch {
    return null
  }
}

function die(message) {
  console.error(message)
  process.exit(1)
}

const version = argValue('--version')
const releaseId = argValue('--release-id')
const compatibleDesktopVersions = []
for (let index = 0; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--compatible-desktop-version') {
    const requested = process.argv[index + 1]
    if (!requested || requested.startsWith('--')) {
      die('--compatible-desktop-version requires a MAJOR.MINOR.PATCH value')
    }
    compatibleDesktopVersions.push(requested)
  }
}

if (!SEMVER_RE.test(version)) {
  die(`--version must be MAJOR.MINOR.PATCH, got: ${version || '(missing)'}`)
}

// releaseId is required, never defaulted. update-desktop-release-manifest.mjs
// falls back to the string 'local', which would ship in a customer-facing
// manifest if this script stayed silent.
if (!releaseId) {
  die('--release-id is required (it reaches a customer-facing manifest)')
}

if (process.argv.includes('--minimum-desktop-version')) {
  die(
    'minimumDesktopVersion is frozen for already-shipped clients; do not raise the legacy update floor'
  )
}

if (compatibleDesktopVersions.length > 0) {
  if (compatibleDesktopVersions.some(value => !SEMVER_RE.test(value))) {
    die('--compatible-desktop-version values must be MAJOR.MINOR.PATCH')
  }
  if (new Set(compatibleDesktopVersions).size !== compatibleDesktopVersions.length) {
    die('--compatible-desktop-version values must be unique')
  }
  if (!compatibleDesktopVersions.includes(version)) {
    die('the compatible Desktop version set must include the requested --version')
  }
  if (compatibleDesktopVersions.some(value => compareVersions(value, version) > 0)) {
    die('compatible Desktop versions cannot be greater than the requested --version')
  }
}

const onDisk = COORDINATES.find(c => c.name === 'desktop-app/package.json').read(ROOT)
const current = committedDesktopVersion() ?? onDisk
if (compareVersions(version, current) <= 0) {
  die(`--version ${version} is not greater than the current desktop version ${current}`)
}

// Resolved BEFORE the first write, so a coordinate table that cannot describe
// what it is about to touch stops the cut instead of producing a half-cut tree
// plus a recovery instruction that would not fully undo it.
let writtenPaths
try {
  writtenPaths = writtenCoordinatePaths()
} catch (error) {
  die(error.message)
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
for (const compatibleDesktopVersion of compatibleDesktopVersions) {
  manifestArgs.push('--compatible-desktop-version', compatibleDesktopVersion)
}
try {
  execFileSync('node', manifestArgs, { cwd: ROOT, stdio: 'inherit' })
} catch (error) {
  // The coordinate loop above has already written every path in writtenPaths.
  // Say so, rather than leaving a raw stack trace and a half-written tree.
  //
  // The list is DERIVED from the coordinate table, not typed out here. The
  // hardcoded version named the two desktop files and never learned about the
  // ghcr pin, so following the discard command reverted the version and left
  // the pin bumped -- still half-cut, by the command offered to un-cut it.
  die(
    `The release cut wrote ${writtenPaths.join(', ')} to ${version}, ` +
      `then the manifest update failed (${error.message}).\n` +
      `The tree is half-cut. Either re-run this same command once the cause is fixed ` +
      `(it compares against the last committed version, so re-running is safe), ` +
      `or discard with \`git checkout -- ${writtenPaths.join(' ')}\`.`
  )
}

console.log(`prepared release ${version}`)
