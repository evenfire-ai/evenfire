/**
 * The `git_read` preflight (design §2.3.5), run on every call before the
 * command: P0 caller root, P1 directory, P2 discovery, P3 object store, P5
 * alternates, P4 repository links, P6 configuration, P7 per-call content
 * checks. Any refusal returns a fixed category and runs no command.
 */
import * as fs from 'fs'
import * as path from 'path'
import { verifyManagedCallerRootPath } from '../../../workspace/callerRootBinding'
import { isProtectedRealPath, isProtectedWorkspacePath } from '../../../workspace/protectedPaths'
import { isWithinDirectory, validatePath } from '../pathValidation'
import type { GitReadParams } from './definition'
import { GIT_READ_FORCED_KEYS, gitReadEnv } from './env'
import { PEEL_SUBCOMMANDS, isContentCall, isRevisionPath } from './protectedContent'
import type { GitSpawn, GitSpawnResult } from './runner'

export type GitReadRefusalCategory =
  | 'root_unavailable'
  | 'bad_path'
  | 'path_missing'
  | 'not_a_repository'
  | 'directory_outside_workspace'
  | 'directory_protected'
  | 'alternates_unsupported'
  | 'alternates_unresolved'
  | 'alternates_unreadable'
  | 'repository_link_unresolved'
  | 'repository_too_large'
  | 'preflight_failed'
  | 'config_runs_programs'
  | 'not_a_commit'
  | 'protected_history'
  | 'timeout'

export class GitReadRefusal extends Error {
  constructor(readonly category: GitReadRefusalCategory) {
    super(category)
    this.name = 'GitReadRefusal'
  }
}

/** Preflight git processes: discovery, config and peel checks. */
export const PREFLIGHT_TIMEOUT_MS = 3000
const PREFLIGHT_MAX_BUFFER = 1024 * 1024
/** The follow check lists every name in the walked history. */
const FOLLOW_CHECK_MAX_BUFFER = 8 * 1024 * 1024
export const GIT_READ_LINK_WALK_BUDGET = 200_000
const MAX_ALTERNATES_BYTES = 64 * 1024
const MAX_ALTERNATES_DEPTH = 5

/**
 * Local and worktree config keys that cannot make git run a program. Exact
 * keys after git's lower-casing of section and variable; `<n>` is any
 * subsection. `blame.ignorerevsfile` is deliberately absent.
 */
export const INERT_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...[
    'repositoryformatversion',
    'filemode',
    'bare',
    'logallrefupdates',
    'ignorecase',
    'precomposeunicode',
    'symlinks',
    'autocrlf',
    'eol',
    'safecrlf',
    'quotepath',
    'untrackedcache',
    'sparsecheckout',
    'sparsecheckoutcone',
    'abbrev',
    'compression',
    'preloadindex',
    'longpaths',
    'whitespace',
    'commentchar',
  ].map(name => `core.${name}`),
  'index.version',
  'index.sparse',
  ...[
    'url',
    'pushurl',
    'fetch',
    'push',
    'tagopt',
    'prune',
    'gh-resolved',
    'promisor',
    'partialclonefilter',
  ].map(name => `remote.<n>.${name}`),
  ...[
    'remote',
    'pushremote',
    'merge',
    'rebase',
    'description',
    'vscode-merge-base',
    'gh-merge-base',
  ].map(name => `branch.<n>.${name}`),
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
])

/** Local keys git_read tolerates because the forced keys override them. */
const TOLERATED_LOCAL_KEYS: ReadonlySet<string> = new Set(['core.hookspath', 'core.fsmonitor'])

export interface ConfigEntry {
  scope: string
  name: string
}

/**
 * Parses `git config --list --show-scope --name-only -z`: every field is
 * NUL-terminated, a scope and then a name. Returns null on any surprise.
 */
export function parseConfigListZ(output: string): ConfigEntry[] | null {
  if (output.length === 0) return []
  if (!output.endsWith('\0')) return null
  const fields = output.slice(0, -1).split('\0')
  if (fields.length % 2 !== 0) return null
  const entries: ConfigEntry[] = []
  for (let i = 0; i < fields.length; i += 2) {
    const scope = fields[i]
    const name = fields[i + 1]
    if (scope.length === 0 || name.length === 0 || /[\n\t]/.test(scope)) return null
    entries.push({ scope, name })
  }
  return entries
}

