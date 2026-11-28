/**
 * How a git process ends, and what git_read returns for each ending. The
 * runner is exercised with real child processes (not git: the endings are
 * the point); the tool rows stub only the main command's spawn.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as path from 'path'
import { GIT_READ_FAILED_TEXT, GIT_READ_REFUSALS, GitReadTool } from '../gitReadTool'
import { type GitSpawn, type GitSpawnResult, spawnGit } from '../runner'
import { type Fixture, makeFixture, makeRepo, requireGit } from './gitFixtures'

const env = { PATH: '/usr/bin:/bin' }

describe('spawnGit outcomes', () => {
  it('a child killed at the timeout is a timeout', async () => {
    const result = await spawnGit('/bin/sleep', ['5'], {
      cwd: '/',
      env,
      timeoutMs: 100,
      maxBuffer: 1024,
    })
    expect(result.outcome).toBe('timeout')
  })

  it('a child that dies from a signal it did not get from us has failed, not timed out', async () => {
    const result = await spawnGit('/bin/sh', ['-c', 'kill -SEGV $$'], {
      cwd: '/',
      env,
      timeoutMs: 10_000,
      maxBuffer: 1024,
    })
    expect(result.outcome).toBe('failed')
  })

  it('stdout past the buffer is an overflow; stderr past it has failed', async () => {
    const out = await spawnGit('/bin/sh', ['-c', 'head -c 300000 /dev/zero | tr "\\0" x'], {
      cwd: '/',
      env,
      timeoutMs: 10_000,
      maxBuffer: 1024,
    })
    expect(out.outcome).toBe('overflow')
    expect(out.stdout.length).toBeGreaterThan(0)
    const err = await spawnGit(
      '/bin/sh',
      ['-c', 'head -c 300000 /dev/zero | tr "\\0" x >&2; echo ok'],
      {
        cwd: '/',
        env,
        timeoutMs: 10_000,
        maxBuffer: 1024,
      }
    )
    expect(err.outcome).toBe('failed')
  })

  it('an argument list the OS refuses (E2BIG) could not start; it never throws', async () => {
    const result = await spawnGit('/bin/echo', ['x'.repeat(4 * 1024 * 1024)], {
      cwd: '/',
      env,
      timeoutMs: 10_000,
      maxBuffer: 1024,
    })
    expect(result.outcome).toBe('error')
  })

  it('an exit code is reported, and a missing binary could not start', async () => {
    expect(
      await spawnGit('/bin/sh', ['-c', 'exit 3'], {
        cwd: '/',
        env,
        timeoutMs: 10_000,
        maxBuffer: 1024,
      })
    ).toMatchObject({ outcome: 'exited', exitCode: 3 })
    expect(
      (
        await spawnGit('/nonexistent/git', [], {
          cwd: '/',
          env,
          timeoutMs: 10_000,
          maxBuffer: 1024,
        })
      ).outcome
    ).toBe('error')
  })
})

describe('git_read results for each ending of the main command', () => {
  let fx: Fixture
  let gitPath: string
  beforeAll(() => {
    gitPath = requireGit()
    fx = makeFixture()
    makeRepo(path.join(fx.root, 'repo'), 'a.txt', 'one\n')
  })
  afterAll(() => fx?.cleanup())

  async function endingWith(
    outcome: GitSpawnResult['outcome']
  ): Promise<{ content: string; is_error: boolean }> {
    // The main command runs after the --git-dir/--work-tree the preflight checked.
    const spawn: GitSpawn = (git, argv, options) =>
      argv[2] === 'log' && argv[0].startsWith('--git-dir=')
        ? Promise.resolve({ exitCode: null, stdout: 'partial\n', stderr: '', outcome })
        : spawnGit(git, argv, options)
    const tool = new GitReadTool({
      root: fx.root,
      gitPath,
      timeoutMs: 10_000,
      verifyCallerRoot: false,
      spawn,
    })
    const out = await tool.execute({ directory: 'repo', subcommand: 'log', options: ['oneline'] })
    return { content: out.content, is_error: out.is_error }
  }

  it('a timeout returns the fixed refusal text', async () => {
    expect(await endingWith('timeout')).toEqual({
      content: GIT_READ_REFUSALS.timeout,
      is_error: true,
    })
  })

  it('an abnormal end is an error, not a timeout or a result', async () => {
    expect(await endingWith('failed')).toEqual({ content: GIT_READ_FAILED_TEXT, is_error: true })
  })

  it('git that could not start is an error', async () => {
    expect(await endingWith('error')).toEqual({
      content: 'git_read could not start git.',
      is_error: true,
    })
  })

  it('a stopped call is an error', async () => {
    expect(await endingWith('aborted')).toEqual({
      content: 'git_read was stopped.',
      is_error: true,
    })
  })

  it('an overflow keeps what was read and says it was cut', async () => {
    expect(await endingWith('overflow')).toEqual({
      content: 'partial\n[output truncated]',
      is_error: false,
    })
  })
})
