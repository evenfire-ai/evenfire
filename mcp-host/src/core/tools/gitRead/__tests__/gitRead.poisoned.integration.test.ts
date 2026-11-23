/**
 * P1-T2: the poisoned-repository matrix. Each row plants a payload that
 * touches a marker file when git runs a program from repository state. The
 * control runs real git the way a shell does today (`/bin/sh -c`, HOME = the
 * workspace, no forced keys) and must fire; git_read must refuse the
 * repository or run without firing. Ablations show which layer stops a row.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { buildGitReadArgv } from '../argv'
import { gitReadEnv } from '../env'
import { GIT_READ_REFUSALS, GitReadTool } from '../gitReadTool'
import { type Fixture, gitw, makeFixture, params, requireGit } from './gitFixtures'

let fx: Fixture
let gitPath: string
let tool: GitReadTool
let markers: string
let counter = 0

beforeAll(() => {
  gitPath = requireGit()
  fx = makeFixture()
  markers = path.join(fx.outside, 'markers')
  fs.mkdirSync(markers)
  tool = new GitReadTool({ root: fx.root, gitPath, timeoutMs: 30_000, verifyCallerRoot: false })
})

afterAll(() => fx?.cleanup())

afterEach(() => {
  for (const marker of fs.readdirSync(markers)) fs.rmSync(path.join(markers, marker))
})

function marker(id: string): string {
  return path.join(markers, id)
}

function fired(id: string): boolean {
  const did = fs.existsSync(marker(id))
  fs.rmSync(marker(id), { force: true })
  return did
}

function touch(id: string): string {
  return `touch ${marker(id)}`
}

/** A repository with a committed `a.txt` (and `b.bin`) and a modified `a.txt`. */
function newRepo(): string {
  const dir = path.join(fx.root, `p${++counter}`)
  fs.mkdirSync(dir)
  gitw(dir, 'init', '-q')
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n')
  fs.writeFileSync(path.join(dir, 'b.bin'), 'bin\n')
  gitw(dir, 'add', '-A')
  gitw(dir, 'commit', '-qm', 'init')
  fs.appendFileSync(path.join(dir, 'a.txt'), 'two\n')
  return dir
}

function appendConfig(dir: string, text: string, file = path.join(dir, '.git', 'config')): void {
  fs.appendFileSync(file, text)
}

/** Today's shell: `/bin/sh -c`, HOME = the workspace, no forced keys. */
function control(dir: string, command: string, extraEnv: Record<string, string> = {}): void {
  spawnSync('/bin/sh', ['-c', command], {
    cwd: dir,
    env: {
      PATH: `${path.dirname(gitPath)}:/usr/bin:/bin`,
      HOME: fx.root,
      GIT_CONFIG_NOSYSTEM: '1',
      LANG: 'C',
      ...extraEnv,
    },
    stdio: 'ignore',
  })
}

/** git_read's argv and environment, without the preflight (ablation). */
function withoutPreflight(
  dir: string,
  raw: Record<string, unknown>,
  transform = (a: string[]) => a
): void {
  const argv = transform(buildGitReadArgv(params(raw)))
  spawnSync(gitPath, argv, {
    cwd: dir,
    env: { ...gitReadEnv(path.dirname(fx.root)) },
    stdio: 'ignore',
  })
}

async function gitRead(
  dir: string,
  raw: Record<string, unknown>
): Promise<{ content: string; is_error: boolean }> {
  const out = await tool.execute({ directory: path.relative(fx.root, dir), ...raw })
  return { content: out.content, is_error: out.is_error }
}

const RUNS_PROGRAMS = { content: GIT_READ_REFUSALS.config_runs_programs, is_error: true }

