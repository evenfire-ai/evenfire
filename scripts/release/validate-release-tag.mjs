#!/usr/bin/env node
// The declared-agreement half of the release checker. Pure tree reads, so it
// runs locally and on the release-prep PR, before any tag exists.
//
// It deliberately does NOT check that the artifacts exist. The v<version>
// images are created by release-images.yml on the tag, so they cannot
// pre-exist here. Existence is that workflow's job.
//
//   node scripts/release/validate-release-tag.mjs --version 0.6.0
import process from 'node:process'
import {
  COORDINATES,
  SEMVER_RE,
  compareVersions,
  readCounterPackage,
} from './release-coordinates.mjs'

const ROOT = process.cwd()

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : ''
}

const version = (argValue('--version') || '').replace(/^v/, '')
if (!SEMVER_RE.test(version)) {
  console.error(
    `--version must be MAJOR.MINOR.PATCH (a leading v is stripped), got: ${version || '(missing)'}`
  )
  process.exit(1)
}

const failures = []

for (const coordinate of COORDINATES) {
  const actual = coordinate.read(ROOT)

  if (coordinate.assert === 'equals' && actual !== version) {
    failures.push(`${coordinate.name}=${actual}, expected ${version}`)
  }

  if (coordinate.assert === 'floor') {
    if (!SEMVER_RE.test(actual)) {
      failures.push(`${coordinate.name}=${actual} is not MAJOR.MINOR.PATCH`)
    } else if (compareVersions(actual, version) > 0) {
      failures.push(`${coordinate.name}=${actual} is greater than the release version ${version}`)
    }
  }

  if (coordinate.assert === 'explicit' && (!actual || actual === 'local')) {
    failures.push(`${coordinate.name}=${actual || '(empty)'} was never set explicitly`)
  }

  if (coordinate.assert === 'counter') {
    const expected = readCounterPackage(ROOT, coordinate.counterPackage)
    if (actual !== expected) {
      failures.push(
        `${coordinate.name}=${actual}, expected ${expected} from ${coordinate.counterPackage}`
      )
    }
  }
}

if (failures.length > 0) {
  console.error(`release ${version} has ${failures.length} disagreeing coordinate(s):`)
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}

console.log(`release ${version}: all ${COORDINATES.length} coordinates agree`)
