/**
 * P2–P4: discovery, the object store and the repository-link walk. Git
 * follows every file under `.git`, so a link (or a hard link) there can make
 * it read outside the workspace. Each row has a control: real git under
 * git_read's environment reading or echoing the outside bytes.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { GIT_READ_LINK_WALK_BUDGET, runPreflight, walkRepositoryLinks } from '../preflight'
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
let outsideObjects: string
let packedBlob: string
let packName: string
let looseBlob: string
let looseSource: string
let secretLine: string
let counter = 0

async function verdict(repoDir: string, subcommand = 'status'): Promise<string> {
  const result = await runPreflight({
    root: fx.root,
    verifyCallerRoot: false,
    gitPath,
    params: params({ subcommand, directory: path.relative(fx.root, repoDir) }),
    timeoutMs: 10_000,
    spawn: spawnGit,
  })
  return result.kind === 'refused' ? result.category : result.kind
}

function freshRepo(): string {
  const dir = path.join(fx.root, `r${++counter}`)
  makeRepo(dir, 'x', 'WITNESS\n')
  return dir
}

function catLeaks(repoDir: string, blob: string): boolean {
  return controlGit(fx.root, repoDir, 'cat-file', '-p', blob).out.includes('SECRET-OBJ')
}

function linkPack(storeDir: string): void {
  fs.mkdirSync(path.join(storeDir, 'pack'), { recursive: true })
  for (const ext of ['.pack', '.idx']) {
    const name = packName.replace('.pack', ext)
    fs.symlinkSync(path.join(outsideObjects, 'pack', name), path.join(storeDir, 'pack', name))
  }
}

function linkLoose(storeDir: string): void {
  const dir = path.join(storeDir, looseBlob.slice(0, 2))
  fs.mkdirSync(dir, { recursive: true })
  fs.symlinkSync(looseSource, path.join(dir, looseBlob.slice(2)))
}

beforeAll(() => {
  gitPath = requireGit()
  fx = makeFixture()
  const outsideRepo = path.join(fx.outside, 'packed')
  packedBlob = makeRepo(outsideRepo, 's', 'SECRET-OBJ packed\n')
  gitw(outsideRepo, 'gc', '-q')
  outsideObjects = fs.realpathSync(path.join(outsideRepo, '.git', 'objects'))
  packName = fs.readdirSync(path.join(outsideObjects, 'pack')).find(f => f.endsWith('.pack'))!
  const looseRepo = path.join(fx.outside, 'loose')
  looseBlob = makeRepo(looseRepo, 's', 'SECRET-OBJ loose\n')
  looseSource = path.join(looseRepo, '.git', 'objects', looseBlob.slice(0, 2), looseBlob.slice(2))
  secretLine = path.join(fx.outside, 'secret-line.txt')
  fs.writeFileSync(secretLine, 'SECRET-LINE-0123456789abcdef\n')
})

afterAll(() => fx?.cleanup())

describe('git_read repository links (P2–P4)', () => {
  it('a plain repository passes', async () => {
    expect(await verdict(freshRepo())).toBe('ok')
  })

  it('.git/objects linked outside is refused', async () => {
    const repo = freshRepo()
    fs.renameSync(path.join(repo, '.git', 'objects'), path.join(repo, '.git', 'objects.orig'))
    fs.symlinkSync(outsideObjects, path.join(repo, '.git', 'objects'))
    expect(catLeaks(repo, packedBlob)).toBe(true)
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('a pack linked outside is refused', async () => {
    const repo = freshRepo()
    linkPack(path.join(repo, '.git', 'objects'))
    expect(catLeaks(repo, packedBlob)).toBe(true)
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('a loose object linked outside is refused', async () => {
    const repo = freshRepo()
    linkLoose(path.join(repo, '.git', 'objects'))
    expect(catLeaks(repo, looseBlob)).toBe(true)
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('packed-refs linked to an outside file is refused', async () => {
    const repo = freshRepo()
    fs.symlinkSync(secretLine, path.join(repo, '.git', 'packed-refs'))
    expect(controlGit(fx.root, repo, 'for-each-ref').out).toContain('SECRET-LINE')
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('HEAD linked outside is refused as outside (git itself does not resolve it)', async () => {
    const repo = freshRepo()
    fs.rmSync(path.join(repo, '.git', 'HEAD'))
    fs.symlinkSync(secretLine, path.join(repo, '.git', 'HEAD'))
    expect(controlGit(fx.root, repo, 'status').status).not.toBe(0)
    // A repository git cannot resolve answers as one that resolves outside.
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('a link inside the root is accepted', async () => {
    const repo = freshRepo()
    fs.symlinkSync(path.join(repo, '.git', 'description'), path.join(repo, '.git', 'desc-link'))
    expect(await verdict(repo)).toBe('ok')
  })

  it('a link into protected state is refused', async () => {
    const repo = freshRepo()
    const state = path.join(fx.root, '.clerum-state')
    fs.mkdirSync(state, { recursive: true })
    fs.writeFileSync(path.join(state, 'tok.txt'), 'NEEDLE\n')
    fs.symlinkSync(path.join(state, 'tok.txt'), path.join(repo, '.git', 'state-link'))
    expect(await verdict(repo)).toBe('directory_protected')
  })

  it('a dangling link is refused', async () => {
    const repo = freshRepo()
    fs.symlinkSync(path.join(fx.root, 'nowhere'), path.join(repo, '.git', 'dangling'))
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('an inside alternate store whose pack links outside is refused', async () => {
    const repo = freshRepo()
    const store = path.join(fx.root, `store${counter}`, 'objects')
    fs.mkdirSync(store, { recursive: true })
    linkPack(store)
    fs.mkdirSync(path.join(repo, '.git', 'objects', 'info'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, '.git', 'objects', 'info', 'alternates'),
      `${fs.realpathSync(store)}\n`
    )
    expect(catLeaks(repo, packedBlob)).toBe(true)
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('an inside alternate store whose loose object links outside is refused', async () => {
    const repo = freshRepo()
    const store = path.join(fx.root, `store${counter}`, 'objects')
    fs.mkdirSync(store, { recursive: true })
    linkLoose(store)
    fs.mkdirSync(path.join(repo, '.git', 'objects', 'info'), { recursive: true })
    fs.writeFileSync(
      path.join(repo, '.git', 'objects', 'info', 'alternates'),
      `${fs.realpathSync(store)}\n`
    )
    expect(catLeaks(repo, looseBlob)).toBe(true)
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('objects linked to an inside directory holding an outside pack link is refused', async () => {
    const repo = freshRepo()
    const store = path.join(fx.root, `objstore${counter}`)
    fs.cpSync(path.join(repo, '.git', 'objects'), store, { recursive: true })
    linkPack(store)
    fs.rmSync(path.join(repo, '.git', 'objects'), { recursive: true })
    fs.symlinkSync(store, path.join(repo, '.git', 'objects'))
    expect(catLeaks(repo, packedBlob)).toBe(true)
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('objects/pack linked to an inside directory of outside links is refused', async () => {
    const repo = freshRepo()
    const packDir = path.join(fx.root, `packdir${counter}`)
    fs.mkdirSync(packDir)
    for (const ext of ['.pack', '.idx']) {
      const name = packName.replace('.pack', ext)
      fs.symlinkSync(path.join(outsideObjects, 'pack', name), path.join(packDir, name))
    }
    fs.rmSync(path.join(repo, '.git', 'objects', 'pack'), { recursive: true })
    fs.symlinkSync(packDir, path.join(repo, '.git', 'objects', 'pack'))
    expect(catLeaks(repo, packedBlob)).toBe(true)
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('a link cycle under .git is walked once', async () => {
    const repo = freshRepo()
    fs.symlinkSync(path.join(repo, '.git'), path.join(repo, '.git', 'loop'))
    expect(await verdict(repo)).toBe('ok')
  })

  it('a non-object file under .git with a second hard link is refused; a hard-linked loose object is not', async () => {
    const repo = freshRepo()
    const other = path.join(fx.outside, `config-copy${counter}`)
    fs.linkSync(path.join(repo, '.git', 'description'), other)
    expect(await verdict(repo)).toBe('directory_outside_workspace')
    fs.rmSync(other)

    const cloned = path.join(fx.root, `clone${counter}`)
    gitw(fx.root, 'clone', '-q', '--local', path.join(repo), cloned)
    const objectsDir = path.join(cloned, '.git', 'objects')
    const linked = fs
      .readdirSync(objectsDir, { recursive: true, withFileTypes: true })
      .filter(entry => entry.isFile())
      .some(entry => fs.statSync(path.join(entry.parentPath, entry.name)).nlink > 1)
    expect(linked).toBe(true)
    expect(await verdict(cloned)).toBe('ok')
  })

  it('a hard link outside an object store is refused wherever an objects segment appears', async () => {
    // A repository that lives under a directory named objects.
    const nested = path.join(fx.root, 'objects', `r${++counter}`)
    makeRepo(nested, 'x', 'WITNESS\n')
    fs.linkSync(secretLine, path.join(nested, '.git', 'packed-refs'))
    expect(controlGit(fx.root, nested, 'for-each-ref').out).toContain('SECRET-LINE')
    expect(await verdict(nested)).toBe('directory_outside_workspace')
    // A non-store directory named objects inside .git.
    const repo = freshRepo()
    fs.mkdirSync(path.join(repo, '.git', 'refs', 'objects'))
    fs.linkSync(secretLine, path.join(repo, '.git', 'refs', 'objects', 'leak'))
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('a planted submodule dir with a linked objects adds no store', async () => {
    const repo = freshRepo()
    fs.linkSync(secretLine, path.join(repo, '.git', 'packed-refs'))
    const fake = path.join(repo, '.git', 'modules', 'x')
    fs.mkdirSync(fake, { recursive: true })
    fs.writeFileSync(path.join(fake, 'HEAD'), 'ref: refs/heads/main\n')
    // objects -> .git: as a store it would exempt every file under .git.
    fs.symlinkSync('../..', path.join(fake, 'objects'))
    expect(controlGit(fx.root, repo, 'for-each-ref').out).toContain('SECRET-LINE')
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('a linked .git/modules is not scanned; the link walk judges it', async () => {
    const repo = freshRepo()
    fs.symlinkSync(fx.outside, path.join(repo, '.git', 'modules'))
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('a core.worktree elsewhere in the workspace is refused for a call from the repository directory', async () => {
    const repo = freshRepo()
    const inner = path.join(fx.root, `inner${counter}`)
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
    fs.mkdirSync(path.join(inner, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(repo, 'sub', 'a'), 'REPO-COPY-LINE\n')
    fs.writeFileSync(path.join(inner, 'sub', 'a'), 'INNER-COPY-LINE\n')
    gitw(repo, 'add', '-A')
    gitw(repo, 'commit', '-qm', 'sub')
    gitw(repo, 'config', 'core.worktree', inner)
    // Control: git reads the configured worktree, not the repository directory.
    expect(controlGit(fx.root, repo, 'grep', '-e', 'COPY-LINE').out).toContain('INNER-COPY-LINE')
    for (const subcommand of ['status', 'diff', 'ls_files', 'log']) {
      expect(await verdict(repo, subcommand)).toBe('not_a_repository')
    }
    // A submodule's own core.worktree is its toplevel: see the recursive clone row.
  })

  it('a recursive clone with submodules runs, in the superproject and inside the submodule', async () => {
    const child = freshRepo()
    const source = freshRepo()
    gitw(source, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', child, 'vendor/sub')
    gitw(source, 'commit', '-qm', 'sub')
    const clone = path.join(fx.root, `clone-rec${++counter}`)
    gitw(
      fx.root,
      '-c',
      'protocol.file.allow=always',
      'clone',
      '-q',
      '--recurse-submodules',
      source,
      clone
    )
    // The clone writes submodule.active, and the submodule's config core.worktree.
    expect(gitw(clone, 'config', '--local', '--get', 'submodule.active').trim()).toBe('.')
    expect(await verdict(clone)).toBe('ok')
    expect(await verdict(path.join(clone, 'vendor', 'sub'))).toBe('ok')
  })

  it('a submodule at a path named objects runs', async () => {
    const child = freshRepo()
    const parent = freshRepo()
    gitw(
      parent,
      '-c',
      'protocol.file.allow=always',
      'submodule',
      '-q',
      'add',
      child,
      'vendor/objects'
    )
    gitw(parent, 'commit', '-qm', 'sub')
    expect(await verdict(parent)).toBe('ok')
  })

  it('a link to a file with a second hard link is refused', async () => {
    const repo = freshRepo()
    const linked = path.join(fx.root, `notes-link${counter}.txt`)
    fs.linkSync(secretLine, linked)
    fs.symlinkSync(linked, path.join(repo, '.git', 'packed-refs'))
    expect(controlGit(fx.root, repo, 'for-each-ref').out).toContain('SECRET-LINE')
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('worktree_list refuses a recorded worktree outside the root or recorded relatively; other calls run', async () => {
    const repo = freshRepo()
    const head = gitw(repo, 'rev-parse', 'HEAD').trim()
    const plant = (name: string, gitdir: string): void => {
      const admin = path.join(repo, '.git', 'worktrees', name)
      fs.mkdirSync(admin, { recursive: true })
      fs.writeFileSync(path.join(admin, 'HEAD'), `${head}\n`)
      fs.writeFileSync(path.join(admin, 'commondir'), '../..\n')
      fs.writeFileSync(path.join(admin, 'gitdir'), `${gitdir}\n`)
    }
    plant('probe', path.join(fx.outside, 'probe-target', '.git'))
    // Control: git lists the outside path, marked prunable when it is missing.
    expect(controlGit(fx.root, repo, 'worktree', 'list').out).toContain(
      path.join(fx.outside, 'probe-target')
    )
    expect(await verdict(repo, 'worktree_list')).toBe('directory_outside_workspace')
    // Other calls never stat recorded worktrees: a sibling worktree is legitimate.
    expect(await verdict(repo, 'status')).toBe('ok')
    expect(await verdict(repo, 'log')).toBe('ok')

    const relative = freshRepo()
    const relHead = gitw(relative, 'rev-parse', 'HEAD').trim()
    const admin = path.join(relative, '.git', 'worktrees', 'rel')
    fs.mkdirSync(admin, { recursive: true })
    fs.writeFileSync(path.join(admin, 'HEAD'), `${relHead}\n`)
    fs.writeFileSync(path.join(admin, 'commondir'), '../..\n')
    fs.writeFileSync(path.join(admin, 'gitdir'), '../../../q/.git\n')
    expect(await verdict(relative, 'worktree_list')).toBe('directory_outside_workspace')

    const clean = freshRepo()
    gitw(clean, 'worktree', 'add', '-q', '--detach', path.join(fx.root, `wt${counter}`))
    expect(await verdict(clean, 'worktree_list')).toBe('ok')
  })

  it('a toplevel outside the root is refused by the toplevel check alone', async () => {
    const repo = freshRepo()
    const outsideTree = path.join(fx.outside, `tree${counter}`)
    fs.mkdirSync(outsideTree)
    fs.writeFileSync(path.join(outsideTree, 'outside-file.txt'), 'x\n')
    gitw(repo, 'config', 'core.worktree', outsideTree)
    expect(controlGit(fx.root, repo, 'status', '--porcelain').out).toContain('outside-file.txt')
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('a gitfile pointing outside is refused (commondir: p10)', async () => {
    const outsideRepo = path.join(fx.outside, `gitdir${counter}`)
    makeRepo(outsideRepo, 'x', 'OUT\n')
    const repo = path.join(fx.root, `gitfile${++counter}`)
    fs.mkdirSync(repo)
    fs.writeFileSync(path.join(repo, '.git'), `gitdir: ${path.join(outsideRepo, '.git')}\n`)
    expect(await verdict(repo)).toBe('directory_outside_workspace')
  })

  it('the link walk stops at its entry budget', async () => {
    const repo = freshRepo()
    const gitDir = fs.realpathSync(path.join(repo, '.git'))
    await expect(walkRepositoryLinks([gitDir], fx.root, [], { budget: 5 })).rejects.toMatchObject({
      category: 'repository_too_large',
    })
    await expect(
      walkRepositoryLinks([gitDir], fx.root, [], { budget: 200_000 })
    ).resolves.toBeUndefined()
    expect(GIT_READ_LINK_WALK_BUDGET).toBe(200_000)
  })

  it('the link walk yields to the event loop between directory reads', async () => {
    const repo = freshRepo()
    const gitDir = fs.realpathSync(path.join(repo, '.git'))
    for (let i = 0; i < 300; i++)
      fs.mkdirSync(path.join(gitDir, 'many', `d${i}`), { recursive: true })
    const order: string[] = []
    setImmediate(() => order.push('other work'))
    await walkRepositoryLinks([gitDir], fx.root, []).then(() => order.push('walk done'))
    // A synchronous walk finished before any other callback could run.
    expect(order).toEqual(['other work', 'walk done'])
    fs.rmSync(path.join(gitDir, 'many'), { recursive: true, force: true })
  })

  it('the link walk stops with timeout past its deadline', async () => {
    const repo = freshRepo()
    const gitDir = fs.realpathSync(path.join(repo, '.git'))
    await expect(
      walkRepositoryLinks([gitDir], fx.root, [], { deadline: Date.now() - 1 })
    ).rejects.toMatchObject({ category: 'timeout' })
    await expect(
      walkRepositoryLinks([gitDir], fx.root, [], { deadline: Date.now() + 60_000 })
    ).resolves.toBeUndefined()
  })

  it('a repository root configured through a symlink works', async () => {
    const linkedRoot = path.join(fx.base, 'ws-link')
    fs.symlinkSync(fx.root, linkedRoot)
    const repo = freshRepo()
    const result = await runPreflight({
      root: linkedRoot,
      verifyCallerRoot: false,
      gitPath,
      params: params({ subcommand: 'status', directory: path.relative(fx.root, repo) }),
      timeoutMs: 10_000,
      spawn: spawnGit,
    })
    expect(result).toMatchObject({ kind: 'ok', cwd: fs.realpathSync(repo) })
    expect(result.kind === 'ok' && result.env.GIT_CEILING_DIRECTORIES).toBe(fx.base)
  })

  it('a directory that does not exist, a file, or a protected directory is a bad path', async () => {
    const repo = freshRepo()
    const rel = path.relative(fx.root, repo)
    for (const directory of [`${rel}/missing`, `${rel}/x`]) {
      const result = await runPreflight({
        root: fx.root,
        verifyCallerRoot: false,
        gitPath,
        params: params({ subcommand: 'status', directory }),
        timeoutMs: 10_000,
        spawn: spawnGit,
      })
      expect(result).toEqual({ kind: 'refused', category: 'bad_path' })
    }
    const linkToState = path.join(fx.root, `state-dir-link${counter}`)
    fs.mkdirSync(path.join(fx.root, '.clerum-state'), { recursive: true })
    fs.symlinkSync(path.join(fx.root, '.clerum-state'), linkToState)
    const result = await runPreflight({
      root: fx.root,
      verifyCallerRoot: false,
      gitPath,
      params: params({ subcommand: 'status', directory: path.basename(linkToState) }),
      timeoutMs: 10_000,
      spawn: spawnGit,
    })
    expect(result).toEqual({ kind: 'refused', category: 'bad_path' })
  })

  it('a managed caller root that verifies runs git_read (the GFS Host path)', async () => {
    const callerRoot = path.join(fx.base, 'host', 'users', 'alice')
    fs.mkdirSync(callerRoot, { recursive: true })
    makeRepo(path.join(callerRoot, 'repo'), 'x', 'WITNESS\n')
    const result = await runPreflight({
      root: callerRoot,
      verifyCallerRoot: true,
      gitPath,
      params: params({ subcommand: 'status', directory: 'repo' }),
      timeoutMs: 10_000,
      spawn: spawnGit,
    })
    expect(result).toMatchObject({
      kind: 'ok',
      cwd: fs.realpathSync(path.join(callerRoot, 'repo')),
    })
  })

  it('blame of a tracked file missing from the worktree is path_missing', async () => {
    const repo = freshRepo()
    fs.rmSync(path.join(repo, 'x'))
    const result = await runPreflight({
      root: fx.root,
      verifyCallerRoot: false,
      gitPath,
      params: params({
        subcommand: 'blame',
        directory: path.relative(fx.root, repo),
        paths: ['x'],
      }),
      timeoutMs: 10_000,
      spawn: spawnGit,
    })
    expect(result).toEqual({ kind: 'refused', category: 'path_missing' })
  })

  it('a caller root that no longer verifies is root_unavailable', async () => {
    const result = await runPreflight({
      root: fx.root,
      verifyCallerRoot: true,
      gitPath,
      params: params({ subcommand: 'status' }),
      timeoutMs: 10_000,
      spawn: spawnGit,
    })
    expect(result).toEqual({ kind: 'refused', category: 'root_unavailable' })
  })
})
