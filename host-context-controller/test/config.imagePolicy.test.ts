import { afterEach, describe, expect, it, vi } from 'vitest'

describe('HCC image-allowlist config', () => {
  afterEach(() => {
    delete process.env.CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES
    delete process.env.CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST
    vi.resetModules()
  })

  it('defaults to the shared permissive allowlist and enforce=false', async () => {
    vi.resetModules()
    const { config } = await import('../src/config')
    const { DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES } = await import('@clerum/image-policy')
    expect(config.allowedPluginImagePrefixes).toEqual([...DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES])
    expect(config.enforcePluginImageAllowlist).toBe(false)
  })

  it('parses env overrides (list + bool)', async () => {
    process.env.CONTEXT_MAPPER_ALLOWED_IMAGE_PREFIXES = 'example.com/, ghcr.io/acme/'
    process.env.CONTEXT_MAPPER_ENFORCE_IMAGE_ALLOWLIST = 'true'
    vi.resetModules()
    const { config } = await import('../src/config')
    expect(config.allowedPluginImagePrefixes).toEqual(['example.com/', 'ghcr.io/acme/'])
    expect(config.enforcePluginImageAllowlist).toBe(true)
  })
})
