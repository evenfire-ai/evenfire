#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

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

function parseManifest(raw) {
  const match = raw.match(/export const releaseManifest: ReleaseManifest = (\{[\s\S]*?\n\})/)
  if (!match) return null
  const normalized = match[1]
    .replace(/([{,]\s*)([a-zA-Z][a-zA-Z0-9]*):/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/,\s*}/g, '}')
  return JSON.parse(normalized)
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
    .replace(/: "([^"]*)"/g, ": '$1'")}
`
}

function validate(manifest, versions) {
  for (const field of Object.keys(PACKAGE_PATHS)) {
    if (manifest[field] !== versions[field]) {
      throw new Error(`${field}=${manifest[field]} does not match package.json ${versions[field]}`)
    }
  }
  if (manifest.minimumDesktopVersion !== manifest.desktopVersion) {
    throw new Error('minimumDesktopVersion must match desktopVersion for this release model')
  }
}

const previousRef = argValue('--previous')
const releaseId = argValue('--release-id') || 'local'
const validateOnly = process.argv.includes('--validate-only')

const versions = currentVersions()
const previous = previousManifest(previousRef) || {
  releaseId,
  externalRestApiVersion: versions.externalRestApiVersion,
  rpcProxyVersion: versions.rpcProxyVersion,
  desktopVersion: versions.desktopVersion,
  minimumDesktopVersion: versions.desktopVersion,
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
  !prevVersions.desktopVersion ||
  prevVersions.desktopVersion !== versions.desktopVersion ||
  next.desktopVersion !== versions.desktopVersion
) {
  next.desktopVersion = versions.desktopVersion
  next.minimumDesktopVersion = versions.desktopVersion
  changed = true
}

if (!changed && currentManifest()) {
  next.releaseId = currentManifest().releaseId
}

validate(next, versions)

if (!validateOnly) {
  fs.writeFileSync(path.join(ROOT, MANIFEST_PATH), renderManifest(next))
}

console.log(JSON.stringify(next, null, 2))
