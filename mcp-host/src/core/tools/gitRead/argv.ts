/**
 * Fixed argv templates for `git_read` (design §2.3.3). Every subcommand that
 * can return content gets `--no-textconv` (and `--no-ext-diff` where git
 * accepts it), and the content calls get the protected-path exclusions after
 * the model's paths, so a model pathspec can never re-include them.
 *
 * `--end-of-options` is used where git accepts it; `blame`, `grep`,
 * `rev-parse` and `ls-tree` do not, and the revision pattern (no leading `-`)
 * is the guard there.
 */
import type { GitReadParams } from './definition'
import { isContentCall, protectedExcludePathspecs } from './protectedContent'

const NO_TEXTCONV = ['--no-textconv', '--no-ext-diff'] as const
// `--all` never walks notes: a note can be made from a protected blob, and a
// notes commit's paths are commit ids that no exclusion pathspec matches.

/** `log` and `reflog` without `max_count` show this many entries. */
export const GIT_READ_DEFAULT_MAX_COUNT = 50

function flag(on: boolean, ...args: string[]): string[] {
  return on ? args : []
}

function value(prefix: string, field: string | number | undefined): string[] {
  return field === undefined ? [] : [`${prefix}${field}`]
}

function logArgv(p: GitReadParams): string[] {
  const o = p.options
  const content = isContentCall(p)
  const follow = o.has('follow')
  return [
    'log',
    ...NO_TEXTCONV,
    '--no-notes',
    '-n',
    String(p.maxCount ?? GIT_READ_DEFAULT_MAX_COUNT),
    ...flag(o.has('oneline'), '--oneline'),
    ...flag(o.has('patch'), '-p'),
    ...flag(o.has('stat'), '--stat'),
    ...flag(o.has('name_only'), '--name-only'),
    ...flag(o.has('name_status'), '--name-status'),
    ...flag(o.has('graph'), '--graph'),
    ...flag(o.has('all'), '--exclude=refs/notes/*', '--all'),
    ...flag(follow, '--follow'),
    ...flag(o.has('word_diff'), '--word-diff=plain'),
    ...value('-U', p.unified),
    ...value('--since=', p.since),
    ...value('--until=', p.until),
    ...value('--author=', p.author),
    ...value('--grep=', p.grep),
    ...value('-S', p.pickaxe),
    ...value('--format=', p.format),
    ...flag(content, '--ignore-submodules=all'),
    '--end-of-options',
    ...p.revisions,
    '--',
    ...p.paths,
    // git refuses --follow with more than one pathspec; the follow check guards it.
    ...(content && !follow ? protectedExcludePathspecs() : []),
  ]
}

