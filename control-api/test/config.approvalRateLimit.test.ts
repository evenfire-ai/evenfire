import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const LOG_LEVELS = ['warn', 'info', 'error', 'debug'] as const
const loggerCalls = {
  warn: vi.fn<(...args: unknown[]) => void>(),
  info: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
  debug: vi.fn<(...args: unknown[]) => void>(),
}
const TOPOLOGY_EVENT = 'external_rate_limit_topology_advisory'

function advisoryCalls(level: (typeof LOG_LEVELS)[number]) {
  return loggerCalls[level].mock.calls.filter(
    ([fields]) =>
      typeof fields === 'object' &&
      fields !== null &&
      'event' in fields &&
      fields.event === TOPOLOGY_EVENT
  )
}

function expectNoAdvisory() {
  for (const level of LOG_LEVELS) expect(advisoryCalls(level)).toEqual([])
}

function expectAdvisory(values: readonly number[], sources: readonly string[]) {
  expect(advisoryCalls('warn')).toEqual([
    [
      {
        event: TOPOLOGY_EVENT,
        resolved: {
          operation: { value: values[0], source: sources[0] },
          session: { value: values[1], source: sources[1] },
          clientIp: { value: values[2], source: sources[2] },
        },
        recommendedTopology: 'operation <= session < clientIp',
      },
      'External rate limits cross the recommended topology; preserving configured values',
    ],
  ])
  for (const level of ['info', 'error', 'debug'] as const) expect(advisoryCalls(level)).toEqual([])
}

const RATE_LIMIT_KEYS = [
  'APPROVAL_RL_REQUEST_PER_MIN',
  'APPROVAL_RL_EXTERNAL_PER_MIN',
  'APPROVAL_RL_EXTERNAL_EDGE_PER_MIN',
  'APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN',
] as const

async function loadConfigWith(
  overrides: Partial<Record<(typeof RATE_LIMIT_KEYS)[number], string>>
) {
  const originalValues = new Map<string, string | undefined>()
  for (const key of RATE_LIMIT_KEYS) {
    originalValues.set(key, process.env[key])
    delete process.env[key]
  }
  Object.assign(process.env, overrides)
  vi.resetModules()
  try {
    // Attach after the reset to the same real logger instance config imports.
    const { rootLogger } = await import('../src/observability/logger.js')
    for (const level of LOG_LEVELS) {
      vi.spyOn(rootLogger, level).mockImplementation((...args: unknown[]) =>
        loggerCalls[level](...args)
      )
    }
    const mod = await import('../src/config.js')
    return mod.config
  } finally {
    for (const key of RATE_LIMIT_KEYS) {
      const value = originalValues.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('control-api approval rate limit config', () => {
  beforeEach(() => vi.clearAllMocks())
  afterEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('defaults approval request rate limit to multi-agent channel-reader capacity', async () => {
    const config = await loadConfigWith({})

    expect(config.approvalRlRequestPerMin).toBe(120)
  })

  it('accepts the approval request rate limit environment override', async () => {
    const config = await loadConfigWith({
      APPROVAL_RL_REQUEST_PER_MIN: '30',
    })

    expect(config.approvalRlRequestPerMin).toBe(30)
  })

  it('uses the recommended external defaults without a boot advisory', async () => {
    const config = await loadConfigWith({})

    expect(config.approvalRlExternalPerMin).toBe(60)
    expect(config.approvalRlExternalEdgePerMin).toBe(120)
    expect(config.approvalRlExternalClientIpPerMin).toBe(1200)
    expectNoAdvisory()
  })

  it.each([
    {
      label: 'operation above the default session budget',
      override: { APPROVAL_RL_EXTERNAL_PER_MIN: '121' },
      expected: [121, 120, 1200],
      sources: ['environment', 'default', 'default'],
    },
    {
      label: 'session equal to the default client-IP budget',
      override: { APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: '1200' },
      expected: [60, 1200, 1200],
      sources: ['default', 'environment', 'default'],
    },
    {
      label: 'client-IP equal to the default session budget',
      override: { APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: '120' },
      expected: [60, 120, 120],
      sources: ['default', 'default', 'environment'],
    },
    {
      label: 'session below the default operation budget',
      override: { APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: '30' },
      expected: [60, 30, 1200],
      sources: ['default', 'environment', 'default'],
    },
  ])(
    'boots with and preserves a partial override: $label',
    async ({ override, expected, sources }) => {
      const config = await loadConfigWith(override)

      expect([
        config.approvalRlExternalPerMin,
        config.approvalRlExternalEdgePerMin,
        config.approvalRlExternalClientIpPerMin,
      ]).toEqual(expected)
      expectAdvisory(expected, sources)
    }
  )

  it('accepts equality and reversed scopes while preserving every explicit value', async () => {
    const config = await loadConfigWith({
      APPROVAL_RL_EXTERNAL_PER_MIN: '500',
      APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: '120',
      APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: '120',
    })

    expect(config.approvalRlExternalPerMin).toBe(500)
    expect(config.approvalRlExternalEdgePerMin).toBe(120)
    expect(config.approvalRlExternalClientIpPerMin).toBe(120)
    expectAdvisory([500, 120, 120], ['environment', 'environment', 'environment'])
  })

  it('warns once with the resolved tuple and source without mutating values', async () => {
    const config = await loadConfigWith({ APPROVAL_RL_EXTERNAL_PER_MIN: '121' })

    expect(config.approvalRlExternalPerMin).toBe(121)
    expect(config.approvalRlExternalEdgePerMin).toBe(120)
    expect(config.approvalRlExternalClientIpPerMin).toBe(1200)
    expectAdvisory([121, 120, 1200], ['environment', 'default', 'default'])
  })

  it.each([
    ['APPROVAL_RL_EXTERNAL_PER_MIN', '0'],
    ['APPROVAL_RL_EXTERNAL_EDGE_PER_MIN', '-1'],
    ['APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN', '1.5'],
    ['APPROVAL_RL_EXTERNAL_PER_MIN', 'not-a-number'],
    ['APPROVAL_RL_EXTERNAL_EDGE_PER_MIN', '9007199254740992'],
  ] as const)('rejects malformed scalar %s=%s at startup', async (key, value) => {
    await expect(loadConfigWith({ [key]: value })).rejects.toThrow(
      `${key} must be a positive integer`
    )
  })

  it.each(['', '   ', '\t'])(
    'treats a blank external rate-limit override (%j) as the default',
    async blank => {
      const config = await loadConfigWith({
        APPROVAL_RL_EXTERNAL_PER_MIN: blank,
        APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: blank,
        APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: blank,
      })

      expect(config.approvalRlExternalPerMin).toBe(60)
      expect(config.approvalRlExternalEdgePerMin).toBe(120)
      expect(config.approvalRlExternalClientIpPerMin).toBe(1200)
      expectNoAdvisory()
    }
  )

  it('does not warn for a coherent explicit topology', async () => {
    const config = await loadConfigWith({
      APPROVAL_RL_EXTERNAL_PER_MIN: '30',
      APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: '60',
      APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: '600',
    })

    expect(config.approvalRlExternalPerMin).toBe(30)
    expect(config.approvalRlExternalEdgePerMin).toBe(60)
    expect(config.approvalRlExternalClientIpPerMin).toBe(600)
    expectNoAdvisory()
  })
})
