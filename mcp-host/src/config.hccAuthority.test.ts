import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadAuthorityMaxStaleness(
  value: string | undefined,
  pollInterval = '30000'
): Promise<number> {
  vi.resetModules()
  process.env = { ...originalEnv }
  process.env.CLERUM_CONTEXT_MAPPER_POLL_INTERVAL = pollInterval
  if (value === undefined) {
    delete process.env.HCC_AUTHORITY_MAX_STALENESS_MS
  } else {
    process.env.HCC_AUTHORITY_MAX_STALENESS_MS = value
  }
  return (await import('./config')).config.hccAuthorityMaxStalenessMs
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('HCC_AUTHORITY_MAX_STALENESS_MS', () => {
  it('defaults to the 180-second rollout-tolerant window', async () => {
    await expect(loadAuthorityMaxStaleness(undefined)).resolves.toBe(180_000)
  })

  it('allows an operator to fail closed sooner', async () => {
    await expect(loadAuthorityMaxStaleness('15000', '5000')).resolves.toBe(15_000)
  })

  it('allows an operator to raise the window for a slower-starting cluster (issue #425)', async () => {
    await expect(loadAuthorityMaxStaleness('300000')).resolves.toBe(300_000)
  })

  it('cannot be configured beyond the 600-second hard ceiling', async () => {
    await expect(loadAuthorityMaxStaleness('700000')).resolves.toBe(600_000)
  })

  it('uses the default window for an invalid value', async () => {
    await expect(loadAuthorityMaxStaleness('not-a-duration')).resolves.toBe(180_000)
  })

  it('rejects a poll interval that reaches the authority ceiling', async () => {
    const { validateHccAuthorityTiming } = await import('./config')
    expect(() => validateHccAuthorityTiming(60_000, 60_000)).toThrow(
      'CLERUM_CONTEXT_MAPPER_POLL_INTERVAL (60000ms) must be less than HCC_AUTHORITY_MAX_STALENESS_MS (60000ms)'
    )
    expect(() => validateHccAuthorityTiming(75_000, 60_000)).toThrow()
  })

  it('fails production configuration when the poll interval reaches the ceiling', async () => {
    await expect(loadAuthorityMaxStaleness('15000', '30000')).rejects.toThrow(
      'CLERUM_CONTEXT_MAPPER_POLL_INTERVAL (30000ms) must be less than HCC_AUTHORITY_MAX_STALENESS_MS (15000ms)'
    )
  })

  it('accepts the default 30-second poll inside the default staleness window', async () => {
    const { validateHccAuthorityTiming } = await import('./config')
    expect(() => validateHccAuthorityTiming(30_000, 180_000)).not.toThrow()
  })
})