/** The argv for one validated call (without the `git` binary). */
export function buildGitReadArgv(p: GitReadParams): string[] {
  const o = p.options
  const excl = protectedExcludePathspecs()
  switch (p.subcommand) {
    case 'status':
      return [
        'status',
        ...flag(o.has('short'), '--short'),
        ...flag(o.has('branch'), '--branch'),
        ...flag(o.has('porcelain'), '--porcelain=v1'),
        '--ignore-submodules=all',
        '--',
        ...p.paths,
      ]
    case 'log':
      return logArgv(p)
    case 'show':
      return [
        'show',
        ...NO_TEXTCONV,
        '--no-notes',
        ...flag(o.has('stat'), '--stat'),
        ...flag(o.has('name_only'), '--name-only'),
        ...flag(o.has('name_status'), '--name-status'),
        ...value('--format=', p.format),
        '--end-of-options',
        ...p.revisions,
        '--',
        ...p.paths,
        ...excl,
      ]
    case 'diff':
      return [
        'diff',
        ...NO_TEXTCONV,
        ...flag(o.has('cached'), '--cached'),
        ...flag(o.has('stat'), '--stat'),
        ...flag(o.has('name_only'), '--name-only'),
        ...flag(o.has('name_status'), '--name-status'),
        ...flag(o.has('word_diff'), '--word-diff=plain'),
        ...value('-U', p.unified),
        '--ignore-submodules=all',
        '--end-of-options',
        ...p.revisions,
        '--',
        ...p.paths,
        ...excl,
      ]
    case 'blame':
      return [
        'blame',
        '--no-textconv',
        ...(p.lineRange !== undefined ? ['-L', p.lineRange] : []),
        ...p.revisions,
        '--',
        p.paths[0],
      ]
    case 'grep':
      return [
        'grep',
        '--no-textconv',
        ...flag(o.has('line_number'), '-n'),
        ...flag(o.has('ignore_case'), '-i'),
        ...flag(o.has('count'), '-c'),
        '-e',
        p.pattern as string,
        ...p.revisions,
        '--',
        ...p.paths,
        ...excl,
      ]
    case 'branch':
      if (o.has('show_current')) return ['branch', '--show-current']
      return [
        'branch',
        '--list',
        ...flag(o.has('all'), '-a'),
        ...flag(o.has('remotes'), '-r'),
        ...flag(o.has('verbose'), '-vv'),
        ...value('--contains=', p.contains),
        ...value('--merged=', p.merged),
        ...value('--sort=', p.sort),
        '--end-of-options',
        ...(p.pattern !== undefined ? [p.pattern] : []),
      ]
    case 'tag':
      return [
        'tag',
        '--list',
        ...value('--contains=', p.contains),
        ...value('--merged=', p.merged),
        ...value('--sort=', p.sort),
        '--end-of-options',
        ...(p.pattern !== undefined ? [p.pattern] : []),
      ]
    case 'rev_parse':
      return [
        'rev-parse',
        ...flag(o.has('abbrev_ref'), '--abbrev-ref'),
        ...flag(o.has('show_toplevel'), '--show-toplevel'),
        ...p.revisions,
        // A word that is not a revision is then refused, never looked up as a path.
        '--',
      ]
    case 'ls_files':
      return ['ls-files', '--', ...p.paths]
    case 'ls_tree':
      return [
        'ls-tree',
        ...flag(o.has('recursive'), '-r'),
        ...flag(o.has('name_only'), '--name-only'),
        p.revisions[0] ?? 'HEAD',
        '--',
        ...p.paths,
      ]
    case 'describe':
      return [
        'describe',
        ...flag(o.has('tags'), '--tags'),
        ...flag(o.has('always'), '--always'),
        '--end-of-options',
        ...p.revisions,
      ]
    case 'stash_list':
      return ['stash', 'list']
    case 'shortlog':
      // shortlog reads stdin without a revision.
      return ['shortlog', '-s', '-n', '--end-of-options', p.revisions[0] ?? 'HEAD', '--']
    case 'rev_list':
      return [
        'rev-list',
        '--count',
        ...flag(o.has('all'), '--exclude=refs/notes/*', '--all'),
        '--end-of-options',
        ...p.revisions,
        '--',
      ]
    case 'merge_base':
      return ['merge-base', '--end-of-options', ...p.revisions]
    case 'cat_file':
      return ['cat-file', '-p', '--end-of-options', p.revisions[0]]
    case 'reflog':
      return [
        'reflog',
        'show',
        ...NO_TEXTCONV,
        '--no-notes',
        '-n',
        String(p.maxCount ?? GIT_READ_DEFAULT_MAX_COUNT),
        '--end-of-options',
        ...p.revisions,
        '--',
      ]
    case 'for_each_ref':
      return [
        'for-each-ref',
        ...value('--sort=', p.sort),
        ...value('--format=', p.format),
        ...value('--count=', p.maxCount),
        '--end-of-options',
        ...(p.pattern !== undefined ? [p.pattern] : []),
      ]
    case 'worktree_list':
      return ['worktree', 'list']
    case 'remote':
      if (o.has('get_url')) return ['remote', 'get-url', '--end-of-options', p.revisions[0]]
      return ['remote', '-v']
  }
}
