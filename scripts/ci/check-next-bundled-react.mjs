#!/usr/bin/env node
// Fail when a Next.js app ships a `next` whose bundled React is affected by a
// known React advisory.
//
// The App Router does not run the app's own `react` dependency. It runs the
// React build compiled into the next package (next/dist/compiled/react,
// react-dom, react-server-dom-webpack/-turbopack, and the prebundled
// next-server/app-page*.runtime.*.js). No lockfile mentions that copy, so
// `npm audit`, Dependabot and lockfile OSV scans only ever report advisories
// filed against `next` itself (see #1431). This check reads the installed tree
// instead, so it works on a checkout after `npm ci` and inside a built image.
//
// Usage: check-next-bundled-react.mjs [--advisories <file>] [--json] <app-dir>...
//   <app-dir> is a directory containing node_modules/next (e.g. control-ui, or
//   /app/control-ui inside the image). Dependency-free so it runs in the
//   runtime image with only node available.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const DEFAULT_ADVISORIES = join(
  dirname(fileURLToPath(import.meta.url)),
  'next-bundled-react-advisories.json'
)

const BUNDLED_PACKAGES = [
  'react',
  'react-dom',
  'react-server-dom-webpack',
  'react-server-dom-turbopack',
]

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/

export function parseVersion(version) {
  const match = VERSION_RE.exec(version ?? '')
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  }
}

function compareRelease(a, b) {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

function compareLine(a, b) {
  return a.major - b.major || a.minor - b.minor
}

// Verdict for one bundled version against the advisory's fixed versions (one
// per affected major.minor line). Prereleases (React canaries) are not ordered
// against stable fixes -- Next.js backports fixes into canaries without
// changing the version string -- so they are undecidable without a marker.
export function versionVerdict(version, fixedVersions) {
  const parsed = parseVersion(version)
  if (!parsed) return { status: 'unverifiable', reason: `unparseable version ${version}` }
  if (parsed.prerelease) {
    return {
      status: 'unverifiable',
      reason: `prerelease ${version} cannot be ordered against fixed releases; the advisory needs a fixMarker`,
    }
  }
  const fixed = fixedVersions.map(v => ({ raw: v, ...parseVersion(v) })).sort(compareRelease)
  const sameLine = fixed.find(f => compareLine(f, parsed) === 0)
  if (sameLine) {
    return compareRelease(parsed, sameLine) >= 0
      ? { status: 'fixed', reason: `${version} >= ${sameLine.raw}` }
      : { status: 'vulnerable', reason: `${version} < ${sameLine.raw}` }
  }
  if (compareLine(parsed, fixed[0]) < 0) {
    return { status: 'vulnerable', reason: `${version} predates every fixed line` }
  }
  if (compareLine(parsed, fixed[fixed.length - 1]) > 0) {
    return { status: 'fixed', reason: `${version} is newer than every fixed line` }
  }
  return { status: 'unverifiable', reason: `${version} is on a line with no listed fix` }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function walkFiles(root) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  return files
}

// The compiled package.json files have no "version" (they are renamed
// "*-builtin"), so read the version from the peer pin or the build itself.
export function bundledVersion(compiledDir, name) {
  const dir = join(compiledDir, name)
  if (!existsSync(dir)) return null
  const manifestPath = join(dir, 'package.json')
  if (existsSync(manifestPath)) {
    const manifest = readJson(manifestPath)
    if (manifest.version) return manifest.version
    if (name.startsWith('react-server-dom-') && manifest.peerDependencies?.react) {
      return manifest.peerDependencies.react
    }
  }
  const builds =
    name === 'react'
      ? ['cjs/react.production.js', 'cjs/react.development.js']
      : name === 'react-dom'
        ? ['cjs/react-dom.production.js', 'cjs/react-dom.development.js']
        : []
  for (const build of builds) {
    const path = join(dir, build)
    if (!existsSync(path)) continue
    const match = /exports\.version\s*=\s*"([^"]+)"/.exec(readFileSync(path, 'utf8'))
    if (match) return match[1]
  }
  return null
}

