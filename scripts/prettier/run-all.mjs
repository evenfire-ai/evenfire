#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

if (!existsSync(prettierBin)) {
  console.error('Prettier is not installed. Run `npm install` at the repository root first.')
  process.exit(1)
}

const cliArgs = process.argv.slice(2)
const prettierArgs = cliArgs.length > 0 ? cliArgs : ['--write']
const targets = [...rootFormatTargets, ...projectRoots]

const result = spawnSync(prettierBin, [...prettierArgs, ...targets], {
  cwd: repoRoot,
  stdio: 'inherit',
})

process.exit(result.status ?? 1)