/**
 * The key as matched against `INERT_CONFIG_KEYS`: section and variable
 * lower-cased, any subsection replaced by `<n>`.
 */
function configKeyShape(name: string): string | null {
  const first = name.indexOf('.')
  const last = name.lastIndexOf('.')
  if (first <= 0 || last === name.length - 1) return null
  const section = name.slice(0, first).toLowerCase()
  const variable = name.slice(last + 1).toLowerCase()
  return first === last ? `${section}.${variable}` : `${section}.<n>.${variable}`
}

const FORCED_COMMAND_KEYS = GIT_READ_FORCED_KEYS.map(([key]) => key.toLowerCase()).sort()

/** P6 over parsed entries. */
export function checkConfigEntries(entries: readonly ConfigEntry[]): GitReadRefusalCategory | null {
  const command: string[] = []
  let runsPrograms = false
  for (const { scope, name } of entries) {
    if (scope === 'command') {
      command.push(name.toLowerCase())
      continue
    }
    if (scope !== 'local' && scope !== 'worktree') return 'preflight_failed'
    const shape = configKeyShape(name)
    if (shape === null) return 'preflight_failed'
    if (!INERT_CONFIG_KEYS.has(shape) && !TOLERATED_LOCAL_KEYS.has(shape)) runsPrograms = true
  }
  command.sort()
  if (
    command.length !== FORCED_COMMAND_KEYS.length ||
    command.some((key, i) => key !== FORCED_COMMAND_KEYS[i])
  ) {
    return 'preflight_failed'
  }
  return runsPrograms ? 'config_runs_programs' : null
}

function isInside(real: string, root: string): boolean {
  return real === root || isWithinDirectory(real, root)
}

/** Inside the real root and not into protected state. */
function confine(real: string, realRoot: string): void {
  if (!isInside(real, realRoot)) throw new GitReadRefusal('directory_outside_workspace')
  if (isProtectedRealPath(real, realRoot)) throw new GitReadRefusal('directory_protected')
}

/**
 * P5: a superset of git's alternates reader. Every entry git could link is
 * resolved the way git resolves it and must be confined; anything git might
 * read differently (quoting, unusual whitespace, depth, size) is refused
 * rather than interpreted. Returns the accepted alternate stores.
 */
export function checkAlternates(
  objectsReal: string,
  realRoot: string,
  depth = 0,
  accepted: Set<string> = new Set<string>()
): Set<string> {
  const file = path.join(objectsReal, 'info', 'alternates')
  let stat: fs.Stats
  try {
    stat = fs.lstatSync(file)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return accepted
    throw new GitReadRefusal('alternates_unreadable')
  }
  if (!stat.isFile() || stat.size > MAX_ALTERNATES_BYTES) {
    throw new GitReadRefusal('alternates_unsupported')
  }
  const text = fs.readFileSync(file, 'latin1')
  const entries: string[] = []
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    if (line.startsWith('"')) throw new GitReadRefusal('alternates_unsupported')
    if (/[\r\t\v\f]/.test(line) || line.trim() !== line) {
      throw new GitReadRefusal('alternates_unsupported')
    }
    entries.push(line)
  }
  if (entries.length === 0) return accepted
  if (depth > MAX_ALTERNATES_DEPTH) throw new GitReadRefusal('alternates_unsupported')
  for (const entry of entries) {
    // objectsReal is already a realpath, as git's relative base is.
    const joined = path.isAbsolute(entry) ? entry : `${objectsReal}/${entry}`
    let real: string
    try {
      real = fs.realpathSync(joined)
    } catch {
      throw new GitReadRefusal('alternates_unresolved')
    }
    confine(real, realRoot)
    if (accepted.has(real)) continue
    accepted.add(real)
    checkAlternates(real, realRoot, depth + 1, accepted)
  }
  return accepted
}

/**
 * P4: walks the git dir, the common dir and every object store with `lstat`.
 * Every symlink must resolve inside the root and not into protected state; a
 * link to a directory is walked by its realpath. A file outside the object
 * stores with more than one hard link is refused: its other names are not
 * visible. One seen-set ends cycles; one budget bounds the whole walk.
 */
