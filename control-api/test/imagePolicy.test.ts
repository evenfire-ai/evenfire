import { describe, expect, it } from 'vitest'
import {
  DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES,
  classifyPluginImage,
  hasLatestTag,
  hasUnsafeImageReferenceSyntax,
  matchesAllowedImagePrefix,
} from '@clerum/image-policy'

const DEFAULTS = [...DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES]

describe('extracted helpers (behavior parity with coordinator)', () => {
  it('hasLatestTag detects :latest only as a tag', () => {
    expect(hasLatestTag('mongodb/mongodb-mcp-server:latest')).toBe(true)
    expect(hasLatestTag('example.com/a/x:1.2.3')).toBe(false)
    expect(hasLatestTag('example.com/latest/x:1.0')).toBe(false)
  })
  it('hasUnsafeImageReferenceSyntax flags whitespace and empty/dot segments', () => {
    expect(hasUnsafeImageReferenceSyntax('a b/c')).toBe(true)
    expect(hasUnsafeImageReferenceSyntax('a//c:1')).toBe(true)
    expect(hasUnsafeImageReferenceSyntax('../evil:1')).toBe(true)
    expect(
      hasUnsafeImageReferenceSyntax('mcr.microsoft.com/playwright/mcp@sha256:' + 'a'.repeat(64))
    ).toBe(false)
  })
  it('matchesAllowedImagePrefix respects path/tag/digest boundaries', () => {
    expect(matchesAllowedImagePrefix('mongodb/mongodb-mcp-server:latest', 'mongodb/')).toBe(true)
    expect(matchesAllowedImagePrefix('mongodbevil/x:1', 'mongodb')).toBe(false)
    expect(matchesAllowedImagePrefix('example.com/a/x:1', 'example.com/')).toBe(
      true
    )
  })
})

describe('classifyPluginImage', () => {
  it('accepts current first-party + evenfire images against the default allowlist', () => {
    for (const img of [
      'us-central1-docker.pkg.dev/your-gcp-project/clerum/airtable-mcp-server:latest',
      'example.com/acme/forecast:1.2.3',
      'mongodb/mongodb-mcp-server:latest',
      'mcr.microsoft.com/playwright/mcp@sha256:' + 'a'.repeat(64),
      'clerum/nginx-egress-proxy:0.1.0',
    ]) {
      expect(classifyPluginImage(img, { allowedPrefixes: DEFAULTS })).toEqual({ ok: true })
    }
  })
  it('denies an unlisted host', () => {
    expect(classifyPluginImage('docker.io/evil/x:1', { allowedPrefixes: DEFAULTS })).toEqual({
      ok: false,
      reason: 'host_not_allowed',
    })
  })
  it('flags empty / non-string image', () => {
    expect(classifyPluginImage('', { allowedPrefixes: DEFAULTS })).toEqual({
      ok: false,
      reason: 'empty',
    })
    expect(classifyPluginImage(undefined, { allowedPrefixes: DEFAULTS })).toEqual({
      ok: false,
      reason: 'empty',
    })
  })
  it('flags unsafe syntax before host', () => {
    expect(
      classifyPluginImage('example.com/ ok/x:1', { allowedPrefixes: DEFAULTS })
    ).toEqual({
      ok: false,
      reason: 'unsafe_syntax',
    })
  })
  it('only rejects :latest when rejectLatest is on', () => {
    expect(
      classifyPluginImage('mongodb/mongodb-mcp-server:latest', { allowedPrefixes: DEFAULTS })
    ).toEqual({ ok: true })
    expect(
      classifyPluginImage('mongodb/mongodb-mcp-server:latest', {
        allowedPrefixes: DEFAULTS,
        rejectLatest: true,
      })
    ).toEqual({ ok: false, reason: 'latest_tag' })
  })
  it('denies everything when the allowlist is empty', () => {
    expect(classifyPluginImage('example.com/a/x:1', { allowedPrefixes: [] })).toEqual({
      ok: false,
      reason: 'host_not_allowed',
    })
  })
})

describe('DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES', () => {
  it('covers the current fleet hosts + evenfire', () => {
    expect(DEFAULTS).toEqual([
      'us-central1-docker.pkg.dev/your-gcp-project/clerum/',
      'example.com/',
      'mongodb/',
      'mcr.microsoft.com/',
      'clerum/',
    ])
  })
})
