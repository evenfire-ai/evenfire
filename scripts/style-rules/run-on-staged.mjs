#!/usr/bin/env node
/**
 * Pre-commit entry: run style-rules against staged files only.
 * Mirrors scripts/prettier/run-on-staged.mjs in shape and behavior.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { checkFiles, reportAndExitCode } from './check.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function exitWithError(message, status = 1) {
  process.stderr.write(`${message}\n`)
  process.exit(status)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    ...options,
  })
  if (result.error) throw result.error
  return result
}

const stagedFilesResult = run('git', [
  'diff',
  '--cached',
  '--name-only',
  '--diff-filter=ACMR',
])

if (stagedFilesResult.status !== 0) {
  exitWithError(
    stagedFilesResult.stderr || 'Failed to read staged files.',
    stagedFilesResult.status
  )
}

const stagedFiles = stagedFilesResult.stdout
  .split(/\r?\n/)
  .map(f => f.trim())
  .filter(Boolean)

if (stagedFiles.length === 0) {
  process.exit(0)
}

const result = checkFiles(stagedFiles)
process.exit(reportAndExitCode(result))
