import { describe, expect, it } from 'vitest'
import { assertSafeFilesystemSegment, assertSafeRouteSegment } from '../pathSafety.js'

describe('assertSafeRouteSegment', () => {
  it.each(['agent-1', 'chat_123', 'team:agent', 'ümlaut'])(
    'accepts a safe route segment: %s',
    value => {
      expect(() => assertSafeRouteSegment('segment', value)).not.toThrow()
    }
  )

  it.each(['', '.', '..', 'a/b', 'a\\b', 'line\nfeed', 'nul\0byte', 'x'.repeat(501)])(
    'rejects an unsafe route segment: %s',
    value => {
      expect(() => assertSafeRouteSegment('segment', value)).toThrow(/Invalid segment/)
    }
  )

  it('honors endpoint-specific length and colon restrictions', () => {
    expect(() => assertSafeRouteSegment('agent', 'a:b', { allowColon: false })).toThrow()
    expect(() => assertSafeRouteSegment('agent', 'abc', { maxLength: 2 })).toThrow()
  })
})

describe('assertSafeFilesystemSegment', () => {
  it.each(['agent-1', 'chat_123', 'report.v2', 'ümlaut'])(
    'accepts a portable filename: %s',
    value => {
      expect(() => assertSafeFilesystemSegment('segment', value)).not.toThrow()
    }
  )

  it.each([
    '.hidden',
    'trailing.',
    'trailing ',
    'a:b',
    'a?b',
    'a*b',
    'a<b',
    'a>b',
    'a|b',
    'a"b',
    'CON',
    'con.txt',
    'COM1',
    'lpt9.log',
  ])('rejects a non-portable filename: %s', value => {
    expect(() => assertSafeFilesystemSegment('segment', value)).toThrow(/unsafe path segment/)
  })

  it('rejects caller-reserved names case-insensitively', () => {
    expect(() =>
      assertSafeFilesystemSegment('segment', 'Snapshots', { reservedNames: ['snapshots'] })
    ).toThrow(/unsafe path segment/)
  })
})
