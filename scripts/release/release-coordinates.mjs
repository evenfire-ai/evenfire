// The release coordinates: every place in the tree that must agree with the
// release tag. One writer (prepare-release.mjs) and one checker
// (validate-release-tag.mjs) both import this list, so a coordinate cannot be
// written without being checked.
//
// The coordinates are NOT all the same kind of thing, which is why each row
// carries its own assertion:
//   equals   - must equal the release version (build inputs, declarations)
//   floor    - a compatibility floor; must be <= the version, moves only on request
//   counter  - a per-service counter; must equal ITS OWN package.json, not the version
//   pointer  - names an artifact; equality here, plus existence checking once a
//              release-images.yml workflow exists (it does not exist in this repo yet)
//
// A future workstream would append the ghcr component pointer row. Do not add
// it before deploy/components/ghcr-images/kustomization.yaml exists.
import fs from 'node:fs'
import path from 'node:path'

// Shared argv reader. Returns '' when the flag is absent, and undefined when
// the flag is last with no value after it -- callers must treat both as unset.
export function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

export const SEMVER_RE = /^\d+\.\d+\.\d+$/

export function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

function readJson(root, rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
}

function writeJson(root, rel, obj) {
  fs.writeFileSync(path.join(root, rel), `${JSON.stringify(obj, null, 2)}\n`)
}

// Parses the `releaseManifest` export specifically, not just any object in
// the file that happens to declare the same field names. A field-by-field
// line regex over the whole file (the earlier approach here) would match the
// FIRST line anywhere that looks like `  field: 'value'` -- including a
// decoy object placed above the real export, or nothing at all if the export
// were renamed, in which case a naive per-field regex silently returns ''
// per field instead of failing loudly. Anchoring on the export statement and
// parsing the whole object closes both holes at once. This is the same
// parser update-desktop-release-manifest.mjs uses, imported from here so
// there is exactly one implementation.
export function parseManifest(raw) {
  const match = raw.match(/export const releaseManifest: ReleaseManifest = (\{[\s\S]*?\n\})/)
  if (!match) return null
  const normalized = match[1]
    .replace(/([{,]\s*)([a-zA-Z][a-zA-Z0-9]*):/g, '$1"$2":')
    .replace(/'/g, '"')
    .replace(/,\s*}/g, '}')
  return JSON.parse(normalized)
}

function manifestField(root, field) {
  const raw = fs.readFileSync(path.join(root, 'external-rest-api/src/releaseManifest.ts'), 'utf8')
  const manifest = parseManifest(raw)
  return manifest ? String(manifest[field] ?? '') : ''
}

// A row carries `write` only when it owns its own write. The manifest fields
// are written by update-desktop-release-manifest.mjs, which prepare-release
// delegates to rather than duplicating its renderer, so those rows declare
// `writtenBy` instead. The writer skips any row without a `write`.
export const COORDINATES = [
  {
    name: 'desktop-app/package.json',
    assert: 'equals',
    read: root => readJson(root, 'desktop-app/package.json').version,
    write: (root, version) => {
      const j = readJson(root, 'desktop-app/package.json')
      j.version = version
      writeJson(root, 'desktop-app/package.json', j)
    },
  },
  {
    name: 'desktop-app/package-lock.json',
    assert: 'equals',
    read: root => {
      const j = readJson(root, 'desktop-app/package-lock.json')
      // Both sites must agree; report a mismatch as an unmistakable value.
      const rootVersion = j.version
      const pkgVersion = j.packages?.['']?.version
      return rootVersion === pkgVersion ? rootVersion : `${rootVersion}/${pkgVersion}`
    },
    write: (root, version) => {
      const j = readJson(root, 'desktop-app/package-lock.json')
      j.version = version
      if (j.packages?.['']) j.packages[''].version = version
      writeJson(root, 'desktop-app/package-lock.json', j)
    },
  },
  {
    name: 'releaseManifest.desktopVersion',
    assert: 'equals',
    read: root => manifestField(root, 'desktopVersion'),
    writtenBy: 'update-desktop-release-manifest.mjs',
  },
  {
    name: 'releaseManifest.minimumDesktopVersion',
    assert: 'floor',
    read: root => manifestField(root, 'minimumDesktopVersion'),
    writtenBy: 'update-desktop-release-manifest.mjs --minimum-desktop-version',
  },
  {
    name: 'releaseManifest.releaseId',
    assert: 'explicit',
    read: root => manifestField(root, 'releaseId'),
    writtenBy: 'update-desktop-release-manifest.mjs --release-id',
  },
  {
    name: 'releaseManifest.externalRestApiVersion',
    assert: 'counter',
    counterPackage: 'external-rest-api/package.json',
    read: root => manifestField(root, 'externalRestApiVersion'),
    writtenBy: 'update-desktop-release-manifest.mjs',
  },
  {
    name: 'releaseManifest.rpcProxyVersion',
    assert: 'counter',
    counterPackage: 'rpc-proxy/package.json',
    read: root => manifestField(root, 'rpcProxyVersion'),
    writtenBy: 'update-desktop-release-manifest.mjs',
  },
]

export function readCounterPackage(root, rel) {
  return readJson(root, rel).version
}
