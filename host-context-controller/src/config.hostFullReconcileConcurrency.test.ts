import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadConfig(raw: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (raw === undefined) {
    delete process.env.HCC_HOST_FULL_RECONCILE_CONCURRENCY
  } else {
    process.env.HCC_HOST_FULL_RECONCILE_CONCURRENCY = raw
  }
  return import('./config')
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('HCC_HOST_FULL_RECONCILE_CONCURRENCY', () => {
  it('defaults to 2 when unset', async () => {
    const { config } = await loadConfig(undefined)

    expect(config.hostFullReconcileConcurrency).toBe(2)
  })

  it('defaults to 2 for a blank value', async () => {
    const { config } = await loadConfig('   ')

    expect(config.hostFullReconcileConcurrency).toBe(2)
  })

  it.each([
    ['1', 1],
    ['2', 2],
    ['4', 4],
    ['8', 8],
  ])('accepts the bounded explicit integer %s', async (raw, expected) => {
    const { config } = await loadConfig(raw)

    expect(config.hostFullReconcileConcurrency).toBe(expected)
  })

  it.each(['0', '9', '-1', '1.5', '2x', 'NaN', 'Infinity'])(
    "fails configuration validation for the explicit value '%s'",
    async raw => {
      await expect(loadConfig(raw)).rejects.toThrow(
        `HCC_HOST_FULL_RECONCILE_CONCURRENCY must be an integer from 1 through 8, got '${raw}'`
      )
    }
  )
})
