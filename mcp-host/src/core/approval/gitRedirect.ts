/**
 * The typed-git redirect: in auto mode, a typed read-only `git` shell command
 * that would be classified or carded gets a fixed result telling the model to
 * use `git_read` instead. Nothing runs. Each distinct command text is
 * redirected once per task; sending the same text again takes today's path.
 */
import { Counter, register } from 'prom-client'

/** The fixed result of a redirected call. */
export const GIT_REDIRECT_TEXT =
  'Not run. In auto approval mode, read-only git runs without asking through the git_read tool. Call git_read with the equivalent subcommand and options. To run this exact command in the shell instead, send it again; the user may be asked to approve it.'

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

/** `branch` / `tag` options that only list refs. */
const LIST_FLAGS: ReadonlySet<string> = new Set([
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
/** List filters that take a value as the next word. */
const LIST_FILTERS: ReadonlySet<string> = new Set(['--contains', '--merged', '--no-merged'])

function listsRefsOnly(args: readonly string[]): boolean {
  let listMode = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (LIST_FLAGS.has(arg)) {
      if (arg === '--list' || arg === '-l') listMode = true
      continue
    }
    if (LIST_FILTERS.has(arg)) {
      if (i + 1 >= args.length) return false
      i++
      listMode = true
      continue
    }
    if (/^--(?:contains|merged|no-merged|sort)=/.test(arg)) {
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
    case 'tag':
      return listsRefsOnly(args)
    default:
      return false
  }
}

/**
 * Matches a typed read-only git command: at most one leading `cd DIR &&`, then
 * `git`, optionally `-C DIR` or `--no-pager` (repeatable), then a read-only
 * subcommand. None of `;`, `|`, `$`, backtick, `<`, `>` or a newline anywhere,
 * and no `&` other than the one after `cd DIR`.
 */
export function matchTypedGitRead(command: string): { subcommand: string } | null {
  if (/[;|$`<>\n\r]/.test(command)) return null
  let rest = command.trim()
  const cd = /^cd\s+\S+\s*&&\s*/.exec(rest)
  if (cd) rest = rest.slice(cd[0].length)
  if (rest.includes('&')) return null
  const words = rest.split(/\s+/)
  if (words[0] !== 'git') return null
  let i = 1
  while (i < words.length) {
    if (words[i] === '--no-pager') {
      i += 1
    } else if (words[i] === '-C' && i + 1 < words.length) {
      i += 2
    } else {
      break
    }
  }
  const subcommand = words[i]
  if (subcommand === undefined || subcommand.startsWith('-')) return null
  return readOnly(subcommand, words.slice(i + 1)) ? { subcommand } : null
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
    help: 'Typed read-only git shell commands redirected to git_read, by whether the next turn called git_read',
    labelNames: ['followed'],
    registers: [register],
  })
})()
