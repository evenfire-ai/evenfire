import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { HttpError } from '../errors'
import {
  isPhysicalSubpath,
  pathFromQuery,
  resolveSafePath,
  resolveSafePhysicalPath,
} from '../fs/pathSafety'

const lexicalOpts = { mountRoot: '/workspace', maxDepth: 32 }

let tmpRoot: string
let mountRoot: string
let outsideRoot: string

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'wfc-path-safety-'))
  mountRoot = path.join(tmpRoot, 'workspace')
  outsideRoot = path.join(tmpRoot, 'outside')
  await fs.mkdir(path.join(mountRoot, 'docs'), { recursive: true })
  await fs.mkdir(path.join(outsideRoot, 'docs'), { recursive: true })
  await fs.writeFile(path.join(mountRoot, 'docs', 'runbook.md'), 'inside')
  await fs.writeFile(path.join(outsideRoot, 'victim.txt'), 'outside')
})

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

function opts(mode: 'existing-target' | 'existing-parent') {
  return { mountRoot, maxDepth: 32, mode }
}

describe('resolveSafePath — happy path', () => {
  it.each([
    ['', '/workspace'],
    ['/', '/workspace'],
    ['.', '/workspace'],
    ['notes', '/workspace/notes'],
    ['/notes/2026', '/workspace/notes/2026'],
    ['notes/sub/file.md', '/workspace/notes/sub/file.md'],
    ['./notes', '/workspace/notes'],
  ])('resolveSafePath(%j) = %j', (input, expected) => {
    expect(resolveSafePath(input, lexicalOpts)).toBe(expected)
  })
})

describe('resolveSafePath — rejection table', () => {
  const cases: Array<[string, string]> = [
    ['..', 'traversal'],
    ['notes/..', 'traversal'],
    ['notes/../../etc', 'traversal'],
    ['..\\windows', 'forbidden'],
    ['notes\\windows', 'forbidden'],
    ['notes\0', 'forbidden'],
    ['notes\nbreak', 'forbidden'],
    ['notes\tbreak', 'forbidden'],
  ]

  it.each(cases)('rejects %j', (input, expectedFragment) => {
    expect(() => resolveSafePath(input, lexicalOpts)).toThrow(HttpError)
    try {
      resolveSafePath(input, lexicalOpts)
    } catch (e) {
      expect((e as HttpError).code).toBe('path_invalid')
      expect((e as HttpError).message.toLowerCase()).toContain(expectedFragment)
    }
  })

  it('rejects non-string input', () => {
    expect(() => resolveSafePath(undefined as unknown as string, lexicalOpts)).toThrow(HttpError)
    expect(() => resolveSafePath(null as unknown as string, lexicalOpts)).toThrow(HttpError)
    expect(() => resolveSafePath(42 as unknown as string, lexicalOpts)).toThrow(HttpError)
  })

  it('rejects paths exceeding maxDepth', () => {
    const deep = Array(33).fill('a').join('/')
    expect(() => resolveSafePath(deep, lexicalOpts)).toThrow(/depth/)
  })

  it('allows trailing spaces because Linux PVCs preserve them as distinct filenames', () => {
    expect(resolveSafePath('notes ', lexicalOpts)).toBe('/workspace/notes ')
  })
})

describe('resolveSafePath — escape attempts', () => {
  it('a normalized path that resolves outside the root is rejected', () => {
    // Even if parser misses ".." early, the resolved-prefix check catches it.
    expect(() => resolveSafePath('a/b/../../..', lexicalOpts)).toThrow(HttpError)
  })

  it('different mount root is respected (per-process configurable)', () => {
    expect(resolveSafePath('foo', { mountRoot: '/data', maxDepth: 32 })).toBe('/data/foo')
  })
})

describe('pathFromQuery', () => {
  it('returns "" for missing/empty', () => {
    expect(pathFromQuery(undefined)).toBe('')
    expect(pathFromQuery(null)).toBe('')
  })

  it('returns the string when a single value is given', () => {
    expect(pathFromQuery('notes/x.md')).toBe('notes/x.md')
  })

  it('rejects an array of values (Express duplicates ?path=A&path=B as an array)', () => {
    expect(() => pathFromQuery(['a', 'b'] as unknown)).toThrow(HttpError)
  })
})

describe('resolveSafePhysicalPath', () => {
  it('accepts the mount root and a normal nested in-mount path', async () => {
    const root = await resolveSafePhysicalPath('', opts('existing-target'))
    expect(root.absPath).toBe(mountRoot)

    const nested = await resolveSafePhysicalPath('docs/runbook.md', opts('existing-target'))
    expect(nested.absPath).toBe(path.join(mountRoot, 'docs', 'runbook.md'))
  })

  it('rejects a symlinked first component', async () => {
    await fs.symlink(outsideRoot, path.join(mountRoot, 'linkdir'))

    await expect(resolveSafePhysicalPath('linkdir/victim.txt', opts('existing-target'))).rejects
      .toMatchObject({ code: 'path_invalid' })
  })

  it('rejects a nested symlinked ancestor', async () => {
    await fs.symlink(outsideRoot, path.join(mountRoot, 'docs', 'linkdir'))

    await expect(resolveSafePhysicalPath('docs/linkdir/victim.txt', opts('existing-target')))
      .rejects.toMatchObject({ code: 'path_invalid' })
  })

  it('distinguishes existing-target missing leaves from existing-parent create paths', async () => {
    await expect(resolveSafePhysicalPath('docs/missing.md', opts('existing-target'))).rejects
      .toMatchObject({ code: 'ENOENT' })

    const createPath = await resolveSafePhysicalPath('docs/missing.md', opts('existing-parent'))
    expect(createPath.absPath).toBe(path.join(mountRoot, 'docs', 'missing.md'))
  })

  it('uses strict physical root containment, not plain string prefix matching', () => {
    expect(isPhysicalSubpath('/tmp/workspace', '/tmp/workspace')).toBe(true)
    expect(isPhysicalSubpath('/tmp/workspace/docs', '/tmp/workspace')).toBe(true)
    expect(isPhysicalSubpath('/tmp/workspace-evil/docs', '/tmp/workspace')).toBe(false)
  })
})
