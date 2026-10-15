#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { argValue, parseManifest } from './release-coordinates.mjs'

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

// The only fields the manifest carries. Manifests read from older refs (or an
// un-migrated HEAD) may still hold the retired minimumDesktopVersion floor;
// picking these keys drops it so the rendered object always matches the
// rendered ReleaseManifest type.
const MANIFEST_FIELDS = ['releaseId', 'externalRestApiVersion', 'rpcProxyVersion', 'desktopVersion']

function pickManifestFields(manifest) {
  return Object.fromEntries(MANIFEST_FIELDS.map(field => [field, manifest[field]]))
}

function renderManifest(manifest) {
  return `export type ReleaseManifest = {
  releaseId: string
  externalRestApiVersion: string
  rpcProxyVersion: string
  desktopVersion: string
}

export const releaseManifest: ReleaseManifest = ${JSON.stringify(
    pickManifestFields(manifest),
    null,
    2
  )
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
}

function main() {
  const previousRef = argValue('--previous')
  const releaseId = argValue('--release-id') || 'local'
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

  if (!previous) {
    previous = {
      releaseId,
      externalRestApiVersion: versions.externalRestApiVersion,
      rpcProxyVersion: versions.rpcProxyVersion,
      desktopVersion: versions.desktopVersion,
    }
  }
  const prevVersions = previousVersions(previousRef)

  const next = { ...pickManifestFields(previous), releaseId }
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

  if (!changed && manifestAtHead) {
    Object.assign(next, pickManifestFields(manifestAtHead))
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
      `correct --release-id flag), then re-run ` +
      '`node scripts/release/update-desktop-release-manifest.mjs`.'
  )
  process.exit(1)
}
