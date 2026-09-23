import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The public control-admin token routes have a per-value bucket and a per-IP
 * bucket. The per-IP ceiling exists for value rotation from one source; it
 * must stay wide enough for many admins behind one shared public IP.
 */

const PER_VALUE_ENV = 'CONTROL_API_ADMIN_PUBLIC_TOKEN_RL_PER_MIN'
const PER_IP_ENV = 'CONTROL_API_ADMIN_PUBLIC_TOKEN_IP_RL_PER_MIN'
const ENV_KEYS = [PER_VALUE_ENV, PER_IP_ENV]

async function loadConfigWith(env: Partial<Record<string, string>>) {
  const originalValues = new Map(ENV_KEYS.map(key => [key, process.env[key]]))
  for (const key of ENV_KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(env)) process.env[key] = value
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

describe('public control-admin token budgets', () => {
  afterEach(() => {
    vi.resetModules()
  })

  it('defaults to 20 per value and 300 per IP', async () => {
    const { config } = await loadConfigWith({})
    expect(config.adminPublicTokenRlPerMin).toBe(20)
    expect(config.adminPublicTokenIpRlPerMin).toBe(300)
  })

  it('reads both values from the environment', async () => {
    const { config } = await loadConfigWith({ [PER_VALUE_ENV]: '10', [PER_IP_ENV]: '600' })
    expect(config.adminPublicTokenRlPerMin).toBe(10)
    expect(config.adminPublicTokenIpRlPerMin).toBe(600)
  })

  // Number() read '0x14' as 20 and 'twenty' as NaN; a NaN limit refuses every request.
  it.each([
    [PER_VALUE_ENV, '0x14', `${PER_VALUE_ENV} must be a positive integer`],
    [PER_VALUE_ENV, 'twenty', `${PER_VALUE_ENV} must be a positive integer`],
    [PER_VALUE_ENV, '0', `${PER_VALUE_ENV} must be a positive integer`],
    [PER_IP_ENV, '300.0', `${PER_IP_ENV} must be a positive integer`],
    [PER_IP_ENV, '6001', `${PER_IP_ENV} must be an integer between 1 and 6000`],
  ])('refuses %s=%j at startup', async (name, value, message) => {
    await expect(loadConfigWith({ [name]: value })).rejects.toThrow(message)
  })

  it('accepts the per-IP ceiling itself', async () => {
    const { config } = await loadConfigWith({ [PER_IP_ENV]: '6000' })
    expect(config.adminPublicTokenIpRlPerMin).toBe(6000)
  })

  it('refuses a per-IP ceiling below the per-value limit, and accepts an equal one', async () => {
    await expect(loadConfigWith({ [PER_VALUE_ENV]: '50', [PER_IP_ENV]: '40' })).rejects.toThrow(
      `${PER_IP_ENV} (40) must not be below ${PER_VALUE_ENV} (50)`
    )

    const { config } = await loadConfigWith({ [PER_VALUE_ENV]: '50', [PER_IP_ENV]: '50' })
    expect(config.adminPublicTokenIpRlPerMin).toBe(50)
  })
})
