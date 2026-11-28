/**
 * The typed-git redirect: in auto mode, a typed read-only `git` shell command
 * that would be classified or carded gets a fixed result telling the model to
 * use `git_read` instead. Nothing runs. Each distinct command text is
 * redirected once per task; sending the same text again takes today's path.
 */
import { Counter, register } from 'prom-client'
import { checkGitReadParams } from '../tools/gitRead/definition'

/** The fixed result of a redirected call. */
export const GIT_REDIRECT_TEXT =
  'Not run. In auto approval mode, git_read lists repository state (status, log, branches, tags, refs) without asking. Call git_read with the equivalent subcommand and options. To run this exact command in the shell instead, send it again; the user may be asked to approve it.'

/** Subcommands whose output is file content: git_read cards them in auto. */
const CONTENT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'show',
  'diff',
  'grep',
  'blame',
  'cat-file',
])

/**
 * A `git log` argument that adds file content: a patch, a word diff, a
 * context size, a pickaxe, a line-range log or a combined diff. A short
 * option bundle counts when it holds one of those letters.
 */
function logContentArg(arg: string): boolean {
  if (
    /^--(patch|notes|show-notes|unified|word-diff|color-words|pickaxe|cc$|diff-merges|full-diff|ext-diff|textconv|raw$)/.test(
      arg
    )
  ) {
    return true
  }
  // A format with %N prints notes, which can be made from any blob.
  if (/^--(format|pretty)=.*%N/.test(arg)) return true
  if (arg.startsWith('-') && !arg.startsWith('--')) {
    return /[puUSGLcm]/.test(arg.slice(1).replace(/^\d+/, ''))
  }
  return false
}

const READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'log',
  'show',
  'diff',
  'blame',
  'grep',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'describe',
  'shortlog',
  'rev-list',
  'merge-base',
  'cat-file',
  'for-each-ref',
])

/** `branch` options that only list refs. */
const BRANCH_LIST_FLAGS: ReadonlySet<string> = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '--all',
  '--list',
  '-l',
  '--show-current',
  '--remotes',
  '--verbose',
])
/** `tag` options that only list refs (`tag -v` verifies, which runs gpg). */
const TAG_LIST_FLAGS: ReadonlySet<string> = new Set(['--list', '-l'])
/** List filters that take a value as the next word. */
const LIST_FILTERS: ReadonlySet<string> = new Set(['--contains', '--merged', '--no-merged'])

function listsRefsOnly(args: readonly string[], flags: ReadonlySet<string>): boolean {
  let listMode = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (flags.has(arg)) {
      if (arg === '--list' || arg === '-l') listMode = true
      continue
    }
    if (LIST_FILTERS.has(arg)) {
      if (i + 1 >= args.length) return false
      i++
      listMode = true
      continue
    }
    if (/^--sort=/.test(arg)) continue
    if (/^--(?:contains|merged|no-merged)=/.test(arg)) {
      listMode = true
      continue
    }
    if (arg.startsWith('-')) return false
    // A name without list mode creates a branch or tag.
    if (!listMode) return false
  }
  return true
}

function readOnly(subcommand: string, args: readonly string[]): boolean {
  // `--output=<file>` writes a file on diff, log and show.
  if (args.some(arg => arg.startsWith('--output'))) return false
  if (READ_ONLY_SUBCOMMANDS.has(subcommand)) return true
  switch (subcommand) {
    case 'stash':
    case 'worktree':
      return args.length === 1 && args[0] === 'list'
    case 'reflog':
      return args.length === 0 || args[0] === 'show' || /^-n?\d*$/.test(args[0])
    case 'remote':
      return (
        args.length === 0 ||
        (args.length === 1 && (args[0] === '-v' || args[0] === '--verbose')) ||
        args[0] === 'get-url'
      )
    case 'branch':
      return listsRefsOnly(args, BRANCH_LIST_FLAGS)
    case 'tag':
      return listsRefsOnly(args, TAG_LIST_FLAGS)
    default:
      return false
  }
}

/**
 * The flags of a typed names-only command that git_read can express. A
 * pointer to git_read for a command it cannot run (`git log --merges`,
 * `git status --ignored`) would only cost the model a turn. Words that do not
 * start with `-` are revisions, paths or patterns, and everything after `--`
 * is a path.
 */
interface FlagSurface {
  /** Flags that stand alone. */
  exact: ReadonlySet<string>
  /** `--name=value` forms. */
  prefixed?: readonly string[]
  /** Flags whose value is the next word. */
  valued?: ReadonlySet<string>
  /** Short-option bundles git_read covers, such as `-sb`. */
  bundle?: RegExp
  /** `-N` and `-nN` entry counts. */
  counts?: boolean
}

const set = (...flags: string[]): ReadonlySet<string> => new Set(flags)

