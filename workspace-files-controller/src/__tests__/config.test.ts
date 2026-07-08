import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config'

function stubRequiredEnv(overrides: Record<string, string | undefined> = {}) {
  vi.stubEnv('WSF_SHARED_FILESYSTEM_NAME', overrides.WSF_SHARED_FILESYSTEM_NAME ?? 'team-mission')
  vi.stubEnv('WSF_SHARED_FILESYSTEM_NAMESPACE', overrides.WSF_SHARED_FILESYSTEM_NAMESPACE ?? 'mcp-host')
  vi.stubEnv('WSF_JWT_PUBLIC_KEY', overrides.WSF_JWT_PUBLIC_KEY ?? 'public-key')
}

describe('loadConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('requires the injected SharedFileSystem namespace', () => {
    stubRequiredEnv()
    vi.stubEnv('WSF_SHARED_FILESYSTEM_NAMESPACE', '')

    expect(() => loadConfig()).toThrow(/WSF_SHARED_FILESYSTEM_NAMESPACE/)
  })

  it('uses the injected SharedFileSystem namespace when present', () => {
    stubRequiredEnv({ WSF_SHARED_FILESYSTEM_NAMESPACE: 'sandbox-recipes' })

    expect(loadConfig().sharedFileSystemNamespace).toBe('sandbox-recipes')
  })
})
