import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadConfig(mode: string | undefined, discoveryBytes?: string) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (mode === undefined) delete process.env.CLERUM_NATIVE_TOOL_PRESENTATION
  else process.env.CLERUM_NATIVE_TOOL_PRESENTATION = mode
  if (discoveryBytes === undefined) delete process.env.CLERUM_NATIVE_TOOL_DISCOVERY_BYTES
  else process.env.CLERUM_NATIVE_TOOL_DISCOVERY_BYTES = discoveryBytes
  return (await import('./config')).config
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
})

describe('CLERUM_NATIVE_TOOL_PRESENTATION import-time configuration', () => {
  it('defaults to direct when unset', async () => {
    expect((await loadConfig(undefined)).nativeToolPresentation).toBe('direct')
  })

  it.each(['direct', 'auto'] as const)('loads explicit %s', async value => {
    expect((await loadConfig(value)).nativeToolPresentation).toBe(value)
  })

  it.each(['', 'AUTO', 'discovery', ' auto'])(
    'refuses to import configuration with invalid mode %j',
    async value => {
      await expect(loadConfig(value)).rejects.toThrow(
        'CLERUM_NATIVE_TOOL_PRESENTATION must be direct or auto'
      )
    }
  )

  it('is independent of CODEX_TOOL_PRESENTATION', async () => {
    process.env = { ...originalEnv, CODEX_TOOL_PRESENTATION: 'discovery' }
    vi.resetModules()
    delete process.env.CLERUM_NATIVE_TOOL_PRESENTATION
    const loaded = (await import('./config')).config
    expect(loaded.codexToolPresentation).toBe('discovery')
    expect(loaded.nativeToolPresentation).toBe('direct')
  })
})

describe('CLERUM_NATIVE_TOOL_DISCOVERY_BYTES import-time configuration', () => {
  it('defaults to 2048 bytes when unset', async () => {
    expect((await loadConfig(undefined)).nativeToolDiscoveryBytes).toBe(2048)
  })

  it('loads an explicit positive integer', async () => {
    expect((await loadConfig('auto', '4096')).nativeToolDiscoveryBytes).toBe(4096)
  })

  it.each(['0', '-1', '1.5', ' 2048'])(
    'refuses to import an invalid budget %j even in direct mode',
    async value => {
      await expect(loadConfig('direct', value)).rejects.toThrow(
        'CLERUM_NATIVE_TOOL_DISCOVERY_BYTES must be a positive safe integer'
      )
    }
  )
})
