import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Integer settings accept only canonical decimal text. `Number()` alone also
 * reads '0x5A', '90.0', '9e1', ' 90' and '+90' as 90, so a typo or a templated
 * value would boot with a number the operator never wrote. One variable per
 * parser: positiveIntegerFromEnv, boundedIntegerFromEnv (and every parser
 * built on positiveIntegerFromEnv), nonNegativeIntegerFromEnv.
 */

type IntegerField =
  | 'userApprovalRequestArchiveBatchSize'
  | 'externalGfsOperationRlPerMin'
  | 'llmCatalogSyncProviderMinLive'

const CASES: Array<{
  parser: string
  env: string
  field: IntegerField
  accepted: Array<[string, number]>
  message: string
}> = [
  {
    parser: 'positiveIntegerFromEnv',
    env: 'APPROVAL_ARCHIVE_BATCH_SIZE',
    field: 'userApprovalRequestArchiveBatchSize',
    accepted: [
      ['90', 90],
      ['1', 1],
    ],
    message: 'APPROVAL_ARCHIVE_BATCH_SIZE must be a positive integer',
  },
  {
    parser: 'boundedIntegerFromEnv',
    env: 'CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN',
    field: 'externalGfsOperationRlPerMin',
    accepted: [
      ['90', 90],
      ['1', 1],
    ],
    message: 'CONTROL_API_EXTERNAL_GFS_OPERATION_RL_PER_MIN must be a positive integer',
  },
  {
    parser: 'nonNegativeIntegerFromEnv',
    env: 'LLM_CATALOG_SYNC_PROVIDER_MIN_LIVE',
    field: 'llmCatalogSyncProviderMinLive',
    accepted: [
      ['90', 90],
      ['0', 0],
    ],
    message: 'LLM_CATALOG_SYNC_PROVIDER_MIN_LIVE must be a non-negative integer',
  },
]

// Each reads as a valid integer through Number().
const NON_CANONICAL = ['0x5A', '90.0', '9e1', ' 90', '90 ', '+90', '090', '9007199254740993']

const ENV_KEYS = CASES.map(testCase => testCase.env)

async function loadConfigWith(name: string, value: string) {
  const originalValues = new Map(ENV_KEYS.map(key => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  process.env[name] = value
  vi.resetModules()
  try {
    return await import('../src/config.js')
  } finally {
    for (const key of ENV_KEYS) {
      const original = originalValues.get(key)
      if (original === undefined) delete process.env[key]
      else process.env[key] = original
    }
  }
}

describe('canonical integer environment values', () => {
  afterEach(() => {
    vi.resetModules()
  })

  describe.each(CASES)('$parser ($env)', testCase => {
    it.each(testCase.accepted)('accepts %j as %d', async (value, expected) => {
      const { config } = await loadConfigWith(testCase.env, value)
      expect(config[testCase.field]).toBe(expected)
    })

    it.each(NON_CANONICAL)('refuses %j at startup', async value => {
      await expect(loadConfigWith(testCase.env, value)).rejects.toThrow(testCase.message)
    })
  })
})
