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

async function loadPromptHistoryConfig(value: string | undefined, maxBytes?: string) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (value === undefined) {
    delete process.env.TRACING_APPROVAL_PROMPT_HISTORY_ENABLED
  } else {
    process.env.TRACING_APPROVAL_PROMPT_HISTORY_ENABLED = value
  }
  if (maxBytes === undefined) delete process.env.TRACING_APPROVAL_PROMPT_HISTORY_MAX_BYTES
  else process.env.TRACING_APPROVAL_PROMPT_HISTORY_MAX_BYTES = maxBytes
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

describe('TRACING_APPROVAL_PROMPT_HISTORY_ENABLED', () => {
  it.each([undefined, 'false', '1', 'TRUE'])('stays disabled for %s', async value => {
    const config = await loadPromptHistoryConfig(value)

    expect(config.approvalPromptHistoryEnabled).toBe(false)
  })

  it('enables capture only for literal true', async () => {
    const config = await loadPromptHistoryConfig('true')

    expect(config.approvalPromptHistoryEnabled).toBe(true)
  })

  it.each(['1024', '32768'])('accepts the inclusive max-byte boundary %s', async maxBytes => {
    const config = await loadPromptHistoryConfig('true', maxBytes)

    expect(config.approvalPromptHistoryEnabled).toBe(true)
    expect(config.approvalPromptHistoryMaxBytes).toBe(Number(maxBytes))
  })

  it.each(['1023', '32769', '16384junk', ' 16384', '1.5', ''])(
    'keeps an explicitly enabled but invalid max-byte value unavailable: %s',
    async maxBytes => {
      const config = await loadPromptHistoryConfig('true', maxBytes)

      expect(config.approvalPromptHistoryEnabled).toBe(true)
      expect(config.approvalPromptHistoryMaxBytes).toBeNaN()
    }
  )
})
