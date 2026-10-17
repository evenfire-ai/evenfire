import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../config'

function stubRequiredEnv(overrides: Record<string, string | undefined> = {}) {
  vi.stubEnv('WSF_SHARED_FILESYSTEM_NAME', overrides.WSF_SHARED_FILESYSTEM_NAME ?? 'team-mission')
  vi.stubEnv(
    'WSF_SHARED_FILESYSTEM_NAMESPACE',
    overrides.WSF_SHARED_FILESYSTEM_NAMESPACE ?? 'mcp-host'
  )
  vi.stubEnv('WSF_JWT_PUBLIC_KEY', overrides.WSF_JWT_PUBLIC_KEY ?? 'public-key')
  vi.stubEnv('WSF_CONTROL_API_SERVICE_TOKEN', overrides.WSF_CONTROL_API_SERVICE_TOKEN ?? '')
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

  it('keeps the checkpoint token optional for legacy HCC deployments', () => {
    // PR1 HCC head 13753fe does not project WSF_CONTROL_API_SERVICE_TOKEN.
    stubRequiredEnv()

    expect(loadConfig().controlApiServiceToken).toBe('')
  })

  it('uses the dedicated checkpoint token when HCC projects it', () => {
    stubRequiredEnv({ WSF_CONTROL_API_SERVICE_TOKEN: 'test-workspace-files-controller-token' })

    expect(loadConfig().controlApiServiceToken).toBe('test-workspace-files-controller-token')
  })
})
