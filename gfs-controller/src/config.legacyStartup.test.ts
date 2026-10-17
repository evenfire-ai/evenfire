import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfig } from './config'

describe('loadConfig legacy startup compatibility', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('keeps legacy serving config when older HCC omits the checkpoint endpoint and token', () => {
    // PR1 HCC head 13753fe omits both optional GFS_CONTROL_API_* variables.
    vi.stubEnv('GFS_DEV_MODE', 'false')
    vi.stubEnv('GFS_STORAGE_PATH', '/data/gfs')
    vi.stubEnv('GFS_STORAGE_ROLE', 'writer')
    vi.stubEnv('GFS_PG_CONNECTION_STRING', 'postgresql://postgres@127.0.0.1/postgres')
    vi.stubEnv('GFS_CONTROL_API_BASE_URL', '')
    vi.stubEnv('GFS_CONTROL_API_SERVICE_TOKEN', '')

    const config = loadConfig()

    expect(config.controlApiServiceToken).toBeUndefined()
    expect(config.controlApiBaseUrl).toBeUndefined()
  })

  it('retains a projected checkpoint token when the current HCC supplies one', () => {
    vi.stubEnv('GFS_DEV_MODE', 'true')
    vi.stubEnv('GFS_STORAGE_PATH', '/data/gfs')
    vi.stubEnv('GFS_STORAGE_ROLE', 'writer')
    vi.stubEnv('GFS_PG_CONNECTION_STRING', 'postgresql://postgres@127.0.0.1/postgres')
    vi.stubEnv('GFS_CONTROL_API_BASE_URL', 'http://control-api.test')
    vi.stubEnv('GFS_CONTROL_API_SERVICE_TOKEN', 'test-gfs-controller-token')

    expect(loadConfig()).toMatchObject({
      controlApiBaseUrl: 'http://control-api.test',
      controlApiServiceToken: 'test-gfs-controller-token',
    })
  })
})
