#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { projectRoots, rootFormatTargets } from './paths.mjs'
import {
  exitWithError,
  parseNullDelimitedPaths,
  prettierBin,
  repoRoot,
  run,
  selectPrettierFiles,
} from './select-files.mjs'

if (!existsSync(prettierBin)) {
  exitWithError('Prettier is not installed. Run `npm install` at the repository root first.')
}

const stagedFilesResult = run(
  'git',
  ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z', '--'],
  { encoding: null }
)

if (stagedFilesResult.status !== 0) {
  exitWithError(
    stagedFilesResult.stderr?.toString() || 'Failed to read staged files.',
    stagedFilesResult.status ?? 1
  )
}

const filesToFormat = selectPrettierFiles(parseNullDelimitedPaths(stagedFilesResult.stdout), {
  projectRoots,
  rootFormatTargets,
})

if (filesToFormat.length === 0) {
  process.exit(0)
}

const prettierResult = spawnSync(prettierBin, ['--write', '--', ...filesToFormat], {
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
