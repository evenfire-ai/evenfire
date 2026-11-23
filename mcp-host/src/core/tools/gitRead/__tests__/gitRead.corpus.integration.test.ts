/**
 * P1-T4 and P1-T1: the typed-git corpus runs through GitReadTool on real git
 * (exit 0 and a first-line witness), and every git process the tool starts,
 * preflight included, gets exactly the literal environment with the ceiling.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { gitReadEnv } from '../env'
import { GIT_READ_TRUNCATED_LINE, GitReadTool } from '../gitReadTool'
import { type GitSpawn, spawnGit } from '../runner'
import { type Fixture, gitw, gitwAt, makeFixture, requireGit } from './gitFixtures'

let fx: Fixture
let gitPath: string
let repo: string

beforeAll(() => {
  gitPath = requireGit()
  fx = makeFixture()
  repo = path.join(fx.root, 'repo')
  fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
  gitw(repo, 'init', '-q')
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTODO two\n')
  fs.writeFileSync(path.join(repo, 'sub', 'b.py'), 'print(1)\n')
  fs.writeFileSync(path.join(repo, 'app.py'), 'print("app")\n')
  gitwAt('2026-01-01T00:00:00Z', repo, 'add', '-A')
  gitwAt('2026-01-01T00:00:00Z', repo, 'commit', '-qm', 'c1')
  fs.appendFileSync(path.join(repo, 'a.txt'), 'three\n')
  gitwAt('2026-01-02T00:00:00Z', repo, 'commit', '-qam', 'c2')
  fs.appendFileSync(path.join(repo, 'a.txt'), 'four\n')
  gitwAt('2026-01-03T00:00:00Z', repo, 'commit', '-qam', 'c3')
  gitw(repo, 'tag', 'v1.0')
  gitw(repo, 'tag', '-a', 'v1.1', '-m', 'annotated')
  gitw(repo, 'branch', 'feature')
  gitw(repo, 'remote', 'add', 'origin', 'https://example.invalid/r.git')
  gitw(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD~1')
  gitw(repo, 'branch', '--set-upstream-to=origin/main', 'main')
  fs.appendFileSync(path.join(repo, 'a.txt'), 'wip\n')
  gitw(repo, 'stash', '-q')
  fs.appendFileSync(path.join(repo, 'a.txt'), 'dirty\n')
  gitw(repo, 'add', 'a.txt')
})

afterAll(() => fx?.cleanup())

const CORPUS: ReadonlyArray<readonly [string, Record<string, unknown>, RegExp]> = [
  ['git status', { subcommand: 'status' }, /^On branch main/],
  [
    'git status -sb',
    { subcommand: 'status', options: ['short', 'branch'] },
    /^## main\.\.\.origin\/main/,
  ],
  [
    'git log --oneline -n 20',
    { subcommand: 'log', options: ['oneline'], max_count: 20 },
    /^[0-9a-f]+ c3$/m,
  ],
  [
    'git log -p -- a.txt',
    { subcommand: 'log', options: ['patch'], paths: ['a.txt'] },
    /^commit [0-9a-f]{40}/,
  ],
  [
    'git log origin/main..HEAD',
    { subcommand: 'log', revisions: ['origin/main..HEAD'], format: '%s' },
    /^c3$/m,
  ],
  ['git log @{u}..HEAD', { subcommand: 'log', revisions: ['@{u}..HEAD'], format: '%s' }, /^c3$/m],
  // Everything is staged, so the worktree diff is exactly empty.
  ['git diff', { subcommand: 'diff' }, /^$/],
  [
    'git diff --cached --stat',
    { subcommand: 'diff', options: ['cached', 'stat'] },
    /a\.txt \| 1 \+/,
  ],
  [
    'git diff --stat',
    { subcommand: 'diff', options: ['stat'], revisions: ['HEAD~1'] },
    /a\.txt \| \d+ \+/,
  ],
  [
    'git diff --cached',
    { subcommand: 'diff', options: ['cached'] },
    /^diff --git a\/a\.txt b\/a\.txt/,
  ],
  ['git diff main...feature', { subcommand: 'diff', revisions: ['main...feature'] }, /^$/],
  ['git diff HEAD~1', { subcommand: 'diff', revisions: ['HEAD~1'] }, /^diff --git/],
  [
    'git diff HEAD^ HEAD -- a.txt',
    { subcommand: 'diff', revisions: ['HEAD^', 'HEAD'], paths: ['a.txt'] },
    /^diff --git/,
  ],
  ['git show', { subcommand: 'show' }, /^commit [0-9a-f]{40}/],
  [
    'git show --stat HEAD~1',
    { subcommand: 'show', options: ['stat'], revisions: ['HEAD~1'] },
    /^commit /,
  ],
  ['git show HEAD:app.py', { subcommand: 'show', revisions: ['HEAD:app.py'] }, /^print\("app"\)$/m],
  ['git show HEAD~2:a.txt', { subcommand: 'show', revisions: ['HEAD~2:a.txt'] }, /^one$/m],
  ['git blame -L 1,2', { subcommand: 'blame', paths: ['a.txt'], line_range: '1,2' }, /\) one$/m],
  [
    'git grep -n TODO',
    { subcommand: 'grep', pattern: 'TODO', options: ['line_number'] },
    /^a\.txt:2:TODO two$/m,
  ],
  [
    "git grep -n TODO -- '*.py'",
    { subcommand: 'grep', pattern: 'print', options: ['line_number'], paths: ['*.py'] },
    /^app\.py:1:/,
  ],
  ['git stash list', { subcommand: 'stash_list' }, /^stash@\{0\}: WIP on main/],
  [
    'git ls-tree -r --name-only HEAD',
    { subcommand: 'ls_tree', options: ['recursive', 'name_only'] },
    /^a\.txt$/m,
  ],
  ['git ls-files', { subcommand: 'ls_files' }, /^a\.txt$/m],
  [
    'git branch -a -vv',
    { subcommand: 'branch', options: ['all', 'verbose'] },
    /^\* main\s+[0-9a-f]+ \[origin\/main/m,
  ],
  ['git branch --show-current', { subcommand: 'branch', options: ['show_current'] }, /^main$/m],
  ["git tag -l 'v1.*'", { subcommand: 'tag', pattern: 'v1.*' }, /^v1\.0$/m],
  ['git rev-parse HEAD', { subcommand: 'rev_parse', revisions: ['HEAD'] }, /^[0-9a-f]{40}$/m],
  [
    'git rev-parse --abbrev-ref HEAD',
    { subcommand: 'rev_parse', options: ['abbrev_ref'], revisions: ['HEAD'] },
    /^main$/m,
  ],
  [
    'git rev-parse --show-toplevel',
    { subcommand: 'rev_parse', options: ['show_toplevel'] },
    /\/repo$/m,
  ],
  [
    'git describe --tags --always',
    { subcommand: 'describe', options: ['tags', 'always'] },
    /^v1\.1$/m,
  ],
  ['git shortlog -sn HEAD', { subcommand: 'shortlog' }, /^\s+3\tfixture$/m],
  ['git rev-list --count HEAD', { subcommand: 'rev_list', revisions: ['HEAD'] }, /^3$/m],
  [
    'git merge-base HEAD origin/main',
    { subcommand: 'merge_base', revisions: ['HEAD', 'origin/main'] },
    /^[0-9a-f]{40}$/m,
  ],
  ['git cat-file -p HEAD', { subcommand: 'cat_file', revisions: ['HEAD'] }, /^tree [0-9a-f]{40}$/m],
  ['git reflog -n 5', { subcommand: 'reflog', max_count: 5 }, /^[0-9a-f]+ HEAD@\{0\}/],
  [
    'git remote -v',
    { subcommand: 'remote' },
    /^origin\thttps:\/\/example\.invalid\/r\.git \(fetch\)$/m,
  ],
  [
    "git for-each-ref --sort=-committerdate refs/heads/ --format='%(refname:short)'",
    {
      subcommand: 'for_each_ref',
      sort: '-committerdate',
      format: '%(refname:short)',
      pattern: 'refs/heads/',
    },
    /^(main|feature)$/m,
  ],
  ['git worktree list', { subcommand: 'worktree_list' }, /\/repo\s+[0-9a-f]+ \[main\]$/m],
  [
    'git remote get-url origin',
    { subcommand: 'remote', options: ['get_url'], revisions: ['origin'] },
    /^https:\/\/example\.invalid\/r\.git$/m,
  ],
  [
    'git log --follow -p -- a.txt',
    { subcommand: 'log', options: ['patch', 'follow'], paths: ['a.txt'] },
    /^commit /,
  ],
  ['git log -S TODO', { subcommand: 'log', pickaxe: 'TODO', format: '%s' }, /^c1$/m],
  [
    'git log --word-diff -U0',
    { subcommand: 'log', options: ['word_diff'], unified: 0, max_count: 1 },
    /\{\+four\+\}/,
  ],
  [
    'git log --graph --all -p',
    { subcommand: 'log', options: ['graph', 'all', 'patch'], max_count: 2 },
    /^\* commit /,
  ],
]

describe('git_read corpus on real git', () => {
  it.each(CORPUS)('%s', async (_typed, params, witness) => {
    const tool = new GitReadTool({
      root: fx.root,
      gitPath,
      timeoutMs: 30_000,
      verifyCallerRoot: false,
    })
    const result = await tool.execute({ directory: 'repo', ...params })
    expect(result.is_error).toBe(false)
    expect(result.content).toMatch(witness)
  })

  it('grep and merge-base with no result exit 1 and return an empty result', async () => {
    const tool = new GitReadTool({
      root: fx.root,
      gitPath,
      timeoutMs: 30_000,
      verifyCallerRoot: false,
    })
    expect(
      await tool.execute({ directory: 'repo', subcommand: 'grep', pattern: 'no-such-text' })
    ).toMatchObject({
      content: '',
      is_error: false,
    })
    const orphan = gitw(repo, 'commit-tree', '-m', 'orphan', `HEAD^{tree}`).trim()
    expect(
      await tool.execute({
        directory: 'repo',
        subcommand: 'merge_base',
        revisions: ['HEAD', orphan],
      })
    ).toMatchObject({ content: '', is_error: false })
  })

  it("other git failures return git's stderr as an error", async () => {
    const tool = new GitReadTool({
      root: fx.root,
      gitPath,
      timeoutMs: 30_000,
      verifyCallerRoot: false,
    })
    const result = await tool.execute({
      directory: 'repo',
      subcommand: 'rev_parse',
      revisions: ['no-such-ref'],
    })
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('no-such-ref')
  })

  it('output past the cap is cut with a fixed line and is not an error', async () => {
    const big = path.join(fx.root, 'big')
    fs.mkdirSync(big)
    gitw(big, 'init', '-q')
    fs.writeFileSync(path.join(big, 'big.txt'), `${'x'.repeat(100)}\n`.repeat(30_000))
    gitw(big, 'add', '-A')
    gitw(big, 'commit', '-qm', 'big')
    const tool = new GitReadTool({
      root: fx.root,
      gitPath,
      timeoutMs: 30_000,
      verifyCallerRoot: false,
    })
    const result = await tool.execute({
      directory: 'big',
      subcommand: 'show',
      revisions: ['HEAD:big.txt'],
    })
    expect(result.is_error).toBe(false)
    expect(result.content.endsWith(`\n${GIT_READ_TRUNCATED_LINE}`)).toBe(true)
    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(1024 * 1024)
  })

  it('a repository with a submodule gets the fixed note on status and diff', async () => {
    const parent = path.join(fx.root, 'parent')
    const child = path.join(fx.root, 'child')
    for (const dir of [parent, child]) {
      fs.mkdirSync(dir)
      gitw(dir, 'init', '-q')
      fs.writeFileSync(path.join(dir, 'f.txt'), 'f\n')
      gitw(dir, 'add', '-A')
      gitw(dir, 'commit', '-qm', 'c')
    }
    gitw(parent, '-c', 'protocol.file.allow=always', 'submodule', '-q', 'add', child, 'mod')
    fs.mkdirSync(path.join(parent, 'src'))
    fs.writeFileSync(path.join(parent, 'src', 's.txt'), 's\n')
    gitw(parent, 'add', '-A')
    gitw(parent, 'commit', '-qm', 'sub')
    const tool = new GitReadTool({
      root: fx.root,
      gitPath,
      timeoutMs: 30_000,
      verifyCallerRoot: false,
    })
    // From a subdirectory too: status and diff still cover the whole repository.
    for (const directory of ['parent', 'parent/src']) {
      for (const subcommand of ['status', 'diff']) {
        const result = await tool.execute({ directory, subcommand })
        expect(result.content).toContain('Submodule changes are not shown by git_read.')
      }
    }
    expect((await tool.execute({ directory: 'repo', subcommand: 'status' })).content).not.toContain(
      'Submodule changes'
    )
  })

  it('a worktree diff or status leaves .git/index unchanged', async () => {
    const indexFile = path.join(repo, '.git', 'index')
    const later = (): void => {
      const when = new Date(Date.now() + 60_000)
      fs.utimesSync(path.join(repo, 'app.py'), when, when)
    }
    // Control: git's own worktree diff refreshes and rewrites the index, even
    // with GIT_OPTIONAL_LOCKS=0, when a tracked file's stat data changed.
    later()
    const before = fs.readFileSync(indexFile)
    spawnSync(gitPath, ['diff'], {
      cwd: repo,
      env: { PATH: '/usr/bin:/bin', HOME: repo, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0' },
    })
    expect(fs.readFileSync(indexFile).equals(before)).toBe(false)
    const tool = new GitReadTool({
      root: fx.root,
      gitPath,
      timeoutMs: 30_000,
      verifyCallerRoot: false,
    })
    for (const params of [
      { subcommand: 'diff' },
      { subcommand: 'diff', options: ['stat'] },
      { subcommand: 'status' },
    ]) {
      fs.utimesSync(
        path.join(repo, 'app.py'),
        new Date(Date.now() + 120_000),
        new Date(Date.now() + 120_000)
      )
      const snapshot = fs.readFileSync(indexFile)
      expect((await tool.execute({ directory: 'repo', ...params })).is_error).toBe(false)
      expect(fs.readFileSync(indexFile).equals(snapshot)).toBe(true)
    }
  })

  it('every git spawn gets the literal environment and the ceiling', async () => {
    const poison: Record<string, string> = {
      GIT_CONFIG_PARAMETERS: "'core.pager'='false'",
      GIT_DIR: path.join(fx.outside, '.git'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(fx.outside, 'objects'),
      GIT_NO_REPLACE_OBJECTS: '0',
      HOME: fx.outside,
      PYTHONPATH: fx.outside,
      GIT_ASKPASS: '/bin/false',
    }
    const saved = Object.fromEntries(Object.keys(poison).map(key => [key, process.env[key]]))
    Object.assign(process.env, poison)
    const envs: Array<Readonly<Record<string, string>>> = []
    const spawned: string[] = []
    const spy: GitSpawn = (git, argv, options) => {
      envs.push(options.env)
      spawned.push(argv[0])
      return spawnGit(git, argv, options)
    }
    try {
      const tool = new GitReadTool({
        root: fx.root,
        gitPath,
        timeoutMs: 30_000,
        verifyCallerRoot: false,
        spawn: spy,
      })
      for (const params of [
        { subcommand: 'status' },
        { subcommand: 'show', revisions: ['HEAD:a.txt'] },
        { subcommand: 'log', options: ['patch', 'follow'], paths: ['a.txt'] },
        { subcommand: 'blame', paths: ['a.txt'] },
      ]) {
        expect((await tool.execute({ directory: 'repo', ...params })).is_error).toBe(false)
      }
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
    // Every process, preflight included, in order, for the four calls.
    expect(spawned).toEqual([
      // status: discovery, config, the index-name check, the command, the submodule note
      'rev-parse',
      'config',
      'ls-files',
      'status',
      'ls-files',
      // show HEAD:a.txt: discovery, config, peel, notes refs, the command
      'rev-parse',
      'config',
      'rev-parse',
      'for-each-ref',
      'show',
      // log --follow -p: discovery, config, notes refs, the follow check, the command
      'rev-parse',
      'config',
      'for-each-ref',
      'log',
      'log',
      // blame: discovery, config, notes refs, the command
      'rev-parse',
      'config',
      'for-each-ref',
      'blame',
    ])
    expect(envs).toHaveLength(spawned.length)
    const literal = gitReadEnv(path.dirname(fs.realpathSync(fx.root)))
    for (const env of envs) expect(env).toEqual(literal)
    expect(literal.GIT_CEILING_DIRECTORIES).toBe(fx.base)
  })
})
