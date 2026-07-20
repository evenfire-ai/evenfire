import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadConfig(governedTracingEnabled: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (governedTracingEnabled === undefined) {
    delete process.env.GOVERNED_TRACING_ENABLED
  } else {
    process.env.GOVERNED_TRACING_ENABLED = governedTracingEnabled
  }
  return (await import('./config')).config
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('GOVERNED_TRACING_ENABLED', () => {
  it('defaults governed tracing on', async () => {
    const config = await loadConfig(undefined)

    expect(config.governedTracingEnabled).toBe(true)
  })

  it('can disable governed tracing', async () => {
    const config = await loadConfig('false')

    expect(config.governedTracingEnabled).toBe(false)
  })
})
