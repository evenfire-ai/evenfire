/**
 * Real-git fixtures for the git_read suites. Repositories are built with the
 * probed git and a writable identity; every "control" runs real git with
 * git_read's own literal environment (or the ordinary one), so a control that
 * leaks proves the attack works on this git before git_read refuses it.
 */
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { type GitReadParams, checkGitReadParams } from '../definition'
import { gitReadEnv } from '../env'
import { probeGitRead } from '../probe'

/** The probed git. Real-git suites fail, never skip, when it is unavailable. */
export function requireGit(): string {
  const probe = probeGitRead()
  if (!probe.available) throw new Error(`git_read probe unavailable: ${probe.reason}`)
  return probe.gitPath
}

export interface Fixture {
  /** The temp base; `root` and `outside` live under it. */
  base: string
  /** The workspace root (a realpath). */
  root: string
  /** A directory outside the root. */
  outside: string
  cleanup(): void
}

export function makeFixture(): Fixture {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-read-')))
  const root = path.join(base, 'ws')
  const outside = path.join(base, 'outside')
  fs.mkdirSync(root)
  fs.mkdirSync(outside)
  return { base, root, outside, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) }
}

const IDENTITY = [
  '-c',
  'user.email=fixture@example.invalid',
  '-c',
  'user.name=fixture',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
]

/** Fixture-building git: ordinary environment, fixed identity. */
export function gitw(cwd: string, ...args: string[]): string {
  const result = spawnSync(requireGit(), [...IDENTITY, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: '/usr/bin:/bin',
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
    },
  })
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

/** A repository with one committed file; returns that file's blob id. */
export function makeRepo(dir: string, file: string, content: string): string {
  fs.mkdirSync(dir, { recursive: true })
  gitw(dir, 'init', '-q')
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
  fs.writeFileSync(path.join(dir, file), content)
  gitw(dir, 'add', '-A')
  gitw(dir, 'commit', '-qm', 'c')
  return gitw(dir, 'rev-parse', `HEAD:${file}`).trim()
}

/** Real git under git_read's literal environment (the control for confinement rows). */
export function controlGit(
  root: string,
  cwd: string,
  ...args: string[]
): { status: number | null; out: string } {
  const result = spawnSync(requireGit(), args, {
    cwd,
    encoding: 'utf8',
    env: { ...gitReadEnv(path.dirname(fs.realpathSync(root))) },
  })
  return { status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

export function params(raw: Record<string, unknown>): GitReadParams {
  const check = checkGitReadParams(raw)
  if (!check.ok) throw new Error(`fixture params invalid: ${check.category}`)
  return check.params
}
