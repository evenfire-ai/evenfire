#!/usr/bin/env node
// The declared-agreement half of the release checker. Pure tree reads, so it
// runs locally and on the release-prep PR, before any tag exists.
//
// It deliberately does NOT check that the artifacts exist. The v<version>
// images are created by .github/workflows/release-images.yml ON THE TAG, so
// they cannot pre-exist here -- asserting existence would make every
// release-prep PR red. Existence is that workflow's half of the split checker.
//
//   node scripts/release/validate-release-tag.mjs --version 0.6.0
import process from 'node:process'
import {
  COORDINATES,
  SEMVER_RE,
  argValue,
  compareVersions,
  readCounterPackage,
} from './release-coordinates.mjs'

const ROOT = process.cwd()

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

  // A switch with a default is deliberate: an unrecognized `assert` kind (a
  // new row landing before its check is implemented) must fail loudly, naming
  // the coordinate and the kind, rather than silently falling through every
  // case the way independent `if`s with no `else` would.
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

    case 'pointer': {
      // The pin is v-prefixed; the release version is not. `read` returns the
      // DISTINCT set joined by '/', so a half-applied rewrite ("v0.6.0/v0.5.0")
      // fails here rather than passing on whichever row happened to be first.
      //
      // Equality only. The v<version> images are created by release-images.yml
      // ON THE TAG, so they cannot pre-exist when this runs on the release-prep
      // PR; asserting existence here would make every release-prep PR red.
      const expected = `v${version}`
      if (actual !== expected) {
        failures.push(
          `${coordinate.name}=${actual || '(empty)'}, expected ${expected}` +
            (actual.includes('/')
              ? ' (the component carries MIXED tags, so a previous rewrite was half-applied)'
              : '')
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
  // ::error:: so this reads as an annotation once the release-cut job runs it,
  // matching update-desktop-release-manifest.mjs and validate-release-version-bumps.mjs.
  // prepare-release.mjs deliberately does NOT do this: it is run by a human at
  // release time, where an annotation prefix is noise.
  console.error(
    `::error::release ${version} has ${failures.length} disagreeing coordinate(s); ` +
      `run scripts/release/prepare-release.mjs --version ${version} --release-id <id> to write them`
  )
  for (const f of failures) console.error(`  ${f}`)
  process.exit(1)
}

console.log(`release ${version}: all ${COORDINATES.length} coordinates agree`)
