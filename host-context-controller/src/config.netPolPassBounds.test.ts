import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadConfig(name: string, raw: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (raw === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = raw
  }
  return import('./config')
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('HCC_K8S_REQUEST_TIMEOUT_MS', () => {
  it('defaults to 30000 when unset', async () => {
    const { config } = await loadConfig('HCC_K8S_REQUEST_TIMEOUT_MS', undefined)
    expect(config.k8sRequestTimeoutMs).toBe(30_000)
  })

  it.each([
    ['1', 1],
    ['45000', 45_000],
    ['2147483647', 2_147_483_647],
  ])('accepts %s', async (raw, expected) => {
    const { config } = await loadConfig('HCC_K8S_REQUEST_TIMEOUT_MS', raw)
    expect(config.k8sRequestTimeoutMs).toBe(expected)
  })

  it.each(['', '0', '-1', '1.5', '30s', 'NaN', '2147483648'])(
    "fails configuration validation for '%s'",
    async raw => {
      await expect(loadConfig('HCC_K8S_REQUEST_TIMEOUT_MS', raw)).rejects.toThrow(
        'HCC_K8S_REQUEST_TIMEOUT_MS must be a positive integer'
      )
    }
  )
})

describe('HCC_NETPOL_PASS_HARD_LIMIT_MS', () => {
  it('defaults to 30 minutes when unset', async () => {
    const { config } = await loadConfig('HCC_NETPOL_PASS_HARD_LIMIT_MS', undefined)
    expect(config.netPolPassHardLimitMs).toBe(1_800_000)
  })

  it.each([
    ['300001', 300_001],
    ['3600000', 3_600_000],
    ['2147483647', 2_147_483_647],
  ])('accepts %s', async (raw, expected) => {
    const { config } = await loadConfig('HCC_NETPOL_PASS_HARD_LIMIT_MS', raw)
    expect(config.netPolPassHardLimitMs).toBe(expected)
  })

  it.each(['', '0', '-1', '300000', '1.5', '30m', 'NaN', '2147483648'])(
    "fails configuration validation for '%s'",
    async raw => {
      await expect(loadConfig('HCC_NETPOL_PASS_HARD_LIMIT_MS', raw)).rejects.toThrow(
        'HCC_NETPOL_PASS_HARD_LIMIT_MS must be an integer number of milliseconds above the 300000ms overrun warning'
      )
    }
  )
})
