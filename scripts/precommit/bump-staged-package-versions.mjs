#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { packageRoots } from '../prettier/paths.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sortedPackageRoots = [...packageRoots].sort((a, b) => b.length - a.length)

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
