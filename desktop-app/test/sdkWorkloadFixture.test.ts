import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSdkWorkloadGrants } from './e2e-playwright/sdk-client-notification/sdkWorkloadFixture'

type GrantRequest = {
  allowedCallers: string[]
  capabilityFamily: 'clientNotifications' | 'promptBridge'
}

const originalAdminPassword = process.env.E2E_ADMIN_PASSWORD

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

function capturedGrantRequests(): GrantRequest[] {
  const requests = vi.mocked(fetch).mock.calls.slice(1)
  return requests.map(([, init]) => JSON.parse(String(init?.body)) as GrantRequest)
}

describe('createSdkWorkloadGrants', () => {
  beforeEach(() => {
    process.env.E2E_ADMIN_PASSWORD = 'test-only-password'
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(response({ token: 'test-admin-token' })))
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    if (originalAdminPassword === undefined) delete process.env.E2E_ADMIN_PASSWORD
    else process.env.E2E_ADMIN_PASSWORD = originalAdminPassword
  })

  it('uses the default SDK caller for every applicable grant', async () => {
    await createSdkWorkloadGrants('recipe-default', 'user-default')

    expect(capturedGrantRequests()).toEqual([
      expect.objectContaining({ capabilityFamily: 'promptBridge', allowedCallers: ['sdk-caller'] }),
      expect.objectContaining({
        capabilityFamily: 'clientNotifications',
        allowedCallers: ['sdk-caller'],
      }),
    ])
  })

  it('uses explicit callers for promptBridge and clientNotifications', async () => {
    await createSdkWorkloadGrants('recipe-sandbox', 'user-sandbox', ['sandbox-ui'], true)

    expect(capturedGrantRequests()).toEqual([
      expect.objectContaining({ capabilityFamily: 'promptBridge', allowedCallers: ['sandbox-ui'] }),
      expect.objectContaining({
        capabilityFamily: 'clientNotifications',
        allowedCallers: ['sandbox-ui'],
      }),
    ])
  })

  it('keeps explicit callers when promptBridge is disabled', async () => {
    await createSdkWorkloadGrants('recipe-notification-only', 'user-sandbox', ['sandbox-ui'], false)

    expect(capturedGrantRequests()).toEqual([
      expect.objectContaining({
        capabilityFamily: 'clientNotifications',
        allowedCallers: ['sandbox-ui'],
      }),
    ])
  })
})
