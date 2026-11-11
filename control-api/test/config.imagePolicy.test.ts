import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES } from '@clerum/image-policy'

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  vi.resetModules()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.CONTROL_API_ALLOWED_IMAGE_PREFIXES
})

afterEach(() => {
  process.env = ORIGINAL_ENV
  vi.resetModules()
})

describe('CONTROL_API_ALLOWED_IMAGE_PREFIXES', () => {
  it('parses the code default into the shared allowlist when the env is unset', async () => {
    const { config } = await import('../src/config.js')

    expect(config.allowedPluginImagePrefixes).toEqual([...DEFAULT_ALLOWED_PLUGIN_IMAGE_PREFIXES])
  })

  it('trims entries and drops empty segments from an override', async () => {
    process.env.CONTROL_API_ALLOWED_IMAGE_PREFIXES = ' registry.evenfire.ai/, , ghcr.io/acme/ '

    const { config } = await import('../src/config.js')

    expect(config.allowedPluginImagePrefixes).toEqual(['registry.evenfire.ai/', 'ghcr.io/acme/'])
  })

  it('keeps the case of an override prefix', async () => {
    process.env.CONTROL_API_ALLOWED_IMAGE_PREFIXES = 'ghcr.io/Acme/'

    const { config } = await import('../src/config.js')

    expect(config.allowedPluginImagePrefixes).toEqual(['ghcr.io/Acme/'])
  })

  it('reads an explicitly empty override as no prefixes, not as the default', async () => {
    process.env.CONTROL_API_ALLOWED_IMAGE_PREFIXES = ''

    const { config } = await import('../src/config.js')

    expect(config.allowedPluginImagePrefixes).toEqual([])
  })
})
