import { describe, expect, it } from 'vitest'
import {
  GIT_READ_DEFINITION,
  GIT_READ_FOR_EACH_REF_FORMAT_TEXT,
  GIT_READ_VALIDATION_TEXTS,
  checkGitReadParams,
  gitReadFileReads,
  gitReadReturnsContent,
  validateGitReadParams,
} from '../definition'
import { checkForEachRefFormat, checkRevisionWord } from '../protectedContent'

function category(params: Record<string, unknown>): string | null {
  const check = checkGitReadParams(params)
  return check.ok ? null : check.category
}

describe('git_read definition', () => {
  it('fits the 2,048-byte native definition budget', () => {
    const bytes = Buffer.byteLength(JSON.stringify(GIT_READ_DEFINITION), 'utf8')
    expect(bytes).toBe(1743)
    expect(bytes).toBeLessThanOrEqual(2048)
  })
})

describe('validateGitReadParams', () => {
  it('returns one fixed text and never echoes the input', () => {
    const result = validateGitReadParams({ subcommand: 'log', revisions: ['--output=/tmp/SECRET'] })
    expect(result).toEqual({ is_valid: false, errors: [GIT_READ_VALIDATION_TEXTS.bad_revision] })
    expect(result.errors.join('')).not.toContain('SECRET')
    expect(validateGitReadParams({ subcommand: 'status' })).toEqual({ is_valid: true, errors: [] })
  })

  it('refuses options and fields on subcommands that do not map them', () => {
    expect(category({ subcommand: 'status', options: ['patch'] })).toBe('option_not_supported')
    expect(category({ subcommand: 'log', options: ['cached'] })).toBe('option_not_supported')
    expect(category({ subcommand: 'ls_tree', options: ['stat'] })).toBe('option_not_supported')
    expect(category({ subcommand: 'show', since: 'yesterday' })).toBe('option_not_supported')
    expect(category({ subcommand: 'diff', format: '%H' })).toBe('option_not_supported')
    expect(category({ subcommand: 'branch', paths: ['x'] })).toBe('option_not_supported')
    expect(category({ subcommand: 'log', output: 'x' })).toBe('option_not_supported')
    expect(category({ subcommand: 'push' })).toBe('option_not_supported')
    expect(category({ subcommand: 'log', options: ['--output=x'] })).toBe('option_not_supported')
    expect(category({ subcommand: 'grep' })).toBe('option_not_supported')
    expect(category({ subcommand: 'branch', options: ['show_current', 'all'] })).toBe(
      'option_not_supported'
    )
    expect(category({ subcommand: 'branch', options: ['show_current'], pattern: 'x' })).toBe(
      'option_not_supported'
    )
    expect(
      category({ subcommand: 'remote', options: ['get_url', 'verbose'], revisions: ['origin'] })
    ).toBe('option_not_supported')
  })

  it('an explicit null counts as absent', () => {
    expect(
      category({ subcommand: 'status', revisions: null, paths: null, format: null, output: null })
    ).toBeNull()
  })

  it('revision words: no leading dash, whitespace, NUL, or more than 8', () => {
    expect(category({ subcommand: 'log', revisions: ['--output=x'] })).toBe('bad_revision')
    expect(category({ subcommand: 'log', revisions: ['HEAD x'] })).toBe('bad_revision')
    expect(category({ subcommand: 'log', revisions: ['HEAD\nx'] })).toBe('bad_revision')
    expect(category({ subcommand: 'log', revisions: Array(9).fill('HEAD') })).toBe('bad_revision')
    expect(category({ subcommand: 'log', revisions: ['HEAD~1', '@{u}..HEAD', 'a...b'] })).toBeNull()
    expect(category({ subcommand: 'status', revisions: ['HEAD'] })).toBe('bad_revision')
    expect(category({ subcommand: 'cat_file' })).toBe('bad_revision')
    expect(category({ subcommand: 'merge_base', revisions: ['HEAD'] })).toBe('bad_revision')
    expect(category({ subcommand: 'remote', revisions: ['origin'] })).toBe('bad_revision')
    expect(category({ subcommand: 'remote', options: ['get_url'], revisions: ['a/b'] })).toBe(
      'bad_revision'
    )
  })

  it('REV:PATH: only show and cat_file, no braces, no :/ or :!, no ./ or ../, unprotected', () => {
    expect(category({ subcommand: 'show', revisions: ['HEAD:a.txt'] })).toBeNull()
    expect(category({ subcommand: 'cat_file', revisions: [':0:a.txt'] })).toBeNull()
    expect(category({ subcommand: 'show', revisions: [':a.txt'] })).toBeNull()
    expect(category({ subcommand: 'grep', pattern: 'x', revisions: ['HEAD:sub'] })).toBe(
      'bad_revision'
    )
    expect(category({ subcommand: 'rev_parse', revisions: ['HEAD:state.db'] })).toBe('bad_revision')
    expect(category({ subcommand: 'show', revisions: ['stash@{0}:a.txt'] })).toBe('bad_revision')
    expect(category({ subcommand: 'show', revisions: ['HEAD^{tree}:state.db'] })).toBe(
      'bad_revision'
    )
    expect(category({ subcommand: 'show', revisions: [':/needle'] })).toBe('bad_revision')
    expect(category({ subcommand: 'show', revisions: [':!x'] })).toBe('bad_revision')
    expect(category({ subcommand: 'show', revisions: ['HEAD:./state.db'] })).toBe('bad_path')
    expect(category({ subcommand: 'show', revisions: ['HEAD:../x'] })).toBe('bad_path')
    expect(category({ subcommand: 'show', revisions: ['HEAD:/etc/passwd'] })).toBe('bad_path')
    expect(category({ subcommand: 'show', revisions: ['HEAD:'] })).toBe('bad_path')
    expect(category({ subcommand: 'show', revisions: ['HEAD:a//b'] })).toBe('bad_path')
    for (const revision of [
      'HEAD:state.db',
      ':state.db',
      ':0:state.db',
      'C2:.clerum-state/tok.txt',
      'side:.clerum-outputs/side.txt',
      'HEAD:sub/state.db-wal',
      'HEAD:x/.gfs-downloads.trash-1/a',
    ]) {
      expect(checkRevisionWord(revision, 'show')).toBe('protected_path')
    }
  })

  it('paths and directory: workspace-relative, no .., not protected', () => {
    for (const bad of ['', '-x', ':(literal)state.db', '/etc', '../x', 'a/../b', 'a\nb']) {
      expect(category({ subcommand: 'log', paths: [bad] })).toBe('bad_path')
    }
    expect(category({ subcommand: 'log', paths: Array(33).fill('a') })).toBe('bad_path')
    expect(category({ subcommand: 'log', paths: ['state.db'] })).toBe('protected_path')
    expect(category({ subcommand: 'log', paths: ['.clerum-state/x'] })).toBe('protected_path')
    expect(category({ subcommand: 'log', directory: '.clerum-outputs' })).toBe('protected_path')
    expect(category({ subcommand: 'log', directory: 'sub', paths: ['state.db-wal'] })).toBe(
      'protected_path'
    )
    expect(category({ subcommand: 'log', directory: '../up' })).toBe('bad_path')
    expect(category({ subcommand: 'log', directory: '/abs' })).toBe('bad_path')
    expect(category({ subcommand: 'log', directory: './sub', paths: ['*.py'] })).toBeNull()
    expect(category({ subcommand: 'blame' })).toBe('bad_path')
    expect(category({ subcommand: 'blame', paths: ['a', 'b'] })).toBe('bad_path')
  })

  it('string fields: at most 256 bytes, no newline; integers in range', () => {
    expect(category({ subcommand: 'log', pickaxe: 'a\nb' })).toBe('bad_value')
    expect(category({ subcommand: 'log', author: 'x'.repeat(257) })).toBe('bad_value')
    expect(category({ subcommand: 'log', author: 'x'.repeat(256) })).toBeNull()
    expect(category({ subcommand: 'log', unified: 101 })).toBe('bad_value')
    expect(category({ subcommand: 'log', max_count: 0 })).toBe('bad_value')
    expect(category({ subcommand: 'log', max_count: 1.5 })).toBe('bad_value')
    expect(category({ subcommand: 'branch', sort: 'objectsize' })).toBe('bad_value')
    expect(category({ subcommand: 'blame', paths: ['a'], line_range: '10' })).toBe('bad_value')
    expect(category({ subcommand: 'blame', paths: ['a'], line_range: '10,-2' })).toBe('bad_value')
    expect(category({ subcommand: 'blame', paths: ['a'], line_range: '10,+2' })).toBeNull()
    expect(category({ subcommand: 'tag', contains: '-x' })).toBe('bad_revision')
    expect(category({ subcommand: 'tag', merged: 'HEAD:a' })).toBe('bad_revision')
  })

  it('follow needs exactly one path', () => {
    expect(category({ subcommand: 'log', options: ['follow'] })).toBe('option_not_supported')
    expect(category({ subcommand: 'log', options: ['follow'], paths: ['a', 'b'] })).toBe(
      'option_not_supported'
    )
    expect(category({ subcommand: 'log', options: ['follow'], paths: ['a'] })).toBeNull()
  })

  it('log and show formats refuse signature placeholders', () => {
    expect(category({ subcommand: 'log', format: '%h %G?' })).toBe('bad_format')
    expect(category({ subcommand: 'show', format: '%(signature)' })).toBe('bad_format')
    for (const format of ['%+G?', '%-G?', '% G?', '%+GS', '%h %-GK']) {
      expect(category({ subcommand: 'log', format })).toBe('bad_format')
    }
    expect(category({ subcommand: 'log', format: '%h %N' })).toBeNull()
  })

  it('for_each_ref formats use only the atom allowlist', () => {
    for (const format of [
      '%(raw)',
      '%(*raw)',
      '%(contents)',
      '%(contents:body)',
      '%(body)',
      '%(trailers)',
      '%(describe)',
      '%(if)x%(then)y%(end)',
      '%(refname:lstrip=%(raw))',
      '%(objectname',
      '%G',
      '100%',
    ]) {
      expect(checkForEachRefFormat(format)).toBe(false)
    }
    expect(validateGitReadParams({ subcommand: 'for_each_ref', format: '%(raw)' })).toEqual({
      is_valid: false,
      errors: [GIT_READ_FOR_EACH_REF_FORMAT_TEXT],
    })
    for (const format of [
      '%(objectname) %(objecttype) %(refname)',
      '%(refname:short) %(refname:lstrip=2) %(refname:rstrip=-1)',
      '%(*subject) %(contents:subject) %(*contents:subject)',
      '%(authordate:iso-strict) %(committerdate) %(creatordate:unix) %(taggerdate:relative)',
      '%(upstream:track) %(push:short) %(HEAD) %(symref) %(objectsize)',
      '%(authorname) <%(authoremail)> %(creator)',
      '100%% %09 literal',
    ]) {
      expect(checkForEachRefFormat(format)).toBe(true)
    }
  })
})

