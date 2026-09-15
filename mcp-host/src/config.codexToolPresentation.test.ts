import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadConfig(value: string | undefined, discoveryBytes?: string) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (value === undefined) delete process.env.CODEX_TOOL_PRESENTATION
  else process.env.CODEX_TOOL_PRESENTATION = value
  if (discoveryBytes === undefined) delete process.env.CODEX_TOOL_DISCOVERY_BYTES
  else process.env.CODEX_TOOL_DISCOVERY_BYTES = discoveryBytes
  return (await import('./config')).config
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('CODEX_TOOL_DISCOVERY_BYTES import-time configuration', () => {
  it('defaults to 32768 bytes when unset', async () => {
    expect((await loadConfig(undefined)).codexToolDiscoveryBytes).toBe(32_768)
  })

  it.each(['1', '32768', String(Number.MAX_SAFE_INTEGER)])(
    'loads the positive safe integer %s',
    async value => {
      expect((await loadConfig(undefined, value)).codexToolDiscoveryBytes).toBe(Number(value))
    }
  )

  it.each(['', '0', '-1', '1.5', '01', '+1', ' 1', '1 ', '1e3', '3bytes', '9007199254740992'])(
    'refuses to import configuration with invalid byte limit %j',
    async value => {
      await expect(loadConfig(undefined, value)).rejects.toThrow(
        'CODEX_TOOL_DISCOVERY_BYTES must be a positive safe integer'
      )
    }
  )
})

describe('CODEX_TOOL_PRESENTATION import-time configuration', () => {
  it('defaults to auto when unset', async () => {
    expect((await loadConfig(undefined)).codexToolPresentation).toBe('auto')
  })

  it.each(['auto', 'direct', 'discovery'] as const)('loads explicit %s', async value => {
    expect((await loadConfig(value)).codexToolPresentation).toBe(value)
  })

  it.each(['', 'AUTO', 'unknown', ' auto'])(
    'refuses to import configuration with invalid mode %j',
    async value => {
      await expect(loadConfig(value)).rejects.toThrow(
        'CODEX_TOOL_PRESENTATION must be auto, direct, or discovery'
      )
    }
  )
})