describe('git_read poisoned repositories', () => {
  it('p01 core.fsmonitor: runs, no fire', async () => {
    const dir = newRepo()
    appendConfig(dir, `[core]\n\tfsmonitor = "${touch('p01')}; false"\n`)
    control(dir, 'git status')
    expect(fired('p01')).toBe(true)
    for (const raw of [
      { subcommand: 'status' },
      { subcommand: 'diff' },
      { subcommand: 'log', max_count: 3 },
      { subcommand: 'ls_files' },
      { subcommand: 'blame', paths: ['a.txt'] },
      { subcommand: 'grep', pattern: 'one' },
      { subcommand: 'describe', options: ['always'] },
    ]) {
      expect((await gitRead(dir, raw)).is_error).toBe(false)
      expect(fired('p01')).toBe(false)
    }
  })

  it('p02 diff.external: refused', async () => {
    const dir = newRepo()
    appendConfig(dir, `[diff]\n\texternal = "${touch('p02')}; true"\n`)
    control(dir, 'git diff')
    expect(fired('p02')).toBe(true)
    expect(await gitRead(dir, { subcommand: 'diff' })).toEqual(RUNS_PROGRAMS)
    expect(fired('p02')).toBe(false)
  })

  it('p03 named textconv: refused; without the preflight --no-textconv still stops it', async () => {
    const dir = newRepo()
    // A second commit, so every log option has a non-root diff to show.
    gitw(dir, 'commit', '-qam', 'two')
    fs.appendFileSync(path.join(dir, 'a.txt'), 'three\n')
    appendConfig(dir, `[diff "x"]\n\ttextconv = "${touch('p03')}; cat"\n`)
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt diff=x\n')
    control(dir, 'git diff')
    expect(fired('p03')).toBe(true)
    for (const raw of [
      { subcommand: 'diff' },
      { subcommand: 'log', options: ['patch'], max_count: 1 },
      { subcommand: 'show' },
      { subcommand: 'blame', paths: ['a.txt'] },
      { subcommand: 'grep', pattern: 'one' },
    ]) {
      expect(await gitRead(dir, raw)).toEqual(RUNS_PROGRAMS)
      withoutPreflight(dir, raw)
      expect(fired('p03')).toBe(false)
    }
    // Every content option of log, the R3-T set, without the preflight.
    for (const raw of [
      { subcommand: 'log', pickaxe: 'one' },
      // git 2.50 prints no diff for --word-diff without -p, so pair it with patch.
      { subcommand: 'log', options: ['word_diff', 'patch'] },
      { subcommand: 'log', options: ['patch', 'follow'], paths: ['a.txt'] },
      { subcommand: 'log', unified: 0 },
      { subcommand: 'log', options: ['graph', 'all', 'patch'] },
    ]) {
      withoutPreflight(dir, raw)
      expect(fired('p03')).toBe(false)
      withoutPreflight(dir, raw, argv => argv.filter(a => a !== '--no-textconv'))
      expect(fired('p03')).toBe(true)
    }
  })

  it('p04 named diff driver command: refused', async () => {
    const dir = newRepo()
    appendConfig(dir, `[diff "y"]\n\tcommand = "${touch('p04')}; true"\n`)
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt diff=y\n')
    control(dir, 'git diff')
    expect(fired('p04')).toBe(true)
    expect(await gitRead(dir, { subcommand: 'diff' })).toEqual(RUNS_PROGRAMS)
    expect(fired('p04')).toBe(false)
  })

  it('p05 clean filter on a touched same-size file: refused; only the preflight stops it', async () => {
    const dir = newRepo()
    gitw(dir, 'checkout', '--', 'a.txt')
    appendConfig(dir, `[filter "z"]\n\tclean = "${touch('p05')}; cat"\n`)
    fs.writeFileSync(path.join(dir, '.gitattributes'), '*.txt filter=z\n')
    const sameSize = (): void => {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n')
      const later = new Date(Date.now() + 5000)
      fs.utimesSync(path.join(dir, 'a.txt'), later, later)
    }
    sameSize()
    control(dir, 'git status')
    expect(fired('p05')).toBe(true)
    sameSize()
    expect(await gitRead(dir, { subcommand: 'status' })).toEqual(RUNS_PROGRAMS)
    expect(fired('p05')).toBe(false)
    sameSize()
    withoutPreflight(dir, { subcommand: 'status' })
    expect(fired('p05')).toBe(true)
  })

  it('p06 post-index-change hook, through core.hooksPath and .git/hooks: no fire', async () => {
    // A fresh future mtime on an unmodified tracked file makes git status
    // refresh and rewrite the index, which runs post-index-change.
    let tick = 0
    const restat = (dir: string): void => {
      const when = new Date(Date.now() + 60_000 + (tick += 10_000))
      fs.utimesSync(path.join(dir, 'b.bin'), when, when)
    }
    const check = async (dir: string, id: string): Promise<void> => {
      restat(dir)
      control(dir, 'git status')
      expect(fired(id)).toBe(true)
      restat(dir)
      expect((await gitRead(dir, { subcommand: 'status' })).is_error).toBe(false)
      expect(fired(id)).toBe(false)
      // The control still fires afterwards: the hook was live during the git_read call.
      restat(dir)
      control(dir, 'git status')
      expect(fired(id)).toBe(true)
    }

    const dir = newRepo()
    fs.writeFileSync(
      path.join(dir, '.git', 'hooks', 'post-index-change'),
      `#!/bin/sh\n${touch('p06')}\n`,
      {
        mode: 0o755,
      }
    )
    await check(dir, 'p06')

    const other = newRepo()
    fs.mkdirSync(path.join(other, 'hk'))
    fs.writeFileSync(path.join(other, 'hk', 'post-index-change'), `#!/bin/sh\n${touch('p06b')}\n`, {
      mode: 0o755,
    })
    appendConfig(other, '[core]\n\thooksPath = hk\n')
    await check(other, 'p06b')
  })

  it('p07 include.path and includeIf to a workspace file: refused', async () => {
    for (const include of [
      '[include]\n\tpath = ../notes.cfg\n',
      '[includeIf "gitdir:**"]\n\tpath = ../notes.cfg\n',
    ]) {
      const dir = newRepo()
      fs.writeFileSync(
        path.join(dir, 'notes.cfg'),
        `[core]\n\tfsmonitor = "${touch('p07')}; false"\n`
      )
      appendConfig(dir, include)
      control(dir, 'git status')
      expect(fired('p07')).toBe(true)
      expect(await gitRead(dir, { subcommand: 'status' })).toEqual(RUNS_PROGRAMS)
      expect(fired('p07')).toBe(false)
    }
  })

  it('p08 a .git file pointing at a generic directory: fsmonitor does not fire, a textconv is refused', async () => {
    const dir = newRepo()
    fs.renameSync(path.join(dir, '.git'), path.join(dir, 'data-store'))
    fs.writeFileSync(path.join(dir, '.git'), 'gitdir: data-store\n')
    appendConfig(
      dir,
      `[core]\n\tfsmonitor = "${touch('p08')}; false"\n`,
      path.join(dir, 'data-store', 'config')
    )
    control(dir, 'git status')
    expect(fired('p08')).toBe(true)
    expect((await gitRead(dir, { subcommand: 'status' })).is_error).toBe(false)
    expect(fired('p08')).toBe(false)
    appendConfig(
      dir,
      `[diff "x"]\n\ttextconv = "${touch('p08')}; cat"\n`,
      path.join(dir, 'data-store', 'config')
    )
    expect(await gitRead(dir, { subcommand: 'status' })).toEqual(RUNS_PROGRAMS)
  })

  it('p09 a git dir of plain files, at the directory and in a subdirectory: not a repository', async () => {
    const plain = (dir: string, worktree: string): void => {
      fs.mkdirSync(path.join(dir, 'objects'), { recursive: true })
      fs.mkdirSync(path.join(dir, 'refs'), { recursive: true })
      fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n')
      fs.writeFileSync(
        path.join(dir, 'config'),
        `[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tworktree = ${worktree}\n\tfsmonitor = "${touch('p09')}; false"\n`
      )
    }
    const atRoot = path.join(fx.root, `plain${++counter}`)
    plain(atRoot, '.')
    control(atRoot, 'git status')
    expect(fired('p09')).toBe(true)
    expect(await gitRead(atRoot, { subcommand: 'status' })).toEqual({
      content: GIT_READ_REFUSALS.not_a_repository,
      is_error: true,
    })
    expect(fired('p09')).toBe(false)
    const parent = path.join(fx.root, `plain${++counter}`)
    plain(path.join(parent, 'sub'), '..')
    control(path.join(parent, 'sub'), 'git status')
    expect(fired('p09')).toBe(true)
    expect(await gitRead(path.join(parent, 'sub'), { subcommand: 'status' })).toEqual({
      content: GIT_READ_REFUSALS.not_a_repository,
      is_error: true,
    })
    expect(fired('p09')).toBe(false)
  })

  it('p10 commondir: outside is refused; inside runs without firing', async () => {
    const make = (shared: string): string => {
      const dir = newRepo()
      fs.mkdirSync(shared, { recursive: true })
      for (const entry of ['config', 'objects', 'refs']) {
        fs.renameSync(path.join(dir, '.git', entry), path.join(shared, entry))
      }
      fs.writeFileSync(path.join(dir, '.git', 'commondir'), `${shared}\n`)
      appendConfig(
        dir,
        `[core]\n\tfsmonitor = "${touch('p10')}; false"\n`,
        path.join(shared, 'config')
      )
      return dir
    }
    const out = make(path.join(fx.outside, `shared${counter}`))
    control(out, 'git status')
    expect(fired('p10')).toBe(true)
    expect(await gitRead(out, { subcommand: 'status' })).toEqual({
      content: GIT_READ_REFUSALS.directory_outside_workspace,
      is_error: true,
    })
    const inside = make(path.join(fx.root, `shared${counter}`))
    expect((await gitRead(inside, { subcommand: 'status' })).is_error).toBe(false)
    expect(fired('p10')).toBe(false)
  })

  it('p11 worktree config with a program key: refused', async () => {
    const dir = newRepo()
    appendConfig(dir, '[extensions]\n\tworktreeConfig = true\n')
    fs.writeFileSync(
      path.join(dir, '.git', 'config.worktree'),
      `[diff]\n\texternal = "${touch('p11')}; true"\n`
    )
    control(dir, 'git diff')
    expect(fired('p11')).toBe(true)
    expect(await gitRead(dir, { subcommand: 'diff' })).toEqual(RUNS_PROGRAMS)
    expect(fired('p11')).toBe(false)
  })

  const MISSING = '1234567890123456789012345678901234567890'

  function promisor(dir: string, remote: string): void {
    appendConfig(
      dir,
      `[extensions]\n\tpartialClone = origin\n[remote "origin"]\n${remote}\tpromisor = true\n`
    )
    const config = path.join(dir, '.git', 'config')
    fs.writeFileSync(
      config,
      fs
        .readFileSync(config, 'utf8')
        .replace('repositoryformatversion = 0', 'repositoryformatversion = 1')
    )
  }

  it('p12a promisor remote with uploadpack: refused', async () => {
    const dir = newRepo()
    promisor(dir, `\turl = ${dir}\n\tuploadpack = "${touch('p12a')}; false"\n`)
    control(dir, `git cat-file -p ${MISSING}`)
    expect(fired('p12a')).toBe(true)
    expect(await gitRead(dir, { subcommand: 'cat_file', revisions: [MISSING] })).toEqual(
      RUNS_PROGRAMS
    )
    expect(fired('p12a')).toBe(false)
  })

  it('p12b tolerated promisor keys with an ext:: url: runs, fails, no fire', async () => {
    const dir = newRepo()
    promisor(dir, `\turl = "ext::sh -c touch% ${marker('p12b')}"\n`)
    control(dir, `git -c protocol.ext.allow=always cat-file -p ${MISSING}`)
    expect(fired('p12b')).toBe(true)
    const result = await gitRead(dir, { subcommand: 'show', revisions: [MISSING] })
    expect(result.is_error).toBe(true)
    expect(fired('p12b')).toBe(false)
  })

  it('p12c a local protocol.ext.allow=always: refused; forcing only protocol.allow would fire', async () => {
    const dir = newRepo()
    promisor(dir, `\turl = "ext::sh -c touch% ${marker('p12c')}"\n`)
    appendConfig(dir, '[protocol "ext"]\n\tallow = always\n')
    control(dir, `git cat-file -p ${MISSING}`)
    expect(fired('p12c')).toBe(true)
    expect(await gitRead(dir, { subcommand: 'show', revisions: [MISSING] })).toEqual(RUNS_PROGRAMS)
    expect(fired('p12c')).toBe(false)
    spawnSync(gitPath, ['cat-file', '-p', MISSING], {
      cwd: dir,
      env: {
        PATH: '/usr/bin:/bin',
        HOME: '/dev/null/home',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'protocol.allow',
        GIT_CONFIG_VALUE_0: 'never',
      },
      stdio: 'ignore',
    })
    expect(fired('p12c')).toBe(true)
  })

  it('p13 gpg.program with log.showSignature on a signed commit: refused', async () => {
    const dir = newRepo()
    const tree = gitw(dir, 'rev-parse', 'HEAD^{tree}').trim()
    const raw = `tree ${tree}\nauthor f <f@example.invalid> 1 +0000\ncommitter f <f@example.invalid> 1 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n x\n -----END PGP SIGNATURE-----\n\nsigned\n`
    fs.writeFileSync(path.join(fx.outside, `c${counter}.raw`), raw)
    const commit = gitw(
      dir,
      'hash-object',
      '-t',
      'commit',
      '-w',
      path.join(fx.outside, `c${counter}.raw`)
    ).trim()
    gitw(dir, 'update-ref', 'refs/heads/main', commit)
    const fake = path.join(fx.outside, `gpgfake${counter}`)
    fs.writeFileSync(fake, `#!/bin/sh\n${touch('p13')}\n`, { mode: 0o755 })
    appendConfig(dir, `[gpg]\n\tprogram = "${fake}"\n[log]\n\tshowSignature = true\n`)
    control(dir, 'git log -1')
    expect(fired('p13')).toBe(true)
    expect(await gitRead(dir, { subcommand: 'log', max_count: 1 })).toEqual(RUNS_PROGRAMS)
    expect(fired('p13')).toBe(false)
  })

  it('p14 core.pager: refused', async () => {
    const dir = newRepo()
    const payload = `${touch('p14')}; cat`
    appendConfig(dir, `[core]\n\tpager = "${payload}"\n`)
    // Git runs the pager only on a terminal; the control shows git would use this one.
    const configured = spawnSync(gitPath, ['var', 'GIT_PAGER'], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', HOME: fx.root, GIT_CONFIG_NOSYSTEM: '1' },
    })
    expect(configured.stdout.trim()).toBe(payload)
    expect(await gitRead(dir, { subcommand: 'log', max_count: 1 })).toEqual(RUNS_PROGRAMS)
    expect(fired('p14')).toBe(false)
  })

  it("p15 GIT_CONFIG_PARAMETERS in mcp-host's own environment: no fire", async () => {
    const dir = newRepo()
    const value = `'core.fsmonitor'='${touch('p15')}; false'`
    control(dir, 'git status', { GIT_CONFIG_PARAMETERS: value })
    expect(fired('p15')).toBe(true)
    const saved = process.env.GIT_CONFIG_PARAMETERS
    process.env.GIT_CONFIG_PARAMETERS = value
    try {
      expect((await gitRead(dir, { subcommand: 'status' })).is_error).toBe(false)
    } finally {
      if (saved === undefined) delete process.env.GIT_CONFIG_PARAMETERS
      else process.env.GIT_CONFIG_PARAMETERS = saved
    }
    expect(fired('p15')).toBe(false)
  })

  describe('submodules', () => {
    /** A parent with a clean submodule `mod` whose `a.txt` is committed as "one\ntwo\n". */
    function makeParent(): { parent: string; moduleConfig: string } {
      const child = newRepo()
      gitw(child, 'commit', '-qam', 'two')
      const parent = newRepo()
      gitw(parent, 'commit', '-qam', 'two')
      gitw(parent, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', child, 'mod')
      gitw(parent, 'commit', '-qm', 'sub')
      return { parent, moduleConfig: path.join(parent, '.git', 'modules', 'mod', 'config') }
    }

    function laterMtime(file: string, seconds: number): void {
      const when = new Date(Date.now() + seconds * 1000)
      fs.utimesSync(file, when, when)
    }

    it('s1 submodule core.fsmonitor: no fire', async () => {
      const { parent, moduleConfig } = makeParent()
      appendConfig(parent, `[core]\n\tfsmonitor = "${touch('s1')}; false"\n`, moduleConfig)
      fs.appendFileSync(path.join(parent, 'mod', 'a.txt'), 'dirty\n')
      control(parent, 'git status')
      expect(fired('s1')).toBe(true)
      expect((await gitRead(parent, { subcommand: 'status' })).is_error).toBe(false)
      expect((await gitRead(parent, { subcommand: 'diff' })).is_error).toBe(false)
      expect(fired('s1')).toBe(false)
    })

    it('s2 submodule textconv: no fire', async () => {
      const { parent, moduleConfig } = makeParent()
      appendConfig(parent, `[diff "x"]\n\ttextconv = "${touch('s2')}; cat"\n`, moduleConfig)
      fs.writeFileSync(path.join(parent, 'mod', '.gitattributes'), '*.txt diff=x\n')
      fs.appendFileSync(path.join(parent, 'mod', 'a.txt'), 'more\n')
      control(parent, 'git diff --submodule=diff')
      expect(fired('s2')).toBe(true)
      expect((await gitRead(parent, { subcommand: 'diff' })).is_error).toBe(false)
      expect(fired('s2')).toBe(false)
    })

    it('s3 submodule clean filter: no fire with --ignore-submodules=all, fires without it', async () => {
      const { parent, moduleConfig } = makeParent()
      appendConfig(parent, `[filter "z"]\n\tclean = "${touch('s3')}; cat"\n`, moduleConfig)
      fs.writeFileSync(path.join(parent, 'mod', '.gitattributes'), '*.txt filter=z\n')
      let tick = 5
      const sameSize = (): void => {
        const file = path.join(parent, 'mod', 'a.txt')
        fs.writeFileSync(file, 'ONE\nTWO\n')
        laterMtime(file, (tick += 5))
      }
      sameSize()
      control(parent, 'git status')
      expect(fired('s3')).toBe(true)
      sameSize()
      expect((await gitRead(parent, { subcommand: 'status' })).is_error).toBe(false)
      expect(fired('s3')).toBe(false)
      sameSize()
      withoutPreflight(parent, { subcommand: 'status' }, argv =>
        argv.filter(a => a !== '--ignore-submodules=all')
      )
      expect(fired('s3')).toBe(true)
    })

    it('s4 a hook in .git/modules/mod/hooks: no fire', async () => {
      const { parent } = makeParent()
      const hook = path.join(parent, '.git', 'modules', 'mod', 'hooks', 'post-index-change')
      fs.writeFileSync(hook, `#!/bin/sh\n${touch('s4')}\n`, { mode: 0o755 })
      laterMtime(path.join(parent, 'mod', 'a.txt'), 5)
      control(parent, 'git status')
      expect(fired('s4')).toBe(true)
      laterMtime(path.join(parent, 'mod', 'a.txt'), 10)
      expect((await gitRead(parent, { subcommand: 'status' })).is_error).toBe(false)
      expect(fired('s4')).toBe(false)
    })
  })

  it('N8 blame.ignoreRevsFile naming an outside file: refused', async () => {
    const dir = newRepo()
    const secret = path.join(fx.outside, 'secret-token.txt')
    fs.writeFileSync(secret, 'SECRET-TOKEN-0123456789abcdef\n')
    appendConfig(dir, `[blame]\n\tignoreRevsFile = ${secret}\n`)
    const leak = spawnSync(gitPath, ['blame', 'a.txt'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...gitReadEnv(path.dirname(fx.root)) },
    })
    expect(`${leak.stdout}${leak.stderr}`).toContain('SECRET-TOKEN')
    expect(await gitRead(dir, { subcommand: 'blame', paths: ['a.txt'] })).toEqual(RUNS_PROGRAMS)
  })

  it('N9 a workspace root with no .git inside an outer repository: not a repository', async () => {
    gitw(fx.base, 'init', '-q')
    try {
      const inner = path.join(fx.root, `n9-${++counter}`)
      fs.mkdirSync(inner)
      const found = spawnSync(gitPath, ['rev-parse', '--show-toplevel'], {
        cwd: inner,
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', HOME: fx.root, GIT_CONFIG_NOSYSTEM: '1' },
      })
      expect(found.stdout.trim()).toBe(fx.base)
      expect(await gitRead(inner, { subcommand: 'status' })).toEqual({
        content: GIT_READ_REFUSALS.not_a_repository,
        is_error: true,
      })
    } finally {
      fs.rmSync(path.join(fx.base, '.git'), { recursive: true, force: true })
    }
  })
})
