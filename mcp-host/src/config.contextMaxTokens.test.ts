import { afterEach, describe, expect, it, vi } from 'vitest'

// `contextMaxTokens` divides every pressure ratio. A value that parses to NaN
// makes every ratio NaN, and `NaN < 0.8` is false, so a typo would compact on
// every iteration; 0 divides by zero. Both must stop the Host at config load
// (R9-15, N-3).
const NAME = 'CLERUM_CONTEXT_MAX_TOKENS'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('CLERUM_CONTEXT_MAX_TOKENS validation', () => {
  it.each(['abc', '0', '', '-1', '1.5', '100k'])(
    'T-R9-15a rejects %j at config load, naming the variable',
    async value => {
      vi.resetModules()
      vi.stubEnv(NAME, value)
      await expect(import('./config')).rejects.toThrow(NAME)
    }
  )

  it('T-R9-15b loads an explicit positive integer', async () => {
    vi.resetModules()
    vi.stubEnv(NAME, '256000')
    const { config } = await import('./config')
    expect(config.contextMaxTokens).toBe(256_000)
  })

  it('T-R9-15c keeps the 100k default when the variable is absent', async () => {
    vi.resetModules()
    vi.stubEnv(NAME, undefined)
    const { config } = await import('./config')
    expect(config.contextMaxTokens).toBe(100_000)
  })
})
