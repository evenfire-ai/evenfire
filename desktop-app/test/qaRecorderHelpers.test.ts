import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertAllowedTarget, desktopCredentials } from './e2e-playwright/qa-recorder-helpers'

describe('QA recorder target guard', () => {
  const previousRemoteOptIn = process.env.QA_RECORDER_ALLOW_REMOTE
  const previousEnvFilePresent = process.env.EVENFIRE_ENV_FILE_PRESENT
  const previousDesktopPassword = process.env.E2E_DESKTOP_PASSWORD
  const previousTestPassword = process.env.E2E_TEST_PASSWORD
  const previousAdminPassword = process.env.ADMIN_PASSWORD

  afterEach(() => {
    vi.unstubAllGlobals()
    if (previousRemoteOptIn === undefined) delete process.env.QA_RECORDER_ALLOW_REMOTE
    else process.env.QA_RECORDER_ALLOW_REMOTE = previousRemoteOptIn
    if (previousEnvFilePresent === undefined) delete process.env.EVENFIRE_ENV_FILE_PRESENT
    else process.env.EVENFIRE_ENV_FILE_PRESENT = previousEnvFilePresent
    if (previousDesktopPassword === undefined) delete process.env.E2E_DESKTOP_PASSWORD
    else process.env.E2E_DESKTOP_PASSWORD = previousDesktopPassword
    if (previousTestPassword === undefined) delete process.env.E2E_TEST_PASSWORD
    else process.env.E2E_TEST_PASSWORD = previousTestPassword
    if (previousAdminPassword === undefined) delete process.env.ADMIN_PASSWORD
    else process.env.ADMIN_PASSWORD = previousAdminPassword
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

  it('allows the seeded default only when no env file exists', () => {
    process.env.EVENFIRE_ENV_FILE_PRESENT = '0'
    delete process.env.E2E_DESKTOP_PASSWORD
    delete process.env.E2E_TEST_PASSWORD
    delete process.env.ADMIN_PASSWORD
    expect(desktopCredentials().password).toBe('changeme123!')
  })

  it('fails closed when an env file exists without a password', () => {
    process.env.EVENFIRE_ENV_FILE_PRESENT = '1'
    delete process.env.E2E_DESKTOP_PASSWORD
    delete process.env.E2E_TEST_PASSWORD
    delete process.env.ADMIN_PASSWORD
    expect(() => desktopCredentials()).toThrow(
      /password is missing from the canonical repository \.env/i
    )
  })
})
