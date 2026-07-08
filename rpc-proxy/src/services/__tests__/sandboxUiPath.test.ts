import { describe, expect, it } from 'vitest'
import { normalizeViewPath } from '../sandboxUiPath.js'

describe('normalizeViewPath', () => {
  it('returns "/" for an empty tail', () => {
    expect(normalizeViewPath('')).toBe('/')
  })

  it('passes a simple absolute path through', () => {
    expect(normalizeViewPath('foo/bar')).toBe('/foo/bar')
  })

  it('preserves a trailing slash', () => {
    expect(normalizeViewPath('foo/')).toBe('/foo/')
  })

  it('collapses single dots', () => {
    expect(normalizeViewPath('./foo/./bar')).toBe('/foo/bar')
  })

  it('collapses repeated slashes', () => {
    expect(normalizeViewPath('foo//bar///baz')).toBe('/foo/bar/baz')
  })

  it('resolves a `..` that stays inside the root', () => {
    expect(normalizeViewPath('foo/bar/../baz')).toBe('/foo/baz')
  })

  it('rejects a path that escapes via `..`', () => {
    expect(normalizeViewPath('../etc/passwd')).toBeNull()
  })

  it('rejects a path that escapes via percent-encoded `..`', () => {
    expect(normalizeViewPath('%2e%2e/etc/passwd')).toBeNull()
  })

  it('rejects a path with an embedded literal NUL', () => {
    expect(normalizeViewPath('foo\x00bar')).toBeNull()
  })

  it('rejects a path with %00', () => {
    expect(normalizeViewPath('foo%00bar')).toBeNull()
  })

  it('rejects a path with double-encoded %2500 NUL after decoding', () => {
    // %2500 → %00 after one decodeURIComponent — second-pass NUL trap.
    expect(normalizeViewPath('foo%2500bar')).toBeNull()
  })

  it('rejects backslashes outright', () => {
    expect(normalizeViewPath('foo\\..\\etc')).toBeNull()
  })

  it('rejects malformed percent-encoding', () => {
    expect(normalizeViewPath('foo%2bar%')).toBeNull()
  })

  it('rejects an undefined tail', () => {
    expect(normalizeViewPath(undefined)).toBeNull()
  })

  it('rejects a `..` chain that pops past the root after pushes', () => {
    expect(normalizeViewPath('foo/../../etc')).toBeNull()
  })

  it('decodes legitimate percent-encoded segments', () => {
    expect(normalizeViewPath('hello%20world/page')).toBe('/hello world/page')
  })

  it('does not forward mixed-case %2E%2E as `..`', () => {
    expect(normalizeViewPath('%2E%2E/etc')).toBeNull()
  })

  it('rejects double-encoded `..` (input %252e%252e → decoded %2e%2e)', () => {
    expect(normalizeViewPath('%252e%252e/secret')).toBeNull()
  })

  it('rejects mixed `.%2e` double-dot segment', () => {
    expect(normalizeViewPath('.%2e/secret')).toBeNull()
  })

  it('rejects mixed `%2e.` double-dot segment', () => {
    expect(normalizeViewPath('%2e./secret')).toBeNull()
  })

  it('treats `%2e` as a single-dot segment (no-op)', () => {
    expect(normalizeViewPath('foo/%2e/bar')).toBe('/foo/bar')
  })
})
