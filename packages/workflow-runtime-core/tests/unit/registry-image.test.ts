import { describe, expect, it } from 'vitest'
import {
  EVENFIRE_REGISTRY_PULL_SECRET_NAME,
  imageRefHost,
  isPlatformRegistryImage,
  registryHostFromUrl,
} from '../../src/registry-image'

const REGISTRY_URL = 'https://registry.evenfire.ai'

describe('EVENFIRE_REGISTRY_PULL_SECRET_NAME', () => {
  // Cross-service contract: control-api writes it, WRC/control-api reference it, HCC
  // materializes it. A rename here silently breaks image pulls everywhere.
  it('is the frozen pull-secret name', () => {
    expect(EVENFIRE_REGISTRY_PULL_SECRET_NAME).toBe('evenfire-registry-pull')
  })
})

describe('registryHostFromUrl', () => {
  it('extracts host, preserving a port', () => {
    expect(registryHostFromUrl('https://registry.evenfire.ai')).toBe('registry.evenfire.ai')
    expect(registryHostFromUrl('http://registry-api.registry.svc:5000')).toBe(
      'registry-api.registry.svc:5000'
    )
  })

  it('returns null for unset, blank, or unparseable input', () => {
    expect(registryHostFromUrl('')).toBeNull()
    expect(registryHostFromUrl('   ')).toBeNull()
    expect(registryHostFromUrl('not a url')).toBeNull()
  })
})

describe('imageRefHost', () => {
  it('reads an explicit host', () => {
    expect(imageRefHost('registry.evenfire.ai/acme/img:1.0')).toBe('registry.evenfire.ai')
    expect(imageRefHost('localhost:5000/img')).toBe('localhost:5000')
  })

  it('returns null when there is no explicit host (docker-hub style)', () => {
    // First component is a host only if it carries a '.' or ':' — otherwise it is a
    // docker-hub org/library path, not a registry.
    expect(imageRefHost('library/postgres:16')).toBeNull()
    expect(imageRefHost('postgres:16')).toBeNull()
    expect(imageRefHost('')).toBeNull()
  })
})

describe('isPlatformRegistryImage', () => {
  it('is true only when the image host equals the configured registry host', () => {
    expect(isPlatformRegistryImage('registry.evenfire.ai/acme/img:1', REGISTRY_URL)).toBe(true)
    expect(isPlatformRegistryImage('ghcr.io/acme/img:1', REGISTRY_URL)).toBe(false)
    expect(isPlatformRegistryImage('postgres:16', REGISTRY_URL)).toBe(false)
  })

  it('is false when no registry is configured — there is no credential to attach', () => {
    expect(isPlatformRegistryImage('registry.evenfire.ai/acme/img:1', '')).toBe(false)
    expect(isPlatformRegistryImage('registry.evenfire.ai/acme/img:1', 'not a url')).toBe(false)
  })

  it('is false for a non-string image', () => {
    expect(isPlatformRegistryImage(undefined, REGISTRY_URL)).toBe(false)
    expect(isPlatformRegistryImage(null, REGISTRY_URL)).toBe(false)
    expect(isPlatformRegistryImage(42, REGISTRY_URL)).toBe(false)
  })

  it('does not match on a host suffix or a lookalike host', () => {
    // A naive `endsWith`/`includes` would wrongly accept an attacker-controlled host.
    // The prefix case uses a neutral domain (the infra-identifier CI guard allows only
    // registry/registration/brain `.evenfire.ai` in the public tree); the property under
    // test is unchanged — `'evil-registry.example.com'.endsWith('registry.example.com')`
    // is true, so only an exact host comparison rejects it.
    expect(
      isPlatformRegistryImage('evil-registry.example.com/x/y:1', 'https://registry.example.com')
    ).toBe(false)
    expect(isPlatformRegistryImage('registry.evenfire.ai.evil.com/x/y:1', REGISTRY_URL)).toBe(false)
  })

  it('distinguishes a port difference', () => {
    expect(isPlatformRegistryImage('localhost:5000/img:1', 'http://localhost:5001')).toBe(false)
    expect(isPlatformRegistryImage('localhost:5000/img:1', 'http://localhost:5000')).toBe(true)
  })
})
