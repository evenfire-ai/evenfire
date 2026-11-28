/**
 * Confinement judges the path the kernel opens. Node's `fs.realpathSync`
 * collapses `..` in the text before it follows links, so with
 * `p/q/lnk -> ../..`, `<root>/p/q/lnk/../x` was judged as `<root>/p/q/x` (a
 * decoy inside the root), while git, through open(2), reaches `x` beside the
 * root. Each row has a raw-git control under git_read's own environment that
 * reads the outside repository through the same path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { GIT_READ_REFUSALS, GitReadTool } from '../gitReadTool'
import { runPreflight } from '../preflight'
import { spawnGit } from '../runner'
import {
  type Fixture,
  controlGit,
  gitw,
  makeFixture,
  makeRepo,
  params,
  requireGit,
} from './gitFixtures'

let fx: Fixture
let gitPath: string
let tool: GitReadTool
let outsideCommit: string
let outsideBlob: string
let counter = 0

const OUTSIDE = GIT_READ_REFUSALS.directory_outside_workspace

beforeAll(() => {
  gitPath = requireGit()
  fx = makeFixture()
  // The outside repository, packed so a replaced objects/pack can reach it.
  const outsideRepo = path.join(fx.base, 'x')
  outsideBlob = makeRepo(outsideRepo, 'secret.txt', 'OUTSIDE-SECRET-LINE\n')
  outsideCommit = gitw(outsideRepo, 'rev-parse', 'HEAD').trim()
  gitw(outsideRepo, 'repack', '-a', '-d', '-q')
  // p/q/lnk -> ../.. is the workspace root, so p/q/lnk/.. is the root's parent.
  fs.mkdirSync(path.join(fx.root, 'p', 'q'), { recursive: true })
  fs.symlinkSync('../..', path.join(fx.root, 'p', 'q', 'lnk'))
  tool = new GitReadTool({ root: fx.root, gitPath, timeoutMs: 20_000, verifyCallerRoot: false })
})

afterAll(() => fx?.cleanup())

/** A workspace repository; returns its directory name and its objects dir. */
function repo(): { dir: string; repoPath: string; objects: string } {
  const dir = `k${++counter}`
  const repoPath = path.join(fx.root, dir)
  makeRepo(repoPath, 'a.txt', 'a\n')
  return { dir, repoPath, objects: path.join(repoPath, '.git', 'objects') }
}

/** The text-resolved twin of a path: an empty directory inside the root. */
function decoy(textResolved: string): void {
  fs.mkdirSync(textResolved, { recursive: true })
}

const leaks = (repoPath: string): boolean =>
  controlGit(fx.root, repoPath, 'cat-file', '-p', outsideBlob).out.includes('OUTSIDE-SECRET-LINE')

async function names(dir: string) {
  const out = await tool.execute({
    directory: dir,
    subcommand: 'rev_parse',
    revisions: [outsideCommit],
  })
  return { content: out.content, is_error: out.is_error }
}

