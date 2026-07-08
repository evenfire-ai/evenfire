import { afterEach, describe, expect, it, vi } from 'vitest'

const RATE_LIMIT_KEYS = ['APPROVAL_RL_REQUEST_PER_MIN'] as const

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
})
