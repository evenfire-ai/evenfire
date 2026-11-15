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
    expect(hasLatestTag('registry.evenfire.ai/a/x:1.2.3')).toBe(false)
    expect(hasLatestTag('registry.evenfire.ai/latest/x:1.0')).toBe(false)
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
    expect(matchesAllowedImagePrefix('registry.evenfire.ai/a/x:1', 'registry.evenfire.ai/')).toBe(
      true
    )
  })
})

describe('classifyPluginImage', () => {
  it('accepts the deploy/base images and the Evenfire registry against the default allowlist', () => {
    for (const img of [
      'ghcr.io/evenfire-ai/airtable-mcp-server:1.0.0',
      'registry.evenfire.ai/acme/forecast:1.2.3',
      'mongodb/mongodb-mcp-server:latest',
      'mcr.microsoft.com/playwright/mcp@sha256:' + 'a'.repeat(64),
      'clerum/nginx-egress-proxy:0.1.0',
    ]) {
      expect(classifyPluginImage(img, { allowedPrefixes: DEFAULTS })).toEqual({ ok: true })
    }
  })
  it('denies an unlisted host, including the placeholder Artifact Registry path', () => {
    for (const img of [
      'docker.io/evil/x:1',
      'us-central1-docker.pkg.dev/your-gcp-project/clerum/airtable-mcp-server:latest',
    ]) {
      expect(classifyPluginImage(img, { allowedPrefixes: DEFAULTS })).toEqual({
        ok: false,
        reason: 'host_not_allowed',
      })
    }
    // Witness: the same default list accepts a listed host.
    expect(
      classifyPluginImage('ghcr.io/evenfire-ai/airtable-mcp-server:1.0.0', {
        allowedPrefixes: DEFAULTS,
      })
    ).toEqual({ ok: true })
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
      classifyPluginImage('registry.evenfire.ai/ ok/x:1', { allowedPrefixes: DEFAULTS })
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
    expect(classifyPluginImage('registry.evenfire.ai/a/x:1', { allowedPrefixes: [] })).toEqual({
      ok: false,
      reason: 'host_not_allowed',
    })
  })
})

describe('DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES', () => {
  it('equals the deploy/base list plus the Evenfire registry', () => {
    expect(DEFAULTS).toEqual([
      'ghcr.io/evenfire-ai/',
      'mongodb/',
      'mcr.microsoft.com/',
      'clerum/',
      'registry.evenfire.ai/',
    ])
  })
})
