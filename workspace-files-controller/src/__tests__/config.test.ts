import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config'

function stubRequiredEnv(overrides: Record<string, string | undefined> = {}) {
  vi.stubEnv('WSF_SHARED_FILESYSTEM_NAME', overrides.WSF_SHARED_FILESYSTEM_NAME ?? 'team-mission')
  vi.stubEnv(
    'WSF_SHARED_FILESYSTEM_NAMESPACE',
    overrides.WSF_SHARED_FILESYSTEM_NAMESPACE ?? 'mcp-host'
  )
  vi.stubEnv('WSF_JWT_PUBLIC_KEY', overrides.WSF_JWT_PUBLIC_KEY ?? 'public-key')
  vi.stubEnv(
    'WSF_CONTROL_API_SERVICE_TOKEN',
    overrides.WSF_CONTROL_API_SERVICE_TOKEN ?? 'test-workspace-files-controller-token'
  )
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

  it('requires the dedicated checkpoint service token', () => {
    stubRequiredEnv()
    vi.stubEnv('WSF_CONTROL_API_SERVICE_TOKEN', '')
    expect(() => loadConfig()).toThrow(/WSF_CONTROL_API_SERVICE_TOKEN/)
  })
})