describe('gitReadReturnsContent', () => {
  it('is false only for valid names-only calls; an invalid call counts as content', () => {
    expect(gitReadReturnsContent({ subcommand: 'status' })).toBe(false)
    expect(gitReadReturnsContent({ subcommand: 'log', options: ['stat'] })).toBe(false)
    expect(gitReadReturnsContent({ subcommand: 'show' })).toBe(true)
    expect(gitReadReturnsContent({ subcommand: 'log', options: ['patch'] })).toBe(true)
    expect(gitReadReturnsContent({ subcommand: 'status', revisions: ['--output=x'] })).toBe(true)
    expect(gitReadReturnsContent({ subcommand: 'push' })).toBe(true)
  })
})

describe('gitReadFileReads', () => {
  it('names-only calls declare no reads', () => {
    for (const params of [
      { subcommand: 'status' },
      { subcommand: 'log', options: ['oneline', 'stat'] },
      { subcommand: 'ls_files' },
      { subcommand: 'ls_tree', options: ['recursive'] },
      { subcommand: 'for_each_ref', format: '%(refname)' },
      { subcommand: 'branch' },
    ]) {
      expect(gitReadFileReads(params)).toBeUndefined()
    }
  })

  it('content calls with literal paths declare those paths and their subtrees', () => {
    expect(gitReadFileReads({ subcommand: 'log', options: ['patch'], paths: ['pub'] })).toEqual({
      paths: ['pub'],
      subtrees: true,
    })
    expect(
      gitReadFileReads({ subcommand: 'diff', directory: 'svc', paths: ['src', 'README.md'] })
    ).toEqual({ paths: ['svc/src', 'svc/README.md'], subtrees: true })
    expect(gitReadFileReads({ subcommand: 'blame', paths: ['a.txt'] })).toEqual({
      paths: ['a.txt'],
      subtrees: true,
    })
  })

  it('any other content call reads the whole workspace', () => {
    for (const params of [
      { subcommand: 'grep', pattern: 'x' },
      { subcommand: 'grep', pattern: 'x', paths: ['*.py'] },
      // git reads `pub/s\\ecret` as a glob that matches `pub/secret`.
      { subcommand: 'log', options: ['patch'], paths: ['pub/s\\ecret'] },
      { subcommand: 'show' },
      { subcommand: 'show', revisions: ['HEAD:a.txt'] },
      { subcommand: 'cat_file', revisions: ['HEAD'] },
      { subcommand: 'diff' },
      { subcommand: 'log', options: ['patch', 'follow'], paths: ['notes.txt'] },
      { subcommand: 'log', pickaxe: 'needle' },
      { subcommand: 'log', unified: 0 },
      { subcommand: 'log', options: ['word_diff'] },
    ]) {
      expect(gitReadFileReads(params)).toEqual({ paths: ['.'], wholeWorkspace: true })
    }
  })
})
