#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { projectRoots, rootFormatTargets } from './paths.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const prettierBin = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prettier.cmd' : 'prettier'
)

const supportedExtensions = new Set([
  '.cjs',
  '.css',
  '.cts',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mdx',
  '.mjs',
  '.mts',
  '.scss',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
])

const ignoredBasenames = new Set(['package-lock.json'])

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

function isInProjectRoots(file) {
  return projectRoots.some(root => file === root || file.startsWith(`${root}/`))
}

function isRootTarget(file) {
  return rootFormatTargets.some(target => file === target || file.startsWith(`${target}/`))
}

function isGitIgnored(file) {
  const result = run('git', ['check-ignore', '--quiet', '--', file], {
    stdio: 'ignore',
  })

  if (result.status === 0) {
    return true
  }

  if (result.status === 1) {
    return false
  }

  exitWithError(`Failed to determine whether ${file} is ignored by Git.`, result.status ?? 1)
}

if (!existsSync(prettierBin)) {
  exitWithError('Prettier is not installed. Run `npm install` at the repository root first.')
}

const stagedFilesResult = run('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'])

if (stagedFilesResult.status !== 0) {
  exitWithError(
    stagedFilesResult.stderr || 'Failed to read staged files.',
    stagedFilesResult.status
  )
}

const filesToFormat = [
  ...new Set(
    stagedFilesResult.stdout
      .split(/\r?\n/)
      .map(file => file.trim())
      .filter(Boolean)
      .filter(file => {
        const absolutePath = join(repoRoot, file)

        if (!existsSync(absolutePath)) {
          return false
        }

        if (ignoredBasenames.has(basename(absolutePath))) {
          return false
        }

        if (!supportedExtensions.has(extname(absolutePath).toLowerCase())) {
          return false
        }

        if (isGitIgnored(file)) {
          return false
        }

        return isInProjectRoots(file) || isRootTarget(file)
      })
  ),
].sort()

if (filesToFormat.length === 0) {
  process.exit(0)
}

const prettierResult = spawnSync(prettierBin, ['--write', ...filesToFormat], {
  cwd: repoRoot,
  stdio: 'inherit',
})

if (prettierResult.status !== 0) {
  process.exit(prettierResult.status ?? 1)
}

const restageResult = spawnSync('git', ['add', '--', ...filesToFormat], {
  cwd: repoRoot,
  stdio: 'inherit',
})

if (restageResult.status !== 0) {
  process.exit(restageResult.status ?? 1)
}
