import { describe, expect, it } from 'vitest'
import { imageRefDigest, isDigestPinnedImageRef } from '../registry.js'

const SHA = 'sha256:' + 'a'.repeat(64)

/**
 * install-hook and upgrade-hook both gate on this and both derive the Host-side
 * digest pin from it. The regression it guards: `/@sha256:…$/` unanchored plus
 * `split('@')[1]` accepted `repo@bar@sha256:…` and pinned `bar` into every
 * Host's guardrails.hooks[].digest — the value mcp-host compares against
 * status.observedDigest to detect drift and quarantine a hook.
 */
describe('isDigestPinnedImageRef', () => {
  it('accepts a normally pinned ref', () => {
    expect(isDigestPinnedImageRef(`registry.example.com/acme/hook@${SHA}`)).toBe(true)
  })

  it('rejects a ref with a second @ before the digest', () => {
    expect(isDigestPinnedImageRef(`repo@bar@${SHA}`)).toBe(false)
  })

  it.each([
    ['a tag instead of a digest', 'registry.example.com/acme/hook:1.2.3'],
    ['no digest at all', 'registry.example.com/acme/hook'],
    ['a truncated digest', 'registry.example.com/acme/hook@sha256:abc'],
    ['a non-hex digest', `registry.example.com/acme/hook@sha256:${'z'.repeat(64)}`],
    ['trailing content after the digest', `registry.example.com/acme/hook@${SHA} `],
    ['an empty ref', ''],
  ])('rejects %s', (_label, ref) => {
    expect(isDigestPinnedImageRef(ref)).toBe(false)
  })

  it.each([undefined, null, 42, {}])('rejects the non-string %s', ref => {
    expect(isDigestPinnedImageRef(ref)).toBe(false)
  })
})

describe('imageRefDigest', () => {
  it('returns the digest of a pinned ref', () => {
    expect(imageRefDigest(`registry.example.com/acme/hook@${SHA}`)).toBe(SHA)
  })

  it('returns undefined for a double-@ ref rather than the middle segment', () => {
    // The old split('@')[1] returned 'bar' here, which then became the Host pin.
    expect(imageRefDigest(`repo@bar@${SHA}`)).toBeUndefined()
  })

  it('returns undefined when the ref is not pinned', () => {
    expect(imageRefDigest('registry.example.com/acme/hook:1.2.3')).toBeUndefined()
  })
})
