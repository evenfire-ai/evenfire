import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertAllowedTarget } from './e2e-playwright/qa-recorder-helpers'

describe('QA recorder target guard', () => {
  const previousRemoteOptIn = process.env.QA_RECORDER_ALLOW_REMOTE

  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousRemoteOptIn === undefined) delete process.env.QA_RECORDER_ALLOW_REMOTE
    else process.env.QA_RECORDER_ALLOW_REMOTE = previousRemoteOptIn
  })

  it('awaits loopback health and fails before the journey when it is unavailable', async () => {
    delete process.env.QA_RECORDER_ALLOW_REMOTE
    const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      assertAllowedTarget('CONTROL_API_BASE_URL', 'http://127.0.0.1:36238')
    ).rejects.toThrow(/CONTROL_API_BASE_URL not healthy/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('only returns after the loopback health check succeeds', async () => {
    delete process.env.QA_RECORDER_ALLOW_REMOTE
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      assertAllowedTarget('CONTROL_API_BASE_URL', 'http://127.0.0.1:36238')
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:36238/health')
  })
})
