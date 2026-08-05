#!/usr/bin/env node
// The declared-agreement half of the release checker. Pure tree reads, so it
// runs locally and on the release-prep PR, before any tag exists.
//
// It deliberately does NOT check that the artifacts exist. The v<version>
// images would be built by a future release-images.yml workflow on the tag
// (not yet added to this repo), so they cannot pre-exist here. Existence
// checking is that future workflow's job, not this one's.
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

  // A switch with a default is deliberate: an unrecognized `assert` kind
  // (e.g. a `pointer` row added before its check is implemented) must fail
  // loudly, naming the coordinate and the kind, rather than silently falling
  // through every case the way independent `if`s with no `else` would.
  switch (coordinate.assert) {
    case 'equals': {
      if (actual !== version) {
        failures.push(`${coordinate.name}=${actual}, expected ${version}`)
      }
      break
    }

    case 'floor': {
      if (!SEMVER_RE.test(actual)) {
        failures.push(`${coordinate.name}=${actual} is not MAJOR.MINOR.PATCH`)
      } else if (compareVersions(actual, version) > 0) {
        failures.push(`${coordinate.name}=${actual} is greater than the release version ${version}`)
      }
      break
    }

    case 'explicit': {
      if (!actual || actual === 'local') {
        failures.push(`${coordinate.name}=${actual || '(empty)'} was never set explicitly`)
      }
      break
    }

    case 'counter': {
      const expected = readCounterPackage(ROOT, coordinate.counterPackage)
      if (actual !== expected) {
        failures.push(
          `${coordinate.name}=${actual}, expected ${expected} from ${coordinate.counterPackage}`
        )
      }
      break
    }

    default: {
      failures.push(
        `${coordinate.name} has assert kind "${coordinate.assert}", which this checker does not ` +
          `implement -- a coordinate cannot be written without being checked, so add a case for it ` +
          `in scripts/release/validate-release-tag.mjs before using this assert kind`
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
