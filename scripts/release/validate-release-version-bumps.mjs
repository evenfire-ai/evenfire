#!/usr/bin/env node
import { execFileSync } from 'node:child_process'

const previousRef = argValue('--previous')
const currentRef = argValue('--current') || 'HEAD'
const allServices = process.argv.includes('--all-services')

// Test files beside the code in a service's source directories. No service runs them, so a
// change to one alone leaves what the service does as it was.
const TEST_ONLY_FILE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$|\.testFixtures\.ts$/

const PROJECTS = [
  {
    name: 'external-rest-api',
    packagePath: 'external-rest-api/package.json',
    codePrefixes: ['external-rest-api/src/', 'external-rest-api/test/', 'packages/jwt-key-policy/'],
    codeFiles: ['external-rest-api/tsconfig.json'],
    ignoredFiles: ['external-rest-api/src/releaseManifest.ts'],
  },
  {
    name: 'rpc-proxy',
    packagePath: 'rpc-proxy/package.json',
    codePrefixes: ['rpc-proxy/src/', 'rpc-proxy/test/', 'packages/jwt-key-policy/'],
    codeFiles: ['rpc-proxy/tsconfig.json'],
  },
]

// Shipped code of the other services, checked only with --all-services. Two branches
// from one base can reach the same next version, and that line then merges cleanly: a
// clean merge runs no pre-commit hook, so nothing else notices that one version now names
// two different trees. Comparing a pull request's merge result with its base catches it.
// The push leg cannot use this: after such a merge it would fail with no branch to fix.
// scripts/tests/test-validate-release-version-bumps.sh pins this list against the roots the
// pre-commit hook bumps. Keep this file free of local imports: that test and
// test-jwt-policy-version-consumers.sh run a copy of it in a fixture.
const SERVICE_PROJECTS = [
  ['channel-reader', ['src/']],
  ['control-api', ['src/']],
  ['control-ui', ['app/', 'components/', 'lib/']],
  ['host-context-controller', ['src/']],
  ['mcp-host', ['src/']],
  ['mcp-proxy', ['src/']],
  ['mcp-servers/doc-generator', ['src/']],
  ['mcp-servers/web-search', ['src/']],
  ['profile-ui', ['app/', 'lib/']],
  ['stdio-bridge', ['src/']],
  ['workflow-recipes', ['src/']],
].map(([root, dirs]) => ({
  name: root,
  packagePath: `${root}/package.json`,
  codePrefixes: dirs.map(dir => `${root}/${dir}`),
  codeFiles: [],
  ignoredPattern: TEST_ONLY_FILE,
}))

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : ''
}

function git(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function packageVersionAt(ref, filePath) {
  const raw = git(['show', `${ref}:${filePath}`])
  return String(JSON.parse(raw).version || '')
}

function changedFiles() {
  if (!previousRef || /^0+$/.test(previousRef)) return []
  return git(['diff', '--name-only', `${previousRef}..${currentRef}`])
    .split('\n')
    .map(filePath => filePath.trim())
    .filter(Boolean)
}

function codeChanged(project, files) {
  return files.some(filePath => {
    if (project.ignoredFiles?.includes(filePath)) return false
    if (project.ignoredPattern?.test(filePath)) return false
    return (
      project.codePrefixes.some(prefix => filePath.startsWith(prefix)) ||
      project.codeFiles.includes(filePath)
    )
  })
}

function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) throw new Error(`cannot order version "${version}": expected x.y.z`)
  return match.slice(1).map(Number)
}

function versionIsBelow(version, base) {
  const parts = versionParts(version)
  const baseParts = versionParts(base)
  const index = parts.findIndex((part, i) => part !== baseParts[i])
  return index >= 0 && parts[index] < baseParts[index]
}

if (!previousRef || /^0+$/.test(previousRef)) {
  console.log('Skipping version bump validation because no previous commit is available.')
  process.exit(0)
}

const files = changedFiles()
const failures = []

for (const project of allServices ? [...PROJECTS, ...SERVICE_PROJECTS] : PROJECTS) {
  const changed = codeChanged(project, files)
  // A version can go down with no code change, from a version conflict resolved to the lower
  // side. The next hook bump then issues a number that already named another tree.
  if (!changed && !(allServices && files.includes(project.packagePath))) continue

  const previousVersion = packageVersionAt(previousRef, project.packagePath)
  const currentVersion = packageVersionAt(currentRef, project.packagePath)
  if (changed && previousVersion === currentVersion) {
    failures.push(
      `${project.name} code changed but ${project.packagePath} stayed at ${currentVersion}`
    )
  } else if (allServices && versionIsBelow(currentVersion, previousVersion)) {
    failures.push(
      `${project.packagePath} went down from ${previousVersion} to ${currentVersion}; set it above the base`
    )
  }
}

if (failures.length) {
  for (const failure of failures) {
    console.error(`::error::${failure}`)
  }
  process.exit(1)
}

console.log('Release package version bumps are valid.')
