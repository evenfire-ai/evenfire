#!/usr/bin/env node
import { execFileSync } from 'node:child_process'

const previousRef = argValue('--previous')
const currentRef = argValue('--current') || 'HEAD'
const allServices = process.argv.includes('--all-services')

const JWT_KEY_POLICY = 'packages/jwt-key-policy/'
const RELEASE_MANIFEST = 'external-rest-api/src/releaseManifest.ts'

const PROJECTS = [
  {
    name: 'external-rest-api',
    packagePath: 'external-rest-api/package.json',
    codePrefixes: ['external-rest-api/src/', 'external-rest-api/test/', JWT_KEY_POLICY],
    codeFiles: ['external-rest-api/tsconfig.json'],
    ignoredFiles: [RELEASE_MANIFEST],
  },
  {
    name: 'rpc-proxy',
    packagePath: 'rpc-proxy/package.json',
    codePrefixes: ['rpc-proxy/src/', 'rpc-proxy/test/', JWT_KEY_POLICY],
    codeFiles: ['rpc-proxy/tsconfig.json'],
  },
]

// Test code and Markdown under a service. No running image contains them, so a change to them
// alone leaves what the service does as it was.
const NOT_SHIPPED = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$|\.testFixtures\.ts$|\.md$/
const TEST_DIRECTORIES = ['test/', 'tests/', 'e2e/']
// Dev-only files at a service's root. No running image contains them either; the same names
// lower down count. SERVICES names the services whose scripts/ is dev-only as well. Every other
// file under a service counts, as it does for the pre-commit hook: lockfiles, Dockerfiles,
// next.config.js and public/ all reach the image.
const DEV_ONLY_ROOT_FILE = /^(Makefile|makefile|vitest\.config\.[^/]+|\.env\.example)$/

// The services --all-services checks. Two branches from one base can reach the same next
// version, and that line then merges cleanly: a clean merge runs no pre-commit hook, so nothing
// else notices that one version now names two different trees. Comparing a pull request's merge
// result with its base catches it. The push leg cannot use this: after such a merge it would
// fail with no branch to fix.
// scripts/tests/test-validate-release-version-bumps.sh pins this list against the roots the
// pre-commit hook bumps. Keep this file free of local imports: that test and
// test-jwt-policy-version-consumers.sh run a copy of it in a fixture.
const SERVICES = [
  { root: 'channel-reader' },
  { root: 'control-api', sharedPrefixes: [JWT_KEY_POLICY], devDirectories: ['scripts/'] },
  { root: 'control-ui' },
  { root: 'external-rest-api', sharedPrefixes: [JWT_KEY_POLICY] },
  { root: 'host-context-controller' },
  { root: 'mcp-host', devDirectories: ['scripts/'] },
  { root: 'mcp-proxy' },
  { root: 'mcp-servers/doc-generator' },
  { root: 'mcp-servers/web-search' },
  { root: 'profile-ui' },
  { root: 'rpc-proxy', sharedPrefixes: [JWT_KEY_POLICY] },
  { root: 'stdio-bridge' },
  { root: 'workflow-recipes', devDirectories: ['scripts/'] },
].map(({ root, sharedPrefixes = [], devDirectories = [] }) => ({
  name: root,
  packagePath: `${root}/package.json`,
  codePrefixes: [`${root}/`, ...sharedPrefixes],
  codeFiles: [],
  ignoredFiles: [RELEASE_MANIFEST],
  ignoredPrefixes: [...TEST_DIRECTORIES, ...devDirectories].map(
    directory => `${root}/${directory}`
  ),
  ignoredPattern: NOT_SHIPPED,
  ignoredRootFile: DEV_ONLY_ROOT_FILE,
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

function existsAt(ref, filePath) {
  return git(['ls-tree', '--full-tree', '--name-only', ref, '--', filePath]) !== ''
}

function packageVersionAt(ref, filePath) {
  const raw = git(['show', `${ref}:${filePath}`])
  return String(JSON.parse(raw).version || '')
}

function changedFiles() {
  if (!previousRef || /^0+$/.test(previousRef)) return []
  // --no-renames lists both sides, so a file renamed to a test name or moved out of a service
  // still counts as that service's file going away.
  return git(['diff', '--no-renames', '--name-only', `${previousRef}..${currentRef}`])
    .split('\n')
    .map(filePath => filePath.trim())
    .filter(Boolean)
}

function codeChanged(project, files) {
  return files.some(filePath => {
    if (project.ignoredFiles?.includes(filePath)) return false
    if (project.ignoredPrefixes?.some(prefix => filePath.startsWith(prefix))) return false
    if (project.ignoredPattern?.test(filePath)) return false
    if (
      filePath.startsWith(`${project.name}/`) &&
      project.ignoredRootFile?.test(filePath.slice(project.name.length + 1))
    ) {
      return false
    }
    return (
      project.codePrefixes.some(prefix => filePath.startsWith(prefix)) ||
      project.codeFiles.includes(filePath)
    )
  })
}

// [major, minor, patch], or null for a version this check cannot order.
function versionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  return match ? match.slice(1).map(Number) : null
}

if (!previousRef || /^0+$/.test(previousRef)) {
  console.log('Skipping version bump validation because no previous commit is available.')
  process.exit(0)
}

const files = changedFiles()
const failures = []

for (const project of allServices ? SERVICES : PROJECTS) {
  if (!codeChanged(project, files)) continue

  if (!existsAt(currentRef, project.packagePath)) {
    failures.push(
      `${project.packagePath} is missing at ${currentRef}; restore it, or remove ${project.name} from this script's list`
    )
    continue
  }
  // A service the base does not have yet has no version to collide with, so one pull request
  // can add or rename a service and list it here.
  if (!existsAt(previousRef, project.packagePath)) continue

  const previousVersion = packageVersionAt(previousRef, project.packagePath)
  const currentVersion = packageVersionAt(currentRef, project.packagePath)
  if (previousVersion === currentVersion) {
    failures.push(
      `${project.name} code changed but ${project.packagePath} stayed at ${currentVersion}`
    )
    continue
  }
  // The default mode runs on the push leg too: a lower version there has no branch left to fix.
  if (!allServices) continue

  // A lower version makes the next hook bump issue a number that already named another tree.
  // That is as true of a revert as of a version conflict resolved to the lower side.
  const parts = versionParts(currentVersion)
  const baseParts = versionParts(previousVersion)
  if (!parts || !baseParts) {
    failures.push(
      `cannot order ${project.packagePath}: ${previousVersion} to ${currentVersion}; this check needs x.y.z`
    )
    continue
  }
  const index = parts.findIndex((part, i) => part !== baseParts[i])
  if (index >= 0 && parts[index] < baseParts[index]) {
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
