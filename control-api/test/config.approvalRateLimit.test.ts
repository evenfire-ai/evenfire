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

  it('keeps the external client IP backstop wider than the session edge bucket', async () => {
    const config = await loadConfigWith({})

    expect(config.approvalRlExternalEdgePerMin).toBe(120)
    expect(config.approvalRlExternalClientIpPerMin).toBe(1200)
    expect(config.approvalRlExternalClientIpPerMin).toBeGreaterThan(
      config.approvalRlExternalEdgePerMin
    )
  })

  it('rejects malformed external rate-limit configuration at startup', async () => {
    await expect(loadConfigWith({ APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: '0' })).rejects.toThrow(
      'APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN must be a positive integer'
    )
  })

  it('rejects an incoherent external limiter hierarchy at startup', async () => {
    await expect(
      loadConfigWith({
        APPROVAL_RL_EXTERNAL_PER_MIN: '60',
        APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: '1200',
        APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: '120',
      })
    ).rejects.toThrow(
      'APPROVAL_RL_EXTERNAL_PER_MIN must be <= APPROVAL_RL_EXTERNAL_EDGE_PER_MIN < APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN'
    )
  })

  it('rejects an operation budget wider than the session budget', async () => {
    await expect(
      loadConfigWith({
        APPROVAL_RL_EXTERNAL_PER_MIN: '121',
        APPROVAL_RL_EXTERNAL_EDGE_PER_MIN: '120',
        APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN: '1200',
      })
    ).rejects.toThrow(
      'APPROVAL_RL_EXTERNAL_PER_MIN must be <= APPROVAL_RL_EXTERNAL_EDGE_PER_MIN < APPROVAL_RL_EXTERNAL_CLIENT_IP_PER_MIN'
    )
  })
})