const NAMES_ONLY_SURFACES: Readonly<Record<string, FlagSurface>> = {
  status: {
    exact: set('-s', '--short', '-b', '--branch', '--porcelain', '--porcelain=v1'),
    bundle: /^-[sb]+$/,
  },
  log: {
    exact: set(
      '--oneline',
      '--stat',
      '--name-only',
      '--name-status',
      '--graph',
      '--all',
      '--follow'
    ),
    prefixed: [
      '--max-count=',
      '--since=',
      '--after=',
      '--until=',
      '--before=',
      '--author=',
      '--grep=',
      '--format=',
      '--pretty=format:',
      '--pretty=tformat:',
    ],
    valued: set(
      '-n',
      '--max-count',
      '--since',
      '--after',
      '--until',
      '--before',
      '--author',
      '--grep'
    ),
    counts: true,
  },
  'rev-parse': { exact: set('--abbrev-ref', '--show-toplevel') },
  'ls-files': { exact: set() },
  'ls-tree': { exact: set('-r', '--name-only') },
  describe: { exact: set('--tags', '--always') },
  shortlog: { exact: set('-s', '-n', '-sn', '-ns') },
  'rev-list': { exact: set('--count', '--all') },
  'merge-base': { exact: set() },
  'for-each-ref': {
    exact: set(),
    prefixed: ['--sort=', '--format=', '--count='],
    valued: set('--sort', '--format', '--count'),
  },
  stash: { exact: set() },
  worktree: { exact: set() },
  reflog: { exact: set(), valued: set('-n'), counts: true },
  remote: { exact: set('-v', '--verbose') },
  branch: {
    exact: set(
      '-a',
      '-r',
      '-v',
      '-vv',
      '--all',
      '--list',
      '-l',
      '--show-current',
      '--remotes',
      '--verbose'
    ),
    prefixed: ['--contains=', '--merged=', '--sort='],
    valued: set('--contains', '--merged'),
  },
  tag: {
    exact: set('--list', '-l'),
    prefixed: ['--contains=', '--merged=', '--sort='],
    valued: set('--contains', '--merged'),
  },
}

/** Whether git_read can run a names-only typed command with these arguments. */
function expressible(subcommand: string, args: readonly string[]): boolean {
  const surface = NAMES_ONLY_SURFACES[subcommand]
  // Content subcommands are never redirected, so their flags are not judged.
  if (surface === undefined) return true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') return true
    if (!arg.startsWith('-')) continue
    if (surface.exact.has(arg)) continue
    if (surface.prefixed?.some(prefix => arg.startsWith(prefix))) continue
    if (surface.valued?.has(arg)) {
      if (i + 1 >= args.length) return false
      i++
      continue
    }
    if (surface.bundle?.test(arg)) continue
    if (surface.counts && /^-n?\d+$/.test(arg)) continue
    return false
  }
  return true
}

/**
 * The directory a typed command runs in, as git_read's workspace-relative
 * `directory`, or null when git_read could not take it: an absolute path, a
 * `..` segment, a leading `~` (the shell expands it), quoting or escaping
 * (the shell would rewrite it), or anything git_read's own rule refuses.
 */
function workspaceDirectory(parts: readonly string[]): string | null {
  if (parts.length === 0) return '.'
  if (parts.some(part => part.startsWith('~') || /['"\\]/.test(part))) return null
  const directory = parts.join('/')
  return checkGitReadParams({ subcommand: 'status', directory }).ok ? directory : null
}

/**
 * Matches a typed read-only git command: at most one leading `cd DIR &&`, then
 * `git`, optionally `-C DIR` or `--no-pager` (repeatable), then a read-only
 * subcommand. None of `;`, `|`, `$`, backtick, `<`, `>` or a newline anywhere,
 * and no `&` other than the one after `cd DIR`.
 */
export function matchTypedGitRead(command: string): {
  subcommand: string
  content: boolean
  expressible: boolean
  /** git_read's `directory` for the command, or null when it has none. */
  directory: string | null
} | null {
  if (/[;|$`<>\n\r]/.test(command)) return null
  let rest = command.trim()
  const cd = /^cd\s+([^\s&]+)\s*&&\s*/.exec(rest)
  const directories: string[] = []
  if (cd) {
    rest = rest.slice(cd[0].length)
    directories.push(cd[1])
  }
  if (rest.includes('&')) return null
  const words = rest.split(/\s+/)
  if (words[0] !== 'git') return null
  let i = 1
  while (i < words.length) {
    if (words[i] === '--no-pager') {
      i += 1
    } else if (words[i] === '-C' && i + 1 < words.length) {
      directories.push(words[i + 1])
      i += 2
    } else {
      break
    }
  }
  const subcommand = words[i]
  if (subcommand === undefined || subcommand.startsWith('-')) return null
  const args = words.slice(i + 1)
  if (!readOnly(subcommand, args)) return null
  const content =
    CONTENT_SUBCOMMANDS.has(subcommand) ||
    ((subcommand === 'log' || subcommand === 'reflog') && args.some(logContentArg)) ||
    (subcommand === 'for-each-ref' &&
      args.some(arg => /%\(\*?(raw|contents|body|trailers)/.test(arg)))
  return {
    subcommand,
    content,
    expressible: content || expressible(subcommand, args),
    directory: workspaceDirectory(directories),
  }
}

/**
 * Whether the model followed a redirect: counted on the next model turn's
 * batch (`yes` when it holds a `git_read` call). Fixed labels only.
 */
export const gitRedirectCounter: Counter<'followed'> = (() => {
  const name = 'git_redirect_total'
  const existing = register.getSingleMetric(name)
  if (existing) return existing as Counter<'followed'>
  return new Counter<'followed'>({
    name,
    help: 'Model turns that followed a typed-git redirect with tool calls, by whether the turn called git_read (a final text answer is not counted)',
    labelNames: ['followed'],
    registers: [register],
  })
})()
