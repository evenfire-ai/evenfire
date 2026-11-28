/**
 * A hand-written `.git/index` whose names leave the worktree. Git's own
 * tools refuse such names, but the index is a file in the workspace, and git
 * opens worktree files by index name: a worktree grep, diff or status would
 * read (or stat and hash) the named outside file. Each row has a raw-git
 * control under git_read's environment that reads it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { GIT_READ_REFUSALS, GitReadTool } from '../gitReadTool'
import { type Fixture, controlGit, gitw, makeFixture, makeRepo, requireGit } from './gitFixtures'

/** Writes a v2 SHA-1 index with zeroed stat data and the given entries. */
function writeIndex(file: string, entries: Array<{ name: string; oid: string }>): void {
  const sorted = [...entries].sort((a, b) =>
    Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))
  )
  const header = Buffer.alloc(12)
  header.write('DIRC', 0)
  header.writeUInt32BE(2, 4)
  header.writeUInt32BE(sorted.length, 8)
  const parts: Buffer[] = [header]
  for (const entry of sorted) {
    const name = Buffer.from(entry.name)
    const fixed = Buffer.alloc(62)
    fixed.writeUInt32BE(0o100644, 24)
    Buffer.from(entry.oid, 'hex').copy(fixed, 40)
    fixed.writeUInt16BE(Math.min(name.length, 0xfff), 60)
    parts.push(fixed, name, Buffer.alloc(8 - ((62 + name.length) % 8)))
  }
  const body = Buffer.concat(parts)
  fs.writeFileSync(file, Buffer.concat([body, createHash('sha1').update(body).digest()]))
}

let fx: Fixture
let tool: GitReadTool
let counter = 0

beforeAll(() => {
  const gitPath = requireGit()
  fx = makeFixture()
  fs.writeFileSync(path.join(fx.outside, 'secret.txt'), 'OUTSIDE-SECRET-LINE\n')
  tool = new GitReadTool({ root: fx.root, gitPath, timeoutMs: 20_000, verifyCallerRoot: false })
})

afterAll(() => fx?.cleanup())

/** A repository whose index also names `name`, pointing at a placeholder blob. */
function plantedRepo(name: () => string): { repo: string; dir: string } {
  const dir = `idx${++counter}`
  const repo = path.join(fx.root, dir)
  const a = makeRepo(repo, 'a.txt', 'a\n')
  const dummy = gitw(repo, 'hash-object', '-w', '--stdin').trim()
  writeIndex(path.join(repo, '.git', 'index'), [
    { name: 'a.txt', oid: a },
    { name: name(), oid: dummy || a },
  ])
  return { repo, dir }
}

async function call(dir: string, params: Record<string, unknown>) {
  const out = await tool.execute({ directory: dir, ...params })
  return { content: out.content, is_error: out.is_error }
}

const refused = (): { content: string; is_error: boolean } => ({
  content: GIT_READ_REFUSALS.index_path_unsafe,
  is_error: true,
})

describe('git_read refuses an index that names paths outside the worktree', () => {
  it.each([
    ['a parent-relative name', () => '../../outside/secret.txt'],
    ['an absolute name', () => path.join(fx.outside, 'secret.txt')],
  ])('%s: worktree grep, diff and status are refused', async (_label, nameOf) => {
    const { repo, dir } = plantedRepo(() => nameOf())
    // Control: git greps the outside file through the index name.
    expect(
      controlGit(fx.root, repo, 'grep', '--no-textconv', '-e', 'OUTSIDE-SECRET').out
    ).toContain('OUTSIDE-SECRET-LINE')
    for (const params of [
      { subcommand: 'grep', pattern: 'OUTSIDE-SECRET' },
      { subcommand: 'diff' },
      { subcommand: 'diff', revisions: ['HEAD'] },
      { subcommand: 'status' },
    ]) {
      expect(await call(dir, params)).toEqual(refused())
    }
    // Object-only reads are unaffected.
    expect(
      (await call(dir, { subcommand: 'grep', pattern: 'a', revisions: ['HEAD'] })).is_error
    ).toBe(false)
    expect((await call(dir, { subcommand: 'diff', options: ['cached'] })).is_error).toBe(false)
  })

  it('a name with a .. segment inside the worktree is refused too', async () => {
    const { repo, dir } = plantedRepo(() => 'pub/../a.txt')
    expect(controlGit(fx.root, repo, 'status', '--porcelain').out).toContain('pub/../a.txt')
    expect(await call(dir, { subcommand: 'grep', pattern: 'a' })).toEqual(refused())
  })

  it('an ordinary repository runs status, diff and grep', async () => {
    const dir = `idx${++counter}`
    makeRepo(path.join(fx.root, dir), 'a.txt', 'a\n')
    for (const params of [
      { subcommand: 'status' },
      { subcommand: 'diff' },
      { subcommand: 'grep', pattern: 'a' },
    ]) {
      expect((await call(dir, params)).is_error).toBe(false)
    }
  })
})