describe('git_read confines on the path the kernel opens', () => {
  it('an absolute alternates entry through a workspace link and .. is refused', async () => {
    const { dir, repoPath, objects } = repo()
    decoy(path.join(fx.root, 'p', 'q', 'x', '.git', 'objects'))
    fs.mkdirSync(path.join(objects, 'info'), { recursive: true })
    fs.writeFileSync(
      path.join(objects, 'info', 'alternates'),
      `${fx.root}/p/q/lnk/../x/.git/objects\n`
    )
    expect(leaks(repoPath)).toBe(true)
    expect(await names(dir)).toEqual({ content: OUTSIDE, is_error: true })
  })

  it('a relative alternates entry through a link inside objects/ and .. is refused', async () => {
    const { dir, repoPath, objects } = repo()
    // objects/lnk -> the root, a target the link walk accepts.
    fs.symlinkSync(fx.root, path.join(objects, 'lnk'))
    decoy(path.join(objects, 'x', '.git', 'objects'))
    fs.mkdirSync(path.join(objects, 'info'), { recursive: true })
    fs.writeFileSync(path.join(objects, 'info', 'alternates'), 'lnk/../x/.git/objects\n')
    expect(leaks(repoPath)).toBe(true)
    expect(await names(dir)).toEqual({ content: OUTSIDE, is_error: true })
  })

  it('objects/pack replaced by a link whose target holds lnk/.. is refused', async () => {
    const { dir, repoPath, objects } = repo()
    decoy(path.join(fx.root, 'p', 'q', 'x', '.git', 'objects', 'pack'))
    fs.rmSync(path.join(objects, 'pack'), { recursive: true, force: true })
    fs.symlinkSync(`${fx.root}/p/q/lnk/../x/.git/objects/pack`, path.join(objects, 'pack'))
    expect(leaks(repoPath)).toBe(true)
    const show = await tool.execute({
      directory: dir,
      subcommand: 'show',
      revisions: [outsideCommit],
    })
    expect({ content: show.content, is_error: show.is_error }).toEqual({
      content: OUTSIDE,
      is_error: true,
    })
    expect(await names(dir)).toEqual({ content: OUTSIDE, is_error: true })
  })

  it('a directory reached through a link and .. is confined after it is resolved', async () => {
    // dirlink -> p/q/lnk/../x: the text says <root>/p/q/x, the kernel says the outside repo.
    decoy(path.join(fx.root, 'p', 'q', 'x'))
    fs.symlinkSync('p/q/lnk/../x', path.join(fx.root, 'dirlink'))
    expect(
      controlGit(fx.root, path.join(fx.root, 'dirlink'), 'cat-file', '-p', outsideBlob).out
    ).toContain('OUTSIDE-SECRET-LINE')
    const cwds: string[] = []
    const result = await runPreflight({
      root: fx.root,
      verifyCallerRoot: false,
      gitPath,
      params: params({ subcommand: 'status', directory: 'dirlink' }),
      timeoutMs: 10_000,
      spawn: (file, args, options) => {
        cwds.push(options.cwd)
        return spawnGit(file, args, options)
      },
    })
    expect(result).toEqual({ kind: 'refused', category: 'directory_outside_workspace' })
    // No git process starts in the outside directory, not even for discovery.
    expect(cwds).toEqual([])
    // Witness: the same spy records the cwd of an ordinary call.
    const { dir } = repo()
    await runPreflight({
      root: fx.root,
      verifyCallerRoot: false,
      gitPath,
      params: params({ subcommand: 'status', directory: dir }),
      timeoutMs: 10_000,
      spawn: (file, args, options) => {
        cwds.push(options.cwd)
        return spawnGit(file, args, options)
      },
    })
    expect(cwds.length).toBeGreaterThan(0)
    expect(cwds.every(cwd => cwd === path.join(fx.root, dir))).toBe(true)
  })

  it('a recorded worktree path that is not normalized is refused for worktree_list', async () => {
    const { dir, repoPath } = repo()
    const admin = path.join(repoPath, '.git', 'worktrees', 'probe')
    fs.mkdirSync(admin, { recursive: true })
    fs.writeFileSync(path.join(admin, 'gitdir'), `${fx.root}/p/q/lnk/../missing/.git\n`)
    fs.writeFileSync(path.join(admin, 'HEAD'), `${outsideCommit}\n`)
    const out = await tool.execute({ directory: dir, subcommand: 'worktree_list' })
    expect({ content: out.content, is_error: out.is_error }).toEqual({
      content: OUTSIDE,
      is_error: true,
    })
  })

  it('an ordinary repository with a link inside the workspace still runs', async () => {
    const { dir, objects } = repo()
    const inside = repo()
    fs.mkdirSync(path.join(objects, 'info'), { recursive: true })
    fs.writeFileSync(path.join(objects, 'info', 'alternates'), `${inside.objects}\n`)
    const out = await tool.execute({ directory: dir, subcommand: 'status' })
    expect(out.is_error).toBe(false)
  })
})
