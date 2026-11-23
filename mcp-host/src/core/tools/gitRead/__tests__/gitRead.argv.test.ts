import { describe, expect, it } from 'vitest'
import { buildGitReadArgv } from '../argv'
import { checkGitReadParams } from '../definition'
import { protectedExcludePathspecs } from '../protectedContent'

const EXCL = [
  ':(exclude,top,glob)**/.clerum-state',
  ':(exclude,top,glob)**/.clerum-state/**',
  ':(exclude,top,glob)**/.gfs-download-store',
  ':(exclude,top,glob)**/.gfs-download-store/**',
  ':(exclude,top,glob)**/.gfs-downloads',
  ':(exclude,top,glob)**/.gfs-downloads/**',
  ':(exclude,top,glob)**/.clerum-outputs',
  ':(exclude,top,glob)**/.clerum-outputs/**',
  ':(exclude,top,glob)**/.gfs-download-store.retired-*',
  ':(exclude,top,glob)**/.gfs-download-store.retired-*/**',
  ':(exclude,top,glob)**/.gfs-downloads.trash-*',
  ':(exclude,top,glob)**/.gfs-downloads.trash-*/**',
  ':(exclude,top,glob)**/state.db*',
]

function argv(params: Record<string, unknown>): string[] {
  const check = checkGitReadParams(params)
  if (!check.ok) throw new Error(`invalid: ${check.category}`)
  return buildGitReadArgv(check.params)
}

