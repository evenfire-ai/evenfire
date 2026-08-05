#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { packageRoots } from '../prettier/paths.mjs'
import { parseManifest } from '../release/release-coordinates.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sortedPackageRoots = [...packageRoots].sort((a, b) => b.length - a.length)

// Files that live inside a package root but must never trigger its counter.
// releaseManifest.ts declares the versions this script would bump. A later
// task adds scripts/release/prepare-release.mjs as the writer of this file;
// bumping external-rest-api in reaction to that write would make the
// manifest stale the instant it is produced. validate-release-version-bumps.mjs
// carries the identical exemption in its ignoredFiles.
const IGNORED_FILES = ['external-rest-api/src/releaseManifest.ts']

// Packages whose version releaseManifest.ts declares, and the manifest field
// each maps to. Bumping one of these without updating the manifest makes
// --validate-only throw on the next CI run, which would redden every PR
// touching these services. desktop-app is deliberately absent: it is not in
// packageRoots (this hook never bumps it), and desktopVersion is synced by a
// separate desktop release flow, not by this pre-commit hook.
const MANIFEST_PATH = 'external-rest-api/src/releaseManifest.ts'
const MANIFEST_FIELD_BY_PACKAGE = {
  'external-rest-api': 'externalRestApiVersion',
  'rpc-proxy': 'rpcProxyVersion',
}
const MANIFEST_COUNTER_PACKAGES = Object.keys(MANIFEST_FIELD_BY_PACKAGE)

function exitWithError(message, status = 1) {
  console.error(message)
  process.exit(status)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  })

  if (result.error) {
    throw result.error
  }

  return result
}

function getPackageRootForFile(file) {
  return sortedPackageRoots.find(root => file === root || file.startsWith(`${root}/`)) ?? null
}

function readJsonFile(relativePath) {
  return JSON.parse(readFileSync(join(repoRoot, relativePath), 'utf8'))
}

function readJsonFromGit(ref, relativePath) {
  const result = run('git', ['show', `${ref}:${relativePath}`])

  if (result.status !== 0) {
    return null
  }

  return JSON.parse(result.stdout)
}

function stageFile(relativePath) {
  const addResult = spawnSync('git', ['add', '--', relativePath], {
    cwd: repoRoot,
    stdio: 'inherit',
  })

  if (addResult.status !== 0) {
    process.exit(addResult.status ?? 1)
  }
}

function hasUnstagedChanges(relativePath) {
  const result = run('git', ['diff', '--name-only', '--', relativePath])

  if (result.status !== 0) {
    exitWithError(result.stderr || `Failed to inspect ${relativePath}.`, result.status)
  }

  return result.stdout.trim().length > 0
}

function bumpPatchVersion(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/)

  if (!match) {
    throw new Error(`Unsupported version format: ${version}`)
  }

  const [, major, minor, patch, prerelease = '', build = ''] = match
  return `${major}.${minor}.${Number(patch) + 1}${prerelease}${build}`
}

// Reads a counter package's version out of the INDEX (git's staged content),
// not the working tree. Only what's staged is what a commit actually records;
// a disk read here would let an unstaged, never-to-be-committed edit decide
// whether the manifest gets re-synced, and what value it gets re-synced to.
function readIndexedPackageVersion(pkg) {
  const packageJsonPath = `${pkg}/package.json`
  const result = run('git', ['show', `:${packageJsonPath}`])

  if (result.status !== 0) {
    return null
  }

  try {
    return JSON.parse(result.stdout).version ?? null
  } catch (error) {
    exitWithError(
      `The pre-commit hook (scripts/precommit/bump-staged-package-versions.mjs) could not parse ` +
        `the staged ${packageJsonPath} to check whether ${MANIFEST_PATH} needs re-syncing: ${error.message}\n` +
        `Fix ${packageJsonPath} (e.g. resolve merge conflict markers) and re-stage it, then retry the commit.`
    )
  }
}

const stagedFilesResult = run('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'])

if (stagedFilesResult.status !== 0) {
  exitWithError(
    stagedFilesResult.stderr || 'Failed to inspect staged files.',
    stagedFilesResult.status
  )
}

const affectedPackages = [
  ...new Set(
    stagedFilesResult.stdout
      .split(/\r?\n/)
      .map(file => file.trim())
      .filter(Boolean)
      .filter(file => !IGNORED_FILES.includes(file))
      .map(getPackageRootForFile)
      .filter(Boolean)
  ),
]

