#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { ciExcludedPaths, ciProjectRoots, ciRootFormatTargets, ciYamlRoots } from './paths.mjs'
import {
  exitWithError,
  parseNullDelimitedPaths,
  prettierBin,
  repoRoot,
  run,
  selectPrettierFiles,
} from './select-files.mjs'

const ZERO_SHA = '0000000000000000000000000000000000000000'
const VALID_MODES = new Set(['direct', 'merge-base'])

function parseArgs(args) {
  const options = {}

  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]
    const value = args[index + 1]

    if (!['--base', '--head', '--mode'].includes(key) || value === undefined) {
      exitWithError('Usage: run-on-diff.mjs --base <sha> --head <sha> --mode <direct|merge-base>')
    }

    options[key.slice(2)] = value
  }

  return options
}

function requireCommit(label, sha) {
  if (!sha || sha === ZERO_SHA) {
    exitWithError(
      `Cannot determine a bounded incoming diff: ${label} SHA is missing or all zero. ` +
        'Refusing to fall back to an empty-tree or repository-wide check.'
    )
  }

  const result = run('git', ['cat-file', '-e', `${sha}^{commit}`], { stdio: 'ignore' })
  if (result.status !== 0) {
    exitWithError(
      `Cannot determine a bounded incoming diff: ${label} commit ${sha} is unavailable. ` +
        'Fetch the exact commit and retry.'
    )
  }
}

if (!existsSync(prettierBin)) {
  exitWithError('Prettier is not installed. Run `npm install` at the repository root first.')
}

const { base, head, mode } = parseArgs(process.argv.slice(2))

if (!VALID_MODES.has(mode)) {
  exitWithError('The diff mode must be either `direct` or `merge-base`.')
}

requireCommit('base', base)
requireCommit('head', head)

let diffBase = base
if (mode === 'merge-base') {
  const mergeBaseResult = run('git', ['merge-base', base, head])
  if (mergeBaseResult.status !== 0) {
    exitWithError(
      mergeBaseResult.stderr || `Could not compute a merge base for ${base} and ${head}.`,
      mergeBaseResult.status ?? 1
    )
  }
  diffBase = mergeBaseResult.stdout.trim()
}

const changedFilesResult = run(
  'git',
  [
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    '--find-renames',
    '--find-copies',
    '-z',
    diffBase,
    head,
    '--',
  ],
  { encoding: null }
)

if (changedFilesResult.status !== 0) {
  exitWithError(
    changedFilesResult.stderr?.toString() ||
      `Failed to read the incoming ${diffBase}..${head} diff.`,
    changedFilesResult.status ?? 1
  )
}

const filesToCheck = selectPrettierFiles(parseNullDelimitedPaths(changedFilesResult.stdout), {
  projectRoots: ciProjectRoots,
  rootFormatTargets: ciRootFormatTargets,
  yamlRoots: ciYamlRoots,
  excludedPaths: ciExcludedPaths,
})

if (filesToCheck.length === 0) {
  console.log(`No Prettier-eligible files in incoming range ${diffBase}..${head}.`)
  process.exit(0)
}

console.log(`Checking ${filesToCheck.length} incoming file(s) from ${diffBase}..${head}.`)

const prettierResult = spawnSync(prettierBin, ['--check', '--', ...filesToCheck], {
  cwd: repoRoot,
  stdio: 'inherit',
})

process.exit(prettierResult.status ?? 1)
