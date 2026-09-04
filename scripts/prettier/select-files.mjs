import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const prettierBin = join(
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

const yamlExtensions = new Set(['.yaml', '.yml'])
const ignoredBasenames = new Set(['package-lock.json'])

export function exitWithError(message, status = 1) {
  console.error(message)
  process.exit(status)
}

export function run(command, args, options = {}) {
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

export function parseNullDelimitedPaths(output) {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : output
  return text.split('\0').filter(Boolean)
}

function isWithin(file, targets) {
  return targets.some(target => file === target || file.startsWith(`${target}/`))
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

export function selectPrettierFiles(
  candidates,
  { projectRoots, rootFormatTargets, yamlRoots = [], excludedPaths = [] }
) {
  const excluded = new Set(excludedPaths)

  return [
    ...new Set(
      candidates.filter(file => {
        const absolutePath = join(repoRoot, file)
        const extension = extname(absolutePath).toLowerCase()

        if (!existsSync(absolutePath) || excluded.has(file)) {
          return false
        }

        if (ignoredBasenames.has(basename(absolutePath))) {
          return false
        }

        if (!supportedExtensions.has(extension) || isGitIgnored(file)) {
          return false
        }

        return (
          isWithin(file, projectRoots) ||
          isWithin(file, rootFormatTargets) ||
          (yamlExtensions.has(extension) && isWithin(file, yamlRoots))
        )
      })
    ),
  ].sort()
}