for (const packageRoot of affectedPackages) {
  const packageJsonPath = `${packageRoot}/package.json`
  const packageLockPath = `${packageRoot}/package-lock.json`
  const absolutePackageJsonPath = join(repoRoot, packageJsonPath)
  const absolutePackageLockPath = join(repoRoot, packageLockPath)

  if (!existsSync(absolutePackageJsonPath)) {
    continue
  }

  if (hasUnstagedChanges(packageJsonPath)) {
    exitWithError(
      `Refusing to auto-bump ${packageJsonPath} because it has unstaged changes. Stage or discard them first.`
    )
  }

  if (existsSync(absolutePackageLockPath) && hasUnstagedChanges(packageLockPath)) {
    exitWithError(
      `Refusing to auto-sync ${packageLockPath} because it has unstaged changes. Stage or discard them first.`
    )
  }

  const headPackage = readJsonFromGit('HEAD', packageJsonPath)
  const currentPackage = readJsonFile(packageJsonPath)

  if (!headPackage?.version || !currentPackage.version) {
    continue
  }

  if (currentPackage.version !== headPackage.version) {
    continue
  }

  try {
    currentPackage.version = bumpPatchVersion(currentPackage.version)
  } catch (error) {
    exitWithError(`Refusing to auto-bump ${packageJsonPath}: ${error.message}`)
  }

  writeFileSync(absolutePackageJsonPath, `${JSON.stringify(currentPackage, null, 2)}\n`)
  stageFile(packageJsonPath)

  if (existsSync(absolutePackageLockPath)) {
    const currentPackageLock = readJsonFile(packageLockPath)
    let shouldWritePackageLock = false

    if (currentPackageLock.version !== currentPackage.version) {
      currentPackageLock.version = currentPackage.version
      shouldWritePackageLock = true
    }

    if (currentPackageLock.packages?.['']) {
      if (currentPackageLock.packages[''].version !== currentPackage.version) {
        currentPackageLock.packages[''].version = currentPackage.version
        shouldWritePackageLock = true
      }
    }

    if (shouldWritePackageLock) {
      writeFileSync(absolutePackageLockPath, `${JSON.stringify(currentPackageLock, null, 2)}\n`)
      stageFile(packageLockPath)
    }
  }

  console.log(`${packageJsonPath}: ${headPackage.version} -> ${currentPackage.version}`)
}

// Re-sync the manifest whenever a counter it declares has drifted from the
// package.json it tracks -- not only when this run performed the bump. A
// bump that lands in one pre-commit invocation and a re-sync that then fails
// (bad manifest, missing floor, ...) must still converge on a retry. Keying
// this off "does the manifest currently disagree with disk" rather than off
// which packages this run happened to bump makes the retry path self-healing
// instead of a bump that permanently disarms its own re-sync: on retry the
// bumped package.json no longer equals HEAD, so the bump loop above skips it
// via the currentPackage.version !== headPackage.version check, and a
// bumpedPackages-style flag would stay empty forever.
const manifestAbsolutePath = join(repoRoot, MANIFEST_PATH)
const relevantCounterPackages = MANIFEST_COUNTER_PACKAGES.filter(pkg =>
  existsSync(join(repoRoot, `${pkg}/package.json`))
)

