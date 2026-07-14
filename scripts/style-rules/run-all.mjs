#!/usr/bin/env node
/**
 * Manual / CI entry: run style-rules across the full repo tree (all files
 * the rules in rules.mjs claim to cover via `applies()`).
 *
 * Currently scoped to desktop-app/ui — extend rules.mjs to add coverage
 * for control-ui / profile-ui when their patterns consolidate.
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { checkFiles, reportAndExitCode } from './check.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const failOnWarn = process.argv.includes('--strict')

const ls = spawnSync('git', ['ls-files'], {
  cwd: repoRoot,
  encoding: 'utf8',
})

if (ls.status !== 0) {
  process.stderr.write(ls.stderr || 'Failed to list git files.\n')
  process.exit(ls.status ?? 1)
}

const files = ls.stdout
  .split(/\r?\n/)
  .map(f => f.trim())
  .filter(Boolean)

const result = checkFiles(files)
process.exit(reportAndExitCode(result, { failOnWarn }))
