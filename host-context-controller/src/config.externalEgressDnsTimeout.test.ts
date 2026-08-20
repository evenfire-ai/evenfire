import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadConfig(raw: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (raw === undefined) {
    delete process.env.HCC_EXTERNAL_EGRESS_DNS_TIMEOUT_MS
  } else {
    process.env.HCC_EXTERNAL_EGRESS_DNS_TIMEOUT_MS = raw
  }
  return import('./config')
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('HCC_EXTERNAL_EGRESS_DNS_TIMEOUT_MS', () => {
  it.each([undefined, '', '   '])('defaults to 5000 for %s', async raw => {
    const { config } = await loadConfig(raw)

    expect(config.externalEgressDnsResolveTimeoutMs).toBe(5_000)
  })

  it.each([
    ['1', 1],
    ['5000', 5_000],
    ['2147483647', 2_147_483_647],
  ])('accepts the positive bounded integer %s', async (raw, expected) => {
    const { config } = await loadConfig(raw)

    expect(config.externalEgressDnsResolveTimeoutMs).toBe(expected)
  })

  it.each(['0', '-1', '1.5', '5000junk', 'NaN', 'Infinity', '2147483648'])(
    "fails configuration validation for '%s'",
    async raw => {
      await expect(loadConfig(raw)).rejects.toThrow(
        'HCC_EXTERNAL_EGRESS_DNS_TIMEOUT_MS must be a positive integer'
      )
    }
  )
})
