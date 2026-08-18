import { describe, expect, it } from 'vitest'
import { isMalformedCredentialPayload } from '../registry.js'

/**
 * Both install paths (McpServer + install-hook) gate on this so they agree on what
 * a credentials payload is. The string case is the one that actually bit:
 * `Object.keys('abc')` enumerates character indices, so an unchecked string reads
 * as three credential names — a spurious unknown_credential_keys 400, or a
 * malformed Secret built from index keys.
 */
describe('isMalformedCredentialPayload', () => {
  it.each([
    ['a string', 'ghp_secret'],
    ['a number', 42],
    ['a boolean', true],
    ['an array', ['ghp_secret']],
  ])('rejects %s', (_label, payload) => {
    expect(isMalformedCredentialPayload(payload)).toBe(true)
  })

  it('accepts a key→value object', () => {
    expect(isMalformedCredentialPayload({ GITHUB_TOKEN: 'ghp_secret' })).toBe(false)
  })

  it('accepts an empty object — "no credentials supplied" is not malformed', () => {
    expect(isMalformedCredentialPayload({})).toBe(false)
  })

  // null is object-typed, so it passes this predicate by design: both call sites
  // treat null/undefined as "none supplied" BEFORE reaching here.
  it('leaves null to the callers null/undefined check', () => {
    expect(isMalformedCredentialPayload(null)).toBe(false)
  })
})