if (relevantCounterPackages.length > 0) {
  // Checked BEFORE the manifest is read for drift purposes, not just before
  // the re-sync runs. The manifest read below feeds the "is anything out of
  // sync" decision itself (it reads the working tree, same as the file this
  // guard inspects); a dirty manifest that happens to already read as
  // in-sync would make outOfSyncPackages empty and skip the refusal
  // entirely if it lived inside that branch, silently committing a
  // package.json bump alongside a manifest that was never staged to match
  // it. Moving the check up here means a dirty manifest can never influence
  // the decision -- it always blocks first.
  if (hasUnstagedChanges(MANIFEST_PATH)) {
    exitWithError(
      `The pre-commit hook (scripts/precommit/bump-staged-package-versions.mjs) is refusing to ` +
        `auto-sync ${MANIFEST_PATH} because it has unstaged changes. Stage or discard them first.`
    )
  }

  let manifestSource

  try {
    manifestSource = readFileSync(manifestAbsolutePath, 'utf8')
  } catch (error) {
    exitWithError(
      `The pre-commit hook (scripts/precommit/bump-staged-package-versions.mjs) could not read ` +
        `${MANIFEST_PATH} to check whether it needs re-syncing after a version bump: ${error.message}\n` +
        `Restore the file (e.g. \`git checkout HEAD -- ${MANIFEST_PATH}\`) or regenerate it with ` +
        `\`node scripts/release/update-desktop-release-manifest.mjs\`, then retry the commit.`
    )
  }

  let manifest

  try {
    manifest = parseManifest(manifestSource)
  } catch (error) {
    exitWithError(
      `The pre-commit hook (scripts/precommit/bump-staged-package-versions.mjs) could not parse ` +
        `${MANIFEST_PATH} to check whether it needs re-syncing after a version bump: ${error.message}\n` +
        `Restore the file (e.g. \`git checkout HEAD -- ${MANIFEST_PATH}\`) or regenerate it with ` +
        `\`node scripts/release/update-desktop-release-manifest.mjs\`, then retry the commit.`
    )
  }

  const outOfSyncPackages = relevantCounterPackages.filter(pkg => {
    const currentVersion = readIndexedPackageVersion(pkg)
    const manifestVersion = manifest ? manifest[MANIFEST_FIELD_BY_PACKAGE[pkg]] : undefined
    return currentVersion && currentVersion !== manifestVersion
  })

  if (outOfSyncPackages.length > 0) {
    // The updater re-reads every counter package's package.json from disk on
    // each invocation, not just the one that triggered this re-sync (absent
    // --previous it always treats every counter field as changed). An
    // unrelated unstaged edit anywhere in MANIFEST_COUNTER_PACKAGES would
    // therefore leak an uncommitted version into the manifest we are about
    // to stage, even though it correctly did not trigger this re-sync itself.
    for (const pkg of relevantCounterPackages) {
      const trackedPackageJsonPath = `${pkg}/package.json`
      if (hasUnstagedChanges(trackedPackageJsonPath)) {
        exitWithError(
          `The pre-commit hook (scripts/precommit/bump-staged-package-versions.mjs) is refusing to ` +
            `re-sync ${MANIFEST_PATH} because ${trackedPackageJsonPath} has unstaged changes. The ` +
            `updater reads every counter package.json from disk, so an unrelated unstaged edit would ` +
            `leak an uncommitted version into the manifest. Stage or discard them first.`
        )
      }
    }

    // The updater defaults releaseId to the literal 'local' when --release-id
    // is absent, which would ship in a customer-facing manifest. Carry the
    // existing value through instead of fabricating one: a counter bump is
    // not a release.
    const releaseId = manifest ? manifest.releaseId : undefined

    if (!releaseId) {
      exitWithError(
        `Could not read a releaseId out of ${MANIFEST_PATH} to preserve during the pre-commit ` +
          `re-sync. Refusing to fabricate one -- the updater defaults to 'local' when --release-id ` +
          `is omitted, and that must never land in a customer-facing manifest. Fix the releaseId ` +
          `field in ${MANIFEST_PATH} and retry the commit.`
      )
    }

    const resync = run('node', [
      'scripts/release/update-desktop-release-manifest.mjs',
      '--release-id',
      releaseId,
      // This re-sync only ever moves the external-rest-api/rpc-proxy
      // counters, never a desktop release. Without --defer-desktop-release
      // the updater also copies desktop-app/package.json's version into
      // desktopVersion, which would publish an unreleased desktop build to
      // every client polling the manifest off the back of an ordinary
      // service PR. The "never use this flag" rule is narrower than it
      // sounds: it forbids using the flag to silence a --validate-only
      // failure, not this re-sync, where leaving desktopVersion untouched is
      // the entire point -- a counter bump is not a desktop release.
      '--defer-desktop-release',
    ])

    if (resync.status !== 0) {
      const detail = (resync.stderr || '').trim()
      exitWithError(
        `The pre-commit hook (scripts/precommit/bump-staged-package-versions.mjs) could not ` +
          `re-sync ${MANIFEST_PATH} via scripts/release/update-desktop-release-manifest.mjs after ` +
          `${outOfSyncPackages.join(', ')} moved. Resolve the issue below, then either fix ` +
          `${MANIFEST_PATH} directly or run the updater manually with the flags it needs (e.g. ` +
          `--minimum-desktop-version) and \`git add ${MANIFEST_PATH}\` before retrying the commit.` +
          (detail ? `\n\nUnderlying error:\n${detail}` : ''),
        resync.status
      )
    }

    stageFile(MANIFEST_PATH)
    console.log(`${MANIFEST_PATH}: re-synced after ${outOfSyncPackages.join(', ')}`)
  }
}
