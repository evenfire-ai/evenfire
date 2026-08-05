#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { SEMVER_RE, compareVersions, parseManifest } from './release-coordinates.mjs'

const ROOT = process.cwd()
const MANIFEST_PATH = 'external-rest-api/src/releaseManifest.ts'
const PACKAGE_PATHS = {
  externalRestApiVersion: 'external-rest-api/package.json',
  rpcProxyVersion: 'rpc-proxy/package.json',
  desktopVersion: 'desktop-app/package.json',
}

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, filePath), 'utf8'))
}

function gitShow(ref, filePath) {
  try {
    return execFileSync('git', ['show', `${ref}:${filePath}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return ''
  }
}

function currentManifest() {
  return parseManifest(fs.readFileSync(path.join(ROOT, MANIFEST_PATH), 'utf8'))
}

function currentVersions() {
  return Object.fromEntries(
    Object.entries(PACKAGE_PATHS).map(([field, packagePath]) => [
      field,
      String(readJsonFile(packagePath).version || ''),
    ])
  )
}

function previousVersions(ref) {
  if (!ref) return {}
  return Object.fromEntries(
    Object.entries(PACKAGE_PATHS).map(([field, packagePath]) => {
      const raw = gitShow(ref, packagePath)
      if (!raw) return [field, '']
      return [field, String(JSON.parse(raw).version || '')]
    })
  )
}

function previousManifest(ref) {
  if (!ref) return currentManifest()
  const raw = gitShow(ref, MANIFEST_PATH)
  return raw ? parseManifest(raw) : currentManifest()
}

function renderManifest(manifest) {
  return `export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = ${JSON.stringify(manifest, null, 2)
    .replace(/"([^"]+)":/g, '$1:')
    .replace(/: "([^"]*)"/g, ": '$1'")
    .replace(/\n}$/, ',\n}')}
`
}

function validate(manifest, versions, options = {}) {
  const fields = options.deferDesktopRelease
    ? ['externalRestApiVersion', 'rpcProxyVersion']
    : Object.keys(PACKAGE_PATHS)
  for (const field of fields) {
    if (manifest[field] !== versions[field]) {
      throw new Error(`${field}=${manifest[field]} does not match package.json ${versions[field]}`)
    }
  }
  if (!SEMVER_RE.test(manifest.minimumDesktopVersion)) {
    throw new Error(
      `minimumDesktopVersion=${manifest.minimumDesktopVersion} is not MAJOR.MINOR.PATCH`
    )
  }
  if (compareVersions(manifest.minimumDesktopVersion, manifest.desktopVersion) > 0) {
    throw new Error(
      `minimumDesktopVersion=${manifest.minimumDesktopVersion} is greater than desktopVersion=${manifest.desktopVersion}`
    )
  }
}

function main() {
  const previousRef = argValue('--previous')
  const releaseId = argValue('--release-id') || 'local'
  const minimumDesktopVersion = argValue('--minimum-desktop-version')
  const validateOnly = process.argv.includes('--validate-only')
  const deferDesktopRelease = process.argv.includes('--defer-desktop-release')

  const versions = currentVersions()
  const manifestAtHead = currentManifest()
  if (validateOnly) {
    if (!manifestAtHead) {
      throw new Error(`${MANIFEST_PATH} does not contain a releaseManifest export`)
    }
    validate(manifestAtHead, versions, { deferDesktopRelease })
    console.log(JSON.stringify(manifestAtHead, null, 2))
    process.exit(0)
  }

  let previous = previousManifest(previousRef)

  // HEAD's floor always outranks one read via --previous: HEAD reflects the
  // most recent operator decision. Never synthesize a floor from
  // desktopVersion -- if nothing readable carries a floor, the operator must
  // say so explicitly.
  const inherited = manifestAtHead?.minimumDesktopVersion || previous?.minimumDesktopVersion

  if (!inherited && !minimumDesktopVersion) {
    throw new Error(
      'no minimumDesktopVersion could be read; pass ' +
        '--minimum-desktop-version explicitly rather than ' +
        'defaulting it to desktopVersion'
    )
  }

  if (!previous) {
    previous = {
      releaseId,
      externalRestApiVersion: versions.externalRestApiVersion,
      rpcProxyVersion: versions.rpcProxyVersion,
      desktopVersion: versions.desktopVersion,
      minimumDesktopVersion: inherited || minimumDesktopVersion,
    }
  }
  const prevVersions = previousVersions(previousRef)

  const next = { ...previous, releaseId }
  let changed = false

  for (const field of ['externalRestApiVersion', 'rpcProxyVersion']) {
    if (
      !prevVersions[field] ||
      prevVersions[field] !== versions[field] ||
      next[field] !== versions[field]
    ) {
      next[field] = versions[field]
      changed = true
    }
  }

  if (
    !deferDesktopRelease &&
    (!prevVersions.desktopVersion ||
      prevVersions.desktopVersion !== versions.desktopVersion ||
      next.desktopVersion !== versions.desktopVersion)
  ) {
    next.desktopVersion = versions.desktopVersion
    changed = true
  }

  // The floor is a compatibility control, not a version. It moves ONLY when the
  // operator asks. Advancing it with every release would show "update required"
  // to every user of the previous release. See appService.ts:840.
  //
  // `previous` may carry a floor copied from an old --previous ref; always
  // re-apply `inherited` (HEAD-first) before letting an explicit flag win, so
  // a floor already raised on HEAD is never silently reverted.
  if (inherited && next.minimumDesktopVersion !== inherited) {
    next.minimumDesktopVersion = inherited
    changed = true
  }
  if (minimumDesktopVersion) {
    next.minimumDesktopVersion = minimumDesktopVersion
    changed = true
  }

  if (!changed && manifestAtHead) {
    Object.assign(next, manifestAtHead)
  }

  validate(next, versions, { deferDesktopRelease })

  if (!validateOnly) {
    fs.writeFileSync(path.join(ROOT, MANIFEST_PATH), renderManifest(next))
  }

  console.log(JSON.stringify(next, null, 2))
}

try {
  main()
} catch (error) {
  // Matches validate-release-version-bumps.mjs's ::error:: style so a
  // contributor sees an actionable GitHub annotation instead of a raw stack
  // trace on the ci-public.yml step. The underlying detail is preserved
  // verbatim in the annotation; the remediation line is appended separately.
  console.error(`::error::${error.message}`)
  console.error(
    `Fix ${MANIFEST_PATH} so it agrees with the current package.json versions (or pass the ` +
      `correct --release-id / --minimum-desktop-version flags), then re-run ` +
      '`node scripts/release/update-desktop-release-manifest.mjs`.'
  )
  process.exit(1)
}