export function walkRepositoryLinks(
  dirs: readonly string[],
  realRoot: string,
  objectStores: readonly string[],
  budget = GIT_READ_LINK_WALK_BUDGET
): void {
  const seen = new Set<string>()
  let entries = 0
  const inStore = (real: string): boolean => objectStores.some(store => isInside(real, store))
  const walk = (dir: string): void => {
    const real = fs.realpathSync(dir)
    if (seen.has(real)) return
    seen.add(real)
    for (const dirent of fs.readdirSync(real, { withFileTypes: true })) {
      if (++entries > budget) throw new GitReadRefusal('repository_too_large')
      const child = path.join(real, dirent.name)
      if (dirent.isSymbolicLink()) {
        let target: string
        try {
          target = fs.realpathSync(child)
        } catch {
          throw new GitReadRefusal('repository_link_unresolved')
        }
        confine(target, realRoot)
        if (fs.statSync(target).isDirectory()) walk(target)
      } else if (dirent.isDirectory()) {
        walk(child)
      } else if (!inStore(child) && fs.lstatSync(child).nlink > 1) {
        throw new GitReadRefusal('directory_outside_workspace')
      }
    }
  }
  for (const dir of dirs) walk(dir)
}

export interface PreflightContext {
  root: string
  verifyCallerRoot: boolean
  gitPath: string
  params: GitReadParams
  timeoutMs: number
  spawn: GitSpawn
  signal?: AbortSignal
}

export type PreflightResult =
  | { kind: 'ok'; cwd: string; env: Readonly<Record<string, string>> }
  | { kind: 'refused'; category: GitReadRefusalCategory }
  /** A check git itself rejected: its stderr is the result, and nothing else runs. */
  | { kind: 'git_failed'; stderr: string }

function refusalOf(error: unknown): GitReadRefusalCategory {
  if (error instanceof GitReadRefusal) return error.category
  throw error
}

/** The endpoints of a revision word that must peel to a commit. */
export function peelEndpoints(revision: string): string[] {
  if (isRevisionPath(revision)) {
    const left = revision.slice(0, revision.indexOf(':'))
    return left === '' ? [] : [left]
  }
  const parts = revision.includes('...')
    ? revision.split('...')
    : revision.includes('..')
      ? revision.split('..')
      : [revision]
  return parts.map(part => (part.startsWith('^') ? part.slice(1) : part)).filter(Boolean)
}

/** Every name in `git log --name-status` output, raw or `-z`. */
function namesInStatusOutput(output: string): string[] {
  return output.split(/[\0\n\t]/).filter(token => token.length > 0)
}

