import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadBrokerPort(value: string | undefined): Promise<number> {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (value === undefined) delete process.env.CLERUM_OAI_EGRESS_BROKER_PORT
  else process.env.CLERUM_OAI_EGRESS_BROKER_PORT = value
  return (await import('./config')).config.brokerPort
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('CLERUM_OAI_EGRESS_BROKER_PORT', () => {
  it('defaults to 3000 when unset', async () => {
    expect(await loadBrokerPort(undefined)).toBe(3000)
  })

  it('honours a valid positive integer', async () => {
    expect(await loadBrokerPort('8080')).toBe(8080)
  })

  it.each(['foo', '', '0', '-1', '3000junk'])(
    'falls back to 3000 for the invalid value %j (never a NaN broker port that dials :NaN)',
    async value => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const port = await loadBrokerPort(value)
      warn.mockRestore()
      expect(port).toBe(3000)
      expect(port).not.toBeNaN()
    }
  )
})