function evaluateMarker(compiledDir, compiledFiles, advisory) {
  const patterns = advisory.markerFiles.map(source => ({ source, re: new RegExp(source) }))
  const unmatched = []
  const missing = []
  let checked = 0
  for (const pattern of patterns) {
    const matches = compiledFiles.filter(rel => pattern.re.test(rel))
    if (matches.length === 0) unmatched.push(pattern.source)
    for (const rel of matches) {
      checked += 1
      if (!readFileSync(join(compiledDir, rel), 'utf8').includes(advisory.fixMarker)) {
        missing.push(rel)
      }
    }
  }
  if (unmatched.length > 0) {
    // A pattern that matches nothing means the next layout changed and the
    // check would silently cover less than it claims. Fail closed.
    return {
      status: 'unverifiable',
      reason: `no files match ${unmatched.join(', ')}; update markerFiles for this next layout`,
    }
  }
  if (missing.length > 0) {
    return {
      status: 'vulnerable',
      reason: `fix marker missing from ${missing.length}/${checked} RSC server files`,
      files: missing,
    }
  }
  return { status: 'fixed', reason: `fix marker present in all ${checked} RSC server files` }
}

function evaluateVersions(versions, advisory) {
  const rsc = Object.entries(versions).filter(
    ([name, version]) => name.startsWith('react-server-dom-') && version
  )
  if (rsc.length === 0) {
    return { status: 'unverifiable', reason: 'no bundled react-server-dom-* version found' }
  }
  const verdicts = rsc.map(([name, version]) => ({
    name,
    ...versionVerdict(version, advisory.fixedReactVersions),
  }))
  for (const status of ['vulnerable', 'unverifiable']) {
    const hit = verdicts.find(v => v.status === status)
    if (hit) return { status, reason: `${hit.name}: ${hit.reason}` }
  }
  return { status: 'fixed', reason: verdicts.map(v => `${v.name}: ${v.reason}`).join('; ') }
}

export function checkApp(appDir, advisories) {
  const nextDir = join(appDir, 'node_modules', 'next')
  const nextManifest = join(nextDir, 'package.json')
  if (!existsSync(nextManifest)) {
    return { appDir, error: `next is not installed (${nextManifest} not found)`, ok: false }
  }
  const compiledDir = join(nextDir, 'dist', 'compiled')
  if (!existsSync(compiledDir) || !statSync(compiledDir).isDirectory()) {
    return { appDir, error: `${compiledDir} not found`, ok: false }
  }
  const nextVersion = readJson(nextManifest).version
  const versions = Object.fromEntries(
    BUNDLED_PACKAGES.map(name => [name, bundledVersion(compiledDir, name)])
  )
  const compiledFiles = walkFiles(compiledDir)
    .map(path => relative(compiledDir, path).split(sep).join('/'))
    .filter(rel => !rel.endsWith('.map'))
  const results = advisories.map(advisory => ({
    id: advisory.id,
    severity: advisory.severity,
    ...(advisory.fixMarker
      ? evaluateMarker(compiledDir, compiledFiles, advisory)
      : evaluateVersions(versions, advisory)),
  }))
  return {
    appDir,
    nextVersion,
    bundledReact: versions,
    advisories: results,
    ok: results.every(r => r.status === 'fixed'),
  }
}

function parseArgs(argv) {
  const options = { advisories: DEFAULT_ADVISORIES, json: false, apps: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') options.json = true
    else if (arg === '--advisories') options.advisories = argv[++i]
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`)
    else options.apps.push(arg)
  }
  if (options.apps.length === 0) throw new Error('at least one <app-dir> is required')
  if (!options.advisories) throw new Error('--advisories needs a file')
  return options
}

function printReport(report) {
  for (const app of report) {
    if (app.error) {
      console.log(`FAIL ${app.appDir}: ${app.error}`)
      continue
    }
    const react = Object.entries(app.bundledReact)
      .map(([name, version]) => `${name}=${version ?? 'absent'}`)
      .join(' ')
    console.log(
      `${app.ok ? 'ok  ' : 'FAIL'} ${app.appDir}: next@${app.nextVersion} bundles ${react}`
    )
    for (const result of app.advisories) {
      console.log(
        `     ${result.status.padEnd(12)} ${result.id} (${result.severity}): ${result.reason}`
      )
      for (const file of result.files ?? []) console.log(`       - next/dist/compiled/${file}`)
    }
  }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`check-next-bundled-react: ${error.message}`)
    console.error('usage: check-next-bundled-react.mjs [--advisories <file>] [--json] <app-dir>...')
    process.exit(2)
  }
  const { advisories } = readJson(options.advisories)
  if (!Array.isArray(advisories) || advisories.length === 0) {
    console.error(`check-next-bundled-react: no advisories in ${options.advisories}`)
    process.exit(2)
  }
  const report = options.apps.map(app => checkApp(resolve(app), advisories))
  if (options.json) console.log(JSON.stringify(report, null, 2))
  else printReport(report)
  process.exit(report.every(app => app.ok) ? 0 : 1)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
