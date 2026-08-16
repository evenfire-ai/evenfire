import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadAuthorityMaxStaleness(value: string | undefined): Promise<number> {
  vi.resetModules()
  process.env = { ...originalEnv }
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
  it('defaults to the 60-second authority ceiling', async () => {
    await expect(loadAuthorityMaxStaleness(undefined)).resolves.toBe(60_000)
  })

  it('allows an operator to fail closed sooner', async () => {
    await expect(loadAuthorityMaxStaleness('15000')).resolves.toBe(15_000)
  })

  it('cannot be configured beyond the 60-second authority ceiling', async () => {
    await expect(loadAuthorityMaxStaleness('120000')).resolves.toBe(60_000)
  })

  it('uses the safe ceiling for an invalid value', async () => {
    await expect(loadAuthorityMaxStaleness('not-a-duration')).resolves.toBe(60_000)
  })
})
