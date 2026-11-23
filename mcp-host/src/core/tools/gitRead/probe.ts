import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { logger } from '../../../logger'
import { gitReadEnv } from './env'

export type GitVersion = readonly [number, number, number]

export type GitReadAvailability =
  | { available: true; gitPath: string; version: GitVersion }
  | { available: false; reason: 'absent' | 'unsafe_owner' | 'too_old' | 'probe_failed' }

/** The oldest git `git_read` runs with: `--end-of-options` on every subcommand it uses. */
export const GIT_READ_MIN_VERSION: GitVersion = [2, 38, 0]

/** Only these locations count. Git elsewhere (for example `/usr/local/bin`) is absent. */
export const GIT_READ_CANDIDATES: readonly string[] = ['/usr/bin/git', '/bin/git']

const PROBE_TIMEOUT_MS = 3000

/** Parses `git version X.Y.Z…`; anything else is null. */
export function parseGitVersion(banner: string): GitVersion | null {
  const match = /^git version (\d+)\.(\d+)\.(\d+)/.exec(banner)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function atLeast(version: GitVersion, floor: GitVersion): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i] !== floor[i]) return version[i] > floor[i]
  }
  return true
}

export interface GitProbeDeps {
  exists(file: string): boolean
  realpath(file: string): string
  stat(file: string): { uid: number; mode: number }
  version(gitPath: string): string
}

const realDeps: GitProbeDeps = {
  exists: file => fs.existsSync(file),
  realpath: file => fs.realpathSync(file),
  stat: file => fs.statSync(file),
  version: gitPath =>
    execFileSync(gitPath, ['--version'], {
      cwd: '/',
      env: gitReadEnv(''),
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }),
}

/** Owned by root and not writable by group or others. */
function safelyOwned(stat: { uid: number; mode: number }): boolean {
  return stat.uid === 0 && (stat.mode & 0o022) === 0
}

/**
 * Finds a git binary `git_read` may run. Fails closed: git outside the
 * candidate paths, a binary or directory another user can replace, a version
 * below the floor, or any probe error makes `git_read` unavailable.
 */
export function probeGitReadWith(deps: GitProbeDeps): GitReadAvailability {
  const candidate = GIT_READ_CANDIDATES.find(file => deps.exists(file))
  if (candidate === undefined) return { available: false, reason: 'absent' }
  let realGit: string
  try {
    realGit = deps.realpath(candidate)
    if (!safelyOwned(deps.stat(realGit)) || !safelyOwned(deps.stat(path.dirname(realGit)))) {
      return { available: false, reason: 'unsafe_owner' }
    }
  } catch (error) {
    logger.warn(
      { event: 'git_read_probe_error', step: 'owner', code: (error as NodeJS.ErrnoException).code },
      'git_read probe could not check the git binary'
    )
    return { available: false, reason: 'probe_failed' }
  }
  let version: GitVersion | null
  try {
    version = parseGitVersion(deps.version(realGit))
  } catch (error) {
    logger.warn(
      {
        event: 'git_read_probe_error',
        step: 'version',
        code: (error as NodeJS.ErrnoException).code,
      },
      'git_read probe could not run git --version'
    )
    return { available: false, reason: 'probe_failed' }
  }
  if (version === null) return { available: false, reason: 'probe_failed' }
  if (!atLeast(version, GIT_READ_MIN_VERSION)) return { available: false, reason: 'too_old' }
  return { available: true, gitPath: realGit, version }
}

let memo: GitReadAvailability | undefined

/**
 * The process-wide probe: one synchronous spawn, at most 3 s, then memoised so
 * the tool list never changes between tasks. `deps` is a test seam.
 */
export function probeGitRead(deps: GitProbeDeps = realDeps): GitReadAvailability {
  if (memo === undefined) {
    memo = probeGitReadWith(deps)
    logger.info(
      memo.available
        ? { event: 'git_read_probe', available: true, version: memo.version.join('.') }
        : { event: 'git_read_probe', available: false, reason: memo.reason },
      'git_read probe'
    )
  }
  return memo
}

/** Test seam: forget the memoised probe. */
export function __resetGitProbeForTest(): void {
  memo = undefined
}
