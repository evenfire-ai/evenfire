import { afterEach, describe, expect, it, vi } from 'vitest'

const originalEnv = process.env

async function loadConfig(value: string | undefined) {
  vi.resetModules()
  process.env = { ...originalEnv }
  if (value === undefined) delete process.env.CODEX_TOOL_PRESENTATION
  else process.env.CODEX_TOOL_PRESENTATION = value
  return (await import('./config')).config
}

afterEach(() => {
  process.env = originalEnv
  vi.resetModules()
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
