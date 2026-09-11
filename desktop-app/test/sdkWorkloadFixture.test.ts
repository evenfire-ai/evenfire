import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SDK_WORKLOAD_MODEL_CONFIG,
  createSdkWorkloadGrants,
} from './e2e-playwright/sdk-client-notification/sdkWorkloadFixture'

type GrantRequest = {
  allowedCallers: string[]
  allowedEventTypes?: string[]
  allowedModels?: string[]
  allowedUserRefs?: string[]
  capabilityFamily: 'clientNotifications' | 'promptBridge'
  defaultTargetRef?: string
  promptTargets?: Array<{
    credentialSlot: string
    model: string
    provider: string
    targetRef: string
  }>
  provider?: string
  quotaLimits: Record<string, number>
  recipeName: string
  recipeNamespace: string
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
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'recipe-default',
        capabilityFamily: 'promptBridge',
        provider: SDK_WORKLOAD_MODEL_CONFIG.provider,
        allowedModels: [SDK_WORKLOAD_MODEL_CONFIG.model],
        promptTargets: [SDK_WORKLOAD_MODEL_CONFIG],
        defaultTargetRef: SDK_WORKLOAD_MODEL_CONFIG.targetRef,
        allowedCallers: ['sdk-caller'],
        quotaLimits: { maxRequestsPerRun: 3 },
      },
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'recipe-default',
        capabilityFamily: 'clientNotifications',
        allowedEventTypes: ['e2e.test.notification'],
        allowedUserRefs: ['user-default'],
        allowedCallers: ['sdk-caller'],
        quotaLimits: { maxNotificationsPerRun: 10 },
      },
    ])
  })

  it('uses explicit callers for promptBridge and clientNotifications', async () => {
    await createSdkWorkloadGrants('recipe-sandbox', 'user-sandbox', ['sandbox-ui'], true)

    expect(capturedGrantRequests().map(request => request.allowedCallers)).toEqual([
      ['sandbox-ui'],
      ['sandbox-ui'],
    ])
  })

  it('keeps explicit callers when promptBridge is disabled', async () => {
    await createSdkWorkloadGrants('recipe-notification-only', 'user-sandbox', ['sandbox-ui'], false)

    expect(capturedGrantRequests()).toEqual([
      {
        recipeNamespace: 'sandbox-recipes',
        recipeName: 'recipe-notification-only',
        capabilityFamily: 'clientNotifications',
        allowedEventTypes: ['e2e.test.notification'],
        allowedUserRefs: ['user-sandbox'],
        allowedCallers: ['sandbox-ui'],
        quotaLimits: { maxNotificationsPerRun: 10 },
      },
    ])
  })
})
