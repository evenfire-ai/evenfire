import { afterEach, describe, expect, it, vi } from 'vitest'

const KEYS = [
  'CONTROL_API_ADMIN_SUBSCRIPTION_READ_PER_MIN',
  'CONTROL_API_ADMIN_SUBSCRIPTION_WRITE_PER_MIN',
  'CONTROL_API_SUBSCRIPTION_OAUTH_CALLBACK_PER_MIN',
] as const

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function readConfig(overrides: Partial<Record<(typeof KEYS)[number], string>> = {}) {
  for (const key of KEYS) vi.stubEnv(key, overrides[key] ?? '')
  vi.resetModules()
  const { config } = await import('../src/config.js')
  // Keep failure diagnostics limited to the contract under test. The full
  // configuration also owns cryptographic material and must never be printed.
  return {
    adminSubscriptionReadPerMin: config.adminSubscriptionReadPerMin,
    adminSubscriptionWritePerMin: config.adminSubscriptionWritePerMin,
    subscriptionOAuthCallbackPerMin: config.subscriptionOAuthCallbackPerMin,
  }
}

describe('administrative subscription capacity', () => {
  it('defaults to five times the incident thresholds', async () => {
    const config = await readConfig()
    expect(config.adminSubscriptionReadPerMin).toBe(150)
    expect(config.adminSubscriptionWritePerMin).toBe(100)
    expect(config.subscriptionOAuthCallbackPerMin).toBe(100)
  })

  it('honors distinct explicit operation budgets', async () => {
    const config = await readConfig({
      CONTROL_API_ADMIN_SUBSCRIPTION_READ_PER_MIN: '321',
      CONTROL_API_ADMIN_SUBSCRIPTION_WRITE_PER_MIN: '123',
      CONTROL_API_SUBSCRIPTION_OAUTH_CALLBACK_PER_MIN: '234',
    })
    expect(config.adminSubscriptionReadPerMin).toBe(321)
    expect(config.adminSubscriptionWritePerMin).toBe(123)
    expect(config.subscriptionOAuthCallbackPerMin).toBe(234)
  })

  for (const key of KEYS) {
    it.each(['0', '-1', '1.5', 'NaN', '9007199254740992'])(
      `rejects invalid ${key}=%s at boot`,
      async value => {
        await expect(readConfig({ [key]: value })).rejects.toThrow(
          `${key} must be a positive integer`
        )
      }
    )
  }
})

const OPERATING_BUDGETS = [
  ['CONTROL_API_ADMIN_WORKFLOW_READ_PER_MIN', 'adminWorkflowReadPerMin', 300],
  ['CONTROL_API_ADMIN_WORKFLOW_GRANT_READ_PER_MIN', 'adminWorkflowGrantReadPerMin', 300],
  ['CONTROL_API_ADMIN_WORKFLOW_GRANT_WRITE_PER_MIN', 'adminWorkflowGrantWritePerMin', 100],
  ['CONTROL_API_ADMIN_WORKFLOW_TRIGGER_PER_MIN', 'adminWorkflowTriggerPerMin', 50],
  ['CONTROL_API_ADMIN_OUTPUTS_READ_PER_MIN', 'adminOutputsReadPerMin', 150],
  ['CONTROL_API_LLM_PROVIDER_ATTEMPT_AUTHORIZE_PER_MIN', 'llmProviderAttemptAuthorizePerMin', 300],
  [
    'CONTROL_API_LLM_PROVIDER_ATTEMPT_AUTHORIZE_ANONYMOUS_IP_PER_MIN',
    'llmProviderAttemptAuthorizeAnonymousIpPerMin',
    60,
  ],
  ['CONTROL_API_ADMIN_REGISTRY_KEYS_PER_MIN', 'adminRegistryKeysPerMin', 150],
  ['CONTROL_API_ADMIN_REGISTRY_GRANTS_PER_MIN', 'adminRegistryGrantsPerMin', 150],
  ['CONTROL_API_ADMIN_REGISTRY_CONNECT_STATUS_PER_MIN', 'adminRegistryConnectStatusPerMin', 150],
  ['CONTROL_API_ADMIN_REGISTRY_CONNECT_REQUEST_PER_MIN', 'adminRegistryConnectRequestPerMin', 15],
  ['CONTROL_API_ADMIN_REGISTRY_CONNECT_RECOVERY_PER_MIN', 'adminRegistryConnectRecoveryPerMin', 50],
  ['CONTROL_API_ADMIN_CONNECTOR_DELETE_EDGE_PER_MIN', 'adminConnectorDeleteEdgePerMin', 300],
  ['CONTROL_API_ADMIN_CONNECTOR_DELETE_PER_MIN', 'adminConnectorDeletePerMin', 150],
  ['CONTROL_API_ADMIN_GFS_GRANTS_PER_MIN', 'adminGfsGrantsPerMin', 150],
  ['CONTROL_API_ADMIN_GFS_SHARES_PER_MIN', 'adminGfsSharesPerMin', 150],
  ['CONTROL_API_ADMIN_GFS_LEGACY_GRANT_REPORT_PER_MIN', 'adminGfsLegacyGrantReportPerMin', 150],
  ['APPROVAL_RL_REFRESH_PER_MIN', 'approvalRlRefreshPerMin', 100],
  ['APPROVAL_RL_REISSUE_PER_MIN', 'approvalRlReissuePerMin', 25],
  ['CONTROL_API_OAUTH_BROKER_RL_PER_MIN', 'oauthBrokerRlPerMin', 300],
] as const

async function readOperatingBudgets(
  overrides: Partial<Record<(typeof OPERATING_BUDGETS)[number][0], string>> = {}
) {
  for (const [key] of OPERATING_BUDGETS) vi.stubEnv(key, overrides[key] ?? '')
  vi.resetModules()
  const { config } = await import('../src/config.js')
  return Object.fromEntries(OPERATING_BUDGETS.map(([, field]) => [field, config[field]])) as Record<
    (typeof OPERATING_BUDGETS)[number][1],
    number
  >
}

describe('similar authenticated administrative budgets', () => {
  it('defaults each family to at least five times its previous ceiling', async () => {
    const config = await readOperatingBudgets()
    for (const [, field, expected] of OPERATING_BUDGETS) {
      expect(config[field]).toBe(expected)
    }
  })

  it('keeps the anonymous provider-attempt allowance separate from the verified budget', async () => {
    const config = await readOperatingBudgets({
      CONTROL_API_LLM_PROVIDER_ATTEMPT_AUTHORIZE_PER_MIN: '900',
    })
    expect(config.llmProviderAttemptAuthorizePerMin).toBe(900)
    expect(config.llmProviderAttemptAuthorizeAnonymousIpPerMin).toBe(60)
  })

  it('honors an explicit override without changing neighboring families', async () => {
    const config = await readOperatingBudgets({
      CONTROL_API_ADMIN_REGISTRY_CONNECT_REQUEST_PER_MIN: '7',
      CONTROL_API_ADMIN_GFS_SHARES_PER_MIN: '40',
    })
    expect(config.adminRegistryConnectRequestPerMin).toBe(7)
    expect(config.adminGfsSharesPerMin).toBe(40)
    expect(config.adminRegistryConnectRecoveryPerMin).toBe(50)
    expect(config.adminGfsGrantsPerMin).toBe(150)
  })

  for (const [key] of OPERATING_BUDGETS) {
    it(`rejects invalid ${key}`, async () => {
      await expect(readOperatingBudgets({ [key]: '0' })).rejects.toThrow(
        `${key} must be a positive integer`
      )
    })
  }
})
