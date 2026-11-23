/**
 * G-P1…G-P8: git_read never returns the content of a protected path, in any
 * revision, the stash, the index or the worktree. The fixture puts protected
 * files in history, renames one out, re-adds them, and puts them on a side
 * branch, in the stash, in the index and behind blob tags. Every refusal or
 * "no needle" row has a control: real git without the rule prints a needle.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { GIT_READ_VALIDATION_TEXTS } from '../definition'
import { gitReadEnv } from '../env'
import { GIT_READ_REFUSALS, GitReadTool } from '../gitReadTool'
import { protectedExcludePathspecs } from '../protectedContent'
import { type Fixture, controlGit, gitwAt, makeFixture, requireGit } from './gitFixtures'

const FORMS = [
  'state.db',
  'sub/state.db-wal',
  '.clerum-state/tok.txt',
  '.gfs-downloads/x.txt',
  '.gfs-download-store/y.txt',
  '.gfs-download-store.retired-1/z.txt',
  '.gfs-downloads.trash-1/w.txt',
  '.clerum-outputs/o.txt',
  'sub/.clerum-state/n.txt',
]
const NT = ['--no-textconv', '--no-ext-diff']

let fx: Fixture
let repo: string
let tool: GitReadTool
const ids: Record<string, string> = {}

function needles(text: string): string[] {
  return [...new Set(text.match(/NEEDLE-[A-Za-z0-9_-]+|OUTSIDE-SECRET/g) ?? [])]
}

function put(version: string): void {
  for (const form of FORMS) {
    const file = path.join(repo, form)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `NEEDLE-P-${form.replace(/[/.]/g, '_')}-${version}\nshared line\n`)
  }
}

function commit(day: number, message: string): string {
  const date = `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`
  gitwAt(date, repo, 'add', '-A')
  gitwAt(date, repo, 'commit', '-qm', message)
  return gitwAt(date, repo, 'rev-parse', 'HEAD').trim()
}

async function call(
  params: Record<string, unknown>
): Promise<{ content: string; is_error: boolean }> {
  const out = await tool.execute({ directory: 'repo', ...params })
  return { content: out.content, is_error: out.is_error }
}

function control(...argv: string[]): string {
  return controlGit(fx.root, repo, ...argv).out
}

beforeAll(() => {
  const gitPath = requireGit()
  fx = makeFixture()
  repo = path.join(fx.root, 'repo')
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(fx.outside, 'secret.txt'), 'OUTSIDE-SECRET\n')
  gitwAt('2026-01-01T00:00:00Z', repo, 'init', '-q')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'WITNESS-A v1\n')
  fs.writeFileSync(path.join(repo, 'sub', 's.txt'), 'WITNESS-S\n')
  fs.writeFileSync(path.join(repo, 'wt-link.txt'), 'regular\n')
  put('v1')
  ids.C1 = commit(1, 'C1')
  put('v2')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'WITNESS-A v2\n')
  ids.C2 = commit(2, 'C2')
  ids.BLOB1 = gitwAt('2026-01-02T00:00:00Z', repo, 'rev-parse', `${ids.C1}:state.db`).trim()
  ids.BLOB2 = gitwAt('2026-01-02T00:00:00Z', repo, 'rev-parse', `${ids.C2}:state.db`).trim()
  ids.TREECS = gitwAt('2026-01-02T00:00:00Z', repo, 'rev-parse', `${ids.C1}:.clerum-state`).trim()
  for (const form of FORMS) gitwAt('2026-01-03T00:00:00Z', repo, 'rm', '-q', form)
  ids.C3 = commit(3, 'C3-delete-protected')
  fs.mkdirSync(path.join(repo, '.clerum-state'), { recursive: true })
  fs.writeFileSync(
    path.join(repo, '.clerum-state', 'ren.txt'),
    'NEEDLE-REN-OLD\nkeep line 2\nkeep line 3\nkeep line 4\n'
  )
  ids.C3b = commit(4, 'C3b')
  gitwAt('2026-01-05T00:00:00Z', repo, 'mv', '.clerum-state/ren.txt', 'notes.txt')
  fs.writeFileSync(
    path.join(repo, 'notes.txt'),
    'keep line 2\nkeep line 3\nkeep line 4\nnew line 5\n'
  )
  ids.C4 = commit(5, 'C4-rename')
  put('v3')
  ids.C5 = commit(6, 'C5-readd')
  const day6 = '2026-01-06T00:00:00Z'
  gitwAt(day6, repo, 'tag', '-a', 'blobtag', '-m', 'tag of a blob', ids.BLOB1)
  gitwAt(day6, repo, 'tag', 'lwblob', ids.BLOB1)
  gitwAt(day6, repo, 'tag', '-a', 'v1', '-m', 'v1', ids.C1)
  gitwAt(day6, repo, 'checkout', '-q', '-b', 'side')
  fs.mkdirSync(path.join(repo, '.clerum-outputs'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.clerum-outputs', 'side.txt'), 'NEEDLE-SIDE\n')
  commit(7, 'side')
  gitwAt(day6, repo, 'checkout', '-q', 'main')
  fs.mkdirSync(path.join(repo, '.clerum-state'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.clerum-state', 'st.txt'), 'NEEDLE-STASH\n')
  gitwAt(day6, repo, 'add', '.clerum-state/st.txt')
  gitwAt(day6, repo, 'stash', '-q')
  fs.appendFileSync(path.join(repo, 'state.db'), 'NEEDLE-WT-worktree-edit\n')
  fs.writeFileSync(path.join(repo, '.clerum-outputs', 'o.txt'), 'NEEDLE-IDX\n')
  gitwAt(day6, repo, 'add', '.clerum-outputs/o.txt')
  fs.rmSync(path.join(repo, 'wt-link.txt'))
  fs.symlinkSync(path.join(fx.outside, 'secret.txt'), path.join(repo, 'wt-link.txt'))
  tool = new GitReadTool({ root: fx.root, gitPath, timeoutMs: 30_000, verifyCallerRoot: false })
})

afterAll(() => fx?.cleanup())

describe('git_read protected content (history, refs, stash, index, worktree)', () => {
  it('log -p --all, from the repo and from a subdirectory: no needle, witness present', async () => {
    expect(needles(control('log', '-p', '--all', ...NT)).length).toBeGreaterThan(20)
    const top = await call({ subcommand: 'log', options: ['patch', 'all'], max_count: 1000 })
    expect(needles(top.content)).toEqual([])
    expect(top.content).toContain('WITNESS-A')
    const sub = await call({
      subcommand: 'log',
      directory: 'repo/sub',
      options: ['patch', 'all'],
      max_count: 1000,
    })
    expect(
      needles(controlGit(fx.root, path.join(repo, 'sub'), 'log', '-p', '--all', ...NT).out).length
    ).toBeGreaterThan(0)
    expect(needles(sub.content)).toEqual([])
    expect(sub.content).toContain('WITNESS-A')
  })

  it('the pickaxe lists no commit for a protected needle', async () => {
    expect(control('log', '-SNEEDLE-P', '--all', '--format=%s', ...NT).trim()).not.toBe('')
    expect(
      await call({ subcommand: 'log', pickaxe: 'NEEDLE-P', options: ['all'], format: '%s' })
    ).toEqual({
      content: '',
      is_error: false,
    })
  })

  it('show, diff and diff --cached drop protected paths', async () => {
    for (const [argv, params] of [
      [['show', ...NT, ids.C2], { subcommand: 'show', revisions: [ids.C2] }],
      [['show', ...NT, 'side'], { subcommand: 'show', revisions: ['side'] }],
      // The stash's index commit: the stash itself held only an index change.
      [['show', ...NT, 'stash@{0}^2'], { subcommand: 'show', revisions: ['stash@{0}^2'] }],
      [['diff', ...NT, ids.C1, ids.C2], { subcommand: 'diff', revisions: [ids.C1, ids.C2] }],
      [
        ['diff', ...NT, `${ids.C1}..${ids.C5}`],
        { subcommand: 'diff', revisions: [`${ids.C1}..${ids.C5}`] },
      ],
      [['diff', '--cached', ...NT], { subcommand: 'diff', options: ['cached'] }],
      [['diff', ...NT], { subcommand: 'diff' }],
    ] as const) {
      expect(needles(control(...argv)).length).toBeGreaterThan(0)
      const result = await call(params)
      expect(result.is_error).toBe(false)
      expect(needles(result.content)).toEqual([])
    }
    expect((await call({ subcommand: 'diff', revisions: [ids.C1, ids.C2] })).content).toContain(
      'WITNESS-A v2'
    )
  })

  it('grep finds no needle in the worktree, from a subdirectory or at a commit, and still finds the witness', async () => {
    expect(needles(control('grep', '--no-textconv', '-n', '-e', 'NEEDLE')).length).toBeGreaterThan(
      0
    )
    expect(await call({ subcommand: 'grep', pattern: 'NEEDLE' })).toEqual({
      content: '',
      is_error: false,
    })
    expect(await call({ subcommand: 'grep', directory: 'repo/sub', pattern: 'NEEDLE' })).toEqual({
      content: '',
      is_error: false,
    })
    expect(
      needles(control('grep', '--no-textconv', '-n', '-e', 'NEEDLE', ids.C2)).length
    ).toBeGreaterThan(0)
    expect(await call({ subcommand: 'grep', pattern: 'NEEDLE', revisions: [ids.C2] })).toEqual({
      content: '',
      is_error: false,
    })
    const live = await call({ subcommand: 'grep', pattern: 'WITNESS', revisions: [ids.C2] })
    expect(live.content).toContain('WITNESS-A')
  })

  it('a rename out of protected state shows the new file only', async () => {
    expect(control('show', ...NT, ids.C4)).toContain('NEEDLE-REN-OLD')
    const shown = await call({ subcommand: 'show', revisions: [ids.C4] })
    expect(needles(shown.content)).toEqual([])
    expect(shown.content).toContain('new line 5')
  })

  it('log --follow -p of a file renamed from protected state is refused', async () => {
    expect(control('log', '--follow', '-p', ...NT, '--', 'notes.txt')).toContain('NEEDLE-REN-OLD')
    expect(
      await call({ subcommand: 'log', options: ['patch', 'follow'], paths: ['notes.txt'] })
    ).toEqual({ content: GIT_READ_REFUSALS.protected_history, is_error: true })
  })

  it('the follow check sees the rename inside a revision window or a since window', async () => {
    const window = `${ids.C3b}..HEAD`
    // With --name-only, a rename lists only its new name: the old check would pass.
    expect(
      control('log', '--follow', '--name-only', '--format=', ...NT, window, '--', 'notes.txt')
    ).not.toContain('.clerum-state')
    expect(control('log', '--follow', '-p', ...NT, window, '--', 'notes.txt')).toContain(
      'NEEDLE-REN-OLD'
    )
    expect(
      await call({
        subcommand: 'log',
        options: ['patch', 'follow'],
        paths: ['notes.txt'],
        revisions: [window],
      })
    ).toEqual({ content: GIT_READ_REFUSALS.protected_history, is_error: true })
    const since = '2026-01-04T12:00:00Z'
    expect(
      control(
        'log',
        '--follow',
        '--name-only',
        '--format=',
        ...NT,
        `--since=${since}`,
        '--',
        'notes.txt'
      )
    ).not.toContain('.clerum-state')
    expect(
      control('log', '--follow', '-p', ...NT, `--since=${since}`, '--', 'notes.txt')
    ).toContain('NEEDLE-REN-OLD')
    expect(
      await call({ subcommand: 'log', options: ['patch', 'follow'], paths: ['notes.txt'], since })
    ).toEqual({ content: GIT_READ_REFUSALS.protected_history, is_error: true })
  })

  it('the follow check sees a protected name git would quote (non-ASCII), renamed out or matched by a glob', async () => {
    const quoted = path.join(fx.root, 'quoted')
    fs.mkdirSync(path.join(quoted, '.gfs-downloads'), { recursive: true })
    gitwAt('2026-02-01T00:00:00Z', quoted, 'init', '-q')
    fs.writeFileSync(path.join(quoted, 'a.txt'), 'WITNESS-Q\n')
    fs.writeFileSync(path.join(quoted, '.gfs-downloads', 'Informe año.txt'), 'NEEDLE-GFS-ANO v1\n')
    gitwAt('2026-02-01T00:00:00Z', quoted, 'add', '-A')
    gitwAt('2026-02-01T00:00:00Z', quoted, 'commit', '-qm', 'q1')
    gitwAt('2026-02-02T00:00:00Z', quoted, 'mv', '.gfs-downloads/Informe año.txt', 'notes.txt')
    gitwAt('2026-02-02T00:00:00Z', quoted, 'commit', '-qm', 'q2')
    // The check's old form: without -z the name is C-quoted.
    const unquoted = controlGit(
      fx.root,
      quoted,
      'log',
      '--follow',
      '--name-status',
      '--format=',
      ...NT,
      '--',
      'notes.txt'
    ).out
    expect(unquoted).toContain('".gfs-downloads/Informe a\\303\\261o.txt"')
    expect(
      controlGit(fx.root, quoted, 'log', '--follow', '-p', ...NT, '--', 'notes.txt').out
    ).toContain('NEEDLE-GFS-ANO')
    const refused = { content: GIT_READ_REFUSALS.protected_history, is_error: true }
    const run = async (params: Record<string, unknown>) => {
      const out = await tool.execute({ directory: 'quoted', ...params })
      return { content: out.content, is_error: out.is_error }
    }
    expect(
      await run({ subcommand: 'log', options: ['patch', 'follow'], paths: ['notes.txt'] })
    ).toEqual(refused)
    expect(
      await run({ subcommand: 'log', options: ['patch', 'follow'], paths: ['.gfs-download*'] })
    ).toEqual(refused)
    // Witness: the same call on an ordinary file still runs.
    expect(
      (await run({ subcommand: 'log', options: ['patch', 'follow'], paths: ['a.txt'] })).content
    ).toContain('WITNESS-Q')
  })

  it('log --follow -p over the whole tree is refused when its history has a protected name', async () => {
    expect(needles(control('log', '--follow', '-p', ...NT, '--', '.')).length).toBeGreaterThan(0)
    expect(await call({ subcommand: 'log', options: ['patch', 'follow'], paths: ['.'] })).toEqual({
      content: GIT_READ_REFUSALS.protected_history,
      is_error: true,
    })
  })

  it('REV:PATH to a protected path is refused in every spelling', async () => {
    for (const revision of [
      'HEAD:state.db',
      ':state.db',
      ':0:state.db',
      `${ids.C2}:.clerum-state/tok.txt`,
      'side:.clerum-outputs/side.txt',
      `${ids.C2}:sub/state.db-wal`,
    ]) {
      expect(needles(control('show', ...NT, revision)).length).toBeGreaterThan(0)
      expect(await call({ subcommand: 'show', revisions: [revision] })).toEqual({
        content: `Parameter validation failed: ${GIT_READ_VALIDATION_TEXTS.protected_path}`,
        is_error: true,
      })
    }
    expect(needles(control('show', ...NT, `${ids.C2}:./state.db`)).length).toBeGreaterThan(0)
    expect(await call({ subcommand: 'show', revisions: [`${ids.C2}:./state.db`] })).toEqual({
      content: `Parameter validation failed: ${GIT_READ_VALIDATION_TEXTS.bad_path}`,
      is_error: true,
    })
  })

  it('braces with a path, REV:PATH on grep and pathspec magic are refused', async () => {
    expect(needles(control('show', ...NT, `${ids.C2}^{tree}:state.db`)).length).toBeGreaterThan(0)
    for (const params of [
      { subcommand: 'show', revisions: [`${ids.C2}^{tree}:state.db`] },
      { subcommand: 'show', revisions: ['stash@{0}:.clerum-state/st.txt'] },
      { subcommand: 'grep', pattern: 'NEEDLE', revisions: ['HEAD:sub'] },
    ]) {
      expect(await call(params)).toEqual({
        content: `Parameter validation failed: ${GIT_READ_VALIDATION_TEXTS.bad_revision}`,
        is_error: true,
      })
    }
    expect(needles(control('log', '-p', ...NT, '--', ':(literal)state.db')).length).toBeGreaterThan(
      0
    )
    expect(
      await call({ subcommand: 'log', options: ['patch'], paths: [':(literal)state.db'] })
    ).toEqual({
      content: `Parameter validation failed: ${GIT_READ_VALIDATION_TEXTS.bad_path}`,
      is_error: true,
    })
  })

  it('blob ids, blob tags and tree ids are not commits', async () => {
    for (const [argv, params] of [
      [['cat-file', '-p', ids.BLOB1], { subcommand: 'cat_file', revisions: [ids.BLOB1] }],
      [['show', ...NT, ids.BLOB1], { subcommand: 'show', revisions: [ids.BLOB1] }],
      [['show', ...NT, 'blobtag'], { subcommand: 'show', revisions: ['blobtag'] }],
      [['show', ...NT, 'lwblob'], { subcommand: 'show', revisions: ['lwblob'] }],
      [
        ['show', ...NT, `${ids.TREECS}:tok.txt`],
        { subcommand: 'show', revisions: [`${ids.TREECS}:tok.txt`] },
      ],
      [
        ['diff', ...NT, ids.BLOB1, ids.BLOB2],
        { subcommand: 'diff', revisions: [ids.BLOB1, ids.BLOB2] },
      ],
      [
        ['grep', '-e', 'NEEDLE', ids.TREECS],
        { subcommand: 'grep', pattern: 'NEEDLE', revisions: [ids.TREECS] },
      ],
    ] as const) {
      expect(needles(control(...argv)).length).toBeGreaterThan(0)
      expect(await call(params)).toEqual({
        content: GIT_READ_REFUSALS.not_a_commit,
        is_error: true,
      })
    }
    // A tree id lists blob ids that lead back to the blob.
    expect(await call({ subcommand: 'cat_file', revisions: [ids.TREECS] })).toEqual({
      content: GIT_READ_REFUSALS.not_a_commit,
      is_error: true,
    })
  })

  it('positives: commit paths, a tree listing, a commit tag, a commit object, follow and paths', async () => {
    expect((await call({ subcommand: 'show', revisions: ['HEAD:a.txt'] })).content).toBe(
      'WITNESS-A v2\n'
    )
    expect((await call({ subcommand: 'show', revisions: ['HEAD:sub'] })).content).toContain('s.txt')
    const tag = await call({ subcommand: 'show', revisions: ['v1'] })
    expect(tag.content).toContain('WITNESS-A v1')
    expect(needles(tag.content)).toEqual([])
    expect((await call({ subcommand: 'cat_file', revisions: ['HEAD'] })).content).toMatch(/^tree /)
    const follow = await call({ subcommand: 'log', options: ['patch', 'follow'], paths: ['a.txt'] })
    expect(follow).toMatchObject({ is_error: false })
    expect(follow.content).toContain('WITNESS-A')
    const sub = await call({
      subcommand: 'log',
      options: ['patch'],
      paths: ['sub'],
      max_count: 1000,
    })
    expect(sub.content).toContain('WITNESS-S')
    expect(needles(sub.content)).toEqual([])
  })

  it('names-only listings show protected names but no content', async () => {
    for (const params of [
      { subcommand: 'ls_tree', options: ['recursive'] },
      { subcommand: 'ls_files' },
      { subcommand: 'status', options: ['short'] },
      { subcommand: 'log', options: ['stat'], revisions: [ids.C2], max_count: 1 },
    ]) {
      const result = await call(params)
      expect(result.is_error).toBe(false)
      expect(needles(result.content)).toEqual([])
    }
    expect((await call({ subcommand: 'ls_files' })).content).toContain('state.db')
  })

  it('a tracked file replaced by a link to an outside file is never followed', async () => {
    expect(fs.readFileSync(path.join(repo, 'wt-link.txt'), 'utf8')).toBe('OUTSIDE-SECRET\n')
    for (const params of [
      { subcommand: 'grep', pattern: 'OUTSIDE' },
      { subcommand: 'diff', paths: ['wt-link.txt'] },
      { subcommand: 'log', options: ['patch'], paths: ['wt-link.txt'] },
      { subcommand: 'blame', paths: ['wt-link.txt'] },
    ]) {
      expect(needles((await call(params)).content)).toEqual([])
    }
  })

  it('a worktree grep is refused when a tracked directory is a link; a revision grep still runs', async () => {
    const linked = path.join(fx.root, 'linked')
    fs.mkdirSync(path.join(linked, 'cfg'), { recursive: true })
    fs.mkdirSync(path.join(linked, 'st'), { recursive: true })
    gitwAt('2026-03-01T00:00:00Z', linked, 'init', '-q')
    fs.writeFileSync(path.join(linked, 'cfg', 'secret.txt'), 'placeholder\n')
    fs.writeFileSync(path.join(linked, 'st', 'session.json'), 'placeholder\n')
    fs.writeFileSync(path.join(linked, 'a.txt'), 'WITNESS-L\n')
    gitwAt('2026-03-01T00:00:00Z', linked, 'add', '-A')
    gitwAt('2026-03-01T00:00:00Z', linked, 'commit', '-qm', 'l1')
    const outsideDir = path.join(fx.outside, 'cfg-target')
    fs.mkdirSync(outsideDir, { recursive: true })
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'OUTSIDE-SECRET line\n')
    const stateDir = path.join(fx.root, '.clerum-state')
    fs.mkdirSync(stateDir, { recursive: true })
    fs.writeFileSync(path.join(stateDir, 'session.json'), 'NEEDLE-STATE token\n')
    fs.rmSync(path.join(linked, 'cfg'), { recursive: true })
    fs.symlinkSync(outsideDir, path.join(linked, 'cfg'))
    fs.rmSync(path.join(linked, 'st'), { recursive: true })
    fs.symlinkSync(stateDir, path.join(linked, 'st'))
    // Control: git greps the worktree through both links.
    const control = controlGit(
      fx.root,
      linked,
      'grep',
      '--no-textconv',
      '-n',
      '-e',
      'SECRET',
      '-e',
      'NEEDLE'
    ).out
    expect(control).toContain('OUTSIDE-SECRET')
    expect(control).toContain('NEEDLE-STATE')
    const run = async (params: Record<string, unknown>) => {
      const out = await tool.execute({ directory: 'linked', ...params })
      return { content: out.content, is_error: out.is_error }
    }
    for (const params of [
      { subcommand: 'grep', pattern: 'SECRET' },
      { subcommand: 'grep', pattern: 'NEEDLE', paths: ['st'] },
    ]) {
      expect(await run(params)).toEqual({
        content: GIT_READ_REFUSALS.worktree_link,
        is_error: true,
      })
    }
    const committed = await run({ subcommand: 'grep', pattern: 'placeholder', revisions: ['HEAD'] })
    expect(committed.is_error).toBe(false)
    expect(committed.content).toContain('HEAD:cfg/secret.txt')
    expect(needles(committed.content)).toEqual([])
    expect(committed.content).not.toContain('OUTSIDE-SECRET')
  })

  describe('each exclusion magic word is load-bearing', () => {
    const excl = (): string[] => [...protectedExcludePathspecs()]

    it('without the /** entries the directory forms leak', () => {
      const min = excl().filter(spec => !spec.endsWith('/**'))
      expect(needles(control('log', '-p', '--all', ...NT, '--', ...min)).length).toBeGreaterThan(0)
      expect(needles(control('log', '-p', '--all', ...NT, '--', ...excl()))).toEqual([])
    })

    it('without glob magic root state.db leaks', () => {
      const noGlob = excl().map(spec => spec.replace('exclude,top,glob', 'exclude,top'))
      expect(control('log', '-p', '--all', ...NT, '--', ...noGlob)).toContain('NEEDLE-P-state_db')
    })

    it('without top magic a subdirectory call leaks', () => {
      const noTop = excl().map(spec => spec.replace('exclude,top,glob', 'exclude,glob'))
      const out = controlGit(
        fx.root,
        path.join(repo, 'sub'),
        'log',
        '-p',
        '--all',
        ...NT,
        '--',
        ...noTop
      ).out
      expect(needles(out).length).toBeGreaterThan(0)
    })
  })

  describe('for_each_ref formats (G-P7)', () => {
    it('%(raw) and %(*raw) are refused', async () => {
      expect(control('for-each-ref', '--format=%(raw)', 'refs/tags/lwblob')).toContain('NEEDLE-P')
      expect(control('for-each-ref', '--format=%(*raw)', 'refs/tags/blobtag')).toContain('NEEDLE-P')
      for (const format of ['%(raw)', '%(*raw)']) {
        const result = await call({ subcommand: 'for_each_ref', format, pattern: 'refs/tags/' })
        expect(result.is_error).toBe(true)
        expect(needles(result.content)).toEqual([])
      }
    })

    it('a format with only allowlisted atoms runs', async () => {
      const result = await call({
        subcommand: 'for_each_ref',
        format: '%(objectname) %(objecttype) %(refname) %(*subject) %(contents:subject)',
        pattern: 'refs/tags/',
      })
      expect(result.is_error).toBe(false)
      expect(result.content).toContain('refs/tags/lwblob')
      expect(needles(result.content)).toEqual([])
    })
  })

  describe('indirection objects (G-P8)', () => {
    let copy: string
    let copyTool: GitReadTool
    beforeAll(() => {
      copy = path.join(fx.root, 'copy')
      fs.cpSync(repo, copy, { recursive: true, verbatimSymlinks: true })
      copyTool = new GitReadTool({
        root: fx.root,
        gitPath: requireGit(),
        timeoutMs: 30_000,
        verifyCallerRoot: false,
      })
    })

    it('a note made from a protected blob does not print', async () => {
      gitwAt('2026-01-08T00:00:00Z', copy, 'notes', 'add', '-f', '-C', ids.BLOB1, 'HEAD')
      expect(controlGit(fx.root, copy, 'log', '-1').out).toContain('NEEDLE-P')
      for (const params of [
        { subcommand: 'log', max_count: 1 },
        { subcommand: 'show' },
        { subcommand: 'log', max_count: 1, format: '%h %N' },
      ]) {
        const result = await copyTool.execute({ directory: 'copy', ...params })
        expect(needles(result.content)).toEqual([])
      }
    })

    it('a replace ref to a protected blob does not print', async () => {
      const aBlob = gitwAt('2026-01-08T00:00:00Z', copy, 'rev-parse', 'HEAD:a.txt').trim()
      gitwAt('2026-01-08T00:00:00Z', copy, 'replace', '-f', aBlob, ids.BLOB1)
      const env = { ...gitReadEnv(path.dirname(fx.root)) } as Record<string, string>
      delete env.GIT_NO_REPLACE_OBJECTS
      const leak = spawnSync(requireGit(), ['show', 'HEAD:a.txt'], {
        cwd: copy,
        env,
        encoding: 'utf8',
      })
      expect(leak.stdout).toContain('NEEDLE-P')
      const shown = await copyTool.execute({
        directory: 'copy',
        subcommand: 'show',
        revisions: ['HEAD:a.txt'],
      })
      expect(shown.content).toBe('WITNESS-A v2\n')
      const grep = await copyTool.execute({
        directory: 'copy',
        subcommand: 'grep',
        pattern: 'NEEDLE',
        revisions: ['HEAD'],
        paths: ['a.txt'],
      })
      expect(needles(grep.content)).toEqual([])
    })
  })
})
