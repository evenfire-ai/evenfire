/**
 * The call's git runs on the repository the preflight checked. Before, the
 * main command discovered the repository again from the call's directory, so
 * a `.git` that appeared between the checks and the command (written by a
 * concurrent tool, here at the spawn seam) sent git to a repository the
 * preflight never confined.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { GitReadTool } from '../gitReadTool'
import { type GitSpawn, spawnGit } from '../runner'
import { type Fixture, gitw, makeFixture, makeRepo, requireGit } from './gitFixtures'

let fx: Fixture
let gitPath: string

beforeAll(() => {
  gitPath = requireGit()
  fx = makeFixture()
  makeRepo(path.join(fx.root, 'a'), 'sub/f.txt', 'f\n')
  gitw(path.join(fx.root, 'a'), 'commit', '-q', '--allow-empty', '-m', 'INSIDE-SUBJECT')
  makeRepo(path.join(fx.outside, 'o'), 'o.txt', 'o\n')
  gitw(path.join(fx.outside, 'o'), 'commit', '-q', '--allow-empty', '-m', 'OUTSIDE-SUBJECT')
})

afterAll(() => fx?.cleanup())

describe('git_read runs the call on the checked repository', () => {
  it('a .git that appears after the checks is not used', async () => {
    const planted = path.join(fx.root, 'a', 'sub', '.git')
    let mainSpawns = 0
    const spawn: GitSpawn = (git, argv, options) => {
      // The main command: `log`, after the pinned prefix or (before) bare.
      if (argv.includes('--oneline')) {
        mainSpawns++
        fs.writeFileSync(planted, `gitdir: ${path.join(fx.outside, 'o', '.git')}\n`)
      }
      return spawnGit(git, argv, options)
    }
    const tool = new GitReadTool({
      root: fx.root,
      gitPath,
      timeoutMs: 20_000,
      verifyCallerRoot: false,
      spawn,
    })
    try {
      const out = await tool.execute({
        directory: 'a/sub',
        subcommand: 'log',
        options: ['oneline'],
      })
      expect(mainSpawns).toBe(1)
      expect(out.is_error).toBe(false)
      expect(out.content).toContain('INSIDE-SUBJECT')
      expect(out.content).not.toContain('OUTSIDE-SUBJECT')
    } finally {
      fs.rmSync(planted, { force: true })
    }
  })
})
