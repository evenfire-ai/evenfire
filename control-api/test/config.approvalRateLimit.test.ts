import { afterEach, describe, expect, it, vi } from 'vitest'

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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = await loadConfigWith({})

    expect(config.approvalRlExternalPerMin).toBe(60)
    expect(config.approvalRlExternalEdgePerMin).toBe(120)
    expect(config.approvalRlExternalClientIpPerMin).toBe(1200)
    expect(warn).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'operation above the default session budget',
      override: { APPROVAL_RL_EXTERNAL_PER_MIN: '121' },
      expected: [121, 120, 1200],
    },
    {
      label: 'session equal to the default client-IP budget',
      override: { APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: '1200' },
      expected: [60, 1200, 1200],
    },
    {
      label: 'client-IP equal to the default session budget',
      override: { APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: '120' },
      expected: [60, 120, 120],
    },
    {
      label: 'session below the default operation budget',
      override: { APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: '30' },
      expected: [60, 30, 1200],
    },
  ])('boots with and preserves a partial override: $label', async ({ override, expected }) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = await loadConfigWith(override)

    expect([
      config.approvalRlExternalPerMin,
      config.approvalRlExternalEdgePerMin,
      config.approvalRlExternalClientIpPerMin,
    ]).toEqual(expected)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('accepts equality and reversed scopes while preserving every explicit value', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = await loadConfigWith({
      APPROVAL_RL_EXTERNAL_PER_MIN: '500',
      APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: '120',
      APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: '120',
    })

    expect(config.approvalRlExternalPerMin).toBe(500)
    expect(config.approvalRlExternalEdgePerMin).toBe(120)
    expect(config.approvalRlExternalClientIpPerMin).toBe(120)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('warns once with the resolved tuple and source without mutating values', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = await loadConfigWith({ APPROVAL_RL_EXTERNAL_PER_MIN: '121' })

    expect(config.approvalRlExternalPerMin).toBe(121)
    expect(config.approvalRlExternalEdgePerMin).toBe(120)
    expect(config.approvalRlExternalClientIpPerMin).toBe(1200)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('preserving exact configured values'),
      {
        resolved: {
          operation: { value: 121, source: 'environment' },
          session: { value: 120, source: 'default' },
          clientIp: { value: 1200, source: 'default' },
        },
        recommendedTopology: 'operation <= session < clientIp',
      }
    )
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
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const config = await loadConfigWith({
        APPROVAL_RL_EXTERNAL_PER_MIN: blank,
        APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: blank,
        APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: blank,
      })

      expect(config.approvalRlExternalPerMin).toBe(60)
      expect(config.approvalRlExternalEdgePerMin).toBe(120)
      expect(config.approvalRlExternalClientIpPerMin).toBe(1200)
      expect(warn).not.toHaveBeenCalled()
    }
  )

  it('does not warn for a coherent explicit topology', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const config = await loadConfigWith({
      APPROVAL_RL_EXTERNAL_PER_MIN: '30',
      APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: '60',
      APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: '600',
    })

    expect(config.approvalRlExternalPerMin).toBe(30)
    expect(config.approvalRlExternalEdgePerMin).toBe(60)
    expect(config.approvalRlExternalClientIpPerMin).toBe(600)
    expect(warn).not.toHaveBeenCalled()
  })
})
