/**
 * `git_read remote` is a names-only call (no card in auto), and git prints
 * the configured URLs, credentials included. git_read replaces the userinfo
 * of every URL it prints for `remote`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as path from 'path'
import { GitReadTool, withoutUrlCredentials } from '../gitReadTool'
import { type Fixture, controlGit, gitw, makeFixture, makeRepo, requireGit } from './gitFixtures'

const SECRET = 'fixture-remote-token-7f'

let fx: Fixture
let tool: GitReadTool

beforeAll(() => {
  const gitPath = requireGit()
  fx = makeFixture()
  const repo = path.join(fx.root, 'r')
  makeRepo(repo, 'a.txt', 'a\n')
  gitw(repo, 'remote', 'add', 'origin', `https://deploy:${SECRET}@git.example.invalid/o/r.git`)
  gitw(repo, 'remote', 'add', 'token', `https://${SECRET}@git.example.invalid/o/t.git`)
  gitw(repo, 'remote', 'add', 'at', `https://user@corp:${SECRET}@git.example.invalid/o/a.git`)
  gitw(repo, 'remote', 'add', 'scp', 'git@git.example.invalid:o/s.git')
  tool = new GitReadTool({ root: fx.root, gitPath, timeoutMs: 20_000, verifyCallerRoot: false })
})

afterAll(() => fx?.cleanup())

describe('git_read remote strips URL credentials', () => {
  it('remote -v lists every remote with its userinfo replaced', async () => {
    // Control: git itself prints the credential.
    expect(controlGit(fx.root, path.join(fx.root, 'r'), 'remote', '-v').out).toContain(SECRET)
    const out = await tool.execute({ directory: 'r', subcommand: 'remote' })
    expect(out.is_error).toBe(false)
    expect(out.content).not.toContain(SECRET)
    expect(out.content.split('\n').filter(Boolean).sort()).toEqual(
      [
        'at\thttps://***@git.example.invalid/o/a.git (fetch)',
        'at\thttps://***@git.example.invalid/o/a.git (push)',
        'origin\thttps://***@git.example.invalid/o/r.git (fetch)',
        'origin\thttps://***@git.example.invalid/o/r.git (push)',
        'scp\tgit@git.example.invalid:o/s.git (fetch)',
        'scp\tgit@git.example.invalid:o/s.git (push)',
        'token\thttps://***@git.example.invalid/o/t.git (fetch)',
        'token\thttps://***@git.example.invalid/o/t.git (push)',
      ].sort()
    )
  })

  it('remote get_url strips it too', async () => {
    for (const [name, expected] of [
      ['origin', 'https://***@git.example.invalid/o/r.git\n'],
      ['at', 'https://***@git.example.invalid/o/a.git\n'],
      ['scp', 'git@git.example.invalid:o/s.git\n'],
    ] as const) {
      const out = await tool.execute({
        directory: 'r',
        subcommand: 'remote',
        options: ['get_url'],
        revisions: [name],
      })
      expect({ content: out.content, is_error: out.is_error }).toEqual({
        content: expected,
        is_error: false,
      })
    }
  })

  it('withoutUrlCredentials leaves a URL with no userinfo unchanged', () => {
    for (const text of [
      'https://git.example.invalid/o/r.git',
      'file:///srv/r.git',
      'plain text @ here',
    ]) {
      expect(withoutUrlCredentials(text)).toBe(text)
    }
    expect(withoutUrlCredentials('ssh://git@h/r https://a:b@h/r')).toBe(
      'ssh://***@h/r https://***@h/r'
    )
  })
})
