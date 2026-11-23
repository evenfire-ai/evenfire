import { afterAll, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { INERT_CONFIG_KEYS, checkConfigEntries, parseConfigListZ, runPreflight } from '../preflight'
import type { GitSpawn, GitSpawnResult } from '../runner'
import { params } from './gitFixtures'

/**
 * Captured from git 2.50.1 under git_read's environment: subsections with dots,
 * a tab and a quote. The last command key was added with diff.autoRefreshIndex.
 */
const CAPTURED =
  'local\u0000core.repositoryformatversion\u0000local\u0000core.filemode\u0000local\u0000core.bare\u0000local\u0000core.logallrefupdates\u0000local\u0000core.ignorecase\u0000local\u0000core.precomposeunicode\u0000local\u0000remote.a.b.url\u0000local\u0000branch.tab\there.remote\u0000local\u0000branch.qu"ote.merge\u0000local\u0000user.name\u0000command\u0000core.fsmonitor\u0000command\u0000core.hookspath\u0000command\u0000core.pager\u0000command\u0000core.sshcommand\u0000command\u0000core.alternaterefscommand\u0000command\u0000submodule.recurse\u0000command\u0000status.submodulesummary\u0000command\u0000log.showsignature\u0000command\u0000gpg.program\u0000command\u0000protocol.allow\u0000command\u0000protocol.ext.allow\u0000command\u0000protocol.file.allow\u0000command\u0000safe.barerepository\u0000command\u0000diff.autorefreshindex\u0000'

const COMMAND = CAPTURED.slice(CAPTURED.indexOf('command\u0000'))

describe('git_read config preflight (P6)', () => {
  it('the inert list is exactly the design list', () => {
    expect([...INERT_CONFIG_KEYS].sort()).toEqual(
      [
        'core.repositoryformatversion',
        'core.filemode',
        'core.bare',
        'core.logallrefupdates',
        'core.ignorecase',
        'core.precomposeunicode',
        'core.symlinks',
        'core.autocrlf',
        'core.eol',
        'core.safecrlf',
        'core.quotepath',
        'core.untrackedcache',
        'core.sparsecheckout',
        'core.sparsecheckoutcone',
        'core.abbrev',
        'core.compression',
        'core.preloadindex',
        'core.longpaths',
        'core.whitespace',
        'core.commentchar',
        'index.version',
        'index.sparse',
        'remote.<n>.url',
        'remote.<n>.pushurl',
        'remote.<n>.fetch',
        'remote.<n>.push',
        'remote.<n>.tagopt',
        'remote.<n>.prune',
        'remote.<n>.gh-resolved',
        'remote.<n>.promisor',
        'remote.<n>.partialclonefilter',
        'branch.<n>.remote',
        'branch.<n>.pushremote',
        'branch.<n>.merge',
        'branch.<n>.rebase',
        'branch.<n>.description',
        'branch.<n>.vscode-merge-base',
        'branch.<n>.gh-merge-base',
        'user.name',
        'user.email',
        'init.defaultbranch',
        'pull.rebase',
        'pull.ff',
        'push.default',
        'push.autosetupremote',
        'fetch.prune',
        'fetch.writecommitgraph',
        'color.ui',
        'extensions.objectformat',
        'extensions.worktreeconfig',
        'extensions.partialclone',
        'submodule.<n>.url',
        'submodule.<n>.active',
        'submodule.active',
        'core.worktree',
        'lfs.repositoryformatversion',
        'status.showuntrackedfiles',
        'diff.algorithm',
        'diff.renames',
        'diff.colormoved',
        'merge.conflictstyle',
        'rerere.enabled',
        'feature.manyfiles',
        'maintenance.auto',
        'maintenance.strategy',
        'advice.detachedhead',
        'commit.gpgsign',
        'gpg.format',
      ].sort()
    )
    expect(INERT_CONFIG_KEYS.has('blame.ignorerevsfile')).toBe(false)
  })

  it('real captured -z output parses and passes', () => {
    const entries = parseConfigListZ(CAPTURED)
    expect(entries).toContainEqual({ scope: 'local', name: 'remote.a.b.url' })
    expect(entries).toContainEqual({ scope: 'local', name: 'branch.tab\there.remote' })
    expect(entries).toContainEqual({ scope: 'local', name: 'branch.qu"ote.merge' })
    expect(checkConfigEntries(entries!)).toBeNull()
  })

  it('a key off the list is refused; the tolerated keys and submodule keys are not', () => {
    for (const name of [
      'diff.external',
      'diff.x.textconv',
      'filter.lfs.clean',
      'include.path',
      'includeif.gitdir:/x.path',
      'core.pager',
      'blame.ignorerevsfile',
      'remote.o.uploadpack',
    ]) {
      expect(checkConfigEntries(parseConfigListZ(`local\u0000${name}\u0000${COMMAND}`)!)).toBe(
        'config_runs_programs'
      )
    }
    expect(
      checkConfigEntries(
        parseConfigListZ(
          `local\u0000core.hookspath\u0000worktree\u0000core.fsmonitor\u0000local\u0000submodule.recurse\u0000local\u0000status.submodulesummary\u0000local\u0000submodule.active\u0000local\u0000core.worktree\u0000${COMMAND}`
        )!
      )
    ).toBeNull()
  })

  it('unknown, system and global scopes fail the preflight', () => {
    for (const scope of ['unknown', 'system', 'global']) {
      expect(checkConfigEntries(parseConfigListZ(`${scope}\u0000user.name\u0000${COMMAND}`)!)).toBe(
        'preflight_failed'
      )
    }
  })

  it('an extra or a missing command key fails the preflight', () => {
    expect(checkConfigEntries(parseConfigListZ(`${COMMAND}command\u0000core.editor\u0000`)!)).toBe(
      'preflight_failed'
    )
    expect(
      checkConfigEntries(parseConfigListZ(COMMAND.replace('command\u0000core.pager\u0000', ''))!)
    ).toBe('preflight_failed')
  })

  it('a truncated record does not parse', () => {
    expect(parseConfigListZ(CAPTURED.slice(0, -1))).toBeNull()
    expect(parseConfigListZ('local\u0000core.bare\u0000local\u0000')).toBeNull()
    expect(parseConfigListZ('local\u0000\u0000')).toBeNull()
  })

  describe('runPreflight config step', () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'git-read-parse-')))
    afterAll(() => fs.rmSync(base, { recursive: true, force: true }))
    fs.mkdirSync(path.join(base, '.git', 'objects'), { recursive: true })

    function stubSpawn(config: Partial<GitSpawnResult>): GitSpawn {
      return async (_git, argv) => {
        if (argv[0] === 'rev-parse') {
          return {
            exitCode: 0,
            stdout: `${base}/.git\n${base}/.git\n${base}\n`,
            stderr: '',
            outcome: 'exited',
          }
        }
        return { exitCode: 0, stdout: CAPTURED, stderr: '', outcome: 'exited', ...config }
      }
    }

    async function verdict(config: Partial<GitSpawnResult>): Promise<string> {
      const result = await runPreflight({
        root: base,
        verifyCallerRoot: false,
        gitPath: '/usr/bin/git',
        params: params({ subcommand: 'status' }),
        timeoutMs: 1000,
        spawn: stubSpawn(config),
      })
      return result.kind === 'refused' ? result.category : result.kind
    }

    it('passes with the captured output, and fails on rc != 0 or a timeout', async () => {
      expect(await verdict({})).toBe('ok')
      expect(await verdict({ exitCode: 1 })).toBe('preflight_failed')
      expect(await verdict({ exitCode: null, outcome: 'timeout' })).toBe('preflight_failed')
      expect(await verdict({ stdout: CAPTURED.slice(0, -1) })).toBe('preflight_failed')
    })
  })
})