/** Runs the preflight; on `ok`, the command may run in `cwd` with `env`. */
export async function runPreflight(ctx: PreflightContext): Promise<PreflightResult> {
  let realRoot: string
  let cwd: string
  try {
    // P0. The caller root of a Host-owned GFS store must still verify.
    if (ctx.verifyCallerRoot && verifyManagedCallerRootPath(ctx.root) === undefined) {
      return { kind: 'refused', category: 'root_unavailable' }
    }
    realRoot = fs.realpathSync(ctx.root)
  } catch {
    return { kind: 'refused', category: 'root_unavailable' }
  }

  // P1. The directory: validatePath's lexical and realpath rules, and a directory.
  const directory = validatePath(ctx.params.directory, ctx.root)
  if (!directory.valid) return { kind: 'refused', category: 'bad_path' }
  try {
    cwd = fs.realpathSync(directory.resolved)
    if (!fs.statSync(cwd).isDirectory()) return { kind: 'refused', category: 'bad_path' }
  } catch {
    return { kind: 'refused', category: 'bad_path' }
  }

  const env = gitReadEnv(path.dirname(realRoot))
  const run = (
    argv: readonly string[],
    options: { timeoutMs?: number; maxBuffer?: number } = {}
  ): Promise<GitSpawnResult> =>
    ctx.spawn(ctx.gitPath, argv, {
      cwd,
      env,
      timeoutMs: options.timeoutMs ?? PREFLIGHT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? PREFLIGHT_MAX_BUFFER,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    })

  try {
    // P2. Discovery, under the ceiling.
    const discovery = await run(['rev-parse', '--git-dir', '--git-common-dir', '--show-toplevel'])
    if (discovery.outcome !== 'exited' || discovery.exitCode !== 0) {
      return { kind: 'refused', category: 'not_a_repository' }
    }
    const lines = discovery.stdout.split('\n').filter(line => line.length > 0)
    if (lines.length !== 3) return { kind: 'refused', category: 'not_a_repository' }
    const [gitDir, commonDir, topLevel] = lines.map(line => {
      try {
        return fs.realpathSync(path.resolve(cwd, line))
      } catch {
        throw new GitReadRefusal('not_a_repository')
      }
    })
    for (const real of [gitDir, commonDir, topLevel]) confine(real, realRoot)

    // P3. The object store.
    let objects: string
    try {
      objects = fs.realpathSync(path.join(commonDir, 'objects'))
    } catch {
      throw new GitReadRefusal('not_a_repository')
    }
    confine(objects, realRoot)

    // P5, then P4 over every store P5 accepted.
    const stores = [objects, ...checkAlternates(objects, realRoot)]
    walkRepositoryLinks([gitDir, commonDir, ...stores], realRoot, stores)
  } catch (error) {
    return { kind: 'refused', category: refusalOf(error) }
  }

  // P6. Configuration.
  const config = await run(['config', '--list', '--show-scope', '--name-only', '-z'])
  if (config.outcome !== 'exited' || config.exitCode !== 0) {
    return { kind: 'refused', category: 'preflight_failed' }
  }
  const entries = parseConfigListZ(config.stdout)
  if (entries === null) return { kind: 'refused', category: 'preflight_failed' }
  const configProblem = checkConfigEntries(entries)
  if (configProblem) return { kind: 'refused', category: configProblem }

  // P7. Per-call content checks.
  const params = ctx.params
  if (params.subcommand === 'blame') {
    const file = validatePath(path.posix.join(params.directory, params.paths[0]), ctx.root)
    if (!file.valid) return { kind: 'refused', category: 'bad_path' }
    try {
      const real = fs.realpathSync(file.resolved)
      if (!isInside(real, realRoot) || isProtectedRealPath(real, realRoot)) {
        return { kind: 'refused', category: 'bad_path' }
      }
    } catch {
      return { kind: 'refused', category: 'path_missing' }
    }
  }

  if (PEEL_SUBCOMMANDS.has(params.subcommand)) {
    for (const revision of params.revisions) {
      for (const endpoint of peelEndpoints(revision)) {
        const peel = await run([
          'rev-parse',
          '--verify',
          '-q',
          '--end-of-options',
          `${endpoint}^{commit}`,
        ])
        if (peel.outcome === 'timeout') return { kind: 'refused', category: 'timeout' }
        if (peel.outcome !== 'exited' || peel.exitCode !== 0) {
          return { kind: 'refused', category: 'not_a_commit' }
        }
      }
    }
  }

  if (params.subcommand === 'log' && params.options.has('follow') && isContentCall(params)) {
    const check = await run(
      [
        'log',
        '--follow',
        '--name-status',
        '--format=',
        '--no-textconv',
        '--no-ext-diff',
        ...(params.options.has('all') ? ['--all'] : []),
        ...(params.since !== undefined ? [`--since=${params.since}`] : []),
        ...(params.until !== undefined ? [`--until=${params.until}`] : []),
        ...(params.author !== undefined ? [`--author=${params.author}`] : []),
        ...(params.grep !== undefined ? [`--grep=${params.grep}`] : []),
        '--end-of-options',
        ...params.revisions,
        '--',
        params.paths[0],
      ],
      { timeoutMs: ctx.timeoutMs, maxBuffer: FOLLOW_CHECK_MAX_BUFFER }
    )
    if (check.outcome === 'timeout') return { kind: 'refused', category: 'timeout' }
    if (check.outcome !== 'exited') return { kind: 'refused', category: 'preflight_failed' }
    if (check.exitCode !== 0) return { kind: 'git_failed', stderr: check.stderr }
    if (namesInStatusOutput(check.stdout).some(isProtectedWorkspacePath)) {
      return { kind: 'refused', category: 'protected_history' }
    }
  }

  return { kind: 'ok', cwd, env }
}