describe('git_read argv templates', () => {
  it('the exclusion pathspecs are the 13 literal entries', () => {
    expect(protectedExcludePathspecs()).toEqual(EXCL)
  })

  it('status, with every option', () => {
    expect(argv({ subcommand: 'status' })).toEqual(['status', '--ignore-submodules=all', '--'])
    expect(
      argv({ subcommand: 'status', options: ['short', 'branch', 'porcelain'], paths: ['src'] })
    ).toEqual([
      'status',
      '--short',
      '--branch',
      '--porcelain=v1',
      '--ignore-submodules=all',
      '--',
      'src',
    ])
  })

  it('log without content options has no exclusions and a default count of 50', () => {
    expect(argv({ subcommand: 'log', options: ['oneline'] })).toEqual([
      'log',
      '--no-textconv',
      '--no-ext-diff',
      '--no-notes',
      '-n',
      '50',
      '--oneline',
      '--end-of-options',
      '--',
    ])
    expect(
      argv({
        subcommand: 'log',
        max_count: 7,
        options: ['stat', 'name_only', 'graph', 'all'],
        since: '2 weeks ago',
        until: 'yesterday',
        author: 'dev',
        grep: 'fix',
        format: '%h %s',
        revisions: ['main..HEAD'],
        paths: ['src'],
      })
    ).toEqual([
      'log',
      '--no-textconv',
      '--no-ext-diff',
      '--no-notes',
      '-n',
      '7',
      '--stat',
      '--name-only',
      '--graph',
      '--all',
      '--since=2 weeks ago',
      '--until=yesterday',
      '--author=dev',
      '--grep=fix',
      '--format=%h %s',
      '--end-of-options',
      'main..HEAD',
      '--',
      'src',
    ])
  })

  it('log content calls get the exclusions and --ignore-submodules=all', () => {
    expect(argv({ subcommand: 'log', options: ['patch'], paths: ['a.txt'] })).toEqual([
      'log',
      '--no-textconv',
      '--no-ext-diff',
      '--no-notes',
      '-n',
      '50',
      '-p',
      '--ignore-submodules=all',
      '--end-of-options',
      '--',
      'a.txt',
      ...EXCL,
    ])
    expect(argv({ subcommand: 'log', options: ['word_diff', 'name_status'], unified: 0 })).toEqual([
      'log',
      '--no-textconv',
      '--no-ext-diff',
      '--no-notes',
      '-n',
      '50',
      '--name-status',
      '--word-diff=plain',
      '-U0',
      '--ignore-submodules=all',
      '--end-of-options',
      '--',
      ...EXCL,
    ])
    expect(argv({ subcommand: 'log', pickaxe: 'needle' })).toEqual([
      'log',
      '--no-textconv',
      '--no-ext-diff',
      '--no-notes',
      '-n',
      '50',
      '-Sneedle',
      '--ignore-submodules=all',
      '--end-of-options',
      '--',
      ...EXCL,
    ])
  })

  it('log --follow takes its one path without exclusions (git allows one pathspec)', () => {
    expect(argv({ subcommand: 'log', options: ['patch', 'follow'], paths: ['a.txt'] })).toEqual([
      'log',
      '--no-textconv',
      '--no-ext-diff',
      '--no-notes',
      '-n',
      '50',
      '-p',
      '--follow',
      '--ignore-submodules=all',
      '--end-of-options',
      '--',
      'a.txt',
    ])
  })

  it('show and diff always get the exclusions', () => {
    expect(argv({ subcommand: 'show', revisions: ['HEAD:a.txt'] })).toEqual([
      'show',
      '--no-textconv',
      '--no-ext-diff',
      '--no-notes',
      '--end-of-options',
      'HEAD:a.txt',
      '--',
      ...EXCL,
    ])
    expect(
      argv({ subcommand: 'show', options: ['stat', 'name_only', 'name_status'], format: '%H' })
    ).toEqual([
      'show',
      '--no-textconv',
      '--no-ext-diff',
      '--no-notes',
      '--stat',
      '--name-only',
      '--name-status',
      '--format=%H',
      '--end-of-options',
      '--',
      ...EXCL,
    ])
    expect(argv({ subcommand: 'diff', revisions: ['HEAD~1'] })).toEqual([
      'diff',
      '--no-textconv',
      '--no-ext-diff',
      '--ignore-submodules=all',
      '--end-of-options',
      'HEAD~1',
      '--',
      ...EXCL,
    ])
    expect(
      argv({
        subcommand: 'diff',
        options: ['cached', 'stat', 'name_only', 'name_status', 'word_diff'],
        unified: 5,
        paths: ['src'],
      })
    ).toEqual([
      'diff',
      '--no-textconv',
      '--no-ext-diff',
      '--cached',
      '--stat',
      '--name-only',
      '--name-status',
      '--word-diff=plain',
      '-U5',
      '--ignore-submodules=all',
      '--end-of-options',
      '--',
      'src',
      ...EXCL,
    ])
  })

  it('blame and grep: no --end-of-options, --no-textconv, grep with exclusions', () => {
    expect(argv({ subcommand: 'blame', paths: ['a.txt'] })).toEqual([
      'blame',
      '--no-textconv',
      '--',
      'a.txt',
    ])
    expect(
      argv({ subcommand: 'blame', paths: ['a.txt'], line_range: '10,+5', revisions: ['HEAD~2'] })
    ).toEqual(['blame', '--no-textconv', '-L', '10,+5', 'HEAD~2', '--', 'a.txt'])
    expect(
      argv({
        subcommand: 'grep',
        pattern: '-e',
        options: ['line_number', 'ignore_case', 'count'],
        revisions: ['HEAD'],
        paths: ['*.py'],
      })
    ).toEqual([
      'grep',
      '--no-textconv',
      '-n',
      '-i',
      '-c',
      '-e',
      '-e',
      'HEAD',
      '--',
      '*.py',
      ...EXCL,
    ])
  })

  it('ref listings put the pattern after --end-of-options', () => {
    expect(
      argv({
        subcommand: 'branch',
        options: ['all', 'remotes', 'verbose'],
        contains: 'abc',
        merged: 'main',
        sort: '-committerdate',
        pattern: '--delete',
      })
    ).toEqual([
      'branch',
      '--list',
      '-a',
      '-r',
      '-vv',
      '--contains=abc',
      '--merged=main',
      '--sort=-committerdate',
      '--end-of-options',
      '--delete',
    ])
    expect(argv({ subcommand: 'branch', options: ['show_current'] })).toEqual([
      'branch',
      '--show-current',
    ])
    expect(argv({ subcommand: 'tag', pattern: 'v1.*', sort: 'version:refname' })).toEqual([
      'tag',
      '--list',
      '--sort=version:refname',
      '--end-of-options',
      'v1.*',
    ])
    expect(
      argv({
        subcommand: 'for_each_ref',
        sort: '-committerdate',
        format: '%(refname:short)',
        max_count: 3,
        pattern: 'refs/heads/',
      })
    ).toEqual([
      'for-each-ref',
      '--sort=-committerdate',
      '--format=%(refname:short)',
      '--count=3',
      '--end-of-options',
      'refs/heads/',
    ])
  })

  it('the remaining subcommands', () => {
    expect(
      argv({
        subcommand: 'rev_parse',
        options: ['abbrev_ref', 'show_toplevel'],
        revisions: ['HEAD'],
      })
    ).toEqual(['rev-parse', '--abbrev-ref', '--show-toplevel', 'HEAD'])
    expect(argv({ subcommand: 'ls_files', paths: ['src'] })).toEqual(['ls-files', '--', 'src'])
    expect(argv({ subcommand: 'ls_tree', options: ['recursive', 'name_only'] })).toEqual([
      'ls-tree',
      '-r',
      '--name-only',
      'HEAD',
      '--',
    ])
    expect(argv({ subcommand: 'describe', options: ['tags', 'always'] })).toEqual([
      'describe',
      '--tags',
      '--always',
      '--end-of-options',
    ])
    expect(argv({ subcommand: 'stash_list' })).toEqual(['stash', 'list'])
    expect(argv({ subcommand: 'shortlog' })).toEqual([
      'shortlog',
      '-s',
      '-n',
      '--end-of-options',
      'HEAD',
    ])
    expect(argv({ subcommand: 'rev_list', options: ['all'] })).toEqual([
      'rev-list',
      '--count',
      '--all',
      '--end-of-options',
    ])
    expect(argv({ subcommand: 'merge_base', revisions: ['HEAD', 'main'] })).toEqual([
      'merge-base',
      '--end-of-options',
      'HEAD',
      'main',
    ])
    expect(argv({ subcommand: 'cat_file', revisions: ['HEAD'] })).toEqual([
      'cat-file',
      '-p',
      '--end-of-options',
      'HEAD',
    ])
    expect(argv({ subcommand: 'reflog', max_count: 5 })).toEqual([
      'reflog',
      'show',
      '--no-textconv',
      '--no-ext-diff',
      '--no-notes',
      '-n',
      '5',
      '--end-of-options',
    ])
    expect(argv({ subcommand: 'worktree_list' })).toEqual(['worktree', 'list'])
    expect(argv({ subcommand: 'remote' })).toEqual(['remote', '-v'])
    expect(argv({ subcommand: 'remote', options: ['get_url'], revisions: ['origin'] })).toEqual([
      'remote',
      'get-url',
      '--end-of-options',
      'origin',
    ])
  })
})
