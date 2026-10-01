import { afterEach, describe, expect, it, vi } from 'vitest'

describe('controlApiUrl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('uses the configured Control API base URL for fetch-based streams', async () => {
    vi.stubEnv('NEXT_PUBLIC_CONTROL_API_BASE_URL', 'https://control.example.test/control-api')
    vi.resetModules()
    const { entityChangeStreamUrl } = await import('../entityChangeStream')

    expect(entityChangeStreamUrl('cursor 1')).toBe(
      'https://control.example.test/control-api/api/v1/gfs/entity-changes/stream?cursor=cursor%201'
    )
  })
})
