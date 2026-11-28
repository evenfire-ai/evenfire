/**
 * A repository can name an outside path through its alternates file, a link
 * inside .git, a gitdir file or core.worktree. The refusal must not depend on
 * whether that outside path exists: a different answer would tell a
 * card-free call whether an arbitrary host path exists.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { runPreflight } from '../preflight'
import { spawnGit } from '../runner'
import { type Fixture, gitw, makeFixture, makeRepo, params, requireGit } from './gitFixtures'

let fx: Fixture
let gitPath: string
let counter = 0
let existing: { dir: string; gitDir: string; objects: string }

beforeAll(() => {
  gitPath = requireGit()
  fx = makeFixture()
  const dir = path.join(fx.outside, 'present')
  makeRepo(dir, 'o.txt', 'o\n')
  existing = { dir, gitDir: path.join(dir, '.git'), objects: path.join(dir, '.git', 'objects') }
})

afterAll(() => fx?.cleanup())

const missing = (): string => path.join(fx.outside, `absent-${counter}`)

async function verdict(dir: string): Promise<string> {
  const result = await runPreflight({
    root: fx.root,
    verifyCallerRoot: false,
    gitPath,
    params: params({ subcommand: 'status', directory: dir }),
    timeoutMs: 10_000,
    spawn: spawnGit,
  })
  return result.kind === 'refused' ? result.category : result.kind
}

/** A fresh workspace repository; `plant` makes it name `target`. */
async function answerFor(plant: (repo: string, target: string) => void, target: string) {
  const dir = `o${++counter}`
  const repo = path.join(fx.root, dir)
  makeRepo(repo, 'a.txt', 'a\n')
  plant(repo, target)
  return verdict(dir)
}

const routes: Array<[string, (repo: string, target: string) => void, () => string, () => string]> =
  [
    [
      'an alternates entry',
      (repo, target) => {
        fs.mkdirSync(path.join(repo, '.git', 'objects', 'info'), { recursive: true })
        fs.writeFileSync(path.join(repo, '.git', 'objects', 'info', 'alternates'), `${target}\n`)
      },
      () => existing.objects,
      () => path.join(missing(), 'objects'),
    ],
    [
      'a link inside .git',
      (repo, target) => fs.symlinkSync(target, path.join(repo, '.git', 'probe')),
      () => existing.dir,
      missing,
    ],
    [
      'a gitdir file',
      (repo, target) => {
        fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true })
        fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${target}\n`)
      },
      () => existing.gitDir,
      () => path.join(missing(), '.git'),
    ],
    [
      'core.worktree',
      (repo, target) => gitw(repo, 'config', 'core.worktree', target),
      () => existing.dir,
      missing,
    ],
  ]

describe('git_read answers an outside path the same whether it exists or not', () => {
  it.each(routes)('%s', async (_label, plant, present, absent) => {
    const whenPresent = await answerFor(plant, present())
    const whenAbsent = await answerFor(plant, absent())
    expect(whenPresent).toBe('directory_outside_workspace')
    expect(whenAbsent).toBe(whenPresent)
  })

  it('a directory with no repository is still not a repository', async () => {
    fs.mkdirSync(path.join(fx.root, 'plain'))
    expect(await verdict('plain')).toBe('not_a_repository')
    expect(
      await verdict(
        await (async () => {
          const dir = `o${++counter}`
          makeRepo(path.join(fx.root, dir), 'a.txt', 'a\n')
          return dir
        })()
      )
    ).toBe('ok')
  })
})
