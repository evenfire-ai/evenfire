#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { SEMVER_RE, argValue, compareVersions, parseManifest } from './release-coordinates.mjs'

const ROOT = process.cwd()
const MANIFEST_PATH = 'external-rest-api/src/releaseManifest.ts'
const PACKAGE_PATHS = {
  externalRestApiVersion: 'external-rest-api/package.json',
  rpcProxyVersion: 'rpc-proxy/package.json',
  desktopVersion: 'desktop-app/package.json',
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
  compatibleDesktopVersions: string[]
  minimumDesktopVersion: string
}

export const releaseManifest: ReleaseManifest = ${JSON.stringify(manifest, null, 2)
    .replace(/"([^"]+)":/g, '$1:')
    .replace(/: "([^"]*)"/g, ": '$1'")
    .replace(/"([^"]*)"/g, "'$1'")
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
  const compatibleDesktopVersions = manifest.compatibleDesktopVersions
  if (
    !Array.isArray(compatibleDesktopVersions) ||
    compatibleDesktopVersions.length === 0 ||
    compatibleDesktopVersions.some(version => !SEMVER_RE.test(version)) ||
    new Set(compatibleDesktopVersions).size !== compatibleDesktopVersions.length
  ) {
    throw new Error(
      'compatibleDesktopVersions must be a non-empty list of unique MAJOR.MINOR.PATCH versions'
    )
  }
  if (!compatibleDesktopVersions.includes(manifest.desktopVersion)) {
    throw new Error('compatibleDesktopVersions must include desktopVersion')
  }
  if (
    compatibleDesktopVersions.some(version => compareVersions(version, manifest.desktopVersion) > 0)
  ) {
    throw new Error('desktopVersion must be the highest version in compatibleDesktopVersions')
  }
}

function argValues(name) {
  const values = []
  for (let i = 0; i < process.argv.length; i += 1) {
    if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[i + 1])
  }
  return values
}

function main() {
  const previousRef = argValue('--previous')
  const releaseId = argValue('--release-id') || 'local'
  const requestedCompatibleVersions = argValues('--compatible-desktop-version')
  const validateOnly = process.argv.includes('--validate-only')
  const deferDesktopRelease = process.argv.includes('--defer-desktop-release')

  if (process.argv.includes('--minimum-desktop-version')) {
    throw new Error(
      'minimumDesktopVersion is frozen for already-shipped clients; do not raise the legacy update floor'
    )
  }

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

  if (!inherited) {
    throw new Error(
      'no minimumDesktopVersion could be read; repair the existing manifest rather than ' +
        'defaulting it to desktopVersion'
    )
  }

  if (!previous) {
    previous = {
      releaseId,
      externalRestApiVersion: versions.externalRestApiVersion,
      rpcProxyVersion: versions.rpcProxyVersion,
      desktopVersion: versions.desktopVersion,
      minimumDesktopVersion: inherited,
    }
  }
  const prevVersions = previousVersions(previousRef)
  const previousDesktopVersion =
    prevVersions.desktopVersion || manifestAtHead?.desktopVersion || previous.desktopVersion
  const desktopVersionChanged = Boolean(
    !deferDesktopRelease && previousDesktopVersion !== versions.desktopVersion
  )

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
    (desktopVersionChanged || next.desktopVersion !== versions.desktopVersion)
  ) {
    next.desktopVersion = versions.desktopVersion
    changed = true
  }

  const compatibleDesktopVersions = requestedCompatibleVersions.length
    ? requestedCompatibleVersions
    : desktopVersionChanged
      ? [versions.desktopVersion]
      : (manifestAtHead?.compatibleDesktopVersions ??
        previous.compatibleDesktopVersions ?? [versions.desktopVersion])
  if (
    JSON.stringify(next.compatibleDesktopVersions) !== JSON.stringify(compatibleDesktopVersions)
  ) {
    next.compatibleDesktopVersions = compatibleDesktopVersions
    changed = true
  }

  // Preserve the legacy floor for clients that still consume it. New clients
  // use compatibleDesktopVersions; this field must never be raised to gate use.
  if (inherited && next.minimumDesktopVersion !== inherited) {
    next.minimumDesktopVersion = inherited
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
